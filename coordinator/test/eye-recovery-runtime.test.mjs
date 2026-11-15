import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
const saved = JSON.parse(readFileSync(new URL('./fixtures/stronghold-eyes/dab84-recovery.json', import.meta.url)));
const sample = name => structuredClone(saved.windows[name].observation);

// Actual eye/flight/body inputs; bridge completion and safe model continuation are reconstructed.
async function replay(check, { interrupt = false } = {}) {
	const record = { agentId: 'dab84-eye', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
	let o = sample('beforeThrow'), runtime, sequence = 0;
	const calls = [];
	runtime = new NativeToolRuntime({
		requestObservation: async () => ({ eventSequence: ++sequence, observation: structuredClone(o) }),
		inspectObservation: async () => ({ survey: {} }),
		bridge: { send: async (type, _id, p) => {
			if (type !== 'action_command') return;
			calls.push(p);
			if (p.actionType === 'use_item') o = sample('falling');
			if (p.actionType === 'travel_to' && calls.filter(c => c.actionType === 'travel_to').length === 1) o = sample('grounded');
			if (p.actionType === 'pick_up_item') o = sample('afterFailure');
			if (interrupt && p.actionType === 'travel_to') {
				queueMicrotask(() => assert.equal(runtime.interruptBlockingTool(record.agentId), true));
				return;
			}
			const failed = p.actionType === 'pick_up_item' || (p.actionType === 'travel_to' && calls.filter(c => c.actionType === 'travel_to').length > 1);
			queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1,
				state: failed ? 'FAILED' : 'SUCCEEDED', reasonCode: failed ? 'PATH_BLOCKED' : 'ACTION_COMPLETED', executionStarted: true, physicalAttempted: true }));
		} },
	});
	const keepAlive = setInterval(() => {}, 1000);
	const find = async () => {
		runtime.updateObservation(record, structuredClone(o), { eventSequence: ++sequence });
		return runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'recovery', callId: `find-${sequence}`,
			tool: normalizeMinecraftToolCall('do_step', { verb: 'find', target: { structure: 'stronghold', allowEyeReserveUse: true, throwCap: 1, timeoutMs: 10000 }, why: 'follow the observed eye' }) }, record);
	};
	try { await check({ find, calls, runtime, record, set: next => { o = next; } }); }
	finally { await runtime.dispose(record.agentId, 'test_complete'); clearInterval(keepAlive); }
}

test('dab84 production recovery retains the landed flight revision after pickup failure', async () => replay(async ({ find, calls }) => {
	const r = await find();
	assert.equal(r.reasonCode, 'FIND_BLOCKED');
	assert.equal(calls.find(c => c.actionType === 'pick_up_item').arguments.targetSelector, sample('grounded').items[0].stableId);
	assert.deepEqual(r.find.eyes.throws[0].droppedAt, sample('grounded').perception.events[0].droppedAt);
	assert.equal(r.find.eyes.eyesLeft, 10, 'failed pickup is not recovery');
}));

test('dab84 model movement with no regain resumes bearing without obsolete drop or new throw', async () => replay(async ({ find, calls, set }) => {
	await find(); const n = calls.length;
	set(sample('modelMoved'));
	const r = await find();
	const moves = calls.slice(n).filter(c => c.actionType === 'travel_to');
	assert.equal(moves.length, 1);
	assert.equal(moves[0].arguments.y, undefined, 'bearing leg, not the airborne or landed historical drop');
	assert.ok(moves[0].arguments.x < sample('beforeThrow').player.x - 60);
	assert.equal(calls.filter(c => c.actionType === 'use_item').length, 1);
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, undefined);
	assert.equal(r.find.eyes.throws[0].recovery, 'not_visible');
	assert.equal(r.find.seen, undefined);
}));

test('dab84 genuine remaining visible item resumes at current Y63 instead of old Y79', async () => replay(async ({ find, calls, set }) => {
	await find(); const n = calls.length;
	set(sample('grounded'));
	await find();
	const move = calls.slice(n).find(c => c.actionType === 'travel_to');
	assert.equal(move.arguments.y, 63);
	assert.equal(move.arguments.x, sample('grounded').items[0].x);
}));

test('inventory-proven model recovery still bypasses a stale visible item row', async () => replay(async ({ find, calls, set }) => {
	await find(); const n = calls.length;
	const o = sample('grounded'); o.inventory.items[0].count = 11; set(o);
	const r = await find();
	assert.equal(calls.slice(n).find(c => c.actionType === 'travel_to').arguments.y, undefined);
	assert.equal(r.find.eyes.throws[0].eyesAfterPickup, 11);
}));

test('unsafe resumed recovery dispatches no body action', async () => replay(async ({ find, calls, set }) => {
	await find(); const n = calls.length;
	const o = sample('grounded'); o.player.health = 7; set(o);
	assert.equal((await find()).reasonCode, 'FIND_DANGER');
	assert.equal(calls.length, n);
}));

test('a different visible eye does not replace the tracked recovery item', async () => replay(async ({ find, calls, set }) => {
	await find(); const n = calls.length;
	const o = sample('grounded'); o.items[0].stableId = '00000000-0000-4000-8000-000000000099'; set(o);
	const r = await find();
	assert.equal(calls.slice(n).find(c => c.actionType === 'travel_to').arguments.y, undefined);
	assert.equal(calls.slice(n).some(c => c.actionType === 'pick_up_item'), false);
	assert.equal(r.find.eyes.throws[0].recovery, 'not_visible');
}));

test('production recovery interruption preserves the running travel without another action', async () => replay(async ({ find, calls, runtime, record }) => {
	const r = await find();
	assert.equal(r.reasonCode, 'FIND_DANGER');
	assert.equal(r.state, 'FAILED');
	assert.equal(r.find.eyes.stoppedBy, 'danger');
	assert.equal(runtime.runningAction(record).actionId, calls.at(-1).actionId);
	assert.equal(calls.at(-1).actionType, 'travel_to');
	assert.equal(calls.some(c => c.actionType === 'pick_up_item'), false);
}, { interrupt: true }));
