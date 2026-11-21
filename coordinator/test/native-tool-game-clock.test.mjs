import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeToolRuntime, gatherStepTimeout } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { gameClockFromObservations } from '../src/game-clock.mjs';

// A fixture at /tick rate 60 passes a game clock; these prove the runtime times gameplay on it and stays on wall time
// when no clock is passed (production).

const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));
const spin = async (turns = 30) => { for (let i = 0; i < turns; i++) await new Promise((resolve) => setImmediate(resolve)); };

/** A clock that moves only when the test advances it; its timers fire on advance. */
function fakeClock(start = 5_000_000) {
	let at = start, id = 0;
	const timers = new Map(), scheduled = [];
	const clock = {
		now: () => at,
		setTimeout: (callback, ms, ...args) => { const handle = ++id; timers.set(handle, { due: at + ms, ms, run: () => callback(...args) }); scheduled.push(ms); return handle; },
		clearTimeout: (handle) => { timers.delete(handle); },
		sleep: (ms) => new Promise((resolve) => { clock.setTimeout(resolve, ms); }),
		advance(ms) {
			at += ms;
			for (const [handle, timer] of [...timers].sort((a, b) => a[1].due - b[1].due)) if (timer.due <= at) { timers.delete(handle); timer.run(); }
		},
		timers, scheduled,
	};
	return clock;
}

const saved = JSON.parse(readFileSync(new URL('./fixtures/fortress-spawner/c8861.json', import.meta.url)));

function findRun({ clock, onMove }) {
	let sequence = 0, samples = 0;
	const observation = structuredClone(saved.windows[1].observation);
	const record = { agentId: `clock-find-${Math.random().toString(36).slice(2, 8)}`, goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
	const moves = [];
	let runtime;
	runtime = new NativeToolRuntime({
		clock,
		requestObservation: async () => { samples += 1; return { eventSequence: ++sequence, observation: structuredClone(observation) }; },
		inspectObservation: async () => ({ survey: {} }),
		bridge: { send: async (type, _agent, p) => {
			if (type !== 'action_command') return;
			const reply = (state, reasonCode) => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state, reasonCode, executionStarted: true, physicalAttempted: true });
			if (p.actionType === 'control') { queueMicrotask(() => reply('SUCCEEDED', 'CONTROL_SEGMENT_COMPLETED')); return; }
			moves.push(p);
			onMove(p, () => reply('FAILED', 'NO_ROUTE'));
		} },
	});
	runtime.updateObservation(record, observation, { eventSequence: ++sequence });
	const finding = runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'clock', callId: 'find',
		tool: normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'spawner', within: 96, timeoutMs: 60_000 }, why: 'game clock fixture' }) }, record);
	return { runtime, record, finding, moves, samples: () => samples };
}

test('find: the sighting watcher sleeps 2 s on the game clock and samples when that clock reaches it', async (t) => {
	const clock = fakeClock();
	let finishLeg = null;
	const run = findRun({ clock, onMove: (_p, finish) => { finishLeg = finish; } });
	t.after(() => run.runtime.dispose(run.record.agentId, 'test_complete'));
	run.finding.catch(() => {});
	await spin();
	assert.ok(finishLeg !== null, 'the search starts a leg');
	assert.ok([...clock.timers.values()].some((timer) => timer.ms === 2_000), 'the watcher waits on the game clock');
	const before = run.samples();
	await spin();
	assert.equal(run.samples(), before, 'no sample while game time stands still');
	clock.advance(2_000);
	await spin();
	assert.ok(run.samples() > before, 'a sample once 2 s of game time passed');
	finishLeg();
	await spin();
});

test('find: its deadline is game time, so legs stop once the game clock passes timeoutMs', async (t) => {
	const clock = fakeClock();
	const run = findRun({ clock, onMove: (_p, finish) => { clock.advance(70_000); queueMicrotask(finish); } });
	t.after(() => run.runtime.dispose(run.record.agentId, 'test_complete'));
	const result = await run.finding;
	assert.equal(run.moves.length, 1, `one leg, then the 60 s search budget is spent (${result.reasonCode})`);
	assert.ok(run.moves[0].arguments.timeoutMs <= 60_000, 'the leg gets at most what the search has left');
	assert.equal(result.state, 'TIMED_OUT', JSON.stringify(result).slice(0, 300));
});

