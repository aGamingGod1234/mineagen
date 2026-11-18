import test from 'node:test';
import assert from 'node:assert/strict';
import { placementCells } from '../src/obtain-runner.mjs';
import { NativeToolRuntime } from '../src/native-tool-runtime.mjs';
import { adaptObservation } from '../src/observation-adapter.mjs';

// K6 (issue #2): obtain's station cells. Each seen block row lists the faces the body can click now to place into the
// cell beside it (placeableFaces). 453 of 646 NO_PLACEMENT_SUPPORT failures placed a crafting table in a cell none of
// whose seen supports could be clicked into.
const FACES = [['up', 0, -1, 0], ['down', 0, 1, 0], ['north', 0, 0, 1], ['south', 0, 0, -1], ['west', 1, 0, 0], ['east', -1, 0, 0]];
const key = (cell) => `${cell.x},${cell.y},${cell.z}`;

// A body on a stone floor. The floor's top faces west of it (x < 0) and the wall north of it are hidden from the eye:
// the server lists no face for them. A tall grass plant stands on a hidden floor block.
// The faces are judged for cobblestone standing in for a full block (the hand holds no block item).
const STAND_IN = { sections: { blocks: { placeableFacesFor: 'minecraft:cobblestone', placeableFacesStandIn: true } } };
function scene({ withFaces = true, coverage = STAND_IN } = {}) {
	const blocks = [];
	const faces = (list) => (withFaces ? { placeableFaces: list } : {});
	for (let x = -3; x <= 3; x++) for (let z = -3; z <= 3; z++) blocks.push({ blockId: 'minecraft:stone', x, y: 63, z, ...faces(x < 0 ? [] : ['up']) });
	for (let x = -3; x <= 3; x++) for (const y of [64, 65, 66]) blocks.push({ blockId: 'minecraft:stone', x, y, z: -3, ...faces([]) });
	blocks.push({ blockId: 'minecraft:short_grass', x: -1, y: 64, z: 1, replaceable: true, ...faces([]) });
	return { player: { x: 0.5, y: 64, z: 0.5, onGround: true }, blocks, ...(coverage === null ? {} : { coverage }) };
}

/** Whether place_block into this cell would fail NO_PLACEMENT_SUPPORT: seen supports, none clickable toward it, no plant. */
function doomed(o, cell) {
	const at = new Map(o.blocks.map((row) => [key(row), row]));
	if (at.get(key(cell))?.replaceable === true) return false;
	const supports = FACES.map(([name, ox, oy, oz]) => ({ name, row: at.get(`${cell.x + ox},${cell.y + oy},${cell.z + oz}`) }))
		.filter(({ row }) => row !== undefined && row.replaceable !== true);
	return supports.length > 0 && supports.every(({ name, row }) => !row.placeableFaces.includes(name));
}

test('K6: no cell offered for a station is one no seen support face can be clicked into; a plant cell stays', () => {
	const o = scene();
	// ensureStation tries the first 8 cells. Metric: offered cells that would fail NO_PLACEMENT_SUPPORT. Pass bar: 0.
	const offered = placementCells(o, new Set(), { trail: ['-1,64,0', '1,64,0'] }).slice(0, 8);
	assert.equal(offered.length, 8);
	const failing = offered.filter((cell) => doomed(o, cell));
	assert.deepEqual(failing.map(key), [], 'cells offered that the server would refuse');
	// Every cell offered names a face its support lists.
	const at = new Map(o.blocks.map((row) => [key(row), row]));
	for (const cell of offered) {
		if (at.get(key(cell))?.replaceable === true) continue;
		const [, ox, oy, oz] = FACES.find(([name]) => name === cell.face);
		assert.ok(at.get(`${cell.x + ox},${cell.y + oy},${cell.z + oz}`)?.placeableFaces?.includes(cell.face), `${key(cell)} face ${cell.face}`);
	}
	const all = placementCells(o, new Set(), { trail: ['-1,64,0', '1,64,0'] });
	assert.ok(all.some((cell) => key(cell) === '-1,64,1'), 'the grass cell is clicked directly and stays a candidate');
	assert.ok(!all.some((cell) => key(cell) === '-1,64,0'), 'a cell the body stood in over a hidden floor is no candidate');
	assert.ok(all.some((cell) => key(cell) === '1,64,0'), 'one over a floor it can click stays first');
});

