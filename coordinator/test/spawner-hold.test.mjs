import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { CANCEL_REASON_MAX, blazeHold, holdCancelRefusal } from '../src/spawner-hold.mjs';

// Wall breaker rods, contract H11-H12: the model's own cancel or replace of a blaze spawner hold carries a reason.
const tick = () => new Promise(resolve => setImmediate(resolve));
const hold = { actionId: 'a1', actionType: 'fight_until', arguments: { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 7 }, dimension: 'minecraft:the_nether' };

test('which running actions are a blaze hold', () => {
	assert.equal(blazeHold(hold), true);
	assert.equal(blazeHold({ ...hold, dimension: undefined }), true, 'no recorded dimension: treated as a hold (the mod decides)');
	assert.equal(blazeHold({ ...hold, arguments: { ...hold.arguments, roof: false } }), false, 'roof:false is the open fight');
	assert.equal(blazeHold({ ...hold, arguments: { ...hold.arguments, mob: 'minecraft:enderman' } }), false);
	assert.equal(blazeHold({ ...hold, actionType: 'fight_target' }), false);
	assert.equal(blazeHold({ ...hold, dimension: 'minecraft:overworld' }), false);
});

test('H11 a cancel without a reason is refused with the hold state; H12 one with a reason passes', () => {
	const refused = holdCancelRefusal(hold, { kind: 'cancel_action', actionId: 'a1' });
	assert.equal(refused.code, 'CANCEL_REASON_REQUIRED');
	assert.match(refused.message, /spawner hold/);
	assert.match(refused.message, /cancelAction again with reason/);
	assert.match(holdCancelRefusal(hold, { kind: 'replace_action', actionId: 'a1' }).message, /replaceAction again with reason/);
	assert.equal(holdCancelRefusal(hold, { kind: 'cancel_action', actionId: 'a1', reason: '   ' }).code, 'CANCEL_REASON_REQUIRED', 'blank is no reason');
	assert.equal(holdCancelRefusal(hold, { kind: 'cancel_action', actionId: 'a1', reason: 'need pearls first' }), null);
	assert.equal(holdCancelRefusal({ ...hold, actionType: 'travel_to' }, { kind: 'cancel_action' }), null, 'other actions need no reason');
	assert.equal(holdCancelRefusal(undefined, { kind: 'cancel_action' }), null);
});

test('the tool calls carry an optional reason, bounded', () => {
	assert.equal(normalizeMinecraftToolCall('cancelAction', { actionId: 'a1', goalRevision: 1 }).reason, undefined);
	assert.equal(normalizeMinecraftToolCall('cancelAction', { actionId: 'a1', goalRevision: 1, reason: 'portal first' }).reason, 'portal first');
	assert.throws(() => normalizeMinecraftToolCall('cancelAction', { actionId: 'a1', goalRevision: 1, reason: 'x'.repeat(CANCEL_REASON_MAX + 1) }));
	const replace = normalizeMinecraftToolCall('replaceAction', { actionId: 'a1', goalRevision: 1, actionType: 'wait', arguments: { durationMs: 5 }, reason: 'low food' });
	assert.equal(replace.reason, 'low food');
	assert.equal(replace.kind, 'replace_action');
});

function harness(t) {
	const record = { agentId: 'agent-rods', provider: 'codex', model: 'test', reasoningEffort: 'high', goalRevision: 1 };
	const sent = [];
	const traces = [];
	const current = { player: { x: 0, y: 70, z: 0, health: 20 }, world: { dimension: 'minecraft:the_nether' }, items: [], entities: [], blocks: [], inventory: { items: [], tagCounts: {} } };
	const runtime = new NativeToolRuntime({
		bridge: { send: async (type, agentId, payload) => sent.push({ type, agentId, payload: validateProtocolV2Payload(type, payload) }) },
		requestObservation: async (_record, { afterEventSequence }) => ({ observation: current, eventSequence: afterEventSequence + 1 }),
		programExecutor: new NativeProgramExecutor(),
		trace: (event, fields) => traces.push({ event, ...fields }),
	});
	t.after(() => runtime.disposeAll());
	runtime.updateObservation(record, current, { eventSequence: 1 });
	let callId = 0;
	const call = (name, args = {}) => runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'turn', callId: String(++callId), tool: normalizeMinecraftToolCall(name, args) }, record);
	const commands = () => sent.filter(entry => entry.type === 'action_command');
	const cancels = () => sent.filter(entry => entry.type === 'action_cancel');
	const finish = (actionId, state, reasonCode = state) => runtime.onActionResult(record, { actionId, goalRevision: 1, state, reasonCode });
	return { call, commands, cancels, finish, traces };
}

const holdArgs = { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 7, timeoutMs: 600_000 };

test('runtime: cancelAction on a running blaze hold is refused without a reason and sends nothing; with one it cancels', async t => {
	const h = harness(t);
	const started = await h.call('startAction', { actionType: 'fight_until', arguments: holdArgs });
	await tick();
	assert.equal(h.commands().length, 1);
	const refused = await h.call('cancelAction', { actionId: started.actionId, goalRevision: 1 }).catch(e => e);
	assert.equal(refused.code, 'CANCEL_REASON_REQUIRED');
	assert.equal(h.cancels().length, 0, 'the refused cancel reached no body');
	const replaced = await h.call('replaceAction', { actionId: started.actionId, goalRevision: 1, actionType: 'wait', arguments: { durationMs: 5 } }).catch(e => e);
	assert.equal(replaced.code, 'CANCEL_REASON_REQUIRED');
	assert.equal(h.cancels().length, 0);
	const cancelling = h.call('cancelAction', { actionId: started.actionId, goalRevision: 1, reason: 'health low, going home' });
	await tick();
	assert.equal(h.cancels().length, 1, 'the cancel with a reason is sent');
	h.finish(started.actionId, 'CANCELLED', 'ACTION_CANCELLED');
	const result = await cancelling;
	assert.equal(result.cancelReason, 'health low, going home');
	assert.ok(h.traces.some(row => row.event === 'native_hold_cancel' && row.reason === 'health low, going home'));
	assert.ok(h.traces.some(row => row.event === 'native_hold_cancel_refused'));
});

test('runtime: a blaze fight_until with roof:false and other actions cancel without a reason', async t => {
	const h = harness(t);
	const started = await h.call('startAction', { actionType: 'fight_until', arguments: { ...holdArgs, roof: false } });
	await tick();
	const cancelling = h.call('cancelAction', { actionId: started.actionId, goalRevision: 1 });
	await tick();
	assert.equal(h.cancels().length, 1);
	h.finish(started.actionId, 'CANCELLED', 'ACTION_CANCELLED');
	await cancelling;
});
