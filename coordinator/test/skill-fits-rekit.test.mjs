import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE_BYTES, portalDeathMark, routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { ObservedMemoryStore } from '../src/observed-memory-store.mjs';

// EV-KIT-4: a death past the portal stage (a lit frame or a Nether visit) takes the kit, and the route asks for it again
// (tools, iron pickaxe, shield, armour, food when hungry) before it sends the respawn back through the portal.

const sample = (items, { dimension = 'minecraft:overworld', health = 20, foodLevel } = {}) => ({ ready: true, observedAtEpochMs: 10,
	position: { x: 0, y: 64, z: 0 }, player: { health, ...(foodLevel === undefined ? {} : { foodLevel }) }, world: { dimension },
	inventory: { items: items.map(([id, count, slot]) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}) })) } });
const visitedNether = () => { const known = emptyKnown(); known.visitedDimensions.push('minecraft:the_nether'); return known; };
const litFrame = () => { const known = emptyKnown(); known.frames.push({ dimension: 'minecraft:overworld', x: 0, y: 60, z: 0, axis: 'x', obsidian: 10, needed: 10, lit: true }); return known; };
const portal = { blockId: 'minecraft:nether_portal', x: 30, y: -20, z: 7 };
const portalMemory = { position: { x: 0, y: 64, z: 0 }, known: { sightings: [{ what: portal.blockId, kind: 'portal', x: 30, y: -20, z: 7, tick: 100 }], blocks: [] } };
const route = (items, { died = true, known = visitedNether(), memory = portalMemory, instincts = false, ...options } = {}) =>
	routeLine({ observation: sample(items, options), known, memory, diedSincePortal: died, evaluate: evaluatePlanCheck, instincts });

const SHIELD = ['shield', 1, 'offhand'];
const ARMOUR = [['iron_chestplate', 1, 'chest'], ['iron_boots', 1, 'feet']];
const TOOLS = [['iron_pickaxe', 1], ['furnace', 1]];
const RETURN = /^usual next step: return via known Overworld portal at 30,-20,7 to the Nether/;

