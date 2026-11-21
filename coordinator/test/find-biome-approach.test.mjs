import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';

// A forest whose ground starts at z >= 85; the body starts in basalt deltas at the origin.
const FOREST_Z = 85;
const NETHERRACK = { itemId: 'minecraft:netherrack', count: 64 };

/**
 * A scripted Nether body: travel_to {yaw, distance} legs move the body along the yaw unless the leg is scripted to
 * fail (NO_ROUTE, no movement); the biome follows the position. walls: how many walking legs in a row fail before one
 * gets through; buildWorks: whether a building leg moves.
 */
function netherBody({ short = 0, sighted = null, dimension = 'minecraft:the_nether', looks = [], walls = () => false, buildWorks = true, known = null, danger = null, dangerCode = 'LAVA_AHEAD', items = [NETHERRACK] } = {}) {
	let at = { x: 0.5, y: 70, z: 0.5 }, clock = 0, walksTried = 0;
	const calls = [], missed = [];
	const biome = () => (at.z >= FOREST_Z ? 'minecraft:warped_forest' : dimension === 'minecraft:the_nether' ? 'minecraft:basalt_deltas' : 'minecraft:plains');
	const sample = () => ({ player: { ...at, yaw: 0, health: 20 }, world: { dimension, biome: biome() }, inventory: { items: structuredClone(items) }, ...(sighted && calls.length === 0 ? { sighted } : {}) });
	return {
		calls, missed,
		now: () => clock,
		progress: () => {},
		observe: async () => sample(),
		look: async () => { calls.push({ look: true }); clock += 2_000; return looks.shift() ?? { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			calls.push({ actionType, args });
			clock += 20_000;
			if (danger !== null && calls.filter((call) => call.actionType).length === danger) return { state: 'FAILED', reasonCode: dangerCode, message: `${dangerCode} at 0,69,40` };
			if (actionType !== 'travel_to' || !Number.isFinite(args.yaw)) return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
			const blocked = args.build ? !buildWorks : walls(walksTried++);
			if (blocked) return { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer, and build is false' };
			const rad = args.yaw * Math.PI / 180;
			// short: travel_to's arrival tolerance, the leg ends that many blocks before its distance.
			const go = Math.max(0, args.distance - short);
			at = { x: at.x - Math.sin(rad) * go, y: at.y, z: at.z + Math.cos(rad) * go };
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
		},
		frontier: () => null,
		known: () => known,
		places: async () => [],
		missedPlaces: () => missed,
		missPlace: (place, why) => missed.push({ ...place, why }),
	};
}
const seenForest = { state: 'SUCCEEDED', survey: { biomes: [{ biome: 'minecraft:warped_forest', x: 0, y: 70, z: 90 }] } };

test('a Nether forest seen across the deltas is walked into, not reported found from 90 blocks away', async () => {
	const body = netherBody({ looks: [seenForest] });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(result.find.seen.via, 'standing in it');
	assert.ok(body.calls.filter((call) => call.actionType === 'travel_to').every((call) => call.args.build === false), 'a clean route needs no building');
});

test('a walking leg the deltas stop (NO_ROUTE) is followed by a building leg toward the forest', async () => {
	const body = netherBody({ looks: [seenForest], walls: (n) => n === 0 });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const legs = body.calls.filter((call) => call.actionType === 'travel_to');
	assert.equal(legs[0].args.build, false);
	assert.equal(legs[1].args.build, true, 'the stopped walk is answered with a building leg on the same heading');
	assert.equal(legs[1].args.yaw, legs[0].args.yaw);
	assert.ok(legs[1].args.distance <= 16);
});

test('five approach legs in a row that gain nothing (straight, then turned 45 and 90 each way) hand back FIND_BLOCKED naming the forest and the distance left', async () => {
	const body = netherBody({ looks: [seenForest], walls: () => true, buildWorks: false });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.match(result.message, /warped_forest seen at 0,70,90/);
	assert.match(result.message, /5 approach legs in a row gained under 4 blocks; 90 blocks left/);
	const walks = body.calls.filter((call) => call.actionType === 'travel_to' && call.args.build === false).map((call) => call.args.yaw);
	assert.deepEqual(walks.map((yaw) => ((yaw - walks[0] + 540) % 360) - 180), [0, 45, -45, 90, -90]);
});

test('a forest remembered from an earlier trip is approached, and one failed leg does not lose it', async () => {
	const known = { sightings: [{ kind: 'biome', what: 'minecraft:warped_forest', x: 0, y: 70, z: 100 }] };
	const body = netherBody({ known, walls: (n) => n === 0 });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(result.find.seen.via, 'standing in it');
	assert.equal(body.missed.length, 0, 'the remembered forest stays a known place');
});

test('a remembered forest the approach cannot reach is marked missed and the search goes on', async () => {
	const known = { sightings: [{ kind: 'biome', what: 'minecraft:warped_forest', x: 0, y: 70, z: 100 }] };
	const body = netherBody({ known, walls: () => true, buildWorks: false });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.notEqual(result.reasonCode, 'FIND_SEEN');
	assert.equal(body.missed.length, 1);
	assert.equal(body.missed[0].why, 'approach stuck');
});

test('lava ahead of an approach leg is a blocked heading, not danger: the next leg turns and the forest is reached', async () => {
	const body = netherBody({ looks: [seenForest], danger: 1 });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(result.find.seen.via, 'standing in it');
});

test('other danger on an approach leg hands back FIND_DANGER (the settle rules stand)', async () => {
	const body = netherBody({ looks: [seenForest], danger: 1, dangerCode: 'IN_LAVA' });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.match(result.message, /IN_LAVA/);
});

test('an Overworld biome is still found on sight (no approach)', async () => {
	const body = netherBody({ dimension: 'minecraft:overworld', looks: [{ state: 'SUCCEEDED', survey: { biomes: [{ biome: 'minecraft:warped_forest', x: 0, y: 70, z: 90 }] } }] });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(result.find.seen.via, 'survey');
	assert.equal(body.calls.filter((call) => call.actionType === 'travel_to').length, 0);
});

test('a forest already in the first sample (sighted.biomes) is approached too: found means standing in it', async () => {
	const body = netherBody({ sighted: { biomes: [{ biome: 'minecraft:warped_forest', x: 0, y: 70, z: 90 }] } });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(result.find.seen.via, 'standing in it');
	assert.ok(body.calls.some((call) => call.actionType === 'travel_to'), 'the body walked in');
});

test('the approach keeps to the caller within: a forest beyond it is not walked to', async () => {
	const body = netherBody({ looks: [seenForest] });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000, within: 60 });
	assert.notEqual(result.reasonCode, 'FIND_SEEN');
	for (const call of body.calls.filter((entry) => entry.actionType === 'travel_to')) assert.ok(call.args.distance <= 60);
	assert.match(result.message, /beyond within 60|edge of within 60|Searched to 60/);
});

