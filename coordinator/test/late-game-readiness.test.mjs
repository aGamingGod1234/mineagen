import test from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_BYTES, routeLine } from '../src/skill-fits.mjs';
import { emptyKnown, evaluatePlanCheck } from '../src/plan-checks.mjs';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { endKit, endKitNote } from '../src/end-readiness.mjs';
import { immutableGoalSpec } from './fixtures/dynamic-main-fixture.mjs';

// The late-game contract, part B: the End readiness note (wall-breakers late-game-contract.md).
const item = (id, count = 1, slot) => ({ itemId: `minecraft:${id}`, count, ...(slot === undefined ? {} : { slot }) });
const FULL = [item('bow'), item('arrow', 40), item('iron_chestplate', 1, 'chest'), item('iron_boots', 1, 'feet'), item('cooked_beef', 20),
	item('cobblestone', 64), item('water_bucket'), item('white_bed'), item('iron_pickaxe'), item('ender_eye', 3)];
const PORTAL = { blockId: 'minecraft:end_portal', x: 1, y: 30, z: 1 };
const sample = (items, { blocks = [PORTAL], world = 'w1', at = 10 } = {}) => ({ ready: true, observedAtEpochMs: at, world: { worldId: world, dimension: 'minecraft:overworld' },
	position: { x: 0, y: 30, z: 0 }, player: { x: 0, y: 30, z: 0, health: 20, foodLevel: 20 }, inventory: { items }, entities: [], blocks });
const visited = () => { const known = emptyKnown(); known.visitedDimensions.push('minecraft:the_nether'); return known; };
const route = (o, kitHandedBack) => routeLine({ observation: o, known: visited(), evaluate: evaluatePlanCheck, ...(kitHandedBack ? { kitHandedBack } : {}) });

test('a full kit adds no note: the head is the portal alone', () => {
	assert.deepEqual(endKit(sample(FULL)).missing, []);
	assert.equal(endKitNote(sample(FULL)), null);
	assert.equal(route(sample(FULL)), 'usual next step: enter the End portal (portal open)');
});

