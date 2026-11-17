import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, readFile, readlink, lstat, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { warmBoots, worldProperties, worldCacheKey, stageServer } from '../../scripts/quality/fixture-servers.mjs';

function fakeServers() {
	const log = [];
	const boot = async (dir, options) => {
		log.push(`boot ${path.basename(dir)} ${options.port}`);
		await new Promise(done => setTimeout(done, 5));
		return { dir, commands: [], async command(text) { this.commands.push(text); return ''; }, async stop() { log.push(`stop ${path.basename(dir)}`); } };
	};
	return { log, boot, replayPort: (base, index) => base + index * 4 };
}

test('warmBoots boots the next case while the current one runs and thaws it when taken', async () => {
	const { log, boot, replayPort } = fakeServers();
	const root = await mkdtemp(path.join(tmpdir(), 'warm-'));
	const seen = [];
	for await (const { item, index, server } of warmBoots(['a', 'b', 'c'], (item) => ({ dir: path.join(root, item), options: { port: 28000 } }), { boot, replayPort, ahead: 1, minFreeMb: 0, keepWorld: true, pool: null })) {
		seen.push([item, index]);
		await new Promise(done => setTimeout(done, 20));
		log.push(`ran ${item}`);
		const fixture = server.commands.filter(text => text !== 'tick query');
		if (index > 0) assert.deepEqual(fixture, ['tick freeze', 'tick unfreeze']);
		else assert.deepEqual(fixture, []);
		await server.stop();
	}
	assert.deepEqual(seen, [['a', 0], ['b', 1], ['c', 2]]);
	// b boots before a has run; every case gets its own port triple.
	assert.ok(log.indexOf('boot b 28004') < log.indexOf('ran a'));
	assert.ok(log.indexOf('boot c 28008') < log.indexOf('ran b'));
	assert.equal(log.filter(line => line.startsWith('boot')).length, 3);
	await rm(root, { recursive: true, force: true });
});

test('warmBoots stops a server booted ahead when the loop ends early, and can boot on demand only', async () => {
	const { log, boot, replayPort } = fakeServers();
	const root = await mkdtemp(path.join(tmpdir(), 'warm-'));
	for await (const { server } of warmBoots(['a', 'b'], (item) => ({ dir: path.join(root, item), options: { port: 28000 } }), { boot, replayPort, ahead: 1, minFreeMb: 0, keepWorld: true, pool: null })) {
		await server.stop();
		break;
	}
	assert.deepEqual([...log].sort(), ['boot a 28000', 'boot b 28004', 'stop a', 'stop b']);
	assert.equal(log.at(-1), 'stop b');
	const lazy = fakeServers();
	for await (const { server } of warmBoots(['a', 'b'], (item) => ({ dir: path.join(root, item), options: { port: 28000 } }), { boot: lazy.boot, replayPort: lazy.replayPort, ahead: 1, minFreeMb: Number.MAX_SAFE_INTEGER, keepWorld: true, pool: null })) {
		lazy.log.push('ran'); await server.stop();
	}
	assert.deepEqual(lazy.log, ['boot a 28000', 'ran', 'stop a', 'boot b 28004', 'ran', 'stop b']);
	await rm(root, { recursive: true, force: true });
});

test('warmBoots boots a case again on demand when its boot ahead failed', async () => {
	const { log, boot, replayPort } = fakeServers();
	const root = await mkdtemp(path.join(tmpdir(), 'warm-'));
	let failed = false;
	const flaky = async (dir, options) => { if (path.basename(dir) === 'b' && !failed) { failed = true; log.push('boot b failed'); throw new Error('port in use'); } return boot(dir, options); };
	const seen = [];
	for await (const { item, server } of warmBoots(['a', 'b'], (item) => ({ dir: path.join(root, item), options: { port: 28000 } }), { boot: flaky, replayPort, ahead: 1, minFreeMb: 0, keepWorld: true, pool: null })) {
		seen.push(item); await server.stop();
	}
	assert.deepEqual(seen, ['a', 'b']);
	assert.ok(log.includes('boot b failed') && log.includes('boot b 28004'));
	await rm(root, { recursive: true, force: true });
});

