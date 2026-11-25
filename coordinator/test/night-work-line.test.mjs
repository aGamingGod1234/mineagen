import test from 'node:test';
import assert from 'node:assert/strict';
import { nightWorkLine } from '../src/night-cover.mjs';
import { composeContinuityHeader } from '../src/continuity-header.mjs';

const DEPTH = { id: 'depth', check: 'y<=-45' };
const IRON = { id: 'iron', check: 'tool:pickaxe:iron+ & has:minecraft:bucket|minecraft:water_bucket|minecraft:lava_bucket*1' };
const POOL = { id: 'pool', check: 'lava:10' };

// A measure game on main: at dusk on a hill, iron pickaxe, two buckets, health and food full, plan next "depth";
// the bot rested 9 minutes "to resume the above-ground lava search in daylight".
function body({ y = 69, dayTime = 11_753, armor = 0, skyOpen = true, items = [['minecraft:iron_pickaxe', 1], ['minecraft:bucket', 2]], ...rest } = {}) {
	return {
		ready: true,
		world: { dimension: 'minecraft:overworld', dayTime },
		player: { x: 70.5, y, z: 85.5, armor, skyOpen, health: 20, foodLevel: 20, ...rest },
		inventory: { items: items.map(([itemId, count], slot) => ({ itemId, count, slot })) },
	};
}

test('dusk at the surface with the dig to lava depth next names that dig instead of a night wait', () => {
	const line = nightWorkLine(body(), DEPTH);
	assert.match(line, /^dusk, then night until dawn in ~10m; plan step depth is reach y -45/);
	assert.match(line, /dig_to y -45 now instead of waiting out the night up here$/);
});

test('night after an early climb out, next step iron, stone pickaxe: dig to the iron band', () => {
	const line = nightWorkLine(body({ dayTime: 15_517, items: [['minecraft:stone_pickaxe', 1]] }), IRON);
	assert.match(line, /^night until dawn in ~7m; plan step iron is iron ore/);
	assert.match(line, /dig_to y 16 stopWhenSeen minecraft:iron_ore/);
});

test('back on the surface with the lava pool still open: dig to lava depth and stop at lava', () => {
	assert.match(nightWorkLine(body({ dayTime: 18_000 }), POOL), /dig_to y -54 stopWhenSeen minecraft:lava/);
});

test('silent by day, in full iron, outside the Overworld, and deep underground', () => {
	assert.equal(nightWorkLine(body({ dayTime: 6_000 }), DEPTH), null);
	assert.equal(nightWorkLine(body({ armor: 15 }), DEPTH), null);
	const nether = body(); nether.world.dimension = 'minecraft:the_nether';
	assert.equal(nightWorkLine(nether, DEPTH), null);
	assert.equal(nightWorkLine(body({ y: 10, skyOpen: false }), IRON), null);
	assert.equal(nightWorkLine(body({ y: -50, skyOpen: false }), DEPTH), null);
});

test('silent when the step is not underground work or the body cannot dig it', () => {
	assert.equal(nightWorkLine(body(), { id: 'frame', check: 'frame:10' }), null);
	assert.equal(nightWorkLine(body(), { id: 'stone', check: 'tool:pickaxe:stone+' }), null);
	assert.equal(nightWorkLine(body({ items: [] }), DEPTH), null);
	assert.equal(nightWorkLine(body({ items: [['minecraft:wooden_pickaxe', 1]] }), IRON), null);
	assert.equal(nightWorkLine(body({ inWater: true }), DEPTH), null);
	const remembered = body(); remembered.continuity = { rememberedSections: ['inventory'] };
	assert.equal(nightWorkLine(remembered, DEPTH), null);
});

test('at the surface but under a roof (a dug recess) the line still fires: the wait there is the same', () => {
	assert.notEqual(nightWorkLine(body({ y: 64, skyOpen: false, dayTime: 13_000 }), DEPTH), null);
});

test('the continuity header carries the line as night', () => {
	const night = nightWorkLine(body(), DEPTH);
	assert.equal(composeContinuityHeader({ goal: 'beat the game', night }).night, night);
	assert.equal(composeContinuityHeader({ goal: 'beat the game' })?.night, undefined);
});

test('the live task view puts the line in the header from the plan step a measure game had open', async () => {
	const { LiveTaskViews } = await import('../src/live-task-view.mjs');
	let now = 1_800_000_000_000;
	const views = new LiveTaskViews({ now: () => now });
	const record = { agentId: 'a1', goalRevision: 1, currentGoal: 'Beat the game', currentGoalSpec: { originalRequest: 'Beat the game', fingerprint: 'f1' } };
	const step = (id, check, dependsOn = []) => ({ id, label: id, kind: 'milestone', status: 'pending', dependsOn, detail: '', evidence: null, check });
	const plan = { steps: [step('stone', 'tool:pickaxe:stone+'), step('iron', IRON.check, ['stone']), step('depth', 'y<=-45', ['iron']), step('pool', 'lava:10', ['depth'])] };
	const sample = dayTime => ({ ...body({ dayTime }), observedAtEpochMs: now, world: { worldId: 'w1', dimension: 'minecraft:overworld', dayTime } });
	await views.observe(record, sample(6_000));
	await views.operate(record, { operation: 'replace', plan });
	assert.equal(views.continuity(record)?.night, undefined, 'by day the header says nothing');
	now += 60_000; await views.observe(record, sample(14_000));
	assert.match(views.continuity(record).night, /^night until dawn in ~8m; plan step depth is reach y -45/);
});
