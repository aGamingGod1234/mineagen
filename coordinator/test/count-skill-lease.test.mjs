import assert from 'node:assert/strict';
import test from 'node:test';

import { goalSpecFingerprint } from '../src/goal-spec.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { countSkillDurationMs } from '../src/plan-count.mjs';

// d41-big rods review: a held count fight outlived the planner's tool lease (timeoutMs + 5 s) and the turn failed
// PLANNING_LEASE_EXPIRED 20-25 s in. The lease now mirrors the body's 180-600 s clamp; a plan-count conversion extends it.
const BLAZE = '33333333-3333-3333-3333-333333333333';
const fields = { originalRequest: 'get 6 blaze rods', predicate: { type: 'inventory_contains', itemId: 'minecraft:blaze_rod', count: 6 }, createdAtTick: 10 };
const record = () => ({ agentId: 'agent-a', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default',
	goalRevision: 3, currentGoal: fields.originalRequest, currentGoalSpec: { ...fields, fingerprint: goalSpecFingerprint(fields) } });

test('count skill durations mirror the body clamp', () => {
	const fight = (args) => countSkillDurationMs({ actionType: 'fight_target', arguments: args });
	assert.equal(fight({ targetId: BLAZE, timeoutMs: 15_000 }), null, 'a single fight keeps its own timeout');
	assert.equal(fight({ targetId: BLAZE, untilItem: 'minecraft:blaze_rod', untilCount: 6, timeoutMs: 15_000, collect: false }), 200_000);
	assert.equal(fight({ targetId: BLAZE, untilItem: 'minecraft:blaze_rod', untilCount: 6, timeoutMs: 900_000 }), 620_000);
	assert.equal(countSkillDurationMs({ actionType: 'fight_until', arguments: { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 6 } }), 200_000);
	assert.equal(countSkillDurationMs({ actionType: 'fight_until', arguments: { timeoutMs: 30_000 } }), 50_000, 'fight_until runs its own timeoutMs');
});

test('a fight_target the plan turns into a count fight extends the planner lease', async () => {
	const sent = [];
	const leases = [];
	const runtime = new NativeToolRuntime({ bridge: { send: async (...entry) => { sent.push(entry); } },
		planNeeds: () => [{ id: 'minecraft:blaze_rod', have: 1, need: 6, step: 'rods' }] });
	runtime.updateObservation(record(), { entities: [{ uuid: BLAZE, type: 'minecraft:blaze', distance: 6 }] }, { eventSequence: 1 });
	const tool = { kind: 'action', actionType: 'fight_target', arguments: { targetId: BLAZE, timeoutMs: 15_000 } };
	const pending = runtime.execute({ agentId: 'agent-a', goalRevision: 3, turnId: 'turn-1', callId: 'call-1', tool, extendLease: (ms) => leases.push(ms) }, record());
	await new Promise((resolve) => setImmediate(resolve));
	assert.equal(sent[0][2].arguments.untilItem, 'minecraft:blaze_rod');
	assert.deepEqual(leases, [200_000]);
	runtime.onActionResult(record(), { actionId: sent[0][2].actionId, state: 'SUCCEEDED', reasonCode: 'FIGHT_UNTIL_COUNT_REACHED', message: 'done' });
	await pending;
});
