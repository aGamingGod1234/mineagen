import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
const { flight } = JSON.parse(readFileSync(new URL('./fixtures/stronghold-eyes/4145a-flight.json', import.meta.url)));

// Recorded visible flight only; bridge sequencing, inventory and stationary NO_ROUTE are injected.
test('production stronghold find throws, follows recorded eye and resumes only in the same scope', { timeout: 30000 }, async () => {
 const record = { agentId: 'eye-prefix', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
 const o = { player: { ...flight.from, health: 20, skyOpen: true, threats: [] },
  world: { worldId: 'eye-world', dimension: 'minecraft:overworld' },
  inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:ender_eye', count: 16, slot: 0 }] }, perception: { events: [] }, blocks: [] };
 let runtime, sequence = 0; const calls = [];
 runtime = new NativeToolRuntime({
  requestObservation: async () => ({ eventSequence: ++sequence, observation: structuredClone(o) }),
  inspectObservation: async () => ({ survey: {} }),
  bridge: { send: async (type, _id, p) => {
   if (type !== 'action_command') return;
   calls.push(p);
   if (p.actionType === 'use_item') { o.inventory.items[0].count--; o.perception.events = [{ ...flight, flightId: sequence }]; }
   queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: record.goalRevision,
    state: p.actionType === 'travel_to' ? 'FAILED' : 'SUCCEEDED', reasonCode: p.actionType === 'travel_to' ? 'NO_ROUTE' : 'DONE', executionStarted: true }));
  } },
 });
 const keepAlive = setInterval(() => {}, 1000);
 const find = () => {
  runtime.updateObservation(record, o, { eventSequence: ++sequence });
  return runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: 'eyes', callId: `find-${sequence}`,
   tool: normalizeMinecraftToolCall('do_step', { verb: 'find', target: { structure: 'stronghold', timeoutMs: 10000 }, why: 'follow observed eyes' }) }, record);
 };
 try {
  const first = await find();
  assert.ok(first.find?.eyes, 'must dispatch the eye hand instead of generic surface search');
  assert.equal(first.reasonCode, 'FIND_BLOCKED'); assert.equal(first.find.eyes.lastHeading, flight.yaw);
  // The recorded eye was lost from view: one walk to where it would have dropped (12 blocks on), then the bearing leg.
  const moves = calls.filter(c => c.actionType === 'travel_to').map(c => c.arguments);
  assert.ok(moves.some(m => Math.abs(Math.hypot(m.x - flight.from.x, m.z - flight.from.z) - 12) < .001), 'searched where the unseen eye drops');
  const move = moves.at(-1);
  assert.ok(Math.abs(move.x - (flight.from.x - Math.sin(flight.yaw * Math.PI / 180) * 120)) < .001);
  assert.equal(move.build, true); assert.equal(move.boundaryX, flight.from.x);
  await find(); assert.equal(calls.filter(c => c.actionType === 'use_item').length, 1, 'same goal resumes the leg');
  for (const reset of [() => record.goalRevision++, () => o.world.worldId = 'other-world', () => o.world.dimension = 'minecraft:the_end', () => o.world.dimension = 'minecraft:overworld']) {
   reset(); if (o.world.dimension !== 'minecraft:overworld') { o.player.health = 7; await find(); o.player.health = 20; continue; }
   const n = calls.filter(c => c.actionType === 'use_item').length;
   await find(); assert.equal(calls.filter(c => c.actionType === 'use_item').length, n + 1, 'new scope starts a new throw');
  }
 } finally { await runtime.dispose(record.agentId, 'test_complete'); clearInterval(keepAlive); }
});
