// Runs on a batch machine, copied there by room-batch.mjs (so it imports nothing from the code under test):
//   node room-batch-remote.mjs JOB.json
// JOB: { room, code, outDir, javaHome, template, timeoutMs, wrapper, lines: [{ arm, jar, env, args }] }. Plays every arm of one
// room side by side, each in its own fresh OUT folder (outDir/ARM) with its own port range (SLOT_PORT_BASE 28000,
// 28100, ...), writes each arm's output to outDir/ARM.log and, once all have exited, outDir/done.json: per arm the exit
// code, seconds, whether the room timeout killed it and the "Can't keep up" lines in its server logs, plus the lowest
// MemAvailable seen while the room played. wrapper (e.g. ["eatmydata"]) is a command each arm's node runs under; its
// environment reaches the fixture's servers too.
import { spawn } from 'node:child_process';
import { createWriteStream } from 'node:fs';
import { mkdir, readdir, readFile, rename, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
await mkdir(job.outDir, { recursive: true });
const expand = (text, values) => String(text).replace(/\$(OUT|JAR)\b/g, (_, key) => values[key]);

async function memAvailableMb() {
	const text = await readFile('/proc/meminfo', 'utf8').catch(() => '');
	const kb = Number(/MemAvailable:\s+(\d+)/.exec(text)?.[1]);
	return Number.isFinite(kb) ? Math.round(kb / 1024) : null;
}
async function serverLogs(dir) {
	const found = [];
	for (const entry of await readdir(dir, { withFileTypes: true }).catch(() => [])) {
		const full = path.join(dir, entry.name);
		if (entry.isDirectory()) found.push(...await serverLogs(full));
		else if (entry.name === 'server.log' || entry.name === 'latest.log') found.push(full);
	}
	return found;
}

let minAvailableMb = await memAvailableMb();
const sampler = setInterval(async () => { const now = await memAvailableMb(); if (now !== null) minAvailableMb = Math.min(minAvailableMb ?? now, now); }, 5000);
const startedAt = Date.now();
const runs = job.lines.map((line, slot) => new Promise(resolve => {
	const out = path.join(job.outDir, line.arm);
	const values = { OUT: out, JAR: line.jar };
	const env = { ...process.env, JAVA_HOME: job.javaHome, ARENA_HEADLESS_SERVER_TEMPLATE: job.template, ARENA_FIXTURE_AHEAD: '0',
		SLOT: String(slot), SLOT_PORT_BASE: String(28000 + slot * 100), PATH: `${path.join(job.javaHome, 'bin')}:${process.env.PATH}` };
	for (const [key, value] of Object.entries(line.env)) env[key] = expand(value, values);
	const log = createWriteStream(path.join(job.outDir, `${line.arm}.log`));
	const began = Date.now();
	const [command, ...prefix] = [...(job.wrapper ?? []), process.execPath];
	const child = spawn(command, [...prefix, ...line.args.map(arg => expand(arg, values))], { cwd: job.code, env, detached: true, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		try { process.kill(-child.pid, 'SIGTERM'); } catch {}
		setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch {} }, 20000).unref();
	}, job.timeoutMs);
	let settled = false;
	const finish = (exit, signal, error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		// Fixture servers are the fixture's children in the same group; nothing of this arm may outlive it.
		try { process.kill(-child.pid, 'SIGKILL'); } catch {}
		log.end();
		resolve({ arm: line.arm, exit, signal, error: error ?? null, timedOut, seconds: Math.round((Date.now() - began) / 1000) });
	};
	child.on('error', error => finish(null, null, error.message));
	child.on('close', (code, signal) => finish(code, signal));
}));
const arms = {};
for (const run of await Promise.all(runs)) {
	let cantKeepUp = 0;
	for (const file of await serverLogs(path.join(job.outDir, run.arm))) cantKeepUp += ((await readFile(file, 'utf8').catch(() => '')).match(/Can't keep up!/g) ?? []).length;
	arms[run.arm] = { ...run, cantKeepUp };
}
clearInterval(sampler);
const done = { room: job.room, wrapper: job.wrapper ?? [], startedAt, finishedAt: Date.now(), seconds: Math.round((Date.now() - startedAt) / 1000), arms,
	machine: { cpus: os.cpus().length, memoryMb: Math.round(os.totalmem() / 2 ** 20), minAvailableMb } };
await writeFile(path.join(job.outDir, 'done.json.tmp'), JSON.stringify(done, null, 2) + '\n');
await rename(path.join(job.outDir, 'done.json.tmp'), path.join(job.outDir, 'done.json'));
