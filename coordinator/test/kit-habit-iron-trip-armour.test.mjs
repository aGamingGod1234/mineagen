import assert from 'node:assert/strict';
import test from 'node:test';
import { IRON_KIT_ITEMS, IRON_TOPUP_MS, KIT_CRAFT_TIMEOUT_MS, KIT_SMELT_MS, ironTripArmourEnabled, nextKitStep } from '../src/kit-habit.mjs';
import { checkedObtainBody, keepKit } from './helpers/checked-body.mjs';

process.env.MINEAGEN_NETHER_KIT = 'off';

// kit.ironTripArmour: in 10 fresh games of 27 Nov the model mined the iron itself and called obtain only to craft, the
// trip ended with 0-7 iron left (raw, unsmelted, in 6), and 7 games never wore an iron piece.
const item = (itemId, slot, count = 1, extra = {}) => ({ itemId: `minecraft:${itemId}`, slot, count, ...extra });
const down = (items, { y = 20, skyOpen = false, dimension = 'minecraft:overworld', health = 20 } = {}) =>
	({ player: { health, skyOpen, y }, position: { x: 0, y, z: 0 }, world: { dimension }, inventory: { items, selectedSlot: 0 } });
const stations = [item('crafting_table', 5), item('furnace', 6), item('coal', 7, 8), item('oak_planks', 8, 16)];
const afterPickaxe = [item('iron_pickaxe', 'mainhand'), ...stations];

const withSwitch = async (value, run) => {
	const before = process.env.MINEAGEN_IRON_TRIP_ARMOUR;
	if (value === undefined) delete process.env.MINEAGEN_IRON_TRIP_ARMOUR; else process.env.MINEAGEN_IRON_TRIP_ARMOUR = value;
	try { return await run(); } finally { if (before === undefined) delete process.env.MINEAGEN_IRON_TRIP_ARMOUR; else process.env.MINEAGEN_IRON_TRIP_ARMOUR = before; }
};

test('the Nether trip mines all four pieces and climbs from dry deepslate toward y16', (t) => {
	const prior = process.env.MINEAGEN_NETHER_KIT;
	delete process.env.MINEAGEN_NETHER_KIT;
	t.after(() => { process.env.MINEAGEN_NETHER_KIT = prior; });
	const items = [...afterPickaxe, item('shield', 'offhand'), item('raw_iron', 9, 1)];
	const deep = down(items, { y: -4 });
	assert.equal(nextKitStep(deep, { topUp: true }).kind, 'dig');
	assert.equal(nextKitStep(deep, { topUp: true, triedIronLevel: true }).count, 31);
	deep.blocks = [{ blockId: 'minecraft:deepslate_iron_ore', visible: true }];
	assert.equal(nextKitStep(deep, { topUp: true }).count, 31);
	deep.advancements = ['story/enter_the_nether'];
	assert.equal(nextKitStep(deep, { topUp: true }).count, 24, 'a re-entry uses the existing frame');
});

test('down a mine after an iron kit obtain with no chestplate, the habit mines the chestplate\'s iron with the kit\'s own', () => {
	// Iron pickaxe and shield made, 1 raw iron left: one bucket (3) and flint and steel (1) are still owed, plus 8.
	const step = nextKitStep(down([...afterPickaxe, item('shield', 'offhand'), item('raw_iron', 9, 1)]), { topUp: true });
	assert.deepEqual(step, { kind: 'craft', itemId: 'minecraft:raw_iron', count: 1 + (3 + 1 + 8 - 1), timeoutMs: IRON_TOPUP_MS, topUp: true });
	// With 1 raw iron and no shield, the shield comes first (its iron is the kit's).
	assert.deepEqual(nextKitStep(down([...afterPickaxe, item('raw_iron', 9, 1)]), { topUp: true }), { kind: 'craft', itemId: 'minecraft:shield' });
	// A stone pickaxe mines iron ore too; the iron pickaxe's 3 are then owed as well.
	const stone = nextKitStep(down([item('stone_pickaxe', 'mainhand'), ...stations]), { topUp: true });
	assert.equal(stone.count, 3 + 1 + 3 + 1 + 8);
});

