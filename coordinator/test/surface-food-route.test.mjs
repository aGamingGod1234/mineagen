import test from 'node:test';
import assert from 'node:assert/strict';
import { routeLine, ROUTE_BYTES, PORTAL_ENTRY_NEXT } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { buildNativeEventInput } from '../src/dynamic-main.mjs';
import { decodeModelFacts, encodeNativeEventInput, ModelObservationViews } from '../src/model-fact-encoding.mjs';
const item = (id, count = 1) => ({ itemId: `minecraft:${id}`, count });
const tools = [item('stone_pickaxe'), item('furnace')];
const observation = (items = tools, entities = []) => ({ ready: true, observedAtEpochMs: 1000, world: { worldId: 'w', dimension: 'minecraft:overworld' }, position: { x: 0, y: 64, z: 0 }, player: { health: 20, foodLevel: 20 }, inventory: { items }, entities });
const line = (o, known = emptyKnown()) => routeLine({ observation: o, known, evaluate: evaluatePlanCheck });

test('food stocking stays before the first iron descent even while healthy', () => {
	const text = line(observation());
	assert.match(text, /cooked meat/); assert.match(text, /before digging below Y ?40/); assert.doesNotMatch(text, /obtain log count \d+ before going down/);
	assert.match(line(observation([item('wooden_pickaxe')])), /cooked meat 0\/8/);
	assert.match(line(observation([item('stone_pickaxe')])), /cooked meat 0\/8/);
	assert.match(line(observation([])), /obtain wooden_pickaxe/);
});

test('food stocking names the nearest actually seen animal, not beef in a sheep field', () => {
	for (const [mob, meat] of [['sheep', 'mutton'], ['pig', 'porkchop'], ['chicken', 'chicken'], ['cow', 'beef']]) {
	 const text = line(observation(tools, [{ type: `minecraft:${mob}`, distance: 8, alive: true }]));
	 assert.match(text, new RegExp(`obtain cooked_${meat} count 8`)); assert.match(text, /furnace/);
	}
});

test('mixed cooked meats total eight; raw meat is cooked without requesting eight of one type', () => {
	assert.match(line(observation([...tools, item('cooked_mutton', 3), item('cooked_porkchop', 5)])), /obtain log count \d+ before going down/);
	assert.match(line(observation([...tools, item('mutton', 2), item('cooked_chicken', 3)])), /obtain cooked_mutton count 2/);
	assert.match(line(observation([...tools, item('cooked_mutton', 2), item('mutton', 8), item('cooked_beef', 3)])), /obtain cooked_mutton count 5/);
	assert.match(line(observation([...tools, item('beef', 8)])), /obtain cooked_beef/);
});

test('food choice rejects hidden, dead, baby, distant and remembered animals', () => {
	for (const extra of [{ visible: false }, { perceivedBy: 'sound' }, { alive: false }, { baby: true }, { appearance: { baby: true } }, { distance: 100 }]) {
	 const text = line(observation(tools, [{ type: 'minecraft:sheep', distance: 8, alive: true, ...extra }]));
	 assert.doesNotMatch(text, /obtain cooked_mutton/); assert.match(text, /look for nearby/);
	}
	const stale = observation(tools, [{ type: 'minecraft:sheep', distance: 8 }]); stale.continuity = { rememberedSections: ['entities'] };
	assert.doesNotMatch(line(stale), /obtain cooked_mutton/);
});

test('lit portal entry and post-Nether rebuild never acquire a new food quota', () => {
	const known = emptyKnown(); known.frames.push({ dimension: 'minecraft:overworld', x: 0, y: 60, z: 0, obsidian: 10, lit: true });
	// The kit goes in first (kitBefore), but never the 8 cooked-meat quota: 4 pieces of any food are the kit's food.
	assert.match(line(observation(), known), /^usual next step: obtain shield, then equip_item it to offhand .*kit before the Nether\)$/);
	const kitted = [...tools, { itemId: 'minecraft:shield', count: 1, slot: 'offhand' }, { itemId: 'minecraft:iron_chestplate', count: 1, slot: 'chest' }, { itemId: 'minecraft:iron_boots', count: 1, slot: 'feet' }, item('cobblestone', 32)];
	assert.match(line(observation(kitted), known), /^usual next step: look for nearby cows.*before going to the Nether \(food 0\/4; kit before the Nether\)$/);
	assert.equal(line(observation([...kitted, item('bread', 4)]), known), `usual next step: ${PORTAL_ENTRY_NEXT} (no bed, 3 matching wool or sheep in reach: no portal bed; shield, armour and food held; eat first if health or hunger is low)`);
	for (const advanced of [false, true]) {
	 const k = emptyKnown(), o = observation();
	 if (advanced) o.advancements = ['minecraft:story/enter_the_nether']; else k.visitedDimensions.push('minecraft:the_nether');
	 assert.match(line(o, k), /obtain iron_pickaxe/); assert.doesNotMatch(line(o, k), /stock|cooked meat/);
	}
});

test('food route survives the production wake and its byte limit', async () => {
	const record = { agentId: 'surface-food', currentGoal: 'Beat the game', goalRevision: 1, currentGoalSpec: { predicate: { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true } } };
	const views = new LiveTaskViews(), o = observation(tools, [{ stableId: 'sheep-1', type: 'minecraft:sheep', x: 8, y: 64, z: 0, distance: 8, alive: true }]);
	await views.observe(record, o);
	const continuity = views.continuity(record);
	const text = continuity.route;
	assert.match(text, /obtain cooked_mutton count 8/); assert.ok(Buffer.byteLength(text) <= ROUTE_BYTES);
	const encoded = encodeNativeEventInput(buildNativeEventInput(record, { event: 'observation', trigger: 'attention', observation: o, continuity }), new ModelObservationViews());
	const facts = decodeModelFacts(JSON.parse(encoded.slice(encoded.indexOf('\n') + 1)));
	assert.equal(facts.now.route, text);
});