function gatherRun({ clock, stepMs }) {
	const record = { agentId: 'clock-gather', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'low', goalRevision: 3 };
	const observation = { player: { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, health: 20 }, world: { dimension: 'minecraft:overworld' }, inventory: { items: [] },
		blocks: [0, 1, 2, 3, 4, 5].map((dz) => ({ blockId: 'minecraft:oak_log', x: 1, y: 64, z: dz, visible: true })), items: [] };
	const commands = [];
	let runtime, sequence = 1;
	runtime = new NativeToolRuntime({
		...(clock === undefined ? {} : { clock }),
		bridge: { send: async (type, _agent, payload) => {
			if (type !== 'action_command') return;
			// mine is look_at then break_block: the break is the step that takes game time.
			if (payload.actionType === 'break_block') { commands.push(payload); stepMs(); }
			queueMicrotask(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: payload.goalRevision, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' }));
		} },
		requestObservation: async (_record, { afterEventSequence }) => ({ eventSequence: Math.max(afterEventSequence, sequence++) + 1, observation: structuredClone(observation) }),
	});
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: 1 });
	const tool = normalizeMinecraftToolCall('gather', { itemId: 'oak_log', count: 64, timeoutMs: 30_000 });
	return { runtime, record, commands, result: runtime.execute({ agentId: record.agentId, goalRevision: 3, turnId: 'turn', callId: 'gather', tool }, record) };
}

test('gather: its timeout and each step timeout count game time', async (t) => {
	const clock = fakeClock();
	const run = gatherRun({ clock, stepMs: () => clock.advance(20_000) });
	t.after(() => run.runtime.dispose(run.record.agentId, 'test_complete'));
	const result = await run.result;
	assert.equal(result.reasonCode, 'GATHER_TIMEOUT', JSON.stringify(result).slice(0, 300));
	const timeouts = run.commands.map((command) => command.arguments?.timeoutMs);
	assert.equal(run.commands.length, 2, `two steps fit 30 s of game time at 20 s each (${timeouts})`);
	assert.equal(timeouts[1], 10_000, 'the second step gets what is left of 30 s after 20 s of game time');
});

test('gather: with no clock it stays on wall time (Date.now)', async (t) => {
	t.mock.timers.enable({ apis: ['Date'], now: 1_000_000 });
	const run = gatherRun({ stepMs: () => t.mock.timers.tick(20_000) });
	t.after(() => run.runtime.dispose(run.record.agentId, 'test_complete'));
	const result = await run.result;
	assert.equal(result.reasonCode, 'GATHER_TIMEOUT');
	assert.equal(run.commands.length, 2);
	assert.equal(run.commands[1].arguments.timeoutMs, 10_000);
	assert.equal(gatherStepTimeout(15_000, Date.now() + 4_000), 4_000, 'the helper defaults to wall time');
});

