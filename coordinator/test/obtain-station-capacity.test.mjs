import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedObtainBody, runObtain } from './helpers/checked-body.mjs';

// G2 receipt :485 broke the table after a replacement craft filled its old slot.
// This body models that capacity boundary, not Minecraft pickup geometry.
for (const scenario of ['junk', 'two junk', 'no junk', 'rejected drop', 'danger', 'room', 'stack']) {
	test(`station cleanup preserves crafting access with ${scenario}`, async () => {
		const station = { kind: 'crafting_table', x: -461, y: -23, z: -94, dimension: 'minecraft:overworld' };
		const placed = [station];
		const items = Array.from({ length: scenario === 'room' ? 35 : 36 }, (_, slot) => ({
			itemId: slot === 0 ? 'minecraft:stone_pickaxe' : slot === 1 && ['junk', 'two junk', 'rejected drop', 'danger'].includes(scenario)
				? 'minecraft:granite' : slot === 1 && scenario === 'stack' ? 'minecraft:crafting_table' : slot === 2 && scenario === 'two junk' ? 'minecraft:diorite' : 'minecraft:diamond',
			slot: slot === 0 ? 'mainhand' : slot, count: 1,
		}));
		let broken = false, danger = false;
		const calls = [];
		const body = checkedObtainBody({
			observe: async () => ({ player: { x: -460.5, y: -23, z: -93.5, health: 20, onFire: danger },
				world: { dimension: station.dimension }, inventory: { selectedSlot: 0, items: structuredClone(items) },
				blocks: broken ? [] : [{ ...station, blockId: 'minecraft:crafting_table' }], items: [] }),
			stopped: () => false, interrupted: () => false, note: () => {},
			act: async (type, args) => {
				calls.push({ type, args });
				if (type === 'drop_item') {
					if (scenario === 'rejected drop') return { state: 'FAILED', reasonCode: 'DROP_FAILED' };
					items.splice(items.findIndex((row) => row.slot === args.slot), 1);
					if (scenario === 'danger') danger = true;
				}
				if (type === 'break_block') {
					broken = true;
					assert.ok(items.length < 36 || items.some((row) => row.itemId === 'minecraft:crafting_table'), 'station drop must fit');
					const stack = items.find((row) => row.itemId === 'minecraft:crafting_table');
					if (stack) stack.count++;
					else items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
				}
				return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
			},
		});
		const result = await runObtain({ item: 'stone_pickaxe' }, body, { placed, now: () => 0 });
		if (['junk', 'two junk', 'room', 'stack'].includes(scenario)) {
			assert.equal(result.reasonCode, 'OBTAINED');
			assert.equal(placed.length, 0);
			assert.ok(items.some((row) => row.itemId === 'minecraft:crafting_table'));
			assert.equal(calls.filter((c) => c.type === 'drop_item').length, ['junk', 'two junk'].includes(scenario) ? 1 : 0);
		} else {
			assert.equal(broken, false);
			assert.equal(placed.length, 1, 'retain placed station ledger');
			assert.equal(result.reasonCode, scenario === 'danger' ? 'DANGER' : 'OBTAINED');
			if (scenario === 'danger') assert.equal(calls.at(-1).type, 'drop_item');
		}
		assert.equal(calls.some((c) => ['travel_to', 'dig_to', 'craft_table', 'craft_inventory'].includes(c.type)), false);
	});
}


for (const stale of [false, true]) test(`station cleanup retains its ledger with ${stale ? 'remembered' : 'missing'} inventory`, async () => {
 const placed = [{kind:'crafting_table',x:0,y:64,z:0,dimension:'minecraft:overworld'}];
 const items = Array.from({length:36},(_,slot)=>({itemId:slot===0?'minecraft:stone_pickaxe':'minecraft:granite',slot,count:1}));
 let samples = 0, actions = 0;
 const body = checkedObtainBody({observe:async()=>{samples++;return {player:{x:0.5,y:64,z:0.5,health:20},world:{dimension:'minecraft:overworld'},
  inventory:samples===1||stale?{items}:{},...(stale&&samples>1?{continuity:{rememberedSections:['inventory']}}:{}),blocks:[],items:[]};},
  stopped:()=>false,interrupted:()=>false,note:()=>{},act:async()=>{actions++;return {state:'FAILED',reasonCode:'UNEXPECTED_ACTION'};}});
 await runObtain({item:'stone_pickaxe'},body,{placed,now:()=>0});
 assert.equal(actions,0,'unknown capacity permits neither discard nor dismantling');
 assert.equal(placed.length,1);
});

