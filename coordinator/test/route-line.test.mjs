import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE_BYTES, routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
import { beatsTheGame } from '../src/goal-spec-translator.mjs';
import { composeContinuityHeader } from '../src/continuity-header.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { ObservedMemoryStore } from '../src/observed-memory-store.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// The route to beat the game as data: one wake line suggesting the usual next step from the player's state.

const sample = (items, { dimension = 'minecraft:overworld', health = 20, foodLevel } = {}) => ({ ready: true, observedAtEpochMs: 10,
	position: { x: 0, y: 64, z: 0 }, player: { health, ...(foodLevel === undefined ? {} : { foodLevel }) }, world: { dimension }, inventory: { items: items.map(([id, count, slot]) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}) })) } });
const route = (items, options = {}, known = emptyKnown()) => routeLine({ observation: sample(items, options), known, evaluate: evaluatePlanCheck });
const COOKED = [['cooked_beef', 24]];
const SHIELD = ['shield', 1, 'offhand'];
// The kit's armour worn (skill-fits KIT_ARMOUR): with it on, the route goes on to the portal.
const ARMOUR = [['iron_chestplate', 1, 'chest'], ['iron_boots', 1, 'feet']];
const MEAT = [['beef', 4]];
// Wood for the trip down, carried: a crafting table and logs enough for the kit's crafts and smelting.
const TRIP = [['crafting_table', 1], ['oak_log', 8]];
// Nothing for a bed in reach at a lit portal: entry, with the reason the portal bed is skipped.
const ENTRY_NO_BED = 'usual next step: enter the Nether through the lit portal now (no bed, 3 matching wool or sheep in reach: no portal bed; food stocks are optional unless health or hunger is low)';

