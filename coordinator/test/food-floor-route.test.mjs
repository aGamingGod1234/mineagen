import test from 'node:test';
import assert from 'node:assert/strict';
import { FOOD_FLOOR_DESCENT, FOOD_FLOOR_PORTAL, PORTAL_ENTRY_NEXT, ROUTE_BYTES, WOOD_FLOOR, routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';

// stock.foodFloor on (the default): food is a points minimum over every food type, held before the first descent and
// before the Overworld portal, re-armed after a death, and raised to every animal in view. The off arm keeps the old
// 8-cooked-meat hint (surface-food-route.test.mjs and the other route tests pin it).

const ON = {};
const OFF = { MINEAGEN_FOOD_FLOOR: 'off' };
const item = (id, count = 1, slot) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}) });
const TOOLS = [item('stone_pickaxe'), item('furnace')];
const cow = (n, distance = 8) => ({ stableId: `cow-${n}`, type: 'minecraft:cow', distance, alive: true, x: distance, y: 64, z: n });
const sample = (items = TOOLS, { entities = [], y = 64, health = 20, foodLevel = 20, skyOpen } = {}) => ({ ready: true, observedAtEpochMs: 1000,
	world: { worldId: 'w', dimension: 'minecraft:overworld' }, position: { x: 0, y, z: 0 }, player: { health, foodLevel, ...(skyOpen === undefined ? {} : { skyOpen }) },
	inventory: { items }, entities });
const litFrame = () => { const known = emptyKnown(); known.frames.push({ dimension: 'minecraft:overworld', x: 0, y: 60, z: 0, axis: 'x', obsidian: 10, needed: 10, lit: true }); return known; };
const visited = () => { const known = emptyKnown(); known.visitedDimensions.push('minecraft:the_nether'); return known; };
const line = (o, { known = emptyKnown(), environment = ON, ...rest } = {}) => routeLine({ observation: o, known, evaluate: evaluatePlanCheck, environment, ...rest });

test('the floors come from the measured damage rates and are minimums, not caps', () => {
	assert.equal(FOOD_FLOOR_PORTAL, 256);
	assert.ok(FOOD_FLOOR_DESCENT > FOOD_FLOOR_PORTAL);
	assert.equal(WOOD_FLOOR, 12);
	assert.match(line(sample()), new RegExp(`food 0/${FOOD_FLOOR_DESCENT} points \\(minimum, not a cap\\)`));
});

test('half a stock no longer lets the bot go down while healthy with nothing in view', () => {
	const half = sample([...TOOLS, item('cooked_beef', 4)]);
	// Before: 4 cooked meat, healthy, no animal in view released the stock and the route moved on to the trip.
	assert.doesNotMatch(line(half, { environment: OFF }), /cooked/);
	const text = line(half);
	assert.match(text, /look for cows\/pigs\/sheep\/chickens nearby/); assert.match(text, /food 63\/320 points/);
});

test('every food counts toward the floor, by hunger plus saturation', () => {
	// Each item counts its saturation plus the 3 hunger the bar takes when the eat reflex fires below 18.
	const mixed = [...TOOLS, item('bread', 10), item('cooked_porkchop', 14)];
	assert.match(line(sample(mixed)), /food 311\/320/);
	assert.doesNotMatch(line(sample([...mixed, item('golden_carrot')])), /food \d+\/320/);
	// Berries count, but at 2.4 points each 64 of them are not a stock.
	assert.match(line(sample([...TOOLS, item('sweet_berries', 64)])), /food 154\/320/);
});

