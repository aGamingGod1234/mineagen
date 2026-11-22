import test from 'node:test';
import assert from 'node:assert/strict';
import { planObtain } from '../src/obtain-plan.mjs';
import { chestYield, lootSources, structureTables, lootYields } from '../src/loot-sources.mjs';
import { lootChest } from '../src/loot-step.mjs';
import { runObtain } from '../src/obtain-runner.mjs';

const at = { x: 311.5, y: 77, z: -241.5 };
const village = (x = 311, z = -239) => ({ player: { ...at }, world: { dimension: 'minecraft:overworld' }, sighted: { structures: [{ structure: 'village', size: 10, x, y: 78, z }] }, blocks: [] });
const held = new Map([['stone_pickaxe', 1], ['oak_log', 4]]);
const kinds = (plan) => plan.needs.map((need) => `${need.kind}:${need.accept[0]}`);

test('chest yields come from the game\'s loot tables: a toolsmith chest holds iron, a village chest on average a little', () => {
	const yields = lootYields();
	assert.ok(yields['chests/village/village_toolsmith'].iron_ingot > 1);
	const tables = structureTables('village');
	assert.ok(tables.length >= 15 && tables.every((name) => name.startsWith('chests/village/')));
	const iron = chestYield(tables, 'iron_ingot');
	assert.ok(iron > 0.1 && iron < 1, String(iron));
	assert.deepEqual(structureTables('bastion remnant'), [], 'a chest behind a fight the planner does not price is no source');
	assert.deepEqual(structureTables('shipwreck'), ['chests/shipwreck_map', 'chests/shipwreck_supply', 'chests/shipwreck_treasure']);
});

test('iron from a village standing in it beats digging for unseen ore; with no village the plan mines as before', () => {
	assert.deepEqual(kinds(planObtain({ ids: ['iron_ingot'], count: 3 }, { held })).slice(0, 1), ['mine:raw_iron']);
	const plan = planObtain({ ids: ['iron_ingot'], count: 3 }, { held, loot: lootSources(village()) });
	assert.deepEqual(kinds(plan), ['loot:iron_ingot']);
	assert.equal(plan.needs[0].sources[0].kind, 'structure');
});

test('a chest in view inside the village is the first source', () => {
	const o = { ...village(), blocks: [{ blockId: 'minecraft:chest', x: 300, y: 78, z: -230 }] };
	const plan = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held, loot: lootSources(o) });
	const loot = plan.needs.find((need) => need.kind === 'loot');
	assert.ok(loot, JSON.stringify(plan.needs));
	assert.equal(loot.sources[0].kind, 'chest');
	assert.deepEqual([loot.sources[0].x, loot.sources[0].z], [300, -230]);
});

test('cost decides, not the place: seen ore or a far village still mines, a near shipwreck loots', () => {
	assert.deepEqual(kinds(planObtain({ ids: ['iron_ingot'], count: 3 }, { held, seen: new Set(['iron_ore']), loot: lootSources(village()) }))[0], 'mine:raw_iron');
	assert.deepEqual(kinds(planObtain({ ids: ['iron_ingot'], count: 3 }, { held, loot: lootSources(village(311, -39)) }))[0], 'mine:raw_iron');
	const wreck = { ...village(), sighted: { structures: [{ structure: 'shipwreck', x: 320, y: 62, z: -241 }] } };
	assert.deepEqual(kinds(planObtain({ ids: ['iron_ingot'], count: 3 }, { held, loot: lootSources(wreck) })), ['loot:iron_ingot']);
});

test('opened chests and searched structures stop being sources; a chest outside any structure is not loot', () => {
	const o = { ...village(), blocks: [{ blockId: 'minecraft:chest', x: 300, y: 78, z: -230 }] };
	assert.deepEqual(lootSources(o, { opened: new Set(['300,78,-230']), searched: new Set(['311,78,-239']) }), []);
	const lone = { player: { ...at }, world: { dimension: 'minecraft:overworld' }, blocks: [{ blockId: 'minecraft:chest', x: 300, y: 78, z: -230 }] };
	assert.deepEqual(lootSources(lone), []);
	const shared = { ...village(), seenResources: [{ id: 'minecraft:chest', kind: 'container', x: 305, y: 78, z: -235, opened: true }, { id: 'minecraft:barrel', kind: 'container', x: 306, y: 78, z: -235, opened: false }] };
	assert.deepEqual(lootSources(shared).filter((row) => row.kind === 'chest').map((row) => row.x), [306], 'the shared seen-resource rows carry opened');
	const remembered = { player: { ...at }, world: { dimension: 'minecraft:overworld' }, blocks: [] };
	assert.equal(lootSources(remembered, { structures: [{ structure: 'village', x: 311, y: 78, z: -239, dimension: 'minecraft:overworld' }] })[0]?.kind, 'structure');
});

