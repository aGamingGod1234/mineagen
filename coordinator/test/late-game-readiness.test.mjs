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
// The kit every trip into danger takes (skill-fits.mjs kitBefore), added where a slot or the food is empty: the End
// kit below is about the rest.
const kitted = o => {
	const items = o.inventory.items, add = [];
	if (!items.some(i => i.slot === 'offhand')) add.push(item('shield', 1, 'offhand'));
	if (!items.some(i => i.slot === 'chest')) add.push(item('iron_chestplate', 1, 'chest'));
	if (!items.some(i => i.slot === 'feet')) add.push(item('iron_boots', 1, 'feet'));
	if (!items.some(i => /cooked_|bread/.test(i.itemId))) add.push(item('bread', 4));
	return { ...o, inventory: { items: [...items, ...add] } };
};
const route = (o, kitHandedBack) => routeLine({ observation: kitted(o), known: visited(), evaluate: evaluatePlanCheck, ...(kitHandedBack ? { kitHandedBack } : {}) });

test('a full kit adds no note: the head is the portal alone', () => {
	assert.deepEqual(endKit(sample(FULL)).missing, []);
	assert.equal(endKitNote(sample(FULL)), null);
	assert.equal(route(sample(FULL)), 'usual next step: enter the End portal (portal open)');
});

test('the shield, armour and food go in first; the End kit itself stays a note', () => {
	const o = sample([item('bow'), item('arrow', 40)]);
	assert.match(routeLine({ observation: o, known: visited(), evaluate: evaluatePlanCheck }), /^usual next step: obtain shield, then equip_item it to offhand .*kit before the End\)$/);
	assert.match(route(o), /^usual next step: enter the End portal/);
});

test('the head stays "enter the End portal" whatever End kit is missing (non-gating)', () => {
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

test('the arrow-free crystal plan: 64 blocks to pillar stand in for a bow', () => {
	assert.ok(!endKit(sample([item('cobblestone', 64)])).missing.some(m => /bow/.test(m)));
	assert.ok(endKit(sample([item('cobblestone', 40)])).missing.some(m => /bow \(or 64 blocks/.test(m)));
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
	await views.observe(r, { ...kitted(sample([item('string', 3), item('stick', 3)], { at: 5 })), world: { worldId: 'w1', dimension: 'minecraft:the_nether' } });
	await views.observe(r, kitted(sample([item('string', 3), item('stick', 3)])));
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
