// Loops the 4-seed model check (obtain branch b8db7cee, gpt-6.1-sol low, 20 min, iron pickaxe) showed, each replayed
// from that run's own positions and messages: a stop that comes back on the same spot moves the body on or hands back.
import test from 'node:test';
import assert from 'node:assert/strict';
import { searchFor } from '../src/find-search.mjs';
import { runObtain } from '../src/obtain-runner.mjs';
import { ObservedMemoryStore } from '../src/observed-memory-store.mjs';

const sample = (player, extra = {}) => ({ player: { yaw: 0, health: 20, ...player }, world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' },
	inventory: { items: [{ itemId: 'minecraft:stone_pickaxe', count: 1 }] }, ...extra });

/** A scripted body (as find-search.test.mjs), with the runtime's missed-place memory shared across searches. */
function scriptedBody({ start, acts = {}, known = null, missed = [] }) {
	let observation = structuredClone(start), clock = 0;
	const calls = [];
	return {
		calls, missed,
		now: () => clock,
		progress: () => {},
		observe: async () => structuredClone(observation),
		look: async () => { calls.push({ look: true }); clock += 2_000; return { state: 'SUCCEEDED', survey: {} }; },
		act: async (actionType, args) => {
			calls.push({ actionType, args });
			const script = (typeof acts[actionType] === 'function' ? acts[actionType](observation.player) : acts[actionType]?.shift()) ?? { result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' } };
			clock += script.ms ?? 30_000;
			if (script.move) observation = { ...observation, player: { ...observation.player, ...script.move(observation.player, args) } };
			return script.result;
		},
		frontier: () => ({ candidates: [], coverage: { headings: {} } }),
		known: () => known,
		places: async () => [],
		missedPlaces: () => missed,
		missPlace: (place, why) => missed.push({ ...place, why }),
	};
}

test('B-1: water under a spot stops one dig down there, then the body moves off, not four digs one per heading', async () => {
	// B-1 at 6.26 min: steep_down from y64 stopped at 12,58,-45 on an aquifer, then three more digs down from that spot
	// (west, north, east) each stopped by the same water before "off this spot".
	const wet = (cell) => ({ result: { state: 'FAILED', reasonCode: 'WATER_AHEAD',
		message: `Stopped: Water at ${cell} beside the opened cell; water on 3 sides of it: a body of water (an aquifer or lake), not a trickle; not going further. At 12,58,-45, steep_down heading west` }, ms: 3_000 });
	// Every dig down from the start and from 12,58,-45 meets the water; from anywhere else the dig sees iron.
	const digAt = (player) => player.y === 64 && player.x === 10.5 ? { ...wet('13,56,-45'), move: () => ({ x: 12.5, y: 58, z: -44.5 }), ms: 11_000 }
		: player.x === 12.5 && player.y === 58 ? wet('12,56,-44')
			: { result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 5,49,-22, 2.1 blocks away' }, move: () => ({ y: 50 }) };
	const body = scriptedBody({ start: sample({ x: 10.5, y: 64, z: -44.5, skyOpen: true }), acts: { dig_to: digAt,
		travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: 10.5, y: 64, z: -44.5 }) },
			{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: () => ({ x: -21.5, y: 64, z: -44.5 }) }] } });
	const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
	const digsBeforeMove = body.calls.findIndex((call) => call.actionType === 'travel_to');
	const digs = body.calls.slice(0, digsBeforeMove).filter((call) => call.actionType === 'dig_to').length;
	assert.equal(digs, 1, `digs down from the wet spot before moving off: ${digs}`);
	// Up out of the wet hole to where the search started, then 32 blocks clear of the water (gate B-4), then down again.
	const moves = body.calls.filter((call) => call.actionType === 'travel_to').map((call) => (call.args.retrace ? 'retrace' : `walk ${call.args.distance}`));
	assert.deepEqual(moves, ['retrace', 'walk 32']);
	assert.equal(result.reasonCode, 'FIND_SEEN');
});

