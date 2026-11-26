import test from 'node:test';
import assert from 'node:assert/strict';
import { openOrder } from '../src/live-task-view.mjs';

// The eyes-to-dragon plan from a 26 Nov chain game: the eyes fell below 12, so the lava-depth, pearl, rod and eye steps
// reopened ahead of the stronghold.
const plan = { steps: [
	{ id: 'depth', check: 'y<=-45', dependsOn: ['iron'] },
	{ id: 'pearls', check: 'has:minecraft:ender_pearl|minecraft:ender_eye*12', dependsOn: ['iron'] },
	{ id: 'gold', check: 'has:minecraft:golden_helmet*1', dependsOn: [] },
	{ id: 'blaze', check: 'has:minecraft:blaze_rod*6', dependsOn: ['cover'] },
	{ id: 'eyes', check: 'has:minecraft:ender_eye*12', dependsOn: ['pearls', 'blaze'] },
	{ id: 'stronghold', check: 'seen:minecraft:stronghold', dependsOn: ['eyes'] },
	{ id: 'end', check: 'in:minecraft:the_end', dependsOn: ['stronghold'] },
	{ id: 'dragon', check: 'killed:minecraft:ender_dragon', dependsOn: ['end'] },
] };
// Open as planProgress leaves it with the eyes short: the stronghold waits on them, so it is not open.
const open = ['depth', 'pearls', 'gold'];
const at = items => ({ world: { dimension: 'minecraft:overworld' }, inventory: { items } });

test('an eye in hand puts the stronghold and End steps ahead of lost Nether prep; none, or the off switch, keeps plan order', () => {
	assert.deepEqual(openOrder(plan, { open }, at([{ itemId: 'minecraft:ender_eye', count: 10 }])).slice(0, 3), ['stronghold', 'depth', 'pearls']);
	// A stale sample has no inventory: the last live inventory stands in.
	assert.equal(openOrder(plan, { open }, { ready: false }, null, [{ itemId: 'minecraft:ender_eye', count: 10 }])[0], 'stronghold');
	assert.deepEqual(openOrder(plan, { open }, at([{ itemId: 'minecraft:ender_pearl', count: 10 }])), open);
	process.env.MINEAGEN_EYES_HOLD = '0';
	try { assert.deepEqual(openOrder(plan, { open }, at([{ itemId: 'minecraft:ender_eye', count: 10 }])), open); } finally { delete process.env.MINEAGEN_EYES_HOLD; }
	// Stronghold seen: the End step leads.
	const seen = { steps: plan.steps.map(s => s.id === 'stronghold' ? { ...s, status: 'complete' } : s) };
	assert.equal(openOrder(seen, { open: ['end', ...open] }, at([{ itemId: 'minecraft:ender_eye', count: 10 }]))[0], 'end');
});
