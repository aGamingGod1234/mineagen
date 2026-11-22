// The seen-resource model: every source the body has actually seen (placed blocks such as a village's cobblestone,
// planks, hay and beds; containers; ores and veins; mobs, built ones included), with the nearest seen position, kept
// across calls. obtain and find plan from it, as a player weighs "the cobblestone is right there" against digging.
// The interface is documented for the other playtest lanes; rows are plain objects:
// { id, kind: 'block'|'container'|'mob', x, y, z, count, distance, seenAt, source, dimension, placed, opened?, stableId?, health? }

/** A remembered row is dropped after this long unseen, or when the body is this far from it. */
export const RESOURCE_TTL_MS = 30 * 60_000;
export const RESOURCE_KEEP_RADIUS = 256;

// Generated terrain is everywhere and the planner digs into it on its own: never a row.
const TERRAIN = /^minecraft:(air|cave_air|void_air|stone|deepslate|granite|diorite|andesite|tuff|dirt|coarse_dirt|grass_block|podzol|rooted_dirt|mud|sand|red_sand|gravel|clay|calcite|dripstone_block|netherrack|end_stone|bedrock|water|lava|short_grass|tall_grass|fern|large_fern|snow|snow_block|ice|packed_ice|blue_ice|sandstone|red_sandstone|terracotta|basalt|blackstone|soul_sand|soul_soil|bubble_column|seagrass|tall_seagrass|kelp|kelp_plant)$/;
const CONTAINERS = new Set(['minecraft:chest', 'minecraft:trapped_chest', 'minecraft:barrel', 'minecraft:vault']);
const ORE = /_ore$|^minecraft:ancient_debris$/;
// Mobs worth a row: anything a plan may kill for a drop. Built mobs (a village's golem) are marked placed.
const BUILT_MOBS = new Set(['minecraft:iron_golem', 'minecraft:snow_golem']);
// A placed block this close (horizontally) to a sighted structure's position, or within twice its seen size, belongs to it.
const STRUCTURE_REACH = 48;

const id = (value) => { const text = String(value ?? '').trim(); return text.includes(':') ? text : `minecraft:${text}`; };
const bare = (value) => String(value ?? '').replace(/^minecraft:/, '');
const finite = (...values) => values.every(Number.isFinite);

/** Plain row objects from an array or the compact { columns, rows } table form. */
function list(value) {
	if (Array.isArray(value)) return value;
	if (value && Array.isArray(value.rows) && Array.isArray(value.columns)) {
		return value.rows.map((row) => Object.fromEntries([...Object.entries(value.defaults ?? {}), ...value.columns.map((column, index) => [column, row[index]])]));
	}
	return [];
}

/** The body's eye-ish position and dimension from an observation, or null. */
function bodyOf(observation) {
	const p = observation?.player ?? {};
	const x = p.x ?? observation?.position?.x, y = p.y ?? observation?.position?.y, z = p.z ?? observation?.position?.z;
	return finite(x, y, z) ? { x, y: y + 1.62, z, dimension: observation?.world?.dimension ?? 'minecraft:overworld' } : null;
}

function rowOf(kind, blockId, x, y, z, { count = 1, source, seenAt, dimension, placed = false, opened, stableId, health } = {}) {
	const row = { id: id(blockId), kind, x: Math.floor(x), y: Math.floor(y), z: Math.floor(z), count: Math.max(1, Math.round(count)), distance: Infinity,
		seenAt, source, dimension, placed };
	if (kind === 'container') row.opened = opened === true;
	// Seen along an open sight line (scan, landmark, far sight, entity): not enclosed. rememberKnownBlocks marks the rest.
	row.enclosed = false;
	if (kind === 'mob') { if (stableId !== undefined) row.stableId = stableId; if (Number.isFinite(health)) row.health = health; }
	return row;
}

