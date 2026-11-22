import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { FakePlanner, eventually, immutableGoalSpec, record, start } from './fixtures/dynamic-main-fixture.mjs';

// The production coordinator path for MINEAGEN_CHOICE_TOOL=on: a flagged moment leads the wake input, and the
// model's choose_response call runs the planned body step through the same tool path as its own calls.
const config = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools',
	launchProfile: { agentId: 'coordinator', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'priority' } } };

// Body tools wait on the bridge; one ref'd handle keeps the loop alive while they do.
const keepAlive = setInterval(() => {}, 1_000);
test.after(() => clearInterval(keepAlive));

const ZOMBIE = '00000000-0000-4000-8000-00000000a001';
const zombie = { uuid: ZOMBIE, type: 'minecraft:zombie', signals: ['targeting'], distance: 6, bearing: 0, targeting: true, swelling: false, lineOfSight: true, visible: true };

// Only Codex threads get the choose_response tool, so the agent is a Codex agent unless a case says otherwise.
async function launch(t, env = {}, agent = record(), body = {}) {
	const registry = new AgentRegistry(), planner = new FakePlanner(registry), turns = [], traces = [];
	planner.steers = [];
	planner.steerNativeTurn = async request => { planner.steers.push(request); if (typeof request.input === 'function') await request.input(); };
	planner.requestNativeTurn = request => { planner.requests.push(request); return new Promise((resolve, reject) => turns.push({ resolve, reject })); };
	const run = await start({ registry, planner, config, env, initialRegistry: [agent], traceWriter: { write: (event, details) => traces.push({ event, ...details }) } });
	t.after(async () => { for (const turn of turns) turn.resolve({ toolCalls: 0 }); await run.coordinator.stop(); });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Get food.', goalSpec: immutableGoalSpec('Get food.') } });
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { ready: true, position: { x: 0, y: 64, z: 0 }, view: { yaw: 0, pitch: 0 },
		inventory: { items: [] }, entities: [], blocks: [], world: { dimension: 'minecraft:overworld', gameTime: 1, dayTime: 1000, raining: false, thundering: false },
		goalRevision: 1, eventSequence: 1, observedAtEpochMs: 1, attention: true, changedFacts: ['threats.zombie.targeting'], threats: { entries: [zombie] },
		...body, player: { health: 20, maxHealth: 20, air: 300, maxAir: 300, foodLevel: 20, onGround: true, ...body.player } } });
	await eventually(() => planner.requests.length === 1);
	return { run, planner, traces, request: planner.requests[0] };
}

const choose = (request, choice) => request.executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'pick',
	tool: normalizeMinecraftToolCall('choose_response', { choice }) });

test('a hostile targeting the player leads the wake with the threat menu', async t => {
	const { request, traces } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' });
	assert.equal(typeof request.input, 'string');
	assert.ok(request.input.startsWith('A hostile mob has just started targeting you. First call choose_response'), request.input.slice(0, 200));
	assert.match(request.input.split('\n')[0], /retreat_cover = break line of sight/);
	assert.deepEqual(traces.filter(x => x.event === 'choice_moment_offered').map(x => x.kind), ['threat']);
});

test('retreat_cover runs flee_from on the zombie and reports the choice', async t => {
	const { run, request, traces } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' });
	const pending = choose(request, 'retreat_cover');
	await eventually(() => run.bridge.sent.some(x => x.type === 'action_command'));
	const command = run.bridge.sent.find(x => x.type === 'action_command');
	assert.equal(command.payload.actionType, 'flee_from');
	assert.equal(command.payload.arguments.targetId, ZOMBIE);
	run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state: 'SUCCEEDED',
		reasonCode: 'ACTION_COMPLETED', message: 'Fled', executionStarted: true, eventSequence: 2 } });
	const result = await pending;
	assert.equal(typeof result.choice, 'string', JSON.stringify(result));
	assert.ok(result.choice.startsWith('Chosen: break line of sight'), result.choice);
	assert.equal(result.state, 'SUCCEEDED', JSON.stringify(result));
	assert.deepEqual(traces.filter(x => x.event === 'choice_made').map(x => [x.kind, x.choice, x.plan, x.body]), [['threat', 'retreat_cover', 'call', 'flee_from']]);
});