test('the same dig stop twice on one spot moves the body off it', async () => {
	const stuck = () => ({ result: { state: 'FAILED', reasonCode: 'CAVE_OPENING', message: 'Stopped: No step block; no visible face to place a step block against' }, ms: 2_000 });
	const body = scriptedBody({ start: sample({ x: 0.5, y: 30, z: 0.5, skyOpen: false }), acts: { dig_to: [stuck(), stuck(), stuck(), stuck()],
		travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'ARRIVED' }, move: (p) => ({ x: p.x + 12 }) }] } });
	await searchFor({ block: 'minecraft:iron_ore' }, body, { timeoutMs: 60_000 });
	const firstMove = body.calls.findIndex((call) => call.actionType === 'travel_to');
	assert.equal(body.calls.slice(0, firstMove).filter((call) => call.actionType === 'dig_to').length, 2, 'two digs, then off the spot');
});

test('B-2: a mined vein leaves memory, so find does not dig 38 blocks back up into an aquifer toward it', () => {
	// B-2: obtain mined the iron at -485,62,-72 (action 58, VEIN_MINED, "no seen block of it is left"); find then went
	// "to remembered sighting" and "to remembered block" at that cell five times (actions 70, 75, 94, 140, 145).
	const memory = new ObservedMemoryStore();
	const world = { worldId: 'w', dimension: 'minecraft:overworld', gameTime: 100 };
	const iron = { blockId: 'minecraft:iron_ore', x: -485, y: 62, z: -72 };
	const view = (gameTime, extra = {}) => ({ ready: true, world: { ...world, gameTime }, position: { x: -484.8, y: 63, z: -71 }, ...extra });
	memory.ingest('a', view(100, { blocks: [{ ...iron, visible: true }], sighted: { veins: [{ blockId: iron.blockId, x: iron.x, y: iron.y, z: iron.z, visible: 1 }] } }), { snapshot: false });
	const before = memory.knownSources('a', view(110), /_ore$/);
	assert.ok(before.sightings.some((row) => row.x === -485 && row.y === 62 && row.z === -72), 'the vein is remembered as a sighting');
	assert.ok(before.blocks.some((row) => row.x === -485 && row.y === 62 && row.z === -72), 'and as a block');
	memory.recordResourceResult('a', view(120), { actionType: 'mine_vein', arguments: { x: -485, y: 62, z: -72, maxBlocks: 24 }, state: 'SUCCEEDED', reasonCode: 'VEIN_MINED',
		message: 'mined: 1 minecraft:iron_ore in 1.3 s; no seen block of it is left' });
	const after = memory.knownSources('a', view(130), /_ore$/);
	assert.deepEqual(after.sightings.filter((row) => row.kind === 'vein'), [], 'no vein sighting left');
	assert.deepEqual(after.blocks, [], 'no remembered block left');
	// A row the server repeats after the receipt does not bring it back.
	memory.ingest('a', view(125, { sighted: { veins: [{ blockId: iron.blockId, x: iron.x, y: iron.y, z: iron.z, visible: 1 }] } }), { snapshot: false });
	assert.deepEqual(memory.knownSources('a', view(130), /_ore$/).sightings.filter((row) => row.kind === 'vein'), []);
});

