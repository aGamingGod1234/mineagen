import assert from 'node:assert/strict';
import test from 'node:test';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { MINECRAFT_DYNAMIC_TOOLS, STEP_ONLY_ACTIONS, normalizeMinecraftToolCall, toolAdjustments } from '../src/native-minecraft-tools.mjs';
import { ESCAPE_FOLDED_TRIGGERS, STEP_ACTIONS, stepFolds } from '../src/wake-filter.mjs';
import { carriedCombatOptions, dangerFactLine } from '../src/dynamic-main.mjs';
import { parseArenaScript } from '../src/arena-script/parser.mjs';
import { canonicalCall, rises } from '../src/decision-eval/predicates.mjs';

test('do_step escape runs the escape body action with a 60 s default and never refuses an emergency for its arguments', () => {
	const plain = normalizeMinecraftToolCall('do_step', { verb: 'escape', target: {}, why: 'drowning in the flooded stairs' });
	assert.deepEqual([plain.kind, plain.actionType, plain.arguments], ['start_action', 'escape', { timeoutMs: 60_000 }]);
	assert.equal(plain.step.why, 'drowning in the flooded stairs');
	// No target and no why: still one call, not a rejection.
	const bare = normalizeMinecraftToolCall('do_step', { verb: 'escape' });
	assert.deepEqual([bare.actionType, bare.arguments, bare.step.why], ['escape', { timeoutMs: 60_000 }, 'get out safely']);
	// Arguments escape does not take are dropped and reported.
	const extra = normalizeMinecraftToolCall('do_step', { verb: 'escape', target: { x: 3, z: 4, timeoutMs: 1 }, why: 'out' });
	assert.deepEqual(extra.arguments, { timeoutMs: 60_000 });
	assert.deepEqual(Object.keys(toolAdjustments(extra)).sort(), ['target.timeoutMs', 'target.x', 'target.z']);
	assert.equal(normalizeMinecraftToolCall('do_step', { verb: 'escape', target: { timeoutMs: 120_000 }, why: 'out' }).arguments.timeoutMs, 120_000);
	// Anything else is dropped and reported, never refused: after would cancel what it waits for.
	for (const args of [{ verb: 'escape', target: 'shore', why: '' }, { verb: 'escape', x: 3, keepGoing: true, after: 'act-1', why: 'x'.repeat(150) }, { verb: 'escape', why: 7, until: '' }, { verb: 'escape', until: 'a\nb', target: { x: 1 }, after: 'h' }, { verb: 'escape', until: 'u'.repeat(400) }]) {
		const step = normalizeMinecraftToolCall('do_step', args);
		assert.deepEqual([step.actionType, step.arguments, step.after, step.keepGoing], ['escape', { timeoutMs: 60_000 }, undefined, undefined], JSON.stringify(args));
		assert.ok(toolAdjustments(step), JSON.stringify(args));
		assert.ok(step.step.why.length > 0 && step.step.why.length <= 100);
	}
	assert.deepEqual(Object.keys(toolAdjustments(normalizeMinecraftToolCall('do_step', { verb: 'escape', target: { x: 1 }, after: 'h' }))).sort(), ['after', 'target.x'], 'both stages report what they dropped');
});

test('escape is a do_step verb and a program call, kept out of the raw action enums to save tool bytes', () => {
	const doStep = MINECRAFT_DYNAMIC_TOOLS.find(({ name }) => name === 'do_step').inputSchema.properties.verb.enum;
	assert.ok(doStep.includes('escape'));
	for (const name of ['act', 'startAction', 'replaceAction']) {
		assert.ok(!MINECRAFT_DYNAMIC_TOOLS.find(tool => tool.name === name).inputSchema.properties.actionType.enum.includes('escape'), name);
	}
	assert.ok(STEP_ONLY_ACTIONS.has('escape'));
	assert.throws(() => normalizeMinecraftToolCall('startAction', { actionType: 'escape', arguments: { timeoutMs: 60_000 } }), { code: 'INVALID_MINECRAFT_TOOL_ARGUMENTS' });
	assert.doesNotThrow(() => parseArenaScript('program.onUnhandledAttention("pause_and_notify"); await player.escape({ timeoutMs: 60000 });'));
	assert.ok(STEP_ACTIONS.has('escape'), 'a running escape is a step: ordinary news folds into its end wake');
});

