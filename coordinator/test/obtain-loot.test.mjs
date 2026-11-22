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
	assert.ok(searches.some((target) => target.block === 'minecraft:oak_door'), 'looks for the village\'s other houses');
	assert.equal(searches.some((target) => target.block === 'minecraft:chest'), false, 'no chest search in a village: its chests are indoors');
	assert.deepEqual(looted.searched, ['311,78,-239']);
	assert.ok(searches.some((target) => /iron_ore/.test(target.block ?? '')), `then mines: ${JSON.stringify(searches)}`);
});

// The 22 Nov playtest: a stone pickaxe at the village, an iron ore known at y14 about 68 blocks off and 60 down.
test('the playtest: a village chest near spawn comes before an iron ore 60 blocks down; an exposed ore 10 down an open cave still wins', async () => {
	const { seenPlaces } = await import('../src/obtain-runner.mjs');
	const start = { ...village(), player: { x: 311.5, y: 77, z: -241.5 } };
	const deep = { ...start, landmarks: [{ blockId: 'minecraft:iron_ore', x: 298, y: 14, z: -261 }] };
	const plan = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held, seen: new Set(['iron_ore']), places: seenPlaces(deep), loot: lootSources(deep) });
	assert.equal(plan.needs[0].kind, 'loot', JSON.stringify(plan.needs));
	const cave = { ...start, landmarks: [{ blockId: 'minecraft:iron_ore', x: 315, y: 67, z: -244, count: 4 }] };
	const near = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held, seen: new Set(['iron_ore']), places: seenPlaces(cave), loot: lootSources(cave) });
	assert.equal(near.needs.some((need) => need.kind === 'loot'), false, JSON.stringify(near.needs));
	assert.equal(near.needs[0].accept[0], 'raw_iron');
});

test('a seen source is priced by the way to it: near logs keep their discount, ore far below is no cheaper than unseen', async () => {
	const { approachCost } = await import('../src/obtain-plan.mjs');
	assert.ok(approachCost({ distance: 5, across: 5, drop: 0 }) < 0.5);
	assert.ok(approachCost({ distance: 63, across: 24, drop: 63 }) > 5);
	assert.ok(approachCost({ distance: 20, across: 10, drop: 17, enclosed: true }) === 17 * 0.4);
	const places = new Map([['iron_ore', [{ distance: 68, across: 24, drop: 63, count: 1 }]]]);
	const far = planObtain({ ids: ['raw_iron'], count: 1 }, { held, seen: new Set(['iron_ore']), places });
	const none = planObtain({ ids: ['raw_iron'], count: 1 }, { held, seen: new Set() });
	assert.deepEqual(far.needs, none.needs);
});

test('a stop in the middle of taking still closes the chest; a chest never read is not counted as opened', async () => {
	const body = chestBody([['iron_ingot', 3], ['bread', 2]]);
	const act = body.act;
	body.act = async (type, args) => (type === 'menu_click' ? (body.calls.push([type, args]), { state: 'INTERRUPTED', reasonCode: 'DANGER' }) : act(type, args));
	const result = await lootChest(body, { x: 1, y: 64, z: 2 }, { wanted: ['iron_ingot'] });
	assert.equal(result.ok, false);
	assert.equal(result.read, true);
	assert.equal(body.calls.at(-1)[0], 'menu_close');
	const shut = chestBody([]);
	shut.act = async (type) => (type === 'interact_block' ? { state: 'FAILED', reasonCode: 'BLOCK_OUT_OF_REACH' } : { state: 'SUCCEEDED' });
	const missed = await lootChest(shut, { x: 1, y: 64, z: 2 });
	assert.equal(missed.read, false);
});

test('a chest the body cannot walk to is skipped for this call but not marked opened', async () => {
	const chest = { blockId: 'minecraft:chest', x: 305, y: 77, z: -236 };
	const body = chestBody([['iron_ingot', 4]]);
	const act = body.act;
	body.act = async (type, args) => (type === 'travel_to' ? { state: 'FAILED', reasonCode: 'NO_ROUTE' } : act(type, args));
	const observe = async () => ({ ...village(), player: { ...at, health: 20, onGround: true, skyOpen: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }] }, blocks: [chest], entities: [] });
	const looted = { opened: [], searched: [], structures: [] };
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, { ...body, observe, stopped: () => false, interrupted: () => false, note: () => {},
		gather: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), mine: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), moveTo: async () => ({ state: 'SUCCEEDED' }),
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }) },
	{ now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.deepEqual(looted.opened, []);
	assert.equal(body.calls.filter(([type]) => type === 'interact_block').length, 0);
});

// The same playtest, later: after the iron it climbed back to the village for food. The trip's food is priced up front.
test('with no food for the trip a village visit comes before even a near cave ore; with food held the ore wins', async () => {
	const { seenPlaces } = await import('../src/obtain-runner.mjs');
	const cave = { ...village(), player: { x: 311.5, y: 77, z: -241.5 }, landmarks: [{ blockId: 'minecraft:iron_ore', x: 315, y: 67, z: -244, count: 4 }] };
	const options = { held, seen: new Set(['iron_ore']), places: seenPlaces(cave), loot: lootSources(cave) };
	const hungry = planObtain({ ids: ['iron_ingot'], count: 8 }, { ...options, food: 8 });
	assert.equal(hungry.needs[0].kind, 'loot', JSON.stringify(hungry.needs));
	assert.ok(hungry.needs[0].accept.includes('bread'));
	assert.equal(planObtain({ ids: ['iron_ingot'], count: 8 }, { ...options, food: 0 }).needs[0].accept[0], 'raw_iron');
});