test('no top-up without the runtime\'s go-ahead, on the surface, in the Nether, with a chestplate, without a pickaxe, or hurt', () => {
	const held = [...afterPickaxe, item('shield', 'offhand'), item('raw_iron', 9, 1)];
	assert.equal(nextKitStep(down(held)), null, 'topUp is the runtime\'s (an iron kit obtain, spaced out)');
	assert.equal(nextKitStep(down(held, { skyOpen: true }), { topUp: true }), null, 'under the sky');
	assert.equal(nextKitStep(down(held, { y: 64 }), { topUp: true }), null, 'not down a mine');
	assert.equal(nextKitStep(down(held, { dimension: 'minecraft:the_nether' }), { topUp: true }), null);
	assert.equal(nextKitStep(down([...held, item('copper_chestplate', 'chest')]), { topUp: true }), null, 'any chestplate worn');
	assert.equal(nextKitStep(down([...held, item('iron_chestplate', 12)]), { topUp: true })?.kind, 'equip', 'a carried one is put on instead');
	assert.equal(nextKitStep(down([item('wooden_pickaxe', 'mainhand'), ...stations]), { topUp: true }), null, 'a wooden pickaxe cannot mine iron');
	assert.equal(nextKitStep(down(held, { health: 9 }), { topUp: true }), null);
});

test('raw iron counts for the chestplate, and its craft gets the furnace time it smelts', () => {
	const kit = [item('iron_pickaxe', 'mainhand'), item('bucket', 3), item('flint_and_steel', 4), item('shield', 'offhand'), ...stations];
	// The kit made: 8 raw iron beyond the second bucket's 3 make a chestplate, all 8 smelted first.
	assert.deepEqual(nextKitStep(down([...kit, item('raw_iron', 9, 8)])), { kind: 'craft', itemId: 'minecraft:iron_chestplate', timeoutMs: KIT_CRAFT_TIMEOUT_MS + 8 * KIT_SMELT_MS });
	// 5 ingots and 3 raw: 3 smelts.
	assert.deepEqual(nextKitStep(down([...kit, item('iron_ingot', 9, 5), item('raw_iron', 10, 3)])), { kind: 'craft', itemId: 'minecraft:iron_chestplate', timeoutMs: KIT_CRAFT_TIMEOUT_MS + 3 * KIT_SMELT_MS });
	// Ingots alone craft as before.
	assert.deepEqual(nextKitStep(down([...kit, item('iron_ingot', 9, 8)])), { kind: 'craft', itemId: 'minecraft:iron_chestplate' });
	// obtain raw_iron 8 hands back its 8: they are kept.
	assert.equal(nextKitStep(down([...kit, item('raw_iron', 9, 8)]), { reserved: { ids: ['raw_iron'], count: 8 } }), null);
});

test('MINEAGEN_IRON_TRIP_ARMOUR=off: no top-up, raw iron is not counted, the step cap is the old one', async () => {
	assert.equal(ironTripArmourEnabled({}), true);
	assert.equal(ironTripArmourEnabled({ MINEAGEN_IRON_TRIP_ARMOUR: 'off' }), false);
	await withSwitch('off', () => {
		assert.equal(nextKitStep(down([...afterPickaxe, item('raw_iron', 9, 1)]), { topUp: true }), null);
		const kit = [item('iron_pickaxe', 'mainhand'), item('bucket', 3), item('flint_and_steel', 4), item('shield', 'offhand'), ...stations];
		assert.equal(nextKitStep(down([...kit, item('raw_iron', 9, 8)])), null);
	});
});

