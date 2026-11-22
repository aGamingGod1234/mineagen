import test from 'node:test';
import assert from 'node:assert/strict';
import { keepPickaxeMakings, planObtain, resolveObtainItem } from '../src/obtain-plan.mjs';
import { locate, runObtain, searchBlock, placementCell, placementCells } from '../src/obtain-runner.mjs';
import { searchFor } from '../src/find-search.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { howtoIndex } from '../src/howto.mjs';

const index = howtoIndex();
const bare = (value) => String(value).replace(/^minecraft:/, '');

/**
 * A body on flat grass with trees, stone under it, iron, cows and sheep: every act changes a counted inventory by the
 * game data's own recipes. Records the calls so tests can check the order of work.
 */
function simulatedBody({ start = {}, iron = true } = {}) {
	const inv = new Map(Object.entries(start));
	const calls = [];
	const blocks = new Map();
	const add = (id, n) => inv.set(bare(id), (inv.get(bare(id)) ?? 0) + n);
	const takeSpec = (spec, n) => {
		const members = spec.startsWith('#') ? index.tags[spec] : spec.split('|');
		let left = n;
		for (const member of members) { const used = Math.min(inv.get(member) ?? 0, left); if (used) { inv.set(member, inv.get(member) - used); left -= used; } }
		return left === 0;
	};
	const craft = (recipeId, count, station) => {
		const item = bare(recipeId) === 'planks' ? null : bare(recipeId);
		const rows = Object.entries(index.recipes).flatMap(([out, list]) => list.filter((row) => (row[3] ?? out) === item).map((row) => [out, row]));
		const [out, [rowStation, yieldCount, inputs]] = rows[0];
		if (rowStation !== station) return { state: 'FAILED', reasonCode: 'WRONG_STATION' };
		const times = Math.ceil(count / yieldCount);
		for (const [spec, per] of inputs) if (!takeSpec(spec, per * times)) return { state: 'FAILED', reasonCode: 'MISSING_INPUT', message: spec };
		add(out, times * yieldCount);
		return { state: 'SUCCEEDED' };
	};
	let furnace = null;
	const at = { x: 0.5, y: 64, z: 0.5 };
	const observation = () => ({
		player: { ...at, health: 20, yaw: 0 },
		inventory: { selectedSlot: 0, items: [...inv].filter(([, n]) => n > 0).map(([itemId, count], slot) => ({ itemId: `minecraft:${itemId}`, count, slot })) },
		blocks: [
			...Array.from({ length: 7 }, (_, dx) => Array.from({ length: 7 }, (_, dz) => ({ blockId: 'minecraft:grass_block', x: Math.floor(at.x) + dx - 3, y: Math.floor(at.y) - 1, z: Math.floor(at.z) + dz - 3, placeableFaces: ['up'] }))).flat(),
			{ blockId: 'minecraft:gravel', x: -3, y: 64, z: -3 },
			{ blockId: 'minecraft:oak_log', x: 3, y: 64, z: 3 },
			...[...blocks].map(([key, blockId]) => { const [x, y, z] = key.split(',').map(Number); return { blockId: `minecraft:${blockId}`, x, y, z }; }),
		],
		entities: [{ stableId: 'cow-1', type: 'minecraft:cow', x: 6, y: 64, z: 6 }, { stableId: 'sheep-1', type: 'minecraft:sheep', x: -6, y: 64, z: 6 }],
		items: [],
	});
	const body = {
		calls, inv,
		observe: async () => observation(),
		stopped: () => false, interrupted: () => false, note: () => {},
		// find's searchFor, as the runtime gives it: iron at its depth, gravel by the bank, nothing else out of view.
		search: async (target, options) => {
			calls.push(['search', target, options]);
			const seen = /iron_ore/.test(target.block ?? '') && iron ? { x: 4, y: 20, z: 4, id: 'minecraft:iron_ore' } : /gravel/.test(target.block ?? '') ? { x: -3, y: 64, z: -3, id: 'minecraft:gravel' } : null;
			return seen ? { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: `Found: ${seen.id}`, find: { seen } } : { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'Searched to 512 blocks from the start' };
		},
		moveTo: async () => ({ state: 'SUCCEEDED' }),
		mine: async (args) => {
			calls.push(['mine', args]);
			if (args.vein) { add('raw_iron', 4); return { state: 'SUCCEEDED' }; }
			const key = `${args.x},${args.y},${args.z}`;
			const block = blocks.get(key);
			if (block) { blocks.delete(key); add(block === 'gravel' ? (calls.filter((c) => c[0] === 'mine').length % 3 === 0 ? 'flint' : 'gravel') : block, 1); }
			return { state: 'SUCCEEDED' };
		},
		gather: async (args) => {
			calls.push(['gather', args]);
			const first = bare(args.itemIds[0]);
			const have = args.itemIds.reduce((sum, item) => sum + (inv.get(bare(item)) ?? 0), 0);
			add(first, Math.max(0, args.count - have));
			return { state: 'SUCCEEDED', broken: args.count };
		},
		act: async (type, args) => {
			calls.push([type, args]);
			if (type === 'craft_inventory') return craft(args.recipeId, args.count, 'inventory');
			if (type === 'craft_table') return blocks.get(`${args.x},${args.y},${args.z}`) === 'crafting_table' ? craft(args.recipeId, args.count, 'crafting_table') : { state: 'FAILED', reasonCode: 'NO_TABLE' };
			if (type === 'place_block') {
				const item = bare(args.itemId);
				if (!(inv.get(item) > 0)) return { state: 'FAILED' };
				inv.set(item, inv.get(item) - 1); blocks.set(`${args.x},${args.y},${args.z}`, item); return { state: 'SUCCEEDED' };
			}
			if (type === 'break_block') { const key = `${args.x},${args.y},${args.z}`; const block = blocks.get(key); blocks.delete(key); if (block) add(block, 1); return { state: 'SUCCEEDED' }; }
			if (type === 'furnace_transaction' && args.operation === 'load') {
				const input = bare(args.expectedItemId), fuel = bare(args.expectedFuelItemId);
				inv.set(input, inv.get(input) - args.count); inv.set(fuel, inv.get(fuel) - args.fuelCount);
				const members = (spec) => (spec.startsWith('#') ? index.tags[spec] : spec.split('|'));
				const out = Object.entries(index.recipes).find(([, list]) => list.some((row) => row[0] === 'furnace' && members(row[2][0][0]).includes(input)))?.[0];
				furnace = { out, n: args.count };
				return { state: 'SUCCEEDED' };
			}
			if (type === 'furnace_transaction' && args.operation === 'take_output') { const n = furnace?.n ?? 0; if (furnace) add(furnace.out, n); furnace = null; return { state: 'SUCCEEDED', message: `Collected ${n} x` }; }
			if (type === 'fight_until') { add(bare(args.untilItem), Math.max(0, args.untilCount - (inv.get(bare(args.untilItem)) ?? 0))); return { state: 'SUCCEEDED' }; }
			if (type === 'travel_to' && args.y !== undefined) { Object.assign(at, { x: args.x + 1, y: args.y, z: args.z }); return { state: 'SUCCEEDED' }; }
			if (type === 'dig_to' && args.pattern === 'stairs_down') { at.y = args.y; return { state: 'SUCCEEDED', message: `${Math.round(64 - args.y)} blocks mined` }; }
			if (type === 'dig_to' || type === 'travel_to' || type === 'wait' || type === 'pick_up_item' || type === 'look_at') return { state: 'SUCCEEDED' };
			return { state: 'FAILED', reasonCode: 'UNSIMULATED', message: type };
		},
	};
	return body;
}

test('family words resolve to every member; exact ids to themselves', () => {
	assert.deepEqual(resolveObtainItem('iron_pickaxe').ids, ['iron_pickaxe']);
	assert.ok(resolveObtainItem('bed').ids.includes('white_bed'));
	assert.ok(resolveObtainItem('boat').ids.includes('oak_boat') && !resolveObtainItem('boat').ids.some((id) => id.includes('chest')));
	assert.equal(resolveObtainItem('no such thing').ids.length, 0);
});

test('an iron pickaxe from nothing: logs, cobblestone and raw iron, with the two tools that gate them', () => {
	const plan = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held: new Map(), seen: new Set() });
	const need = (id) => plan.needs.find((row) => row.accept.includes(id));
	assert.equal(need('raw_iron').count, 3);
	assert.equal(need('raw_iron').tool, 'stone_pickaxe');
	assert.equal(need('cobblestone').count, 11);
	assert.ok(need('oak_log').accept.length > 5, 'any log will do');
	assert.deepEqual(plan.tools.sort(), ['stone_pickaxe', 'wooden_pickaxe']);
	assert.equal(plan.fuel.smelts, 3);
});

test('held items are netted: a held stone pickaxe and furnace leave only iron and sticks', () => {
	const plan = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held: new Map([['stone_pickaxe', 1], ['furnace', 1], ['crafting_table', 1], ['oak_planks', 8]]), seen: new Set() });
	assert.deepEqual(plan.needs.map((row) => row.accept[0]), ['raw_iron']);
	assert.equal(plan.needs[0].tool, null);
});

test('wool comes from white sheep, not rare dyed ones', () => {
	const plan = planObtain({ ids: resolveObtainItem('bed').ids, count: 1 }, { held: new Map(), seen: new Set() });
	assert.ok(plan.needs.some((row) => row.kind === 'kill' && row.accept[0] === 'white_wool' && row.mobs.includes('sheep')));
});

test('iron ingots come from ore and a furnace, not from hunting zombies in view for their rare drop', () => {
	for (const held of [new Map(), new Map([['wooden_pickaxe', 1], ['crafting_table', 1]])]) {
		const plan = planObtain({ ids: ['iron_ingot'], count: 3 }, { held, seen: new Set(['zombie', 'husk', 'drowned']) });
		assert.equal(plan.needs.some((need) => need.kind === 'kill'), false, JSON.stringify(plan.needs));
		assert.ok(plan.needs.some((need) => need.kind === 'mine' && need.accept.includes('raw_iron')));
		assert.ok(plan.ops.some((op) => op.kind === 'smelt'));
	}
});

test('a mob\'s usual drop is still hunted for: string, leather and spider eyes', () => {
	for (const [id, mob] of [['string', 'spider'], ['leather', 'cow'], ['spider_eye', 'spider']]) {
		const plan = planObtain({ ids: [id], count: 2 }, { held: new Map(), seen: new Set([mob]) });
		assert.deepEqual(plan.needs.map((need) => need.kind), ['kill'], `${id}: ${JSON.stringify(plan.needs)}`);
	}
});

test('any log out of view: find looks for the log this biome grows, oak elsewhere', () => {
	const logs = { blocks: ['acacia_log', 'birch_log', 'oak_log', 'spruce_log', 'jungle_log'] };
	assert.equal(searchBlock(logs, { world: { biome: 'minecraft:old_growth_spruce_taiga' } }), 'spruce_log');
	assert.equal(searchBlock(logs, { world: { biome: 'minecraft:birch_forest' } }), 'birch_log');
	assert.equal(searchBlock(logs, { world: { biome: 'minecraft:plains' } }), 'oak_log');
	assert.equal(searchBlock({ blocks: ['iron_ore', 'deepslate_iron_ore'] }, {}), 'iron_ore');
});

for (const tree of ['acacia_log', 'spruce_log', 'pale_oak_log']) test(`generic wood need finds ${tree} even with oak as the starting primary`, async () => {
	const need = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held: new Map() }).needs.find((n) => n.accept.includes(tree));
	assert.equal(need.blocks.length, 9, 'the actual planner accepts all nine natural Overworld log kinds');
	const observation = { player: { x: 0.5, y: 64, z: 0.5, health: 20 }, world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' }, blocks: [] };
	const source = { blockId: `minecraft:${tree}`, x: 3, y: 64, z: 0 };
	let target;
	const body = { observe: async () => observation, search: async (asked) => {
		target = asked;
		return searchFor(asked, { now: () => 0, observe: async () => ({ ...observation, blocks: [source] }), known: () => null, places: async () => [],
			look: async () => { assert.fail('the accepted visible log must end the search before another survey'); },
			act: async () => { assert.fail('the accepted visible log must end the search before walking'); } });
	} };
	const result = await locate(need, body, { budget: { failed: new Set() }, timeoutMs: 60_000 });
	assert.equal(target.block, 'minecraft:oak_log', 'a plains start keeps its original primary');
	assert.equal(new Set([target.block, ...target.also]).size, 9);
	assert.equal(result.blockId, source.blockId);
});

test('a source out of view is found by find inside obtain\'s time; one in view is not searched for', async () => {
	let t = 0;
	const body = simulatedBody();
	const result = await runObtain({ item: 'iron_pickaxe', count: 1, timeoutMs: 600_000 }, body, { now: () => (t += 100) });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const searches = body.calls.filter(([type]) => type === 'search');
	assert.deepEqual(searches.map(([, target]) => target), [{ block: 'minecraft:iron_ore' }], 'only the iron is out of view (logs and cows are seen)');
	assert.ok(searches[0][2].timeoutMs <= 600_000);
});

test('a placement cell is beside the body on solid ground, not in it', () => {
	const body = simulatedBody();
	return body.observe().then((o) => {
		const cell = placementCell(o);
		assert.ok(cell && cell.y === 64 && !(cell.x === 0 && cell.z === 0));
	});
});

for (const [item, extra] of [['iron_pickaxe'], ['bucket'], ['cooked_beef'], ['bed'], ['torch'], ['flint_and_steel'], ['shield'], ['chest'], ['boat']]) {
	test(`runs ${item} to the end on a simulated body, gathering in batches and picking stations back up`, async () => {
		const body = simulatedBody(extra);
		const result = await runObtain({ item, count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
		assert.equal(result.state, 'SUCCEEDED', JSON.stringify(result));
		assert.equal(result.stations.left, 0);
		const gathered = body.calls.filter(([type]) => type === 'gather').map(([, args]) => args.itemIds[0]);
		assert.equal(new Set(gathered).size, gathered.length, `gathered twice: ${gathered.join(', ')}`);
		for (const [type, args] of body.calls) if (type === 'place_block' && /crafting_table|furnace/.test(args.itemId)) assert.ok(body.calls.some(([t, a]) => t === 'break_block' && a.x === args.x && a.y === args.y && a.z === args.z));
	});
}

test('stuck runs say what is missing and why', async () => {
	const body = simulatedBody({ iron: false });
	body.act = ((act) => async (type, args) => (type === 'dig_to' ? { state: 'SUCCEEDED', blocksBroken: 200 } : act(type, args)))(body.act);
	const result = await runObtain({ item: 'iron_ingot', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'FAILED');
	assert.match(result.message, /iron_ore/);
});

test('do_step obtain runs to its result and takes item, count and timeoutMs', () => {
	const call = normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'iron_pickaxe', count: 1 }, why: 'iron tools' });
	assert.equal(call.kind, 'obtain');
	assert.deepEqual(call.arguments, { item: 'iron_pickaxe', count: 1, timeoutMs: 900_000 });
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'obtain', target: { item: 'stick', depth: 3 }, why: 'x' }));
});

