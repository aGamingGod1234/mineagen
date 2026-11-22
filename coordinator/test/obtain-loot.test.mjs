import test from 'node:test';
import assert from 'node:assert/strict';
import { planObtain } from '../src/obtain-plan.mjs';
import { chestYield, lootSources, structureTables, lootYields } from '../src/loot-sources.mjs';
import { lootChest } from '../src/loot-step.mjs';
import { runObtain } from '../src/obtain-runner.mjs';
import { validateAction } from '../src/schema.mjs';

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
	assert.deepEqual(lootSources(o, { opened: new Set(['minecraft:overworld|300,78,-230']), searched: new Set(['minecraft:overworld|311,78,-239']) }), []);
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
			// Every move the loot step sends must pass the action schema the runtime applies before dispatch.
			validateAction({ type, ...args });
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
	assert.deepEqual(looted.opened, ['minecraft:overworld|305,77,-236']);
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
	assert.deepEqual(looted.opened, ['minecraft:overworld|305,77,-236']);
	assert.ok(searches.some((target) => target.block === 'minecraft:oak_door'), 'looks for the village\'s other houses');
	assert.equal(searches.some((target) => target.block === 'minecraft:chest'), false, 'no chest search in a village: its chests are indoors');
	assert.deepEqual(looted.searched, ['minecraft:overworld|311,78,-239']);
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
		if (type === 'travel_to') { Object.assign(pos, { x: args.x, y: args.y ?? pos.y, z: args.z }); validateAction({ type, ...args }); }
		if (type === 'navigate_to') { validateAction({ type, ...args }); body.calls.push([type, args]); Object.assign(pos, { x: args.x, y: args.y, z: args.z }); if (args.tolerance === 1 && Math.hypot(args.x - 300.5, args.z - -229.5) === 2) inside = true; return { state: 'SUCCEEDED' }; }
		if (type === 'set_door') { validateAction({ type, ...args }); body.calls.push([type, args]); return { state: 'SUCCEEDED' }; }
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
	assert.deepEqual(looted.opened, ['minecraft:overworld|302,77,-228']);
	assert.deepEqual(body.calls.filter(([type]) => type === 'set_door').map(([, args]) => args.open), [true, false], 'the door is shut behind');
});

test('a house with a zombie by its door is shut again and not entered', async () => {
	const calls = [];
	const pos = { ...at };
	const observe = async () => ({ ...village(), player: { ...pos, health: 20, onGround: true, skyOpen: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }] },
		seenResources: [{ id: 'minecraft:oak_door', kind: 'block', x: 300, y: 77, z: -230, count: 1 }],
		blocks: [], entities: [{ type: 'minecraft:zombie', x: 302, y: 77, z: -228 }] });
	const act = async (type, args) => { calls.push([type, args]); validateAction({ type, ...args }); if (type === 'travel_to') Object.assign(pos, { x: args.x ?? pos.x, z: args.z ?? pos.z }); return { state: 'SUCCEEDED' }; };
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, { act, observe, menu: async () => ({}), stopped: () => false, interrupted: () => false, note: () => {},
		gather: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), mine: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), moveTo: async () => ({ state: 'SUCCEEDED' }),
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND' }) }, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	const doorCalls = calls.filter(([type]) => type === 'set_door').map(([, args]) => args.open);
	assert.deepEqual(doorCalls, [], 'a zombie seen by the door before it opens: the door stays shut');
	assert.equal(calls.some(([type]) => type === 'navigate_to'), false, 'never steps into the house');
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

test('the chest is opened by the face toward the body, and another face when that one is blocked', async () => {
	const { facesToward } = await import('../src/loot-step.mjs');
	assert.deepEqual(facesToward({ x: 311, y: 77, z: -237 }, { x: 311.5, y: 77, z: -240.5 }).slice(0, 2), ['north', 'west']);
	assert.equal(facesToward({ x: 311, y: 77, z: -237 }, { x: 314.5, y: 79, z: -237.5 })[0], 'up');
	const body = chestBody([['iron_ingot', 2]]);
	const act = body.act;
	let tries = 0;
	body.act = async (type, args) => (type === 'interact_block' && tries++ === 0 ? (body.calls.push([type, args]), { state: 'FAILED', reasonCode: 'TARGET_OBSTRUCTED' }) : act(type, args));
	const result = await lootChest(body, { x: 311, y: 77, z: -237 }, { from: { x: 311.5, y: 77, z: -240.5 } });
	assert.equal(result.read, true);
	assert.deepEqual(body.calls.filter(([type]) => type === 'interact_block').map(([, args]) => args.face), ['north', 'west']);
});

