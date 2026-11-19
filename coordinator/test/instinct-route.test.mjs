import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE_BYTES, routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';

// Issue 2 Step 2 items 5 and 6: the weapon habit and food in every dimension, route steps of the instincts arm only.

const sample = (items, { dimension = 'minecraft:overworld', health = 20, foodLevel = 20, entities = [] } = {}) => ({ ready: true, observedAtEpochMs: 10,
	position: { x: 0, y: 64, z: 0 }, player: { health, foodLevel }, world: { dimension }, entities,
	inventory: { items: items.map(([id, count, slot, hotbar]) => ({ itemId: `minecraft:${id}`, count, ...(slot === undefined ? {} : { slot }), ...(hotbar === undefined ? {} : { hotbar }) })) } });
const route = (items, options = {}, instincts = true, known = emptyKnown()) => routeLine({ observation: sample(items, options), known, evaluate: evaluatePlanCheck, instincts });
const COOKED = [['cooked_beef', 24, 3, true]];
const STONE = [['stone_pickaxe', 1, 0, true], ['cobblestone', 5, 10, false]];

test('weapon habit: after the stone pickaxe, obtain a stone sword while no stone-or-better sword or axe is held', () => {
	assert.equal(route([...STONE, ...COOKED]), 'usual next step: obtain stone_sword (no stone-or-better sword or axe; defend and fights swing the best one held)');
	assert.match(route([...STONE, ['wooden_sword', 1, 1, true], ...COOKED]), /obtain stone_sword/, 'a wooden sword does not count');
	assert.match(route([...STONE, ['golden_axe', 1, 1, true], ...COOKED]), /obtain stone_sword/, 'gold does not count');
	assert.match(route([...STONE, ['stone_sword', 1, 1, true], ...COOKED]), /^usual next step: obtain furnace/);
	assert.match(route([...STONE, ['iron_axe', 1, 1, true], ...COOKED]), /^usual next step: obtain furnace/);
	assert.match(route([['wooden_pickaxe', 1, 0, true], ...COOKED]), /cooked meat|stone_pickaxe/, 'not before the stone pickaxe');
	const lit = { ...emptyKnown(), frames: [{ dimension: 'minecraft:overworld', x: 1, y: 64, z: 1, lit: true }] };
	assert.doesNotMatch(route([...STONE, ...COOKED], {}, true, lit) ?? '', /stone_sword/, 'a lit portal ends it');
	const visited = { ...emptyKnown(), visitedDimensions: ['minecraft:the_nether'] };
	assert.doesNotMatch(route([...STONE, ...COOKED], {}, true, visited) ?? '', /stone_sword/, 'a Nether visit ends it');
	assert.match(route([...STONE, ...COOKED], {}, false), /^usual next step: obtain furnace/, 'flag off: no weapon step');
});

test('food in reach: food only in the main inventory is moved into the hotbar first, in any dimension', () => {
	const stored = [['iron_pickaxe', 1, 0, true], ['cooked_beef', 10, 20, false]];
	const line = route(stored, { foodLevel: 17 });
	assert.equal(line, 'usual next step: select_tool sourceSlot:20 hotbarSlot:8 expectedItemId:minecraft:cooked_beef minRemainingDurability:0 (food only in the main inventory; the eat reflex reads the hotbar and offhand)');
	assert.match(route([...stored, ['torch', 5, 8, true]], { foodLevel: 17 }), /hotbarSlot:7 /, 'an empty hotbar slot is named');
	assert.doesNotMatch(route(stored, { foodLevel: 20 }), /select_tool/, 'full and unhurt: no move line to crowd out the route');
	assert.match(route(stored, { foodLevel: 20, health: 12 }), /select_tool/, 'hurt: the move line comes first');
	assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES);
	assert.match(route(stored, { dimension: 'minecraft:the_nether', foodLevel: 17 }), /^usual next step: select_tool sourceSlot:20/);
	assert.match(route(stored, { dimension: 'minecraft:the_end', foodLevel: 17 }), /^usual next step: select_tool sourceSlot:20/);
	assert.doesNotMatch(route([['iron_pickaxe', 1, 0, true], ['cooked_beef', 10, 'offhand']], { foodLevel: 17 }), /select_tool/, 'offhand food is in reach');
	assert.doesNotMatch(route([['iron_pickaxe', 1, 0, true], ['cooked_beef', 10, 20, false], ['bread', 2, 4, true]], { foodLevel: 17 }), /select_tool/, 'some food in the hotbar is enough');
	assert.doesNotMatch(route([['iron_pickaxe', 1], ['cooked_beef', 10]], { foodLevel: 17 }), /select_tool/, 'rows without slot facts count as in reach');
	assert.equal(route(stored, { foodLevel: 17 }, false), routeLine({ observation: sample(stored, { foodLevel: 17 }), known: emptyKnown(), evaluate: evaluatePlanCheck }), 'flag off: byte for byte the old line');
});