test('danger interrupting obtain hands back with what is done and the running action handle', async () => {
	const body = simulatedBody();
	let calls = 0;
	const interrupted = () => calls > 3;
	body.interrupted = interrupted;
	const act = body.act;
	body.act = async (type, args) => { calls += 1; return calls === 4 ? { state: 'RUNNING', actionId: 'native:a:1', interruptedBy: 'danger', recoveryHint: 'replaceAction with actionId native:a:1' } : act(type, args); };
	const result = await runObtain({ item: 'wooden_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'INTERRUPTED');
	assert.equal(result.running.actionId, 'native:a:1');
	assert.match(result.message, /danger/);
});

test('a held item that packs into a block is never planned through the block (raw iron <-> raw iron block)', () => {
	const plan = planObtain({ ids: ['bucket'], count: 1 }, { held: new Map([['raw_iron', 1], ['stone_pickaxe', 1], ['furnace', 1], ['crafting_table', 1]]), seen: new Set() });
	assert.deepEqual(plan.unreachable, []);
	assert.equal(plan.needs.find((row) => row.accept.includes('raw_iron')).count, 2);
	assert.ok(!plan.ops.some((op) => op.outputs.includes('raw_iron_block')));
});

test('a station goes first where the body just stood: known air over a solid floor, even in a sparse tunnel sample', () => {
	const o = { player: { x: 10.5, y: 12, z: 0.5, onGround: true }, blocks: [{ blockId: 'minecraft:stone', x: 10, y: 11, z: 0 }] };
	const cells = placementCells(o, new Set(), { trail: ['8,12,0', '9,12,0', '10,12,0'] });
	assert.ok(['8,12,0', '9,12,0'].includes(`${cells[0].x},${cells[0].y},${cells[0].z}`) && cells[0].face === 'up', JSON.stringify(cells[0]));
	assert.ok(['8,12,0', '9,12,0'].includes(`${cells[1].x},${cells[1].y},${cells[1].z}`), 'both cells it stood in come before any guess');
	assert.ok(!cells.some((cell) => cell.x === 10 && cell.z === 0 && (cell.y === 12 || cell.y === 13)), 'never the body\'s own cells');
});

test('damage or a close hostile hands obtain back to the model; a far hostile that ended a walk does not', async () => {
	// The threat rows the server senses after the stop decide a hostile stop; a zombie 29 blocks away is past their range.
	const creeper = [{ uuid: 'x', type: 'minecraft:creeper', distance: 5.7, targeting: true, signals: ['targeting'] }];
	for (const [message, reasonCode, expected, threats] of [['minecraft:creeper x 5.7 blocks away at 1,2,3, targeting you', 'HOSTILE_NEAR', 'INTERRUPTED', creeper],
		['Took 4.0 damage (arrow from minecraft:skeleton); health 16.0', 'TRAVEL_DAMAGED', 'INTERRUPTED', []],
		['minecraft:zombie x 29.0 blocks away at 1,2,3, targeting you', 'HOSTILE_NEAR', 'SUCCEEDED', []]]) {
		const body = simulatedBody();
		const observe = body.observe;
		body.observe = async () => { const o = await observe(); return { ...o, player: { ...o.player, threats } }; };
		const gather = body.gather;
		let first = true;
		body.gather = async (args) => { if (first) { first = false; await gather(args); return { state: 'FAILED', reasonCode, message, broken: 4 }; } return gather(args); };
		const result = await runObtain({ item: 'wooden_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
		assert.equal(result.state, expected, `${reasonCode}: ${result.message}`);
	}
});

test('b9 test host seed 7-r1: a placed table that two pickups cannot reach is left, not retried every round and call', async () => {
	const placed = [];
	const body = simulatedBody({ start: { crafting_table: 1, oak_planks: 3, stick: 2 } });
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'break_block' && args.expectedBlockId === 'minecraft:crafting_table') { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE', message: 'not visible' }; }
		return act(type, args);
	};
	const tries = () => body.calls.filter(([type, args]) => type === 'break_block' && args.expectedBlockId === 'minecraft:crafting_table').length;
	const first = await runObtain({ item: 'wooden_pickaxe', count: 1 }, body, { placed, now: ticking() });
	assert.equal(first.state, 'SUCCEEDED', first.message);
	assert.equal(tries(), 2, 'two tries');
	assert.equal(placed.length, 0, 'then left');
	assert.ok(first.steps.some((line) => /could not pick up the crafting_table .*: TARGET_NOT_VISIBLE; leave it/.test(line)), first.steps.join(' | '));
	await runObtain({ item: 'stick', count: 4 }, body, { placed, now: ticking() });
	assert.equal(tries(), 2, 'no more tries in the next call');
});

test('stations a danger-interrupted call left placed are picked up by the next call', async () => {
	const placed = [];
	const body = simulatedBody();
	let interrupted = false;
	body.interrupted = () => interrupted;
	const act = body.act;
	let crafted = 0;
	body.act = async (type, args) => { const result = await act(type, args); if (type === 'craft_table' && crafted++ === 0) interrupted = true; return result; };
	const first = await runObtain({ item: 'stone_pickaxe', count: 1 }, body, { placed, now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(first.state, 'INTERRUPTED');
	assert.equal(placed.length, 1, 'the table stays on the shared list');
	interrupted = false;
	const second = await runObtain({ item: 'stone_pickaxe', count: 1 }, body, { placed, now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(second.state, 'SUCCEEDED', second.message);
	assert.equal(placed.length, 0);
	assert.ok(body.calls.filter(([type]) => type === 'break_block').length >= 1);
});

test('raw iron held without fuel: the logs for fuel are gathered before the smelt, not a smelt that fails', async () => {
	const body = simulatedBody({ start: { raw_iron: 3, stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2 } });
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const order = body.calls.map(([type, args]) => type === 'furnace_transaction' ? `furnace:${args.operation}` : type);
	assert.ok(order.indexOf('gather') < order.indexOf('furnace:load'), order.join(' '));
});

test('review P1: danger or death while picking up stations is never reported as obtained', async () => {
	for (const [label, poison] of [['damage', (body) => { const act = body.act; body.act = async (type, args) => (type === 'break_block' ? { state: 'FAILED', reasonCode: 'DAMAGE_TAKEN', message: 'Took 6.0 damage (mob); health 2.0' } : act(type, args)); }],
		['death', (body) => { const act = body.act; body.act = async (type, args) => { const result = await act(type, args); if (type === 'break_block') body.inv.clear(); return result; }; }]]) {
		const body = simulatedBody();
		poison(body);
		const result = await runObtain({ item: 'wooden_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
		assert.notEqual(result.state, 'SUCCEEDED', `${label}: ${result.message}`);
	}
});

test('review P1: every life-safety stop hands back, and a skeleton aiming from 13 blocks counts', async () => {
	const { isDanger } = await import('../src/obtain-runner.mjs');
	for (const code of ['IN_LAVA', 'LAVA_AHEAD', 'FALLING_BLOCKS', 'AIR_RESERVE_REACHED', 'ON_FIRE', 'VOID_EDGE']) assert.ok(isDanger({ reasonCode: code }), code);
	const after = (type, distance) => ({ player: { threats: [{ uuid: '1b0a0e00-9fc5-44f6-8c29-abfefb6df538', type, distance, targeting: true, signals: ['targeting'] }] } });
	assert.ok(isDanger({ reasonCode: 'HOSTILE_NEAR', message: 'minecraft:skeleton 1b0a0e00-9fc5-44f6-8c29-abfefb6df538 13.2 blocks away at 1,2,3, targeting you' }, after('minecraft:skeleton', 13.2)));
	// A zombie 29 blocks away is past the server's threat range: no row, no danger.
	assert.ok(!isDanger({ reasonCode: 'HOSTILE_NEAR', message: 'minecraft:zombie 1b0a0e00-9fc5-44f6-8c29-abfefb6df538 29.0 blocks away at 1,2,3, targeting you' }, { player: { threats: [] } }));
	// A zombie 5 blocks off that is not after the body has no threat row: its hostile entity row still makes the stop danger.
	assert.ok(isDanger({ reasonCode: 'HOSTILE_NEAR' }, { player: { x: 0, y: 64, z: 0, threats: [] }, entities: [{ stableId: 'z', type: 'minecraft:zombie', hostile: true, x: 5, y: 64, z: 0 }] }));
	assert.ok(!isDanger({ reasonCode: 'WATER_AHEAD' }));
	// A dig that stops for lava ends obtain at once instead of counting as a failed search and digging on.
	const body = simulatedBody({ iron: false, start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 6 } });
	// find stopped for lava: obtain hands back at once instead of counting a failed search and searching on.
	let searches = 0;
	body.search = async () => { searches += 1; return { state: 'FAILED', reasonCode: 'FIND_DANGER', message: 'Stopped for danger: IN_LAVA' }; };
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'INTERRUPTED', result.message);
	assert.equal(searches, 1, 'no searching on after lava');
});

test('review: the deadline holds for every body call, waits included', async () => {
	let t = 0;
	const body = simulatedBody({ start: { raw_iron: 3, stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 6 } });
	const act = body.act;
	body.act = async (type, args) => { t += type === 'wait' ? args.durationMs : 5_000; return act(type, args); };
	const result = await runObtain({ item: 'iron_pickaxe', count: 1, timeoutMs: 20_000 }, body, { now: () => t });
	for (const [type, args] of body.calls) {
		if (type === 'wait') assert.ok(args.durationMs <= 20_000, `wait ${args.durationMs}`);
		if (Number.isFinite(args?.timeoutMs)) assert.ok(args.timeoutMs <= 50_000, `${type} ${args.timeoutMs}`);
	}
	assert.ok(t <= 20_000 + 30_000 + 15_000, `ran ${t} ms of a 20 s budget (cleanup grace 30 s)`);
	assert.ok(['TIMED_OUT', 'SUCCEEDED'].includes(result.state), result.message);
});

test('review: a station out of reach (after a death or a long trip) is given up, not walked back to', async () => {
	const placed = [{ kind: 'crafting_table', x: 300, y: 64, z: 300, dimension: null }];
	const body = simulatedBody();
	const result = await runObtain({ item: 'wooden_pickaxe', count: 1 }, body, { placed, now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(placed.length, 0);
	assert.ok(!body.calls.some(([type, args]) => (type === 'moveTo' || type === 'break_block') && args.x >= 299), 'never went back for it');
});

test('review: logs from down a mine: back up to the surface first, not a sideways search', async () => {
	// The run starts on the surface, then the body is down a mine (sky closed, 40 blocks lower) when it needs logs.
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, raw_iron: 3 } });
	let observed = 0, underground = true;
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); if (observed++ > 0 && underground) { o.player.y = 24; o.player.skyOpen = false; } else o.player.skyOpen = true; return o; };
	const act = body.act;
	body.act = async (type, args) => { if (type === 'travel_to' && args.retrace) underground = false; return act(type, args); };
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const order = body.calls.map(([type, args]) => (type === 'travel_to' && args.retrace ? 'retrace' : type));
	assert.ok(order.includes('retrace') && order.indexOf('retrace') < order.indexOf('gather'), order.join(' '));
});

test('find pointing again at an ore obtain already failed at: tunnel off to new ground before searching again', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	const mine = body.mine;
	let veins = 0;
	// Out of reach for good: the vein fails, and again after a short dig toward it.
	body.mine = async (args) => (args.vein && veins++ < 2 ? (body.calls.push(['mine', args]), { state: 'FAILED', reasonCode: 'INVALID_VEIN_TARGET' }) : mine(args));
	// The same stale survey row until the body has moved off; then a new vein from the new ground.
	body.search = async (target, options) => {
		body.calls.push(['search', target, options]);
		const moved = body.calls.some(([type, args]) => type === 'dig_to' && args.pattern === 'tunnel' && args.heading);
		const seen = moved ? { x: 8, y: 20, z: 8, id: 'minecraft:iron_ore' } : { x: 4, y: 20, z: 4, id: 'minecraft:iron_ore' };
		return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: 'Found', find: { seen } };
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const order = body.calls.map(([type, args]) => (type === 'dig_to' && args.pattern === 'tunnel' && args.heading ? 'move-off' : type));
	const second = order.indexOf('search', order.indexOf('search') + 1);
	assert.ok(order.includes('move-off') && order.indexOf('move-off') < order.indexOf('search', second + 1), order.join(' '));
	assert.ok(body.calls.some(([type, args]) => type === 'dig_to' && args.x === 4 && args.z === 4 && args.stopWhenSeen === 'minecraft:iron_ore'), 'a short dig toward the hidden ore first');
});

test('gate seed 1 scripted: an ore in reach but behind a block is dug to and mined, not left for three more searches', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	const mine = body.mine;
	let veins = 0;
	body.mine = async (args) => (args.vein && veins++ === 0 ? (body.calls.push(['mine', args]), { state: 'FAILED', reasonCode: 'INVALID_VEIN_TARGET' }) : mine(args));
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.calls.filter(([type]) => type === 'search').length, 1, 'one search');
});

const ticking = () => { let t = 0; return () => (t += 100); };

test('gate seed 5 scripted: a raw iron drop past the tunnel end is dug to and picked up, not left for a second vein', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	let drop = null, dug = false;
	body.mine = async (args) => { body.calls.push(['mine', args]); if (args.vein) drop = { stableId: 'raw-1', itemId: 'minecraft:raw_iron', x: 7.5, y: 20, z: 4.5 }; return { state: 'SUCCEEDED' }; };
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); o.player.skyOpen = o.player.y < 60 ? false : true; if (drop) o.items = [drop]; return o; };
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'pick_up_item') {
			body.calls.push([type, args]);
			if (!dug) return { state: 'FAILED', reasonCode: 'PATH_BLOCKED', message: 'Navigation could not recover from repeated stalls' };
			body.inv.set('raw_iron', 3); drop = null; return { state: 'SUCCEEDED' };
		}
		if (type === 'dig_to' && args.pattern === 'tunnel' && args.x === 7) { body.calls.push([type, args]); dug = true; return { state: 'SUCCEEDED' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.ok(dug, 'dug toward the drop');
	assert.equal(body.calls.filter(([type, args]) => type === 'mine' && args.vein).length, 1, 'one vein');
});

test('re-check P1 1: damage while picking up the stations, or ending under the low-health line, is never obtained', async () => {
	for (const after of [2, 14]) {
		const body = simulatedBody();
		let health = 20;
		const observe = body.observe;
		body.observe = async () => { const o = await observe(); o.player.health = health; return o; };
		const act = body.act;
		body.act = async (type, args) => { const result = await act(type, args); if (type === 'break_block') health = after; return result; };
		const result = await runObtain({ item: 'wooden_pickaxe', count: 1 }, body, { now: ticking() });
		assert.equal(result.state, 'INTERRUPTED', `health 20 -> ${after}: ${result.message}`);
		assert.equal(result.reasonCode, 'DANGER');
		assert.match(result.message, new RegExp(`health 20 -> ${after}`));
	}
});

test('re-check P2 7: a search that danger stopped with its leg still running hands that handle back', async () => {
	const body = simulatedBody({ iron: false, start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 6 } });
	body.search = async () => ({ state: 'RUNNING', actionId: 'native:a:9', reasonCode: 'FIND_DANGER', recoveryHint: 'replaceAction with actionId native:a:9',
		message: 'Danger stopped the search; the leg still runs (native:a:9): deal with it, then find again' });
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'INTERRUPTED', result.message);
	assert.equal(result.running?.actionId, 'native:a:9');
	assert.match(result.running.recoveryHint, /native:a:9/);
});

/** A body down a mine with no surface origin: stairs_up raises it by what the dig gives, the sky opens at y 60. */
function underground(body, { startY, perLeg }) {
	let y = startY;
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); o.player.y = y; o.player.skyOpen = y >= 60; return o; };
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'dig_to' && args.pattern === 'stairs_up') { body.calls.push([type, args]); const rose = Math.min(perLeg, args.y - y); y += rose; return rose > 0 ? { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' } : { state: 'FAILED', reasonCode: 'NO_STANCE', message: 'no stance up from here' }; }
		return act(type, args);
	};
}

test('re-check P2 4: logs from deep down with no surface origin: stairs up until the sky is open, not 24 blocks and a sideways search', async () => {
	const body = simulatedBody();
	underground(body, { startY: -20, perLeg: 24 });
	const result = await runObtain({ item: 'stick', count: 4 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const order = body.calls.map(([type, args]) => (type === 'dig_to' && args.pattern === 'stairs_up' ? 'up' : type));
	assert.equal(order.filter((call) => call === 'up').length, 4, order.join(' '));
	assert.ok(order.lastIndexOf('up') < order.indexOf('gather'), order.join(' '));
});

test('re-check P2 4: a climb to the surface that cannot go on hands back NO_SOURCE saying why, with no sideways search', async () => {
	const body = simulatedBody();
	underground(body, { startY: -20, perLeg: 0 });
	const result = await runObtain({ item: 'stick', count: 4 }, body, { now: ticking() });
	assert.equal(result.state, 'FAILED', result.message);
	assert.equal(result.reasonCode, 'NO_SOURCE');
	assert.match(result.message, /no way up to the surface for .*climb to the surface stopped at y -20 under cover \(NO_STANCE/);
	assert.ok(!body.calls.some(([type]) => type === 'gather' || type === 'search'), body.calls.map(([type]) => type).join(' '));
});

test('re-check P2 3: a gather step inside obtain never runs past what is left of the deadline', async () => {
	const { gatherStepTimeout } = await import('../src/native-tool-runtime.mjs');
	assert.equal(gatherStepTimeout(20_000, 105_000, 100_000), 5_000, 'a 20 s walk with 5 s left gets 5 s');
	assert.equal(gatherStepTimeout(15_000, 200_000, 100_000), 15_000);
	assert.equal(gatherStepTimeout(15_000, 100_000, 100_400), 1_000, 'past the deadline: the shortest step, then gather ends');
	let t = 0;
	const body = simulatedBody();
	const gather = body.gather;
	body.gather = async (args) => { t += 1_000; return gather(args); };
	await runObtain({ item: 'stick', count: 4, timeoutMs: 30_000 }, body, { now: () => t });
	for (const [type, args] of body.calls) if (type === 'gather') assert.ok(args.timeoutMs <= 30_000, `gather asked ${args.timeoutMs}`);
});

test('re-check P2 8: the live harness ends the run at a hand-back by default, with no fight, flee or wait', async () => {
	const { callObtain } = await import('../../scripts/quality/obtain-handbacks.mjs');
	const handedBack = { state: 'INTERRUPTED', reasonCode: 'DANGER', message: 'Stopped for danger (HOSTILE_NEAR: minecraft:zombie 1b0a0e00-9fc5-44f6-8c29-abfefb6df538 4.0 blocks away)' };
	for (const mode of [undefined, '', 'end']) {
		let executed = 0, answered = 0;
		const ran = await callObtain({ mode, budgetMs: 900_000, started: 0, now: () => 0, execute: async () => { executed += 1; return handedBack; }, alive: async () => true, answer: async () => { answered += 1; return 'fought'; } });
		assert.equal(executed, 1);
		assert.equal(answered, 0, `mode ${mode}: no answer after the hand-back`);
		assert.equal(ran.handBacks.length, 1);
		assert.equal(ran.result, handedBack);
	}
	let answered = 0;
	await callObtain({ mode: 'answer', budgetMs: 900_000, started: 0, now: () => 0, execute: async (attempt) => (attempt === 0 ? handedBack : { state: 'SUCCEEDED' }), alive: async () => true, answer: async () => { answered += 1; return null; } });
	assert.equal(answered, 1, 'OBTAIN_HANDBACK=answer keeps the stand-in');
});

test('round-2 P2 5: a failed retrace that ends near the origin altitude under cover still climbs to open sky', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, raw_iron: 3 } });
	let observed = 0, y = 64, sky = true;
	const observe = body.observe;
	// The run starts on the surface (y 64), then the body is 4 blocks lower under an overhang when it needs logs.
	body.observe = async () => { const o = await observe(); if (observed++ === 1) { y = 60; sky = false; } o.player.y = y; o.player.skyOpen = sky; return o; };
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'travel_to' && args.retrace) { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen leg gets closer' }; }
		if (type === 'dig_to' && args.pattern === 'stairs_up') { body.calls.push([type, args]); y += 3; sky = true; return { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const order = body.calls.map(([type, args]) => (type === 'travel_to' && args.retrace ? 'retrace' : type === 'dig_to' && args.pattern === 'stairs_up' ? 'up' : type));
	assert.ok(order.indexOf('retrace') < order.indexOf('up') && order.indexOf('up') < order.indexOf('gather'), order.join(' '));
});

test('round-2 P2 4: every pickup carries a timeout, inside what is left of obtain', async () => {
	const call = normalizeMinecraftToolCall('act', { actionType: 'pick_up_item', arguments: { targetSelector: '1b0a0e00-9fc5-44f6-8c29-abfefb6df538', timeoutMs: 5_000 } });
	assert.ok(JSON.stringify(call).includes('"timeoutMs":5000'), JSON.stringify(call));
	// A station broken in cleanup drops beside it: obtain picks the drop up with a bounded timeout.
	const body = simulatedBody();
	let broke = null;
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); if (broke) o.items = [{ stableId: 'drop-1', itemId: 'minecraft:crafting_table', x: broke.x + 0.5, y: broke.y, z: broke.z + 0.5 }]; return o; };
	const act = body.act;
	body.act = async (type, args) => { const result = await act(type, args); if (type === 'break_block') broke = args; if (type === 'pick_up_item') broke = null; return result; };
	const result = await runObtain({ item: 'wooden_pickaxe', count: 1, timeoutMs: 20_000 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const pickups = body.calls.filter(([type]) => type === 'pick_up_item').map(([, args]) => args);
	assert.ok(pickups.length > 0, 'the drop was picked up');
	for (const args of pickups) assert.ok(Number.isFinite(args.timeoutMs) && args.timeoutMs <= 50_000, JSON.stringify(args));
});

test('gate seed 1: raw iron found one ore at a time is smelted in one batch, not a furnace per ore', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 6 } });
	const mine = body.mine;
	body.mine = async (args) => { if (!args.vein) return mine(args); body.calls.push(['mine', args]); body.inv.set('raw_iron', (body.inv.get('raw_iron') ?? 0) + 1); return { state: 'SUCCEEDED' }; };
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const loads = body.calls.filter(([type, args]) => type === 'furnace_transaction' && args.operation === 'load').map(([, args]) => args.count);
	assert.deepEqual(loads, [3], 'one load of all three');
});

