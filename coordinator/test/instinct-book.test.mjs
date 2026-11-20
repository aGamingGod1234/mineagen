import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { INSTINCT_LINE_CHARS, checkBook, instinctBookPath, instinctLines, loadInstinctBook, rankRules, situationTags } from '../src/instinct-book.mjs';

// A small authored book: the real one is loaded from MINEAGEN_INSTINCT_BOOK at run time.
const BOOK = checkBook([
	{ id: 'ore-cave-first', tags: ['need:iron', 'place:surface'], when: 'You need iron and a cave mouth is in view.', do: 'Go into the cave and scan its walls.', priority: 2 },
	{ id: 'ore-strip-to-cave', tags: ['need:iron', 'place:underground'], when: 'You are underground and still need iron.', do: 'Tunnel to break into a cave, then follow it.', priority: 2 },
	{ id: 'shield-first-iron', tags: ['lacks:shield', 'has:iron'], when: 'You hold iron but no shield.', do: 'Craft a shield before more mining.', priority: 3 },
	{ id: 'health-low-retreat', tags: ['health:low'], when: 'Health is 8 or less.', do: 'Back off, block in and eat.', priority: 3 },
	{ id: 'skeleton-no-shield-cover', tags: ['threat:skeleton', 'lacks:shield'], when: 'A skeleton shoots and you have no shield.', do: 'Break line of sight.', priority: 3 },
	{ id: 'nav-record-places', tags: ['dim:overworld'], when: 'You find a place worth coming back to.', do: 'Record its coordinates.', priority: 2 },
	{ id: 'nether-food-leave', tags: ['dim:nether', 'hunger:low', 'lacks:food'], when: 'In the Nether, hungry, no food.', do: 'Go back through the portal for food.', priority: 3 },
]);

const observation = ({ y = 70, health = 20, foodLevel = 20, dimension = 'minecraft:overworld', items = [], entities = [], dayTime = 1000, sighted } = {}) =>
	({ world: { dimension, dayTime }, player: { x: 0, y, z: 0, health, foodLevel }, inventory: { items }, entities, ...(sighted ? { sighted } : {}) });
const item = (id, count = 1, slot = 9) => ({ itemId: `minecraft:${id}`, count, slot });

test('the situation is read only from what the body perceives', () => {
	const { tags, unknown } = situationTags(observation({ items: [item('stone_pickaxe', 1, 0), item('cooked_beef', 5)] }));
	for (const tag of ['dim:overworld', 'health:full', 'hunger:ok', 'time:day', 'stage:stone', 'need:iron', 'place:surface', 'has:stone_pickaxe', 'lacks:iron_pickaxe', 'has:cooked_food', 'lacks:shield'])
		assert.ok(tags.includes(tag), tag);
	assert.deepEqual(unknown, []);
	const nether = situationTags(observation({ dimension: 'minecraft:the_nether', y: 40, foodLevel: 10, entities: [{ type: 'minecraft:skeleton', distance: 9 }, { type: 'minecraft:stray', distance: 30 }] })).tags;
	assert.ok(nether.includes('dim:nether') && nether.includes('hunger:low') && nether.includes('stage:nether') && nether.includes('threat:skeleton'));
	assert.ok(!nether.some(tag => tag.startsWith('place:')), 'no Overworld depth rule in the Nether');
	assert.ok(!nether.includes('threat:many'), 'a mob 30 blocks off is not a threat');
	const deep = situationTags(observation({ y: 20, sighted: { caves: [{ air: 300 }] } })).tags;
	assert.ok(deep.includes('place:underground') && deep.includes('place:cave'));
	assert.ok(situationTags(observation({ y: 60 })).unknown.includes('place'), 'between 56 and 64 the place is unknown, not guessed');
	assert.ok(situationTags({ player: {} }).unknown.includes('hunger'));
});

test('rules are ranked by how specific they are, then how urgent; ambient rules never show', () => {
	const tags = situationTags(observation({ health: 6, items: [item('iron_ingot', 3), item('stone_pickaxe', 1, 0)], entities: [{ type: 'minecraft:skeleton', distance: 8 }] })).tags;
	const ids = rankRules(BOOK, tags, { limit: 5 }).map(row => row.rule.id);
	assert.deepEqual(ids.slice(0, 3), ['skeleton-no-shield-cover', 'health-low-retreat', 'shield-first-iron'], 'acute facts outrank what is held');
	assert.ok(ids.includes('ore-cave-first'));
	assert.ok(!ids.includes('nav-record-places'), 'a dimension-only rule is true everywhere');
	assert.ok(!ids.includes('nether-food-leave'), 'every tag of a rule must hold');
});

test('instinct lines are short, named and capped at three', () => {
	const lines = instinctLines(BOOK, observation({ health: 6, items: [item('iron_ingot', 3), item('stone_pickaxe', 1, 0)], entities: [{ type: 'minecraft:skeleton', distance: 8 }] }));
	assert.equal(lines.length, 3);
	assert.match(lines[0], /^skeleton-no-shield-cover: A skeleton shoots and you have no shield -> Break line of sight\.$/);
	const long = checkBook([{ id: 'long', tags: ['health:low'], when: 'x'.repeat(400), do: 'y', priority: 3 }]);
	assert.equal(instinctLines(long, observation({ health: 2 }))[0].length, INSTINCT_LINE_CHARS);
	assert.equal(instinctLines(BOOK, observation({ dimension: 'minecraft:the_end', y: 60, items: [item('cooked_beef', 9), item('shield')] })), null);
	assert.equal(instinctLines(null, observation()), null);
});

test('the book comes from MINEAGEN_INSTINCT_BOOK and is checked on load', () => {
	assert.equal(instinctBookPath({}), null);
	assert.equal(instinctBookPath({ MINEAGEN_INSTINCT_BOOK: ' off ' }), null);
	const dir = mkdtempSync(path.join(tmpdir(), 'instinct-book-'));
	const file = path.join(dir, 'book.json');
	writeFileSync(file, JSON.stringify({ rules: [{ id: 'a-rule', tags: ['health:low'], when: 'w', do: 'd', priority: 3 }] }));
	assert.equal(instinctBookPath({ MINEAGEN_INSTINCT_BOOK: file }), file);
	assert.equal(loadInstinctBook(file)[0].id, 'a-rule');
	writeFileSync(file, JSON.stringify([{ id: 'Bad Id', tags: ['health:low'], when: 'w', do: 'd' }]));
	assert.throws(() => loadInstinctBook(file), /kebab-case/);
	writeFileSync(file, JSON.stringify([{ id: 'x', tags: ['lowhealth'], when: 'w', do: 'd' }]));
	assert.throws(() => loadInstinctBook(file), /kind:value/);
});
