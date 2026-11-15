import assert from 'node:assert/strict';
import test from 'node:test';

import { repairActionArguments } from '../src/action-argument-repairs.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';

test('dig_to reads "staircase" as stairs_down and a numeric heading as a yaw, and says so', () => {
	// the recorded Oct 29 game: Sol sent pattern "staircase" and heading 180 twice each, and lost a turn to every rejection.
	const repaired = repairActionArguments('dig_to', { pattern: 'staircase', y: 16, heading: 180 });
	assert.equal(repaired.arguments.pattern, 'stairs_down');
	assert.equal(repaired.arguments.heading, 'north');
	assert.match(repaired.adjusted.pattern, /asked staircase/);
	assert.match(repaired.adjusted.heading, /asked 180, read as a yaw/);
	assert.deepEqual([0, 90, -90, 270, -180, 44].map((heading) => repairActionArguments('dig_to', { y: 0, heading }).arguments.heading),
		['south', 'west', 'east', 'east', 'north', 'south']);
	const untouched = { pattern: 'steep_down', y: 0, heading: 'east' };
	assert.equal(repairActionArguments('dig_to', untouched).arguments, untouched, 'valid arguments pass unchanged');
	assert.equal(repairActionArguments('dig_to', { pattern: 'spiral', y: 0 }).arguments.pattern, 'spiral', 'other unknown patterns still fail validation');
});

test('the act path applies the dig_to repair before validation', () => {
	const call = normalizeMinecraftToolCall('act', { actionType: 'dig_to', arguments: { pattern: 'staircase', y: 16, heading: 180, timeoutMs: 60_000 } });
	const args = call.tool?.arguments ?? call.arguments?.arguments ?? call.arguments;
	assert.equal(args.pattern, 'stairs_down', JSON.stringify(call).slice(0, 300));
	assert.equal(args.heading, 'north');
});