/** Rows from one observation: what is seen now (never remembered rows). */
export function observedResources(observation, { now = Date.now() } = {}) {
	const body = bodyOf(observation);
	if (body === null) return [];
	const { dimension } = body;
	const out = [];
	const block = (row, source) => {
		const blockId = id(row?.blockId ?? row?.id);
		if (!finite(row?.x, row?.y, row?.z) || TERRAIN.test(blockId)) return;
		const container = CONTAINERS.has(blockId);
		out.push(rowOf(container ? 'container' : 'block', blockId, row.x, row.y, row.z, { count: Number.isFinite(row.count) ? row.count : 1, source, seenAt: now, dimension,
			placed: source === 'sighted' && !ORE.test(blockId), opened: row.opened }));
	};
	for (const row of list(observation?.blocks)) block(row, 'local');
	for (const row of list(observation?.world?.landmarks ?? observation?.landmarks)) block(row, 'landmark');
	const sighted = observation?.sighted ?? {};
	for (const row of list(sighted.resources)) block(row, 'sighted');
	// A placed block or container inside a structure the body sees (a village's door, chest or well) names it.
	const structures = list(sighted.structures).filter((row) => typeof row?.structure === 'string' && finite(row.x, row.z));
	for (const row of out) {
		if (!row.placed && row.kind !== 'container') continue;
		const near = structures.map((one) => ({ one, d: Math.hypot(one.x - row.x, one.z - row.z) }))
			.filter(({ one, d }) => d <= Math.max(STRUCTURE_REACH, (Number.isFinite(one.size) ? one.size : 0) * 2)).sort((a, b) => a.d - b.d)[0];
		if (near) row.structure = near.one.structure;
	}
	for (const row of list(sighted.blocks)) block(row, 'sighted');
	for (const row of list(sighted.veins)) block(row, 'vein');
	for (const row of list(observation?.entities)) {
		const type = row?.type ?? row?.entityType;
		if (!type || type === 'minecraft:item' || type === 'minecraft:player' || row?.alive === false || !finite(row?.x, row?.y, row?.z)) continue;
		out.push(rowOf('mob', type, row.x, row.y, row.z, { source: 'entity', seenAt: now, dimension, placed: BUILT_MOBS.has(id(type)), stableId: row.stableId ?? row.uuid, health: row.health }));
	}
	return out;
}

/** An empty memory for one agent. */
export function newResourceMemory() {
	return { rows: new Map() };
}

// Blocks of one id within this many blocks are one source (a well, a house wall): the nearest member stands for it.
const MERGE = 6;
const keyOf = (row) => row.kind === 'mob' ? `${row.dimension}|mob|${row.stableId ?? `${row.id}@${row.x},${row.y},${row.z}`}`
	: row.kind === 'container' ? `${row.dimension}|${row.id}@${row.x},${row.y},${row.z}` : null;

/**
 * Merges an observation into memory (mutated and returned). Re-seen rows refresh; a remembered block or container whose
 * cell the body now sees holding something else is dropped; rows past RESOURCE_TTL_MS or RESOURCE_KEEP_RADIUS go.
 */