test('warmBoots hands a case that cannot boot to the caller as an error and runs the rest', async () => {
	const { log, boot, replayPort } = fakeServers();
	const root = await mkdtemp(path.join(tmpdir(), 'warm-'));
	const broken = async (dir, options) => { if (path.basename(dir) === 'b') { log.push('boot b failed'); throw new Error('no spawn'); } return boot(dir, options); };
	const seen = [];
	for await (const { item, server, error } of warmBoots(['a', 'b', 'c'], (item) => ({ dir: path.join(root, item), options: { port: 28000 } }), { boot: broken, replayPort, ahead: 1, minFreeMb: 0, keepWorld: true, pool: null })) {
		seen.push([item, server ? 'server' : error.message]);
		await server?.stop();
	}
	// b fails ahead and again on demand; a strict fixture records it as invalid evidence and c still runs.
	assert.deepEqual(seen, [['a', 'server'], ['b', 'no spawn'], ['c', 'server']]);
	assert.equal(log.filter(line => line === 'boot b failed').length, 2);
	await rm(root, { recursive: true, force: true });
});

test('warmBoots kills a case whose world is thrown away and deletes it, and saves a kept one', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'warm-'));
	const exists = file => lstat(file).then(() => true, () => false);
	for (const keepWorld of [false, true]) {
		const { log, boot, replayPort } = fakeServers();
		const withWorld = async (dir, options) => { await mkdir(path.join(dir, 'server', 'world'), { recursive: true }); await writeFile(path.join(dir, 'server', 'world', 'level.dat'), 'x'); await writeFile(path.join(dir, 'server.log'), 'log'); return boot(dir, options); };
		const abort = async (s) => { log.push(`abort ${path.basename(s.dir)}`); };
		const plan = (item) => ({ dir: path.join(root, `${item}-${keepWorld}`), options: { port: 28000 } });
		for await (const { server } of warmBoots(['a', 'b'], plan, { boot: withWorld, replayPort, abort, ahead: 1, minFreeMb: 0, keepWorld, pool: null })) await server.stop();
		if (keepWorld) {
			assert.deepEqual(log.filter(line => !line.startsWith('boot')), ['stop a-true', 'stop b-true']);
			assert.ok(await exists(path.join(root, 'a-true', 'server', 'world', 'level.dat')));
		} else {
			// Play never reached disk: the killed world is deleted so nobody inspects pre-play terrain by mistake. The log stays.
			assert.deepEqual(log.filter(line => !line.startsWith('boot')), ['abort a-false', 'abort b-false']);
			assert.ok(!await exists(path.join(root, 'a-false', 'server')) && !await exists(path.join(root, 'b-false', 'server')));
			assert.ok(await exists(path.join(root, 'a-false', 'server.log')));
		}
	}
	await rm(root, { recursive: true, force: true });
});