test('the route walks the usual Overworld order from nothing to a lit portal', () => {
	assert.equal(route([]), 'usual next step: obtain wooden_pickaxe (no tools yet)');
	assert.equal(route(MEAT), 'usual next step: obtain wooden_pickaxe (no tools yet)');
	assert.match(route([['oak_log', 3], ...MEAT]), /obtain wooden_pickaxe \(3 logs\/planks held\)/);
	assert.match(route([['wooden_pickaxe', 1]]), /cooked meat 0\/8/);
	assert.match(route([['stone_pickaxe', 1], ['cobblestone', 5], ...COOKED]), /^usual next step: obtain furnace \(stone tools, 5 cobblestone\)$/);
	// Before the first descent, the wood the whole kit's crafts and smelting take: no table carried, 4 planks more.
	assert.equal(route([['stone_pickaxe', 1], ['furnace', 1], ...COOKED]), "usual next step: obtain log count 5 before going down (wood for the kit's crafts and smelting, so the trip needs no climb back; 0 logs/planks held)");
	// A carried table takes its planks off; the count is a total to hold, and one log stays kept for the next pickaxe's sticks.
	assert.match(route([['stone_pickaxe', 1], ['furnace', 1], ['crafting_table', 1], ['oak_log', 1], ...COOKED]), /^usual next step: obtain log count 5 before going down \(.*1 logs\/planks held\)$/);
	assert.match(route([['stone_pickaxe', 1], ['furnace', 1], ['crafting_table', 1], ['oak_log', 5], ...COOKED]), /^usual next step: obtain iron_ingot count 11 in one trip/);
	// Coal in view fuels the smelting: less wood to carry.
	const coal = sample([['stone_pickaxe', 1], ['furnace', 1], ['crafting_table', 1], ...COOKED]);
	coal.blocks = [{ blockId: 'minecraft:coal_ore', x: 3, y: 60, z: 3, visible: true }];
	assert.match(routeLine({ observation: coal, known: emptyKnown(), evaluate: evaluatePlanCheck }), /^usual next step: obtain log count 2 before going down/);
	// Down a mine the wood step gives way to the trip itself: a missing log must not turn into a climb.
	const deep = sample([['stone_pickaxe', 1], ['furnace', 1], ...COOKED]); deep.position.y = 20; deep.player.skyOpen = false;
	assert.match(routeLine({ observation: deep, known: emptyKnown(), evaluate: evaluatePlanCheck }), /^usual next step: obtain iron_ingot count 11 in one trip/);
	// Then all of the kit's iron in one trip, instead of one obtain (and one search) per item.
	assert.equal(route([['stone_pickaxe', 1], ['furnace', 1], ...TRIP, ...COOKED]), 'usual next step: obtain iron_ingot count 11 in one trip, then craft the kit (kit iron 11: pickaxe 3, shield 1, 2 buckets 6, flint_and_steel 1; 0 iron held)');
	assert.match(route([['stone_pickaxe', 1], ['furnace', 1], ['raw_iron', 2], ...TRIP, ...COOKED]), /obtain iron_ingot count 11 in one trip.*; 2 iron held\)$/);
	// With the trip's iron held, the kit is crafted from it, pickaxe first.
	assert.equal(route([['stone_pickaxe', 1], ['furnace', 1], ['iron_ingot', 11], ...TRIP, ...COOKED]), 'usual next step: obtain iron_pickaxe (stone tools, 11/3 iron held)');
	// Right after the iron pickaxe: a shield in the off hand (skeletons killed 8 of 12 scripted deaths).
	assert.equal(route([['iron_pickaxe', 1], ['iron_ingot', 8], ...TRIP, ...COOKED]), 'usual next step: obtain shield, then equip_item it to offhand (iron 8 held, shield takes 1)');
	assert.equal(route([['iron_pickaxe', 1], ['shield', 1], ['iron_ingot', 7], ...TRIP, ...COOKED]), 'usual next step: equip_item shield to offhand (shield held, not in the off hand)');
	assert.equal(route([['iron_pickaxe', 1], ['iron_ingot', 7], SHIELD, ...TRIP, ...COOKED]),
		'usual next step: obtain bucket count 2, then flint_and_steel (iron 7 held, 7 needed for 2 buckets, flint_and_steel)');
	assert.match(route([['iron_pickaxe', 1], ['bucket', 2], ['iron_ingot', 1], SHIELD, ...TRIP, ...COOKED]), /^usual next step: obtain flint_and_steel \(/);
	// The shield gates the kit even when the buckets and the light came first: its iron is the trip's.
	assert.match(route([['iron_pickaxe', 1], ['bucket', 2], ['flint_and_steel', 1], ...TRIP, ...COOKED]), /^usual next step: obtain iron_ingot count 1 in one trip.*kit iron 1: shield 1/);
	assert.match(route([['iron_pickaxe', 1], ['bucket', 2], ['flint_and_steel', 1], ['iron_ingot', 1], ...TRIP, ...COOKED]), /^usual next step: obtain shield/);
	// Armour once the kit is made and before the portal (iron-kit room: 0 of 26 lanes wore any; with it in the first trip
	// the iron pickaxe came 11 min later), mining its own iron when none is spare.
	const bare = [['iron_pickaxe', 1], ['water_bucket', 1], ['bucket', 1], ['flint_and_steel', 1], SHIELD];
	assert.equal(route([...bare, ...COOKED]), 'usual next step: obtain iron_chestplate, then equip_item it to chest (iron 0 held, kit made; iron_chestplate takes 8, no chest armour worn)');
	assert.equal(route([...bare, ['iron_chestplate', 1], ...COOKED]), 'usual next step: equip_item iron_chestplate to chest (iron_chestplate carried, not worn)');
	// A carried piece of another material is put on as it is, not named as the iron one (which is not held).
	assert.equal(route([...bare, ['golden_chestplate', 1], ...COOKED]), 'usual next step: equip_item golden_chestplate to chest (golden_chestplate carried, not worn)');
	assert.match(route([...bare, ARMOUR[0], ...COOKED]), /^usual next step: obtain iron_boots, then equip_item it to feet/);
	// The buckets and the lighter come first even with spare iron held (the kit habit makes armour from that spare itself).
	assert.match(route([['iron_pickaxe', 1], ['iron_ingot', 15], SHIELD, ...TRIP, ...COOKED]), /^usual next step: obtain bucket count 2, then flint_and_steel/);
	const kit = [...bare, ...ARMOUR];
	assert.match(route([...kit, ...COOKED]), /^usual next step: find block minecraft:lava, then build nether_portal beside the pool \(casts the frame with your buckets, lights it\) \(water bucket held, plain blocks 0\/13, lava pools seen 0\)$/);
	assert.match(route([...kit, ['cobblestone', 16], ...COOKED], {}, { ...emptyKnown(), lavaPools: [{ dimension: 'minecraft:overworld', x: 4, y: 60, z: 4 }] }),
		/^usual next step: build nether_portal beside the lava pool at 4,60,4 \(casts the frame with your buckets and lights it\) \(water bucket held, plain blocks 16\/13, lava pools seen 1\)$/);
	// Without water the step names the verb that fills a bucket (gate games asked obtain for water_bucket and were refused).
	assert.match(route([['iron_pickaxe', 1], ['bucket', 2], ['flint_and_steel', 1], SHIELD, ...ARMOUR, ...COOKED]), /^usual next step: obtain water_bucket, then find block minecraft:lava and build nether_portal beside it \(plain blocks 0\/13, lava pools seen 0\)$/);
	assert.match(route([['iron_pickaxe', 1], ['bucket', 2], ['flint_and_steel', 1], SHIELD, ...ARMOUR, ...COOKED], {}, { ...emptyKnown(), lavaPools: [{ dimension: 'minecraft:overworld', x: 4, y: -50, z: 4 }] }),
		/^usual next step: obtain water_bucket, then find block minecraft:lava nearer than the pool 114 blocks away at 4,-50,4 \(or go there\), then build nether_portal beside it \(/);
	assert.match(route([['iron_pickaxe', 1], ['bucket', 2], ['flint_and_steel', 1], SHIELD, ...ARMOUR, ['obsidian', 10], ...COOKED]), /^usual next step: build nether_portal \(10 obsidian held\)$/);
});

test('ten carried obsidian and a lighter reach build without buckets, water, lava or portal knowledge', () => {
	const kit = [['iron_pickaxe', 1], SHIELD, ...ARMOUR, ['flint_and_steel', 1], ['cooked_beef', 32], ['cobblestone', 64]];
	for (const obsidian of [10, 11]) {
		const line = route([...kit, ['obsidian', obsidian]], { foodLevel: 20 });
		assert.equal(line, `usual next step: build nether_portal (${obsidian} obsidian held)`);
		assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES);
	}
	assert.equal(route([...kit, ['obsidian', 9], ...TRIP]), 'usual next step: obtain iron_ingot count 6 in one trip, then craft the kit (kit iron 6: 2 buckets 6; 0 iron held)');
	assert.equal(route([...kit, ['obsidian', 9], ['iron_ingot', 6], ...TRIP]), 'usual next step: obtain bucket count 2 (iron 6 held, 6 needed for 2 buckets)');
	assert.equal(route([...kit, ['obsidian', 4], ['obsidian', 6]]), 'usual next step: build nether_portal (10 obsidian held)');
});

