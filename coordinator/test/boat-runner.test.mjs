import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { appendFile, mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { coordinatorSession, dialRelay, serveRelay } from '../src/boat-relay.mjs';
import { parseCliJson, remoteConfig, remoteEnvironment, runBoatCoordinator, writeBackSignIns } from '../src/boat-runner.mjs';

// The relay's coordinator session runs on the Linux boat machine; it ends the coordinator by process group, which
// Windows does not have.
const onlyOnMachine = process.platform === 'win32' && 'the coordinator session runs on the Linux boat machine';
const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
async function until(check, timeoutMs = 20_000) {
	const deadline = Date.now() + timeoutMs;
	for (;;) {
		const value = await check();
		if (value) return value;
		if (Date.now() > deadline) throw new Error('timed out');
		await wait(50);
	}
}

test('the machine gets an allowlisted environment with PC paths moved to the session', () => {
	const env = {
		PATH: '/usr/bin', HOME: '/home/player', AWS_SECRET_ACCESS_KEY: 'x', GITHUB_TOKEN: 'y', OPENAI_API_KEY: 'sk-test', LANG: 'en_US.UTF-8',
		ARENA_AGENT_BRIDGE_SECRET: 's'.repeat(40), ARENA_LEAN_INPUT: '1', ARENA_PROTOCOL_AUDIT_PATH: '/pc/run/protocol.jsonl',
		ARENA_DECISION_LOG: 'C:\\Users\\p\\log.jsonl', ARENA_CAPTURE_SHUTDOWN_PATH: '/pc/run/capture.json', ARENA_PRIVATE_INPUTS: '/pc/private',
		ARENA_PROVIDER_CREDENTIAL_ROOT: '/pc/keys', MINEAGEN_INSTINCTS: '1', MINEAGEN_BOAT_TOKEN_FILE: '/pc/token', MINEAGEN_RUNS_ON: 'boat',
		CODEX_HOME: '/pc/codex',
	};
	const without = remoteEnvironment(env, { signIns: [], consent: false });
	assert.deepEqual(Object.keys(without.env).sort(), ['ARENA_AGENT_BRIDGE_SECRET', 'ARENA_LEAN_INPUT', 'ARENA_PROTOCOL_AUDIT_PATH', 'ARENA_PROVIDER_CREDENTIAL_ROOT', 'LANG', 'MINEAGEN_INSTINCTS']);
	assert.equal(without.env.ARENA_PROTOCOL_AUDIT_PATH, '${SESSION}/out/arena_protocol_audit_path.jsonl');
	assert.deepEqual(without.mirror, [{ name: 'ARENA_PROTOCOL_AUDIT_PATH', path: '${SESSION}/out/arena_protocol_audit_path.jsonl', local: '/pc/run/protocol.jsonl' }]);
	assert.deepEqual(without.dropped, ['ARENA_DECISION_LOG']);
	const withConsent = remoteEnvironment(env, { signIns: ['codex'], consent: true });
	assert.equal(withConsent.env.OPENAI_API_KEY, 'sk-test');
	assert.equal(withConsent.env.CODEX_HOME, '${SESSION}/codex-home');
	assert.equal(withConsent.env.GITHUB_TOKEN, undefined);
});

test('config paths point at the session folder', () => {
	const config = remoteConfig({ bridge: { port: 1 }, workspaceRoot: '/pc/ws', codex: { cwd: '/pc', launchProfile: { cwd: '/pc' } }, claude: { executable: '/pc/claude', cwd: '/pc' } });
	assert.equal(config.workspaceRoot, '${SESSION}/workspaces');
	assert.equal(config.codex.launchProfile.cwd, '${SESSION}/workspaces');
	assert.equal(config.claude.executable, undefined);
});

test('CLI JSON lines resolve to the result object', () => {
	assert.equal(parseCliJson('{"event":"creating"}\n{"sandbox":{"id":"bx_1"}}\n').sandbox.id, 'bx_1');
	assert.equal(parseCliJson('{"id":"bx_2"}').id, 'bx_2');
});

test('a refreshed sign-in is written back only over the copy that was sent', async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), 'boat-signin-'));
	try {
		const local = path.join(root, 'auth.json');
		await writeFile(local, 'old');
		const sent = [{ provider: 'codex', name: 'auth.json', local, hash: (await import('node:crypto')).createHash('sha256').update('old').digest('hex') }];
		const fresh = [{ name: 'auth.json', content: Buffer.from('new').toString('base64') }];
		assert.deepEqual(await writeBackSignIns(sent, fresh), [{ provider: 'codex', written: true }]);
		assert.equal(await readFile(local, 'utf8'), 'new');
		// The player signed in again meanwhile: their newer file wins.
		assert.deepEqual(await writeBackSignIns(sent, [{ name: 'auth.json', content: Buffer.from('newer').toString('base64') }]), [{ provider: 'codex', written: false, reason: 'changed-locally' }]);
		assert.equal(await readFile(local, 'utf8'), 'new');
	} finally { rmSync(root, { recursive: true, force: true }); }
});