// Smoke 8: the chest opened but the step read no menu. A real chest inspection, through the runtime's own result path.
test('a real chest inspection page keeps its menu through the tool-result path, named menuId; the loot step reads it', async () => {
	const { toolResultContent } = await import('../src/native-minecraft-tools.mjs');
	const slot = (i) => ({ itemId: i % 3 ? 'minecraft:bread' : 'minecraft:iron_ingot', count: 3, damage: 0, maxDamage: 0, maxStackSize: 64, displayName: i % 3 ? 'Bread' : 'Iron Ingot',
		fingerprint: `sha256:${'a'.repeat(64)}`, tooltip: [i % 3 ? 'Bread' : 'Iron Ingot'], tooltipTruncated: false, slot: i, x: 8 + 18 * (i % 9), y: 18 + 18 * Math.floor(i / 9), pickupAllowed: true, slotLimit: 64 });
	for (const [size, limit] of [[63, 32], [63, 9], [90, 32]]) {
		const raw = { state: 'SUCCEEDED', reasonCode: 'INSPECTED', entries: Array.from({ length: limit }, (_, i) => slot(i)),
			coverage: { offset: 0, limit, total: size, returned: limit, hasMore: true, nextOffset: limit, complete: false, byteLimited: false, source: 'open_menu' },
			menu: { type: 'minecraft:generic_9x3', containerId: 7, stateId: 3, slotCount: size, cursor: { itemId: 'minecraft:air', count: 0 }, capabilities: ['menu_click', 'menu_close'], details: {} } };
		const seen = JSON.parse(toolResultContent(raw).contentItems[0].text);
		assert.equal(seen.menu?.menuId, 'minecraft:generic_9x3', `${size}/${limit}: the menu survives, renamed menuId`);
		assert.equal(seen.menu?.type, undefined, 'and has no type field: the cause of "no chest menu open (none)"');
	}
	const body = chestBody([['iron_ingot', 2]]);
	const menu = body.menu;
	body.menu = async () => { const page = await menu(); return page.menu?.type === 'minecraft:generic_9x3' ? { ...page, menu: (({ type, ...rest }) => ({ menuId: type, ...rest }))(page.menu) } : page; };
	const result = await lootChest(body, { x: 1, y: 64, z: 2 }, { wanted: ['iron_ingot'] });
	assert.equal(result.ok, true, result.why);
	assert.deepEqual(result.taken, { iron_ingot: 2 });
	assert.equal(body.calls.find(([type]) => type === 'menu_click')[1].menuId, 'minecraft:generic_9x3');
});

// Review of 47cdd2cb (8 findings): each one's case.
function villageRun({ blocks = [], entities = [], seenResources = [], menuBody = chestBody([['iron_ingot', 4]]), extra = {} } = {}) {
	const pos = { ...at };
	const calls = menuBody.calls;
	const observe = async () => ({ ...village(), player: { ...pos, health: 20, onGround: true, skyOpen: true },
		inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 }, ...[...menuBody.inv].map(([id, count], i) => ({ itemId: `minecraft:${id}`, count, slot: i + 1 }))] },
		blocks: typeof blocks === 'function' ? blocks() : blocks, entities: typeof entities === 'function' ? entities() : entities, seenResources });
	const act = menuBody.act;
	const body = { ...menuBody, observe, stopped: () => false, interrupted: () => false, note: () => {},
		act: async (type, args) => { if (type === 'travel_to' || type === 'navigate_to') { calls.push([type, args]); validateAction({ type, ...args }); Object.assign(pos, { x: args.x, z: args.z }); return { state: 'SUCCEEDED' }; } if (type === 'set_door') { calls.push([type, args]); validateAction({ type, ...args }); return { state: 'SUCCEEDED' }; } return act(type, args); },
		gather: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), mine: async () => ({ state: 'FAILED', reasonCode: 'NOTHING_MINED' }), moveTo: async () => ({ state: 'SUCCEEDED' }),
		search: async () => ({ state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }), ...extra };
	return { body, calls, pos };
}

