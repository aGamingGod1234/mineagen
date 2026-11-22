import test from 'node:test';
import assert from 'node:assert/strict';
import { checkedSearchBody, searchFor } from './helpers/checked-body.mjs';

const noRoute = { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'No seen standing spot ahead gets closer, and build is false' };
const found = { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', seen: { id: 'fortress', x: 60, y: 43, z: 0, distance: 8, via: 'sight' } };
const blocks = (count) => [{ itemId: 'minecraft:cobblestone', count }];

function bodyFor({ items = blocks(64), travel = () => ({ result: noRoute }), onLook } = {}) {
	let now = 0, observation = {
		player: { x: 0.5, y: 43, z: 0.5, yaw: 0, health: 20, threats: [] },
		world: { dimension: 'minecraft:the_nether', biome: 'minecraft:nether_wastes' }, inventory: { items },
	};
	const calls = [];
	return checkedSearchBody({ calls, now: () => now, observe: async () => structuredClone(observation), frontier: () => null, known: () => null, places: async () => [],
		look: async () => { now += 1000; observation = onLook?.(observation, calls) ?? observation; return { state: 'SUCCEEDED', survey: {} }; },
		act: async (type, args) => {
			assert.equal(type, 'travel_to');
			calls.push(structuredClone(args));
			const step = travel(args, calls.length, observation);
			now += step.ms ?? 1000;
			if (step.move) observation.player = { ...observation.player, ...step.move };
			if (step.then) observation = { ...observation, ...step.then };
			return step.result;
		},
	});
}

test('R5 G3:42/80 progress keeps walking, then zero progress gets one short build on that bearing', async () => {
	const body = bodyFor({ travel: (args, i) => i === 1 ? { result: noRoute, move: { z: 42.5 } }
		: i === 2 ? { result: noRoute } : { result: args.build ? found : noRoute, ms: args.build ? 1000 : 30000 } });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 20000 });
	assert.equal(result.reasonCode, 'FIND_SEEN');
	assert.deepEqual(body.calls.map(c => c.build), [false, false, true]);
	assert.equal(body.calls[2].yaw, body.calls[1].yaw);
	assert.equal(body.calls[2].distance, 16);
});

test('zero-net early attempts consume requested distance and hand back fresh facts without dispatching the suggestion', async () => {
	let builds = 0;
	const body = bodyFor({ travel: (args) => {
		if (args.build) builds += 1;
		return { result: noRoute, ...(builds === 4 ? { then: { inventory: { items: blocks(9) } } } : {}) };
	} });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 120000 });
	const attempts = body.calls.filter(c => c.build);
	assert.equal(attempts.length, 4);
	assert.equal(attempts.reduce((n, c) => n + c.distance, 0), 64);
	assert.equal(body.calls.length, 9, 'four walk/build pairs then one refused walk, no automatic manual continuation');
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.match(result.message, /0\.5,43,0\.5/);
	assert.match(result.message, /9 supported building blocks/);
	assert.match(result.message, /64 of 64/);
	assert.match(result.message, /travel_to.*yaw.*build:true/);
});

test('existing fallback and early retries share the requested64-block allowance even without movement', async () => {
	const body = bodyFor({ items: [], onLook: (o, calls) => calls.length >= 8 ? { ...o, inventory: { items: blocks(64) } } : o });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 120000 });
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.equal(body.calls.slice(0, 8).every(c => c.build === false), true);
	const attempts = body.calls.filter(c => c.build);
	assert.equal(attempts.length, 4);
	assert.equal(attempts.reduce((n, c) => n + c.distance, 0), 64);
	assert.match(result.message, /64 of 64/);
});

test('three early failures leave only one short leg for the existing fallback', async () => {
	let builds = 0;
	const body = bodyFor({ travel: (args) => {
		if (args.build) builds += 1;
		return { result: noRoute, ...(builds === 3 ? { then: { inventory: { items: [] } } } : {}) };
	}, onLook: (o, calls) => calls.length >= 11 ? { ...o, inventory: { items: blocks(64) } } : o });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 120000 });
	assert.deepEqual(body.calls.map(c => c.build), [false, true, false, true, false, true, false, false, false, false, false, true]);
	assert.equal(body.calls.filter(c => c.build).reduce((n, c) => n + c.distance, 0), 64);
	assert.match(result.message, /64 of 64/);
});

test('supported counts combine stacks, while combustible, falling, valuable and station items do not qualify', async () => {
	for (const items of [blocks(7), [{ itemId: 'minecraft:oak_planks', count: 64 }],
		['sand', 'gravel', 'obsidian', 'crafting_table', 'furnace'].map(id => ({ itemId: `minecraft:${id}`, count: 64 }))]) {
		const body = bodyFor({ items, travel: (_, i) => ({ result: noRoute, ms: i === 1 ? 1000 : 30000 }) });
		await searchFor({ structure: 'fortress' }, body, { timeoutMs: 20000 });
		assert.equal(body.calls.some(c => c.build), false);
	}
	const body = bodyFor({ items: [...blocks(5), { itemId: 'minecraft:netherrack', count: 3 }],
		travel: args => ({ result: args.build ? found : noRoute }) });
	assert.equal((await searchFor({ structure: 'fortress' }, body, { timeoutMs: 20000 })).reasonCode, 'FIND_SEEN');
	assert.deepEqual(body.calls.map(c => c.build), [false, true]);
});

