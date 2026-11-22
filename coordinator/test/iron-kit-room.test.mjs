import assert from 'node:assert/strict';
import test from 'node:test';
import { kitMinutes, kitStatTotal, portalReady, routeCall, routeToolTimeout } from '../../scripts/quality/lib/iron-kit-route.mjs';
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

test('the stand-in wears what a route line names, in the slot it names', () => {
	assert.deepEqual(routeCall('usual next step: equip_item shield to offhand (shield carried)'), { kind: 'equip', item: 'shield', slot: 'offhand' });
	assert.deepEqual(routeCall('usual next step: equip_item iron_chestplate to chest (iron_chestplate carried, not worn)'), { kind: 'equip', item: 'iron_chestplate', slot: 'chest' });
	assert.deepEqual(routeCall('usual next step: obtain iron_boots, then equip_item it to feet (iron 0 held, kit made; iron_boots takes 4, no feet armour worn)'),
		{ kind: 'obtain', item: 'iron_boots', count: null, then: { equip: 'feet' } });
	assert.deepEqual(routeCall('usual next step: obtain shield, then equip_item it to offhand (iron 1 held)'), { kind: 'obtain', item: 'shield', count: null, then: { equip: 'offhand' } });
	assert.equal(routeCall('usual next step: obtain iron_pickaxe (iron 3 held)').then, null);
});

test('portal-ready is the kit held with the route on its portal row', () => {
	const kit = { inventory: { items: [
		{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:shield', count: 1 },
		{ itemId: 'minecraft:bucket', count: 2 }, { itemId: 'minecraft:flint_and_steel', count: 1 },
	] } };
	const portal = 'usual next step: obtain water_bucket, then find block minecraft:lava and build nether_portal beside it (plain blocks 30/13, lava pools seen 0)';
	assert.equal(portalReady(kit, portal), true);
	// With a bed in view the portal row names the bed step instead of the build.
	assert.equal(portalReady(kit, 'usual next step: before lighting the portal, break_block the white_bed at 3,64,1, then carry it to the portal (bed in view)'), true);
	assert.equal(portalReady(kit, 'usual next step: obtain iron_chestplate, then equip_item it to chest (iron 0 held, kit made)'), false);
	assert.equal(portalReady({ inventory: { items: kit.inventory.items.slice(1) } }, portal), false);
});
