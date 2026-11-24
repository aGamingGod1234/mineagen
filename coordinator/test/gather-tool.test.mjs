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

// Audit of #108/#109: obtain chose a remembered village cobblestone cell, but gather knew only block ids. Out of reach
// with cobblestone and stone on its list, its one far-sight search named stone (bulk terrain), the server refused the
// whole search, and gather ended NO_TARGET. Gather now walks to the remembered placed cell and never searches terrain.
test('gather walks to a remembered placed block and never sends bulk terrain to the far-sight search', async () => {
	const { NativeToolRuntime } = await import('../src/native-tool-runtime.mjs');
	const record = () => ({ agentId: 'agent-v', provider: 'codex', model: 'test-model', reasoningEffort: 'low', serviceTier: 'fast', goalRevision: 3, currentGoal: 'get cobblestone' });
	const world = { worldId: 'w1', dimension: 'minecraft:overworld' };
	const state = { x: 0.5, cobble: 0, broken: false };
	const observe = () => ({ player: { x: state.x, y: 64, z: 0.5, yaw: 0, pitch: 0, health: 20 }, world, items: [],
		inventory: { items: state.cobble > 0 ? [{ slot: 0, itemId: 'minecraft:cobblestone', count: state.cobble }] : [] },
		blocks: state.x > 10 && !state.broken ? [{ blockId: 'minecraft:cobblestone', x: 14, y: 64, z: 0, visible: true }] : [] });
	const sent = [];
	let runtime, sequence = 1;
	runtime = new NativeToolRuntime({
		bridge: { send: async (type, _agentId, payload) => {
			sent.push({ type, payload });
			if (type !== 'action_command') return;
			if (['move_to', 'navigate_to', 'travel_to'].includes(payload.actionType)) state.x = 12.5;
			if (payload.actionType === 'break_block') { state.broken = true; state.cobble = 1; }
			queueMicrotask(() => runtime.onActionResult(record(), { actionId: payload.actionId, goalRevision: payload.goalRevision, state: 'SUCCEEDED',
				reasonCode: payload.actionType === 'break_block' ? 'BLOCK_BROKEN' : 'ACTION_COMPLETED', message: 'done' }));
		} },
		requestObservation: async (_record, { afterEventSequence }) => ({ eventSequence: Math.max(afterEventSequence, sequence++) + 1, observation: observe() }),
	});
	// Seen earlier from the plaza: a village wall's cobblestone 14 blocks off, now out of the local scan.
	runtime.updateObservation(record(), { ...observe(), sighted: { resources: [{ blockId: 'minecraft:cobblestone', x: 14, y: 64, z: 0, distance: 13.5, bearing: 0, count: 6 }] } }, { eventSequence: 1 });
	const tool = normalizeMinecraftToolCall('gather', { itemId: 'cobblestone', count: 1, blockIds: ['cobblestone', 'stone'], radius: 24, timeoutMs: 30_000 });
	const result = await runtime.execute({ agentId: 'agent-v', goalRevision: 3, turnId: 'turn-1', callId: 'call-1', tool }, record());
	const reasonCode = result.reasonCode ?? result.result?.reasonCode;
	assert.equal(reasonCode, 'GATHER_DONE', JSON.stringify(result).slice(0, 600));
	assert.ok(!JSON.stringify(sent).includes('blocks:minecraft:stone'), 'no search names bulk terrain');
	const actions = sent.filter((entry) => entry.type === 'action_command').map((entry) => entry.payload.actionType);
	assert.ok(actions.indexOf('break_block') > 0 && actions.slice(0, actions.indexOf('break_block')).some((type) => /move|navigate|travel/.test(type)), actions.join(','));
});

// Wave 6 speed lane, 32 bots: 481 of 593 coordinator observation requests reached the server 1-2 ticks after that bot's
// last collect. The server already publishes a sample in each action result's tick; gather's look after each break
// ignored it and asked for another collect.
test('gather looks at the sample the server publishes with each break instead of asking for another collect', async () => {
	const { NativeToolRuntime } = await import('../src/native-tool-runtime.mjs');
	const record = () => ({ agentId: 'agent-g', provider: 'codex', model: 'test-model', reasoningEffort: 'low', serviceTier: 'fast', goalRevision: 3, currentGoal: 'get logs' });
	const world = { worldId: 'w1', dimension: 'minecraft:overworld' };
	const logs = new Set(['1,64,0', '1,65,0', '1,66,0', '1,67,0', '1,68,0']);
	let held = 0, sequence = 1, requests = 0, breaks = 0;
	const observe = () => ({ player: { x: 0.5, y: 64, z: 0.5, yaw: 0, pitch: 0, health: 20 }, world, items: [],
		inventory: { items: held > 0 ? [{ slot: 0, itemId: 'minecraft:oak_log', count: held }] : [] },
		blocks: [...logs].map((key) => { const [x, y, z] = key.split(',').map(Number); return { blockId: 'minecraft:oak_log', x, y, z, visible: true }; }) });
	let runtime;
	runtime = new NativeToolRuntime({
		bridge: { send: async (type, _agentId, payload) => {
			if (type !== 'action_command') return;
			if (payload.actionType === 'break_block') {
				breaks += 1;
				logs.delete(`${payload.arguments.x},${payload.arguments.y},${payload.arguments.z}`);
				held += 1;
			}
			// As the bridge does: the result, then the observation published in the same tick.
			queueMicrotask(() => {
				runtime.onActionResult(record(), { actionId: payload.actionId, goalRevision: payload.goalRevision, state: 'SUCCEEDED', reasonCode: payload.actionType === 'break_block' ? 'BLOCK_BROKEN' : 'ACTION_COMPLETED', message: 'done' });
				runtime.updateObservation(record(), observe(), { eventSequence: ++sequence });
			});
		} },
		requestObservation: async (_record, { afterEventSequence }) => { requests += 1; return { eventSequence: Math.max(afterEventSequence, sequence++) + 1, observation: observe() }; },
	});
	runtime.updateObservation(record(), observe(), { eventSequence: 1 });
	const tool = normalizeMinecraftToolCall('gather', { itemId: 'oak_log', count: 5, timeoutMs: 30_000 });
	const result = await runtime.execute({ agentId: 'agent-g', goalRevision: 3, turnId: 'turn-1', callId: 'call-1', tool }, record());
	assert.equal(result.reasonCode ?? result.result?.reasonCode, 'GATHER_DONE', JSON.stringify(result).slice(0, 600));
	assert.equal(breaks, 5);
	// Before: one request per break plus the first look (6 for 5 breaks). After: only the first look, which follows no break.
	assert.equal(requests, 1, `${requests} observation requests for ${breaks} breaks`);
});