test('a carried frame still needs the lighter, without gathering casting buckets first', () => {
	const kit = [['iron_pickaxe', 1], SHIELD, ['obsidian', 10], ...COOKED];
	assert.equal(route([...kit, ...TRIP]), 'usual next step: obtain iron_ingot count 1 in one trip, then craft the kit (kit iron 1: flint_and_steel 1; 0 iron held)');
	assert.equal(route([...kit, ['iron_ingot', 2], ['bucket', 1]]), 'usual next step: obtain flint_and_steel (iron 2 held, 1 needed for flint_and_steel)');
	assert.equal(route([['iron_pickaxe', 1], SHIELD, ['obsidian', 9], ['iron_ingot', 7], ...TRIP, ...COOKED]), 'usual next step: obtain bucket count 2, then flint_and_steel (iron 7 held, 7 needed for 2 buckets, flint_and_steel)');
});

test('the production continuity header offers a carried build from current inventory with empty portal memory', async () => {
	const views = new LiveTaskViews();
	const record = { agentId: 'carried-portal', currentGoal: 'beat the game', goalRevision: 1,
		currentGoalSpec: { predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true } } };
	const kit = [['iron_pickaxe', 1], SHIELD, ...ARMOUR, ['flint_and_steel', 1], ...COOKED];
	await views.observe(record, sample([...kit, ['obsidian', 10]]));
	assert.equal(views.continuity(record).route, 'usual next step: build nether_portal (10 obsidian held)');
	// Losing one obsidian returns the route to casting preparation instead of keeping the old carried-kit fact.
	await views.observe(record, { ...sample([...kit, ['obsidian', 9], ['iron_ingot', 6], ...TRIP]), observedAtEpochMs: 11 });
	assert.match(views.continuity(record).route, /^usual next step: obtain bucket count 2/);
});

test('carried obsidian skips only casting needs and retains current tools, shield and survival facts', () => {
	const frame = [['obsidian', 10], ['flint_and_steel', 1]];
	assert.match(route(frame), /^usual next step: obtain wooden_pickaxe/);
	// The carried frame drops the buckets' iron from the trip: pickaxe 3 and shield 1.
	assert.match(route([...frame, ['stone_pickaxe', 1], ['furnace', 1], ...TRIP, ...COOKED]), /^usual next step: obtain iron_ingot count 4 in one trip.*pickaxe 3, shield 1;/);
	assert.match(route([...frame, ['stone_pickaxe', 1], ['furnace', 1], ['iron_ingot', 4], ...TRIP, ...COOKED]), /^usual next step: obtain iron_pickaxe/);
	assert.match(route([...frame, ['iron_pickaxe', 1], ['iron_ingot', 1], ...TRIP, ...COOKED]), /^usual next step: obtain shield/);
	assert.match(route([...frame, ['iron_pickaxe', 1], ['shield', 1], ...COOKED]), /^usual next step: equip_item shield to offhand/);
	const ready = [...frame, ['iron_pickaxe', 1], SHIELD];
	assert.match(route(ready, { health: 8, foodLevel: 20 }), /cooked meat.*before digging below Y40|before digging below Y40.*cooked meat/);
	assert.match(route(ready, { health: 20, foodLevel: 10 }), /cooked meat 0\/8/);
	assert.doesNotMatch(route(ready, { health: 20, foodLevel: 20 }), /low hunger\/health/);
	const observation = sample(ready);
	observation.continuity = { rememberedSections: ['inventory'] };
	assert.equal(routeLine({ observation, known: emptyKnown(), evaluate: evaluatePlanCheck }), null);
});

