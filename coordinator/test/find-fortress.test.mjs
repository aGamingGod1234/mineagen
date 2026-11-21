import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';
import { MAX_FAILED_LEGS, TURNS, FORTRESS_LEG, BUILD_LEG, AHEAD_MIN, fortressSearch, footingAhead, nextFortressTarget, startHeading, yawToward } from '../src/find-fortress.mjs';
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
			} else if (step.go && args.x !== undefined) Object.assign(observation.player, { x: args.x, z: args.z });
			if (step.items) observation.inventory.items = step.items;
			return step.result;
		} };
}

test('legs keep one heading along z, toward the nearest unseen region start ground, walking, and stop on a sighting', async () => {
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
	assert.equal(first.yaw, target.z < 100.5 ? 180 : 0, 'along z, the way fortresses string out');
	assert.equal(first.yaw, startHeading({ x: 100.5, z: 100.5 }, target));
});

test('the nether_fortress spelling takes the same loop', async () => {
	const body = bodyFor({ onLook: (o, calls) => (calls.length >= 1 ? { structures: [fortressRow] } : null) });
	const result = await searchFor({ structure: 'nether_fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(body.calls[0].build, false);
});

test('walking legs at every turn come first; a short building leg on the bearing only after all of them fail', async () => {
	const body = bodyFor({ travel: (args) => (args.build ? { result: arrived, go: true } : { result: noRoute }),
		onLook: (o, calls) => (calls.length >= 2 ? { structures: [fortressRow] } : null) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual(body.calls.map((call) => call.build), [false, false, false, false, false, true]);
	assert.equal(new Set(body.calls.slice(0, 5).map((call) => call.yaw)).size, 5, 'five walking headings');
	const build = body.calls[5], u = { x: -Math.sin(body.calls[0].yaw * Math.PI / 180), z: Math.cos(body.calls[0].yaw * Math.PI / 180) };
	assert.deepEqual([build.x, build.z], [Math.floor(100.5 + u.x * BUILD_LEG) + 0.5, Math.floor(100.5 + u.z * BUILD_LEG) + 0.5], 'the build aims a short way on along the heading');
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
	assert.equal(body.calls.length, TURNS.length, 'every walking heading, then no blocks to build with');
	assert.ok(body.calls.every((call) => call.build === false));
});

test('out of blocks mid-bridge hands back at once', async () => {
	const body = bodyFor({ travel: (args) => (args.build ? { result: { state: 'FAILED', reasonCode: 'OUT_OF_BLOCKS', message: 'No plain block left' }, items: blocks(2) } : { result: noRoute }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.find.stopCode, 'OUT_OF_BLOCKS');
	assert.deepEqual(body.calls.map((call) => call.build), [false, false, false, false, false, true]);
});

test('no way on: building legs that keep failing turn, then hand back NO_WAY_ON', async () => {
	const body = bodyFor({ travel: () => ({ result: noRoute }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 570_000 });
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.equal(result.find.stopCode, 'NO_WAY_ON');
	assert.equal(body.calls.length, MAX_FAILED_LEGS, 'five walks and a build on each heading in turn');
	assert.ok(new Set(body.calls.map((call) => call.yaw)).size >= 4, 'each failed leg turns further from the heading');
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
	assert.equal(again.calls[0].yaw, body.calls[0].yaw, 'the resumed search keeps its heading');
	assert.ok(Number.isFinite(state.fortressHeading));
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

test('MINEAGEN_FORTRESS_SEARCH=off keeps the generic sweep for a fortress in the Nether', () => {
	const profile = { kind: 'structure', label: 'fortress' }, observation = { world: { dimension: 'minecraft:the_nether' } };
	assert.equal(fortressSearch(profile, observation, {}), true);
	assert.equal(fortressSearch(profile, observation, { MINEAGEN_FORTRESS_SEARCH: 'off' }), false);
});

test('a build leg aims past the farthest point reached, so a failed side walk that dragged the body back costs no new tunnel', async () => {
	// Live round 1: side walks slid the body 20 blocks back down its own tunnel; the build leg then re-walked it and
	// counted as progress, forever. Here every failed walk drags the body 20 blocks back; each build still goes on.
	let sign = null;
	const body = bodyFor({ travel: (args, n, observation) => {
		if (args.build) return { result: arrived, go: true };
		sign ??= Math.cos(args.yaw * Math.PI / 180) > 0 ? 1 : -1;
		if (args.yaw !== undefined && n > 1) observation.player.z -= 20 * sign;
		return { result: noRoute };
	}, onLook: (o, calls) => (calls.filter((call) => call.build).length >= 3 ? { structures: [fortressRow] } : null) });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 570_000 });
	const builds = body.calls.filter((call) => call.build);
	assert.ok(builds.length >= 3);
	assert.deepEqual(builds.map((call) => Math.round((call.z - builds[0].z) * sign)), [0, BUILD_LEG, 2 * BUILD_LEG], 'each build goes on from where the last one ended');
});

test('a mob stopping legs is neither progress nor a closed way: the search runs to its time cap, not NO_WAY_ON', async () => {
	const body = bodyFor({ travel: () => ({ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'minecraft:zombified_piglin 6 blocks away' } }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 570_000 });
	assert.equal(result.reasonCode, 'FIND_BUDGET');
	assert.ok(body.calls.length > MAX_FAILED_LEGS);
});

test('after five walks and a build on the heading fail, the next legs go to the side; a side that goes on becomes the heading', async () => {
	const state = {};
	const body = bodyFor({ state, travel: (args, n) => (n > TURNS.length + 1 ? { result: arrived, go: true } : { result: noRoute }),
		onLook: (o, calls) => (calls.length >= TURNS.length + 3 ? { structures: [fortressRow] } : null) });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	const first = body.calls[0].yaw;
	assert.deepEqual(body.calls.slice(0, TURNS.length + 1).map((call) => call.build), [false, false, false, false, false, true]);
	const side = body.calls[TURNS.length + 1];
	assert.equal(side.build, false);
	assert.equal(Math.abs(((side.yaw - first + 540) % 360) - 180), 90, 'a quarter turn');
	assert.equal(state.fortressHeading, side.yaw);
	assert.equal(body.calls[TURNS.length + 2].yaw, side.yaw, 'and it keeps going that way');
});

test('seen ground ahead is walked to before any compass leg, and a footing that cannot be reached is not tried again', async () => {
	const state = {};
	const far = { x: 104, y: 42, z: 160, dy: 2, distance: 60, footing: 'seen_surface' };
	const near = { x: 98, y: 40, z: 125, dy: 0, distance: 25, footing: 'seen_surface' };
	const body = bodyFor({ state, travel: (args, n) => (n === 1 ? { result: noRoute } : { result: arrived, go: true }),
		onLook: (o, calls) => (calls.length >= 3 ? { structures: [fortressRow] } : null) });
	state.fortressHeading = 0;
	body.frontier = () => ({ candidates: [far, near, { x: 100, y: 40, z: 60, dy: 0, distance: 40, footing: 'seen_surface' }] });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.deepEqual([body.calls[0].x, body.calls[0].z], [104.5, 160.5], 'the farthest seen ground ahead first');
	assert.equal(body.calls[0].build, false);
	assert.deepEqual([body.calls[1].x, body.calls[1].z], [98.5, 125.5], 'then the next one, not the unreachable one again');
	assert.deepEqual(state.fortressTried, ['104,42,160']);
});

test('footingAhead: ahead within 45 degrees, not stood on, not a cliff or a roof ledge', () => {
	const here = { x: 0.5, y: 40, z: 0.5 };
	const pick = (rows) => footingAhead(rows, here, 0)?.z ?? null;
	assert.equal(pick([{ x: 0, y: 40, z: AHEAD_MIN - 2 }]), null, 'too close to count as progress');
	assert.equal(pick([{ x: 0, y: 40, z: -30 }]), null, 'behind');
	assert.equal(pick([{ x: 40, y: 40, z: 20 }]), null, 'more than 45 degrees off');
	assert.equal(pick([{ x: 0, y: 40, z: 30, visited: true }]), null, 'stood on already');
	assert.equal(pick([{ x: 0, y: 40, z: 30, blocked: true }]), null, 'a move failed there');
	assert.equal(pick([{ x: 0, y: 70, z: 30 }]), null, 'a ledge high above');
	assert.equal(pick([{ x: 0, y: 10, z: 30 }]), null, 'a drop far below');
	assert.equal(pick([{ x: 0, y: 40, z: 30 }, { x: 0, y: 41, z: 50 }]), 50, 'the farthest along');
});

test('a vantage is climbed only when it lies ahead toward the target and away from earlier look points', async () => {
	// The candidate is placed along (or against) the bearing of the leg just walked, which heads for the leg's target.
	const run = async (place) => {
		const body = bodyFor({ onLook: (o, calls) => (calls.length >= 2 ? { structures: [fortressRow] } : null) });
		body.frontier = () => {
			if (body.calls.length === 0) return { candidates: [] };
			const p = body.observation.player, yaw = body.calls.at(-1).yaw * Math.PI / 180;
			return { candidates: [place(p, -Math.sin(yaw), Math.cos(yaw))] };
		};
		await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
		return body.calls.some((call) => call.x !== undefined && call.build === false);
	};
	assert.equal(await run((p, ux, uz) => ({ x: Math.floor(p.x + ux * 20), y: 52, z: Math.floor(p.z + uz * 20), dy: 12, distance: 20 })), true, 'high ground ahead is climbed');
	assert.equal(await run((p, ux, uz) => ({ x: Math.floor(p.x - ux * 20), y: 52, z: Math.floor(p.z - uz * 20), dy: 12, distance: 20 })), false, 'high ground behind is not');
	assert.equal(await run(() => ({ x: 101, y: 52, z: 110, dy: 12, distance: 20 })), false, 'a hill next to an earlier look point is not');
});
