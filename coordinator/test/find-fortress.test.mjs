import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';
import { MAX_FAILED_LEGS, MAX_WALK_FAILS, FORTRESS_LEG, BUILD_LEG, nextFortressTarget, yawToward } from '../src/find-fortress.mjs';
import { REGION_BLOCKS, searchRegions } from '../src/nether-regions.mjs';

// The wall-breaker contract's hand-back rules for find {structure: fortress} in the Nether, one test each.
const blocks = (count) => (count > 0 ? [{ itemId: 'minecraft:cobblestone', count }] : []);
const arrived = { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
const noRoute = { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer' };
const fortressRow = { structure: 'nether fortress', x: 200, y: 60, z: 40 };

function bodyFor({ items = blocks(64), health = 20, travel = () => ({ result: arrived, go: true }), onLook = () => null, known = null, state = {} } = {}) {
	let now = 0;
	const observation = { player: { x: 100.5, y: 40, z: 100.5, yaw: 0, health, threats: [] },
		world: { dimension: 'minecraft:the_nether', biome: 'minecraft:nether_wastes' }, inventory: { items } };
	const calls = [], looks = [];
	return { calls, looks, observation, eyeSearchState: state, now: () => now, observe: async () => structuredClone(observation),
		frontier: () => null, known: () => known, places: async () => [],
		look: async () => {
			now += 2000;
			looks.push({ x: observation.player.x, z: observation.player.z });
			return { state: 'SUCCEEDED', survey: onLook(observation, calls) ?? {} };
		},
		act: async (type, args) => {
			calls.push({ type, ...structuredClone(args) });
			const step = travel(args, calls.length, observation);
			now += step.ms ?? 10_000;
			if (step.throws) throw step.throws;
			if (step.go && args.yaw !== undefined) {
				observation.player.x -= Math.sin(args.yaw * Math.PI / 180) * args.distance;
				observation.player.z += Math.cos(args.yaw * Math.PI / 180) * args.distance;
			}
			if (step.items) observation.inventory.items = step.items;
			return step.result;
		} };
}

test('legs head for the nearest unseen region start ground, walking, and stop on a sighting', async () => {
	const body = bodyFor({ onLook: (o, calls) => (calls.length >= 2 ? { structures: [fortressRow] } : null) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.state, 'SUCCEEDED');
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(body.calls.length, 2);
	const first = body.calls[0];
	assert.equal(first.type, 'travel_to');
	assert.equal(first.build, false, 'walk first: building legs wore out a pickaxe tunnelling through hills');
	assert.ok(first.distance <= FORTRESS_LEG);
	const target = searchRegions({ x: 100.5, z: 100.5 }, new Map(), 1, [{ x: 100, z: 100 }])[0].target;
	assert.equal(first.yaw, yawToward(target.x - 100.5, target.z - 100.5));
});

test('the nether_fortress spelling takes the same loop', async () => {
	const body = bodyFor({ onLook: (o, calls) => (calls.length >= 1 ? { structures: [fortressRow] } : null) });
	const result = await searchFor({ structure: 'nether_fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(body.calls[0].build, false);
});

test('a walking leg that gets nowhere is retried once on the same bearing as a short building leg', async () => {
	const body = bodyFor({ travel: (args) => (args.build ? { result: arrived, go: true } : { result: noRoute }),
		onLook: (o, calls) => (calls.length >= 2 ? { structures: [fortressRow] } : null) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual(body.calls.map((call) => call.build), [false, true]);
	assert.equal(body.calls[1].yaw, body.calls[0].yaw);
	assert.equal(body.calls[1].distance, BUILD_LEG);
});

test('a mob stopping a walking leg is no reason to build', async () => {
	const body = bodyFor({ travel: (args, n) => (n === 1 ? { result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'zombified piglin' } } : { result: arrived, go: true }),
		onLook: (o, calls) => (calls.length >= 2 ? { structures: [fortressRow] } : null) });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.ok(body.calls.every((call) => call.build === false));
});

test('hands back danger from a leg with the leg code', async () => {
	const body = bodyFor({ travel: () => ({ result: { state: 'FAILED', reasonCode: 'IN_LAVA', message: 'Entered lava' } }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(result.find.stopCode, 'IN_LAVA');
	assert.equal(body.calls.length, 1);
});

test('hands back a reflex interrupt as danger', async () => {
	const body = bodyFor({ travel: () => ({ result: { state: 'RUNNING', actionId: 'leg-1', interruptedBy: 'reflex:default-lava' } }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(body.calls.length, 1);
});

test('health floor: no leg starts at or below the search floor', async () => {
	const body = bodyFor({ health: 6 });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(result.find.stopCode, 'LOW_HEALTH');
	assert.equal(body.calls.length, 0);
});

test('time cap: the call budget ends the loop with FIND_BUDGET', async () => {
	const body = bodyFor();
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 60_000 });
	assert.equal(result.state, 'TIMED_OUT');
	assert.equal(result.reasonCode, 'FIND_BUDGET');
	assert.ok(body.calls.length >= 2 && body.calls.length <= 6);
});

test('out of blocks: walking legs that get nowhere hand back OUT_OF_BLOCKS', async () => {
	const body = bodyFor({ items: blocks(3), travel: () => ({ result: noRoute }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.equal(result.find.stopCode, 'OUT_OF_BLOCKS');
	assert.equal(body.calls.length, MAX_WALK_FAILS);
	assert.ok(body.calls.every((call) => call.build === false));
});

test('out of blocks mid-bridge hands back at once', async () => {
	const body = bodyFor({ travel: (args) => (args.build ? { result: { state: 'FAILED', reasonCode: 'OUT_OF_BLOCKS', message: 'No plain block left' }, items: blocks(2) } : { result: noRoute }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.find.stopCode, 'OUT_OF_BLOCKS');
	assert.deepEqual(body.calls.map((call) => call.build), [false, true]);
});

test('no way on: building legs that keep failing turn, then hand back NO_WAY_ON', async () => {
	const body = bodyFor({ travel: () => ({ result: noRoute }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.equal(result.find.stopCode, 'NO_WAY_ON');
	assert.equal(body.calls.length, MAX_FAILED_LEGS * 2, 'each failed attempt is a walk then a build on the same bearing');
	assert.ok(new Set(body.calls.map((call) => call.yaw)).size >= 4, 'each failed leg turns further from the bearing');
});

test('searched out: every region in the window known to hold a bastion hands back FIND_NOT_FOUND', async () => {
	const sightings = [];
	for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) sightings.push({ kind: 'built', what: 'built:minecraft:gilded_blackstone', x: dx * REGION_BLOCKS + 100, y: 60, z: dz * REGION_BLOCKS + 100 });
	const body = bodyFor({ known: { sightings, trail: [] } });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_NOT_FOUND');
	assert.equal(body.calls.length, 0);
});

test('model cancel propagates out of the loop', async () => {
	const cancelled = Object.assign(new Error('find cancelled before its next step'), { code: 'NATIVE_ACTION_CANCELLED' });
	const body = bodyFor({ travel: () => ({ throws: cancelled }) });
	await assert.rejects(searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 }), { code: 'NATIVE_ACTION_CANCELLED' });
});

test('resumes from memory: ground already stood near is not a target again, across calls and after a respawn', async () => {
	const at = { x: 100.5, z: 100.5 };
	const first = nextFortressTarget(at, { sightings: [], trail: [] });
	// A later call (after a respawn, a portal trip) remembers standing at the first target: that ground is seen.
	const second = nextFortressTarget(at, { sightings: [], trail: [{ x: first.x, z: first.z }] });
	assert.notDeepEqual([second.x, second.z], [first.x, first.z]);
	assert.ok(Math.hypot(second.x - first.x, second.z - first.z) > 140);
	// The search's own look points kept in this dimension's state count the same way.
	const state = {};
	const body = bodyFor({ state });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 40_000 });
	assert.ok(state.fortressLooks.length >= 2);
	const again = bodyFor({ state });
	await searchFor({ structure: 'fortress' }, again, { timeoutMs: 20_000 });
	assert.notEqual(again.calls[0].yaw, body.calls[0].yaw, 'the resumed search does not repeat the first leg');
});

test('a remembered fortress sighting is the target before any unseen region', () => {
	const target = nextFortressTarget({ x: 0, z: 0 }, { sightings: [{ kind: 'built', what: 'built:minecraft:nether_bricks', x: 300, y: 60, z: -20 }], trail: [] });
	assert.equal(target.kind, 'remembered');
	assert.deepEqual([target.x, target.z], [300, -20]);
});

test('outside the Nether, or for another structure, the generic sweep runs', async () => {
	const body = bodyFor();
	body.observation.world.dimension = 'minecraft:overworld';
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 20_000 });
	assert.equal(body.calls[0].build, false);
	const bastion = bodyFor();
	await searchFor({ structure: 'bastion' }, bastion, { timeoutMs: 20_000 });
	assert.equal(bastion.calls[0].build, false);
});

test('a mob stopping legs is neither progress nor a closed way: the search runs to its time cap, not NO_WAY_ON', async () => {
	const body = bodyFor({ travel: () => ({ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'minecraft:zombified_piglin 6 blocks away' } }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_BUDGET');
	assert.ok(body.calls.length > MAX_FAILED_LEGS);
});

test('after every turn toward one target fails, that ground is ruled out and the next target is taken', async () => {
	const state = {};
	const body = bodyFor({ state, travel: () => ({ result: noRoute }) });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(state.fortressUnreachable.length, 3);
	const first = nextFortressTarget({ x: 100.5, z: 100.5 }, null, [{ x: 100, z: 100 }]);
	assert.deepEqual(state.fortressUnreachable[0], { x: Math.round(first.x), z: Math.round(first.z) });
	assert.notEqual(body.calls[10].yaw, body.calls[0].yaw, 'the sixth attempt (walk and build) heads for another target');
});

test('a vantage is climbed only when it lies ahead toward the target and away from earlier look points', async () => {
	// The candidate is placed along (or against) the bearing of the leg just walked, which heads for the leg's target.
	const run = async (place) => {
		const body = bodyFor({ onLook: (o, calls) => (calls.length >= 2 ? { structures: [fortressRow] } : null) });
		body.frontier = () => {
			const p = body.observation.player, yaw = body.calls.at(-1).yaw * Math.PI / 180;
			return { candidates: [place(p, -Math.sin(yaw), Math.cos(yaw))] };
		};
		await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
		return body.calls.some((call) => call.x !== undefined && call.build === false);
	};
	assert.equal(await run((p, ux, uz) => ({ x: Math.floor(p.x + ux * 20), y: 52, z: Math.floor(p.z + uz * 20), dy: 8, distance: 20 })), true, 'high ground ahead is climbed');
	assert.equal(await run((p, ux, uz) => ({ x: Math.floor(p.x - ux * 20), y: 52, z: Math.floor(p.z - uz * 20), dy: 8, distance: 20 })), false, 'high ground behind is not');
	assert.equal(await run(() => ({ x: 101, y: 52, z: 110, dy: 8, distance: 20 })), false, 'a hill next to an earlier look point is not');
});