test('a respawn after a Nether death with a known portal re-kits before the portal return', () => {
	// Before: the empty-handed respawn was sent straight back ("active portal needs no iron pick").
	assert.match(route([], { died: false }), RETURN);
	// After: the kit rows in route order, each tagged as the re-kit.
	assert.equal(route([]), 'usual next step: obtain wooden_pickaxe (no tools yet; re-kit after a death)');
	assert.match(route([['wooden_pickaxe', 1]]), /^usual next step: obtain stone_pickaxe \(wooden pickaxe, no stone tools; re-kit after a death\)$/);
	assert.match(route([['stone_pickaxe', 1], ['furnace', 1]]), /^usual next step: obtain iron_pickaxe \(stone tools, no iron yet; re-kit after a death\)$/);
	// Past the old slice (which stopped at the iron pickaxe): the shield, then the armour.
	assert.equal(route(TOOLS), 'usual next step: obtain shield, then equip_item it to offhand (iron 0 held, shield takes 1; re-kit after a death)');
	assert.match(route([...TOOLS, ['shield', 1]]), /^usual next step: equip_item shield to offhand \(.*re-kit after a death\)$/);
	// The armour mines its own iron: the lost buckets and light are not kept back for (a lit portal needs neither).
	assert.equal(route([...TOOLS, SHIELD]), 'usual next step: obtain iron_chestplate, then equip_item it to chest (iron 0 held; iron_chestplate takes 8, no chest armour worn; re-kit after a death)');
	assert.match(route([...TOOLS, SHIELD, ARMOUR[0]]), /^usual next step: obtain iron_boots, then equip_item it to feet \(iron 0 held; iron_boots takes 4/);
	assert.match(route([...TOOLS, SHIELD, ['iron_boots', 1]], {}), /^usual next step: equip_item iron_boots to feet/);
	// The whole kit back on: the portal return, as before.
	assert.match(route([...TOOLS, SHIELD, ...ARMOUR]), RETURN);
	// A keepInventory-style respawn (or drops recovered) has nothing to re-kit.
	assert.match(route([['diamond_pickaxe', 1], SHIELD, ['diamond_chestplate', 1, 'chest'], ['golden_boots', 1, 'feet']]), RETURN);
});

test('without a known portal the rebuild goes on past the iron pickaxe to the shield and armour after a death', () => {
	const none = { memory: null };
	// No death: the old rebuild, iron pickaxe and no further.
	assert.match(route([], { ...none, died: false }), /rebuild after the Nether visit/);
	assert.doesNotMatch(route(TOOLS, { ...none, died: false }), /shield|chestplate|re-kit/);
	assert.match(route([], none), /^usual next step: obtain wooden_pickaxe \(no tools yet; re-kit after a death\)$/);
	assert.match(route(TOOLS, none), /^usual next step: obtain shield, then equip_item it to offhand/);
	assert.match(route([...TOOLS, SHIELD], none), /^usual next step: obtain iron_chestplate/);
	assert.match(route([...TOOLS, SHIELD, ...ARMOUR, ['cooked_beef', 16]], none), /go back to the Nether for 7 blaze_rods/);
});

test('a death after lighting the portal, before entering, re-kits before the entry', () => {
	const ENTRY = /^usual next step: enter the Nether through the lit portal now/;
	assert.match(route([], { died: false, known: litFrame(), memory: null }), ENTRY);
	assert.equal(route([], { known: litFrame(), memory: null }), 'usual next step: obtain wooden_pickaxe (no tools yet; re-kit after a death)');
	assert.match(route(TOOLS, { known: litFrame(), memory: null }), /^usual next step: obtain shield/);
	assert.match(route([...TOOLS, SHIELD, ...ARMOUR], { known: litFrame(), memory: null }), ENTRY);
});

test('food on a re-kit is the hunger check the portal return makes, not the cooked-meat quota', () => {
	// A healthy, fed respawn goes to its tools first, with no meat quota ahead of the kit, even with a cow in view.
	const cow = { ...sample([]), entities: [{ type: 'minecraft:cow', distance: 6, alive: true }] };
	assert.equal(routeLine({ observation: cow, known: visitedNether(), memory: portalMemory, diedSincePortal: true, evaluate: evaluatePlanCheck }),
		'usual next step: obtain wooden_pickaxe (no tools yet; re-kit after a death)');
	// Hungry with no food: the spawn food row first, then food on the way of each later kit step.
	assert.match(route([], { foodLevel: 10 }), /^usual next step: obtain beef count 4 .*re-kit after a death\)$/);
	const hungry = route(TOOLS, { foodLevel: 10 });
	assert.match(hungry, /^usual next step: obtain shield, then equip_item it to offhand; low hunger\/health, food 0 held: obtain cooked_beef on the way \(.*re-kit after a death\)$/);
	// The kit back on while hungry: the portal return says to recover first, as it did.
	assert.match(route([...TOOLS, SHIELD, ...ARMOUR, ['apple', 2]], { foodLevel: 10 }), /return via known Overworld portal.*low health\/hunger, food 2 held: recover first/);
});

test('the instincts arm re-kits its weapon too, and every re-kit line keeps its tag within the byte budget', () => {
	assert.match(route([['stone_pickaxe', 1]], { instincts: true }), /^usual next step: obtain stone_sword .*re-kit after a death\)$/);
	assert.match(route([['stone_pickaxe', 1], ['stone_sword', 1], ['furnace', 1]], { instincts: true }), /obtain iron_pickaxe/);
	const kits = [[], [['wooden_pickaxe', 1]], TOOLS, [...TOOLS, ['shield', 1]], [...TOOLS, SHIELD], [...TOOLS, SHIELD, ARMOUR[0]]];
	for (const items of kits) for (const options of [{}, { foodLevel: 10 }, { instincts: true, foodLevel: 10 }, { known: litFrame(), memory: null, foodLevel: 10 }]) {
		const line = route(items, options);
		assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES, line);
		// The instincts food note in front of the spawn food row's long text clips the tag; every kit row keeps it.
		if (!/obtain beef count/.test(line)) assert.match(line, /re-kit after a death\)$/, line);
	}
});

test('portalDeathMark: set at the portal stage, refreshed alive in the Nether, never before the stage', () => {
	const overworld = sample([]), nether = sample([], { dimension: 'minecraft:the_nether' });
	assert.equal(portalDeathMark(null, 2, overworld, emptyKnown()), null, 'no lit frame and no visit: no mark');
	assert.equal(portalDeathMark(null, 2, overworld, litFrame()), 2);
	assert.equal(portalDeathMark(null, 1, overworld, visitedNether()), 1);
	assert.equal(portalDeathMark(null, 0, { ...overworld, advancements: ['story/enter_the_nether'] }, emptyKnown()), 0, 'a visit from a staged save');
	assert.equal(portalDeathMark(1, 3, overworld, visitedNether()), 1, 'the Overworld keeps the mark: a death since it stays a death');
	assert.equal(portalDeathMark(1, 3, nether, visitedNether()), 3, 'back in the Nether alive: the kit question is settled');
	assert.equal(portalDeathMark(null, undefined, nether, emptyKnown()), null);
});