test('keepKit: top-up, chestplate, wear it; the top-up runs once and tells the runtime', async () => {
	let items = [...afterPickaxe, item('shield', 'offhand'), item('raw_iron', 9, 1)];
	const crafts = [];
	let topUps = 0;
	const body = checkedObtainBody({
		observe: async () => down(items),
		act: async (type, args) => { items = items.map(row => row.slot === args.sourceSlot ? { ...row, slot: args.targetSlot } : row); return { state: 'SUCCEEDED' }; },
	});
	const craft = async (itemId, count, timeoutMs) => {
		crafts.push([itemId.replace('minecraft:', ''), count, timeoutMs]);
		if (itemId === 'minecraft:raw_iron') items = items.map(row => row.itemId === 'minecraft:raw_iron' ? { ...row, count } : row);
		else { items = items.map(row => row.itemId === 'minecraft:raw_iron' ? { ...row, count: row.count - 8 } : row); items.push(item('iron_chestplate', 20)); }
		return { state: 'SUCCEEDED' };
	};
	const done = await keepKit(body, craft, { topUp: true, onTopUp: () => { topUps += 1; } });
	// The shield is held, so 3 (a bucket) + 1 (flint and steel) + 8 - 1 held = 11 more: 12 raw iron in all.
	assert.deepEqual(done, ['mined 12 raw_iron for the iron_chestplate', 'crafted iron_chestplate', 'wore iron_chestplate (chest)']);
	assert.deepEqual(crafts, [['raw_iron', 12, IRON_TOPUP_MS], ['iron_chestplate', 1, KIT_CRAFT_TIMEOUT_MS + 8 * KIT_SMELT_MS]]);
	assert.equal(topUps, 1);
	assert.ok(items.some(row => row.itemId === 'minecraft:iron_chestplate' && row.slot === 'chest'));
	assert.equal(items.find(row => row.itemId === 'minecraft:raw_iron').count, 4, 'the kit\'s 4 are left for the bucket and the lighter');
});

test('a top-up that runs dry ends the kit run and hands its code back; it is not retried in the same run', async () => {
	const items = [...afterPickaxe, item('shield', 'offhand')];
	let calls = 0;
	const stop = {};
	const done = await keepKit(checkedObtainBody({ observe: async () => down(items), act: async () => ({ state: 'SUCCEEDED' }) }),
		async () => { calls += 1; return { state: 'TIMED_OUT', reasonCode: 'OBTAIN_TIMEOUT' }; }, { topUp: true, stop });
	assert.deepEqual(done, ['mining the iron_chestplate\'s iron stopped (OBTAIN_TIMEOUT)']);
	assert.equal(calls, 1);
	assert.equal(stop.result.reasonCode, 'OBTAIN_TIMEOUT');
});

test('only the iron kit\'s obtains open a top-up', () => {
	for (const id of ['iron_pickaxe', 'minecraft:iron_ingot', 'raw_iron', 'bucket', 'water_bucket', 'shield', 'flint_and_steel']) assert.ok(IRON_KIT_ITEMS.test(id), id);
	for (const id of ['cooked_beef', 'stone_pickaxe', 'obsidian', 'iron_chestplate', 'coal']) assert.ok(!IRON_KIT_ITEMS.test(id), id);
});

test('v2: the chestplate\'s iron held with no fuel: its obtain gathers the fuel, as a top-up, down a mine only', () => {
	// A/B game freshd1 (fix arm) ended with 10 raw iron, a table and a furnace and nothing to burn.
	const noFuel = [item('iron_pickaxe', 'mainhand'), item('bucket', 3, 2), item('flint_and_steel', 4), item('shield', 'offhand'),
		item('crafting_table', 5), item('furnace', 6), item('raw_iron', 9, 10)];
	assert.deepEqual(nextKitStep(down(noFuel), { topUp: true }), { kind: 'craft', itemId: 'minecraft:iron_chestplate', timeoutMs: IRON_TOPUP_MS + 8 * KIT_SMELT_MS, topUp: true });
	assert.equal(nextKitStep(down(noFuel)), null, 'not without the runtime\'s go-ahead');
	assert.equal(nextKitStep(down(noFuel, { skyOpen: true }), { topUp: true }), null, 'not on the surface');
});

test('v2: with no chestplate, leggings wait for it; boots do not', () => {
	const kit = [item('iron_pickaxe', 'mainhand'), item('bucket', 3, 2), item('flint_and_steel', 4), item('shield', 'offhand'), ...stations];
	// A/B game freshrb (fix arm): 7 spare became leggings and the chestplate never came.
	assert.deepEqual(nextKitStep(down([...kit, item('iron_ingot', 9, 7)])), { kind: 'craft', itemId: 'minecraft:iron_boots' });
	assert.deepEqual(nextKitStep(down([...kit, item('iron_chestplate', 'chest'), item('iron_ingot', 9, 7)])), { kind: 'craft', itemId: 'minecraft:iron_leggings' });
});