test('obtain: its deadline is game time', async (t) => {
	const clock = fakeClock();
	const record = { agentId: 'clock-obtain', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'high', serviceTier: 'default' };
	let sequence = 1;
	const observation = { world: { dimension: 'minecraft:overworld' },
		player: { x: 0.5, y: 64, z: 0.5, yaw: 0, health: 20, air: 300, maxAir: 300, onGround: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_ingot', slot: 0, count: 3 }, { itemId: 'minecraft:crafting_table', slot: 1, count: 1 }] }, blocks: [] };
	for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) observation.blocks.push({ blockId: 'minecraft:stone', x, y: 63, z, placeableFaces: ['up'] });
	const commands = [];
	let runtime;
	runtime = new NativeToolRuntime({ clock, registry: { get: () => record },
		requestObservation: async () => ({ observation: structuredClone(observation), eventSequence: ++sequence }),
		inspectObservation: async (_r, q) => ({ section: q.section, entries: observation.blocks, coverage: { hasMore: false }, eventSequence: ++sequence }),
		bridge: { send: async (type, _a, p) => {
			if (type !== 'action_command') return;
			commands.push(p.actionType);
			assert.ok(commands.length < 30, 'bounded');
			if (p.actionType === 'place_block') { observation.blocks.push({ blockId: p.arguments.itemId, x: p.arguments.x, y: p.arguments.y, z: p.arguments.z }); observation.inventory.items.splice(1, 1); }
			// Each body action takes 70 s of game time: the 60 s obtain is out of time after the first.
			clock.advance(70_000);
			queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED', executionStarted: true }));
		} } });
	t.after(() => runtime.dispose(record.agentId, 'test_complete'));
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: sequence });
	const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'obtain', callId: 'obtain',
		tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'bucket', timeoutMs: 60_000 }, why: 'game clock fixture' }) }, record);
	assert.equal(result.reasonCode, 'OBTAIN_TIMEOUT', JSON.stringify(result).slice(0, 400));
	assert.ok(!commands.includes('craft_table'), `no craft after the game-time budget ran out (${commands})`);
});

function programRun(t, clock) {
	const record = { agentId: 'clock-program', provider: 'codex', model: 'test', reasoningEffort: 'high', goalRevision: 1 };
	const observation = { player: { x: 0, y: 64, z: 0, health: 20 }, inventory: { items: [], tagCounts: {} }, items: [], entities: [], blocks: [] };
	const runtime = new NativeToolRuntime({ ...(clock === undefined ? {} : { clock }), bridge: { send: async () => {} },
		requestObservation: async (_record, { afterEventSequence }) => ({ observation, eventSequence: afterEventSequence + 1 }) });
	t.after(() => runtime.disposeAll());
	runtime.updateObservation(record, observation, { eventSequence: 1 });
	let callId = 0;
	const call = (name, args = {}) => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'turn', callId: String(++callId), tool: normalizeMinecraftToolCall(name, args) }, record);
	return { call };
}
const LONG_PROGRAM = 'program.onUnhandledAttention("continue_and_notify"); await player.wait(100000);';

test('wait on a running program, and the program deadline, run on the game clock', async (t) => {
	const clock = fakeClock();
	const { call } = programRun(t, clock);
	const handle = await call('runProgram', { background: true, timeoutMs: 7_000, source: LONG_PROGRAM });
	assert.equal(handle.state, 'RUNNING');
	assert.equal(handle.deadlineEpochMs, clock.now() + 7_000, 'the reported deadline is game time');
	assert.ok(clock.scheduled.includes(7_000), 'the executor times the program on the game clock');
	let waited = null;
	call('wait', { durationMs: 5_000 }).then((result) => { waited = result; });
	await spin();
	assert.ok([...clock.timers.values()].some((timer) => timer.ms === 5_000), 'the wait sleeps on the game clock');
	assert.equal(waited, null, 'no game time passed, so the wait has not elapsed');
	clock.advance(5_000);
	await spin();
	assert.equal(waited?.reasonCode, 'WAIT_ELAPSED');
});

test('wait on a running program stays on wall timers with no clock', async (t) => {
	t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: 2_000_000 });
	const { call } = programRun(t);
	const handle = await call('runProgram', { background: true, timeoutMs: 7_000, source: LONG_PROGRAM });
	assert.equal(handle.deadlineEpochMs, Date.now() + 7_000);
	let waited = null;
	call('wait', { durationMs: 5_000 }).then((result) => { waited = result; });
	await spin();
	assert.equal(waited, null);
	t.mock.timers.tick(5_000);
	await spin();
	assert.equal(waited?.reasonCode, 'WAIT_ELAPSED');
});

