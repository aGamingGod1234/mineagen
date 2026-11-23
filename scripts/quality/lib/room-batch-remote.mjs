// Runs on a batch machine, copied there by room-batch.mjs (so it imports nothing from the code under test):
//   node room-batch-remote.mjs JOB.json
// JOB: { room, code, outDir, javaHome, template, serverMods, timeoutMs, wrapper, portBase, env, lines: [{ arm, jar, env, args }] }. Plays every
// arm of one room side by side, each in its own fresh OUT folder (outDir/ARM) with its own port range (SLOT_PORT_BASE
// portBase, portBase + 100, ...; portBase defaults to 28000), writes each arm's output to outDir/ARM.log and, once all have exited, outDir/done.json: per arm the exit
// code, seconds, whether the room timeout killed it and the "Can't keep up" lines in its server logs, plus the lowest
// MemAvailable seen while the room played. wrapper (e.g. ["eatmydata"]) is a command each arm's node runs under; its
// environment reaches the fixture's servers too. env is added to every arm's environment before the line's own env.
// serverMods (JAR paths on this machine, e.g. Lithium) go into every arm's server: rooms play on a copy of the template
// with them added to mods/ (TEMPLATE+NAMES beside it, made once per machine), so the image's own template, which other
// batches on a shared pool machine use, is never changed. done.json counts the server logs that list each added mod.
// It runs on Linux and Windows: on Windows an arm's process tree is killed with taskkill.
import { spawn, spawnSync } from 'node:child_process';
import { createWriteStream, existsSync } from 'node:fs';
import { cp, mkdir, readdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

const job = JSON.parse(await readFile(process.argv[2], 'utf8'));
await mkdir(job.outDir, { recursive: true });
const serverMods = job.serverMods ?? [];
if (serverMods.length) {
	const names = serverMods.map(file => path.basename(file));
	const target = `${job.template}+${names.map(name => name.replace(/\.jar$/i, '')).join('+')}`;
	if (!existsSync(path.join(target, 'mods', names[0]))) {
		// Built beside the target and renamed into place, so two rooms starting at once on one machine never see half a copy.
		const temp = `${target}.tmp-${process.pid}-${Date.now()}`;
		await cp(job.template, temp, { recursive: true });
		for (const file of serverMods) await cp(file, path.join(temp, 'mods', path.basename(file)));
		await rename(temp, target).catch(() => {});
		await rm(temp, { recursive: true, force: true });
		if (!existsSync(path.join(target, 'mods', names[0]))) throw new Error(`could not make the template copy ${target}`);
	}
	job.template = target;
}
// The mod id a Fabric server lists for an added JAR: lithium-fabric-0.26.4+mc26.3.jar lists as "lithium".
const modIds = serverMods.map(file => path.basename(file).split(/[-_.+]/)[0].toLowerCase());
const expand = (text, values) => String(text).replace(/\$(OUT|JAR)\b/g, (_, key) => values[key]);
const windows = process.platform === 'win32';
const portBase = job.portBase ?? 28000;
// On Linux each arm leads its own process group. Windows has no groups, so taskkill takes the tree from the arm's pid,
// and only while the arm still runs: Windows hands an exited pid to the next process.
function killTree(pid, signal) {
	if (windows) spawnSync('taskkill', ['/T', '/F', '/PID', String(pid)], { stdio: 'ignore', windowsHide: true });
	else try { process.kill(-pid, signal); } catch {}
}

async function memAvailableMb() {
	if (process.platform !== 'linux') return Math.round(os.freemem() / 2 ** 20);
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
	const env = { ...process.env, ...job.env, JAVA_HOME: job.javaHome, ARENA_HEADLESS_SERVER_TEMPLATE: job.template, ARENA_FIXTURE_AHEAD: '0',
		SLOT: String((portBase - 28000) / 100 + slot), SLOT_PORT_BASE: String(portBase + slot * 100) };
	// Windows spells it Path; a second PATH key would leave which one the child sees to chance.
	const pathKey = Object.keys(env).find(key => key.toUpperCase() === 'PATH') ?? 'PATH';
	env[pathKey] = `${path.join(job.javaHome, 'bin')}${path.delimiter}${env[pathKey] ?? ''}`;
	for (const [key, value] of Object.entries(line.env)) env[key] = expand(value, values);
	const log = createWriteStream(path.join(job.outDir, `${line.arm}.log`));
	const began = Date.now();
	const [command, ...prefix] = [...(job.wrapper ?? []), process.execPath];
	const child = spawn(command, [...prefix, ...line.args.map(arg => expand(arg, values))], { cwd: job.code, env, detached: !windows, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
	child.stdout.pipe(log, { end: false }); child.stderr.pipe(log, { end: false });
	let timedOut = false;
	const timer = setTimeout(() => {
		timedOut = true;
		killTree(child.pid, 'SIGTERM');
		if (!windows) setTimeout(() => killTree(child.pid, 'SIGKILL'), 20000).unref();
	}, job.timeoutMs);
	let settled = false;
	const finish = (exit, signal, error) => {
		if (settled) return;
		settled = true;
		clearTimeout(timer);
		// Fixture servers are the fixture's children in the same group; nothing of this arm may outlive it. On Windows the
		// arm's pid is gone by now, so the pool kills what is left of the room when it retires the slot.
		if (!windows) killTree(child.pid, 'SIGKILL');
		log.end();
		resolve({ arm: line.arm, exit, signal, error: error ?? null, timedOut, seconds: Math.round((Date.now() - began) / 1000) });
	};
	child.on('error', error => finish(null, null, error.message));
	child.on('close', (code, signal) => finish(code, signal));
}));
const arms = {};
for (const run of await Promise.all(runs)) {
	let cantKeepUp = 0, logs = 0;
	const listed = Object.fromEntries(modIds.map(id => [id, 0]));
	for (const file of await serverLogs(path.join(job.outDir, run.arm))) {
		const text = await readFile(file, 'utf8').catch(() => '');
		logs++;
		cantKeepUp += (text.match(/Can't keep up!/g) ?? []).length;
		for (const id of modIds) if (new RegExp(`^\\s*- ${id} `, 'm').test(text)) listed[id]++;
	}
	arms[run.arm] = { ...run, cantKeepUp, ...(modIds.length ? { serverMods: { logs, listed } } : {}) };
}
clearInterval(sampler);
const done = { room: job.room, wrapper: job.wrapper ?? [], portBase, template: path.basename(job.template), startedAt, finishedAt: Date.now(), seconds: Math.round((Date.now() - startedAt) / 1000), arms,
	machine: { cpus: os.cpus().length, memoryMb: Math.round(os.totalmem() / 2 ** 20), minAvailableMb } };
await writeFile(path.join(job.outDir, 'done.json.tmp'), JSON.stringify(done, null, 2) + '\n');
await rename(path.join(job.outDir, 'done.json.tmp'), path.join(job.outDir, 'done.json'));