test('keepKit v2: a top-up whose raw iron has no fuel to smelt goes on to the chestplate\'s own obtain in the same run', async () => {
	let items = [item('iron_pickaxe', 'mainhand'), item('bucket', 3, 2), item('flint_and_steel', 4), item('shield', 'offhand'), item('crafting_table', 5), item('furnace', 6), item('raw_iron', 9, 3)];
	const crafts = [];
	let topUps = 0;
	const body = checkedObtainBody({ observe: async () => down(items),
		act: async (type, args) => { items = items.map(row => row.slot === args.sourceSlot ? { ...row, slot: args.targetSlot } : row); return { state: 'SUCCEEDED' }; } });
	const craft = async (itemId, count, timeoutMs) => {
		crafts.push([itemId.replace('minecraft:', ''), count, timeoutMs]);
		if (itemId === 'minecraft:raw_iron') items = items.map(row => row.itemId === 'minecraft:raw_iron' ? { ...row, count } : row);
		else { items = items.map(row => row.itemId === 'minecraft:raw_iron' ? { ...row, count: row.count - 8 } : row); items.push(item('iron_chestplate', 20)); }
		return { state: 'SUCCEEDED' };
	};
	const done = await keepKit(body, craft, { topUp: true, onTopUp: () => { topUps += 1; } });
	assert.deepEqual(done, ['mined 8 raw_iron for the iron_chestplate', 'crafted iron_chestplate', 'wore iron_chestplate (chest)']);
	assert.deepEqual(crafts.map(row => row[0]), ['raw_iron', 'iron_chestplate']);
	assert.equal(crafts[1][2], IRON_TOPUP_MS + 8 * KIT_SMELT_MS, 'the chestplate\'s obtain has the time to find fuel');
	assert.equal(topUps, 1, 'one top-up for the spacing');
});

test('with ingots reserved, the chestplate\'s raw iron is smelted as its own step first, so the reserved ingots stay', () => {
	const kit = [item('iron_pickaxe', 'mainhand'), item('bucket', 3), item('flint_and_steel', 4), item('shield', 'offhand'), ...stations];
	const reserved = { ids: ['minecraft:iron_ingot'], count: 3 };
	// obtain iron_ingot 3 handed back its 3, and 8 raw make the chestplate: smelt to 3 + 8 first.
	assert.deepEqual(nextKitStep(down([...kit, item('iron_ingot', 9, 3), item('raw_iron', 10, 8)]), { reserved }),
		{ kind: 'craft', itemId: 'minecraft:iron_ingot', count: 11, timeoutMs: KIT_CRAFT_TIMEOUT_MS + 8 * KIT_SMELT_MS, smelt: true });
	// Smelted: the chestplate crafts from ingots alone, with 3 left over.
	assert.deepEqual(nextKitStep(down([...kit, item('iron_ingot', 9, 11)]), { reserved }), { kind: 'craft', itemId: 'minecraft:iron_chestplate' });
	// Raw iron beyond the reserved count is armour iron (a raw-iron top-up after obtain raw_iron 8); the craft smelts
	// only the 8 it lacks, so the reserved 8 stay.
	assert.deepEqual(nextKitStep(down([...kit, item('raw_iron', 10, 16)]), { reserved: { ids: ['minecraft:raw_iron'], count: 8 } }),
		{ kind: 'craft', itemId: 'minecraft:iron_chestplate', timeoutMs: KIT_CRAFT_TIMEOUT_MS + 8 * KIT_SMELT_MS });
	// A shield from raw iron with ingots reserved smelts its one first too.
	assert.deepEqual(nextKitStep(down([item('iron_pickaxe', 'mainhand'), ...stations, item('iron_ingot', 9, 3), item('raw_iron', 10, 1)]), { reserved }),
		{ kind: 'craft', itemId: 'minecraft:iron_ingot', count: 4, timeoutMs: KIT_CRAFT_TIMEOUT_MS + KIT_SMELT_MS, smelt: true });
	assert.deepEqual(nextKitStep(down([item('iron_pickaxe', 'mainhand'), ...stations, item('iron_ingot', 9, 4)]), { reserved }), { kind: 'craft', itemId: 'minecraft:shield' });
});

