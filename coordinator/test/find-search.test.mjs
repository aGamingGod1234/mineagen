import test from 'node:test';
import assert from 'node:assert/strict';
import { DESCENT_RESERVE, stepRow, UNREACHED, UNREACHED_SPOT, chooseHeading, pickaxeUses, stairBudget, findProfile, oreRockShare, rememberedPlaces, sameVein, seenAtOf, sightingOf } from '../src/find-search.mjs';
import { normalizeMinecraftToolCall } from '../src/native-minecraft-tools.mjs';
import { isNativeBodyTool } from '../src/codex-service.mjs';
import { checkedSearchBody, searchFor } from './helpers/checked-body.mjs';

const sample = (extra = {}) => ({ player: { x: 0.5, y: 70, z: 0.5, yaw: 0, health: 20 }, world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' },
	inventory: { items: [{ itemId: 'minecraft:stone_sword', count: 1 }] }, ...extra });

/** A scripted body: each act answers from the script by action type and moves the body as told. */
function fakeBody({ start = sample(), acts = {}, looks = [], frontier = null, known = null, places = [] } = {}) {
	let observation = structuredClone(start), clock = 0;
	const calls = [];
	return checkedSearchBody({
		calls,
		now: () => clock,
		progress: () => {},
		observe: async () => structuredClone(observation),
		look: async ({ pitch, survey }) => { calls.push({ look: pitch, include: survey.include }); clock += 2_000; return looks.shift() ?? { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			calls.push({ actionType, args });
			const script = acts[actionType]?.shift() ?? { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } };
			clock += script.ms ?? 30_000;
			if (script.move) observation = { ...observation, player: { ...observation.player, ...script.move(observation.player, args) } };
			if (script.then) observation = { ...observation, ...script.then };
			return script.result;
		},
		frontier: () => frontier,
		known: () => known,
		places: async () => places,
	});
}

test('find normalizes as a do_step verb that holds the body until it ends', () => {
	const step = normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'lava' }, why: 'lava for the portal' });
	assert.deepEqual(step.arguments, { block: 'minecraft:lava', within: 512, timeoutMs: 540_000 });
	assert.equal(step.kind, 'find');
	assert.ok(isNativeBodyTool(step));
	assert.equal(normalizeMinecraftToolCall('do_step', { verb: 'find', target: { structure: 'Nether Fortress', within: 300 }, why: 'x' }).arguments.structure, 'nether fortress');
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'lava', mob: 'sheep' }, why: 'x' }), /exactly one/);
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'find', target: { block: 'lava', timeoutMs: 600_000 }, why: 'x' }));
	assert.throws(() => normalizeMinecraftToolCall('do_step', { verb: 'find', target: { mob: 'sheep' }, why: 'x', until: 'seen:sheep' }), /background verb/);
});

test('a profile knows the depth an underground block lives at and counts its deepslate form', () => {
	const iron = findProfile({ block: 'minecraft:iron_ore' });
	assert.equal(iron.depth, 16);
	assert.ok(iron.ids.has('minecraft:deepslate_iron_ore'));
	assert.equal(findProfile({ block: 'minecraft:lava' }).depth, -54);
	assert.equal(findProfile({ block: 'minecraft:oak_log' }).surface, true);
	assert.equal(findProfile({ block: 'minecraft:ancient_debris' }, 'minecraft:the_nether').depth, 15);
	assert.equal(findProfile({ block: 'minecraft:iron_ore' }, 'minecraft:the_nether').depth, null);
});

test('an overworld log below y 50 is no tree to walk to (a cave azalea or a mineshaft): seed 5 walked to one at y33 and never climbed out', () => {
	const logs = findProfile({ block: 'minecraft:acacia_log', also: ['minecraft:oak_log'] });
	assert.equal(sightingOf(logs, sample(), { blocks: [{ blockId: 'minecraft:oak_log', x: 149, y: 33, z: 165 }] }), null);
	assert.equal(sightingOf(logs, sample({ blocks: [{ blockId: 'minecraft:oak_log', x: 3, y: 40, z: 0 }] })), null);
	assert.equal(sightingOf(logs, sample(), { blocks: [{ blockId: 'minecraft:oak_log', x: 30, y: 64, z: 0 }] }).id, 'minecraft:oak_log');
	assert.equal(sightingOf(logs, sample({ blocks: [{ blockId: 'minecraft:acacia_log', x: 3, y: 50, z: 0 }] })).via, 'sight');
	// A body already down in a cave: a log at its own level is its way to planks (review of #314).
	assert.equal(sightingOf(logs, sample({ player: { x: 0.5, y: 34, z: 0.5, yaw: 0, health: 20 }, blocks: [{ blockId: 'minecraft:oak_log', x: 3, y: 33, z: 0 }] })).via, 'sight');
	assert.equal(sightingOf(logs, sample({ player: { x: 0.5, y: 45, z: 0.5, yaw: 0, health: 20 } }), { blocks: [{ blockId: 'minecraft:oak_log', x: 20, y: 33, z: 0 }] }), null);
	assert.equal(sightingOf(findProfile({ block: 'minecraft:lava' }), sample(), { blocks: [{ blockId: 'minecraft:lava', x: 40, y: 20, z: 0 }] }).id, 'minecraft:lava');
	assert.equal(sightingOf(findProfile({ block: 'minecraft:crimson_stem' }, 'minecraft:the_nether'), sample({ world: { dimension: 'minecraft:the_nether' } }), { blocks: [{ blockId: 'minecraft:crimson_stem', x: 10, y: 35, z: 0 }] }).id, 'minecraft:crimson_stem');
});

test('sightings come from the sample, its passive far sightings and a survey; remembered rows are not sightings', () => {
	const lava = findProfile({ block: 'minecraft:lava' });
	assert.equal(sightingOf(lava, sample({ blocks: [{ blockId: 'minecraft:lava', x: 3, y: 68, z: 0 }] })).via, 'sight');
	assert.equal(sightingOf(lava, sample({ blocks: [{ blockId: 'minecraft:lava', x: 3, y: 68, z: 0 }], continuity: { rememberedSections: ['blocks'] } })), null);
	assert.deepEqual(sightingOf(lava, sample(), { blocks: [{ blockId: 'minecraft:lava', x: 40, y: 60, z: 0, count: 20 }] }), { x: 40, y: 60, z: 0, id: 'minecraft:lava', via: 'survey', distance: 41 });
	// A far row of flowing lava only (a fall with its source out of sight) is no sighting: build casts from a source.
	assert.equal(sightingOf(lava, sample(), { blocks: [{ blockId: 'minecraft:lava', x: 12, y: 60, z: 0, flowing: true }] }), null);
	assert.equal(sightingOf(lava, sample({ sighted: { blocks: [{ blockId: 'minecraft:lava', x: 12, y: 60, z: 0, flowing: true }] } })), null);
	const sheep = findProfile({ mob: 'sheep' });
	assert.equal(sightingOf(sheep, sample({ entities: [{ type: 'minecraft:sheep', x: 10, y: 70, z: 0 }] })).distance, 10);
	assert.equal(sightingOf(sheep, sample({ entities: [{ type: 'minecraft:sheep', x: 10, y: 70, z: 0, perceivedBy: 'sound' }] })), null);
	const village = findProfile({ structure: 'village' });
	assert.equal(sightingOf(village, sample({ sighted: { structures: [{ structure: 'village', x: 100, y: 70, z: 0 }] } })).id, 'village');
	assert.equal(sightingOf(village, sample(), { poi: [{ blockId: 'minecraft:bell', x: 20, y: 70, z: 0 }] }).id, 'village');
	const fortress = findProfile({ structure: 'fortress' });
	assert.equal(sightingOf(fortress, sample({ sighted: { structures: [{ structure: 'nether fortress', x: 100, y: 70, z: 0 }] } })).id, 'nether fortress');
	const forest = findProfile({ biome: 'warped_forest' });
	assert.equal(sightingOf(forest, sample({ world: { biome: 'minecraft:warped_forest' } })).via, 'standing in it');
	assert.equal(sightingOf(forest, sample(), { biomes: [{ biome: 'minecraft:warped_forest', x: 60, y: 70, z: 0 }] }).distance, 60);
	assert.deepEqual(seenAtOf('minecraft:lava seen at 12,-55,40, 9 blocks away'), { x: 12, y: -55, z: 40 });
});

test('remembered places come nearest first, from sightings, blocks and the places the model kept', () => {
	const rows = rememberedPlaces(findProfile({ block: 'lava' }), { sightings: [{ kind: 'lava', what: 'minecraft:lava', x: 100, y: 10, z: 0 }, { kind: 'vein', what: 'minecraft:iron_ore', x: 5, y: 10, z: 0 }], blocks: [] },
		[{ key: 'lava-pool', label: 'Lava pool by the ravine', summary: 'x', position: { x: 30, y: -40, z: 0 } }], { x: 0, y: 70, z: 0 });
	assert.deepEqual(rows.map((row) => row.via), ['your place lava-pool', 'remembered sighting']);
});

test('a heading continues while it is set, else the least covered', () => {
	assert.equal(chooseHeading({ N: [100, 200], NE: [10, 10], E: [0, 0], SE: [5, 5], S: [0, 20], SW: [9, 9], W: [50, 50], NW: [70, 70] }), -90);
	assert.equal(chooseHeading({ N: [100, 200] }, 180), 180);
	assert.equal(chooseHeading({ S: [0, 0] }, null, new Set(['S'])) !== 0, true);
});

test('find stops at a sighting in the first look around without moving', async () => {
	const body = fakeBody({ looks: [{ state: 'SUCCEEDED', survey: { blocks: [{ blockId: 'minecraft:lava', x: 40, y: 64, z: 3 }] } }] });
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual([result.find.seen.x, result.find.seen.y, result.find.seen.z], [40, 64, 3]);
	assert.equal(body.calls.filter((call) => call.actionType).length, 0);
});

test('an underground target digs to its depth, then tunnels straight legs until the dig sees it', async () => {
	const body = fakeBody({
		frontier: { candidates: [], coverage: { headings: { N: [50, 50], E: [0, 0] } } },
		acts: {
			dig_to: [
				{ move: (player, args) => ({ y: args.y }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' }, ms: 120_000 },
				{ move: (player) => ({ x: player.x - 32 }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -40,15,6, 7 blocks away' } },
			],
		},
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual([result.find.seen.x, result.find.seen.y, result.find.seen.z], [-40, 15, 6]);
	const digs = body.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args);
	assert.equal(digs[0].y, 16);
	assert.equal(digs[0].stopWhenSeen, 'minecraft:iron_ore');
	assert.equal(digs[1].pattern, 'tunnel');
	assert.equal(digs[1].heading, digs[2].heading, 'a leg that went its full length keeps the heading: straight, no wandering');
});

test('a surface target takes the high ground in sight, then walks straight legs and looks after each', async () => {
	const body = fakeBody({
		frontier: { candidates: [{ x: 10, y: 80, z: 10, dy: 10, distance: 14 }, { x: 5, y: 72, z: 0, dy: 2, distance: 5 }], coverage: { headings: { S: [0, 0], N: [80, 80] } } },
		acts: { travel_to: [
			{ move: () => ({ x: 10.5, y: 80, z: 10.5 }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } },
			{ move: (player) => ({ z: player.z + 80 }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } },
		] },
		looks: [{ survey: {} }, { survey: {} }, { survey: { structures: [{ structure: 'village', x: 20, y: 70, z: 150 }] } }],
	});
	const result = await searchFor({ structure: 'village' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const travels = body.calls.filter((call) => call.actionType === 'travel_to').map((call) => call.args);
	assert.equal(travels[0].y, 80, 'the high ground first');
	assert.equal(travels[0].build, false, 'walked to, never dug to (scripted gate seed 3: NO_TOOL there ended the search)');
	assert.equal(travels[1].yaw, 0, 'then the least covered heading (south)');
	assert.equal(travels.some((args) => args.fightThrough !== undefined), false, 'travel legs never fight through on their own (review P1 2)');
});

test('water-5 fixture: a leg left in water with no bank in sight walks back out the way it came before another heading', async () => {
	const stuck = { result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'In water with no bank seen within 10 blocks, and the way toward the target leaves the water over a drop' },
		move: (player) => ({ x: player.x + 30, inWater: true }) };
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [stuck, { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: 0.5, z: 0.5, inWater: false }) },
			{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player) => ({ z: player.z + 80 }) }] },
		// Back at the start's cell the view is the one the first look took: no second look there (K1). The walk's look sees it.
		looks: [{ survey: {} }, { survey: { blocks: [{ blockId: 'minecraft:oak_log', x: 3, y: 70, z: 90 }] } }] });
	const result = await searchFor({ block: 'minecraft:oak_log' }, body);
	const travels = body.calls.filter((call) => call.actionType === 'travel_to').map((call) => call.args);
	assert.equal(travels[1].retrace, true, JSON.stringify(travels));
	assert.deepEqual([travels[1].x, travels[1].z], [0.5, 0.5], 'back to the start, the last dry spot');
	assert.notEqual(travels[2].yaw, travels[0].yaw, 'then another heading');
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
});

test('danger the search cannot work round hands back with what it covered', async () => {
	const body = fakeBody({
		start: sample({ inventory: { items: [] } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [{ move: (player) => ({ z: player.z + 30 }), result: { state: 'SUCCEEDED', reasonCode: 'HOSTILE_NEAR', message: 'zombie 5 blocks away' } }] },
	});
	const result = await searchFor({ mob: 'sheep' }, body);
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(result.find.covered.walked, 30);
	assert.match(result.message, /sheep not seen/);
});

test('the budget ends the search with the ground it covered', async () => {
	const travel = Array.from({ length: 40 }, () => ({ move: (player, args) => ({ x: player.x - Math.sin(args.yaw * Math.PI / 180) * 80, z: player.z + Math.cos(args.yaw * Math.PI / 180) * 80 }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, ms: 40_000 }));
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, acts: { travel_to: travel } });
	const result = await searchFor({ mob: 'sheep' }, body, { timeoutMs: 200_000, within: 2048 });
	assert.equal(result.reasonCode, 'FIND_BUDGET');
	assert.equal(result.find.covered.walked, result.find.covered.fromStart, 'straight legs: every block walked is new ground');
});

test('a body that cannot dig hands back blocked, and a search that reaches within hands back not found', async () => {
	const noPick = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, acts: { dig_to: [{ result: { state: 'FAILED', reasonCode: 'NO_TOOL', message: 'no pickaxe' } }] } });
	const blocked = await searchFor({ block: 'minecraft:iron_ore' }, noPick);
	assert.equal(blocked.reasonCode, 'FIND_BLOCKED');
	const travel = Array.from({ length: 40 }, () => ({ move: (player, args) => ({ x: player.x - Math.sin(args.yaw * Math.PI / 180) * args.distance, z: player.z + Math.cos(args.yaw * Math.PI / 180) * args.distance }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }));
	const near = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, acts: { travel_to: travel } });
	const result = await searchFor({ mob: 'minecraft:sheep' }, near, { within: 100 });
	assert.equal(result.reasonCode, 'FIND_NOT_FOUND');
	assert.ok(result.find.covered.fromStart <= 100);
});

test('lava heard behind a block the dig will not break is opened from two cells back, then the body steps out of its flow', async () => {
	const body = fakeBody({
		start: sample({ player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20 } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [{ result: { state: 'FAILED', reasonCode: 'LAVA_AHEAD', message: 'Stopped: Lava is heard beside this block, about 2 block(s) away; not breaking minecraft:tuff at 0,-54,1; pool coordinates not seen' } }],
			move_to: [{ move: (player, args) => ({ x: args.x, z: args.z }), result: { state: 'SUCCEEDED' } }, { move: (player, args) => ({ x: args.x, z: args.z }), result: { state: 'SUCCEEDED' } }],
			break_block: [{ result: { state: 'SUCCEEDED', message: 'lava now open' }, then: { blocks: [{ blockId: 'minecraft:lava', x: 0, y: -54, z: 2 }] } }],
		},
	});
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const moves = body.calls.filter((call) => call.actionType === 'move_to').map((call) => call.args.z);
	assert.deepEqual(moves, [-1.5, -3.5], 'two cells back to open it, two more out of its flow');
	assert.equal(body.calls.find((call) => call.actionType === 'break_block').args.acceptLavaRisk, true);
	assert.equal(body.calls.find((call) => call.actionType === 'move_to').args.timeoutMs, undefined, 'move_to takes no timeoutMs');
});

test('lava heard beside a refused block that one peek does not show: the tunnel keeps its heading and opens the next cell toward it', async () => {
	const refuse = (z) => ({ result: { state: 'FAILED', reasonCode: 'LAVA_AHEAD', message: `Stopped: Lava is heard beside this block, about 2 block(s) away; not breaking minecraft:tuff at 0,-54,${z}; pool coordinates not seen` } });
	const step = { move: (player, args) => ({ x: args.x, z: args.z }), result: { state: 'SUCCEEDED' } };
	const play = (opened = 'opened, lava still heard') => fakeBody({
		start: sample({ player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20 } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [refuse(1), { move: () => ({ z: 1.5 }), ...refuse(2) }, { result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED' } }],
			move_to: [step, step, step, step],
			break_block: [{ result: { state: 'SUCCEEDED', message: opened } },
				{ result: { state: 'SUCCEEDED', message: 'lava now open' }, then: { blocks: [{ blockId: 'minecraft:lava', x: 0, y: -55, z: 2 }] } }],
		},
	});
	const body = play();
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const tunnels = body.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args.heading);
	assert.deepEqual(tunnels, ['south', 'south'], 'the second leg goes on toward the sound');
	assert.equal(body.calls.filter((call) => call.actionType === 'break_block').length, 2);
	// The peek opened onto lava it does not count (flowing): it flows into the cell, so the tunnel turns rather than walk in.
	const flowing = play('Broken; lava now open beside the opening at 1,-54,1; it flows in after about 1.5 s');
	await searchFor({ block: 'minecraft:lava' }, flowing);
	assert.notEqual(flowing.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args.heading)[1], 'south', 'lava now open: no walk back in');
	const saved = process.env.MINEAGEN_LAVA_OPEN;
	process.env.MINEAGEN_LAVA_OPEN = 'off';
	try {
		const off = play();
		await searchFor({ block: 'minecraft:lava' }, off);
		const headings = off.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args.heading);
		assert.notEqual(headings[1], 'south', 'off: the old turn after the peek');
	} finally {
		if (saved === undefined) delete process.env.MINEAGEN_LAVA_OPEN; else process.env.MINEAGEN_LAVA_OPEN = saved;
	}
});

