import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { FakePlanner, eventually, factToWireObservation, immutableGoalSpec, start } from './fixtures/dynamic-main-fixture.mjs';

// obtain recovers at low health itself (fork-rule.mjs): while it recovers, the heal nudge reaches neither a steer nor a
// planner request. An obtain merely running, and a plain body action, still get the nudge; a fork sample still wakes.
const NATIVE_CONFIG = {
	bridge: { port: 25570, secret: 's'.repeat(32) },
	codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } },
};
const settle = async () => { for (let index = 0; index < 8; index += 1) await new Promise((resolve) => setImmediate(resolve)); };
const BREAD = { slot: 1, itemId: 'minecraft:bread', nutrition: 5 };
const items = [{ itemId: 'minecraft:iron_pickaxe', count: 1, slot: 0 }, { itemId: 'minecraft:bread', count: 4, slot: 1 }];
const ZOMBIE = '11111111-1111-1111-1111-111111111111';

async function launch(call, { health = 20, fed = false } = {}) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	planner.steers = [];
	planner.steerNativeTurn = async (request) => { planner.steers.push(request); return { turnId: 'deciding' }; };
	const turns = [];
	planner.requestNativeTurn = (request) => {
		planner.requests.push(request);
		const promise = new Promise((resolve, reject) => turns.push({ resolve, reject }));
		if (planner.requests.length === 1) {
			void request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId: 'call-1', tool: normalizeMinecraftToolCall(call.name, call.arguments) }).catch(() => {});
		}
		return promise;
	};
	planner.interrupt = async () => {};
	planner.finishAll = () => { for (const turn of turns) turn.resolve({ status: 'completed', toolCalls: 0 }); };
	const traces = [];
	const run = await start({ registry, planner, config: NATIVE_CONFIG, traceWriter: { write(event, details) { traces.push({ event, ...details }); } } });
	const sampleInspection = run.bridge.sampleInspection.bind(run.bridge);
	run.bridge.sampleInspection = (request) => {
		if (request.payload.query.section !== 'blocks') return sampleInspection(request);
		run.bridge.replyInspection(request, { entries: run.bridge.latestObservations.get(request.agentId)?.blocks ?? [], coverage: { hasMore: false } });
	};
	let sequence = 0;
	// A full wire sample (the fixture's shorthand has no survival section): food 10 (19 when fed) with bread carried or none, a tree in view.
	run.observe = (health, { threats = undefined, fed = false, bread = true } = {}) => {
		const wire = factToWireObservation({ player: { x: 0, y: 64, z: 0, health, hunger: fed ? 19 : 10 }, inventory: { selectedSlot: 0, items: bread ? items : items.slice(0, 1) },
			blocks: [{ blockId: 'minecraft:oak_log', x: 3, y: 64, z: 3 }, { blockId: 'minecraft:oak_log', x: 3, y: 65, z: 3 }, { blockId: 'minecraft:grass_block', x: 0, y: 63, z: 0 }] },
		1, ++sequence, threats !== undefined, 1, threats ? threats.map((row) => `threats.${row.uuid}.targeting`) : undefined);
		wire.player.saturation = fed ? 6 : 0;
		wire.survival = bread ? { safe: !threats, canHealNow: !threats, bestFood: BREAD, signals: [] } : { safe: !threats, canHealNow: false, signals: [] };
		wire.world = { ...wire.world, difficulty: 'normal', naturalRegeneration: true };
		run.bridge.emit('observation', { agentId: 'agent-a', payload: { ...wire, ...(threats ? { priority: 'urgent', trigger: 'threat', threats: { entries: threats } } : {}) } });
	};
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Get planks.', goalSpec: immutableGoalSpec('Get planks.') } });
	run.observe(health, fed ? { fed: true, bread: false } : {});
	await eventually(() => planner.requests.length === 1);
	await eventually(() => run.bridge.sent.some(({ type }) => type === 'action_command'));
	return { planner, traces, run };
}

const nudged = (traces) => traces.some(({ event }) => event === 'native_heal_nudge');

const obtainCall = { name: 'do_step', arguments: { verb: 'obtain', target: { item: 'oak_planks', count: 4 }, why: 'planks' } };

test('a heal nudge while obtain recovers is folded: no steer and no planner request', async () => {
	// Started at health 7, fed and with no food: obtain waits for regeneration (no nudge without food). Bread then shows.
	const { planner, traces, run } = await launch(obtainCall, { health: 7, fed: true });
	try {
		await eventually(() => run.bridge.sent.some(({ type, payload }) => type === 'action_command' && payload.actionType === 'wait'));
		const steersBefore = planner.steers.length;
		run.observe(7, { fed: true });
		await eventually(() => nudged(traces));
		await eventually(() => traces.some(({ event, reason }) => event === 'native_wake_filtered' && reason === 'obtain recovers (active)'));
		await settle();
		assert.equal(planner.steers.length, steersBefore, 'the nudge is the recovery\'s to answer');
		assert.equal(planner.requests.length, 1);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

test('a zombie after the body still steers while obtain recovers', async () => {
	const { planner, run } = await launch(obtainCall, { health: 7, fed: true });
	try {
		await eventually(() => run.bridge.sent.some(({ type, payload }) => type === 'action_command' && payload.actionType === 'wait'));
		const steersBefore = planner.steers.length;
		run.observe(7, { threats: [{ uuid: ZOMBIE, type: 'minecraft:zombie', distance: 4, bearing: 0, targeting: true, swelling: false, lineOfSight: true, signals: ['targeting', 'imminent'], risk: 40 }] });
		await eventually(() => planner.steers.length > steersBefore);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

for (const [name, call] of [['an obtain that is working, not recovering,', obtainCall], ['a plain body action', { name: 'act', arguments: { actionType: 'dig_to', arguments: { pattern: 'tunnel', heading: 'north', timeoutMs: 60000 } } }]]) {
	test(`${name} still gets the heal nudge`, async () => {
		const { planner, traces, run } = await launch(call);
		try {
			run.observe(7);
			await settle();
			const steersBefore = planner.steers.length;
			run.observe(7);
			await eventually(() => nudged(traces));
			await eventually(() => planner.steers.length > steersBefore);
			assert.ok(!traces.some(({ reason }) => /^obtain recovers/.test(reason ?? '')));
		} finally {
			planner.finishAll();
			await run.coordinator.stop();
		}
	});
}