test('a discarded world is preserved when server exit cannot be confirmed', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'warm-'));
	const { boot, replayPort } = fakeServers();
	try {
		const dir = path.join(root, 'case');
		await mkdir(path.join(dir, 'server'), { recursive: true });
		await writeFile(path.join(dir, 'server', 'level.dat'), 'evidence');
		await assert.rejects(async () => { for await (const { server } of warmBoots(['a'], () => ({ dir, options: { port: 28000 } }), {
			boot, replayPort, ahead: 0, keepWorld: false, pool: null,
			abort: async () => { throw new Error('Replay server exit unconfirmed; preserve its world'); },
		})) {
			await assert.rejects(server.stop(), /exit unconfirmed/);
			assert.equal(await readFile(path.join(dir, 'server', 'level.dat'), 'utf8'), 'evidence');
		} }, /exit unconfirmed/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a swallowed playing-server stop failure prevents advancement and port reuse', async () => {
	const { EventEmitter } = await import('node:events');
	const { spawnSync } = await import('node:child_process');
	const { replayPort } = await import('../../scripts/quality/watch-replay.mjs');
	const root = await mkdtemp(path.join(tmpdir(), 'playing-unsafe-'));
	const children = [], ports = [], taken = [];
	try {
		await assert.rejects(async () => {
			for await (const { index, server } of warmBoots(Array.from({ length: 26 }, (_, i) => i),
				item => ({ dir: path.join(root, String(item)), options: { port: 28000 } }), {
				ahead: 1, minFreeMb: 0, pool: { dir: root, count: 1 }, keepWorld: false, replayPort,
				boot: async (dir, options) => {
					ports.push(options.port);
					const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} });
					children.push(child);
					await mkdir(path.join(dir, 'server'), { recursive: true });
					await writeFile(path.join(dir, 'server/level.dat'), 'evidence');
					return { child, command: async () => '', stop: async () => {} };
				},
				abort: async () => { throw new Error('Replay server exit unconfirmed; preserve its world'); },
			})) {
				taken.push(index);
				await server.stop().catch(() => {});
			}
		}, /exit unconfirmed/);
		assert.deepEqual(taken, [0]);
		assert.deepEqual(ports, [28000, 28004], 'never reach case 26 on the first live server port');
		assert.notEqual(spawnSync('flock', ['-n', path.join(root, 'live-0.lock'), 'true']).status, 0);
		assert.equal(await readFile(path.join(root, '0/server/level.dat'), 'utf8'), 'evidence');
		assert.equal(await readFile(path.join(root, '1/server/level.dat'), 'utf8'), 'evidence');
		children[1].exitCode = 0; children[1].emit('exit', 0);
		await new Promise(done => setTimeout(done, 20));
		assert.equal(spawnSync('flock', ['-n', path.join(root, 'live-0.lock'), 'true']).status, 0);
	} finally {
		for (const child of children) { child.exitCode = 0; child.emit('exit', 0); }
		await rm(root, { recursive: true, force: true });
	}
});