test('gate B-2: a smelt waits for fuel that covers it: planks are crafted from a held log first, not 3 raw iron on 1 plank', async () => {
	const body = simulatedBody({ start: { raw_iron: 3, stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 1, oak_log: 1 } });
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const load = body.calls.find(([type, args]) => type === 'furnace_transaction' && args.operation === 'load')[1];
	assert.equal(load.count, 3);
	assert.ok(load.fuelCount * 1.5 >= 3, `fuel ${load.fuelCount} ${load.expectedFuelItemId}`);
	assert.ok(body.calls.findIndex(([type]) => type === 'craft_inventory') < body.calls.findIndex(([type]) => type === 'furnace_transaction'), 'planks before the load');
});

test('gate B-2: with too little wood and coal ore in view, the fuel is coal from the mine, not a climb for a log', () => {
	const plan = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held: new Map([['raw_iron', 3], ['stone_pickaxe', 1], ['crafting_table', 1], ['furnace', 1], ['stick', 2], ['spruce_planks', 1]]), seen: new Set(['coal_ore']) });
	assert.deepEqual(plan.needs.map((need) => need.accept[0]), ['coal']);
	const away = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held: new Map([['raw_iron', 3], ['stone_pickaxe', 1], ['crafting_table', 1], ['furnace', 1], ['stick', 2], ['spruce_planks', 1]]), seen: new Set() });
	assert.ok(away.needs.some((need) => need.accept.includes('oak_log')), 'no coal seen: logs as before');
});

test('review: coal ore remembered but out of reach: once coal is out of tries, the fuel is planks from a log, not NO_SOURCE', async () => {
	const body = simulatedBody({ start: { raw_iron: 3, oak_planks: 1, stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2 } });
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); o.routeMemory = { seenResources: [{ blockId: 'minecraft:coal_ore', x: 40, y: 50, z: -30 }] }; return o; };
	const result = await runObtain({ item: 'iron_pickaxe', count: 1, timeoutMs: 600_000 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.ok(body.calls.some(([type, target]) => type === 'search' && /coal_ore/.test(target.block ?? '')), 'coal was tried first');
	assert.ok(body.calls.some(([type, args]) => type === 'gather' && args.itemIds.some((item) => /_log$/.test(item))), 'then a log');
});

function bucketMine({ coal }) {
	const body = simulatedBody({ iron: false, start: { raw_iron: 3, iron_pickaxe: 1, shield: 1, furnace: 1, crafting_table: 1 } });
	underground(body, { startY: 28, perLeg: 24 });
	const search = body.search;
	body.search = async (target, options) => {
		if (!/coal_ore/.test(target.block ?? '')) return search(target, options);
		body.calls.push(['search', target, options]);
		return coal ? { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: 'Found: minecraft:coal_ore', find: { seen: { x: 3, y: 26, z: 2, id: 'minecraft:coal_ore' } } }
			: { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'Searched the tunnels' };
	};
	const mine = body.mine;
	body.mine = async (args) => { if (args.vein && coal) { body.calls.push(['mine', args]); body.inv.set('coal', (body.inv.get('coal') ?? 0) + 3); return { state: 'SUCCEEDED' }; } return mine(args); };
	return body;
}

test('r5 Q1: under cover with iron to smelt and no wood, the plan burns coal (searched for), not a climb for logs', () => {
	const held = new Map([['raw_iron', 3], ['iron_pickaxe', 1], ['furnace', 1], ['crafting_table', 1]]);
	assert.deepEqual(planObtain({ ids: ['bucket'], count: 1 }, { held, seen: new Set(), coalFirst: true }).needs.map((need) => need.accept[0]), ['coal']);
	assert.ok(planObtain({ ids: ['bucket'], count: 1 }, { held, seen: new Set() }).needs.some((need) => need.accept.includes('oak_log')), 'on the surface: logs as before');
	assert.deepEqual(planObtain({ ids: ['bucket'], count: 1 }, { held: new Map([...held, ['coal', 1]]), seen: new Set(), coalFirst: true }).needs, [], 'coal carried covers the smelt');
});

