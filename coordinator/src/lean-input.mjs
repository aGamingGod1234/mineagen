/**
 * Lean input sends the model the facts it decides on and leaves the rest one observe or inspect call away. It is on in
 * normal play and in harness games: the mod's coordinator supervisor and scripts/quality/run-scenarios.mjs both set
 * ARENA_LEAN_INPUT=1 unless the environment sets it (ARENA_LEAN_INPUT=0 turns it off). A coordinator started some other
 * way without the variable runs on the full input.
 *
 * Kept: goal counts and next step (goalNow, skillFits, now.plan/failure/guard), the danger line, threats in range,
 * the newest action results, body state, carried items, nearby non-terrain blocks, and close entities. Dropped or
 * summarised: item/block tag tables, coverage and perception bookkeeping, distant landmarks and entities, terrain
 * block rows (counted by type), static mechanics prose (combat-facts lean variant) and long option paragraphs.
 * Explicit observe replies stay full, so the model can always ask for the complete snapshot.
 */
export const LEAN_INPUT_ENV = 'ARENA_LEAN_INPUT';
export const LEAN_INPUT_NOTE = 'lean: terrainCounts and *Omitted count rows left out; observe for all rows and tags';

export function leanInputEnabled(env = process.env) {
	return /^(1|true|on|yes)$/i.test(String(env?.[LEAN_INPUT_ENV] ?? '').trim());
}

const record = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const MAX_THREATS = 6;
const MAX_ENTITIES = 6;
const MAX_BLOCKS = 14;
const MAX_LANDMARKS = 4;
const MAX_GROUND_ITEMS = 6;
const MAX_CAVES = 1;
const MAX_HEARD = 2;
const MAX_OPTIONS_CHARS = 240;
const MAX_KNOWN_CHARS = 160;
const MAX_RECEIPTS = 2;
const FOOTING_BLOCKS = 1.8;

// Plain terrain a player walks on or digs through; ores, fluids, fire, portals, obsidian, logs, crops, nether bricks (they
// mark a fortress) and every functional block stay as rows.
const TERRAIN = /^minecraft:(stone|deepslate|cobblestone|cobbled_deepslate|mossy_cobblestone|dirt|coarse_dirt|rooted_dirt|grass_block|podzol|mycelium|mud|clay|sand|red_sand|sandstone|red_sandstone|gravel|andesite|diorite|granite|tuff|calcite|dripstone_block|netherrack|basalt|smooth_basalt|polished_basalt|blackstone|soul_soil|end_stone|snow_block|snow|ice|packed_ice|terracotta|[a-z_]+_terracotta|bedrock|crimson_nylium|warped_nylium|nether_wart_block|warped_wart_block|short_grass|tall_grass|fern|large_fern|dead_bush|[a-z_]+_leaves|moss_block|moss_carpet|cave_air|air)$/;

const HAZARD = /^minecraft:(lava|fire|soul_fire|magma_block|nether_portal|end_portal|end_portal_frame|obsidian|crying_obsidian|water|powder_snow|cactus|sweet_berry_bush|campfire|soul_campfire|spawner|trial_spawner)$/;

const round1 = value => typeof value === 'number' && Number.isFinite(value) && !Number.isInteger(value) ? Math.round(value * 10) / 10 : value;
const distanceOf = row => Number.isFinite(row?.distance) ? row.distance : Infinity;
const nearest = (rows, limit) => rows.map((row, index) => [row, index]).sort(([a, i], [b, j]) => distanceOf(a) - distanceOf(b) || i - j).slice(0, limit).map(([row]) => row);
const idOf = row => row?.uuid ?? row?.stableId ?? null;

function leanThreat(row) {
	if (!record(row)) return row;
	const out = {};
	for (const [key, value] of Object.entries(row)) {
		// Unknown perception cells (null) and the false/zero defaults carry no decision.
		if (value === null || ['perception', 'visible', 'targetable', 'reachable'].includes(key) && value === 'unknown') continue;
		if (['swelling', 'meleeCandidate'].includes(key) && value === false) continue;
		if (key === 'stableId' && row.uuid === value) continue;
		out[key] = round1(value);
	}
	return out;
}

