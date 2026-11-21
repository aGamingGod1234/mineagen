import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { armTotals, formatSummary, mergeArms, parseCommands, plannedOf, runQueue, splitWords, stageRoom } from '../../scripts/quality/lib/room-batch-core.mjs';
import { runBatch } from '../../scripts/quality/lib/room-batch-run.mjs';
import { nextSlot, parseWindowsHosts, portClashes, slotPortBase, windowsBatchDir, windowsPath, windowsPool } from '../../scripts/quality/lib/windows-pool.mjs';
import { BUNDLE_PATHS, buildBundle, hasZstd, launchScript, prepareScript, readWait, waitAndPackScript } from '../../scripts/quality/lib/boat-pool.mjs';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { spawn, spawnSync } from 'node:child_process';

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
	assert.equal(plannedOf({ BUILD_ONLY: '' }), 1, 'an empty selector still plans one row');
});

test('a lost room with an empty selector keeps the arm from reading as PASS', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-empty-selector-'));
	try {
		const rooms = parseCommands(`@a ${LINE}\n@b BUILD_ONLY= ${LINE}`, ['new']);
		assert.equal(rooms[1].planned, 1);
		await writeRoom(out, 'a', 'new', [row('spot-a')]);
		const outcomes = [
			{ room: 'a', lost: false, worker: 'vm1', attempts: 1, arms: { new: { exit: 0, seconds: 5 } } },
			{ room: 'b', lost: true, reason: 'worker died', worker: 'vm2', attempts: 2, arms: {} },
		];
		// A stale plannedByArm of 0 (an older parse) is clamped too.
		const merged = await mergeArms({ out, rooms: [rooms[0], { ...rooms[1], planned: 0, plannedByArm: { new: 0 } }], arms: ['new'], outcomes });
		const totals = armTotals(merged.new);
		assert.notEqual(totals.status, 'PASS', 'a lost room must never read as PASS');
		assert.equal(totals.notStarted, 1);
		assert.deepEqual(totals.lostRooms, ['b']);
		assert.equal(totals.damage, null, 'damage is unknown, not 0, with a room missing');
	} finally { await rm(out, { recursive: true, force: true }); }
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
		assert.equal(oldTotals.deaths, null, 'a lost room makes the totals unknown, never a subtotal');
		assert.equal(oldTotals.damage, null);
		assert.equal(oldTotals.fail, 1);
		const whole = await mergeArms({ out, rooms: rooms.slice(0, 2), arms: ['old'], outcomes: outcomes.slice(0, 2) });
		assert.equal(armTotals(whole.old).deaths, 1);
		assert.equal(armTotals(whole.old).damage, 0);
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
			async prepare(vm) { return { wrapper: ['eatmydata'], code: '/c', out: '/o', jars: { new: '/j/new.jar', old: '/j/old.jar' }, inputs: {}, javaHome: '/jdk', template: '/t', ...(vm.id === 'vm2' ? { portBase: 28400, env: { TMP: '/tmp2' } } : {}) }; },
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
		assert.equal(job.portBase, 28400, 'the machine layout picks the room port base');
		assert.deepEqual(job.env, { TMP: '/tmp2' });
		assert.equal([...machines.get('vm1').jobs.values()][0].portBase, 28000, 'boat machines keep 28000');
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('the machine helper plays every arm side by side under the wrapper, each in its own folder and port range from the job port base', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'room-batch-remote-'));
	try {
		const fixture = path.join(dir, 'fixture.mjs');
		await writeFile(fixture, `import { mkdirSync, writeFileSync } from 'node:fs';
import path from 'node:path';
const [out, jar] = process.argv.slice(2);
mkdirSync(out, { recursive: true });
writeFileSync(out + '/result.json', JSON.stringify([{ jar, wrapped: process.env.ROOM_WRAPPED, port: process.env.SLOT_PORT_BASE, slot: process.env.SLOT, extra: process.env.ROOM_EXTRA, javaFirst: process.env.PATH.startsWith(path.join('/jdk', 'bin') + path.delimiter), only: process.env.BUILD_ONLY }]));
process.exit(jar.endsWith('old.jar') ? 3 : 0);\n`);
		const wrapperScript = path.join(dir, 'wrap.mjs');
		await writeFile(wrapperScript, `import { spawnSync } from 'node:child_process';
const res = spawnSync(process.argv[2], process.argv.slice(3), { env: { ...process.env, ROOM_WRAPPED: 'yes' }, stdio: 'inherit' });
process.exit(res.status ?? 1);\n`);
		const wrapper = [process.execPath, wrapperScript];
		const job = { room: 'r', code: dir, outDir: path.join(dir, 'out', 'r'), javaHome: '/jdk', template: '/t', timeoutMs: 60_000, wrapper, portBase: 28400, env: { ROOM_EXTRA: 'x' },
			lines: ['new', 'old'].map(arm => ({ arm, jar: `/j/${arm}.jar`, env: { BUILD_ONLY: 'r' }, args: [fixture, '$OUT', '$JAR'] })) };
		await writeFile(path.join(dir, 'job.json'), JSON.stringify(job));
		const helper = fileURLToPath(new URL('../../scripts/quality/lib/room-batch-remote.mjs', import.meta.url));
		const { spawnSync } = await import('node:child_process');
		const run = spawnSync(process.execPath, [helper, path.join(dir, 'job.json')], { encoding: 'utf8' });
		assert.equal(run.status, 0, run.stderr);
		const done = JSON.parse(await readFile(path.join(job.outDir, 'done.json'), 'utf8'));
		assert.deepEqual(done.wrapper, wrapper);
		assert.equal(done.arms.new.exit, 0);
		assert.equal(done.arms.old.exit, 3);
		const rows = await Promise.all(['new', 'old'].map(async arm => JSON.parse(await readFile(path.join(job.outDir, arm, 'result.json'), 'utf8'))[0]));
		assert.equal(done.portBase, 28400);
		assert.deepEqual(rows, [{ jar: '/j/new.jar', wrapped: 'yes', port: '28400', slot: '4', extra: 'x', javaFirst: true, only: 'r' }, { jar: '/j/old.jar', wrapped: 'yes', port: '28500', slot: '5', extra: 'x', javaFirst: true, only: 'r' }]);
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
		assert.equal(result.outcomes[0].attempts, 2);
		assert.equal(result.merged.new.summary.status, 'PASS');
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('Windows PCs: the host list, one port range per arm from the slot base, slots spread over PCs, reserved ports and paths', () => {
	assert.deepEqual(parseWindowsHosts('pc-a:4:0, pc-b:5:4'), [{ host: 'pc-a', slots: 4, slotBase: 0 }, { host: 'pc-b', slots: 5, slotBase: 4 }]);
	assert.deepEqual(parseWindowsHosts('pc-a:2'), [{ host: 'pc-a', slots: 2, slotBase: 0 }]);
	for (const bad of ['', 'pc-a', 'pc-a:0:0', 'pc-a:x:0', 'pc a:1:0', 'pc-a:1:0:9', 'pc-a:1:0,pc-a:2:0']) assert.throws(() => parseWindowsHosts(bad), undefined, bad);
	assert.equal(slotPortBase(0, 0, 2), 28000);
	assert.equal(slotPortBase(0, 1, 2), 28200, 'the second room starts after both arms of the first');
	assert.equal(slotPortBase(4, 0, 2), 28400);
	assert.equal(slotPortBase(4, 2, 3), 29000);
	const hosts = [{ host: 'a', slots: 2 }, { host: 'b', slots: 1 }];
	const busy = new Set();
	const order = [];
	for (let free; (free = nextSlot(hosts, busy)); ) { busy.add(`${free.host}:${free.slot}`); order.push(`${free.host}:${free.slot}`); }
	assert.deepEqual(order, ['a:0', 'b:0', 'a:1']);
	busy.delete('b:0');
	assert.deepEqual(nextSlot(hosts, busy), { host: 'b', slot: 0 }, 'a freed slot is handed out again');
	const netsh = 'Protocol tcp Port Exclusion Ranges\r\n\r\nStart Port    End Port\r\n----------    --------\r\n      5357        5357\r\n     28385       28385\r\n     50000       50059     *\r\n\r\n* - Administered port exclusions.\r\n';
	assert.deepEqual(portClashes(netsh, 28000, 28399), [[28385, 28385]]);
	assert.deepEqual(portClashes(netsh, 28400, 29399), []);
	assert.deepEqual(portClashes(netsh, 50059, 50100), [[50000, 50059]]);
	assert.equal(windowsPath('C:/aa-runs/batches/b/w0/jobs/r.json'), 'C:\\aa-runs\\batches\\b\\w0\\jobs\\r.json');
	for (const badName of ['', '.', '..', '...', '.hidden', 'a..b', 'trail.', 'a/b', 'a\\b', 'bad name']) {
		assert.throws(() => windowsBatchDir('C:/aa-runs', badName), undefined, badName);
	}
	const dir1 = windowsBatchDir('C:/aa-runs', 'smoke-1');
	const dir2 = windowsBatchDir('C:/aa-runs', 'smoke-1');
	assert.match(dir1, /^C:\/aa-runs\/batches\/smoke-1-\d+-[0-9a-f]{8}$/);
	assert.notEqual(dir1, dir2, 'two concurrent batches with the same name get separate directories');
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

test('a worker that finds the queue empty is released at once; a room lost after that goes to a replacement', async () => {
	const released = [], played = [];
	let made = 0;
	const outcomes = await runQueue({ rooms: ['a', 'b'].map(room), workers: [worker('w1'), worker('w2')],
		attempt: async (w, entry, tries) => {
			played.push(`${w.id}:${entry.room}`);
			await new Promise(done => setTimeout(done, w.id === 'w2' ? 20 : 1));
			return w.id === 'w2' && tries === 1 ? { lost: true, reason: 'machine gone' } : { lost: false, arms: {} };
		},
		release: async w => { released.push(w.id); },
		replace: async () => worker(`r${++made}`) });
	assert.ok(outcomes.every(outcome => !outcome.lost));
	assert.deepEqual(released.sort(), ['r1', 'w1']);
	assert.deepEqual(played, ['w1:a', 'w2:b', 'r1:b']);
});

const repoRoot = fileURLToPath(new URL('../..', import.meta.url));
const covered = relative => relative === '' || BUNDLE_PATHS.some(entry => relative === entry || relative.startsWith(`${entry}/`));

test('the batch bundle holds every file the live fixtures import and every repository file they name', () => {
	const quality = path.join(repoRoot, 'scripts/quality');
	const queue = readdirSync(quality).filter(name => /^test-.*-live\.mjs$|^watch-replay\.mjs$/.test(name)).map(name => path.join(quality, name));
	assert.ok(queue.length > 10);
	const seen = new Set(), missing = new Set(), bare = new Set();
	while (queue.length) {
		const file = queue.pop();
		if (seen.has(file)) continue;
		seen.add(file);
		const text = readFileSync(file, 'utf8');
		for (const match of text.matchAll(/(?:import|export)\s[^'"`;]*?from\s*['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|new URL\(\s*['"]([^'"]+)['"]\s*,\s*import\.meta\.url/g)) {
			const spec = match[1] ?? match[2] ?? match[3];
			if (spec.startsWith('node:')) continue;
			if (!spec.startsWith('.')) { bare.add(spec.split('/')[0]); continue; }
			const target = path.resolve(path.dirname(file), spec);
			const relative = path.relative(repoRoot, target).split(path.sep).join('/');
			// A path the repository lacks (a private evals/ file) was never in the code archive either.
			if (!covered(relative) && existsSync(target)) missing.add(`${relative} (imported by ${path.relative(repoRoot, file)})`);
			else if (/\.m?js$/.test(target) && existsSync(target)) queue.push(target);
		}
		// Files a fixture reads by repository path, such as coordinator/test/fixtures/routine-programs.md.
		for (const match of text.matchAll(/['"`]((?:coordinator\/(?:test|test-support|fixtures)|src|docs|server-template|voice-addon|gradle)\/[\w./-]+)/g)) {
			if (!covered(match[1]) && existsSync(path.join(repoRoot, match[1]))) missing.add(`${match[1]} (named by ${path.relative(repoRoot, file)})`);
		}
	}
	assert.deepEqual([...missing], []);
	for (const name of bare) assert.ok(existsSync(path.join(repoRoot, 'coordinator/node_modules', name)), `${name} is imported but not in coordinator/node_modules`);
});

for (const zstd of [true, false]) test(`a ${zstd ? 'zstd' : 'gzip'} bundle unpacks on the machine side into code, helper, jars and inputs, and prepare checks the image`, { skip: process.platform === 'win32' || !existsSync(path.join(repoRoot, '.git')) || (zstd && !hasZstd()) }, async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'room-batch-bundle-'));
	try {
		await mkdir(path.join(dir, 'local'));
		for (const [name, text] of [['new.jar', 'new jar'], ['old.jar', 'old jar'], ['spots.json', '[]']]) await writeFile(path.join(dir, 'local', name), text);
		const work = path.join(dir, 'work');
		await mkdir(work);
		const bundle = await buildBundle({ root: repoRoot, ref: 'HEAD', jars: { new: path.join(dir, 'local/new.jar'), old: path.join(dir, 'local/old.jar') },
			inputs: [{ local: path.join(dir, 'local/spots.json'), name: '1-spots.json' }], helper: path.join(repoRoot, 'scripts/quality/lib/room-batch-remote.mjs'), work, zstd });
		assert.equal(bundle.unpack.split(' ')[0], zstd ? 'zstd' : 'gzip');
		const home = path.join(dir, 'home'), bin = path.join(dir, 'bin');
		await mkdir(path.join(home, 'rooms/jdk/bin'), { recursive: true });
		await mkdir(path.join(home, 'rooms/template-26.3'), { recursive: true });
		await mkdir(bin);
		await writeFile(path.join(home, 'rooms/jdk/bin/java'), '#!/bin/sh\n', { mode: 0o755 });
		await writeFile(path.join(bin, 'eatmydata'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
		const run = (env) => spawnSync('bash', ['-c', `(\n${prepareScript({ unpack: bundle.unpack })}\n)`], { input: readFileSync(bundle.file), encoding: 'utf8', env: { ...process.env, HOME: home, PATH: `${bin}:${process.env.PATH}`, ...env } });
		const noTemplate = run();
		assert.notEqual(noTemplate.status, 0);
		assert.match(noTemplate.stdout, /no server template/);
		await writeFile(path.join(home, 'rooms/template-26.3/server.jar'), 'jar');
		const ok = run();
		assert.equal(ok.status, 0, ok.stdout + ok.stderr);
		assert.match(ok.stdout, new RegExp(`^HOME=${home}$`, 'm'));
		assert.match(ok.stdout, /^STEPS=\d+\.\d,\d+\.\d$/m, 'prepare reports where its seconds went');
		const batch = path.join(home, 'batch');
		assert.equal(readFileSync(path.join(batch, 'jars/old.jar'), 'utf8'), 'old jar');
		assert.equal(readFileSync(path.join(batch, 'inputs/1-spots.json'), 'utf8'), '[]');
		assert.ok(existsSync(path.join(batch, 'room-batch-remote.mjs')));
		assert.ok(existsSync(path.join(batch, 'code/scripts/quality/test-build-live.mjs')));
		assert.ok(existsSync(path.join(batch, 'code/coordinator/src/dynamic-main.mjs')));
		assert.ok(existsSync(path.join(batch, 'code/coordinator/node_modules/acorn/package.json')));
		assert.ok(!existsSync(path.join(batch, 'code/src')), 'the Java sources stay home');
		assert.ok(!existsSync(path.join(batch, 'code/.room-batch')));
		for (const name of ['jobs', 'out']) assert.ok(existsSync(path.join(batch, name)));
		assert.deepEqual(bundle.jars, ['new', 'old']);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the long poll says RUNNING while a room plays, the room folder as soon as done.json appears, and no output is no answer', { skip: process.platform === 'win32' }, async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'room-batch-wait-'));
	try {
		await mkdir(path.join(dir, 'out/r/new'), { recursive: true });
		await writeFile(path.join(dir, 'out/r/new/result.json'), '[]');
		await writeFile(path.join(dir, 'out/r/new/secret.txt'), 'rcon');
		const waitFor = (seconds) => new Promise((resolve, reject) => {
			const child = spawn('bash', ['-c', waitAndPackScript({ outDir: path.join(dir, 'out'), room: 'r', seconds })], { stdio: ['ignore', 'pipe', 'inherit'] });
			const chunks = [];
			child.stdout.on('data', chunk => chunks.push(chunk));
			child.on('error', reject);
			child.on('close', code => resolve({ code, data: Buffer.concat(chunks) }));
		});
		const idle = await waitFor(1);
		assert.equal(idle.code, 0);
		assert.equal(readWait('vm1', idle.data), 'running');
		assert.throws(() => readWait('vm1', Buffer.alloc(0)), /no answer from vm1/);
		assert.throws(() => readWait('vm1', Buffer.from('ssh: connection closed')), /no answer from vm1: ssh: connection closed/);
		const began = Date.now();
		setTimeout(() => writeFile(path.join(dir, 'out/r/done.json'), '{"seconds":3}'), 1500);
		const done = await waitFor(30);
		const waited = Date.now() - began;
		assert.equal(done.code, 0);
		assert.ok(Buffer.isBuffer(readWait('vm1', done.data)));
		assert.ok(waited < 3000, `the end was seen ${waited - 1500} ms late`);
		await mkdir(path.join(dir, 'back'));
		const untar = spawnSync('tar', ['-xz', '-C', path.join(dir, 'back')], { input: done.data });
		assert.equal(untar.status, 0);
		assert.equal(readFileSync(path.join(dir, 'back/r/done.json'), 'utf8'), '{"seconds":3}');
		assert.ok(existsSync(path.join(dir, 'back/r/new/result.json')));
		assert.ok(!existsSync(path.join(dir, 'back/r/new/secret.txt')), 'the RCON secret stays on the machine');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the room launch writes its job file in the same call', { skip: process.platform === 'win32' }, async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'room-batch-job-'));
	try {
		const helper = path.join(dir, 'helper.mjs');
		await writeFile(helper, `import { readFileSync, writeFileSync } from 'node:fs'; writeFileSync(process.argv[2] + '.seen', JSON.parse(readFileSync(process.argv[2], 'utf8')).room);\n`);
		const job = { room: "it's", lines: [{ args: ['$OUT', 'a "quoted" word'] }] };
		const jobFile = path.join(dir, 'jobs', 'r.json');
		const script = launchScript({ outDir: path.join(dir, 'out', 'r'), code: dir, helper, jobFile, log: path.join(dir, 'job.log'), node: process.execPath, job });
		assert.equal(spawnSync('bash', ['-c', script], { encoding: 'utf8' }).stdout.trim(), 'started');
		assert.deepEqual(JSON.parse(readFileSync(jobFile, 'utf8')), job);
		const deadline = Date.now() + 10_000;
		while (Date.now() < deadline && !existsSync(`${jobFile}.seen`)) await new Promise(done => setTimeout(done, 100));
		assert.equal(readFileSync(`${jobFile}.seen`, 'utf8'), "it's");
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a poll that fails on a live machine is retried after a pause, and a stop cuts a running poll short', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-retry-'));
	try {
		const polls = [];
		let failures = 1;
		const pool = {
			async create() { return { id: 'vm1' }; },
			async prepare() { return { code: '/c', out: '/o', jars: { new: '/j/new.jar', old: '/j/old.jar' }, inputs: {}, javaHome: '/jdk', template: '/t' }; },
			async start() {},
			async poll(vm, roomName, options) { polls.push({ at: Date.now(), signal: options?.signal ?? null }); if (failures-- > 0) throw new Error('ssh dropped'); return 'done'; },
			async alive() { return true; },
			async fetch(vm, roomName) {
				for (const arm of ['new', 'old']) await writeRoom(out, roomName, arm, [row(`spot-${roomName}`)]);
				return { seconds: 5, arms: { new: { exit: 0 }, old: { exit: 0 } }, machine: {} };
			},
			async keepAlive() {},
			async usage() { return { seconds: 1 }; },
			async destroy() {},
		};
		const controller = new AbortController();
		const result = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms: parseCommands(`@a ${LINE}`, ['new', 'old']), arms: [{ name: 'new' }, { name: 'old' }], pool, vms: 1, out, retryMs: 200, log: () => {}, signal: controller.signal });
		assert.equal(polls.length, 2);
		assert.ok(polls[1].at - polls[0].at >= 190, 'the failed poll was retried at once');
		assert.equal(polls[0].signal, controller.signal, 'the poll gets the batch signal so a stop can cut it short');

		const stopOut = await mkdtemp(path.join(os.tmpdir(), 'room-batch-retry-stop-'));
		try {
			const stopper = new AbortController();
			const stopping = { ...pool, poll: (vm, roomName, { signal }) => new Promise((resolve, reject) => { signal.addEventListener('abort', () => reject(new Error('stopped'))); setTimeout(() => stopper.abort(), 20); }) };
			const began = Date.now();
			const stopped = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms: parseCommands(`@a ${LINE}`, ['new', 'old']), arms: [{ name: 'new' }, { name: 'old' }], pool: stopping, vms: 1, out: stopOut, log: () => {}, signal: stopper.signal });
			assert.equal(stopped.outcomes[0].reason, 'batch stopped');
			assert.ok(Date.now() - began < 2000);
		} finally { await rm(stopOut, { recursive: true, force: true }); }
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('the merge ignores rows a lost room left behind, calls a killed arm invalid and counts planned rows per arm', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-guard-'));
	try {
		const rooms = parseCommands(`@a BUILD_ONLY=a ${LINE}\n@b:new BUILD_ONLY= ${LINE}\n@b:old BUILD_ONLY=x,y ${LINE}\n@c ${LINE}`, ['new', 'old']);
		await writeRoom(out, 'a', 'new', [row('spot-a')]);
		await writeRoom(out, 'a', 'old', [row('spot-a')]);
		await writeRoom(out, 'b', 'old', [row('spot-x'), row('spot-y')]);
		await writeRoom(out, 'c', 'new', [row('spot-c')]);
		await writeRoom(out, 'c', 'old', [row('spot-c')]);
		const outcomes = [
			{ room: 'a', lost: false, worker: 'vm1', attempts: 1, arms: { new: { exit: 0, seconds: 9 }, old: { exit: 0, seconds: 9 } } },
			{ room: 'b', lost: true, reason: 'copy failed: tar exited 2', attempts: 2 },
			{ room: 'c', lost: false, worker: 'vm2', attempts: 1, arms: { new: { exit: null, signal: 'SIGKILL', timedOut: true, seconds: 2400 }, old: { exit: 0, seconds: 50 } } },
		];
		const merged = await mergeArms({ out, rooms, arms: ['new', 'old'], outcomes });
		assert.equal(merged.old.summary.planned, 4, 'arm old selects two rows in room b');
		assert.equal(merged.old.summary.notStarted, 2, 'the rows a lost room left on disk are not counted');
		assert.equal(merged.old.summary.status, 'INVALID');
		assert.equal(merged.new.summary.invalid, 1, 'rows of an arm the room timeout killed are invalid');
		assert.match(merged.new.rows.find(item => item.room === 'c').integrity.join(), /arm killed \(room timeout\)/);
		assert.equal(merged.new.summary.status, 'INVALID');
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('a delete that fails is tried again when the batch ends, and a failed liveness lookup keeps the grace period', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-delete-'));
	try {
		const deletes = [];
		let polls = 0;
		const pool = {
			async create() { return { id: 'vm1' }; },
			async prepare() { return { code: '/c', out: '/o', jars: { new: '/j/new.jar', old: '/j/old.jar' }, inputs: {}, javaHome: '/jdk', template: '/t' }; },
			async start() {},
			async poll() { if (++polls === 1) throw new Error('ssh hiccup'); return 'done'; },
			async alive() { throw new Error('boat api hiccup'); },
			async fetch(vm, roomName) { for (const arm of ['new', 'old']) await writeRoom(out, roomName, arm, [row(`spot-${roomName}`)]); return { seconds: 5, arms: { new: { exit: 0 }, old: { exit: 0 } }, machine: {} }; },
			async keepAlive() {},
			async usage() { return { seconds: 1 }; },
			async destroy(vm) { deletes.push(vm.id); if (deletes.length === 1) throw new Error('boat busy'); },
		};
		const rooms = parseCommands(`@a ${LINE}`, ['new', 'old']);
		const result = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms, arms: [{ name: 'new' }, { name: 'old' }], pool, vms: 1, out, pollMs: 1, log: () => {} });
		assert.equal(result.outcomes[0].lost, false, 'one failed poll and one failed lookup do not lose the room');
		assert.deepEqual(deletes, ['vm1', 'vm1']);
		assert.equal(result.machines[0].destroyed, true);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('a fetched room replaces an earlier attempt only once its copy unpacks, and a failed copy leaves nothing', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'room-batch-stage-'));
	try {
		const { execFileSync } = await import('node:child_process');
		const src = path.join(dir, 'src');
		await mkdir(path.join(src, 'r', 'new'), { recursive: true });
		await writeFile(path.join(src, 'r', 'done.json'), JSON.stringify({ room: 'r', arms: { new: { exit: 0 } } }));
		await writeFile(path.join(src, 'r', 'new', 'result.json'), '[]');
		const archive = path.join(dir, 'r.tgz');
		execFileSync('tar', ['-czf', archive, '-C', src, 'r']);
		const roomsDir = path.join(dir, 'rooms');
		await mkdir(path.join(roomsDir, 'r', 'old'), { recursive: true });
		await writeFile(path.join(roomsDir, 'r', 'old', 'result.json'), '[{"pass":true}]');
		await assert.rejects(stageRoom({ roomsDir, room: 'r', download: async () => { throw new Error('copy failed'); } }), /copy failed/);
		assert.equal(await readFile(path.join(roomsDir, 'r', 'old', 'result.json'), 'utf8'), '[{"pass":true}]', 'a failed copy changes nothing');
		const done = await stageRoom({ roomsDir, room: 'r', download: async local => { const { copyFile } = await import('node:fs/promises'); await copyFile(archive, local); } });
		assert.equal(done.room, 'r');
		assert.deepEqual((await readdir(roomsDir)).sort(), ['r'], 'no staging folder is left');
		assert.deepEqual((await readdir(path.join(roomsDir, 'r'))).sort(), ['done.json', 'new'], 'the earlier attempt\'s files are gone');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('room-image waits for an in-flight machine creation and deletes it when cancelled', { skip: process.platform === 'win32' }, async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'room-image-cancel-'));
	try {
		const tpl = path.join(dir, 'tpl'), logFile = path.join(dir, 'boat.log'), fakeBoat = path.join(dir, 'fake-boat.mjs');
		await mkdir(tpl, { recursive: true });
		await writeFile(path.join(tpl, 'server.jar'), 'stub');
		await writeFile(fakeBoat, `#!/usr/bin/env node
import { appendFileSync } from 'node:fs';
const args = process.argv.slice(2);
appendFileSync(${JSON.stringify(logFile)}, JSON.stringify(args) + '\\n');
if (args.includes('new')) {
	process.stdout.write(JSON.stringify({ event: 'ready', id: 'bx_cancel_test' }) + '\\n');
	setTimeout(() => process.exit(0), 300);
} else {
	process.exit(0);
}
`, { mode: 0o755 });
		const { spawn } = await import('node:child_process');
		const script = fileURLToPath(new URL('../../scripts/quality/room-image.mjs', import.meta.url));
		const child = spawn(process.execPath, [script, '--template', tpl, '--snapshot', 'cancel-snap'], {
			env: { ...process.env, BOAT_BIN: fakeBoat },
			stdio: ['ignore', 'pipe', 'pipe'],
		});
		const deadline = Date.now() + 5000;
		while (Date.now() < deadline) {
			const calls = await readFile(logFile, 'utf8').catch(() => '');
			if (calls.includes('"new"')) break;
			await new Promise(done => setTimeout(done, 25));
		}
		child.kill('SIGTERM');
		const exitCode = await new Promise((resolve, reject) => {
			child.on('error', reject);
			child.on('close', code => resolve(code));
		});
		assert.equal(exitCode, 130);
		const calls = (await readFile(logFile, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
		assert.ok(calls.some(args => args.includes('new')), 'machine creation started');
		assert.ok(calls.some(args => args.includes('delete') && args.includes('bx_cancel_test')), 'created machine was deleted before exit');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('mergeArms marks an arm INVALID when a room summary is missing, corrupt, or INVALID with planned 0', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-invalid-summary-'));
	try {
		const rooms = parseCommands(`@a ${LINE}\n@b ${LINE}`, ['new']);
		await writeRoom(out, 'a', 'new', [row('spot-a')]);
		// Room b wrote a passing row without result-summary.json (e.g. crashed before writing summary).
		const dirB = path.join(out, 'rooms', 'b', 'new');
		await mkdir(dirB, { recursive: true });
		await writeFile(path.join(dirB, 'result.json'), JSON.stringify([row('spot-b')]));
		const outcomes = [
			{ room: 'a', lost: false, worker: 'vm1', attempts: 1, arms: { new: { exit: 0, seconds: 5 } } },
			{ room: 'b', lost: false, worker: 'vm1', attempts: 1, arms: { new: { exit: 1, seconds: 5 } } },
		];
		const missingSummary = await mergeArms({ out, rooms, arms: ['new'], outcomes });
		assert.equal(missingSummary.new.summary.status, 'INVALID', 'missing room summary must never read as PASS');
		// Now room b writes an explicit INVALID summary with planned 0 and 0 rows.
		await writeFile(path.join(dirB, 'result.json'), '[]');
		await writeFile(path.join(dirB, 'result-summary.json'), JSON.stringify({ status: 'INVALID', planned: 0 }));
		const zeroPlanned = await mergeArms({ out, rooms, arms: ['new'], outcomes });
		assert.equal(zeroPlanned.new.summary.status, 'INVALID', 'an INVALID planned:0 room summary must stay INVALID');
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('cancelling a batch while machines are preparing deletes them at once without waiting for prepare', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-cancel-prep-'));
	try {
		const controller = new AbortController();
		const deleted = [];
		const pool = {
			async create() { return { id: 'vm-prep' }; },
			async prepare() {
				setTimeout(() => controller.abort(), 10);
				return new Promise(() => {}); // Never resolves.
			},
			async start() { throw new Error('should not start'); },
			async poll() { return 'running'; },
			async alive() { return true; },
			async fetch() { throw new Error('should not fetch'); },
			async keepAlive() {},
			async usage() { return { seconds: 1 }; },
			async destroy(vm) { deleted.push(vm.id); },
		};
		const rooms = parseCommands(`@a ${LINE}`, ['new']);
		const result = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms, arms: [{ name: 'new' }], pool, vms: 1, out, pollMs: 1, log: () => {}, signal: controller.signal });
		assert.deepEqual(deleted, ['vm-prep']);
		assert.equal(result.machines[0].destroyed, true);
		assert.deepEqual(result.outcomes.map(outcome => [outcome.room, outcome.lost, outcome.reason]), [['a', true, 'batch stopped']]);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('windowsPool isolates worker cleanup markers, propagates SSH errors in alive, retries batch cleanup, and serializes replacement prepare', async () => {
	const scripts = [];
	let batchDeletes = 0, releaseDelete = null;
	const pool = windowsPool({
		hosts: [{ host: 'pc-a', slots: 2, slotBase: 0 }],
		batchName: 'win-test',
		bundle: { codeTar: '/tmp/c.tgz', helper: '/tmp/h.mjs', jars: { new: '/tmp/n.jar' }, inputs: [] },
		log: () => {},
		runUpload: async () => {},
		runDownload: async () => {},
		runPs: async (host, script) => {
			scripts.push(script);
			if (script === `'ok'`) throw new Error('ssh timeout');
			if (script.includes('ConvertTo-Json')) return JSON.stringify({ node: 'C:\\node.exe', excluded: '' });
			if (script.includes('refusing to delete outside batches root')) {
				batchDeletes++;
				if (batchDeletes === 1) throw new Error('busy lock');
				if (batchDeletes === 2) await new Promise(resolve => { releaseDelete = resolve; });
			}
			return '';
		},
	});
	const vm1 = await pool.create();
	await pool.prepare(vm1);
	// SSH error propagates from alive() rather than returning false.
	await assert.rejects(() => pool.alive(vm1), /ssh timeout/);
	// First destroy fails on shared batch cleanup; retry must attempt shared batch cleanup again without underflowing workers.
	await assert.rejects(() => pool.destroy(vm1), /busy lock/);
	assert.equal(batchDeletes, 1);
	// Worker cleanup script uses trailing path separators so w0/ never matches w00/.
	const workerCleanup = scripts.find(s => s.includes('$mark ='));
	assert.match(workerCleanup, /\/w0\/', '.*\\w0\\'/);
	// Second destroy enters deferred batch cleanup; a concurrent replacement prepare must wait until it finishes.
	const retryDestroy = pool.destroy(vm1);
	while (!releaseDelete) await new Promise(done => setImmediate(done));
	const vm2 = await pool.create();
	let prepDone = false;
	const prepPromise = pool.prepare(vm2).then(() => { prepDone = true; });
	await new Promise(done => setTimeout(done, 20));
	assert.equal(prepDone, false, 'replacement prepare must wait for in-flight shared cleanup');
	releaseDelete();
	await Promise.all([retryDestroy, prepPromise]);
	assert.equal(batchDeletes, 2);
	assert.equal(prepDone, true);
});

test('windowsPool deletes its own stale batch folder before a re-prepare claims it again', async () => {
	const scripts = [];
	let uploads = 0;
	const pool = windowsPool({
		hosts: [{ host: 'pc-a', slots: 1, slotBase: 0 }],
		batchName: 'win-stale',
		bundle: { codeTar: '/tmp/c.tgz', helper: '/tmp/h.mjs', jars: { new: '/tmp/n.jar' }, inputs: [] },
		log: () => {},
		runUpload: async () => { if (++uploads === 1) throw new Error('scp failed'); },
		runDownload: async () => {},
		runPs: async (host, script) => {
			scripts.push(script.includes('ConvertTo-Json') ? 'claim' : script.includes('refusing to delete outside batches root') ? 'clean' : 'other');
			return script.includes('ConvertTo-Json') ? JSON.stringify({ node: 'C:\\node.exe', excluded: '' }) : '';
		},
	});
	const vm = await pool.create();
	// The upload fails after the batch folder was claimed: the folder is left behind.
	await assert.rejects(() => pool.prepare(vm), /scp failed/);
	assert.deepEqual(scripts, ['claim']);
	await pool.prepare(vm);
	assert.deepEqual(scripts.slice(0, 3), ['claim', 'clean', 'claim'], 'the stale folder is deleted before it is claimed again');
});

test('a row that ran safely but missed its bar counts and reads as a fail, as the scorer scores it', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-bar-'));
	try {
		const rooms = parseCommands(`@slow ${LINE}\n@bad ${LINE}`, ['new']);
		await writeRoom(out, 'slow', 'new', [row('spot-slow', { bar: false })]);
		await writeRoom(out, 'bad', 'new', [row('spot-bad', { measurementStatus: 'INVALID' })]);
		const outcomes = ['slow', 'bad'].map(name => ({ room: name, lost: false, worker: 'vm1', attempts: 1, arms: { new: { exit: 0, seconds: 5 } } }));
		const merged = await mergeArms({ out, rooms, arms: ['new'], outcomes });
		const totals = armTotals(merged.new);
		assert.equal(totals.pass, 0, 'neither row met acceptance');
		assert.equal(totals.fail, 1);
		assert.equal(totals.invalid, 1);
		const text = formatSummary({ batch: { name: 'b', code: 'abc12345' }, merged, arms: ['new'], wallSeconds: 10, vms: 1, rooms });
		assert.match(text, /^slow: fail /m);
		assert.match(text, /^bad: INVALID /m);
	} finally { await rm(out, { recursive: true, force: true }); }
});

const fakeWindows = ({ claim = async () => JSON.stringify({ node: 'C:\\node.exe', excluded: '' }), uploads = [], scripts = [], jars = { new: '/tmp/n.jar' } } = {}) => windowsPool({
	hosts: [{ host: 'pc-a', slots: 1, slotBase: 0 }],
	batchName: 'win-case',
	bundle: { codeTar: '/tmp/c.tgz', helper: '/tmp/h.mjs', jars, inputs: [] },
	log: () => {},
	runUpload: async (host, local) => { uploads.push(local); },
	runDownload: async () => {},
	runPs: async (host, script) => {
		const kind = script.includes('ConvertTo-Json') ? 'claim' : script.includes('refusing to delete outside batches root') ? 'clean' : 'other';
		scripts.push(kind);
		return kind === 'claim' ? claim(script) : '';
	},
});

test('windowsPool refuses arm names that differ only in case', () => {
	assert.throws(() => fakeWindows({ jars: { A: '/tmp/a.jar', a: '/tmp/b.jar' } }), /differ in more than case/);
});

test('windowsPool refuses a port range another batch on the PC holds, and deletes the folder it claimed', async () => {
	const scripts = [];
	const pool = fakeWindows({ scripts, claim: async script => {
		assert.match(script, /ports\.json/, 'the claim records its port range');
		return JSON.stringify({ overlap: ['other-batch-1'], node: 'C:\\node.exe', excluded: '' });
	} });
	const vm = await pool.create();
	await assert.rejects(() => pool.prepare(vm), /may be in use by another batch \(other-batch-1/);
	await pool.destroy(vm);
	assert.deepEqual(scripts, ['claim', 'other', 'clean'], 'the worker sweep, then its own claimed folder is deleted');
});

test('windowsPool cleanup after Ctrl-C waits for an in-flight prepare, which stops before uploading', async () => {
	const scripts = [], uploads = [];
	let answer;
	const pool = fakeWindows({ scripts, uploads, claim: () => new Promise(resolve => { answer = resolve; }) });
	const controller = new AbortController();
	const vm = await pool.create();
	const prep = pool.prepare(vm, { signal: controller.signal });
	prep.catch(() => {});
	while (!answer) await new Promise(done => setImmediate(done));
	controller.abort();
	let destroyed = false;
	const destroy = pool.destroy(vm).then(() => { destroyed = true; });
	await new Promise(done => setTimeout(done, 20));
	assert.equal(destroyed, false, 'cleanup waits while the first ssh answer is still out');
	answer(JSON.stringify({ node: 'C:\\node.exe', excluded: '' }));
	await destroy;
	await assert.rejects(prep, /batch stopped/);
	assert.deepEqual(uploads, [], 'nothing is uploaded after the stop');
	assert.deepEqual(scripts, ['claim', 'other', 'clean'], 'the folder the late claim made is deleted');
});

test('windowsPool deletes a batch folder whose claim made it but never answered', async () => {
	const scripts = [];
	const pool = fakeWindows({ scripts, claim: async () => { throw new Error('ssh connection closed'); } });
	const vm = await pool.create();
	await assert.rejects(() => pool.prepare(vm), /ssh connection closed/);
	await pool.destroy(vm);
	assert.deepEqual(scripts, ['claim', 'other', 'clean'], 'the folder the claim may have made is deleted');
});

// The warm pool against a fake boat: sandboxes are files, exec runs the script here with HOME at the sandbox's own folder.
const FAKE_BOAT = `import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
const dir = process.env.FAKE_BOAT_DIR, boxes = path.join(dir, 'sandboxes');
mkdirSync(boxes, { recursive: true });
const args = process.argv.slice(2).filter(arg => arg !== '--no-update');
appendFileSync(path.join(dir, 'calls.log'), JSON.stringify(args) + '\\n');
const opt = name => { const at = args.indexOf(name); return at < 0 ? null : args[at + 1]; };
const iso = ms => new Date(ms).toISOString();
const home = id => path.join(dir, 'homes', id);
const read = id => existsSync(path.join(boxes, id + '.json')) ? JSON.parse(readFileSync(path.join(boxes, id + '.json'), 'utf8')) : null;
const save = box => writeFileSync(path.join(boxes, box.id + '.json'), JSON.stringify(box));
const out = value => console.log(JSON.stringify(value));
const [command, id] = args;
if (command === 'new') {
	if (process.env.FAKE_BOAT_LIMIT_ONCE && !existsSync(path.join(dir, 'limited'))) { writeFileSync(path.join(dir, 'limited'), '1'); console.error('429 rate_limited: the start limit for this minute is full, retryAfterSeconds 1'); process.exit(1); }
	const box = { id: 'bx_' + randomBytes(4).toString('hex'), name: opt('--name'), type: opt('--type'), state: 'idle', createdAt: iso(Date.now()), archiveAfter: iso(Date.now() + Number(opt('--ttl')) * 1000) };
	mkdirSync(path.join(home(box.id), 'rooms/jdk/bin'), { recursive: true });
	mkdirSync(path.join(home(box.id), 'rooms/template-26.3'), { recursive: true });
	writeFileSync(path.join(home(box.id), 'rooms/jdk/bin/java'), '#!/bin/sh\\n', { mode: 0o755 });
	writeFileSync(path.join(home(box.id), 'rooms/template-26.3/server.jar'), '');
	save(box); out({ event: 'ready', id: box.id });
} else if (command === 'list') out({ sandboxes: readdirSync(boxes).map(file => JSON.parse(readFileSync(path.join(boxes, file), 'utf8'))) });
else if (command === 'snapshots') out({ named: [{ name: 'img', snapshotId: process.env.FAKE_BOAT_SNAPSHOT_ID ?? 'sid-1' }] });
else if (command === 'limits') out({ starts: { minute: { remaining: 30 }, hour: { remaining: Number(process.env.FAKE_BOAT_HOUR_LEFT ?? 100) }, day: { remaining: 500 } } });
else if (command === 'info') { const box = read(id); if (!box) { console.error('sandbox not found'); process.exit(1); } out({ sandbox: { ...box, hydrated: Date.now() - Date.parse(box.createdAt) >= Number(process.env.FAKE_BOAT_HYDRATE_MS ?? 0) } }); }
else if (command === 'extend') { const box = read(id); box.archiveAfter = iso(Date.now() + Number(opt('--ttl')) * 1000); save(box); out({}); }
else if (command === 'delete') { rmSync(path.join(boxes, id + '.json'), { force: true }); out({}); }
else if (command === 'usage') out({ seconds: 1 });
else if (command === 'exec') {
	if (!read(id)) { out({ success: false, error: 'sandbox not found' }); process.exit(0); }
	const run = spawnSync('bash', ['-c', args.at(-1)], { env: { ...process.env, HOME: home(id), PATH: path.join(dir, 'bin') + ':' + process.env.PATH }, encoding: 'utf8' });
	out({ success: run.status === 0, exitCode: run.status, stdout: run.stdout, stderr: run.stderr });
} else { console.error('fake boat cannot ' + command); process.exit(1); }
`;

async function fakeBoat(env = {}) {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'fake-boat-'));
	await mkdir(path.join(dir, 'bin'), { recursive: true });
	await writeFile(path.join(dir, 'bin/eatmydata'), '#!/bin/sh\nexec "$@"\n', { mode: 0o755 });
	await writeFile(path.join(dir, 'boat.mjs'), FAKE_BOAT);
	await writeFile(path.join(dir, 'boat'), `#!/bin/sh\nexec "${process.execPath}" "${path.join(dir, 'boat.mjs')}" "$@"\n`, { mode: 0o755 });
	const saved = { BOAT_BIN: process.env.BOAT_BIN, FAKE_BOAT_DIR: process.env.FAKE_BOAT_DIR, ...Object.fromEntries(Object.keys(env).map(key => [key, process.env[key]])) };
	Object.assign(process.env, { BOAT_BIN: path.join(dir, 'boat'), FAKE_BOAT_DIR: dir, ...env });
	return {
		dir, poolDir: path.join(dir, 'pool'),
		home: id => path.join(dir, 'homes', id),
		calls: async kind => (await readFile(path.join(dir, 'calls.log'), 'utf8').catch(() => '')).trim().split('\n').filter(Boolean).map(line => JSON.parse(line)).filter(args => args[0] === kind),
		exists: id => existsSync(path.join(dir, 'sandboxes', `${id}.json`)),
		async close() { for (const [key, value] of Object.entries(saved)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; } await rm(dir, { recursive: true, force: true }); },
	};
}
const { leaseStore } = await import('../../scripts/quality/lib/pool-leases.mjs');
const { warmBoatPool, rateLimited, poolMember, machineName } = await import('../../scripts/quality/lib/boat-warm.mjs');
const quiet = process.env.POOL_TEST_LOG ? message => console.log(`${Date.now() % 100000} ${message}`) : () => {};
const warm = (fake, extra = {}) => warmBoatPool({ snapshot: 'img', type: 'default', store: leaseStore({ dir: fake.poolDir }), log: quiet, roomPorts: [1, 0], startsPerMinute: 600, ...extra });
const exited = child => new Promise(resolve => { if (child.exitCode !== null || child.signalCode !== null) resolve(); else child.once('exit', resolve); });

test('a machine goes back to the warm pool killed and wiped, and the next batch leases it with no boat start', { skip: process.platform === 'win32' }, async () => {
	const fake = await fakeBoat();
	try {
		const first = warm(fake);
		const vm = await first.create();
		assert.equal(vm.reused, false);
		assert.equal((await fake.calls('new')).length, 1);
		// What a batch leaves behind: its folder, a fixture world and a room process still running under ~/batch.
		const batchDir = path.join(fake.home(vm.id), 'batch');
		await mkdir(path.join(batchDir, 'out/r1'), { recursive: true });
		await mkdir(path.join(fake.home(vm.id), '.cache/mineagen/fixtures/worlds/w1'), { recursive: true });
		await mkdir(path.join(fake.home(vm.id), '.cache/mineagen/fixtures/servers/s1'), { recursive: true });
		const room = spawn('sleep', ['300'], { cwd: path.join(batchDir, 'out/r1'), stdio: 'ignore', detached: true });
		assert.equal(await first.release(vm), true);
		await Promise.race([exited(room), new Promise((_, reject) => setTimeout(() => reject(new Error('the room process outlived the release')), 5000))]);
		assert.equal(existsSync(batchDir), false, 'the batch folder is wiped');
		assert.equal(existsSync(path.join(fake.home(vm.id), '.cache/mineagen/fixtures/worlds')), false, 'fixture worlds go, as on a fresh machine');
		assert.ok(existsSync(path.join(fake.home(vm.id), '.cache/mineagen/fixtures/servers/s1')), 'prepared servers stay');
		assert.ok(existsSync(path.join(fake.home(vm.id), 'rooms/jdk/bin/java')), 'the image stays');
		assert.ok(fake.exists(vm.id), 'the machine is still running');

		// A second batch (its own lease store, as another thread would have) gets the same machine without a start.
		const second = warm(fake);
		const again = await second.create();
		assert.equal(again.id, vm.id);
		assert.equal(again.reused, true);
		assert.equal((await fake.calls('new')).length, 1, 'no new machine for the second batch');
		// While it is leased, another batch cannot have it and starts its own.
		const other = await first.create();
		assert.notEqual(other.id, vm.id);
		assert.equal((await fake.calls('new')).length, 2);
		assert.deepEqual((await fake.calls('delete')), [], 'nothing was deleted');
		first.store.stop(); second.store.stop();
	} finally { await fake.close(); }
});

test('a warm machine that fails its check, or comes from a rebuilt image, is never handed out', { skip: process.platform === 'win32' }, async () => {
	const fake = await fakeBoat();
	try {
		const pool = warm(fake);
		const vm = await pool.create();
		await pool.release(vm);
		await writeFile(path.join(fake.home(vm.id), '.mineagen-pool.json'), '{"someone":"else"}');
		const next = await warm(fake).create();
		assert.notEqual(next.id, vm.id);
		assert.equal(fake.exists(vm.id), false, 'the broken machine is deleted');
		assert.equal((await fake.calls('new')).length, 2);
		await pool.release(next);
		// The image was saved again under the same name: its old machines do not match and a new one starts.
		process.env.FAKE_BOAT_SNAPSHOT_ID = 'sid-2';
		const rebuilt = await warm(fake).create();
		assert.notEqual(rebuilt.id, next.id);
		assert.ok(fake.exists(next.id), 'an old-image machine is left for prune or its idle deadline, not taken');
	} finally { delete process.env.FAKE_BOAT_SNAPSHOT_ID; await fake.close(); }
});

test('machines named with --machines are leased, cleaned and given back, and never created or deleted', { skip: process.platform === 'win32' }, async () => {
	const fake = await fakeBoat();
	try {
		const owner = warm(fake);
		const made = await owner.startNew();
		// While the pool holds it, a --machines batch cannot have it: both lease by the machine's name.
		await assert.rejects(warm(fake, { machines: [made.id] }).create(), /busy or unusable/);
		await owner.release(made);
		const pool = warm(fake, { machines: [made.id, 'bx_missing'] });
		const vm = await pool.create();
		assert.equal(vm.id, made.id);
		await assert.rejects(warm(fake, { machines: [made.id] }).create(), /busy or unusable/);
		await rm(path.join(fake.home(vm.id), 'rooms/jdk'), { recursive: true });
		assert.equal(await pool.release(vm), true, 'a named machine that fails its check is left running');
		await pool.destroy(vm);
		assert.ok(fake.exists(vm.id));
		assert.equal((await fake.calls('new')).length, 1);
		assert.deepEqual(await fake.calls('delete'), []);
	} finally { await fake.close(); }
});

test('leases are exclusive across processes, and the lease of a batch that died or hung is broken', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'pool-leases-'));
	try {
		const lib = new URL('../../scripts/quality/lib/pool-leases.mjs', import.meta.url).href;
		const racer = `const { leaseStore } = await import(${JSON.stringify(lib)}); const store = leaseStore({ dir: ${JSON.stringify(dir)} });
console.log(JSON.stringify(await store.take(['m1', 'm2'], { batch: String(process.pid) }))); setTimeout(() => process.exit(0), 1500);`;
		const children = Array.from({ length: 6 }, () => spawn(process.execPath, ['--input-type=module', '-e', racer], { stdio: ['ignore', 'pipe', 'inherit'] }));
		const taken = await Promise.all(children.map(child => new Promise(resolve => { let text = ''; child.stdout.on('data', chunk => { text += chunk; }); child.on('exit', () => resolve(JSON.parse(text.trim()))); })));
		assert.deepEqual(taken.filter(Boolean).sort(), ['m1', 'm2'], 'each machine went to exactly one of six racing batches');
		const store = leaseStore({ dir });
		// Every racer has exited: their leases are stale and the next batch breaks them.
		assert.equal(await store.take(['m1']), 'm1');
		// A live process whose heartbeat stopped (hung, or a reused pid) loses its lease too; a fresh one keeps it.
		await writeFile(path.join(dir, 'leases/m2.json'), JSON.stringify({ token: 'x', pid: process.pid, heartbeatAt: Date.now() - 10 * 60_000 }));
		await writeFile(path.join(dir, 'leases/m3.json'), JSON.stringify({ token: 'y', pid: process.pid, heartbeatAt: Date.now() }));
		assert.equal(await leaseStore({ dir }).take(['m3', 'm2']), 'm2');
		assert.equal(await leaseStore({ dir }).take(['m3']), null);
		// A mutex left by a crashed holder is broken.
		await writeFile(path.join(dir, 'mutex'), JSON.stringify({ pid: 999999999, at: Date.now() }));
		assert.equal(await leaseStore({ dir }).take(['m4']), 'm4');
		store.stop();
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('machine starts are paced over every batch on the computer, a full minute is retried and a nearly full hour stops creation', { skip: process.platform === 'win32' }, async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'pool-pace-'));
	try {
		const began = Date.now();
		const a = leaseStore({ dir }), b = leaseStore({ dir });
		await Promise.all([a.reserveStart({ perMinute: 100, minGapMs: 250 }), b.reserveStart({ perMinute: 100, minGapMs: 250 }), a.reserveStart({ perMinute: 100, minGapMs: 250 })]);
		assert.ok(Date.now() - began >= 480, 'three starts from two batches are spaced by the gap');
		assert.equal(await a.recentStarts(), 3);
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 300);
		await assert.rejects(b.reserveStart({ perMinute: 3, minGapMs: 0, signal: controller.signal }), /batch stopped/, 'a fourth start in the minute waits');
	} finally { await rm(dir, { recursive: true, force: true }); }
	assert.deepEqual(rateLimited(new Error('boat new exited 1: 429 rate_limited window hour, retryAfterSeconds 1800')), { window: 'hour', retryAfterSeconds: 1800, concurrent: false });
	assert.equal(rateLimited(new Error('boat new exited 1: no_ready_machine')), null);
	const limited = await fakeBoat({ FAKE_BOAT_LIMIT_ONCE: '1' });
	try {
		const vm = await warm(limited).create();
		assert.ok(limited.exists(vm.id));
		assert.equal((await limited.calls('new')).length, 2, 'one refused start, then one that worked');
	} finally { await limited.close(); }
	const full = await fakeBoat({ FAKE_BOAT_HOUR_LEFT: '3' });
	try {
		await assert.rejects(warm(full).create(), /hour sandbox start limit has 3 starts left/);
		assert.equal((await full.calls('new')).length, 0);
	} finally { await full.close(); }
});

test('only machines this computer\'s pool named are members', () => {
	const name = machineName({ poolId: 'ab12cd', type: 'large', snapshot: 'mineagen-rooms-263', snapshotId: 'sid', rand: 'beef' });
	assert.match(name, /^rbpool-ab12cd-large-mineagenrooms263-[0-9a-f]{8}-beef$/);
	assert.equal(poolMember({ id: 'bx_1', name, state: 'idle', archiveAfter: null }, 'ab12cd').remainingMs, Infinity);
	assert.equal(poolMember({ id: 'bx_1', name, state: 'idle' }, 'ffffff'), null, 'another computer\'s pool');
	assert.equal(poolMember({ id: 'bx_2', name: 'tbcave-27', state: 'idle' }, 'ab12cd'), null, 'a machine another tool started');
});

test('rooms start on the first machine while a later one is still coming up, and a pool with release() keeps its machines', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-run-'));
	try {
		const events = [];
		let made = 0;
		const pool = {
			async create() { const vm = { id: `vm${++made}` }; if (vm.id === 'vm2') await new Promise(done => setTimeout(done, 250)); return vm; },
			async prepare() { return { code: '/c', out: '/o', jars: { new: '/j/new.jar', old: '/j/old.jar' }, inputs: {}, javaHome: '/jdk', template: '/t' }; },
			async start(vm, job) { events.push({ at: Date.now(), what: `start ${vm.id} ${job.room}` }); },
			async poll() { await new Promise(done => setTimeout(done, 150)); return 'done'; },
			async alive() { return true; },
			async fetch(vm, roomName) { for (const arm of ['new', 'old']) await writeRoom(out, roomName, arm, [row(`spot-${roomName}`)]); return { seconds: 1, arms: { new: { exit: 0 }, old: { exit: 0 } }, machine: {} }; },
			async keepAlive() {}, async usage() { return {}; },
			async release(vm) { events.push({ at: Date.now(), what: `release ${vm.id}` }); return true; },
			async destroy(vm) { events.push({ at: Date.now(), what: `delete ${vm.id}` }); },
		};
		const rooms = parseCommands(`@a ${LINE}\n@b ${LINE}\n@c ${LINE}\n@d ${LINE}`, ['new', 'old']);
		const began = Date.now();
		const result = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms, arms: [{ name: 'new' }, { name: 'old' }], pool, vms: 2, out, log: quiet });
		assert.ok(events[0].what.startsWith('start vm1') && events[0].at - began < 200, 'the first room did not wait for the late machine');
		assert.ok(events.some(event => event.what.startsWith('start vm2')), 'the late machine joined the queue');
		assert.ok(result.outcomes.every(outcome => !outcome.lost));
		assert.deepEqual(events.filter(event => event.what.startsWith('delete')), []);
		assert.ok(result.machines.every(vm => vm.returned && !vm.destroyed));
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('the merge finds rows finishRun wrote under another name, and calls several candidates invalid', async () => {
	const { armRows } = await import('../../scripts/quality/lib/room-batch-core.mjs');
	const dir = await mkdtemp(path.join(os.tmpdir(), 'arm-rows-'));
	try {
		// drawn-bow: acceptance.json + acceptance-summary.json, no result.json.
		await mkdir(path.join(dir, 'bow'));
		await writeFile(path.join(dir, 'bow/acceptance.json'), JSON.stringify([row('bow')]));
		await writeFile(path.join(dir, 'bow/acceptance-summary.json'), JSON.stringify({ planned: 1 }));
		await writeFile(path.join(dir, 'bow/results.json'), JSON.stringify({ drawnBow: {} }));
		assert.deepEqual(await armRows(path.join(dir, 'bow')), { rows: [row('bow')], summary: { planned: 1 }, file: 'acceptance.json', problem: null });
		// end-breath: result.json is its own report (an object); the rows are runs.json.
		await mkdir(path.join(dir, 'breath'));
		await writeFile(path.join(dir, 'breath/result.json'), JSON.stringify({ arm: 'new', runs: [] }));
		await writeFile(path.join(dir, 'breath/runs.json'), JSON.stringify([row('r1'), row('r2')]));
		await writeFile(path.join(dir, 'breath/runs-summary.json'), JSON.stringify({ planned: 2 }));
		assert.equal((await armRows(path.join(dir, 'breath'))).file, 'runs.json');
		await writeFile(path.join(dir, 'breath/acceptance.json'), JSON.stringify([row('x')]));
		await writeFile(path.join(dir, 'breath/acceptance-summary.json'), JSON.stringify({ planned: 1 }));
		assert.match((await armRows(path.join(dir, 'breath'))).problem, /several row files \(acceptance\.json, runs\.json\)/);
		// Through the merge: the rows count, and the summary shows them instead of "no rows".
		const out = path.join(dir, 'out');
		for (const arm of ['new', 'old']) {
			await mkdir(path.join(out, 'rooms/end-breath', arm), { recursive: true });
			await writeFile(path.join(out, 'rooms/end-breath', arm, 'result.json'), JSON.stringify({ arm, runs: [] }));
			await writeFile(path.join(out, 'rooms/end-breath', arm, 'runs.json'), JSON.stringify([row('r1')]));
			await writeFile(path.join(out, 'rooms/end-breath', arm, 'runs-summary.json'), JSON.stringify({ planned: 1 }));
		}
		const rooms = [room('end-breath')];
		const merged = await mergeArms({ out, rooms, arms: ['new', 'old'], outcomes: [{ room: 'end-breath', lost: false, arms: { new: { exit: 0, seconds: 3 }, old: { exit: 0, seconds: 3 } } }] });
		assert.equal(merged.new.summary.status, 'PASS');
		const text = formatSummary({ batch: { name: 'b', code: 'abcdef12' }, merged, arms: ['new', 'old'], wallSeconds: 1, vms: 1, rooms });
		assert.doesNotMatch(text, /no rows/);
		assert.match(text, /end-breath: pass d=0 dmg=0/);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a machine the pool hands back to the same batch after a release is never deleted at the batch end', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-run-'));
	try {
		const destroyed = [], released = [];
		let leases = 0;
		// One machine only: every create() is a new lease of bx_same, as a warm pool gives after a release.
		const pool = {
			async create() { leases++; return { id: 'bx_same' }; },
			async prepare() { return { code: '/c', out: '/o', jars: { new: '/j/new.jar', old: '/j/old.jar' }, inputs: {}, javaHome: '/jdk', template: '/t' }; },
			async start() {},
			async poll() { return 'done'; },
			async alive() { return true; },
			// The first copy fails, so the room is lost on the first lease and re-queued for a replacement.
			async fetch(vm, roomName) { if (leases === 1) throw new Error('cut'); for (const arm of ['new', 'old']) await writeRoom(out, roomName, arm, [row(`spot-${roomName}`)]); return { seconds: 1, arms: {}, machine: {} }; },
			async keepAlive() {}, async usage() { return {}; },
			async release(vm) { released.push(vm.id); return true; },
			async destroy(vm) { destroyed.push(vm.id); },
		};
		const rooms = parseCommands(`@a ${LINE}`, ['new', 'old']);
		const result = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms, arms: [{ name: 'new' }, { name: 'old' }], pool, vms: 1, out, log: quiet });
		assert.equal(leases, 2);
		assert.deepEqual(destroyed, [], 'no boat delete for a machine that went back to the pool');
		assert.deepEqual(released, ['bx_same', 'bx_same'], 'each lease is given back on its own');
		assert.ok(result.machines.every(vm => vm.returned));
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('a warm machine whose check gets no answer is skipped and kept, never deleted', { skip: process.platform === 'win32' }, async () => {
	const fake = await fakeBoat();
	try {
		const pool = warm(fake);
		const vm = await pool.create();
		await pool.release(vm);
		// The next check cannot reach the machine (exec fails the way a boat API error does), so it is not reused.
		await writeFile(path.join(fake.dir, 'boat.mjs'), FAKE_BOAT.replace("else if (command === 'exec') {", "else if (command === 'exec' && process.env.FAKE_BOAT_EXEC_DOWN) { out({ success: false, error: 'api unavailable' }); }\nelse if (command === 'exec') {"));
		process.env.FAKE_BOAT_EXEC_DOWN = '1';
		const other = await warm(fake).create().catch(error => error);
		assert.ok(other instanceof Error, 'the new machine cannot be checked either');
		assert.ok(fake.exists(vm.id), 'the unreachable warm machine is still there');
		delete process.env.FAKE_BOAT_EXEC_DOWN;
		const again = await warm(fake).create();
		assert.equal(again.id, vm.id, 'once it answers, it is reused');
	} finally { delete process.env.FAKE_BOAT_EXEC_DOWN; await fake.close(); }
});

test('a machine with auto-stop turned off keeps it through a lease and a return', { skip: process.platform === 'win32' }, async () => {
	const fake = await fakeBoat();
	try {
		const owner = warm(fake);
		const made = await owner.startNew();
		await owner.release(made);
		const file = path.join(fake.dir, 'sandboxes', `${made.id}.json`);
		await writeFile(file, JSON.stringify({ ...JSON.parse(await readFile(file, 'utf8')), archiveAfter: null }));
		const extendsBefore = (await fake.calls('extend')).length;
		const pool = warm(fake, { machines: [made.id] });
		const vm = await pool.create();
		await pool.keepAlive(vm);
		await pool.release(vm);
		assert.equal((await fake.calls('extend')).length, extendsBefore, 'no extend --ttl put a deadline on it');
		assert.equal(JSON.parse(await readFile(file, 'utf8')).archiveAfter, null);
	} finally { await fake.close(); }
});

test('a stop during prepare gives a machine back to the pool only once its upload has ended', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'room-batch-run-'));
	try {
		const events = [];
		const pool = {
			async create() { return { id: 'vm1' }; },
			async prepare() { await new Promise(done => setTimeout(done, 400)); events.push('prepare ended'); return { code: '/c', out: '/o', jars: {}, inputs: {}, javaHome: '/jdk', template: '/t' }; },
			async start() {}, async poll() { return 'done'; }, async alive() { return true; }, async fetch() { return {}; },
			async keepAlive() {}, async usage() { return {}; },
			async release() { events.push('release'); return true; },
			async destroy() { events.push('delete'); },
		};
		const controller = new AbortController();
		setTimeout(() => controller.abort(), 100);
		const rooms = parseCommands(`@a ${LINE}`, ['new']);
		const result = await runBatch({ batch: { name: 't', code: 'abc12345' }, rooms, arms: [{ name: 'new' }], pool, vms: 1, out, log: quiet, signal: controller.signal });
		assert.deepEqual(events, ['prepare ended', 'release']);
		assert.equal(result.outcomes[0].reason, 'batch stopped');
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('a new machine gets its first room only once its image has fully arrived', { skip: process.platform === 'win32' }, async () => {
	const fake = await fakeBoat({ FAKE_BOAT_HYDRATE_MS: '2500' });
	try {
		const began = Date.now();
		const vm = await warm(fake).create();
		assert.ok(Date.now() - began >= 2500, 'create waited for hydration');
		const infos = (await fake.calls('info')).filter(args => args[1] === vm.id);
		assert.ok(infos.length >= 2, 'it asked boat until the machine said hydrated');
	} finally { delete process.env.FAKE_BOAT_HYDRATE_MS; await fake.close(); }
});
