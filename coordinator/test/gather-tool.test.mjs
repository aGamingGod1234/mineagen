import test from 'node:test';
import assert from 'node:assert/strict';
import { minecraftCapabilities, normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { isNativeBodyTool } from '../src/codex-service.mjs';

test('gather normalizes to a body tool with defaults, carried reflexes and bare ids', () => {
	assert.deepEqual(normalizeMinecraftToolCall('gather', { itemId: 'oak_log', count: 6 }),
		{ kind: 'gather', arguments: { itemId: 'minecraft:oak_log', count: 6, blockIds: ['minecraft:oak_log'], radius: 16, timeoutMs: 120_000 } });
	const coal = normalizeMinecraftToolCall('gather', { itemId: 'minecraft:coal', count: 8, blockIds: ['coal_ore', 'minecraft:deepslate_coal_ore'], radius: 24 });
	assert.deepEqual(coal.arguments.blockIds, ['minecraft:coal_ore', 'minecraft:deepslate_coal_ore']);
	assert.ok(isNativeBodyTool(coal), 'a body tool: it owns the player while it runs');
	const carried = normalizeMinecraftToolCall('gather', { itemId: 'oak_log', count: 2, reflexes: [{ id: 'g-lava', kind: 'trigger', when: { type: 'in_lava' }, do: { type: 'leave_lava' } }] });
	assert.equal(carried.reflexes.length, 1);
	assert.throws(() => normalizeMinecraftToolCall('gather', { itemId: 'oak_log', count: 0 }));
	assert.throws(() => normalizeMinecraftToolCall('gather', { itemId: 'oak_log', count: 6, x: 1 }));
});

// Scripted gate seed 1: with its wooden pickaxe worn out, gather punched 22 stone blocks by hand, 8 s each, for no
// cobblestone. A break that drops nothing for want of the right tool ends gather NO_TOOL at once.
test('gather stops NO_TOOL when a break drops nothing for want of the right tool', async () => {
	const { NativeToolRuntime } = await import('../src/native-tool-runtime.mjs');
	const { goalSpecFingerprint } = await import('../src/goal-spec.mjs');
	const fields = { originalRequest: 'get cobblestone', predicate: { type: 'inventory_contains', itemId: 'minecraft:cobblestone', count: 3 }, createdAtTick: 10 };
	const record = () => ({ agentId: 'agent-a', provider: 'codex', model: 'gpt-5.6-sol', reasoningEffort: 'low', serviceTier: 'fast',
		goalRevision: 3, currentGoal: fields.originalRequest, currentGoalSpec: { ...fields, fingerprint: goalSpecFingerprint(fields) } });
	const observation = { player: { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, health: 20 }, world: { dimension: 'minecraft:overworld' }, inventory: { items: [] },
		blocks: [0, 1, 2].map((dz) => ({ blockId: 'minecraft:stone', x: 1, y: 64, z: dz, visible: true })), items: [] };
	const commands = [];
	let runtime, sequence = 1;
	runtime = new NativeToolRuntime({
		bridge: { send: async (type, agentId, payload) => {
			if (type !== 'action_command') return;
			commands.push(payload.actionType);
			queueMicrotask(() => runtime.onActionResult(record(), { actionId: payload.actionId, goalRevision: payload.goalRevision, state: 'SUCCEEDED',
				reasonCode: payload.actionType === 'break_block' ? 'BLOCK_BROKEN' : 'ACTION_COMPLETED',
				message: payload.actionType === 'break_block' ? 'Broken with hand; no block drops without correct tool/tier, needs any pickaxe; no drops seen' : 'Action completed' }));
		} },
		requestObservation: async (_record, { afterEventSequence }) => ({ eventSequence: Math.max(afterEventSequence, sequence++) + 1, observation: structuredClone(observation) }),
	});
	runtime.updateObservation(record(), structuredClone(observation), { eventSequence: 1 });
	const tool = normalizeMinecraftToolCall('gather', { itemId: 'cobblestone', count: 3, blockIds: ['stone'], timeoutMs: 30_000 });
	const result = await runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn-1', callId: 'call-1', tool }, record());
	const state = result.state ?? result.result?.state, reasonCode = result.reasonCode ?? result.result?.reasonCode;
	assert.equal(reasonCode, 'NO_TOOL', JSON.stringify(result).slice(0, 600));
	assert.equal(state, 'FAILED');
	assert.equal(commands.filter((type) => type === 'break_block').length, 1, 'one break, not a block punched after block');
});
