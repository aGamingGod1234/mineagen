import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedObtainBody, runObtain } from './helpers/checked-body.mjs';

// stock.foodFloor: a pack full of stone left food, log and mob drops on the ground (g1 of 25 Nov hit INVENTORY_FULL 18
// times in its last 154 minutes). A gather that is not stone drops junk stacks first, so its drops have room.

function fullPack() {
	return Array.from({ length: 36 }, (_, slot) => ({ itemId: slot === 0 ? 'minecraft:iron_sword' : slot < 4 ? 'minecraft:cobblestone' : slot < 20 ? 'minecraft:granite' : 'minecraft:diorite',
		slot: slot === 0 ? 'mainhand' : slot, count: slot === 0 ? 1 : 64 }));
}

async function hunt(environment) {
	const before = process.env.MINEAGEN_FOOD_FLOOR;
	if (environment === undefined) delete process.env.MINEAGEN_FOOD_FLOOR; else process.env.MINEAGEN_FOOD_FLOOR = environment;
	try {
		const items = fullPack();
		const calls = [];
		const body = checkedObtainBody({
			observe: async () => ({ ready: true, player: { x: 0.5, y: 64, z: 0.5, health: 20, foodLevel: 20, skyOpen: true, onGround: true }, position: { x: 0.5, y: 64, z: 0.5 },
				world: { dimension: 'minecraft:overworld' }, inventory: { selectedSlot: 0, items: structuredClone(items) }, blocks: [], items: [], entities: [] }),
			stopped: () => false, interrupted: () => false, note: () => {},
			act: async (type, args) => {
				calls.push({ type, args });
				if (type === 'drop_item') { items.splice(items.findIndex((row) => row.slot === args.slot), 1); return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' }; }
				return { state: 'FAILED', reasonCode: 'NO_ROUTE' };
			},
		});
		await runObtain({ item: 'beef', count: 4 }, body, { now: () => 0 });
		return { calls, items };
	} finally {
		if (before === undefined) delete process.env.MINEAGEN_FOOD_FLOOR; else process.env.MINEAGEN_FOOD_FLOOR = before;
	}
}

test('a hunt with a pack full of stone drops junk stacks before it starts, keeping some cobblestone', async () => {
	const { calls, items } = await hunt(undefined);
	const drops = calls.filter((call) => call.type === 'drop_item');
	assert.ok(drops.length >= 1 && drops.length <= 2, JSON.stringify(calls.slice(0, 4)));
	assert.equal(calls[0].type, 'drop_item');
	assert.ok(items.filter((row) => row.itemId === 'minecraft:cobblestone').reduce((n, row) => n + row.count, 0) >= 16);
	assert.ok(items.some((row) => row.itemId === 'minecraft:iron_sword'));
});

test('the off arm hunts with the full pack as before', async () => {
	const { calls } = await hunt('off');
	assert.equal(calls.some((call) => call.type === 'drop_item'), false);
});