test('K6: support rows without placeableFaces say nothing, and cells are offered as before', () => {
	const o = scene({ withFaces: false });
	const all = placementCells(o, new Set(), { trail: ['-1,64,0', '1,64,0'] });
	assert.ok(all.some((cell) => key(cell) === '-1,64,0') && all.some((cell) => cell.x < 0 && cell.y === 64), 'cells over floors of unknown faces stay');
	assert.ok(all.every((cell) => cell.face === 'up' || cell.y !== 64), 'ground cells still click the floor top');
	// Remembered block rows carry the lists from where the body stood then: they say nothing either.
	const remembered = { ...scene(), continuity: { rememberedSections: ['blocks'] } };
	assert.ok(placementCells(remembered, new Set(), { trail: ['-1,64,0'] }).some((cell) => key(cell) === '-1,64,0'));
});

test('K6: faces judged for a held sapling or seeds say nothing about a station, and every cell stays a candidate', () => {
	// A sapling only goes on dirt: every stone support lists no face. The table is a full cube and fits there.
	const sapling = { sections: { blocks: { placeableFacesFor: 'minecraft:oak_sapling' } } };
	const o = scene({ coverage: sapling });
	for (const row of o.blocks) row.placeableFaces = [];
	const all = placementCells(o, new Set(), { trail: ['-1,64,0', '1,64,0'] });
	assert.ok(all.length >= 8, `cells offered: ${all.length}`);
	assert.ok(all.some((cell) => key(cell) === '1,64,0') && all.some((cell) => key(cell) === '-1,64,0'), 'cells over the floor stay');
	// The same lists judged for a full block (or with no basis named) would shut these cells; with no basis they stay.
	assert.ok(placementCells(scene({ coverage: null }), new Set(), { trail: ['-1,64,0'] }).some((cell) => key(cell) === '-1,64,0'), 'no basis named: unknown');
	for (const held of ['minecraft:oak_planks', 'minecraft:spruce_log', 'minecraft:cobblestone']) {
		const full = scene({ coverage: { sections: { blocks: { placeableFacesFor: held } } } });
		assert.ok(!placementCells(full, new Set(), { trail: ['-1,64,0'] }).some((cell) => key(cell) === '-1,64,0'), `a held ${held} judges the faces`);
	}
});

test('K6: the basis reaches placementCells through the observation adapter and the runtime, as obtain reads it', () => {
	const scenery = scene();
	const wire = { ready: true, position: { x: 0.5, y: 64, z: 0.5 }, velocity: { x: 0, y: 0, z: 0 }, view: { yaw: 0, pitch: 0 },
		player: { health: 20, maxHealth: 20, armor: 0, foodLevel: 20, saturation: 5, gameMode: 'survival', onGround: true, inWater: false, onFire: false,
			air: 300, maxAir: 300, suffocating: false, fallDistance: 0, effects: [] },
		inventory: { items: [], selectedItem: 'minecraft:air' }, entities: [], blocks: scenery.blocks.map((row) => ({ ...row, replaceable: row.replaceable === true })), nearbyContainers: [],
		world: { dimension: 'minecraft:overworld', gameTime: 1, dayTime: 1, raining: false, thundering: false },
		currentAction: { active: false }, lastResult: { present: false },
		coverage: { mode: 'sampled_visible', complete: false, sections: { blocks: { returned: scenery.blocks.length, complete: false, placeableFacesFor: 'minecraft:cobblestone', placeableFacesStandIn: true } } } };
	const record = { agentId: 'agent-a', provider: 'claude', model: 'claude-opus-5-5', reasoningEffort: 'low', serviceTier: 'standard', goalRevision: 3, currentGoal: 'beat the game' };
	const runtime = new NativeToolRuntime({ bridge: { send: async () => {} } });
	runtime.updateObservation(record, adaptObservation(wire), { eventSequence: 2 });
	const o = runtime.decorateObservation(record, adaptObservation(wire), { deliver: false });
	assert.equal(o.coverage?.sections?.blocks?.placeableFacesStandIn, true, 'the basis survives');
	const all = placementCells(o, new Set(), { trail: ['-1,64,0', '1,64,0'] });
	assert.ok(!all.some((cell) => key(cell) === '-1,64,0'), 'a cell over a hidden floor is dropped');
	assert.ok(all.some((cell) => key(cell) === '1,64,0'), 'one over a floor it can click stays');
});