test('with the choice tool off, the same wake carries no moment line', async t => {
	const { request, traces } = await launch(t);
	assert.equal(typeof request.input, 'string');
	assert.doesNotMatch(request.input, /choose_response/);
	assert.equal(traces.some(x => x.event === 'choice_moment_offered'), false);
});

test('a non-Codex agent gets no moment line even with the choice tool on', async t => {
	const { request, traces } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' }, { ...record(), provider: 'claude', model: 'claude-opus-5-5' });
	assert.equal(typeof request.input, 'string');
	assert.doesNotMatch(request.input, /choose_response/);
	assert.equal(traces.some(x => x.event === 'choice_moment_offered'), false);
});

test('a carry-on key dispatches no body action and says the running step goes on', async t => {
	const { run, request } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' });
	const result = await choose(request, 'ignore');
	assert.match(result.choice, /running step goes on/);
	await new Promise(resolve => setImmediate(resolve));
	assert.equal(run.bridge.sent.some(x => x.type === 'action_command'), false);
});

test('with a step already running, retreat_cover replaces it with flee_from instead of being refused', async t => {
	const { run, request, traces } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' });
	const walking = await request.executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'walk',
		tool: normalizeMinecraftToolCall('startAction', { actionType: 'travel_to', arguments: { x: 40, y: 64, z: 0, timeoutMs: 60_000 } }) });
	assert.equal(walking.state, 'RUNNING', JSON.stringify(walking));
	const pending = choose(request, 'retreat_cover');
	// The replacement stops the walk first; the body reports it cancelled, then the flee starts.
	for (let i = 0; i < 50 && !run.bridge.sent.some(x => x.type === 'action_command' && x.payload.actionType === 'flee_from'); i++) {
		const cancel = run.bridge.sent.find(x => x.type === 'action_cancel' && !x.answered);
		if (cancel) { cancel.answered = true; run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: walking.actionId, state: 'CANCELLED', reasonCode: 'CANCELLED', message: 'Cancelled', executionStarted: true, eventSequence: 2 } }); }
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	const flee = run.bridge.sent.find(x => x.type === 'action_command' && x.payload.actionType === 'flee_from');
	assert.ok(flee, `sent: ${run.bridge.sent.map(x => `${x.type}:${x.payload?.actionType ?? ''}`).join(', ')}`);
	assert.equal(flee.payload.arguments.targetId, ZOMBIE);
	run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: flee.payload.actionId, state: 'SUCCEEDED',
		reasonCode: 'ACTION_COMPLETED', message: 'Fled', executionStarted: true, eventSequence: 3 } });
	const result = await pending;
	assert.doesNotMatch(result.choice, /could not do it/, result.choice);
	const made = traces.filter(x => x.event === 'choice_made');
	assert.deepEqual(made.map(x => [x.choice, x.body, x.via, x.replacedRunning]), [['retreat_cover', 'flee_from', 'replaceAction', true]]);
});

test('if the hostile is gone by the time the bot answers, back off goes back to the bot instead of fleeing a stale target', async t => {
	const { run, request } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' });
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { ready: true, position: { x: 0, y: 64, z: 0 }, view: { yaw: 0, pitch: 0 },
		inventory: { items: [] }, entities: [], blocks: [], world: { dimension: 'minecraft:overworld', gameTime: 40, dayTime: 1040, raining: false, thundering: false },
		goalRevision: 1, eventSequence: 2, observedAtEpochMs: 2, attention: false, changedFacts: [], threats: { entries: [] },
		player: { health: 20, maxHealth: 20, air: 300, maxAir: 300, foodLevel: 20, onGround: true } } });
	await new Promise(resolve => setTimeout(resolve, 20));
	const result = await choose(request, 'retreat_cover');
	assert.match(result.choice, /make the tool call that does it now/, result.choice);
	assert.equal(run.bridge.sent.some(x => x.type === 'action_command'), false);
});