test('a seen iron golem is a way only with iron armour and an iron weapon', () => {
	const seen = new Set(['iron_golem']);
	assert.equal(kinds(planObtain({ ids: ['iron_ingot'], count: 3 }, { held, seen })).some((row) => row.startsWith('kill')), false);
	assert.equal(kinds(planObtain({ ids: ['iron_ingot'], count: 3 }, { held, seen, gear: { armor: 6, weapon: 4 } })).some((row) => row.startsWith('kill')), false);
	assert.deepEqual(kinds(planObtain({ ids: ['iron_ingot'], count: 3 }, { held, seen, gear: { armor: 15, weapon: 4 } })), ['kill:iron_ingot']);
	assert.equal(kinds(planObtain({ ids: ['iron_ingot'], count: 3 }, { held, gear: { armor: 15, weapon: 4 } })).some((row) => row.startsWith('kill')), false, 'only a golem in view');
});

function chestBody(contents) {
	const slots = contents.map(([itemId, count], slot) => ({ slot, itemId: `minecraft:${itemId}`, count, fingerprint: `fp-${slot}` }));
	const inv = new Map();
	const calls = [];
	let open = false, stateId = 1;
	return {
		calls, inv,
		menu: async () => (open ? { menu: { type: 'minecraft:generic_9x3', containerId: 3, stateId, slotCount: 63 }, entries: { $rows: { columns: ['slot', 'itemId', 'count', 'fingerprint'], rows: slots.filter((row) => row.count > 0).map((row) => [row.slot, row.itemId, row.count, row.fingerprint]) } } }
			: { menu: { type: 'minecraft:inventory', containerId: 0, stateId, slotCount: 46 }, entries: [] }),
		act: async (type, args) => {
			calls.push([type, args]);
			if (type === 'interact_block') { open = true; return { state: 'SUCCEEDED' }; }
			if (type === 'menu_click') {
				const row = slots.find((s) => s.slot === args.slot);
				assert.equal(args.stateId, stateId); assert.equal(args.expectedItemId, row.itemId); assert.equal(args.expectedCount, row.count);
				inv.set(row.itemId.slice(10), (inv.get(row.itemId.slice(10)) ?? 0) + row.count); row.count = 0; stateId++;
				return { state: 'SUCCEEDED', reasonCode: 'MENU_INPUT_APPLIED' };
			}
			if (type === 'menu_close') { open = false; return { state: 'SUCCEEDED' }; }
			if (type === 'travel_to') return { state: 'SUCCEEDED' };
			return { state: 'FAILED', reasonCode: 'UNSIMULATED' };
		},
	};
}

test('the loot step takes what the plan needs and what a player keeps, leaves the rest, closes the chest', async () => {
	const body = chestBody([['iron_ingot', 3], ['wheat_seeds', 5], ['bread', 2], ['dandelion', 1], ['iron_pickaxe', 1]]);
	const result = await lootChest(body, { x: 1, y: 64, z: 2 }, { wanted: ['iron_ingot'] });
	assert.equal(result.ok, true, result.why);
	assert.deepEqual(result.taken, { iron_ingot: 3, bread: 2, iron_pickaxe: 1 });
	assert.equal(body.calls.at(-1)[0], 'menu_close');
});

test('obtain iron_ingot in a village loots its chests before any search for ore', async () => {
	const chest = { blockId: 'minecraft:chest', x: 305, y: 77, z: -236 };
	const body = chestBody([['iron_ingot', 4], ['bread', 3]]);
	const observe = async () => ({ ...village(), player: { ...at, health: 20, onGround: true, skyOpen: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }, ...[...body.inv].map(([id, count], i) => ({ itemId: `minecraft:${id}`, count, slot: i + 1 }))] },
		blocks: [chest], entities: [] });
	const searches = [];
	const looted = { opened: [], searched: [], structures: [] };
	const result = await runObtain({ item: 'iron_ingot', count: 3 }, { ...body, observe, stopped: () => false, interrupted: () => false, note: () => {},
		search: async (target) => { searches.push(target); return { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND' }; } },
	{ now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.equal(result.state, 'SUCCEEDED', JSON.stringify(result));
	assert.deepEqual(searches, []);
	assert.deepEqual(looted.opened, ['305,77,-236']);
	assert.equal(body.inv.get('bread'), 3, 'food comes along');
	assert.equal(looted.structures[0].structure, 'village');
});

test('a village chest that lacks the item is opened once, then the plan goes back to mining', async () => {
	const chest = { blockId: 'minecraft:chest', x: 305, y: 77, z: -236 };
	const body = chestBody([['wheat', 4]]);
	const observe = async () => ({ ...village(), player: { ...at, health: 20, onGround: true, skyOpen: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }] }, blocks: [chest], entities: [] });
	const searches = [];
	const looted = { opened: [], searched: [], structures: [] };
	const result = await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 60_000 }, { ...body, observe, stopped: () => false, interrupted: () => false, note: () => {},
		gather: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), mine: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), moveTo: async () => ({ state: 'SUCCEEDED' }),
		search: async (target) => { searches.push(target); return { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }; } },
	{ now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.notEqual(result.state, 'SUCCEEDED');
	assert.deepEqual(looted.opened, ['305,77,-236']);
	assert.ok(searches.some((target) => target.block === 'minecraft:chest'), 'looks for the village\'s other chests');
	assert.deepEqual(looted.searched, ['311,78,-239']);
	assert.ok(searches.some((target) => /iron_ore/.test(target.block ?? '')), `then mines: ${JSON.stringify(searches)}`);
});