const ENTITY_KEYS = ['stableId', 'uuid', 'type', 'name', 'x', 'y', 'z', 'distance', 'hostile', 'targetingAgent', 'risk', 'health', 'baby', 'appearance', 'heldItem', 'itemId', 'count', 'alive'];
function leanEntity(row, threat) {
	if (!record(row)) return row;
	const out = {};
	for (const key of threat ? ['stableId', 'uuid', 'type', 'x', 'y', 'z', 'appearance'] : ENTITY_KEYS) {
		if (!Object.hasOwn(row, key)) continue;
		if (key === 'alive' && row.alive === true || ['hostile', 'targetingAgent'].includes(key) && row[key] === false) continue;
		out[key] = ['x', 'y', 'z', 'distance', 'risk'].includes(key) ? round1(row[key]) : row[key];
	}
	return out;
}

function leanPlayer(player, threatIds) {
	if (!record(player)) return player;
	const out = {};
	for (const [key, value] of Object.entries(player)) {
		// player.threat repeats the threats row with the same uuid.
		if (key === 'threat' && threatIds.has(idOf(value))) continue;
		if (['dead', 'inWater', 'swimming', 'gliding', 'crouching', 'onClimbable', 'horizontalCollision', 'verticalCollision', 'passenger', 'sprinting', 'lowHealthNoFood'].includes(key) && value === false) continue;
		if (['effects', 'threats', 'heard'].includes(key) && Array.isArray(value) && value.length === 0 || key === 'fallDistance' && value === 0) continue;
		if (key === 'gameMode' && value === 'survival' || key === 'pose' && value === 'standing' || key === 'fallDamage' && value === 0) continue;
		if (key === 'heard' && Array.isArray(value)) { out.heard = value.slice(0, MAX_HEARD); continue; }
		out[key] = ['x', 'y', 'z', 'yaw', 'pitch', 'fallDistance'].includes(key) ? round1(value) : value;
	}
	return out;
}

const titleCase = itemId => String(itemId ?? '').replace(/^[a-z0-9_.-]+:/, '').split('_').map(part => part.charAt(0).toUpperCase() + part.slice(1)).join(' ');
function leanInventory(inventory) {
	if (!record(inventory) || !Array.isArray(inventory.items)) return inventory;
	const items = inventory.items.map(item => {
		if (!record(item)) return item;
		const { tags: _tags, maxStackSize: _stack, fingerprint: _fingerprint, maxDamage, usesLeft, displayName, ...rest } = item;
		// A worn-down tool's uses matter; a fresh one's maximum does not. Potion and book names carry their kind.
		if (Number.isFinite(usesLeft) && (!Number.isFinite(maxDamage) || usesLeft < maxDamage)) rest.usesLeft = usesLeft;
		if (typeof displayName === 'string' && displayName !== titleCase(item.itemId)) rest.displayName = displayName;
		return rest;
	});
	const { tagCounts: _tagCounts, fingerprints: _fingerprints, ...rest } = inventory;
	return { ...rest, items };
}

function leanBlocks(rows, player) {
	const kept = [], terrainCounts = {};
	const at = [player?.x, player?.y, player?.z];
	const near = row => record(row) && at.every(Number.isFinite) && [row.x, row.y, row.z].every(Number.isFinite)
		? Math.hypot(row.x + .5 - at[0], row.y + .5 - at[1], row.z + .5 - at[2]) : Infinity;
	// Terrain the player could place against right beside the feet stays, so footing and shelter choices keep positions.
	const footing = row => Array.isArray(row.placeableFaces) && row.placeableFaces.length > 0 && near(row) <= FOOTING_BLOCKS;
	for (const row of rows) {
		if (record(row) && typeof row.blockId === 'string' && TERRAIN.test(row.blockId) && !Object.hasOwn(row, 'appearance') && !footing(row)) {
			terrainCounts[row.blockId] = (terrainCounts[row.blockId] ?? 0) + 1;
			continue;
		}
		if (!record(row)) { kept.push(row); continue; }
		const { tags: _tags, ...rest } = row;
		for (const key of ['boundsTruncated', 'replaceable']) if (rest[key] === false) delete rest[key];
		if (Array.isArray(rest.placeableFaces) && rest.placeableFaces.length === 0) delete rest.placeableFaces;
		kept.push(rest);
	}
	if (kept.length <= MAX_BLOCKS) return { kept, terrainCounts, omitted: 0 };
	const rank = row => HAZARD.test(row?.blockId ?? '') ? 0 : 1;
	const chosen = kept.map((row, index) => [row, index]).sort(([a, i], [b, j]) => rank(a) - rank(b) || near(a) - near(b) || i - j).slice(0, MAX_BLOCKS)
		.sort(([, i], [, j]) => i - j).map(([row]) => row);
	return { kept: chosen, terrainCounts, omitted: kept.length - chosen.length };
}

