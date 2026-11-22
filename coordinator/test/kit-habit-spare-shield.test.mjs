import assert from 'node:assert/strict';
import test from 'node:test';
import { nextKitStep } from '../src/kit-habit.mjs';

// COMBAT-2: the shield after a death, after it breaks, and a spare before the Nether. Decisions only (nextKitStep is
// pure: it reads one observation and names one step).

const body = (items, { dimension = 'minecraft:overworld', health = 20 } = {}) => ({ world: { dimension }, player: { health },
	inventory: { selectedSlot: 0, items: items.map(([id, count, slot]) => ({ itemId: `minecraft:${id}`, count, slot })) } });
const WOOD = [['oak_planks', 12, 11], ['crafting_table', 1, 12]];
// The route's kit done: iron pickaxe, 2 buckets, flint and steel, one shield in the off hand.
const KIT = [['iron_pickaxe', 1, 'mainhand'], ['bucket', 2, 13], ['flint_and_steel', 1, 14], ['shield', 1, 'offhand']];
const WORN = [['iron_chestplate', 1, 'chest'], ['iron_boots', 1, 'feet']];
const SPARE = { kind: 'craft', itemId: 'minecraft:shield', count: 2 };

test('a spare shield is made from iron left once the chestplate and boots are on, in the Overworld only', () => {
	assert.deepEqual(nextKitStep(body([...KIT, ...WORN, ['iron_ingot', 1, 10], ...WOOD])), SPARE);
	// In the Nether the spare waits: the shield in hand is what blocks there, and iron is for the trip home.
	assert.equal(nextKitStep(body([...KIT, ...WORN, ['iron_ingot', 1, 10], ...WOOD], { dimension: 'minecraft:the_nether' })), null);
	// Two shields held: no third.
	assert.equal(nextKitStep(body([...KIT, ['shield', 1, 15], ...WORN, ['iron_ingot', 3, 10], ...WOOD])), null);
	// The route's armour not on yet: its iron is not spent on a spare (the chestplate and boots come first).
	assert.equal(nextKitStep(body([...KIT, ['iron_ingot', 3, 10], ...WOOD])), null);
	assert.equal(nextKitStep(body([...KIT, WORN[0], ['iron_ingot', 3, 10], ...WOOD])), null);
	// No iron beyond the kit's own: no spare (a missing bucket keeps its 3).
	assert.equal(nextKitStep(body([['iron_pickaxe', 1, 'mainhand'], ['bucket', 1, 13], ['flint_and_steel', 1, 14], ['shield', 1, 'offhand'], ...WORN, ['iron_ingot', 3, 10], ...WOOD])), null);
	// No wood for its planks: nothing gathered for it.
	assert.equal(nextKitStep(body([...KIT, ...WORN, ['iron_ingot', 1, 10], ['crafting_table', 1, 12]])), null);
});

test('a shield that broke in the Nether is replaced from the pack, then from held iron', () => {
	const noShield = KIT.filter(([id]) => id !== 'shield');
	// The spare in the pack goes to the off hand first (free).
	assert.deepEqual(nextKitStep(body([...noShield, ...WORN, ['shield', 1, 15]], { dimension: 'minecraft:the_nether' })),
		{ kind: 'equip', sourceSlot: 15, targetSlot: 'offhand', itemId: 'minecraft:shield' });
	// No spare: a new one from one held ingot, in any dimension.
	assert.deepEqual(nextKitStep(body([...noShield, ...WORN, ['iron_ingot', 1, 10], ...WOOD], { dimension: 'minecraft:the_nether' })),
		{ kind: 'craft', itemId: 'minecraft:shield' });
});

test('after a death the iron pickaxe still comes first: 1 iron and a stone pickaxe make no shield', () => {
	assert.equal(nextKitStep(body([['stone_pickaxe', 1, 'mainhand'], ['iron_ingot', 1, 10], ...WOOD])), null);
	assert.equal(nextKitStep(body([['stone_pickaxe', 1, 'mainhand'], ['iron_ingot', 3, 10], ...WOOD])), null);
	assert.deepEqual(nextKitStep(body([['stone_pickaxe', 1, 'mainhand'], ['iron_ingot', 4, 10], ...WOOD])), { kind: 'craft', itemId: 'minecraft:shield' });
	assert.deepEqual(nextKitStep(body([['iron_pickaxe', 1, 'mainhand'], ['iron_ingot', 1, 10], ...WOOD])), { kind: 'craft', itemId: 'minecraft:shield' });
});