test('refreshed inventory and dimension gate the retry; Overworld keeps its walking behavior', async () => {
	for (const then of [{ inventory: { items: [] } }, { world: { dimension: 'minecraft:overworld' } }]) {
		const body = bodyFor({ travel: (_, i) => ({ result: noRoute, then, ms: i === 1 ? 1000 : 30000 }) });
		await searchFor({ structure: 'fortress' }, body, { timeoutMs: 20000 });
		assert.equal(body.calls.some(c => c.build), false);
	}
	const body = bodyFor({ onLook: o => ({ ...o, world: { dimension: 'minecraft:overworld' } }),
		travel: (_, i) => ({ result: noRoute, ms: i === 1 ? 1000 : 30000 }) });
	await searchFor({ structure: 'village' }, body, { timeoutMs: 20000 });
	assert.equal(body.calls.some(c => c.build), false);
});

test('danger, air, tool, dimension-transition and still-running results never trigger the early building retry', async () => {
	for (const code of ['LAVA_AHEAD', 'TUNNEL_FLOODED', 'AIR_RESERVE_REACHED', 'TRAVEL_DAMAGED', 'NO_TOOL', 'TOOL_WORN', 'DIMENSION_TRANSITION']) {
		const body = bodyFor({ travel: (_, i) => ({ result: { state: 'FAILED', reasonCode: code }, ms: i === 1 ? 1000 : 30000 }) });
		await searchFor({ structure: 'fortress' }, body, { timeoutMs: 20000 });
		assert.equal(body.calls.some(c => c.build), false, code);
	}
	const body = bodyFor({ travel: () => ({ result: { ...noRoute, interruptedBy: 'danger', actionId: 'live-1' } }) });
	const result = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 20000 });
	assert.equal(result.reasonCode, 'FIND_DANGER');
	assert.match(result.message, /live-1/);
	assert.equal(body.calls.length, 1);
});

test('a short build retains danger/tool/live-handle handbacks and does not dispatch another leg', async () => {
	for (const result of [
		...['LAVA_AHEAD', 'TUNNEL_FLOODED', 'AIR_RESERVE_REACHED', 'TRAVEL_DAMAGED', 'NO_TOOL', 'TOOL_WORN']
			.map(reasonCode => ({ state: 'FAILED', reasonCode })),
		{ ...noRoute, interruptedBy: 'danger', actionId: 'live-build' },
	]) {
		const body = bodyFor({ travel: args => ({ result: args.build ? result : noRoute }) });
		const ended = await searchFor({ structure: 'fortress' }, body, { timeoutMs: 20000 });
		assert.deepEqual(body.calls.map(c => c.build), [false, true], result.reasonCode);
		assert.match(ended.reasonCode, /^FIND_(DANGER|BLOCKED)$/);
		if (result.actionId) assert.match(ended.message, /live-build/);
	}
});

test('a walking refusal at the deadline starts no building retry', async () => {
	const body = bodyFor({ travel: () => ({ result: noRoute, ms: 15000 }) });
	await searchFor({ structure: 'fortress' }, body, { timeoutMs: 20000 });
	assert.deepEqual(body.calls.map(c => c.build), [false]);
});

test('unseen Nether spawners keep the canonical walking-first fallback without early retries', async () => {
	const body = bodyFor();
	await searchFor({ block: 'minecraft:spawner' }, body, { timeoutMs: 120000 });
	assert.deepEqual(body.calls.map(c => c.build), [...Array(8).fill(false), ...Array(8).fill(true)]);
});

test('a partial walking leg in a small radius keeps the short retry inside the original circle', async () => {
	const body = bodyFor({ travel: (args, i) => i === 1 ? { result: noRoute, move: { z: 3.5 } } : { result: args.build ? found : noRoute } });
	await searchFor({ structure: 'fortress' }, body, { within: 16, timeoutMs: 20000 });
	const retry = body.calls[1];
	assert.equal(retry.build, true);
	assert.equal(retry.yaw, body.calls[0].yaw);
	assert.ok(retry.distance <= body.calls[0].distance, 'retain the radius-scaled leg size');
	assert.ok(Math.hypot(-Math.sin(retry.yaw * Math.PI / 180) * retry.distance,
		3 + Math.cos(retry.yaw * Math.PI / 180) * retry.distance) <= 16);
});

test('no viable construction retry fits when a partial walk leaves less than eight radial blocks', async () => {
	const body = bodyFor({ travel: (_, i) => i === 1 ? { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: { z: 8.5 } }
		: i === 2 ? { result: noRoute, move: { z: 11.5 } } : { result: noRoute, ms: 30000 } });
	await searchFor({ structure: 'fortress' }, body, { within: 16, timeoutMs: 20000 });
	assert.equal(body.calls.some(c => c.build), false);
});