test('B-2 and B-3: one trip per remembered place, and a place a search could not reach is not tried by the next search', async () => {
	// B-3 at 13.51 min: "to remembered sighting" at 467,45,-149 stopped WATER_AHEAD; the next obtain call went there again.
	// B-2's sighting and remembered block were one cell: two trips each call.
	const known = { sightings: [{ what: 'minecraft:iron_ore', kind: 'vein', x: 467, y: 45, z: -150 }], blocks: [{ blockId: 'minecraft:iron_ore', x: 467, y: 45, z: -150 }] };
	const water = () => ({ result: { state: 'FAILED', reasonCode: 'WATER_AHEAD', message: 'Digging down toward y 45: Stopped: Water at 467,62,-150 fills the cut; water on 3 sides of it: a body of water (an aquifer or lake), not a trickle; not going further.' }, ms: 7_000 });
	const missed = [];
	const trips = [];
	for (let call = 0; call < 2; call++) {
		const body = scriptedBody({ start: sample({ x: 470.5, y: 70, z: -238.5, skyOpen: true }), known, missed,
			acts: { travel_to: [water(), water()], dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 470,30,-230' } }] } });
		await searchFor({ block: 'minecraft:iron_ore' }, body);
		trips.push(body.calls.filter((row) => row.actionType === 'travel_to' && row.args.x === 467.5).length);
	}
	assert.deepEqual(trips, [1, 0], `memory trips per search: ${trips}`);
	assert.equal(missed[0].why, 'WATER_AHEAD');
});

test('B-2 and B-4: underground, a remembered ore further than a short dig is left to the search at depth', async () => {
	// B-4 at 14.70 min: from y16 at -367,16,55, "to remembered sighting" -319,54,64 dug stairs up for 96 s until the
	// pickaxe wore out, then flooded on the next call. B-2 at 8.17 min: from y24, toward y62 (39 blocks), into an aquifer.
	for (const [start, place] of [[{ x: -366.5, y: 16, z: 55.5 }, { x: -319, y: 54, z: 64 }], [{ x: -484.5, y: 24, z: -78.5 }, { x: -485, y: 62, z: -72 }]]) {
		const body = scriptedBody({ start: sample({ ...start, skyOpen: false }), known: { sightings: [{ what: 'minecraft:iron_ore', kind: 'vein', ...place }], blocks: [] },
			acts: { dig_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: `minecraft:iron_ore seen at ${Math.floor(start.x)},${start.y},${Math.floor(start.z) + 3}` } }] } });
		const result = await searchFor({ block: 'minecraft:iron_ore' }, body);
		assert.equal(body.calls.filter((row) => row.actionType === 'travel_to').length, 0, `no trip from y${start.y} to y${place.y}`);
		assert.equal(result.reasonCode, 'FIND_SEEN');
	}
	// A near one is still a trip.
	const near = scriptedBody({ start: sample({ x: 451.5, y: 47, z: -146.5, skyOpen: false }), known: { sightings: [{ what: 'minecraft:iron_ore', kind: 'vein', x: 467, y: 45, z: -150 }], blocks: [] },
		acts: { travel_to: [{ result: { state: 'SUCCEEDED', reasonCode: 'TARGET_SEEN', message: 'minecraft:iron_ore seen at 467,45,-150' } }] } });
	await searchFor({ block: 'minecraft:iron_ore' }, near);
	assert.equal(near.calls.filter((row) => row.actionType === 'travel_to').length, 1);
});

test('B-3: a walk to a herd that stops out of reach is not followed by a hunt, and that herd is not walked at again', async () => {
	// B-3 at 10.03 and 12.63 min: "walk to the cow at 574,63,-71" stopped in water 70+ blocks short (NO_ROUTE,
	// OUT_OF_BLOCKS), and each time fight_until then saw no cow for 30 s.
	const calls = [];
	const at = { x: 492.3, y: 62, z: -165.5 };
	const body = {
		observe: async () => ({ player: { ...at, health: 20, yaw: 0, skyOpen: true }, world: { dimension: 'minecraft:overworld', biome: 'minecraft:plains' },
			inventory: { selectedSlot: 0, items: [{ itemId: 'minecraft:stone_sword', count: 1, slot: 0 }] }, blocks: [], entities: [], items: [] }),
		stopped: () => false, interrupted: () => false, note: () => {},
		search: async (target) => { calls.push(['search', target]); return { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', find: { seen: { x: 574, y: 63, z: -71, id: 'minecraft:cow' } } }; },
		moveTo: async () => ({ state: 'SUCCEEDED' }),
		mine: async () => ({ state: 'FAILED' }),
		gather: async () => ({ state: 'FAILED' }),
		act: async (type, args) => {
			calls.push([type, args]);
			if (type === 'travel_to') return { state: 'FAILED', reasonCode: 'NO_ROUTE', message: 'In water with no bank seen within 10 blocks' };
			if (type === 'fight_until') return { state: 'FAILED', reasonCode: 'NO_TARGET_SEEN', message: 'No minecraft:cow seen within 24 blocks for 30 s' };
			return { state: 'SUCCEEDED' };
		},
	};
	const result = await runObtain({ item: 'minecraft:beef', count: 3, timeoutMs: 600_000 }, body);
	const hunts = calls.filter(([type]) => type === 'fight_until').length;
	const walks = calls.filter(([type]) => type === 'travel_to').length;
	assert.equal(hunts, 0, `hunts where no cow was in reach: ${hunts}`);
	assert.equal(walks, 1, `walks toward the same far cow: ${walks}`);
	assert.equal(result.reasonCode, 'NO_SOURCE');
	assert.match(result.message, /could not reach the cow at 574,63,-71 \(NO_ROUTE, \d+ blocks short\)|no cow found/);
});
