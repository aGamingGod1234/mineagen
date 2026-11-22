import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { FakePlanner, eventually, factToWireObservation, immutableGoalSpec, start } from './fixtures/dynamic-main-fixture.mjs';

// obtain runs inside the model's own call, so a wake could only reach the model when obtain ends. A search whose walk keeps
// looping for 3 min of game time with no item gained is stopped instead: obtain hands back SEARCH_STALLED in that call.
const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
const START = 1_787_184_000_000;

async function launch({ tree = false, call = null } = {}) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	planner.steerNativeTurn = async () => ({ turnId: 'deciding' });
	planner.interrupt = async () => {};
	const turns = [];
	let obtained = null;
	planner.requestNativeTurn = (request) => {
		planner.requests.push(request);
		const promise = new Promise((resolve) => turns.push(resolve));
		if (planner.requests.length === 1) {
			obtained = request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId: 'call-1',
				tool: call ?? normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'oak_log', count: 4 }, why: 'wood for tools' }) });
			obtained.catch(() => {});
		}
		return promise;
	};
	const traces = [];
	const run = await start({ registry, planner, config: CONFIG, traceWriter: { write(event, details) { traces.push({ event, ...details }); } } });
	// The mod answers a cancel with the action's CANCELLED result.
	let resultSequence = 10_000;
	const send = run.bridge.send.bind(run.bridge);
	run.bridge.send = async (type, agentId, payload, options) => {
		await send(type, agentId, payload, options);
		if (type === 'action_cancel') queueMicrotask(() => run.bridge.emit('action_result', { agentId, payload: { goalRevision: 1, actionId: payload.actionId, state: 'CANCELLED', reasonCode: 'MODEL_CANCELLED', executionStarted: true, eventSequence: ++resultSequence } }));
	};
	const sampleInspection = run.bridge.sampleInspection.bind(run.bridge);
	run.bridge.sampleInspection = (request) => {
		if (request.payload.query.section !== 'blocks') return sampleInspection(request);
		run.bridge.replyInspection(request, { entries: run.bridge.latestObservations.get(request.agentId)?.blocks ?? [], coverage: { hasMore: false } });
	};
	let sequence = 0;
	// A wire sample at game second s: the body steps between two cells (a loop), carrying `logs` oak logs.
	run.observe = (s, { logs = 0 } = {}) => {
		const items = [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }, ...(logs > 0 ? [{ itemId: 'minecraft:oak_log', count: logs, slot: 1 }] : [])];
		const blocks = [{ blockId: 'minecraft:sand', x: 0, y: 63, z: 0 }, ...(tree ? [{ blockId: 'minecraft:oak_log', x: 30, y: 64, z: 30 }, { blockId: 'minecraft:oak_log', x: 30, y: 65, z: 30 }] : [])];
		const wire = factToWireObservation({ player: { x: sequence % 2, y: 64, z: 0, health: 20 }, inventory: { selectedSlot: 0, items }, blocks }, 1, ++sequence, false, 1);
		wire.world = { ...wire.world, gameTime: 1_000 + s * 20 };
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { ...wire, observedAtEpochMs: START + s * 1_000 } });
	};
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Get wood.', goalSpec: immutableGoalSpec('Get wood.') } });
	run.observe(0);
	await eventually(() => planner.requests.length === 1);
	await eventually(() => run.bridge.sent.some(({ type }) => type === 'action_command'));
	const look = () => planner.requests[0].executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: `look-${sequence}`, tool: normalizeMinecraftToolCall('observe', {}) });
	const again = () => planner.requests[0].executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'call-2',
		tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'oak_log', count: 4 }, why: 'try again' }) });
	planner.steers = [];
	planner.steerNativeTurn = async (request) => { planner.steers.push(request); return { turnId: 'deciding' }; };
	return { run, planner, traces, again, look, obtained: () => obtained, finish: () => { for (const resolve of turns) resolve({ status: 'completed', toolCalls: 1 }); } };
}

async function loop(run, from, to, every = 5, logs = () => 0) {
	for (let s = from; s <= to; s += every) { run.observe(s, { logs: logs(s) }); await settle(); }
}