test('after an obtain of something a smelt could burn (coal, planks), raw iron is not armour iron, so that fuel stays', () => {
	const kit = [item('iron_pickaxe', 'mainhand'), item('bucket', 3), item('flint_and_steel', 4), item('shield', 'offhand'), ...stations];
	assert.equal(nextKitStep(down([...kit, item('raw_iron', 9, 8)]), { reserved: { ids: ['minecraft:coal'], count: 8 } }), null);
	assert.equal(nextKitStep(down([...kit, item('raw_iron', 9, 8)]), { reserved: { ids: ['minecraft:oak_planks'], count: 16 } }), null);
	// Ingots alone still craft, as before the switch.
	assert.deepEqual(nextKitStep(down([...kit, item('iron_ingot', 9, 8)]), { reserved: { ids: ['minecraft:coal'], count: 8 } }), { kind: 'craft', itemId: 'minecraft:iron_chestplate' });
	// And no top-up or fuel gather opens after one.
	assert.equal(nextKitStep(down([...afterPickaxe, item('shield', 'offhand'), item('raw_iron', 9, 1)]), { topUp: true, reserved: { ids: ['minecraft:coal'], count: 8 } }), null);
});

test('keepKit with reserved ingots: smelt, then chestplate, then wear it', async () => {
	const kit = [item('iron_pickaxe', 'mainhand'), item('bucket', 3), item('flint_and_steel', 4), item('shield', 'offhand'), ...stations];
	let items = [...kit, item('iron_ingot', 9, 3), item('raw_iron', 10, 8)];
	const calls = [];
	const body = { observe: async () => down(items), act: async (_type, a) => {
		items = items.map(row => row.slot === a.sourceSlot ? { ...row, slot: a.targetSlot } : row);
		return { state: 'SUCCEEDED' };
	} };
	const craft = async (itemId, count) => {
		calls.push([itemId, count]);
		if (itemId === 'minecraft:iron_ingot') items = [...items.filter(row => !/iron_ingot|raw_iron/.test(row.itemId)), item('iron_ingot', 9, count)];
		if (itemId === 'minecraft:iron_chestplate') items = [...items.map(row => row.itemId === 'minecraft:iron_ingot' ? { ...row, count: row.count - 8 } : row), item('iron_chestplate', 12)];
		return { state: 'SUCCEEDED' };
	};
	const done = await keepKit(body, craft, { reserved: { ids: ['minecraft:iron_ingot'], count: 3 } });
	assert.deepEqual(calls, [['minecraft:iron_ingot', 11], ['minecraft:iron_chestplate', 1]]);
	assert.deepEqual(done, ['smelted iron_ingot to 11', 'crafted iron_chestplate', 'wore iron_chestplate (chest)']);
	assert.equal(items.find(row => row.itemId === 'minecraft:iron_ingot').count, 3, 'the 3 asked for are still held');
});

test('keepKit with reserved ingots smelts twice in one run: the shield\'s ingot, then the chestplate\'s', async () => {
	let items = [item('iron_pickaxe', 'mainhand'), item('bucket', 3), item('flint_and_steel', 4), ...stations, item('iron_ingot', 9, 3), item('raw_iron', 10, 12)];
	const calls = [];
	const take = (id, n) => { items = items.map(row => row.itemId === id ? { ...row, count: row.count - n } : row).filter(row => row.count > 0); };
	const body = { observe: async () => down(items), act: async (_type, a) => {
		items = items.map(row => row.slot === a.sourceSlot ? { ...row, slot: a.targetSlot } : row);
		return { state: 'SUCCEEDED' };
	} };
	const craft = async (itemId, count) => {
		calls.push([itemId, count]);
		if (itemId === 'minecraft:iron_ingot') { const have = items.find(row => row.itemId === 'minecraft:iron_ingot').count; take('minecraft:raw_iron', count - have); take('minecraft:iron_ingot', -(count - have)); }
		if (itemId === 'minecraft:shield') { take('minecraft:iron_ingot', 1); items.push(item('shield', 13)); }
		if (itemId === 'minecraft:iron_chestplate') { take('minecraft:iron_ingot', 8); items.push(item('iron_chestplate', 12)); }
		return { state: 'SUCCEEDED' };
	};
	const done = await keepKit(body, craft, { reserved: { ids: ['minecraft:iron_ingot'], count: 3 } });
	assert.deepEqual(calls.map(([id]) => id.replace('minecraft:', '')), ['iron_ingot', 'shield', 'iron_ingot', 'iron_chestplate']);
	assert.ok(done.includes('wore iron_chestplate (chest)'), done.join(', '));
	assert.equal(items.find(row => row.itemId === 'minecraft:iron_ingot').count, 3, 'the 3 asked for are still held');
});
