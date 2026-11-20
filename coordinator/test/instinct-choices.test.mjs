import assert from 'node:assert/strict';
import test from 'node:test';
import { CAVE_MIN_HEALTH, applyInstinctChoices, instinctChoicesEnabled, keptNote } from '../src/instinct-choices.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

const keepAlive = setInterval(() => {}, 1000);
test.after(() => clearInterval(keepAlive));

const fed = [{ itemId: 'minecraft:cooked_beef', slot: 9, count: 5 }, { itemId: 'minecraft:stone_pickaxe', slot: 'mainhand', count: 1 }];
const body = ({ health = 20, dimension = 'minecraft:overworld', items = fed } = {}) =>
	({ world: { dimension }, player: { x: 0.5, y: 40, z: 0.5, yaw: 0, health, air: 300, maxAir: 300, onGround: true }, inventory: { selectedSlot: 0, items }, blocks: [] });

test('a dig or trip asking never to drop into a cave runs the instinct way while healthy and fed in the Overworld', () => {
	const asked = { pattern: 'stairs_down', y: 16, throughCaves: false };
	const kept = applyInstinctChoices('dig_to', asked, body());
	assert.equal(kept.arguments.throughCaves, 'small');
	assert.deepEqual(kept.kept.map(row => [row.id, row.rule, row.asked, row.instinct]), [['caves', 'ore-cave-first', false, 'small']]);
	assert.equal(asked.throughCaves, false, 'the model\'s arguments are not mutated');
	assert.equal(applyInstinctChoices('travel_to', { x: 1, z: 2, throughCaves: false }, body()).arguments.throughCaves, 'small');
	assert.match(keptNote(kept.kept), /^instinct kept throughCaves:"small" \(you asked false; .*\)\. To go against it, repeat with overrule:/);
	assert.equal(keptNote([]), null);
});

test('the model value stands where the instinct does not hold or the model names its reason', () => {
	const asked = { pattern: 'tunnel', heading: 'north', throughCaves: false };
	for (const [label, observation] of [['hurt', body({ health: CAVE_MIN_HEALTH - 1 })], ['no food', body({ items: [] })], ['Nether', body({ dimension: 'minecraft:the_nether' })], ['no observation', null]]) {
		const result = applyInstinctChoices('dig_to', asked, observation);
		assert.equal(result.arguments.throughCaves, false, label);
		assert.deepEqual(result.kept, [], label);
	}
	const overruled = applyInstinctChoices('dig_to', asked, body(), { overrule: 'the cave below is flooded' });
	assert.equal(overruled.arguments.throughCaves, false);
	assert.deepEqual(overruled.overruled.map(row => row.because), ['the cave below is flooded']);
	for (const value of ['small', true]) assert.equal(applyInstinctChoices('dig_to', { throughCaves: value }, body()).arguments.throughCaves, value, `${value} already agrees`);
	assert.deepEqual(applyInstinctChoices('dig_to', { pattern: 'shaft', y: 0 }, body()).kept, [], 'an unset field is the body default already');
	assert.deepEqual(applyInstinctChoices('mine', { throughCaves: false }, body()).kept, [], 'only the verbs the choice covers');
});

test('MINEAGEN_INSTINCT_CHOICES=off is the only way to turn it off', () => {
	assert.equal(instinctChoicesEnabled({}), true);
	assert.equal(instinctChoicesEnabled({ MINEAGEN_INSTINCT_CHOICES: ' OFF' }), false);
	assert.equal(instinctChoicesEnabled({ MINEAGEN_INSTINCT_CHOICES: 'on' }), true);
});

test('overrule is one line on do_step and reaches the step', () => {
	const step = normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { pattern: 'tunnel', heading: 'north', throughCaves: false }, why: 'w', overrule: ' flooded cave ahead ' });
	assert.equal(step.step.overrule, 'flooded cave ahead');
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { pattern: 'tunnel', heading: 'north' }, why: 'w', overrule: 'a\nb' }), /one line/);
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { pattern: 'tunnel', heading: 'north' }, why: 'w', overrule: 'x'.repeat(161) }));
});

// The production step path: normalization, the runtime's step executor and the bridge command the mod receives.
async function digStep({ instinctChoices, overrule, observation = body() }) {
	const record = { agentId: 'instinct-agent', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' };
	const commands = [], traces = [];
	let sequence = 1;
	const runtime = new NativeToolRuntime({ instinctChoices, registry: { get: () => record }, trace: (event, fields) => traces.push([event, fields]),
		requestObservation: async () => ({ observation: structuredClone(observation), eventSequence: ++sequence }),
		bridge: { send: async (type, _a, p) => {
			commands.push({ type, ...p });
			if (type === 'action_command') queueMicrotask(() => runtime.onActionResult(record, { actionId: p.actionId, goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED', executionStarted: true }));
		} } });
	runtime.updateObservation(record, structuredClone(observation), { eventSequence: sequence });
	try {
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 't', callId: 'c',
			tool: normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { pattern: 'stairs_down', y: 16, throughCaves: false }, why: 'iron', ...(overrule ? { overrule } : {}) }) }, record);
		return { result, sent: commands.find(c => c.type === 'action_command')?.arguments, traces: traces.filter(([event]) => event.startsWith('instinct_')) };
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
}

test('through do_step, the mod receives the instinct value and the model reads why', async () => {
	const kept = await digStep({ instinctChoices: true });
	assert.equal(kept.sent.throughCaves, 'small');
	assert.match(kept.result.instinct, /^instinct kept throughCaves:"small"/);
	assert.deepEqual(kept.traces.map(([event, f]) => [event, f.id, f.asked]), [['instinct_choice_kept', 'caves', false]]);
	const overruled = await digStep({ instinctChoices: true, overrule: 'the cave below is flooded' });
	assert.equal(overruled.sent.throughCaves, false);
	assert.equal(overruled.result.instinct, undefined);
	assert.deepEqual(overruled.traces.map(([event, f]) => [event, f.because]), [['instinct_choice_overruled', 'the cave below is flooded']]);
	const off = await digStep({ instinctChoices: false });
	assert.equal(off.sent.throughCaves, false, 'a runtime without instinct choices sends exactly what the model asked');
	assert.deepEqual(off.traces, []);
});