test('stock eight cooked meat before descent; later hunger advice keeps its threshold', () => {
	assert.match(route([['stone_pickaxe', 1], ['furnace', 1], ['cooked_beef', 4]], { foodLevel: 14 }), /cooked meat 4\/8/);
	assert.doesNotMatch(route([['stone_pickaxe', 1], ['furnace', 1], ['cooked_beef', 12]], { foodLevel: 6 }), /food/);
	assert.match(route([['wooden_pickaxe', 1]], { foodLevel: 6 }), /cooked meat 0\/8/, 'food stock precedes mineral gathering');
	// Healthy hunger no longer skips stocking before the first Nether visit; it does not append a second beef hunt.
	assert.equal(route([['iron_pickaxe', 1], ['bucket', 2], ['flint_and_steel', 1], SHIELD, ['cobblestone', 20]], { foodLevel: 20 }),
		'usual next step: look for nearby cows/pigs/sheep/chickens, then obtain cooked meat with a furnace before digging below Y40 (cooked meat 0/8)');
	assert.match(route([['stone_pickaxe', 1], ['furnace', 1]], { foodLevel: 15 }), /cooked meat 0\/8/);
});

test('a lit portal suggests entering with optional preparation; the Nether and the End have their own steps', () => {
	const known = emptyKnown();
	known.frames.push({ dimension: 'minecraft:overworld', x: 0, y: 60, z: 0, obsidian: 10, lit: true });
	const kit = [['iron_pickaxe', 1], ['water_bucket', 1], ['bucket', 1], SHIELD, ['flint_and_steel', 1]];
	// Three matching wool held: the portal bed comes first (C33), crafted from them, with no search.
	assert.equal(route([...kit, ['cooked_beef', 8], ['cobblestone', 30], ['white_wool', 3]], { health: 15 }, known),
		'usual next step: obtain white_bed, then place_block it by the portal at 0,60,0, interact_block it until "Respawn point set" (by day too), keep it (3 white_wool held)');
	assert.equal(route([...kit, ['cooked_beef', 8], ['cobblestone', 30], ['white_wool', 2]], { health: 15 }, known), ENTRY_NO_BED);
	assert.equal(route([...kit, ['cooked_beef', 10], ['cobblestone', 64]], {}, known), ENTRY_NO_BED);
	assert.equal(route([...kit, ['cooked_beef', 22], ['cobblestone', 64]], {}, known), ENTRY_NO_BED);
	const nether = { dimension: 'minecraft:the_nether' };
	assert.match(route([['blaze_rod', 2]], nether), /find a fortress and fight_until 8 blaze_rods \(no gold worn; rods 2\/8, pearls 0\/15, eyes 0 held \+ 0 set; plan 15 eyes, 12 fill the frame\)/);
	// The eye plan's margin (eye-plan.mjs): 8 rods and 15 pearls before going home.
	assert.match(route([['blaze_rod', 7], ['ender_pearl', 5]], nether), /fight_until 8 blaze_rods/);
	assert.match(route([['blaze_rod', 8], ['ender_pearl', 5]], nether), /get 15 ender_pearls/);
	assert.match(route([['blaze_rod', 8], ['ender_pearl', 13]], nether), /get 15 ender_pearls/);
	assert.match(route([['blaze_rod', 8], ['ender_pearl', 15]], nether), /return home through the portal/);
	assert.match(route([], { dimension: 'minecraft:the_end' }), /kill the ender_dragon/);
});

// The Overworld kit after the first Nether visit: an iron pickaxe and food, so the eye steps are reached.
const KIT = [['iron_pickaxe', 1], ['cooked_beef', 16]];
const visitedNether = () => { const known = emptyKnown(); known.visitedDimensions.push('minecraft:the_nether'); return known; };
const withFrames = (items, filled, total = 12) => ({ ...sample(items), blocks: Array.from({ length: total }, (_, index) => ({ blockId: 'minecraft:end_portal_frame', x: index, y: 30, z: 0, state: { eye: index < filled ? 'true' : 'false' } })) });
const routeAt = (observation, known = visitedNether()) => routeLine({ observation, known, evaluate: evaluatePlanCheck });

