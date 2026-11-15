import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { FakePlanner, immutableGoalSpec, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

// d41-big rods: the model mid-turn waiting on its own count fight was steered by every blaze shot and hit, and cancelled
// 114 of 124 count fights 13-20 s in. The skill's own mob no longer steers; another kind still does.
const NATIVE_CONFIG = {
	bridge: { port: 25570, secret: 's'.repeat(32) },
	codex: { controlProtocol: 'native_tools', launchProfile: { agentId: 'coordinator', model: 'gpt-5.6-sol', reasoningEffort: 'high', serviceTier: 'fast' } },
};
const BLAZE = '33333333-3333-3333-3333-333333333333';
const ZOMBIE = '11111111-1111-1111-1111-111111111111';
const blaze = { uuid: BLAZE, type: 'minecraft:blaze', distance: 6, hostile: true, position: { x: 6, y: 71, z: 0 } };
const zombie = { uuid: ZOMBIE, type: 'minecraft:zombified_piglin', distance: 2, hostile: true, position: { x: 2, y: 70, z: 0 } };

async function launch(tool) {
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	planner.steers = [];
	planner.steerNativeTurn = async (request) => { planner.steers.push(request); };
	const turns = [];
	planner.requestNativeTurn = (request) => {
		planner.requests.push(request);
		const promise = new Promise((resolve, reject) => turns.push({ resolve, reject }));
		if (planner.requests.length === 1) {
			void request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId: 'call-1',
				tool: normalizeMinecraftToolCall('act', { actionType: tool.name, arguments: tool.arguments }) }).catch(() => {});
		}
		return promise;
	};
	planner.interrupt = async () => {};
	planner.finishAll = () => { for (const turn of turns) turn.resolve({ status: 'completed', toolCalls: 0 }); };
	const traces = [];
	const run = await start({ registry, planner, config: NATIVE_CONFIG, traceWriter: { write(event, details) { traces.push({ event, ...details }); } } });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Get 6 blaze rods.', goalSpec: immutableGoalSpec('Get 6 blaze rods.') } });
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: 1, observation: { player: { x: 0, y: 70, z: 0, health: 20, maxHealth: 20, threats: [blaze] }, entities: [blaze] } } });
	await eventually(() => planner.requests.length === 1);
	await eventually(() => run.bridge.sent.some(({ type }) => type === 'action_command'));
	return { planner, traces, run };
}

const hit = (eventSequence, attacker, health = 15, rows = [blaze]) => ({ agentId: 'agent-a', payload: { goalRevision: 1, eventSequence, attention: true, priority: 'urgent', trigger: 'damage',
	changedFacts: ['player.health'], observation: { player: { x: 0, y: 70, z: 0, health, maxHealth: 20, threats: rows, lastAttacker: { uuid: attacker.uuid, type: attacker.type, distance: attacker.distance } }, entities: rows } } });

test('a count fight is not steered by its own mob\'s hits; another kind steers', async () => {
	const { planner, traces, run } = await launch({ name: 'fight_target', arguments: { targetId: BLAZE, untilItem: 'minecraft:blaze_rod', untilCount: 6, collect: false, fleeAtHealth: 12, timeoutMs: 15000 } });
	try {
		run.bridge.emit('observation', hit(2, blaze, 16));
		run.bridge.emit('observation', hit(3, blaze, 14));
		await eventually(() => traces.filter(({ event, steer }) => event === 'native_wake_filtered' && steer === true).length === 2);
		await new Promise((resolve) => setTimeout(resolve, 20));
		assert.equal(planner.steers.length, 0, 'blaze hits during the count fight are held');
		run.bridge.emit('observation', hit(4, zombie, 13, [blaze, zombie]));
		await eventually(() => planner.steers.length === 1);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});

test('a single fight is steered by a hit as before', async () => {
	const { planner, run } = await launch({ name: 'fight_target', arguments: { targetId: BLAZE, timeoutMs: 15000 } });
	try {
		run.bridge.emit('observation', hit(2, blaze, 16));
		await eventually(() => planner.steers.length === 1);
	} finally {
		planner.finishAll();
		await run.coordinator.stop();
	}
});
