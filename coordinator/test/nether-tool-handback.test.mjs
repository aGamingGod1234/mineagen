import test from 'node:test';
import assert from 'node:assert/strict';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

// Production find adapter and terminal delivery; only Minecraft transport and samples are synthetic.
// These tests establish handback, not physical tunnelling or biome arrival.
const record = { agentId: 'tool-handback', goalRevision: 1, provider: 'codex', model: 'fixture', reasoningEffort: 'high', serviceTier: 'priority' };
const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));
async function run(t, code, spare = false) {
  const sent = [];
  let sequence = 1, travel = 0, selected = false, runtime;
  const observation = () => ({ ready: true, player: { x: 0.5, y: 65, z: 0.5, yaw: 0, health: 20, onGround: true, skyOpen: true },
    world: { dimension: 'minecraft:the_nether', biome: travel > 1 ? 'minecraft:warped_forest' : 'minecraft:basalt_deltas' },
    inventory: { selectedSlot: 0, items: spare && !selected ? [{ slot: 17, itemId: 'minecraft:iron_pickaxe', count: 1, damage: 10, maxDamage: 250 }] : [] }, blocks: [], entities: [], items: [] });
  runtime = new NativeToolRuntime({ registry: { get: () => record },
    bridge: { send: async (type, _agent, payload) => {
      if (type !== 'action_command') return;
      sent.push(payload);
      let reasonCode = 'DONE', state = 'SUCCEEDED', message = '';
      if (payload.actionType === 'travel_to') {
        travel++;
        if (travel === 1) {
          state = 'FAILED'; reasonCode = code;
          message = 'A tunnel heading needs a usable tool: minecraft:basalt at 79,65,63; slot=0 tool=minecraft:iron_pickaxe damage=249/250 remaining=1; no usable harvesting tool in slots 0-35';
        }
      }
      if (payload.actionType === 'select_tool') selected = true;
      queueMicrotask(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1, state, reasonCode, message, executionStarted: true }));
    } },
    requestObservation: async () => ({ observation: observation(), eventSequence: ++sequence }),
  });
  t.after(() => runtime.dispose(record.agentId));
  runtime.updateObservation(record, observation(), { eventSequence: sequence });
  const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'tool-test', callId: 'find',
    tool: normalizeMinecraftToolCall('do_step', { verb: 'find', target: { biome: 'minecraft:warped_forest', timeoutMs: 30000 }, why: 'Find the next biome' }) }, record);
  return { result, sent, travel, selected };
}
for (const code of ['NO_TOOL', 'TOOL_WORN']) {
  test(`${code} returns useful local facts before a second heading without a spare`, async t => {
    const { result, travel } = await run(t, code);
    assert.equal(result.reasonCode, 'FIND_BLOCKED');
    assert.equal(travel, 1);
    assert.match(result.message, new RegExp(code));
    assert.match(result.message, /minecraft:basalt at 79,65,63/);
    assert.match(result.message, /damage=249\/250 remaining=1/);
  });
  test(`${code} swaps a usable carried spare before resuming`, async t => {
    const { result, sent, travel, selected } = await run(t, code, true);
    assert.equal(result.reasonCode, 'FIND_SEEN');
    assert.equal(selected, true);
    assert.equal(travel, 2);
    const swap = sent.find(x => x.actionType === 'select_tool');
    assert.equal(swap.arguments.sourceSlot, 17);
    assert.equal(swap.arguments.minRemainingDurability, 3);
    assert.ok(sent.indexOf(swap) < sent.findIndex(x => x.actionType === 'travel_to' && x !== sent.find(y => y.actionType === 'travel_to')));
  });
}
test('ordinary NO_ROUTE continues exploring headings', async t => {
  const { result, travel, selected } = await run(t, 'NO_ROUTE');
  assert.equal(result.reasonCode, 'FIND_SEEN');
  assert.equal(travel, 2);
  assert.equal(selected, false);
});