test('enough eyes never send the agent back for blazes: missing counts down from eyes held and set in frames', () => {
	assert.match(route([...KIT, ['blaze_rod', 7], ['ender_pearl', 12]], {}, visitedNether()), /craft 12 ender_eyes from pearls and blaze powder/);
	// After crafting: 12 eyes, no loose powder or rods. The old line said "go back to the Nether ... (rods 6/7, pearls 12/12)".
	const crafted = route([...KIT, ['ender_eye', 12]], {}, visitedNether());
	assert.match(crafted, /^usual next step: find structure stronghold\b/);
	assert.doesNotMatch(crafted, /Nether/);
	assert.match(route([...KIT, ['ender_eye', 12]], { dimension: 'minecraft:the_nether' }), /return home through the portal/);
	// Throwing: one eye broke, 11 held; one more eye needs one pearl and one powder (half a rod).
	assert.match(route([...KIT, ['ender_eye', 11]], {}, visitedNether()), /go back to the Nether for 1 blaze_rods and 1 ender_pearls \(rods 0\/1, pearls 0\/1, eyes 11 held/);
	assert.match(route([...KIT, ['ender_eye', 11], ['ender_pearl', 1], ['blaze_powder', 1]], {}, visitedNether()), /craft 1 ender_eyes/);
	// Inserting: eyes leave the inventory into frames, and nothing regresses.
	for (const set of [0, 4, 11]) {
		const line = routeAt(withFrames([...KIT, ['ender_eye', 12 - set]], set));
		assert.match(line, /set the ender_eyes in the empty End portal frames/, `${set} set`);
		assert.match(line, new RegExp(`eyes ${12 - set} held \\+ ${set} set of 12`));
	}
	// The game reports at most 8 blocks of a kind per observation: 11 set and 1 held, but only 8 set frames in view.
	// The old line sent the agent back for 2 rods and 3 pearls; with an eye in hand it sets that eye first.
	const capped = withFrames([...KIT, ['ender_eye', 1]], 8, 8);
	assert.match(routeAt(capped), /set the ender_eyes in the empty End portal frames/);
	assert.doesNotMatch(routeAt(capped), /Nether/);
	const open = withFrames(KIT, 12);
	open.blocks.push({ blockId: 'minecraft:end_portal', x: 5, y: 30, z: 5 });
	assert.match(routeAt(open), /enter the End portal/);
});

test('without a retained portal a death after the first Nether visit keeps the existing preparation route', () => {
	assert.match(route([], {}, visitedNether()), /^usual next step: obtain wooden_pickaxe \(no tools yet; rebuild after the Nether visit\)/);
	assert.match(route([['stone_pickaxe', 1], ['furnace', 1]], {}, visitedNether()), /^usual next step: obtain iron_pickaxe \(stone tools, no iron yet; rebuild after the Nether visit\)/);
	assert.match(route([['iron_pickaxe', 1], ['cooked_beef', 3]], { foodLevel: 10 }, visitedNether()), /obtain cooked_beef count 17 before going on \(food 3\/10/);
	assert.match(route([...KIT, ['blaze_rod', 3], ['ender_pearl', 12]], {}, visitedNether()), /go back to the Nether for 4 blaze_rods/);
});

test('urgent spawn food gives way to tools, then cooked stock precedes iron', () => {
	// No food at spawn: the food step comes first, as a suggestion naming the nearest animal's meat and an opt-out.
	assert.equal(route([], { foodLevel: 10 }), 'usual next step: obtain beef count 4 (or porkchop, mutton or chicken from the nearest animal; skip if none in view) (no food held, health regrows only at hunger 18+)');
	// Food carried (raw or cooked, any meat or other food, even one piece left after eating) moves on to the tools.
	for (const meat of [[['chicken', 1]], [['apple', 6]], [['carrot', 8]], [['beef', 4]], [['porkchop', 4]], [['mutton', 2], ['chicken', 2]], [['bread', 4]], [['cooked_beef', 5]]]) {
		assert.equal(route(meat), 'usual next step: obtain wooden_pickaxe (no tools yet)', JSON.stringify(meat));
	}
	// Urgent raw food gives way to tools, then the new cooked stock precedes the iron descent.
	assert.match(route([['wooden_pickaxe', 1]]), /cooked meat 0\/8/);
	assert.match(route([['stone_pickaxe', 1], ['furnace', 1]]), /cooked meat 0\/8/);
	assert.match(route([['iron_pickaxe', 1]]), /cooked meat 0\/8/);
	for (const items of [[['wooden_pickaxe', 1]], [['stone_pickaxe', 1], ['furnace', 1]], [['iron_pickaxe', 1], SHIELD]]) assert.doesNotMatch(route(items), /beef/);
	// After the portal is lit or the Nether visited (a death there loses the pickaxe too), no food step.
	const lit = emptyKnown();
	lit.frames.push({ dimension: 'minecraft:overworld', x: 0, y: 60, z: 0, obsidian: 10, lit: true });
	assert.doesNotMatch(route([], {}, lit), /beef/);
	assert.equal(route([], {}, visitedNether()), 'usual next step: obtain wooden_pickaxe (no tools yet; rebuild after the Nether visit)');
	assert.doesNotMatch(route([], { foodLevel: 6 }), /cooked_beef on the way/);
	// Raw meat is cooked before another hunt; it does not satisfy the cooked stock.
	const hungry = route([['stone_pickaxe', 1], ['furnace', 1], ['beef', 4]], { foodLevel: 10 });
	assert.match(hungry, /obtain cooked_beef count 4/);
	assert.match(hungry, /raw meat held/);
	assert.doesNotMatch(hungry, /food 0 held/);
});

test('the route line stays within its byte budget and needs a live sample', () => {
	for (const items of [[], [['iron_pickaxe', 1]], [['iron_pickaxe', 1], SHIELD], [['stone_pickaxe', 1], ['furnace', 1]]]) assert.ok(Buffer.byteLength(route(items)) <= ROUTE_BYTES);
	assert.equal(routeLine({ observation: { ...sample([]), ready: false }, known: emptyKnown(), evaluate: evaluatePlanCheck }), null);
	assert.equal(routeLine({ observation: sample([]), known: null, evaluate: evaluatePlanCheck }), null);
});

test('only a beat-the-game goal carries the route, and it rides the wake header beside the plan', () => {
	assert.equal(beatsTheGame({ predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true } }), true);
	assert.equal(beatsTheGame({ predicate: { type: 'all_of', predicates: [{ type: 'inventory_contains', itemId: 'minecraft:bread', count: 1 }, { type: 'advancement_granted', advancementId: 'minecraft:story/enter_the_end' }] } }), true);
	assert.equal(beatsTheGame({ predicate: { type: 'inventory_contains', itemId: 'minecraft:iron_ingot', count: 3 } }), false);
	assert.equal(beatsTheGame(null), false);
	const header = composeContinuityHeader({ goal: 'Beat the game', progress: 'open iron[...]', route: 'usual next step: obtain iron_pickaxe (stone tools, no iron yet)' });
	assert.deepEqual(Object.keys(header), ['plan', 'route']);
});

test('review: obtain counts are totals to hold, and a filled bucket counts toward the two', () => {
	const COOKED = [['cooked_beef', 20]];
	const IRON = [['iron_ingot', 7], ...TRIP];
	assert.match(route([['iron_pickaxe', 1], ['bucket', 1], SHIELD, ...IRON, ...COOKED]), /^usual next step: obtain bucket count 2,/);
	assert.match(route([['iron_pickaxe', 1], ['water_bucket', 1], SHIELD, ...IRON, ...COOKED]), /^usual next step: obtain bucket count 1,/);
	assert.match(route([['iron_pickaxe', 1], SHIELD, ...IRON, ...COOKED]), /^usual next step: obtain bucket count 2,/);
	// The trip's iron is a total to hold too: a bucket already made takes its 3 off the kit.
	assert.match(route([['iron_pickaxe', 1], ['bucket', 1], SHIELD, ...TRIP, ...COOKED]), /^usual next step: obtain iron_ingot count 4 in one trip/);
});

test('offhand:<id> holds only for the item in the off hand slot', () => {
	const check = items => evaluatePlanCheck('offhand:minecraft:shield', sample(items), emptyKnown());
	assert.equal(check([SHIELD]).ok, true);
	assert.equal(check([['shield', 1]]).ok, false, 'a carried shield is not held in the off hand');
	assert.equal(check([['totem_of_undying', 1, 'offhand'], ['shield', 1]]).ok, false);
	assert.equal(evaluatePlanCheck('offhand:minecraft:shield', { ...sample([SHIELD]), ready: false }, emptyKnown()).ok, null);
});

test('review: a shield lost after the portal is lit or the Nether visited does not hold the route back', () => {
	const known = emptyKnown();
	known.frames.push({ dimension: 'minecraft:overworld', x: 0, y: 60, z: 0, obsidian: 10, lit: true });
	const kit = [['iron_pickaxe', 1], ['bucket', 2], ['flint_and_steel', 1]];
	assert.equal(route([...kit, ['cooked_beef', 10], ['cobblestone', 64]], {}, known), ENTRY_NO_BED);
	assert.doesNotMatch(route([...kit, ['totem_of_undying', 1, 'offhand'], ['cooked_beef', 10], ['cobblestone', 64]], {}, known), /shield/);
});

// Synthetic offline cases. Live restore and first-wake proof belong to the parent gameplay lane.
const portal = { blockId: 'minecraft:nether_portal', x: 30, y: -20, z: 7 };
const portalMemory = (extra = {}) => ({ position: { x: 0, y: 64, z: 0 }, known: {
	sightings: [{ what: portal.blockId, kind: 'portal', x: portal.x, y: portal.y, z: portal.z, tick: 100 }], blocks: [], ...extra,
} });
const recoveryRoute = (observation = sample([]), memory = portalMemory(), known = visitedNether()) =>
	routeLine({ observation, memory, known, evaluate: evaluatePlanCheck });

test('retained scoped portal bypasses kit and food quotas with only route tools left to decide', () => {
	for (const items of [[], [['wooden_pickaxe', 1]], [['stone_pickaxe', 1]], KIT]) {
		const line = recoveryRoute(sample(items));
		assert.match(line, /return via known Overworld portal at 30,-20,7 to the Nether/);
		assert.match(line, /active portal needs no iron pick or ignition; use held tools/);
		assert.match(line, /food stocking optional while healthy/);
		assert.doesNotMatch(line, /obtain|iron_pickaxe|furnace|count|bed/);
		assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES);
	}
	for (const options of [{ health: 8, foodLevel: 20 }, { health: 20, foodLevel: 10 }]) {
		const line = recoveryRoute(sample([['apple', 2]], options));
		assert.match(line, /low health\/hunger, food 2 held: recover first/);
		assert.doesNotMatch(line, /stocking optional/);
		assert.doesNotMatch(line, /quota|count|bed|iron_pickaxe/);
		assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES);
	}
	assert.match(recoveryRoute(sample([]), { known: { blocks: [portal], sightings: [] } }), /at 30,-20,7/);
	const large = recoveryRoute(sample([], { health: 8 }), { known: { blocks: [{ ...portal, x: -30000000, y: -2048, z: -30000000 }] } });
	assert.ok(Buffer.byteLength(large, 'utf8') <= ROUTE_BYTES);
	assert.equal(Buffer.from(large).toString('utf8'), large);
});

