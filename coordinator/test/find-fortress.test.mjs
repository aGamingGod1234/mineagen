import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';
import { MAX_FAILED_LEGS, MAX_DIGS, OPEN_VIEW, LAVA_RIM_Y, BRINK_DROP, brinkOf, towardBrink, viewHeading, TURNS, SEARCH_TURNS, FORTRESS_LEG, BUILD_LEG, AHEAD_MIN, openView, fortressSearch, footingAhead, nextFortressTarget, startHeading, yawToward } from '../src/find-fortress.mjs';
import { REGION_BLOCKS, searchRegions } from '../src/nether-regions.mjs';

// The wall-breaker contract's hand-back rules for find {structure: fortress} in the Nether, one test each.
const blocks = (count) => (count > 0 ? [{ itemId: 'minecraft:cobblestone', count }] : []);
const arrived = { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
const noRoute = { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer' };
const fortressRow = { structure: 'nether fortress', x: 200, y: 60, z: 40 };

function bodyFor({ items = blocks(64), health = 20, travel = () => ({ result: arrived, go: true }), onLook = () => null, ground = null, known = null, state = {} } = {}) {
	let now = 0;
	const observation = { player: { x: 100.5, y: 40, z: 100.5, yaw: 0, health, threats: [] },
		world: { dimension: 'minecraft:the_nether', biome: 'minecraft:nether_wastes' }, inventory: { items } };
	const calls = [], looks = [];
	return { calls, looks, observation, eyeSearchState: state, now: () => now, observe: async () => structuredClone(observation),
		frontier: () => null, known: () => known, places: async () => [],
		look: async () => {
			now += 2000;
			looks.push({ x: observation.player.x, z: observation.player.z });
			return { state: 'SUCCEEDED', survey: onLook(observation, calls) ?? {}, ...(ground === null ? {} : { ground: ground(observation, calls) }) };
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
	assert.deepEqual(body.calls.map((call) => call.build), [false, false, false, true]);
	assert.equal(new Set(body.calls.slice(0, 3).map((call) => call.yaw)).size, 3, 'straight on and 45 each way');
	const build = body.calls[3], u = { x: -Math.sin(body.calls[0].yaw * Math.PI / 180), z: Math.cos(body.calls[0].yaw * Math.PI / 180) };
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
	assert.equal(body.calls.length, SEARCH_TURNS.length, 'every walking heading, then no blocks to build with');
	assert.ok(body.calls.every((call) => call.build === false));
});

test('out of blocks mid-bridge hands back at once', async () => {
	const body = bodyFor({ travel: (args) => (args.build ? { result: { state: 'FAILED', reasonCode: 'OUT_OF_BLOCKS', message: 'No plain block left' }, items: blocks(2) } : { result: noRoute }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.find.stopCode, 'OUT_OF_BLOCKS');
	assert.deepEqual(body.calls.map((call) => call.build), [false, false, false, true]);
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
	// Each stop still lets the body move a few blocks on.
	const body = bodyFor({ travel: (args) => ({ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'minecraft:zombified_piglin 6 blocks away' }, go: true, short: true }) });
	const act = body.act;
	body.act = async (type, args) => act(type, args.yaw !== undefined ? { ...args, distance: 3 } : args);
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 570_000 });
	assert.equal(result.reasonCode, 'FIND_BUDGET');
	assert.ok(body.calls.length > MAX_FAILED_LEGS);
});

test('mobs that stop three legs in a row with the body in place hand back as danger, not a wait beside them', async () => {
	const body = bodyFor({ travel: () => ({ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'minecraft:magma_cube 3 blocks away' } }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 570_000 });
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(result.find.stopCode, 'MOBS_IN_THE_WAY');
	assert.equal(body.calls.filter((call) => call.type === 'travel_to').length, 3);
});

test('after five walks and a build on the heading fail, the next legs go to the side; a side that goes on becomes the heading', async () => {
	const state = {};
	const body = bodyFor({ state, travel: (args, n) => (n > SEARCH_TURNS.length + 1 ? { result: arrived, go: true } : { result: noRoute }),
		onLook: (o, calls) => (calls.length >= SEARCH_TURNS.length + 3 ? { structures: [fortressRow] } : null) });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	const first = body.calls[0].yaw;
	assert.deepEqual(body.calls.slice(0, SEARCH_TURNS.length + 1).map((call) => call.build), [false, false, false, true]);
	const side = body.calls[SEARCH_TURNS.length + 1];
	assert.equal(side.build, false);
	assert.equal(Math.abs(((side.yaw - first + 540) % 360) - 180), 90, 'a quarter turn');
	assert.equal(state.fortressHeading, side.yaw);
	assert.equal(body.calls[SEARCH_TURNS.length + 2].yaw, side.yaw, 'and it keeps going that way');
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

const tunnel = { state: 'SUCCEEDED', reasonCode: 'ARRIVED', message: 'Arrived; 1 legs, bridged 0, pillared 0, tunnelled 20; 64 plain blocks carried' };

test('openView: the farthest land seen within 90 degrees of the heading, not one already tried', () => {
	const views = [{ yaw: 0, farthestLand: 6 }, { yaw: 90, farthestLand: 40 }, { yaw: -90, farthestLand: 30 }, { yaw: 180, farthestLand: 80 }];
	assert.equal(openView(views, 0).yaw, 90);
	assert.equal(openView(views, 0, new Set([6])).yaw, -90, 'yaw 90 tried from this front');
	assert.equal(openView([{ yaw: 45, farthestLand: OPEN_VIEW - 1 }], 0), null, 'too little land seen that way');
	assert.equal(openView([{ yaw: 180, farthestLand: 80 }], 0), null, 'never back the way it came');
});

test('walled in ahead with open ground seen to the side: it walks there before any dig', async () => {
	// A kept heading (0): the open-side rule, not the opening look's heading choice.
	const body = bodyFor({ state: { fortressHeading: 0 }, travel: (args, n) => (args.build ? { result: tunnel, go: true } : args.yaw === 90 ? { result: arrived, go: true } : { result: noRoute }),
		ground: () => [{ yaw: 0, water: 0, land: 3, farthestLand: 5 }, { yaw: 90, water: 0, land: 8, farthestLand: 40 }, { yaw: 180, water: 0, land: 8, farthestLand: 60 }],
		onLook: (o, calls) => (calls.length >= 5 ? { structures: [fortressRow] } : null) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const legs = body.calls.filter((call) => call.type === 'travel_to');
	assert.deepEqual(legs.slice(0, 4).map((call) => [call.build, call.yaw]), [[false, legs[0].yaw], [false, legs[1].yaw], [false, legs[2].yaw], [false, 90]],
		'three walks on the heading, then the open side, not a build');
	assert.equal(legs[3].distance, 40, 'as far as the land seen that way');
	assert.equal(legs.some((call) => call.build), false);
});

test('two digs in a row that never open into walkable ground: back to the last open ground, then the next heading', async () => {
	// The first walk makes way (open ground), then rock all the way on.
	const body = bodyFor({ travel: (args, n) => (n === 1 || args.retrace ? { result: arrived, go: true } : args.build ? { result: tunnel, go: true } : { result: noRoute }) });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	const legs = body.calls.filter((call) => call.type === 'travel_to');
	const open = { x: Math.floor(body.looks[1].x) + 0.5, z: Math.floor(body.looks[1].z) + 0.5 };
	const builds = legs.map((call, index) => (call.build ? index : -1)).filter((index) => index >= 0);
	assert.ok(builds.length >= MAX_DIGS);
	const back = legs[builds[MAX_DIGS - 1] + 1 + SEARCH_TURNS.length];
	assert.equal(back.retrace, true, 'back along its own trail');
	assert.deepEqual([back.x, back.z], [open.x, open.z], 'to where walking last made way');
	const before = legs[builds[0]], after = legs.find((call, index) => index > legs.indexOf(back) && call.yaw !== undefined);
	assert.notEqual(Math.round(Math.atan2(-(before.x - open.x), before.z - open.z) * 180 / Math.PI), after.yaw, 'the next heading, not the same rock again');
});

test('a body that starts inside rock with no open ground behind it digs on straight: there is nowhere to go back to', async () => {
	const body = bodyFor({ travel: (args) => (args.build ? { result: tunnel, go: true } : { result: noRoute }) });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	const legs = body.calls.filter((call) => call.type === 'travel_to');
	assert.equal(legs.some((call) => call.retrace), false);
	assert.ok(legs.filter((call) => call.build).length > MAX_DIGS);
});

test('a side walk that only slides back down its own tunnel is no way on', async () => {
	// Every open-side walk ends at an earlier look point (the start), never on new ground.
	const body = bodyFor({ state: { fortressHeading: 0 }, travel: (args, n, o) => {
			if (args.build) return { result: tunnel, go: true };
			if (args.yaw === 90) { Object.assign(o.player, { x: 100.5, z: 100.5 }); return { result: noRoute }; }
			return { result: noRoute };
		},
		ground: () => [{ yaw: 90, water: 0, land: 8, farthestLand: 40 }] });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 120_000 });
	const legs = body.calls.filter((call) => call.type === 'travel_to');
	assert.ok(legs.filter((call) => call.yaw === 90).length <= 2, 'the open side is tried once from each front, not every round');
});

test('MINEAGEN_FORTRESS_SEARCH=plain plays the loop without the walled-in rules', async () => {
	const prior = process.env.MINEAGEN_FORTRESS_SEARCH;
	process.env.MINEAGEN_FORTRESS_SEARCH = 'plain';
	try {
		const body = bodyFor({ travel: (args) => (args.build ? { result: tunnel, go: true } : { result: noRoute }),
			ground: () => [{ yaw: 90, water: 0, land: 8, farthestLand: 40 }], onLook: (o, calls) => (calls.length >= 5 ? { structures: [fortressRow] } : null) });
		await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
		assert.equal(body.calls.some((call) => call.yaw === 90), false, 'no open-side walk');
		assert.equal(body.calls[3].build, true);
	} finally { if (prior === undefined) delete process.env.MINEAGEN_FORTRESS_SEARCH; else process.env.MINEAGEN_FORTRESS_SEARCH = prior; }
});

test('each find first climbs the highest ground in sight, any way, and looks from there', async () => {
	const body = bodyFor({ onLook: (o, calls) => (calls.length >= 1 && o.player.z < 95 ? { structures: [fortressRow] } : null) });
	body.frontier = () => ({ candidates: [{ x: 100, y: 52, z: 70, dy: 12, distance: 30 }, { x: 110, y: 45, z: 110, dy: 5, distance: 14 }] });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual([body.calls[0].x, body.calls[0].y, body.calls[0].z, body.calls[0].build], [100.5, 52, 70.5, false], 'the highest, behind as much as ahead');
	assert.equal(body.calls.length, 1, 'the look from the top saw it');
});

test('footingAhead: from higher up, ground at the lava sea rim is not walked down to', () => {
	const rim = { x: 100, y: LAVA_RIM_Y - 1, z: 140, footing: 'seen' };
	assert.equal(footingAhead([rim], { x: 100.5, y: 48, z: 100.5 }, 0), null, 'standing at y48');
	assert.equal(footingAhead([rim], { x: 100.5, y: LAVA_RIM_Y + 2, z: 100.5 }, 0)?.z, 140, 'already down at the rim: it walks on along it');
});

test('the search stays inside the caller\'s within and hands back FIND_NOT_FOUND at its edge (Codex on #79)', async () => {
	const body = bodyFor();
	const result = await searchFor({ structure: 'fortress' }, body, { within: 16, timeoutMs: 30_000 });
	const p = body.observation.player;
	assert.ok(Math.hypot(p.x - 100.5, p.z - 100.5) <= 16 + 1e-6, `ended ${Math.round(Math.hypot(p.x - 100.5, p.z - 100.5))} blocks out`);
	assert.equal(result.reasonCode, 'FIND_NOT_FOUND');
});

test('the last open ground and the digs since it are kept across find calls, so a re-asked search still goes back (Codex on #79)', async () => {
	const state = {};
	const travel = (args, n) => (n === 1 || args.retrace ? { result: arrived, go: true } : args.build ? { result: tunnel, go: true } : { result: noRoute });
	// Call 1: one walk on open ground, then one dig before its budget ends.
	const first = bodyFor({ travel, state });
	await searchFor({ structure: 'fortress' }, first, { timeoutMs: 64_000 });
	assert.equal(first.calls.filter((call) => call.build).length, 1);
	// Call 2 from the tunnel's end: one more blind dig, then back along the trail.
	const second = bodyFor({ travel: (args) => (args.retrace ? { result: arrived, go: true } : args.build ? { result: tunnel, go: true } : { result: noRoute }), state });
	Object.assign(second.observation.player, { x: first.observation.player.x, z: first.observation.player.z });
	await searchFor({ structure: 'fortress' }, second, { timeoutMs: 120_000 });
	const legs = second.calls.filter((call) => call.type === 'travel_to');
	const back = legs.findIndex((call) => call.retrace);
	assert.ok(back > 0, 'walks back to the kept open ground');
	assert.equal(legs.slice(0, back).filter((call) => call.build).length, MAX_DIGS - 1, 'after one more dig, not two');
});

test('a wounded body hands back before the opening climb, not after it (Codex on #79)', async () => {
	const body = bodyFor({ health: 6 });
	body.frontier = () => ({ candidates: [{ x: 100, y: 52, z: 70, dy: 12, distance: 30 }] });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(body.calls.filter((call) => call.type === 'travel_to').length, 0);
});

// Round 2 (22 Nov): the lava sea's rim, lava in the look, the opening look's heading, and brinks the walker reports.
const withEnv = async (value, run) => {
	const prior = process.env.MINEAGEN_FORTRESS_SEARCH;
	if (value === undefined) delete process.env.MINEAGEN_FORTRESS_SEARCH; else process.env.MINEAGEN_FORTRESS_SEARCH = value;
	try { return await run(); } finally { if (prior === undefined) delete process.env.MINEAGEN_FORTRESS_SEARCH; else process.env.MINEAGEN_FORTRESS_SEARCH = prior; }
};

test('groundOfView counts lava apart: a lava sea is no farthest dry ground', async () => {
	const { groundOfView } = await import('../src/native-tool-runtime.mjs');
	const row = (blockId, distance) => ({ compact: { blockId, distance } });
	// Sweep sections: entities, blocks, items, landmarks.
	const view = (rows) => ({ yaw: 0, sections: [[], [], [], rows] });
	assert.deepEqual(groundOfView(view([row('minecraft:netherrack', 20), row('minecraft:lava', 30), row('minecraft:lava', 70)])),
		{ yaw: 0, water: 0, land: 3, farthestLand: 70, lava: 2, farthestDry: 20 });
	assert.deepEqual(groundOfView(view([row('minecraft:netherrack', 20)])), { yaw: 0, water: 0, land: 1, farthestLand: 20 }, 'no lava: the fields as before');
});

test('viewHeading: the view with the most dry ground, to 45 degrees; never the lava sea; null with nothing open', () => {
	const views = [{ yaw: 3, water: 0, land: 20, farthestLand: 90, lava: 18, farthestDry: 30 }, { yaw: -88, water: 0, land: 12, farthestLand: 70 },
		{ yaw: 92, water: 0, land: 6, farthestLand: 40 }];
	assert.equal(viewHeading(views), -90);
	assert.equal(viewHeading([{ yaw: 0, land: 20, farthestLand: 90, lava: 20, farthestDry: 0 }]), null, 'all lava sea');
	assert.equal(viewHeading([{ yaw: 0, land: 3, farthestLand: OPEN_VIEW - 1 }]), null, 'walled in every way');
	assert.equal(viewHeading(undefined), null);
});

test('a new search keeps the heading its opening look showed most open and dry; r1 keeps the z rule', async () => {
	const ground = () => [{ yaw: 0, water: 0, land: 24, farthestLand: 96, lava: 22, farthestDry: 14 }, { yaw: -90, water: 0, land: 14, farthestLand: 60 }, { yaw: 90, water: 0, land: 4, farthestLand: 26 }];
	const seen = (o, calls) => (calls.length >= 1 ? { structures: [fortressRow] } : null);
	const body = bodyFor({ ground, onLook: seen });
	await withEnv(undefined, () => searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 }));
	assert.equal(body.calls[0].yaw, -90, 'across the dry caverns, not onto the lava sea');
	assert.equal(body.eyeSearchState.fortressHeading, -90, 'kept for the next call');
	const old = bodyFor({ ground, onLook: seen });
	await withEnv('r1', () => searchFor({ structure: 'fortress' }, old, { timeoutMs: 300_000 }));
	const target = searchRegions({ x: 100.5, z: 100.5 }, new Map(), 1, [{ x: 100, z: 100 }])[0].target;
	assert.equal(old.calls[0].yaw, startHeading({ x: 100.5, z: 100.5 }, target));
});

test('openView: a view mostly of lava sea is no open side; its far side counts only as far as dry ground', () => {
	const views = [{ yaw: 90, land: 20, farthestLand: 90, lava: 15, farthestDry: 40 }, { yaw: -90, land: 9, farthestLand: 50 }];
	assert.equal(openView(views, 0).yaw, 90, 'round 1 took the lava sea as the most open way');
	assert.equal(openView(views, 0, new Set(), { dry: true }).yaw, -90);
	assert.equal(openView([{ yaw: 90, land: 20, farthestLand: 90, lava: 4, farthestDry: 40 }], 0, new Set(), { dry: true }).farthestLand, 40);
	assert.equal(openView(views, 0, new Set(), { dry: true, skip: (yaw) => yaw === -90 }), null, 'a skipped way');
});

test('footingAhead: with rim on, ground at the lava sea rim is never the way on, even from the rim itself', () => {
	const here = { x: 0.5, y: 34, z: 0.5 };
	const rows = [{ x: 0, y: 34, z: 40 }, { x: 0, y: 40, z: 24 }];
	assert.equal(footingAhead(rows, here, 0).z, 40, 'round 1 walked the shore from the shore');
	assert.equal(footingAhead(rows, here, 0, [], { rim: true }).z, 24);
});

test('from the lava sea rim the search first climbs to the highest ground in reach, any way', async () => {
	const body = bodyFor({ state: { fortressHeading: 0 }, onLook: (o, calls) => (calls.length >= 1 ? { structures: [fortressRow] } : null) });
	body.observation.player.y = 34;
	body.frontier = () => ({ candidates: [{ x: 100, y: 34, z: 140, distance: 40 }, { x: 90, y: 44, z: 80, distance: 22 }, { x: 110, y: 41, z: 92, distance: 13 }, { x: 100, y: 60, z: 60, distance: 40 }] });
	const result = await withEnv(undefined, () => searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 }));
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual([body.calls[0].x, body.calls[0].y, body.calls[0].z], [90.5, 44, 80.5], 'the highest ground in reach 4 or more above the rim, behind the heading too, not a cliff 26 up');
	assert.equal(body.calls[0].build, false);
	const old = bodyFor({ state: { fortressHeading: 0 }, onLook: (o, calls) => (calls.length >= 1 ? { structures: [fortressRow] } : null) });
	old.observation.player.y = 34;
	old.frontier = body.frontier;
	await withEnv('r1', () => searchFor({ structure: 'fortress' }, old, { timeoutMs: 300_000 }));
	assert.equal(old.calls[0].z, 140.5, 'r1: on along the shore');
});