for (const firstPickup of ['collected', 'blocked', 'unconfirmed']) test(`station pickup after junk recollection is ${firstPickup}`, async () => {
	const station = { kind: 'crafting_table', x: 0, y: 64, z: 1, dimension: 'minecraft:overworld' };
	const placed = [station];
	const junk = { itemId: 'minecraft:dirt', slot: 1, count: 1 };
	const items = Array.from({ length: 36 }, (_, slot) => slot === 1 ? structuredClone(junk)
		: { itemId: slot === 0 ? 'minecraft:stone_pickaxe' : 'minecraft:diamond', slot, count: 1 });
	let broken = false, allowPickup = firstPickup === 'collected';
	const calls = [];
	const body = checkedObtainBody({
		observe: async () => ({ player: { x: 0.5, y: 64, z: 0.5, health: 20, skyOpen: true },
			world: { dimension: station.dimension }, inventory: { selectedSlot: 0, items: structuredClone(items) },
			blocks: broken ? [] : [{ ...station, blockId: 'minecraft:crafting_table' }],
			items: broken && !items.some((row) => row.itemId === 'minecraft:crafting_table') ? [
				{ stableId: '00000000-0000-4000-8000-00000000d127', itemId: 'minecraft:dirt', x: 0.5, y: 64, z: 1.5 },
				{ stableId: '00000000-0000-4000-8000-0000000057a7', itemId: 'minecraft:crafting_table', x: 0.5, y: 64, z: 1.5 },
			] : [] }),
		stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type, args) => {
			calls.push({ type, args });
			if (type === 'drop_item') items.splice(items.findIndex((row) => row.slot === args.slot), 1);
			if (type === 'break_block') { broken = true; items.push(structuredClone(junk)); }
			if (type === 'pick_up_item') {
				assert.equal(args.targetSelector, '00000000-0000-4000-8000-0000000057a7', 'do not collect discarded junk');
				assert.equal(items.length, 35, 'reclaim room after the long break');
				if (allowPickup) items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
				else if (firstPickup === 'blocked') return { state: 'FAILED', reasonCode: 'PATH_BLOCKED' };
			}
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
	});
	const result = await runObtain({ item: 'stone_pickaxe' }, body, { placed, now: () => 0 });
	assert.equal(calls.filter((call) => call.type === 'drop_item').length, 2);
	assert.equal(calls.filter((call) => call.type === 'break_block').length, 1);
	if (allowPickup) assert.equal(placed.length, 0);
	else {
		assert.equal(placed.length, 1);
		assert.equal(placed[0].drop, true);
		assert.equal(result.stations.pending[0].state, 'dropped');
		assert.match(result.message, /workstation recovery incomplete: crafting_table drop at 0,64,1/);
		allowPickup = true;
		await runObtain({ item: 'stone_pickaxe' }, body, { placed, now: () => 0 });
		assert.equal(calls.filter((call) => call.type === 'break_block').length, 1, 'resume the drop, never re-break an air cell');
		assert.equal(placed.length, 0);
	}
});

for (const change of ['spare used', 'different table acquired']) test(`resumed station pickup uses current inventory after ${change}`, async () => {
	const station = { kind: 'crafting_table', x: 0, y: 64, z: 1, dimension: 'minecraft:overworld' };
	const placed = [station], calls = [];
	const items = [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1 }];
	if (change === 'spare used') items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
	let broken = false, collected = false, allowPickup = false;
	const body = checkedObtainBody({
		observe: async () => ({ player: { x: 0.5, y: 64, z: 0.5, health: 20, skyOpen: true },
			world: { dimension: station.dimension }, inventory: { selectedSlot: 0, items: structuredClone(items) },
			blocks: broken ? [] : [{ ...station, blockId: 'minecraft:crafting_table' }],
			items: broken && !collected ? [{ stableId: '00000000-0000-4000-8000-0000000057a7', itemId: 'minecraft:crafting_table', x: 0.5, y: 64, z: 1.5 }] : [] }),
		stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type, args) => {
			calls.push({ type, args });
			if (type === 'break_block') broken = true;
			if (type === 'pick_up_item') {
				if (!allowPickup) return { state: 'FAILED', reasonCode: 'PATH_BLOCKED' };
				collected = true;
				items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
			}
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
	});
	await runObtain({ item: 'stone_pickaxe' }, body, { placed, now: () => 0 });
	assert.equal(placed.length, 1);
	assert.equal(placed[0].drop, true);
	if (change === 'spare used') { items.splice(1, 1); allowPickup = true; }
	else items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
	const result = await runObtain({ item: 'stone_pickaxe' }, body, { placed, now: () => 0 });
	assert.equal(calls.filter((call) => call.type === 'break_block').length, 1);
	assert.equal(collected, change === 'spare used');
	assert.equal(placed.length, change === 'spare used' ? 0 : 1);
	if (!collected) {
		assert.equal(result.stations.pending[0].state, 'dropped');
		assert.match(result.message, /workstation recovery incomplete/);
	} else assert.equal(items.filter((row) => row.itemId === 'minecraft:crafting_table').reduce((sum, row) => sum + row.count, 0), 1);
});