for (const ahead of [0, 1]) for (const interruption of ['failed', 'exit', 'SIGTERM']) test(`exit guard retains ${ahead ? 'ahead' : 'on-demand'} boot during ${interruption}`, async () => {
	const { spawnSync } = await import('node:child_process');
	const root = await mkdtemp(path.join(tmpdir(), 'boot-exit-'));
	const moduleUrl = new URL('../../scripts/quality/fixture-servers.mjs', import.meta.url).href;
	try {
		const result = spawnSync(process.execPath, ['--input-type=module', '-e', `
import { warmBoots } from ${JSON.stringify(moduleUrl)};
import { EventEmitter } from 'node:events';
import { writeFileSync } from 'node:fs';
const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null,
  kill(signal) { writeFileSync(${JSON.stringify(path.join(root, 'killed'))}, signal); } });
for await (const row of warmBoots([0, 1], i => ({ dir: ${JSON.stringify(root)} + '/' + i, options: { port: 28000 } }), {
  ahead: ${ahead}, pool: null, minFreeMb: 0, keepWorld: true, replayPort: (base, i) => base + i * 4,
  boot: async (dir, options) => {
    if (${ahead} && dir.endsWith('/0')) return { command: async () => '', stop: async () => {} };
    if (${JSON.stringify(interruption)} !== 'failed') {
      options.onSpawn?.({ child });
      setInterval(() => {}, 1000); // Model the spawned child's open handles while boot is pending.
      setTimeout(() => ${interruption === 'SIGTERM' ? "process.kill(process.pid, 'SIGTERM')" : 'process.exit(0)'}, 10);
      return new Promise(() => {});
    }
    const error = new Error('Replay server exit unconfirmed; preserve its world');
    error.fixtureServer = { child };
    throw error;
  },
  abort: async () => {}
})) { if (row.server) await row.server.stop(); }
process.exit(0);
`], { encoding: 'utf8', timeout: 5000 });
		assert.equal(result.status, interruption === 'SIGTERM' ? 143 : 0, result.stderr);
		assert.equal(await readFile(path.join(root, 'killed'), 'utf8'), 'SIGKILL');
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a server booted ahead holds a free live slot until its case takes it, and boots on demand when none is free', async () => {
	const { spawn, spawnSync } = await import('node:child_process');
	const root = await mkdtemp(path.join(tmpdir(), 'pool-'));
	const pool = { dir: root, count: 2 };
	const busy = slot => spawnSync('flock', ['-n', path.join(root, `live-${slot}.lock`), 'true']).status !== 0;
	const hold = slot => new Promise(resolve => { const child = spawn('flock', ['-n', path.join(root, `live-${slot}.lock`), '-c', 'echo held; exec cat'], { stdio: ['pipe', 'pipe', 'ignore'] }); child.stdout.once('data', () => resolve(child)); });
	// This harness's own slot, as slot.sh holds it.
	const own = await hold(0);
	try {
		const { log, boot, replayPort } = fakeServers();
		const seen = [];
		for await (const { item, server } of warmBoots(['a', 'b'], (item) => ({ dir: path.join(root, item), options: { port: 28000 } }), { boot, replayPort, ahead: 1, minFreeMb: 0, keepWorld: true, pool })) {
			await new Promise(done => setTimeout(done, 30));
			seen.push([item, busy(1)]);
			await server.stop();
		}
		// While a plays, b's standby server holds slot 1; once b is taken the slot is free again.
		assert.deepEqual(seen, [['a', true], ['b', false]]);
		assert.ok(log.indexOf('boot b 28004') < log.indexOf('stop a'));
		const other = await hold(1);
		const full = fakeServers();
		for await (const { server } of warmBoots(['a', 'b'], (item) => ({ dir: path.join(root, `full-${item}`), options: { port: 28000 } }), { boot: full.boot, replayPort: full.replayPort, ahead: 1, minFreeMb: 0, keepWorld: true, pool })) { full.log.push('ran'); await server.stop(); }
		assert.deepEqual(full.log, ['boot full-a 28000', 'ran', 'stop full-a', 'boot full-b 28004', 'ran', 'stop full-b']);
		other.stdin.end();
	} finally {
		own.stdin.end();
		await rm(root, { recursive: true, force: true });
	}
});

test('warmBoots reads the playing server tick time while the next case boots ahead and when the case ends', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'ticks-'));
	const { boot, replayPort } = fakeServers();
	const timed = async (dir, options) => {
		const s = await boot(dir, options);
		s.command = async function (text) { this.commands.push(text); return text === 'tick query' ? 'The game is running normally Target tick rate: 20.0 per second.Average time per tick: 12.5ms (Target: 50.0ms)Percentiles: P50: 11.0ms P95: 31.2ms P99: 40.1ms, sample: 100' : ''; };
		return s;
	};
	const servers = [];
	for await (const { server } of warmBoots(['a', 'b'], (item) => ({ dir: path.join(root, item), options: { port: 28000 } }), { boot: timed, replayPort, ahead: 1, minFreeMb: 0, keepWorld: true, pool: null })) {
		await new Promise(done => setTimeout(done, 30));
		servers.push(server); await server.stop();
	}
	assert.deepEqual(servers[0].ticks.overlap, { avgMs: 12.5, p95Ms: 31.2 });
	assert.deepEqual(servers[0].ticks.end, { avgMs: 12.5, p95Ms: 31.2 });
	assert.equal(servers[1].ticks.overlap, undefined);
	await rm(root, { recursive: true, force: true });
});

