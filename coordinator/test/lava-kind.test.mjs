import test from 'node:test';
import assert from 'node:assert/strict';
import { createSearch, recordSightings, restoreSearch, serializeSearch } from '../src/search-coverage.mjs';
import { knownLine, obsidianOptions } from '../src/need-sources.mjs';

const place = (x, y, z) => ({ x, y, z, distance: 40, bearing: 0 });
// A recorded fresh game's surface scene: a lavafall near the body, a pocket farther, the lake farther still.
const SCENE = {
	blocks: [
		{ blockId: 'minecraft:lava', count: 8, flowing: true, ...place(30, 74, 0) },
		{ blockId: 'minecraft:lava', count: 3, small: true, ...place(0, 60, 60) },
		{ blockId: 'minecraft:lava', count: 20, ...place(-120, 40, 0) },
	],
};
const AT = { x: 0, y: 70, z: 0 };

function remembered(env) {
	const saved = process.env.MINEAGEN_LAVA_KIND;
	if (env === undefined) delete process.env.MINEAGEN_LAVA_KIND; else process.env.MINEAGEN_LAVA_KIND = env;
	try {
		const search = createSearch();
		recordSightings(search, SCENE, 10);
		return search;
	} finally {
		if (saved === undefined) delete process.env.MINEAGEN_LAVA_KIND; else process.env.MINEAGEN_LAVA_KIND = saved;
	}
}
const sightings = (search) => [...search.sightings.values()];

test('remembered far lava keeps the server tag: a fall, a pocket and a pool, through persistence', () => {
	const search = remembered();
	assert.deepEqual(sightings(search).map((row) => [row.x, row.flowing ?? false, row.small ?? false, row.pool ?? false]),
		[[30, true, false, false], [0, false, true, false], [-120, false, false, true]]);
	const restored = restoreSearch(JSON.parse(JSON.stringify(serializeSearch(search))));
	assert.deepEqual(sightings(restored), sightings(search));
});

test('the known line names falls and pockets and lists the pool first, though it is farthest', () => {
	const line = knownLine({ known: { sightings: sightings(remembered()), blocks: [] }, position: AT });
	const lava = line.slice(line.indexOf('lava: '));
	assert.match(lava, /^lava: lava pool\(enough for a frame\) 120m/);
	assert.ok(lava.indexOf('lava pocket(too few for a frame)') < lava.indexOf('lavafall(no source in sight)'), lava);
});

test('obsidian options leave out falls and pockets and count a pool as usable', () => {
	const text = obsidianOptions({ position: AT, known: { sightings: sightings(remembered()), blocks: [] }, items: [{ itemId: 'minecraft:water_bucket', count: 1 }] });
	assert.equal((text.match(/lava \d+m/g) ?? []).length, 1, text);
	assert.match(text, /lava 120m W dy-30 y40 ~\d+ \(walk \d+, 10 casts \d+; enough sources for a frame seen\)/);
});

test('flowing lava at the lake layer stays an obsidian option: it runs from a lake there', () => {
	const search = createSearch();
	recordSightings(search, { blocks: [{ blockId: 'minecraft:lava', count: 4, flowing: true, ...place(40, -52, 0) }] }, 3);
	const text = obsidianOptions({ position: { x: 0, y: -40, z: 0 }, known: { sightings: sightings(search), blocks: [] } });
	assert.match(text, /lava 40m E dy-12 y-52 ~/);
	const line = knownLine({ known: { sightings: sightings(search), blocks: [] }, position: { x: 0, y: -40, z: 0 } });
	assert.match(line, /lava: lava\(flowing at the lake layer; source unseen\) 40m/);
});

test('a cell once seen as a pool stays a pool when a later look tags it flowing or small', () => {
	const search = createSearch();
	recordSightings(search, { blocks: [{ blockId: 'minecraft:lava', count: 14, ...place(-100, 78, -60) }] }, 1);
	recordSightings(search, { blocks: [{ blockId: 'minecraft:lava', count: 3, flowing: true, ...place(-101, 77, -62) }] }, 2);
	recordSightings(search, { blocks: [{ blockId: 'minecraft:lava', count: 2, small: true, ...place(-99, 78, -61) }] }, 3);
	assert.deepEqual(sightings(search).map((row) => [row.pool, 'flowing' in row, 'small' in row, row.tick]), [[true, false, false, 3]]);
});

test('with memory.lavaKind off the memory and the lines are as before', () => {
	const search = remembered('off');
	assert.ok(sightings(search).every((row) => row.flowing === undefined && row.small === undefined && row.pool === undefined));
	const line = knownLine({ known: { sightings: sightings(search), blocks: [] }, position: AT });
	assert.match(line, /lava: lava\(source unverified\) 30m/);
	const text = obsidianOptions({ position: AT, known: { sightings: sightings(search), blocks: [] } });
	assert.equal((text.match(/lava \d+m/g) ?? []).length, 3, text);
});

test('a cell holding both a fall and a pool is remembered as the pool', () => {
	const search = createSearch();
	recordSightings(search, { blocks: [
		{ blockId: 'minecraft:lava', count: 12, ...place(-60, -55, 2) },
		{ blockId: 'minecraft:lava', count: 2, flowing: true, ...place(-58, -54, 4) },
	] }, 5);
	assert.deepEqual(sightings(search).map((row) => [row.x, row.pool ?? false, row.flowing ?? false]), [[-60, true, false]]);
});
