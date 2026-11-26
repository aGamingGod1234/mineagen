import test from 'node:test';
import assert from 'node:assert/strict';
import { pathToFileURL } from 'node:url';
import { checkedSearchBody, checkedSearchFor } from './helpers/checked-body.mjs';
const searchFor = checkedSearchFor((await import(process.env.FIND_SEARCH_SOURCE ? pathToFileURL(process.env.FIND_SEARCH_SOURCE) : '../src/find-search.mjs')).searchFor);

// Synthetic top-face masonry at the G6 owned position. Health/empty threats and frontier are
// explicit fixture context; this diagnoses dispatch, not historical survival or Minecraft geometry.
const sample = () => ({ player: { x: 5.94, y: 65, z: 119.50, health: 20, yaw: 0 },
	world: { dimension: 'minecraft:the_nether' }, blocks: [{ blockId: 'minecraft:nether_bricks', x: 5, y: 64, z: 123, placeableFaces: ['up'] }],
	inventory: { items: [{ itemId: 'minecraft:iron_sword', count: 1 }] }, threats: { entries: [] } });
function body({ observation = sample(), frontier = null, stop = null, discover = false } = {}) {
	let clock = 0;
	const calls = [];
	return checkedSearchBody({ calls, now: () => clock, observe: async () => structuredClone(observation), progress: () => {},
		known: () => null, places: async () => [], frontier: () => frontier,
		look: async () => { clock += 1000; return { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			calls.push({ actionType, args }); clock += 1000;
			if (stop) return stop;
			if (args.x !== undefined) Object.assign(observation.player, { x: args.x, y: args.y, z: args.z });
			else {
				observation.player.x -= Math.sin(args.yaw * Math.PI / 180) * args.distance;
				observation.player.z += Math.cos(args.yaw * Math.PI / 180) * args.distance;
			}
			if (discover) observation.blocks.push({ blockId: 'minecraft:spawner', x: observation.player.x + 2, y: observation.player.y, z: observation.player.z });
			return { state: 'SUCCEEDED', reasonCode: 'ARRIVED' };
		} });
}
const target = { block: 'minecraft:spawner' };
const options = { within: 96, timeoutMs: 60_000 };

test('observed masonry floor is walked on the first leg and can reveal the target', async () => {
	const b = body({ discover: true });
	const result = await searchFor(target, b, options);
	assert.equal(b.calls[0].args.build, false);
	assert.deepEqual([b.calls[0].args.x, b.calls[0].args.y, b.calls[0].args.z], [5.5, 65, 123.5]);
	assert.equal(b.calls[0].args.stopWhenSeen, 'minecraft:spawner');
	assert.equal(b.calls[0].args.fightThrough, undefined);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.equal(result.find.covered.walked, 4);
});

test('a raised generic frontier does not override visible fortress floor', async () => {
	const b = body({ discover: true, frontier: { candidates: [{ x: 10, y: 72, z: 119, dy: 7, distance: 8 }] } });
	const result = await searchFor(target, b, options);
	assert.equal(b.calls[0].args.build, false);
	assert.equal(b.calls[0].args.y, 65);
	assert.equal(result.find.covered.y, 65);
});

test('a remote raised spot cannot replace visible fortress floor', async () => {
	const b = body({ discover: true, frontier: { candidates: [{ x: 40, y: 72, z: 119, dy: 7, distance: 35 }] } });
	await searchFor(target, b, options);
	assert.equal(b.calls[0].args.x, 5.5);
	assert.deepEqual([b.calls[0].args.x, b.calls[0].args.y, b.calls[0].args.z], [5.5, 65, 123.5]);
});

for (const [name, change, sought] of [
	['Overworld spawner', (s) => { s.world.dimension = 'minecraft:overworld'; }, target],
	['Nether without observed masonry', (s) => { s.blocks = []; }, target],
	['remembered masonry', (s) => { s.continuity = { rememberedSections: ['blocks'] }; }, target],
	['other Nether block', () => {}, { block: 'minecraft:glowstone' }],
	['fortress structure search', () => {}, { structure: 'fortress' }],
	['blaze mob search', () => {}, { mob: 'minecraft:blaze' }],
]) test(`${name} keeps its first nonbuilding search leg`, async () => {
	const observation = sample(); change(observation);
	const b = body({ observation });
	await searchFor(sought, b, options);
	assert.equal(b.calls[0].args.build, false);
	assert.equal(b.calls[0].args.distance, 48);
});

test('floor exhaustion hands back without starting compass building legs', async () => {
	const b = body();
	const result = await searchFor(target, b, options);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.equal(b.calls.length, 1);
	assert.equal(b.calls[0].args.build, false);
	assert.equal(result.find.covered.walked, 4);
});

for (const reasonCode of ['LAVA_AHEAD', 'VOID_EDGE', 'LOW_HEALTH', 'TRAVEL_DAMAGED', 'NO_TOOL', 'TOOL_WORN']) {
	test(`walking still hands back ${reasonCode} without retry`, async () => {
		const b = body({ stop: { state: 'FAILED', reasonCode } });
		const result = await searchFor(target, b, options);
		assert.equal(b.calls.length, 1);
		assert.equal(result.reasonCode, ['NO_TOOL', 'TOOL_WORN'].includes(reasonCode) ? 'FIND_BLOCKED' : 'FIND_DANGER');
	});
}

test('body interruption keeps its running handle for the model', async () => {
	const b = body({ stop: { state: 'RUNNING', interruptedBy: 'model', actionId: 'running-leg' } });
	const result = await searchFor(target, b, options);
	assert.equal(b.calls.length, 1);
	assert.equal(result.actionId, 'running-leg');
	assert.equal(result.reasonCode, 'FIND_DANGER');
});

test('target already seen ends before building', async () => {
	const observation = sample(); observation.blocks.push({ blockId: 'minecraft:spawner', x: 8, y: 72, z: 119 });
	const b = body({ observation });
	assert.equal((await searchFor(target, b, options)).reasonCode, 'FIND_SEEN');
	assert.equal(b.calls.length, 0);
});

for (const [name, x, within] of [['outside search radius', 14, 4], ['outside floor leg reach', 30, 96]]) {
	test(`${name} hands the floor decision back without travel`, async () => {
		const observation = sample(); observation.blocks[0].x = x;
		const b = body({ observation });
		assert.equal((await searchFor(target, b, { ...options, within })).reasonCode, 'FIND_BLOCKED');
		assert.equal(b.calls.length, 0);
	});
}

test('new floor observations continue walking until the existing 64-block budget is spent', async () => {
	const observation = sample();
	Object.assign(observation.player, { x: 0.5, z: 0.5 });
	Object.assign(observation.blocks[0], { x: 16, z: 0 });
	const b = body({ observation });
	const act = b.act;
	b.act = async (...args) => {
		const result = await act(...args);
		observation.blocks[0].x += 16;
		return result;
	};
	const result = await searchFor(target, b, { ...options, within: 128 });
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.equal(result.find.covered.walked, 64);
	assert.equal(b.calls.length, 4);
	assert.ok(b.calls.every(call => call.args.build === false && call.args.y === 65));
});

test('remembered blocks after arrival cannot extend the observed floor route', async () => {
	const observation = sample(), b = body({ observation });
	const act = b.act;
	b.act = async (...args) => {
		const result = await act(...args);
		observation.blocks[0].z += 4;
		observation.continuity = { rememberedSections: ['blocks'] };
		return result;
	};
	assert.equal((await searchFor(target, b, options)).reasonCode, 'FIND_BLOCKED');
	assert.equal(b.calls.length, 1);
});

// Base1 games (25 Nov): the floor walk read only blocks next to the body and handed back FIND_BLOCKED in 0-12 s while the
// far rays of the look showed fortress brick 7-62 blocks away.
test('fortress brick seen far off by a look round is walked to when no floor is in reach', async () => {
	const observation = sample(); observation.blocks[0] = { ...observation.blocks[0], x: 6, z: 120 };
	const b = body({ observation });
	b.look = async () => ({ state: 'SUCCEEDED', survey: {}, samples: [{ landmarks: [{ blockId: 'minecraft:nether_bricks', x: 6, y: 64, z: 150, distance: 30 }, { blockId: 'minecraft:basalt', x: 30, y: 64, z: 119, distance: 24 }] }] });
	const result = await searchFor(target, b, options);
	assert.deepEqual([b.calls[0].args.x, b.calls[0].args.y, b.calls[0].args.z, b.calls[0].args.tolerance], [6.5, 65, 150.5, 2]);
	assert.equal(result.find.covered.walked > 25, true);
});

test('layout off: with a blaze in view the floor nearest it is walked first, not the farthest', async () => {
	process.env.MINEAGEN_FORTRESS_LAYOUT = 'off';
	try { await blazeFirst(); } finally { delete process.env.MINEAGEN_FORTRESS_LAYOUT; }
});

test('layout on: a blaze in view does not steer the walk; the farthest new floor is walked', async () => {
	const observation = sample();
	observation.blocks = [{ blockId: 'minecraft:nether_bricks', x: 5, y: 64, z: 131, placeableFaces: ['up'] }, { blockId: 'minecraft:nether_bricks', x: 15, y: 64, z: 119, placeableFaces: ['up'] }];
	observation.entities = [{ type: 'minecraft:blaze', x: 20, y: 68, z: 118, perceivedBy: 'sight' }];
	const b = body({ observation, discover: true });
	await searchFor(target, b, options);
	assert.deepEqual([b.calls[0].args.x, b.calls[0].args.z], [5.5, 131.5]);
});

async function blazeFirst() {
	const observation = sample();
	observation.blocks = [{ blockId: 'minecraft:nether_bricks', x: 5, y: 64, z: 131, placeableFaces: ['up'] }, { blockId: 'minecraft:nether_bricks', x: 15, y: 64, z: 119, placeableFaces: ['up'] }];
	observation.entities = [{ type: 'minecraft:blaze', x: 20, y: 68, z: 118, perceivedBy: 'sight' }];
	const plain = sample(); plain.blocks = structuredClone(observation.blocks);
	const b = body({ observation, discover: true });
	await searchFor(target, b, options);
	assert.deepEqual([b.calls[0].args.x, b.calls[0].args.z], [15.5, 119.5]);
	const c = body({ observation: plain, discover: true });
	await searchFor(target, c, options);
	assert.deepEqual([c.calls[0].args.x, c.calls[0].args.z], [5.5, 131.5], 'no blaze: the farthest floor, as before');
}

test('with nothing new in reach it looks round once from the spot before handing back', async () => {
	const observation = sample(); observation.blocks[0] = { ...observation.blocks[0], x: 6, z: 120 };
	const b = body({ observation });
	let looks = 0; const look = b.look; b.look = async (...args) => { looks++; return look(...args); };
	const result = await searchFor(target, b, options);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.equal(b.calls.length, 0);
	assert.ok(looks >= 1);
});