test('a session starts the coordinator on the machine, carries the bridge, copies a refreshed sign-in back and deletes the machine', { skip: onlyOnMachine }, async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), 'boat-runner-'));
	const relays = [];
	try {
		// The mod's bridge on "the PC": echoes what the coordinator sends.
		const bridge = net.createServer(socket => socket.pipe(socket));
		await new Promise(resolve => bridge.listen(0, '127.0.0.1', resolve));
		const bridgePort = bridge.address().port;
		const codexHome = path.join(root, 'codex');
		await mkdir(codexHome);
		await writeFile(path.join(codexHome, 'auth.json'), '{"tokens":"old"}');
		const configFile = path.join(root, 'config.json');
		await writeFile(configFile, JSON.stringify({ bridge: { host: '127.0.0.1', port: bridgePort }, codex: {} }));
		const capture = path.join(root, 'capture.json');
		const audit = path.join(root, 'protocol.jsonl');
		const sessionRoot = path.join(root, 'machine-session');
		let machineBridgePort = 0, spawned = null;
		// The stand-in coordinator: refreshes its sign-in, writes an audit line, and talks over the machine's bridge.
		const coordinatorScript = `
			const fs = require('fs'), net = require('net');
			fs.writeFileSync(process.env.CODEX_HOME + '/auth.json', '{"tokens":"refreshed"}');
			fs.appendFileSync(process.env.ARENA_PROTOCOL_AUDIT_PATH, 'audit-line\\n');
			const s = net.connect(Number(process.env.TEST_BRIDGE_PORT), '127.0.0.1', () => s.write('hello-bridge'));
			s.on('data', d => fs.appendFileSync(process.env.ARENA_PROTOCOL_AUDIT_PATH, 'echo:' + d + '\\n'));
			setInterval(() => {}, 1000);`;
		const removed = [];
		const backend = {
			kind: 'fake',
			async list() { return [{ id: 'bx_old', name: 'mineagen-runner-test-old', state: 'idle' }, { id: 'bx_other', name: 'someone-else', state: 'idle' }]; },
			async create({ files }) {
				const key = files.find(file => file.path.endsWith('relay.key')).content;
				const relay = await serveRelay({ key, bridgePort: 0, wsPort: 0, sessionRoot, coordinatorRoot: path.join(root, 'machine-code'),
					spawnProcess: (execPath, _args, options) => { spawned = spawn(execPath, ['-e', coordinatorScript], { ...options, env: { ...options.env, TEST_BRIDGE_PORT: String(machineBridgePort) } }); return spawned; } });
				machineBridgePort = relay.bridgePort;
				relays.push(relay);
				return { id: 'bx_new', url: `http://127.0.0.1:${relay.wsPort}/?_token=t` };
			},
			async state() { return 'ready'; },
			async host() { throw new Error('url came with create'); },
			async extend() {},
			async remove(id) { removed.push(id); },
		};
		const env = { CODEX_HOME: codexHome, MINEAGEN_BOAT_SIGNIN_CONSENT: '1', MINEAGEN_BOAT_SIGNIN_PROVIDERS: 'codex', MINEAGEN_BOAT_INSTALL_ID: 'test',
			ARENA_CAPTURE_SHUTDOWN_PATH: capture, ARENA_PROTOCOL_AUDIT_PATH: audit, ARENA_AGENT_BRIDGE_SECRET: 's'.repeat(40), PATH: process.env.PATH };
		const run = runBoatCoordinator({ argv: ['--config', configFile], env, backend, reaper: false, log: () => {} });
		await until(async () => (await readFile(audit, 'utf8').catch(() => '')).includes('echo:hello-bridge'));
		// The refreshed sign-in is copied back while the session is still running.
		await until(async () => (await readFile(path.join(codexHome, 'auth.json'), 'utf8')).includes('refreshed'), 15_000);
		assert.deepEqual(removed, ['bx_old']);
		await writeFile(capture, '{}');
		assert.equal(await run, 0);
		assert.deepEqual(removed, ['bx_old', 'bx_new']);
		assert.equal(spawned.exitCode !== null || spawned.signalCode !== null, true);
		await assert.rejects(readFile(path.join(sessionRoot, 'codex-home', 'auth.json')), { code: 'ENOENT' });
		bridge.close();
	} finally {
		for (const relay of relays) await relay.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a bridge connection that timed out waiting for the PC does not swallow the next spare', async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), 'boat-spare-'));
	const pc = net.createServer(socket => socket.pipe(socket));
	await new Promise(resolve => pc.listen(0, '127.0.0.1', resolve));
	const key = 'k'.repeat(40);
	const relay = await serveRelay({ key, bridgePort: 0, wsPort: 0, sessionRoot: path.join(root, 's'), spareWaitMs: 200 });
	let dialer = null;
	try {
		// No PC yet: the coordinator's connection is refused once its wait ends.
		const early = net.connect(relay.bridgePort, '127.0.0.1');
		await new Promise(resolve => early.on('close', resolve));
		dialer = dialRelay({ url: `ws://127.0.0.1:${relay.wsPort}/bridge`, key, bridgePort: pc.address().port });
		await wait(500);
		const late = net.connect(relay.bridgePort, '127.0.0.1', () => late.write('after-timeout'));
		let echoed = '';
		late.on('data', data => { echoed += data; });
		await until(() => echoed === 'after-timeout', 5_000);
		late.destroy();
	} finally {
		dialer?.close();
		await relay.close();
		pc.close();
		rmSync(root, { recursive: true, force: true });
	}
});