test('canonical or bare entry advancement recovers a lost visit flag without inventing portal coordinates', () => {
	for (const id of ['story/enter_the_nether', 'minecraft:story/enter_the_nether']) {
		assert.match(recoveryRoute({ ...sample([]), advancements: [id] }, portalMemory(), emptyKnown()), /at 30,-20,7/);
		const known = emptyKnown(); known.advancements = [id];
		assert.match(recoveryRoute(sample([]), portalMemory(), known), /at 30,-20,7/);
	}
	assert.doesNotMatch(recoveryRoute(sample([]), portalMemory(), emptyKnown()), /known Overworld portal/);
});

test('End portal and capped frames with a held eye take priority even with no kit and a remembered Nether portal', () => {
	const open = { ...sample([], { health: 8 }), blocks: [{ blockId: 'minecraft:end_portal', x: 1, y: 30, z: 1 }] };
	// The End kit note (end-readiness.mjs) rides behind the head; the head stays the portal.
	assert.match(recoveryRoute(open), /^usual next step: enter the End portal \(portal open; End kit lacks /);
	const capped = withFrames([['ender_eye', 1]], 8, 8);
	assert.match(recoveryRoute(capped), /set the ender_eyes in the empty End portal frames/);
	assert.doesNotMatch(recoveryRoute(capped), /Nether|rebuild/);
	assert.match(recoveryRoute(sample([], { dimension: 'minecraft:the_nether' })), /find a fortress/);
	assert.match(recoveryRoute(sample([], { dimension: 'minecraft:the_end' })), /kill the ender_dragon/);
});

test('unknown, wrong-scope and remembered-only locations cannot become recovery coordinates', () => {
	const o = { ...sample([]), world: { worldId: 'w', dimension: 'minecraft:overworld' }, blocks: [portal],
		sighted: { poi: [portal] } };
	const known = visitedNether(); known.frames = [{ ...portal, dimension: 'minecraft:overworld', lit: true }];
	for (const memory of [
		{ known: { sightings: [], blocks: [] } }, portalMemory({ worldId: 'other' }),
		portalMemory({ dimension: 'minecraft:the_nether' }),
		{ known: { sightings: [{ what: portal.blockId, x: 30, z: 7 }] } },
		{ known: { blocks: [{ ...portal, dimension: 'minecraft:the_nether' }] } },
	]) assert.doesNotMatch(recoveryRoute(o, memory, known), /known Overworld portal|30,-20,7/);
	assert.match(recoveryRoute(o, null), /at 30,-20,7/, 'direct visible blocks work without a memory source');
	for (const blocks of [[{ ...portal, visible: false }], [{ ...portal, remembered: true }], []])
		assert.doesNotMatch(recoveryRoute({ ...o, blocks }, null, known), /known Overworld portal|30,-20,7/);
	assert.doesNotMatch(recoveryRoute({ ...o, continuity: { rememberedSections: ['blocks'] } }, null), /known Overworld portal/);
});

test('production restored memory reaches the encoded wake and withdrawn portals never rebound from repeated poi', async t => {
	const directory = await mkdtemp(join(tmpdir(), 'route-memory-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const record = { agentId: 'recovery-route', currentGoal: 'beat the game', goalRevision: 1,
		currentGoalSpec: { predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true } } };
	const obs = (tick, extra = {}) => ({ ...sample([]), observedAtEpochMs: tick * 50,
		world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime: tick }, advancements: ['story/enter_the_nether'], ...extra });
	const saved = new ObservedMemoryStore({ directory });
	saved.ingest(record.agentId, obs(100, { sighted: { poi: [portal] } }));
	await saved.flush(record.agentId);
	const memory = new ObservedMemoryStore({ directory }); await memory.load(record.agentId);
	const views = new LiveTaskViews({ sources: (r, o, pattern) => memory.knownSources(r.agentId, o, pattern) });
	const wake = async o => {
		const before = structuredClone(o);
		memory.ingest(record.agentId, o, { snapshot: false }); await views.observe(record, o);
		const continuity = views.continuity(record);
		const input = buildNativeEventInput(record, { event: 'observation', trigger: 'start', newContext: true, observation: o, continuity });
		const encoded = encodeNativeEventInput(input, new ModelObservationViews());
		const facts = decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n') + 1)));
		assert.deepEqual(o, before, 'the production projection does not mutate its observation');
		assert.equal(facts.now.route, continuity.route);
		return continuity.route;
	};
	assert.match(await wake(obs(200)), /at 30,-20,7/);
	assert.match(await wake(obs(201, { sighted: { portalFrames: [{ x: 30, y: -20, z: 7, lit: true, obsidian: 10 }] } })), /at 30,-20,7/);
	const repeat = { sighted: { poi: [portal] } };
	assert.doesNotMatch(await wake(obs(210, { ...repeat, blocks: [{ ...portal, blockId: 'minecraft:air' }] })), /known Overworld portal|30,-20,7/);
	assert.doesNotMatch(await wake(obs(220, repeat)), /known Overworld portal|30,-20,7/);
	assert.deepEqual(memory.knownSources(record.agentId, obs(220)).sightings, []);
	assert.doesNotMatch(await wake({ ...obs(230), world: { worldId: 'other', dimension: 'minecraft:overworld', gameTime: 230 } }), /known Overworld portal|30,-20,7/);
});

