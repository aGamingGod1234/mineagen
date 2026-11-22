import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';
import { checkedSearchBody } from './helpers/checked-body.mjs';

// K1 (issue #2): find's surface sweep. 1,358 of 1,662 NO_ROUTE results were its walk legs ({yaw, distance, build:false}):
// several doomed walks per spot, one build leg, then the blocked set cleared and the sweep started again. It also looked
// round after every leg, moved or not, searched under a roof for things seen only from the surface, and searched for
// blocks that never generate in the body's dimension.

/** A scripted body. travel(args, player) answers each travel_to; dig(args, player) each dig_to. */
function body({ player, dimension = 'minecraft:overworld', blocks = [], travel = () => ({ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }),
	dig = () => ({ result: { state: 'FAILED', reasonCode: 'NO_TOOL' } }), openSky = null } = {}) {
	let observation = { player: { yaw: 0, health: 20, ...player }, world: { dimension, biome: 'minecraft:plains' }, blocks,
		inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }, { itemId: 'minecraft:cobblestone', count: 64 }] } };
	let clock = 0;
	const calls = [];
	const cell = () => `${Math.floor(observation.player.x)},${Math.floor(observation.player.y)},${Math.floor(observation.player.z)}`;
	return checkedSearchBody({
		calls,
		now: () => clock,
		progress: () => {},
		observe: async () => structuredClone(observation),
		look: async () => { calls.push({ look: cell() }); clock += 2_000; return { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			calls.push({ actionType, args: structuredClone(args) });
			const step = (actionType === 'dig_to' ? dig : travel)(args, observation.player) ?? {};
			clock += step.ms ?? 3_000;
			if (step.player) observation = { ...observation, player: { ...observation.player, ...step.player } };
			return step.result ?? { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
		},
		frontier: () => ({ candidates: [], coverage: { headings: {} } }),
		known: () => null,
		places: async () => [],
		openSky: () => openSky,
	});
}

const noRoute = { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer, and build is false' };
const along = (from, args) => ({ x: from.x - Math.sin(args.yaw * Math.PI / 180) * args.distance, z: from.z + Math.cos(args.yaw * Math.PI / 180) * args.distance });

test('K1: a build leg that gets through builds on; no doomed walk legs between build legs, no repeat look from the same cell', async () => {
	// Ground no walk crosses (a ravine field): every walk is refused where it stands, every build leg gets its full distance.
	const fake = body({ player: { x: 0.5, y: 70, z: 0.5, skyOpen: true },
		travel: (args, player) => (args.build ? { player: along(player, args) } : { result: noRoute }) });
	const result = await searchFor({ structure: 'village' }, fake, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_BLOCKED', result.message);
	const legs = fake.calls.filter((call) => call.actionType === 'travel_to');
	const firstBuild = legs.findIndex((call) => call.args.build === true);
	const builds = legs.filter((call) => call.args.build === true);
	const spentAt = legs.findIndex((call, index) => index > firstBuild && builds.slice(0, legs.slice(0, index).filter((c) => c.args.build).length)
		.reduce((sum, c) => sum + c.args.distance, 0) >= 64);
	// Metric: build:false NO_ROUTE legs once building started and before the 64-block budget was spent. Pass bar: 0.
	const doomed = legs.slice(firstBuild, spentAt === -1 ? legs.length : spentAt).filter((call) => call.args.build === false).length;
	assert.equal(doomed, 0, `walk legs between build legs: ${legs.map((call) => (call.args.build ? 'B' : 'w')).join('')}`);
	assert.ok(builds.reduce((sum, call) => sum + call.args.distance, 0) <= 64, 'the construction budget holds');
	assert.ok(builds.every((call) => call.args.yaw === builds[0].args.yaw), 'building goes on along one heading');
	// Survey once per new cell: no look from the cell the previous look was taken in.
	const looks = fake.calls.filter((call) => call.look !== undefined).map((call) => call.look);
	assert.equal(looks.filter((cell, index) => index > 0 && cell === looks[index - 1]).length, 0, `looks: ${looks.join(' ')}`);
});

test('K1: a block that never generates in this dimension is refused at once, with the reason', async () => {
	const fake = body({ player: { x: 0.5, y: 70, z: 0.5 }, dimension: 'minecraft:the_nether' });
	const result = await searchFor({ block: 'minecraft:oak_log' }, fake);
	assert.equal(result.reasonCode, 'FIND_NOT_FOUND');
	assert.match(result.message, /^oak_log does not generate in the nether \(only in the overworld\), so no search here turns one up/);
	assert.equal(fake.calls.length, 0, 'no look and no leg');
	// Lava generates in the Nether; a block the game data does not place (a spawner) is never refused.
	for (const block of ['minecraft:lava', 'minecraft:spawner']) {
		const other = body({ player: { x: 0.5, y: 70, z: 0.5 }, dimension: 'minecraft:the_nether', travel: () => ({ result: noRoute }) });
		const outcome = await searchFor({ block }, other, { timeoutMs: 30_000 });
		assert.ok(other.calls.length > 0, `${block}: ${outcome.message}`);
	}
	// A dimension the game data does not know (a datapack's) refuses nothing.
	const modded = body({ player: { x: 0.5, y: 70, z: 0.5 }, dimension: 'example:mining', travel: () => ({ result: noRoute }) });
	await searchFor({ block: 'minecraft:oak_log' }, modded, { timeoutMs: 30_000 });
	assert.ok(modded.calls.length > 0, 'searched in an unknown dimension');
	// Water in the End, a log the caller also accepts: refused only when none of the ids can be here.
	assert.equal((await searchFor({ block: 'minecraft:water' }, body({ player: { x: 0.5, y: 70, z: 0.5 }, dimension: 'minecraft:the_end' }))).reasonCode, 'FIND_NOT_FOUND');
	const stems = body({ player: { x: 0.5, y: 70, z: 0.5 }, dimension: 'minecraft:the_nether', travel: () => ({ result: noRoute }) });
	await searchFor({ block: 'minecraft:oak_log', also: ['minecraft:crimson_stem'] }, stems, { timeoutMs: 30_000 });
	assert.ok(stems.calls.length > 0, 'a crimson stem can be here');
});

test('K1: a tree or animal search under a roof climbs out before the surface legs', async () => {
	for (const target of [{ block: 'minecraft:oak_log' }, { mob: 'minecraft:sheep' }]) {
		const fake = body({ player: { x: 0.5, y: 30, z: 0.5, skyOpen: false },
			dig: (args) => ({ player: { y: args.y, skyOpen: true }, result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' } }),
			travel: (args, player) => (args.build ? { player: along(player, args) } : { result: noRoute }) });
		await searchFor(target, fake, { timeoutMs: 60_000 });
		const moves = fake.calls.filter((call) => call.actionType);
		assert.deepEqual([moves[0].actionType, moves[0].args.pattern], ['dig_to', 'stairs_up'], `${JSON.stringify(target)}: ${JSON.stringify(moves[0])}`);
		assert.ok(moves.slice(1).some((call) => call.actionType === 'travel_to' && call.args.yaw !== undefined), 'then the surface legs');
		assert.equal(Object.hasOwn(moves[0].args, 'stopWhenSeen'), target.block !== undefined, 'a mob climb names no block to stop at');
	}
	// The way the body came first, when the runtime knows the open sky it left.
	const back = body({ player: { x: 0.5, y: 30, z: 0.5, skyOpen: false }, openSky: { x: 4.5, y: 68, z: 0.5 },
		travel: (args) => (args.retrace ? { player: { x: args.x, y: args.y, z: args.z, skyOpen: true } } : { result: noRoute }) });
	await searchFor({ mob: 'minecraft:cow' }, back, { timeoutMs: 30_000 });
	assert.equal(back.calls.find((call) => call.actionType).args.retrace, true);
	// Under leaves the sky is closed, but there is nothing to climb through: the surface legs at once.
	const leaves = body({ player: { x: 0.5, y: 70, z: 0.5, skyOpen: false }, blocks: [{ blockId: 'minecraft:oak_leaves', x: 0, y: 73, z: 0 }],
		travel: () => ({ result: noRoute }) });
	await searchFor({ mob: 'minecraft:sheep' }, leaves, { timeoutMs: 30_000 });
	assert.equal(leaves.calls.some((call) => call.actionType === 'dig_to'), false);
	// A climb that cannot rise hands back why, within the climb's own stall guard.
	const stuck = body({ player: { x: 0.5, y: 30, z: 0.5, skyOpen: false }, dig: () => ({ result: { state: 'FAILED', reasonCode: 'NO_ROUTE' } }) });
	const result = await searchFor({ block: 'minecraft:oak_log' }, stuck, { timeoutMs: 120_000 });
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.match(result.message, /Still under cover/);
	assert.equal(stuck.calls.filter((call) => call.actionType === 'travel_to').length, 0, 'no walk legs under the roof');
});

test('K1: a build leg that moved clears the headings ruled out at the spot before; each is tried again from the new spot', async () => {
	// No walk gets anywhere. The first build heading is walled at the start; the next build leg gets through, and from
	// there every heading is walled except the first one.
	let first = null, moved = false;
	const builds = [];
	const fake = body({ player: { x: 0.5, y: 70, z: 0.5, skyOpen: true }, travel: (args, player) => {
		if (!args.build) return { result: noRoute };
		builds.push({ yaw: args.yaw, after: moved });
		if (first === null) { first = args.yaw; return { result: noRoute }; }
		if (!moved || args.yaw === first) { moved = true; return { player: along(player, args) }; }
		return { result: noRoute };
	} });
	await searchFor({ structure: 'village' }, fake, { timeoutMs: 540_000 });
	assert.ok(builds.some((leg) => leg.after && leg.yaw === first), `build legs: ${JSON.stringify(builds)}`);
});

test('K1: blocks that structures or ocean floors also place in the Overworld or the End are not refused there', async () => {
	for (const [block, dimension] of [['minecraft:magma_block', 'minecraft:overworld'], ['minecraft:netherrack', 'minecraft:overworld'], ['minecraft:bedrock', 'minecraft:the_end']]) {
		const fake = body({ player: { x: 0.5, y: 70, z: 0.5 }, dimension, travel: () => ({ result: noRoute }) });
		const result = await searchFor({ block }, fake, { timeoutMs: 30_000 });
		assert.ok(fake.calls.length > 0, `${block} in ${dimension}: ${result.message}`);
	}
	// A block only the Nether places is still refused in the Overworld.
	assert.equal((await searchFor({ block: 'minecraft:crimson_nylium' }, body({ player: { x: 0.5, y: 70, z: 0.5 } }))).reasonCode, 'FIND_NOT_FOUND');
});