test('world properties match the text boot() always wrote, and the cache key follows seed, settings and jar', async () => {
	assert.equal(worldProperties({ world: null, seed: '1001', spawnMonsters: true, extraProperties: 'max-tick-time=-1\n' }),
		'level-name=world\nlevel-seed=1001\nspawn-protection=0\nview-distance=6\nsimulation-distance=6\npause-when-empty-seconds=-1\nmax-players=4\nspawn-monsters=true\ndifficulty=normal\nmax-tick-time=-1\n');
	assert.ok(!worldProperties({ world: '/saved', seed: '1001' }).includes('level-seed'));
	const root = await mkdtemp(path.join(tmpdir(), 'key-'));
	const template = path.join(root, 'template');
	await mkdir(path.join(template, 'mods'), { recursive: true });
	await writeFile(path.join(template, 'server.jar'), 'server');
	await writeFile(path.join(template, 'mods', 'fabric-api.jar'), 'api');
	await writeFile(path.join(template, 'mods', 'mineagen-old.jar'), 'ignored');
	await writeFile(path.join(root, 'a.jar'), 'jar a');
	await writeFile(path.join(root, 'b.jar'), 'jar b');
	const key = (seed, monsters, jar = 'a.jar') => worldCacheKey({ template, jar: path.join(root, jar), properties: worldProperties({ seed, spawnMonsters: monsters }) });
	assert.equal(await key('1', false), await key('1', false));
	assert.notEqual(await key('1', false), await key('2', false));
	assert.notEqual(await key('1', false), await key('1', true));
	assert.notEqual(await key('1', false), await key('1', false, 'b.jar'));
	await rm(root, { recursive: true, force: true });
});

test('a staged server links the prepared template, copies its config and never writes into the template', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'stage-'));
	const previous = process.env.ARENA_FIXTURE_CACHE;
	process.env.ARENA_FIXTURE_CACHE = path.join(root, 'cache');
	try {
		const template = path.join(root, 'template');
		await mkdir(path.join(template, 'mods'), { recursive: true });
		await mkdir(path.join(template, 'libraries', 'net'), { recursive: true });
		await writeFile(path.join(template, 'libraries', 'net', 'loader.jar'), 'loader');
		await writeFile(path.join(template, 'server.properties'), 'template');
		await writeFile(path.join(template, 'mods', 'fabric-api.jar'), 'api');
		await writeFile(path.join(template, 'mods', 'mineagen-old.jar'), 'old');
		// A minimal vanilla bundle: one library and the version jar, listed with their hashes.
		const { createHash } = await import('node:crypto');
		const sha = text => createHash('sha256').update(text).digest('hex');
		const { spawnSync } = await import('node:child_process');
		const made = spawnSync('python3', ['-I', '-c', `import zipfile,sys
z=zipfile.ZipFile(sys.argv[1],'w')
z.writestr('META-INF/libraries.list','${sha('lib')}\\tx:y:1\\tx/y/1/y-1.jar\\n')
z.writestr('META-INF/libraries/x/y/1/y-1.jar','lib')
z.writestr('META-INF/versions.list','${sha('mc')}\\t26.3\\t26.3/server-26.3.jar\\n')
z.writestr('META-INF/versions/26.3/server-26.3.jar','mc')
z.close()`, path.join(template, 'server.jar')]);
		assert.equal(made.status, 0, String(made.stderr));
		await writeFile(path.join(root, 'arena.jar'), 'arena');
		const server = path.join(root, 'case', 'server');
		await stageServer(template, server, path.join(root, 'arena.jar'));
		assert.equal(await readFile(path.join(server, 'libraries/x/y/1/y-1.jar'), 'utf8'), 'lib');
		assert.equal(await readFile(path.join(server, 'versions/26.3/server-26.3.jar'), 'utf8'), 'mc');
		assert.ok((await lstat(path.join(server, 'libraries/net/loader.jar'))).isSymbolicLink());
		assert.ok(!(await readlink(path.join(server, 'server.jar'))).startsWith(template));
		assert.ok(!(await lstat(path.join(server, 'server.properties'))).isSymbolicLink());
		assert.ok(!(await lstat(path.join(server, 'mods/mineagen-0.2.0.jar'))).isSymbolicLink());
		await assert.rejects(lstat(path.join(server, 'mods/mineagen-old.jar')));
		await assert.rejects(lstat(path.join(template, 'libraries/x')));
	} finally {
		if (previous === undefined) delete process.env.ARENA_FIXTURE_CACHE; else process.env.ARENA_FIXTURE_CACHE = previous;
		await rm(root, { recursive: true, force: true });
	}
});

