import test from 'node:test';
import assert from 'node:assert/strict';
import { AgentRegistry, DynamicAgentState } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { FakePlanner, factToWireObservation, immutableGoalSpec, eventually, start, DEATH } from './fixtures/dynamic-main-fixture.mjs';

// The selected provider is faked; the coordinator, lifecycle admission, tool runtime,
// recovery memory and obtain entry point are production code. No Minecraft/model runs.
test('native model death -> respawn -> re-kit preserves the dragon goal and current inventory', async () => {
 const registry = new AgentRegistry(), planner = new FakePlanner(registry), errors = [], attempted = [], outcomes = [];
 const goal = 'Beat the game by killing the Ender Dragon.';
 const spec = immutableGoalSpec(goal, { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
 planner.requestNativeTurn = async request => {
  planner.requests.push(request);
  const dead = request.input.includes('player_death');
  const call = dead ? { name: 'act', arguments: { actionType: 'respawn', arguments: {} } }
   : planner.requests.length === 1 ? { name: 'act', arguments: { actionType: 'wait', arguments: { durationMs: 60000 } } }
   : { name: 'do_step', arguments: { verb: 'obtain', target: { item: 'minecraft:wooden_pickaxe' }, why: 'Re-kit after death using current inventory and observed wood.' } };
  attempted.push(call);
  try { outcomes.push(await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: `model-${planner.requests.length}`, callId: `call-${planner.requests.length}`, tool: normalizeMinecraftToolCall(call.name, call.arguments) })); }
  catch (error) { outcomes.push({ error: error.code, message: error.message }); }
  return { status: 'completed', toolCalls: 1 };
 };
 const run = await start({ registry, planner, config: { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } } });
 run.coordinator.on('runtimeError', e => errors.push(e));
 const sampleInspection = run.bridge.sampleInspection.bind(run.bridge);
 run.bridge.sampleInspection = request => {
  if (request.payload.query.section !== 'blocks') return sampleInspection(request);
  const latest = run.bridge.latestObservations.get(request.agentId);
  run.bridge.replyInspection(request, { entries: latest?.blocks ?? [], coverage: { hasMore: false } });
 };
 const t0 = Date.now();
 const commands = () => run.bridge.sent.filter(m => m.type === 'action_command');
 try {
  run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal, goalSpec: spec, updatedAtEpochMs: t0 } });
  run.bridge.emit('observation', { agentId: 'agent-a', payload: factToWireObservation({ player: { x: .5, y: 64, z: .5, health: 20 }, inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }] }, world: { worldId: 'same-game', dimension: 'minecraft:overworld', gameTime: 100, dayTime: 100, raining: false, thundering: false } }, 1, 1, false, t0) });
  await eventually(() => commands().some(m => m.payload.actionType === 'wait'));
  const death = { ...DEATH, cause: 'Probe was slain by Zombie', gameMode: 'survival', diedAtEpochMs: t0 + 1 };
  run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'dead', goalRevision: 1, updatedAtEpochMs: t0 + 1, death } });
  await eventually(() => commands().some(m => m.payload.actionType === 'respawn'));
  const deadTurn = planner.requests.find(r => r.input.includes('player_death'));
  assert.match(deadTurn.input, /Respawn keeps the goal/);
  assert.match(deadTurn.input, /re-kit from fresh inventory/);
  assert.equal(registry.get('agent-a').state, DynamicAgentState.DEAD);
  assert.equal(registry.get('agent-a').currentGoal, goal);
  const respawn = commands().find(m => m.payload.actionType === 'respawn');
  run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: respawn.payload.actionId, commandId: respawn.payload.actionId, actionType: 'respawn', state: 'SUCCEEDED', reasonCode: 'VANILLA_RESPAWNED', message: 'Respawned at the vanilla target', elapsedMs: 1, observedAtEpochMs: t0 + 2, eventSequence: 2 } });
  run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'respawn', goalRevision: 1, updatedAtEpochMs: t0 + 2, resumeGoal: true } });
  await eventually(() => run.bridge.sent.filter(m => m.type === 'agent_ready' && m.payload.goalRevision === 1).length >= 2);
  run.bridge.emit('observation', { agentId: 'agent-a', payload: factToWireObservation({ player: { x: .5, y: 64, z: .5, health: 20, skyOpen: true }, inventory: { items: [] }, blocks: [{ blockId: 'minecraft:oak_log', x: 1, y: 64, z: 0 }, { blockId: 'minecraft:stone', x: 0, y: 63, z: 0 }], world: { worldId: 'same-game', dimension: 'minecraft:overworld', gameTime: 103, dayTime: 103, raining: false, thundering: false } }, 1, 3, false, t0 + 3) });
  await eventually(() => attempted.some(c => c.arguments?.target?.item === 'minecraft:wooden_pickaxe'));
  const liveTurn = planner.requests.at(-1), payload = JSON.parse(liveTurn.input.slice(liveTurn.input.indexOf('\n') + 1));
  assert.equal(liveTurn.goalRevision, 1);
  assert.equal(registry.get('agent-a').currentGoal, goal);
  assert.equal(registry.get('agent-a').currentGoalSpec.fingerprint, spec.fingerprint);
  assert.deepEqual(payload.observation.inventory.items, [], 'lost pickaxe is not current possession');
  assert.match(liveTurn.input, /iron_pickaxe/, 'lost gear remains recovery evidence');
  await eventually(() => commands().some(m => ['look_at', 'mine_vein', 'break_block', 'travel_to'].includes(m.payload.actionType))).catch(error => { error.message += JSON.stringify({ actions: commands().map(m => m.payload.actionType), outcomes, errors: errors.map(e => e.message) }); throw error; });
  assert.ok(outcomes.some(r => r?.state === 'SUCCEEDED' && r.reasonCode === 'VANILLA_RESPAWNED'), 'the received successful respawn is returned to its caller, not rewritten as cancellation');
  assert.notEqual(registry.get('agent-a').state, DynamicAgentState.COMPLETED);
  assert.equal(run.bridge.sent.some(m => m.type === 'goal_completed'), false);
  assert.deepEqual(errors, []);
 } finally { await run.coordinator.stop(); }
});
