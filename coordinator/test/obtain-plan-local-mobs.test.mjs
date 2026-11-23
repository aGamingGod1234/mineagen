import assert from 'node:assert/strict';
import test from 'node:test';
import { planObtain } from '../src/obtain-plan.mjs';

// NE-END-1's bow and arrows: string and feathers come from the common mobs (spiders, chickens), not from mobs that live
// only in villages or jungles, unless one of those is in view.

const kills = (ids, count, seen = [], held = new Map()) => planObtain({ ids, count }, { held, seen: new Set(seen) }).needs
	.filter((need) => need.kind === 'kill').map((need) => need.mobs[0]);
const way = (id, seen = [], held = new Map()) => {
	const plan = planObtain({ ids: [id], count: 1 }, { held, seen: new Set(seen) });
	return plan.needs.map((need) => need.kind === 'kill' ? `kill ${need.mobs[0]}` : `${need.kind} ${need.blocks?.[0] ?? need.accept[0]}`);
};

test('string: spiders, not cats, unless a cat is in view', () => {
	assert.deepEqual(way('string'), ['kill spider']);
	assert.deepEqual(way('string', ['spider']), ['kill spider']);
	// Cave spiders live at mineshaft spawners: one in view (down a mineshaft) is a way, an unseen one is not.
	assert.deepEqual(way('string', ['cave_spider']), ['kill cave_spider']);
	// A cat in view is a short hunt: it stays a way.
	assert.deepEqual(way('string', ['cat']), ['kill cat']);
	// Cobwebs in view with shears held: no kill at all.
	assert.deepEqual(way('string', ['cobweb'], new Map([['shears', 1]])), ['mine cobweb']);
});

test('feathers: chickens, not parrots, unless a parrot is in view', () => {
	assert.deepEqual(way('feather'), ['kill chicken']);
	assert.deepEqual(way('feather', ['chicken']), ['kill chicken']);
	assert.deepEqual(way('feather', ['parrot']), ['kill parrot']);
});

test('obtain bow and obtain arrow hunt spiders and chickens on an ordinary spawn', () => {
	const tools = new Map([['iron_sword', 1], ['iron_pickaxe', 1], ['oak_log', 8]]);
	for (const seen of [[], ['spider', 'chicken'], ['spider', 'chicken', 'cow', 'sheep']]) {
		assert.deepEqual(kills(['bow'], 1, seen, tools), ['spider'], JSON.stringify(seen));
		const arrow = kills(['arrow'], 16, seen, new Map([...tools, ['flint', 4]]));
		assert.ok(arrow.includes('chicken') && !arrow.includes('parrot'), `${JSON.stringify(seen)}: ${arrow}`);
	}
});

test('other items keep a common mob: rotten flesh never from a zombie horse, beef and leather from cows', () => {
	assert.notDeepEqual(way('rotten_flesh'), ['kill zombie_horse']);
	assert.match(way('rotten_flesh')[0], /^kill (zombie|drowned|husk|zombie_villager)$/);
	assert.deepEqual(way('beef'), ['kill cow']);
	assert.deepEqual(way('leather'), ['kill cow']);
});