test('a build leg from the lava sea rim aims up off it', async () => {
	const body = bodyFor({ state: { fortressHeading: 0 }, travel: (args) => (args.build ? { result: arrived, go: true } : { result: noRoute }),
		onLook: (o, calls) => (calls.some((call) => call.build) ? { structures: [fortressRow] } : null) });
	body.observation.player.y = 33;
	await withEnv(undefined, () => searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 }));
	const build = body.calls.find((call) => call.build);
	assert.equal(build.y, LAVA_RIM_Y + 4);
});

test('brinkOf reads the walker footing fact; no walk sets off within 45 degrees of a reported drop from there', async () => {
	assert.deepEqual(brinkOf('No seen standing spot ahead gets closer; footing {"drop":35,"yaw":-61}', { x: 18.3, z: 55.8 }), { x: 18.3, z: 55.8, yaw: -61, drop: 35 });
	assert.equal(brinkOf('footing {"drop":2,"yaw":10}', { x: 0, z: 0 }), null, 'a step down is no brink');
	assert.equal(brinkOf('footing {"drop":4,"into":"lava","yaw":-85,"distance":1.1}', { x: 0, z: 0 }).into, 'lava');
	assert.equal(brinkOf('no footing fact', { x: 0, z: 0 }), null);
	assert.ok(BRINK_DROP > 3, 'past fall damage');
	assert.equal(towardBrink([{ x: 0, z: 0, yaw: -61 }], { x: 1, z: 1 }, -45), true);
	assert.equal(towardBrink([{ x: 0, z: 0, yaw: -61 }], { x: 1, z: 1 }, 0), false);
	assert.equal(towardBrink([{ x: 0, z: 0, yaw: -61 }], { x: 20, z: 1 }, -45), false, 'only from where it was seen');
	const ridge = { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer, and build is false; footing {"drop":35,"yaw":-45}' };
	const body = bodyFor({ state: { fortressHeading: 0 }, travel: (args) => (args.build ? { result: arrived, go: true } : { result: ridge }),
		onLook: (o, calls) => (calls.some((call) => call.build) ? { structures: [fortressRow] } : null) });
	await withEnv(undefined, () => searchFor({ structure: 'fortress' }, body, { timeoutMs: 300_000 }));
	assert.deepEqual(body.calls.slice(0, 3).map((call) => [call.build, call.yaw]), [[false, 0], [false, 45], [true, undefined]], 'the -45 walk toward the drop is skipped');
	const old = bodyFor({ state: { fortressHeading: 0 }, travel: (args) => (args.build ? { result: arrived, go: true } : { result: ridge }),
		onLook: (o, calls) => (calls.some((call) => call.build) ? { structures: [fortressRow] } : null) });
	await withEnv('r1', () => searchFor({ structure: 'fortress' }, old, { timeoutMs: 300_000 }));
	assert.equal(old.calls[2].yaw, -45, 'r1 walks it');
});