test('food in reach: food the eat reflex will not top up on does not count as in reach', () => {
	const mixed = [['iron_pickaxe', 1, 0, true], ['chicken', 3, 1, true], ['cooked_beef', 10, 20, false]];
	assert.match(route(mixed, { foodLevel: 17, health: 12 }), /^usual next step: select_tool sourceSlot:20 hotbarSlot:8 expectedItemId:minecraft:cooked_beef /,
		'raw chicken in the hotbar at hunger 17: the reflex sleeps, so the cooked beef is moved into reach');
	assert.doesNotMatch(route(mixed, { foodLevel: 12, health: 12 }) ?? '', /select_tool/, 'below hunger 14 the reflex eats the chicken: no move');
	assert.doesNotMatch(route([['iron_pickaxe', 1, 0, true], ['chicken', 3, 1, true], ['chicken', 5, 20, false]], { foodLevel: 17 }) ?? '', /select_tool/,
		'only top-up-skipped food carried: no move line that would not help');
});

test('food in reach: any food the eat reflex accepts is moved when it is the only food it would eat', () => {
	const apple = [['iron_pickaxe', 1, 0, true], ['golden_apple', 1, 20, false]];
	assert.match(route(apple, { foodLevel: 17, health: 6 }), /^usual next step: select_tool sourceSlot:20 hotbarSlot:8 expectedItemId:minecraft:golden_apple /,
		'health 6: the reflex would eat a golden apple, so it is moved into reach');
	assert.doesNotMatch(route(apple, { foodLevel: 17, health: 12 }) ?? '', /select_tool/, 'health 12 at hunger 17: the reflex keeps the apple, no move');
	assert.match(route([['iron_pickaxe', 1, 0, true], ['rotten_flesh', 4, 20, false]], { foodLevel: 8 }), /^usual next step: select_tool sourceSlot:20 .*rotten_flesh/,
		'hunger 8: rotten flesh is eaten, so it is moved into reach');
	assert.match(route([['iron_pickaxe', 1, 0, true], ['bread', 2, 4, true], ['cooked_beef', 10, 20, false]], { foodLevel: 17, health: 6 }) ?? '', /^(?!.*select_tool)/,
		'food the reflex eats already in the hotbar: no move');
});

test('food in every dimension: with none carried and hungry, a source in view first, else a note before more travel', () => {
	const hog = [{ type: 'minecraft:hoglin', distance: 12, x: 12, y: 64, z: 0 }];
	const kit = [['iron_pickaxe', 1, 0, true], ['blaze_rod', 0, 1, true]];
	assert.equal(route(kit, { dimension: 'minecraft:the_nether', foodLevel: 10, entities: hog }),
		'usual next step: fight_target the hoglin in view for porkchop (cook it or eat it raw) (no food held; health regrows only at hunger 18+)');
	assert.match(route(kit, { dimension: 'minecraft:the_nether', foodLevel: 10 }), /^usual next step: no food source in view, take one when seen; .*fortress/);
	assert.match(route(kit, { dimension: 'minecraft:the_nether', foodLevel: 10, health: 8, entities: hog }), /^usual next step: no food source in view, take one when seen; /, 'at health 10 or less a hoglin is not a food source');
	assert.match(route(kit, { dimension: 'minecraft:the_end', health: 12 }), /^usual next step: no food source in view, take one when seen; /);
	const cow = [{ type: 'minecraft:cow', distance: 8, x: 8, y: 64, z: 0 }];
	assert.equal(route([['iron_pickaxe', 1, 0, true]], { foodLevel: 12, entities: cow }), 'usual next step: obtain beef count 4 from the animal in view (no food held; health regrows only at hunger 18+)');
	assert.doesNotMatch(route(kit, { dimension: 'minecraft:the_nether', foodLevel: 20 }), /food source/, 'not hungry or hurt: no food line');
	assert.doesNotMatch(route(kit, { dimension: 'minecraft:the_nether', foodLevel: 10, entities: hog }, false), /hoglin|food source/, 'flag off: the Nether line has no food line');
	for (const line of [route(kit, { dimension: 'minecraft:the_nether', foodLevel: 10 }), route(kit, { dimension: 'minecraft:the_end', health: 12 })])
		assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES, line);
});