function leanInteraction(interaction, selectedItem) {
	if (!record(interaction)) return interaction;
	const out = {};
	for (const [key, value] of Object.entries(interaction)) {
		if (key === 'input' || key === 'useRemainingTicks' && value === 0 || key === 'activeHand' && value === 'none' || key === 'usingItem' && value === false
			|| key === 'offHandItemId' && value === 'minecraft:air' || key === 'attackCooldown' && value === 1 || key === 'mainHandItemId' && value === selectedItem) continue;
		// The player's own inventory screen repeats inventory.items; a carried cursor stack or any other menu stays.
		const carried = record(value?.cursor) && value.cursor.itemId !== 'minecraft:air' && value.cursor.count !== 0;
		if (key === 'menu' && record(value) && value.type === 'minecraft:inventory' && !carried) continue;
		out[key] = value;
	}
	return out;
}

function clip(text, limit) {
	if (typeof text !== 'string' || text.length <= limit) return text;
	const cut = text.slice(0, limit);
	const boundary = Math.max(cut.lastIndexOf(' | '), cut.lastIndexOf('; '), cut.lastIndexOf('. '), cut.lastIndexOf(', '));
	return `${cut.slice(0, boundary > limit / 2 ? boundary : limit).trimEnd()} ... (trimmed)`;
}

// Options hold one segment per need ("ender_pearl: 12 more needed (...), est. options: ...", "(step nether) blaze_rod: ...")
// and the current state ("now: ..."), joined by " | " with route alternatives between them. Every need and the
// current state stay, without long parenthetical asides; route alternatives are left out. The fortress search segments
// (the region grid facts, regions a seen bastion rules out, the nearest unseen regions with coordinates) and the golden
// helmet line for held gold stay whole: they are where-to-go facts the model cannot read elsewhere.
const OPTION_HEAD = /^(\([^)]*\) )?[a-z0-9_]+: /;
const OPTION_WHOLE = /^(Fortress search, your choice: |bastion seen, so no fortress in: |regions with nothing seen yet|option golden helmet now: )/;
const MIN_ASIDE_CHARS = 80;
// Removes top-level "(...)" asides of MIN_ASIDE_CHARS or more, nested parentheses included.
function withoutLongAsides(text) {
	let out = '', depth = 0, start = -1;
	for (let index = 0; index < text.length; index++) {
		const char = text[index];
		if (char === '(') { if (depth++ === 0) start = index; continue; }
		if (char === ')' && depth > 0) {
			if (--depth === 0) {
				const aside = text.slice(start, index + 1);
				if (aside.length < MIN_ASIDE_CHARS) out += aside; else out = out.replace(/\s+$/, '');
			}
			continue;
		}
		if (depth === 0) out += char;
	}
	return depth > 0 ? out + text.slice(start) : out;
}
function leanOptions(text) {
	if (typeof text !== 'string' || text.length <= MAX_OPTIONS_CHARS) return text;
	const segments = text.split(' | ');
	const kept = segments.filter((segment, index) => index === 0 || OPTION_HEAD.test(segment) || OPTION_WHOLE.test(segment))
		.map(segment => OPTION_WHOLE.test(segment) ? segment : clip(withoutLongAsides(segment), MAX_OPTIONS_CHARS));
	return kept.join(' | ');
}

