// Containers as sources for obtain's planner: a chest the body knows of, or a sighted structure whose chests it has not
// found yet, priced by the walk to it and the mean count of each item one opened chest holds (config/loot-yield.json,
// from the game's own loot tables: scripts/loot-yield.mjs). A village, a shipwreck, a ruined portal or a mineshaft are
// the same thing to the planner: a place whose chests may hold what the plan needs.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

let cached = null;
export function lootYields() {
	cached ??= JSON.parse(readFileSync(fileURLToPath(new URL('../config/loot-yield.json', import.meta.url)), 'utf8')).tables;
	return cached;
}

// Which chest tables a sighted structure's chests roll from. Structures whose chests sit behind a fight the planner does
// not price (bastions, fortresses, ancient and end cities, trial chambers, mansions) are left out on purpose.
const STRUCTURE_TABLES = [
	[/^village/, (name) => name.startsWith('chests/village/')],
	[/^shipwreck/, (name) => /^chests\/shipwreck_/.test(name)],
	[/^ruined.portal/, (name) => name === 'chests/ruined_portal'],
	[/^(abandoned.)?mineshaft/, (name) => name === 'chests/abandoned_mineshaft'],
	[/^desert.(temple|pyramid)/, (name) => name === 'chests/desert_pyramid'],
	[/^jungle.(temple|pyramid)/, (name) => name === 'chests/jungle_temple'],
	[/^pillager.outpost/, (name) => name === 'chests/pillager_outpost'],
	[/^igloo/, (name) => name === 'chests/igloo_chest'],
	[/^buried.treasure/, (name) => name === 'chests/buried_treasure'],
	[/^(ocean|underwater).ruin/, (name) => /^chests\/underwater_ruin_/.test(name)],
	[/^stronghold/, (name) => /^chests\/stronghold_/.test(name)],
];
// How far from a structure's sighted point its chests lie (a village spreads wider than a shipwreck).
const STRUCTURE_REACH = { village: 64 };
const DEFAULT_REACH = 32;
export const structureReach = (name) => STRUCTURE_REACH[bare(name).replace(/_/g, ' ').toLowerCase().split(' ')[0]] ?? DEFAULT_REACH;
const CONTAINERS = /^(minecraft:)?(chest|trapped_chest|barrel)$/;

const bare = (value) => String(value ?? '').replace(/^minecraft:/, '');
const structureName = (row) => bare(row?.structure ?? row?.what ?? '').replace(/_/g, ' ').toLowerCase();

/** The chest tables of a structure by its sighted name, or [] when its chests are not a priced source. */
export function structureTables(name, yields = lootYields()) {
	const key = bare(name).replace(/_/g, ' ').toLowerCase();
	const match = STRUCTURE_TABLES.find(([pattern]) => pattern.test(key));
	return match ? Object.keys(yields).filter(match[1]) : [];
}

/** Mean count of an item in one opened chest of any of these tables (each table equally likely). */
export function chestYield(tables, item, yields = lootYields()) {
	if (tables.length === 0) return 0;
	const id = bare(item);
	return tables.reduce((sum, table) => sum + (yields[table]?.[id] ?? 0), 0) / tables.length;
}

const finite = (row) => [row?.x, row?.y, row?.z].every(Number.isFinite);
const key = (row) => `${Math.floor(row.x)},${Math.floor(row.y)},${Math.floor(row.z)}`;

/**
 * Loot sources the body knows now, nearest first: { kind: 'chest', x, y, z, distance, tables } for a container seen
 * inside a sighted structure and not opened, and { kind: 'structure', name, x, y, z, distance, tables } for a sighted
 * structure whose chests are still to be found. opened: cells ("x,y,z") this body has opened; searched: structure
 * points ("x,y,z") whose chest search came back empty; structures: earlier sightings ({ structure, x, y, z, dimension })
 * kept by the caller, since a structure leaves the sighted rows once the body walks off. A container outside any known structure is someone's storage,
 * not loot, and is not offered.
 */
export function lootSources(o, { opened = new Set(), searched = new Set(), structures: known = [], yields = lootYields() } = {}) {
	const at = o?.position ?? o?.player;
	if (!finite(at)) return [];
	const dimension = o.world?.dimension;
	const structures = (o.sighted?.structures ?? []).filter(finite)
		.map((row) => ({ name: structureName(row), x: row.x, y: row.y, z: row.z, tables: structureTables(structureName(row), yields) }))
		.filter((row) => row.tables.length > 0);
	const remembered = known.filter((row) => finite(row) && (!row.dimension || row.dimension === dimension))
		.map((row) => ({ name: structureName(row), x: row.x, y: row.y, z: row.z, tables: structureTables(structureName(row), yields) }))
		.filter((row) => row.tables.length > 0 && !structures.some((s) => s.name === row.name && Math.hypot(s.x - row.x, s.z - row.z) < 48));
	const all = [...structures, ...remembered];
	const distance = (row) => Math.hypot(row.x + 0.5 - at.x, row.y + 0.5 - at.y, row.z + 0.5 - at.z);
	const owner = (row) => all.filter((s) => Math.hypot(s.x - row.x, s.z - row.z) <= (STRUCTURE_REACH[s.name.split(' ')[0]] ?? DEFAULT_REACH))
		.sort((a, b) => Math.hypot(a.x - row.x, a.z - row.z) - Math.hypot(b.x - row.x, b.z - row.z))[0] ?? null;
	// Containers: the shared seen-resource rows when present (they carry opened), else the blocks in view.
	// Containers: the shared seen-resource rows (they carry opened) and the blocks in view now, which a row may not hold yet.
	const shared = Array.isArray(o.seenResources) ? o.seenResources.filter((row) => row?.kind === 'container' && (!row.dimension || row.dimension === dimension)) : [];
	const openedShared = new Set(shared.filter((row) => row.opened === true).map(key));
	const rows = [...shared.filter((row) => row.opened !== true), ...[...(o.blocks ?? []), ...(o.nearbyContainers ?? [])].map((row) => ({ ...row, id: row.blockId }))]
		.filter((row) => finite(row) && !openedShared.has(key(row)));
	const chests = new Map();
	for (const row of rows) {
		if (!finite(row) || !CONTAINERS.test(row.id ?? row.blockId ?? '') || opened.has(key(row))) continue;
		const home = owner(row);
		if (home === null) continue;
		chests.set(key(row), { kind: 'chest', x: row.x, y: row.y, z: row.z, distance: distance(row), tables: home.tables, structure: home.name });
	}
	const places = all.filter((row) => !searched.has(key(row)))
		.map((row) => ({ kind: 'structure', name: row.name, x: row.x, y: row.y, z: row.z, distance: distance(row), tables: row.tables }));
	return [...chests.values(), ...places].sort((a, b) => a.distance - b.distance);
}

// What the body takes from an opened chest besides the plan's own items: what a player grabs on the way through.
export const LOOT_KEEP = /^(iron_ingot|iron_nugget|raw_iron|gold_ingot|gold_nugget|raw_gold|diamond|emerald|obsidian|coal|charcoal|flint|ender_pearl|bread|apple|golden_apple|enchanted_golden_apple|carrot|potato|baked_potato|beetroot|cooked_[a-z]+|beef|porkchop|mutton|chicken|rabbit|cod|salmon|wheat|hay_block|string|leather|book|bucket|water_bucket|lava_bucket|shield|bow|arrow|torch|[a-z_]*_bed|(iron|diamond|stone|golden|chainmail)_(pickaxe|axe|shovel|sword|helmet|chestplate|leggings|boots)|flint_and_steel|tnt|saddle)$/;
