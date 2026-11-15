import test from 'node:test';
import assert from 'node:assert/strict';
import { workNotices, oreToolFact } from '../src/work-notices.mjs';
import { ModelObservationViews, decodeModelFacts, encodeNativeEventInput } from '../src/model-fact-encoding.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';

const sample = () => ({ ready: true, player: { x: 0, y: 64, z: 0 }, world: { worldId: 'notice-world', dimension: 'minecraft:overworld' },
 inventory: { items: [] }, blocks: [], items: [], currentAction: { active: false },
 lastResult: { actionId: 'a', present: true, actionType: 'break_block', state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN', message: 'Broken; drops seen', actionObservation: { target: { beforeId: 'minecraft:hay_block' } } } });
const block = (blockId, x = 1) => ({ blockId, x, y: 64, z: 0 });

test('names only visible ground stacks, with counts and position, without claiming acquisition or loot provenance', () => {
 const o = sample();
 o.items = [{ itemId: 'minecraft:crafting_table', count: 1, x: 1, y: 64, z: 0 },
  { itemId: 'minecraft:hay_block', count: 2, x: 2, y: 64, z: 0 },
  { itemId: 'minecraft:diamond', count: 1, x: 1, y: 64, z: 0, visible: false }];
 const text = workNotices(o).join('\n');
 assert.match(text, /crafting_table x1 @1,64,0 \(1 blocks\)/);
 assert.match(text, /hay_block x2/);
 assert.match(text, /not picked up/);
 assert.doesNotMatch(text, /diamond/);
 o.items = []; assert.deepEqual(workNotices(o), []);
});

test('same-source gathering counts distinct visible cells within eye reach and works after crafting and pickup', () => {
 const o = sample(); o.blocks = [block('minecraft:hay_block', 1), block('minecraft:hay_block', 2), block('minecraft:hay_block', 8)];
 assert.match(workNotices(o).join('\n'), /More hay_block: 2 seen within mining reach/);
 for (const [actionType, message] of [['craft_table', 'Crafted 3 minecraft:bread through visible menu clicks'], ['pick_up_item', 'Collected into inventory']]) {
  o.lastResult = { ...o.lastResult, actionType, message, actionObservation: undefined };
  o.inventory.items = [{ itemId: 'minecraft:wheat', count: 9 }];
  assert.match(workNotices(o).join('\n'), /More hay_block: 2/);
 }
 o.blocks = [block('minecraft:diamond_ore')];
 assert.doesNotMatch(workNotices(o).join('\n'), /More hay_block/);
});

test('portable workstation facts state placement memory separately from current visibility and respect scope', () => {
 const o = sample(); o.leftBehind = [{ blockId: 'minecraft:crafting_table', x: 48, y: 64, z: 0 }, { blockId: 'minecraft:furnace', x: 49, y: 64, z: 0 }];
 const text = workNotices(o).join('\n');
 assert.match(text, /Your placed crafting_table @48,64,0 \(48 blocks away\)/);
 assert.match(text, /remembered, not checked now/); assert.match(text, /furnaces need a pickaxe/);
 o.leftBehind[0].dimension = 'minecraft:the_nether'; o.leftBehind[1].available = false;
 assert.deepEqual(workNotices(o), []);
 o.blocks = [block('minecraft:crafting_table')];
 assert.match(workNotices(o).join('\n'), /Can mine and carry to the work site/);
 o.inventory.items = [{ itemId: 'minecraft:crafting_table', count: 1 }]; assert.deepEqual(workNotices(o), []);
 o.inventory.items = []; o.blocks = [block('minecraft:crafting_table', 5)];
 assert.deepEqual(workNotices(o), [], 'a workstation beyond eye reach is not described as in reach');
 o.blocks = [{ ...block('minecraft:crafting_table', 1), y: 69 }];
 assert.match(workNotices(o).join('\n'), /Workstations in reach/);
 o.player.crouching = true;
 assert.deepEqual(workNotices(o), [], 'crouching lowers the eye and changes reach to an overhead station');
});

test('both liquid stops give coordinates, inventory facts and model choices without promising a safe direction or seal', () => {
 for (const fluid of ['water', 'lava']) {
  const o = sample(); o.lastResult = { actionType: 'dig_to', state: 'FAILED', reasonCode: `${fluid.toUpperCase()}_AHEAD`, message: `${fluid} at 1,64,0 beside the opened cell; not going further` };
  o.inventory.items = [{ itemId: 'minecraft:cobblestone', count: 12 }];
  const text = workNotices(o).join('\n');
  assert.match(text, /@1,64,0/); assert.match(text, /held: cobblestone x12/);
  assert.match(text, /dig_to with another heading from here/); assert.match(text, /headings are unverified/);
  o.inventory.items = []; assert.match(workNotices(o).join('\n'), /no solid filler shown/);
  o.lastResult.message = undefined; o.blocks = [block(`minecraft:${fluid}`)];
  assert.match(workNotices(o).join('\n'), /@1,64,0/);
 }
});

test('valuable ores get their own line and distinguish carried capability from the selected hand', () => {
 const o = sample(); o.blocks = [block('minecraft:deepslate_diamond_ore', 2), block('minecraft:deepslate_diamond_ore', 3), block('minecraft:deepslate', 1)];
 o.inventory.items = [{ itemId: 'minecraft:stone_pickaxe', count: 1 }, { itemId: 'minecraft:iron_pickaxe', count: 1 }];
 assert.match(workNotices(o).join('\n'), /Ores in view: deepslate_diamond_ore x2, nearest @2,64,0 2 blocks; iron\+ pickaxe; carried iron_pickaxe/);
 assert.match(oreToolFact('minecraft:ancient_debris', o.inventory.items), /diamond\+ pickaxe; no suitable/);
 assert.match(oreToolFact('minecraft:iron_ore', [{ itemId: 'minecraft:wooden_pickaxe', count: 1 }]), /stone\+ pickaxe; no suitable/);
 assert.match(oreToolFact('minecraft:nether_gold_ore', [{ itemId: 'minecraft:wooden_pickaxe', count: 1 }]), /carried wooden_pickaxe/);
});

test('no stale gather or liquid advice while another action is running, after death, or from remembered sections', () => {
 const o = sample(); o.items = [{ itemId: 'minecraft:hay_block', count: 1, x: 1, y: 64, z: 0 }]; o.blocks = [block('minecraft:hay_block')];
 o.currentAction.active = true; assert.deepEqual(workNotices(o), []);
 o.currentAction.active = false; o.continuity = { rememberedSections: ['items', 'blocks'] }; assert.deepEqual(workNotices(o), []);
 delete o.continuity; o.player.dead = true; assert.deepEqual(workNotices(o), []);
});

test('lean production presenters retain notices in wakes and direct action replies before row pruning', () => {
 const previous = process.env.ARENA_LEAN_INPUT; process.env.ARENA_LEAN_INPUT = '1';
 try {
  const o = sample(); o.items = [{ itemId: 'minecraft:crafting_table', count: 1, x: 1, y: 64, z: 0 }];
  const input = buildNativeEventInput({ currentGoal: 'Beat Minecraft', goalRevision: 1 }, { observation: o });
  const encoded = encodeNativeEventInput(input);
  const payload = decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n') + 1)));
  assert.match(JSON.stringify(payload.notice), /crafting_table x1/);
  const presented = new ModelObservationViews().prepare({ state: 'SUCCEEDED', message: 'Broken; drops seen', postAction: { freshness: { fresh: true }, observation: o } }, { kind: 'action', actionType: 'break_block' });
  assert.match(JSON.stringify(presented.value.notice), /crafting_table x1/);
  const stale = new ModelObservationViews().prepare({ postAction: { freshness: { fresh: false }, observation: o } }, { kind: 'action', actionType: 'break_block' });
  assert.equal(stale.value.notice, undefined);
 } finally { if (previous === undefined) delete process.env.ARENA_LEAN_INPUT; else process.env.ARENA_LEAN_INPUT = previous; }
});

test('a far-off owned station names the materials held for a new one beside it, and nothing without them', () => {
 const o = sample(); o.leftBehind = [{ blockId: 'minecraft:crafting_table', x: 48, y: 64, z: 0 }, { blockId: 'minecraft:furnace', x: 49, y: 64, z: 0 }];
 o.inventory.items = [{ itemId: 'minecraft:oak_planks', count: 3 }, { itemId: 'minecraft:spruce_planks', count: 2 }, { itemId: 'minecraft:cobblestone', count: 12 }];
 assert.match(workNotices(o).join('\n'), /or craft a new one here: crafting_table from 4 planks \(you hold 5\), furnace from 8 cobblestone \(you hold 12\)\./);
 o.inventory.items = [{ itemId: 'minecraft:oak_planks', count: 3 }];
 assert.doesNotMatch(workNotices(o).join('\n'), /or craft/);
});

test('beside the top of its own staircase the agent is told where it leads and how to walk it', () => {
	const o = { player: { x: 96.5, y: 83, z: -39.3 }, inventory: { items: [] }, ownStairs: [{ x: 94, y: 43, z: -80, levels: 40 }] };
	const text = workNotices(o, { actionType: 'craft_table', state: 'SUCCEEDED' }).join(' ');
	assert.match(text, /Your staircase from here goes down 40 levels to 94,43,-80; travel_to 94,43,-80 with retrace:true walks it down\./);
});

test('in the first levels of its own staircase, the agent sees what it carries for underground work when a table or food is missing', () => {
	const dig = { actionType: 'dig_to', state: 'SUCCEEDED' };
	const at = (items, descent = { topY: 83, levels: 27 }) => ({ player: { x: 94.5, y: 56, z: -66.5 }, inventory: { items }, descent });
	const sol = [{ itemId: 'minecraft:stone_pickaxe', count: 1 }, { itemId: 'minecraft:oak_planks', count: 1 }, { itemId: 'minecraft:stick', count: 3 }, { itemId: 'minecraft:cobblestone', count: 64 }];
	assert.match(workNotices(at(sol), dig).join(' '), /27 levels below your staircase top \(y83\), carrying: crafting_table 0, planks 1 \(logs counted as 4\), sticks 3, food 0, furnace 0\. A pickaxe crafted down here needs a table/);
	const kitted = [...sol, { itemId: 'minecraft:crafting_table', count: 1 }, { itemId: 'minecraft:bread', count: 6 }];
	assert.doesNotMatch(workNotices(at(kitted), dig).join(' '), /levels below your staircase top/, 'nothing missing, nothing said');
	assert.doesNotMatch(workNotices(at(sol), { actionType: 'craft_table', state: 'SUCCEEDED' }).join(' '), /levels below/, 'only on a dig result');
	assert.doesNotMatch(workNotices(at(sol, { topY: 83, levels: 60 }), dig).join(' '), /levels below/, 'not deep down, only in the first levels');
	const logs = [...sol, { itemId: 'minecraft:spruce_log', count: 2 }, { itemId: 'minecraft:cooked_beef', count: 3 }];
	assert.doesNotMatch(workNotices(at(logs), dig).join(' '), /levels below/, 'logs make planks for a table');
});