// Known reads "caves: ...; places: ...; lava: ...": places, lava and ores stay whole, caves keep the nearest few.
function leanKnown(text) {
	if (typeof text !== 'string' || text.length <= MAX_KNOWN_CHARS) return text;
	return text.split('; ').map(part => /^caves:/.test(part) ? clip(part, MAX_KNOWN_CHARS / 2) : part).join('; ');
}

function leanNow(now) {
	if (!record(now)) return now;
	return { ...now, ...(typeof now.options === 'string' ? { options: leanOptions(now.options) } : {}),
		...(typeof now.known === 'string' ? { known: leanKnown(now.known) } : {}) };
}

const DROPPED_OBSERVATION = ['itemTags', 'blockTags', 'coverage', 'snapshotCounts', 'omittedRows', 'status', 'ready', 'observedAtEpochMs', 'velocity',
	'itemDefaults', 'blockDefaults', 'landmarkDefaults', 'blockOmittedFields'];

/** Lean observation: the essential body, threats in range, near rows; the full snapshot stays an observe away. */
export function presentLeanObservation(observation, threatRows = null) {
	if (!record(observation)) return observation;
	const rowsOf = value => Array.isArray(value) ? value : Array.isArray(value?.entries) ? value.entries : null;
	const threats = rowsOf(threatRows) ?? rowsOf(observation.threats) ?? rowsOf(observation.player?.threats) ?? [];
	const threatIds = new Set(threats.map(idOf).filter(Boolean));
	const out = {};
	for (const [key, value] of Object.entries(observation)) {
		if (DROPPED_OBSERVATION.includes(key)) continue;
		if (key === 'hungerShaking' && value === false) continue;
		switch (key) {
			case 'threats': {
				if (record(value) && Array.isArray(value.entries)) {
					const entries = nearest(value.entries, MAX_THREATS).map(leanThreat);
					out.threats = { ...value, entries, ...(value.entries.length > entries.length ? { omittedEntries: value.entries.length - entries.length } : {}) };
					break;
				}
				if (!Array.isArray(value)) { out.threats = value; break; }
				const rows = nearest(value, MAX_THREATS).map(leanThreat);
				out.threats = rows;
				if (value.length > rows.length) out.threatsOmitted = value.length - rows.length;
				break;
			}
			case 'player': {
				const player = leanPlayer(value, threatIds);
				if (record(player) && Array.isArray(player.threats)) player.threats = nearest(player.threats, MAX_THREATS).map(leanThreat);
				out.player = player;
				break;
			}
			case 'inventory': out.inventory = leanInventory(value); break;
			case 'interaction': out.interaction = leanInteraction(value, observation.inventory?.selectedItem); break;
			case 'entities': {
				if (!Array.isArray(value)) { out.entities = value; break; }
				const rows = nearest(value, MAX_ENTITIES);
				out.entities = rows.map(row => leanEntity(row, threatIds.has(row?.stableId) || threatIds.has(row?.uuid)));
				if (value.length > rows.length) out.entitiesOmitted = value.length - rows.length;
				break;
			}
			case 'items': {
				if (!Array.isArray(value)) { out.items = value; break; }
				out.items = nearest(value, MAX_GROUND_ITEMS).map(row => record(row) ? (({ tags: _tags, ...rest }) => rest)(row) : row);
				if (value.length > out.items.length) out.itemsOmitted = value.length - out.items.length;
				break;
			}
			case 'blocks': {
				if (!Array.isArray(value)) { out.blocks = value; break; }
				const { kept, terrainCounts, omitted } = leanBlocks(value, observation.player);
				out.blocks = kept;
				if (omitted > 0) out.blocksOmitted = omitted;
				if (Object.keys(terrainCounts).length > 0) out.terrainCounts = terrainCounts;
				break;
			}
			case 'landmarks': {
				if (!Array.isArray(value)) { out.landmarks = value; break; }
				const special = value.filter(row => !(record(row) && typeof row.blockId === 'string' && TERRAIN.test(row.blockId)));
				out.landmarks = nearest(special, MAX_LANDMARKS).map(row => record(row) ? (({ elevation: _elevation, tags: _tags, ...rest }) => ({ ...rest,
					...(Number.isFinite(rest.distance) ? { distance: Math.round(rest.distance) } : {}), ...(Number.isFinite(rest.bearing) ? { bearing: Math.round(rest.bearing) } : {}) }))(row) : row);
				break;
			}
			case 'sighted': {
				out.sighted = record(value) && Array.isArray(value.caves) ? { ...value, caves: nearest(value.caves, MAX_CAVES) } : value;
				break;
			}
			case 'perception': {
				// Boss bars are on screen; the chat/event log is an observe away (heard and conversation carry the rest).
				if (record(value) && Array.isArray(value.bossBars) && value.bossBars.length > 0) out.perception = { bossBars: value.bossBars };
				break;
			}
			default: out[key] = value;
		}
	}
	out.lean = LEAN_INPUT_NOTE;
	return out;
}