test('review 1: a stop while taking still closes the chest through closeMenu, which bypasses the halted act', async () => {
	const menuBody = chestBody([['iron_ingot', 3], ['bread', 2]]);
	const act = menuBody.act;
	let halted = false;
	menuBody.act = async (type, args) => {
		if (halted) { menuBody.calls.push(['refused', type]); return { state: 'INTERRUPTED', reasonCode: 'DANGER' }; }
		if (type === 'menu_click') { halted = true; return { state: 'INTERRUPTED', reasonCode: 'DANGER' }; }
		return act(type, args);
	};
	const closes = [];
	const { body } = villageRun({ blocks: [{ blockId: 'minecraft:chest', x: 305, y: 77, z: -236 }], menuBody,
		extra: { closeMenu: async (args) => { closes.push(args); validateAction({ type: 'menu_close', ...args }); return { state: 'SUCCEEDED', reasonCode: 'MENU_CLOSED' }; } } });
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	assert.equal(closes.length, 1, 'closed once, by closeMenu');
	assert.equal(menuBody.calls.some(([type, what]) => type === 'refused' && what === 'menu_close'), false);
});

test('review 2: no use on a cell that no longer holds a container (a stale target)', async () => {
	const looted = { opened: [], searched: [], structures: [], doors: [] };
	let n = 0;
	// Seen as a chest when planned, a TNT block by the time the body stands there.
	const { body, calls } = villageRun({ blocks: () => (n++ < 3 ? [{ blockId: 'minecraft:chest', x: 305, y: 77, z: -236 }] : [{ blockId: 'minecraft:tnt', x: 305, y: 77, z: -236 }]) });
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.equal(calls.some(([type]) => type === 'interact_block'), false);
	assert.deepEqual(looted.opened, []);
});

test('review 3: a hostile near the chest stops the run before the chest is opened; the server hostile flag counts at a door, a golem\'s does not', async () => {
	const chest = { blockId: 'minecraft:chest', x: 305, y: 77, z: -236 };
	const { body, calls } = villageRun({ blocks: [chest], entities: [{ type: 'minecraft:zombie', x: 307, y: 77, z: -236, hostile: true }] });
	const result = await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	assert.equal(calls.some(([type]) => type === 'interact_block'), false);
	assert.equal(result.state, 'INTERRUPTED');
	const door = [{ id: 'minecraft:oak_door', kind: 'block', x: 300, y: 77, z: -230, count: 1 }];
	const flagged = villageRun({ seenResources: door, entities: [{ type: 'minecraft:phantom', x: 301, y: 79, z: -230, hostile: true }] });
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, flagged.body, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	assert.equal(flagged.calls.some(([type]) => type === 'set_door'), false, 'a flagged hostile by the door: not opened');
	const golem = villageRun({ seenResources: door, entities: [{ type: 'minecraft:iron_golem', x: 301, y: 77, z: -230, hostile: true }] });
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, golem.body, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	assert.ok(golem.calls.some(([type, args]) => type === 'set_door' && args.open), 'the village golem does not keep it out');
});

test('review 4: ledger keys carry the dimension, and the runtime starts a new ledger in a new world', async () => {
	const { lootKey } = await import('../src/obtain-runner.mjs');
	assert.notEqual(lootKey({ x: 1, y: 2, z: 3 }, 'minecraft:overworld'), lootKey({ x: 1, y: 2, z: 3 }, 'minecraft:the_nether'));
	const o = { ...village(), blocks: [{ blockId: 'minecraft:chest', x: 300, y: 78, z: -230 }] };
	assert.equal(lootSources(o, { opened: new Set(['minecraft:the_nether|300,78,-230']) }).some((row) => row.kind === 'chest'), true);
	assert.equal(lootSources(o, { opened: new Set(['minecraft:overworld|300,78,-230']) }).some((row) => row.kind === 'chest'), false);
});


