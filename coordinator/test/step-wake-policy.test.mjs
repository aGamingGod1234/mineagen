import assert from 'node:assert/strict';
import test from 'node:test';
import { AgentRegistry } from '../src/agent-registry.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { STEP_FOLDED_TRIGGERS, WakeFilter, stepFolds } from '../src/wake-filter.mjs';
import { FakePlanner, eventually, start } from './fixtures/dynamic-main-fixture.mjs';

// While a step runs, only surprises wake the model: the step's end or the body stopping it, danger the reflexes did not
// handle, chat, death and goal changes. Ordinary sightings, routine updates and the coordinator's loop notes are folded
// into the wake the step's end brings.

const CONFIG = { bridge: { port: 25570, secret: 's'.repeat(32) }, codex: { controlProtocol: 'native_tools' } };
const tick = () => new Promise((resolve) => setImmediate(resolve));
const settle = async () => { for (let index = 0; index < 6; index += 1) await tick(); };
const wake = (request) => JSON.parse(request.input.split('\n')[1]);

function observation(sequence, { attention = false, health = 20, x = sequence % 7, changedFacts, trigger, lastAttacker, inLava, blocks = [] } = {}) {
	return { agentId: 'agent-a', payload: { goalRevision: 1, eventSequence: sequence, attention, observedAtEpochMs: sequence, ...(changedFacts === undefined ? {} : { changedFacts }),
		...(trigger === undefined ? {} : { trigger }),
		observation: { player: { x, y: 64, z: 0, health, ...(lastAttacker === undefined ? {} : { lastAttacker }), ...(inLava === undefined ? {} : { inLava }) },
			items: [], entities: [], blocks, inventory: { items: [], tagCounts: {} } } } };
}

