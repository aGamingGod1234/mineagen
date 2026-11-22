import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ObservedMemoryStore } from '../src/observed-memory-store.mjs';
import { createSearch, recordSightings, serializeSearch, restoreSearch } from '../src/search-coverage.mjs';
import { pearlOptions } from '../src/need-sources.mjs';
import { findProfile, rememberedPlaces } from '../src/find-search.mjs';

const NETHER = 'minecraft:the_nether';
const sample = (gameTime, x, z, biome, extra = {}) => ({ world: { worldId: 'w', dimension: NETHER, gameTime, biome }, position: { x, y: 70, z }, ...extra });

test('a warped forest stood in is remembered and still known after a trip to the Overworld and back', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'forest-memory-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = new ObservedMemoryStore({ directory });
	store.ingest('a', sample(10, 100, 280, 'minecraft:warped_forest'));
	store.ingest('a', sample(20, 0, 0, 'minecraft:basalt_deltas'));
	store.ingest('a', { world: { worldId: 'w', dimension: 'minecraft:overworld', gameTime: 30, biome: 'minecraft:plains' }, position: { x: 12, y: 64, z: 35 } });
	await store.flush('a');
	const restored = new ObservedMemoryStore({ directory });
	await restored.load('a');
	const known = restored.knownSources('a', sample(40, 0, 0, 'minecraft:basalt_deltas'));
	const forest = known.sightings.filter((row) => row.kind === 'biome');
	assert.equal(forest.length, 1);
	assert.deepEqual({ what: forest[0].what, x: forest[0].x, z: forest[0].z, standing: forest[0].standing }, { what: 'minecraft:warped_forest', x: 100, z: 280, standing: true });
	assert.equal(restored.knownSources('a', { world: { worldId: 'w', dimension: 'minecraft:overworld' } }).sightings.filter((row) => row.kind === 'biome').length, 0, 'per dimension');
});

test('a forest surveyed far off is remembered from its survey row; other biomes are not', () => {
	const search = createSearch();
	recordSightings(search, { biomes: [{ biome: 'minecraft:warped_forest', x: 60, y: 71, z: -90 }, { biome: 'minecraft:soul_sand_valley', x: -50, y: 40, z: 0 }] }, 5, () => undefined, { dimension: NETHER });
	const rows = [...search.sightings.values()];
	assert.deepEqual(rows.map((row) => [row.kind, row.what, row.x, row.y, row.z]), [['biome', 'minecraft:warped_forest', 60, 71, -90]]);
	const round = restoreSearch(JSON.parse(JSON.stringify(serializeSearch(search))));
	assert.equal([...round.sightings.values()][0].kind, 'biome', 'kept through serialize and restore');
});

test('caves, ore and lava cannot push a remembered forest out; a long forest walk keeps at most 4 forest rows', () => {
	const search = createSearch();
	recordSightings(search, { biomes: [{ biome: 'minecraft:warped_forest', x: 60, y: 71, z: -90 }] }, 1, () => undefined, { dimension: NETHER });
	for (let i = 0; i < 48; i++) recordSightings(search, { caves: [{ x: i * 20, y: 30, z: 0, air: 80 }], blocks: [{ blockId: 'minecraft:lava', x: i * 20, y: 20, z: 40 }], veins: [{ blockId: 'minecraft:nether_gold_ore', x: i * 20, y: 25, z: 80, visible: 2 }] }, 2 + i, () => undefined, { dimension: NETHER });
	assert.ok([...search.sightings.values()].some((row) => row.kind === 'biome'), 'the forest survives 48 transient rows of each kind');
	recordSightings(search, { structures: [{ structure: 'nether fortress', x: -300, y: 60, z: 0 }] }, 60, () => undefined, { dimension: NETHER });
	for (let i = 0; i < 12; i++) recordSightings(search, {}, 70 + i, () => undefined, { dimension: NETHER, biome: 'minecraft:warped_forest', at: { x: 200 + i * 64, y: 70, z: 0 } });
	const rows = [...search.sightings.values()];
	assert.equal(rows.filter((row) => row.kind === 'biome').length, 4);
	assert.ok(rows.some((row) => row.kind === 'structure'), 'a forest walk does not push out the fortress');
});

test('pearl options and find read the remembered forest', () => {
	const known = { sightings: [{ kind: 'biome', what: 'minecraft:warped_forest', x: 100, y: 70, z: 280, tick: 10 }], blocks: [], tick: 400 };
	const text = pearlOptions({ observation: { world: { dimension: NETHER, biome: 'minecraft:basalt_deltas' }, entities: [] }, position: { x: 0, y: 70, z: 0 }, known, items: [], needed: 12 });
	assert.match(text, /warped forest 297m \w+ \(walk/);
	const places = rememberedPlaces(findProfile({ biome: 'minecraft:warped_forest' }, NETHER), known, [], { x: 0, y: 70, z: 0 });
	assert.equal(places.length, 1);
	assert.equal(places[0].via, 'remembered sighting');
	assert.equal(rememberedPlaces(findProfile({ biome: 'minecraft:crimson_forest' }, NETHER), known, [], { x: 0, y: 70, z: 0 }).length, 0);
});

test('a cell the body stood in keeps that verified point over a later far survey row of the same 32-block cell', () => {
	const search = createSearch();
	recordSightings(search, {}, 1, () => undefined, { dimension: NETHER, biome: 'minecraft:warped_forest', at: { x: 100, y: 70, z: 280 } });
	recordSightings(search, { biomes: [{ biome: 'minecraft:warped_forest', x: 110, y: 90, z: 270 }] }, 2, () => undefined, { dimension: NETHER });
	const rows = [...search.sightings.values()].filter((row) => row.kind === 'biome');
	assert.equal(rows.length, 1);
	assert.deepEqual([rows[0].x, rows[0].z, rows[0].standing], [100, 280, true]);
});

test('a body falling through a warped forest (knocked off a bridge) leaves no standing point', async (t) => {
	const directory = await mkdtemp(join(tmpdir(), 'forest-memory-'));
	t.after(() => rm(directory, { recursive: true, force: true }));
	const store = new ObservedMemoryStore({ directory });
	store.ingest('a', sample(10, 100, 280, 'minecraft:warped_forest', { player: { onGround: false } }));
	assert.equal(store.knownSources('a', sample(20, 0, 0, 'minecraft:basalt_deltas')).sightings.filter((row) => row.kind === 'biome' && row.standing).length, 0);
	store.ingest('a', sample(30, 100, 280, 'minecraft:warped_forest', { player: { onGround: true } }));
	assert.equal(store.knownSources('a', sample(40, 0, 0, 'minecraft:basalt_deltas')).sightings.filter((row) => row.kind === 'biome' && row.standing).length, 1, 'landed: remembered');
});