test('gameClockFromObservations: game ticks, extrapolation with a cap, never backwards, per world', () => {
	let wall = 1_000_000;
	const clock = gameClockFromObservations({ tickRate: 60, wallNow: () => wall });
	const sample = (gameTime, extra = {}) => ({ observedAtEpochMs: wall, world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime, ...extra } });
	assert.equal(clock.now(), 1_000_000, 'starts at wall time');
	clock.observe(sample(100));
	wall += 500;
	assert.equal(clock.now(), 1_001_500, '500 ms of wall at 60 TPS extrapolates to 1.5 s of game time');
	clock.observe(sample(130));
	assert.equal(clock.now(), 1_001_500, '30 ticks are 1.5 s: the sample confirms the extrapolation');
	wall += 5_000;
	assert.equal(clock.now(), 1_004_500, 'with no sample it extrapolates at most 1 s of wall');
	clock.observe(sample(150));
	assert.equal(clock.now(), 1_004_500, 'a sample behind the extrapolation does not move it back');
	clock.observe(sample(250));
	assert.equal(clock.now(), 1_007_500, '100 more ticks are 5 s of game time');
	clock.observe(sample(250));
	wall += 10_000;
	assert.equal(clock.now(), 1_010_500, 'a frozen world (same gameTime) stops the clock after the cap');
	clock.observe(sample(7, { dimension: 'minecraft:the_nether' }));
	assert.equal(clock.now(), 1_010_500, 'another world re-anchors with no time added');
	clock.observe(sample(27, { dimension: 'minecraft:the_nether' }));
	assert.equal(clock.now(), 1_011_500, 'then counts its own ticks');
	clock.observe({ world: {} });
	assert.equal(clock.now(), 1_011_500, 'a sample with no gameTime changes nothing');
});

test('gameClockFromObservations: a timer fires on game time, or after its length in wall time when samples stop', async () => {
	const clock = gameClockFromObservations({ tickRate: 60, maxPollMs: 5 });
	const tick = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
	let gameTime = 0;
	clock.observe({ observedAtEpochMs: Date.now(), world: { gameTime } });
	let fired = false;
	clock.setTimeout(() => { fired = true; }, 600);
	// 600 ms of game time at 60 TPS is 200 ms of wall time: samples say 12 ticks (600 ms) passed.
	await tick(30);
	gameTime += 12;
	clock.observe({ observedAtEpochMs: Date.now(), world: { gameTime } });
	await tick(30);
	assert.ok(fired, 'fired once game time reached it');
	const frozen = gameClockFromObservations({ tickRate: 60, maxExtrapolateMs: 0, maxPollMs: 5 });
	frozen.observe({ observedAtEpochMs: Date.now(), world: { gameTime: 5 } });
	const started = Date.now();
	await frozen.sleep(80);
	assert.ok(Date.now() - started >= 75, 'with game time stopped, the sleep ends at its wall length');
	let cancelled = true;
	const handle = clock.setTimeout(() => { cancelled = false; }, 20);
	clock.clearTimeout(handle);
	await tick(50);
	assert.ok(cancelled, 'a cleared timer never fires');
});

test('the runtime feeds the clock every sample, pushed or requested', async (t) => {
	let wall = 9_000_000;
	const clock = gameClockFromObservations({ tickRate: 60, wallNow: () => wall });
	const record = { agentId: 'clock-feed', provider: 'codex', model: 'test', reasoningEffort: 'low', goalRevision: 1 };
	let gameTime = 1_000, sequence = 1;
	const sample = () => ({ observedAtEpochMs: wall, player: { x: 0, y: 64, z: 0, health: 20 }, world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime },
		inventory: { items: [] }, items: [], entities: [], blocks: [] });
	const runtime = new NativeToolRuntime({ clock, bridge: { send: async () => {} },
		requestObservation: async () => ({ observation: sample(), eventSequence: ++sequence }) });
	t.after(() => runtime.disposeAll());
	runtime.updateObservation(record, sample(), { eventSequence: ++sequence });
	const start = clock.now();
	gameTime += 60;
	runtime.updateObservation(record, sample(), { eventSequence: ++sequence });
	assert.equal(clock.now() - start, 3_000, 'a pushed sample 60 ticks later moves the clock 3 s');
	gameTime += 40;
	await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'turn', callId: 'observe', tool: normalizeMinecraftToolCall('observe', {}) }, record);
	assert.equal(clock.now() - start, 5_000, 'a sample the runtime asks for moves it too');
});

