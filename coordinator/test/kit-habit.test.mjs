import assert from 'node:assert/strict';
import test from 'node:test';
import { KIT_MAX_STEPS, ironReserved, keepKit, kitHabitEnabled, nextKitStep } from '../src/kit-habit.mjs';

const item = (itemId, slot, count = 1, extra = {}) => ({ itemId: `minecraft:${itemId}`, slot, count, ...extra });
const sample = (items, { health = 20, selectedSlot = 0 } = {}) => ({ player: { health }, inventory: { items, selectedSlot } });
const ironKit = [item('iron_pickaxe', 'mainhand'), item('bucket', 3, 2), item('flint_and_steel', 4)];

test('a shield in the main inventory goes to the off hand before anything is crafted', () => {
	assert.deepEqual(nextKitStep(sample([item('shield', 20), item('iron_ingot', 9, 20)])),
		{ kind: 'equip', sourceSlot: 20, targetSlot: 'offhand', itemId: 'minecraft:shield' });
	assert.equal(nextKitStep(sample([item('shield', 'offhand')])), null, 'a shield in the off hand is kept');
});

test('after a respawn with iron and wood back in hand, the body crafts the shield it lost', () => {
	assert.deepEqual(nextKitStep(sample([item('stone_pickaxe', 'mainhand'), item('iron_ingot', 1, 4), item('oak_log', 2, 2)])),
		{ kind: 'craft', itemId: 'minecraft:shield' });
	assert.equal(nextKitStep(sample([item('stone_pickaxe', 'mainhand'), item('iron_ingot', 1, 3), item('oak_log', 2, 2)])), null,
		'3 ingots without an iron pickaxe are the pickaxe\'s');
	assert.deepEqual(nextKitStep(sample([item('iron_pickaxe', 'mainhand'), item('iron_ingot', 1, 1), item('oak_log', 2, 2)])),
		{ kind: 'craft', itemId: 'minecraft:shield' });
	assert.equal(nextKitStep(sample([item('iron_ingot', 1, 3), item('oak_planks', 2, 5)])), null, '5 planks are not enough for a shield');
	assert.equal(nextKitStep(sample([item('oak_log', 2, 4)])), null, 'no iron, no shield craft (no mining for it)');
});

test('armour comes only from iron the route does not still need', () => {
	assert.equal(ironReserved([item('stone_pickaxe', 'mainhand')]), 3 + 1 + 6 + 1);
	assert.equal(ironReserved([...ironKit, item('shield', 'offhand')]), 0);
	// 11 ingots before the iron pickaxe, shield, buckets and flint and steel: all of it is spoken for.
	assert.equal(nextKitStep(sample([item('stone_pickaxe', 'mainhand'), item('shield', 'offhand'), item('iron_ingot', 1, 10)])), null);
	assert.deepEqual(nextKitStep(sample([...ironKit, item('shield', 'offhand'), item('iron_ingot', 1, 8)])), { kind: 'craft', itemId: 'minecraft:iron_chestplate' });
	assert.deepEqual(nextKitStep(sample([...ironKit, item('shield', 'offhand'), item('iron_chestplate', 'chest'), item('iron_ingot', 1, 7)])),
		{ kind: 'craft', itemId: 'minecraft:iron_leggings' }, 'then the piece with the most armour per iron that fits');
	assert.deepEqual(nextKitStep(sample([...ironKit, item('shield', 'offhand'), item('iron_chestplate', 'chest'), item('iron_ingot', 1, 4)])),
		{ kind: 'craft', itemId: 'minecraft:iron_boots' });
});

test('held armour is worn, and a worn piece of any metal is left alone', () => {
	assert.deepEqual(nextKitStep(sample([item('shield', 'offhand'), item('golden_helmet', 12)])),
		{ kind: 'equip', sourceSlot: 12, targetSlot: 'head', itemId: 'minecraft:golden_helmet' });
	assert.equal(nextKitStep(sample([...ironKit, item('shield', 'offhand'), item('golden_chestplate', 'chest'), item('iron_ingot', 1, 3)])), null,
		'gold worn for piglins is not replaced');
});

test('food only in the main inventory moves to a free hotbar slot, not the selected one', () => {
	const step = nextKitStep(sample([item('shield', 'offhand'), item('stone_pickaxe', 8), item('cooked_beef', 30, 5)], { selectedSlot: 7 }));
	assert.deepEqual(step, { kind: 'hotbar', sourceSlot: 30, hotbarSlot: 6, itemId: 'minecraft:cooked_beef' });
	assert.equal(nextKitStep(sample([item('shield', 'offhand'), item('bread', 2, 3), item('cooked_beef', 30, 5)])), null, 'food already in reach');
});

test('the habit waits while the body is hurt or the sample has no inventory', () => {
	assert.equal(nextKitStep(sample([item('shield', 20)], { health: 9 })), null);
	assert.equal(nextKitStep({ player: { health: 20 } }), null);
	assert.equal(nextKitStep(null), null);
});

test('keepKit crafts, then wears, then stops; a failed step ends it; it never runs past its cap', async () => {
	let items = [...ironKit, item('iron_ingot', 1, 9), item('oak_planks', 2, 8)];
	const calls = [];
	const body = {
		observe: async () => sample(items),
		act: async (type, args) => {
			calls.push([type, args]);
			items = items.map(row => row.slot === args.sourceSlot ? { ...row, slot: args.targetSlot } : row);
			return { state: 'SUCCEEDED' };
		},
	};
	const craft = async (itemId) => {
		calls.push(['craft', itemId]);
		const name = itemId.slice('minecraft:'.length);
		items = items.map(row => row.itemId === 'minecraft:iron_ingot' ? { ...row, count: row.count - (name === 'shield' ? 1 : 8) } : row);
		items.push(item(name, 20 + calls.length));
		return { state: 'SUCCEEDED' };
	};
	const done = await keepKit(body, craft);
	assert.deepEqual(done, ['crafted shield', 'wore shield (offhand)', 'crafted iron_chestplate', 'wore iron_chestplate (chest)']);
	assert.ok(calls.length <= KIT_MAX_STEPS);
	items = [item('iron_pickaxe', 'mainhand'), item('iron_ingot', 1, 1), item('oak_log', 2, 2)];
	assert.deepEqual(await keepKit(body, async () => ({ state: 'FAILED', reasonCode: 'NO_TABLE_SPOT' })), ['craft shield stopped (NO_TABLE_SPOT)']);
	let stop = false;
	assert.deepEqual(await keepKit(body, async () => { stop = true; return { state: 'FAILED' }; }, { stopped: () => true }), []);
	assert.equal(stop, false, 'a stopped run does nothing');
});

test('a craft that leaves the item missing is not retried in the same run', async () => {
	const items = [item('iron_pickaxe', 'mainhand'), item('iron_ingot', 1, 1), item('oak_log', 2, 2)];
	let crafts = 0;
	const done = await keepKit({ observe: async () => sample(items), act: async () => ({ state: 'SUCCEEDED' }) }, async () => { crafts += 1; return { state: 'SUCCEEDED' }; });
	assert.equal(crafts, 1);
	assert.deepEqual(done, ['crafted shield']);
});

test('MINEAGEN_KIT_HABIT=off is the only way to turn it off', () => {
	assert.equal(kitHabitEnabled({}), true);
	assert.equal(kitHabitEnabled({ MINEAGEN_KIT_HABIT: 'off' }), false);
	assert.equal(kitHabitEnabled({ MINEAGEN_KIT_HABIT: 'OFF ' }), false);
	assert.equal(kitHabitEnabled({ MINEAGEN_KIT_HABIT: 'on' }), true);
});
