import test from 'node:test';
import assert from 'node:assert/strict';
import { checkStart, markStart, readStart } from '../../scripts/quality/lib/start-check.mjs';
import { roomVerdict } from '../../scripts/quality/lib/fixture-run.mjs';

const distance = (a, b) => Math.hypot(...a.map((value, i) => value - b[i]));

test('recorded bad start (iron-kit room, seed 31005 lane 1): spruce leaves in the head cell read INVALID, not a bot failure', () => {
	// The start the room recorded: spot 184,110, body at 184.5 76 110.5, summoned over motion_blocking_no_leaves under a
	// spruce. Every search then ended FIND_BLOCKED ("No part of spruce_leaves ... is in reach and view"), 11 times.
	const SPEC = { footing: { notIn: ['leaves', 'fluid'], solidBelow: true } };
	const start = { body: [184.5, 76, 110.5], feet: { leaves: false, fluid: false }, head: { leaves: 'minecraft:spruce_leaves', fluid: false }, below: { solid: true } };
	const result = checkStart(SPEC, start);
	assert.deepEqual(result.failures, [{ check: 'footing', reason: "leaves in the body's head cell (minecraft:spruce_leaves)" }]);
	const row = markStart({ name: 'lane-1', pass: false, deaths: 0, failReason: 'no armour in 35 min' }, result, start);
	assert.deepEqual(roomVerdict(row), { verdict: 'INVALID', reason: "not exercised: bad start: leaves in the body's head cell (minecraft:spruce_leaves)" });
	assert.equal(row.startCheck.start.body[1], 76);
	// The same spot clear of the canopy is a good start, and the row keeps its own verdict.
	const clear = checkStart(SPEC, { ...start, head: { leaves: false, fluid: false } });
	assert.equal(clear.ok, true);
	assert.equal(roomVerdict(markStart({ pass: false, failReason: 'no armour' }, clear)).verdict, 'FAIL');
	assert.match(checkStart(SPEC, { ...start, feet: { leaves: false, fluid: 'water' } }).failures[0].reason, /fluid in the body's feet cell \(water\)/);
});

test('recorded skeleton-escape starts: the skeleton the room judged was 82 to 127 blocks from the body, never in range', () => {
	// Two recorded starts of the skeleton room (10-a-side A/B on 23 Nov): one the room marked "no skeleton in sight at the
	// start", one it counted as exposed. Its check took the skeleton nearest the command's origin, not the body.
	const wall = { x0: 197, x1: 198, y0: 150, y1: 153, z0: 199, z1: 202 };
	const recorded = [{ body: [199.34, 150.96, 200.54], skeleton: [117.5, 71, 159.5], exposed: false, wall }, { body: [200.5, 150, 200.5], skeleton: [203.5, 69, 188.5], exposed: true, wall }];
	const SPEC = { mobs: [{ type: 'minecraft:skeleton', min: 1, within: 16, inSight: true }] };
	for (const start of recorded) {
		const mobs = [{ type: 'minecraft:skeleton', position: start.skeleton, distance: distance(start.body, start.skeleton), inSight: start.exposed }];
		const result = checkStart(SPEC, { body: start.body, mobs });
		assert.equal(result.ok, false, `exposed ${start.exposed} at ${Math.round(mobs[0].distance)} blocks is no skeleton start`);
		assert.match(result.failures[0].reason, /^0 minecraft:skeleton within 16 blocks, wants 1 \(nearest (82|122) blocks away\)$/);
	}
	// A skeleton 6 blocks off the pad: in sight is a start, behind the wall is not, unmeasured sight is not.
	const near = inSight => checkStart(SPEC, { body: [200.5, 150, 200.5], mobs: [{ type: 'minecraft:skeleton', distance: 6, inSight }] });
	assert.equal(near(true).ok, true);
	assert.deepEqual(near(false).failures[0].reason, '0 minecraft:skeleton in sight within 16 blocks, wants 1');
	assert.deepEqual(near(undefined).failures[0].reason, 'minecraft:skeleton in sight unknown');
});

test('health, inventory and time of day, and anything unread, fail a start that asks for them', () => {
	const SPEC = { health: { min: 20 }, inventory: { has: { 'minecraft:shield': 1 }, lacks: ['minecraft:water_bucket'] }, time: { from: 13000, to: 1000 } };
	assert.equal(checkStart(SPEC, { health: 20, inventory: { 'minecraft:shield': 1, 'minecraft:water_bucket': 0 }, timeOfDay: 18000 }).ok, true, 'night wraps over midnight');
	assert.deepEqual(checkStart(SPEC, { health: 12, inventory: { 'minecraft:shield': 0, 'minecraft:water_bucket': 1 }, timeOfDay: 6000 }).failures.map(failure => failure.reason),
		['health 12, wants at least 20', '0 minecraft:shield, wants 1', 'holds 1 minecraft:water_bucket, wants none', 'time of day 6000, wants 13000-1000']);
	assert.deepEqual(checkStart(SPEC, {}).failures.map(failure => failure.reason),
		['health unknown', 'minecraft:shield count unknown', 'minecraft:water_bucket count unknown', 'time of day unknown']);
	assert.deepEqual(checkStart({ footing: { notIn: ['leaves'], solidBelow: true }, mobs: [{ type: 'minecraft:zombie' }] }, {}).failures.map(failure => failure.reason),
		['feet cell: leaves unknown', 'head cell: leaves unknown', 'ground under the body unknown', 'minecraft:zombie: mobs unknown']);
	const row = markStart({ notExercised: 'the room\'s own reason' }, { ok: false, failures: [{ check: 'health', reason: 'health unknown' }] });
	assert.equal(row.notExercised, 'the room\'s own reason', 'a room\'s own reason is kept');
});

test('readStart reads the start with commands anchored at the body, and an unreadable reply is unknown', async () => {
	const sent = [];
	const world = {
		'data get entity Probe Pos': 'Probe has the following entity data: [200.5d, 150.0d, 200.5d]',
		'execute at Probe if block ~ ~0 ~ #minecraft:leaves': 'Test failed', 'execute at Probe if block ~ ~1 ~ #minecraft:leaves': 'Test passed',
		'execute at Probe if block ~ ~0 ~ minecraft:water': 'Test failed', 'execute at Probe if block ~ ~0 ~ minecraft:lava': 'Test failed',
		'execute at Probe if block ~ ~1 ~ minecraft:water': 'Test failed', 'execute at Probe if block ~ ~1 ~ minecraft:lava': 'Test failed',
		'execute if entity @a[name=Probe,nbt={OnGround:1b}]': 'Test passed',
		'execute at Probe if entity @e[type=minecraft:skeleton,distance=..16]': 'Test passed, count: 2',
		'execute at Probe run data get entity @e[type=minecraft:skeleton,limit=1,sort=nearest] Pos': 'Skeleton has the following entity data: [203.5d, 150.0d, 196.5d]',
		'data get entity Probe Health': 'Probe has the following entity data: 18.5f',
		'clear Probe minecraft:shield 0': 'Found 1 matching items on player Probe', 'clear Probe minecraft:water_bucket 0': 'No items were found on player Probe',
		'time query daytime': 'The time is 6000',
	};
	// Every other fluid test (plants, bubble columns, waterlogged blocks) finds nothing here.
	const command = async text => { sent.push(text); return world[text] ?? (/^execute at Probe if block /.test(text) ? 'Test failed' : 'Unknown or incomplete command'); };
	const SPEC = { footing: { notIn: ['leaves', 'fluid'], solidBelow: true }, mobs: [{ type: 'minecraft:skeleton', within: 16, inSight: true }], health: { min: 20 },
		inventory: { has: { 'minecraft:shield': 1 }, lacks: ['minecraft:water_bucket'] }, time: { from: 0, to: 12000 } };
	const start = await readStart(command, 'Probe', SPEC, { sight: async mob => mob.distance < 10 });
	assert.deepEqual(start.head, { leaves: true, fluid: false });
	assert.deepEqual(start.below, { solid: true });
	assert.equal(start.mobs.length, 2);
	assert.equal(start.mobs[0].distance, 5);
	assert.equal(start.mobs[0].inSight, true);
	assert.deepEqual([start.health, start.inventory, start.timeOfDay], [18.5, { 'minecraft:shield': 1, 'minecraft:water_bucket': 0 }, 6000]);
	assert.deepEqual(checkStart(SPEC, start).failures.map(failure => failure.reason), ["leaves in the body's head cell", 'health 18.5, wants at least 20']);
	assert.ok(sent.filter(text => /@e|if block/.test(text)).every(text => text.startsWith('execute at Probe ')), 'every world test is anchored at the body');
	// Standing in seagrass, or in a waterlogged slab, is a start in water.
	for (const wet of ['execute at Probe if block ~ ~0 ~ minecraft:seagrass', 'execute at Probe if block ~ ~0 ~ #minecraft:slabs[waterlogged=true]']) {
		const soaked = await readStart(async text => text === wet ? 'Test passed' : world[text] ?? (/if block/.test(text) ? 'Test failed' : ''), 'Probe', { footing: { notIn: ['fluid'] } });
		assert.equal(soaked.feet.fluid, 'water', wet);
	}
	// Off the ground (a torch or a flower below, or mid-fall): no support.
	const floating = await readStart(async text => text === 'execute if entity @a[name=Probe,nbt={OnGround:1b}]' ? 'Test failed' : world[text] ?? 'Test failed', 'Probe', { footing: { solidBelow: true } });
	assert.deepEqual(checkStart({ footing: { solidBelow: true } }, floating).failures.map(failure => failure.reason), ['no solid block under the body']);
	// A server that answers nothing readable: every fact is unknown, so the start is not counted.
	const blank = await readStart(async () => '', 'Probe', SPEC, { sight: async () => true });
	assert.equal(checkStart(SPEC, blank).ok, false);
	assert.equal(blank.mobs, null);
	await assert.rejects(readStart(command, 'Probe', { mobs: [{ type: 'minecraft:skeleton', inSight: true }] }), /give readStart the room's sight/);
	await assert.rejects(readStart(command, 'Probe', { mobs: [{ type: 'minecraft:skeleton', min: 2, inSight: true }] }, { sight: async () => true }), /can judge sight for one mob/);
	// Two requirements on one type read apart: one skeleton within 6 does not also fill "two within 16".
	const two = { mobs: [{ type: 'minecraft:skeleton', min: 2, within: 16 }, { type: 'minecraft:skeleton', min: 1, within: 6 }] };
	const one = { 'execute at Probe if entity @e[type=minecraft:skeleton,distance=..16]': 'Test passed, count: 1', 'execute at Probe if entity @e[type=minecraft:skeleton,distance=..6]': 'Test passed, count: 1' };
	const lone = await readStart(async text => one[text] ?? world[text] ?? '', 'Probe', two);
	assert.deepEqual(checkStart(two, lone).failures.map(failure => failure.reason), ['1 minecraft:skeleton within 16 blocks, wants 2 (nearest 5 blocks away)']);
	// No range asked: the count is not cut to any range.
	const any = await readStart(async text => { sent.push(text); return text === 'execute at Probe if entity @e[type=minecraft:skeleton]' ? 'Test passed, count: 2' : world[text] ?? ''; }, 'Probe', { mobs: [{ type: 'minecraft:skeleton', min: 2 }] });
	assert.equal(checkStart({ mobs: [{ type: 'minecraft:skeleton', min: 2 }] }, any).ok, true);
	await assert.rejects(readStart(command, 'Probe; kill @e', SPEC), /player name/);
});