test('r5 Q1: underground bucket smelt with coal ore found: mines the coal and burns it, no climb', async () => {
	const body = bucketMine({ coal: true });
	const result = await runObtain({ item: 'bucket', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const order = body.calls.map(([type, args]) => type === 'dig_to' && args.pattern === 'stairs_up' ? 'up' : type === 'travel_to' && args.retrace ? 'retrace' : type);
	assert.ok(!order.includes('up') && !order.includes('retrace') && !order.includes('gather'), order.join(' '));
	const load = body.calls.find(([type, args]) => type === 'furnace_transaction' && args.operation === 'load')[1];
	assert.equal(bare(load.expectedFuelItemId), 'coal');
});

test('r5 Q1: underground bucket smelt with no coal found: two short coal searches, then the climb for logs', async () => {
	const body = bucketMine({ coal: false });
	const result = await runObtain({ item: 'bucket', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const coal = body.calls.filter(([type, target]) => type === 'search' && /coal_ore/.test(target.block ?? ''));
	assert.equal(coal.length, 2);
	for (const [, , options] of coal) assert.ok(options.timeoutMs <= 90_000, `coal search ${options.timeoutMs} ms`);
	const order = body.calls.map(([type, args]) => type === 'dig_to' && args.pattern === 'stairs_up' ? 'up' : type === 'search' && /coal_ore/.test(args.block ?? '') ? 'coal' : type);
	assert.ok(order.lastIndexOf('coal') < order.indexOf('up') && order.indexOf('up') < order.indexOf('gather'), order.join(' '));
	assert.ok(body.calls.find(([type]) => type === 'gather')[1].count >= 8, 'one trip covers the shield planks and the fuel');
});

test('gate B-3: a few held nuggets do not make the nugget recipe the way to an ingot', () => {
	const plan = planObtain({ ids: ['iron_pickaxe'], count: 1 }, { held: new Map([['iron_nugget', 3], ['raw_iron', 3], ['stone_pickaxe', 1], ['crafting_table', 1], ['furnace', 1], ['oak_planks', 6]]), seen: new Set() });
	assert.deepEqual(plan.unreachable, []);
	assert.ok(plan.ops.some((op) => op.kind === 'smelt' && op.outputs[0] === 'iron_ingot'));
});

test('logs come by the tree: a trip for logs takes at least eight, so a later step does not climb back for one', async () => {
	const body = simulatedBody();
	const result = await runObtain({ item: 'wooden_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.ok(body.calls.find(([type]) => type === 'gather')[1].count >= 6);
});

test('gate B-1: a body on a tree canopy breaks the leaves under its feet down to the ground before it gathers', async () => {
	const body = simulatedBody();
	let feetY = 74;
	const observe = body.observe;
	// The grass round the tree is at y 69 (the sim's ground raised 6), seen past the canopy's edge: 4 blocks below the feet.
	body.observe = async () => { const o = await observe(); o.player.y = feetY; o.player.onGround = true; o.blocks = o.blocks.map((row) => ({ ...row, y: row.y + 6 })); return o; };
	body.blocksNear = async () => (feetY > 70 ? [{ blockId: 'minecraft:birch_leaves', x: 0, y: feetY - 1, z: 0 }] : [{ blockId: 'minecraft:grass_block', x: 0, y: 69, z: 0 }]);
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'break_block' && /_leaves$/.test(args.expectedBlockId ?? '')) { body.calls.push([type, args]); feetY -= 1; return { state: 'SUCCEEDED' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const breaks = body.calls.filter(([type, args]) => type === 'break_block' && /_leaves$/.test(args.expectedBlockId ?? '')).map(([, args]) => args.y);
	assert.deepEqual(breaks, [73, 72, 71, 70]);
	assert.ok(body.calls.findIndex(([type]) => type === 'gather') > body.calls.findIndex(([type]) => type === 'break_block'), 'down first, then gather');
});

test('review: on a jungle giant\'s canopy 25 blocks up, or with no ground seen round it, the body does not break down through the leaves', async () => {
	for (const groundY of [69, null]) {
		const body = simulatedBody();
		let feetY = 95;
		const observe = body.observe;
		// Leaves stack under the feet down to y 85, then open air to the grass at y 69 (or no ground in sight at all).
		body.observe = async () => {
			const o = await observe();
			o.player.y = feetY; o.player.onGround = true;
			o.blocks = groundY === null ? [] : o.blocks.map((row) => ({ ...row, y: row.y + groundY - 63 }));
			return o;
		};
		body.blocksNear = async () => (feetY > 85 ? [{ blockId: 'minecraft:jungle_leaves', x: 0, y: feetY - 1, z: 0 }] : []);
		const act = body.act;
		body.act = async (type, args) => {
			if (type === 'break_block' && /_leaves$/.test(args.expectedBlockId ?? '')) { body.calls.push([type, args]); feetY = feetY - 1 > 85 ? feetY - 1 : groundY === null ? 40 : groundY + 1; return { state: 'SUCCEEDED' }; }
			return act(type, args);
		};
		await runObtain({ item: 'oak_planks', count: 4 }, body, { now: ticking() });
		const breaks = body.calls.filter(([type, args]) => type === 'break_block' && /_leaves$/.test(args.expectedBlockId ?? ''));
		assert.equal(breaks.length, 0, `ground ${groundY}: broke ${breaks.map(([, args]) => args.y).join(', ')}; fell to y ${feetY}`);
	}
});

test('scripted gate seed 2: a search stopped by a worn pickaxe does not use up one of the ore\'s tries', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8, cobblestone: 20 } });
	let searches = 0;
	const search = body.search;
	body.search = async (target, options) => {
		searches += 1;
		if (searches <= 5) { body.calls.push(['search', target, options]); return { state: 'FAILED', reasonCode: 'FIND_BLOCKED', message: 'The body cannot go on: TOOL_WORN (Stopped: Every hotbar tool for minecraft:granite has 2 or fewer uses left)' }; }
		return search(target, options);
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
});

test('scripted gate seed 3: a log search blocked for want of a pickaxe is a failed try, not a worn pickaxe searched again', async () => {
	const body = simulatedBody();
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); o.blocks = o.blocks.filter((row) => !/_log$/.test(row.blockId)); return o; };
	let logSearches = 0;
	body.search = async (target, options) => {
		body.calls.push(['search', target, options]);
		if (/_log$/.test(target.block ?? '')) logSearches += 1;
		return { state: 'FAILED', reasonCode: 'FIND_BLOCKED', message: 'The body cannot go on: NO_TOOL (Digging down toward y 76: Stopped: No hotbar tool can harvest minecraft:stone at 191,63,-287)' };
	};
	const result = await runObtain({ item: 'wooden_pickaxe', count: 1, timeoutMs: 600_000 }, body, { now: ticking() });
	assert.notEqual(result.state, 'SUCCEEDED');
	assert.ok(logSearches <= 3, `${logSearches} log searches`);
});

test('a whole kit plans as one: one iron need for every item, one table and the shared fuel', () => {
	const held = new Map([['stone_pickaxe', 1], ['furnace', 1], ['crafting_table', 1]]);
	const kit = planObtain({ ids: ['iron_pickaxe'], count: 1, also: [{ ids: ['shield'], count: 1 }, { ids: ['bucket'], count: 2 }, { ids: ['flint_and_steel'], count: 1 }] }, { held, seen: new Set() });
	const iron = kit.needs.filter((need) => need.accept.includes('raw_iron'));
	assert.equal(iron.length, 1);
	assert.equal(iron[0].count, 11);
	assert.equal(kit.fuel.smelts, 11);
	// The table carried serves every craft; none is made.
	assert.equal(kit.ops.some((op) => op.outputs.includes('crafting_table')), false);
	// One item at a time, the same kit is four plans that each count only their own iron.
	const alone = planObtain({ ids: ['bucket'], count: 2 }, { held, seen: new Set() });
	assert.equal(alone.needs.find((need) => need.accept.includes('raw_iron')).count, 6);
});

test('scripted gate seed 2: in a flooded stair, the move off an ore out of reach is back up the way the body came, not tunnels refused in the water', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	let water = false, searches = 0;
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); o.player.underWater = water; o.player.inWater = water; return o; };
	body.search = async (target, options) => {
		body.calls.push(['search', target, options]);
		searches += 1;
		const seen = searches <= 2 ? { x: 4, y: 20, z: 40, id: 'minecraft:iron_ore' } : { x: 1, y: 63, z: 1, id: 'minecraft:iron_ore' };
		return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: `Found: ${seen.id}`, find: { seen } };
	};
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'travel_to' && args.retrace) { body.calls.push([type, args]); water = false; return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }; }
		if (type === 'travel_to' && args.y === 20) { body.calls.push([type, args]); water = true; return { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Could not get out of the water in 30 s' }; }
		if (type === 'dig_to' && water) { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'The body is under water' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const order = body.calls.map(([type, args]) => (type === 'travel_to' && args.retrace ? 'retrace' : type === 'dig_to' && args.heading ? 'tunnel-off' : type));
	assert.ok(order.includes('retrace'), order.join(' '));
	assert.ok(!order.includes('tunnel-off'), order.join(' '));
});

test('scripted gate seed 1: soil deeper than one dig down: dig on down until stone shows, not a walk that wears the pickaxe out', async () => {
	const body = simulatedBody({ start: { wooden_pickaxe: 1, crafting_table: 1, stick: 4, oak_planks: 4 } });
	const observe = body.observe;
	body.observe = async () => {
		const o = await observe();
		if (o.player.y <= 52) o.blocks.push({ blockId: 'minecraft:stone', x: Math.floor(o.player.x) + 1, y: Math.floor(o.player.y), z: Math.floor(o.player.z) });
		return o;
	};
	const result = await runObtain({ item: 'stone_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const digs = body.calls.filter(([type, args]) => type === 'dig_to' && args.pattern === 'stairs_down').map(([, args]) => args.y);
	assert.deepEqual(digs, [58, 52], 'two digs down, the second because only soil showed');
	assert.equal(body.calls.some(([type, args]) => type === 'travel_to' && args.distance === 24), false, 'no walk off to look for stone');
});

test('a placed cobblestone block seen earlier (seen-resource model) is the stone source: no dig down (the 22 Nov village playtest)', async () => {
	const body = simulatedBody({ start: { wooden_pickaxe: 1, crafting_table: 1, stick: 4, oak_planks: 4 } });
	const observe = body.observe, mine = body.mine;
	const well = new Set(['6,64,2', '7,64,2', '6,64,3', '7,64,3']);
	body.observe = async () => {
		const o = await observe();
		const left = [...well].map((key) => { const [x, y, z] = key.split(',').map(Number); return { id: 'minecraft:cobblestone', kind: 'block', x, y, z, count: well.size, distance: 6,
			seenAt: 1, source: 'sighted', dimension: 'minecraft:overworld', placed: true }; });
		return { ...o, seenResources: left };
	};
	body.mine = async (args) => {
		const key = `${args.x},${args.y},${args.z}`;
		if (well.has(key)) { well.delete(key); body.inv.set('cobblestone', (body.inv.get('cobblestone') ?? 0) + 1); body.calls.push(['mine', args]); return { state: 'SUCCEEDED' }; }
		if (args.vein) { for (const cell of [...well]) { well.delete(cell); body.inv.set('cobblestone', (body.inv.get('cobblestone') ?? 0) + 1); } body.calls.push(['mine', args]); return { state: 'SUCCEEDED' }; }
		return mine(args);
	};
	const result = await runObtain({ item: 'stone_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.calls.some(([type, args]) => type === 'dig_to' && args.pattern === 'stairs_down'), false, 'no dig down for stone');
	const walk = body.calls.findIndex(([type, args]) => type === 'travel_to' && Math.floor(args.x) === 6 && Math.floor(args.z) === 2);
	assert.ok(walk >= 0, 'walked to the seen cobblestone');
	assert.equal(body.calls[walk + 1]?.[0], 'gather', 'and took it there');
});

test('scripted gate seed 8: drops out of view after a vein: look at where the ore was, then pick them up, not a search for another vein', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	let drop = null, lookedAt = null;
	body.mine = async (args) => { body.calls.push(['mine', args]); if (args.vein) drop = { stableId: 'raw-8', itemId: 'minecraft:raw_iron', x: args.x + 0.5, y: args.y, z: args.z + 0.5 }; return { state: 'SUCCEEDED' }; };
	const observe = body.observe;
	// The drop is in the sample only once the body has looked toward it.
	body.observe = async () => { const o = await observe(); if (drop && lookedAt) o.items = [drop]; return o; };
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'look_at') { body.calls.push([type, args]); lookedAt = args; return { state: 'SUCCEEDED' }; }
		if (type === 'pick_up_item') { body.calls.push([type, args]); body.inv.set('raw_iron', 8); drop = null; return { state: 'SUCCEEDED' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.calls.filter(([type, args]) => type === 'mine' && args.vein).length, 1, 'one vein');
	assert.equal(body.calls.filter(([type]) => type === 'search').length, 1, 'no second search');
	assert.ok(lookedAt !== null, 'looked toward the mined ore');
});

test('scripted gate seed 3: no stone in view on a ruined portal: step off the magma before digging down into the stone', async () => {
	const body = simulatedBody({ start: { wooden_pickaxe: 1, crafting_table: 1, stick: 4, oak_planks: 4 } });
	let moved = false;
	body.blocksNear = async () => [{ blockId: moved ? 'minecraft:grass_block' : 'minecraft:magma_block', x: 0, y: 63, z: 0 }];
	const act = body.act;
	body.act = async (type, args) => { if (type === 'travel_to' && args.distance === 8) moved = true; return act(type, args); };
	const result = await runObtain({ item: 'stone_pickaxe', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const order = body.calls.map(([type, args]) => (type === 'travel_to' && args.distance === 8 ? 'aside' : type === 'dig_to' ? 'dig' : type));
	assert.ok(order.indexOf('aside') !== -1 && order.indexOf('aside') < order.indexOf('dig'), order.join(' '));
});

test('scripted gate seed 1: a vein\'s drops left in its pocket out of view: walk into the pocket for them, not a search for another vein', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	let pocket = null;
	body.mine = async (args) => { body.calls.push(['mine', args]); if (args.vein) pocket = args; return { state: 'SUCCEEDED', reasonCode: 'VEIN_MINED', message: 'mined: 6 minecraft:iron_ore in 7.8 s; no seen block of it is left' }; };
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'navigate_to' && pocket && args.x === pocket.x + 0.5 && args.z === pocket.z + 0.5 && args.tolerance < 1) { body.calls.push([type, args]); body.inv.set('raw_iron', 6); return { state: 'SUCCEEDED' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.calls.filter(([type, args]) => type === 'mine' && args.vein).length, 1, 'one vein');
	assert.equal(body.calls.filter(([type]) => type === 'search').length, 1, 'no second search');
});

test('local scripted seed 2: an ore out of reach takes the rest of its vein with it, for obtain and for find', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	const observe = body.observe;
	// One vein across a cave, in view and never reached; find points at another vein once told the first is out of reach.
	body.observe = async () => { const o = await observe(); o.blocks.push({ blockId: 'minecraft:iron_ore', x: 12, y: 50, z: 0 }, { blockId: 'minecraft:iron_ore', x: 12, y: 50, z: 1 }, { blockId: 'minecraft:iron_ore', x: 13, y: 51, z: 1 }); return o; };
	const missed = [];
	body.missPlace = (place, why) => missed.push({ ...place, why });
	const act = body.act;
	body.act = async (type, args) => {
		if ((type === 'travel_to' || type === 'dig_to') && args.x >= 11 && args.x <= 14 && args.z <= 2) { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'NO_ROUTE' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.deepEqual(missed.map((row) => `${row.x},${row.y},${row.z} ${row.why}`).sort(), ['12,50,0 unreachable', '12,50,1 unreachable', '13,51,1 unreachable'], 'the vein\'s known cells, for find');
	assert.equal(body.calls.filter(([type, args]) => type === 'travel_to' && args.x >= 11 && args.x <= 14 && args.z <= 2).length, 1, 'one try at the vein, not one per cell');
});

test('review of e247fdec: a separate vein near one out of reach, not joined to it, is still a pick', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	const observe = body.observe;
	// The vein across the cave at z 0-1; another on the body's own side at z 4, 3 blocks from it, no ore between.
	body.observe = async () => { const o = await observe(); o.blocks.push({ blockId: 'minecraft:iron_ore', x: 8, y: 50, z: 0 }, { blockId: 'minecraft:iron_ore', x: 8, y: 50, z: 1 }, { blockId: 'minecraft:iron_ore', x: 8, y: 50, z: 4 }); return o; };
	const act = body.act;
	body.act = async (type, args) => {
		if ((type === 'travel_to' || type === 'dig_to') && args.x >= 7 && args.x <= 9 && args.z <= 2) { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'NO_ROUTE' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const veins = body.calls.filter(([type, args]) => type === 'mine' && args.vein).map(([, args]) => `${args.x},${args.y},${args.z}`);
	assert.deepEqual(veins, ['8,50,4'], 'the near vein is mined, not hidden by the far one');
	assert.equal(body.calls.filter(([type]) => type === 'search').length, 0, 'no search past it');
});

test('review of e247fdec: a pickaxe worn out at a vein marks nothing out of reach; the same vein is mined with the next one', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	const missed = [];
	body.missPlace = (place, why) => missed.push({ ...place, why });
	const mine = body.mine;
	let veins = 0;
	body.mine = async (args) => (args.vein && veins++ === 0 ? (body.calls.push(['mine', args]), { state: 'FAILED', reasonCode: 'TOOL_WORN', message: 'Every hotbar tool for minecraft:iron_ore has 2 or fewer uses left' }) : mine(args));
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.deepEqual(missed, [], 'nothing out of reach');
	const tries = body.calls.filter(([type, args]) => type === 'mine' && args.vein).map(([, args]) => `${args.x},${args.y},${args.z}`);
	assert.deepEqual(tries, ['4,20,4', '4,20,4'], 'the same vein again');
});

test('local scripted seed 2: an ore that mines nothing from beside it goes out of the searches with its vein', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	const missed = [];
	body.missPlace = (place, why) => missed.push({ ...place, why });
	const mine = body.mine;
	let veins = 0;
	body.mine = async (args) => (args.vein && veins++ < 2 ? (body.calls.push(['mine', args]), { state: 'FAILED', reasonCode: 'NOTHING_MINED' }) : mine(args));
	// find, as the runtime runs it, leaves a missed vein out and reports the next one.
	body.search = async (target) => {
		body.calls.push(['search', target]);
		const seen = missed.some((row) => row.x === 4) ? { x: 30, y: 20, z: 30, id: 'minecraft:iron_ore' } : { x: 4, y: 20, z: 4, id: 'minecraft:iron_ore' };
		return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: `Found: ${seen.id}`, find: { seen } };
	};
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.deepEqual(missed.map((row) => [row.x, row.y, row.z, row.why]), [[4, 20, 4, 'unreachable']]);
	assert.equal(body.calls.filter(([type]) => type === 'search').length, 2, 'the next search finds the next vein');
});

test('local scripted seed 4: a dig for stone that meets water walks away from the water and digs again, without spending a try', async () => {
	const body = simulatedBody({ start: { wooden_pickaxe: 1, crafting_table: 1, stick: 4, oak_planks: 4 } });
	const observe = body.observe;
	let digs = 0;
	body.observe = async () => {
		const o = await observe();
		if (digs >= 3 && o.player.y <= 58) o.blocks.push({ blockId: 'minecraft:stone', x: Math.floor(o.player.x) + 1, y: Math.floor(o.player.y), z: Math.floor(o.player.z) });
		return o;
	};
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'dig_to' && args.pattern === 'stairs_down' && ++digs < 3) {
			body.calls.push([type, args]);
			return { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: Water at -2,62,0 beside the opened cell -1,62,0; water on 3 sides of it' };
		}
		return act(type, args);
	};
	const result = await runObtain({ item: 'stone_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const walks = body.calls.filter(([type, args]) => type === 'travel_to' && args.distance === 16);
	assert.equal(walks.length, 2, 'one walk away per wet dig');
	assert.ok(walks.every(([, args]) => Math.abs(args.yaw + 90) <= 1), `away from the water to the west: east (${walks.map(([, args]) => args.yaw)})`);
	assert.equal(body.calls.some(([type, args]) => type === 'travel_to' && args.distance === 24), false, 'no random walk off');
	assert.equal(body.calls.filter(([type]) => type === 'gather').length, 1, 'one gather, at the stone');
});

test('farm seed 3: the best pickaxe in the hotbar but not in hand is taken in hand before the dig for ore', async () => {
	const body = simulatedBody({ start: { wooden_pickaxe: 1, stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const order = body.calls.map(([type]) => type);
	const select = body.calls.find(([type]) => type === 'select_tool');
	assert.ok(select, order.join(' '));
	assert.deepEqual([select[1].sourceSlot, select[1].hotbarSlot, select[1].expectedItemId], [1, 1, 'minecraft:stone_pickaxe']);
	assert.ok(order.indexOf('select_tool') < order.indexOf('mine'), 'before the vein');
});

test('farm seed 6 (721d9afd): a tunnel to the ore stopped by a worn pickaxe or a mob marks nothing out of reach', async () => {
	for (const stop of ['TOOL_WORN', 'HOSTILE_NEAR']) {
		const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
		const missed = [];
		body.missPlace = (place, why) => missed.push({ ...place, why });
		const act = body.act;
		let stopped = 0;
		body.act = async (type, args) => {
			if ((type === 'travel_to' || type === 'dig_to') && args.x === 4.5 && stopped++ < 1) { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: stop }; }
			if (type === 'dig_to' && args.pattern === 'tunnel' && stopped === 1) { stopped++; body.calls.push([type, args]); return { state: 'FAILED', reasonCode: stop }; }
			return act(type, args);
		};
		const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
		assert.deepEqual(missed, [], `${stop}: nothing out of reach`);
		if (stop === 'HOSTILE_NEAR') { assert.equal(result.reasonCode, 'DANGER', 'the mob is handed back'); continue; }
		assert.equal(result.state, 'SUCCEEDED', result.message);
		assert.deepEqual(body.calls.filter(([type, args]) => type === 'mine' && args.vein).map(([, args]) => `${args.x},${args.y},${args.z}`), ['4,20,4'], `${stop}: the same vein, next round`);
	}
});

test('review of e247fdec: a near-broken pickaxe earlier in the inventory never replaces a sound one of its tier in hand', async () => {
	// The pickaxes held, in hand at selectedSlot; then the select_tool calls before the first vein.
	const selects = async (selectedSlot, rows) => {
		const body = simulatedBody({ start: { furnace: 1, crafting_table: 1, stick: 2, oak_planks: 8 } });
		const observe = body.observe;
		body.observe = async () => { const o = await observe(); o.inventory.selectedSlot = selectedSlot; o.inventory.items.push(...rows); return o; };
		const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: ticking() });
		assert.equal(result.state, 'SUCCEEDED', result.message);
		return body.calls.filter(([type]) => type === 'select_tool').map(([, args]) => args.sourceSlot);
	};
	const stone = (slot, usesLeft) => ({ itemId: 'minecraft:stone_pickaxe', count: 1, slot, damage: 131 - usesLeft, maxDamage: 131 });
	assert.deepEqual(await selects(3, [stone(0, 6), stone(3, 120)]), [], 'a sound one in hand stays there; slot 0 has 6 uses');
	assert.deepEqual(await selects(3, [{ itemId: 'minecraft:iron_pickaxe', count: 1, slot: 0, damage: 245, maxDamage: 250 }, stone(3, 120)]), [], 'nor for a better tier about to break');
	assert.deepEqual(await selects(5, [stone(1, 120), stone(5, 30)]), [1], 'of two sound ones in a tier, the one with more uses');
	assert.deepEqual(await selects(3, [stone(0, 6), { itemId: 'minecraft:wooden_pickaxe', count: 1, slot: 3, damage: 1, maxDamage: 59 }]), [], 'a sound wooden one over a stone one about to break');
});

// Gate games gate2B-1, -3, -6 and -8: obtain water_bucket answered NO_SUCH_ITEM (no recipe or drop gives one).
test('water_bucket: an empty bucket first, then filled at water the search found', async () => {
	const body = simulatedBody({ start: { iron_ingot: 3, crafting_table: 1 } });
	const water = { x: 10, y: 63, z: 10 };
	const search = body.search, act = body.act;
	body.search = async (target, options) => {
		if (!/water/.test(target.block ?? '')) return search(target, options);
		body.calls.push(['search', target]);
		return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: 'Found: water', find: { seen: { ...water, id: 'minecraft:water' } } };
	};
	body.act = async (type, args) => {
		if (type === 'select_item' || type === 'select_tool') { body.calls.push([type, args]); return { state: 'SUCCEEDED' }; }
		if (type !== 'use_item') return act(type, args);
		body.calls.push([type, args]);
		if (!(body.inv.get('bucket') > 0) || args.expectedItemId !== 'minecraft:bucket') return { state: 'FAILED', reasonCode: 'NO_BUCKET' };
		body.inv.set('bucket', body.inv.get('bucket') - 1);
		body.inv.set('water_bucket', (body.inv.get('water_bucket') ?? 0) + 1);
		return { state: 'SUCCEEDED' };
	};
	const result = await runObtain({ item: 'minecraft:water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.inv.get('water_bucket'), 1);
	const order = body.calls.map(([type]) => type);
	assert.ok(order.indexOf('craft_table') < order.indexOf('search'), 'the bucket is made before the water is looked for');
	assert.deepEqual(body.calls.find(([type]) => type === 'use_item')[1], { durationMs: 1000, mode: 'once', expectedItemId: 'minecraft:bucket', aimX: 10.5, aimY: 63.5, aimZ: 10.5 });
});

test('water_bucket with no water anywhere hands back stuck, naming the search', async () => {
	const body = simulatedBody({ start: { bucket: 1 } });
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'FAILED');
	assert.equal(result.reasonCode, 'NO_SOURCE');
	assert.match(result.message, /no water found \(FIND_NOT_FOUND/);
});

test('batch 2: a water search stopped by a worn pickaxe ends the call with the tool stop at once, not another round', async () => {
	for (const [message, code] of [
		['The body cannot go on: TOOL_WORN (Stopped: Every hotbar tool for minecraft:stone has 2 or fewer uses left. At -612,62,-97, stairs_up heading west)', 'TOOL_WORN'],
		['No way on from here: 8 heading(s) blocked (last: NO_ROUTE: No seen way on toward the target, and building cannot continue: minecraft:stone at 557,67,114 takes 7', 'NO_TOOL'],
	]) {
		const body = simulatedBody({ start: { bucket: 1 } });
		let searches = 0;
		body.search = async () => { searches += 1; return { state: 'FAILED', reasonCode: 'FIND_BLOCKED', message }; };
		const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
		assert.equal(result.reasonCode, code, result.message);
		assert.equal(searches, 1, 'one search, then the tool stop goes back');
		assert.match(result.message, /replace or equip a usable tool/);
	}
	const body = simulatedBody({ start: { bucket: 1 } });
	let searches = 0;
	body.search = async () => { searches += 1; return { state: 'FAILED', reasonCode: 'FIND_BLOCKED', message: 'No way on from here: water under this spot stops every dig down' }; };
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.reasonCode, 'NO_SOURCE');
	assert.ok(searches > 1);
});

test('gate2B-6: two buckets right after the iron pickaxe, no ore in view: mine raw iron, never smelt the pickaxe down for nuggets', () => {
	const plan = planObtain({ ids: ['bucket'], count: 2 }, { held: new Map([['iron_pickaxe', 1], ['stone_pickaxe', 1], ['furnace', 1], ['crafting_table', 1], ['cobblestone', 40]]), seen: new Set() });
	assert.deepEqual(plan.unreachable, []);
	assert.equal(plan.needs.find((row) => row.accept.includes('raw_iron'))?.count, 6);
});

test('scripted chain gate seed 1: health lost while waiting on a smelt ends obtain as danger, not a wait on under fire', async () => {
	const body = simulatedBody({ start: { raw_iron: 3, furnace: 1, oak_planks: 8, stick: 2, crafting_table: 1 } });
	let hit = false;
	const act = body.act, observe = body.observe;
	body.act = async (type, args) => { if (type === 'wait') { body.calls.push([type, args]); hit = true; return { state: 'SUCCEEDED' }; } return act(type, args); };
	body.observe = async () => { const o = await observe(); return hit ? { ...o, player: { ...o.player, health: 13 } } : o; };
	const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { index });
	assert.equal(result.state, 'INTERRUPTED', result.message);
	assert.match(result.message, /health 20 -> 13 while waiting at the furnace/);
	assert.ok(body.calls.filter(([type]) => type === 'wait').every(([, args]) => args.durationMs <= 5_000));
	assert.equal(body.calls.filter(([type]) => type === 'wait').length, 1, 'no further waits after the hit');
});

// Review of the smelt wait: an arrow during the wait ended obtain with the raw iron in the furnace; the next call planned
// from the inventory (no iron, no ingots) and dug for the ore again while the ingots sat in the furnace it placed.
test('a smelt danger cut short leaves its load for the next call, which takes the output before planning', async () => {
	const body = simulatedBody({ start: { raw_iron: 3, furnace: 1, oak_planks: 8, stick: 2, crafting_table: 1 } });
	let hurting = true, hit = false;
	const act = body.act, observe = body.observe;
	body.act = async (type, args) => { if (type === 'wait') { body.calls.push([type, args]); if (hurting) hit = true; return { state: 'SUCCEEDED' }; } return act(type, args); };
	body.observe = async () => { const o = await observe(); return hit ? { ...o, player: { ...o.player, health: 18 } } : o; };
	const placed = [], loads = [];
	const first = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { index, placed, loads });
	assert.equal(first.state, 'INTERRUPTED', first.message);
	assert.equal(loads.length, 1, 'the loaded furnace is kept for the next call');
	hurting = false; hit = false;
	const from = body.calls.length;
	const second = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { index, placed, loads });
	assert.equal(second.state, 'SUCCEEDED', second.message);
	const after = body.calls.slice(from).map(([type, args]) => (type === 'furnace_transaction' ? args.operation : type));
	assert.ok(after.indexOf('take_output') !== -1, after.join(' '));
	assert.ok(!after.includes('search') && !after.includes('mine') && !after.includes('load'), `no new ore or load: ${after.join(' ')}`);
	assert.equal(loads.length, 0);
});

// Review of the water fill: a walk back out that failed was ignored, and obtain answered a clean OBTAINED from the water.
function wetFill(body, { startWet = false, seen = { x: 10, y: 63, z: 10 }, searchEndsIn = false, walkOut = false, drains = false, puddle = false } = {}) {
	let wet = startWet, drained = false;
	const search = body.search, act = body.act, observe = body.observe;
	body.search = async (target, options) => {
		if (!/water/.test(target.block ?? '')) return search(target, options);
		body.calls.push(['search', target]);
		// The search's own legs carried the body into the water beside the source.
		if (searchEndsIn) { await act('travel_to', { x: seen.x - 1, y: seen.y, z: seen.z }); wet = true; }
		return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: 'Found: water', find: { seen: { ...seen, id: 'minecraft:water' } } };
	};
	body.act = async (type, args) => {
		if (type === 'select_item' || type === 'select_tool') { body.calls.push([type, args]); return { state: 'SUCCEEDED' }; }
		if (type === 'travel_to' && (args.build === false || args.retrace === true) && args.y !== undefined && body.inv.get('water_bucket') > 0) {
			if (walkOut) { const r = await act(type, args); wet = false; return r; }
			body.calls.push([type, args]);
			return { state: 'FAILED', reasonCode: 'NO_ROUTE' };
		}
		if (type === 'travel_to' && args.y !== undefined) { const r = await act(type, args); wet = true; return r; }
		if (type !== 'use_item') return act(type, args);
		body.calls.push([type, args]);
		body.inv.set('bucket', body.inv.get('bucket') - 1);
		body.inv.set('water_bucket', (body.inv.get('water_bucket') ?? 0) + 1);
		// drains: the emptied source was the only water cell the body touched; the next sample shows it dry, once.
		drained = drains;
		// puddle: the emptied source was all the water there was; the body is dry from here on.
		if (puddle) wet = false;
		return { state: 'SUCCEEDED' };
	};
	body.observe = async () => {
		const o = await observe();
		const flicker = drained && wet;
		drained = false;
		return { ...o, player: { ...o.player, inWater: wet && !flicker } };
	};
	return body;
}

test('water_bucket filled but the walk back out fails: the result says the body is still in the water and why', async () => {
	const body = wetFill(simulatedBody({ start: { bucket: 1 } }));
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(result.inWater, true);
	assert.match(result.message, /still in the water at .*walk back to dry ground at 0,64,0 ended NO_ROUTE.*find and dig_to refuse/);
});

test('water_bucket filled from the water with no dry ground stood on: no walk out, and the result says so', async () => {
	const body = wetFill(simulatedBody({ start: { bucket: 1 } }), { startWet: true });
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.match(result.message, /still in the water .*not stood on dry ground during this obtain/);
	const filled = body.calls.findIndex(([type]) => type === 'use_item');
	assert.ok(!body.calls.slice(filled).some(([type]) => type === 'travel_to'), 'no walk to a made-up dry spot after the fill');
});

// Review of the 32-block cap on the walk out: the last dry spot is refreshed only by obtain's own observes, so after a
// walk of more than 32 blocks to the water it was where that walk began, and the cap left the body in the lake (the
// kit-chain case of gate seed 4, a 50-block walk). The walk's own start is always a way back.
test('water_bucket filled after a walk of more than 32 blocks to the water: the body walks back to where that walk began', async () => {
	const body = wetFill(simulatedBody({ start: { bucket: 1 } }), { seen: { x: 40, y: 63, z: 40 }, walkOut: true });
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.notEqual(result.inWater, true, result.message);
	const filled = body.calls.findIndex(([type]) => type === 'use_item');
	const back = body.calls.slice(filled).find(([type]) => type === 'travel_to');
	assert.deepEqual(back?.[1] && { x: back[1].x, y: back[1].y, z: back[1].z, build: back[1].build }, { x: 0.5, y: 64, z: 0.5, build: false });
});

test('water_bucket filled on a second try from the water after a long walk: still walks back to where the walk began', async () => {
	const body = wetFill(simulatedBody({ start: { bucket: 1 } }), { seen: { x: 40, y: 63, z: 40 }, walkOut: true });
	// The lake in view: the second try takes the next source in reach, no search.
	body.blocksNear = async () => [40, 41].map((z) => ({ blockId: 'minecraft:water', x: 40, y: 63, z, state: { level: '0' } }));
	const act = body.act;
	let clicks = 0;
	body.act = async (type, args) => {
		if (type === 'use_item' && ++clicks === 1) { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'NO_EFFECT' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.notEqual(result.inWater, true, result.message);
	assert.equal(clicks, 2);
	assert.ok(!body.calls.some(([type]) => type === 'search'), 'no search');
});

// Review runs of gate seed 4 (farm water4-b, water4-c): the body stood in, or floated over, the very source it emptied,
// so the sample just after the fill showed it dry; obtain skipped the walk out, and the lake flowed back round it.
test('water_bucket filled from the source the body stood in: the lake beside it flows back, so it still walks out', async () => {
	const body = wetFill(simulatedBody({ start: { bucket: 1 } }), { seen: { x: 40, y: 63, z: 40 }, walkOut: true, drains: true });
	body.blocksNear = async () => [{ blockId: 'minecraft:water', x: 41, y: 63, z: 40, state: { level: '1' } }];
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.notEqual(result.inWater, true, result.message);
	const filled = body.calls.findIndex(([type]) => type === 'use_item');
	const back = body.calls.slice(filled).find(([type]) => type === 'travel_to');
	assert.deepEqual(back?.[1] && { x: back[1].x, z: back[1].z }, { x: 0.5, z: 0.5 }, 'the walk back to where the walk began');
});

test('water_bucket filled from a lone puddle the body stood in: no water beside it, so no walk out', async () => {
	const body = wetFill(simulatedBody({ start: { bucket: 1 } }), { seen: { x: 40, y: 63, z: 40 }, walkOut: true, puddle: true });
	body.blocksNear = async () => [];
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const filled = body.calls.findIndex(([type]) => type === 'use_item');
	assert.ok(!body.calls.slice(filled).some(([type]) => type === 'travel_to'), 'no walk back from a puddle that is gone');
});

test('water_bucket filled where a find search ended in the water: no walk back to a dry spot from before the search', async () => {
	const body = wetFill(simulatedBody({ start: { bucket: 1 } }), { seen: { x: 40, y: 63, z: 40 }, searchEndsIn: true, walkOut: true });
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(result.inWater, true);
	assert.match(result.message, /still in the water .*find search ended in the water.*more than 32 blocks back/);
	const filled = body.calls.findIndex(([type]) => type === 'use_item');
	assert.ok(filled !== -1 && !body.calls.slice(filled).some(([type]) => type === 'travel_to'), 'no 60 s walk to a dry spot from before the search');
});

// Lane: water from underground. Farm runs 628183eb and fb2bfeb3 (gate seeds 4 and 7): climbs met aquifers with the body
// standing in the water, and every fill aimed at a source beside it was TARGET_OBSTRUCTED (19 calls).
test('water_bucket from inside an aquifer: the cell the body stands in is scooped first, with no search', async () => {
	const body = simulatedBody({ start: { bucket: 1 } });
	const act = body.act, observe = body.observe;
	body.observe = async () => { const o = await observe(); return { ...o, player: { ...o.player, inWater: true, underWater: true, skyOpen: false } }; };
	body.act = async (type, args) => {
		if (type === 'select_item' || type === 'select_tool') { body.calls.push([type, args]); return { state: 'SUCCEEDED' }; }
		if (type !== 'use_item') return act(type, args);
		body.calls.push([type, args]);
		if (args.aimY !== 65.5) return { state: 'FAILED', reasonCode: 'TARGET_OBSTRUCTED' };
		body.inv.set('bucket', 0); body.inv.set('water_bucket', 1);
		return { state: 'SUCCEEDED', reasonCode: 'USE_INPUT_CONFIRMED' };
	};
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.held, 1, result.message);
	assert.deepEqual(body.calls.filter(([type]) => type === 'use_item').map(([, args]) => [args.aimX, args.aimY, args.aimZ]), [[0.5, 65.5, 0.5]], 'the eye cell first');
	assert.ok(!body.calls.some(([type]) => type === 'search'), 'no search');
});

// Local scripted seed 7 from y56 (main 0c689437): six clicks at two sources, each on one named face, all
// TARGET_OBSTRUCTED, across rounds with a search between them.
test('water_bucket with sources in reach: each is tried in one round, the next after one the ray cannot meet', async () => {
	const body = simulatedBody({ start: { bucket: 1 } });
	body.blocksNear = async () => [{ blockId: 'minecraft:water', x: 2, y: 64, z: 0, state: { level: '0' } }, { blockId: 'minecraft:water', x: 2, y: 64, z: 1, state: { level: '0' } },
		{ blockId: 'minecraft:water', x: 1, y: 64, z: 2, state: { level: '4' } }];
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'select_item' || type === 'select_tool') { body.calls.push([type, args]); return { state: 'SUCCEEDED' }; }
		if (type !== 'use_item') return act(type, args);
		body.calls.push([type, args]);
		if (args.aimZ === 0.5) return { state: 'FAILED', reasonCode: 'TARGET_OBSTRUCTED', message: 'No part of the minecraft:water source at 2,64,0 is the first thing the bucket ray meets' };
		body.inv.set('bucket', 0); body.inv.set('water_bucket', 1);
		return { state: 'SUCCEEDED', reasonCode: 'USE_INPUT_CONFIRMED' };
	};
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(result.rounds, 1);
	assert.deepEqual(body.calls.filter(([type]) => type === 'use_item').map(([, args]) => args.aimZ), [0.5, 1.5], 'the flowing cell is never aimed at');
	assert.ok(!body.calls.some(([type]) => type === 'search' || type === 'travel_to'));
});

