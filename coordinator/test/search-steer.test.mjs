import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { FakePlanner, factToWireObservation, immutableGoalSpec, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

// Gate run 3: the danger steer cut a running find (or obtain's search) short for one zombie it could beat, or mobs behind
// rock, 8 of 24 mob hand-backs. While a search runs those steers are held; a fork (a creeper here) still steers.
const NATIVE_CONFIG = {
	bridge: { port: 25570, secret: 's'.repeat(32) },
	codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } },
};
const ZOMBIE = '11111111-1111-1111-1111-111111111111';
const CREEPER = '22222222-2222-2222-2222-222222222222';
const zombie = { uuid: ZOMBIE, type: 'minecraft:zombie', distance: 5, bearing: 0, targeting: true, swelling: false, lineOfSight: true, signals: ['targeting', 'imminent'], risk: 40 };
const creeper = { uuid: CREEPER, type: 'minecraft:creeper', distance: 4, bearing: 90, targeting: true, swelling: false, lineOfSight: true, signals: ['targeting', 'creeper_close'], risk: 80 };
const items = [{ itemId: 'minecraft:iron_pickaxe', count: 1, slot: 0 }];

async function launch(call) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	planner.steers = [];
	planner.steerNativeTurn = async (request) => { planner.steers.push(request); };
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
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Find lava.', goalSpec: immutableGoalSpec('Find lava.') } });
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 0, y: -40, z: 0, health: 20, maxHealth: 20 }, inventory: { selectedSlot: 0, items } } } });
	await eventually(() => planner.requests.length === 1);
	await eventually(() => run.bridge.sent.some(({ type }) => type === 'action_command'));
	return { planner, traces, run };
}

// The fixture's fact shorthand has no threat rows: a full wire sample carries them, as the mod sends them.
const threat = (eventSequence, rows) => {
	const changedFacts = rows.map((row) => `threats.${row.uuid}.targeting`);
	const wire = factToWireObservation({ player: { x: 0, y: -40, z: 0, health: 20 }, inventory: { selectedSlot: 0, items } }, 1, eventSequence, true, 1, changedFacts);
	return { agentId: 'agent-a', payload: { ...wire, priority: 'urgent', trigger: 'threat', threats: { entries: rows } } };
};

test('a running find is not steered for one zombie it can beat; a creeper still steers', async () => {
	const { planner, traces, run } = await launch({ name: 'do_step', arguments: { verb: 'find', target: { block: 'lava' }, why: 'lava for the portal' } });
	try {
		run.bridge.emit('observation', threat(2, [zombie]));
		await eventually(() => traces.some(({ event, reason }) => event === 'native_wake_filtered' && /^search handles: one zombie/.test(reason ?? '')));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(planner.steers.length, 0, 'the zombie is the search\'s to fight');
		run.bridge.emit('observation', threat(3, [zombie, creeper]));
		await eventually(() => planner.steers.length === 1);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

test('a plain body action is steered by the same zombie as before', async () => {
	const { planner, run } = await launch({ name: 'act', arguments: { actionType: 'dig_to', arguments: { pattern: 'tunnel', heading: 'north', timeoutMs: 60000 } } });
	try {
		run.bridge.emit('observation', threat(2, [zombie]));
		await eventually(() => planner.steers.length === 1);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

// A hit sample: the zombie still lastAttacker (vanilla keeps it 5 s), hurtBy naming what did this damage.
const hit = (eventSequence, { hurtBy, inLava = false }) => {
	const wire = factToWireObservation({ player: { x: 0, y: -40, z: 0, health: 18 }, inventory: { selectedSlot: 0, items } }, 1, eventSequence, true, 1, ['player.health']);
	wire.player = { ...wire.player, hurtBy, inLava, lastAttacker: { uuid: ZOMBIE, type: 'minecraft:zombie', distance: 2 } };
	return { agentId: 'agent-a', payload: { ...wire, priority: 'urgent', trigger: 'damage', threats: { entries: [{ ...zombie, distance: 2 }] } } };
};

test('a running find holds the zombie\'s own hit, and steers for lava that hits within 5 s of it', async () => {
	const { planner, traces, run } = await launch({ name: 'do_step', arguments: { verb: 'find', target: { block: 'lava' }, why: 'lava for the portal' } });
	try {
		run.bridge.emit('observation', hit(2, { hurtBy: 'mob_attack by minecraft:zombie' }));
		await eventually(() => traces.some(({ event, trigger, reason }) => event === 'native_wake_filtered' && trigger === 'damage' && /^search handles: one zombie/.test(reason ?? '')));
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(planner.steers.length, 0, 'the zombie\'s hit is the search\'s fight');
		// Knocked into the lava beside it: lastAttacker is still the zombie, the damage is lava.
		run.bridge.emit('observation', hit(3, { hurtBy: 'lava', inLava: true }));
		await eventually(() => planner.steers.length === 1);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});