test('seenRowCost against searchCost: a near cave ore is worth going back to, one 60 blocks down is not', async () => {
	const { searchCost, seenRowCost } = await import('../src/obtain-plan.mjs');
	const o = { player: { x: 311.5, y: 77, z: -241.5 } };
	assert.equal(searchCost('minecraft:iron_ore'), 8);
	assert.ok(seenRowCost({ id: 'minecraft:iron_ore', x: 315, y: 67, z: -244, count: 4 }, o) < 8);
	assert.ok(seenRowCost({ id: 'minecraft:iron_ore', x: 298, y: 14, z: -261 }, o) > 8);
	assert.ok(seenRowCost({ id: 'minecraft:iron_ore', x: 298, y: 14, z: -261, enclosed: true }, o) > seenRowCost({ id: 'minecraft:iron_ore', x: 298, y: 14, z: -261 }, o));
});

test('a village chest out of sight is found by looking into the houses through their doors, nearest first', async () => {
	const body = chestBody([['iron_ingot', 4], ['bread', 2]]);
	const pos = { ...at };
	let inside = false;
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'travel_to') { Object.assign(pos, { x: args.x, y: args.y ?? pos.y, z: args.z }); if (args.x === 300.5 && args.z === -229.5 && args.tolerance === 0.5) inside = true; }
		if (type === 'set_door') { body.calls.push([type, args]); return { state: 'SUCCEEDED' }; }
		return act(type, args);
	};
	const observe = async () => ({ ...village(), player: { ...pos, health: 20, onGround: true, skyOpen: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }, ...[...body.inv].map(([id, count], i) => ({ itemId: `minecraft:${id}`, count, slot: i + 1 }))] },
		seenResources: [{ id: 'minecraft:oak_door', kind: 'block', x: 330, y: 77, z: -250, count: 1 }, { id: 'minecraft:oak_door', kind: 'block', x: 300, y: 77, z: -230, count: 1 }],
		blocks: inside ? [{ blockId: 'minecraft:chest', x: 302, y: 77, z: -228 }] : [], entities: [] });
	const looted = { opened: [], searched: [], structures: [], doors: [] };
	const result = await runObtain({ item: 'iron_ingot', count: 3 }, { ...body, observe, stopped: () => false, interrupted: () => false, note: () => {},
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND' }) }, { now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.equal(result.state, 'SUCCEEDED', JSON.stringify(result));
	assert.deepEqual(looted.doors.map((d) => d.x), [300], 'the nearer house first, and no further once a chest is found');
	assert.ok(body.calls.some(([type, args]) => type === 'set_door' && args.open === true));
	assert.deepEqual(looted.opened, ['302,77,-228']);
	assert.deepEqual(body.calls.filter(([type]) => type === 'set_door').map(([, args]) => args.open), [true, false], 'the door is shut behind');
});

test('a house with a zombie by its door is shut again and not entered', async () => {
	const calls = [];
	const pos = { ...at };
	const observe = async () => ({ ...village(), player: { ...pos, health: 20, onGround: true, skyOpen: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }] },
		seenResources: [{ id: 'minecraft:oak_door', kind: 'block', x: 300, y: 77, z: -230, count: 1 }],
		blocks: [], entities: [{ type: 'minecraft:zombie', x: 302, y: 77, z: -228 }] });
	const act = async (type, args) => { calls.push([type, args]); if (type === 'travel_to') Object.assign(pos, { x: args.x ?? pos.x, z: args.z ?? pos.z }); return { state: 'SUCCEEDED' }; };
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, { act, observe, menu: async () => ({}), stopped: () => false, interrupted: () => false, note: () => {},
		gather: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), mine: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), moveTo: async () => ({ state: 'SUCCEEDED' }),
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND' }) }, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	const doorCalls = calls.filter(([type]) => type === 'set_door').map(([, args]) => args.open);
	assert.deepEqual(doorCalls.slice(0, 2), [true, false]);
	assert.equal(calls.some(([type, args]) => type === 'travel_to' && args.tolerance === 0.5), false, 'never steps into the doorway');
});

// The playtest's iron trip: obtain iron_pickaxe mined only the pickaxe's 3 iron, and the kit's other 8 took a second trip.
test('an iron tool\'s trip mines the rest of the kit\'s iron at the ore too; none extra when the plan mines no iron', async () => {
	const { kitIronExtra } = await import('../src/obtain-runner.mjs');
	const o = { world: { dimension: 'minecraft:overworld' }, inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }, { itemId: 'minecraft:oak_log', count: 4 }] } };
	const plan = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held });
	assert.equal(kitIronExtra(o, plan), 8, 'shield 1, 2 buckets 6, flint and steel 1');
	const both = planObtain({ ids: ['iron_pickaxe'], count: 1, also: [{ ids: ['raw_iron'], count: 8 }] }, { held });
	assert.equal(both.needs.find((need) => need.accept.includes('raw_iron')).count, 11, 'one vein trip for 11 raw iron');
	const twoHeld = { ...o, inventory: { items: [...o.inventory.items, { itemId: 'minecraft:raw_iron', count: 2 }] } };
	assert.equal(kitIronExtra(twoHeld, planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held: new Map([...held, ['raw_iron', 2]]) })), 8);
	assert.equal(kitIronExtra(o, planObtain({ ids: ['stick'], count: 4 }, { held })), 0);
	assert.equal(kitIronExtra({ ...o, world: { dimension: 'minecraft:the_nether' } }, plan), 0);
});
