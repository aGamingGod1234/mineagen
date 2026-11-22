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

async function launch() {
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
				tool: normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'oak_log', count: 4 }, why: 'wood for tools' }) });
			obtained.catch(() => {});
		}
		return promise;
	};
	const traces = [];
	const run = await start({ registry, planner, config: CONFIG, traceWriter: { write(event, details) { traces.push({ event, ...details }); } } });
	const sampleInspection = run.bridge.sampleInspection.bind(run.bridge);
	run.bridge.sampleInspection = (request) => {
		if (request.payload.query.section !== 'blocks') return sampleInspection(request);
		run.bridge.replyInspection(request, { entries: [], coverage: { hasMore: false } });
	};
	let sequence = 0;
	// A wire sample at game second s: the body steps between two cells (a loop), carrying `logs` oak logs.
	run.observe = (s, { logs = 0 } = {}) => {
		const items = [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }, ...(logs > 0 ? [{ itemId: 'minecraft:oak_log', count: logs, slot: 1 }] : [])];
		const wire = factToWireObservation({ player: { x: sequence % 2, y: 64, z: 0, health: 20 }, inventory: { selectedSlot: 0, items }, blocks: [{ blockId: 'minecraft:sand', x: 0, y: 63, z: 0 }] }, 1, ++sequence, false, 1);
		wire.world = { ...wire.world, gameTime: 1_000 + s * 20 };
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { ...wire, observedAtEpochMs: START + s * 1_000 } });
	};
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Get wood.', goalSpec: immutableGoalSpec('Get wood.') } });
	run.observe(0);
	await eventually(() => planner.requests.length === 1);
	await eventually(() => run.bridge.sent.some(({ type }) => type === 'action_command'));
	return { run, planner, traces, obtained: () => obtained, finish: () => { for (const resolve of turns) resolve({ status: 'completed', toolCalls: 1 }); } };
}

async function loop(run, from, to, every = 5, logs = () => 0) {
	for (let s = from; s <= to; s += every) { run.observe(s, { logs: logs(s) }); await settle(); }
}

test('an obtain whose walk loops for 3 min of game time hands back SEARCH_STALLED inside the model\'s call', async () => {
	const { run, planner, traces, obtained, finish } = await launch();
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
		assert.equal(run.bridge.sent.filter(({ type }) => type === 'action_cancel').length, 0, 'the leg is handed back, not cancelled');
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