test('an emergency after the offer stops the chosen fight: drowning keeps the body for escape', async t => {
	const { run, request, traces } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' });
	run.bridge.emit('observation', { agentId: 'agent-a', payload: { ready: true, position: { x: 0, y: 50, z: 0 }, view: { yaw: 0, pitch: 0 },
		inventory: { items: [] }, entities: [], blocks: [], world: { dimension: 'minecraft:overworld', gameTime: 40, dayTime: 1040, raining: false, thundering: false },
		goalRevision: 1, eventSequence: 2, observedAtEpochMs: 2, attention: false, changedFacts: [], threats: { entries: [zombie] },
		player: { health: 6, maxHealth: 20, air: 40, maxAir: 300, underWater: true, foodLevel: 20, onGround: false } } });
	await new Promise(resolve => setTimeout(resolve, 20));
	const pending = choose(request, 'fight');
	await new Promise(resolve => setTimeout(resolve, 30));
	assert.equal(run.bridge.sent.some(x => x.type === 'action_command'), false, 'no fight is sent to the body');
	const result = await pending;
	// Either the drowning wake already closed the menu (no menu leads it), or the answer meets the drowning body.
	assert.match(result.choice, /running out of air comes first|no moment is open/, result.choice);
	assert.ok(traces.filter(x => x.event === 'choice_made').every(x => x.plan !== 'call'));
});

test('a drowning wake at low health with a drowned on the bot leads with the drowning line, not a fight-or-run menu', async t => {
	const drowned = { ...zombie, type: 'minecraft:drowned' };
	const { request, traces } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' }, record(), { threats: { entries: [drowned] },
		changedFacts: ['threats.drowned.targeting', 'player.air'], player: { health: 6, air: 40, underWater: true, onGround: false } });
	assert.equal(typeof request.input, 'string');
	assert.doesNotMatch(request.input, /choose_response/);
	assert.match(request.input.split('\n')[0], /drowning/);
	assert.equal(traces.some(x => x.event === 'choice_moment_offered'), false);
});

test('a bot touching lava is offered no use-lava or carry-on menu', async t => {
	const { request, traces } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' }, record(), { threats: { entries: [] }, changedFacts: ['player.inLava'],
		blocks: [{ blockId: 'minecraft:lava', x: 0, y: 64, z: 0 }], player: { health: 14, inLava: true } });
	assert.doesNotMatch(request.input, /choose_response/);
	assert.equal(traces.some(x => x.event === 'choice_moment_offered'), false);
});

test('choosing a shelter while walking stops the walk and starts the same registered step, with its why, as from rest', async t => {
	const { run, request, traces } = await launch(t, { MINEAGEN_CHOICE_TOOL: 'on' }, record(), { threats: { entries: [] }, changedFacts: ['world.night'],
		world: { dimension: 'minecraft:overworld', gameTime: 1, dayTime: 15000, raining: false, thundering: false },
		inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 40, slot: 4 }], selectedSlot: 0 }, player: { skyOpen: true, yaw: 0 } });
	assert.deepEqual(traces.filter(x => x.event === 'choice_moment_offered').map(x => x.kind), ['night_falls']);
	const walking = await request.executeTool({ agentId: 'agent-a', goalRevision: 1, turnId: 'turn-1', callId: 'walk',
		tool: normalizeMinecraftToolCall('startAction', { actionType: 'travel_to', arguments: { x: 40, y: 64, z: 0, timeoutMs: 60_000 } }) });
	assert.equal(walking.state, 'RUNNING', JSON.stringify(walking));
	const pending = choose(request, 'shelter');
	for (let i = 0; i < 50 && !run.bridge.sent.some(x => x.type === 'action_command' && x.payload.actionType === 'build_shelter'); i++) {
		const cancel = run.bridge.sent.find(x => x.type === 'action_cancel' && !x.answered);
		if (cancel) { cancel.answered = true; run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: walking.actionId, state: 'CANCELLED', reasonCode: 'CANCELLED', message: 'Cancelled', executionStarted: true, eventSequence: 2 } }); }
		await new Promise(resolve => setTimeout(resolve, 10));
	}
	const shelter = run.bridge.sent.find(x => x.type === 'action_command' && x.payload.actionType === 'build_shelter');
	assert.ok(shelter, `sent: ${run.bridge.sent.map(x => `${x.type}:${x.payload?.actionType ?? ''}`).join(', ')}`);
	const result = await pending;
	assert.equal(result.step?.verb, 'build_shelter', JSON.stringify(result));
	assert.equal(result.step?.started, true, 'the step is registered as the current step');
	assert.equal(result.step?.why, 'Wall in and wait it out safely.');
	assert.deepEqual(traces.filter(x => x.event === 'choice_made').map(x => [x.choice, x.body, x.via, x.replacedRunning]), [['shelter', 'build_shelter', 'do_step', true]]);
});