/** The first turn starts one do_step (a background dig_to) and ends; the body keeps digging until the test ends it. */
async function startWithStep(stepArguments = { verb: 'dig_to', target: { y: 16, maxBlocks: 80 }, why: 'iron is common near y16', until: 'iron seen' }) {
	const timers = [];
	const registry = new AgentRegistry();
	const planner = new FakePlanner(registry);
	const rows = [];
	const steers = [];
	planner.getExecutionSettings = () => ({ provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' });
	planner.steerNativeTurn = async (request) => { steers.push(request); return { turnId: 'turn' }; };
	planner.requestNativeTurn = async (request) => {
		planner.requests.push(request);
		if (planner.requests.length === 1) {
			const tool = normalizeMinecraftToolCall('do_step', stepArguments);
			planner.stepResult = await request.executeTool({ agentId: request.agentId, goalRevision: request.goalRevision, turnId: 'turn-1', callId: 'c1', tool });
			return { toolCalls: 1 };
		}
		return { toolCalls: 0 };
	};
	const run = await start({ registry, planner, config: CONFIG, traceWriter: { write(event, fields) { rows.push({ event, ...fields }); } },
		setWakeHoldTimeout: (callback, delayMs) => { const timer = { callback, delayMs, cleared: false }; timers.push(timer); return timer; },
		clearWakeHoldTimeout: (timer) => { timer.cleared = true; } });
	run.bridge.emit('goal_control', { agentId: 'agent-a', payload: { operation: 'start', goalRevision: 1, goal: 'Get iron.' } });
	run.bridge.emit('observation', observation(1, { attention: true, changedFacts: ['blocks'] }));
	await eventually(() => run.bridge.sent.some(({ type }) => type === 'action_command'));
	await eventually(() => rows.some(({ event }) => event === 'native_turn_completed'));
	const command = run.bridge.sent.find(({ type }) => type === 'action_command');
	const end = (state, reasonCode) => run.bridge.emit('action_result', { agentId: 'agent-a', payload: { goalRevision: 1, actionId: command.payload.actionId, state, reasonCode, actionType: command.payload.actionType, eventSequence: 50 } });
	return { run, planner, rows, steers, timers, command, end };
}

/** Ordinary noise a dig produces: sightings, routine updates, a non-major structure and a walk that loops back and forth. */
async function noise(run, from = 2) {
	let sequence = from;
	// Three ore blocks seen one at a time while the body digs: each is a new resource sighting.
	for (const z of [3, 4, 5]) {
		run.bridge.emit('observation', observation(sequence++, { attention: true, changedFacts: ['blocks'], blocks: [{ blockId: 'minecraft:coal_ore', x: 2, y: 60, z }] }));
		await tick();
	}
	run.bridge.emit('observation', observation(sequence++, { attention: true, changedFacts: ['blocks'] }));
	run.bridge.emit('observation', observation(sequence++, { attention: true, changedFacts: ['sighted'] }));
	run.bridge.emit('observation', observation(sequence++));
	for (const x of [1, 0, 1, 0, 1, 1]) { run.bridge.emit('observation', observation(sequence++, { x })); await tick(); }
	await settle();
	return sequence;
}

test('a do_step starts its action in the background, says why in game chat and becomes the current intent', async () => {
	const { run, planner, command } = await startWithStep();
	try {
		assert.equal(command.payload.actionType, 'dig_to');
		assert.equal(planner.stepResult.state, 'RUNNING');
		assert.deepEqual({ verb: planner.stepResult.step.verb, why: planner.stepResult.step.why }, { verb: 'dig_to', why: 'iron is common near y16' });
		assert.match(planner.stepResult.step.next, /End your turn/);
		const chat = run.bridge.sent.filter(({ type, payload }) => type === 'verbose_event' && payload?.stage === 'decision');
		assert.ok(chat.some(({ payload }) => /dig to: iron is common near y16/.test(payload.message)), 'the step\'s why is shown in game chat');
	} finally { await run.coordinator.stop(); }
});

test('noisy ordinary events during a running step cause no extra model turn and arm no deadline', async () => {
	const { run, planner, rows, steers, timers } = await startWithStep();
	try {
		await noise(run);
		assert.equal(planner.requests.length, 1, 'no model turn for sightings, routine updates or a movement loop');
		assert.equal(steers.length, 0);
		assert.equal(timers.length, 0, 'a step\'s folds have no 15 s release');
		const folded = rows.filter(({ event, verdict }) => event === 'native_wake_filtered' && verdict === 'fold');
		assert.ok(folded.some(({ trigger }) => trigger === 'resource_discovery'));
		assert.ok(folded.some(({ trigger }) => trigger === 'movement_loop'), 'the coordinator\'s loop note is folded while the body digs');
	} finally { await run.coordinator.stop(); }
});

test('the step finishing wakes the model once, with the folded events summed', async () => {
	const { run, planner, end } = await startWithStep();
	try {
		const next = await noise(run);
		end('SUCCEEDED', 'DIG_DONE');
		run.bridge.emit('observation', observation(next + 50, { attention: true, changedFacts: ['blocks'] }));
		await eventually(() => planner.requests.length === 2);
		await settle();
		assert.equal(planner.requests.length, 2, 'exactly one wake for the finished step');
		const event = wake(planner.requests[1]);
		assert.match(event.now.whileActing, /resource sighting x3/);
		assert.match(event.now.whileActing, /routine update/);
	} finally { await run.coordinator.stop(); }
});

test('the body stopping the step wakes the model', async () => {
	const { run, planner, end } = await startWithStep();
	try {
		await noise(run);
		end('FAILED', 'WATER_AHEAD');
		run.bridge.emit('observation', observation(60, { attention: true, changedFacts: ['blocks'] }));
		await eventually(() => planner.requests.length === 2);
	} finally { await run.coordinator.stop(); }
});

test('danger the reflexes did not handle wakes the model during a step', async () => {
	for (const danger of [
		{ attention: true, changedFacts: ['health'], health: 6 },
		{ attention: true, changedFacts: ['player.inLava'], inLava: true },
		{ attention: true, changedFacts: ['health'], health: 17 },
	]) {
		const { run, planner } = await startWithStep();
		try {
			await noise(run);
			run.bridge.emit('observation', observation(40, danger));
			await eventually(() => planner.requests.length === 2);
		} finally { await run.coordinator.stop(); }
	}
});

test('player chat wakes the model during a step', async () => {
	const { run, planner } = await startWithStep();
	try {
		await noise(run);
		run.bridge.emit('conversation_event', { agentId: 'agent-a', payload: {
			sequence: 1, kind: 'player_message', sourceId: 'player-a', recipientId: 'agent-a', scope: 'direct', text: 'Where are you?', goalRevision: 1, observedAtEpochMs: 1_787_184_000_000 } });
		await eventually(() => planner.requests.length === 2);
	} finally { await run.coordinator.stop(); }
});

test('stepFolds folds only ordinary triggers and only while a step runs', () => {
	for (const trigger of ['resource_discovery', 'attention', 'observation', 'movement_loop', 'structure_sighted', 'context_entry']) {
		assert.equal(stepFolds('dig_to', { attention: true, priority: 'ordinary', trigger }), true, trigger);
		assert.equal(stepFolds(null, { attention: true, priority: 'ordinary', trigger }), false, trigger);
	}
	for (const trigger of ['damage', 'threat', 'lava', 'lava_flow', 'drowning', 'suffocation', 'fall', 'low_health', 'stuck', 'conversation', 'dimension_changed', 'respawn', 'tool_broke']) {
		assert.equal(STEP_FOLDED_TRIGGERS.has(trigger), false, trigger);
		assert.equal(stepFolds('travel_to', { attention: true, priority: 'urgent', trigger }), false, trigger);
	}
});

test('a fold is summed into the next whileActing line and a major discovery is still a wake', () => {
	const filter = new WakeFilter();
	const at = { player: { health: 20 }, inventory: { items: [] } };
	filter.fold('a', 'resource_discovery', at);
	filter.fold('a', 'resource_discovery', at);
	filter.fold('a', 'movement_loop', at);
	filter.fold('a', 'attention', at);
	assert.equal(filter.take('a', at), 'not woken for: resource sighting x2; movement loop (the body kept going); 1 routine update(s)');
	assert.equal(filter.take('a', at), null);
	const fortress = { ...at, sighted: { structures: [{ type: 'minecraft:fortress', new: true }] } };
	assert.equal(filter.discovery('a', { attention: { trigger: 'structure_sighted' }, observation: fortress }), 'fortress sighted');
	assert.equal(filter.discovery('a', { attention: { trigger: 'structure_sighted' }, observation: { ...at, sighted: { structures: [{ type: 'minecraft:village', new: true }] } } }), null);
});

test('until "seen:<block>" stops a dig in the body: the dig carries stopWhenSeen and its TARGET_SEEN end wakes the model once', async () => {
	const { run, planner, command, end } = await startWithStep({ verb: 'dig_to', target: { y: 16, maxBlocks: 80 }, why: 'iron is common near y16', until: 'seen:iron_ore' });
	try {
		assert.equal(command.payload.arguments.stopWhenSeen, 'minecraft:iron_ore', 'the body stops the dig itself on that sighting (TARGET_SEEN)');
		// Ores the dig passes are ordinary news; the body's own stop on iron is the step ending.
		run.bridge.emit('observation', observation(2, { attention: true, changedFacts: ['blocks'], blocks: [{ blockId: 'minecraft:coal_ore', x: 2, y: 60, z: 3 }] }));
		await settle();
		assert.equal(planner.requests.length, 1);
		end('SUCCEEDED', 'TARGET_SEEN');
		run.bridge.emit('observation', observation(51, { attention: true, changedFacts: ['blocks'], blocks: [{ blockId: 'minecraft:iron_ore', x: 3, y: 16, z: 3 }] }));
		await eventually(() => planner.requests.length === 2);
		await settle();
		assert.equal(planner.requests.length, 2, 'one wake for the sighting that ended the step');
	} finally { await run.coordinator.stop(); }
});

test('until "seen:<block>" on a verb that does not stop itself wakes the model at the real sighting, once', async () => {
	const { run, planner, rows } = await startWithStep({ verb: 'fight_until', target: { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 7 }, why: 'rods for eyes', until: 'seen:minecraft:nether_wart' });
	try {
		await noise(run);
		assert.equal(planner.requests.length, 1, 'other sightings fold');
		run.bridge.emit('observation', observation(30, { attention: true, changedFacts: ['blocks'], blocks: [{ blockId: 'minecraft:nether_wart', x: 4, y: 64, z: 1 }] }));
		await eventually(() => planner.requests.length === 2);
		assert.equal(wake(planner.requests[1]).trigger, 'step_until_seen');
		assert.ok(rows.some(({ event, verdict, reason }) => event === 'native_wake_filtered' && verdict === 'wake' && /until seen:minecraft:nether_wart/.test(reason)));
		run.bridge.emit('observation', observation(31, { attention: true, changedFacts: ['blocks'], blocks: [{ blockId: 'minecraft:nether_wart', x: 5, y: 64, z: 1 }] }));
		await settle();
		assert.equal(planner.requests.length, 2, 'the step\'s sighting wakes once');
	} finally { await run.coordinator.stop(); }
});

/** A walk that keeps looping: back and forth between two cells, one sample every stepMs from atMs on. */
async function loopFor(run, { from, atMs, untilMs, stepMs = 5_000, items = () => [] }) {
	let sequence = from;
	for (let at = atMs, index = 0; at <= untilMs; at += stepMs, index += 1) {
		const sample = observation(sequence++, { x: index % 2 });
		sample.payload.observedAtEpochMs = at;
		// The stall clock runs on game ticks (20 a second), as live samples carry them.
		sample.payload.observation.world = { dimension: 'minecraft:overworld', gameTime: Math.round(at / 50), dayTime: 1_000, raining: false, thundering: false };
		sample.payload.observation.inventory.items = items(at);
		run.bridge.emit('observation', sample);
		await tick();
	}
	await settle();
	return sequence;
}

test('a step whose walk keeps looping for 3 min wakes the model once with the stall, and the step keeps running', async () => {
	const { run, planner, rows } = await startWithStep();
	try {
		const start = 1_787_184_000_000;
		const next = await loopFor(run, { from: 2, atMs: start, untilMs: start + 170_000 });
		assert.equal(planner.requests.length, 1, 'under 3 min of loop notes still folds');
		await loopFor(run, { from: next, atMs: start + 175_000, untilMs: start + 200_000 });
		await eventually(() => planner.requests.length === 2);
		await settle();
		assert.equal(planner.requests.length, 2, 'one wake for the stall');
		const event = wake(planner.requests[1]);
		assert.equal(event.trigger, 'step_stalled');
		assert.match(event.now.whileActing, /^not woken for: the step made no progress for 3 min \(no item gained\); movement loop \(the body kept going\) x\d+/);
		assert.ok(rows.some(({ event: name, verdict, reason }) => name === 'native_wake_filtered' && verdict === 'wake' && /^step dig_to stalled 1\d\d s$/.test(reason)));
		assert.equal(run.bridge.sent.filter(({ type }) => type === 'cancel_action').length, 0, 'the wake does not stop the step');
	} finally { await run.coordinator.stop(); }
});

test('a looping step that keeps gaining items is not woken for a stall (same cadence as the stalled case)', async () => {
	const { run, planner } = await startWithStep();
	try {
		const start = 1_787_184_000_000;
		await loopFor(run, { from: 2, atMs: start, untilMs: start + 400_000, items: (at) => [{ slot: 0, itemId: 'minecraft:cobblestone', count: 1 + Math.floor((at - start) / 60_000) }] });
		assert.equal(planner.requests.length, 1, 'a cobblestone gained every minute resets the stall clock');
	} finally { await run.coordinator.stop(); }
});