test('water_bucket filled from the water with no dry ground stood on: out along the walked route to the last open sky', async () => {
	const body = wetFill(simulatedBody({ start: { bucket: 1 } }), { startWet: true, walkOut: true });
	body.openSky = () => ({ x: -20.5, y: 70, z: 3.5 });
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.notEqual(result.inWater, true, result.message);
	const filled = body.calls.findIndex(([type]) => type === 'use_item');
	const out = body.calls.slice(filled).find(([type]) => type === 'travel_to')?.[1];
	assert.deepEqual(out && { x: out.x, y: out.y, z: out.z, retrace: out.retrace }, { x: -20.5, y: 70, z: 3.5, retrace: true });
});

test('water_bucket: a plant the bucket ray meets first is broken and the same source tried again', async () => {
	const body = simulatedBody({ start: { bucket: 1 } });
	body.blocksNear = async () => [{ blockId: 'minecraft:water', x: 2, y: 64, z: 0, state: { level: '0' } }];
	const act = body.act;
	let grass = true;
	body.act = async (type, args) => {
		if (type === 'select_item' || type === 'select_tool') { body.calls.push([type, args]); return { state: 'SUCCEEDED' }; }
		if (type === 'break_block' && args.expectedBlockId === 'minecraft:tall_grass') { body.calls.push([type, args]); grass = false; return { state: 'SUCCEEDED' }; }
		if (type !== 'use_item') return act(type, args);
		body.calls.push([type, args]);
		if (grass) return { state: 'FAILED', reasonCode: 'USE_NOT_ACCEPTED', message: 'The bucket did not act; its ray met minecraft:tall_grass at 0,65,0 face down (0.0 m); hand minecraft:bucket -> minecraft:bucket' };
		body.inv.set('bucket', 0); body.inv.set('water_bucket', 1);
		return { state: 'SUCCEEDED', reasonCode: 'USE_INPUT_CONFIRMED' };
	};
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.deepEqual(body.calls.filter(([type]) => type === 'use_item' || type === 'break_block').map(([type, args]) => (type === 'break_block' ? `break ${args.x},${args.y},${args.z}` : `use ${args.aimX}`)),
		['use 2.5', 'break 0,65,0', 'use 2.5']);
});

test('review of PR #197: a walk to water that ends out of reach marks that spot for find, not the lake joined to it', async () => {
	for (const stop of ['TIMED_OUT', 'NO_ROUTE', 'HOSTILE_NEAR']) {
		const body = simulatedBody({ start: { bucket: 1 } });
		const missed = [];
		body.missPlace = (place, why) => missed.push({ ...place, why });
		const search = body.search, act = body.act;
		body.search = async (target, options) => {
			if (!/water/.test(target.block ?? '')) return search(target, options);
			body.calls.push(['search', target]);
			return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: 'Found: water', find: { seen: { x: 80, y: 62, z: 0, id: 'minecraft:water' } } };
		};
		body.act = async (type, args) => {
			if (type === 'travel_to' && args.x === 80.5) { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: stop }; }
			return act(type, args);
		};
		await runObtain({ item: 'water_bucket', count: 1, timeoutMs: 60_000 }, body, { index, now: ticking() });
		const marks = [...new Set(missed.map((row) => `${row.x},${row.y},${row.z} ${row.why}`))];
		assert.deepEqual(marks, stop === 'HOSTILE_NEAR' ? [] : ['80,62,0 unreachable spot'], stop);
	}
});

// Batch 4 water step: fills aimed at flowing water (a find sighting, or the cells of a body standing in a stream) met the
// rock behind it, and find kept stopping at the same cell. A body ARRIVED 3 above a lake was never in reach.
function waterSighting(seen, { flowing = [], wet = false, arrivedAbove = 0, miss = false } = {}) {
	const body = simulatedBody({ start: { bucket: 1 } });
	const missed = [];
	let feetY = null;
	body.missPlace = (place, why) => missed.push(`${place.x},${place.y},${place.z} ${why}`);
	body.blocksNear = async () => flowing.map(([x, y, z]) => ({ blockId: 'minecraft:water', x, y, z, state: { level: '1' } }));
	const search = body.search, act = body.act, observe = body.observe;
	body.search = async (target, options) => {
		if (!/water/.test(target.block ?? '')) return search(target, options);
		body.calls.push(['search', target]);
		return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: 'Found: water', find: { seen: { ...seen, id: 'minecraft:water' } } };
	};
	body.observe = async () => { const o = await observe(); return { ...o, player: { ...o.player, ...(feetY === null ? {} : { y: feetY }), inWater: wet } }; };
	body.act = async (type, args) => {
		if (type === 'select_item' || type === 'select_tool') { body.calls.push([type, args]); return { state: 'SUCCEEDED' }; }
		if (type === 'travel_to' && args.x === seen.x + 0.5) { const r = await act(type, args); if (arrivedAbove) feetY = args.y + arrivedAbove; return { ...r, reasonCode: 'ARRIVED' }; }
		if (type === 'dig_to' && args.pattern === 'shaft') { body.calls.push([type, args]); feetY = args.y; return { state: 'SUCCEEDED' }; }
		if (type !== 'use_item') return act(type, args);
		body.calls.push([type, args]);
		if (miss) return { state: 'FAILED', reasonCode: 'USE_NOT_ACCEPTED', message: 'The bucket did not act; its ray met minecraft:deepslate at 3,62,0 face up (2.0 m)' };
		body.inv.set('bucket', 0); body.inv.set('water_bucket', 1);
		return { state: 'SUCCEEDED', reasonCode: 'USE_INPUT_CONFIRMED' };
	};
	return { body, missed };
}
const aims = (body) => body.calls.filter(([type]) => type === 'use_item').map(([, args]) => `${args.aimX},${args.aimY},${args.aimZ}`);

test('batch 4 laptop seed 3: a sighting the rows show as flowing water is not clicked at, and find is told to pass it', async () => {
	const { body, missed } = waterSighting({ x: 3, y: 63, z: 0 }, { flowing: [[3, 63, 0]] });
	const result = await runObtain({ item: 'water_bucket', count: 1, timeoutMs: 60_000 }, body, { index, now: ticking() });
	assert.equal(result.state, 'FAILED', result.message);
	assert.deepEqual(aims(body), []);
	assert.ok(missed.includes('3,63,0 unreachable spot'), missed.join('; '));
});

test('boat batch 3 seed 5: a body standing in a stream does not click at its own cells', async () => {
	const { body } = waterSighting({ x: 3, y: 63, z: 0 }, { flowing: [[0, 64, 0], [0, 65, 0], [1, 64, 0], [3, 63, 0]], wet: true });
	await runObtain({ item: 'water_bucket', count: 1, timeoutMs: 60_000 }, body, { index, now: ticking() });
	assert.deepEqual(aims(body).filter((aim) => aim.startsWith('0.5,')), []);
});

test('batch 4 laptop seed 6: a fill whose ray passes the cell marks it for find, so the next search does not stop there', async () => {
	const { body, missed } = waterSighting({ x: 3, y: 63, z: 0 }, { miss: true });
	await runObtain({ item: 'water_bucket', count: 1, timeoutMs: 60_000 }, body, { index, now: ticking() });
	assert.equal(aims(body).length, 1, aims(body).join('; '));
	assert.ok(missed.includes('3,63,0 unreachable spot'), missed.join('; '));
});

test('boat batch 4 seed 8: a walk that ends ARRIVED 3 above the water digs down beside it, then fills', async () => {
	const { body } = waterSighting({ x: 20, y: 62, z: 0 }, { arrivedAbove: 3 });
	const result = await runObtain({ item: 'water_bucket', count: 1, timeoutMs: 60_000 }, body, { index, now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.deepEqual(body.calls.find(([type]) => type === 'dig_to')?.[1], { pattern: 'shaft', y: 64, maxBlocks: 8, throughCaves: 'small', timeoutMs: 20_000 });
	assert.deepEqual(aims(body), ['20.5,62.5,0.5']);
});

for (const plant of [false, true]) test(`fresh low air stops obstructed scoops before another use or plant clear: plant=${plant}`, async () => {
	const body = simulatedBody({ start: { bucket: 1 } });
	let air = 150;
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); return { ...o, player: { ...o.player, y: 16, underWater: true, inWater: true, air, maxAir: 300 } }; };
	body.blocksNear = async () => [1, 2, 3].flatMap(x => [0, 1].map(z => ({ blockId: 'minecraft:water', x, y: 16, z, state: { level: '0' } })));
	const beforeUses = [];
	body.act = async (type, args) => {
		body.calls.push([type, args]);
		if (type === 'use_item') { beforeUses.push(air); air -= 20; return { state: 'FAILED', reasonCode: 'USE_NOT_ACCEPTED', message: plant && air < 100 ? 'The bucket did not act; its ray met minecraft:tall_grass at 0,17,0 face down (0.0 m)' : 'obstructed' }; }
		return { state: 'SUCCEEDED' };
	};
	const result = await runObtain({ item: 'water_bucket', timeoutMs: 60_000 }, body, { index });
	assert.equal(result.reasonCode, 'DANGER', result.message);
	assert.equal(result.state, 'INTERRUPTED');
	assert.deepEqual(beforeUses, [150, 130, 110]);
	assert.equal(air, 90);
	assert.ok(!body.calls.some(([type]) => type === 'break_block' || type === 'travel_to' || type === 'control'));
});

test('fresh low air returns the scoop action still owned by the model', async () => {
	const body = simulatedBody({ start: { bucket: 1 } });
	let air = 150;
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); return { ...o, player: { ...o.player, air, maxAir: 300, underWater: true } }; };
	body.blocksNear = async () => [{ blockId: 'minecraft:water', x: 2, y: 64, z: 0, state: { level: '0' } }];
	body.act = async (type, args) => { body.calls.push([type, args]); if (type === 'use_item') { air = 90; return { state: 'RUNNING', actionId: 'owned-scoop', recoveryHint: 'cancel or await this action' }; } return { state: 'SUCCEEDED' }; };
	const result = await runObtain({ item: 'water_bucket' }, body, { index });
	assert.equal(result.reasonCode, 'DANGER');
	assert.deepEqual(result.running, { actionId: 'owned-scoop', recoveryHint: 'cancel or await this action' });
	assert.equal(body.calls.filter(([type]) => type === 'use_item').length, 1);
});

// Script-first heal spot run 3: the beef obtain at health 5-6 ended LOW_HEALTH before the hunt, so the body never ate.
const lowHealth = (body, health = 5) => { const observe = body.observe; body.observe = async () => { const o = await observe(); return { ...o, player: { ...o.player, health } }; }; return body; };
const clock = () => { let t = 0; return () => (t += 100); };

