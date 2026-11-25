import test from 'node:test';
import assert from 'node:assert/strict';
import { emptyKnown, evaluatePlanCheck, rememberPlanFacts, restoreKnown } from '../src/plan-checks.mjs';
import { routeLine } from '../src/skill-fits.mjs';

// The remembered lava pools are what the lava:10 step and the portal route hint read. In the real games the memory only
// grew: one game kept pointing at pool cells it had already cast into its own frame, and another cast five times at a lava fall with
// no source blocks while the plan read "pool found" from a pool about 400 blocks behind it. These states are rebuilt
// from those games' coordinates and result messages.

const OVERWORLD = 'minecraft:overworld';
const KIT = [['iron_pickaxe', 1], ['water_bucket', 1], ['bucket', 1], ['flint_and_steel', 1], ['shield', 1, 'offhand'],
	['iron_chestplate', 1, 'chest'], ['iron_boots', 1, 'feet'], ['cooked_beef', 24], ['cobblestone', 64]];
const lava = (x, y, z, level = '0') => ({ blockId: 'minecraft:lava', state: { level }, x, y, z, visible: true });
const block = (id, x, y, z) => ({ blockId: `minecraft:${id}`, x, y, z, visible: true });
let tick = 0;
function sample({ x, y, z }, { blocks = [], lastResult } = {}) {
	return { ready: true, observedAtEpochMs: 1_800_000_000_000 + ++tick, world: { worldId: 'w', dimension: OVERWORLD },
		position: { x, y, z }, player: { health: 20, foodLevel: 20 }, blocks,
		inventory: { items: KIT.map(([id, count, slot]) => ({ itemId: `minecraft:${id}`, count, ...(slot ? { slot } : {}) })) },
		...(lastResult ? { lastResult: { present: true, state: 'FAILED', ...lastResult } } : {}) };
}
const sources = known => known.lavaPools.reduce((n, p) => n + p.sources, 0);
const route = (o, known) => routeLine({ observation: o, known, evaluate: evaluatePlanCheck });
// The cast controller's NO_LAVA_IN_REACH text (ServerCastObsidianController), as one real game got it.
const NO_LAVA = 'No lava source seen within 16 blocks to fill the bucket after a full look around; frame site 496,-35,-479 axis x (asked 497,-35,-477), 0 blocks to mine, mined 0; looked around 7 times for lava; lava sources seen within 16: 0; carried water_bucket 1, lava_bucket 0, bucket 1';

test('a cast that found no lava in reach forgets the nearby cells, and the far pool is named with its distance', () => {
	const known = emptyKnown();
	// Early on the game saw a ten-source pool at 99,-55,-599.
	rememberPlanFacts(known, sample({ x: 101.5, y: -54, z: -596.5 }, { blocks: Array.from({ length: 10 }, (_, i) => lava(95 + i, -55, -599)) }));
	// Hours later, at the lava fall near 497,-35,-477, it remembered two sources there that were not still lava any more.
	rememberPlanFacts(known, sample({ x: 498.5, y: -35, z: -476.5 }, { blocks: [lava(498, -38, -477), lava(501, -39, -474)] }));
	assert.equal(sources(known), 12);
	const at = { x: 498.5, y: -35, z: -476.8 };
	const failed = sample(at, { lastResult: { actionId: 'cast-1', actionType: 'cast_obsidian', reasonCode: 'NO_LAVA_IN_REACH', message: NO_LAVA } });
	assert.equal(rememberPlanFacts(known, failed), true);
	assert.deepEqual(known.lavaPools.map(p => [p.x, p.sources]), [[95, 10]]);
	// The far pool still counts for the lava step, but the route no longer says "beside the lava pool" as if it were here.
	assert.equal(evaluatePlanCheck('lava:10', failed, known).ok, true);
	const line = route(failed, known);
	assert.match(line, /^usual next step: find block minecraft:lava nearer than the pool \d+ blocks away at \d+,-55,-599 \(or go there\), then build nether_portal beside it /);
	const away = Number(line.match(/the pool (\d+) blocks away/)[1]);
	assert.ok(away > 390 && away < 420, `pool distance ${away}`);
	assert.doesNotMatch(line, /…$/);
});

