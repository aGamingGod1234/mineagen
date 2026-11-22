import assert from 'node:assert/strict';
import test from 'node:test';

import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { NativeProgramExecutor } from '../src/native-program-executor.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { validateProtocolV2Payload } from '../src/protocol-v2.mjs';
import { CONFIRM_MS, blazeHold, holdCancelRefusal } from '../src/spawner-hold.mjs';

// Wall breaker rods, contract H11-H12: the model's own cancel or replace of a blaze spawner hold is confirmed by repeating it.
const tick = () => new Promise(resolve => setImmediate(resolve));
const hold = { actionId: 'a1', actionType: 'fight_until', arguments: { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 7 }, dimension: 'minecraft:the_nether' };

test('which running actions are a blaze hold', () => {
	assert.equal(blazeHold(hold), true);
	assert.equal(blazeHold({ ...hold, dimension: undefined }), true, 'no recorded dimension: treated as a hold (the mod decides)');
	assert.equal(blazeHold({ ...hold, arguments: { ...hold.arguments, roof: false } }), false, 'roof:false is the open fight');
	assert.equal(blazeHold({ ...hold, arguments: { ...hold.arguments, mob: 'minecraft:enderman' } }), false);
	assert.equal(blazeHold({ ...hold, actionType: 'fight_target' }), false);
	assert.equal(blazeHold({ ...hold, dimension: 'minecraft:overworld' }), false);
	// The mod keeps the ordinary fight for these (never a hold), so a replace with escape or build_shelter is not delayed.
	assert.equal(blazeHold({ ...hold, arguments: { ...hold.arguments, pursue: false } }), false, 'pursue:false is the ordinary fight');
	assert.equal(blazeHold({ ...hold, arguments: { ...hold.arguments, sneak: true } }), false, 'sneak:true is the ordinary fight');
	assert.equal(blazeHold({ ...hold, arguments: { ...hold.arguments, x: 1, y: 64, z: 2 } }), false, 'an explicit spot is the ordinary fight');
	assert.equal(holdCancelRefusal({ ...hold, arguments: { ...hold.arguments, pursue: false } }, { kind: 'replace_action', actionType: 'build_shelter' }, null, 0), null);
	assert.equal(blazeHold({ ...hold, arguments: { ...hold.arguments, pursue: true, sneak: false } }), true);
});

test('H11 a first cancel is refused with the hold state; H12 the same call repeated within 60 s passes', () => {
	const refused = holdCancelRefusal(hold, { kind: 'cancel_action', actionId: 'a1' }, null, 1_000);
	assert.equal(refused.code, 'CANCEL_CONFIRM_REQUIRED');
	assert.match(refused.message, /spawner hold/);
	assert.match(refused.message, /same cancelAction again within 60 s/);
	assert.match(holdCancelRefusal(hold, { kind: 'replace_action', actionId: 'a1' }, null, 1_000).message, /same replaceAction again/);
	assert.equal(holdCancelRefusal(hold, { kind: 'cancel_action' }, { actionId: 'a1', at: 1_000 }, 1_000 + CONFIRM_MS), null, 'repeated in time: passes');
	assert.equal(holdCancelRefusal(hold, { kind: 'cancel_action' }, { actionId: 'a1', at: 1_000 }, 1_001 + CONFIRM_MS).code, 'CANCEL_CONFIRM_REQUIRED', 'too late: asked again');
	assert.equal(holdCancelRefusal(hold, { kind: 'cancel_action' }, { actionId: 'other', at: 1_000 }, 2_000).code, 'CANCEL_CONFIRM_REQUIRED', 'a refusal of another action does not confirm this one');
	assert.equal(holdCancelRefusal({ ...hold, actionType: 'travel_to' }, { kind: 'cancel_action' }, null, 0), null, 'other actions need no confirmation');
	assert.equal(holdCancelRefusal(undefined, { kind: 'cancel_action' }, null, 0), null);
	assert.equal(holdCancelRefusal(hold, { kind: 'replace_action', actionType: 'flee_from' }, null, 0), null, 'a replace to flee_from is never delayed');
	assert.equal(holdCancelRefusal(hold, { kind: 'replace_action', actionType: 'wait' }, null, 0).code, 'CANCEL_CONFIRM_REQUIRED');
});

test('runtime: replaceAction to flee_from passes at once', async t => {
	const h = harness(t);
	const started = await h.call('startAction', { actionType: 'fight_until', arguments: holdArgs });
	await tick();
	const fleeing = h.call('replaceAction', { actionId: started.actionId, goalRevision: 1, actionType: 'flee_from', arguments: { targetId: '00000000-0000-0000-0000-0000000000b1', distance: 8, timeoutMs: 15_000 } });
	await tick();
	assert.equal(h.cancels().length, 1, 'the fight is cancelled for the flee without a confirmation');
	h.finish(started.actionId, 'CANCELLED', 'ACTION_CANCELLED');
	await tick();
	const flee = h.commands().at(-1);
	if (flee?.payload.actionType === 'flee_from') h.finish(flee.payload.actionId, 'SUCCEEDED', 'FLED');
	await fleeing.catch(() => {});
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

test('runtime: the first cancelAction or replaceAction of a blaze hold is refused and sends nothing; the repeat cancels', async t => {
	const h = harness(t);
	const started = await h.call('startAction', { actionType: 'fight_until', arguments: holdArgs });
	await tick();
	assert.equal(h.commands().length, 1);
	const refused = await h.call('replaceAction', { actionId: started.actionId, goalRevision: 1, actionType: 'wait', arguments: { durationMs: 5 } }).catch(e => e);
	assert.equal(refused.code, 'CANCEL_CONFIRM_REQUIRED');
	assert.equal(h.cancels().length, 0, 'the refused call reached no body');
	const cancelling = h.call('cancelAction', { actionId: started.actionId, goalRevision: 1 });
	await tick();
	assert.equal(h.cancels().length, 1, 'the repeat (as a cancel) goes through');
	h.finish(started.actionId, 'CANCELLED', 'ACTION_CANCELLED');
	await cancelling;
	assert.ok(h.traces.some(row => row.event === 'native_hold_cancel_refused'));
	assert.ok(h.traces.some(row => row.event === 'native_hold_cancel_confirmed'));
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
