import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { armTotals, formatSummary, mergeArms, parseCommands, plannedOf, runQueue, splitWords } from '../../scripts/quality/lib/room-batch-core.mjs';
import { runBatch } from '../../scripts/quality/lib/room-batch-run.mjs';
import { launchScript } from '../../scripts/quality/lib/boat-pool.mjs';

const LINE = 'node scripts/quality/test-build-live.mjs scripts/quality/carve-hidden-fluid-spots.json $OUT $JAR --descriptive';
const room = name => ({ room: name, lines: [{ arm: 'new', env: {}, args: [] }, { arm: 'old', env: {}, args: [] }], planned: 1 });

test('a room line runs once per arm, an arm line overrides it, and bad lines are refused', () => {
	const rooms = parseCommands(`# comment\n\n@lava BUILD_ONLY=a,b ${LINE}\n@water BUILD_ONLY=w ${LINE}\n@water:old BUILD_ONLY=w EXTRA="x y" ${LINE}\n`, ['new', 'old']);
	assert.deepEqual(rooms.map(entry => entry.room), ['lava', 'water']);
	assert.deepEqual(rooms[0].lines.map(line => line.arm), ['new', 'old']);
	assert.equal(rooms[0].planned, 2);
	assert.deepEqual(rooms[0].lines[1].args, LINE.split(' ').slice(1));
	assert.deepEqual(rooms[1].lines[0].env, { BUILD_ONLY: 'w' });
	assert.deepEqual(rooms[1].lines[1].env, { BUILD_ONLY: 'w', EXTRA: 'x y' });
	assert.throws(() => parseCommands(`@a ${LINE}\n@a ${LINE}`, ['new']), /appears twice/);
	assert.throws(() => parseCommands(`@a:other ${LINE}`, ['new']), /unknown arm/);
	assert.throws(() => parseCommands('@a node x.mjs', ['new']), /\$OUT/);
	assert.throws(() => parseCommands(`@a bash ${LINE}`, ['new']), /only "node SCRIPT/);
	assert.throws(() => parseCommands(`@a/b ${LINE}`, ['new']), /room name/);
	assert.throws(() => parseCommands(`@a:old ${LINE}`, ['new', 'old']), /no command for arm new/);
	assert.deepEqual(splitWords(`a 'b c' "d \\"e\\"" f\\ g`), ['a', 'b c', 'd "e"', 'f g']);
	assert.equal(plannedOf({ FIND_ONLY: 'x,y,z' }), 3);
	assert.equal(plannedOf({ OTHER: '1' }), 1);
});

const worker = id => ({ id });
const settle = () => new Promise(done => setImmediate(done));

test('every worker pulls from one queue and each room plays once', async () => {
	const played = [];
	const outcomes = await runQueue({ rooms: ['a', 'b', 'c', 'd', 'e'].map(room), workers: [worker('w1'), worker('w2')],
		attempt: async (w, entry) => { played.push([w.id, entry.room]); await settle(); return { lost: false, arms: {} }; } });
	assert.deepEqual(outcomes.map(outcome => outcome.room), ['a', 'b', 'c', 'd', 'e']);
	assert.ok(outcomes.every(outcome => !outcome.lost && outcome.attempts === 1));
	assert.deepEqual(played.map(([, name]) => name).sort(), ['a', 'b', 'c', 'd', 'e']);
	assert.deepEqual(new Set(played.map(([id]) => id)), new Set(['w1', 'w2']));
});

test('a room lost with its machine is re-queued once, on another machine, and the lost machine takes no more', async () => {
	const played = [];
	const outcomes = await runQueue({ rooms: ['a', 'b', 'c'].map(room), workers: [worker('w1'), worker('w2')],
		attempt: async (w, entry) => {
			played.push(`${w.id}:${entry.room}`);
			await settle();
			if (w.id === 'w1') return { lost: true, reason: 'machine gone' };
			return { lost: false, arms: {} };
		} });
	assert.equal(played.filter(item => item.startsWith('w1')).length, 1);
	const lostRoom = played.find(item => item.startsWith('w1')).split(':')[1];
	const retry = outcomes.find(outcome => outcome.room === lostRoom);
	assert.equal(retry.lost, false);
	assert.equal(retry.worker, 'w2');
	assert.equal(retry.attempts, 2);
	assert.ok(outcomes.every(outcome => !outcome.lost));
});

test('a room lost twice is reported lost; rooms left with no machine are reported, never dropped', async () => {
	const lose = async () => { await settle(); return { lost: true, reason: 'machine gone' }; };
	const [twice] = await runQueue({ rooms: [room('a')], workers: [worker('w1'), worker('w2')], attempt: lose });
	assert.deepEqual([twice.lost, twice.attempts, twice.reason], [true, 2, 'machine gone']);
	const left = await runQueue({ rooms: ['a', 'b'].map(room), workers: [worker('w1')], attempt: lose });
	assert.deepEqual(left.map(outcome => [outcome.room, outcome.lost, outcome.reason]), [['a', true, 'no other machine left'], ['b', true, 'no machine left']]);
});

test('a replacement machine takes the re-queued room when the only machine dies', async () => {
	const log = [];
	const outcomes = await runQueue({ rooms: ['a', 'b'].map(room), workers: [worker('w1')],
		attempt: async (w, entry) => { await settle(); log.push(`${w.id}:${entry.room}`); return w.id === 'w1' ? { lost: true, reason: 'gone' } : { lost: false }; },
		replace: async lost => worker(`${lost.id}-again`) });
	assert.deepEqual(log, ['w1:a', 'w1-again:a', 'w1-again:b']);
	assert.ok(outcomes.every(outcome => !outcome.lost));
});

async function writeRoom(out, roomName, arm, rows, planned = rows.length) {
	const dir = path.join(out, 'rooms', roomName, arm);
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, 'result.json'), JSON.stringify(rows));
	await writeFile(path.join(dir, 'result-summary.json'), JSON.stringify({ planned }));
}
const row = (name, extra = {}) => ({ name, startedAt: 1, finishedAt: 2, pass: true, deaths: 0, damageTaken: 0, ...extra });