// Reviewer reproduction: portal blocks must survive the real source-pattern projection.
test('block-only remembered portal reaches the encoded recovery route and respects withdrawal', async () => {
 const record = {agentId:'block-recovery', currentGoal:'beat the game', goalRevision:1, currentGoalSpec:{predicate:{type:'entity_killed_by_agent',entityType:'minecraft:ender_dragon',afterGoalStart:true}}};
 const memory = new ObservedMemoryStore();
 const views = new LiveTaskViews({sources:(r,o,p)=>memory.knownSources(r.agentId,o,p)});
 const wake = async (tick, blocks=[]) => {
  const o = {...sample([]), world:{worldId:'block-world',dimension:'minecraft:overworld',gameTime:tick}, observedAtEpochMs:tick*50, advancements:['story/enter_the_nether'], blocks};
  memory.ingest(record.agentId,o); await views.observe(record,o);
  const continuity=views.continuity(record);
  const encoded=encodeNativeEventInput(buildNativeEventInput(record,{event:'observation',trigger:'start',newContext:true,observation:o,continuity}),new ModelObservationViews());
  return decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n')+1))).now.route;
 };
 assert.match(await wake(100,[{...portal,visible:true}]),/at 30,-20,7/);
 assert.match(await wake(200),/at 30,-20,7/);
 assert.doesNotMatch(await wake(210,[{...portal,blockId:'minecraft:air',visible:true}]),/known Overworld portal/);
 assert.doesNotMatch(await wake(220),/known Overworld portal/);
});

