import test from 'node:test';
import assert from 'node:assert/strict';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { countSkillDurationMs } from '../src/plan-count.mjs';

const hunt = { mob: 'minecraft:enderman', untilItem: 'minecraft:ender_pearl', untilCount: 12 };

test('an untimed enderman pearl fight_until is dispatched with 540 s, through act and through do_step', () => {
	const act = normalizeMinecraftToolCall('act', { actionType: 'fight_until', arguments: { ...hunt, roof: true } });
	assert.equal(act.arguments.timeoutMs, 540_000);
	const step = normalizeMinecraftToolCall('do_step', { verb: 'fight_until', target: { ...hunt }, why: 'pearls' });
	assert.equal(step.arguments.timeoutMs, 540_000);
	assert.ok(countSkillDurationMs({ actionType: 'fight_until', arguments: act.arguments }) >= 540_000, 'the planner lease covers the hunt');
});

test('every other fight_until keeps 180 s, and a model timeout is kept as given', () => {
	assert.equal(normalizeMinecraftToolCall('act', { actionType: 'fight_until', arguments: { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 7 } }).arguments.timeoutMs, 180_000);
	assert.equal(normalizeMinecraftToolCall('act', { actionType: 'fight_until', arguments: { mob: 'minecraft:enderman', untilItem: 'minecraft:ender_eye', untilCount: 1 } }).arguments.timeoutMs, 180_000);
	assert.equal(normalizeMinecraftToolCall('act', { actionType: 'fight_until', arguments: { ...hunt, timeoutMs: 60_000 } }).arguments.timeoutMs, 60_000);
	assert.equal(normalizeMinecraftToolCall('act', { actionType: 'fight_until', arguments: { ...hunt, fleeAtHealth: 14 } }).arguments.fleeAtHealth, 14, 'the model fleeAtHealth is kept');
});
