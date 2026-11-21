import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { FakePlanner, factToWireObservation, eventually, start, DEATH } from './fixtures/dynamic-main-fixture.mjs';

// Production coordinator with a fake bridge and planner: a goal_control dead receipt writes one agent_death trace row
// joining the server's cause facts with the last observed health, position and hunger.
test('a death writes an agent_death trace row with its cause and the last seconds observed', async () => {
	const rows = [], registry = new AgentRegistry();
	const traceWriter = { write: (event, fields) => { rows.push({ event, ...fields }); } };
	const run = await start({ registry, planner: new FakePlanner(registry), traceWriter });
	try {
		const t0 = Date.now();
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Beat the game.', updatedAtEpochMs: t0 } });
		await eventually(() => run.bridge.sent.some((m) => m.type === 'agent_ready' && m.payload.goalRevision === 1));
		const world = { worldId: 'w', dimension: 'minecraft:overworld', gameTime: 100, dayTime: 100, raining: false, thundering: false };
		for (const [i, health] of [[1, 12], [2, 7], [3, 3]]) {
			run.bridge.emit('observation', { agentId: 'agent-a', payload: factToWireObservation({ player: { x: i, y: 64, z: 0, health, hunger: 4 }, world }, 1, i, true, t0 + i * 1000) });
		}
		const death = { ...DEATH, cause: 'Probe was shot by Skeleton', gameMode: 'survival', diedAtEpochMs: t0 + 3500,
			damageType: 'minecraft:arrow', attacker: 'minecraft:skeleton', directAttacker: 'minecraft:arrow', foodLevel: 4, saturation: 0, armor: 0 };
		run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'dead', goalRevision: 1, updatedAtEpochMs: t0 + 3500, death } });
		await eventually(() => rows.some((row) => row.event === 'agent_death'));
		const row = rows.find((r) => r.event === "agent_death");
		assert.equal(row.agentId, 'agent-a');
		assert.equal(row.cause, 'Probe was shot by Skeleton');
		assert.equal(row.attacker, 'minecraft:skeleton');
		assert.equal(row.damageType, 'minecraft:arrow');
		assert.equal(row.foodLevel, 4);
		assert.deepEqual(row.trail.map((point) => point.health), [12, 7, 3]);
		assert.deepEqual(row.trail.map((point) => point.s), [-2.5, -1.5, -0.5]);
	} finally { await run.coordinator.stop(); }
});