test('food at health 5: the low-health line does not stop the obtain, and the hunt bails at the next hit, not at once', async () => {
	const body = lowHealth(simulatedBody());
	const result = await runObtain({ item: 'minecraft:beef', count: 5 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const hunts = body.calls.filter(([type]) => type === 'fight_until');
	assert.ok(hunts.length > 0 && hunts.every(([, args]) => args.fleeAtHealth === 4), JSON.stringify(hunts));
});

/**
 * simulatedBody with the survival facts obtain's recovery reads: health, food bar and saturation, canHealNow and
 * bestFood from the carried food (foodSlot moves it to that slot), the regeneration gamerule, and eating and
 * regeneration as the game does them in outline: use_item on held food fills the bar, a wait at food 18+ heals 1 a second.
 */
const FOOD_NUTRITION = { bread: 5, cooked_beef: 8, apple: 4, golden_apple: 4 };
function survivalBody({ start = {}, health = 5, foodLevel = 10, saturation = 0, foodSlot = null, regen = true, threats = [], usingItem = false, waitHurts = 0, noHeal = false, fail = null } = {}) {
	const body = simulatedBody({ start });
	const state = { health, foodLevel, saturation, held: null, usingItem };
	const observe = body.observe;
	body.state = state;
	body.recoveringStates = [];
	body.recovering = (value) => body.recoveringStates.push(value);
	body.observe = async () => {
		const o = await observe();
		const items = o.inventory.items.map((row) => (foodSlot !== null && bare(row.itemId) in FOOD_NUTRITION ? { ...row, slot: foodSlot } : row));
		const food = items.find((row) => bare(row.itemId) in FOOD_NUTRITION);
		const bestFood = food ? { slot: food.slot, itemId: food.itemId, nutrition: FOOD_NUTRITION[bare(food.itemId)], ...(bare(food.itemId) === 'golden_apple' ? { alwaysEdible: true } : {}) } : null;
		const safe = threats.length === 0;
		return { ...o, inventory: { ...o.inventory, items }, interaction: { usingItem: state.usingItem },
			player: { ...o.player, health: state.health, foodLevel: state.foodLevel, saturation: state.saturation, threats,
				bestFood, safe, canHealNow: state.health < 20 && bestFood !== null && safe && (state.foodLevel < 20 || bestFood.alwaysEdible === true) },
			world: { dimension: 'minecraft:overworld', difficulty: 'normal', naturalRegeneration: regen } };
	};
	const act = body.act;
	body.act = async (type, args) => {
		if (type === fail) { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'ACTION_FAILED', message: `${type} failed` }; }
		if (type === 'select_item') { body.calls.push([type, args]); state.held = bare(args.itemId); return { state: 'SUCCEEDED' }; }
		if (type === 'select_tool') { body.calls.push([type, args]); state.held = bare(args.expectedItemId); return { state: 'SUCCEEDED' }; }
		if (type === 'use_item') {
			body.calls.push([type, args]);
			const item = state.held;
			if (!(item in FOOD_NUTRITION) || !(body.inv.get(item) > 0) || bare(args.expectedItemId) !== item) return { state: 'FAILED', reasonCode: 'NOT_FOOD' };
			body.inv.set(item, body.inv.get(item) - 1);
			state.foodLevel = Math.min(20, state.foodLevel + FOOD_NUTRITION[item]);
			state.saturation = Math.min(state.foodLevel, state.saturation + FOOD_NUTRITION[item] * 1.2);
			return { state: 'SUCCEEDED' };
		}
		if (type === 'wait') {
			body.calls.push([type, args]);
			state.usingItem = false;
			if (waitHurts > 0) { state.health -= waitHurts; return { state: 'SUCCEEDED' }; }
			if (regen && !noHeal && state.foodLevel >= 18) {
				const healed = Math.min(Math.floor(args.durationMs / 1000), 20 - state.health, Math.floor((state.saturation + state.foodLevel - 17) / 1.5));
				state.health += healed; state.saturation = Math.max(0, state.saturation - healed * 1.5);
			}
			return { state: 'SUCCEEDED' };
		}
		return act(type, args);
	};
	// Eating heals by regeneration over the next waits; obtain's own legs take no time here, so a gather after eating
	// sees the health the waits gave.
	return body;
}
const typesOf = (body) => body.calls.map(([type]) => type);

test('a non-food obtain at health 5 with hotbar food eats it, regenerates to 12 and goes on', async () => {
	const body = survivalBody({ start: { bread: 3 } });
	const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const types = typesOf(body);
	assert.deepEqual(types.slice(0, 2), ['select_item', 'use_item'], types.join(','));
	assert.deepEqual(body.calls[1][1], { durationMs: 2000, expectedItemId: 'minecraft:bread' });
	assert.ok(types.indexOf('gather') > types.lastIndexOf('wait'), 'work resumes only after the recovery');
	assert.ok(body.state.health >= 12, `health ${body.state.health}`);
	assert.deepEqual(body.recoveringStates.slice(0, 2), ['armed', 'active']);
	assert.equal(body.recoveringStates.at(-1), 'armed');
});

test('food in slots 9-35 is brought to the selected hotbar slot with select_tool, then eaten', async () => {
	const body = survivalBody({ start: { bread: 3 }, foodSlot: 14 });
	const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const select = body.calls.find(([type]) => type === 'select_tool');
	assert.deepEqual(select?.[1], { sourceSlot: 14, hotbarSlot: 0, expectedItemId: 'minecraft:bread', minRemainingDurability: 0 });
	assert.ok(!body.calls.some(([type]) => type === 'select_item'));
});

test('with no food, regeneration at food 18 or more is waited out to 10 and the obtain goes on', async () => {
	const body = survivalBody({ health: 7, foodLevel: 20, saturation: 6 });
	const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.ok(typesOf(body).includes('wait') && !typesOf(body).includes('use_item'), typesOf(body).join(','));
	assert.ok(body.calls.filter(([type]) => type === 'wait').every(([, args]) => args.durationMs <= 5000));
	assert.ok(body.state.health >= 10);
});

for (const [name, options, said] of [
	['no food and no regeneration (food 17, saturation 20)', { foodLevel: 17, saturation: 20 }, /^Health 5: stopped to recover, then health 5, food 17, saturation 20: no food to eat, and regeneration \(food 18 or more\) cannot pay/],
	['no food and the regeneration gamerule off', { foodLevel: 20, saturation: 20, regen: false }, /natural regeneration is off/],
	['food carried but a zombie after the body', { start: { bread: 3 }, threats: [{ uuid: 'z', type: 'minecraft:zombie', distance: 5, targeting: true, lineOfSight: true, signals: ['targeting'] }] }, /health 5 with a zombie 5 blocks away/],
	['health falling while it waits', { foodLevel: 20, saturation: 20, waitHurts: 1 }, /health fell 5 -> 4 while recovering/],
]) {
	test(`a non-food obtain at health 5 hands back LOW_HEALTH, not danger, on ${name}`, async () => {
		const body = survivalBody(options);
		const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
		assert.equal(result.state, 'INTERRUPTED', result.message);
		assert.equal(result.reasonCode, 'LOW_HEALTH', result.message);
		assert.match(result.message, said);
		assert.doesNotMatch(result.message, /danger/i);
		assert.ok(!typesOf(body).includes('gather'), 'no work while low');
		assert.ok(!typesOf(body).includes('use_item'), 'nothing eaten');
	});
}

test('a body already using an item (the eat reflex mid-bite) is left to finish: obtain waits, then eats', async () => {
	const body = survivalBody({ start: { bread: 3 }, usingItem: true });
	const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.deepEqual(typesOf(body).slice(0, 3), ['wait', 'select_item', 'use_item']);
});

test('food edible at any hunger (a golden apple) is not eaten again once the bar can regenerate', async () => {
	const body = survivalBody({ start: { golden_apple: 5 }, noHeal: true });
	await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
	// Food 10 -> 14 -> 18: two bites, then only waits.
	assert.equal(body.calls.filter(([type]) => type === 'use_item').length, 2, typesOf(body).join(','));
});

for (const [name, options, said] of [
	['regeneration that never lifts health', { foodLevel: 20, saturation: 20, noHeal: true }, /health 5 after 9\d s of recovering/],
	['a failed bite', { start: { bread: 3 }, fail: 'use_item' }, /eating bread failed \(use_item ACTION_FAILED: use_item failed\)/],
	['a failed wait', { foodLevel: 20, saturation: 20, fail: 'wait' }, /waiting to recover failed \(wait ACTION_FAILED/],
]) {
	test(`recovery is bounded: ${name} hands back LOW_HEALTH`, async () => {
		const body = survivalBody(options);
		const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
		assert.equal(result.reasonCode, 'LOW_HEALTH', result.message);
		assert.match(result.message, said);
		assert.ok(!typesOf(body).includes('gather'));
	});
}

test('without survival facts a non-food obtain at health 5 hands back at once (no wait), and a full-health hunt keeps fight_until\'s own flee line', async () => {
	const body = lowHealth(simulatedBody());
	const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
	assert.equal(result.state, 'INTERRUPTED', result.message);
	assert.equal(result.reasonCode, 'LOW_HEALTH', result.message);
	assert.match(result.message, /^Health 5: stopped to recover, then health 5, food \?, saturation \?: no food to eat/);
	assert.doesNotMatch(result.message, /danger/);
	assert.deepEqual(body.calls, [], 'no wait, no work at health 5 with nothing known to recover by');
	const healthy = simulatedBody();
	assert.equal((await runObtain({ item: 'minecraft:beef', count: 2 }, healthy, { now: clock() })).state, 'SUCCEEDED');
	assert.ok(healthy.calls.filter(([type]) => type === 'fight_until').every(([, args]) => !('fleeAtHealth' in args)));
});

test('a non-food obtain that ends holding its item at health 5 hands back LOW_HEALTH, not danger', async () => {
	const result = await runObtain({ item: 'oak_planks', count: 4 }, lowHealth(simulatedBody({ start: { oak_planks: 4 } })), { now: clock() });
	assert.equal(result.state, 'INTERRUPTED', result.message);
	assert.equal(result.reasonCode, 'LOW_HEALTH');
	assert.match(result.message, /^Obtained oak_planks, but health is 5, at or under 6; recover/);
});

test('an obtain that ends holding its item at health 7 or 8 reports OBTAINED', async () => {
	for (const health of [7, 8]) {
		const result = await runObtain({ item: 'oak_planks', count: 4 }, lowHealth(simulatedBody({ start: { oak_planks: 4 } }), health), { now: clock() });
		assert.equal(result.reasonCode, 'OBTAINED', `${health}: ${result.message}`);
	}
});

test('a gather leg stopping LOW_HEALTH at 7 is recovered from once, then the gather goes on', async () => {
	const body = survivalBody({ start: { bread: 3 }, health: 12 });
	const gather = body.gather;
	let stops = 0;
	body.gather = async (args) => {
		if (stops++ === 0) { body.calls.push(['gather', args]); body.state.health = 7; return { state: 'FAILED', reasonCode: 'LOW_HEALTH', message: 'Health 7: stopped gathering' }; }
		return gather(args);
	};
	const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.calls.filter(([type]) => type === 'gather').length, 2);
	// Bread at food 10 gives 15: it eats again toward the regeneration line of 18.
	assert.equal(body.calls.filter(([type]) => type === 'use_item').length, 2);
	assert.ok(body.state.foodLevel >= 18 && body.state.health >= 12, JSON.stringify(body.state));
});

// The leg tests start above the recovery line, so the leg runs; the leg's stop drops health to 7.
const dropsTo = (body, health) => { let low = false; const observe = body.observe; body.observe = async () => { const o = await observe(); return low ? { ...o, player: { ...o.player, health } } : o; }; return () => { low = true; }; };

test('a leg stopping LOW_HEALTH at 7 with nothing to recover by hands back LOW_HEALTH with its line and numbers; other damage stops stay danger', async () => {
	for (const reasonCode of ['LOW_HEALTH', 'DAMAGE_TAKEN']) {
		const body = simulatedBody();
		const low = dropsTo(body, 7);
		body.gather = async (args) => { body.calls.push(['gather', args]); low(); return { state: 'FAILED', reasonCode, message: 'Health 7: stopped gathering' }; };
		const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
		assert.equal(body.calls.filter(([type]) => type === 'gather').length, 1, `${reasonCode}: nothing more is dispatched`);
		assert.equal(result.state, 'INTERRUPTED', `${reasonCode}: ${result.message}`);
		assert.equal(result.reasonCode, reasonCode === 'LOW_HEALTH' ? 'LOW_HEALTH' : 'DANGER', `${reasonCode}: ${result.message}`);
		if (reasonCode === 'LOW_HEALTH') {
			assert.match(result.message, /^Stopped at low health \(LOW_HEALTH: Health 7: stopped gathering\), then health 7, food \?/);
			assert.doesNotMatch(result.message, /danger/i);
		}
	}
});

test('a find leg\'s own low-health stop reaches obtain as LOW_HEALTH; a find danger stop stays danger', async () => {
	for (const stopCode of ['LOW_HEALTH', 'IN_LAVA']) {
		const body = simulatedBody({ iron: false, start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 6 } });
		const low = dropsTo(body, 7);
		let searches = 0;
		body.search = async () => {
			searches += 1;
			low();
			return { state: 'FAILED', reasonCode: 'FIND_DANGER', message: `Stopped for danger: ${stopCode} (Health 7: stopped digging). Covered in 9 s`, find: { covered: {}, stopCode } };
		};
		const result = await runObtain({ item: 'iron_pickaxe', count: 1 }, body, { now: clock() });
		assert.equal(searches, 1, `${stopCode}: no searching on`);
		assert.equal(result.state, 'INTERRUPTED', `${stopCode}: ${result.message}`);
		assert.equal(result.reasonCode, stopCode === 'LOW_HEALTH' ? 'LOW_HEALTH' : 'DANGER', `${stopCode}: ${result.message}`);
		if (stopCode === 'LOW_HEALTH') assert.doesNotMatch(result.message, /danger/i);
	}
});

test('a fork stop ends obtain with its own code: the leg it cut short is not read as danger, and real danger still wins', async () => {
	for (const scenario of ['fork', 'fork in lava', 'no fork reader']) {
		const body = simulatedBody();
		let fork = null;
		body.gather = async (args) => {
			body.calls.push(['gather', args]);
			fork = { reasonCode: 'LOW_HEALTH', message: 'Health 7: recover first' };
			return { state: 'INTERRUPTED', reasonCode: 'LOW_HEALTH' };
		};
		body.interrupted = () => fork !== null;
		if (scenario !== 'no fork reader') body.forkStop = () => fork;
		const observe = body.observe;
		body.observe = async () => { const o = await observe(); return scenario === 'fork in lava' && fork !== null ? { ...o, player: { ...o.player, inLava: true } } : o; };
		const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: clock() });
		assert.equal(body.calls.filter(([type]) => type === 'gather').length, 1, scenario);
		assert.equal(result.state, 'INTERRUPTED', `${scenario}: ${result.message}`);
		assert.equal(result.reasonCode, scenario === 'fork' ? 'LOW_HEALTH' : 'DANGER', `${scenario}: ${result.message}`);
		if (scenario === 'fork') {
			assert.match(result.message, /^Health 7: recover first; decide, then call obtain again/);
			assert.doesNotMatch(result.message, /danger/i);
		}
	}
});

test('food at health 5 with damage taken during the hunt still hands back as danger', async () => {
	for (const reasonCode of ['LOW_HEALTH_BAILOUT', 'DAMAGE_TAKEN']) {
		const body = lowHealth(simulatedBody());
		const act = body.act;
		body.act = async (type, args) => (type === 'fight_until' ? (body.calls.push([type, args]), { state: 'FAILED', reasonCode, message: 'Health 4.0 reached fleeAtHealth 4.0' }) : act(type, args));
		const result = await runObtain({ item: 'minecraft:beef', count: 5 }, body, { now: clock() });
		assert.equal(result.state, 'INTERRUPTED', `${reasonCode}: ${result.message}`);
		assert.equal(result.reasonCode, 'DANGER');
	}
});

test('a crafted or smelted food at health 5 keeps the low-health stop: its chain mines and smelts like any item', async () => {
	const body = lowHealth(simulatedBody());
	const result = await runObtain({ item: 'minecraft:cooked_beef', count: 2 }, body, { now: clock() });
	assert.notEqual(result.state, 'SUCCEEDED', result.message);
	assert.match(result.message, /Health 5: stopped to recover/);
	assert.ok(!body.calls.some(([type]) => type === 'fight_until'), 'no hunt at health 5 for a smelted food');
});

test('the food hunt flee line is set once: a lower health on a later hunt round does not lower it', async () => {
	let health = 5;
	const body = simulatedBody();
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); return { ...o, player: { ...o.player, health } }; };
	const act = body.act;
	let hunts = 0;
	body.act = async (type, args) => {
		if (type !== 'fight_until') return act(type, args);
		body.calls.push([type, args]);
		// The first hunt gets nothing (the herd wandered), and an unreported tick costs a point before the next round.
		if (hunts++ === 0) { health = 4; return { state: 'FAILED', reasonCode: 'TARGET_LOST', message: 'lost the herd' }; }
		return act(type, args);
	};
	await runObtain({ item: 'minecraft:beef', count: 5 }, body, { now: clock() });
	const lines = body.calls.filter(([type]) => type === 'fight_until').map(([, args]) => args.fleeAtHealth);
	assert.ok(lines.length >= 2, JSON.stringify(lines));
	assert.ok(lines.every((line) => line === 4), JSON.stringify(lines));
});

