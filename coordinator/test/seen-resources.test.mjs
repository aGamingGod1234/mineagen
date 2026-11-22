import test from 'node:test';
import assert from 'node:assert/strict';
import { observedResources, rememberResources, knownResources, knownResourceIds, newResourceMemory, RESOURCE_TTL_MS } from '../src/seen-resources.mjs';

const at = (x, y, z, extra = {}) => ({ player: { x, y, z }, world: { dimension: 'minecraft:overworld' }, ...extra });

test('placed blocks, containers and built mobs from one observation; terrain is left out', () => {
	const o = at(311.5, 77, -241.5, {
		blocks: [{ blockId: 'minecraft:grass_block', x: 311, y: 76, z: -241 }, { blockId: 'minecraft:oak_log', x: 299, y: 78, z: -229 }],
		sighted: { resources: [{ blockId: 'minecraft:cobblestone', x: 305, y: 77, z: -236, count: 14 }, { blockId: 'minecraft:chest', x: 300, y: 77, z: -230, count: 1, opened: false },
			{ blockId: 'minecraft:hay_block', x: 320, y: 77, z: -250, count: 5 }] },
		entities: [{ type: 'minecraft:iron_golem', x: 302.9, y: 77, z: -224.1, stableId: 'g1' }, { type: 'minecraft:item', x: 1, y: 2, z: 3 }],
	});
	const rows = observedResources(o, { now: 1 });
	const by = (id) => rows.find((row) => row.id === id);
	assert.equal(by('minecraft:grass_block'), undefined, 'terrain is no row');
	assert.equal(by('minecraft:cobblestone').kind, 'block');
	assert.equal(by('minecraft:cobblestone').placed, true);
	assert.equal(by('minecraft:cobblestone').count, 14);
	assert.equal(by('minecraft:chest').kind, 'container');
	assert.equal(by('minecraft:chest').opened, false);
	assert.equal(by('minecraft:iron_golem').kind, 'mob');
	assert.equal(by('minecraft:iron_golem').placed, true, 'a golem is a built mob');
	assert.equal(by('minecraft:iron_golem').stableId, 'g1');
	assert.equal(by('minecraft:item'), undefined);
});

test('remembered across observations, nearest first, merged per neighbourhood, dropped when mined or stale', () => {
	const memory = newResourceMemory();
	rememberResources(memory, at(311.5, 77, -241.5, { sighted: { resources: [{ blockId: 'minecraft:cobblestone', x: 305, y: 77, z: -236, count: 14 }] } }), { now: 1000 });
	// Out of view later: still known, with distance from the new position.
	let rows = knownResources(memory, at(320.5, 77, -241.5), { ids: ['cobblestone'] });
	assert.equal(rows.length, 1);
	assert.ok(rows[0].distance > 15 && rows[0].distance < 20, String(rows[0].distance));
	assert.ok(knownResourceIds(memory, at(320.5, 77, -241.5)).has('cobblestone'));
	// A nearer member of the same well refreshes the row rather than adding one.
	rememberResources(memory, at(306.5, 77, -237.5, { sighted: { resources: [{ blockId: 'minecraft:cobblestone', x: 306, y: 77, z: -237, count: 10 }] } }), { now: 2000 });
	assert.equal(knownResources(memory, at(306.5, 77, -237.5), { ids: ['minecraft:cobblestone'] }).length, 1);
	// The cell now shows air: mined, so forgotten.
	rememberResources(memory, at(306.5, 77, -237.5, { blocks: [{ blockId: 'minecraft:air', x: 306, y: 77, z: -237 }] }), { now: 3000 });
	assert.equal(knownResources(memory, at(306.5, 77, -237.5), { ids: ['cobblestone'] }).length, 0);
	// Stale rows go after the TTL.
	rememberResources(memory, at(0.5, 64, 0.5, { sighted: { resources: [{ blockId: 'minecraft:oak_planks', x: 4, y: 64, z: 4, count: 20 }] } }), { now: 0 });
	rememberResources(memory, at(0.5, 64, 0.5), { now: RESOURCE_TTL_MS + 1 });
	assert.equal(knownResources(memory, at(0.5, 64, 0.5), { ids: ['oak_planks'] }).length, 0);
});

