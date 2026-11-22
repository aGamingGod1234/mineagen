import assert from 'node:assert/strict';
import test from 'node:test';
import { kitMinutes, kitStatTotal, routeToolTimeout } from '../../scripts/quality/lib/iron-kit-route.mjs';
import { callObtain } from '../../scripts/quality/obtain-handbacks.mjs';

test('an interrupted iron search gets only the time left after the hand-back', async () => {
	let now = 0;
	const timeouts = [];
	await callObtain({
		mode: 'answer', started: 0, budgetMs: 1_500_000, now: () => now,
		execute: async (attempt, left) => {
			timeouts.push(routeToolTimeout('obtain', left));
			now += timeouts.at(-1);
			return { state: attempt === 0 ? 'INTERRUPTED' : 'SUCCEEDED' };
		},
		alive: async () => true,
		answer: async () => { now += 20_000; },
	});
	assert.deepEqual(timeouts, [1_200_000, 280_000]);
	assert.equal(routeToolTimeout('obtain', 59_999), null);
	assert.equal(routeToolTimeout('obtain', 60_000), 60_000);
	assert.equal(routeToolTimeout('find_animal', 10_000), 10_000);
	assert.equal(routeToolTimeout('equip_shield', 0), null);
});

test('even a full iron kit is unscored when first seen after the room deadline', () => {
	const observation = { inventory: { items: [
		{ itemId: 'minecraft:iron_pickaxe', count: 1 },
		{ itemId: 'minecraft:shield', count: 1 },
		{ itemId: 'minecraft:bucket', count: 2 },
		{ itemId: 'minecraft:flint_and_steel', count: 1 },
	] } };
	assert.equal(kitMinutes(observation, 1_500_000, 1_500_000), 25);
	assert.equal(kitMinutes(observation, 1_500_001, 1_500_000), null);
	assert.equal(kitMinutes(null, 1_499_999, 1_500_000), null);
});

test('only an explicitly unset mining counter counts as zero', async () => {
	const objectives = ['km0', 'km1'];
	const total = (secondReply) => kitStatTotal(async (command) => {
		if (command.endsWith('km0')) return 'Kit0 has 12 [km0]';
		if (secondReply instanceof Error) throw secondReply;
		return secondReply;
	}, 'Kit0', objectives);
	assert.equal(await total("Can't get value of km1 for Kit0; none is set"), 12);
	assert.equal(await total('Kit0 has 4 [km1]'), 16);
	for (const unreadable of ["Can't get value", 'Kit0 has 4 [other]', 'unparsed reply', new Error('RCON disconnected')]) {
		assert.equal(await total(unreadable), null);
	}
});