test('the merge keeps room folders, counts a lost room as notStarted and calls the arm INVALID', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-merge-'));
	try {
		const rooms = ['a', 'b', 'c'].map(room);
		await writeRoom(out, 'a', 'new', [row('spot-a', { damageTaken: 4 })]);
		await writeRoom(out, 'a', 'old', [row('spot-a', { pass: false, deaths: 1 })]);
		await writeRoom(out, 'b', 'new', [row('spot-b', { damageTaken: null })]);
		await writeRoom(out, 'b', 'old', [row('spot-b')]);
		const outcomes = [
			{ room: 'a', lost: false, worker: 'vm1', attempts: 1, arms: { new: { exit: 0, seconds: 60, cantKeepUp: 2 }, old: { exit: 0, seconds: 70, cantKeepUp: 0 } } },
			{ room: 'b', lost: false, worker: 'vm2', attempts: 2, arms: { new: { exit: 0, seconds: 30 }, old: { exit: 0, seconds: 30 } } },
			{ room: 'c', lost: true, reason: 'machine gone', attempts: 2 },
		];
		const merged = await mergeArms({ out, rooms, arms: ['new', 'old'], outcomes });
		assert.equal(merged.new.summary.planned, 3);
		assert.equal(merged.new.summary.notStarted, 1);
		assert.equal(merged.new.summary.status, 'INVALID');
		const written = JSON.parse(await readFile(path.join(out, 'new', 'result.json'), 'utf8'));
		assert.deepEqual(written.map(item => [item.room, item.host, item.attempts]), [['a', 'vm1', 1], ['b', 'vm2', 2]]);
		assert.equal(JSON.parse(await readFile(path.join(out, 'old', 'result-summary.json'), 'utf8')).failed, 1);
		const newTotals = armTotals(merged.new), oldTotals = armTotals(merged.old);
		assert.equal(newTotals.damage, null, 'a row without a damage number makes the total unknown');
		assert.equal(newTotals.unknownDamageRows, 1);
		assert.deepEqual(newTotals.lostRooms, ['c']);
		assert.equal(newTotals.cantKeepUp, 2);
		assert.equal(oldTotals.deaths, 1);
		assert.equal(oldTotals.damage, 0);
		assert.equal(oldTotals.fail, 1);
		const text = formatSummary({ batch: { name: 'b1', code: 'f875b5a674' }, merged, arms: ['new', 'old'], wallSeconds: 125, vms: 2, rooms });
		assert.match(text, /3 rooms x 2 arms on 2 machines, code f875b5a6, wall 2m05s/);
		assert.match(text, /c: LOST \(machine gone\) \| LOST \(machine gone\)/);
		assert.match(text, /dmg=\?/);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('a batch over a fake pool re-queues the room of a machine that dies, deletes every machine and merges', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-run-'));
	try {
		const events = [];
		let made = 0;
		const machines = new Map();
		const pool = {
			async create() { const vm = { id: `vm${++made}` }; machines.set(vm.id, { alive: true, jobs: new Map() }); return vm; },
			async prepare(vm) { return { wrapper: ['eatmydata'], code: '/c', out: '/o', jars: { new: '/j/new.jar', old: '/j/old.jar' }, inputs: {}, javaHome: '/jdk', template: '/t' }; },
			async start(vm, job) { events.push(`start ${vm.id} ${job.room}`); machines.get(vm.id).jobs.set(job.room, job); if (vm.id === 'vm1') machines.get(vm.id).alive = false; },
			async poll(vm, roomName) { if (!machines.get(vm.id).alive) throw new Error('no answer'); return 'done'; },
			async alive(vm) { return machines.get(vm.id).alive; },
			async fetch(vm, roomName, roomsDir) {
				for (const arm of ['new', 'old']) await writeRoom(out, roomName, arm, [row(`spot-${roomName}`)]);
				return { seconds: 5, arms: { new: { exit: 0, seconds: 5 }, old: { exit: 0, seconds: 5 } }, machine: {} };
			},
			async keepAlive() {},
			async usage(vm) { return { seconds: 10 }; },
			async destroy(vm) { events.push(`delete ${vm.id}`); machines.get(vm.id).alive = false; },
		};
		const rooms = parseCommands(`@a BUILD_ONLY=a ${LINE}\n@b BUILD_ONLY=b ${LINE}\n@c BUILD_ONLY=c ${LINE}`, ['new', 'old']);
		const result = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms, arms: [{ name: 'new' }, { name: 'old' }], pool, vms: 2, out, pollMs: 1, replacements: 0, log: () => {} });
		assert.ok(result.outcomes.every(outcome => !outcome.lost));
		const lostRoom = events.find(event => event.startsWith('start vm1')).split(' ')[2];
		assert.equal(result.outcomes.find(outcome => outcome.room === lostRoom).worker, 'vm2');
		assert.deepEqual(events.filter(event => event.startsWith('delete')).sort(), ['delete vm1', 'delete vm2']);
		assert.ok(result.machines.every(vm => vm.destroyed && vm.usage.seconds === 10));
		assert.equal(result.merged.new.summary.status, 'PASS');
		assert.equal(result.merged.old.summary.planned, 3);
		const job = [...machines.get('vm2').jobs.values()][0];
		assert.deepEqual(job.lines.map(line => line.jar), ['/j/new.jar', '/j/old.jar']);
		assert.ok(job.lines[0].args.includes('$OUT'), 'the machine fills in $OUT itself');
		assert.deepEqual(job.wrapper, ['eatmydata'], 'the machine layout picks the command rooms run under');
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('the machine helper plays every arm side by side under the wrapper, each in its own folder and port range', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'room-batch-remote-'));
	try {
		const fixture = path.join(dir, 'fixture.mjs');
		await writeFile(fixture, `import { mkdirSync, writeFileSync } from 'node:fs';
const [out, jar] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
writeFileSync(out + '/result.json', JSON.stringify([{ jar, wrapped: process.env.ROOM_WRAPPED, port: process.env.SLOT_PORT_BASE, only: process.env.BUILD_ONLY }]));
process.exit(jar.endsWith('old.jar') ? 3 : 0);\n`);
		const job = { room: 'r', code: dir, outDir: path.join(dir, 'out', 'r'), javaHome: '/jdk', template: '/t', timeoutMs: 60_000, wrapper: ['env', 'ROOM_WRAPPED=yes'],
			lines: ['new', 'old'].map(arm => ({ arm, jar: `/j/${arm}.jar`, env: { BUILD_ONLY: 'r' }, args: [fixture, '$OUT', '$JAR'] })) };
		await writeFile(path.join(dir, 'job.json'), JSON.stringify(job));
		const helper = new URL('../../scripts/quality/lib/room-batch-remote.mjs', import.meta.url).pathname;
		const { spawnSync } = await import('node:child_process');
		const run = spawnSync(process.execPath, [helper, path.join(dir, 'job.json')], { encoding: 'utf8' });
		assert.equal(run.status, 0, run.stderr);
		const done = JSON.parse(await readFile(path.join(job.outDir, 'done.json'), 'utf8'));
		assert.deepEqual(done.wrapper, ['env', 'ROOM_WRAPPED=yes']);
		assert.equal(done.arms.new.exit, 0);
		assert.equal(done.arms.old.exit, 3);
		const rows = await Promise.all(['new', 'old'].map(async arm => JSON.parse(await readFile(path.join(job.outDir, arm, 'result.json'), 'utf8'))[0]));
		assert.deepEqual(rows, [{ jar: '/j/new.jar', wrapped: 'yes', port: '28000', only: 'r' }, { jar: '/j/old.jar', wrapped: 'yes', port: '28100', only: 'r' }]);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a stopped batch deletes its machines and reports unfinished rooms as stopped', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-stop-'));
	try {
		const controller = new AbortController();
		const deleted = [];
		const pool = {
			async create() { return { id: 'vm1' }; },
			async prepare() { return { code: '/c', out: '/o', jars: { new: '/j/new.jar', old: '/j/old.jar' }, inputs: {}, javaHome: '/jdk', template: '/t' }; },
			async start() { controller.abort(); },
			async poll() { return 'running'; },
			async alive() { return true; },
			async fetch() { throw new Error('never fetched'); },
			async keepAlive() {},
			async usage() { return { seconds: 1 }; },
			async destroy(vm) { deleted.push(vm.id); },
		};
		const rooms = parseCommands(`@a ${LINE}\n@b ${LINE}`, ['new', 'old']);
		const result = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms, arms: [{ name: 'new' }, { name: 'old' }], pool, vms: 1, out, pollMs: 1, log: () => {}, signal: controller.signal });
		assert.deepEqual(deleted, ['vm1']);
		assert.deepEqual(result.outcomes.map(outcome => [outcome.room, outcome.lost, outcome.reason]), [['a', true, 'batch stopped'], ['b', true, 'batch stopped']]);
		assert.equal(result.merged.new.summary.status, 'INVALID');
		assert.equal(result.merged.new.summary.notStarted, 2);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('a machine that cannot start its room is deleted at once and the room plays on a replacement', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-start-'));
	try {
		const events = [];
		let made = 0;
		const pool = {
			async create() { const vm = { id: `vm${++made}` }; events.push(`create ${vm.id}`); return vm; },
			async prepare() { return { code: '/c', out: '/o', jars: { new: '/j/new.jar', old: '/j/old.jar' }, inputs: {}, javaHome: '/jdk', template: '/t' }; },
			async start(vm) { if (vm.id === 'vm1') throw new Error('server not responding'); events.push(`start ${vm.id}`); },
			async poll() { return 'done'; },
			async alive() { return true; },
			async fetch(vm, roomName) {
				for (const arm of ['new', 'old']) await writeRoom(out, roomName, arm, [row(`spot-${roomName}`)]);
				return { seconds: 5, arms: { new: { exit: 0 }, old: { exit: 0 } }, machine: {} };
			},
			async keepAlive() {},
			async usage() { return { seconds: 1 }; },
			async destroy(vm) { events.push(`delete ${vm.id}`); },
		};
		const rooms = parseCommands(`@a ${LINE}`, ['new', 'old']);
		const result = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms, arms: [{ name: 'new' }, { name: 'old' }], pool, vms: 1, out, pollMs: 1, log: () => {} });
		assert.deepEqual(events, ['create vm1', 'delete vm1', 'create vm2', 'start vm2', 'delete vm2']);
		assert.equal(result.outcomes[0].lost, false);
		assert.equal(result.outcomes[0].attempts, 2);
		assert.equal(result.merged.new.summary.status, 'PASS');
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('the room launch returns at once and leaves only the helper running, so ssh never waits out a room', { skip: process.platform === 'win32' }, async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'room-batch-launch-'));
	try {
		const helper = path.join(dir, 'helper.mjs');
		await writeFile(helper, `import { writeFileSync } from 'node:fs'; setTimeout(() => writeFileSync(process.argv[2] + '.ran', 'yes'), 3000);\n`);
		await mkdir(path.join(dir, 'out', 'r'), { recursive: true });
		const script = launchScript({ outDir: path.join(dir, 'out', 'r'), code: dir, helper, jobFile: path.join(dir, 'job.json'), log: path.join(dir, 'job.log'), node: process.execPath });
		const { spawn } = await import('node:child_process');
		const began = Date.now();
		// Like boat ssh: the call ends only when every holder of the output pipe has closed it.
		const output = await new Promise((resolve, reject) => {
			const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] });
			let text = '';
			child.stdout.on('data', chunk => { text += chunk; });
			child.on('error', reject);
			child.stdout.on('end', () => resolve(text));
		});
		assert.equal(output.trim(), 'started');
		assert.ok(Date.now() - began < 2000, `the launch held the output open for ${Date.now() - began} ms`);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline) { try { await readFile(path.join(dir, 'job.json.ran')); break; } catch { await new Promise(done => setTimeout(done, 200)); } }
		assert.equal(await readFile(path.join(dir, 'job.json.ran'), 'utf8'), 'yes', 'the helper kept running after the launch returned');
	} finally { await rm(dir, { recursive: true, force: true }); }
});
