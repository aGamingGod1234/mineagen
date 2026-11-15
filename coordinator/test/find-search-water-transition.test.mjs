import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';

const ok = (reasonCode = 'ARRIVED') => ({ state: 'SUCCEEDED', reasonCode });
const stop = (reasonCode) => ({ state: 'FAILED', reasonCode });
const source = { blockId: 'minecraft:water', x: 12, y: 24, z: 20, state: { level: '0' } };

// Reproduce native 514's transition after eight failed nonbuilding headings. Sky facts here are explicit fixture facts;
// saved protocol observations omit them, so this is a policy regression, not a replay of the saved world.
function transitionBody(next, { skyOpen = false, unknownSky = false, known, heard = [] } = {}) {
	let player = { x: 0.5, y: 67, z: 0.5, yaw: 0, health: 20, skyOpen: true }, blocks = [], clock = 0;
	const calls = [];
	let descended = false;
	return {
		calls, now: () => clock, places: async () => [],
		observe: async () => ({ player: { ...player }, blocks, inventory: { items: [] }, world: { dimension: 'minecraft:overworld' } }),
		frontier: () => ({ candidates: [], coverage: { headings: {} } }),
		openSky: () => ({ x: 0.5, y: 67, z: 0.5 }),
		known: () => ({ blocks: descended ? known ?? [] : [] }),
		look: async () => { clock += 1000; return { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			calls.push({ actionType, args, y: player.y }); clock += 1000;
			if (!descended) {
				if (!args.build) return stop('NO_ROUTE');
				descended = true;
				player = { ...player, x: 10.7, y: 25, z: 20, skyOpen: unknownSky ? undefined : skyOpen, heard };
				return ok();
			}
			const row = next({ actionType, args, player, calls }) ?? {};
			player = { ...player, ...row.player }; blocks = row.blocks ?? blocks;
			clock += row.ms ?? 0;
			return row.result ?? stop('NO_TOOL');
		},
	};
}
const movements = (body) => body.calls.filter(({ actionType }) => ['travel_to', 'dig_to'].includes(actionType));
const run = (body, options = {}) => searchFor({ block: 'minecraft:water' }, body, { timeoutMs: 120_000, ...options });

test('water surface search re-enters ascent after a building leg descends, then resumes surface walking', async () => {
	const body = transitionBody(({ args }) => args.retrace
		? { result: ok(), player: { x: 0.5, y: 67, z: 0.5, skyOpen: true } }
		: { result: ok(), blocks: [{ ...source, y: 66 }] });
	const result = await run(body);
	assert.equal(result.reasonCode, 'FIND_SEEN');
	const moves = movements(body);
	assert.equal(moves.filter(({ args }) => args.distance === 80).length, 9);
	assert.equal(moves[8].args.build, true);
	assert.equal(moves[9].args.retrace, true, 'ascent before another heading underground');
	assert.equal(moves[10].args.build, false);
	assert.equal(moves[10].y, 67);
});

test('water transition listens before ascent and requires an actual source sighting', async () => {
	const body = transitionBody(({ actionType }) => actionType === 'look_at' ? { result: ok(), blocks: [source] } : {},
		{ heard: [{ sound: 'block.water.ambient', direction: 'right', elevation: 'below', distance: 6 }] });
	assert.equal((await run(body)).reasonCode, 'FIND_SEEN');
	assert.equal(body.calls[9].actionType, 'look_at');
	assert.equal(body.calls.length, 10);
});

test('water transition tries a nearby remembered source without digging, but memory alone is no success', async () => {
	for (const visible of [true, false]) {
		const body = transitionBody(({ args }) => args.x === 12.5
			? { result: ok(), blocks: visible ? [source] : [] } : {}, { known: [source] });
		const result = await run(body);
		assert.equal(body.calls[9].args.x, 12.5);
		assert.equal(body.calls[9].args.build, false);
		assert.equal(result.reasonCode === 'FIND_SEEN', visible);
	}
});

test('an ascent that stalls returns geometry instead of more surface headings', async () => {
	const body = transitionBody(() => ({ result: stop('NO_ROUTE') }));
	const result = await run(body);
	assert.equal(result.reasonCode, 'FIND_BLOCKED');
	assert.match(result.message, /underground.*surface/i);
	assert.equal(movements(body).filter(({ args }) => args.distance !== undefined).length, 9);
	assert.ok(body.calls.length < 20, 'uses existing ascent stall guard');
});

test('transition preserves ascent tool, air, death, cancellation and boundary stops', async () => {
	for (const [reasonCode, expected] of [['NO_TOOL', 'FIND_BLOCKED'], ['TOOL_WORN', 'FIND_BLOCKED'], ['AIR_RESERVE_REACHED', 'FIND_DANGER'], ['BREATH_NOT_COVERED', 'FIND_DANGER'], ['SEARCH_BOUNDARY', 'FIND_NOT_FOUND']]) {
		const body = transitionBody(() => ({ result: stop(reasonCode) }));
		const result = await run(body);
		assert.equal(result.reasonCode, expected, `${reasonCode}: ${result.message}`);
		assert.equal(body.calls.length, 10);
	}
	for (const interruptedBy of ['model', 'death']) {
		const body = transitionBody(() => ({ result: { state: 'CANCELLED', reasonCode: 'STEER', interruptedBy, actionId: 'still-running' } }));
		assert.equal((await run(body)).reasonCode, 'FIND_DANGER');
		assert.equal(body.calls.length, 10);
	}
});

test('transition keeps real creeper danger ahead of ascent continuation', async () => {
	const body = transitionBody(() => ({ result: stop('HOSTILE_NEAR'), player: { threats: [{ type: 'minecraft:creeper', distance: 3.6, targeting: true }] } }));
	assert.equal((await run(body)).reasonCode, 'FIND_DANGER');
	assert.equal(body.calls.length, 10);
});

test('ascent retains the original within circle and block cap', async () => {
	const body = transitionBody(() => ({ result: stop('NO_ROUTE') }));
	await run(body, { within: 200 });
	const stair = body.calls.find(({ actionType }) => actionType === 'dig_to');
	assert.ok(stair);
	assert.equal(stair.args.maxBlocks, 80);
	for (const { args } of movements(body)) {
		assert.deepEqual([args.boundaryX, args.boundaryZ, args.boundaryRadius], [0.5, 0.5, 200]);
		assert.equal(args.stopWhenSeen, 'minecraft:water');
	}
});

test('open sky and unknown sky facts retain the surface route without speculative ascent', async () => {
	for (const skyOpen of [true, undefined]) {
		const body = transitionBody(() => ({ result: ok(), blocks: [source] }), { skyOpen, unknownSky: skyOpen === undefined });
		assert.equal((await run(body)).reasonCode, 'FIND_SEEN');
		assert.equal(body.calls[9].args.distance, 80);
		assert.equal(body.calls[9].args.build, false);
	}
});


test('ascent exhausting the existing search deadline returns budget, without another heading', async () => {
	const body = transitionBody(() => ({ result: stop('NO_ROUTE'), ms: 120_000 }));
	assert.equal((await run(body)).reasonCode, 'FIND_BUDGET');
	assert.equal(body.calls.length, 10);
});

test('the remembered open-sky spot under cover still counts as outside after ascent', async () => {
	const body = transitionBody(({ args }) => args.retrace
		? { result: ok(), player: { x: 1.5, y: 67, z: 0.5, skyOpen: false } }
		: { result: ok(), blocks: [source] });
	assert.equal((await run(body)).reasonCode, 'FIND_SEEN');
	assert.equal(body.calls[9].args.retrace, true);
	assert.equal(body.calls[10].args.build, false);
	assert.ok(!body.calls.some(({ actionType }) => actionType === 'dig_to'));
});

test('successful ascent with too little time left returns budget before another surface leg', async () => {
	for (const ms of [98_000, 100_000]) {
		const body = transitionBody(({ args }) => args.retrace
			? { result: ok(), player: { x: 0.5, y: 67, z: 0.5, skyOpen: true }, ms }
			: { result: stop('NO_TOOL') });
		assert.equal((await run(body)).reasonCode, 'FIND_BUDGET');
		assert.equal(body.calls.length, 10, 'successful ascent is the final action');
	}
});

test('ascent sighting and danger remain ahead of budget expiry', async () => {
	for (const danger of [false, true]) {
		const body = transitionBody(() => ({ ms: 100_000,
			result: danger ? stop('HOSTILE_NEAR') : ok(),
			player: { x: 0.5, y: 67, z: 0.5, skyOpen: true,
				...(danger ? { threats: [{ type: 'minecraft:creeper', distance: 3.6, targeting: true }] } : {}) },
			blocks: danger ? [] : [{ ...source, y: 66 }] }));
		assert.equal((await run(body)).reasonCode, danger ? 'FIND_DANGER' : 'FIND_SEEN');
		assert.equal(body.calls.length, 10);
	}
});

test('initial cover near remembered sky still listens for nearby water before walking', async () => {
	let clock = 0, blocks = [];
	const calls = [], player = { x: 0.5, y: 67, z: 0.5, yaw: 0, health: 20, skyOpen: false,
		heard: [{ sound: 'block.water.ambient', direction: 'right', elevation: 'below', distance: 6 }] };
	const body = {
		calls, now: () => clock, places: async () => [], known: () => ({ blocks: [] }),
		observe: async () => ({ player, blocks, inventory: { items: [] }, world: { dimension: 'minecraft:overworld' } }),
		openSky: () => ({ x: 0.5, y: 67, z: 0.5 }),
		frontier: () => ({ candidates: [], coverage: { headings: {} } }),
		look: async () => { clock += 1000; return { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			calls.push({ actionType, args }); clock += 1000;
			if (actionType === 'look_at') { blocks = [{ ...source, x: -5, y: 63, z: 0 }]; return ok(); }
			return stop('NO_TOOL');
		},
	};
	assert.equal((await run(body)).reasonCode, 'FIND_SEEN');
	assert.deepEqual(calls.map(({ actionType }) => actionType), ['look_at']);
});