// The production path: the live view counts the death and hands it to the route line in the wake header.
const record = (agentId) => ({ agentId, currentGoal: 'beat the game', goalRevision: 1,
	currentGoalSpec: { predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true } } });
const live = (tick, items, { dimension = 'minecraft:overworld', worldId = 'w', ...extra } = {}) => ({ ...sample(items, { dimension }), observedAtEpochMs: tick * 50,
	player: { dead: false, health: 20 }, world: { worldId, dimension, gameTime: tick }, ...extra });
const corpse = (tick, dimension = 'minecraft:the_nether') => ({ ready: true, observedAtEpochMs: tick * 50, player: { dead: true, health: 0 }, world: { worldId: 'w', dimension, gameTime: tick } });

test('live view: a Nether death and an empty Overworld respawn get the re-kit, not the walk back; re-entry settles it', async () => {
	const r = record('rekit-live');
	const memory = new ObservedMemoryStore();
	const views = new LiveTaskViews({ sources: (rec, o, p) => memory.knownSources(rec.agentId, o, p) });
	const step = async o => { memory.ingest(r.agentId, o); await views.observe(r, o); return views.continuity(r).route; };
	const FULL = [...TOOLS, SHIELD, ...ARMOUR];
	const first = live(100, FULL, { blocks: [{ ...portal, visible: true }] });
	assert.doesNotMatch(await step(first), /re-kit/);
	assert.match(await step(live(200, FULL, { dimension: 'minecraft:the_nether' })), /find a fortress/);
	await step(corpse(300));
	const respawn = live(400, []);
	assert.equal(await step(respawn), 'usual next step: obtain wooden_pickaxe (no tools yet; re-kit after a death)');
	// A queued wake built from a sample before the death states that sample's route (its own death count).
	assert.doesNotMatch(views.continuity(r, { observation: first }).route, /re-kit/);
	assert.match(await step(live(410, TOOLS)), /^usual next step: obtain shield.*re-kit after a death\)$/);
	// Kit back on: the walk back; alive in the Nether: the death is settled; home alive with nothing: no re-kit.
	assert.match(await step(live(500, FULL)), /return via known Overworld portal at 30,-20,7/);
	await step(live(600, FULL, { dimension: 'minecraft:the_nether' }));
	// A wake queued from the empty-handed respawn and delivered after re-entry keeps that sample's mark: still the re-kit.
	assert.match(views.continuity(r, { observation: respawn }).route, /re-kit after a death\)$/);
	assert.match(await step(live(700, [])), /return via known Overworld portal at 30,-20,7/);
	// A second death (in the Overworld this time) brings it back again.
	await step(corpse(800, 'minecraft:overworld'));
	assert.match(await step(live(900, [])), /re-kit after a death\)$/);
});

test('live view: a staged save past the Nether counts a death in this session; a new world starts clean', async () => {
	const r = record('rekit-staged');
	const views = new LiveTaskViews();
	const staged = (tick, items, extra = {}) => live(tick, items, { advancements: ['story/enter_the_nether'], ...extra });
	assert.doesNotMatch(views.continuity(r)?.route ?? '', /re-kit/);
	await views.observe(r, staged(100, [...TOOLS, SHIELD]));
	assert.doesNotMatch(views.continuity(r).route, /re-kit/);
	await views.observe(r, corpse(200, 'minecraft:overworld'));
	await views.observe(r, staged(300, []));
	assert.match(views.continuity(r).route, /re-kit after a death\)$/);
	// Another world: its deaths and its portal stage are its own.
	await views.observe(r, live(400, [], { worldId: 'other' }));
	assert.doesNotMatch(views.continuity(r).route, /re-kit/);
	// No portal stage yet: a death is the ordinary route, which already asks for the kit.
	await views.observe(r, corpse(500, 'minecraft:overworld'));
	await views.observe(r, { ...live(600, []), world: { worldId: 'other', dimension: 'minecraft:overworld', gameTime: 600 } });
	assert.equal(views.continuity(r).route, 'usual next step: obtain wooden_pickaxe (no tools yet)');
});