test('a fight on the way to a Nether forest does not end the approach on a far sighting of it', async () => {
	// The first approach leg stops for a zombie beside the body; the body is armed, so find fights it. Every sample still
	// shows the forest 90 blocks off: before, the fight leg's own sighting check handed that back as FIND_SEEN in the deltas.
	const body = netherBody({ looks: [seenForest], items: [NETHERRACK, { itemId: 'minecraft:iron_sword', count: 1 }] });
	const observe = body.observe, act = body.act;
	let stopped = false, zombie = true;
	body.observe = async () => {
		const sample = await observe();
		return { ...sample, sighted: { biomes: [{ biome: 'minecraft:warped_forest', x: 0, y: 70, z: 90 }] },
			entities: zombie ? [{ stableId: 'z1', type: 'minecraft:zombie', hostile: true, alive: true, x: sample.player.x + 2, y: sample.player.y, z: sample.player.z, distance: 2 }] : [] };
	};
	body.act = async (actionType, args) => {
		if (actionType === 'travel_to' && Number.isFinite(args.yaw) && !stopped) {
			stopped = true;
			body.calls.push({ actionType, args });
			return { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'minecraft:zombie z1 2.0 blocks away at 2,70,0, targeting you' };
		}
		if (actionType === 'fight_target') { zombie = false; body.calls.push({ actionType, args }); return { state: 'SUCCEEDED', reasonCode: 'TARGET_KILLED' }; }
		return act(actionType, args);
	};
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.ok(stopped, 'the zombie stopped the first approach leg');
	if (result.reasonCode === 'FIND_SEEN') assert.equal(result.find.seen.via, 'standing in it', `found only standing in the forest: ${result.message}`);
	assert.ok(body.calls.filter((call) => call.actionType === 'travel_to').length >= 2, 'the approach went on after the zombie');
});

test('a forest cell seen right at the biome edge is walked through, not given up 3 blocks short of it', async () => {
	// Travel stops 3 blocks before each leg's end (its arrival tolerance); the seen cell is the forest's first row (z 85).
	const edge = { state: 'SUCCEEDED', survey: { biomes: [{ biome: 'minecraft:warped_forest', x: 0, y: 70, z: FOREST_Z }] } };
	const body = netherBody({ looks: [edge], short: 3 });
	const result = await searchFor({ biome: 'minecraft:warped_forest' }, body, { timeoutMs: 540_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.equal(result.find.seen.via, 'standing in it');
	assert.ok(body.calls.some((call) => call.actionType === 'travel_to' && call.args.distance >= 7), 'one leg aimed past the edge cell');
});