// Round 4, seed 2: obtain flint_and_steel re-broke gravel 24 times in a cave beside a skeleton, each round paused by the
// defend reflex, and handed back LOW_HEALTH only at 1.67 health. The re-break loop now checks the body before each round.
for (const [name, harm, reasonCode, said] of [
	['a skeleton shooting at the body', (o) => ({ ...o, player: { ...o.player, threats: [{ uuid: 's', type: 'minecraft:skeleton', distance: 12, targeting: true, signals: ['targeting'] }] } }), 'DANGER', /skeleton 12 blocks away/],
	// obtain's low-health stop keeps its own code through end(): low health alone is not danger.
	['low health', (o) => ({ ...o, player: { ...o.player, health: 5 } }), 'LOW_HEALTH', /Health 5: stopped to recover/],
]) {
	test(`the gravel re-break for flint hands back on ${name} instead of breaking on`, async () => {
		const body = simulatedBody({ start: { iron_ingot: 1 } });
		const observe = body.observe;
		const placed = () => body.calls.filter(([type, args]) => type === 'place_block' && /gravel/.test(args.itemId)).length;
		body.observe = async () => { const o = await observe(); return placed() >= 1 ? harm(o) : o; };
		const result = await runObtain({ item: 'flint_and_steel', count: 1 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
		assert.equal(result.reasonCode, reasonCode, JSON.stringify(result));
		assert.match(result.message, said);
		assert.equal(placed(), 1, 'no gravel placed after the danger showed');
	});
}

test('script-first r2 seed 8: gravel gather could not take goes out of find\'s gravel sightings for the next obtain call', async () => {
	for (const [reasonCode, marked] of [['PATH_BLOCKED', true], ['NO_TARGET', true], ['HOSTILE_NEAR', false], ['LOW_HEALTH', false]]) {
		const body = simulatedBody({ start: { stone_pickaxe: 1 } });
		const missed = [];
		body.missPlace = (place, why) => missed.push({ ...place, why });
		body.gather = async (args) => { body.calls.push(['gather', args]); return { state: 'FAILED', reasonCode }; };
		const result = await runObtain({ item: 'flint', count: 1 }, body, { now: ticking() });
		assert.notEqual(result.state, 'SUCCEEDED', reasonCode);
		assert.deepEqual(missed.map((row) => `${row.x},${row.y},${row.z} ${row.blockId} ${row.why}`), marked ? ['-3,64,-3 minecraft:gravel unreachable'] : [], reasonCode);
	}
});

test('r5 seed 7, batch 4: the sticks for four more pickaxes are kept back while a sound pickaxe is held, and spent on a pickaxe', () => {
	const held = new Map([['stone_pickaxe', 1], ['stick', 2], ['oak_planks', 5], ['oak_log', 3], ['cobblestone', 40]]);
	const left = keepPickaxeMakings(held, ['bucket'], index);
	assert.deepEqual([left.get('stick'), left.get('oak_planks'), left.get('oak_log'), left.get('cobblestone')], [0, 3, 2, 40], 'sticks, then planks, then a log: four pickaxes\' worth');
	assert.deepEqual([...keepPickaxeMakings(new Map([['stone_pickaxe', 1], ['birch_log', 2]]), ['shield'], index)], [['stone_pickaxe', 1], ['birch_log', 1]]);
	assert.equal(keepPickaxeMakings(held, ['stone_pickaxe'], index), held, 'making a pickaxe is what they are kept for');
	const none = new Map([['stick', 2], ['oak_planks', 2]]);
	assert.equal(keepPickaxeMakings(none, ['bucket'], index), none, 'no pickaxe left: nothing held back');
	const scrap = new Map([['iron_pickaxe', 1], ['stick', 1], ['oak_planks', 1]]);
	assert.equal(keepPickaxeMakings(scrap, ['bucket'], index), scrap, 'less than one pickaxe\'s sticks makes nothing');
});

test('r5 seed 7: a bucket\'s smelt does not burn the last planks: a log is gathered for fuel and the pickaxe makings stay', async () => {
	const body = simulatedBody({ start: { raw_iron: 3, stone_pickaxe: 1, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 2 } });
	const result = await runObtain({ item: 'bucket', count: 1 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.ok(body.inv.get('stick') >= 2 && body.inv.get('oak_planks') >= 2, `kept ${body.inv.get('stick')} sticks, ${body.inv.get('oak_planks')} planks`);
	const load = body.calls.find(([type, args]) => type === 'furnace_transaction' && args.operation === 'load')[1];
	assert.equal(load.count, 3);
	// Then the pickaxe wears out underground: its replacement is made from what was kept, with no trip for wood.
	body.inv.set('stone_pickaxe', 0);
	body.inv.set('cobblestone', 3);
	const calls = body.calls.length;
	const made = await runObtain({ item: 'stone_pickaxe', count: 1 }, body, { now: ticking() });
	assert.equal(made.state, 'SUCCEEDED', made.message);
	assert.ok(!body.calls.slice(calls).some(([type]) => type === 'gather'), 'no gather');
});

test('the raw iron in hand smelts while the next vein in view is mined (furnace waits were 1.9 min of a kit)', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, furnace: 1, crafting_table: 1, raw_iron: 3, oak_planks: 10 } });
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); o.blocks.push({ blockId: 'minecraft:iron_ore', x: 4, y: 64, z: 4 }); return o; };
	// The walk back to the furnace moves the body (the plain simulator's moveTo stays put).
	body.moveTo = async (args) => body.act('travel_to', { x: args.x - 1.5, y: args.y, z: args.z });
	const result = await runObtain({ item: 'bucket', count: 2 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message + ' :: ' + result.steps.join(' | ') + ' :: ' + body.calls.map(([t, a]) => t + (t === 'furnace_transaction' ? ':' + a.operation + ':' + (a.count ?? '') : '')).join(','));
	const order = body.calls.map(([type, args]) => type === 'furnace_transaction' ? `furnace:${args.operation}:${args.count ?? ''}` : type).filter((one) => /^(mine|furnace)/.test(one));
	assert.equal(order[0], 'furnace:load:3', order.join(','));
	assert.ok(order.indexOf('mine') > 0 && order.indexOf('mine') < order.indexOf('furnace:take_output:'), order.join(','));
	assert.equal(body.calls.filter(([type]) => type === 'mine').length, 1, 'one vein');
	assert.ok(result.steps.some((line) => /3 raw_iron smelting while the rest is mined/.test(line)), result.steps.join(' | '));
});

test('b11 test host seed 4-r1: under cover with no sound pickaxe, a stone pickaxe is made from what is held before the smelt burns the planks', async () => {
	const body = simulatedBody({ start: { raw_iron: 3, oak_planks: 4, cobblestone: 3, furnace: 1, crafting_table: 1 } });
	const observe = body.observe;
	body.observe = async () => { const o = await observe(); o.player.skyOpen = false; o.player.y = 20; return o; };
	const result = await runObtain({ item: 'iron_ingot', count: 3 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const kinds = body.calls.map(([type, args]) => type === 'craft_table' || type === 'craft_inventory' ? `craft:${bare(args.recipeId)}` : type === 'furnace_transaction' ? `furnace:${args.operation}` : type);
	const pick = kinds.indexOf('craft:stone_pickaxe'), load = kinds.indexOf('furnace:load');
	assert.ok(pick >= 0 && pick < load, kinds.join(','));
	assert.equal(body.inv.get('stone_pickaxe'), 1);
});

test('review of #322: a spare stone pickaxe whose craft keeps failing gives way to the goal', async () => {
	const body = simulatedBody({ start: { raw_iron: 3, oak_planks: 4, cobblestone: 3, furnace: 1, crafting_table: 1 } });
	const observe = body.observe, act = body.act;
	body.observe = async () => { const o = await observe(); o.player.skyOpen = false; o.player.y = 20; return o; };
	body.act = async (type, args) => {
		if (type === 'craft_table' && /stone_pickaxe/.test(args.recipeId)) { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'NO_PLACEMENT_SUPPORT', message: 'no table spot' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'iron_ingot', count: 3 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.calls.filter(([type, args]) => type === 'craft_table' && /stone_pickaxe/.test(args.recipeId)).length, 2);
});

test('b17b seed 5-r1: a tree out of reach is followed by the next search, not a random 24-block walk', async () => {
	const body = simulatedBody();
	const gather = body.gather, mine = body.mine, search = body.search;
	body.search = async (target, options) => /_log/.test(target.block ?? '') ? { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: 'Found', find: { seen: { x: 20, y: 64, z: 20, id: 'minecraft:oak_log' } } } : search(target, options);
	let fails = 0;
	body.gather = async (args) => { if (fails < 1 && args.itemIds.some((item) => /_log$/.test(item))) { fails += 1; body.calls.push(['gather', args]); return { state: 'FAILED', reasonCode: 'NO_TARGET', broken: 0 }; } return gather(args); };
	body.mine = async (args) => { if (args.vein && fails === 1) { body.calls.push(['mine', args]); return { state: 'FAILED', reasonCode: 'TARGET_NOT_VISIBLE' }; } return mine(args); };
	const result = await runObtain({ item: 'oak_planks', count: 4 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.calls.filter(([type, args]) => type === 'travel_to' && args?.distance === 24).length, 0, 'no random walk');
	assert.ok(fails === 1);
});

test('a full inventory drops junk stacks and crafts the replacement pickaxe (b2 chain-gate-1 DESTINATION_FULL)', async () => {
	const keepers = ['water_bucket', 'bucket', 'flint_and_steel', 'obsidian', 'bread', 'iron_pickaxe', 'shield', 'torch', 'coal', 'raw_copper', 'redstone',
		'lapis_lazuli', 'diamond', 'emerald', 'string', 'bone', 'arrow', 'rotten_flesh', 'gunpowder', 'feather', 'leather', 'wheat_seeds', 'iron_ingot', 'gold_ingot', 'copper_ingot', 'amethyst_shard'];
	const start = { birch_log: 2, crafting_table: 1, cobblestone: 20, cobbled_deepslate: 30, dirt: 12, gravel: 40, granite: 5, diorite: 30, andesite: 33, tuff: 9,
		...Object.fromEntries(keepers.map((kind) => [kind, 1])) };
	const body = simulatedBody({ start });
	const kinds = () => [...body.inv.values()].filter((n) => n > 0).length;
	assert.equal(kinds(), 36, 'every slot taken');
	const simulated = body.act, observe = body.observe;
	let slots = [];
	body.observe = async () => { const o = await observe(); slots = o.inventory.items; return o; };
	body.act = async (type, args) => {
		if (type === 'drop_item') {
			body.calls.push([type, args]);
			const row = slots.find((item) => item.slot === args.slot && item.count >= args.count);
			if (!row) return { state: 'FAILED', reasonCode: 'ITEM_NOT_FOUND' };
			body.inv.set(bare(row.itemId), body.inv.get(bare(row.itemId)) - args.count);
			return { state: 'SUCCEEDED', reasonCode: 'DROPPED' };
		}
		// The game refuses a craft whose result is a new kind when no slot is free.
		if (/^craft_/.test(type) && kinds() >= 36 && !(body.inv.get(bare(args.recipeId)) > 0)) {
			body.calls.push([type, args]);
			return { state: 'FAILED', reasonCode: 'DESTINATION_FULL', message: 'Player inventory cannot accept the complete crafting result' };
		}
		return simulated(type, args);
	};
	const result = await runObtain({ item: 'stone_pickaxe', count: 1 }, body, { index });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	const dropped = body.calls.filter(([type]) => type === 'drop_item').map(([, args]) => args);
	// Craft recovery and the final station pickup each require capacity.
	assert.ok(dropped.length > 0 && dropped.length <= 3, JSON.stringify(dropped));
	assert.equal(body.inv.get('crafting_table'), 1, 'the table returns after the replacement uses its former slot');
	// Only junk went, smallest stack first: never a tool, bucket, food, obsidian or the last 16 cobblestone.
	for (const kind of keepers) assert.ok(body.inv.get(kind) > 0, `${kind} kept`);
	assert.ok(body.inv.get('cobblestone') + body.inv.get('cobbled_deepslate') >= 16);
	assert.equal(body.inv.get('granite'), 0, 'the smallest junk stack goes first');
	assert.equal(body.inv.get('dirt'), 0, 'one extra junk stack makes room for the recovered table');
});

test('review of #223: under cover the pickaxe wood reserve is spent on a crafting table rather than sending the body up for wood', async () => {
	const run = async (skyOpen) => {
		const body = simulatedBody({ start: { stone_pickaxe: 1, oak_planks: 5 } });
		const observe = body.observe;
		body.observe = async () => { const o = await observe(); o.player.skyOpen = skyOpen; if (!skyOpen) o.player.y = 20; return o; };
		const result = await runObtain({ item: 'crafting_table', count: 1 }, body, { now: ticking() });
		return { result, gathered: body.calls.some(([type, args]) => type === 'gather' || (type === 'travel_to' && /log/.test(JSON.stringify(args)))) };
	};
	const under = await run(false);
	assert.equal(under.result.state, 'SUCCEEDED', under.result.message);
	assert.equal(under.gathered, false, 'made from the planks it holds');
});

test('b9 test host seed 8: a search handed back by water where the body stands is followed by a move off, not another search from the same cell', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1 }, iron: false });
	const order = [];
	let searches = 0;
	body.search = async () => {
		searches += 1; order.push('search');
		return { state: 'FAILED', reasonCode: 'FIND_BLOCKED', message: 'No way on from here: water under this spot stops every dig down, and the move off this spot stopped too (NO_ROUTE). Covered in 116 s' };
	};
	const act = body.act;
	body.act = async (type, args) => { if (type === 'dig_to' || type === 'travel_to') order.push(type); return act(type, args); };
	await runObtain({ item: 'raw_iron', count: 1, timeoutMs: 600_000 }, body, { now: ticking() });
	assert.ok(searches >= 2, `${searches} searches`);
	for (let k = 1; k < order.length; k++) if (order[k] === 'search') assert.notEqual(order[k - 1], 'search', order.join(','));
});

test('review of #225: only plain stone at hand speed reads as a missing pickaxe; an ore a stone pickaxe cannot take keeps the old rounds', async () => {
	const body = simulatedBody({ start: { bucket: 1 } });
	let searches = 0;
	body.search = async () => { searches += 1; return { state: 'FAILED', reasonCode: 'FIND_BLOCKED', message: 'No way on from here: 8 heading(s) blocked (last: NO_ROUTE: No seen way on toward the target, and building cannot continue: minecraft:deepslate_gold_ore at 5,-20,9 takes 9' }; };
	const result = await runObtain({ item: 'water_bucket', count: 1 }, body, { index });
	assert.equal(result.reasonCode, 'NO_SOURCE', result.message);
	assert.ok(searches > 1);
});

for (const scenario of ['ore', 'approach', 'moveOff', 'no junk', 'rejected', 'still full', 'danger', 'cancel', 'deadline', 'drop danger', 'approach blocked', 'moveOff blocked']) {
	test(`materials capacity recovery: ${scenario}`, async () => {
		const body = simulatedBody({ start: { stone_pickaxe: 1, cobblestone: 16, coal: 4, oak_planks: 8, dirt: 12, granite: 5 } });
		if (['no junk', 'approach blocked', 'moveOff blocked'].includes(scenario)) { body.inv.delete('dirt'); body.inv.delete('granite'); }
		// Fill every slot with non-junk valuables. Slot order is refreshed before each drop.
		for (let n = body.inv.size; n < 36; n++) body.inv.set(`valuable_${n}`, 1);
		let rows, full = true, stopped = false, time = 0, digs = 0, mines = 0, searches = 0;
		const at = { x: 0.5, y: 20, z: 0.5 }, where = { x: scenario.startsWith('approach') ? 12 : 2, y: 20, z: 0, blockId: 'minecraft:iron_ore' };
		const observe = body.observe;
		body.observe = async () => {
			const o = await observe(); Object.assign(o.player, at, { skyOpen: false }); rows = o.inventory.items;
			return o;
		};
		body.stopped = () => stopped;
		const fullResult = { state: 'FAILED', reasonCode: 'INVENTORY_FULL', message: 'Inventory is full; raw iron would stay on the ground (out of reach)' };
		const missed = [], excluded = [];
		body.missPlace = (...args) => missed.push(args);
		const act = body.act;
		body.act = async (type, args) => {
			if (type === 'drop_item') {
				body.calls.push([type, args]);
				if (scenario === 'rejected') return { state: 'FAILED', reasonCode: 'DROP_REJECTED' };
				const row = rows.find((r) => r.slot === args.slot);
				assert.ok(['granite', 'dirt'].includes(bare(row.itemId)), `unsafe drop ${row.itemId}`);
				body.inv.delete(bare(row.itemId));
				if (scenario !== 'still full') full = false;
				if (scenario === 'cancel') stopped = true;
				if (scenario === 'deadline') time = 60_001;
				return scenario === 'drop danger' ? { state: 'INTERRUPTED', reasonCode: 'IN_LAVA' } : { state: 'SUCCEEDED' };
			}
			if (type === 'travel_to') { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'NO_ROUTE' }; }
			if (type === 'dig_to') {
				body.calls.push([type, args]); digs++;
				if (full) return fullResult;
				Object.assign(at, { x: where.x, y: where.y, z: where.z });
				return { state: 'SUCCEEDED' };
			}
			return act(type, args);
		};
		body.mine = async (args) => {
			body.calls.push(['mine', args]); mines++;
			if (full) return fullResult;
			body.inv.set('raw_iron', 1); return { state: 'SUCCEEDED' };
		};
		if (scenario === 'danger') {
			body.observe = async () => { const o = await observe(); Object.assign(o.player, at); rows = o.inventory.items; if (mines > 0) o.player.inLava = true; return o; };
		}
		const result = await runObtain({ item: 'raw_iron', timeoutMs: 60_000 }, body, { now: () => time,
			locate: async (need, b, { budget }) => {
				searches++; excluded.push(...budget.failed);
				if (scenario.startsWith('moveOff') && searches === 1) { budget.lastSearch = { reasonCode: 'FIND_SEEN' }; return null; }
				return where;
			} });
		assert.deepEqual(missed, [], 'capacity never marks ore unreachable');
		assert.deepEqual(excluded, [], 'capacity never excludes a source');
		assert.equal(body.inv.get('cobblestone'), 16, 'cobble reserve kept');
		assert.equal(body.inv.get('coal'), 4); assert.equal(body.inv.get('oak_planks'), 8);
		const drops = body.calls.filter(([type]) => type === 'drop_item');
		assert.ok(drops.length <= 2, 'bounded junk policy');
		if (['ore', 'approach', 'moveOff'].includes(scenario)) {
			assert.equal(result.reasonCode, 'OBTAINED', result.message);
			const action = scenario === 'ore' ? 'mine' : 'dig_to';
			const attempts = body.calls.filter(([type]) => type === action);
			assert.equal(attempts.length, 2); assert.deepEqual(attempts[0], attempts[1], 'retry identical blocked action');
			assert.equal(searches, scenario === 'moveOff' ? 2 : 1);
		} else {
			const expected = { danger: 'DANGER', cancel: 'CANCELLED', deadline: 'OBTAIN_TIMEOUT', 'drop danger': 'DANGER' }[scenario] ?? 'OBTAIN_STUCK';
			assert.equal(result.reasonCode, expected, result.message);
			assert.equal(digs, scenario.endsWith('blocked') ? 1 : 0, 'no tunnel or research loop');
			assert.equal(searches, 1);
			assert.equal(mines, scenario.endsWith('blocked') ? 0 : scenario === 'still full' ? 2 : 1, 'no retry after stop or rejected drop');
			if (expected === 'OBTAIN_STUCK') assert.match(result.message, /capacity.*INVENTORY_FULL|capacity.*Inventory is full/i);
			if (scenario === 'no junk' || scenario === 'danger') assert.equal(drops.length, 0);
		}
	});
}

// Two cobble stacks could satisfy the 16-block reserve, but both belong to this obtain's target.
test('capacity recovery keeps target cobblestone even when an extra stack passes the junk reserve', async () => {
	const body = simulatedBody({ start: { stone_pickaxe: 1, cobblestone: 80 } });
	const observe = body.observe;
	body.observe = async () => {
		const o = await observe();
		o.inventory.items = [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0 },
			{ itemId: 'minecraft:cobblestone', count: 64, slot: 1 }, { itemId: 'minecraft:cobblestone', count: 16, slot: 2 }];
		return o;
	};
	const act = body.act;
	body.act = async (type, args) => {
		if (type === 'dig_to') { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'INVENTORY_FULL' }; }
		return act(type, args);
	};
	const result = await runObtain({ item: 'cobblestone', count: 81 }, body);
	assert.equal(result.reasonCode, 'OBTAIN_STUCK', result.message);
	assert.equal(body.calls.filter(([type]) => type === 'drop_item').length, 0);
	assert.equal(body.calls.filter(([type]) => type === 'dig_to').length, 1);
});