test('chain gates: a furnace drop not picked up still leaves the crafting table to fetch', async () => {
	// Main left the table behind after every missed furnace drop; underground, with the pickaxe worn, no new one could be made.
	const furnace = { kind: 'furnace', x: 0, y: 64, z: 2, dimension: 'minecraft:overworld', drop: true };
	const table = { kind: 'crafting_table', x: 0, y: 64, z: 1, dimension: 'minecraft:overworld' };
	const placed = [furnace, table];
	const items = [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1 }];
	let broken = false;
	const body = checkedObtainBody({
		observe: async () => ({ player: { x: 0.5, y: 64, z: 0.5, health: 20, skyOpen: true }, world: { dimension: table.dimension },
			inventory: { selectedSlot: 0, items: structuredClone(items) }, blocks: broken ? [] : [{ ...table, blockId: 'minecraft:crafting_table' }], items: [] }),
		stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type) => {
			if (type === 'break_block') { broken = true; items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 }); }
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
	});
	await runObtain({ item: 'stone_pickaxe' }, body, { placed, now: () => 0 });
	const on = process.env.MINEAGEN_OBTAIN_NEXT_STATION !== 'off';
	assert.equal(items.some((row) => row.itemId === 'minecraft:crafting_table'), on);
	assert.deepEqual(placed.map((station) => station.kind), on ? ['furnace'] : ['furnace', 'crafting_table'], 'the missed furnace drop stays in the ledger');
});

test('chain gates: a missed furnace drop that comes in with the table\'s sweep leaves the ledger', async () => {
	const furnace = { kind: 'furnace', x: 0, y: 64, z: 2, dimension: 'minecraft:overworld', drop: true };
	const table = { kind: 'crafting_table', x: 0, y: 64, z: 1, dimension: 'minecraft:overworld' };
	const placed = [furnace, table];
	const items = [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1 }];
	let broken = false, sweeps = 0;
	const body = checkedObtainBody({
		observe: async () => ({ player: { x: 0.5, y: 64, z: 0.5, health: 20, skyOpen: true }, world: { dimension: table.dimension },
			inventory: { selectedSlot: 0, items: structuredClone(items) }, blocks: broken ? [] : [{ ...table, blockId: 'minecraft:crafting_table' }],
			items: broken && !items.some((row) => row.itemId === 'minecraft:furnace') ? [{ stableId: '00000000-0000-4000-8000-00000000f0f0', itemId: 'minecraft:furnace', x: 0.5, y: 64, z: 2.5 }] : [] }),
		stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type) => {
			if (type === 'break_block') { broken = true; items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 }); }
			// The table's sweep picks up the furnace lying next to it.
			if (type === 'pick_up_item' && broken && ++sweeps >= 1) items.push({ itemId: 'minecraft:furnace', slot: 2, count: 1 });
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
	});
	await runObtain({ item: 'stone_pickaxe' }, body, { placed, now: () => 0 });
	if (process.env.MINEAGEN_OBTAIN_NEXT_STATION === 'off') return;
	assert.ok(items.some((row) => row.itemId === 'minecraft:furnace'));
	assert.deepEqual(placed, [], 'the furnace picked up with the table is no longer a drop to fetch');
});

test('station cleanup never breaks a station on a sample that is not ready', async () => {
	const table = { kind: 'crafting_table', x: 0, y: 64, z: 1, dimension: 'minecraft:overworld' };
	const placed = [table];
	let samples = 0, broken = false;
	const body = checkedObtainBody({
		// A not-ready sample carries an empty inventory list: unknown room, not 36 free slots.
		observe: async () => (++samples === 1 ? { ready: true, player: { x: 0.5, y: 64, z: 0.5, health: 20, skyOpen: true }, world: { dimension: table.dimension },
			inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', slot: 0, count: 1 }] }, blocks: [{ ...table, blockId: 'minecraft:crafting_table' }], items: [] }
			: { ready: false, player: { x: 0.5, y: 64, z: 0.5, health: 20, skyOpen: true }, world: { dimension: table.dimension }, inventory: { items: [] },
				blocks: [{ ...table, blockId: 'minecraft:crafting_table' }], items: [] }),
		stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type) => { if (type === 'break_block') broken = true; return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' }; },
	});
	await runObtain({ item: 'stone_pickaxe' }, body, { placed, now: () => 0 });
	assert.equal(broken, false);
	assert.equal(placed.length, 1);
});
