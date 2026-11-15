import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const saved = JSON.parse(readFileSync(new URL('./fixtures/fortress-spawner/c8861.json', import.meta.url)));
// Actual recorded facts enter the production native runtime. Only bridge replies/physics are injected.
async function replay(index, reasonCode = 'NO_ROUTE', change = () => {}) {
	const observation = structuredClone(saved.windows[index].observation);
	change(observation);
	const record = { agentId: 'floor-replay', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
	let runtime, sequence = 0;
	const moves = [];
	runtime = new NativeToolRuntime({
		requestObservation: async () => ({ eventSequence: ++sequence, observation: structuredClone(observation) }),
		inspectObservation: async () => ({ survey: {} }),
		bridge: { send: async (type, _agent, p) => {
			if (type !== 'action_command') return;
			const moving = p.actionType !== 'control';
			if (moving) moves.push({ actionType: p.actionType, ...p.arguments });
			queueMicrotask(() => {
				if (moving && reasonCode === 'INTERRUPT') {
					assert.equal(runtime.interruptBlockingTool(record.agentId, 'danger'), true);
					return;
				}
				if (moving && reasonCode === 'CANCEL') { void runtime.dispose(record.agentId, 'explicit_model_cancel'); return; }
				runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1,
					state: moving ? 'FAILED' : 'SUCCEEDED', reasonCode: moving ? reasonCode : 'CONTROL_SEGMENT_COMPLETED', executionStarted: true, physicalAttempted: true });
			});
		} },
	});
	const keepAlive = setInterval(() => {}, 1000);
	try {
		runtime.updateObservation(record, observation, { eventSequence: ++sequence });
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'replay', callId: 'find',
			tool: normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'spawner', within: 96, timeoutMs: 60000 }, why: 'search observed fortress flooring' }) }, record);
		return { result, moves };
	} finally { await runtime.dispose(record.agentId, 'test_complete'); clearInterval(keepAlive); }
}

test('c8861 visible floor is approached instead of bridging northeast through rock', async () => {
	const { result, moves } = await replay(1);
	assert.equal(moves.length, 1);
	assert.equal(moves[0].actionType, 'travel_to');
	assert.deepEqual([moves[0].x, moves[0].y, moves[0].z], [9.5, 67, 113.5]);
	assert.equal(moves[0].build, false);
	assert.equal(moves[0].tolerance, 1);
	assert.equal(moves[0].stopWhenSeen, 'minecraft:spawner');
	assert.equal(moves[0].fightThrough, undefined);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.equal(result.find.seen, undefined);
});

test('c8861 initial underside masonry has no visible top and does not justify blind travel', async () => {
	const { result, moves } = await replay(0);
	assert.equal(moves.length, 0);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
});

test('native floor interruption hands the running action back without another leg', async () => {
	const { result, moves } = await replay(1, 'INTERRUPT');
	assert.equal(moves.length, 1);
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(result.state, 'RUNNING');
	assert.ok(result.actionId);
});

test('explicit model cancellation stops the floor search', async () => {
	await assert.rejects(replay(1, 'CANCEL'), { code: 'NATIVE_ACTION_CANCELLED' });
});

for (const code of ['LAVA_AHEAD', 'VOID_EDGE', 'LOW_HEALTH', 'TRAVEL_DAMAGED', 'NO_TOOL', 'TOOL_WORN']) {
	test(`native floor search preserves ${code} handback`, async () => {
		const { result, moves } = await replay(1, code);
		assert.equal(moves.length, 1);
		assert.equal(moves[0].build, false);
		assert.equal(result.reasonCode, ['NO_TOOL', 'TOOL_WORN'].includes(code) ? 'FIND_BLOCKED' : 'FIND_DANGER');
	});
}