export function rememberResources(memory, observation, { now = Date.now() } = {}) {
	const body = bodyOf(observation);
	if (body === null) return memory;
	const rows = memory.rows;
	// A cell the observation shows now with another block (or air) no longer holds what was remembered there.
	const shown = new Map();
	for (const row of list(observation?.blocks)) if (finite(row?.x, row?.y, row?.z)) shown.set(`${row.x},${row.y},${row.z}`, id(row.blockId));
	for (const [key, row] of rows) {
		if (row.kind === 'mob') continue;
		const now_ = shown.get(`${row.x},${row.y},${row.z}`);
		if (row.dimension === body.dimension && now_ !== undefined && now_ !== row.id) rows.delete(key);
	}
	for (const row of observedResources(observation, { now })) {
		const exact = keyOf(row);
		if (exact !== null) { rows.set(exact, { ...rows.get(exact), ...row }); continue; }
		const known = rows.get(`${row.dimension}|${row.id}@${row.x},${row.y},${row.z}`);
		if (known?.enclosed) known.enclosed = false;
		// A block: one row per id and neighbourhood, at the nearest member seen.
		let merged = false;
		for (const [key, old] of rows) {
			if (old.kind !== 'block' || old.id !== row.id || old.dimension !== row.dimension) continue;
			if (Math.abs(old.x - row.x) > MERGE || Math.abs(old.y - row.y) > MERGE || Math.abs(old.z - row.z) > MERGE) continue;
			const closer = Math.hypot(row.x + 0.5 - body.x, row.z + 0.5 - body.z) < Math.hypot(old.x + 0.5 - body.x, old.z + 0.5 - body.z);
			rows.set(key, { ...old, ...(closer ? { x: row.x, y: row.y, z: row.z } : {}), count: Math.max(old.count, row.count), seenAt: now,
				source: closer ? row.source : old.source, placed: old.placed || row.placed, enclosed: false, ...(row.structure ? { structure: row.structure } : {}) });
			merged = true;
			break;
		}
		if (!merged) rows.set(`${row.dimension}|${row.id}@${row.x},${row.y},${row.z}`, row);
	}
	for (const [key, row] of rows) {
		const far = row.dimension === body.dimension && Math.hypot(row.x + 0.5 - body.x, row.z + 0.5 - body.z) > RESOURCE_KEEP_RADIUS;
		if (now - row.seenAt > RESOURCE_TTL_MS || far) rows.delete(key);
	}
	return memory;
}

/**
 * Merges blocks the body knows of without a sight line now (an ore a dig sighted through rock, kept in the observed-
 * memory store) as rows with `enclosed: true`. A row also seen along a sight line keeps `enclosed: false`.
 */
export function rememberKnownBlocks(memory, observation, blocks, { now = Date.now(), source = 'vein' } = {}) {
	const body = bodyOf(observation);
	if (body === null || !Array.isArray(blocks)) return memory;
	for (const block of blocks) {
		const blockId = id(block?.blockId);
		if (!finite(block?.x, block?.y, block?.z) || TERRAIN.test(blockId)) continue;
		const key = `${body.dimension}|${blockId}@${Math.floor(block.x)},${Math.floor(block.y)},${Math.floor(block.z)}`;
		const old = memory.rows.get(key);
		if (old) { memory.rows.set(key, { ...old, seenAt: Math.max(old.seenAt, now) }); continue; }
		const row = rowOf(CONTAINERS.has(blockId) ? 'container' : 'block', blockId, block.x, block.y, block.z, { source, seenAt: now, dimension: body.dimension });
		row.enclosed = true;
		memory.rows.set(key, row);
	}
	return memory;
}

/** Known rows of the body's dimension, nearest first, distance from the observation's body. */
export function knownResources(memory, observation, { ids = null, kinds = null, maxDistance = Infinity, includeOpened = true } = {}) {
	const body = bodyOf(observation);
	if (body === null || !memory?.rows) return [];
	const wanted = ids === null ? null : new Set([...ids].map(id));
	const kindSet = kinds === null ? null : new Set(kinds);
	const out = [];
	for (const row of memory.rows.values()) {
		if (row.dimension !== body.dimension) continue;
		if (wanted !== null && !wanted.has(row.id)) continue;
		if (kindSet !== null && !kindSet.has(row.kind)) continue;
		if (!includeOpened && row.kind === 'container' && row.opened) continue;
		const distance = Math.round(Math.hypot(row.x + 0.5 - body.x, row.y + 0.5 - body.y, row.z + 0.5 - body.z) * 10) / 10;
		if (distance > maxDistance) continue;
		out.push({ ...row, distance });
	}
	return out.sort((a, b) => a.distance - b.distance);
}

/** Bare ids of every known row, for the planner's `seen` set. */
export function knownResourceIds(memory, observation) {
	return new Set(knownResources(memory, observation).map((row) => bare(row.id)));
}