test('gameClockFromObservations: a slow server that still ticks keeps timers on game time', async () => {
	const clock = gameClockFromObservations({ tickRate: 20, maxPollMs: 5 });
	const tick = (ms) => new Promise((resolve) => { setTimeout(resolve, ms); });
	let gameTime = 0;
	clock.observe({ observedAtEpochMs: Date.now(), world: { gameTime } });
	// 10 TPS: one tick every 100 ms of wall time, so 400 ms of game time takes about 800 ms of wall time.
	const ticker = setInterval(() => { gameTime += 1; clock.observe({ observedAtEpochMs: Date.now(), world: { gameTime } }); }, 100);
	try {
		let firedAt = null;
		const started = Date.now();
		clock.setTimeout(() => { firedAt = Date.now() - started; }, 400);
		await tick(520);
		assert.equal(firedAt, null, 'not at its wall length: the server still ticks');
		await tick(500);
		assert.ok(firedAt !== null && firedAt >= 520, `fired on game time (${firedAt} ms of wall)`);
	} finally { clearInterval(ticker); }
});

test('clock.at: a sample on the game timeline from its gameTime, else its wall stamp scaled at the tick rate', () => {
	let wall = 1_000_000;
	const clock = gameClockFromObservations({ tickRate: 60, wallNow: () => wall });
	const sample = (gameTime, observedAtEpochMs, dimension = 'minecraft:overworld') => ({ world: { worldId: 'w', dimension, gameTime }, observedAtEpochMs });
	assert.equal(clock.at({ observedAtEpochMs: 999_000 }), 999_000, 'before any sample: its wall stamp');
	assert.equal(clock.at({}), null, 'no time at all');
	clock.observe(sample(10_000, wall));
	const start = clock.now();
	wall += 1_000;
	clock.observe(sample(10_060, wall));
	assert.equal(clock.at(sample(10_060, wall)), start + 3_000, '60 ticks are 3 game s, though 1 s of wall passed');
	assert.equal(clock.at(sample(10_030, wall - 500)), start + 1_500, 'an older sample of the same world');
	assert.equal(clock.at({ observedAtEpochMs: wall - 500 }), start + 1_500, 'no gameTime: its wall stamp at 3x from the anchor');
	assert.equal(clock.at(sample(99_999, wall, 'minecraft:the_nether')), start + 3_000, 'another dimension: its wall stamp');
	assert.ok(clock.at(sample(20_000, wall)) <= clock.now(), 'never later than now()');
});

test('WALL_CLOCK.at reads observedAtEpochMs exactly as the runtime did before the clock', async () => {
	const { WALL_CLOCK, completeClock } = await import('../src/game-clock.mjs');
	assert.equal(WALL_CLOCK.at({ observedAtEpochMs: 1234 }), 1234);
	assert.equal(WALL_CLOCK.at({ observedAtEpochMs: Number.NaN }), null);
	assert.equal(WALL_CLOCK.at(undefined), null);
	assert.equal(completeClock(WALL_CLOCK), WALL_CLOCK, 'production keeps the very same clock');
	assert.equal(completeClock({ now: () => 42, sleep: async () => {} }).at({ observedAtEpochMs: 7 }), 42, 'a clock without at() stamps samples with its now()');
});