test('a running escape folds the drowning edges it is already answering, and nothing it is not', () => {
	assert.ok(ESCAPE_FOLDED_TRIGGERS.has('drowning'));
	const air = seconds => ({ player: { airSecondsLeft: seconds } });
	assert.equal(stepFolds('escape', { trigger: 'drowning' }, air(9)), true);
	assert.equal(stepFolds('escape', { trigger: 'drowning' }, air(3)), false, 'the last seconds of air always wake the model');
	assert.equal(stepFolds('escape', { trigger: 'drowning' }), false, 'unknown air wakes');
	assert.equal(stepFolds('travel_to', { trigger: 'drowning' }), false, 'other steps still wake for drowning');
	for (const trigger of ['damage', 'threat', 'lava', 'fire', 'suffocation', 'projectile']) assert.equal(stepFolds('escape', { trigger }), false, trigger);
	assert.equal(stepFolds('escape', { trigger: 'resource_discovery' }), true);
});

test('drowning, afloat and threat wakes offer the escape step instead of jump presses', () => {
	const drowning = dangerFactLine('drowning', { airSecondsLeft: 4.5, breathable: { x: 1, y: 63, z: 2, distance: 3, direction: 'up' } });
	assert.match(drowning, /do_step escape \(stops the running step\) swims to air and out onto dry footing, then hands back/);
	assert.doesNotMatch(drowning, /hold jump/i);
	const options = carriedCombatOptions({ inventory: { items: [] } });
	assert.match(options, /do_step escape \(cover from shooters, out of water or a hole; hands back once safe\)/);
	const graded = canonicalCall({ name: 'do_step', arguments: { verb: 'escape', target: {}, why: 'out' } });
	assert.equal(rises(graded, { position: { y: 40 } }), true, 'decision tests count escape as rising toward air');
});

test('do_step escape stops a running step itself instead of being refused as busy', async () => {
	const record = { agentId: 'escape-replace', provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', goalRevision: 1 };
	const sent = [];
	let runtime;
	runtime = new NativeToolRuntime({ registry: { get: () => record }, bridge: { send: async (type, id, payload) => {
		sent.push({ type, payload });
		if (type === 'action_cancel') setImmediate(() => runtime.onActionResult(record, { actionId: payload.actionId, goalRevision: 1, state: 'CANCELLED', reasonCode: 'CANCELLED', message: 'cancelled', executionStarted: true, physicalAttempted: true }));
	} } });
	runtime.updateObservation(record, { ready: true, world: { dimension: 'minecraft:overworld' }, player: { x: 0, y: 40, z: 0, health: 20, foodLevel: 20, underWater: true, airSecondsLeft: 6 } }, { eventSequence: 1 });
	try {
		const dig = normalizeMinecraftToolCall('do_step', { verb: 'dig_to', target: { pattern: 'stairs_down', y: 16 }, why: 'iron depth' });
		const digging = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'dig', callId: 'dig', tool: dig }, record);
		await new Promise(resolve => setImmediate(resolve));
		assert.equal(sent.filter(row => row.type === 'action_command').length, 1);
		const escape = normalizeMinecraftToolCall('do_step', { verb: 'escape', target: {}, why: 'the stairs flooded' });
		const result = await runtime.execute({ agentId: record.agentId, goalRevision: 1, turnId: 'escape', callId: 'escape', tool: escape }, record);
		const commands = sent.filter(row => row.type === 'action_command');
		assert.equal(sent.filter(row => row.type === 'action_cancel').length, 1, 'the running dig was cancelled');
		assert.equal(commands.length, 2);
		assert.equal(commands[1].payload.actionType, 'escape');
		assert.deepEqual(commands[1].payload.arguments, { timeoutMs: 60_000 });
		assert.equal(result.replacedAction.actionId, digging.actionId);
		assert.equal(result.replacedAction.state, 'CANCELLED');
		assert.equal(result.step.verb, 'escape');
		assert.equal(runtime.runningStep(record), 'escape');
	} finally { await runtime.dispose(record.agentId, 'test_complete'); }
});
