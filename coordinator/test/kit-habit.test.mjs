import assert from 'node:assert/strict';
import test from 'node:test';
import { KIT_MAX_STEPS, craftsFromHeld, ironReserved, kitHabitEnabled, nextKitStep } from '../src/kit-habit.mjs';
import { checkedObtainBody, keepKit } from './helpers/checked-body.mjs';

const item = (itemId, slot, count = 1, extra = {}) => ({ itemId: `minecraft:${itemId}`, slot, count, ...extra });
const sample = (items, { health = 20, selectedSlot = 0 } = {}) => ({ player: { health }, inventory: { items, selectedSlot } });
const ironKit = [item('iron_pickaxe', 'mainhand'), item('bucket', 3, 2), item('flint_and_steel', 4), item('crafting_table', 5)];

test('a shield in the main inventory goes to the off hand before anything is crafted', () => {
	assert.deepEqual(nextKitStep(sample([item('shield', 20), item('iron_ingot', 9, 20)])),
		{ kind: 'equip', sourceSlot: 20, targetSlot: 'offhand', itemId: 'minecraft:shield' });
	assert.equal(nextKitStep(sample([item('shield', 'offhand')])), null, 'a shield in the off hand is kept');
});

test('after a respawn with iron and wood back in hand, the body crafts the shield it lost', () => {
	assert.deepEqual(nextKitStep(sample([item('stone_pickaxe', 'mainhand'), item('iron_ingot', 1, 4), item('oak_log', 2, 3), item('crafting_table', 3)])),
		{ kind: 'craft', itemId: 'minecraft:shield' });
	assert.equal(nextKitStep(sample([item('stone_pickaxe', 'mainhand'), item('iron_ingot', 1, 3), item('oak_log', 2, 2)])), null,
		'3 ingots without an iron pickaxe are the pickaxe\'s');
	assert.deepEqual(nextKitStep(sample([item('iron_pickaxe', 'mainhand'), item('iron_ingot', 1, 1), item('oak_log', 2, 3), item('crafting_table', 3)])),
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

test('a pickaxe about to break keeps its replacement\'s iron reserved', () => {
	const worn = item('iron_pickaxe', 'mainhand', 1, { maxDamage: 250, damage: 248 });
	const rest = [item('bucket', 3, 2), item('flint_and_steel', 4), item('crafting_table', 5), item('shield', 'offhand')];
	assert.equal(ironReserved([worn, ...rest]), 3);
	assert.deepEqual(nextKitStep(sample([worn, ...rest, item('iron_ingot', 1, 8)])), { kind: 'craft', itemId: 'minecraft:iron_boots' },
		'8 ingots less 3 for the next pickaxe leave 5: boots, not the chestplate');
	assert.deepEqual(nextKitStep(sample([worn, ...rest, item('iron_ingot', 1, 11)])), { kind: 'craft', itemId: 'minecraft:iron_chestplate' });
	const fresh = { ...worn, damage: 10 };
	assert.deepEqual(nextKitStep(sample([fresh, ...rest, item('iron_ingot', 1, 8)])), { kind: 'craft', itemId: 'minecraft:iron_chestplate' });
	// The shield waits for the pickaxe's 3 ingots too.
	assert.equal(nextKitStep(sample([worn, item('crafting_table', 5), item('oak_planks', 2, 10), item('iron_ingot', 1, 3)])), null);
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
	const body = checkedObtainBody({
		observe: async () => sample(items),
		act: async (type, args) => {
			calls.push([type, args]);
			items = items.map(row => row.slot === args.sourceSlot ? { ...row, slot: args.targetSlot } : row);
			return { state: 'SUCCEEDED' };
		},
	});
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
	items = [item('iron_pickaxe', 'mainhand'), item('iron_ingot', 1, 1), item('oak_log', 2, 3), item('crafting_table', 3)];
	assert.deepEqual(await keepKit(body, async () => ({ state: 'FAILED', reasonCode: 'NO_TABLE_SPOT' })), ['craft shield stopped (NO_TABLE_SPOT)']);
	let stop = false;
	assert.deepEqual(await keepKit(body, async () => { stop = true; return { state: 'FAILED' }; }, { stopped: () => true }), []);
	assert.equal(stop, false, 'a stopped run does nothing');
});

test('a craft that leaves the item missing is not retried in the same run', async () => {
	const items = [item('iron_pickaxe', 'mainhand'), item('iron_ingot', 1, 1), item('oak_log', 2, 3), item('crafting_table', 3)];
	let crafts = 0;
	const done = await keepKit(checkedObtainBody({ observe: async () => sample(items), act: async () => ({ state: 'SUCCEEDED' }) }), async () => { crafts += 1; return { state: 'SUCCEEDED' }; });
	assert.equal(crafts, 1);
	assert.deepEqual(done, ['crafted shield']);
});

test('a kit craft that would need gathering (a table from logs not held, the pickaxe\'s sticks) is not chosen', () => {
	const noTable = [item('iron_pickaxe', 'mainhand'), item('bucket', 3, 2), item('flint_and_steel', 4), item('shield', 'offhand')];
	// Eight spare ingots but no table and no wood: the chestplate's plan would mine a log for the table.
	assert.equal(nextKitStep(sample([...noTable, item('iron_ingot', 1, 8)])), null);
	assert.ok(!craftsFromHeld(sample([...noTable, item('iron_ingot', 1, 8)]), 'minecraft:iron_chestplate'));
	// Four planks are not enough while two are kept for the next pickaxe's sticks; six make the table from what is held.
	assert.equal(nextKitStep(sample([...noTable, item('iron_ingot', 1, 8), item('oak_planks', 2, 4)])), null);
	assert.deepEqual(nextKitStep(sample([...noTable, item('iron_ingot', 1, 8), item('oak_planks', 2, 6)])), { kind: 'craft', itemId: 'minecraft:iron_chestplate' });
	// Six planks and a table, but two planks are the next pickaxe's sticks: the shield would send the body for a log.
	assert.equal(nextKitStep(sample([item('iron_pickaxe', 'mainhand'), item('crafting_table', 3), item('iron_ingot', 1, 1), item('oak_planks', 2, 6)])), null);
	assert.deepEqual(nextKitStep(sample([item('iron_pickaxe', 'mainhand'), item('crafting_table', 3), item('iron_ingot', 1, 1), item('oak_planks', 2, 8)])), { kind: 'craft', itemId: 'minecraft:shield' });
});

test('what the obtain just handed back is never spent on kit', () => {
	const held = [item('iron_pickaxe', 'mainhand'), item('crafting_table', 3), item('oak_planks', 2, 8), item('iron_ingot', 1, 3)];
	assert.deepEqual(nextKitStep(sample(held)), { kind: 'craft', itemId: 'minecraft:shield' });
	// obtain iron_ingot count 3: the shield would hand back 2.
	assert.equal(nextKitStep(sample(held), { reserved: { ids: ['iron_ingot'], count: 3 } }), null);
	assert.deepEqual(nextKitStep(sample([...held.slice(0, 3), item('iron_ingot', 1, 4)]), { reserved: { ids: ['iron_ingot'], count: 3 } }), { kind: 'craft', itemId: 'minecraft:shield' });
	// obtain planks count 8: the shield's planks are those planks.
	assert.equal(nextKitStep(sample(held), { reserved: { ids: ['oak_planks', 'birch_planks'], count: 8 } }), null);
	assert.deepEqual(nextKitStep(sample([...held, item('oak_log', 4, 3)]), { reserved: { ids: ['oak_planks'], count: 8 } }), { kind: 'craft', itemId: 'minecraft:shield' });
});

test('armour and shields in the selected hotbar slot are equipped from that slot', () => {
	assert.deepEqual(nextKitStep(sample([item('iron_boots', 'mainhand')], { selectedSlot: 4 })),
		{ kind: 'equip', sourceSlot: 4, targetSlot: 'feet', itemId: 'minecraft:iron_boots' });
	assert.deepEqual(nextKitStep(sample([item('shield', 'mainhand')], { selectedSlot: 2 })),
		{ kind: 'equip', sourceSlot: 2, targetSlot: 'offhand', itemId: 'minecraft:shield' });
});

test('an off hand holding something else leaves the shield where it is and the rest of the kit goes on', () => {
	const step = nextKitStep(sample([item('torch', 'offhand', 16), item('shield', 20), item('iron_helmet', 12)]));
	assert.deepEqual(step, { kind: 'equip', sourceSlot: 12, targetSlot: 'head', itemId: 'minecraft:iron_helmet' });
	assert.deepEqual(nextKitStep(sample([item('torch', 'offhand', 16), item('shield', 20), item('stone_pickaxe', 0), item('bread', 30, 3)])),
		{ kind: 'hotbar', sourceSlot: 30, hotbarSlot: 8, itemId: 'minecraft:bread' });
	assert.equal(nextKitStep(sample([item('torch', 'offhand', 16), item('shield', 20)])), null);
});

test('keepKit hands back the result of the step that stopped it', async () => {
	const running = { state: 'RUNNING', actionId: 'a-7', recoveryHint: 'replaceAction with actionId a-7' };
	const stop = {};
	const done = await keepKit(checkedObtainBody({ observe: async () => sample([item('shield', 20)]), act: async () => running }), async () => ({ state: 'SUCCEEDED' }), { stop });
	assert.deepEqual(done, ['equip shield stopped (RUNNING)']);
	assert.equal(stop.result, running);
});

test('MINEAGEN_KIT_HABIT=off is the only way to turn it off', () => {
	assert.equal(kitHabitEnabled({}), true);
	assert.equal(kitHabitEnabled({ MINEAGEN_KIT_HABIT: 'off' }), false);
	assert.equal(kitHabitEnabled({ MINEAGEN_KIT_HABIT: 'OFF ' }), false);
	assert.equal(kitHabitEnabled({ MINEAGEN_KIT_HABIT: 'on' }), true);
});

// The route's trip now mines the kit's armour iron too (skill-fits KIT_ARMOUR, 23 in all). With all of it held after the
// trip, the iron beyond the rest of the kit's is exactly the chestplate and the boots, in the habit's own order.
test('the trip\'s armour iron becomes a chestplate and then boots, never the buckets\' iron', () => {
	const tools = [item('stone_pickaxe', 'mainhand'), item('crafting_table', 5), item('oak_planks', 6, 16), item('stick', 7, 4)];
	const after = (extra, ingots) => nextKitStep(sample([...tools, item('shield', 'offhand'), ...extra, item('iron_ingot', 1, ingots)]));
	// 23 held, shield made (22): 10 kept for the iron pickaxe, buckets and lighter, 12 spare.
	assert.deepEqual(after([], 22), { kind: 'craft', itemId: 'minecraft:iron_chestplate' });
	assert.deepEqual(after([item('iron_chestplate', 'chest')], 14), { kind: 'craft', itemId: 'minecraft:iron_boots' });
	assert.equal(after([item('iron_chestplate', 'chest'), item('iron_boots', 'feet')], 10), null, 'the last 10 are the rest of the kit\'s');
});