// Two failures from one block, then a third: a fixture at 60 TPS sends them 6.7 s and 25 s of wall time after the
// first, which is 20 s and 75 s of game time.
async function repeatedFailures(clock, setWall) {
	const record = { agentId: `clock-repeat-${Math.random().toString(36).slice(2, 8)}`, goalRevision: 1, provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low' };
	const sent = [];
	const runtime = new NativeToolRuntime({ ...(clock ? { clock } : {}), bridge: { send: async (type, _agent, payload) => { if (type === 'action_command') sent.push(payload); } } });
	const base = 1_000_000, repeats = [];
	try {
		for (const [index, [wallMs, gameTime]] of [[0, 10_000], [6_667, 10_400], [25_000, 11_500]].entries()) {
			setWall(base + wallMs);
			runtime.updateObservation(record, { position: { x: -30.7, y: 66, z: -36.5 }, world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime }, observedAtEpochMs: base + wallMs }, { eventSequence: index + 1 });
			const pending = runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'turn', callId: `call-${index}`, tool: { kind: 'action', actionType: 'move_to', arguments: { x: -48 - index, y: 68, z: -26, tolerance: 3 } } }, record);
			await spin();
			runtime.onActionResult(record, { actionId: sent.at(-1).actionId, state: 'FAILED', reasonCode: 'NO_PATH', executionStarted: true, physicalAttempted: true,
				observedAtEpochMs: base + wallMs, actionObservation: { position: { x: -30.7, y: 66, z: -36.5 }, observedAtEpochMs: base + wallMs } });
			repeats.push((await pending).failure?.repeat ?? null);
		}
	} finally { runtime.disposeAll(); }
	return repeats;
}

test('repeated failures: the 60 s window and the seconds it reports count game time on a game clock', async () => {
	let wall = 0;
	const game = await repeatedFailures(gameClockFromObservations({ tickRate: 60, wallNow: () => wall }), (ms) => { wall = ms; });
	assert.deepEqual(game, [null, '2nd from this block in 20s', '2nd from this block in 55s'], 'the first failure is 75 game s old by the third');
	const production = await repeatedFailures(null, () => {});
	assert.deepEqual(production, [null, '2nd from this block in 7s', '3rd from this block in 25s'], 'no clock: wall time, as before');
});

// A start sample taken 0.9 s of wall time before dispatch: 2.7 s of game time at 60 TPS, past the 2 s the failure's
// change text names as stale; on wall time (production) it is 0.9 s and not named.
async function startSampleChange(clock, { sampleAt, wait }) {
	const record = { agentId: `clock-age-${Math.random().toString(36).slice(2, 8)}`, goalRevision: 1, provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low' };
	const sent = [];
	const runtime = new NativeToolRuntime({ ...(clock ? { clock } : {}), bridge: { send: async (type, _agent, payload) => { if (type === 'action_command') sent.push(payload); } } });
	try {
		runtime.updateObservation(record, { position: { x: 0.5, y: 66, z: 0.5 }, world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime: 5_000 }, observedAtEpochMs: sampleAt }, { eventSequence: 1 });
		wait();
		const pending = runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'turn', callId: 'age', tool: { kind: 'action', actionType: 'move_to', arguments: { x: 9, y: 66, z: 0, tolerance: 1 } } }, record);
		await spin();
		runtime.onActionResult(record, { actionId: sent.at(-1).actionId, state: 'FAILED', reasonCode: 'NO_PATH', executionStarted: true, physicalAttempted: true,
			actionObservation: { position: { x: 4.5, y: 66, z: 0.5 } } });
		return (await pending).failure.changed;
	} finally { runtime.disposeAll(); }
}

test('a body action\'s start sample age counts game time on a game clock', async () => {
	let wall = 3_000_000;
	const clock = gameClockFromObservations({ tickRate: 60, wallNow: () => wall });
	assert.equal(await startSampleChange(clock, { sampleAt: wall, wait: () => { wall += 900; } }), 'moved 4m since a position seen 3s before it started');
	assert.equal(await startSampleChange(null, { sampleAt: Date.now() - 900, wait: () => {} }), 'moved 4m', 'no clock: 0.9 s of wall time, not named stale');
});

test('a runtime on a game clock gives its executor wall timers for the cancel acknowledgement', () => {
	const source = readFileSync(new URL('../src/native-tool-runtime.mjs', import.meta.url), 'utf8');
	assert.match(source, /acknowledgementSetTimeoutFn: setTimeout, acknowledgementClearTimeoutFn: clearTimeout/);
});
