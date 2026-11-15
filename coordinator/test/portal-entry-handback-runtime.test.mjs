import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
const { window: saved } = JSON.parse(readFileSync(new URL('./fixtures/portal-room/f84-entry.json', import.meta.url)));

// Recorded command/terminal receipt/RCON positions; frontier and bridge sequencing are reconstructed.
async function probe(run, { position = saved.before.position, frame = null, health = 20 } = {}) {
 const record = { agentId: 'portal-entry', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' };
 const target = saved.arguments;
 const o = { player: { ...position, health }, world: { worldId: 'entry', dimension: 'minecraft:overworld' },
  inventory: { items: [{ itemId: 'minecraft:ender_eye', count: 11 }] },
  blocks: [{ blockId: 'minecraft:stone_bricks', x: -313, y: 37, z: 1851 }, ...(frame ? [frame] : [])] };
 const moves = []; let runtime, sequence = 0;
 runtime = new NativeToolRuntime({
  occupancy: { ingest() {}, load() {}, flush() {}, clear() {}, candidates: () => ({ candidates:
   [target, { ...target, x: target.x + 8 }].map(p => ({ ...p, x: p.x - .5, z: p.z - .5 })) }) },
  requestObservation: async () => ({ eventSequence: ++sequence, observation: structuredClone(o) }),
  inspectObservation: async () => ({ survey: {} }),
  bridge: { send: async (type, _id, payload) => {
   if (type !== 'action_command') return;
   const moving = payload.actionType === 'travel_to'; if (moving) moves.push(payload.arguments);
   const receipt = moving ? moves.length === 1 ? saved.receipt : { state: 'FAILED', reasonCode: 'NO_TOOL' }
    : { state: 'SUCCEEDED', reasonCode: 'CONTROL_SEGMENT_COMPLETED' };
   queueMicrotask(() => runtime.onActionResult(record, { ...receipt, actionId: payload.actionId,
    goalRevision: record.goalRevision, executionStarted: true, physicalAttempted: true }));
  } },
 });
 const keepAlive = setInterval(() => {}, 1000);
 const find = () => {
  runtime.updateObservation(record, o, { eventSequence: ++sequence });
  return runtime.execute({ agentId: record.agentId, goalRevision: record.goalRevision, turnId: 'entry', callId: `find-${sequence}`,
   tool: normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'end_portal_frame', timeoutMs: 30000 }, why: 'walk observed passages' }) }, record);
 };
 try { await run({ find, o, moves, record, runtime }); }
 finally { await runtime.dispose(record.agentId, 'test_complete'); clearInterval(keepAlive); }
}

test('recorded stationary NO_ROUTE hands entry decision back after one walking leg', { timeout: 15000 }, () => probe(async ({ find, moves }) => {
 const result = await find();
 assert.equal(result.reasonCode, 'FIND_BLOCKED');
 assert.equal(moves.length, 1);
 assert.deepEqual({ x: moves[0].x, y: moves[0].y, z: moves[0].z }, { x: -312.5, y: 34, z: 1852.5 });
 assert.equal(moves[0].build, false);
 assert.equal(result.find.seen, undefined);
 assert.deepEqual(result.find.portal.approach.actual, saved.after.position);
 assert.equal(result.find.portal.approach.verticalGap, -4);
 assert.equal(result.find.portal.approach.reasonCode, 'NO_ROUTE');
 assert.equal(result.find.portal.approach.message, saved.receipt.message);
 assert.match(result.message, /standing spot/);
}));

test('model descent resumes observed passages with the original room boundary; new goal resets origin', { timeout: 15000 }, () => probe(async ({ find, moves, record, o }) => {
 await find();
 Object.assign(o.player, { y: 34 });
 const resumed = await find();
 assert.equal(moves.length, 2);
 assert.equal(moves[1].x, -304.5);
 assert.deepEqual(resumed.find.portal.origin, saved.before.position);
 record.goalRevision++; o.player.x -= 10;
 const reset = await find();
 assert.deepEqual(reset.find.portal.origin, { x: o.player.x, y: o.player.y, z: o.player.z });
}));

test('nearby actual frame can certify sight, masonry cannot', { timeout: 15000 }, () => probe(async ({ find, moves }) => {
 const result = await find();
 assert.equal(result.reasonCode, 'FIND_SEEN');
 assert.equal(result.find.seen.id, 'minecraft:end_portal_frame');
 assert.equal(moves.length, 0);
}, { frame: { blockId: 'minecraft:end_portal_frame', x: -313, y: 37, z: 1852 } }));

test('low health hands back before a room walking leg', { timeout: 15000 }, () => probe(async ({ find, moves }) => {
 const result = await find();
 assert.equal(result.reasonCode, 'FIND_DANGER');
 assert.equal(moves.length, 0);
}, { health: 6 }));
