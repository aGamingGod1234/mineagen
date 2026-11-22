// find: search the way a player does and stop the moment the target is seen. The model names what (a block, biome, mob
// or structure); this decides how: look around first, go to a remembered place, take high ground for a surface target,
// walk straight legs to new ground, and dig to the depth an underground target lives at, then tunnel straight legs.
// searchFor is the one entry point; it drives a body (the runtime's observe, look and body actions) and returns a
// result. It is shared by do_step find and by verbs that need a source they cannot see (obtain).

import { howtoIndex } from './howto.mjs';
import { corridorFloor, witherOnLeg, withersSeen } from './fortress-approach.mjs';
import { eyeTarget, eyesHeld, followEyes } from './find-eyes.mjs';
import { portalTarget, strongholdNearby, findPortalRoom } from './find-portal-room.mjs';
import { nightMoveStop } from './night-cover.mjs';
import { ENGAGE_CLOSE, SEARCH_LOW_HEALTH, creeperNear, pursuedByPack, searchDanger, threatRows } from './search-danger.mjs';

export const FIND_KINDS = Object.freeze(['block', 'biome', 'mob', 'structure']);
export const DEFAULT_FIND_WITHIN = 512;
export const TREE_MIN_Y = 50;
const CAVE_LOG_MARGIN = 3;
/** Whether a log row is no tree to walk to: an overworld log below TREE_MIN_Y, and more than CAVE_LOG_MARGIN below the body. */
export const caveLog = (blockId, y, dimension, bodyY = Infinity) => /_(log|stem)$/.test(String(blockId))
	&& (dimension ?? 'minecraft:overworld') === 'minecraft:overworld' && y < TREE_MIN_Y && !(Number.isFinite(bodyY) && y >= bodyY - CAVE_LOG_MARGIN);
export const MIN_FIND_WITHIN = 16;
export const MAX_FIND_WITHIN = 2048;
// Every tool call is held by the provider for at most 600 s (MCP_TOOL_TIMEOUT); a search ends in time to report.
export const DEFAULT_FIND_TIMEOUT_MS = 540_000;
export const MAX_FIND_TIMEOUT_MS = 570_000;
const MIN_LEG_MS = 5_000;
const SURFACE_LEG = 80;
const MIN_SURFACE_LEG = 8;
const BUILD_LEG = 16;
const BUILD_BUDGET = 64;
// Surface blocks that also lie in pockets in the rock at every level (gravel blobs in stone). Sought from under cover,
// a player mines along where they stand and looks at the walls instead of walking a tunnel that leads nowhere: at most
// ROCK_LEGS tunnel legs at the body's own level, then out to the sky and the surface legs. Script-first batches 4-6: 53
// flint steps all started at y-5 to y48 under cover; their 80-block walks failed NO_ROUTE 2224 times (99 of 486 min),
// 16 steps never found gravel, and the 23 that did found it in the rock 2-44 blocks from where they started.
const IN_ROCK = new Set(['minecraft:gravel']);
const ROCK_LEGS = 3;
const HIGH_GROUND_RADIUS = 48;
const HIGH_GROUND_RISE = 5;
const TUNNEL_LEG = 32;
const MAX_FIGHTS = 3;
// A mob judged out of the search's way (search-danger.mjs) that stops legs this many times is answered as before.
const MAX_PASSES = 3;
// How long the body stands for a mob after it that is not in reach yet (fight_target with no pursuit) before it goes on,
// and the most one fight in reach takes (a zombie dies to a pickaxe in about 5 s). A mob after the body crosses the
// distance a search fights at in a few seconds; one not there in 8 s is behind rock, and 20 s stood idle for it (K7).
const MEET_MS = 8_000;
const FIGHT_MS = 30_000;
// Damage stops a mob's hit ends (not a fall, lava or fire): the search fights that mob when it is one to fight.
const HIT_STOPS = new Set(['TRAVEL_DAMAGED', 'NAVIGATION_DAMAGED', 'DAMAGE_TAKEN']);
const MAX_MEMORY_TRIPS = 2;
// A Nether biome approach (find biome): straight legs toward the cell, a building leg after one that gains under
// APPROACH_GAIN blocks, at most APPROACH_BUILD_BUDGET blocks of building legs, and a hand-back after APPROACH_STUCK legs in
// a row that gain under APPROACH_GAIN. 128 blocks of building is twice a surface search's: the closest seven-rods
// approach stopped 103 blocks out.
const APPROACH_LEG = 32;
const APPROACH_GAIN = 4;
const APPROACH_BUILD_BUDGET = 128;
const APPROACH_STUCK = 5;
// A stuck leg turns the next one off the straight line: basalt columns and lava pools block one heading, not all.
const APPROACH_TURNS = Object.freeze([0, 45, -45, 90, -90]);
const APPROACH_ARRIVE = 3;
// A leg that ends within APPROACH_ARRIVE of a seen cell not yet in the biome is followed once by one aimed this far past
// the cell: travel_to stops within its own 3-block tolerance, short of a cell at the biome's edge.
const APPROACH_PAST = 4;
const MAX_DESCENT_STOPS = 6;
const DEPTHS = Object.freeze({ lava: -54, iron_ore: 16, deepslate_iron_ore: 16, gold_ore: -16, deepslate_gold_ore: -16, diamond_ore: -58,
	deepslate_diamond_ore: -58, redstone_ore: -58, deepslate_redstone_ore: -58, lapis_ore: 0, deepslate_lapis_ore: 0, copper_ore: 48,
	deepslate_copper_ore: 48, coal_ore: 48, deepslate_coal_ore: 48 });
const NETHER_DEPTHS = Object.freeze({ ancient_debris: 15 });
// A dig that gets in the way of these stones may drop them for room; nothing else is ever dropped (obtain's crafts too).
export const DISCARD = Object.freeze(['minecraft:cobblestone', 'minecraft:cobbled_deepslate', 'minecraft:diorite', 'minecraft:andesite', 'minecraft:granite', 'minecraft:tuff', 'minecraft:dirt', 'minecraft:gravel']);
// Body stops that are danger to answer now, shared with obtain (one list): damage, and every life-safety stop (lava,
// fire, falling blocks, a void edge, air running out, a flooding tunnel).
export const DAMAGE_STOPS = Object.freeze(new Set(['TRAVEL_DAMAGED', 'NAVIGATION_DAMAGED', 'DAMAGE_TAKEN', 'LOW_HEALTH', 'LOW_HEALTH_BAILOUT']));
// A travel_to leg that fought a mob on the way (issue 2 Step 2's instincts arm) ends with the fight's code: the mob, not the place.
export const FIGHT_STOPS = Object.freeze(new Set(['TARGET_ESCAPED', 'TARGET_UNREACHABLE', 'APPROACH_BLOCKED', 'NO_SEEN_ROUTE', 'FIGHT_TIMED_OUT']));
export const LIFE_SAFETY_STOPS = Object.freeze(new Set(['IN_LAVA', 'LAVA_AHEAD', 'LAVA_BEHIND', 'LAVA_INCOMING', 'LAVA_FLOW', 'LAVA_OPENED', 'LAVA_POUR_AT_BODY',
	'ON_FIRE', 'BURNING', 'FALLING_BLOCKS', 'VOID_EDGE', 'AIR_RESERVE_REACHED', 'BREATH_NOT_COVERED', 'TUNNEL_FLOODED']));
const DANGER = new Set(['HOSTILE_NEAR', 'LOW_FOOD', ...DAMAGE_STOPS, ...LIFE_SAFETY_STOPS]);
const RANGED = new Set(['skeleton', 'stray', 'bogged', 'parched', 'pillager', 'witch', 'blaze', 'ghast', 'breeze', 'drowned'].map((id) => `minecraft:${id}`));
const CLOSE_HOSTILE = 10;
const DROWNED_REACH = 16;
const targeting = (row) => row.targeting === true || (Array.isArray(row.signals) && row.signals.includes('targeting'));
export function hostileIsDanger(observation) {
	const rows = threatRows(observation);
	if (rows === null) return true;
	if (rows.some((row) => row.distance <= CLOSE_HOSTILE
		|| (RANGED.has(row.type) && targeting(row) && (row.type !== 'minecraft:drowned' || row.distance <= DROWNED_REACH)))) return true;
	const at = observation?.player ?? {};
	return (Array.isArray(observation?.entities) ? observation.entities : []).some((row) => row?.hostile === true && row.alive !== false
		&& (Number.isFinite(row.distance) ? row.distance : Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z)) <= CLOSE_HOSTILE);
}
const MAX_ESCAPES = 2;
const BREATH_STOPS = new Set(['AIR_RESERVE_REACHED', 'BREATH_NOT_COVERED', 'TUNNEL_FLOODED']);
// A walk's or swim's own stop for its air (travel's breath rule), as against a dig that flooded.
const AIR_STOPS = new Set(['AIR_RESERVE_REACHED', 'BREATH_NOT_COVERED']);
// Stops a search cannot work round by itself: the model decides (craft a pickaxe, empty the inventory...).
const BLOCKED = new Set(['NO_TOOL', 'TOOL_WORN', 'INVENTORY_FULL']);
const CARDINALS = Object.freeze([{ name: 'south', yaw: 0 }, { name: 'west', yaw: 90 }, { name: 'north', yaw: 180 }, { name: 'east', yaw: -90 }]);
// The index's worldgen rows come from biome features and noise settings only (HowtoIndexExporter.readWorldgen). Structures
// and carvers it does not walk place these blocks in other dimensions too: netherrack and magma in ruined portals and
// magma under the oceans (Overworld), bedrock in the End's exit portal and gateways. A find for one there is never refused.
const ALSO_PLACED = Object.freeze({ magma_block: ['overworld'], netherrack: ['overworld'], bedrock: ['the_end'] });
const HEADING_YAW = Object.freeze({ S: 0, SW: 45, W: 90, NW: 135, N: 180, NE: -135, E: -90, SE: -45 });
const BUCKET_FLUIDS = new Set(['minecraft:lava', 'minecraft:water']);
// Far sight's own near range (FarSight.SMALL_SIGHT): within it a survey marks a fluid's flow, past it only landmarks see.
const FLUID_LEVEL_SIGHT = 24;
// A surface target sought from under cover: back up the way the body came, or stairs up when that way is shut, at most
// this many legs, each stair leg up to CLIMB_LEG blocks higher.
const MAX_CLIMBS = 8;
const CLIMB_LEG = 24;
// The retrace is tried this many times; between tries, a stair this many blocks up gets past where it stopped.
const MAX_RETRACE_TRIES = 3;
const DETOUR_RISE = 8;
// Water a player hears underground: flowing water and dripstone dripping it, within the 16 blocks the ear reaches.
const HEARD_WATER = /water/;
const WATER_NEAR = 24;
const MAX_WATER_TRIPS = 2;
const SOUND_YAW = Object.freeze({ front: 0, front_right: 45, right: 90, back_right: 135, back: 180, back_left: -135, left: -90, front_left: -45 });
const WEAPON = /(^|:)[a-z_]+_(sword|axe)$/;
const MAX_SWAPS = 3;
const PICK_TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];
/** The best pickaxe with more than 2 uses left in the main inventory (slots 9-35), off the hotbar dig_to uses; or null. */
export function sparePickaxe(observation) {
	return (observation?.inventory?.items ?? []).filter((item) => /_pickaxe$/.test(item?.itemId ?? '') && Number.isSafeInteger(item.slot) && item.slot >= 9
		&& !(item.maxDamage > 0 && item.maxDamage - (item.damage ?? 0) <= 2))
		.sort((a, b) => PICK_TIERS.indexOf(b.itemId.replace(/^minecraft:/, '').split('_')[0]) - PICK_TIERS.indexOf(a.itemId.replace(/^minecraft:/, '').split('_')[0]))[0] ?? null;
}
const TIMED = new Set(['travel_to', 'dig_to', 'fight_target', 'break_block', 'build_shelter', 'escape']);
const SHELTER_BLOCKS = new Set(['minecraft:cobblestone', 'minecraft:cobbled_deepslate', 'minecraft:dirt', 'minecraft:stone', 'minecraft:deepslate', 'minecraft:andesite', 'minecraft:diorite', 'minecraft:granite', 'minecraft:tuff', 'minecraft:netherrack']);
const MAX_PEEKS = 2;
// Falls or spills of the target fluid seen with no source (far sight's flowing rows) a search walks over to, and the
// missed-place reason that keeps a later search from walking to one again.
const MAX_SPILLS = 3;
const NO_SOURCE = 'no source seen';
const SMALL_POOL = 'pocket too small to cast';
const smallLava = (row) => row?.small === true && row.blockId === 'minecraft:lava';
// Biomes trees grow in (a tree search heads for them when they are in sight).
// (Not plains: a tree here and there, and the plains beside a beach spawn drew every leg back to it.)
const WOODED = /(forest|taiga|jungle|savanna|grove|swamp|mangrove|meadow|garden|woodland|wooded)/;
const MELEE = /(^|:)(zombie|husk|drowned|zombie_villager|spider|cave_spider|silverfish|slime|endermite|zombified_piglin|piglin|piglin_brute|hoglin|zoglin|magma_cube|vindicator)$/;
const MAX_SIDESTEPS = 3;
const SIDESTEP = 8;
const CAVE_REACH = 48;
const CAVE_BAND = 24;
const MAX_IDLE_DIGS = 3;
const MAX_RELOCATIONS = 2;
const RELOCATE = 12;
const CLEAR_CAVE = 24;
const MAX_CAVE_VISITS = 8;
// Cave first: before the first dig down for an ore, walk (never dig) into a cave the body has seen or remembers, as a
// player does, and look round it. At most CAVE_WALKS walks; a cave closer than CAVE_NEAR is the spot the first look
// already saw from, and one with a hostile within CAVE_MOB_CLEAR is left alone. PR #31's room test (21 Nov): the cave
// legs dug with build on, re-fired after mob stops mid-descent and walked into the mob's cave: iron found 0 of 4
// exercised runs against 4 of 4, pickaxe worn out 3 of 4.
const CAVE_WALKS = 2;
const CAVE_NEAR = 6;
const CAVE_MOB_CLEAR = 12;
// No cave walks at all with a hostile this close to the body: a search asked again after a mob hand-back starts beside
// the mob's cave (room 21 Nov: walks right after a creeper stop).
const CAVE_MOB_SENSE = 24;
// One cave walk's time, and the search time a cave walk leaves for the dig down after it.
const CAVE_WALK_MS = 45_000;
const CAVE_DIG_RESERVE_MS = 90_000;
// Missed places for caves carry this blockId, so a failed cave walk never hides ore or water near it from a later search.
const CAVE_MISS = 'mineagen:cave';
const HOSTILE_TYPE = (type) => MELEE.test(String(type)) || RANGED.has(type) || /(^|:)(creeper|phantom|vex|evoker|ravager|warden)$/.test(String(type));
// Water seen this close to a cave row is a flooded floor: a walk in ends swimming (PR #31 rerun, one seed: stuck in its
// cave's water 5 of 6 runs, FIND_BLOCKED, while digging down saw iron in 69 s).
const CAVE_WATER_NEAR = 4;
const WET_WALK_STOPS = new Set(['WATER_AHEAD', 'TUNNEL_FLOODED', 'BREATH_LOW', 'AIR_RESERVE_REACHED', 'BREATH_NOT_COVERED']);
/**
 * Cave first is off unless MINEAGEN_CAVE_FIRST=on. Room batch 21 Nov (16 spawns x 10 repeats per arm, provider-free):
 * 75% of 103 cave walks found no walking way into a seen cave and 15% met a mob; only 10 arrived. On the 3 spawns where
 * walks fired, iron was found in 9 of 30 runs with it on against 18 of 30 off.
 */
export const caveFirst = (environment = process.env) => String(environment?.MINEAGEN_CAVE_FIRST ?? '').trim().toLowerCase() === 'on';
// Blocks a dig_to may be given (schema.mjs maxBlocks) and the cells one step cuts per pattern.
const MAX_DIG_BLOCKS = 4_096;
const STEP_CELLS = Object.freeze({ tunnel: 2, stairs_down: 3, stairs_up: 3, steep_down: 4 });
// Water under a dig down (an aquifer or a lake bed): above the target's band, the body walks WET_WALK blocks clear of it
// before the next dig down, at most MAX_WET_TUNNELS times; inside the band, the search stays at that level.
const MAX_WET_TUNNELS = 3;
const WET_WALK = 32;
const WET_WALK_MORE = 16;
// A walk off the water that went nowhere: a tunnel this many steps to one side (at least WET_SIDE_MIN of room inside
// within), toward the side with fewer water cells in sight within WET_SIDE_SIGHT blocks.
const WET_SIDE_TUNNEL = 10;
const WET_SIDE_MIN = 8;
const WET_SIDE_SIGHT = 12;
const WET_SAME = 12;
const WET_REGION = 64;
const WET_SPOT = 'water under a dig down';
const MAX_SWIMS = 6;
// Air still at this share of full after the swims up: breathing between bobs, so one swim out to a bank before handing
// back; the leg's length.
const AIR_BOBBING = 0.8;
const SWIM_OUT = 8;
// Walks back out of water a surface search makes (each to the last dry spot a leg ended on).
const MAX_RETRACES = 3;
// The last open-sky spot a wet or flooded body climbs back to: only one this close (a retrace along its own path).
const SKY_REACH = 48;
const FLOODED_REACH = 96;
// Swimming up a flooded stair: pulses of this many ticks, at most this many (the stair from y16 to the surface is ~50 up).
const STAIR_PULSE_TICKS = 40;
const MAX_WATER_STEPS = 6;
const MAX_STEP_OUTS = 2;
const MAX_STAIR_PULSES = 30;
// Stops that say the way back up is flooded or shut, not that the body is in danger: a new stair up instead.
const SHUT_WAY = new Set(['TUNNEL_FLOODED', 'NO_ROUTE', 'STALLED_IN_PLACE', 'NO_STANDABLE_PATH', 'PATH_BLOCKED', 'OUT_OF_BLOCKS', 'WATER_AHEAD']);
// A heading of a look is open water when this many of its far samples are water and none is land.
const SEA_SAMPLES = 3;
const SWIM_TICKS = 20;
// Remembered places this close together are one place (an ore's sighting and its remembered block).
const SAME_PLACE = 3;
// A remembered place a caller could not reach: it and the rest of its vein are no sighting.
export const UNREACHED = 'unreachable';
// A spot of water a caller could not get within reach of: that spot is no sighting, but the water joined to it still is.
// A lake or sea is one connected body, and one failed walk to it (timed out on the way, ended on a high bank) says
// nothing of the rest of its shore.
export const UNREACHED_SPOT = 'unreachable spot';
// Underground, a trip to a remembered place is a dig; past this many blocks it costs more than the search at depth.
// 4-seed check: trips of 39 and 62 blocks from y24 and y16 dug for 96 s, flooded, and once left the body in an aquifer.
const UNDERGROUND_TRIP = 32;
// A search below its ore's depth walks back up its own route first when the way back starts within this many blocks.
const WALK_BACK_UP = 128;
// Descent patterns: water stopping one is in the ground under this spot, whatever the heading.
const DESCENTS = /^dig (steep_down|stairs_down|shaft) /;