function leanProgram(program) {
	if (!record(program) || !record(program.result) || !Array.isArray(program.result.receipts)) return program;
	const receipts = program.result.receipts;
	const failed = state => ['FAILED', 'TIMED_OUT', 'REJECTED', 'CANCELLED'].includes(state);
	const keep = receipts.filter((receipt, index) => index >= receipts.length - MAX_RECEIPTS || failed(receipt?.state) && index >= receipts.length - 4);
	if (keep.length === receipts.length) return program;
	return { ...program, result: { ...program.result, receipts: keep, omittedReceipts: (program.result.omittedReceipts ?? 0) + receipts.length - keep.length } };
}

function leanTaskMemory(memory) {
	if (!record(memory)) return memory;
	// Empty journal lists say nothing; totals still state the counts.
	return Object.fromEntries(Object.entries(memory).filter(([, value]) => !(Array.isArray(value) && value.length === 0)));
}

/** Lean event payload (parsed wake JSON). Combat prose is shortened at its source (combatFacts lean variant). */
export function presentLeanWake(value) {
	if (!record(value)) return value;
	const out = { ...value };
	const threatRows = Array.isArray(value.hud?.threats) ? value.hud.threats : null;
	if (record(value.hud) && Array.isArray(value.hud.threats)) {
		const rows = nearest(value.hud.threats, MAX_THREATS).map(leanThreat);
		out.hud = { ...value.hud, threats: rows, ...(value.hud.threats.length > rows.length ? { threatsOmitted: value.hud.threats.length - rows.length } : {}) };
	}
	if (record(value.observation)) out.observation = presentLeanObservation(value.observation, threatRows);
	if (record(value.now)) out.now = leanNow(value.now);
	if (record(value.program)) out.program = leanProgram(value.program);
	if (record(value.taskMemory)) out.taskMemory = leanTaskMemory(value.taskMemory);
	if (Array.isArray(value.resourceSightings) && value.resourceSightings.length > 3) out.resourceSightings = value.resourceSightings.slice(0, 3);
	if (Array.isArray(value.mergedEvents)) out.mergedEvents = value.mergedEvents.map(entry => {
		if (!record(entry)) return entry;
		const { combat: _combat, ...rest } = entry;
		return presentLeanWake(rest);
	});
	return out;
}

/**
 * After observation views have used the world identity, the model needs only the dimension: a world UUID decides
 * nothing it can do. Applied to the presented wake (observation and a changes view's replaced world section).
 */
export function withoutWorldId(presented) {
	if (!record(presented)) return presented;
	const strip = holder => record(holder?.world) && Object.hasOwn(holder.world, 'worldId') ? { ...holder, world: (({ worldId: _worldId, ...rest }) => rest)(holder.world) } : holder;
	let out = presented;
	if (record(out.observation)) out = { ...out, observation: strip(out.observation) };
	if (record(out.observationView?.replace)) out = { ...out, observationView: { ...out.observationView, replace: strip(out.observationView.replace) } };
	return out;
}