test('reads filter by kind, distance and opened containers', () => {
	const memory = newResourceMemory();
	rememberResources(memory, at(0.5, 64, 0.5, { sighted: { resources: [
		{ blockId: 'minecraft:chest', x: 3, y: 64, z: 0, count: 1, opened: true }, { blockId: 'minecraft:barrel', x: 40, y: 64, z: 0, count: 1, opened: false }] } }), { now: 1 });
	assert.deepEqual(knownResources(memory, at(0.5, 64, 0.5), { kinds: ['container'] }).map((row) => row.id), ['minecraft:chest', 'minecraft:barrel']);
	assert.deepEqual(knownResources(memory, at(0.5, 64, 0.5), { kinds: ['container'], includeOpened: false }).map((row) => row.id), ['minecraft:barrel']);
	assert.deepEqual(knownResources(memory, at(0.5, 64, 0.5), { maxDistance: 10 }).map((row) => row.id), ['minecraft:chest']);
});

test('an ore a dig sighted through rock is a row with enclosed: true until seen along a sight line', async () => {
	const { rememberKnownBlocks } = await import('../src/seen-resources.mjs');
	const memory = newResourceMemory();
	rememberKnownBlocks(memory, at(0.5, 40, 0.5), [{ blockId: 'minecraft:iron_ore', x: 5, y: 38, z: 2 }], { now: 1 });
	let row = knownResources(memory, at(0.5, 40, 0.5), { ids: ['iron_ore'] })[0];
	assert.equal(row.enclosed, true);
	assert.equal(row.source, 'vein');
	rememberResources(memory, at(0.5, 40, 0.5, { blocks: [{ blockId: 'minecraft:iron_ore', x: 5, y: 38, z: 2 }] }), { now: 2 });
	row = knownResources(memory, at(0.5, 40, 0.5), { ids: ['iron_ore'] })[0];
	assert.equal(row.enclosed, false);
});

test('each door is its own row, named with the village it stands in', () => {
	const memory = newResourceMemory();
	rememberResources(memory, at(311.5, 77, -241.5, { sighted: {
		structures: [{ structure: 'village', size: 10, x: 311, y: 78, z: -239 }],
		resources: [{ blockId: 'minecraft:oak_door', x: 300, y: 77, z: -230, count: 1 }, { blockId: 'minecraft:oak_door', x: 322, y: 77, z: -250, count: 1 },
			{ blockId: 'minecraft:oak_door', x: 400, y: 70, z: -241, count: 1 }] } }), { now: 1 });
	const doors = knownResources(memory, at(311.5, 77, -241.5), { ids: ['oak_door'] });
	assert.equal(doors.length, 3, 'one row per door');
	assert.deepEqual(doors.slice(0, 2).map((row) => row.structure), ['village', 'village']);
	assert.equal(doors[2].structure, undefined, 'a door far from any sighted structure names none');
});

test('remembering stays cheap on a busy scene: 600 local rows and 24 resource rows a sample, 200 samples, memory bounded', () => {
	const memory = newResourceMemory();
	const ids = ['oak_leaves', 'poppy', 'oak_log', 'torch', 'oak_planks', 'cobblestone', 'hay_block', 'white_bed', 'oak_door', 'iron_ore'];
	let worst = 0;
	for (let step = 0; step < 200; step++) {
		const px = step * 3;
		const blocks = Array.from({ length: 600 }, (_, i) => ({ blockId: `minecraft:${ids[i % ids.length]}`, x: px + ((i * 7) % 41) - 20, y: 64 + (i % 5), z: ((i * 13) % 41) - 20 }));
		const resources = Array.from({ length: 24 }, (_, i) => ({ blockId: `minecraft:${ids[(i * 3) % ids.length]}`, x: px + i * 2, y: 64, z: i, count: 3 }));
		const o = at(px, 64, 0, { blocks, sighted: { resources } });
		const started = performance.now();
		rememberResources(memory, o, { now: step });
		knownResources(memory, o);
		worst = Math.max(worst, performance.now() - started);
	}
	assert.ok(memory.rows.size < 3000, `memory stays bounded: ${memory.rows.size} rows`);
	assert.ok(worst < 25, `worst sample took ${worst.toFixed(1)} ms`);
});