// A tally covers only seen crystals, so it must never promise that all ten are gone.
test('a remembered cleared crystal set suggests the fight while keeping unseen healing crystals possible', () => {
 const o=sample([], {dimension:'minecraft:the_end'}), known=emptyKnown();
 known.crystals={standing:0,caged:0,broken:1};
 const text=routeLine({observation:o,known,evaluate:evaluatePlanCheck});
 assert.match(text,/fight the dragon from open ground near the exit fountain/);
 assert.match(text,/no remembered standing crystals; if it heals, look for others/);
 assert.doesNotMatch(text,/all.*gone|cannot heal|break the end crystals first/);
 assert.ok(Buffer.byteLength(text)<=ROUTE_BYTES);
 for (const crystals of [null,{standing:1,caged:1,broken:9},{standing:0,caged:0,broken:0}]) {
  known.crystals=crystals;
  assert.match(routeLine({observation:o,known,evaluate:evaluatePlanCheck}),/break the end crystals first/);
 }
});

test('a cached standing-crystal wake keeps its own priority after the latest sample clears it', async () => {
 const {buildNativeEventInput}=await import('../src/dynamic-main.mjs');
 const record={agentId:'cached-crystal',currentGoal:'beat the game',goalRevision:1,currentGoalSpec:{predicate:{type:'entity_killed_by_agent',entityType:'minecraft:ender_dragon',afterGoalStart:true}}};
 const views=new LiveTaskViews();
 const at=(n,endCrystals)=>({...sample([],{dimension:'minecraft:the_end'}),observedAtEpochMs:n,world:{worldId:'cached-end',dimension:'minecraft:the_end'},endCrystals});
 const standing=at(2,{standing:[{x:10,y:85,z:10,caged:true}],broken:1});
 const cleared=at(3,{standing:[],broken:2});
 await views.observe(record,standing); await views.observe(record,cleared);
 assert.match(views.continuity(record).route,/fight the dragon from open ground/);
 const continuity=views.continuity(record,{observation:standing});
 assert.match(continuity.route,/break the end crystals first/);
 const payload=JSON.parse(buildNativeEventInput(record,{event:'observation',observation:standing,continuity}).split('\n')[1]);
 assert.match(payload.combat,/1 standing when last seen/);
 assert.doesNotMatch(continuity.route,/no remembered standing/);
});

// Initial-stock advice must not send a post-Nether body back through the full kit.
for (const evidence of ['visited', 'known advancement', 'current advancement']) test(`post-Nether ${evidence} rebuild remains pickaxe first`, () => {
 const known = emptyKnown(); const extra = {};
 if (evidence === 'visited') known.visitedDimensions.push('minecraft:the_nether');
 else if (evidence === 'known advancement') known.advancements.push('minecraft:story/enter_the_nether');
 else extra.advancements = ['minecraft:story/enter_the_nether'];
 const render = items => routeLine({ observation: { ...sample(items), ...extra }, known, evaluate: evaluatePlanCheck });
 const first = render([]);
 assert.match(first, /obtain wooden_pickaxe/);
 const next = render([['stone_pickaxe', 1], ['furnace', 1]]);
 assert.match(next, /obtain iron_pickaxe/);
 assert.doesNotMatch(next, /chestplate|cooked meat|64 before portal/);
});
