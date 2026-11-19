import test from 'node:test';
import assert from 'node:assert/strict';
import { PEARL_HUNT_TIMEOUT_MS, huntFleeLine, isPearlHunt, pearlHuntDefaults } from '../src/pearl-hunt.mjs';
import { countSkillDurationMs } from '../src/plan-count.mjs';

const ENDER = '22222222-2222-4222-8222-222222222222';
const BLAZE = '11111111-1111-4111-8111-111111111111';
const nether = { world: { dimension: 'minecraft:the_nether' }, player: { health: 20 }, entities: [
	{ uuid: ENDER, type: 'minecraft:enderman' }, { uuid: BLAZE, type: 'minecraft:blaze' }] };
const overworld = { world: { dimension: 'minecraft:overworld' }, player: { health: 20 }, entities: [] };
const hunt = (extra = {}) => ({ actionType: 'fight_until', arguments: { mob: 'minecraft:enderman', untilItem: 'minecraft:ender_pearl', untilCount: 12, ...extra } });

test('the model 14 is lowered to the stance retreat line (default-retreat: steady 7, cautious 10; fight 4 floored at the body default 6)', () => {
	for (const [stance, line] of [['steady', 7], ['fight', 6], ['cautious', 10]]) {
		const { tool, note } = pearlHuntDefaults(hunt({ fleeAtHealth: 14, timeoutMs: 300_000 }), { stance, observation: nether });
		assert.equal(tool.arguments.fleeAtHealth, line, stance);
		assert.match(note, new RegExp(`fleeAtHealth 14 lowered to ${line} \\(${stance} stance`));
		assert.equal(tool.arguments.timeoutMs, 300_000, 'the model timeout is kept');
	}
});

test('with instincts off (stance null) the line is the auto stance: cautious in the Nether, steady on a healthy Overworld body', () => {
	assert.deepEqual(huntFleeLine(null, nether), { stance: 'cautious', line: 10 });
	assert.deepEqual(huntFleeLine(null, overworld), { stance: 'steady', line: 7 });
	assert.equal(pearlHuntDefaults(hunt({ fleeAtHealth: 14, timeoutMs: 60_000 }), { stance: null, observation: nether }).tool.arguments.fleeAtHealth, 10);
});

test('a fleeAtHealth at or below the line, or none, is the model own and kept', () => {
	assert.equal(pearlHuntDefaults(hunt({ fleeAtHealth: 6, timeoutMs: 60_000 }), { stance: 'cautious', observation: nether }).note, undefined);
	assert.equal(pearlHuntDefaults(hunt({ fleeAtHealth: 10, timeoutMs: 60_000 }), { stance: 'cautious', observation: nether }).tool.arguments.fleeAtHealth, 10);
	assert.equal(pearlHuntDefaults(hunt({ timeoutMs: 60_000 }), { stance: 'cautious', observation: nether }).tool.arguments.fleeAtHealth, undefined);
});

test('time cap: an untimed hunt runs 540 s (under the 600 s provider hold), a timed one keeps its time', () => {
	const { tool, note } = pearlHuntDefaults(hunt(), { stance: 'cautious', observation: nether });
	assert.equal(tool.arguments.timeoutMs, PEARL_HUNT_TIMEOUT_MS);
	assert.ok(PEARL_HUNT_TIMEOUT_MS < 600_000);
	assert.match(note, /timeoutMs 540 s/);
	assert.ok(countSkillDurationMs(tool) >= PEARL_HUNT_TIMEOUT_MS, 'the planner lease covers the whole hunt');
	assert.equal(pearlHuntDefaults(hunt({ timeoutMs: 30_000 }), { stance: 'cautious', observation: nether }).tool.arguments.timeoutMs, 30_000);
});

test('only enderman pearl count fights are touched', () => {
	assert.equal(isPearlHunt(hunt(), []), true);
	assert.equal(isPearlHunt({ actionType: 'fight_until', arguments: { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 7 } }), false);
	const target = (targetId, extra = {}) => ({ actionType: 'fight_target', arguments: { targetId, untilItem: 'minecraft:ender_pearl', untilCount: 4, fleeAtHealth: 14, timeoutMs: 30_000, ...extra } });
	assert.equal(isPearlHunt(target(ENDER), nether.entities), true);
	assert.equal(isPearlHunt(target(BLAZE), nether.entities), false, 'a blaze is not a pearl hunt');
	assert.equal(isPearlHunt({ actionType: 'fight_target', arguments: { targetId: ENDER, fleeAtHealth: 14, timeoutMs: 30_000 } }, nether.entities), false, 'a single fight is not a hunt');
	const blaze = { actionType: 'fight_until', arguments: { mob: 'minecraft:blaze', untilItem: 'minecraft:blaze_rod', untilCount: 7, fleeAtHealth: 14 } };
	assert.equal(pearlHuntDefaults(blaze, { stance: 'cautious', observation: nether }).tool, blaze);
	assert.equal(pearlHuntDefaults(target(ENDER), { stance: 'cautious', observation: nether }).tool.arguments.fleeAtHealth, 10);
	assert.equal(pearlHuntDefaults({ actionType: 'navigate_to', arguments: null }).tool.actionType, 'navigate_to');
});