test('the count reaches the floor, and a herd in view is taken whole', () => {
	assert.match(line(sample(TOOLS, { entities: [cow(1)] })), /obtain cooked_beef count 21 using a furnace, taking every cow in view, before going down/);
	// 19 cooked beef is 2 short of the floor, but the 5 cows in view are all taken while they are here.
	assert.match(line(sample([...TOOLS, item('cooked_beef', 19)], { entities: [1, 2, 3, 4, 5].map(n => cow(n)) })), /obtain cooked_beef count 24 /);
	// Raw meat held is cooked first, all of it.
	assert.match(line(sample([...TOOLS, item('beef', 20)])), /obtain cooked_beef count 20 .*raw meat held/);
	// Hidden, baby, far and heard-only animals are not in view.
	const unseen = [{ ...cow(1), visible: false }, { ...cow(2), baby: true }, cow(3, 100), { ...cow(4), perceivedBy: 'sound' }];
	assert.match(line(sample(TOOLS, { entities: unseen })), /look for cows/);
});

test('the floor lets go only underground or after a failed hunt with nothing in view', () => {
	assert.doesNotMatch(line(sample(TOOLS, { y: 30, skyOpen: false })), /food \d+\/320/);
	assert.doesNotMatch(line(sample(TOOLS), { foodHandedBack: true }), /food \d+\/320/);
	assert.match(line(sample(TOOLS, { entities: [cow(1)] }), { foodHandedBack: true }), /obtain cooked_beef/);
});

test('the trip carries at least 12 logs of wood, 15 without coal to cook with', () => {
	const fed = [...TOOLS, item('cooked_beef', 21)];
	assert.match(line(sample([...fed, item('oak_log', 2)])), /obtain log count 15 before going down/);
	assert.match(line(sample([...fed, item('oak_log', 2), item('oak_planks', 8)])), /obtain log count 13 before going down/);
	assert.match(line(sample([...fed, item('oak_log', 2), item('coal', 3)])), /obtain log count 12 before going down/);
});

test('a lit portal waits for the floor and the wood before the entry', () => {
	const known = litFrame();
	const fed = [item('iron_pickaxe'), item('cooked_beef', 17), item('oak_log', 15)];
	assert.match(line(sample([item('iron_pickaxe'), item('cooked_beef', 2), item('oak_log', 15)], { entities: [cow(1)] }), { known }),
		/obtain cooked_beef count 17 using a furnace, taking every cow in view, before entering the portal \(food 32\/256/);
	assert.match(line(sample([item('iron_pickaxe'), item('cooked_beef', 17)]), { known }), /obtain log count 15 before entering the portal/);
	const go = line(sample(fed), { known });
	assert.ok(go.startsWith(`usual next step: ${PORTAL_ENTRY_NEXT}`), go); assert.match(go, /carry 256\+ food points/);
	// Before: the entry came at once with no food, and called food optional.
	assert.match(line(sample([item('iron_pickaxe')]), { known, environment: OFF }), /food stocks are optional/);
});

test('a death past the portal stage re-arms the stock at the portal floor', () => {
	const after = line(sample([item('wooden_pickaxe')]), { known: visited(), diedSincePortal: true });
	assert.match(after, /food 0\/256 points .*re-kit after a death/);
	assert.match(line(sample([item('wooden_pickaxe'), item('cooked_porkchop', 17)]), { known: visited(), diedSincePortal: true }), /obtain stone_pickaxe/);
	// Before: a re-kit never stocked food at full hunger.
	assert.doesNotMatch(line(sample([item('wooden_pickaxe')]), { known: visited(), diedSincePortal: true, environment: OFF }), /food|cooked/);
});

test('every floor line fits the route budget unclipped', () => {
	const cases = [sample(TOOLS, { entities: [{ ...cow(1), type: 'minecraft:chicken' }] }), sample([...TOOLS, item('porkchop', 3)])];
	for (const o of cases) { const text = line(o); assert.ok(Buffer.byteLength(text) <= ROUTE_BYTES && !text.endsWith('…'), text); }
	const portal = line(sample([item('iron_pickaxe')], { entities: [{ ...cow(1), type: 'minecraft:sheep' }] }), { known: litFrame() });
	assert.ok(Buffer.byteLength(portal) <= ROUTE_BYTES && !portal.endsWith('…'), portal);
});
