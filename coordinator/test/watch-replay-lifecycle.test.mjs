import assert from 'node:assert/strict';
import test from 'node:test';
import { spawn } from 'node:child_process';
import { EventEmitter, once } from 'node:events';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { boot, replayPort, abortReplayBoot, stopReplayServer } from '../../scripts/quality/watch-replay.mjs';

test('boot hands off its real child before waiting for readiness and cleans up callback failure', async t => {
	if (process.platform === 'win32') return t.skip('POSIX executable stand-in for Java');
	const root = await mkdtemp(path.join(tmpdir(), 'replay-spawn-'));
	const previousJava = process.env.JAVA_HOME, previousCopy = process.env.ARENA_FIXTURE_COPY_TEMPLATE;
	let child;
	try {
		await mkdir(path.join(root, 'bin'));
		await writeFile(path.join(root, 'bin/java'), '#!/usr/bin/env node\nsetInterval(() => {}, 1000);\n', { mode: 0o755 });
		await mkdir(path.join(root, 'template/mods'), { recursive: true });
		await writeFile(path.join(root, 'arena.jar'), 'unused by stand-in');
		await mkdir(path.join(root, 'case'));
		process.env.JAVA_HOME = root;
		process.env.ARENA_FIXTURE_COPY_TEMPLATE = '1';
		await assert.rejects(boot(path.join(root, 'case'), {
			template: path.join(root, 'template'), jar: path.join(root, 'arena.jar'), port: 28000, seed: '1',
			onSpawn: server => {
				child = server.child;
				assert.equal(child.exitCode, null);
				assert.equal(server.rcon, undefined, 'ownership precedes the first RCON connection');
				throw new Error('owner rejects startup');
			},
		}), /owner rejects startup/);
		assert.ok(child);
		assert.ok(child.exitCode !== null || child.signalCode !== null);
	} finally {
		if (child?.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
		if (previousJava === undefined) delete process.env.JAVA_HOME; else process.env.JAVA_HOME = previousJava;
		if (previousCopy === undefined) delete process.env.ARENA_FIXTURE_COPY_TEMPLATE; else process.env.ARENA_FIXTURE_COPY_TEMPLATE = previousCopy;
		await rm(root, { recursive: true, force: true });
	}
});

test('replay server triples stay unique inside their live slot before reuse', () => {
	const used = new Set();
	for (let index = 0; index < 25; index++) {
		const base = replayPort(28000, index);
		for (const port of [base, base + 1, base + 2]) {
			assert.ok(port >= 28000 && port < 28100);
			assert.ok(!used.has(port));
			used.add(port);
		}
	}
	assert.equal(replayPort(28000, 25), 28000);
});

test('a failed replay start kills its real child and closes its resources', async () => {
	const child = spawn(process.execPath, ['-e', 'setInterval(() => {}, 1000)'], { stdio: 'ignore' });
	await once(child, 'spawn');
	const closed = [];
	try {
		await abortReplayBoot({ child, bridge: { stop() { closed.push('bridge'); } },
			rcon: { async close() { closed.push('rcon'); } }, log: { async close() { closed.push('log'); } } });
		assert.equal(child.signalCode, 'SIGTERM');
		assert.deepEqual(closed, ['bridge', 'rcon', 'log']);
	} finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
});

test('replay shutdown waits for a real child that ignores TERM before closing the log', async (t) => {
	if (process.platform === 'win32') return t.skip('POSIX signal handler; Windows owned-job cleanup has its own suite');
	const child = spawn(process.execPath, ['-e', "process.on('SIGTERM', () => {}); process.stdout.write('ready'); setInterval(() => {}, 1000)"], { stdio: ['ignore', 'pipe', 'ignore'] });
	await once(child.stdout, 'data');
	let closedAfterExit = false;
	try {
		await stopReplayServer({ child, log: { async close() { closedAfterExit = child.signalCode !== null; } } }, { gracefulMs: 0, killMs: 100 });
		assert.equal(child.signalCode, 'SIGKILL');
		assert.equal(closedAfterExit, true);
	} finally { if (child.signalCode === null && child.exitCode === null) child.kill('SIGKILL'); }
});

test('unconfirmed replay shutdown rejects before world cleanup can run', async () => {
	const child = new EventEmitter();
	Object.assign(child, { pid: 4242, exitCode: null, signalCode: null, kill: () => true });
	let logClosed = false, worldDeleted = false;
	await assert.rejects(async () => {
		await stopReplayServer({ child, log: { async close() { logClosed = true; } } }, { gracefulMs: 0, killMs: 20 });
		worldDeleted = true;
	}, /unconfirmed|Could not confirm termination/);
	assert.equal(worldDeleted, false);
	assert.equal(logClosed, false);
});