test('the coal decision retains held versus reserved wood through later smelting and cleanup', async () => {
	const body = simulatedBody({ start: { iron_pickaxe: 1, raw_iron: 7, furnace: 1, crafting_table: 1, stick: 2, oak_planks: 2, oak_log: 1 } });
	const observe = body.observe, notes = [];
	body.observe = async () => { const o = await observe(); o.player.skyOpen = false; return o; };
	body.note = (text) => notes.push(text);
	let coalSearches = 0;
	const result = await runObtain({ item: 'bucket', count: 2 }, body, { now: ticking(), locate: async (need, b, { budget }) => {
		assert.ok(need.accept.includes('coal'), JSON.stringify(need));
		assert.equal(body.inv.get('oak_log'), 1, 'carried wood is reserved during both searches');
		coalSearches++;
		budget.lastSearch = { reasonCode: 'FIND_BUDGET', message: 'No coal in the search budget' };
		return null;
	} });
	assert.equal(result.reasonCode, 'OBTAINED', result.message);
	assert.equal(coalSearches, 2, 'diagnosis preserves the existing fuel decisions');
	const prefix = 'coal fuel decision ';
	const diagnostic = JSON.parse(result.steps.find((step) => step.startsWith(prefix)).slice(prefix.length));
	assert.equal(diagnostic.coalFailures, 1, 'the last coal decision survives later craft/smelt/cleanup steps');
	assert.equal(diagnostic.counts.oak_log, 1);
	assert.equal(diagnostic.counts.oak_planks, 2);
	assert.equal(diagnostic.available.oak_log, 0);
	assert.equal(diagnostic.available.oak_planks, 0);
	assert.equal(diagnostic.coalFirst, true);
	assert.equal(diagnostic.plan.fuel.smelts, 6);
	assert.ok(diagnostic.plan.needs.some((need) => need.accept.includes('coal')));
	assert.equal(notes.filter((step) => step.startsWith(prefix)).length, 2);
	assert.ok(result.steps.length <= 12);
});

test('station placement steps beyond travel arrival tolerance before retrying a hidden support', async () => {
	const body = simulatedBody({ start: { crafting_table: 1, cobblestone: 3, stick: 2 } });
	const observe = body.observe, act = body.act;
	let moved = 0;
	body.observe = async () => { const o = await observe(); o.player.x += moved; return o; };
	body.act = async (type, args) => {
		if (type === 'place_block' && moved === 0) {
			body.calls.push([type, args]);
			return { state: 'FAILED', reasonCode: 'NO_PLACEMENT_SUPPORT', message: 'cause=SUPPORT_FACE_HIDDEN' };
		}
		if (type === 'travel_to' && args.distance !== undefined) {
			body.calls.push([type, args]);
			// A relative destination starts this far away; travel already arrived when it is within tolerance.
			moved += Math.max(0, args.distance - (args.tolerance ?? 3));
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
		}
		return act(type, args);
	};
	const result = await runObtain({ item: 'stone_pickaxe' }, body, { now: ticking() });
	assert.equal(result.reasonCode, 'OBTAINED', result.message);
	assert.ok(moved >= 2, 'placement retries from a different eye position');
	assert.equal(body.calls.filter(([type, args]) => type === 'travel_to' && args.distance !== undefined).length, 1);
	assert.equal(body.calls.filter(([type]) => type === 'gather').length, 0);
});

for (const scenario of ['reserve', 'spare first', 'capacity', 'cancel after load']) {
	test(`materials bundle overlap interaction: ${scenario}`, async () => {
		const body = simulatedBody({ start: { ...(scenario === 'spare first' ? {} : { stone_pickaxe: 1 }), cobblestone: 3,
			furnace: 1, crafting_table: 1, raw_iron: 3, oak_planks: 10, stick: 2, dirt: 12 } });
		const observe = body.observe, act = body.act, mine = body.mine;
		let stopped = false, blocked = scenario === 'capacity';
		body.stopped = () => stopped;
		body.observe = async () => { const o = await observe(); o.player.skyOpen = false;
			o.blocks.push({ blockId: 'minecraft:iron_ore', x: 4, y: 64, z: 4 }); return o; };
		body.moveTo = async (args) => body.act('travel_to', { x: args.x - 1.5, y: args.y, z: args.z });
		body.act = async (type, args) => {
			if (type === 'drop_item') { const o = await observe(); const row = o.inventory.items.find((r) => r.slot === args.slot);
				assert.equal(bare(row.itemId), 'dirt'); body.inv.delete('dirt'); blocked = false;
				body.calls.push([type, args]); return { state: 'SUCCEEDED' }; }
			const result = await act(type, args);
			if (scenario === 'cancel after load' && type === 'furnace_transaction' && args.operation === 'load') stopped = true;
			return result;
		};
		body.mine = async (args) => {
			if (blocked) { body.calls.push(['mine', args]); return { state: 'FAILED', reasonCode: 'INVENTORY_FULL' }; }
			return mine(args);
		};
		const loads = [], placed = [];
		const result = await runObtain({ item: 'bucket', count: 2 }, body, { now: ticking(), loads, placed });
		const firstLoad = body.calls.findIndex(([type, args]) => type === 'furnace_transaction' && args.operation === 'load');
		assert.ok(firstLoad >= 0);
		assert.equal(body.calls[firstLoad][1].count, 3, 'held input loaded before mining remainder');
		if (scenario === 'cancel after load') {
			assert.equal(result.reasonCode, 'CANCELLED', result.message);
			assert.equal(body.calls.length, firstLoad + 1, 'no mining or cleanup dispatch after cancellation');
			assert.equal(loads.length, 1, 'pending furnace retained');
		} else {
			assert.equal(result.reasonCode, 'OBTAINED', result.message);
			if (scenario !== 'spare first') assert.ok(body.inv.get('stick') >= 2 && body.inv.get('oak_planks') >= 2, 'replacement pickaxe makings retained');
			else assert.equal(body.inv.get('stone_pickaxe'), 1, 'makings used for the spare');
			assert.equal(loads.length, 0);
			if (scenario === 'spare first') assert.ok(body.calls.findIndex(([type, args]) => type === 'craft_table' && /stone_pickaxe/.test(args.recipeId)) < firstLoad);
			if (scenario === 'capacity') assert.equal(body.calls.filter(([type]) => type === 'drop_item').length, 1);
		}
	});
}

// Batch23 time lane: exercise runObtain with real locate and deterministic simulated drops.
function carriedGravelBody(start = { gravel: 1 }) {
	const body = simulatedBody({ start });
	const observe = body.observe;
	body.observe = async () => {
		const o = await observe();
		return { ...o, blocks: o.blocks.filter((row) => row.blockId !== 'minecraft:gravel' || row.x !== -3 || row.z !== -3) };
	};
	body.search = async (target, options) => {
		body.calls.push(['search', target, options]);
		return { state: 'FAILED', reasonCode: 'FIND_NOT_FOUND', message: 'controlled: no natural deposit' };
	};
	return body;
}

test('carried gravel: flint without a natural deposit needs no search', async () => {
	const body = carriedGravelBody();
	const result = await runObtain({ item: 'flint' }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', JSON.stringify({ result, calls: body.calls }));
	assert.equal(body.inv.get('flint'), 1);
	assert.equal(body.calls.filter(([type]) => type === 'mine').length, 3);
	assert.equal(body.calls.filter(([type]) => type === 'search' || type === 'gather').length, 0);
});

test('carried gravel: an immediately visible natural source stays first', async () => {
	const body = simulatedBody({ start: { gravel: 1 } });
	body.gather = async (args) => { body.calls.push(['gather', args]); body.inv.set('flint', 1); return { state: 'SUCCEEDED' }; };
	const result = await runObtain({ item: 'flint' }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.calls[0][0], 'gather');
	assert.equal(body.calls.filter(([type]) => type === 'place_block' || type === 'search').length, 0);
	assert.equal(body.inv.get('gravel'), 1);
});

test('carried gravel: multiple flint uses fresh counts and reacquires after partial input', async () => {
	const body = carriedGravelBody({ gravel: 1, flint: 1 });
	body.search = async (target, options) => {
		body.calls.push(['search', target, options, body.inv.get('flint')]);
		return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', find: { seen: { x: -3, y: 64, z: -3, id: 'minecraft:gravel' } } };
	};
	const result = await runObtain({ item: 'minecraft:flint', count: 3 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.inv.get('flint'), 3);
	assert.equal(body.calls.find(([type]) => type === 'search')[3], 2, 'first carried block became flint before search');
	assert.equal(body.calls.find(([type]) => type === 'gather')[1].count, 6, 'fresh 0 gravel + 2 flint + 4');
});

for (const stop of ['danger', 'cancel', 'deadline', 'low health']) {
	test(`carried gravel: ${stop} during rebreak prevents fallback search`, async () => {
		const body = carriedGravelBody();
		const act = body.act, observe = body.observe;
		let placed = false, expired = false;
		body.act = async (type, args) => {
			const result = await act(type, args);
			if (type === 'place_block') { placed = true; expired = true; }
			return result;
		};
		body.stopped = () => stop === 'cancel' && placed;
		body.observe = async () => {
			const o = await observe();
			if (placed && stop === 'danger') o.player.threats = [{ type: 'minecraft:skeleton', distance: 8, targeting: true, signals: ['targeting'] }];
			if (placed && stop === 'low health') o.player.health = 5;
			return o;
		};
		const result = await runObtain({ item: 'flint', timeoutMs: 60000 }, body, { now: stop === 'deadline' ? () => expired ? 60001 : 0 : ticking() });
		assert.notEqual(result.state, 'SUCCEEDED', result.message);
		assert.equal(result.reasonCode, { deadline: 'OBTAIN_TIMEOUT', cancel: 'CANCELLED', 'low health': 'LOW_HEALTH' }[stop] ?? 'DANGER', result.message);
		assert.equal(body.calls.filter(([type]) => type === 'search' || type === 'gather').length, 0);
		assert.equal(body.calls.filter(([type]) => type === 'place_block').length, 1);
	});
}

for (const mode of ['no cell', 'placement fails']) {
	test(`carried gravel: ${mode} permits existing acquisition fallback`, async () => {
		const body = carriedGravelBody();
		const observe = body.observe, act = body.act;
		let searched = false;
		body.observe = async () => { const o = await observe(); return mode === 'no cell' && !searched ? { ...o, blocks: [] } : o; };
		body.act = async (type, args) => {
			if (mode === 'placement fails' && type === 'place_block') { body.calls.push([type, args]); return { state: 'FAILED', reasonCode: 'NO_PLACEMENT_SUPPORT' }; }
			return act(type, args);
		};
		body.search = async (target, options) => {
			searched = true;
			body.calls.push(['search', target, options]);
			return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', find: { seen: { x: -3, y: 64, z: -3, id: 'minecraft:gravel' } } };
		};
		body.gather = async (args) => { body.calls.push(['gather', args]); body.inv.set('flint', 1); return { state: 'SUCCEEDED' }; };
		const result = await runObtain({ item: 'flint' }, body, { now: ticking() });
		assert.equal(result.state, 'SUCCEEDED', result.message);
		assert.ok(searched);
		assert.equal(body.calls.filter(([type]) => type === 'mine').length, 0, 'failed placement is not mined');
	});
}

test('carried gravel: absent input still searches and nonchance gravel remains exact', async () => {
	const empty = carriedGravelBody({});
	const failed = await runObtain({ item: 'flint' }, empty, { now: ticking() });
	assert.equal(failed.reasonCode, 'NO_SOURCE');
	assert.equal(empty.calls.filter(([type]) => type === 'search').length, 3);
	assert.equal(empty.calls.filter(([type]) => type === 'place_block').length, 0);
	const body = simulatedBody({ start: { gravel: 1 } });
	const result = await runObtain({ item: 'minecraft:gravel', count: 2 }, body, { now: ticking() });
	assert.equal(result.state, 'SUCCEEDED', result.message);
	assert.equal(body.inv.get('gravel'), 2);
	assert.equal(body.inv.get('flint'), undefined);
	assert.equal(body.calls.filter(([type]) => type === 'place_block' || type === 'mine').length, 0);
});

for (const dimension of ['minecraft:the_nether', 'the_nether']) {
 test(`Nether golden boots use Nether gold nuggets (${dimension})`, () => {
  const plan = planObtain({ ids: ['golden_boots'], count: 1 }, { dimension, held: new Map([['iron_pickaxe', 1], ['crafting_table', 1]]) });
  assert.deepEqual(plan.unreachable, []);
  assert.deepEqual(plan.needs.map(n => ({ accept:n.accept, blocks:n.blocks, count:n.count })), [{accept:['gold_nugget'],blocks:['nether_gold_ore'],count:36}]);
  assert.ok(plan.ops.some(op => op.recipeId === 'gold_ingot_from_nuggets' && op.times === 4));
 });
}
test('omitted and explicit Overworld dimensions preserve the existing source plan', () => {
 const held = new Map([['iron_pickaxe',1],['crafting_table',1]]), goal={ids:['golden_boots'],count:1};
 assert.deepEqual(planObtain(goal,{held}),planObtain(goal,{held,dimension:'minecraft:overworld'}));
 const end=planObtain(goal,{held,dimension:'minecraft:the_end'});
 assert.ok(end.unreachable.length>0);
 assert.ok(!end.needs.some(n=>n.blocks.includes('gold_ore')||n.blocks.includes('nether_gold_ore')));
});
for (const rawGold of [0,1]) {
 test(`runtime passes the Nether dimension and completes boots with ${rawGold} held raw gold`, async () => {
  const body=simulatedBody({start:{iron_pickaxe:1,raw_gold:rawGold,crafting_table:1,furnace:1,coal:15}});
  const observe=body.observe;
  body.observe=async()=>{const o=await observe();return {...o,world:{dimension:'minecraft:the_nether'},blocks:[...o.blocks,{blockId:'minecraft:nether_gold_ore',x:1,y:64,z:1}]};};
  body.mine=async args=>{assert.equal(args.vein,true);body.calls.push(['nether-mine',args]);body.inv.set('gold_nugget',(body.inv.get('gold_nugget')??0)+9);return{state:'SUCCEEDED',reasonCode:'VEIN_MINED'};};
  let tick=0;const result=await runObtain({item:'golden_boots'},body,{now:()=>tick+=50});
  assert.equal(result.reasonCode,'OBTAINED',JSON.stringify(result));
  assert.equal(body.inv.get('golden_boots'),1);
  assert.ok(body.calls.some(c=>c[0]==='nether-mine'));
  assert.ok(!body.calls.some(c=>c[0]==='search' && c[1].block==='minecraft:gold_ore'));
  if(rawGold)assert.equal((body.inv.get('raw_gold')??0)+body.calls.filter(c=>c[0]==='furnace_transaction' && c[1].operation==='load' && c[1].expectedItemId==='minecraft:raw_gold').reduce((n,c)=>n+c[1].count,0),1,'the actual raw gold is retained or smelted, never discarded by repricing');
 });
}

 test('partial raw gold does not block the nugget route without furnace or fuel', async () => {
  const body=simulatedBody({start:{iron_pickaxe:1,raw_gold:1,crafting_table:1}});
  const observe=body.observe;
  body.observe=async()=>{const o=await observe();return {...o,world:{dimension:'minecraft:the_nether'},player:{...o.player,skyOpen:false},blocks:[...o.blocks,{blockId:'minecraft:nether_gold_ore',x:1,y:64,z:1}]};};
  body.mine=async args=>{assert.equal(args.vein,true);body.calls.push(['nether-mine',args]);body.inv.set('gold_nugget',(body.inv.get('gold_nugget')??0)+9);return{state:'SUCCEEDED',reasonCode:'VEIN_MINED'};};
  let tick=0;const result=await runObtain({item:'golden_boots'},body,{now:()=>tick+=50});
  assert.equal(result.reasonCode,'OBTAINED',JSON.stringify(result));assert.equal(body.inv.get('golden_boots'),1);assert.equal(body.inv.get('raw_gold'),1);
  assert.ok(!body.calls.some(c=>c[0]==='furnace_transaction'));
 });
 test('a directly seen transported ore remains available outside its generation dimension', () => {
  const plan=planObtain({ids:['raw_iron'],count:1},{dimension:'minecraft:the_nether',held:new Map([['iron_pickaxe',1]]),seen:new Set(['iron_ore'])});
  assert.deepEqual(plan.unreachable,[]);assert.deepEqual(plan.needs[0].blocks,['iron_ore']);
 });

test('an unreachable ingredient stops before loading a smelt or gathering its remainder', async () => {
 const inv=new Map(Object.entries({rabbit:2,baked_potato:3,carrot:3,brown_mushroom:1,coal:15,furnace:1,crafting_table:1,bowl:3}));
 const calls=[];let tick=0;
 const body={stopped:()=>false,interrupted:()=>false,note:()=>{},observe:async()=>({world:{dimension:'minecraft:the_end'},player:{x:.5,y:64,z:.5,health:20,onGround:true},inventory:{selectedSlot:0,items:[...inv].map(([itemId,count],slot)=>({itemId:'minecraft:'+itemId,count,slot}))},blocks:[{blockId:'minecraft:furnace',x:1,y:64,z:0},{blockId:'minecraft:crafting_table',x:-1,y:64,z:0}],entities:[{type:'minecraft:rabbit',stableId:'transported-rabbit',x:2,y:64,z:0,alive:true}]}),act:async(type,args)=>{calls.push({type,args});return{state:'SUCCEEDED'};}};
 // Make both mushroom alternatives unavailable; shipped data also offers a rare zombie red-mushroom drop.
 const blockedIndex={...index,mobDrops:{...index.mobDrops,red_mushroom:[],brown_mushroom:[]}};
 assert.ok(planObtain({ids:['rabbit_stew'],count:3},{held:inv,dimension:'minecraft:the_end',index:blockedIndex}).unreachable.length>0);
 const result=await runObtain({item:'rabbit_stew',count:3},body,{now:()=>tick+=50,index:blockedIndex});
 assert.equal(result.reasonCode,'NO_WAY');assert.deepEqual(calls,[]);
});

test('review of #117: at night on open ground with no armour obtain does not gather (its walks reach 32 blocks); by day it does', async () => {
	const night = simulatedBody();
	const observeNight = night.observe;
	night.observe = async () => { const o = await observeNight(); return { ...o, world: { dimension: 'minecraft:overworld', dayTime: 14_000 }, player: { ...o.player, armor: 0, skyOpen: true } }; };
	const dark = await runObtain({ item: 'oak_log', count: 3 }, night, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(dark.reasonCode, 'NIGHT', dark.message);
	assert.equal(night.calls.some(([type]) => type === 'gather'), false, 'no gather walk was sent');
	const day = simulatedBody();
	const observeDay = day.observe;
	day.observe = async () => { const o = await observeDay(); return { ...o, world: { dimension: 'minecraft:overworld', dayTime: 6_000 }, player: { ...o.player, armor: 0, skyOpen: true } }; };
	const light = await runObtain({ item: 'oak_log', count: 3 }, day, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.equal(light.state, 'SUCCEEDED', light.message);
});
