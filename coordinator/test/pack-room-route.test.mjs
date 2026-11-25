import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE_BYTES, routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';

// Room in the pack (skill-fits.mjs packRoom): a nearly full pack drops clutter before the next step, so drops (food above
// all) can be picked up. The inventory is the one g1 of the 25 Nov fresh games carried at minute 340, 36 of 36 slots.
const G1 = [['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 64], ['cobblestone', 38],
	['andesite', 62], ['granite', 37], ['cinnabar', 29], ['dirt', 25], ['lapis_lazuli', 23], ['raw_copper', 14], ['stick', 11], ['coal', 9], ['spruce_log', 8],
	['stone_pickaxe', 1], ['stone_pickaxe', 1], ['stone_pickaxe', 1], ['stone_pickaxe', 1], ['stone_pickaxe', 1], ['stone_pickaxe', 1], ['stone_pickaxe', 1],
	['clay_ball', 4], ['spruce_planks', 3], ['stone_shovel', 1], ['stone_sword', 1], ['wooden_pickaxe', 1], ['furnace', 1], ['arrow', 1], ['crafting_table', 1],
	['raw_iron', 1], ['flint', 1], ['iron_pickaxe', 1], ['flint_and_steel', 1]];
const sample = rows => ({ ready: true, observedAtEpochMs: 10, world: { worldId: 'w', dimension: 'minecraft:overworld' }, position: { x: 0, y: 64, z: 0 },
	player: { health: 20, foodLevel: 6 }, inventory: { items: rows.map(([id, count], slot) => ({ itemId: `minecraft:${id}`, count, slot })) }, entities: [], blocks: [] });
const route = rows => routeLine({ observation: sample(rows), known: emptyKnown(), evaluate: evaluatePlanCheck });

test('a full pack drops clutter first, never the kit, the fuel or the block stock', () => {
	const line = route(G1);
	assert.match(line, /^usual next step: drop_item slot:\d+ count:\d+(, then drop_item slot:\d+ count:\d+){2} \(pack 36\/36, a full pack loses drops; spare cinnabar, lapis_lazuli, raw_copper\)$/);
	const slots = [...line.matchAll(/slot:(\d+)/g)].map(m => G1[Number(m[1])][0]);
	assert.deepEqual(slots, ['cinnabar', 'lapis_lazuli', 'raw_copper']);
	assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES);
	// Once the clutter is gone: the odd stone and dirt, then cobblestone past 128, then the lower pickaxes past two spares.
	const kept = G1.map(([id, count]) => ['cinnabar', 'lapis_lazuli', 'raw_copper', 'clay_ball'].includes(id) ? ['air', 0] : [id, count]).filter(([, c]) => c > 0);
	const second = [...route([...kept, ['oak_sapling', 1], ['bread', 2], ['white_carpet', 1], ['gravel', 1]]).matchAll(/slot:(\d+)/g)].map(m => Number(m[1]));
	assert.ok(second.length > 0);
	for (const slot of second) assert.doesNotMatch([...kept, ['oak_sapling', 1], ['bread', 2], ['white_carpet', 1], ['gravel', 1]][slot][0], /iron_pickaxe|flint_and_steel|furnace|coal|bread|crafting_table|raw_iron/);
});

test('room to spare, or nothing that is clutter: the route goes on as before', () => {
	assert.doesNotMatch(route(G1.slice(0, 33)), /drop_item/);
	const kit = Array.from({ length: 36 }, (_, i) => [['iron_pickaxe', 'shield', 'bucket', 'flint_and_steel', 'cooked_beef', 'iron_ingot', 'coal', 'oak_log', 'torch'][i % 9], 1]);
	assert.doesNotMatch(route(kit), /drop_item/);
});

test('blocks past the stock go, odd kinds and dirt first, and the stock itself stays', () => {
	const rows = [...Array.from({ length: 30 }, () => ['cobblestone', 64]), ['dirt', 64], ['andesite', 64], ['iron_pickaxe', 1], ['bread', 8], ['shield', 1], ['furnace', 1]];
	const line = route(rows);
	const ids = [...line.matchAll(/slot:(\d+)/g)].map(m => rows[Number(m[1])][0]);
	assert.deepEqual(ids.slice(0, 2), ['dirt', 'andesite']);
	assert.equal(ids.length, 3);
});
