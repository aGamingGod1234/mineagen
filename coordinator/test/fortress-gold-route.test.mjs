import assert from 'node:assert/strict';
import test from 'node:test';
import { ROUTE_BYTES, routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';

const NETHER = 'minecraft:the_nether';
const item = (id, count = 1, slot) => ({ itemId: `minecraft:${id}`, count, ...(slot === undefined ? {} : { slot }) });
const sample = (items = [], extra = {}) => ({ ready: true, observedAtEpochMs: 1_000,
	world: { worldId: 'w', dimension: NETHER }, position: { x: 37.3, y: 77, z: -12.5 },
	player: { dead: false, health: 20, foodLevel: 20 }, inventory: { items }, entities: [], blocks: [], ...extra });
const route = observation => routeLine({ observation, known: emptyKnown(), evaluate: evaluatePlanCheck });
const fortress = 'find a fortress and fight_until 7 blaze_rods';
const facts = 'rods 0/7, pearls 0/12, eyes 0 held + 0 set of 12';
const bare = `usual next step: ${fortress} (${facts})`;
const optional = 'consider gold armour if safely nearby; skip a gold hunt';

test('no worn gold adds optional nearby preparation while retaining fortress progress', () => {
	assert.equal(route(sample()), `usual next step: ${optional}; ${fortress} (no gold worn; ${facts})`);
	for (const items of [[item('gold_ingot', 16)], [item('golden_sword')], [item('golden_boots', 0, 'feet')], [item('iron_boots', 1, 'feet')]]) {
		assert.match(route(sample(items)), /consider gold armour if safely nearby; skip a gold hunt; find a fortress/);
	}
});

test('every carried gold armour piece is preferred, but any worn piece preserves the old route', () => {
	for (const [id, slot] of [['golden_helmet', 'head'], ['golden_chestplate', 'chest'], ['golden_leggings', 'legs'], ['golden_boots', 'feet']]) {
		for (const carriedSlot of [undefined, 8, 'offhand']) {
			const line = route(sample([item(id, 1, carriedSlot)]));
			assert.match(line, new RegExp(`consider equip_item ${id} before searching; find a fortress`));
			assert.doesNotMatch(line, /gold hunt|obtain/);
		}
		assert.equal(route(sample([item(id, 1, slot), item('golden_boots')])), bare);
	}
});

test('gold suggestions do not replace other stages or use stale inventory', () => {
	assert.match(route(sample([item('blaze_rod', 7)])), /^usual next step: get 12-14 ender_pearls/);
	assert.match(route(sample([item('blaze_rod', 7), item('ender_pearl', 12)])), /^usual next step: return home/);
	assert.match(route(sample([item('ender_eye', 12)])), /^usual next step: return home/);
	assert.match(route(sample([item('blaze_powder', 12)])), /^usual next step: get 12-14 ender_pearls/);
	assert.equal(route(sample([], { world: { dimension: 'minecraft:overworld' } })), 'usual next step: obtain wooden_pickaxe (no tools yet)');
	assert.equal(route(sample([], { world: { dimension: 'minecraft:the_end' } })), 'usual next step: kill the ender_dragon: break the end crystals first (in the End)');
	for (const inventory of [undefined, {}, { items: [] }, { items: [item('golden_boots', 1, 'feet')] }]) {
		assert.equal(route(sample([], { inventory, continuity: { rememberedSections: ['inventory'] } })), null);
	}
	assert.equal(route(sample([], { ready: false })), null);
});

test('gold is not presented as a remedy for angry piglins or brutes', () => {
	for (const type of ['minecraft:piglin', 'minecraft:piglin_brute']) {
		const line = route(sample([item('golden_boots')], { entities: [{ type, distance: 3, alive: true, targetingAgent: true }] }));
		assert.match(line, /consider equip_item golden_boots/);
		assert.doesNotMatch(line, /pacif|calm|safe from|protect|stop.*attack|must|obtain/);
		assert.match(line, /find a fortress/);
	}
});

test('the 220-byte route preserves UTF-8 ellipsis and fortress progress when clipping', () => {
	assert.equal(ROUTE_BYTES, 220);
	for (const gold of [[], [item('golden_chestplate')]]) {
		const line = route(sample([...gold, item('ender_pearl', Number.MAX_SAFE_INTEGER)]));
		assert.ok(Buffer.byteLength(line) <= 220);
		assert.match(line, /find a fortress and fight_until 7 blaze_rods/);
		assert.equal(Buffer.from(line).toString('utf8'), line);
		assert.doesNotMatch(line, /\uFFFD/);
	}
	// Satisfy early food stocking so this still exercises the long casting/restock route.
	const clipped = route(sample([item('iron_pickaxe'), item('shield', 1, 'offhand'), item('water_bucket'), item('bucket'), item('flint_and_steel'), item('cooked_mutton', 8)],
		{ world: { dimension: 'minecraft:overworld' }, player: { health: 10, foodLevel: 10 } }));
	assert.ok(Buffer.byteLength(clipped) <= 220);
	assert.match(clipped, /^usual next step: find block minecraft:lava/);
	assert.ok(clipped.endsWith('…'));
	assert.equal(Buffer.from(clipped).toString('utf8'), clipped);
});

// Scout-shaped inventory variant: a shield and ample plain blocks do not count as worn gold.
// This is a constructed route case, not a replay or a survival claim about the recorded scout.
const scoutInventory = [item('diamond_pickaxe', 1, 0), item('iron_pickaxe', 1, 1), item('shield', 1, 'offhand'), item('cobblestone', 990, 2)];
for (const [name, observation, expected] of [
	['no gold', sample(), optional],
	['scout inventory', sample(scoutInventory), optional],
	['scout carrying boots', sample([...scoutInventory, item('golden_boots', 1, 8)]), 'consider equip_item golden_boots before searching'],
	['scout wearing boots', sample([...scoutInventory, item('golden_boots', 1, 'feet')]), bare],
	['rods complete', sample([item('blaze_rod', 7)]), 'usual next step: get 12-14 ender_pearls'],
	['eyes complete', sample([item('ender_eye', 12)]), 'usual next step: return home'],
	['Overworld', sample([], { world: { worldId: 'w', dimension: 'minecraft:overworld' } }), 'usual next step: obtain wooden_pickaxe'],
	['End', sample([], { world: { worldId: 'w', dimension: 'minecraft:the_end' } }), 'usual next step: kill the ender_dragon'],
	['stale inventory', sample([], { continuity: { rememberedSections: ['inventory'] } }), null],
]) test(`production wake route: ${name}`, async () => {
	const record = { agentId: 'gold-route', currentGoal: 'beat the game', goalRevision: 1,
		currentGoalSpec: { predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true } } };
	const original = structuredClone(observation);
	const views = new LiveTaskViews();
	await views.observe(record, observation);
	const continuity = views.continuity(record);
	const input = buildNativeEventInput(record, { event: 'observation', trigger: 'attention', observation, continuity });
	const encoded = encodeNativeEventInput(input, new ModelObservationViews());
	const facts = decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n') + 1)));
	if (expected === null) assert.equal(facts.now.route, undefined);
	else {
		assert.ok(facts.now.route.includes(expected), facts.now.route);
		assert.equal(facts.now.route, route(observation));
		assert.ok(Buffer.byteLength(facts.now.route) <= ROUTE_BYTES);
	}
	assert.deepEqual(observation, original, 'presenting advice leaves the observation unchanged');
	assert.equal(observation.currentAction, undefined);
});