test('mirrored logs wait out a disconnected PC and follow a rotated file', { skip: onlyOnMachine }, async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), 'boat-mirror-'));
	let connected = false, received = '';
	const send = text => {
		if (!connected) return false;
		if (text.startsWith('file:audit:')) received += Buffer.from(text.slice('file:audit:'.length), 'base64').toString();
		return true;
	};
	const session = coordinatorSession({ sessionRoot: path.join(root, 'session'), coordinatorRoot: root, log: () => {}, send,
		spawnProcess: (execPath, _args, options) => spawn(execPath, ['-e', 'setInterval(() => {}, 1000)'], options) });
	try {
		await session.start({ config: {}, mirror: [{ name: 'audit', path: '${SESSION}/out/audit.jsonl' }] });
		const file = path.join(root, 'session', 'out', 'audit.jsonl');
		await writeFile(file, 'while-offline\n');
		await wait(1_200);
		assert.equal(received, '');
		connected = true;
		await until(() => received === 'while-offline\n', 5_000);
		// Rotation as RotatingJsonlSink does it: a last line lands in the old file, which becomes ".1", then a new file starts.
		connected = false;
		await appendFile(file, 'last-before-rotation\n');
		await rename(file, `${file}.1`);
		await writeFile(file, 'first-after-rotation\n');
		await wait(1_200);
		connected = true;
		await until(() => received === 'while-offline\nlast-before-rotation\nfirst-after-rotation\n', 5_000);
	} finally {
		await session.stop();
		rmSync(root, { recursive: true, force: true });
	}
});

test('a bridge connection reset while waiting for the PC does not end the relay', async () => {
	const root = mkdtempSync(path.join(os.tmpdir(), 'boat-reset-'));
	const relay = await serveRelay({ key: 'k'.repeat(40), bridgePort: 0, wsPort: 0, sessionRoot: path.join(root, 's'), spareWaitMs: 500 });
	try {
		const socket = net.connect(relay.bridgePort, '127.0.0.1');
		await new Promise(resolve => socket.on('connect', resolve));
		socket.resetAndDestroy();
		await wait(800);
		// Still serving: a new connection is accepted and refused cleanly when no PC comes.
		const again = net.connect(relay.bridgePort, '127.0.0.1');
		await new Promise((resolve, reject) => { again.on('close', resolve); again.on('error', reject); });
	} finally {
		await relay.close();
		rmSync(root, { recursive: true, force: true });
	}
});
