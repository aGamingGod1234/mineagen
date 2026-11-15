import test from 'node:test';
import assert from 'node:assert/strict';
import { runObtain } from '../src/obtain-runner.mjs';

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
		const body = {
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
		};
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
 const body = {observe:async()=>{samples++;return {player:{x:0.5,y:64,z:0.5,health:20},world:{dimension:'minecraft:overworld'},
  inventory:samples===1||stale?{items}:{},...(stale&&samples>1?{continuity:{rememberedSections:['inventory']}}:{}),blocks:[],items:[]};},
  stopped:()=>false,interrupted:()=>false,note:()=>{},act:async()=>{actions++;return {state:'FAILED',reasonCode:'UNEXPECTED_ACTION'};}};
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
	const body = {
		observe: async () => ({ player: { x: 0.5, y: 64, z: 0.5, health: 20, skyOpen: true },
			world: { dimension: station.dimension }, inventory: { selectedSlot: 0, items: structuredClone(items) },
			blocks: broken ? [] : [{ ...station, blockId: 'minecraft:crafting_table' }],
			items: broken && !items.some((row) => row.itemId === 'minecraft:crafting_table') ? [
				{ stableId: 'discarded-dirt', itemId: 'minecraft:dirt', x: 0.5, y: 64, z: 1.5 },
				{ stableId: 'station-drop', itemId: 'minecraft:crafting_table', x: 0.5, y: 64, z: 1.5 },
			] : [] }),
		stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type, args) => {
			calls.push({ type, args });
			if (type === 'drop_item') items.splice(items.findIndex((row) => row.slot === args.slot), 1);
			if (type === 'break_block') { broken = true; items.push(structuredClone(junk)); }
			if (type === 'pick_up_item') {
				assert.equal(args.targetSelector, 'station-drop', 'do not collect discarded junk');
				assert.equal(items.length, 35, 'reclaim room after the long break');
				if (allowPickup) items.push({ itemId: 'minecraft:crafting_table', slot: 1, count: 1 });
				else if (firstPickup === 'blocked') return { state: 'FAILED', reasonCode: 'PATH_BLOCKED' };
			}
			return { state: 'SUCCEEDED', reasonCode: 'ACTION_COMPLETED' };
		},
	};
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
	const body = {
		observe: async () => ({ player: { x: 0.5, y: 64, z: 0.5, health: 20, skyOpen: true },
			world: { dimension: station.dimension }, inventory: { selectedSlot: 0, items: structuredClone(items) },
			blocks: broken ? [] : [{ ...station, blockId: 'minecraft:crafting_table' }],
			items: broken && !collected ? [{ stableId: 'station-drop', itemId: 'minecraft:crafting_table', x: 0.5, y: 64, z: 1.5 }] : [] }),
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
	};
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
