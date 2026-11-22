import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

// PR #108 review: the runtime's seen-resource memory must not carry one world's village into a replacement world, and a
// block the agent broke must stop being a source (no sample lists the air it leaves).
const record = { agentId: 'agent-res', provider: 'codex', model: 'test-model', reasoningEffort: 'low', serviceTier: 'fast', goalRevision: 2, currentGoal: 'stone' };
const observation = (worldId, resources = []) => ({ player: { x: 0.5, y: 64, z: 0.5, health: 20 }, world: { worldId, dimension: 'minecraft:overworld' },
	observedAtEpochMs: Date.now(), sighted: { resources: resources.map((x) => ({ blockId: 'minecraft:cobblestone', x, y: 64, z: 0, distance: x, bearing: 0, count: 1 })) } });
const cobble = (runtime) => runtime.resourcesFor(record.agentId, { ids: ['cobblestone'] }).map((row) => row.x);

test('seen sources belong to one world: a replacement world starts empty, and server_replaced forgets them', async (t) => {
	const runtime = new NativeToolRuntime({ bridge: { send: async () => {} } });
	t.after(() => runtime.dispose(record.agentId));
	runtime.updateObservation(record, observation('world-a', [6]), { eventSequence: 1 });
	assert.deepEqual(cobble(runtime), [6]);
	runtime.updateObservation(record, observation('world-b'), { eventSequence: 2 });
	assert.deepEqual(cobble(runtime), [], 'the old world\'s cobblestone is not a source in the new world');
	runtime.updateObservation(record, observation('world-b', [9]), { eventSequence: 3 });
	assert.deepEqual(cobble(runtime), [9]);
	await runtime.dispose(record.agentId, 'server_replaced');
	assert.deepEqual(cobble(runtime), [], 'a replaced server forgets the agent\'s sources');
});

test('a break_block the agent finished removes that source from memory', async (t) => {
	const sent = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (type, _agentId, payload) => { if (type === 'action_command') sent.push(payload); } } });
	t.after(() => runtime.dispose(record.agentId));
	runtime.updateObservation(record, observation('world-a', [6, 30]), { eventSequence: 1 });
	assert.deepEqual(cobble(runtime).sort((a, b) => a - b), [6, 30]);
	const started = await runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: 'turn-1', callId: 'call-1',
		tool: normalizeMinecraftToolCall('startAction', { actionType: 'break_block', arguments: { x: 6, y: 64, z: 0 } }) }, record);
	assert.equal(started.state, 'RUNNING', JSON.stringify(started));
	assert.equal(runtime.onActionResult(record, { actionId: sent[0].actionId, state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' }), true);
	assert.deepEqual(cobble(runtime), [30], 'the broken cobblestone is gone; the far one stays');
});