const id = (value) => (value.includes(':') ? value : `minecraft:${value}`);
const bare = (value) => value.replace(/^minecraft:/, '');
const wrap = (yaw) => ((yaw + 180) % 360 + 360) % 360 - 180;
const words = (value) => bare(String(value)).toLowerCase().replace(/[_-]+/g, ' ').trim();

/** What the target is and how it is sought: the ids that count as seen, the depth it lives at and the survey sections. */
export function findProfile(target, dimension = 'minecraft:overworld') {
	const kinds = FIND_KINDS.filter((kind) => target?.[kind] !== undefined);
	if (kinds.length !== 1) throw new TypeError(`find takes exactly one of ${FIND_KINDS.join(', ')}`);
	const kind = kinds[0];
	const value = String(target[kind]).trim().toLowerCase();
	if (kind === 'structure') {
		const name = words(value);
		return { kind, label: name, ids: new Set([name]), depth: null, surface: true, sections: ['structures', 'poi'] };
	}
	const main = id(value);
	if (kind === 'mob') return { kind, label: bare(main), ids: new Set([main]), depth: null, surface: true, sections: ['structures'] };
	if (kind === 'biome') return { kind, label: bare(main), ids: new Set([main]), depth: null, surface: true, sections: ['biomes'] };
	const ids = new Set([main]);
	const name = bare(main);
	if (/^[a-z_]+_ore$/.test(name)) {
		const variant = name.startsWith('deepslate_') ? name.slice('deepslate_'.length) : `deepslate_${name}`;
		if (howtoIndex().worldgen[variant]) ids.add(id(variant));
	}
	// Blocks that serve as well (obtain's any log: the biome's own first, then the rest), seen and surveyed too.
	for (const other of Array.isArray(target.also) ? target.also.slice(0, 8) : []) ids.add(id(String(other).trim().toLowerCase()));
	const depths = dimension === 'minecraft:the_nether' ? NETHER_DEPTHS : dimension === 'minecraft:overworld' ? DEPTHS : {};
	const depth = depths[name] ?? null;
	// Ore veins and caves are where underground blocks show; a surface block is surveyed for each id it may be.
	// (A survey takes at most 4 blocks:<id> searches: the first four ids, the target's own first.)
	const trees = [...ids].every((one) => /_(log|stem)$/.test(one));
	const sections = depth === null && ids.size > 1 ? ['blocks', ...[...ids].filter(SEARCHABLE).slice(0, 4).map((one) => `blocks:${one}`)]
		: ['blocks', 'veins', 'caves', ...(SEARCHABLE(main) ? [`blocks:${main}`] : [])];
	// Logs grow in wooded land: a tree search also looks for where it lies, as a player heads for the woods in sight.
	if (trees && dimension === 'minecraft:overworld') sections.push('biomes');
	return { kind, label: name, ids, stopId: main, depth, surface: depth === null, sections, trees };
}

// Terrain a blocks:<id> survey search refuses (FarSight.UNSEARCHABLE); lava, ores and logs are searchable.
const SEARCHABLE = (blockId) => !/(^|:)(air|cave_air|void_air|stone|deepslate|granite|diorite|andesite|tuff|dirt|grass_block|sand|red_sand|gravel|water|netherrack|end_stone|bedrock|sandstone|terracotta|basalt|blackstone|soul_sand|soul_soil|snow_block|clay|calcite)$/.test(blockId);

function bodyAt(observation) {
	const player = observation?.player;
	return [player?.x, player?.y, player?.z].every(Number.isFinite) ? { x: player.x, y: player.y, z: player.z } : null;
}

