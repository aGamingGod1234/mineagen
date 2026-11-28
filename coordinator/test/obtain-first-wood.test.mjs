import assert from 'node:assert/strict';
import test from 'node:test';
import { logOrder, searchBlock } from '../src/obtain-runner.mjs';
import { runObtain } from './helpers/checked-body.mjs';
import { planObtain } from '../src/obtain-plan.mjs';

// EARLY-7: the first-log search on a treeless spawn surveys the logs its neighbours grow, and after one full search with
// no log the obtain goes back to the model with the biomes seen instead of searching again.

const LOGS = planObtain({ ids: ['wooden_pickaxe'], count: 1 }, { held: new Map() }).needs.find((need) => need.accept.includes('oak_log')).blocks;
const at = (biome) => ({ world: { biome: `minecraft:${biome}` } });

test('the survey takes the spawn biome\'s own log and its neighbours\' first, never alphabetical order', () => {
	assert.equal(LOGS.length, 9);
	// find surveys the first four ids: the main block and the first three of also.
	const first4 = (biome) => logOrder(LOGS, at(biome)).slice(0, 4);
	assert.deepEqual(first4('desert'), ['acacia_log', 'oak_log', 'birch_log', 'jungle_log']);
	assert.deepEqual(first4('badlands'), ['oak_log', 'acacia_log', 'spruce_log', 'birch_log']);
	assert.deepEqual(first4('ice_spikes'), ['spruce_log', 'oak_log', 'birch_log', 'dark_oak_log']);
	assert.deepEqual(first4('snowy_plains'), ['spruce_log', 'oak_log', 'birch_log', 'dark_oak_log']);
	assert.deepEqual(first4('plains'), ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log']);
	assert.deepEqual(first4('beach'), ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log']);
	assert.deepEqual(first4('swamp'), ['oak_log', 'mangrove_log', 'birch_log', 'spruce_log']);
	assert.deepEqual(logOrder(LOGS, {}).slice(0, 4), ['oak_log', 'birch_log', 'spruce_log', 'dark_oak_log'], 'unknown biome: most common first');
	// Every log is still searched for, each once.
	for (const biome of ['desert', 'jungle', 'cherry_grove', 'pale_garden']) assert.deepEqual([...logOrder(LOGS, at(biome))].sort(), [...LOGS].sort());
	// The main block keeps the biome's own log where one grows (as before), oak on plains.
	assert.equal(searchBlock({ blocks: LOGS }, at('old_growth_spruce_taiga')), 'spruce_log');
	assert.equal(searchBlock({ blocks: LOGS }, at('birch_forest')), 'birch_log');
	assert.equal(searchBlock({ blocks: LOGS }, at('savanna_plateau')), 'acacia_log');
	assert.equal(searchBlock({ blocks: LOGS }, at('plains')), 'oak_log');
	assert.equal(searchBlock({ blocks: LOGS }, at('desert')), 'acacia_log');
});

// A body with no moves: the hand-back must come from one fruitless search alone.
function treeless({ items = [], reasonCode = 'FIND_NOT_FOUND', biomes = ['desert', 'badlands'] } = {}) {
	const searches = [];
	let biome = 0;
	const body = {
		observe: async () => ({ ready: true, player: { x: 0.5, y: 70, z: 0.5, health: 20, foodLevel: 20, skyOpen: true, onGround: true },
			world: { dimension: 'minecraft:overworld', biome: `minecraft:${biomes[Math.min(biome, biomes.length - 1)]}` },
			inventory: { items: items.map(([itemId, count], slot) => ({ itemId: `minecraft:${itemId}`, count, slot })) }, blocks: [] }),
		search: async (target) => { searches.push(target); biome += 1;
			return { state: reasonCode === 'FIND_BUDGET' ? 'TIMED_OUT' : 'FAILED', reasonCode, message: 'Searched to 96 blocks from the start' }; },
		survey: async () => ({ entries: [] }), note: () => {}, stopped: () => false, interrupted: () => false, recovering: () => {},
	};
	return { body, searches };
}

test('the first wood hands back after one full search with no log, naming the biomes seen', async () => {
	for (const reasonCode of ['FIND_NOT_FOUND', 'FIND_BUDGET']) {
		const { body, searches } = treeless({ reasonCode });
		const result = await runObtain({ item: 'wooden_pickaxe', count: 1, timeoutMs: 600_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
		assert.equal(result.state, 'FAILED', result.message);
		assert.equal(result.reasonCode, 'NO_SOURCE');
		assert.equal(searches.length, 1, `${reasonCode}: one search, not three`);
		assert.equal(searches[0].block, 'minecraft:acacia_log', 'a desert spawn looks for acacia first');
		// find surveys the block and the first three of also: oak, birch and jungle next, not alphabetical.
		assert.deepEqual(searches[0].also.slice(0, 3), ['minecraft:oak_log', 'minecraft:birch_log', 'minecraft:jungle_log']);
		assert.match(result.message, /No tree for the first wood after one full search/);
		assert.match(result.message, /biomes seen: desert, badlands/);
	}
});

test('with wood or a tool held, a fruitless log search is retried as before', async () => {
	for (const items of [[['oak_planks', 2]], [['wooden_pickaxe', 1]], [['stick', 2]]]) {
		const { body, searches } = treeless({ items });
		const result = await runObtain({ item: 'crafting_table', count: 1, timeoutMs: 600_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
		assert.doesNotMatch(result.message ?? '', /first wood/, JSON.stringify(items));
		assert.ok(searches.length > 1, `${JSON.stringify(items)}: retried (${searches.length} searches)`);
	}
});

test('wood held when the call began is not the first wood, even once none is left', async () => {
	// The pack shows a wooden sword at the start and nothing after (lost during the call): the retries stay.
	const { body, searches } = treeless();
	const observe = body.observe;
	let first = true;
	body.observe = async () => { const o = await observe(); if (first) { first = false; o.inventory.items = [{ itemId: 'minecraft:wooden_sword', count: 1, slot: 0 }]; } return o; };
	const result = await runObtain({ item: 'wooden_pickaxe', count: 1, timeoutMs: 600_000 }, body, { now: (() => { let t = 0; return () => (t += 100); })() });
	assert.doesNotMatch(result.message ?? '', /first wood/);
	assert.ok(searches.length > 1, `retried (${searches.length} searches)`);
});