test('a lava search below its tunnel level (steep_down lands a block low) climbs one stair before the tunnel, so pools are met from above', async () => {
	const body = fakeBody({
		start: sample({ player: { x: 0.5, y: -55, z: 0.5, yaw: 0, health: 20 } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [{ move: () => ({ y: -54 }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 0,-55,9, 9 blocks away' } }],
		},
	});
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const digs = body.calls.filter((call) => call.actionType === 'dig_to').map((call) => `${call.args.pattern}${call.args.y === undefined ? '' : ` y${call.args.y}`}`);
	assert.deepEqual(digs, ['stairs_up y-54', 'tunnel']);
});

test('a tunnel stopped at flowing lava (a fall it plugged) is no sighting; one stopped at a source pool is', async () => {
	const start = sample({ player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20 } });
	const fall = fakeBody({
		start,
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [{ result: { state: 'FAILED', reasonCode: 'LAVA_AHEAD', message: 'Lava at 0,-54,8 (flowing, not a pool) beside the opened cell 0,-54,7; plugged with minecraft:cobblestone' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 9,-55,0, 9 blocks away' } }],
		},
	});
	const found = await searchFor({ block: 'minecraft:lava' }, fall);
	assert.equal(found.reasonCode, 'FIND_SEEN');
	assert.match(found.message, /9,-55,0/, 'the source seen later, not the plugged fall');
	assert.equal(fall.calls.filter((call) => call.actionType === 'dig_to').length, 2, 'dug on after the fall');
	const pool = fakeBody({
		start,
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ result: { state: 'FAILED', reasonCode: 'LAVA_AHEAD', message: 'Lava at 0,-55,8 beside the opened cell 0,-54,8; target pool found; left for casting' } }] },
	});
	const seen = await searchFor({ block: 'minecraft:lava' }, pool);
	assert.equal(seen.reasonCode, 'FIND_SEEN');
	assert.match(seen.message, /0,-55,8/);
});

test('script-first r1 seed 5: lava seen only as a spill is walked to, and the walk reports the source it sees', async () => {
	const start = sample({ player: { x: 0.5, y: -44, z: 0.5, yaw: 0, health: 20 } });
	const spill = { state: 'SUCCEEDED', survey: { blocks: [{ blockId: 'minecraft:lava', x: 5, y: -45, z: 11, flowing: true }] } };
	const missed = [];
	const body = { ...fakeBody({ start, looks: [spill], frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 4,-45,11, 9 blocks away' } }] } }),
	missedPlaces: () => missed, missPlace: (place, why) => missed.push({ ...place, why }) };
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual([result.find.seen.x, result.find.seen.y, result.find.seen.z], [4, -45, 11], 'the source, not the spill');
	const walk = body.calls.find((call) => call.actionType === 'travel_to').args;
	assert.equal(walk.stopWhenSeen, 'minecraft:lava');
	assert.deepEqual([walk.x, walk.z], [5.5, 11.5]);
	assert.equal(missed.length, 0);
});

test('a spill that shows no source is not walked to again, this search or the next, and the search goes on', async () => {
	const start = sample({ player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20 } });
	const spill = () => ({ state: 'SUCCEEDED', survey: { blocks: [{ blockId: 'minecraft:lava', x: 5, y: -54, z: 11, flowing: true }] } });
	const missed = [];
	const run = (looks) => {
		const body = { ...fakeBody({ start, looks, frontier: { candidates: [], coverage: { headings: {} } },
			acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 9,-55,0, 9 blocks away' } }] } }),
		missedPlaces: () => missed, missPlace: (place, why) => missed.push({ ...place, why }) };
		return { body, done: searchFor({ block: 'minecraft:lava' }, body) };
	};
	const first = run([spill(), spill()]);
	assert.equal((await first.done).reasonCode, 'FIND_SEEN');
	assert.equal(first.body.calls.filter((call) => call.actionType === 'travel_to').length, 1, 'walked to the spill once, though the look there saw it again');
	assert.equal(first.body.calls.filter((call) => call.actionType === 'dig_to').length, 1, 'then searched on');
	assert.deepEqual(missed.map(({ x, y, z, why }) => [x, y, z, why]), [[5, -54, 11, 'no source seen']]);
	const second = run([spill()]);
	assert.equal((await second.done).reasonCode, 'FIND_SEEN');
	assert.equal(second.body.calls.filter((call) => call.actionType === 'travel_to').length, 0);
});

test('script-first r4 seed 1: a lava pocket too small for the cast is no sighting, is kept as spent, and the search goes on', async () => {
	const profile = findProfile({ block: 'minecraft:lava' });
	const pocket = { blockId: 'minecraft:lava', x: 3, y: -55, z: 1, state: { level: '0' }, small: true };
	assert.equal(sightingOf(profile, sample({ player: { x: 0.5, y: -54, z: 0.5 }, blocks: [pocket] })), null, 'a near pocket');
	assert.equal(sightingOf(profile, sample({ player: { x: 0.5, y: -54, z: 0.5 } }), { blocks: [{ ...pocket, state: undefined }] }), null, 'a surveyed pocket');
	const start = sample({ player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20 } });
	const missed = [];
	const run = (looks) => {
		const body = { ...fakeBody({ start, looks, frontier: { candidates: [], coverage: { headings: {} } },
			acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 9,-57,0, 9 blocks away' } }] } }),
		missedPlaces: () => missed, missPlace: (place, why) => missed.push({ ...place, why }) };
		return { body, done: searchFor({ block: 'minecraft:lava' }, body) };
	};
	const first = run([{ state: 'SUCCEEDED', survey: { blocks: [{ blockId: 'minecraft:lava', x: 4, y: -55, z: 3, small: true }] } }]);
	const result = await first.done;
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual([result.find.seen.x, result.find.seen.y], [9, -57], 'the pool past the pocket');
	assert.deepEqual(missed.map(({ x, y, z, why }) => [x, y, z, why]), [[4, -55, 3, 'pocket too small to cast']]);
	assert.equal((await run([{ state: 'SUCCEEDED', survey: { blocks: [{ blockId: 'minecraft:lava', x: 4, y: -55, z: 3, small: true }] } }]).done).reasonCode, 'FIND_SEEN');
	assert.equal(missed.length, 1, 'a pocket already spent is not recorded again');
});

test('a danger stop on the walk to a spill hands back with no body action after it', async () => {
	const start = sample({ player: { x: 0.5, y: -44, z: 0.5, yaw: 0, health: 20 } });
	const body = fakeBody({ start, looks: [{ state: 'SUCCEEDED', survey: { blocks: [{ blockId: 'minecraft:lava', x: 5, y: -45, z: 11, flowing: true }] } }],
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [{ result: { state: 'FAILED', reasonCode: 'LAVA_INCOMING', message: 'Seen lava was flowing into 4,-44,9' } }] } });
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_DANGER');
	const acts = body.calls.filter((call) => call.actionType);
	assert.deepEqual(acts.map((call) => call.actionType), ['travel_to'], 'the walk was the last body action');
	assert.equal(body.calls.filter((call) => call.look !== undefined).length, 1, 'no look after the hand-back');
});

test('a hostile the body cannot reach stops the dig: it steps 8 blocks out of its sight and digs on from there', async () => {
	const body = fakeBody({
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [
				{ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:zombie 4309 at 0,50,-6, 11 blocks away. At 0,59,0' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,30,9, 6 blocks away' } },
			],
			travel_to: [{ move: (player, args) => ({ z: player.z + args.distance }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }],
		},
		start: sample({ entities: [{ type: 'minecraft:zombie', hostile: true, stableId: 'z', x: 0.5, y: 50, z: -5.5 }] }),
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const away = body.calls.find((call) => call.actionType === 'travel_to').args;
	assert.equal(away.yaw, 0, 'south: straight away from the zombie to the north');
	assert.equal(away.distance, 8);
	assert.equal(body.calls.some((call) => call.actionType === 'fight_target'), false, 'a zombie 9 blocks below is not fought');
});

test('a cave the dig passed near the target depth is looked into before any tunnel', async () => {
	const body = fakeBody({
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [{ move: (player, args) => ({ y: args.y }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED', message: 'Reached y16. At 0,16,0; dug past caves at 3,23,-8 (y23), 0,60,0 (y60)' } }],
			travel_to: [{ move: () => ({ x: 3.5, y: 23, z: -7.5 }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }],
		},
		looks: [{ survey: {} }, { survey: {} }, { survey: { veins: [{ blockId: 'minecraft:iron_ore', x: 9, y: 25, z: -12, visible: 3 }] } }],
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual(body.calls.find((call) => call.actionType === 'travel_to').args.y, 23, 'the y23 cave, not the y60 one (outside the band)');
	assert.equal(body.calls.filter((call) => call.args?.pattern === 'tunnel').length, 0);
});

test('underground with blocks to spare, the body walls off the cave and digs on away from the mob instead of walking into it', async () => {
	const body = fakeBody({
		start: sample({ inventory: { items: [{ itemId: 'minecraft:stone_sword', count: 1 }, { itemId: 'minecraft:cobblestone', count: 20 }] } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [
				{ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:skeleton 86ef at 0,50,-6, 10 blocks away. At 0,59,0' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,30,9, 6 blocks away' } },
			],
			build_shelter: [{ result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } }],
		},
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const shelter = body.calls.find((call) => call.actionType === 'build_shelter').args;
	assert.deepEqual([shelter.x, shelter.y, shelter.z, shelter.opening, shelter.itemId, shelter.roof], [0, 70, 0, 'south', 'minecraft:cobblestone', true]);
	assert.equal(body.calls.some((call) => call.actionType === 'travel_to'), false);
	const after = body.calls.filter((call) => call.actionType === 'dig_to')[1].args;
	assert.deepEqual([after.pattern, after.heading, after.maxBlocks], ['tunnel', 'south', 24], 'a level tunnel away from the skeleton before digging down again');
});

test('a surface search with every heading blocked from here hands back blocked with the reason, not "not found"', async () => {
	const stuck = Array.from({ length: 16 }, () => ({ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'minecraft:stone takes 7.5 s per block' } }));
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, acts: { travel_to: stuck } });
	const result = await searchFor({ structure: 'village' }, body);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	const builds = body.calls.filter((call) => call.actionType === 'travel_to').map((call) => call.args.build);
	assert.deepEqual([builds.slice(0, 8).every((build) => build === false), builds.slice(8).every((build) => build === true), builds.length], [true, true, 16],
		'walking legs first (round hills, not through them); building legs only once walking has no way on');
	assert.match(result.message, /8 heading\(s\) blocked \(last: NO_ROUTE: minecraft:stone takes 7.5 s per block\)/);
});

test('a surface search walled in by stone tunnels short legs and hands back blocked once its building budget is spent', async () => {
	let building = false;
	const leg = {
		ms: 3_000,
		get result() { return building ? { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } : { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer, and build is false' }; },
		move: (player, args) => {
			building = args.build;
			const step = args.build ? args.distance : 0;
			return { x: player.x - Math.sin(args.yaw * Math.PI / 180) * step, z: player.z + Math.cos(args.yaw * Math.PI / 180) * step };
		},
	};
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 15, z: 0.5, yaw: 0, health: 20, skyOpen: false } }),
		frontier: { candidates: [], coverage: { headings: {} } }, acts: { travel_to: { shift: () => leg } } });
	const result = await searchFor({ block: 'minecraft:sand' }, body);
	const builds = body.calls.filter((call) => call.actionType === 'travel_to' && call.args.build === true).map((call) => call.args.distance);
	assert.ok(builds.length > 0 && builds.every((distance) => distance <= 16), `short building legs, not 80-block bores: ${builds}`);
	assert.ok(builds.reduce((sum, distance) => sum + distance, 0) <= 64, `at most 64 blocks of building in one search: ${builds}`);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.match(result.message, /building legs already covered 64 of 64 blocks this search, so no more digging blind/);
});

const noRoute = () => ({ ms: 3_000, result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer, and build is false' } });
const covered = (y, extra = {}) => sample({ player: { x: 611.5, y, z: 86.5, yaw: 0, health: 20, skyOpen: false, ...extra } });
test('b4 laptop seed 5: gravel sought from under cover tunnels at the body\'s own level and stops at the first sight, no 80-block walks', async () => {
	const body = fakeBody({ start: covered(10), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: Array.from({ length: 40 }, noRoute), dig_to: [
			{ move: (player) => ({ x: player.x + 16 }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED', message: '32 blocks mined in 16 steps over 38 s (y10 to y10); mined stone 30, diorite 2' } },
			{ move: (player) => ({ x: player.x + 4 }), result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:gravel seen at 632,11,90, 4 blocks away' } }] } });
	const result = await searchFor({ block: 'minecraft:gravel' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.deepEqual([result.find.seen.x, result.find.seen.y, result.find.seen.z], [632, 11, 90]);
	assert.equal(body.calls.filter((call) => call.actionType === 'travel_to').length, 0, 'no walk legs from inside the rock');
	const digs = body.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args);
	assert.deepEqual(digs.map((dig) => [dig.pattern, dig.stopWhenSeen]), [['tunnel', 'minecraft:gravel'], ['tunnel', 'minecraft:gravel']], 'level tunnel legs, no dig down or up');
	assert.equal(body.calls.findIndex((call) => call.actionType === 'dig_to'), 1, 'one look round where it starts, not a second before the first tunnel');
	// Under the open sky, gravel keeps its walk legs (a river bed or beach is seen from the surface).
	const open = fakeBody({ start: covered(64, { skyOpen: true }), frontier: { candidates: [], coverage: { headings: {} } }, acts: { travel_to: Array.from({ length: 40 }, noRoute) } });
	await searchFor({ block: 'minecraft:gravel' }, open);
	assert.deepEqual([open.calls.find((call) => call.actionType)?.actionType, open.calls.find((call) => call.actionType)?.args.distance], ['travel_to', 80]);
	assert.equal(open.calls.filter((call) => call.actionType === 'dig_to').length, 0);
});

test('gravel not in the rock within three tunnel legs: out to the open sky the body came from, then the surface legs', async () => {
	const body = fakeBody({ start: covered(15), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: Array.from({ length: 6 }, () => ({ move: (player) => ({ x: player.x + 16 }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED' } })),
			travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: 600.5, y: 70, z: 80.5, skyOpen: true }) },
				{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:gravel seen at 560,64,80, 5 blocks away' }, move: (player) => ({ x: player.x - 40 }) }] } });
	body.openSky = () => ({ x: 600.5, y: 70, z: 80.5 });
	const result = await searchFor({ block: 'minecraft:gravel' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const actions = body.calls.filter((call) => call.actionType).map((call) => call.actionType === 'dig_to' ? call.args.pattern : call.args.retrace ? 'retrace' : `walk ${call.args.distance}`);
	assert.deepEqual(actions, ['tunnel', 'tunnel', 'tunnel', 'retrace', 'walk 80'], 'at most three tunnel legs (96 blocks of pickaxe wear), then up and the surface legs');
});

test('digs that go nowhere move the body off the spot, and a spot it cannot leave hands back blocked instead of looping', async () => {
	const wet = Array.from({ length: 40 }, () => ({ result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'water on 3 sides' }, ms: 1_000 }));
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, acts: { dig_to: wet, travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE' } }, { result: { state: 'FAILED', reasonCode: 'NO_ROUTE' } }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.match(result.message, /No way on from here: water under this spot stops every dig down, and the move off this spot stopped too \(NO_ROUTE\)/);
	assert.equal(body.calls.filter((call) => call.actionType === 'travel_to').length, 2, 'the walk off the water and the move off the spot, both going nowhere');
	assert.deepEqual(body.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args.pattern), ['steep_down', 'tunnel'],
		'one dig down, a walk off the water and a tunnel sideways that both went nowhere, then the move off');
});

const pillarFailed = (left) => ({ result: { state: 'FAILED', reasonCode: 'BUILD_FAILED',
	message: `No seen way on toward the target, and building cannot continue: Could not pillar up at -9,45,-45; at -8.5,45.0,-44.3; ${left} blocks left to the target` } });
const seedOneBody = ({ waterX, tunnel }) => fakeBody({
	start: sample({ player: { x: -8.5, y: 51, z: -41.5, yaw: 180, health: 20, skyOpen: false } }),
	frontier: { candidates: [], coverage: { headings: {} } },
	acts: {
		dig_to: [
			{ result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: Water at -9,45,-47 beside the opened cell -9,45,-46; water on 3 sides of it: a body of water (an aquifer or lake), not a trickle; not going further. At -9,45,-45, steep_down heading north' },
				move: () => ({ x: -8.5, y: 45, z: -44.3, underWater: false }),
				then: { blocks: [-46, -45, -44].map((z) => ({ blockId: 'minecraft:water', x: waterX, y: 45, z })) } },
			tunnel,
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -20,30,-40, 5 blocks away' } },
		],
		travel_to: [pillarFailed(2), pillarFailed(32)],
	},
});

test('round 1 seed 1: a walk off the water that cannot climb its own steep stair tunnels out sideways, to the dryer side, and digs on', async () => {
	for (const [waterX, side, dx] of [[-4, 'west', -10], [-13, 'east', 10]]) {
		const body = seedOneBody({ waterX, tunnel: { result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED' }, move: (player) => ({ x: player.x + dx }) } });
		const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
		assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
		const digs = body.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args);
		assert.deepEqual([digs[1].pattern, digs[1].heading, digs[1].maxBlocks], ['tunnel', side, 20], `water seen to the ${side === 'west' ? 'east' : 'west'}: 10 steps ${side}`);
		assert.equal(digs.length, 3, 'the search digs on from the dry rock it tunnelled to');
		assert.deepEqual(body.calls.filter((call) => call.actionType).map((call) => call.actionType), ['dig_to', 'travel_to', 'travel_to', 'dig_to', 'dig_to']);
	}
});

test('round 1 seed 1: a sideways tunnel that also goes nowhere leaves the move off turning from the way away from the water', async () => {
	// Water to the north (the dig's -9,45,-47) and seen to the east: the tunnel goes west and does not move the body.
	const body = seedOneBody({ waterX: -4, tunnel: { result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED' } } });
	await searchFor({ block: 'minecraft:iron_ore' }, body);
	const walks = body.calls.filter((call) => call.actionType === 'travel_to');
	assert.equal(walks[1].args.yaw, 0, 'the walk off the water goes south, away from it');
	assert.deepEqual(body.calls.filter((call) => call.actionType === 'dig_to').map((call) => [call.args.pattern, call.args.heading]), [['steep_down', 'south'], ['tunnel', 'west']]);
	// Turned one step from south (the way away), not from the tunnel's west, which would point north at the water.
	assert.equal(walks.at(-1).args.yaw, 90, 'the move off goes sideways, not back toward the water');
});

test('round 1 seed 1: danger during the sideways tunnel hands back to the caller and starts nothing more', async () => {
	const flooded = seedOneBody({ waterX: -4, tunnel: { result: { state: 'FAILED', reasonCode: 'TUNNEL_FLOODED', message: 'water poured into the tunnel' } } });
	const stopped = await searchFor({ block: 'minecraft:iron_ore' }, flooded);
	assert.equal(stopped.reasonCode, 'FIND_DANGER');
	assert.match(stopped.message, /TUNNEL_FLOODED/);
	assert.equal(flooded.calls.filter((call) => call.actionType).at(-1).args.pattern, 'tunnel', 'nothing after the tunnel that met the danger');
	const steered = seedOneBody({ waterX: -4, tunnel: { result: { state: 'RUNNING', actionId: 'dig-7', interruptedBy: 'steer' } } });
	const handed = await searchFor({ block: 'minecraft:iron_ore' }, steered);
	assert.equal(handed.reasonCode, 'FIND_DANGER');
	assert.match(handed.message, /the leg still runs \(dig-7\)/);
	assert.equal(steered.calls.filter((call) => call.actionType).at(-1).args.pattern, 'tunnel', 'a steer during the tunnel starts no new body action');
});

test('scripted gate seed 2: a search started in its own covered stair also climbs out of the wet hole before walking clear', async () => {
	const wet = { result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: Water at 2,45,0 fills the cut; water on 4 sides of it: a body of water (an aquifer or lake), not a trickle' }, move: () => ({ x: 0.5, y: 46 }) };
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 72, z: 0.5, yaw: 0, health: 20, skyOpen: false } }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [wet, { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -33,20,0, 3 blocks away' }, move: () => ({ y: 21 }) }],
			travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: 0.5, y: 72 }) }, { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player) => ({ x: player.x - 32 }) }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const moves = body.calls.filter((call) => ['dig_to', 'travel_to'].includes(call.actionType))
		.map((call) => (call.actionType === 'dig_to' ? call.args.pattern : call.args.retrace ? 'retrace' : 'walk'));
	assert.deepEqual(moves, ['steep_down', 'retrace', 'walk', 'steep_down'], 'up at y72 first, never a level walk at y46 in the aquifer');
});

test('B-1 aquifer: afloat in its own flooded hole with the way back shut, the escape job runs from that cell before any swim or laid block', async () => {
	// The dig down opens the aquifer and the body floats at the bottom of its hole, 4 under its last open sky; the way back
	// up answers NO_ROUTE toward the next cell over. Swimming toward that cell first left the body where the escape found
	// no step to place (ESCAPE_NO_SHORE, then FIND_BLOCKED, every run since #74).
	const wet = { result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: Water at 10,54,-45 beside the opened cell 10,55,-45; water on 3 sides of it: a body of water (an aquifer or lake), not a trickle' },
		move: () => ({ x: 10.5, y: 54.3, z: -44.5, inWater: true, underWater: false, onGround: false, skyOpen: false }) };
	const shut = { result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No route out of the water toward Point[x=11, y=56, z=-45]' } };
	const body = fakeBody({ start: sample({ player: { x: 12.5, y: 58, z: -44.5, yaw: 90, health: 20, air: 300, maxAir: 300, skyOpen: true },
		inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }, { itemId: 'minecraft:cobblestone', count: 64 }] } }),
	frontier: { candidates: [], coverage: { headings: {} } },
	acts: { dig_to: [wet], travel_to: [shut],
		escape: [{ result: { state: 'SUCCEEDED', reasonCode: 'ESCAPED', message: 'Safe: footing, eyes in air' }, ms: 2_000,
			move: () => ({ x: 10.5, y: 56, z: -44.5, inWater: false, underWater: false, onGround: true }) }] } });
	body.openSky = () => ({ x: 12.5, y: 58, z: -44.5 });
	await searchFor({ block: 'minecraft:iron_ore' }, body, { timeoutMs: 120_000 });
	const types = body.calls.map((call) => call.actionType);
	const retrace = body.calls.findIndex((call) => call.actionType === 'travel_to' && call.args.retrace === true);
	const escape = types.indexOf('escape');
	assert.ok(retrace >= 0 && escape > retrace, `escape after the shut way back (calls: ${types.join(',')})`);
	assert.deepEqual(types.slice(retrace + 1, escape).filter((type) => type === 'control' || type === 'place_block'), [], 'no swim pulse or laid block before the escape');
});

test('water under a dig down: up out of the wet hole, a walk clear of the water, then down again; inside the band, the search mines at that level', async () => {
	const wet = { result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: Water at 2,57,0 beside the opened cell 1,58,0; water on 3 sides of it: a body of water (an aquifer or lake), not a trickle' }, move: () => ({ x: 0.5, y: 58 }) };
	const missed = [];
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [wet, { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -33,20,0, 3 blocks away' }, move: () => ({ y: 21 }) }],
			travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: 0.5, y: 70 }) }, { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player) => ({ x: player.x - 32 }) }] } });
	body.missPlace = (place, why) => missed.push({ ...place, why });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const moves = body.calls.filter((call) => ['dig_to', 'travel_to'].includes(call.actionType))
		.map((call) => (call.actionType === 'dig_to' ? `${call.args.pattern} ${call.args.heading}` : call.args.retrace ? 'retrace' : `walk ${call.args.yaw} ${call.args.distance}`));
	assert.deepEqual(moves, ['steep_down south', 'retrace', 'walk 90 32', 'steep_down west'], 'up, west away from the water (east of the body), then down again');
	assert.deepEqual(missed.map((row) => row.why), ['water under a dig down']);
	// A later search starting by that wet spot goes off it before digging down.
	const again = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,20,9, 4 blocks away' } }] } });
	again.missedPlaces = () => [{ x: 0, y: 58, z: 0, why: 'water under a dig down' }];
	await searchFor({ block: 'minecraft:iron_ore' }, again);
	assert.equal(again.calls.find((call) => call.actionType === 'travel_to' || call.actionType === 'dig_to').actionType, 'travel_to', 'a walk off it, not straight down into the same water');
	// Inside the band (y 30 for iron's 16): the search stays at that level and tunnels.
	const band = fakeBody({ start: sample({ player: { x: 0.5, y: 30, z: 0.5, yaw: 0, health: 20, skyOpen: false } }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ ...wet, move: () => ({ y: 30 }) }, { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 9,30,0, 8 blocks away' } }] } });
	assert.equal((await searchFor({ block: 'minecraft:iron_ore' }, band)).reasonCode, 'FIND_SEEN');
	assert.deepEqual(band.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args.pattern), ['steep_down', 'tunnel']);
});

test('b12-desktop seed 4: water a tunnel or walk met marks the spot for later searches, as a dig down\'s does; never a lava flood or a water search', async () => {
	const flooded = (message) => ({ result: { state: 'FAILED', reasonCode: 'TUNNEL_FLOODED', message } });
	const found = { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 9,30,0, 8 blocks away' } };
	const run = async (target, first) => {
		const missed = [];
		const body = fakeBody({ start: sample({ player: { x: 0.5, y: 17, z: 0.5, yaw: 0, health: 20, skyOpen: false } }), frontier: { candidates: [], coverage: { headings: {} } },
			acts: { dig_to: [first, found, found] } });
		body.missPlace = (place, why) => missed.push({ ...place, why });
		await searchFor(target, body);
		return missed;
	};
	const water = await run({ block: 'minecraft:iron_ore' }, flooded('Water flowed into the opened tunnel at -242,59,68; not entered; backed out to -244,58,68 and the flow stopped short of it'));
	assert.deepEqual(water, [{ x: -242, y: 59, z: 68, why: 'water under a dig down' }], 'the flooded cell');
	const ahead = await run({ block: 'minecraft:iron_ore' }, { result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: Water at -246,58,68 fills the cut; not going further. At -246,58,69, tunnel heading north' } });
	assert.deepEqual(ahead.map(({ x, y, z }) => [x, y, z]), [[-246, 58, 68]]);
	assert.deepEqual(await run({ block: 'minecraft:iron_ore' }, flooded('Lava flowed into the opened tunnel at 1,30,5; not entered; backed out to 1,30,2')), [], 'a lava flood is no wet spot');
	assert.deepEqual(await run({ block: 'minecraft:water' }, flooded('Water flowed into the opened tunnel at 1,30,5; not entered; backed out to 1,30,2')), [], 'a water search is after the water');
});

test('review P1 3: under water the body swims until its eyes are in air, and hands back at once with its air when it cannot', async () => {
	const stuck = fakeBody({ start: sample({ player: { x: 0.5, y: 38, z: 0.5, yaw: 0, health: 20, inWater: true, underWater: true, air: 143, maxAir: 300 } }),
		frontier: { candidates: [], coverage: { headings: {} } } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, stuck);
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.match(result.message, /Under water with no way up to air here \(air 143\/300\)/);
	assert.equal(stuck.calls.some((call) => call.actionType === 'dig_to' || call.actionType === 'travel_to'), false, 'no breath spent on digs or travel');
	const rising = fakeBody({ start: sample({ player: { x: 0.5, y: 38, z: 0.5, yaw: 0, health: 20, inWater: true, underWater: true, air: 200, maxAir: 300 } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			control: [{ result: { state: 'SUCCEEDED' } }, { move: (player) => ({ y: player.y + 2, underWater: false }), result: { state: 'SUCCEEDED' } }],
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,30,9, 6 blocks away' } }],
		} });
	const ok = await searchFor({ block: 'minecraft:iron_ore' }, rising);
	assert.equal(ok.reasonCode, 'FIND_SEEN');
	assert.deepEqual(rising.calls.filter((call) => call.actionType).map((call) => call.actionType), ['control', 'control', 'dig_to'], 'digs only once the eyes are in air');
});

test('review P1 1: the lava is not opened when the step back failed', async () => {
	const body = fakeBody({
		start: sample({ player: { x: 0.5, y: -58, z: 0.5, yaw: 0, health: 20 } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [{ result: { state: 'FAILED', reasonCode: 'LAVA_AHEAD', message: 'Lava is heard beside this block; not breaking minecraft:tuff at 0,-57,1' } }],
			move_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE' } }],
		},
	});
	await searchFor({ block: 'minecraft:lava' }, body, { timeoutMs: 60_000 });
	assert.equal(body.calls.some((call) => call.actionType === 'break_block'), false);
});

test('review P1 2: no travel leg in a search fights through; a creeper in the way is never engaged', async () => {
	const body = fakeBody({
		start: sample({ entities: [{ type: 'minecraft:creeper', hostile: true, stableId: 'c', x: 3.5, y: 70, z: 0.5 }] }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [{ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:creeper c at 3,70,0' } }] },
	});
	await searchFor({ mob: 'minecraft:sheep' }, body, { timeoutMs: 60_000 });
	assert.equal(body.calls.some((call) => call.args?.fightThrough !== undefined), false);
	assert.equal(body.calls.some((call) => call.actionType === 'fight_target'), false);
});

test('review P2 4: underground legs stay inside within, the descent included', async () => {
	// A steep descent moves 1 block forward per 2 levels (4 blocks mined); left alone, y70 to y16 walks 27 blocks.
	const step = { south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] };
	const dig = (player, args) => {
		const [dx, dz] = step[args.heading];
		const forward = args.pattern === 'tunnel' ? args.maxBlocks / 2 : Math.min((player.y - args.y) / 2, (args.maxBlocks ?? Infinity) / 4);
		return { x: player.x + dx * forward, z: player.z + dz * forward, y: args.pattern === 'tunnel' ? player.y : player.y - 2 * forward };
	};
	const legs = Array.from({ length: 30 }, () => ({ move: dig, result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED', message: 'mined stone 10' } }));
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: { S: [0, 0] } } }, acts: { dig_to: legs } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body, { within: 16 });
	assert.equal(result.reasonCode, 'FIND_NOT_FOUND');
	assert.ok(result.find.covered.fromStart <= 16, `moved ${result.find.covered.fromStart} with within 16`);
});

test('review P2 5: a small within still walks legs scaled to it', async () => {
	const travel = Array.from({ length: 20 }, () => ({ move: (player, args) => ({ x: player.x - Math.sin(args.yaw * Math.PI / 180) * args.distance, z: player.z + Math.cos(args.yaw * Math.PI / 180) * args.distance }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }));
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, acts: { travel_to: travel } });
	const result = await searchFor({ mob: 'minecraft:sheep' }, body, { within: 40 });
	const legs = body.calls.filter((call) => call.actionType === 'travel_to');
	assert.ok(legs.length >= 2 && legs.every((call) => call.args.distance === 20), `legs ${legs.map((call) => call.args.distance)}`);
	assert.ok(result.find.covered.fromStart <= 40);
});

test('review P2 6: a start below an ore band climbs to it', async () => {
	const body = fakeBody({
		start: sample({ player: { x: 0.5, y: -50, z: 0.5, yaw: 0, health: 20 } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [
			{ move: (player, args) => ({ y: args.y }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' } },
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:copper_ore seen at 3,48,9, 6 blocks away' } },
		] },
	});
	const result = await searchFor({ block: 'minecraft:copper_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const first = body.calls.find((call) => call.actionType === 'dig_to').args;
	assert.deepEqual([first.pattern, first.y], ['stairs_up', 48]);
});

test('a tunnel leg through rock ore cannot form in turns the next leg', async () => {
	assert.equal(oreRockShare('At -44,15,0, tunnel heading west; 32 blocks mined in 16 steps over 34 s (y15 to y15); mined sulfur 24, cinnabar 8; tool stone_pickaxe'), 0);
	assert.equal(oreRockShare('33 blocks mined in 12 steps over 42 s (y16 to y16); mined gravel 22, granite 9, stone 2; tool stone_pickaxe'), 1, 'gravel is a pocket, not the region');
	assert.equal(oreRockShare('32 blocks mined in 16 steps; mined stone 22, andesite 10; tool stone_pickaxe 61 uses'), 1);
	assert.equal(oreRockShare('no blocks named'), 1);
	const body = fakeBody({
		frontier: { candidates: [], coverage: { headings: {} } },
		start: sample({ player: { x: 0.5, y: 16, z: 0.5, yaw: 0, health: 20 } }),
		acts: { dig_to: [
			{ move: (player) => ({ z: player.z + 16 }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED', message: '32 blocks mined; mined sulfur 24, cinnabar 8' } },
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,15,20, 4 blocks away' } },
		] },
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const headings = body.calls.filter((call) => call.args?.pattern === 'tunnel').map((call) => call.args.heading);
	assert.notEqual(headings[0], headings[1]);
});

test('tunnel stops turn right, then left, then back from the last heading that went its full leg, never to and fro', async () => {
	const wall = { result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'water on 3 sides' }, move: (player) => ({ x: player.x + 1.5 }) };
	const body = fakeBody({
		start: sample({ player: { x: 0.5, y: 16, z: 0.5, yaw: 0, health: 20 } }),
		frontier: { candidates: [], coverage: { headings: { S: [0, 0] } } },
		acts: { dig_to: [wall, wall, wall, { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,15,9, 4 blocks away' } }] },
	});
	await searchFor({ block: 'minecraft:iron_ore' }, body);
	const headings = body.calls.filter((call) => call.args?.pattern === 'tunnel').map((call) => call.args.heading);
	assert.deepEqual(headings.slice(1, 4), ['west', 'east', 'north'], `from south: right, left, back (got ${headings.join(', ')})`);
});

test('a skeleton or a mob below is not chased: the body walls off instead of fighting it', async () => {
	const body = fakeBody({
		start: sample({ inventory: { items: [{ itemId: 'minecraft:stone_sword', count: 1 }, { itemId: 'minecraft:cobblestone', count: 20 }] },
			entities: [{ type: 'minecraft:skeleton', hostile: true, stableId: 's', x: 3.5, y: 70, z: 3.5 }, { type: 'minecraft:zombie', hostile: true, stableId: 'z', x: 2.5, y: 66, z: 0.5 }] }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [
			{ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:skeleton s at 3,70,3, 4 blocks away.' } },
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,30,9, 6 blocks away' } },
		] },
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(body.calls.some((call) => call.actionType === 'fight_target'), false);
	assert.equal(body.calls.some((call) => call.actionType === 'build_shelter'), true);
});

test('a danger hand-back underground walls the body in first, and fights there do not pursue', async () => {
	const body = fakeBody({
		start: sample({ player: { x: 0.5, y: 50, z: 0.5, yaw: 0, health: 20, skyOpen: false },
			inventory: { items: [{ itemId: 'minecraft:stone_sword', count: 1 }, { itemId: 'minecraft:cobblestone', count: 20 }] },
			entities: [{ type: 'minecraft:zombie', hostile: true, stableId: '0c1f6b9e-3d2a-4c5b-8e7f-1a2b3c4d5e01', x: 3.5, y: 50, z: 0.5 }] }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [{ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:zombie 0c1f6b9e-3d2a-4c5b-8e7f-1a2b3c4d5e01 at 3,50,0' } }, { result: { state: 'FAILED', reasonCode: 'LOW_HEALTH', message: 'Health 7' } }],
			fight_target: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_KILLED' } }],
			build_shelter: [{ result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } }],
		},
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(result.find.stopCode, 'LOW_HEALTH', 'the leg\'s own stop code goes back with the hand-back');
	assert.match(result.message, /walled in where it stands/);
	assert.equal(body.calls.find((call) => call.actionType === 'fight_target').args.pursue, false);
});

test('review P1 3: a dig refused because the body is under water is never retried on that spot, even when a sample shows the eyes in air', async () => {
	const wet = Array.from({ length: 40 }, () => ({ result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: The body is under water at 310,38,-128 (air 298/300); not digging on' }, ms: 1_000 }));
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: wet, travel_to: [{ result: { state: 'FAILED', reasonCode: 'BUILD_FAILED' } }, { result: { state: 'FAILED', reasonCode: 'BUILD_FAILED' } }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.ok(body.calls.filter((call) => call.actionType === 'dig_to').length <= 3, `digs ${body.calls.filter((call) => call.actionType === 'dig_to').length}`);
});

test('review P1 3: a body that surfaces and sinks back is moved off the spot, not dug in again', async () => {
	const sink = Array.from({ length: 40 }, () => ({ move: () => ({ underWater: true }), result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: The body is under water at 310,38,-128 (air 298/300)' }, ms: 1_000 }));
	const swim = Array.from({ length: 40 }, () => ({ move: () => ({ underWater: false }), result: { state: 'SUCCEEDED' } }));
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 38, z: 0.5, yaw: 0, health: 20, underWater: false } }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: sink, control: swim, travel_to: [{ result: { state: 'FAILED', reasonCode: 'BUILD_FAILED' } }, { result: { state: 'FAILED', reasonCode: 'BUILD_FAILED' } }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.ok(body.calls.filter((call) => call.actionType === 'dig_to').length <= 3, `digs ${body.calls.filter((call) => call.actionType === 'dig_to').length}`);
});

test('review P2 radius: digs are capped by the steps left along their heading, so stairs never carry the body out of within', async () => {
	const cells = { tunnel: 2, stairs_up: 3, stairs_down: 3, steep_down: 4 };
	const step = { south: [0, 1], north: [0, -1], east: [1, 0], west: [-1, 0] };
	let farthest = 0;
	// A dig goes on until its target y or its maxBlocks (a tunnel, until maxBlocks); a stairs_up step climbs 1.
	const dig = (player, args) => {
		const [dx, dz] = step[args.heading];
		const levels = args.pattern === 'tunnel' ? Infinity : Math.abs(args.y - player.y) / (args.pattern === 'steep_down' ? 2 : 1);
		const forward = Math.min(levels, Math.floor((args.maxBlocks ?? 4096) / cells[args.pattern]));
		const next = { x: player.x + dx * forward, z: player.z + dz * forward, y: args.pattern === 'tunnel' ? player.y : player.y + Math.sign(args.y - player.y) * forward * (args.pattern === 'steep_down' ? 2 : 1) };
		farthest = Math.max(farthest, Math.hypot(next.x - 0.5, next.z - 0.5));
		return next;
	};
	const legs = Array.from({ length: 60 }, () => ({ move: dig, result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED', message: 'mined stone 10' } }));
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: -50, z: 0.5, yaw: 0, health: 20 } }), frontier: { candidates: [], coverage: { headings: { S: [0, 0] } } }, acts: { dig_to: legs } });
	const result = await searchFor({ block: 'minecraft:copper_ore' }, body, { within: 16 });
	assert.ok(farthest <= 16, `reached ${farthest.toFixed(1)} blocks from the start with within 16`);
	assert.equal(result.reasonCode, 'FIND_NOT_FOUND');
});

test('review P2 schema: a wide within never asks a dig for more blocks than dig_to accepts', async () => {
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,30,9, 6 blocks away' } }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body, { within: 2048 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.ok(body.calls.filter((call) => call.actionType === 'dig_to').every((call) => (call.args.maxBlocks ?? 0) <= 4096));
});

test('re-check P1 2: lava ahead, falling blocks or air running out hands an ore search back at once; obtain uses the same list', async () => {
	const { DAMAGE_STOPS, LIFE_SAFETY_STOPS } = await import('../src/find-search.mjs');
	const { isDanger } = await import('../src/obtain-runner.mjs');
	for (const code of [...DAMAGE_STOPS, ...LIFE_SAFETY_STOPS]) assert.ok(isDanger({ reasonCode: code }), `obtain: ${code}`);
	for (const code of ['LAVA_AHEAD', 'FALLING_BLOCKS', 'AIR_RESERVE_REACHED', 'LAVA_FLOW', 'VOID_EDGE']) {
		const stop = { state: 'FAILED', reasonCode: code, message: `Stopped: ${code}; not breaking minecraft:stone at 3,16,0` };
		const body = fakeBody({
			start: sample({ inventory: { items: [] } }),
			frontier: { candidates: [], coverage: { headings: { N: [50, 50], E: [0, 0] } } },
			acts: { dig_to: [{ move: (player, args) => ({ y: args.y }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' } }, stop, stop, stop, stop].map((row) => (row.result ? row : { result: row })) },
		});
		const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
		assert.equal(result.reasonCode, 'FIND_DANGER', `${code}: ${result.message}`);
		assert.equal(body.calls.filter((call) => call.actionType === 'dig_to').length, 2, `${code}: no digging on after the stop`);
	}
});

test('round-2 P1 1: an air, flooding or drowning stop hands back at once and never builds cover', async () => {
	for (const stop of [{ reasonCode: 'AIR_RESERVE_REACHED', message: 'air 2.0 s left' }, { reasonCode: 'TUNNEL_FLOODED', message: 'water broke in' },
		{ reasonCode: 'DAMAGE_TAKEN', message: 'Took 2.0 damage (drown); health 12.0' }, { reasonCode: 'BREATH_NOT_COVERED', message: 'no air route' }]) {
		const body = fakeBody({
			start: sample({ inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 32 }] } }),
			frontier: { candidates: [], coverage: { headings: { N: [50, 50], E: [0, 0] } } },
			acts: { dig_to: [{ move: (player, args) => ({ y: args.y }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' } }, { result: { state: 'FAILED', ...stop } }] },
		});
		const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
		assert.equal(result.reasonCode, 'FIND_DANGER', `${stop.reasonCode}: ${result.message}`);
		assert.ok(!body.calls.some((call) => call.actionType === 'build_shelter'), `${stop.reasonCode}: no building on the last breath`);
	}
	const lava = fakeBody({
		start: sample({ inventory: { items: [{ itemId: 'minecraft:cobblestone', count: 32 }] } }),
		frontier: { candidates: [], coverage: { headings: { N: [50, 50], E: [0, 0] } } },
		acts: { dig_to: [{ move: (player, args) => ({ y: args.y }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' } }, { result: { state: 'FAILED', reasonCode: 'LAVA_AHEAD', message: 'lava behind' } }] },
	});
	await searchFor({ block: 'minecraft:iron_ore' }, lava);
	assert.ok(lava.calls.some((call) => call.actionType === 'build_shelter'));
});

test('round-2 P1 3: a dig that stopped for lava with iron in view hands back the danger and the sighting, not FIND_SEEN', async () => {
	const body = fakeBody({
		start: sample({ inventory: { items: [] } }),
		frontier: { candidates: [], coverage: { headings: { N: [50, 50], E: [0, 0] } } },
		acts: { dig_to: [{ move: (player, args) => ({ y: args.y }), result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' } },
			{ result: { state: 'FAILED', reasonCode: 'LAVA_AHEAD', message: 'Stopped: lava behind minecraft:stone at 3,16,0', seen: { x: 4, y: 15, z: 1, id: 'minecraft:iron_ore', distance: 4, via: 'dig_to' } } }] },
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.state, 'FAILED');
	assert.equal(result.reasonCode, 'FIND_DANGER', result.message);
	assert.deepEqual([result.find.seen.x, result.find.seen.y, result.find.seen.z], [4, 15, 1]);
	assert.match(result.message, /LAVA_AHEAD.*also seen: iron_ore seen at 4,15,1/);
	const { isDanger } = await import('../src/obtain-runner.mjs');
	assert.ok(isDanger({ reasonCode: 'LAVA_AHEAD' }));
	// A leg a reflex held for minutes ends obtain instead of being retried into the same hold.
	assert.ok(isDanger({ reasonCode: 'HELD_BY_REFLEX' }));
});

// Threat rows as the server sends them (ThreatPerception entries): a hostile after the body within 16 blocks.
const threat = (type, distance, extra = {}) => ({ player: { threats: [{ uuid: '9b6ad922-d7b9-4735-b020-5ce37861a1c8', type, distance, targeting: true, signals: ['targeting'], ...extra }] } });
// A hostile with no signal: the server sends no threat row for it, only its entity row (distance from the coordinates).
const idle = (type, distance) => ({ player: { x: 0.5, y: 70, z: 0.5, threats: [] }, entities: [{ stableId: 'idle', type, hostile: true, x: 0.5 + distance, y: 70, z: 0.5 }] });

test('gate B-5: a drowned far down in the sea does not end a surface search; one close by, or a skeleton aiming, does', async () => {
	const { hostileIsDanger } = await import('../src/find-search.mjs');
	// The drowned 31.9 blocks away is past the server's 16-block threat range: no row.
	assert.equal(hostileIsDanger({ player: { threats: [] } }), false);
	assert.equal(hostileIsDanger(threat('minecraft:drowned', 12)), true);
	assert.equal(hostileIsDanger(threat('minecraft:drowned', 18)), false, 'a drowned past its trident reach (still listed up to 20 blocks)');
	assert.equal(hostileIsDanger(threat('minecraft:skeleton', 14)), true);
	// A skeleton in view but not after the body still has a row: it raises ranged_sight (ThreatPerception.signals).
	assert.equal(hostileIsDanger(threat('minecraft:skeleton', 14, { targeting: false, signals: ['ranged_sight'] })), false, 'a skeleton not after the body');
	assert.equal(hostileIsDanger(threat('minecraft:zombie', 8)), true, 'a mob after the body this close');
	// A mob with no signal (not after the body, not a creeper or ranged) has no threat row, only a hostile entity row.
	assert.equal(hostileIsDanger(idle('minecraft:zombie', 8)), true, 'anything this close, row or not');
	assert.equal(hostileIsDanger(idle('minecraft:spider', 14)), false, 'a mob with no row and not close');
	assert.equal(hostileIsDanger({ ...idle('minecraft:zombie', 4), entities: [{ ...idle('minecraft:zombie', 4).entities[0], alive: false }] }), false, 'a dead one');
	assert.equal(hostileIsDanger(threat('minecraft:zombie', 14)), false, 'a melee mob after the body but not close');
	assert.equal(hostileIsDanger({ player: {} }), true, 'a sample with no threat rows is unknown, so danger');
	assert.equal(hostileIsDanger(null), true);
	const far = { result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'minecraft:drowned 9b6ad922-d7b9-4735-b020-5ce37861a1c8 31.9 blocks away at 375.6,43.0,-31.9, targeting you' }, move: (player) => ({ x: player.x + 10 }) };
	const start = sample({ inventory: { items: [] } });
	start.player.threats = [];
	const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [far, { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:oak_log seen at 60,70,0, 9 blocks away' } }] } });
	const result = await searchFor({ block: 'minecraft:oak_log' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
});

test('step 8: the danger call never reads the stop message, so rewording a hostile stop changes no decision', async () => {
	const { hostileIsDanger } = await import('../src/find-search.mjs');
	const { isDanger } = await import('../src/obtain-runner.mjs');
	// Each sample, stopped with the server's wording today and with three rewordings (a message is for the model).
	const samples = [{ player: { threats: [] } }, threat('minecraft:drowned', 12), threat('minecraft:drowned', 18), threat('minecraft:skeleton', 14),
		threat('minecraft:skeleton', 14, { targeting: false, signals: ['ranged_sight'] }), idle('minecraft:zombie', 8), threat('minecraft:zombie', 14), { player: {} }];
	const id = '9b6ad922-d7b9-4735-b020-5ce37861a1c8';
	const wordings = [`minecraft:skeleton ${id} 24.0 blocks away at 1,2,3, targeting you`, `A skeleton (${id}) is 24 blocks off and aiming at you`,
		`minecraft:drowned ${id} 31.9 blocks away at 375.6,43.0,-31.9`, '', undefined];
	for (const observation of samples) {
		const decision = hostileIsDanger(observation);
		for (const message of wordings) assert.equal(isDanger({ reasonCode: 'HOSTILE_NEAR', message }, observation), decision, `${message} on ${JSON.stringify(observation)}`);
	}
});

test('step 8 review: a close hostile with no threat row ends a surface search as danger, not as blocked headings', async () => {
	// A daytime spider 4 blocks off: travel stops for any hostile in view within 6, but it has no signal, so no threat row.
	// Unarmed, so the body neither fights nor sidesteps it: the danger call alone decides (origin/main: FIND_DANGER, 1 leg).
	const start = sample({ inventory: { items: [] }, entities: [{ stableId: 'spider', type: 'minecraft:spider', hostile: true, x: 4.5, y: 70, z: 0.5 }] });
	start.player.threats = [];
	const stop = { result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'minecraft:spider 0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0 4.0 blocks away at 4,70,0' } };
	const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } }, acts: { travel_to: Array.from({ length: 20 }, () => structuredClone(stop)) } });
	const result = await searchFor({ block: 'minecraft:oak_log' }, body);
	assert.equal(result.reasonCode, 'FIND_DANGER', result.message);
	assert.equal(body.calls.filter((call) => call.actionType === 'travel_to').length, 1);
});

test('any log: find watches and surveys every kind obtain accepts, the biome\'s own first', () => {
	const logs = findProfile({ block: 'minecraft:oak_log', also: ['minecraft:birch_log', 'minecraft:spruce_log'] });
	assert.ok(logs.ids.has('minecraft:birch_log') && logs.ids.has('minecraft:spruce_log'));
	assert.deepEqual(logs.sections, ['blocks', 'blocks:minecraft:oak_log', 'blocks:minecraft:birch_log', 'blocks:minecraft:spruce_log', 'biomes']);
	assert.equal(logs.stopId, 'minecraft:oak_log');
	// A survey takes at most 4 blocks:<id> searches (scripted seed 3: six log kinds made every look INVALID).
	const many = findProfile({ block: 'minecraft:acacia_log', also: ['oak_log', 'birch_log', 'spruce_log', 'jungle_log', 'dark_oak_log', 'cherry_log'] });
	assert.equal(many.sections.filter((section) => section.startsWith('blocks:')).length, 4);
	assert.equal(many.sections[1], 'blocks:minecraft:acacia_log');
	assert.ok(many.ids.has('minecraft:cherry_log'), 'every kind still counts when seen');
	normalizeMinecraftToolCall('lookAround', { centerYaw: 0, pitch: 0, steps: 4, ticksPerStep: 2, survey: { include: many.sections, limit: 8 } });
	assert.equal(sightingOf(logs, sample({ blocks: [{ blockId: 'minecraft:spruce_log', x: 5, y: 70, z: 0 }] })).id, 'minecraft:spruce_log');
});

test('scripted gate seed 6: a lone cave zombie is fought with the pickaxe at full health, not walled off and handed back', async () => {
	const zombie = { type: 'minecraft:zombie', hostile: true, stableId: '0c1f6b9e-3d2a-4c5b-8e7f-1a2b3c4d5e02', x: 2.5, y: 30, z: 0.5 };
	const body = fakeBody({
		start: sample({ player: { x: 0.5, y: 30, z: 0.5, yaw: 0, health: 20, skyOpen: false },
			inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }, { itemId: 'minecraft:cobblestone', count: 20 }] }, entities: [zombie] }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:zombie 0c1f6b9e-3d2a-4c5b-8e7f-1a2b3c4d5e02 at 2,30,0, 2.0 blocks away.' } },
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,20,9, 4 blocks away' } }],
		fight_target: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_KILLED' }, then: { entities: [] } }] },
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.equal(body.calls.some((call) => call.actionType === 'build_shelter'), false);
	assert.equal(body.calls.find((call) => call.actionType === 'fight_target').args.pursue, false);
	const crowd = fakeBody({
		start: sample({ player: { x: 0.5, y: 30, z: 0.5, yaw: 0, health: 20, skyOpen: false },
			inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }] }, entities: [zombie, { ...zombie, stableId: 'z2', x: 4.5 }] }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:zombie z at 2,30,0, 2.0 blocks away.' } }] },
	});
	await searchFor({ block: 'minecraft:iron_ore' }, crowd);
	assert.equal(crowd.calls.some((call) => call.actionType === 'fight_target'), false);
});

test('scripted gate seed 1: bobbing in a flooded stair with the air nearly full: swim out to a bank, not a hand-back', async () => {
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 57, z: 0.5, yaw: 90, health: 20, inWater: true, underWater: true, air: 286, maxAir: 300 } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player) => ({ x: player.x - 5, y: 60, inWater: false, underWater: false }) }],
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,30,9, 6 blocks away' } }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const moves = body.calls.filter((call) => call.actionType).map((call) => call.actionType);
	assert.deepEqual(moves.slice(0, 7), ['control', 'control', 'control', 'control', 'control', 'control', 'travel_to'], moves.join(' '));
});

test('review: a drowned that hits the body on the swim out to the bank is handed back, not a dig on beside it', async () => {
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 57, z: 0.5, yaw: 90, health: 20, inWater: true, underWater: true, air: 280, maxAir: 300 } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [{ result: { state: 'FAILED', reasonCode: 'TRAVEL_DAMAGED', message: 'Took 3 damage from minecraft:drowned' }, move: (player) => ({ x: player.x - 5, y: 60, inWater: false, underWater: false, health: 14 }) }],
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,30,9, 6 blocks away' } }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_DANGER', result.message);
	assert.match(result.message, /TRAVEL_DAMAGED/);
	assert.equal(body.calls.some((call) => call.actionType === 'dig_to'), false);
});

test('scripted seed 2: a dig down that floods round the body: up to air, out of the hole and clear of the water, not down the same flooded stair again', async () => {
	const flooded = { result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: The body is under water at 0,46,0 (air 280/300); not digging on' }, move: () => ({ y: 46, underWater: true }) };
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [flooded, { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 30,20,0, 3 blocks away' } }],
			control: [{ result: { state: 'SUCCEEDED' }, move: () => ({ underWater: false }) }],
			travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ y: 70 }) }, { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player) => ({ x: player.x + 32 }) }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const moves = body.calls.filter((call) => call.actionType !== undefined).map((call) => (call.actionType === 'travel_to' ? (call.args.retrace ? 'retrace' : 'walk') : call.actionType));
	assert.deepEqual(moves, ['dig_to', 'control', 'retrace', 'walk', 'dig_to']);
});

test('scripted gate seed 5: a tree search with no tree in sight heads for the wooded land a look saw, not the least-covered heading out to sea', async () => {
	const body = fakeBody({ start: sample({ inventory: { items: [] } }), frontier: { candidates: [], coverage: { headings: { W: [0, 0], E: [5, 40] } } },
		looks: [{ state: 'SUCCEEDED', survey: { biomes: [{ biome: 'minecraft:ocean', x: -90, y: 62, z: 0 }, { biome: 'minecraft:forest', x: 120, y: 70, z: 30 }] } }],
		acts: { travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:oak_log seen at 100,70,20, 9 blocks away' } }] } });
	const result = await searchFor({ block: 'minecraft:oak_log', also: ['minecraft:birch_log'] }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.ok(body.calls.find((call) => call.look !== undefined).include.includes('biomes'));
	assert.equal(body.calls.find((call) => call.actionType === 'travel_to').args.yaw, -90, 'east, toward the forest');
});

test('scripted gate seed 5: headings a look saw as open water are out; the first leg goes where it saw land', async () => {
	// The stony-shore spawn: the sea north (all water samples), land south-east; least covered is north-west.
	const ground = [{ yaw: 180, water: 9, land: 0, farthestLand: 0 }, { yaw: -90, water: 0, land: 7, farthestLand: 24 }, { yaw: 0, water: 0, land: 7, farthestLand: 12 }, { yaw: 90, water: 6, land: 0, farthestLand: 0 }];
	const body = fakeBody({ start: sample({ inventory: { items: [] } }), frontier: { candidates: [], coverage: { headings: { S: [9, 40], SE: [9, 40], E: [9, 40] } } },
		looks: [{ state: 'SUCCEEDED', survey: {}, ground }],
		acts: { travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:oak_log seen at 100,70,20, 9 blocks away' } }] } });
	const result = await searchFor({ block: 'minecraft:oak_log' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const first = body.calls.find((call) => call.actionType === 'travel_to').args.yaw;
	assert.ok([0, -45, -90].includes(first), `a land heading (S, SE or E), not into the sea: yaw ${first}`);
	// A view with any land in it (a river with a far bank) is not open water.
	const { seaHeadings } = await import('../src/find-search.mjs');
	assert.deepEqual([...seaHeadings([{ yaw: 180, water: 3, land: 1 }, { yaw: 90, water: 2, land: 0 }])], [], 'land beyond the water, or too few samples');
	assert.deepEqual([...seaHeadings([{ yaw: 180, water: 3, land: 0 }])].sort(), ['N', 'NE', 'NW']);
});

test('scripted gate seeds 3, 6, 7: water under a dig down from obtain\'s covered pit: up to the open sky it came down from, then the walk off on the surface', async () => {
	const wet = { result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: Water at 2,47,0 beside the opened cell 1,48,0; water on 3 sides of it: a body of water (an aquifer or lake), not a trickle' }, move: () => ({ x: 0.5, y: 48 }) };
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 65, z: 0.5, yaw: 0, health: 20, skyOpen: false } }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [wet, { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -33,20,0, 3 blocks away' }, move: () => ({ y: 21 }) }],
			travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: -5.5, y: 71, z: 0.5, skyOpen: true }) },
				{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player) => ({ x: player.x - 32 }) }] } });
	body.openSky = () => ({ x: -5.5, y: 71, z: 0.5 });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const travels = body.calls.filter((call) => call.actionType === 'travel_to').map((call) => call.args);
	assert.deepEqual([travels[0].retrace, travels[0].x, travels[0].y], [true, -5.5, 71], 'the retrace ends at the open sky, not at the pit floor (y65)');
	assert.equal(travels[1].distance, 32);
	// A surface start far from where the search began is not the way up: the search's own start is.
	const far = fakeBody({ start: sample({ player: { x: 0.5, y: 65, z: 0.5, yaw: 0, health: 20, skyOpen: false } }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [wet, { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -33,20,0, 3 blocks away' }, move: () => ({ y: 21 }) }],
			travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: 0.5, y: 65 }) }, { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player) => ({ x: player.x - 32 }) }] } });
	far.openSky = () => ({ x: 90, y: 72, z: 0 });
	await searchFor({ block: 'minecraft:iron_ore' }, far);
	assert.equal(far.calls.find((call) => call.actionType === 'travel_to').args.y, 65);
});

test('scripted gate seed 7: bobbing in a flooded chamber with no bank in reach: out the way it came to the last open sky, then the search goes on', async () => {
	const bobbing = { x: -15.5, y: 39, z: 31.5, yaw: 0, health: 20, inWater: true, underWater: true, air: 290, maxAir: 300, skyOpen: false };
	const body = fakeBody({ start: sample({ player: bobbing }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { control: Array.from({ length: 6 }, () => ({ result: { state: 'SUCCEEDED' } })),
			travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Could not get out of the water in 30 s; no dry footing seen within 10 blocks' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: -7.5, y: 63, z: 29.5, inWater: false, underWater: false, skyOpen: true }) }],
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -20,20,29, 3 blocks away' } }] } });
	body.openSky = () => ({ x: -7.5, y: 63, z: 29.5 });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const travels = body.calls.filter((call) => call.actionType === 'travel_to').map((call) => call.args);
	assert.deepEqual(travels.map((args) => args.retrace === true), [false, true], 'the swim out, then the retrace up');
	assert.deepEqual([travels[1].x, travels[1].y, travels[1].z], [-7.5, 63, 29.5]);
	const lost = fakeBody({ start: sample({ player: bobbing }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { control: Array.from({ length: 6 }, () => ({ result: { state: 'SUCCEEDED' } })), travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE' } }] } });
	assert.match((await searchFor({ block: 'minecraft:iron_ore' }, lost)).message, /Under water with no way up to air here \(air 290\/300\)/);
});

test('a look\'s ground per heading counts the far samples only: the shore at the body\'s feet says nothing about what lies beyond', async () => {
	const { groundOfView } = await import('../src/native-tool-runtime.mjs');
	const row = (blockId, distance) => ({ compact: { blockId, distance } });
	const view = (rows) => ({ yaw: 90, sections: [[], [], [], rows] });
	assert.deepEqual(groundOfView(view([row('minecraft:gravel', 2), row('minecraft:gravel', 3), row('minecraft:water', 30), row('minecraft:water', 41), row('minecraft:water', 48)])),
		{ yaw: 90, water: 3, land: 0, farthestLand: 0 }, 'the stony shore underfoot, the sea beyond');
	assert.deepEqual(groundOfView(view([row('minecraft:water', 20), row('minecraft:grass_block', 160)])), { yaw: 90, water: 1, land: 1, farthestLand: 160 });
});

test('scripted gate seed 7: the way back up its own stair is flooded: a new stair up away from the water, not a hand-back', async () => {
	const wet = { result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: Water at 2,57,0 beside the opened cell 1,58,0; water on 3 sides of it: a body of water (an aquifer or lake), not a trickle' }, move: () => ({ x: 0.5, y: 52 }) };
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [wet, { result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' }, move: () => ({ x: -3.5, y: 70 }) },
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -40,20,0, 3 blocks away' } }],
			travel_to: [{ result: { state: 'FAILED', reasonCode: 'TUNNEL_FLOODED', message: 'Fluid flowed into the opened tunnel at 1,56,0; not entered; backed out' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player) => ({ x: player.x - 32 }) }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const moves = body.calls.filter((call) => ['dig_to', 'travel_to'].includes(call.actionType))
		.map((call) => (call.actionType === 'dig_to' ? `${call.args.pattern} ${call.args.heading}${call.args.y === 70 ? ' to y70' : ''}` : call.args.retrace ? 'retrace' : 'walk'));
	assert.deepEqual(moves, ['steep_down south', 'retrace', 'stairs_up west to y70', 'walk', 'steep_down west'], 'the flooded retrace, a new stair up away from the water, then the walk off');
});

test('scripted gate seed 7: off a second wet spot the walk goes away from the first one too, and farther', async () => {
	const wet = (x) => ({ result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: `Stopped: Water at ${x + 1},50,0 beside the opened cell; water on 3 sides of it: a body of water (an aquifer or lake), not a trickle` }, move: () => ({ x: x + 0.5, y: 51 }) });
	// The first wet spot lies 40 blocks east; this one is under the body, its water to the east.
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [wet(0), { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 0,20,40, 3 blocks away' }, move: () => ({ y: 21 }) }],
			travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: 0.5, y: 70 }) }, { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player) => ({ z: player.z + 40 }) }] } });
	body.missedPlaces = () => [{ x: -40, y: 50, z: 0, why: 'water under a dig down' }];
	await searchFor({ block: 'minecraft:iron_ore' }, body);
	const walk = body.calls.filter((call) => call.actionType === 'travel_to' && call.args.yaw !== undefined).at(-1)?.args;
	assert.ok(walk !== undefined && walk.yaw !== 90, `not west, back toward the first wet spot: yaw ${walk?.yaw}`);
});

test('local scripted seeds 2 and 7: a retrace that refuses the flooded stair: swim up it toward the way in while each pulse gains height', async () => {
	const bobbing = { x: -543.5, y: 37, z: -113.5, yaw: 0, health: 20, inWater: true, underWater: true, air: 290, maxAir: 300, skyOpen: false };
	const refused = { result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen way on toward the target, and building cannot continue: water at -542,37,-113' } };
	const body = fakeBody({ start: sample({ player: bobbing }), frontier: { candidates: [], coverage: { headings: {} } },
		// Two pulses up with the eyes under water (40 air each), then along the surface of the half-flooded stair, then out.
		acts: { control: [...Array.from({ length: 6 }, () => ({ result: { state: 'SUCCEEDED' } })),
			...Array.from({ length: 8 }, (_, i) => ({ result: { state: 'SUCCEEDED' }, move: (player) => {
				if (i < 2) return { y: player.y + 2, air: player.air - 40 };
				return i < 7 ? { y: player.y + 4, air: 300, underWater: false } : { y: player.y + 1, inWater: false, underWater: false, skyOpen: true };
			} }))],
			travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Could not get out of the water in 30 s' } }, refused],
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -520,20,-100, 3 blocks away' } }] } });
	body.openSky = () => ({ x: -530.5, y: 72, z: -100.5 });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const swims = body.calls.filter((call) => call.actionType === 'control' && call.args.forward === 1);
	assert.equal(swims.length, 8, 'pulses until out of the water');
	assert.ok(swims.every((call) => call.args.jump === true && Math.abs(call.args.yaw - Math.atan2(-13, 13) * 180 / Math.PI) < 1), 'toward the way in');
	const stuck = fakeBody({ start: sample({ player: bobbing }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { control: Array.from({ length: 40 }, () => ({ result: { state: 'SUCCEEDED' } })), travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE' } }, refused] } });
	stuck.openSky = () => ({ x: -530.5, y: 72, z: -100.5 });
	await searchFor({ block: 'minecraft:iron_ore' }, stuck);
	assert.equal(stuck.calls.filter((call) => call.actionType === 'control' && call.args.forward === 1 && call.args.pitch === -30).length, 2);
});

test('review of 0eec2a67: the stair swim up a rising flooded passage turns back to its last breath before the air runs out', async () => {
	const bobbing = { x: -543.5, y: 37, z: -113.5, yaw: 0, health: 20, inWater: true, underWater: true, air: 290, maxAir: 300, skyOpen: false };
	const refused = { result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen way on toward the target, and building cannot continue: water at -542,37,-113' } };
	// Each pulse with the eyes under water spends 40 air. The passage rises a block a pulse for 20 blocks under a ceiling,
	// no air in it; the bobbing spot it started from is where the body breathes.
	let lowest = bobbing.air;
	const pulse = (player, args) => {
		if (args.forward !== 1 && args.sneak !== true) return {};
		const y = player.y + (args.sneak === true ? -1 : args.jump === true && player.y < bobbing.y + 20 ? 1 : 0);
		const air = y <= bobbing.y ? 300 : player.air - 40;
		lowest = Math.min(lowest, air);
		return { y, air, underWater: y > bobbing.y || args.sneak !== true };
	};
	const body = fakeBody({ start: sample({ player: bobbing }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { control: Array.from({ length: 60 }, () => ({ result: { state: 'SUCCEEDED' }, ms: 2_000, move: pulse })),
			travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Could not get out of the water in 30 s' } }, refused],
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -520,20,-100, 3 blocks away' } }] } });
	body.openSky = () => ({ x: -530.5, y: 72, z: -100.5 });
	await searchFor({ block: 'minecraft:iron_ore' }, body);
	const swims = body.calls.filter((call) => call.actionType === 'control' && call.args.forward === 1 && call.args.jump === true);
	assert.ok(swims.length >= 1 && swims.length <= 3, `up while the air covers the way back: ${swims.length} pulses`);
	assert.ok(body.calls.some((call) => call.actionType === 'control' && call.args.sneak === true), 'then back down to the last breath');
	assert.ok(lowest > 0, `never out of air: lowest ${lowest}`);
});

// A flooded passage up from the bobbing spot (where the body breathes): each pulse with the eyes under water spends 40
// air; a swim pulse rises `rise` blocks while the passage goes on up (`top` blocks over the bobbing spot), a sinking one
// drops as much. No air anywhere in it.
function floodedPassage({ rise, top, sky }) {
	const bobbing = { x: -543.5, y: 37, z: -113.5, yaw: 0, health: 20, inWater: true, underWater: true, air: 290, maxAir: 300, skyOpen: false };
	const refused = { result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen way on toward the target, and building cannot continue: water at -542,37,-113' } };
	const trace = { lowest: bobbing.air };
	const pulse = (player, args) => {
		if (args.forward !== 1 && args.sneak !== true) return {};
		const y = args.sneak === true ? Math.max(bobbing.y, player.y - rise) : args.jump === true ? Math.min(bobbing.y + top, player.y + rise) : player.y;
		const air = y <= bobbing.y ? 300 : player.air - 40;
		trace.lowest = Math.min(trace.lowest, air);
		return { y, air, underWater: y > bobbing.y || args.sneak !== true };
	};
	const body = fakeBody({ start: sample({ player: bobbing }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { control: Array.from({ length: 60 }, () => ({ result: { state: 'SUCCEEDED' }, ms: 2_000, move: pulse })),
			travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Could not get out of the water in 30 s' } }, refused],
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -520,20,-100, 3 blocks away' } }] } });
	body.openSky = () => ({ x: -530.5, y: bobbing.y + sky, z: -100.5 });
	return { body, trace, bobbing };
}

test('review of 0e415936: the stair swim bets no air on the sky spot\'s height; it turns back while the air still covers the way down', async () => {
	// The sky spot 4-6 blocks up and the passage rising 1.5-2 blocks a pulse: before, the swim pressed on past the sky
	// spot's height still under water, to air 10, then sank back to air -230.
	for (const sky of [4, 5, 6]) for (const rise of [1.5, 2]) {
		const { body, trace } = floodedPassage({ rise, top: 40, sky });
		await searchFor({ block: 'minecraft:iron_ore' }, body);
		const swims = body.calls.filter((call) => call.actionType === 'control' && call.args.forward === 1 && call.args.jump === true);
		assert.ok(swims.length >= 1 && swims.length <= 3, `sky +${sky}, rise ${rise}: up while the air covers the way back: ${swims.length} pulses`);
		assert.ok(body.calls.some((call) => call.actionType === 'control' && call.args.sneak === true), `sky +${sky}, rise ${rise}: then back down to the last breath`);
		assert.ok(trace.lowest > 0, `sky +${sky}, rise ${rise}: never out of air: lowest ${trace.lowest}`);
		assert.equal(body.calls.some((call) => call.actionType === 'break_block'), false, 'no cut below a flooded roof');
	}
});

test('review of 0e415936: a stair swim that stalls under water goes back down to its last breath, not a hand-back drowning', async () => {
	// The passage rises one pulse and meets a ceiling: two more pulses gain nothing and the swim ends with the eyes under
	// water at air 170. Before, the swim stopped there and the search handed back FIND_DANGER.
	const { body, trace } = floodedPassage({ rise: 2, top: 2, sky: 35 });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.notEqual(result.reasonCode, 'FIND_DANGER', result.message);
	assert.ok(body.calls.some((call) => call.actionType === 'control' && call.args.sneak === true), 'back down to the last breath');
	assert.ok(trace.lowest > 0, `never out of air: lowest ${trace.lowest}`);
	assert.equal(body.calls.some((call) => call.actionType === 'break_block'), false, 'last breath below the roof, no step cut');
});

test('local scripted seed 2: an ore the caller could not reach, and the rest of its vein, are no sighting for the next search', async () => {
	const seen = { state: 'SUCCEEDED', survey: { veins: [{ blockId: 'minecraft:iron_ore', x: -527, y: 37, z: -27 }] } };
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [seen, seen],
		acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -527,37,-28, 4 blocks away' } },
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 30,16,9, 3 blocks away' } }] } });
	body.missedPlaces = () => [{ x: -526, y: 38, z: -26, why: 'unreachable' }];
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.deepEqual([result.find.seen.x, result.find.seen.z], [30, 9], 'the unreachable vein, seen by survey and by a dig, is passed over');
});

test('review of e247fdec: a vein near one out of reach but not joined to it is a sighting', async () => {
	const iron = findProfile({ block: 'minecraft:iron_ore' });
	const out = [{ x: 10, y: 20, z: 0 }];
	const exclude = (rows) => sameVein(out, rows);
	const view = (cells) => sample({ player: { x: 0.5, y: 20, z: 0.5, yaw: 0, health: 20 }, blocks: cells.map(([x, y, z]) => ({ blockId: 'minecraft:iron_ore', x, y, z })) });
	assert.equal(sightingOf(iron, view([[10, 20, 0], [10, 21, 1], [11, 22, 2]]), null, exclude), null, 'the vein and every cell joined to it');
	assert.deepEqual(sightingOf(iron, view([[10, 20, 0], [10, 20, 4]]), null, exclude)?.z, 4, 'a separate vein 4 blocks away, no ore between');
});

test('local scripted seeds 1 and 7: a cave system\'s openings are walked into at most 8 times in a search, then it tunnels on', async () => {
	const openings = Array.from({ length: 30 }, (_, i) => ({ x: i * 7, y: 16, z: 0, air: 30 }));
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 16, z: 0.5, yaw: 0, health: 20, skyOpen: false } }), frontier: { candidates: [], coverage: { headings: {} } },
		looks: Array.from({ length: 40 }, () => ({ state: 'SUCCEEDED', survey: { caves: openings } })),
		acts: { travel_to: Array.from({ length: 40 }, () => ({ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player, args) => ({ x: args.x, z: args.z }) })),
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 300,20,9, 3 blocks away' } }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.equal(body.calls.filter((call) => call.actionType === 'travel_to').length, 8);
});

test('farm seed 1: the stair swim heads for the retrace\'s next waypoint, not the sky spot the stair turned away from', async () => {
	const bobbing = { x: -6.7, y: 44, z: -41.7, yaw: 0, health: 20, inWater: true, underWater: true, air: 298, maxAir: 300, skyOpen: false };
	const refused = { result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Retrace 1/12 toward Point[dimension=minecraft:overworld, x=-8, y=46, z=-43]: Could not get out of the water in 30 s' } };
	const body = fakeBody({ start: sample({ player: bobbing }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { control: [...Array.from({ length: 6 }, () => ({ result: { state: 'SUCCEEDED' } })),
			{ result: { state: 'SUCCEEDED' }, move: () => ({ x: -7.5, y: 46, z: -42.5, inWater: false, underWater: false }) }],
			travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Could not get out of the water in 30 s' } }, refused],
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at -20,16,-60, 3 blocks away' } }] } });
	body.openSky = () => ({ x: -7.5, y: 70, z: -30.5 });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const swim = body.calls.find((call) => call.actionType === 'control' && call.args.forward === 1);
	const expected = Math.atan2(-(-7.5 - -6.7), -42.5 - -41.7) * 180 / Math.PI;
	assert.ok(Math.abs(swim.args.yaw - expected) < 1, `toward -8,46,-43 (yaw ${expected.toFixed(0)}), not south to the sky spot: ${swim.args.yaw}`);
});

test('kit chain: a worn pickaxe with a spare off the hotbar swaps it in and digs on, then hands back once none is left', async () => {
	const worn = { state: 'FAILED', reasonCode: 'TOOL_WORN', message: 'Stopped: Every hotbar tool for minecraft:deepslate has 2 or fewer uses left.' };
	const body = fakeBody({
		start: sample({ inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:iron_pickaxe', count: 1, slot: 0, maxDamage: 250, damage: 249 }, { itemId: 'minecraft:stone_pickaxe', count: 1, slot: 14, maxDamage: 131, damage: 0 }] } }),
		frontier: { candidates: [], coverage: { headings: { N: [50, 50], E: [0, 0] } } },
		acts: {
			dig_to: [{ result: worn }, { result: worn }],
			select_tool: [{ then: { inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_pickaxe', count: 1, slot: 0, maxDamage: 131, damage: 0 }, { itemId: 'minecraft:iron_pickaxe', count: 1, slot: 14, maxDamage: 250, damage: 249 }] } }, result: { state: 'SUCCEEDED' } }],
		},
	});
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	const swap = body.calls.find((call) => call.actionType === 'select_tool');
	assert.deepEqual(swap?.args, { sourceSlot: 14, hotbarSlot: 0, expectedItemId: 'minecraft:stone_pickaxe', minRemainingDurability: 3 });
	assert.equal(body.calls.filter((call) => call.actionType === 'dig_to').length, 2, 'dug again after the swap');
	assert.equal(result.reasonCode, 'FIND_BLOCKED', 'no spare left the second time');
});

test('scripted gate seed 3: flowing lava in sight is no lava sighting; a source is', () => {
	const profile = findProfile({ block: 'minecraft:lava' });
	const row = (level) => ({ blockId: 'minecraft:lava', x: 3, y: -12, z: 1, state: { level } });
	assert.equal(sightingOf(profile, sample({ player: { x: 0.5, y: -11, z: 0.5 }, blocks: [row('4')] })), null);
	assert.equal(sightingOf(profile, sample({ player: { x: 0.5, y: -11, z: 0.5 }, blocks: [row('0')] }))?.id, 'minecraft:lava');
});

// Water from under cover (lane: water from underground). Local scripted seed 7 from y56 on main 0c689437: nine 80-block
// surface legs in a row ended NO_ROUTE at once in the body's own stair.
test('water sought from under cover: after the look, back up the way the body came, and the walking legs only from open sky', async () => {
	const under = sample({ player: { x: 0.5, y: 16, z: 0.5, yaw: 0, health: 20, skyOpen: false, heard: [] } });
	const body = fakeBody({ start: under, acts: {
		travel_to: [
			{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: -5.5, y: 70, z: 0.5, skyOpen: true }) },
			{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, then: { blocks: [{ blockId: 'minecraft:water', x: 30, y: 62, z: 0, state: { level: '0' } }] } },
		],
	} });
	body.openSky = () => ({ x: -5.5, y: 70, z: 0.5 });
	const result = await searchFor({ block: 'minecraft:water' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const moves = body.calls.filter((row) => row.actionType);
	assert.deepEqual(moves[0].args, { x: -5.5, y: 70, z: 0.5, retrace: true, tolerance: 3, stopWhenSeen: 'minecraft:water', boundaryX: 0.5, boundaryZ: 0.5, boundaryRadius: 512, timeoutMs: 298_000 });
	assert.ok(moves.every((row) => row.actionType !== 'dig_to'), 'no stair dug: the way back was walked');
	assert.ok(body.calls.findIndex((row) => row.look !== undefined) < body.calls.findIndex((row) => row.actionType), 'looked round before leaving');
});

test('water sought from under cover: a retrace that stops short is passed by a short stair up, then taken again', async () => {
	const under = sample({ player: { x: 0.5, y: 16, z: 0.5, yaw: 0, health: 20, skyOpen: false, heard: [] } });
	const body = fakeBody({ start: under, acts: {
		travel_to: [
			{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Retrace 7/61: Remembered shaft has blocked or unseen headroom above' }, move: (p) => ({ y: p.y + 4 }) },
			{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: -5.5, y: 70, z: 0.5, skyOpen: true }) },
		],
		dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'DIG_GOAL_REACHED' }, move: (p) => ({ y: p.y + 8 }) }],
	} });
	body.openSky = () => ({ x: -5.5, y: 70, z: 0.5 });
	await searchFor({ block: 'minecraft:water' }, body, { timeoutMs: 300_000 });
	const moves = body.calls.filter((row) => row.actionType).map((row) => `${row.actionType}${row.args.retrace ? ' retrace' : ''}${row.args.pattern ? ` ${row.args.pattern} y${row.args.y}` : ''}`);
	assert.deepEqual(moves.slice(0, 3), ['travel_to retrace', 'dig_to stairs_up y28', 'travel_to retrace']);
	assert.equal(body.calls.find((row) => row.actionType === 'dig_to').args.stopWhenSeen, 'minecraft:water');
});

test('water sought from under cover: back at the open-sky spot under leaves, no stair is dug up into the tree', async () => {
	const under = sample({ player: { x: 0.5, y: 16, z: 0.5, yaw: 0, health: 20, skyOpen: false, heard: [] } });
	const body = fakeBody({ start: under, acts: {
		travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: -3.5, y: 70, z: 1.5, skyOpen: false }) }],
	} });
	body.openSky = () => ({ x: -5.5, y: 70, z: 0.5 });
	await searchFor({ block: 'minecraft:water' }, body, { timeoutMs: 120_000 });
	assert.ok(!body.calls.some((row) => row.actionType === 'dig_to'), JSON.stringify(body.calls.filter((row) => row.actionType).map((row) => row.args)));
});

test('water heard but not seen from under cover: a look toward it first, and what it shows is the sighting', async () => {
	const under = sample({ player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20, skyOpen: false,
		heard: [{ sound: 'block.water.ambient', direction: 'right', elevation: 'below', distance: 6 }] } });
	const body = fakeBody({ start: under, acts: {
		look_at: [{ result: { state: 'SUCCEEDED' }, then: { blocks: [{ blockId: 'minecraft:water', x: -5, y: -57, z: 0, state: { level: '0' } }] } }],
	} });
	body.openSky = () => ({ x: -5.5, y: 70, z: 0.5 });
	const result = await searchFor({ block: 'minecraft:water' }, body, { timeoutMs: 120_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const looked = body.calls.find((row) => row.actionType === 'look_at');
	assert.ok(looked.args.x < 0 && looked.args.y < -54 + 1.62, `toward the right (west at yaw 0) and down: ${JSON.stringify(looked.args)}`);
	assert.ok(!body.calls.some((row) => row.actionType === 'travel_to'), 'no climb: water is near below');
});

test('flowing water is no sighting for a water search: a bucket takes a source', () => {
	const water = findProfile({ block: 'minecraft:water' });
	assert.equal(sightingOf(water, sample({ blocks: [{ blockId: 'minecraft:water', x: 3, y: 68, z: 0, state: { level: '3' } }] })), null);
	assert.equal(sightingOf(water, sample({ blocks: [{ blockId: 'minecraft:water', x: 3, y: 68, z: 0, state: { level: '0' } }] })).via, 'sight');
});

// Batch 4, laptop seeds 3 and 6: a cave's flowing water seen only as landmarks (no level) stopped every water search,
// and each fill aimed there met the rock behind it.
test('a water landmark near the body is no sighting (it has no level); a far one still is', () => {
	const water = findProfile({ block: 'minecraft:water' });
	assert.equal(sightingOf(water, sample({ landmarks: [{ blockId: 'minecraft:water', x: 8, y: 66, z: 3 }] })), null);
	assert.equal(sightingOf(water, sample({ landmarks: [{ blockId: 'minecraft:water', x: 60, y: 62, z: 0 }] })).via, 'sight');
	assert.equal(sightingOf(water, sample({ blocks: [{ blockId: 'minecraft:water', x: 8, y: 66, z: 3, state: { level: '0' } }] })).via, 'sight');
});

test('water remembered near the way up: walked to before the rest of the climb, never dug to', async () => {
	const under = sample({ player: { x: 0.5, y: -54, z: 0.5, yaw: 0, health: 20, skyOpen: false, heard: [] } });
	const body = fakeBody({ start: under, acts: {
		travel_to: [
			{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Retrace 23/68: Stalled here again' }, move: () => ({ x: 11.5, y: -11, z: 20.5 }) },
			{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, then: { blocks: [{ blockId: 'minecraft:water', x: 10, y: -7, z: 32, state: { level: '0' } }] } },
		],
	} });
	body.openSky = () => ({ x: 16.5, y: 67, z: -44.5 });
	const water = { blockId: 'minecraft:water', x: 10, y: -7, z: 32 };
	body.known = (observation, pattern) => (pattern?.test('minecraft:water') ? { blocks: [water], sightings: [] } : { blocks: [], sightings: [] });
	const result = await searchFor({ block: 'minecraft:water' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const moves = body.calls.filter((row) => row.actionType);
	assert.equal(moves.length, 2, JSON.stringify(moves));
	assert.equal(moves[0].args.retrace, true, 'from y-54 the water 73 blocks off is not near: up first');
	assert.deepEqual({ x: moves[1].args.x, y: moves[1].args.y, z: moves[1].args.z, build: moves[1].args.build }, { x: 10.5, y: -6, z: 32.5, build: false });
});

test('review of PR #197: water a walk could not reach goes out of the sightings as that spot only, not the whole lake joined to it', async () => {
	// A lake 12 cells long, every cell touching the next; the walk to its near end (10,62,0) failed.
	const lake = Array.from({ length: 12 }, (_, i) => ({ blockId: 'minecraft:water', x: 10 + i, y: 62, z: 0, state: { level: '0' } }));
	const spot = await searchFor({ block: 'minecraft:water' }, Object.assign(fakeBody({ start: sample({ blocks: lake }) }), { missedPlaces: () => [{ x: 10, y: 62, z: 0, why: UNREACHED_SPOT }] }));
	assert.equal(spot.reasonCode, 'FIND_SEEN', spot.message);
	assert.equal(spot.find.seen.x, 14, 'the nearest cell more than 3 blocks from the missed spot');
	// An ore vein the caller could not reach still takes its whole vein out.
	const vein = await searchFor({ block: 'minecraft:water' }, Object.assign(fakeBody({ start: sample({ blocks: lake }), acts: { travel_to: Array.from({ length: 40 }, () => ({ result: { state: 'FAILED', reasonCode: 'NO_ROUTE' } })) } }),
		{ missedPlaces: () => [{ x: 10, y: 62, z: 0, why: UNREACHED }] }), { timeoutMs: 20_000 });
	assert.notEqual(vein.reasonCode, 'FIND_SEEN', 'with UNREACHED the joined cells are no sighting');
});

test('script-first r2 seed 8: a block obtain gave up on is no sighting of that block, and hides nothing of another', async () => {
	// Gravel in a pocket by a pool: obtain's gather failed at 10,62,0. A gravel search passes it and the gravel joined to it;
	// a water search still sees the pool touching it.
	const blocks = [{ blockId: 'minecraft:gravel', x: 10, y: 62, z: 0 }, { blockId: 'minecraft:gravel', x: 10, y: 62, z: 1 },
		{ blockId: 'minecraft:water', x: 11, y: 62, z: 0, state: { level: '0' } }, { blockId: 'minecraft:gravel', x: 20, y: 62, z: 0 }];
	const mark = [{ x: 10, y: 62, z: 0, why: UNREACHED, blockId: 'minecraft:gravel' }];
	const gravel = await searchFor({ block: 'minecraft:gravel' }, Object.assign(fakeBody({ start: sample({ blocks }) }), { missedPlaces: () => mark }));
	assert.equal(gravel.reasonCode, 'FIND_SEEN', gravel.message);
	assert.equal(gravel.find.seen.x, 20, 'the gravel away from the pocket');
	const water = await searchFor({ block: 'minecraft:water' }, Object.assign(fakeBody({ start: sample({ blocks }) }), { missedPlaces: () => mark }));
	assert.equal(water.reasonCode, 'FIND_SEEN', water.message);
	assert.deepEqual([water.find.seen.x, water.find.seen.z], [11, 0], 'the pool beside it is still water');
});

test('review of PR #197: remembered flowing water is never a trip; the nearest remembered source is', async () => {
	const under = sample({ player: { x: 0.5, y: 10, z: 0.5, yaw: 0, health: 20, skyOpen: false, heard: [] } });
	const body = fakeBody({ start: under, acts: { travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, then: { blocks: [{ blockId: 'minecraft:water', x: 12, y: 9, z: 0, state: { level: '0' } }] } }] } });
	body.openSky = () => ({ x: 0.5, y: 70, z: 0.5 });
	const spill = { blockId: 'minecraft:water', x: 2, y: 9, z: 0, blockState: '{"falling":"true","level":"8"}' };
	const pool = { blockId: 'minecraft:water', x: 12, y: 9, z: 0, blockState: '{"level":"0"}' };
	body.known = (observation, pattern) => (pattern?.test('minecraft:water') ? { blocks: [spill, pool], sightings: [] } : { blocks: [], sightings: [] });
	const result = await searchFor({ block: 'minecraft:water' }, body, { timeoutMs: 300_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const trip = body.calls.find((row) => row.actionType === 'travel_to');
	assert.deepEqual([trip.args.x, trip.args.z], [12.5, 0.5], 'to the source, not the spill 2 blocks off');
});


test('water spot exclusion leaves fresh nearby iron visible', async () => {
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 16, z: 0.5, health: 20, skyOpen: false }, blocks: [{ blockId: 'minecraft:iron_ore', x: 2, y: 16, z: 0 }] }) });
	body.missedPlaces = () => [{ x: 3, y: 16, z: 0, why: UNREACHED_SPOT }];
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body, { timeoutMs: 10_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(result.find.seen.x, 2);
	assert.equal(body.calls.length, 0);
});

for (const sky of [null, { x: 100.5, y: 70, z: 0.5 }]) test(`water within 16 rejects distant retrace and bounds stairs: ${sky !== null}`, async () => {
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 16, z: 0.5, health: 20, skyOpen: false } }), acts: { dig_to: [{ result: { state: 'FAILED', reasonCode: 'SEARCH_BOUNDARY' } }] } });
	body.openSky = () => sky;
	body.known = (o, pattern) => ({ blocks: pattern?.test('minecraft:water') ? [{ blockId: 'minecraft:water', x: 20, y: 16, z: 0, blockState: '{"level":"0"}' }] : [] });
	const result = await searchFor({ block: 'minecraft:water' }, body, { within: 16, timeoutMs: 62_000 });
	const moves = body.calls.filter(row => row.actionType);
	assert.equal(moves.length, 1);
	assert.equal(moves[0].actionType, 'dig_to');
	assert.ok(moves[0].args.y <= 30, 'stairs reserve braking room within 16 horizontal steps');
	assert.deepEqual([moves[0].args.boundaryX, moves[0].args.boundaryZ, moves[0].args.boundaryRadius], [0.5, 0.5, 16]);
	assert.equal(result.reasonCode, 'FIND_NOT_FOUND');
});

test('water retrace to a nearby destination keeps the original boundary for intermediate detours', async () => {
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 16, z: 0.5, health: 20, skyOpen: false } }), acts: { travel_to: [{ result: { state: 'FAILED', reasonCode: 'SEARCH_BOUNDARY' } }] } });
	body.openSky = () => ({ x: 4.5, y: 70, z: 0.5 });
	const result = await searchFor({ block: 'minecraft:water' }, body, { within: 16, timeoutMs: 62_000 });
	assert.equal(result.reasonCode, 'FIND_NOT_FOUND');
	assert.equal(body.calls.filter(row => row.actionType).length, 1);
	assert.equal(body.calls.find(row => row.actionType).args.boundaryRadius, 16);
});


test('water spot exclusion leaves remembered nearby iron eligible for an approach too', async () => {
	const body = fakeBody({ start: sample({ player: { x: 0.5, y: 16, z: 0.5, health: 20, skyOpen: false } }), known: { blocks: [{ blockId: 'minecraft:iron_ore', x: 2, y: 16, z: 0 }] }, acts: { travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 2,16,0, 2 blocks away' } }] } });
	body.missedPlaces = () => [{ x: 3, y: 16, z: 0, why: UNREACHED_SPOT }];
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body, { timeoutMs: 10_000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(body.calls.find(row => row.actionType).args.x, 2.5);
});

const creeperUuid = '5f0c1a2b-3c4d-4e5f-8a9b-0c1d2e3f4a5b';
const creeperStop = { result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: `HOSTILE_NEAR minecraft:creeper ${creeperUuid} 7.8 blocks away at 0,50,-7` } };
const underground = (items, extra = {}) => sample({ player: { x: 0.5, y: 50, z: 0.5, yaw: 0, health: 20, skyOpen: false }, inventory: { items: [...items, { itemId: 'minecraft:cobblestone', count: 20 }] }, ...extra });

test('a creeper fork 7.8 blocks away hands back at once with its uuid, never walled in beside it', async () => {
	const body = fakeBody({
		start: underground([{ itemId: 'minecraft:stone_sword', count: 1 }], { threats: { entries: [{ type: 'minecraft:creeper', uuid: creeperUuid, distance: 7.8 }] } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [creeperStop], build_shelter: [{ result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } }] },
	});
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.equal(body.calls.some((call) => call.actionType === 'build_shelter'), false);
	assert.match(result.message, new RegExp(`minecraft:creeper ${creeperUuid}`));
	assert.doesNotMatch(result.message, /walled in/);
});

test('a sidestep underground from a creeper never walls in: unarmed it hands back, armed it walks away', async () => {
	const creeper = { type: 'minecraft:creeper', hostile: true, stableId: creeperUuid, x: 0.5, y: 50, z: -7 };
	const bare = fakeBody({ start: underground([], { entities: [creeper] }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [creeperStop], build_shelter: [{ result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } }] } });
	const handed = await searchFor({ block: 'minecraft:iron_ore' }, bare);
	assert.equal(handed.reasonCode, 'FIND_DANGER');
	assert.match(handed.message, new RegExp(`minecraft:creeper ${creeperUuid}`));
	assert.equal(bare.calls.some((call) => call.actionType === 'build_shelter'), false);

	const armed = fakeBody({ start: underground([{ itemId: 'minecraft:stone_sword', count: 1 }], { entities: [creeper] }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [creeperStop, { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,30,9, 6 blocks away' } }],
			travel_to: [{ move: (player, args) => ({ z: player.z + args.distance }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }] } });
	assert.equal((await searchFor({ block: 'minecraft:iron_ore' }, armed)).reasonCode, 'FIND_SEEN');
	assert.equal(armed.calls.some((call) => call.actionType === 'build_shelter'), false);
	assert.equal(armed.calls.find((call) => call.actionType === 'travel_to').args.yaw, 0, 'south, away from the creeper to the north');
});

test('batch 2 chain-gate-6-r2: no walls with a creeper 11.3 blocks away either (it closes in during the build)', async () => {
	const far = { result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: `Stopped: minecraft:creeper ${creeperUuid} at -424,12,696, 11.3 blocks away.` } };
	const body = fakeBody({ start: underground([], { entities: [{ type: 'minecraft:creeper', hostile: true, stableId: creeperUuid, x: 0.5, y: 50, z: -10.8 }] }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [far], build_shelter: [{ result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(body.calls.some((call) => call.actionType === 'build_shelter'), false);
	assert.equal(result.reasonCode, 'FIND_DANGER');
});

test('a zombie the body cannot fight underground is still walled off as before', async () => {
	const body = fakeBody({ start: underground([], { entities: [{ type: 'minecraft:zombie', hostile: true, stableId: 'z', x: 0.5, y: 50, z: -7 }] }),
		frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:zombie z at 0,50,-7, 7.5 blocks away.' } },
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,30,9, 6 blocks away' } }],
		build_shelter: [{ result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } }] } });
	assert.equal((await searchFor({ block: 'minecraft:iron_ore' }, body)).reasonCode, 'FIND_SEEN');
	assert.equal(body.calls.find((call) => call.actionType === 'build_shelter').args.opening, 'south');
});

test('round 1 seed 3: a sighting with a creeper close by hands the danger back, not the sighting', async () => {
	// Travel stopped HOSTILE_NEAR for a creeper 4.1 blocks off with the target in view; FIND_SEEN sent obtain past it.
	const id = '3c1d2e4f-5a6b-4c7d-8e9f-0a1b2c3d4e5f';
	const stopped = (threats) => ({ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: `minecraft:${threats[0].type.slice(10)} ${id} ${threats[0].distance} blocks away at 4.6,70.0,0.5` },
		then: { player: { x: 0.5, y: 70, z: 0.5, yaw: 0, health: 20, threats }, blocks: [{ blockId: 'minecraft:oak_log', x: 9, y: 70, z: 0 }] } });
	const run = async (threats) => {
		const start = sample();
		start.player.threats = [];
		const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } }, acts: { travel_to: [stopped(threats)] } });
		return searchFor({ block: 'minecraft:oak_log' }, body);
	};
	const close = await run([{ uuid: id, type: 'minecraft:creeper', distance: 4.1, lineOfSight: true }]);
	assert.equal(close.reasonCode, 'FIND_DANGER', close.message);
	assert.match(close.message, new RegExp(`a creeper 4 blocks away \\(HOSTILE_NEAR\\).*minecraft:creeper ${id}.*also seen: oak_log`));
	assert.ok(close.find.seen, 'the sighting goes back with the danger');
	// A mob the search would not hand to the model (a zombie 14 blocks off, behind rock) keeps the sighting.
	const far = await run([{ uuid: id, type: 'minecraft:zombie', distance: 14, targeting: true, signals: ['targeting'] }]);
	assert.equal(far.reasonCode, 'FIND_SEEN', far.message);
});

test('batch 1 r5 seeds 3 and 6: the walk off water under a lava dig goes where the look saw land, not out over the lake', async () => {
	// On the lake's edge at y65 with a water bucket: the dig meets the lake under the body; south and east are open water.
	const ground = [{ yaw: 0, water: 9, land: 0, farthestLand: 0 }, { yaw: -90, water: 6, land: 0, farthestLand: 0 }, { yaw: 90, water: 0, land: 7, farthestLand: 40 }, { yaw: 180, water: 1, land: 3, farthestLand: 20 }];
	const start = sample({ player: { x: 174.5, y: 65, z: -185.5, yaw: 0, health: 20, skyOpen: true },
		inventory: { items: [{ itemId: 'minecraft:water_bucket', count: 1 }, { itemId: 'minecraft:iron_pickaxe', count: 1 }] } });
	const run = async (looks) => {
		const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } }, looks,
			acts: { dig_to: [{ result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: Water at 174,62,-186 beside the opened cell 174,63,-186; water on 5 sides of it: a body of water (an aquifer or lake), not a trickle; not going further' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 140,-54,-180, 9 blocks away' } }],
				travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (player, args) => ({ x: player.x - Math.sin(args.yaw * Math.PI / 180) * 32, z: player.z + Math.cos(args.yaw * Math.PI / 180) * 32 }) }] } });
		const result = await searchFor({ block: 'minecraft:lava' }, body);
		assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
		return body.calls.find((call) => call.actionType === 'travel_to').args.yaw;
	};
	assert.equal(await run([{ state: 'SUCCEEDED', survey: {}, ground }]), 90, 'west, where the look saw land, not south (away from the water named) over the lake');
	assert.equal(await run([]), 0, 'no look ground: away from the water named, as before');
});

test('batch 1 r5 seed 3: a lava dig near water met under an earlier dig down takes the stair, not the 1-wide shaft it cannot climb out of when it floods', async (t) => {
	process.env.MINEAGEN_LAVA_STAIRS = 'on';
	t.after(() => { delete process.env.MINEAGEN_LAVA_STAIRS; });
	const start = sample({ player: { x: 249.5, y: 67, z: -217.5, yaw: 0, health: 20, skyOpen: true },
		inventory: { items: [{ itemId: 'minecraft:water_bucket', count: 1 }, { itemId: 'minecraft:iron_pickaxe', count: 1 }] } });
	const run = async (wetSpots) => {
		const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } },
			acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 249,-54,-200, 9 blocks away' } }] } });
		body.missedPlaces = () => wetSpots;
		await searchFor({ block: 'minecraft:lava' }, body);
		return body.calls.find((call) => call.actionType === 'dig_to').args.pattern;
	};
	// Two wet spots from the search before, 30 blocks west: the same aquifer region.
	assert.equal(await run([{ x: 219, y: 65, z: -219, why: 'water under a dig down' }, { x: 219, y: 65, z: -209, why: 'water under a dig down' }]), 'steep_down');
	assert.equal(await run([{ x: 100, y: 65, z: -219, why: 'water under a dig down' }]), 'steep_down', 'a lava find digs stairs, water met or not');
	assert.equal(await run([]), 'steep_down', 'no water met: stairs, not the bucket shaft');
	// Stairs off (the default): the bucket shaft.
	delete process.env.MINEAGEN_LAVA_STAIRS;
	try {
		assert.equal(await run([{ x: 100, y: 65, z: -219, why: 'water under a dig down' }]), 'shaft', 'stairs off: water met far off says nothing of the ground here');
		assert.equal(await run([]), 'shaft', 'stairs off: no water met, the bucket shaft as before');
	} finally { process.env.MINEAGEN_LAVA_STAIRS = 'on'; }
});

test('lava-gate-1 and -8: a lava find from spawn digs stairs down, never the 1-wide shaft that flooded or dropped it into a mob cave', async (t) => {
	process.env.MINEAGEN_LAVA_STAIRS = 'on';
	t.after(() => { delete process.env.MINEAGEN_LAVA_STAIRS; });
	const start = sample({ player: { x: 16.5, y: 70, z: -47.5, yaw: 0, health: 20, skyOpen: true },
		inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:water_bucket', count: 1 }, { itemId: 'minecraft:cobblestone', count: 16 }] } });
	const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 20,-54,-40, 6 blocks away' } }] } });
	await searchFor({ block: 'minecraft:lava' }, body);
	const digs = body.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args.pattern);
	assert.deepEqual(digs, ['steep_down']);
	// An ore find keeps the bucket shaft: only the lava descent changed.
	const ore = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 20,16,-40, 4 blocks away' } }] } });
	await searchFor({ block: 'minecraft:iron_ore' }, ore);
	assert.equal(ore.calls.find((call) => call.actionType === 'dig_to')?.args.pattern, 'shaft');
});

test('batches 1-2: a lava shaft starts with the water bucket in the hotbar, so the dig cuts one column, not two', async () => {
	const run = async (items, selectedSlot = 0) => {
		const start = sample({ player: { x: 249.5, y: 67, z: -217.5, yaw: 0, health: 20, skyOpen: true }, inventory: { selectedSlot, items } });
		const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } },
			acts: { select_tool: [{ result: { state: 'SUCCEEDED', reasonCode: 'TOOL_SELECTED' } }],
				dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 249,-54,-200, 9 blocks away' } }] } });
		await searchFor({ block: 'minecraft:lava' }, body);
		const order = body.calls.map((call) => call.actionType).filter((type) => type === 'select_tool' || type === 'dig_to');
		return { order, select: body.calls.find((call) => call.actionType === 'select_tool')?.args };
	};
	// The pickaxe swap left the bucket in slot 14; hotbar 0 holds the pickaxe (held), 1 cobblestone, 2 empty.
	const off = await run([{ itemId: 'minecraft:iron_pickaxe', count: 1, slot: 'mainhand' }, { itemId: 'minecraft:cobblestone', count: 40, slot: 1 },
		{ itemId: 'minecraft:water_bucket', count: 1, slot: 14 }]);
	assert.deepEqual(off.order, ['select_tool', 'dig_to'], 'into the hotbar before the shaft');
	assert.deepEqual([off.select.sourceSlot, off.select.hotbarSlot, off.select.expectedItemId], [14, 2, 'minecraft:water_bucket'], 'an empty hotbar slot, never the held pickaxe');
	const on = await run([{ itemId: 'minecraft:iron_pickaxe', count: 1, slot: 'mainhand' }, { itemId: 'minecraft:water_bucket', count: 1, slot: 3 }]);
	assert.deepEqual(on.order, ['dig_to']);
});

function pinnedInFlood({ freedBy = null, breaks = [] } = {}) {
	const afloat = { x: -414.3, y: 59.7, z: -27.7, yaw: 180, health: 20, inWater: true, underWater: true, air: 298, maxAir: 300, skyOpen: false };
	const missed = [];
	const cut = new Set();
	const body = fakeBody({ start: sample({ player: afloat }), frontier: { candidates: [], coverage: { headings: {} } }, acts: {
		travel_to: Array.from({ length: 20 }, () => ({ result: { state: 'FAILED', reasonCode: 'NO_ROUTE',
			message: 'Retrace 3/8 toward Point[dimension=minecraft:overworld, x=-415, y=62, z=-30]: Could not get out of the water in 30 s; no dry footing seen within 10 blocks' }, ms: 30_000 })),
		break_block: [...breaks, ...Array.from({ length: 40 }, () => ({ result: { state: 'FAILED', reasonCode: 'TARGET_AIR' }, ms: 1_000 }))].map((row) => ({ ...row,
			move: (player, args) => { cut.add(`${args.x},${args.y},${args.z}`); return {}; } })),
		control: Array.from({ length: 80 }, () => ({ result: { state: 'SUCCEEDED' }, ms: 2_000,
			move: (player, args) => (freedBy !== null && cut.has(freedBy) && args.forward === 1 && args.pitch === 0
				? { x: -414.5, y: 60, z: -28.5, inWater: false, underWater: false } : {}) })),
		dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at -420,20,-40, 3 blocks away' } }],
	} });
	body.openSky = () => ({ x: -424.5, y: 63, z: -29.5 });
	body.missedPlaces = () => missed;
	body.missPlace = (place, why) => missed.push({ ...place, why });
	return { body, missed };
}

test('b8-desktop seed 2: pinned at the top of its own flooded stair under a ceiling, the lava search cuts a step out and digs on', async () => {
	// The ice over the head (-415,62,-28) stops the hop onto the lip north; with it broken the body climbs out.
	const { body } = pinnedInFlood({ freedBy: '-415,62,-28' });
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const breaks = body.calls.filter((call) => call.actionType === 'break_block').map((call) => `${call.args.x},${call.args.y},${call.args.z}`);
	assert.deepEqual(breaks.slice(0, 5), ['-415,60,-29', '-415,61,-29', '-415,62,-29', '-415,61,-28', '-415,62,-28'], 'the step ahead toward the way in (north), then over the head and the hop');
	assert.ok(body.calls.every((call) => call.actionType !== 'break_block' || call.args.acceptLavaRisk === undefined), 'lava check kept');
	const hop = body.calls.findLast((call) => call.actionType === 'control' && call.args.pitch === 0);
	assert.equal(hop.args.yaw, 180, 'onto the step north');
});

// b14-desktop seed 5: its own 1-wide shaft opened an aquifer; the shaft is dry from y63 down to the water's top at y51 and
// the floor is y47. Each jump pulse rises a block to the top; with bob, the eyes are under at every other sample there.
function sunkInShaft({ startY = 47.9, bob = false } = {}) {
	const TOP = 51.3;
	const cut = new Set();
	let out = false, pulses = 0;
	const start = { x: 480.7, y: startY, z: 139.5, yaw: 0, health: 20, inWater: true, underWater: startY < 51, air: 298, maxAir: 300, skyOpen: true };
	const body = fakeBody({ start: sample({ player: start }), frontier: { candidates: [], coverage: { headings: {} } }, acts: {
		travel_to: Array.from({ length: 20 }, () => ({ result: { state: 'FAILED', reasonCode: 'NO_ROUTE',
			message: 'Retrace 0/25 toward Point[dimension=minecraft:overworld, x=480, y=52, z=139]: In water with no bank seen within 10 blocks, and the way toward the target leaves the water over a drop of more than 3 blocks' }, ms: 2_000 })),
		break_block: Array.from({ length: 40 }, () => ({ result: { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' }, ms: 1_000,
			move: (player, args) => { cut.add(`${args.x},${args.y},${args.z}`); return {}; } })),
		control: Array.from({ length: 80 }, () => ({ result: { state: 'SUCCEEDED' }, ms: 2_000,
			move: (player, args) => {
				// The hop onto a cut step at the water's top: out of the water, a block up.
				if (args.forward === 1 && args.pitch === 0) { if (cut.size < 3 || player.y < 51) return {}; out = true; return { y: 52, z: player.z + 1, inWater: false, underWater: false }; }
				if (!args.jump) return { y: Math.max(47.9, player.y - 1), underWater: true };
				const y = Math.min(TOP, player.y + 1);
				pulses += 1;
				return { y, underWater: y < 51 || (bob && pulses % 2 === 0) };
			} })),
		// Every dig from the water is refused (dig_to's under-water check); from the step it digs on and sees the lava.
		dig_to: Array.from({ length: 30 }, () => ({ get result() { return out ? { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 470,-40,150, 3 blocks away' }
			: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: The body is under water at 480,48,139 (air 298/300); not digging on.' }; } })),
	} });
	body.openSky = () => ({ x: 480.5, y: 63, z: 139.5 });
	const missed = [];
	body.missedPlaces = () => missed;
	body.missPlace = (place, why) => missed.push({ ...place, why });
	return body;
}

for (const [label, options] of [['sunk at the floor', {}], ['afloat at the water\'s top (the step 1.3 blocks from where the move off began)', { startY: 51.3 }],
	['sunk, the eyes bobbing under at the top', { bob: true }], ['afloat at the top, bobbing', { startY: 51.3, bob: true }]]) {
	test(`b14-desktop seed 5: in its own shaft into an aquifer, ${label}: the swim stalls under the dry shaft and it cuts a step out at the water's top`, async () => {
		const body = sunkInShaft(options);
		const result = await searchFor({ block: 'minecraft:lava' }, body);
		const breaks = body.calls.filter((call) => call.actionType === 'break_block').map((call) => call.args);
		assert.ok(breaks.length >= 3, `a step cut out of the water (calls: ${body.calls.map((call) => call.actionType).join(',')}; ${result.reasonCode} ${result.message})`);
		assert.ok(breaks.every((args) => args.y >= 52), 'cut from the water\'s top (y51), not from the bottom of the shaft');
		assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	});
}


for (const reasonCode of ['LAVA_BEHIND', 'LOW_AIR', 'AIR_RESERVE_REACHED', 'BLOCK_PROTECTED']) {
	test(`water step keeps the body's ${reasonCode} refusal before any hop`, async () => {
		const { body } = pinnedInFlood({ breaks: [{ result: { state: 'FAILED', reasonCode }, ms: 1_000 }] });
		await searchFor({ block: 'minecraft:lava' }, body);
		const cut = body.calls.findIndex((call) => call.actionType === 'break_block');
		assert.ok(cut >= 0, 'reached guarded cut');
		assert.equal(body.calls.slice(cut + 1).some((call) => call.actionType === 'control' && call.args.pitch === 0), false, 'no hop after refusal');
		assert.equal(body.calls.filter((call) => call.actionType === 'break_block').length, 1, 'refusal stops cutting');
	});
}

test('water step stops cutting when the eyes submerge and air falls between cells', async () => {
	const { body } = pinnedInFlood({ breaks: [{ result: { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' }, ms: 1_000,
		then: { player: { x: -414.3, y: 59.7, z: -27.7, health: 20, inWater: true, underWater: true, air: 100, maxAir: 300 } } }] });
	await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(body.calls.filter((call) => call.actionType === 'break_block').length, 1);
	assert.equal(body.calls.some((call) => call.actionType === 'control' && call.args.pitch === 0), false);
});

test('b20 control wet iron dig: escape a bobbing flooded stair before retrying the same iron search', async () => {
	let dry = false, cuts = 0;
	const flooded = { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: The body is under water at -262,55,746 (air 298/300); not digging on' };
	const body = fakeBody({ start: sample({ player: { x: -261.7, y: 56.2, z: 746.4, health: 20, skyOpen: false,
		inWater: true, underWater: true, air: 298, maxAir: 300 }, inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }] } }),
		frontier: { candidates: [], coverage: { headings: {} } }, acts: {
			travel_to: { shift: () => ({ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Could not get out of the water in 30 s; no dry footing seen within 10 blocks' }, ms: 2_000 }) },
			dig_to: { shift: () => ({ result: dry ? { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN',
				seen: { x: -270, y: 16, z: 746, id: 'minecraft:iron_ore', via: 'dig_to', distance: 8 } } : flooded, ms: 2_000 }) },
			break_block: { shift: () => { cuts++; return { result: { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' }, ms: 500 }; } },
			control: { shift: () => ({ result: { state: 'SUCCEEDED', reasonCode: 'CONTROL_ENDED' }, ms: 2_000,
				move: (player, args) => {
					if (args.pitch === 0 && args.jump === true) { dry = true; return { x: player.x + 1, y: player.y + 1, inWater: false, underWater: false }; }
					return { air: 298, underWater: false };
				} }) },
		} });
	body.openSky = () => ({ x: -261.5, y: 62, z: 745.5 });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.equal(dry, true, 'the next iron dig begins after leaving the water');
	assert.equal(cuts, 5, 'clear the guarded step and overhead cells before hopping');
	const hop = body.calls.findIndex((call) => call.actionType === 'control' && call.args.pitch === 0);
	assert.ok(body.calls.slice(hop + 1).some((call) => call.actionType === 'dig_to'), 'resume iron work after escape');
});

test('Nether ore searches do not invent nonexistent deepslate variants', () => {
 for (const block of ['nether_gold_ore','nether_quartz_ore']) {
  const profile=findProfile({block:'minecraft:'+block},'minecraft:the_nether');
  assert.deepEqual([...profile.ids],['minecraft:'+block]);
 }
 for (const ore of ['coal','copper','iron','gold','lapis','redstone','diamond','emerald']) {
  const expected=['minecraft:'+ore+'_ore','minecraft:deepslate_'+ore+'_ore'].sort();
  for (const block of expected)assert.deepEqual([...findProfile({block}).ids].sort(),expected);
 }
});

// lava-gate-1 (seed 5433312384530337025): the lava find's 1-wide shaft from spawn broke the roof of a flooded cave at y56
// (water in every cell round it up to the stone roof at y57); the only air is the shaft, open to the sky, so the spot the
// runtime keeps under open sky is the body's own at the bottom. On main every way off read "already at the surface" and
// the body trod water there for 12 minutes (10 of 10 runs).
function afloatUnderOwnShaft({ bob = false, spawnSky = false, bobY = 56.9 } = {}) {
	let laid = false, out = false, pulses = 0;
	const cut = new Set();
	const water = [];
	for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [1, -1], [-1, 1]]) water.push({ blockId: 'minecraft:water', x: 16 + dx, y: 56, z: -48 + dz });
	const start = { x: 16.5, y: 56.3, z: -47.5, yaw: 0, health: 20, inWater: true, underWater: false, air: 300, maxAir: 300, skyOpen: true };
	const body = fakeBody({ start: sample({ player: start, blocks: water, inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 },
		{ itemId: 'minecraft:water_bucket', count: 1 }, { itemId: 'minecraft:cobblestone', count: 16 }] } }), frontier: { candidates: [], coverage: { headings: {} } }, acts: {
		travel_to: Array.from({ length: 20 }, () => ({ result: { state: 'FAILED', reasonCode: 'NO_ROUTE',
			message: 'Could not get out of the water in 30 s; no dry footing seen within 10 blocks' }, ms: 30_000 })),
		place_block: Array.from({ length: 4 }, () => ({ result: { state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED' }, ms: 500, move: () => { laid = true; return {}; } })),
		break_block: Array.from({ length: 40 }, () => ({ result: { state: 'SUCCEEDED', reasonCode: 'BLOCK_BROKEN' }, ms: 1_000,
			move: (player, args) => { cut.add(`${args.x},${args.y},${args.z}`); return {}; } })),
		control: Array.from({ length: 80 }, () => ({ result: { state: 'SUCCEEDED' }, ms: 1_000,
			move: (player, args) => {
				// Jump pulses in the 1-wide column go nowhere; the hop needs the laid floor and the cut step.
				if (args.forward === 1 && args.pitch === 0 && laid && cut.size >= 3) { out = true; return { y: 57, z: player.z + 1, inWater: false, underWater: false, skyOpen: false, onGround: true }; }
				// lava-gate-6: a jump pulse at the water's top lifts the body clear for a sample, then it sinks back.
				pulses += 1;
				if (bob && args.jump && pulses % 2 === 1) return { y: bobY, inWater: false, onGround: false };
				return { y: 56.3, inWater: true, onGround: false };
			} })),
		dig_to: Array.from({ length: 30 }, () => ({ get result() { return out ? { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 30,40,-30, 5 blocks away' }
			: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Stopped: The body is under water at 16,56,-48 (air 298/300); not digging on.' }; } })),
	} });
	// lava-gate-6's spawn is remembered under open sky 12 above; lava-gate-1's open shaft leaves only the body's own spot.
	body.openSky = () => (spawnSky ? { x: 16.5, y: 68, z: -47.5 } : { x: 16.5, y: 56, z: -47.5 });
	const missed = [];
	body.missedPlaces = () => missed;
	body.missPlace = (place, why) => missed.push({ ...place, why });
	return body;
}

for (const [label, options] of [['bobbing clear of the water on every other jump (lava-gate-6)', { bob: true }], ['its spawn remembered under open sky above, bobbing (lava-gate-6)', { bob: true, spawnSky: true }]]) {
	test(`flooded own shaft, ${label}: the lava find still lays a step, cuts it out and climbs on`, async () => {
		const body = afloatUnderOwnShaft(options);
		const result = await searchFor({ block: 'minecraft:lava' }, body, { timeoutMs: 540_000 });
		const types = body.calls.map((call) => call.actionType);
		assert.ok(types.includes('place_block') && types.indexOf('break_block') > types.indexOf('place_block'), `laid then cut (calls: ${types.join(',')}; ${result.reasonCode} ${result.message})`);
		assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	});
}

test('the step out of the water comes from the water\'s row on a bob sample that crossed into the row above', () => {
	assert.equal(stepRow(56.3, true, false), 56, 'in the water: its own row');
	assert.equal(stepRow(56.9, false, true), 55, 'clear of the water, water under the feet: the row below (the water the feet left)');
	assert.equal(stepRow(57.2, false, true), 56, 'a bob into the row over the water: the water row, not 57');
	assert.equal(stepRow(57.2, false, false), 57, 'dry ground: its own row');
});

test('a bob that lifts the feet into the row over the water lays and cuts the step from the water\'s row, not a block above the lip', async () => {
	const body = afloatUnderOwnShaft({ bob: true, bobY: 57.2 });
	const result = await searchFor({ block: 'minecraft:lava' }, body, { timeoutMs: 540_000 });
	const laid = body.calls.find((call) => call.actionType === 'place_block');
	assert.ok(laid !== undefined, `a step laid (${result.reasonCode} ${result.message})`);
	assert.equal(laid.args.y, 56, 'laid in the water row beside the body');
	const cuts = body.calls.filter((call) => call.actionType === 'break_block').map((call) => call.args.y);
	assert.ok(cuts.length > 0 && Math.min(...cuts) === 57, `cut from the row over the step (${cuts.join(',')})`);
});

test('lava-gate-1: afloat at the bottom of its own shaft open to the sky, the lava find lays a step in the water, cuts it out and climbs on', async () => {
	const body = afloatUnderOwnShaft();
	const result = await searchFor({ block: 'minecraft:lava' }, body, { timeoutMs: 540_000 });
	const types = body.calls.map((call) => call.actionType);
	const laid = types.indexOf('place_block'), firstCut = types.indexOf('break_block');
	assert.ok(laid >= 0, `a step laid in the water (calls: ${types.join(',')}; ${result.reasonCode} ${result.message})`);
	assert.ok(firstCut > laid, 'laid before the step is cut out above it');
	assert.deepEqual(['x', 'y', 'z', 'face'].map((key) => body.calls[laid].args[key]), [16, 56, -47, 'down'], 'into the water beside the body (south, its yaw), against the rock over it');
	const stairs = body.calls.find((call) => call.actionType === 'dig_to' && call.args.pattern === 'stairs_up');
	assert.ok(stairs !== undefined && stairs.args.y >= 64, 'stairs on up out of the flooded shaft, not another dig into the water');
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
});

// Cave first is opt-in (MINEAGEN_CAVE_FIRST=on); the tests from here on run with it on, except the switch test, which sets it itself.
const caveFirstBefore = process.env.MINEAGEN_CAVE_FIRST;
test('cave first tests run with the switch on', () => { process.env.MINEAGEN_CAVE_FIRST = 'on'; });
test.after(() => { if (caveFirstBefore === undefined) delete process.env.MINEAGEN_CAVE_FIRST; else process.env.MINEAGEN_CAVE_FIRST = caveFirstBefore; });
// Cave first (21 Nov room test of PR #31: its cave legs dug with build on, re-fired after mob stops mid-descent and walked
// into the mob's cave; iron 0 of 4 exercised runs against 4 of 4, pickaxe worn out 3 of 4).
const DOWN = { move: (player, args) => ({ y: args.y }), result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 3,20,9, 3 blocks away' } };
const cave = (x, y, z) => ({ x, y, z, air: 60 });

test('cave first: a cave in the first look, below and within reach, is walked into with build off before any dig', async () => {
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		looks: [{ survey: { caves: [cave(20, 50, 0)] } }, { survey: { veins: [{ blockId: 'minecraft:iron_ore', x: 24, y: 46, z: 2, visible: 3 }] } }],
		acts: { travel_to: [{ move: () => ({ x: 20.5, y: 50, z: 0.5 }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }], dig_to: [DOWN] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.match(result.message, /walked into 1 of 1 cave\(s\) before digging/);
	const walk = body.calls.find((call) => call.actionType === 'travel_to').args;
	assert.deepEqual([walk.x, walk.y, walk.z, walk.build], [20.5, 50, 0.5, false]);
	assert.equal(body.calls.some((call) => call.actionType === 'dig_to'), false, 'seen from inside the cave: no dig at all');
});

test('cave first: a cave with no walking way in is marked and left, and the dig down runs from where the body stands', async () => {
	const missed = [];
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [{ survey: { caves: [cave(20, 50, 0)] } }],
		acts: { travel_to: [{ ms: 3_000, result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer, and build is false' } }], dig_to: [DOWN] } });
	body.missPlace = (place, why) => missed.push({ ...place, why });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.deepEqual(body.calls.filter((call) => call.actionType).map((call) => call.actionType), ['travel_to', 'dig_to']);
	assert.equal(body.calls[1].args.build, false);
	assert.deepEqual(missed.map((row) => [row.x, row.y, row.z, row.why]), [[20, 50, 0, 'no walking way into the cave']]);
	assert.match(result.message, /walked into 0 of 1 cave\(s\) first, then dug/);
});

test('cave first: a remembered cave counts; the cave the body stands at, one above it, one far under the band and one with a mob near do not', async () => {
	const known = { sightings: [{ kind: 'cave', what: 'cave', x: 0, y: 30, z: 30, air: 50 }] };
	const body = fakeBody({ known, frontier: { candidates: [], coverage: { headings: {} } },
		start: sample({ entities: [{ type: 'minecraft:zombie', hostile: true, x: 30, y: 60, z: 4, distance: 30 }] }),
		looks: [{ survey: { caves: [cave(2, 68, 1), cave(10, 80, 0), cave(0, -20, 20), cave(30, 60, 0)] } }],
		acts: { travel_to: [{ move: () => ({ x: 0.5, y: 30, z: 30.5 }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }], dig_to: [DOWN] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const walks = body.calls.filter((call) => call.actionType === 'travel_to').map((call) => [call.args.x, call.args.y, call.args.z]);
	assert.deepEqual(walks, [[0.5, 30, 30.5]], 'only the remembered cave');
	assert.match(result.message, /walked into 1 of 1 cave\(s\) first, down to y30, then dug/);
});

test('cave first: at most two walks, and a mob met on a walk ends the walking', async () => {
	const walks = (body) => body.calls.filter((call) => call.actionType === 'travel_to').length;
	const three = [cave(20, 50, 0), cave(-20, 50, 0), cave(0, 50, 20)];
	const arrive = (x, z) => ({ move: () => ({ x, y: 50, z }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } });
	const all = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [{ survey: { caves: three } }, { survey: {} }, { survey: {} }],
		acts: { travel_to: [arrive(20.5, 0.5), arrive(-19.5, 0.5), arrive(0.5, 20.5)], dig_to: [DOWN] } });
	assert.equal((await searchFor({ block: 'minecraft:iron_ore' }, all)).reasonCode, 'FIND_SEEN');
	assert.equal(walks(all), 2);
	const mob = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [{ survey: { caves: three } }],
		acts: { travel_to: [{ result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'minecraft:zombie 1a2b 14 blocks away' } }], dig_to: [DOWN] } });
	await searchFor({ block: 'minecraft:iron_ore' }, mob);
	assert.equal(walks(mob), 1, 'no second cave walk after the mob');
});

test('cave first: the walk back to where the cave walks began that stops for damage hands back, it does not dig on', async () => {
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [{ survey: { caves: [cave(20, 50, 0)] } }],
		acts: { travel_to: [
			// The walk into the cave gives up 9 blocks out, so the body walks back before digging.
			{ move: () => ({ x: 9.5, z: 0.5 }), result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer, and build is false' } },
			{ move: () => ({ health: 10 }), result: { state: 'FAILED', reasonCode: 'TRAVEL_DAMAGED', message: 'Stopped: lost 10 health on the way' } },
		], dig_to: [DOWN] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_DANGER', result.message);
	assert.equal(body.calls.some((call) => call.actionType === 'dig_to'), false, 'no dig after the damaged walk back');
});

test('cave first runs once, before the first dig: a cave the descent opened after a mob stop is not walked to', async () => {
	const body = fakeBody({ start: sample({ inventory: { items: [{ itemId: 'minecraft:stone_sword', count: 1 }, { itemId: 'minecraft:cobblestone', count: 20 }] } }),
		frontier: { candidates: [], coverage: { headings: {} } },
		looks: [{ survey: {} }, { survey: { caves: [cave(10, 45, 0)] } }],
		acts: {
			dig_to: [
				{ move: () => ({ y: 55 }), result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:skeleton 86ef at 0,45,-6, 10 blocks away. At 0,55,0; dug past caves at 10,45,0 (y45)' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED', message: 'Mined the maxBlocks limit' } },
				DOWN,
			],
			build_shelter: [{ result: { state: 'SUCCEEDED', reasonCode: 'SHELTER_BUILT' } }],
		} });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	assert.equal(body.calls.some((call) => call.actionType === 'travel_to' && call.args.build === false), false);
	assert.doesNotMatch(result.message, /cave\(s\)/);
});

test('cave first runs only with MINEAGEN_CAVE_FIRST=on, and never for lava', async () => {
	const run = async (target) => {
		const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [{ survey: { caves: [cave(20, 50, 0)] } }], acts: { dig_to: [DOWN] } });
		await searchFor(target, body);
		return body.calls.some((call) => call.actionType === 'travel_to' && call.args.build === false);
	};
	assert.equal(await run({ block: 'minecraft:lava' }), false);
	delete process.env.MINEAGEN_CAVE_FIRST;
	assert.equal(await run({ block: 'minecraft:iron_ore' }), false, 'off by default');
	process.env.MINEAGEN_CAVE_FIRST = 'off';
	assert.equal(await run({ block: 'minecraft:iron_ore' }), false);
	process.env.MINEAGEN_CAVE_FIRST = 'on';
	assert.equal(await run({ block: 'minecraft:iron_ore' }), true);
	assert.equal(await run({ block: 'minecraft:lava' }), false);
});

test('cave first: a cave with water seen beside it is left alone, and a walk that ends in water walks back out and digs from dry ground', async () => {
	const seenWet = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		looks: [{ survey: { caves: [cave(20, 50, 0)], blocks: [{ blockId: 'minecraft:water', x: 21, y: 49, z: 1 }] } }], acts: { dig_to: [DOWN] } });
	assert.equal((await searchFor({ block: 'minecraft:iron_ore' }, seenWet)).reasonCode, 'FIND_SEEN');
	assert.equal(seenWet.calls.some((call) => call.actionType === 'travel_to'), false, 'the flooded cave is not walked to');
	const missed = [];
	const swim = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [{ survey: { caves: [cave(20, 50, 0), cave(-20, 50, 0)] } }],
		acts: { travel_to: [
			{ move: () => ({ x: 18.5, y: 50, z: 0.5, inWater: true }), result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'Could not get out of the water in 30 s' } },
			{ move: () => ({ x: 0.5, y: 70, z: 0.5, inWater: false }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }],
		dig_to: [DOWN] } });
	swim.missPlace = (place, why) => missed.push({ ...place, why });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, swim);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const travels = swim.calls.filter((call) => call.actionType === 'travel_to').map((call) => [call.args.x, call.args.y, call.args.z, call.args.build]);
	assert.deepEqual(travels, [[20.5, 50, 0.5, false], [0.5, 70, 0.5, false]], 'into the cave, then back to the start; no second cave');
	assert.ok(missed.some((row) => row.why === 'flooded cave'));
	assert.match(result.message, /1 flooded, walked back out/);
	assert.equal(swim.calls.filter((call) => call.actionType === 'dig_to').length, 1);
});

test('cave first: no cave walk with a hostile within 24 blocks of the body (a search asked again after a mob stop)', async () => {
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		start: sample({ entities: [{ type: 'minecraft:creeper', hostile: true, x: -10, y: 70, z: 10, distance: 14 }] }),
		looks: [{ survey: { caves: [cave(20, 50, 0)] } }], acts: { dig_to: [DOWN] } });
	await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(body.calls.some((call) => call.actionType === 'travel_to'), false);
});

test('cave first: a mob seen on any heading of the look rules out its cave; walks are time-capped; cave misses never hide ore', async () => {
	const sweep = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } },
		looks: [{ survey: { caves: [cave(30, 50, 0)] }, samples: [{ entities: [{ type: 'minecraft:skeleton', x: 31, y: 50, z: 2 }] }, { entities: [] }] }], acts: { dig_to: [DOWN] } });
	await searchFor({ block: 'minecraft:iron_ore' }, sweep);
	assert.equal(sweep.calls.some((call) => call.actionType === 'travel_to'), false, 'the skeleton beside it was seen on an earlier heading');
	const missed = [];
	const capped = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [{ survey: { caves: [cave(20, 50, 0)] } }],
		acts: { travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'build is false' } }], dig_to: [DOWN] } });
	capped.missPlace = (place, why) => missed.push({ ...place, why });
	await searchFor({ block: 'minecraft:iron_ore' }, capped);
	assert.equal(capped.calls.find((call) => call.actionType === 'travel_to').args.timeoutMs, 45_000);
	assert.deepEqual(missed.map((row) => row.blockId), ['mineagen:cave'], 'a cave miss is typed, so ore and water searches ignore it');
	const late = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [{ survey: { caves: [cave(20, 50, 0)] } }], acts: { dig_to: [DOWN] } });
	await searchFor({ block: 'minecraft:iron_ore' }, late, { timeoutMs: 100_000 });
	assert.equal(late.calls.some((call) => call.actionType === 'travel_to'), false, 'too little time left for a walk and a dig after it');
});

test('cave first: when no cave walk got in, the body walks back to where the walks began before it digs', async () => {
	const body = fakeBody({ frontier: { candidates: [], coverage: { headings: {} } }, looks: [{ survey: { caves: [cave(-8, 56, -5)] } }],
		acts: { travel_to: [
			{ move: () => ({ x: -7.5, y: 63, z: -3.6 }), result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer, and build is false' } },
			{ move: () => ({ x: 0.5, y: 70, z: 0.5 }), result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } }],
		dig_to: [DOWN] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const order = body.calls.filter((call) => call.actionType).map((call) => `${call.actionType}${call.args.build === false ? ':walk' : ''}`);
	assert.deepEqual(order, ['travel_to:walk', 'travel_to:walk', 'dig_to']);
	assert.deepEqual([body.calls[2].args.x, body.calls[2].args.y, body.calls[2].args.z], [0.5, 70, 0.5]);
});

test('playtest 22 Nov: below the ore band, find walks back up its own route before cutting new stairs', async () => {
	const deep = { x: 396.5, y: 11, z: -260.5, yaw: 0, health: 20, skyOpen: false };
	const body = fakeBody({ start: sample({ player: deep }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:coal_ore seen at 300,40,-240, 3 blocks away' }, move: () => ({ x: 301.5, y: 40, z: -240.5 }) }] } });
	body.openSky = () => ({ x: 289.5, y: 78, z: -229.5 });
	const result = await searchFor({ block: 'minecraft:coal_ore' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const moves = body.calls.filter((call) => ['travel_to', 'dig_to'].includes(call.actionType));
	assert.equal(moves[0].actionType, 'travel_to', 'no new staircase first');
	assert.deepEqual([moves[0].args.retrace, moves[0].args.x, moves[0].args.y], [true, 289.5, 78]);
	assert.equal(moves[0].args.stopWhenSeen, 'minecraft:coal_ore');
	// With no way back recorded it digs stairs up, as before.
	const none = fakeBody({ start: sample({ player: deep }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:coal_ore seen at 396,30,-270, 3 blocks away' } }] } });
	await searchFor({ block: 'minecraft:coal_ore' }, none);
	assert.equal(none.calls.find((call) => ['travel_to', 'dig_to'].includes(call.actionType))?.args.pattern, 'stairs_up');
});

test('review: the walk back up stops once in the ore band, not at the last sky', async () => {
	const deep = { x: 396.5, y: 11, z: -260.5, yaw: 0, health: 20, skyOpen: false };
	const body = fakeBody({ start: sample({ player: deep }), frontier: { candidates: [], coverage: { headings: {} } },
		acts: { travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: 300.5, y: 30, z: -240.5 }) }],
			dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:coal_ore seen at 300,30,-250, 3 blocks away' } }] } });
	body.openSky = () => ({ x: 289.5, y: 78, z: -229.5 });
	let watched = null;
	const act = body.act;
	body.act = async (type, args, options) => { if (type === 'travel_to' && args.retrace) watched = options?.watch; return act(type, args, options); };
	await searchFor({ block: 'minecraft:coal_ore' }, body);
	assert.ok(watched, 'the walk back is watched');
	assert.equal(watched(sample({ player: { ...deep, y: 20 } })), null, 'below the band it walks on');
	assert.deepEqual(watched(sample({ player: { ...deep, y: 30 } })), { until: true }, 'in the band (coal y48 - 24) it stops');
});

test('review: a remembered ore the caller priced out is no known-place trip', async () => {
	const ore = { blockId: 'minecraft:iron_ore', x: 10, y: 20, z: 0, tick: 1 };
	const at = { x: 0.5, y: 22, z: 0.5, yaw: 0, health: 20, skyOpen: false };
	const trips = (skip) => {
		const body = fakeBody({ start: sample({ player: at }), known: { sightings: [], blocks: [ore], placed: [], trail: [], tick: 2 },
			frontier: { candidates: [], coverage: { headings: {} } } });
		return searchFor({ block: 'minecraft:iron_ore', ...(skip ? { skip: [{ x: 10, y: 20, z: 0 }] } : {}) }, body, { timeoutMs: 120_000 })
			.then(() => body.calls.filter((call) => call.actionType === 'travel_to' && call.args.x === 10.5 && call.args.z === 0.5).length);
	};
	assert.ok(await trips(false) >= 1, 'without a skip the remembered block is a trip');
	assert.equal(await trips(true), 0, 'priced out: no trip');
});

test('lava-gate-3 kit: stairs only as far as the pickaxes also cover a shaft for the rest and the search at depth, then the bucket shaft', async (t) => {
	process.env.MINEAGEN_LAVA_STAIRS = 'on';
	t.after(() => { delete process.env.MINEAGEN_LAVA_STAIRS; });
	// An iron (250) and a stone (131) pickaxe, new: 377 uses past the 2 each dig keeps back.
	const kit = [{ itemId: 'minecraft:iron_pickaxe', count: 1, maxDamage: 250, damage: 0 }, { itemId: 'minecraft:stone_pickaxe', count: 1, maxDamage: 131, damage: 0 },
		{ itemId: 'minecraft:water_bucket', count: 1 }, { itemId: 'minecraft:cobblestone', count: 16 }];
	assert.equal(pickaxeUses({ inventory: { items: kit } }), 377);
	assert.equal(pickaxeUses({ inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }] } }), Infinity, 'no wear reported: unknown');
	assert.equal(stairBudget(377, 125), 2 * (377 - 125 - DESCENT_RESERVE));
	assert.equal(stairBudget(200, 125), 0);
	const start = sample({ player: { x: 0.5, y: 71, z: 0.5, yaw: 0, health: 20, skyOpen: true }, inventory: { items: kit } });
	const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [
			// The stairs spend their budget (one use a block) and stop at the limit, about 46 blocks down.
			{ move: () => ({ y: 25 }), then: { inventory: { items: [{ ...kit[0], damage: 184 }, kit[1], kit[2], kit[3]] } }, result: { state: 'SUCCEEDED', reasonCode: 'DIG_LIMIT_REACHED', message: 'Mined the maxBlocks limit' } },
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 4,-54,0, 4 blocks away' } }] } });
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_SEEN', result.message);
	const digs = body.calls.filter((call) => call.actionType === 'dig_to').map((call) => call.args);
	assert.deepEqual(digs.map((args) => args.pattern), ['steep_down', 'shaft']);
	assert.ok(digs[0].maxBlocks <= stairBudget(377, 71 - findProfile({ block: 'minecraft:lava' }).depth), 'the stairs leg is capped at the budget');
});

test('lava-gate-6: after stairs stop for a mob in the cave below, the next descent stops at cave openings instead of crossing the cave', async (t) => {
	process.env.MINEAGEN_LAVA_STAIRS = 'on';
	t.after(() => { delete process.env.MINEAGEN_LAVA_STAIRS; });
	const start = sample({ player: { x: 0.5, y: 71, z: 0.5, yaw: 0, health: 20, skyOpen: true },
		inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:water_bucket', count: 1 }, { itemId: 'minecraft:stone_sword', count: 1 }] } });
	const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } },
		acts: { dig_to: [
			{ move: () => ({ y: -5 }), result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:zombie 95d3ca29-7f2f-401f-a6b2-bc81a81c1e25 at 3,-5,0, 3.3 blocks away. At 0,-5,0, steep_down heading south' } },
			{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 4,-54,0, 4 blocks away' } }] } });
	await searchFor({ block: 'minecraft:lava' }, body);
	const digs = body.calls.filter((call) => call.actionType === 'dig_to' && call.args.pattern === 'steep_down').map((call) => call.args);
	assert.ok(digs.length >= 2, JSON.stringify(body.calls.map((call) => call.actionType)));
	assert.equal(digs[0].throughCaves, undefined);
	assert.equal(digs.at(-1).throughCaves, false);
	const fled = body.calls.find((call) => call.actionType === 'flee_from');
	assert.equal(fled?.args.targetId, '95d3ca29-7f2f-401f-a6b2-bc81a81c1e25', 'flees the zombie the stairs stopped for, never fights it');
	assert.ok(!body.calls.some((call) => call.actionType === 'fight_target'));
	const back = body.calls.find((call) => call.actionType === 'travel_to' && call.args.retrace === true);
	assert.ok(back !== undefined && back.args.y === 71, 'backs up its own stairs to where that descent began');
	assert.notEqual(digs.at(-1).heading, digs[0].heading, 'and goes down another way');
});

test('the default lava descent is the bucket shaft; MINEAGEN_LAVA_STAIRS=on digs stairs', async (t) => {
	const start = sample({ player: { x: 16.5, y: 70, z: -47.5, yaw: 0, health: 20, skyOpen: true },
		inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:water_bucket', count: 1 }] } });
	const first = async () => {
		const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } },
			acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 20,-54,-40, 6 blocks away' } }] } });
		await searchFor({ block: 'minecraft:lava' }, body);
		return body.calls.find((call) => call.actionType === 'dig_to').args.pattern;
	};
	assert.equal(await first(), 'shaft');
	process.env.MINEAGEN_LAVA_STAIRS = 'on';
	t.after(() => { delete process.env.MINEAGEN_LAVA_STAIRS; });
	assert.equal(await first(), 'steep_down');
});

test('stairs into a mob cave: when neither the flee nor the walk back up gets away, the danger goes back, no dig from the same spot', async (t) => {
	process.env.MINEAGEN_LAVA_STAIRS = 'on';
	t.after(() => { delete process.env.MINEAGEN_LAVA_STAIRS; });
	const start = sample({ player: { x: 0.5, y: 71, z: 0.5, yaw: 0, health: 20, skyOpen: true },
		inventory: { items: [{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:water_bucket', count: 1 }, { itemId: 'minecraft:stone_sword', count: 1 }] } });
	const body = fakeBody({ start, frontier: { candidates: [], coverage: { headings: {} } },
		acts: {
			dig_to: [{ move: () => ({ y: -5 }), result: { state: 'FAILED', reasonCode: 'HOSTILE_NEAR', message: 'Stopped: minecraft:zombie 95d3ca29-7f2f-401f-a6b2-bc81a81c1e25 at 3,-5,0, 3.3 blocks away. At 0,-5,0, steep_down heading south' } },
				{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:lava seen at 4,-54,0, 4 blocks away' } }],
			flee_from: [{ result: { state: 'SUCCEEDED', reasonCode: 'WALLED_IN', message: 'Could not get away, so it stood its ground' } }],
			travel_to: [{ result: { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer' } }],
		} });
	const result = await searchFor({ block: 'minecraft:lava' }, body);
	assert.equal(result.reasonCode, 'FIND_DANGER', result.message);
	assert.equal(body.calls.filter((call) => call.actionType === 'dig_to').length, 1, 'no second dig from the exposed spot');
	const flee = body.calls.find((call) => call.actionType === 'flee_from');
	assert.ok(Number.isFinite(flee?.args.timeoutMs), 'the flee is a timed leg, capped by the search budget');
});