function cellOf(row) {
	if ([row?.x, row?.y, row?.z].every(Number.isFinite)) return { x: row.x, y: row.y, z: row.z };
	const match = typeof row?.stableId === 'string' ? row.stableId.match(/^(-?\d+),(-?\d+),(-?\d+)$/) : null;
	return match === null ? null : { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

function structureMatches(profile, name) {
	if (typeof name !== 'string') return false;
	const seen = words(name), wanted = profile.label;
	return seen === wanted || seen.includes(wanted) || wanted.includes(seen);
}

/**
 * The target as the body sees it now (the sample's own rows, its passive far sightings, and an optional survey), the
 * nearest first, or null. Remembered rows are not sightings.
 */
export function sightingOf(profile, observation, survey = null, exclude = null) {
	const body = bodyAt(observation);
	if (body === null) return null;
	const remembered = Array.isArray(observation?.continuity?.rememberedSections) ? observation.continuity.rememberedSections : [];
	const found = [];
	const dimension = observation?.world?.dimension;
	const add = (cell, what, via) => {
		if (cell === null || caveLog(what, cell.y, dimension, body.y)) return;
		found.push({ x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z), id: what, via,
			distance: Math.round(Math.hypot(cell.x + 0.5 - body.x, cell.y + 0.5 - body.y, cell.z + 0.5 - body.z)) });
	};
	const rows = (source, section) => (Array.isArray(source?.[section]) ? source[section].filter((row) => row !== null && typeof row === 'object') : []);
	const far = [observation?.sighted, survey].filter((source) => source !== null && typeof source === 'object');
	if (profile.kind === 'block') {
		if (!remembered.includes('blocks')) {
			const landmarks = rows(observation, 'landmarks');
			for (const row of [...rows(observation, 'blocks'), ...landmarks]) {
				const near = () => { const at = cellOf(row); return at === null || Math.hypot(at.x + 0.5 - body.x, at.y + 0.5 - body.y, at.z + 0.5 - body.z) <= FLUID_LEVEL_SIGHT; };
				const flowing = BUCKET_FLUIDS.has(row.blockId) && (row.state?.level !== undefined ? String(row.state.level) !== '0' : landmarks.includes(row) && near());
				if (profile.ids.has(row.blockId) && row.visible !== false && row.remembered !== true && !flowing && !smallLava(row)) add(cellOf(row), row.blockId, 'sight');
			}
		}
		for (const source of far) for (const section of ['blocks', 'veins']) for (const row of rows(source, section)) if (profile.ids.has(row.blockId) && row.flowing !== true && !smallLava(row)) add(cellOf(row), row.blockId, 'survey');
	} else if (profile.kind === 'mob') {
		if (!remembered.includes('entities')) {
			for (const row of rows(observation, 'entities')) {
				if (profile.ids.has(row.type) && row.alive !== false && row.perceivedBy !== 'sound') add(cellOf(row), row.type, 'sight');
			}
		}
	} else if (profile.kind === 'biome') {
		if (profile.ids.has(observation?.world?.biome)) add({ x: body.x - 0.5, y: body.y - 0.5, z: body.z - 0.5 }, observation.world.biome, 'standing in it');
		for (const source of far) for (const row of rows(source, 'biomes')) if (profile.ids.has(id(String(row.biome ?? '')))) add(cellOf(row), id(row.biome), 'survey');
	} else {
		for (const source of far) {
			for (const row of rows(source, 'structures')) if (structureMatches(profile, row.structure)) add(cellOf(row), row.structure, 'survey');
			if (profile.label === 'village') for (const row of rows(source, 'poi')) if (row.blockId === 'minecraft:bell') add(cellOf(row), 'village', 'survey');
		}
	}
	const out = exclude === null ? null : exclude(found);
	return found.filter((row) => out === null || !out.has(row)).sort((left, right) => left.distance - right.distance)[0] ?? null;
}

/**
 * The rows of the same vein as cells out of reach: a row touching one of them (by a face, edge or corner, as the vein
 * miner joins ore), or touching a row that does. Nearness alone is not the vein: a separate vein across a cave gap, or on
 * the body's own wall a few blocks away, is still a sighting. Returns the Set of those row objects.
 */
export function sameVein(cells, rows) {
	const touches = (a, b) => Math.abs(a.x - b.x) <= 1 && Math.abs(a.y - b.y) <= 1 && Math.abs(a.z - b.z) <= 1;
	const vein = new Set();
	const joined = [...cells];
	for (let grew = true; grew;) {
		grew = false;
		for (const row of rows) if (!vein.has(row) && joined.some((cell) => touches(cell, row))) { vein.add(row); joined.push(row); grew = true; }
	}
	return vein;
}

/** Where a WATER_AHEAD message says the water is ("Water at 20,61,5 beside..."), or null. */
export function waterOf(message) {
	const match = String(message ?? '').match(/water at (-?\d+),\s*(-?\d+),\s*(-?\d+)/i);
	return match === null ? null : { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

export function seenAtOf(message) {
	const match = String(message ?? '').match(/(?:seen at|pool at|lava at)\s*(-?\d+),\s*(-?\d+),\s*(-?\d+)/i);
	return match === null ? null : { x: Number(match[1]), y: Number(match[2]), z: Number(match[3]) };
}

// The rock ores replace (stone_ore_replaceables and deepslate_ore_replaceables).
const ORE_ROCK = new Set(['stone', 'granite', 'diorite', 'andesite', 'deepslate', 'tuff']);

// Loose pockets every kind of rock holds: they say nothing about the region.
const POCKETS = new Set(['gravel', 'dirt', 'clay', 'sand', 'coarse_dirt']);

/**
 * The share of a dig's mined rock ("; mined stone 22, sulfur 10") that ore can form in, leaving out loose pockets;
 * 1 when the dig names none.
 */
export function oreRockShare(message) {
	const listed = String(message ?? '').match(/;\s*mined ((?:[a-z_]+ \d+(?:, )?)+)/);
	if (listed === null) return 1;
	let rock = 0, all = 0;
	for (const [, name, count] of listed[1].matchAll(/([a-z_]+) (\d+)/g)) {
		if (POCKETS.has(name)) continue;
		all += Number(count);
		if (ORE_ROCK.has(name) || /_ore$/.test(name)) rock += Number(count);
	}
	return all === 0 ? 1 : rock / all;
}

/** Remembered places of the target, nearest first: kept sightings, remembered blocks and the model's own places. */
export function rememberedPlaces(profile, known, places, from) {
	const out = [];
	const add = (row, what, via) => { if ([row?.x, row?.y, row?.z].every(Number.isFinite)) out.push({ x: row.x, y: row.y, z: row.z, id: what, via }); };
	for (const row of known?.sightings ?? []) {
		if (profile.kind === 'block' && profile.ids.has(row.what) && ['lava', 'vein'].includes(row.kind)) add(row, row.what, 'remembered sighting');
		if (profile.kind === 'mob' && row.kind === 'mob' && profile.ids.has(row.what)) add(row, row.what, 'remembered sighting');
		if (profile.kind === 'structure' && row.kind === 'structure' && structureMatches(profile, row.what)) add(row, row.what, 'remembered sighting');
		if (profile.kind === 'biome' && row.kind === 'biome' && profile.ids.has(row.what)) add(row, row.what, 'remembered sighting');
		if (profile.kind === 'structure' && profile.label === 'village' && row.kind === 'poi' && row.what === 'minecraft:bell') add(row, 'village', 'remembered sighting');
	}
	if (profile.kind === 'block') for (const row of known?.blocks ?? []) if (profile.ids.has(row.blockId)) add(row, row.blockId, 'remembered block');
	const label = profile.label.replace(/_/g, ' ');
	for (const place of places ?? []) {
		const text = `${place?.label ?? ''} ${place?.summary ?? ''} ${place?.key ?? ''}`.toLowerCase().replace(/_/g, ' ');
		if (text.includes(label) || (profile.kind === 'block' && label === 'lava' && text.includes('lava'))) add(place.position, label, `your place ${place.key ?? place.label}`);
	}
	const sorted = out.map((row) => ({ ...row, distance: Math.round(Math.hypot(row.x + 0.5 - from.x, row.z + 0.5 - from.z)) }))
		.sort((left, right) => left.distance - right.distance);
	// One trip per place: a sighting and the remembered block of the same ore are the same place.
	return sorted.filter((row, i) => !sorted.slice(0, i).some((kept) => Math.hypot(kept.x - row.x, kept.y - row.y, kept.z - row.z) <= SAME_PLACE));
}

/**
 * The yaw of the next straight leg: keep the current one while it still leads to new ground; otherwise the heading
 * least walked and least seen. headings is exploreFrontier coverage ({ N: [walked, seen, ...] }).
 */
export function chooseHeading(headings, current = null, avoid = new Set()) {
	const rows = Object.entries(HEADING_YAW).filter(([name]) => !avoid.has(name)).map(([name, yaw]) => {
		const [walked = 0, seen = 0] = Array.isArray(headings?.[name]) ? headings[name] : [];
		return { name, yaw, score: walked + seen / 4 };
	});
	if (current !== null && rows.some((row) => row.yaw === current)) return current;
	rows.sort((left, right) => left.score - right.score);
	return rows[0]?.yaw ?? 0;
}

/**
 * The compass headings a look around showed as open water: each of its views with at least SEA_SAMPLES water samples and
 * no land, and the headings within 45 degrees of it (a view spans about 90).
 */
export function seaHeadings(views) {
	const out = new Set();
	for (const view of Array.isArray(views) ? views : []) {
		if (!Number.isFinite(view?.yaw) || !(view.water >= SEA_SAMPLES) || view.land !== 0) continue;
		for (const [name, yaw] of Object.entries(HEADING_YAW)) if (Math.abs(wrap(yaw - view.yaw)) <= 45) out.add(name);
	}
	return out;
}

function headingName(yaw) {
	return Object.entries(HEADING_YAW).sort((left, right) => Math.abs(wrap(left[1] - yaw)) - Math.abs(wrap(right[1] - yaw)))[0][0];
}

function nearestCardinal(yaw) {
	return CARDINALS.slice().sort((left, right) => Math.abs(wrap(left.yaw - yaw)) - Math.abs(wrap(right.yaw - yaw)))[0];
}

/**
 * The search. body provides: now(), observe() (a fresh sample), look({ pitch, survey }) (a 4-heading look around, its
 * merged survey rows), act(actionType, args, { watch }) (one body action; watch(sample) returning a sighting ends it
 * early, reported as result.seen), frontier() (exploreFrontier footing with coverage), known() (remembered sightings
 * and blocks), places() (the model's remembered places), progress(facts). Returns { state, reasonCode, message, find }.
 */
export async function searchFor(target, body, options = {}) {
	const night = { ended: null };
	const result = await searchLegs(target, body, options, night);
	// A night stop ends every later leg at once; whatever the search said after it, the night is why it stopped.
	return night.ended !== null && result?.state !== 'SUCCEEDED' ? night.ended : result;
}

async function searchLegs(target, body, { timeoutMs = DEFAULT_FIND_TIMEOUT_MS, within = DEFAULT_FIND_WITHIN } = {}, night) {
	const startedAt = body.now();
	const deadline = startedAt + timeoutMs;
	let observation = await body.observe();
	const origin = bodyAt(observation);
	if (origin === null) return { state: 'FAILED', reasonCode: 'FIND_NO_POSITION', message: 'find needs the body position' };
	if (portalTarget(target) && observation.world?.dimension === 'minecraft:overworld'
		&& (body.eyeSearchState?.portal || strongholdNearby(observation, body))) {
		return findPortalRoom(body, { observation, deadline, within, dangerCodes: DANGER,
			dangerNow: o => hostileIsDanger(o) && ((o.player?.threats?.length ?? o.threats?.entries?.length ?? 0) > 0 || (o.entities ?? []).some(e => e.hostile)) ? 'HOSTILE_NEAR' : null });
	}
	if (eyeTarget(target) && observation.world?.dimension === 'minecraft:overworld'
		&& (eyesHeld(observation) > 0 || body.eyeSearchState?.throws?.length)) {
		return followEyes(target, body, { observation, deadline, within, dangerCodes: DANGER, discard: DISCARD, seenAtOf,
			dangerNow: o => hostileIsDanger(o) && ((o.player?.threats?.length ?? o.threats?.entries?.length ?? 0) > 0 || (o.entities ?? []).some(e => e.hostile)) ? 'HOSTILE_NEAR' : null });
	}
	const profile = findProfile(target, observation?.world?.dimension);
	const insideBoundary = (at) => Math.hypot(at.x - origin.x, at.z - origin.z) <= within;
	const withinReach = () => { const at = bodyAt(observation); return at === null ? 0 : within - Math.hypot(at.x - origin.x, at.z - origin.z); };
	const legs = [];
	let looks = 0, fights = 0, deepest = origin.y, last = origin;
	const progress = (label) => body.progress?.({ label, legs: legs.length, looks, seconds: Math.round((body.now() - startedAt) / 1000) });
	const moved = () => {
		const at = bodyAt(observation) ?? last;
		deepest = Math.min(deepest, at.y);
		const step = Math.hypot(at.x - last.x, at.z - last.z);
		last = at;
		return step;
	};
	let walked = 0;
	const covered = () => {
		const at = bodyAt(observation) ?? last;
		return { seconds: Math.round((body.now() - startedAt) / 1000), legs: legs.length, looks, walked: Math.round(walked),
			fromStart: Math.round(Math.hypot(at.x - origin.x, at.z - origin.z)), startY: Math.floor(origin.y), y: Math.floor(at.y), deepestY: Math.floor(deepest),
			...(legs.length === 0 ? {} : { route: legs.slice(-8).map((leg) => `${leg.how} ${leg.reasonCode ?? leg.state}`) }) };
	};
	const describe = (seen) => `${seen.id.replace(/^minecraft:/, '')} seen at ${seen.x},${seen.y},${seen.z}, ${seen.distance} blocks away (${seen.via})`;
	// What the cave-first walks did, for the result: the model learns which way paid.
	let caveNote = '';
	const found = (seen) => ({ state: 'SUCCEEDED', reasonCode: 'FIND_SEEN', message: `Found: ${describe(seen)}${caveNote}`,
		find: { target: profile.label, seen, covered: covered() } });
	const handBack = (state, reasonCode, why, extra = {}) => {
		const c = covered();
		return { state, reasonCode, ...extra, message: `${why}. Covered in ${c.seconds} s: ${c.legs} leg(s), walked ${c.walked} blocks, now ${c.fromStart} from the start at y${c.y}${c.deepestY < c.startY - 2 ? ` (deepest y${c.deepestY})` : ''}; ${profile.label} not seen${caveNote}`,
			find: { target: profile.label, covered: c } };
	};
	// Set once a leg would take the body up or out into the night: every later leg ends the search the same way.
	let nightEnded = null;
	const left = () => nightEnded !== null ? 0 : deadline - body.now();
	const armed = () => (observation?.inventory?.items ?? []).some((item) => WEAPON.test(item?.itemId ?? ''));
	const forTarget = (place) => place.blockId === undefined || profile.ids.has(place.blockId);
	const unreached = (body.missedPlaces?.() ?? []).filter((place) => place.why === UNREACHED && forTarget(place)).map(({ x, y, z }) => ({ x, y, z }));
	const unreachedKeys = new Set(unreached.map(({ x, y, z }) => `${x},${y},${z}`));
	const spots = profile.ids.has('minecraft:water') ? (body.missedPlaces?.() ?? []).filter((place) => place.why === UNREACHED_SPOT) : [];
	const excluded = unreached.length === 0 && spots.length === 0 ? null : (rows) => {
		const vein = sameVein(unreached, rows);
		for (const { x, y, z } of vein) if (!unreachedKeys.has(`${x},${y},${z}`)) { unreachedKeys.add(`${x},${y},${z}`); unreached.push({ x, y, z }); }
		for (const row of rows) if (spots.some((place) => Math.hypot(place.x - row.x, place.y - row.y, place.z - row.z) <= SAME_PLACE)) vein.add(row);
		return vein;
	};
	const spent = (body.missedPlaces?.() ?? []).filter((place) => place.why === SMALL_POOL);
	const spentNear = (at, reach = SAME_PLACE) => spent.some((place) => Math.hypot(place.x - at.x, place.y - at.y, place.z - at.z) <= reach);
	const check = (survey = null) => {
		for (const source of [observation, observation?.sighted, survey]) for (const section of ['blocks', 'veins']) for (const row of (Array.isArray(source?.[section]) ? source[section] : [])) {
			const cell = smallLava(row) && profile.ids.has('minecraft:lava') ? cellOf(row) : null;
			if (cell !== null && !spentNear(cell)) { const at = { x: Math.floor(cell.x), y: Math.floor(cell.y), z: Math.floor(cell.z) }; spent.push(at); body.missPlace?.(at, SMALL_POOL); }
		}
		return sightingOf(profile, observation, survey, excluded);
	};
	const refresh = async () => { observation = await body.observe(); walked += moved(); return check(); };
	// The way up the body came down, as a player swims or climbs back out: the last spot it stood on under open sky (the
	// runtime keeps it from every sample), when that is above it and close enough to walk back to.
	const skyAbove = (here, reach) => {
		const sky = body.openSky?.() ?? null;
		return sky !== null && [sky.x, sky.y, sky.z].every(Number.isFinite) && here !== null && sky.y > here.y + 3
			&& Math.hypot(sky.x - here.x, sky.z - here.z) <= reach ? sky : null;
	};
	const swimUpStair = async (sky, failed = null) => {
		const next = /toward Point\[[^\]]*?x=(-?\d+), y=(-?\d+), z=(-?\d+)\]/.exec(String(failed?.result?.message ?? ''));
		const via = next === null ? null : { x: Number(next[1]) + 0.5, y: Number(next[2]), z: Number(next[3]) + 0.5 };
		let breathed = bodyAt(observation), since = 0, toward = sky;
		const from = breathed;
		let top = from?.y ?? -Infinity;
		for (let pulse = 0, stalls = 0; pulse < MAX_STAIR_PULSES && stalls < 2; pulse += 1) {
			const at = bodyAt(observation);
			const player = observation?.player;
			if (at === null || (player?.inWater !== true && player?.underWater !== true)) return null;
			if (player.underWater !== true) { breathed = at; since = 0; }
			else if ((Number.isFinite(player.air) ? player.air : 0) - STAIR_PULSE_TICKS < (since + 1) * STAIR_PULSE_TICKS) return backToBreath(breathed, since);
			toward = via !== null && (at.y < via.y - 0.5 || Math.hypot(via.x - at.x, via.z - at.z) > 0.8) ? via : sky;
			const yaw = Math.atan2(-(toward.x - at.x), toward.z - at.z) * 180 / Math.PI;
			const swim = await leg('swim up the flooded stair', 'control', { forward: 1, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false,
				yaw, pitch: -30, selectedSlot: Number.isSafeInteger(observation?.inventory?.selectedSlot) ? observation.inventory.selectedSlot : 0, hand: 'main', ticks: STAIR_PULSE_TICKS });
			if (swim.seen || swim.interrupted) return settle(swim);
			const after = bodyAt(observation);
			stalls = after !== null && after.y > at.y + 0.5 ? 0 : stalls + 1;
			if (after !== null) top = Math.max(top, after.y);
			if (observation?.player?.underWater === true) since += 1;
		}
		// Last breath at the top of the swim, not the last pulse's sample: with jump held at the water's top the eyes bob
		// under and back, and there is no lower breath to sink back to.
		const breathedAtTop = breathed !== null && breathed.y >= top - 1;
		if (observation?.player?.underWater === true && since > 0 && !breathedAtTop) { const back = await backToBreath(breathed, since); if (back !== null) return back; }
		return from !== null && (top < from.y + 1 || (inWater() && breathedAtTop)) ? stepOut(toward) : null;
	};
	let stepOuts = 0;
	const stepOut = async (toward) => {
		const breathing = (player) => player?.underWater !== true || (Number.isFinite(player?.air) && player.air >= AIR_BOBBING * (Number.isFinite(player.maxAir) ? player.maxAir : 300));
		if (stepOuts >= MAX_STEP_OUTS) return null;
		stepOuts += 1;
		for (let step = 0; step < MAX_WATER_STEPS; step += 1) {
			const at = bodyAt(observation), player = observation?.player;
			if (at === null || (player?.inWater !== true && player?.underWater !== true) || !breathing(player)) return null;
			const flat = Math.hypot(toward.x - at.x, toward.z - at.z) > 0.5;
			const dir = nearestCardinal(flat ? Math.atan2(-(toward.x - at.x), toward.z - at.z) * 180 / Math.PI : Number.isFinite(player.yaw) ? player.yaw : 0);
			const dx = Math.round(-Math.sin(dir.yaw * Math.PI / 180)), dz = Math.round(Math.cos(dir.yaw * Math.PI / 180));
			const fx = Math.floor(at.x), fy = Math.floor(at.y + 1e-3), fz = Math.floor(at.z);
			for (const [x, y, z] of [[fx + dx, fy + 1, fz + dz], [fx + dx, fy + 2, fz + dz], [fx + dx, fy + 3, fz + dz], [fx, fy + 2, fz], [fx, fy + 3, fz]]) {
				if (!breathing(observation?.player)) return null;
				const cut = await leg('cut a step out of the water', 'break_block', { x, y, z });
				if (cut.seen || cut.interrupted) return settle(cut);
				// TARGET_AIR is already clear; every other refusal leaves the hop unproven.
				if (cut.result?.state !== 'SUCCEEDED' && cut.result?.reasonCode !== 'TARGET_AIR') return null;
			}
			if (!breathing(observation?.player)) return null;
			const hop = await leg('climb the step out of the water', 'control', { forward: 1, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false,
				yaw: dir.yaw, pitch: 0, selectedSlot: Number.isSafeInteger(observation?.inventory?.selectedSlot) ? observation.inventory.selectedSlot : 0, hand: 'main', ticks: STAIR_PULSE_TICKS });
			if (hop.seen || hop.interrupted) return settle(hop);
			// The hop took the eyes under and the air is going: back down to where it breathed.
			if (observation?.player?.underWater === true && !breathing(observation.player)) return backToBreath(at, 1);
			const after = bodyAt(observation);
			if (after === null || after.y < at.y + 0.5) return null;
		}
		return null;
	};
	const inWater = () => observation?.player?.inWater === true || observation?.player?.underWater === true;
	// Back down to where it last breathed, sinking (sneak) toward it, a pulse for each it swam up; then the search goes
	// on from there, as from any stair the swim could not climb.
	const backToBreath = async (breathed, pulses) => {
		for (let pulse = 0; pulse <= pulses && observation?.player?.underWater === true; pulse += 1) {
			const at = bodyAt(observation);
			if (at === null) break;
			const yaw = Math.atan2(-(breathed.x - at.x), breathed.z - at.z) * 180 / Math.PI;
			const sink = await leg('back down to the last breath', 'control', { forward: Math.hypot(breathed.x - at.x, breathed.z - at.z) > 0.8 ? 1 : 0, strafe: 0, jump: false,
				sneak: at.y > breathed.y + 0.5, sprint: false, attack: false, use: false, yaw, pitch: 30,
				selectedSlot: Number.isSafeInteger(observation?.inventory?.selectedSlot) ? observation.inventory.selectedSlot : 0, hand: 'main', ticks: STAIR_PULSE_TICKS });
			if (sink.seen || sink.interrupted) return settle(sink);
		}
		return null;
	};

	// Caves the digs passed and the looks saw: open rock where a player sees ore and lava without digging for it.
	const caves = new Map();
	let caveVisits = 0;
	const noteCaves = (message, survey) => {
		const listed = String(message ?? '').match(/dug past caves at ([^;]+)/);
		for (const cell of listed === null ? [] : listed[1].matchAll(/(-?\d+),(-?\d+),(-?\d+)/g)) {
			const key = `${cell[1]},${cell[2]},${cell[3]}`;
			if (!caves.has(key)) caves.set(key, { x: Number(cell[1]), y: Number(cell[2]), z: Number(cell[3]), visited: false });
		}
		for (const row of Array.isArray(survey?.caves) ? survey.caves : []) {
			if (![row?.x, row?.y, row?.z].every(Number.isFinite)) continue;
			const key = `${row.x},${row.y},${row.z}`;
			if (!caves.has(key)) caves.set(key, { x: row.x, y: row.y, z: row.z, air: row.air, visited: false });
		}
	};
	const woods = [];
	const noteWoods = (survey) => {
		if (!profile.trees) return;
		for (const row of Array.isArray(survey?.biomes) ? survey.biomes : []) {
			if (WOODED.test(String(row?.biome ?? '')) && [row.x, row.z].every(Number.isFinite)) woods.push({ x: row.x, z: row.z, biome: row.biome });
		}
	};
	// What the last look around showed of the ground each way (the runtime's per-heading landmarks), and where it was taken.
	let ground = null, lookedFrom = null, lastSurvey = null, sweepHostiles = [];
	const cellOfBody = (at) => (at === null ? null : `${Math.floor(at.x)},${Math.floor(at.y + 0.01)},${Math.floor(at.z)}`);
	const look = async (pitch) => {
		// A mob the search fights, close and coming: met before the look turns the body's back on it. Fixture zombie
		// tunnel: it landed 4 hits during the first look (20 -> 10.8 health) while nothing answered it.
		const met = await meet();
		if (met !== null) return { ended: met };
		looks += 1;
		progress('look around');
		const result = await body.look({ pitch, survey: { include: profile.sections.slice(0, 8), limit: 8 } });
		if (result?.interruptedBy !== undefined) return { interrupted: result };
		lookedFrom = bodyAt(observation);
		lastSurvey = result?.survey ?? null;
		// Mobs any heading of the sweep showed: the last frame alone misses one beside a cave seen earlier in the turn.
		sweepHostiles = (Array.isArray(result?.samples) ? result.samples : []).flatMap((sample) => Array.isArray(sample?.entities) ? sample.entities : [])
			.map((row) => ({ type: row?.entityType ?? row?.type, ...(row?.position ?? row) })).filter((row) => HOSTILE_TYPE(row.type) && [row.x, row.y, row.z].every(Number.isFinite));
		ground = Array.isArray(result?.ground) ? { at: bodyAt(observation), views: result.ground } : null;
		noteCaves(null, result?.survey);
		noteWoods(result?.survey);
		const seen = check(result?.survey ?? null);
		if (seen !== null) return { seen };
		const now = await refresh();
		return now !== null ? { seen: now } : toSpill(result?.survey ?? null);
	};
	const spilled = [];
	const toSpill = async (survey) => {
		if (profile.kind !== 'block' || spilled.length >= MAX_SPILLS || left() < MIN_LEG_MS) return { seen: null };
		const at = bodyAt(observation);
		const near = (cell) => (place) => Math.hypot(place.x - cell.x, place.y - cell.y, place.z - cell.z) <= SAME_PLACE;
		const missedSpills = (body.missedPlaces?.() ?? []).filter((place) => place.why === NO_SOURCE);
		const spill = [observation?.sighted, survey].flatMap((source) => ['blocks', 'veins'].flatMap((section) => (Array.isArray(source?.[section]) ? source[section] : [])))
			.filter((row) => row?.flowing === true && BUCKET_FLUIDS.has(row.blockId) && profile.ids.has(row.blockId))
			.map((row) => ({ ...cellOf(row), id: row.blockId })).filter((cell) => Number.isFinite(cell.x) && insideBoundary(cell)
				&& !spilled.some(near(cell)) && !missedSpills.some(near(cell)))
			.sort((a, b) => Math.hypot(a.x - at.x, a.y - at.y, a.z - at.z) - Math.hypot(b.x - at.x, b.y - at.y, b.z - at.z))[0];
		if (spill === undefined) return { seen: null };
		spilled.push(spill);
		const walk = await leg(`to the ${bare(spill.id)} spill at ${spill.x},${spill.y},${spill.z}`, 'travel_to',
			{ x: spill.x + 0.5, y: spill.y + 1, z: spill.z + 0.5, tolerance: 3, stopWhenSeen: profile.stopId });
		if (walk.seen || walk.interrupted) return walk;
		const ended = await settle(walk);
		if (ended !== null) return { ended };
		const there = await look(10);
		if (!there.seen && !there.interrupted && !there.ended) body.missPlace?.({ x: spill.x, y: spill.y, z: spill.z }, NO_SOURCE);
		return there;
	};

	// One body action toward the search; a sighting during it (its own stopWhenSeen, or the watch) ends it.
	// sight: what ends this leg as seen (default: the target in view anywhere, as sightingOf reads it).
	// until(sample): an extra stop for the leg (the walk back up ends at the ore's band), handed back as no sighting.
	const leg = async (how, actionType, args, sight = null, { until = null } = {}) => {
		if (nightEnded === null) {
			const why = nightMoveStop(observation, actionType, args, { openSky: body.openSky?.() ?? null });
			if (why !== null) night.ended = nightEnded = handBack('FAILED', 'FIND_NIGHT', `Stopped before "${how}": ${why}`);
		}
		if (nightEnded !== null) return { ended: nightEnded, result: { state: 'FAILED', reasonCode: 'FIND_NIGHT' } };
		// While a Nether biome is approached, every leg (a fight or sidestep on the way too) ends as seen only standing in it.
		if (sight === null && approaching && netherBiome()) sight = standingIn;
		progress(how);
		const timeout = Math.min(left(), 600_000, args.timeoutMs ?? Infinity);
		// Controllers enforce the original circle on every tick, including retrace detours.
		if (profile.ids.has('minecraft:water') && ['travel_to', 'dig_to'].includes(actionType)) args = { ...args, boundaryX: origin.x, boundaryZ: origin.z, boundaryRadius: within };
		const result = await body.act(actionType, TIMED.has(actionType) ? { ...args, timeoutMs: Math.max(MIN_LEG_MS, Math.floor(timeout)) } : args, { watch: sight ?? ((sample) => sightingOf(profile, sample, null, excluded) ?? (until?.(sample) ? { until: true } : null)) });
		const entry = { how, actionType, state: result?.state, reasonCode: result?.reasonCode, underWater: /body is under water/i.test(String(result?.message ?? '')),
			waterAt: result?.reasonCode === 'WATER_AHEAD' ? waterOf(result?.message) : null };
		legs.push(entry);
		noteCaves(result?.message, null);
		if (result?.interruptedBy !== undefined) return { interrupted: result };
		if (result?.seen?.until === true) { observation = await body.observe(); walked += moved(); return { result: { ...result, seen: undefined } }; }
		if (result?.seen != null) { observation = await body.observe(); walked += moved(); return { seen: result.seen, result }; }
		// A dig stopped at lava is a sighting only when it names a pool (a source): a fall or spill it plugged is not.
		const seenAt = result?.reasonCode === 'TARGET_SEEN' || (result?.reasonCode === 'LAVA_AHEAD' && profile.ids.has('minecraft:lava') && /target pool found/i.test(String(result.message ?? ''))) ? seenAtOf(result.message) : null;
		const now = sight === null ? await refresh() : (observation = await body.observe(), walked += moved(), sight(observation));
		if (now !== null) return { seen: now, result };
		if (seenAt !== null && !(excluded?.([seenAt]).size > 0)) {
			const at = bodyAt(observation);
			return { seen: { ...seenAt, id: profile.stopId ?? [...profile.ids][0], via: actionType, distance: Math.round(Math.hypot(seenAt.x + 0.5 - at.x, seenAt.y + 0.5 - at.y, seenAt.z + 0.5 - at.z)) }, result };
		}
		return { result };
	};

	// What every leg's stop means for the search: a sighting ends it, danger and blockers hand back, the rest go on.
	const settle = async (outcome) => {
		// A leg that saw the target and stopped for danger hands the danger back first, with the sighting: a body that
		// refused to dig into lava with iron in view is not "found, go on".
		const stop = outcome.result?.reasonCode;
		if (stop === 'SEARCH_BOUNDARY') return handBack('FAILED', 'FIND_NOT_FOUND', `Searched to ${within} blocks from the start`);
		const fork = outcome.seen && stop === 'HOSTILE_NEAR' ? searchDanger(observation)?.fork : undefined;
		if (outcome.seen && (fork !== undefined || stop !== 'HOSTILE_NEAR') && DANGER.has(stop) && !(stop === 'LAVA_AHEAD' && profile.ids.has('minecraft:lava'))) {
			return { state: 'FAILED', reasonCode: 'FIND_DANGER', find: { target: profile.label, seen: outcome.seen, covered: covered() },
				message: `Stopped for danger: ${fork !== undefined ? `${fork} (${stop})` : stop}${outcome.result?.message ? ` (${String(outcome.result.message).slice(0, 200)})` : ''}; also seen: ${describe(outcome.seen)}` };
		}
		if (outcome.ended) return outcome.ended;
		if (outcome.seen) return arrive(outcome.seen);
		if (outcome.interrupted) {
			// The steer that stopped it is the model's fork; its reason leads the message (obtain keeps the first 160 characters).
			let why = '';
			try { const judged = searchDanger(await body.observe()); if (judged?.fork !== undefined) why = ` (${judged.fork})`; } catch { /* the steer's own facts stand */ }
			return { ...outcome.interrupted, reasonCode: 'FIND_DANGER', find: { target: profile.label, covered: covered() },
				message: `Danger stopped the search${why}; the leg still runs (${outcome.interrupted.actionId}): deal with it, then find again` };
		}
		const result = outcome.result;
		const code = result?.reasonCode;
		if (!profile.ids.has('minecraft:water') && !DESCENTS.test(legs.at(-1)?.how ?? '')
			&& (code === 'WATER_AHEAD' || (code === 'TUNNEL_FLOODED' && !/^Lava flowed/i.test(String(result?.message ?? ''))))) {
			const named = String(result?.message ?? '').match(/\bat (-?\d+),(-?\d+),(-?\d+)/);
			const here = bodyAt(observation);
			const cell = named !== null ? { x: Number(named[1]), y: Number(named[2]), z: Number(named[3]) }
				: here === null ? null : { x: Math.floor(here.x), y: Math.floor(here.y + 1e-3), z: Math.floor(here.z) };
			if (cell !== null) body.missPlace?.(cell, WET_SPOT);
		}
		// A far hostile only ended a walk on the surface: the next leg starts with it in view, and travel stops for one
		// in view only up close.
		if (code === 'HOSTILE_NEAR' && profile.surface && legs.at(-1)?.actionType === 'travel_to' && !hostileIsDanger(observation)) return null;
		// A hostile that stopped a leg, or a mob's hit, judged as a player would (search-danger.mjs): the model's fork goes
		// back with its reason; one mob the body can beat is fought; one behind rock or not after the body is passed by.
		// Gate run 3: 8 of 24 mob hand-backs during find and obtain were these, each a model round trip.
		const hit = HIT_STOPS.has(code) && /\bmob\b/.test(String(result?.message ?? ''));
		const judged = code === 'HOSTILE_NEAR' || hit ? searchDanger(observation) : null;
		// A mob's hit with no hostile left in sense (a reflex or the fight killed it) and health above the floor: a player
		// searches on. Fixture zombie tunnel: the reflex killed it during the dig, and the stop for its hit handed back.
		if (hit && judged === null && Array.isArray(observation?.player?.threats) && observation.player.health > SEARCH_LOW_HEALTH) return null;
		if (judged?.fork !== undefined) {
			// A creeper close by is the model's to back away from or kill: hand back now with the stop's own words (its
			// `minecraft:creeper <uuid>` is what the answer flees from), not walled in beside it.
			if (creeperNear(observation) !== null) return handBack('FAILED', 'FIND_DANGER', `Stopped for danger: ${judged.fork} (${code}${result?.message ? `: ${String(result.message).slice(0, 200)}` : ''})`);
			const walled = observation?.player?.underWater === true ? false : await cover();
			return handBack('FAILED', 'FIND_DANGER', `Stopped for danger: ${judged.fork} (${code})${walled ? '; walled in where it stands' : ''}`);
		}
		if (judged?.handle === 'fight' && fights < MAX_FIGHTS) {
			const fought = await fightMob(judged.mob);
			return fought === true ? null : fought;
		}
		if (judged?.handle === 'ignore' && code === 'HOSTILE_NEAR') {
			const mob = judged.mob.uuid ?? judged.mob.stableId;
			passes.set(mob, (passes.get(mob) ?? 0) + 1);
			if (passes.get(mob) <= MAX_PASSES) return null;
		}
		if (code === 'HOSTILE_NEAR') {
			if (fights < MAX_FIGHTS) {
				const fought = await fight();
				if (fought === true) return null;
				if (fought !== null && typeof fought === 'object') return fought;
			}
			// One it cannot reach (in a cave below, a creeper): get out of its sight and go on from there.
			if (sidesteps < MAX_SIDESTEPS) {
				const stepped = await sidestep(result?.message);
				if (stepped !== null) return stepped === true ? null : stepped;
			}
		}
		// A walk or swim that stopped for breath with the body still in the water: the escape job is the player's next
		// move, not a hand-back, since no model answers inside the air left (#83's duck-out is in escape's swim too). Only
		// when it leaves the body in the water does the breath stop go back as danger.
		if (AIR_STOPS.has(code) && inWater() && escapes < MAX_ESCAPES) {
			const escaped = await escapeWater();
			if (escaped !== null) return escaped;
			if (!inWater()) return null;
		}
		// Lava ahead is what a lava search is after: the dig loop peeks at it (below) rather than handing back.
		if (DANGER.has(code) && !(code === 'LAVA_AHEAD' && profile.ids.has('minecraft:lava'))) {
			// Underground, the body is handed back walled in rather than idle in a cave's line of fire; never on a stop for
			// air, drowning or flooding, or under water, where building spends the breath it has left.
			const walled = BREATH_STOPS.has(code) || /drown/i.test(String(result?.message ?? '')) || observation?.player?.underWater === true ? false : await cover();
			const back = handBack('FAILED', 'FIND_DANGER', `Stopped for danger: ${code}${result?.message ? ` (${String(result.message).slice(0, 200)})` : ''}${walled ? '; walled in where it stands' : ''}`);
			// The leg's own stop code, so a caller (obtain) can tell a low-health stop from danger.
			back.find.stopCode = code;
			return back;
		}
		// A worn pickaxe with a sound one carried off the hotbar: a player swaps it in and digs on. Kit chain, 5 of 8 gate
		// seeds: the iron pickaxe wore out on the way down to the lava level and every find after it handed back TOOL_WORN
		// from the same cell while spare stone pickaxes sat in the inventory.
		if ((code === 'TOOL_WORN' || code === 'NO_TOOL') && swaps < MAX_SWAPS) {
			const spare = sparePickaxe(observation);
			if (spare !== null) {
				swaps += 1;
				const selected = observation?.inventory?.selectedSlot;
				const swapped = await body.act('select_tool', { sourceSlot: spare.slot, hotbarSlot: Number.isSafeInteger(selected) ? selected : 0, expectedItemId: spare.itemId, minRemainingDurability: 3 });
				observation = await body.observe();
				if (swapped?.state === 'SUCCEEDED') return null;
			}
		}
		if (BLOCKED.has(code)) return handBack('FAILED', 'FIND_BLOCKED', `The body cannot go on: ${code}${result?.message ? ` (${String(result.message).slice(0, 200)})` : ''}`);
		return null;
	};
	let swaps = 0;
	let escapes = 0;
	// Still in the water after a leg stopped there: the escape job (do_step escape) gets the body out as a player swims or
	// climbs out (to air, out from under a ledge, to a bank, a step or a filled shaft), then the search judges the spot
	// from dry footing. B-1's aquifer: the way back NO_ROUTE and the walk off STALLED_IN_PLACE, 3 blocks under the start,
	// then a hand-back in the water.
	const escapeWater = async () => {
		if (!inWater() || escapes >= MAX_ESCAPES) return null;
		escapes += 1;
		// At most do_step escape's own 60 s, and never past the search's budget (leg caps a timed action by what is left).
		return settle(await leg('escape the water', 'escape', { timeoutMs: 60_000 }));
	};
	const bucketToHotbar = async () => {
		const items = observation?.inventory?.items ?? [];
		const selected = observation?.inventory?.selectedSlot;
		const slotOf = (item) => (item?.slot === 'mainhand' ? selected : item?.slot);
		const isBucket = (item) => item?.itemId === 'minecraft:water_bucket';
		if (items.some((item) => isBucket(item) && (item.slot === 'offhand' || slotOf(item) === 40 || (Number.isSafeInteger(slotOf(item)) && slotOf(item) < 9)))) return;
		const bucket = items.find((item) => isBucket(item) && Number.isSafeInteger(item.slot) && item.slot >= 9 && item.slot <= 35);
		if (bucket === undefined) return;
		const hotbar = new Map(items.filter((item) => Number.isSafeInteger(slotOf(item)) && slotOf(item) < 9).map((item) => [slotOf(item), item.itemId]));
		const options = [...Array(9).keys()].filter((slot) => slot !== selected);
		const keep = /_pickaxe$|_sword$|_axe$|_shovel$|shield$|bucket$|flint_and_steel$|obsidian$|crafting_table$|furnace$/;
		const into = options.find((slot) => !hotbar.has(slot)) ?? options.find((slot) => DISCARD.includes(hotbar.get(slot)))
			?? options.find((slot) => !keep.test(hotbar.get(slot) ?? ''));
		if (into === undefined) return;
		await body.act('select_tool', { sourceSlot: bucket.slot, hotbarSlot: into, expectedItemId: 'minecraft:water_bucket', minRemainingDurability: 0 });
		observation = await body.observe();
	};

	// A Nether biome is found by standing in it, not by seeing it: seven-rods scouts saw no way across basalt deltas to a
	// forest (travel_to NO_ROUTE 0-64 times a run, never nearer than 103 blocks), and a far sight handed back as found
	// left the crossing to the model. The approach heads for the seen or remembered cell in legs; a leg that gains under
	// APPROACH_GAIN blocks is followed by a building leg toward it, from the approach's own building budget.
	const netherBiome = () => profile.kind === 'biome' && observation?.world?.dimension === 'minecraft:the_nether';
	const standingIn = (sample) => {
		const at = bodyAt(sample);
		// Standing, not passing through: a body knocked off a bridge falls through the biome over lava.
		return at !== null && sample?.player?.onGround !== false && profile.ids.has(sample?.world?.biome)
			? { x: Math.floor(at.x), y: Math.floor(at.y), z: Math.floor(at.z), id: sample.world.biome, via: 'standing in it', distance: 0 } : null;
	};
	let approaching = false;
	// Lava ahead of a leg in the deltas is the ground, not danger, while the body is out of lava and not burning: the
	// heading is blocked and the next leg turns. Anything else a leg stops for is settled as on every other leg.
	const lavaLip = (outcome) => !outcome.seen && outcome.result?.reasonCode === 'LAVA_AHEAD'
		&& observation?.player?.inLava !== true && observation?.player?.onFire !== true;
	// Returns a result to hand back (found, danger, budget), or { stuck } when this place cannot be reached from here.
	const approach = async (goal, what) => {
		approaching = true;
		try {
			let budget = APPROACH_BUILD_BUDGET, stuck = 0, legsRun = 0, pastTried = false;
			while (left() >= MIN_LEG_MS) {
				const here = standingIn(observation);
				if (here !== null) return found(here);
				const at = bodyAt(observation);
				const away = Math.hypot(goal.x + 0.5 - at.x, goal.z + 0.5 - at.z);
				if (away <= APPROACH_ARRIVE) {
					if (pastTried || withinReach() < 1) return { stuck: `reached ${goal.x},${goal.y},${goal.z} but the ground there is not ${profile.label}` };
					pastTried = true;
					const through = wrap(Math.round(Math.atan2(-(goal.x + 0.5 - at.x), goal.z + 0.5 - at.z) * 180 / Math.PI));
					const step = await leg(`through to ${what}`, 'travel_to', { yaw: through, distance: Math.min(Math.ceil(away) + APPROACH_PAST, Math.floor(withinReach())), build: false }, standingIn);
					const stepEnd = lavaLip(step) ? null : await settle(step);
					if (stepEnd !== null) return stepEnd;
					continue;
				}
				// The caller's within holds for the approach too: no leg ends beyond it.
				if (!insideBoundary({ x: goal.x + 0.5, z: goal.z + 0.5 })) return { stuck: `${goal.x},${goal.y},${goal.z} lies beyond within ${within} of the start` };
				// A straight leg to a goal inside the boundary stays inside it (the area is a circle); only a turned leg can leave it.
				const turned = APPROACH_TURNS[stuck % APPROACH_TURNS.length] !== 0;
				const room = turned ? Math.floor(withinReach()) : Infinity;
				if (room < MIN_SURFACE_LEG) return { stuck: `at the edge of within ${within} of the start; ${Math.round(away)} blocks left` };
				if (stuck >= APPROACH_STUCK) return { stuck: `${stuck} approach legs in a row gained under ${APPROACH_GAIN} blocks; ${Math.round(away)} blocks left` };
				const yaw = wrap(Math.round(Math.atan2(-(goal.x + 0.5 - at.x), goal.z + 0.5 - at.z) * 180 / Math.PI) + APPROACH_TURNS[stuck % APPROACH_TURNS.length]);
				legsRun += 1;
				const walkOut = await leg(`approach ${what} (${Math.round(away)} blocks)`, 'travel_to', { yaw, distance: Math.min(APPROACH_LEG, Math.ceil(away), room), build: false }, standingIn);
				const walkEnd = lavaLip(walkOut) ? null : await settle(walkOut);
				if (walkEnd !== null) return walkEnd;
				let after = bodyAt(observation), gain = away - Math.hypot(goal.x + 0.5 - after.x, goal.z + 0.5 - after.z);
				if (gain < APPROACH_GAIN && standingIn(observation) === null && budget >= MIN_SURFACE_LEG && left() >= MIN_LEG_MS) {
					const distance = Math.min(BUILD_LEG, budget, Math.ceil(away), Math.max(1, Math.floor(withinReach())));
					budget -= distance;
					const built = await leg(`build toward ${what}`, 'travel_to', { yaw, distance, build: true }, standingIn);
					const buildEnd = lavaLip(built) ? null : await settle(built);
					if (buildEnd !== null) return buildEnd;
					after = bodyAt(observation);
					gain = away - Math.hypot(goal.x + 0.5 - after.x, goal.z + 0.5 - after.z);
				}
				stuck = gain < APPROACH_GAIN ? stuck + 1 : 0;
				if (stuck > 0 && budget < MIN_SURFACE_LEG) return { stuck: `the approach's ${APPROACH_BUILD_BUDGET}-block building budget is spent; ${Math.round(away - gain)} blocks left` };
			}
			return handBack('TIMED_OUT', 'FIND_BUDGET', `The search time ran out approaching ${what}`);
		} finally { approaching = false; }
	};
	// Every sighting ends here: a Nether biome is found only standing in it, anything else on sight.
	// During an approach a far sighting is no arrival: the approach goes on (null).
	const arrive = (seen) => (!netherBiome() || seen.via === 'standing in it' ? found(seen) : approaching ? null : approachSeen(seen));
	const approachSeen = async (seen) => {
		const reached = await approach(seen, `the ${profile.label} seen at ${seen.x},${seen.y},${seen.z}`);
		if (reached?.stuck === undefined) return reached;
		return handBack('FAILED', 'FIND_BLOCKED', `${describe(seen)}, but no way there: ${reached.stuck}`);
	};

	const shelterBlock = () => (observation?.inventory?.items ?? []).find((item) => SHELTER_BLOCKS.has(item?.itemId) && item.count >= 8)?.itemId;
	const cover = async () => {
		const block = shelterBlock();
		// A mob on foot can reach the opening while the body builds, leaving nowhere to run when the pack catches up.
		if (profile.surface || block === undefined || observation?.player?.skyOpen === true
			|| creeperNear(observation) !== null || pursuedByPack(observation)) return false;
		const at = bodyAt(observation);
		const walled = await leg('wall in', 'build_shelter', { x: Math.floor(at.x), y: Math.floor(at.y + 1e-3), z: Math.floor(at.z), opening: nearestCardinal(observation?.player?.yaw ?? 0).name, itemId: block, roof: true });
		return walled.result?.reasonCode === 'SHELTER_BUILT';
	};

	// Out of a hostile's sight: 8 blocks straight away from it, then the search goes on from there. Travel legs do not set
	// fightThrough (it engages creepers and pursues); find's fight() keeps its limits. Under the instincts arm the mod
	// still fights a lone beatable melee mob on any leg without the key (TravelStops.beatable).
	let sidesteps = 0, awayFrom = null;
	const passes = new Map();
	const sidestep = async (message) => {
		const at = bodyAt(observation);
		const named = String(message ?? '').match(/at (-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?),(-?\d+(?:\.\d+)?)/);
		const creeper = creeperNear(observation);
		const mob = creeper !== null && [creeper.x, creeper.z].every(Number.isFinite) ? creeper
			: named !== null ? { x: Number(named[1]) + 0.5, z: Number(named[3]) + 0.5 }
			: (observation?.entities ?? []).filter((row) => row?.hostile === true && [row.x, row.z].every(Number.isFinite))
				.sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))[0];
		if (mob === undefined) return null;
		const away = nearestCardinal(Math.atan2(-(at.x - mob.x), at.z - mob.z) * 180 / Math.PI);
		// Underground (a cave opened under the dig): wall the body in with its window away from the mob, then dig on
		// away from it. Walking would lead into the cave.
		const block = (observation?.inventory?.items ?? []).find((item) => SHELTER_BLOCKS.has(item?.itemId) && item.count >= 8)?.itemId;
		// Never beside a creeper: its blast breaks the wall. Walk away from it when the body can, else the model's fork.
		if (creeper !== null && !armed()) return handBack('FAILED', 'FIND_DANGER', `Stopped for danger: a creeper ${Math.round(creeper.distance)} blocks away (HOSTILE_NEAR${message ? `: ${String(message).slice(0, 200)}` : ''})`);
		if (!profile.surface && block !== undefined && creeper === null) {
			sidesteps += 1;
			awayFrom = away;
			const feet = { x: Math.floor(at.x), y: Math.floor(at.y + 1e-3), z: Math.floor(at.z) };
			const walled = await leg('wall off the cave', 'build_shelter', { ...feet, opening: away.name, itemId: block, roof: true });
			if (walled.seen || walled.interrupted) return settle(walled);
			return true;
		}
		if (!armed()) return null;
		sidesteps += 1;
		const outcome = await leg('away from the hostile', 'travel_to', { yaw: away.yaw, distance: SIDESTEP });
		if (outcome.seen || outcome.interrupted) return settle(outcome);
		const code = outcome.result?.reasonCode;
		if (DANGER.has(code) && code !== 'HOSTILE_NEAR') return handBack('FAILED', 'FIND_DANGER', `Stopped for danger: ${code}${outcome.result?.message ? ` (${String(outcome.result.message).slice(0, 200)})` : ''}`);
		return true;
	};

	// A hostile in the way: a player with a weapon and the health for it fights, then goes on; otherwise hands back.
	const fight = async () => {
		const player = observation?.player ?? {};
		const at = bodyAt(observation);
		// Only a melee mob close by and level with the body: chasing a skeleton or anything below leads off the stairs.
		const hostile = (observation?.entities ?? []).filter((row) => row?.hostile === true && row.alive !== false && typeof row.stableId === 'string' && row.type !== 'minecraft:creeper'
			&& [row.x, row.y, row.z].every(Number.isFinite) && Math.abs(row.y - at.y) <= 2
			// A melee mob within 6 blocks; a ranged one only at arm's length (beside a wall or window).
			&& Math.hypot(row.x - at.x, row.z - at.z) <= (MELEE.test(row.type ?? '') ? 6 : 3)).sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))[0];
		const tool = (observation?.inventory?.items ?? []).some((item) => /(^|:)[a-z_]+_pickaxe$/.test(item?.itemId ?? ''));
		const company = (observation?.entities ?? []).filter((row) => row?.hostile === true && row.alive !== false && [row.x, row.z].every(Number.isFinite)
			&& Math.hypot(row.x - at.x, row.z - at.z) <= 12).length;
		const able = armed() ? player.health >= 12 : tool && player.health >= 16 && company <= 1 && MELEE.test(hostile?.type ?? '');
		if (!able || hostile === undefined) return null;
		fights += 1;
		// Underground the body stays on its own stairs: pursuing drops it into the cave the mob came from.
		const outcome = await leg(`fight ${bare(hostile.type)}`, 'fight_target', { targetId: hostile.stableId, fleeAtHealth: 8, ...(profile.surface ? {} : { pursue: false }) });
		if (outcome.seen || outcome.interrupted) return settle(outcome);
		return ['SUCCEEDED'].includes(outcome.result?.state) || ['TARGET_KILLED', 'TARGET_GONE', 'TARGET_LOST'].includes(outcome.result?.reasonCode) ? true : null;
	};

	// The one mob search-danger.mjs judged the body can beat: in reach and level with it, fought where the body stands
	// (underground on its own stairs, no pursuit); farther, above or below, the body stands and lets it come into reach,
	// as a player does in a tunnel. One that never comes is behind rock: the search goes on. Returns true when the search
	// goes on, else its ending: a fight that left the mob alive (it bailed at low health, or ran out of time in reach)
	// is the model's fork, handed back walled in; looking round or digging on turns the body's back on a live mob.
	const fightMob = async (mob) => {
		const id = mob.uuid ?? mob.stableId;
		const inReach = () => {
			const at = bodyAt(observation);
			const row = (observation?.entities ?? []).find((entity) => entity?.stableId === id && entity.alive !== false && [entity.x, entity.y, entity.z].every(Number.isFinite));
			return row !== undefined && at !== null && Math.abs(row.y - at.y) <= 2 && Math.hypot(row.x - at.x, row.z - at.z) <= 6;
		};
		const near = inReach();
		fights += 1;
		const fightFor = (timeoutMs, pursue) => leg(`fight ${bare(mob.type)}`, 'fight_target', { targetId: id, fleeAtHealth: SEARCH_LOW_HEALTH,
			...(profile.surface && pursue ? {} : { pursue: false }), timeoutMs });
		let outcome = await fightFor(near ? FIGHT_MS : MEET_MS, near);
		if (outcome.seen || outcome.interrupted) return settle(outcome);
		// MEET_MS covers the wait and the fight: a mob that came late can time it out alive in reach. Only one still out of
		// reach on the leg's fresh sample never came; one in reach is fought on for a whole fight.
		if (!near && outcome.result?.reasonCode === 'FIGHT_TIMED_OUT') {
			if (!inReach()) { passes.set(id, (passes.get(id) ?? 0) + 1); return true; }
			outcome = await fightFor(FIGHT_MS, true);
			if (outcome.seen || outcome.interrupted) return settle(outcome);
		}
		if (outcome.result?.state === 'SUCCEEDED' || ['TARGET_KILLED', 'TARGET_GONE', 'TARGET_LOST'].includes(outcome.result?.reasonCode)) return true;
		const now = searchDanger(observation);
		const why = now?.fork ?? `health ${observation?.player?.health ?? '?'} with a ${bare(mob.type)} it fought and did not kill`;
		const walled = observation?.player?.underWater === true ? false : await cover();
		return handBack('FAILED', 'FIND_DANGER', `Stopped for danger: ${why} (fight ${outcome.result?.reasonCode ?? outcome.result?.state ?? 'ended'})${walled ? '; walled in where it stands' : ''}`);
	};

	// The mob search-danger.mjs would fight, close enough to reach the body before the next leg stops for it: fought now.
	// Returns the search's ending when the fight ends it, else null.
	const meet = async () => {
		const judged = searchDanger(observation);
		if (judged?.handle !== 'fight' || fights >= MAX_FIGHTS || !(judged.mob.distance <= ENGAGE_CLOSE)) return null;
		const fought = await fightMob(judged.mob);
		return fought === true ? null : fought;
	};

	// Under water the body gets its eyes into air before any other move; breath is never spent on digs.
	let retracesUp = 0;
	const surface = async () => {
		for (let tries = 0; tries < MAX_SWIMS && observation?.player?.underWater === true; tries += 1) {
			const player = observation.player;
			const swim = await leg('swim up', 'control', { forward: 0, strafe: 0, jump: true, sneak: false, sprint: false, attack: false, use: false,
				yaw: Number.isFinite(player.yaw) ? player.yaw : 0, pitch: -30, selectedSlot: Number.isSafeInteger(observation?.inventory?.selectedSlot) ? observation.inventory.selectedSlot : 0, hand: 'main', ticks: SWIM_TICKS });
			if (swim.seen || swim.interrupted) return settle(swim);
		}
		if (observation?.player?.underWater !== true) return null;
		const full = Number.isFinite(observation.player.air) && observation.player.air >= AIR_BOBBING * (Number.isFinite(observation.player.maxAir) ? observation.player.maxAir : 300);
		if (full) {
			const out = await leg('swim out of the water', 'travel_to', { yaw: Number.isFinite(observation.player.yaw) ? observation.player.yaw : 0, distance: SWIM_OUT, tolerance: 2 });
			// A danger stop on the way to the bank (a drowned's hit) is handed back like any leg's, on the bank or not.
			const ended = await settle(out);
			if (ended !== null) return ended;
			if (observation?.player?.underWater !== true) return null;
		}
		if (full && retracesUp < MAX_RETRACES) {
			const sky = skyAbove(bodyAt(observation), FLOODED_REACH);
			if (sky !== null) {
				retracesUp += 1;
				const up = await leg('out of the water the way it came', 'travel_to', { x: sky.x, y: sky.y, z: sky.z, retrace: true, tolerance: 3,
					...(profile.kind === 'block' ? { stopWhenSeen: profile.stopId } : {}) });
				const ended = await settle(up);
				if (ended !== null) return ended;
				if (up.result?.state !== 'SUCCEEDED') { const swum = await swimUpStair(sky, up); if (swum !== null) return swum; }
				if (observation?.player?.underWater !== true) return null;
			}
		}
		const air = observation.player.air, maxAir = observation.player.maxAir;
		return handBack('FAILED', 'FIND_DANGER', `Under water with no way up to air here${Number.isFinite(air) ? ` (air ${air}/${Number.isFinite(maxAir) ? maxAir : 300})` : ''}: swim or dig out before anything else`);
	};

	// Lava heard right behind a block the dig will not break: as a player, step back two cells, break it from there
	// and look. The opened lava is the sighting; the body then steps back two more cells, out of its flow.
	let peeks = 0;
	const peek = async (cell) => {
		const at = bodyAt(observation);
		const feet = { x: Math.floor(at.x), y: Math.floor(at.y + 1e-3), z: Math.floor(at.z) };
		const ax = cell.x - feet.x, az = cell.z - feet.z;
		const dir = Math.abs(ax) >= Math.abs(az) ? { x: Math.sign(ax) || 1, z: 0 } : { x: 0, z: Math.sign(az) || 1 };
		peeks += 1;
		const back = await leg('step back to open the lava', 'move_to', { x: feet.x - 2 * dir.x + 0.5, y: feet.y, z: feet.z - 2 * dir.z + 0.5, tolerance: 0.5 });
		if (back.seen || back.interrupted) return settle(back);
		// Opening lava where the body could not step back would let it flow onto the body: leave the block shut.
		if (back.result?.state !== 'SUCCEEDED') return null;
		await leg('look at the block', 'look_at', { x: cell.x + 0.5, y: cell.y + 0.5, z: cell.z + 0.5 });
		const opened = await leg('open the lava', 'break_block', { x: cell.x, y: cell.y, z: cell.z, acceptLavaRisk: true });
		if (opened.interrupted) return settle(opened);
		if (!opened.seen) return null;
		const away = bodyAt(observation);
		await leg('step out of its flow', 'move_to', { x: Math.floor(away.x) - 2 * dir.x + 0.5, y: Math.floor(away.y + 1e-3), z: Math.floor(away.z) - 2 * dir.z + 0.5, tolerance: 0.5 });
		return arrive(opened.seen);
	};

	// Water heard but not seen (behind the look's four headings, above or below the eye): a look toward it, as a player
	// turns to the sound. Returns the search's ending when that look ends it, else null.
	const listen = async () => {
		if (!profile.ids.has('minecraft:water') || !Number.isFinite(observation?.player?.yaw)) return null;
		const heard = (observation?.player?.heard ?? []).filter((row) => HEARD_WATER.test(String(row?.sound ?? '')) && SOUND_YAW[row.direction] !== undefined && Number.isFinite(row.distance))
			.sort((a, b) => a.distance - b.distance)[0];
		if (heard === undefined) return null;
		const at = bodyAt(observation);
		const yaw = (observation.player.yaw + SOUND_YAW[heard.direction]) * Math.PI / 180;
		const dy = heard.elevation === 'above' ? 3 : heard.elevation === 'below' ? -4 : 0;
		const reach = Math.max(2, Math.min(heard.distance, 8));
		progress(`water heard ${heard.direction} ${heard.elevation}, ${heard.distance} blocks: look toward it`);
		const looked = await leg('look toward the water heard', 'look_at', { x: at.x - Math.sin(yaw) * reach, y: at.y + 1.62 + dy, z: at.z + Math.cos(yaw) * reach });
		if (looked.seen || looked.interrupted) return settle(looked);
		return null;
	};
	// Remembered water near the body (seen earlier, out of sight now), nearest first: walked to, never dug to (a dig
	// into water floods the body's own tunnel). Returns the search's ending when a trip ends it, else null.
	let waterTrips = 0;
	const rememberedWater = async () => {
		if (!profile.ids.has('minecraft:water')) return null;
		while (waterTrips < MAX_WATER_TRIPS && left() >= MIN_LEG_MS) {
			const at = bodyAt(observation);
			// Sources only: a trip to flowing water (the aquifer spilling down the body's own stair) cannot end in a sighting.
			const rows = (body.known?.(observation, /(^|:)water$/)?.blocks ?? []).filter((row) => [row.x, row.y, row.z].every(Number.isFinite) && !wasMissed(row)
				&& !/"level":"[1-9]/.test(row.blockState ?? ''))
				.map((row) => ({ ...row, distance: Math.hypot(row.x + 0.5 - at.x, row.y + 0.5 - at.y, row.z + 0.5 - at.z) })).filter((row) => row.distance <= WATER_NEAR && insideBoundary({ x: row.x + 0.5, z: row.z + 0.5 }))
				.sort((a, b) => a.distance - b.distance);
			const place = rows[0];
			if (place === undefined) return null;
			waterTrips += 1;
			const trip = await leg(`to the water remembered at ${place.x},${place.y},${place.z}`, 'travel_to', { x: place.x + 0.5, y: place.y + 1, z: place.z + 0.5, tolerance: 3, build: false, stopWhenSeen: profile.stopId });
			const ended = await settle(trip);
			if (ended !== null) return ended;
			// Not in sight from where the trip ended: gone, walled off, or out of reach. Its neighbours go with it.
			miss(place, trip.result?.reasonCode === 'ARRIVED' ? 'not seen there' : trip.result?.reasonCode ?? 'no move');
			for (const row of rows.filter((other) => Math.hypot(other.x - place.x, other.y - place.y, other.z - place.z) <= SAME_PLACE * 2)) missed.push({ x: row.x, y: row.y, z: row.z, why: 'with the water missed' });
		}
		return null;
	};
	const canopy = () => {
		const at = bodyAt(observation);
		return at !== null && (observation?.blocks ?? []).some((row) => /_leaves$/.test(String(row?.blockId)) && row.x === Math.floor(at.x) && row.z === Math.floor(at.z) && row.y > at.y);
	};
	const outside = () => {
		if (observation?.player?.skyOpen !== false) return true;
		const sky = body.openSky?.() ?? null, at = bodyAt(observation);
		return sky !== null && at !== null && at.y >= sky.y - 2 && Math.hypot(sky.x - at.x, sky.z - at.z) <= 6;
	};
	// A mob search (no block id to stop at) also climbs out; its legs carry no stopWhenSeen and the watch sees for them.
	const stopWhen = profile.stopId === undefined ? {} : { stopWhenSeen: profile.stopId };
	const climbOut = async () => {
		let retraces = MAX_RETRACE_TRIES, detour = false, stalls = 0, rosePastStop = false;
		for (let climbs = 0; climbs < MAX_CLIMBS && stalls < 2 && left() >= MIN_LEG_MS && !outside(); climbs += 1) {
			const at = bodyAt(observation);
			const sky = retraces > 0 && !detour ? body.openSky?.() ?? null : null;
			const back = sky !== null && [sky.x, sky.y, sky.z].every(Number.isFinite) && sky.y > at.y + 1 && insideBoundary(sky);
			const rise = Math.min(detour ? DETOUR_RISE : CLIMB_LEG, Math.floor(withinReach()) - 2);
			if (!back && rise < 1) return handBack('FAILED', 'FIND_NOT_FOUND', `Searched to ${within} blocks from the start`);
			const outcome = back
				? await leg('back up the way it came', 'travel_to', { x: sky.x, y: sky.y, z: sky.z, retrace: true, tolerance: 3, ...stopWhen })
				: await leg(detour ? 'stairs up past where the way back stopped' : 'stairs up to the surface', 'dig_to', { pattern: 'stairs_up', y: Math.floor(at.y) + rise,
					maxBlocks: 80, throughCaves: 'small', ...stopWhen, discard: DISCARD });
			const ended = await settle(outcome);
			if (ended !== null) return ended;
			const after = bodyAt(observation);
			const rose = after !== null && after.y > at.y + 1;
			// Water the way up passes near, seen on the way down: a walk to it, not the rest of the climb.
			if (!outside()) { const near = await rememberedWater(); if (near !== null) return near; }
			const mob = outcome.result?.reasonCode === 'HOSTILE_NEAR';
			if (back && !mob && !outside()) {
				// A successful detour followed by a failed replay that lost its height did not rejoin above the
				// obstruction. Keep climbing from here rather than spend another detour replaying that ascent.
				retraces = rosePastStop && outcome.result?.state === 'FAILED' && after !== null && after.y < at.y ? 0 : retraces - 1;
				detour = retraces > 0;
			}
			rosePastStop = !back && detour && outcome.result?.state === 'SUCCEEDED' && rose;
			if (!back) detour = false;
			stalls = rose ? 0 : mob ? stalls : stalls + 1;
		}
		return null;
	};

	// Movement can take a surface water search back into its own mine. Recheck fresh footing before another
	// surface heading; climbOut returning null alone does not prove that its guarded ascent reached the surface.
	const waterToSurface = async ({ initial = false } = {}) => {
		if (!profile.surface || !profile.ids.has('minecraft:water') || (initial ? observation?.player?.skyOpen !== false : outside())) return null;
		const near = await listen() ?? await rememberedWater();
		if (near !== null) return near;
		const up = await climbOut();
		if (up !== null) return up;
		if (!outside()) return left() < MIN_LEG_MS
			? handBack('TIMED_OUT', 'FIND_BUDGET', 'The search time ran out during the ascent')
			: handBack('FAILED', 'FIND_BLOCKED', 'Still underground after trying the way back and stairs: no way to the surface found here');
		return null;
	};

	let seen = check();
	if (seen !== null) return arrive(seen);
	// A block that never generates in this dimension (an oak log in the Nether): no search here turns one up. One
	// program made 140 NO_ROUTE legs looking for oak logs in the Nether. A block the game data does not place is unknown.
	{
		const here = bare(String(observation?.world?.dimension ?? ''));
		const named = (name) => (name.startsWith('the_') ? name : `the_${name}`).replace(/_/g, ' ');
		const rows = profile.kind === 'block' && ['overworld', 'the_nether', 'the_end'].includes(here)
			? [...profile.ids].map((one) => { const row = howtoIndex().worldgen[bare(one)]; return row && { d: [...row.d, ...(ALSO_PLACED[bare(one)] ?? [])] }; }) : [];
		if (rows.length > 0 && rows.every((row) => Array.isArray(row?.d)) && !rows.some((row) => row.d.includes(here))) {
			const where = [...new Set(rows.flatMap((row) => row.d))].map(named).join(' or ');
			return handBack('FAILED', 'FIND_NOT_FOUND', `${profile.label} does not generate in ${named(here)} (only in ${where}), so no search here turns one up`);
		}
	}
	{
		const first = await look(profile.surface ? 0 : 15);
		if (first.interrupted || first.seen || first.ended) return settle(first);
	}

	// 2. Known places: walk to the nearest remembered one in range and look there. A place an earlier search went to and
	// did not see it at, or could not reach, is not tried again (body.missedPlaces, kept by the runtime across calls);
	// underground, a place further than a short dig is left to the search at depth.
	const missed = (body.missedPlaces?.() ?? []).filter((place) => (place.why !== UNREACHED_SPOT || profile.ids.has('minecraft:water')) && forTarget(place));
	// Remembered places the caller priced out (obtain: a remembered ore dearer to reach than a fresh search) are no trip.
	for (const cell of Array.isArray(target?.skip) ? target.skip : []) if ([cell?.x, cell?.y, cell?.z].every(Number.isFinite)) missed.push({ x: cell.x, y: cell.y, z: cell.z, why: 'priced out' });
	const wasMissed = (row) => missed.some((place) => Math.hypot(place.x - row.x, place.y - row.y, place.z - row.z) <= SAME_PLACE);
	const miss = (place, why) => { missed.push({ ...place, why }); body.missPlace?.({ x: place.x, y: place.y, z: place.z }, why); };
	const underground = !profile.surface && observation?.player?.skyOpen === false;
	const known = rememberedPlaces(profile, body.known(observation), await body.places(profile).catch(() => []), origin)
		.filter((row) => row.distance <= within && !wasMissed(row) && !(underground && Math.hypot(row.x + 0.5 - origin.x, row.y - origin.y, row.z + 0.5 - origin.z) > UNDERGROUND_TRIP));
	for (const place of known.slice(0, MAX_MEMORY_TRIPS)) {
		if (left() < MIN_LEG_MS) break;
		if (netherBiome()) {
			// One failed leg in the deltas does not lose the forest: only a whole approach that gets nowhere marks it missed.
			const reached = await approach(place, `the ${profile.label} remembered at ${place.x},${place.y},${place.z}`);
			if (reached?.stuck === undefined) return reached;
			progress(`remembered ${profile.label}: ${reached.stuck}`);
			miss(place, 'approach stuck');
			continue;
		}
		const trip = await leg(`to ${place.via}`, 'travel_to', { x: place.x + 0.5, y: place.y, z: place.z + 0.5, tolerance: 4,
			...(profile.kind === 'block' ? { stopWhenSeen: profile.stopId } : {}) });
		const code = trip.result?.reasonCode;
		// Stopped short (water, no route, a flooded tunnel): the way there is shut. A hostile or a worn tool says nothing
		// about the place.
		if (!trip.seen && !trip.interrupted && code !== 'ARRIVED' && code !== 'HOSTILE_NEAR' && !BLOCKED.has(code) && !FIGHT_STOPS.has(code)) miss(place, code ?? trip.result?.state);
		const ended = await settle(trip);
		if (ended !== null) return ended;
		const there = await look(10);
		if (there.interrupted || there.seen || there.ended) return settle(there);
		// There and looked round, and not in sight: mined, or never there.
		if (code === 'ARRIVED') miss(place, 'not seen there');
	}

	{
		const up = await waterToSurface({ initial: true });
		if (up !== null) return up;
	}
	// Trees and animals are seen from the surface (obtain climbs out for the same ones first): from under cover, back up
	// the way the body came or stairs up before the surface legs. Searching sideways underground finds neither. Leaves
	// overhead are no cover to climb through.
	if (profile.surface && (profile.trees || profile.kind === 'mob') && observation?.world?.dimension === 'minecraft:overworld' && !outside() && !canopy()) {
		const up = await climbOut();
		if (up !== null) return up;
		if (!outside()) return left() < MIN_LEG_MS
			? handBack('TIMED_OUT', 'FIND_BUDGET', 'The search time ran out during the ascent')
			: handBack('FAILED', 'FIND_BLOCKED', 'Still under cover after trying the way back and stairs: no way to the surface found here');
	}

	// A block that shows in the rock, sought from under cover: the tunnel legs at the body's own level come first (IN_ROCK).
	const rock = profile.surface && IN_ROCK.has(profile.stopId) && !outside();
	if (!profile.surface || rock) {
		// 3a. Underground: dig to the target's depth (stopping at the first sight), then tunnel straight legs at that depth.
		// A rock search has no depth to dig to: it tunnels where it stands, and caves near that level are its band.
		const bandY = profile.depth ?? Math.floor(origin.y);
		let rockLegs = 0;
		const water = (observation?.inventory?.items ?? []).some((item) => item?.itemId === 'minecraft:water_bucket');
		let heading = nearestCardinal(chooseHeading(body.frontier(observation)?.coverage?.headings));
		let descentStops = 0, lookedAt = rock ? bodyAt(observation) : null;
		// Turns after a stop: from the last heading that went its full leg, right, then left, then back; never to and fro.
		let base = null, turns = 0;
		const turn = () => { base ??= heading; turns += 1; heading = CARDINALS[(CARDINALS.indexOf(base) + [1, 3, 2][(turns - 1) % 3]) % 4]; };
		const stuck = new Set();
		// Lava lies at the lava level and below; an ore within a short climb of its depth.
		const inBand = (y) => profile.ids.has('minecraft:lava') ? y <= profile.depth + 20 : Math.abs(y - bandY) <= CAVE_BAND;
		let previous = null, idle = 0, relocations = 0, idleWhy = null, counted = 0;
		let level = false, wetTunnels = 0;
		const wetSpots = () => missed.filter((place) => place.why === WET_SPOT);
		// Off a wet spot: away from the water the dig named, else from the remembered wet spot, never a heading already
		// taken off the water.
		const offWater = (from, water) => {
			const yaw = water === null ? chooseHeading(body.frontier(observation)?.coverage?.headings) : Math.atan2(-(from.x - water.x - 0.5), from.z - water.z - 0.5) * 180 / Math.PI;
			const best = nearestCardinal(yaw);
			const open = [best, CARDINALS[(CARDINALS.indexOf(best) + 1) % 4], CARDINALS[(CARDINALS.indexOf(best) + 3) % 4]]
				.filter((option) => !wetHeadings.has(option.name) && stepsLeft(option) >= WET_WALK / 2);
			const sea = ground !== null && Math.hypot(ground.at.x - from.x, ground.at.z - from.z) <= 4 ? seaHeadings(ground.views) : new Set();
			const order = open.some((option) => !sea.has(headingName(option.yaw))) ? open.filter((option) => !sea.has(headingName(option.yaw))) : open;
			const spots = wetSpots().filter((spot) => Math.hypot(spot.x + 0.5 - from.x, spot.z + 0.5 - from.z) > WET_SAME && (water === null || Math.hypot(spot.x - water.x, spot.z - water.z) > WET_SAME));
			if (order.length < 2 || spots.length === 0) return order[0] ?? null;
			const distance = wetWalk(wetTunnels);
			const clearance = (option) => Math.min(...spots.map((spot) => Math.hypot(from.x - Math.sin(option.yaw * Math.PI / 180) * distance - spot.x,
				from.z + Math.cos(option.yaw * Math.PI / 180) * distance - spot.z)));
			return order.slice().sort((left, right) => clearance(right) - clearance(left))[0];
		};
		// Farther off at each wet spot: one aquifer can span more than one walk.
		const wetWalk = (before) => WET_WALK + WET_WALK_MORE * before;
		// Left or right of a way off the water that went nowhere: the side with fewer water cells in sight ahead of it (the
		// sample's own block rows and the water the dig named), then the one with more room inside within; null when
		// neither side has room for the tunnel.
		const dryerSide = (from, away, water) => {
			const i = CARDINALS.indexOf(away);
			const cells = (observation?.blocks ?? []).filter((row) => row?.blockId === 'minecraft:water').map(cellOf).filter((cell) => cell !== null);
			if (water != null) cells.push(water);
			const wetAhead = (option) => {
				const ux = -Math.sin(option.yaw * Math.PI / 180), uz = Math.cos(option.yaw * Math.PI / 180);
				return cells.filter((cell) => Math.abs(cell.y + 0.5 - from.y) <= 4 && Math.hypot(cell.x + 0.5 - from.x, cell.z + 0.5 - from.z) <= WET_SIDE_SIGHT
					&& (cell.x + 0.5 - from.x) * ux + (cell.z + 0.5 - from.z) * uz > 0.5).length;
			};
			return [CARDINALS[(i + 1) % 4], CARDINALS[(i + 3) % 4]].filter((option) => stepsLeft(option) >= WET_SIDE_MIN)
				.sort((a, b) => wetAhead(a) - wetAhead(b) || stepsLeft(b) - stepsLeft(a))[0] ?? null;
		};
		// Out of its own wet hole the way it came; still in the water when that way is shut, the escape job (escapeWater).
		const climbOut = async (top, away, label) => {
			const up = await leg(label, 'travel_to', { x: top.x, y: top.y, z: top.z, retrace: true, tolerance: 3, stopWhenSeen: profile.stopId });
			if (!up.seen && !up.interrupted && SHUT_WAY.has(up.result?.reasonCode) && inWater()) {
				const ended = await escapeWater();
				if (ended !== null) return ended;
			}
			const at = bodyAt(observation);
			if (up.seen || up.interrupted || !SHUT_WAY.has(up.result?.reasonCode) || observation?.player?.underWater === true || at === null || at.y >= top.y - 3) return settle(up);
			const rise = Math.ceil(top.y - at.y);
			const stair = await leg(`stairs up ${away.name} out of the flooded way`, 'dig_to', { pattern: 'stairs_up', y: Math.floor(top.y), heading: away.name,
				maxBlocks: Math.min(MAX_DIG_BLOCKS, STEP_CELLS.stairs_up * (rise + 4)), stopWhenSeen: profile.stopId, discard: DISCARD });
			return settle(stair);
		};
		const wetHeadings = new Set();
		let wetStuck = false;
		// Where each dig stopped and why: the same stop again on the same spot moves the body off it.
		const stopsAt = new Set();
		// Every dig stays inside within: its blocks are capped at the steps the heading has left before the radius
		// (ServerDigController.stepCells: tunnel 2 cells a step, stairs 3, steep 4; a shaft moves none), and at the edge
		// the heading turns toward the start.
		const stepsLeft = (direction) => {
			const at = bodyAt(observation);
			const ux = -Math.sin(direction.yaw * Math.PI / 180), uz = Math.cos(direction.yaw * Math.PI / 180);
			const px = at.x - origin.x, pz = at.z - origin.z;
			const b = ux * px + uz * pz, c = px * px + pz * pz - within * within;
			return b * b - c < 0 ? 0 : Math.max(0, Math.floor(-b + Math.sqrt(b * b - c)));
		};
		// At the edge: right or left along it when there is room (new ground), else back toward the start.
		const inward = () => {
			if (stepsLeft(heading) >= 1) return;
			const i = CARDINALS.indexOf(heading);
			const side = [CARDINALS[(i + 1) % 4], CARDINALS[(i + 3) % 4]].filter((option) => stepsLeft(option) >= 2).sort((a, b) => stepsLeft(b) - stepsLeft(a))[0];
			const before = heading;
			heading = side ?? nearestCardinal(Math.atan2(-(origin.x - bodyAt(observation).x), origin.z - bodyAt(observation).z) * 180 / Math.PI);
			// Back the way it came, twice: the line through the radius is dug; nothing new is left on it.
			reversals = side === undefined && CARDINALS.indexOf(heading) === (CARDINALS.indexOf(before) + 2) % 4 ? reversals + 1 : 0;
			base = heading; turns = 0;
		};
		let reversals = 0;
		const exhausted = () => reversals >= 2 || stepsLeft(heading) < 1;
		const cap = (pattern) => pattern === 'shaft' ? {} : { maxBlocks: Math.min(MAX_DIG_BLOCKS, STEP_CELLS[pattern] * stepsLeft(heading)) };
		const tunnelBlocks = () => cap('tunnel').maxBlocks;
		const descentCap = (pattern) => cap(pattern);
		// Ores only: lava keeps its own band and rock searches have no depth. Off for the A/B arm.
		let walkedUp = false;
		let cavePicked = !caveFirst() || profile.ids.has('minecraft:lava') || rock;
		// Caves a cave-first walk may go to: seen in this search or remembered, unvisited, within reach and inside within, at
		// or below the body and not far under the band, not where the body stands, and with no hostile seen near it.
		const waterCells = () => [observation, observation?.sighted, lastSurvey].flatMap((source) => ['blocks', 'veins'].flatMap((section) => Array.isArray(source?.[section]) ? source[section] : []))
			.filter((row) => row?.blockId === 'minecraft:water').map(cellOf).filter((cell) => cell !== null);
		const caveChoices = (here) => {
			const wet = waterCells();
			const hostiles = [...(observation?.entities ?? []).filter((row) => row?.hostile === true && row.alive !== false), ...sweepHostiles].filter((row) => [row?.x, row?.y, row?.z].every(Number.isFinite));
			const caveMisses = (body.missedPlaces?.() ?? []).filter((place) => place.blockId === CAVE_MISS);
			return [...caves.values()].filter((row) => !row.visited && row.y <= here.y + 2 && row.y >= profile.depth - CAVE_BAND
				&& Math.hypot(row.x + 0.5 - here.x, row.z + 0.5 - here.z) <= CAVE_REACH && Math.hypot(row.x + 0.5 - origin.x, row.z + 0.5 - origin.z) <= within
				&& Math.hypot(row.x + 0.5 - here.x, row.y - here.y, row.z + 0.5 - here.z) >= CAVE_NEAR
				&& !caveMisses.some((place) => Math.hypot(place.x - row.x, place.y - row.y, place.z - row.z) <= SAME_PLACE)
				&& !hostiles.some((mob) => Math.hypot(mob.x - row.x - 0.5, mob.y - row.y, mob.z - row.z - 0.5) <= CAVE_MOB_CLEAR)
				&& !wet.some((cell) => Math.hypot(cell.x - row.x, cell.y - row.y, cell.z - row.z) <= CAVE_WATER_NEAR))
				.sort((a, b) => Math.hypot(a.x - here.x, a.y - here.y, a.z - here.z) - Math.hypot(b.x - here.x, b.y - here.y, b.z - here.z));
		};
		// Up to CAVE_WALKS walks with build off: a cave with no walking way in costs a few seconds and no pickaxe use. Null
		// to dig on from wherever the walks left the body (in a cave, lower down), else the search's end.
		const caveWalks = async (from) => {
			for (const row of body.known?.(observation)?.sightings ?? []) {
				if (row?.kind !== 'cave' || ![row.x, row.y, row.z].every(Number.isFinite)) continue;
				const key = `${row.x},${row.y},${row.z}`;
				if (!caves.has(key)) caves.set(key, { x: row.x, y: row.y, z: row.z, air: row.air, visited: false });
			}
			let tried = 0, entered = 0, flooded = 0;
			for (; tried < CAVE_WALKS && left() >= MIN_LEG_MS; tried += 1) {
				const here = bodyAt(observation);
				if (left() < CAVE_WALK_MS + CAVE_DIG_RESERVE_MS) break;
				const near = [...(observation?.entities ?? []).filter((row) => row?.hostile === true && row.alive !== false), ...(threatRows(observation) ?? []), ...sweepHostiles]
					.some((row) => (Number.isFinite(row.distance) ? row.distance : Math.hypot(row.x - here.x, row.y - here.y, row.z - here.z)) <= CAVE_MOB_SENSE);
				if (near) break;
				const cave = caveChoices(here)[0];
				if (cave === undefined) break;
				caveVisits += 1;
				for (const row of caves.values()) if (Math.hypot(row.x - cave.x, row.y - cave.y, row.z - cave.z) <= CAVE_NEAR) row.visited = true;
				const walk = await leg('walk into a cave', 'travel_to', { x: cave.x + 0.5, y: cave.y, z: cave.z + 0.5, tolerance: 3, build: false, stopWhenSeen: profile.stopId, timeoutMs: CAVE_WALK_MS });
				const code = walk.result?.reasonCode, arrived = code === 'ARRIVED';
				// Water on the way in or underfoot: a flooded cave. Back to the dry spot the walks began from and dig there.
				if (!walk.seen && !walk.interrupted && !walk.ended && (WET_WALK_STOPS.has(code) || inWater())) {
					flooded += 1; tried += 1;
					body.missPlace?.({ x: cave.x, y: cave.y, z: cave.z, blockId: CAVE_MISS }, 'flooded cave');
					if (observation?.player?.underWater === true) { const drowning = await surface(); if (drowning !== null) return drowning; }
					const back = await leg('back out of the flooded cave', 'travel_to', { x: from.x, y: from.y, z: from.z, tolerance: 2, build: false, stopWhenSeen: profile.stopId });
					// Every return walk is settled: one that stopped for damage or danger carries only its result.
					const out = await settle(back);
					if (out !== null) return out;
					break;
				}
				const walked = await settle(walk);
				if (walked !== null) { caveNote = `; walked into ${entered + (arrived ? 1 : 0)} of ${tried + 1} cave(s) before digging`; return walked; }
				// A mob met on the way: no more wandering into caves near it; the dig goes on from here.
				if (code === 'HOSTILE_NEAR' || HIT_STOPS.has(code) || FIGHT_STOPS.has(code)) { tried += 1; break; }
				if (!arrived) { if (!BLOCKED.has(code)) body.missPlace?.({ x: cave.x, y: cave.y, z: cave.z, blockId: CAVE_MISS }, 'no walking way into the cave'); continue; }
				entered += 1;
				const inside = await look(20);
				lookedAt = bodyAt(observation);
				if (inside.interrupted || inside.seen || inside.ended) { caveNote = `; walked into ${entered} of ${tried + 1} cave(s) before digging`; return settle(inside); }
			}
			// No cave entered: back to where the walks began before digging. A walk that gave up still moved the body, and
			// room test 21 Nov (one seed, 10 of 10): it stopped at a pond's edge, so the dig down met the water and the wet
			// spot moves wore the pickaxe out, where the same dig from the start saw iron in about a minute.
			const stopped = bodyAt(observation);
			if (tried > 0 && entered === 0 && flooded === 0 && stopped !== null && Math.hypot(stopped.x - from.x, stopped.y - from.y, stopped.z - from.z) > 2) {
				const back = await leg('back to where the cave walks began', 'travel_to', { x: from.x, y: from.y, z: from.z, tolerance: 1.5, build: false, stopWhenSeen: profile.stopId, timeoutMs: CAVE_WALK_MS });
				const out = await settle(back);
				if (out !== null) return out;
			}
			if (tried > 0) {
				const now = bodyAt(observation);
				caveNote = `; walked into ${entered} of ${tried} cave(s) first${flooded > 0 ? ` (${flooded} flooded, walked back out)` : ''}${entered > 0 && now !== null && now.y < from.y - 2 ? `, down to y${Math.floor(now.y)}` : ''}, then dug`;
			}
			return null;
		};
		while (left() >= MIN_LEG_MS) {
			const at = bodyAt(observation);
			// Digs that go nowhere (the body under water, every way here wet or refused): move off this spot rather than
			// try the same few headings again.
			// Only digs count: walling off or a fight in place is not a dig going nowhere.
			const lastLeg = legs.at(-1), lastHow = lastLeg?.how ?? '';
			// The start, near a spot where an earlier search's dig down met water: off it first, not down into it again.
			const nearWet = legs.length === 0 && profile.depth !== null && at.y > profile.depth + CAVE_BAND
				? wetSpots().find((place) => Math.hypot(place.x + 0.5 - at.x, place.z + 0.5 - at.z) <= 12) : undefined;
			const wetDig = counted < legs.length && DESCENTS.test(lastHow) && lastLeg?.reasonCode === 'WATER_AHEAD';
			const wet = lastLeg?.underWater === true || observation?.player?.underWater === true;
			if (wetDig) miss({ x: Math.floor(at.x), y: Math.floor(at.y + 1e-3), z: Math.floor(at.z) }, WET_SPOT);
			if (wetDig && !wet && profile.depth !== null && Math.abs(at.y - profile.depth) <= CAVE_BAND) { level = true; counted = legs.length; previous = at; continue; }
			if ((wetDig || nearWet !== undefined) && wetTunnels < MAX_WET_TUNNELS) {
				// On open ground, a look round first unless the last one was from here: the walk off goes where it shows land.
				if (observation?.player?.skyOpen === true && observation?.player?.underWater !== true && (ground === null || Math.hypot(ground.at.x - at.x, ground.at.z - at.z) > 4)) {
					const view = await look(0);
					if (view.interrupted || view.seen || view.ended) return settle(view);
				}
				const away = offWater(at, wetDig ? lastLeg.waterAt : nearWet);
				if (away !== null && observation?.player?.underWater === true) {
					const drowning = await surface();
					if (drowning !== null) return drowning;
				}
				if (away !== null) {
					wetTunnels += 1;
					wetHeadings.add(away.name);
					heading = away; base = heading; turns = 0;
					const here = bodyAt(observation);
					const top = skyAbove(here, SKY_REACH) ?? origin;
					if (here.y < top.y - 3 || (top !== origin && observation?.player?.skyOpen === false)) {
						const upEnded = await climbOut(top, away, top === origin ? 'back up out of the wet hole' : 'back up to the surface it came down from');
						if (upEnded !== null) return upEnded;
					}
					const off = await leg(`walk ${away.name} off the water`, 'travel_to', { yaw: away.yaw, distance: Math.min(wetWalk(wetTunnels - 1), stepsLeft(away)), stopWhenSeen: profile.stopId });
					const ended = await settle(off);
					if (ended !== null) return ended;
					counted = legs.length;
					previous = bodyAt(observation);
					if (Math.hypot(previous.x - at.x, previous.z - at.z) < 2) {
						const side = dryerSide(previous, away, wetDig ? lastLeg.waterAt : nearWet);
						if (side !== null) {
							wetHeadings.add(side.name);
							heading = side; base = heading; turns = 0;
							const out = await leg(`tunnel ${side.name} off the wet spot`, 'dig_to', { pattern: 'tunnel', heading: side.name,
								maxBlocks: STEP_CELLS.tunnel * Math.min(WET_SIDE_TUNNEL, stepsLeft(side)), stopWhenSeen: profile.stopId, discard: DISCARD });
							const sided = await settle(out);
							if (sided !== null) return sided;
							counted = legs.length;
							const from = previous;
							previous = bodyAt(observation);
							// Dry rock reached: new ground, so the tunnel is not a dig that went nowhere.
							if (Math.hypot(previous.x - from.x, previous.z - from.z) >= 2) { previous = null; continue; }
							// The tunnel went nowhere too: the move off below turns from the way away from the water, as before.
							heading = away; base = heading; turns = 0;
						}
						// A way off that went nowhere: the body moves off this spot as before (no more digs here).
						wetTunnels = MAX_WET_TUNNELS; wetStuck = true;
					}
					continue;
				}
			}
			idle = previous !== null && /^(dig|tunnel)/.test(lastHow) && Math.hypot(at.x - previous.x, at.y - previous.y, at.z - previous.z) < 1 ? idle + 1 : 0;
			idleWhy = idle > 0 ? `${idle} digs in a row went nowhere` : null;
			// A dig refused because the body is under water: this spot is wet whatever the heading. Move off at once
			// (after surfacing) rather than spend breath on more digs here.
			if (legs.findLast((entry) => /^(dig|tunnel)/.test(entry.how))?.underWater === true && /^(dig|tunnel)/.test(lastHow)) { idle = MAX_IDLE_DIGS; idleWhy = 'the body is under water here'; }
			// Water stopping a dig down is in the ground under this spot (an aquifer, a lake bed): every heading down from
			// here meets it. 4-seed check B-1 and B-2: four digs down from one spot, one per heading, each stopped by it.
			if ((counted < legs.length && DESCENTS.test(lastHow) && lastLeg?.reasonCode === 'WATER_AHEAD') || wetStuck) { idle = MAX_IDLE_DIGS; idleWhy = 'water under this spot stops every dig down'; wetStuck = false; }
			if (counted < legs.length && /^(dig|tunnel)/.test(lastHow) && lastLeg?.state !== 'SUCCEEDED' && typeof lastLeg?.reasonCode === 'string') {
				const stop = `${Math.floor(at.x)},${Math.floor(at.y + 1e-3)},${Math.floor(at.z)}:${lastLeg.reasonCode}`;
				if (stopsAt.has(stop)) { idle = MAX_IDLE_DIGS; idleWhy ??= `the same stop again on this spot`; }
				stopsAt.add(stop);
			}
			counted = legs.length;
			previous = at;
			if (idle >= MAX_IDLE_DIGS) {
				const last = legs.at(-1);
				if (relocations >= MAX_RELOCATIONS) return handBack('FAILED', 'FIND_BLOCKED', `No way on from here: ${idleWhy ?? `${idle} digs in a row went nowhere`} (last: ${last?.reasonCode ?? last?.state})`);
				relocations += 1;
				idle = 0;
				heading = CARDINALS[(CARDINALS.indexOf(heading) + 1) % 4];
				base = heading; turns = 0;
				if (observation?.player?.underWater === true) {
					const drowning = await surface();
					if (drowning !== null) return drowning;
				}
				inward();
				if (stepsLeft(heading) < 4) return handBack('FAILED', 'FIND_NOT_FOUND', `Searched to ${within} blocks from the start`);
				const from = bodyAt(observation);
				// In water (its own flooded tunnels), a walk off swims in place: out the way it came instead.
				const wetSky = observation?.player?.inWater === true || observation?.player?.underWater === true ? skyAbove(from, FLOODED_REACH) : null;
				const out = wetSky !== null ? await leg('out of the water the way it came', 'travel_to', { x: wetSky.x, y: wetSky.y, z: wetSky.z, retrace: true, tolerance: 3, stopWhenSeen: profile.stopId })
					: await leg('off this spot', 'travel_to', { yaw: heading.yaw, distance: Math.min(RELOCATE, stepsLeft(heading)), stopWhenSeen: profile.stopId });
				let ended = await settle(out);
				if (ended !== null) return ended;
				if (wetSky !== null && out.result?.state !== 'SUCCEEDED') { ended = await swimUpStair(wetSky, out); if (ended !== null) return ended; }
				ended = await escapeWater();
				if (ended !== null) return ended;
				previous = bodyAt(observation);
				// A move off that left the body where it was: digging here again meets the same stop. Live, B-1's aquifer cell:
				// two such moves (BUILD_FAILED in the water) each followed by two more wet digs down, 108 s in all.
				// A dry step is off the wet spot even when the hop moved less than two blocks.
				if (Math.hypot(previous.x - from.x, previous.y - from.y, previous.z - from.z) < 2 && (wetSky === null || inWater())) {
					return handBack('FAILED', 'FIND_BLOCKED', `No way on from here: ${idleWhy ?? 'digs here went nowhere'}, and the move off this spot stopped too (${out.result?.reasonCode ?? out.result?.state})`);
				}
				continue;
			}
			// Eyes into air before any dig (after the dead-spot check above, which a swim leg must not hide).
			if (observation?.player?.underWater === true) {
				const drowning = await surface();
				if (drowning !== null) return drowning;
			}
			if (awayFrom !== null) {
				heading = awayFrom; awayFrom = null; base = heading; turns = 0;
				// Out of the cave's footprint first: a level tunnel away from it, then the descent goes on from there.
				inward();
				if (stepsLeft(heading) < 1) return handBack('FAILED', 'FIND_NOT_FOUND', `Searched to ${within} blocks from the start`);
				const clear = await leg(`tunnel ${heading.name} away from the cave`, 'dig_to', { pattern: 'tunnel', heading: heading.name, maxBlocks: Math.min(CLEAR_CAVE, tunnelBlocks()), stopWhenSeen: profile.stopId, discard: DISCARD });
				const ended = await settle(clear);
				if (ended !== null) return ended;
				previous = bodyAt(observation);
				continue;
			}
			// Below an ore's band (a start deep in a cave): stairs up to its depth.
			if (profile.depth !== null && !profile.ids.has('minecraft:lava') && at.y < profile.depth - CAVE_BAND && descentStops < MAX_DESCENT_STOPS) {
				// The way the body came down passes that depth: walk back up it, watching for the target, before cutting a
				// new staircase (playtest 22 Nov: 37 blocks of new stairs up for coal wore out two pickaxes, its own stair
				// and tunnel back up were open).
				const sky = walkedUp ? null : body.openSky?.() ?? null;
				if (sky !== null && [sky.x, sky.y, sky.z].every(Number.isFinite) && sky.y >= profile.depth && insideBoundary(sky)
					&& Math.hypot(sky.x - at.x, sky.z - at.z) <= WALK_BACK_UP) {
					walkedUp = true;
					// It stops once in the ore's band: past it the walk would leave the band and a new descent would follow.
					const back = await leg(`back up the way it came toward y${profile.depth}`, 'travel_to', { x: sky.x, y: sky.y, z: sky.z, retrace: true, tolerance: 3, stopWhenSeen: profile.stopId },
						null, { until: (sample) => { const p = bodyAt(sample); return p !== null && p.y >= profile.depth - CAVE_BAND; } });
					const ended = await settle(back);
					if (ended !== null) return ended;
					continue;
				}
				inward();
				if (stepsLeft(heading) < 1) return handBack('FAILED', 'FIND_NOT_FOUND', `Searched to ${within} blocks from the start`);
				const outcome = await leg(`climb stairs to y${profile.depth}`, 'dig_to', { pattern: 'stairs_up', y: profile.depth, heading: heading.name, ...descentCap('stairs_up'), stopWhenSeen: profile.stopId, discard: DISCARD });
				const ended = await settle(outcome);
				if (ended !== null) return ended;
				if (outcome.result?.reasonCode === 'DIG_GOAL_REACHED') reversals = 0;
				if (!['DIG_GOAL_REACHED', 'DIG_LIMIT_REACHED'].includes(outcome.result?.reasonCode)) { descentStops += 1; turn(); }
				continue;
			}
			// Below the lava's tunnel level (steep_down drops two a step and lands a block low, or a cave below): one stair up,
			// so the tunnel runs over the pools' tops rather than level with them, where their lava flows into the cut.
			if (profile.ids.has('minecraft:lava') && profile.depth !== null && Math.floor(at.y + 1e-3) < profile.depth && descentStops < MAX_DESCENT_STOPS) {
				inward();
				if (stepsLeft(heading) < 1) return handBack('FAILED', 'FIND_NOT_FOUND', `Searched to ${within} blocks from the start`);
				const outcome = await leg(`climb stairs to y${profile.depth}`, 'dig_to', { pattern: 'stairs_up', y: profile.depth, heading: heading.name, ...descentCap('stairs_up'), stopWhenSeen: profile.stopId, discard: DISCARD });
				const ended = await settle(outcome);
				if (ended !== null) return ended;
				if (!['DIG_GOAL_REACHED', 'DIG_LIMIT_REACHED'].includes(outcome.result?.reasonCode)) { descentStops += 1; turn(); }
				continue;
			}
			// Cave first, once, before the first dig of this search: never after a dig stopped for a mob or opened a cave.
			if (!cavePicked && profile.depth !== null && !level && at.y > profile.depth + 3) {
				cavePicked = true;
				if (!legs.some((entry) => entry.actionType === 'dig_to')) {
					const picked = await caveWalks(at);
					if (picked !== null) return picked;
					continue;
				}
			}
			if (profile.depth !== null && !level && at.y > profile.depth + 3 && descentStops < MAX_DESCENT_STOPS) {
				const wetGround = wetSpots().some((spot) => Math.hypot(spot.x + 0.5 - at.x, spot.z + 0.5 - at.z) <= WET_REGION);
				const pattern = water && descentStops === 0 && !wetGround ? 'shaft' : 'steep_down';
				// At the edge of within, the stairs turn back toward the start and go on down inside it.
				if (pattern !== 'shaft') {
					inward();
					if (stepsLeft(heading) < 1) return handBack('FAILED', 'FIND_NOT_FOUND', `Searched to ${within} blocks from the start`);
				}
				if (pattern === 'shaft') await bucketToHotbar();
				const outcome = await leg(`dig ${pattern} to y${profile.depth}`, 'dig_to', { pattern, y: profile.depth, heading: heading.name, ...descentCap(pattern), stopWhenSeen: profile.stopId, discard: DISCARD });
				const ended = await settle(outcome);
				if (ended !== null) return ended;
				const code = outcome.result?.reasonCode;
				if (code === 'DIG_GOAL_REACHED') reversals = 0;
				if (code === 'DIG_GOAL_REACHED' || code === 'DIG_LIMIT_REACHED') continue;
				descentStops += 1;
				if (code === 'CAVE_OPENING') {
					const cave = await look(25);
					if (cave.interrupted || cave.seen || cave.ended) return settle(cave);
					// A cave going down is a way to the depth with no digging: its lowest seen floor.
					const floor = String(outcome.result?.message ?? '').match(/lowest floor[^-\d]*(-?\d+),\s*(-?\d+),\s*(-?\d+)/i);
					if (floor !== null && Number(floor[2]) < bodyAt(observation).y - 3) {
						const walk = await leg('down the cave', 'travel_to', { x: Number(floor[1]) + 0.5, y: Number(floor[2]), z: Number(floor[3]) + 0.5, tolerance: 2, stopWhenSeen: profile.stopId });
						const walkEnded = await settle(walk);
						if (walkEnded !== null) return walkEnded;
						continue;
					}
				}
				turn();
				continue;
			}
			// At depth (or the way down is shut): look once per new spot, then a straight tunnel leg.
			const here = bodyAt(observation);
			if (lookedAt === null || Math.hypot(here.x - lookedAt.x, here.y - lookedAt.y, here.z - lookedAt.z) > 12) {
				lookedAt = here;
				const spot = await look(10);
				if (spot.interrupted || spot.seen || spot.ended) return settle(spot);
			}
			inward();
			if (exhausted()) return handBack('FAILED', 'FIND_NOT_FOUND', `Searched to ${within} blocks from the start`);
			// A cave in the target's band nearby comes before more tunnel: walk in and look round it.
			const cave = [...caves.values()].filter((row) => !row.visited && inBand(row.y) && Math.hypot(row.x + 0.5 - here.x, row.z + 0.5 - here.z) <= CAVE_REACH
				&& Math.hypot(row.x + 0.5 - origin.x, row.z + 0.5 - origin.z) <= within)
				.sort((a, b) => Math.hypot(a.x - here.x, a.y - here.y, a.z - here.z) - Math.hypot(b.x - here.x, b.y - here.y, b.z - here.z))[0];
			if (cave !== undefined && caveVisits < MAX_CAVE_VISITS) {
				caveVisits += 1;
				for (const row of caves.values()) if (Math.hypot(row.x - cave.x, row.y - cave.y, row.z - cave.z) <= 6) row.visited = true;
				const walk = await leg('into a cave', 'travel_to', { x: cave.x + 0.5, y: cave.y, z: cave.z + 0.5, tolerance: 2, stopWhenSeen: profile.stopId });
				const walked = await settle(walk);
				if (walked !== null) return walked;
				const inside = await look(20);
				if (inside.interrupted || inside.seen || inside.ended) return settle(inside);
				lookedAt = bodyAt(observation);
				continue;
			}
			// Heard lava is a direction: a player digs toward the sound, unless that way already stopped here.
			const heard = observation?.player?.heardLava;
			const spot = `${Math.floor(here.x)},${Math.floor(here.y)},${Math.floor(here.z)}`;
			if (profile.ids.has('minecraft:lava') && heard?.direction !== undefined && SOUND_YAW[heard.direction] !== undefined && Number.isFinite(observation?.player?.yaw)) {
				const toward = nearestCardinal(observation.player.yaw + SOUND_YAW[heard.direction]);
				if (!stuck.has(`${spot}:${toward.name}`) && !spentNear(here, 16)) heading = toward;
			}
			if (rock && rockLegs >= ROCK_LEGS) break;
			rockLegs += 1;
			const outcome = await leg(`tunnel ${heading.name}`, 'dig_to', { pattern: 'tunnel', heading: heading.name, maxBlocks: Math.min(TUNNEL_LEG, tunnelBlocks()), stopWhenSeen: profile.stopId, discard: DISCARD });
			const ended = await settle(outcome);
			if (ended !== null) return ended;
			const code = outcome.result?.reasonCode;
			const refused = code === 'LAVA_AHEAD' ? String(outcome.result?.message ?? '').match(/not breaking \S+ at (-?\d+),(-?\d+),(-?\d+)/) : null;
			if (refused !== null && profile.ids.has('minecraft:lava') && peeks < MAX_PEEKS) {
				const peeked = await peek({ x: Number(refused[1]), y: Number(refused[2]), z: Number(refused[3]) });
				if (peeked !== null) return peeked;
			}
			const after = bodyAt(observation);
			if (Math.hypot(after.x - here.x, after.z - here.z) < 1) stuck.add(`${spot}:${heading.name}`);
			// Ore only forms in ore-bearing rock: a leg through mostly other stone (sulfur, dripstone, dirt...) turns.
			const barren = profile.kind === 'block' && !profile.ids.has('minecraft:lava') && oreRockShare(outcome.result?.message) < 0.5;
			if (['DIG_LIMIT_REACHED', 'DIG_GOAL_REACHED'].includes(code)) { base = heading; turns = 0; }
			if (!['DIG_LIMIT_REACHED', 'DIG_GOAL_REACHED'].includes(code) || barren) {
				if (code === 'CAVE_OPENING') { const cave = await look(25); if (cave.interrupted || cave.seen || cave.ended) return settle(cave); }
				turn();
			}
		}
		if (!rock) return handBack('TIMED_OUT', 'FIND_BUDGET', 'The search time ran out');
	}
	// Not in the rock near here: out to the open sky the body came from, and the surface legs from there.
	if (rock) {
		const up = await climbOut();
		if (up !== null) return up;
	}

	// c8861: masonry alone sent compass building legs through rock and away from the fortress.
	// A visible top face is a destination to try, not proof of reachable floor; walking navigation owns that check.
	const fortressSpawner = profile.kind === 'block' && profile.ids.has('minecraft:spawner')
		&& observation?.world?.dimension === 'minecraft:the_nether'
		&& !observation?.continuity?.rememberedSections?.includes('blocks')
		&& (observation?.blocks ?? []).some((row) => row.blockId === 'minecraft:nether_bricks');
	if (fortressSpawner) {
		const attempted = new Set(), visited = [bodyAt(observation)];
		let travelled = 0;
		while (left() >= MIN_LEG_MS) {
			const at = bodyAt(observation);
			const seenBlocks = observation?.continuity?.rememberedSections?.includes('blocks') ? [] : (observation?.blocks ?? []);
			const reachable = seenBlocks
				.filter(row => row.blockId === 'minecraft:nether_bricks' && row.placeableFaces?.includes('up'))
				.map(row => { const cell = cellOf(row); return cell === null ? null : { x: cell.x + 0.5, y: cell.y + 1, z: cell.z + 0.5 }; })
				.filter(row => row !== null && insideBoundary(row) && !attempted.has(`${row.x},${row.y},${row.z}`)
					&& Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z) <= Math.min(BUILD_LEG, BUILD_BUDGET - travelled)
					&& visited.every(spot => Math.hypot(row.x - spot.x, row.y - spot.y, row.z - spot.z) > 2));
			// Wall breaker rods (b): no floor leg past a seen wither skeleton (they killed most on open walkways).
			const withers = withersSeen(observation);
			const floors = reachable.filter(row => witherOnLeg(at, row, withers) === null)
				.sort((a, b) => Math.hypot(b.x - at.x, b.z - at.z) - Math.hypot(a.x - at.x, a.z - at.z));
			const floor = floors[0];
			if (floor === undefined && reachable.length > 0) {
				const near = reachable.map(row => witherOnLeg(at, row, withers)).filter(Boolean).sort((a, b) => a.distance - b.distance)[0];
				return handBack('FAILED', 'WITHER_ON_DECK', `Every visible fortress floor leg passes a wither skeleton (nearest ${Math.round(near.distance)} blocks away at ${Math.floor(near.x)},${Math.floor(near.y)},${Math.floor(near.z)}); 2.4 tall, it cannot enter a two-high gap: wait in cover, tunnel 2-high, or fight it from a 2-high doorway`);
			}
			if (floor === undefined) return handBack('FAILED', 'FIND_BLOCKED', 'No new visible fortress floor reachable by walking found here; choose the next walkway or vantage point');
			attempted.add(`${floor.x},${floor.y},${floor.z}`);
			// A seen corridor (brick walls both sides) may be reached across a gap with carried blocks.
			const bricks = new Set(seenBlocks.filter(row => row.blockId === 'minecraft:nether_bricks').map(row => cellOf(row)).filter(Boolean).map(c => `${c.x},${c.y},${c.z}`));
			const trip = await leg('along observed fortress floor', 'travel_to', { ...floor, tolerance: 1, build: corridorFloor(floor, bricks), stopWhenSeen: profile.stopId });
			const ended = await settle(trip);
			if (ended !== null) return ended;
			const after = bodyAt(observation);
			travelled += Math.hypot(after.x - at.x, after.y - at.y, after.z - at.z);
			visited.push(after);
			const view = await look(0);
			if (view.interrupted || view.seen || view.ended) return settle(view);
		}
		return handBack('TIMED_OUT', 'FIND_BUDGET', 'The search time ran out');
	}

	// 3b. Surface: take the high ground in sight once, then straight legs to new ground, looking round after each.
	const frontier = body.frontier(observation);
	const high = (frontier?.candidates ?? []).filter((row) => Number.isFinite(row.dy) && row.dy >= HIGH_GROUND_RISE && row.distance <= HIGH_GROUND_RADIUS && row.blocked !== true)
		.sort((left, right) => right.dy - left.dy)[0];
	if (high !== undefined && left() >= MIN_LEG_MS) {
		const climb = await leg('up to high ground', 'travel_to', { x: high.x + 0.5, y: high.y, z: high.z + 0.5, tolerance: 2, build: false,
			...(profile.kind === 'block' ? { stopWhenSeen: profile.stopId } : {}) });
		const ended = await settle(climb);
		if (ended !== null) return ended;
		if (climb.result?.reasonCode === 'ARRIVED') {
			const top = await look(-5);
			if (top.interrupted || top.seen || top.ended) return settle(top);
		}
	}
	// Every leg ends on new ground: inside within and NEW_GROUND blocks from every place a leg already ended.
	// Legs scale to the radius: a small within still gets straight legs inside it.
	const legLength = Math.min(SURFACE_LEG, Math.max(MIN_SURFACE_LEG, Math.floor(within / 2)));
	const newGround = legLength / 2;
	const visited = [bodyAt(observation)];
	const legEnd = (from, heading) => ({ x: from.x - Math.sin(heading * Math.PI / 180) * legLength, z: from.z + Math.cos(heading * Math.PI / 180) * legLength });
	const fresh = (from, heading) => {
		const end = legEnd(from, heading);
		return Math.hypot(end.x - origin.x, end.z - origin.z) <= within && visited.every((spot) => Math.hypot(end.x - spot.x, end.z - spot.z) >= newGround);
	};
	const stale = (from) => new Set(Object.entries(HEADING_YAW).filter(([, heading]) => !fresh(from, heading)).map(([name]) => name));
	let yaw = chooseHeading(body.frontier(observation)?.coverage?.headings, null, stale(bodyAt(observation)));
	const blocked = new Set();
	let lastBlock = '', building = false, retraces = 0, built = 0;
	// Spawner exploration has its own fortress-floor policy; leave its generic fallback unchanged too.
	const netherCrossing = () => observation?.world?.dimension === 'minecraft:the_nether'
		&& !(profile.kind === 'block' && profile.ids.has('minecraft:spawner'));
	// Conservative subset of TravelBuilder.buildingBlock: no wood, falling blocks, valuables or stations.
	const supportedBlocks = () => (observation?.inventory?.items ?? []).reduce((n, item) =>
		n + (SHELTER_BLOCKS.has(item?.itemId) && Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 0), 0);
	const constructionHandBack = () => {
		const at = bodyAt(observation) ?? last;
		return handBack('FAILED', 'FIND_BLOCKED', `At ${[at.x, at.y, at.z].map(n => Number(n.toFixed(1))).join(',')}, bearing ${headingName(yaw)} (yaw ${yaw}); ${supportedBlocks()} supported building blocks held. `
			+ `Requested ${built} of ${BUILD_BUDGET} construction-travel blocks this search. Choose another route, or request travel_to {yaw:${yaw},distance:${BUILD_LEG},build:true} for another short building attempt`);
	};
	while (left() >= MIN_LEG_MS) {
		const before = cellOfBody(bodyAt(observation));
		const up = await waterToSurface();
		if (up !== null) return up;
		// An ascent carried the body off the heading it was building along: walking legs again from where it came up.
		if (building && cellOfBody(bodyAt(observation)) !== before) { blocked.clear(); building = false; }
		if (left() < MIN_LEG_MS) break;
		const at = bodyAt(observation);
		if (!building && ground !== null && at !== null && Math.hypot(ground.at.x - at.x, ground.at.z - at.z) <= 4) {
			const sea = [...seaHeadings(ground.views)].filter((name) => !blocked.has(name));
			if (sea.length > 0) progress(`open water seen ${sea.join(', ')}`);
			for (const name of sea) { blocked.add(name); lastBlock = `open water seen ${name}`; }
		}
		if (blocked.has(headingName(yaw)) || !fresh(at, yaw)) {
			// Turn to the least covered heading that still leads to new ground; none left means the area is searched.
			const avoid = new Set([...stale(at), ...blocked]);
			// Walking found no way on: once, let the legs bridge, pillar and tunnel (build) before handing back, while the
			// search's building budget lasts.
			if (avoid.size >= Object.keys(HEADING_YAW).length && blocked.size > 0 && !building && BUILD_BUDGET - built >= MIN_SURFACE_LEG) {
				building = true;
				blocked.clear();
				avoid.clear();
				for (const name of stale(at)) avoid.add(name);
			}
			if (avoid.size >= Object.keys(HEADING_YAW).length) {
				if (netherCrossing() && BUILD_BUDGET - built < MIN_SURFACE_LEG) return constructionHandBack();
				return blocked.size === 0 ? handBack('FAILED', 'FIND_NOT_FOUND', `No new ground left within ${within} blocks of the start`)
					: handBack('FAILED', 'FIND_BLOCKED', `No way on from here: ${blocked.size} heading(s) blocked (last: ${lastBlock}), the rest already searched${built > 0
						? `; building legs already covered ${Math.round(built)} of ${BUILD_BUDGET} blocks this search, so no more digging blind (a cave, open air or the surface is the way on)` : ''}`);
			}
			yaw = chooseHeading(body.frontier(observation)?.coverage?.headings, null, avoid);
		}
		// Toward the nearest wooded land seen, when the leg there is new ground and its heading is not blocked.
		const wood = woods.filter((row) => Math.hypot(row.x - at.x, row.z - at.z) > 12).sort((a, b) => Math.hypot(a.x - at.x, a.z - at.z) - Math.hypot(b.x - at.x, b.z - at.z))[0];
		let toWoods = '';
		if (wood !== undefined) {
			const toward = HEADING_YAW[headingName(Math.atan2(-(wood.x - at.x), wood.z - at.z) * 180 / Math.PI)];
			if (!blocked.has(headingName(toward)) && fresh(at, toward)) { yaw = toward; toWoods = ` toward the ${bare(String(wood.biome))} at ${Math.round(wood.x)},${Math.round(wood.z)}`; }
		}
		// A surface target is seen from the surface: legs walk round hills rather than tunnel through them (no build),
		// until walking has no way on from here.
		if (building && netherCrossing() && BUILD_BUDGET - built < MIN_SURFACE_LEG) return constructionHandBack();
		let distance = building ? Math.max(MIN_SURFACE_LEG, Math.min(legLength, BUILD_LEG, BUILD_BUDGET - built)) : legLength;
		const charged = building && netherCrossing();
		if (charged) built += distance;
		let outcome = await leg(`${building ? 'build' : 'walk'} ${headingName(yaw)}${toWoods}`, 'travel_to', { yaw, distance, build: building,
			...(profile.kind === 'block' ? { stopWhenSeen: profile.stopId } : {}) });
		const ended = await settle(outcome);
		if (ended !== null) return ended;
		let from = at, after = bodyAt(observation);
		if (building && !charged) built += Math.hypot(after.x - at.x, after.z - at.z);
		if (!building && netherCrossing() && ['NO_ROUTE', 'STALLED_IN_PLACE'].includes(outcome.result?.reasonCode) && supportedBlocks() >= MIN_SURFACE_LEG
			&& Math.hypot(after.x - at.x, after.z - at.z) < distance / 2 && left() >= MIN_LEG_MS && withinReach() >= MIN_SURFACE_LEG) {
			if (BUILD_BUDGET - built < MIN_SURFACE_LEG) return constructionHandBack();
			from = after;
			distance = Math.min(legLength, BUILD_LEG, BUILD_BUDGET - built, Math.floor(withinReach()));
			// Charge requested distance, even on refusal or zero movement, shared with the normal fallback above.
			built += distance;
			outcome = await leg(`build ${headingName(yaw)} after blocked walk`, 'travel_to', { yaw, distance, build: true,
				...(profile.kind === 'block' ? { stopWhenSeen: profile.stopId } : {}) });
			const stopped = await settle(outcome);
			if (stopped !== null) return stopped;
			after = bodyAt(observation);
		}
		// A leg that got nowhere this way (blocked, no route) rules the heading out from here.
		if (outcome.result?.reasonCode !== 'ARRIVED' && Math.hypot(after.x - from.x, after.z - from.z) < distance / 2) {
			blocked.add(headingName(yaw));
			lastBlock = `${outcome.result?.reasonCode ?? outcome.result?.state}: ${String(outcome.result?.message ?? '').slice(0, 160)}`;
			// Left in water with no bank in sight: out the way the body came, to the last dry spot a leg ended on, before
			// another heading. Scripted water-5 fixture: a leg walked into a river and stopped mid-stream, and every leg
			// after it swam 30 s without moving, 4 min in all.
			const dry = visited.at(-1);
			if ((observation?.player?.inWater === true || observation?.player?.underWater === true) && retraces < MAX_RETRACES
				&& Math.hypot(dry.x - after.x, dry.z - after.z) > 3) {
				retraces += 1;
				const back = await leg('back out of the water the way it came', 'travel_to', { x: dry.x, y: dry.y, z: dry.z, retrace: true, tolerance: 3,
					...(profile.kind === 'block' ? { stopWhenSeen: profile.stopId } : {}) });
				const out = await settle(back);
				if (out !== null) return out;
			}
		}
		else {
			visited.push(after);
			// A build leg that got through builds on that heading while the budget lasts: walking legs from the far side of
			// what it bridged or tunnelled ended NO_ROUTE again, several per spot, before the next build (K1). Headings ruled
			// out at the spot it left say nothing about this one: each is tried again from here.
			blocked.clear();
			if (!building || BUILD_BUDGET - built < MIN_SURFACE_LEG) building = false;
		}
		// One look per new cell: a leg that left the body in the cell it last looked from shows the same view (about 2 s).
		if (cellOfBody(bodyAt(observation)) !== cellOfBody(lookedFrom)) {
			const view = await look(0);
			if (view.interrupted || view.seen || view.ended) return settle(view);
		}
	}
	return handBack('TIMED_OUT', 'FIND_BUDGET', 'The search time ran out');
}
