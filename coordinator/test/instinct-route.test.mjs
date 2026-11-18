import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE_BYTES, routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';

// Issue 2 Step 2 item 5: the weapon habit, a route step of the instincts arm only.

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
	assert.match(route([...STONE, ...COOKED], {}, false), /^usual next step: obtain furnace/, 'flag off: no weapon step');
});