test('an obtain whose walk loops for 3 min of game time hands back SEARCH_STALLED inside the model\'s call', async () => {
	const { run, planner, traces, obtained, finish, again } = await launch();
	try {
		let settled = null;
		obtained().then((result) => { settled = result; }, () => {});
		await loop(run, 5, 170);
		assert.equal(settled, null, 'under 3 min the search keeps going');
		assert.ok(traces.some(({ event, trigger, verdict }) => event === 'native_wake_filtered' && trigger === 'movement_loop' && verdict === 'fold'), 'the walk loops');
		await loop(run, 175, 230);
		await eventually(() => settled !== null);
		assert.equal(settled.state, 'INTERRUPTED', JSON.stringify(settled).slice(0, 400));
		assert.equal(settled.reasonCode, 'SEARCH_STALLED');
		assert.match(settled.message, /^Searched 3 min without progress \(no item gained; \d+ loop or stall notes\); decide, then call obtain again to continue/);
		assert.ok(traces.some(({ event, verdict, reason }) => event === 'native_wake_filtered' && verdict === 'stop' && /^step obtain stalled 1[89]\d s$/.test(reason)));
		assert.equal(planner.requests.length, 1, 'no extra turn: the result reaches the model in its own call');
		// The looping walk is the stuck part: it is cancelled, and obtain can be called again at once.
		const cancels = run.bridge.sent.filter(({ type }) => type === 'action_cancel');
		assert.equal(cancels.length, 1, 'the stuck leg is cancelled');
		assert.equal(settled.running, undefined, 'no leg is handed back running');
		assert.equal(settled.stoppedLeg.actionId, cancels[0].payload.actionId);
		assert.equal(settled.stoppedLeg.cancel, 'CANCELLED');
		assert.ok(traces.some(({ event, state }) => event === 'native_stalled_leg_cancelled' && state === 'CANCELLED'));
		// Called again as the message says, obtain starts a fresh search: the body is free (before the fix it came back
		// NO_SOURCE, its legs refused with NATIVE_ACTION_IN_PROGRESS by the walk still running).
		const before = run.bridge.sent.length;
		let second = null;
		again().then((value) => { second = value; }, (error) => { second = { error: String(error?.code ?? error) }; });
		await eventually(() => run.bridge.sent.slice(before).some(({ type }) => type === 'action_command') || second !== null);
		assert.ok(second === null || !/NATIVE_ACTION_IN_PROGRESS/.test(JSON.stringify(second)), JSON.stringify(second ?? {}).slice(0, 300));
		assert.ok(run.bridge.sent.slice(before).some(({ type }) => type === 'action_command'), 'the second obtain moves the body');
	} finally { finish(); await run.coordinator.stop(); }
});

test('an obtain that loops but gains a log every minute is not stopped (same cadence)', async () => {
	const { run, traces, obtained, finish } = await launch();
	try {
		let settled = null;
		obtained().then((result) => { settled = result; }, () => {});
		await loop(run, 5, 400, 5, (s) => Math.floor(s / 60));
		assert.ok(traces.some(({ event, trigger }) => event === 'native_wake_filtered' && trigger === 'movement_loop'), 'the walk loops');
		assert.equal(settled === null || settled.reasonCode !== 'SEARCH_STALLED', true, JSON.stringify(settled ?? {}).slice(0, 300));
		assert.equal(traces.some(({ verdict }) => verdict === 'stop'), false);
	} finally { finish(); await run.coordinator.stop(); }
});

test('an obtain walking to a tree it has seen is not judged stalled, however its walk loops', async () => {
	const { run, traces, obtained, finish } = await launch({ tree: true });
	try {
		let settled = null;
		obtained().then((result) => { settled = result; }, () => {});
		await loop(run, 5, 400);
		assert.ok(traces.some(({ event, trigger }) => event === 'native_wake_filtered' && trigger === 'movement_loop'), 'the walk loops');
		assert.equal(traces.some(({ verdict }) => verdict === 'stop'), false, 'no stall stop while obtain is not searching');
		assert.equal(settled === null || settled.reasonCode !== 'SEARCH_STALLED', true);
	} finally { finish(); await run.coordinator.stop(); }
});

test('a model call during a stalled search starts the clock over', async () => {
	const { run, traces, look, finish } = await launch();
	try {
		await loop(run, 5, 170);
		await look().catch(() => {});
		await loop(run, 175, 340);
		assert.equal(traces.some(({ verdict }) => verdict === 'stop'), false, 'under 3 min since the model\'s call');
		await loop(run, 345, 380);
		await eventually(() => traces.some(({ verdict }) => verdict === 'stop'));
	} finally { finish(); await run.coordinator.stop(); }
});

test('a blocking walk inside the model\'s own call is not woken for a stall it could not hear', async () => {
	const { run, planner, traces, finish } = await launch({ call: normalizeMinecraftToolCall('travelTo', { x: 200, y: 64, z: 0 }) });
	try {
		await loop(run, 5, 400);
		assert.ok(traces.some(({ event, trigger, reason }) => event === 'native_wake_filtered' && trigger === 'movement_loop' && reason === 'step travel_to running'), 'the walk loops as a step');
		assert.equal(traces.some(({ event, verdict }) => event === 'native_wake_filtered' && (verdict === 'wake' || verdict === 'stop')), false);
		assert.equal(planner.steers.length, 0, 'no stall steer queued on the open call');
		assert.equal(planner.requests.length, 1);
	} finally { finish(); await run.coordinator.stop(); }
});
