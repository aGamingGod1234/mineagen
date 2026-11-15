import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { presentNativeToolResult } from '../src/codex-service.mjs';
import { decodeModelFacts } from '../src/model-fact-encoding.mjs';

test('production do_step preserves explicit resume and original body frame facts', async () => {
 const record = { agentId: 'explicit-resume', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', goalRevision: 1 };
 const sent = [];
 const runtime = new NativeToolRuntime({ registry: { get: () => record }, bridge: { send: async (type, id, payload) => sent.push({ type, payload }) } });
 runtime.updateObservation(record, { ready: true, world: { dimension: 'minecraft:overworld' }, player: { x: 249, y: -52, z: -282, health: 20, foodLevel: 20 } }, { eventSequence: 1 });
 const target = { frame: true, resume: true, x: 250, y: -52, z: -284, axis: 'z' };
 try {
  const tool = normalizeMinecraftToolCall('do_step', { verb: 'cast_obsidian', target, why: 'resume body-reported plane' });
  const handle = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'cast', callId: 'cast', tool }, record);
  await new Promise(resolve => setImmediate(resolve));
  const command = sent.find(row => row.type === 'action_command').payload;
  assert.equal(command.actionType, 'cast_obsidian');
  assert.deepEqual(command.arguments, { timeoutMs: 300000, ...target });
  const message = 'Cell not seen; frame at 250,-52,-284 axis z: 4/10 cells seen cast (unknown, not seen: 250,-48,-282); clicks: water poured 1, lava poured 1, water scooped 1, lava taken 0, blocks placed 0; carried water_bucket 1, lava_bucket 0, bucket 1';
  assert.equal(runtime.onActionResult(record, { actionId: handle.actionId, goalRevision: 1, state: 'FAILED', reasonCode: 'FRAME_CELL_UNSEEN', message, executionStarted: true, physicalAttempted: true }), true);
  const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'read', callId: 'read', tool: { kind: 'action_status', actionId: handle.actionId } }, record);
  const shown = decodeModelFacts(JSON.parse(presentNativeToolResult(result, { kind: 'action_status' }).response.contentItems[0].text));
  assert.ok(shown.failure.blockedBy.endsWith(message));
  assert.match(shown.failure.blockedBy, /resume:true,x:250,y:-52,z:-284,axis:"z"/);
  assert.equal(sent.filter(row => row.type === 'action_command').length, 1);
 } finally { await runtime.dispose(record.agentId, 'test_complete'); }
});

for (const tool of ['do_step', 'act', 'startAction']) test(`${tool} rejects incomplete resume intent and keeps false/default compatible`, () => {
 const base = { x: 250, y: -52, z: -284 };
 const normalize = target => normalizeMinecraftToolCall(tool, tool === 'do_step' ? { verb: 'cast_obsidian', target, why: 'schema' } : { actionType: 'cast_obsidian', arguments: target });
 for (const target of [{ ...base, resume: true, axis: 'z' }, { ...base, resume: true, frame: true }, { ...base, resume: true, frame: false, axis: 'z' }, { ...base, frame: true, resume: true, axis: 'z', y: -52.5 }]) assert.throws(() => normalize(target));
 for (const target of [base, { ...base, frame: true }, { ...base, resume: false }, { ...base, resume: true, frame: true, axis: 'z' }]) assert.doesNotThrow(() => normalize(target));
});

for (const mode of ['background', 'blocking same stack', 'blocking after boundary']) test(`danger suppresses cast retry advice: ${mode}`, async () => {
 const record = { agentId: 'resume-danger', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', goalRevision: 1 };
 const sent = [];
 const runtime = new NativeToolRuntime({ registry: { get: () => record }, bridge: { send: async (type, id, payload) => sent.push({ type, payload }) } });
 runtime.updateObservation(record, { ready: true, world: { dimension: 'minecraft:overworld' }, player: { x: 249, y: -52, z: -282, health: 20 } }, { eventSequence: 1 });
 try {
  const args = { frame: true, x: 250, y: -52, z: -284, axis: 'z' };
  const tool = mode === 'background' ? normalizeMinecraftToolCall('do_step', { verb: 'cast_obsidian', target: args, why: 'finish frame' })
   : normalizeMinecraftToolCall('act', { actionType: 'cast_obsidian', arguments: args });
  const pending = runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'cast', callId: 'cast', tool }, record);
  await new Promise(resolve => setImmediate(resolve));
  const actionId = sent.find(row => row.type === 'action_command').payload.actionId;
  assert.equal(runtime.interruptBlockingTool(record.agentId), mode !== 'background');
  if (mode === 'blocking after boundary') await new Promise(resolve => setImmediate(resolve));
  const message = 'No standing spot; frame at 250,-52,-284 axis z: 4/10 cells seen cast; carried water_bucket 1, lava_bucket 0, bucket 1';
  runtime.onActionResult(record, { actionId, goalRevision: 1, state: 'FAILED', reasonCode: 'NO_STAND_SPOT', message, executionStarted: true, physicalAttempted: true });
  await pending;
  const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'read', callId: 'read', tool: { kind: 'action_status', actionId } }, record);
  assert.equal(result.message, message, 'danger handback retains only the native facts');
  const shown = decodeModelFacts(JSON.parse(presentNativeToolResult(result, { kind: 'action_status' }).response.contentItems[0].text));
  assert.equal(shown.failure.blockedBy, message);
  assert.equal(sent.filter(row => row.type === 'action_command').length, 1);
  assert.equal(sent.some(row => row.type === 'action_cancel'), false, 'advice suppression does not cancel or replace the body');
 } finally { await runtime.dispose(record.agentId, 'test_complete'); }
});