test('the head stays "enter the End portal" whatever is missing (non-gating)', () => {
	for (const items of [[], [item('bow')], FULL.filter(i => i.itemId !== 'minecraft:water_bucket'), [item('string', 3), item('stick', 3), item('bucket')]]) {
		assert.match(route(sample(items)), /^usual next step: enter the End portal[ ;(]/);
	}
	// And at the frames with eyes in hand, setting them stays first.
	const frames = Array.from({ length: 12 }, (_, x) => ({ blockId: 'minecraft:end_portal_frame', x, y: 30, z: 0, state: { eye: 'false' } }));
	assert.match(route(sample([item('ender_eye', 12)], { blocks: frames })), /^usual next step: set the ender_eyes in the empty End portal frames/);
});

test('names only in-reach fixes; anything else is only counted as missing', () => {
	// No inputs held or in view: nothing to do about it here, so no fix.
	const bare = endKit(sample([item('iron_pickaxe')], { blocks: [PORTAL] }));
	assert.deepEqual(bare.fixes, []);
	assert.ok(bare.missing.some(m => /^bow/.test(m)) && bare.missing.includes('water bucket') && bare.missing.includes('bed'));
	// Inputs held or in view: the fix is named.
	const reach = endKit(sample([item('bow'), item('arrow', 4), item('flint', 8), item('feather', 8), item('stick', 4), item('bucket'), item('red_wool', 3),
		item('porkchop', 6), item('iron_pickaxe'), item('iron_ingot', 8)], { blocks: [PORTAL, { blockId: 'minecraft:water', x: 3, y: 30, z: 0 }, { blockId: 'minecraft:stone_bricks', x: 2, y: 30, z: 0 }] }));
	assert.deepEqual(reach.fixes, ['obtain arrow count 35', 'obtain iron_chestplate, then equip_item it', 'obtain cooked_porkchop count 6', 'obtain cobblestone count 32', 'obtain water_bucket', 'obtain red_bed']);
	// A bucket with no water in view, wool short of 3: not in reach.
	const short = endKit(sample([item('bucket'), item('red_wool', 2)]));
	assert.equal(short.fixes.length, 0);
	assert.match(route(sample([item('string', 3), item('stick', 3)])), /^usual next step: enter the End portal; in reach first: obtain bow \(portal open; End kit lacks/);
});

test('no block count stands in for a bow: blocks are their own kit item', () => {
	for (const blocks of [40, 64, 600]) assert.ok(endKit(sample([item('cobblestone', blocks)])).missing.includes('bow'), `${blocks} blocks`);
	assert.ok(!endKit(sample([item('cobblestone', 64)])).missing.some(m => /^blocks/.test(m)));
	assert.ok(endKit(sample([item('cobblestone', 20)])).missing.includes('blocks 20/32'));
});

// The inventories 19 recorded games carried into the End (night and checkpoint rounds), cut to what the kit reads:
// [bow, arrows, string, sticks, flint, planks, logs, plain blocks], each on a common base kit (iron armour and sword, a
// pickaxe, a shield, cooked beef, a water bucket), which nearly all of them carried. Only 3 held a bow; none 32 arrows.
const END_ENTRY = [
	[0, 0, 4, 0, 0, 28, 10, 342], [0, 1, 0, 2, 0, 23, 8, 490], [0, 0, 0, 12, 4, 26, 10, 523], [0, 5, 2, 0, 0, 30, 8, 329],
	[0, 0, 0, 8, 3, 15, 8, 474], [0, 0, 0, 0, 2, 27, 8, 535], [1, 2, 0, 0, 0, 22, 8, 183], [0, 0, 4, 0, 1, 20, 8, 457],
	[1, 1, 0, 0, 1, 13, 10, 607], [0, 2, 1, 2, 0, 14, 8, 322], [0, 0, 2, 0, 0, 23, 8, 578], [1, 0, 1, 5, 0, 12, 10, 233],
	[0, 0, 0, 0, 1, 21, 8, 638], [0, 0, 0, 2, 0, 26, 8, 590], [0, 1, 1, 0, 0, 22, 8, 352], [0, 0, 1, 2, 0, 23, 8, 410],
	[0, 1, 0, 0, 0, 22, 8, 336], [0, 6, 4, 2, 0, 19, 8, 348], [0, 1, 2, 2, 0, 5, 0, 474],
];
const entryKit = ([bow, arrows, string, sticks, flint, planks, logs, blocks], eyes = 2) => [
	item('iron_helmet', 1, 'head'), item('iron_chestplate', 1, 'chest'), item('iron_leggings', 1, 'legs'), item('iron_boots', 1, 'feet'),
	item('iron_sword'), item('iron_pickaxe'), item('shield'), item('cooked_beef', 30), item('water_bucket'), item('ender_eye', eyes), item('cobblestone', blocks),
	...[['bow', bow], ['arrow', arrows], ['string', string], ['stick', sticks], ['flint', flint], ['oak_planks', planks], ['oak_log', logs]].filter(([, n]) => n > 0).map(([id, n]) => item(id, n)),
];

test('every recorded End-entry inventory names the bow, or the arrows when a bow is held, as missing', () => {
	let bowMissing = 0, arrowsMissing = 0;
	for (const row of END_ENTRY) {
		const kit = endKit(sample(entryKit(row), { blocks: [] }));
		if (row[0] === 0) { assert.ok(kit.missing.includes('bow'), JSON.stringify(row)); bowMissing++; }
		else { assert.ok(kit.missing.includes(`arrows ${row[1]}/32`), JSON.stringify(row)); arrowsMissing++; }
		// The bow is named as a fix only with its string and sticks (or wood) held.
		assert.equal(kit.fixes.includes('obtain bow'), row[0] === 0 && row[2] >= 3, JSON.stringify(row));
	}
	assert.deepEqual([bowMissing, arrowsMissing], [16, 3]);
});

// After the Nether, back in the Overworld: rods and pearls done, 12 eyes crafted, no portal or frame in view.
const searchReady = (row, extra = []) => sample([...entryKit(row, 12), ...extra], { blocks: [] });
const NO_BOW = END_ENTRY[0], SHORT_BOW = END_ENTRY[6];

test('the route line gets a bow before the stronghold search', () => {
	for (const row of END_ENTRY.filter(r => r[0] === 0)) {
		const line = route(searchReady(row));
		assert.match(line, /^usual next step: obtain bow \(no bow: End crystals are shot from the ground/, line);
		assert.doesNotMatch(line, /stronghold/);
		assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES && !line.endsWith('…'), line);
	}
	// Makings for spare eyes held: the bow still comes first.
	assert.match(route(searchReady(NO_BOW, [item('ender_pearl', 3), item('blaze_powder', 3)])), /^usual next step: obtain bow \(/);
	// A bow with too few arrows: the arrows, to 32 held.
	const arrows = route(searchReady(SHORT_BOW));
	assert.match(arrows, /^usual next step: obtain arrow count 32 \(arrows 2\/32: each 4 take a flint \(gravel\), a feather \(chickens\) and a stick\)$/);
	assert.ok(Buffer.byteLength(arrows) <= ROUTE_BYTES);
});

test('a handed-back bow or arrow obtain moves the line on to the stronghold', () => {
	assert.match(route(searchReady(NO_BOW), new Set(['minecraft:bow'])), /^usual next step: find structure stronghold follows thrown eyes/);
	assert.match(route(searchReady(NO_BOW, [item('ender_pearl', 3), item('blaze_powder', 3)]), new Set(['minecraft:bow'])), /^usual next step: craft 3 spare ender_eyes .* then find structure stronghold/);
	assert.match(route(searchReady(SHORT_BOW), new Set(['minecraft:arrow'])), /^usual next step: find structure stronghold/);
	// The arrows' release does not release the bow.
	assert.match(route(searchReady(NO_BOW), new Set(['minecraft:arrow'])), /^usual next step: obtain bow \(/);
});

test('with a bow and 32 arrows there is no ranged step', () => {
	for (const arrows of [32, 40]) assert.match(route(searchReady([1, arrows, 0, 0, 0, 20, 8, 300])), /^usual next step: find structure stronghold/);
	assert.match(route(searchReady([1, 30, 0, 0, 0, 20, 8, 300], [item('spectral_arrow', 2)])), /^usual next step: find structure stronghold/);
});

test('the ranged step never overrides an open portal, frames in view, or a stale inventory', () => {
	assert.match(route(sample(entryKit(NO_BOW, 12))), /^usual next step: enter the End portal/);
	const frames = Array.from({ length: 12 }, (_, x) => ({ blockId: 'minecraft:end_portal_frame', x, y: 30, z: 0, state: { eye: 'false' } }));
	assert.match(route(sample(entryKit(NO_BOW, 12), { blocks: frames })), /^usual next step: set the ender_eyes/);
	const stale = { ...searchReady(NO_BOW), continuity: { rememberedSections: ['inventory'] } };
	assert.doesNotMatch(route(stale) ?? '', /obtain bow/);
});

test('the bow release is wired through the production route line', async () => {
	const spec = immutableGoalSpec('beat the game', { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
	const r = { agentId: 'ranged', currentGoal: 'beat the game', currentGoalSpec: spec, goalRevision: 1 };
	const views = new LiveTaskViews();
	await views.observe(r, { ...searchReady(NO_BOW), observedAtEpochMs: 5, world: { worldId: 'w1', dimension: 'minecraft:the_nether' } });
	await views.observe(r, searchReady(NO_BOW));
	assert.match(views.continuity(r).route ?? '', /^usual next step: obtain bow \(/);
	views.noteFoodHandback(r, { kind: 'obtain', arguments: { item: 'bow' } }, { state: 'FAILED', reasonCode: 'NO_SOURCE' });
	assert.match(views.continuity(r).route, /^usual next step: find structure stronghold/);
});

test('a handed-back obtain releases its fix, and only that fix', () => {
	const o = sample([item('string', 3), item('stick', 3), item('bucket')], { blocks: [PORTAL, { blockId: 'minecraft:water', x: 3, y: 30, z: 0 }] });
	assert.deepEqual(endKit(o).fixes, ['obtain bow', 'obtain water_bucket']);
	assert.deepEqual(endKit(o, { handedBack: new Set(['minecraft:bow']) }).fixes, ['obtain water_bucket']);
	assert.match(route(o, new Set(['minecraft:bow'])), /in reach first: obtain water_bucket \(/);
});

test('the release is wired: a failed bow obtain this life drops the bow fix from the production route line', async () => {
	const spec = immutableGoalSpec('beat the game', { type: 'entity_killed_by_agent', entityType: 'minecraft:ender_dragon', afterGoalStart: true });
	const r = { agentId: 'kit', currentGoal: 'beat the game', currentGoalSpec: spec, goalRevision: 1 };
	const views = new LiveTaskViews();
	// The Nether was visited earlier this world.
	await views.observe(r, { ...sample([item('string', 3), item('stick', 3)], { at: 5 }), world: { worldId: 'w1', dimension: 'minecraft:the_nether' } });
	await views.observe(r, sample([item('string', 3), item('stick', 3)]));
	const before = views.continuity(r).route;
	assert.match(before ?? '', /in reach first: obtain bow/, before);
	// A danger stop is no release.
	views.noteFoodHandback(r, { kind: 'obtain', arguments: { item: 'bow' } }, { state: 'FAILED', reasonCode: 'OBTAIN_DANGER' });
	assert.match(views.continuity(r).route, /in reach first: obtain bow/);
	views.noteFoodHandback(r, { kind: 'obtain', arguments: { item: 'bow' } }, { state: 'FAILED', reasonCode: 'NO_SOURCE' });
	assert.doesNotMatch(views.continuity(r).route, /obtain bow/);
	assert.match(views.continuity(r).route, /^usual next step: enter the End portal/);
});

test('the line stays within ROUTE_BYTES with the note', () => {
	for (const items of [[], [item('string', 3), item('stick', 3), item('bucket'), item('red_wool', 3), item('porkchop', 3), item('flint', 3), item('feather', 3), item('bow')]]) {
		const line = route(sample(items, { blocks: [PORTAL, { blockId: 'minecraft:water', x: 3, y: 30, z: 0 }] }));
		assert.ok(Buffer.byteLength(line) <= ROUTE_BYTES, line);
		assert.match(line, /^usual next step: enter the End portal/);
	}
});