test('freeze failure confirms shutdown before retrying the same case', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'freeze-'));
	const { boot, log, replayPort } = fakeServers();
	let refused = false;
	const freezing = async (dir, options) => {
		const s = await boot(dir, options);
		s.command = async text => { if (text === 'tick freeze' && !refused) { refused = true; throw new Error('freeze refused'); } return ''; };
		return s;
	};
	try {
		for await (const { server } of warmBoots(['a', 'b'], item => ({ dir: path.join(root, item), options: { port: 28000 } }), { boot: freezing, replayPort, ahead: 1, minFreeMb: 0, pool: null, keepWorld: true })) {
			await new Promise(done => setTimeout(done, 20)); await server.stop();
		}
		const boots = log.flatMap((line, i) => line === 'boot b 28004' ? [i] : []);
		assert.equal(boots.length, 2);
		assert.ok(log.indexOf('stop b') < boots[1], log.join(', '));
	} finally { await rm(root, { recursive: true, force: true }); }
});

for (const failure of ['freeze', 'thaw', 'unused']) test(`${failure}: unconfirmed shutdown preserves world and slot until child exits`, async () => {
	const { EventEmitter } = await import('node:events');
	const { spawnSync } = await import('node:child_process');
	const root = await mkdtemp(path.join(tmpdir(), 'unsafe-'));
	const pool = { dir: root, count: 1 }, { boot, replayPort } = fakeServers();
	const child = Object.assign(new EventEmitter(), { exitCode: null, signalCode: null, kill() {} });
	let boots = 0;
	const failing = async (dir, options) => {
		const s = await boot(dir, options);
		if (path.basename(dir) === 'b') {
			boots++; s.child = child;
			await mkdir(path.join(dir, 'server'), { recursive: true });
			await writeFile(path.join(dir, 'server', 'level.dat'), 'evidence');
			s.command = async text => {
				if (text === (failure === 'freeze' ? 'tick freeze' : 'tick unfreeze') && failure !== 'unused') throw new Error('RCON failed');
				return '';
			};
		}
		return s;
	};
	try {
		const rows = [];
		for await (const row of warmBoots(['a', 'b'], item => ({ dir: path.join(root, item), options: { port: 28000 } }), {
			boot: failing, replayPort, ahead: 1, minFreeMb: 0, pool, keepWorld: false,
			abort: async s => { if (s.child === child) throw new Error('Replay server exit unconfirmed; preserve its world'); },
		})) {
			rows.push(row);
			if (row.server) await row.server.stop();
			if (failure === 'unused') break;
		}
		assert.equal(boots, 1, 'never retry while the first JVM may own the ports');
		assert.equal(await readFile(path.join(root, 'b/server/level.dat'), 'utf8'), 'evidence');
		assert.notEqual(spawnSync('flock', ['-n', path.join(root, 'live-0.lock'), 'true']).status, 0, 'reservation retained');
		if (failure !== 'unused') assert.match(rows.at(-1).error.message, /exit unconfirmed/);
		child.exitCode = 0; child.emit('exit', 0);
		await new Promise(done => setTimeout(done, 20));
		assert.equal(spawnSync('flock', ['-n', path.join(root, 'live-0.lock'), 'true']).status, 0, 'actual exit releases reservation');
	} finally { child.exitCode = 0; child.emit('exit', 0); await rm(root, { recursive: true, force: true }); }
});

test('boot cleanup uncertainty never deletes the world or retries the case', async () => {
	const root = await mkdtemp(path.join(tmpdir(), 'boot-unsafe-'));
	let boots = 0;
	try {
		const rows = [];
		for await (const row of warmBoots(['a', 'b'], item => ({ dir: path.join(root, item), options: { port: 28000 } }), {
			ahead: 0, pool: null, replayPort: x => x,
			boot: async dir => { boots++; await mkdir(path.join(dir, 'server'), { recursive: true }); await writeFile(path.join(dir, 'server/level.dat'), 'evidence'); throw new Error('Replay server exit unconfirmed; preserve its world'); },
		})) rows.push(row);
		assert.equal(boots, 1); assert.equal(rows.length, 1);
		assert.equal(await readFile(path.join(root, 'a/server/level.dat'), 'utf8'), 'evidence');
	} finally { await rm(root, { recursive: true, force: true }); }
});