test('review 6: a step into the house that finds no room tries the door\'s other side', async () => {
	const door = [{ id: 'minecraft:oak_door', kind: 'block', x: 300, y: 77, z: -230, count: 1 }];
	const { body, calls } = villageRun({ seenResources: door });
	const act = body.act;
	let first = true;
	body.act = async (type, args) => (type === 'navigate_to' && args.tolerance === 1 && first ? (first = false, calls.push([type, args]), { state: 'FAILED', reasonCode: 'REACHED_FRONTIER' }) : act(type, args));
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	const steps = calls.filter(([type, args]) => type === 'navigate_to' && args.tolerance === 1).map(([, args]) => [args.x, args.z]);
	assert.equal(steps.length, 2);
	assert.deepEqual([steps[0][0] + steps[1][0], steps[0][1] + steps[1][1]], [2 * 300.5, 2 * -229.5], 'opposite sides of the door');
});


test('review 8: an ore in view whose dig costs more than a fresh search is not walked at; a near open one is; places come only from counted rows', async () => {
	const { locate, seenPlaces, seenIds } = await import('../src/obtain-runner.mjs');
	const need = { kind: 'mine', blocks: ['iron_ore', 'deepslate_iron_ore'], mobs: [], accept: ['raw_iron'] };
	const base = { player: { x: 0.5, y: 64, z: 0.5 }, world: { dimension: 'minecraft:overworld' } };
	const searched = [];
	const body = (blocks) => ({ observe: async () => ({ ...base, blocks }), search: async (t) => { searched.push(t); return { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND' }; } });
	const deep = await locate(need, body([{ blockId: 'minecraft:iron_ore', x: 0, y: 44, z: 0, enclosed: true }]), { budget: { failed: new Set() }, timeoutMs: 60_000 });
	assert.equal(deep, null, 'an enclosed ore 20 down (dig 8 units) is no better than a search (8): searched instead');
	assert.equal(searched.length, 1);
	const open = await locate(need, body([{ blockId: 'minecraft:iron_ore', x: 3, y: 60, z: 0 }]), { budget: { failed: new Set() }, timeoutMs: 60_000 });
	assert.equal(open?.x, 3);
	const remembered = { ...base, blocks: [], seenResources: [{ id: 'minecraft:iron_ore', kind: 'block', x: 5, y: 20, z: 5, placed: false }] };
	assert.equal(seenIds(remembered).has('iron_ore'), seenPlaces(remembered).has('iron_ore'), 'seen and priced from the same rows');
});


test('review 4: one loot ledger per world: kept while the world is the same or unknown, new in a known different world', async () => {
	const { lootLedger } = await import('../src/obtain-runner.mjs');
	const first = lootLedger(undefined, 'world-a');
	first.opened.push('minecraft:overworld|1,2,3');
	assert.equal(lootLedger(first, 'world-a'), first);
	assert.equal(lootLedger(first, null), first, 'a sample without a world id changes nothing');
	const next = lootLedger(first, 'world-b');
	assert.notEqual(next, first);
	assert.deepEqual(next.opened, []);
	assert.equal(next.worldId, 'world-b');
});

test('review 5: three empty chest visits for apples leave the apple tree its own tries', async () => {
	const looted = { opened: [], searched: [], structures: [], doors: [] };
	const searches = [];
	// Three chests in view that no walk reaches: three failed loot steps.
	const chests = [0, 1, 2].map((i) => ({ blockId: 'minecraft:chest', x: 300 + 3 * i, y: 77, z: -230 }));
	const { body, calls } = villageRun({ blocks: chests, extra: { search: async (target) => { searches.push(target.block); return { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'none' }; } } });
	const act = body.act;
	body.act = async (type, args) => (type === 'travel_to' && chests.some((c) => args.x === c.x + 0.5 && args.z === c.z + 0.5) ? (calls.push([type, args]), { state: 'FAILED', reasonCode: 'NO_ROUTE' }) : act(type, args));
	await runObtain({ item: 'apple', count: 1, timeoutMs: 60_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.equal(calls.filter(([type, args]) => type === 'travel_to' && chests.some((c) => args.x === c.x + 0.5)).length, 3, 'three chest visits failed');
	assert.ok(searches.some((block) => /_leaves$/.test(block)), `then the leaves still get a search: ${searches.join(', ')}`);
});

// The playtest village (22 Nov smoke logs): house doors at 322,77,-232, 334,79,-235 and 296,78,-239 from the start.
const PLAYTEST_DOORS = [[322, 77, -232], [334, 79, -235], [296, 78, -239]].map(([x, y, z]) => ({ id: 'minecraft:oak_door', kind: 'block', x, y, z, count: 1, placed: true }));
test('houses are priced: the toolsmith\'s house first though farther; with food held and no job block in sight no house pays its look', async () => {
	const { houseYield } = await import('../src/loot-sources.mjs');
	assert.ok(houseYield('grindstone', 'iron_ingot') > 1 && houseYield('none', 'iron_ingot') === 0 && houseYield('brewing_stand', 'bread') === 0);
	const smithy = { id: 'minecraft:smithing_table', kind: 'block', x: 335, y: 79, z: -238, count: 1, placed: true };
	const first = villageRun({ seenResources: [...PLAYTEST_DOORS, smithy] });
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 60_000 }, first.body, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	const opened = first.calls.filter(([type, args]) => type === 'set_door' && args.open).map(([, args]) => `${args.x},${args.z}`);
	assert.equal(opened[0], '334,-235', `the toolsmith's door first: ${opened.join(' ')}`);
	const fed = villageRun({ seenResources: PLAYTEST_DOORS });
	fed.body.observe = ((observe) => async () => { const o = await observe(); o.inventory.items.push({ itemId: 'minecraft:bread', count: 12, slot: 8 }); return o; })(fed.body.observe);
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 60_000 }, fed.body, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	assert.equal(fed.calls.some(([type]) => type === 'set_door'), false, 'plain houses hold no iron and the trip has its food: none looked into');
});

// The rerun's stone-pickaxe village start (4 bread held) looked into up to 5 ordinary houses for bread and found none.
test('trip food counts hunger points: 4 bread is a full bar and sends the bot into no ordinary house for food', async () => {
	const { tripFoodShort } = await import('../src/obtain-runner.mjs');
	assert.equal(tripFoodShort(new Map([['bread', 4]])), 0);
	assert.equal(tripFoodShort(new Map([['bread', 1]])), 3);
	assert.equal(tripFoodShort(new Map([['cooked_beef', 3]])), 0);
	assert.equal(tripFoodShort(new Map()), 4);
	const run = villageRun({ seenResources: PLAYTEST_DOORS });
	run.body.observe = ((observe) => async () => { const o = await observe(); o.inventory.items.push({ itemId: 'minecraft:bread', count: 4, slot: 8 }); return o; })(run.body.observe);
	await runObtain({ item: 'iron_pickaxe', count: 1, timeoutMs: 60_000 }, run.body, { now: (() => { let t = 0; return () => (t += 100); })(), looted: { opened: [], searched: [], structures: [], doors: [] } });
	assert.equal(run.calls.some(([type]) => type === 'set_door'), false, 'no ordinary house is worth its look');
});

// Codex review of 42b55e28.
test('codex: a mineshaft is no chest source (its loot rides in chest minecarts)', () => {
	assert.deepEqual(structureTables('mineshaft'), []);
	assert.deepEqual(structureTables('abandoned mineshaft'), []);
});

test('codex: the stacks the plan asked for are taken before what a player merely keeps', async () => {
	const body = chestBody([['bread', 3], ['apple', 2], ['iron_ingot', 4]]);
	await lootChest(body, { x: 1, y: 64, z: 2 }, { wanted: ['iron_ingot'] });
	assert.equal(body.calls.find(([type]) => type === 'menu_click')[1].expectedItemId, 'minecraft:iron_ingot');
});

test('codex: a take a stop cut short leaves the chest a source to come back to, though its loot is rolled', async () => {
	const looted = { opened: [], searched: [], structures: [], doors: [], partial: [] };
	const menuBody = chestBody([['iron_ingot', 3], ['bread', 2]]);
	const act = menuBody.act;
	menuBody.act = async (type, args) => (type === 'menu_click' ? { state: 'INTERRUPTED', reasonCode: 'DANGER' } : act(type, args));
	const chest = { blockId: 'minecraft:chest', x: 305, y: 77, z: -236 };
	const { body } = villageRun({ blocks: [chest], menuBody, extra: { closeMenu: async () => ({ state: 'SUCCEEDED' }) } });
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.deepEqual(looted.opened, []);
	assert.deepEqual(looted.partial, ['minecraft:overworld|305,77,-236']);
	const after = { ...village(), blocks: [chest], seenResources: [{ id: 'minecraft:chest', kind: 'container', x: 305, y: 77, z: -236, opened: true }] };
	assert.equal(lootSources(after, { partial: new Set(looted.partial) }).some((row) => row.kind === 'chest'), true);
	assert.equal(lootSources(after).some((row) => row.kind === 'chest'), false);
});

test('codex: a village no house of which pays for this goal stays a source for the next goal', async () => {
	const looted = { opened: [], searched: [], structures: [], doors: [] };
	const fed = villageRun({ seenResources: PLAYTEST_DOORS });
	fed.body.observe = ((observe) => async () => { const o = await observe(); o.inventory.items.push({ itemId: 'minecraft:bread', count: 12, slot: 8 }); return o; })(fed.body.observe);
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 60_000 }, fed.body, { now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.deepEqual(looted.searched, [], 'not written off for later goals');
	assert.equal(lootSources(village(), { searched: new Set(looted.searched), structures: looted.structures }).some((row) => row.kind === 'structure'), true);
});

test('codex: a house never entered (a hostile by its door) stays eligible for a later call; one entered is not visited again', async () => {
	const door = [{ id: 'minecraft:oak_door', kind: 'block', x: 300, y: 77, z: -230, count: 1, placed: true }];
	const looted = { opened: [], searched: [], structures: [], doors: [] };
	const zombie = villageRun({ seenResources: door, entities: [{ type: 'minecraft:zombie', x: 301, y: 77, z: -230 }] });
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, zombie.body, { now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.deepEqual(looted.doors, [], 'not entered, not written off');
	const clear = villageRun({ seenResources: door });
	await runObtain({ item: 'iron_ingot', count: 3, timeoutMs: 30_000 }, clear.body, { now: (() => { let t = 0; return () => (t += 100); })(), looted });
	assert.equal(looted.doors.length, 1, 'entered on the later call');
});

test("codex: an open chest gives every item the plan needs, not only the visit's own", async () => {
	const src = await import('../src/loot-step.mjs');
	const body = chestBody([['stick', 4], ['iron_ingot', 2]]);
	await src.lootChest(body, { x: 1, y: 64, z: 2 }, { wanted: ['iron_ingot', 'stick'] });
	assert.deepEqual(body.calls.filter(([type]) => type === 'menu_click').map(([, a]) => a.expectedItemId).sort(), ['minecraft:iron_ingot', 'minecraft:stick']);
	const runner = (await import('node:fs')).readFileSync(new URL('../src/obtain-runner.mjs', import.meta.url), 'utf8');
	assert.match(runner, /wanted: planWanted\(need\)/);
});

test('codex: a wanted stack a full inventory cannot take leaves the chest a source, with the miss counted', async () => {
	const body = chestBody([['iron_ingot', 2]]);
	const act = body.act;
	body.act = async (type, args) => (type === 'menu_click' ? (body.calls.push([type, args]), { state: 'SUCCEEDED', reasonCode: 'MENU_INPUT_NO_CHANGE' }) : act(type, args));
	const result = await lootChest(body, { x: 1, y: 64, z: 2 }, { wanted: ['iron_ingot'] });
	assert.equal(result.read, true);
	assert.equal(result.stopped, true, 'kept as a partly taken chest');
	assert.equal(result.ok, false);
	assert.match(result.why, /no room for iron_ingot/);
});