test('the same result read again on later samples forgets only once: lava seen after it stays remembered', () => {
	const known = emptyKnown();
	const at = { x: 498.5, y: -35, z: -476.8 };
	const result = { actionId: 'cast-2', actionType: 'cast_obsidian', reasonCode: 'NO_LAVA_IN_REACH', message: NO_LAVA };
	rememberPlanFacts(known, sample(at, { blocks: [lava(498, -38, -477)] }));
	rememberPlanFacts(known, sample(at, { lastResult: result }));
	assert.equal(sources(known), 0);
	// A step later it looks round and sees a real source in the same box; the stale result must not wipe it.
	rememberPlanFacts(known, sample(at, { lastResult: result, blocks: [lava(503, -40, -477)] }));
	rememberPlanFacts(known, sample(at, { lastResult: result }));
	assert.equal(sources(known), 1);
	// A new failed cast does forget it.
	rememberPlanFacts(known, sample(at, { lastResult: { ...result, actionId: 'cast-3' } }));
	assert.equal(sources(known), 0);
});

test('pool cells cast into the frame stop counting as lava once seen as obsidian', () => {
	const known = emptyKnown();
	const pool = [[368, -55, 512], [369, -55, 512], [370, -55, 512], [368, -55, 513], [369, -55, 513], [372, -56, 513], [373, -56, 513]];
	rememberPlanFacts(known, sample({ x: 372.5, y: -56, z: 513.5 }, { blocks: pool.map(c => lava(...c)) }));
	assert.equal(sources(known), 7);
	const near = sample({ x: 373.5, y: -54, z: 514.5 });
	assert.match(route(near, known), /^usual next step: build nether_portal beside the lava pool at 373,-56,513 \(/);
	// The frame's bottom row was cast from the cells under it, and one flowing remnant is left.
	rememberPlanFacts(known, sample({ x: 375.5, y: -55, z: 511.5 }, { blocks: [block('obsidian', 372, -56, 513), block('obsidian', 373, -56, 513), lava(370, -55, 512, '3')] }));
	assert.equal(sources(known), 4);
	assert.ok(!known.lavaPools[0].cells.includes('372,-56,513'));
	assert.match(route(near, known), /beside the lava pool at 369,-55,513 \(/);
	// Every cell gone: the pool is dropped and the route goes back to finding lava.
	rememberPlanFacts(known, sample({ x: 375.5, y: -55, z: 511.5 }, { blocks: [[368, -55, 512], [369, -55, 512], [368, -55, 513], [369, -55, 513]].map(c => block('cobblestone', ...c)) }));
	assert.deepEqual(known.lavaPools, []);
	assert.equal(evaluatePlanCheck('lava:1', near, known).ok, false);
	assert.match(route(near, known), /^usual next step: find block minecraft:lava, then build nether_portal beside the pool/);
});

test('a result that saw lava, another action, or a dead sample forgets nothing', () => {
	const at = { x: 0.5, y: -50, z: 0.5 };
	const fresh = () => { const k = emptyKnown(); rememberPlanFacts(k, sample(at, { blocks: [lava(3, -51, 2), lava(4, -51, 2)] })); return k; };
	for (const lastResult of [
		{ actionId: 'a', actionType: 'cast_obsidian', reasonCode: 'CAST_INCOMPLETE', message: 'cast 4 of 10; lava sources seen within 16: 2; carried water_bucket 1, lava_bucket 0, bucket 1' },
		{ actionId: 'b', actionType: 'travel_to', reasonCode: 'ARRIVED', message: 'Arrived within 1.0 blocks of the target' },
		{ actionId: 'c', actionType: 'cast_obsidian', reasonCode: 'NO_LAVA_IN_REACH', message: 'No lava source seen within 16 blocks', present: false },
	]) {
		const known = fresh();
		rememberPlanFacts(known, sample(at, { lastResult }));
		assert.equal(sources(known), 2, lastResult.actionId);
	}
	const known = fresh();
	rememberPlanFacts(known, { ...sample(at, { lastResult: { actionId: 'd', reasonCode: 'NO_LAVA_IN_REACH', message: NO_LAVA } }), player: { health: 0, dead: true } });
	assert.equal(sources(known), 2);
	// Cells outside the body's search box (16 across, 6 below to 4 above the feet) are kept.
	const wide = emptyKnown();
	rememberPlanFacts(wide, sample(at, { blocks: [lava(20, -50, 0), lava(0, -58, 0), lava(0, -44, 0), lava(5, -54, 5)] }));
	rememberPlanFacts(wide, sample(at, { lastResult: { actionId: 'e', reasonCode: 'NO_LAVA_IN_REACH', message: NO_LAVA } }));
	assert.deepEqual(wide.lavaPools.flatMap(p => p.cells).sort(), ['0,-44,0', '0,-58,0', '20,-50,0']);
	// And what is left survives a restore.
	assert.deepEqual(restoreKnown(JSON.parse(JSON.stringify(wide))).lavaPools.map(p => p.sources), wide.lavaPools.map(p => p.sources));
});
