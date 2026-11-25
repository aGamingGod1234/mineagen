// obtain {item, count}: gets an item into the inventory by its whole chain, as a player would. Each round reads a fresh
// observation, re-plans from what is held (obtain-plan.mjs) and makes one move: craft or smelt everything it can now,
// else gather one raw need in full (every log the plan needs, then craft once). Rules it keeps: finish what is in front
// of it (a whole tree, a whole vein), reuse a table or furnace in reach before placing one, pick up what it placed
// before it leaves, the right tool in hand (mine and break choose it), and every move goes somewhere. It hands back when
// done, when stuck (what is missing and why) or when danger the reflexes do not handle interrupts it.
//
// Finding a source is one function, locate(): what is in view or remembered, then a survey search, then exploring
// (walking out for trees and animals, digging toward the ore's depth). A future find verb can replace it.
import { appendFileSync } from 'node:fs';
import { howtoIndex } from './howto.mjs';
import { DAMAGE_STOPS, FIGHT_STOPS, DISCARD, LIFE_SAFETY_STOPS, MAX_FIND_TIMEOUT_MS, UNREACHED, UNREACHED_SPOT, caveLog, hostileIsDanger, sameVein } from './find-search.mjs';
import { threatRows, blazeBlocksErrand } from './search-danger.mjs';
import { nightMoveStop } from './night-cover.mjs';
import { REGEN_RESUME_HEALTH, bodyDanger, eatCalls, lowHealthFork } from './fork-rule.mjs';
import { heldCounts, heldOf, keepPickaxeMakings, planObtain, readyTimes, resolveObtainItem, searchCost, seenRowCost, shortId, OBTAIN_STATIONS } from './obtain-plan.mjs';
import { JOB_BLOCK, houseYield, lootSources, structureReach } from './loot-sources.mjs';
import { lootChest } from './loot-step.mjs';
import { KIT_ARMOUR, kitLeft } from './skill-fits.mjs';
import { getSwitch } from './switches.mjs';

export const OBTAIN_DEFAULT_TIMEOUT_MS = 900_000;
export const OBTAIN_MAX_TIMEOUT_MS = 1_800_000;
const MAX_ROUNDS = 160;
const LOW_HEALTH = 6;
// At or under this a non-food obtain stops to recover (eat or regenerate, fork-rule.mjs) before its next move: the heal
// nudge's line and gather's own floor. Recovery lasts at most RECOVER_MS and resumes at EAT_RESUME_HEALTH once it ate.
const RECOVER_AT = 8;
const RECOVER_MS = 90_000;
const EAT_RESUME_HEALTH = 12;
// Food is what a player at low health goes to get: the low-health line does not stop an obtain for one of these. Only
// food taken straight from an animal or plant: a crafted or smelted food's chain mines, smelts and travels like any other.
const FOODS = new Set(['beef', 'porkchop', 'mutton', 'chicken', 'rabbit', 'cod', 'salmon', 'apple', 'carrot', 'potato',
	'sweet_berries', 'glow_berries', 'melon_slice', 'beetroot']);
// MINEAGEN_OBTAIN_COSTS=off plans as before chests, the seen-source cost model and the one-trip kit iron (A/B rooms).
const OBTAIN_COSTS = getSwitch('obtain.costs').value;
const FILL_LEGS = getSwitch('obtain.fillLegs').value;
const FILL_EDGE = getSwitch('obtain.fillEdge').value;
const EDGE_REDO = 'dug down beside a drop to water; fill again from here';
// Food a trip below ground is stocked with, in hunger points: one full bar (20), about a quarter hour's eating. Food the
// trip lacks is counted in bread-sized items (5 points) for a chest's value; 4 bread held is a full bar and none is short.
const TRIP_HUNGER = 20;
const NUTRITION = { bread: 5, baked_potato: 5, cooked_beef: 8, cooked_porkchop: 8, cooked_mutton: 6, cooked_chicken: 6, cooked_salmon: 6, cooked_cod: 5,
	cooked_rabbit: 5, golden_carrot: 6, apple: 4, carrot: 3, potato: 1, beetroot: 1, beef: 3, porkchop: 3, mutton: 2, chicken: 2, rabbit: 3, cod: 2, salmon: 2,
	sweet_berries: 2, glow_berries: 2, melon_slice: 2 };
/** Bread-sized food items the trip still lacks, from the hunger points of the food held. */
export function tripFoodShort(counts) {
	const points = [...counts].reduce((sum, [kind, n]) => sum + (NUTRITION[kind] ?? 0) * n, 0);
	return Math.max(0, Math.ceil((TRIP_HUNGER - points) / 5));
}
// Climbing out of a mine for logs or animals: stairs up a leg of 24 at a time, enough legs to reach the surface from y -58.
const CLIMB_LEG = 24;
const CLIMB_LEGS = 6;
const REACH = 4.4;
const STATION_WALK = 24;
const SURFACE_RADIUS = 32;
const ORE_RADIUS = 24;
const SMELT_MS = 10_000;
const WAIT_SLICE_MS = 5_000;
// fight_until's radius: a herd further than this from where the walk ended is out of the hunt's reach.
const HUNT_RADIUS = 24;
const LOGS_PER_TRIP = 8;
const COAL_FUEL_TRIES = 2;
const COAL_SEARCH_MS = 90_000;
// Leaves under the feet (a spawn on a tree canopy) are broken one at a time until the body stands on the ground.
const CANOPY_BREAKS = 8;
// Leaves hide the column under them, so the drop off a canopy is judged by the ground seen round the tree: the lowest
// natural ground within CANOPY_REACH blocks, seen looking out over each side. A fall of CANOPY_FALL costs 2 health.
const CANOPY_REACH = 8;
const CANOPY_FALL = 5;
// A drop the body could not walk to that is this close underground is dug to (pick-up stops meaning no standing spot).
const DROP_DIG = 4;
// Mining stops that say the ore is out of reach from where the body got to: it and its vein leave obtain's picks and
// find's sightings. A worn or missing tool, or danger, says nothing about reach: a new tool mines the same vein.
const OUT_OF_REACH = new Set(['NOTHING_MINED', 'INVALID_VEIN_TARGET', 'NO_STANCE', 'PATH_BLOCKED', 'NO_STANDABLE_PATH', 'NO_ROUTE', 'NO_PROGRESS', 'NO_SEEN_ROUTE']);
const TOOL_STOPS = new Set(['TOOL_WORN', 'NO_TOOL']);
export const HAND_SPEED_STONE = /building cannot continue: minecraft:(?:stone|deepslate|andesite|diorite|granite|tuff|cobblestone|cobbled_deepslate|calcite|dripstone_block)(?: at -?\d+,-?\d+,-?\d+)? takes \d/;
const NOT_REACH = new Set([...TOOL_STOPS, 'HOSTILE_NEAR', 'DANGER', 'LOW_FOOD', 'INVENTORY_FULL', 'CANCELLED', 'NATIVE_ACTION_CANCELLED', ...DAMAGE_STOPS, ...FIGHT_STOPS]);
const VEIN_MISSES = 8;
// A pickaxe with fewer uses left than this is about to break: one tunnel or vein more wears it out.
const LOW_USES = 16;
const STONE_DIG_LEGS = 3;
// A dig for stone that meets water: walk this far away from it and dig again, at most this many times a round.
const WET_STONE_WALK = 16;
const WET_STONE_MOVES = 3;
const UNREACHED_DROP = new Set(['PATH_BLOCKED', 'NO_STANDABLE_PATH', 'NO_ROUTE', 'NO_PROGRESS', 'ITEM_PICKUP_TIMED_OUT', 'NO_SEEN_ROUTE']);
const PLAIN_GROUND = /^(grass_block|dirt|coarse_dirt|podzol|mycelium|rooted_dirt|mud|moss_block|pale_moss_block|clay|sand|red_sand|gravel|snow_block|snow|stone|andesite|diorite|granite|tuff|deepslate|calcite|dripstone_block|sandstone|red_sandstone|terracotta|[a-z_]+_terracotta|packed_ice)$/;
// Furnace fuel a body burns, in smelts per item from the game's burn times (coal 8, a plank or log 1.5); never a tool
// or a workstation, which burn too.
const FUEL_GROUPS = [['coal'], ['charcoal'], '#planks', '#logs_that_burn'];
const id = (value) => `minecraft:${String(value).replace(/^minecraft:/, '')}`;
const bare = (value) => String(value ?? '').replace(/^minecraft:/, '');
const TOOL_TIERS = ['wooden', 'golden', 'stone', 'copper', 'iron', 'diamond', 'netherite'];
const STONE_BLOCKS = /^(stone|deepslate|cobblestone|cobbled_deepslate|andesite|diorite|granite|tuff)$/;
const ORE_BLOCKS = /_ore$/;
// Items no recipe or drop gives: a player fills an empty bucket at a source of the fluid. Lava is left to build
// nether_portal, which scoops it from a pool it has judged safe to stand by. Gate games gate2B-1, -3, -6 and -8: the
// model asked obtain for water_bucket and got NO_SUCH_ITEM, then filled the bucket by hand over 1-7 minutes.
const FILLS = Object.freeze({ water_bucket: 'water' });
// Sources tried before obtain hands back stuck: each try is another source, or the same one found again from elsewhere.
const FILL_TRIES = 4;
// The rest of a smelt's input in view this near: the held part smelts while the body mines it (one furnace, one trip).
const OVERLAP_WALK = 12;
const WET_STOP = /water under this spot|the body is under water here|out of the water|TUNNEL_FLOODED|flooded/i;
// A plant a bucket's ray met (use_item's or interact's message names it): soft, broken at once, nothing behind it.
const PLANT_HIT = /(?:ray met|meets) (minecraft:(?:short_grass|tall_grass|grass|fern|large_fern|[a-z_]*vines?(?:_plant)?|glow_lichen|[a-z_]*roots|[a-z_]*sprouts|small_dripleaf|big_dripleaf(?:_stem)?|azalea|flowering_azalea|moss_carpet|pale_moss_carpet|[a-z_]*bush|dead_bush|seagrass|tall_seagrass|kelp(?:_plant)?|hanging_roots|spore_blossom|[a-z_]*_sapling|[a-z_]*tulip|dandelion|poppy|[a-z_]*orchid|allium|azure_bluet|oxeye_daisy|cornflower|lily_of_the_valley|leaf_litter)) at (-?\d+),(-?\d+),(-?\d+)/;
const SCOOPS = 8;
// Plain blocks a cast frame's mould and its crossings take: a walk to water builds only with more than these carried.
const PLAIN_BLOCKS = /^(cobblestone|cobbled_deepslate|dirt|stone|deepslate|andesite|diorite|granite|tuff|blackstone|basalt)$/;
const SPARE_BLOCKS = 24;
// A walk to water goes in legs of FILL_LEG_MS, up to FILL_WALK_MS in all, and checks for water in reach after each
// (obtain.fillLegs off: one leg of the whole FILL_WALK_MS, as before).
const FILL_WALK_MS = 90_000, FILL_LEG_MS = FILL_LEGS ? 10_000 : FILL_WALK_MS, FILL_LEG_MIN_MS = 3_000;
// The walker's own stuck check (travel's STALL_MS and PROGRESS_STEP) starts over each leg, so the legs keep it across
// the whole walk: no closer by this much for this long and the water counts as out of reach (NO_ROUTE).
const FILL_STALL_MS = 60_000, FILL_PROGRESS = 2;
// After a fill, a walk back out of the water to a dry spot from before a find search goes only this many blocks.
const DRY_WALK = 32;
const KEEP_COBBLE = 16;
const ROOM_STACKS = 2;
const COBBLE = new Set(['cobblestone', 'cobbled_deepslate']);

function bodyAt(o) {
	const p = o?.position ?? o?.player;
	return p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null;
}
const eyeDistance = (body, b) => Math.hypot(b.x + 0.5 - body.x, b.y + 0.5 - (body.y + 1.62), b.z + 0.5 - body.z);
const flatDistance = (body, b) => Math.hypot(b.x + 0.5 - body.x, b.z + 0.5 - body.z);

// The water a step or two off an edge the body stands on, 3-8 blocks below its feet (the mod's edges fact), or null.
export function waterBelowEdge(o) {
	const at = bodyAt(o);
	const drops = o?.player?.edges?.drops;
	if (at === null || !Array.isArray(drops)) return null;
	const steps = { E: [1, 0], S: [0, 1], W: [-1, 0], N: [0, -1] };
	const drop = drops.filter((row) => row?.into === 'water' && row.atLeast !== true && steps[row.dir] && Number.isSafeInteger(row.at) && row.at <= 1
		&& Number.isSafeInteger(row.drop) && row.drop >= 3 && row.drop <= 8).sort((a, b) => a.at - b.at || a.drop - b.drop)[0];
	if (!drop) return null;
	const [dx, dz] = steps[drop.dir];
	// Away from the drop: without a water bucket a shaft goes down as two-column stairs, and these cut into the wall behind.
	const away = { E: 'west', S: 'north', W: 'east', N: 'south' }[drop.dir];
	// drop is ceil(feet - water surface); a source's surface stands 0.89 above its cell, a flow's lower. Feet on a block top
	// (67.0) or a part block (farmland 67.94, a slab 67.5) both name the cell the surface is in.
	return { x: Math.floor(at.x) + dx * (drop.at + 1), y: Math.floor(at.y - drop.drop + 0.11), z: Math.floor(at.z) + dz * (drop.at + 1), away };
}

// MINEAGEN_FILL_TRACE names a file: each bucket fill that fails to reach its water appends one JSON line (diagnosis only).
function fillTrace(row) {
	const file = process.env.MINEAGEN_FILL_TRACE;
	if (!file) return;
	try { appendFileSync(file, `${JSON.stringify({ t: Date.now(), ...row })}\n`); } catch { /* diagnosis only */ }
}

function knownBlocks(o) {
	// seenResources (seen-resources.mjs): placed blocks seen so far (a village's cobblestone, a house's planks), nearest
	// first. Remembered ore is the ore-memory lane's to use; here only what perception never listed as terrain or ore.
	return [...(o.blocks ?? []), ...(o.world?.landmarks ?? o.landmarks ?? []), ...(o.routeMemory?.seenResources ?? []),
		...(o.seenResources ?? []).filter((row) => row.kind === 'block' && row.placed === true).map((row) => ({ ...row, blockId: row.id }))]
		.filter((row) => row && typeof row.blockId === 'string' && [row.x, row.y, row.z].every(Number.isSafeInteger));
}

/**
 * Raw iron to mine beyond this plan's own while at the ore: the iron the route's kit (kitLeft) still lacks, less the
 * iron held and what this plan already mines. 0 unless this plan mines raw iron in the Overworld.
 */
export function kitIronExtra(o, plan) {
	if ((o?.world?.dimension ?? 'minecraft:overworld') !== 'minecraft:overworld') return 0;
	const mining = plan.needs.filter((need) => need.kind === 'mine' && need.accept.includes('raw_iron')).reduce((n, need) => n + need.count, 0);
	if (mining === 0) return 0;
	const items = (o?.inventory?.items ?? []).filter((row) => row?.count > 0);
	const count = (re) => items.filter((row) => re.test(row.itemId ?? '')).reduce((n, row) => n + row.count, 0);
	// The kit's iron less what is held and what this plan brings up already.
	return Math.max(0, kitLeft(count).iron - count(/^minecraft:(iron_ingot|raw_iron)$/) - mining);
}

/** Iron (ingots and raw) the route's kit still lacks beyond what is held. */
export function kitIronShort(o) {
	const items = (o?.inventory?.items ?? []).filter((row) => row?.count > 0);
	const count = (re) => items.filter((row) => re.test(row.itemId ?? '')).reduce((n, row) => n + row.count, 0);
	return Math.max(0, kitLeft(count).iron - count(/^minecraft:(iron_ingot|raw_iron)$/));
}

/**
 * Iron the kit and the route's armour (KIT_ARMOUR pieces not held) still lack beyond what is held: what a top-up at the
 * ore takes. A player at a vein takes the iron it will wear too. The armour row alone asked for 8 iron with 0 to 5 held,
 * a second trip down, and 0 of 30 Overworld deaths in 8 fresh games (25 Nov) wore armour. Never a fresh search: the
 * top-up mines only ore in view or known within reach.
 */
export function kitAndArmourIronShort(o) {
	const items = (o?.inventory?.items ?? []).filter((row) => row?.count > 0);
	const count = (re) => items.filter((row) => re.test(row.itemId ?? '')).reduce((n, row) => n + row.count, 0);
	const armour = KIT_ARMOUR.filter((piece) => !count(piece.part)).reduce((n, piece) => n + piece.iron, 0);
	return Math.max(0, kitLeft(count).iron + armour - count(/^minecraft:(iron_ingot|raw_iron)$/));
}

/** Armour points worn and the best sword or axe tier held (-1 none): whether a built mob's fight is a way. */
export function gearOf(o) {
	const weapons = (o?.inventory?.items ?? []).filter((row) => row?.count > 0 && /_(sword|axe)$/.test(bare(row.itemId)))
		.map((row) => TOOL_TIERS.indexOf(bare(row.itemId).split('_')[0]));
	return { armor: Number.isFinite(o?.player?.armor) ? o.player.armor : 0, weapon: Math.max(-1, ...weapons) };
}

/**
 * The loot ledger for a world: the same one while the world is the same or unknown (a sample without a world id), a new
 * one once a known, different world is seen (a replacement server's chests and villages are new).
 */
export function lootLedger(ledger, worldId) {
	if (!ledger || (worldId !== null && ledger.worldId != null && ledger.worldId !== worldId)) return { opened: [], searched: [], structures: [], misses: {}, doors: [], worldId };
	if (worldId !== null) ledger.worldId ??= worldId;
	return ledger;
}

// Structures seen this life, kept so a village's chests stay a source after the body walks out of its sight.
const KEPT_STRUCTURES = 16;
// Houses looked into per loot step before the search, and the door blocks that lead into them.
const DOOR_VISITS = 6;
const DOOR = /^(minecraft:)?[a-z_]+_door$/;
const HOUSE_REACH = 8;
// Looking into one house, all in: plan, walk to the door, open it, step in, look, shut it. In the 22 Nov rerun the door
// walk to the shut door took a median 17 s over 115 houses, and the stone-pickaxe village start ran 168 s longer for
// about 5 houses (about 34 s each). In the planner's cost units of about 5 s.
const HOUSE_LOOK = 6;
const HOSTILE_MOB = /^(zombie|zombie_villager|husk|drowned|skeleton|stray|bogged|spider|cave_spider|creeper|witch|pillager|vindicator|evoker|ravager|slime|enderman)$/;
// The server's hostility flag counts too, except on a village's own (a golem defends, villagers and cats are harmless).
const VILLAGE_FOLK = /^(villager|iron_golem|wandering_trader|trader_llama|cat|snow_golem)$/;
const hostileMob = (row) => HOSTILE_MOB.test(bare(row?.type ?? '')) || (row?.hostile === true && !VILLAGE_FOLK.test(bare(row?.type ?? '')));
const CONTAINER = /^(minecraft:)?(chest|trapped_chest|barrel)$/;
const CONTAINER_SCREEN = /generic_9x|shulker_box/;
/** A loot ledger key: the cell in its dimension. */
export const lootKey = (row, dimension) => `${dimension ?? 'minecraft:overworld'}|${Math.floor(row.x)},${Math.floor(row.y)},${Math.floor(row.z)}`;
const DOOR_KINDS = ['oak', 'spruce', 'birch', 'acacia', 'dark_oak', 'jungle', 'mangrove', 'cherry', 'pale_oak'].map((kind) => `minecraft:${kind}_door`);
export function rememberStructures(looted, o) {
	for (const row of o?.sighted?.structures ?? []) {
		if (![row?.x, row?.y, row?.z].every(Number.isFinite) || typeof row.structure !== 'string') continue;
		const dimension = o.world?.dimension ?? null;
		if (looted.structures.some((s) => s.structure === row.structure && s.dimension === dimension && Math.hypot(s.x - row.x, s.z - row.z) < 48)) continue;
		looted.structures.push({ structure: row.structure, x: row.x, y: row.y, z: row.z, dimension });
		if (looted.structures.length > KEPT_STRUCTURES) looted.structures.shift();
	}
}

/**
 * Where each seen id is, for the planner's price of the way to it (obtain-plan.mjs approachCost): per short id, the
 * known places with { distance, across, drop, enclosed, count }. Reads the shared seen-resource rows when the
 * observation carries them, and the blocks and mobs in view. enclosed: a row the perception marks as not open to a walk.
 */
export function seenPlaces(o) {
	const at = bodyAt(o);
	const places = new Map();
	if (at === null) return places;
	const add = (rawId, row, count = 1) => {
		if (![row?.x, row?.y, row?.z].every(Number.isFinite)) return;
		const cx = Number.isInteger(row.x) ? row.x + 0.5 : row.x, cz = Number.isInteger(row.z) ? row.z + 0.5 : row.z;
		const across = Math.hypot(cx - at.x, cz - at.z), drop = at.y - row.y;
		const key = bare(rawId);
		const list = places.get(key) ?? [];
		list.push({ distance: Math.hypot(across, drop), across, drop, enclosed: row.enclosed === true || row.hidden === true, count: Number.isFinite(row.count) ? row.count : count });
		places.set(key, list);
	};
	// The same rows seenIds counts (knownBlocks: remembered ore stays the ore-memory lane's), so a place is priced only
	// for a source the plan counts as seen.
	for (const row of knownBlocks(o)) add(row.blockId, row);
	for (const row of o.entities ?? []) if (row?.type && row.type !== 'minecraft:item' && row.alive !== false) add(row.type, row);
	return places;
}

/** Short ids of blocks and mobs in view or remembered, for the planner's "seen is cheaper". */
export function seenIds(o) {
	const seen = new Set();
	for (const row of knownBlocks(o)) seen.add(bare(row.blockId));
	for (const row of o.entities ?? []) if (row?.type && row.type !== 'minecraft:item') seen.add(bare(row.type));
	return seen;
}

/** A station block in view now within walking reach, the one this run placed first; never one it has picked up. */
function nearStation(o, kind, placed, removed = new Set()) {
	const body = bodyAt(o);
	if (body === null || o.continuity?.rememberedSections?.includes('blocks')) return null;
	const rows = (o.blocks ?? []).filter((row) => row?.blockId === id(kind) && [row.x, row.y, row.z].every(Number.isSafeInteger) && !removed.has(`${row.x},${row.y},${row.z}`)
		&& Math.hypot(row.x + 0.5 - body.x, row.y - body.y, row.z + 0.5 - body.z) <= STATION_WALK);
	const ours = rows.filter((row) => placed.some((p) => p.x === row.x && p.y === row.y && p.z === row.z));
	return [...ours, ...rows.sort((a, b) => eyeDistance(body, a) - eyeDistance(body, b))][0] ?? null;
}

/** Inventory slot (0-35) of the fullest stack of any id in members, skipping one slot. */
function slotOf(o, members, skip = null) {
	const selected = o.inventory?.selectedSlot;
	const rows = (o.inventory?.items ?? []).map((row) => ({ ...row, slotIndex: Number.isSafeInteger(row.slot) ? row.slot : row.slot === 'mainhand' && Number.isSafeInteger(selected) ? selected : null }))
		.filter((row) => row.slotIndex !== null && row.slotIndex !== skip && row.count > 0 && members.includes(bare(row.itemId)));
	return rows.sort((a, b) => b.count - a.count)[0] ?? null;
}

// Body stops that mean danger to answer now: damage, and every life-safety stop (lava, fire, falling blocks, a void
// edge, air running out). A hostile far off that merely ended a walk leg is not one, unless it shoots: judged from the
// threat rows of a sample taken after the stop (observation), never from the stop's wording.
// (DAMAGE_STOPS and LIFE_SAFETY_STOPS are find's list, one for both verbs.)
export function isDanger(result, observation) {
	const code = result?.reasonCode;
	if (DAMAGE_STOPS.has(code) || LIFE_SAFETY_STOPS.has(code)) return true;
	// A reflex kept the body for minutes (the mod's REFLEX_HOLD_LIMIT_MS): retrying the leg would hand it straight back to
	// the same reflex for another 2 minutes, so the run stops and the model hears why.
	if (code === 'HELD_BY_REFLEX') return true;
	return code === 'HOSTILE_NEAR' && hostileIsDanger(observation);
}

const RANGED_KINDS = new Set(['skeleton', 'stray', 'bogged', 'parched', 'pillager', 'witch', 'blaze', 'ghast', 'breeze', 'drowned'].map(id));

/**
 * A mob to hunt seen (not heard or remembered) within the hunt's reach and about the body's height: under cover it is
 * fought there. A cow heard through a cave ceiling still means climbing out to the surface first.
 */
function huntHere(need, o, budget) {
	const at = bodyAt(o);
	if (!at || o.continuity?.rememberedSections?.includes('entities')) return false;
	const mobs = new Set(need.mobs.map(id));
	return (o.entities ?? []).some((row) => mobs.has(row?.type) && row.alive !== false && row.visible !== false && row.perceivedBy !== 'sound' && row.remembered !== true
		&& [row.x, row.y, row.z].every(Number.isFinite) && !unreachedHerd(budget, row) && Math.abs(row.y - at.y) <= 4 && Math.hypot(row.x - at.x, row.z - at.z) <= HUNT_RADIUS);
}

/**
 * The sample with the hunted kind's own rows left out, so a walk-up stop for the quarry alone is not danger. Unchanged
 * with no quarry, or with no threat rows to tell the kinds apart (unknown stays danger).
 */
function withoutQuarry(o, quarry) {
	if (quarry === null || o === null || threatRows(o) === null) return o;
	// The hunted mob itself is left out by its id. Others of its kind are left out too, except an archer drawing on the body
	// (a second skeleton on a bone hunt), which stays danger. With no id known, the hunted kind's archers stay danger too.
	const drawing = (row) => RANGED_KINDS.has(row.type) && (row.targeting === true || (Array.isArray(row.signals) && row.signals.includes('targeting')));
	const other = (row) => !(quarry.id !== null && (row?.stableId ?? row?.uuid) === quarry.id) && (row?.type !== quarry.type || drawing(row));
	return { ...o, player: { ...o.player, ...(Array.isArray(o.player?.threats) ? { threats: o.player.threats.filter(other) } : {}) },
		...(Array.isArray(o.threats?.entries) ? { threats: { ...o.threats, entries: o.threats.entries.filter(other) } } : {}),
		...(Array.isArray(o.entities) ? { entities: o.entities.filter(other) } : {}) };
}

/**
 * A hostile on the body now, by obtain's one rule (hostileIsDanger: one within 10 blocks, or a ranged mob after it),
 * named for the model. A sample with no threat rows is judged by its entity rows alone: no stop says a hostile is near.
 */
function hostileOn(o) {
	if (!hostileIsDanger(threatRows(o) === null ? { ...o, player: { ...o?.player, threats: [] } } : o)) return null;
	const at = o?.player ?? {};
	const near = [...(threatRows(o) ?? []), ...(Array.isArray(o?.entities) ? o.entities.filter((row) => row?.hostile === true && row.alive !== false) : [])]
		.map((row) => ({ type: row.type ?? row.entityId ?? row.id ?? 'hostile', d: Number.isFinite(row.distance) ? row.distance : Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z) }))
		.filter((row) => Number.isFinite(row.d)).sort((a, b) => a.d - b.d)[0];
	return near ? `${bare(String(near.type))} ${Math.round(near.d)} blocks away` : 'a hostile near';
}

/** Whether a block cell intersects the player's 0.6 x 1.8 hitbox (a block cannot be placed there). */
const overlapsBody = (body, cell) => cell.x < body.x + 0.3 && cell.x + 1 > body.x - 0.3 && cell.z < body.z + 0.3 && cell.z + 1 > body.z - 0.3
	&& cell.y < body.y + 1.8 && cell.y + 1 > body.y;

const FACES = [['up', 0, -1, 0], ['down', 0, 1, 0], ['north', 0, 0, 1], ['south', 0, 0, -1], ['west', 1, 0, 0], ['east', -1, 0, 0]];

/**
 * Cells within reach, outside the body, to place a block in, best first: on the ground beside the body, then against a
 * wall or ceiling. A sample lists few blocks underground (six in a dug pit), so a cell not seen as solid is a candidate
 * too; place_block's preferred face lets the server click whichever seen support face the cell has.
 */
// Full-cube block items: faces judged for one hold for a crafting table, furnace or sand placed the same way.
const FULL_CUBE_BASIS = /^(cobblestone|cobbled_deepslate|stone|deepslate|andesite|diorite|granite|tuff|blackstone|dirt|netherrack|end_stone|crafting_table|furnace|sand|red_sand|gravel|[a-z_]+_(planks|log|wood|stem|hyphae))$/;

export function placementCells(o, tried = new Set(), { ground = false, trail = [] } = {}) {
	const body = bodyAt(o);
	if (body === null) return [];
	// Cells the body itself stood in a moment ago are known air over a solid floor: the surest place, even where a
	// sample lists almost no blocks (a dug tunnel).
	const feetNow = `${Math.floor(body.x)},${Math.floor(body.y + 0.01)},${Math.floor(body.z)}`;
	const stood = [...new Set(trail)].filter((key) => key !== feetNow && !tried.has(key)).map((key) => { const [x, y, z] = key.split(',').map(Number); return { x, y, z }; })
		.filter((cell) => eyeDistance(body, cell) <= REACH - 0.4 && !overlapsBody(body, cell) && !(o.blocks ?? []).some((row) => row.x === cell.x && row.y === cell.y && row.z === cell.z && row.replaceable !== true))
		.map((cell) => ({ ...cell, face: 'up', score: -1 + Math.abs(Math.hypot(cell.x + 0.5 - body.x, cell.z + 0.5 - body.z) - 1.6) * 0.1 }));
	const at = new Map((o.blocks ?? []).map((row) => [`${row.x},${row.y},${row.z}`, row]));
	const solid = (row) => row !== undefined && row.replaceable !== true && !/(water|lava|air)$/.test(row.blockId);
	// Each seen block row lists the faces the body can click now to place into the cell beside it (placeableFaces, the
	// server's own reach and sight check). A cell whose seen supports all list no face toward it fails
	// NO_PLACEMENT_SUPPORT: 453 of 646 such failures placed a crafting table. A support row without the list says nothing.
	// A replaceable plant in the cell is clicked directly and needs no support face. Remembered rows' lists are from where
	// the body stood then, so they say nothing either.
	// The lists are judged for the held block item (cobblestone stands in when the hand holds none): a held sapling or
	// seeds list no face on stone, which says nothing about a full-cube station. Only a full-cube basis counts.
	const basis = o.coverage?.sections?.blocks;
	const fullCube = basis?.placeableFacesStandIn === true || FULL_CUBE_BASIS.test(bare(basis?.placeableFacesFor));
	const lists = fullCube && !(o.continuity?.rememberedSections ?? []).includes('blocks');
	const plant = (row) => row?.replaceable === true && !/(water|lava|air)$/.test(row.blockId);
	const support = (x, y, z) => {
		let seen = 0, unknown = false;
		const faces = [];
		for (const [name, ox, oy, oz] of FACES) {
			const row = at.get(`${x + ox},${y + oy},${z + oz}`);
			if (!solid(row)) continue;
			seen += 1;
			if (!lists || !Array.isArray(row.placeableFaces)) unknown = true;
			else if (row.placeableFaces.includes(name)) faces.push(name);
		}
		return { faces, shut: seen > 0 && !unknown && faces.length === 0 && !plant(at.get(`${x},${y},${z}`)) };
	};
	const feet = { x: Math.floor(body.x), y: Math.floor(body.y + 0.01), z: Math.floor(body.z) };
	const cells = [];
	for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) for (let dy = -1; dy <= 2; dy++) {
		const x = feet.x + dx, y = feet.y + dy, z = feet.z + dz;
		if (dx === 0 && dz === 0 && (dy === 0 || dy === 1)) continue;
		const row = at.get(`${x},${y},${z}`);
		if (tried.has(`${x},${y},${z}`) || solid(row) || /(water|lava)$/.test(row?.blockId ?? '')) continue;
		if (eyeDistance(body, { x, y, z }) > REACH - 0.4) continue;
		const clicks = support(x, y, z);
		if (clicks.shut) continue;
		const seen = FACES.map(([name, ox, oy, oz]) => ({ name, support: at.get(`${x + ox},${y + oy},${z + oz}`) })).find(({ support }) => solid(support));
		const below = solid(at.get(`${x},${y - 1},${z}`));
		if (ground && !below) continue;
		const d = Math.hypot(x + 0.5 - body.x, z + 0.5 - body.z);
		const score = (below ? 0 : seen ? 2 : 4) + Math.abs(dy) * 0.7 + Math.abs(d - 1.6) * 0.5 + (row === undefined ? 0.5 : 0);
		cells.push({ x, y, z, face: clicks.faces[0] ?? (below ? 'up' : seen?.name ?? 'up'), score });
	}
	const stoodKeys = new Set(stood.map((cell) => `${cell.x},${cell.y},${cell.z}`));
	const stoodOpen = stood.flatMap((cell) => { const clicks = support(cell.x, cell.y, cell.z); return clicks.shut ? [] : [{ ...cell, face: clicks.faces[0] ?? cell.face }]; });
	return [...stoodOpen, ...cells.filter((cell) => !stoodKeys.has(`${cell.x},${cell.y},${cell.z}`))].sort((a, b) => a.score - b.score);
}

export function placementCell(o, tried = new Set(), options = {}) {
	return placementCells(o, tried, options)[0] ?? null;
}

// The log to look for when none is in view: the one the biome grows (find watches for one block id).
const BIOME_LOGS = [[/cherry/, 'cherry_log'], [/mangrove/, 'mangrove_log'], [/jungle|bamboo/, 'jungle_log'], [/savanna/, 'acacia_log'],
	[/dark_forest/, 'dark_oak_log'], [/pale_garden/, 'pale_oak_log'], [/birch/, 'birch_log'], [/taiga|snowy|grove|old_growth/, 'spruce_log']];

/** The block find searches for: the need's own block, or for any log the one this biome grows (oak elsewhere). */
export function searchBlock(need, o) {
	if (need.blocks.length === 1 || !need.blocks.every((block) => /_(log|stem)$/.test(block))) return need.blocks[0];
	const biome = bare(o?.world?.biome ?? '');
	const grown = BIOME_LOGS.find(([pattern]) => pattern.test(biome))?.[1] ?? 'oak_log';
	return need.blocks.includes(grown) ? grown : need.blocks[0];
}

// A flood rejects an approach, never the ore or its vein. Keep only recent failures at the current
// footing; movement, an observed footing change, a world change or expiry makes it worth reconsidering.
const FLOODED_APPROACH_MS = 10 * 60_000;
const FLOODED_APPROACH_LIMIT = 32;
function approachContext(o) {
	const at = bodyAt(o), dimension = o.world?.dimension;
	if (!at || typeof dimension !== 'string') return null;
	const feet = [Math.floor(at.x), Math.floor(at.y), Math.floor(at.z)];
	const ground = (o.continuity?.rememberedSections ?? []).includes('blocks') ? [] : (o.blocks ?? [])
		.filter((b) => Math.abs(b.x - feet[0]) <= 1 && b.y >= feet[1] - 1 && b.y <= feet[1] + 1 && Math.abs(b.z - feet[2]) <= 1)
		.map((b) => [`${b.x},${b.y},${b.z}`, b.blockId]);
	return { key: JSON.stringify([o.world?.worldId ?? o.worldId ?? null, dimension, feet,
		o.player?.onGround ?? null, o.player?.inWater ?? null, o.player?.underWater ?? null]), ground };
}
function refreshApproaches(memory, o, now) {
	const context = approachContext(o);
	const ground = new Map(context?.ground ?? []);
	const kept = context === null ? [] : memory.filter((row) => row.context.key === context.key
		&& now >= row.at && now - row.at < FLOODED_APPROACH_MS
		&& !row.context.ground.some(([cell, block]) => ground.has(cell) && ground.get(cell) !== block));
	memory.splice(0, memory.length, ...kept);
	return context;
}
const floodedApproach = (budget, row) => budget?.approaches?.some((failed) => failed.source.x === row.x
	&& failed.source.y === row.y && failed.source.z === row.z && failed.source.blockId === row.blockId);

/** A source of the need in view now (sight, or a sighting the server keeps), nearest first, never one that failed. */
function inView(need, o, budget) {
	const at = bodyAt(o);
	if (at === null) return null;
	if (need.kind === 'kill') {
		const mobs = new Set(need.mobs.map(id));
		return (o.entities ?? []).filter((row) => mobs.has(row.type) && row.alive !== false && [row.x, row.y, row.z].every(Number.isFinite) && !unreachedHerd(budget, row))
			.map((row) => ({ x: row.x, y: row.y, z: row.z, mob: row.type, stableId: row.stableId, d: Math.hypot(row.x - at.x, row.y - at.y, row.z - at.z) }))
			.filter((row) => row.d <= 128).sort((a, b) => a.d - b.d)[0] ?? null;
	}
	const blocks = new Set(need.blocks.map(id));
	const radius = need.blocks.some((block) => ORE_BLOCKS.test(block)) ? ORE_RADIUS : SURFACE_RADIUS;
	const ore = need.blocks.some((block) => ORE_BLOCKS.test(block));
	// A kit top-up goes on to the next vein, never back to one this call already mined (it can still show a block or two).
	const rows = knownBlocks(o).filter((row) => blocks.has(row.blockId) && !budget?.failed?.has(`${row.x},${row.y},${row.z}`)
		&& !(budget?.topUp && budget.veins?.has(`${row.x},${row.y},${row.z}`))
		&& !caveLog(row.blockId, row.y, o?.world?.dimension, at.y) && !floodedApproach(budget, row));
	const vein = ore && budget?.unreached?.length > 0 ? sameVein(budget.unreached, rows) : new Set();
	// An ore whose way there (a long dig down) costs more than finding another is not a source to walk at (obtain-plan
	// seenRowCost against searchCost, the planner's own prices).
	const worthIt = (row) => !ore || !OBTAIN_COSTS || seenRowCost({ ...row, id: row.blockId }, o) <= searchCost(row.blockId);
	return rows.filter((row) => !vein.has(row) && worthIt(row))
		.map((row) => ({ x: row.x, y: row.y, z: row.z, blockId: row.blockId, d: Math.hypot(row.x + 0.5 - at.x, (row.y - at.y) * 1.5, row.z + 0.5 - at.z) }))
		.filter((row) => row.d <= radius).sort((a, b) => a.d - b.d)[0] ?? null;
}

/**
 * An ore of the need the body saw earlier (the seen-resource memory: digs, looks, earlier trips) and has not failed at,
 * cheapest first, while going back to it costs less than finding one fresh (obtain-plan's seenRowCost against
 * searchCost, the planner's own prices). A player goes back to the vein it walked past before strip mining for a new
 * one, but not to a lone ore 60 blocks up its stairs. Never one a search
 * already found unreachable (missedPlaces), one this run failed at, or one whose approach flooded from here.
 */
function rememberedOre(need, o, budget, missed = []) {
	if (need.kind === 'kill' || !need.blocks?.some((block) => ORE_BLOCKS.test(block))) return null;
	const at = bodyAt(o);
	if (at === null) return null;
	const blocks = new Set(need.blocks.map(id));
	const unreachable = new Set(missed.filter((place) => place.why === UNREACHED).map((place) => `${place.x},${place.y},${place.z}`));
	const rows = (o.seenResources ?? []).filter((row) => row?.kind === 'block' && blocks.has(row.id) && [row.x, row.y, row.z].every(Number.isSafeInteger))
		.map((row) => ({ x: row.x, y: row.y, z: row.z, blockId: row.id, cost: seenRowCost(row, o) }))
		.filter((row) => row.cost < searchCost(row.blockId) && !budget?.failed?.has(`${row.x},${row.y},${row.z}`) && !unreachable.has(`${row.x},${row.y},${row.z}`) && !floodedApproach(budget, row));
	// A vein joined to an ore this run or an earlier search could not reach is that same vein: never walked back to.
	const bad = [...(budget?.unreached ?? []), ...missed.filter((place) => place.why === UNREACHED)];
	const vein = bad.length > 0 ? sameVein(bad, rows) : new Set();
	return rows.filter((row) => !vein.has(row))
		.map((row) => ({ ...row, remembered: true, d: Math.hypot(row.x + 0.5 - at.x, row.y - at.y, row.z + 0.5 - at.z) }))
		.sort((a, b) => a.cost - b.cost)[0] ?? null;
}

/** Remembered ores of the need that cost more to reach than a fresh search: find's known-place trips skip them too. */
function pricedOutOres(need, o) {
	if (need.kind === 'kill' || !need.blocks?.some((block) => ORE_BLOCKS.test(block))) return [];
	const blocks = new Set(need.blocks.map(id));
	return (o.seenResources ?? []).filter((row) => row?.kind === 'block' && blocks.has(row.id) && [row.x, row.y, row.z].every(Number.isSafeInteger)
		&& !(seenRowCost(row, o) < searchCost(row.id))).slice(0, 16).map((row) => ({ x: row.x, y: row.y, z: row.z }));
}

/** A mob near a herd a walk could not get within hunting reach of (budget.herds): not one to walk at again. */
const unreachedHerd = (budget, row) => (budget?.herds ?? []).some((herd) => Math.hypot(herd.x - row.x, herd.z - row.z) <= HUNT_RADIUS
	&& !(Number.isFinite(herd.y) && Number.isFinite(row.y) && Math.abs(herd.y - row.y) > 8));

/**
 * Where a source of the need is: { x, y, z, blockId } for a block, { x, y, z, mob } for a mob, or null with the
 * search's own result in budget.lastSearch. What is in view comes first; anything else is find's search (body.search,
 * find-search.mjs searchFor): look round, remembered places, walking legs, digging to the ore's depth, water, inside
 * obtain's remaining time.
 */
export async function locate(need, body, { budget, timeoutMs }) {
	const o = await body.observe();
	const seen = inView(need, o, budget);
	if (seen) return seen;
	const remembered = rememberedOre(need, o, budget, body.missedPlaces?.() ?? []);
	if (remembered) return remembered;
	// Do not send find toward the only currently seen ore via the same rejected approach.
	if (knownBlocks(o).some((row) => need.blocks?.includes(bare(row.blockId)) && floodedApproach(budget, row))) {
		budget.lastSearch = { reasonCode: 'OBTAIN_APPROACH_FLOODED', message: 'seen ore flooded from this footing; change approach before reconsidering' };
		return null;
	}
	if (typeof body.search !== 'function' || timeoutMs < 5_000) return null;
	const main = need.kind === 'kill' ? null : searchBlock(need, o);
	const target = need.kind === 'kill' ? { mob: id(need.mobs[0]) }
		: { block: id(main), ...(need.blocks.length > 1 && need.blocks.every((block) => /_(log|stem)$/.test(block)) ? { also: need.blocks.filter((block) => block !== main).slice(0, 8).map(id) } : {}) };
	const skip = pricedOutOres(need, o);
	if (skip.length > 0) target.skip = skip;
	const result = await body.search(target, { timeoutMs: Math.min(MAX_FIND_TIMEOUT_MS, timeoutMs) });
	budget.lastSearch = result;
	const at = result?.find?.seen;
	if (result?.reasonCode !== 'FIND_SEEN' || !at || ![at.x, at.y, at.z].every(Number.isFinite) || budget.failed.has(`${at.x},${at.y},${at.z}`)) return null;
	if (need.kind === 'kill') {
		if (unreachedHerd(budget, at)) return null;
		// The found mob's identity from a fresh look (its row nearest the sighting), so a hunt's walk-up can tell it apart
		// from others of its kind.
		const near = ((await body.observe()).entities ?? []).filter((row) => row?.type === at.id && typeof row.stableId === 'string' && [row.x, row.z].every(Number.isFinite))
			.map((row) => ({ row, d: Math.hypot(row.x - at.x - 0.5, row.z - at.z - 0.5) })).filter(({ d }) => d <= 4).sort((a, b) => a.d - b.d)[0]?.row;
		return { x: at.x + 0.5, y: at.y, z: at.z + 0.5, mob: at.id, ...(near ? { stableId: near.stableId } : {}) };
	}
	const fresh = await body.observe();
	const source = { x: at.x, y: at.y, z: at.z, blockId: at.id };
	return inView(need, fresh, budget) ?? (floodedApproach(budget, source) ? null : source);
}

/**
 * Runs obtain to its end. body: { observe(), act(actionType, args), mine(args), moveTo(args), gather(args),
 * survey(include), stopped(), interrupted(), note(text) }. Returns { state, reasonCode, message, held, ... }.
 */
export async function runObtain({ item, count = 1, timeoutMs = OBTAIN_DEFAULT_TIMEOUT_MS }, rawBody, { index = howtoIndex(), now = Date.now, locate: find = locate, placed = [], loads = [], approaches = [], looted = { opened: [], searched: [], structures: [], misses: {} } } = {}) {
	looted.misses ??= {};
	looted.doors ??= [];
	// The deadline holds everywhere: every body call's own timeout and a wait's duration end by it, and past it nothing
	// more is dispatched (cleanup alone gets a short grace to pick up what was placed).
	const deadline = now() + timeoutMs;
	const CLEANUP_GRACE_MS = 30_000;
	let cleaning = false, checkingCleanup = false, cleanupObservationFailed = false;
	const left = () => deadline + (cleaning ? CLEANUP_GRACE_MS : 0) - now();
	const cap = (args) => {
		if (Number.isFinite(args?.timeoutMs)) return { ...args, timeoutMs: Math.max(1_000, Math.min(args.timeoutMs, left())) };
		if (Number.isFinite(args?.durationMs)) return { ...args, durationMs: Math.max(1_000, Math.min(args.durationMs, left())) };
		return args;
	};
	// An action still running when danger interrupted (the runtime keeps it for the model) is handed back with its handle.
	let running = null, danger = null, fillToolStop = null, capacityStop = null, nightStop = null, walkingOn = false;
	// The fork the coordinator stopped this run for ({reasonCode, message}), unless obtain found danger of its own: the
	// run then ends with the fork's code, and the legs it cut short are not read as danger.
	const forkStop = () => (danger === null ? rawBody.forkStop?.() ?? null : null);
	// danger came from a leg's own LOW_HEALTH stop: it halts the run like danger but is handed back as LOW_HEALTH.
	let lowLeg = false;
	let materialsKeep = new Set();
	// The hostile kind a hunt is walking up to (a spider for string): its own approach stop is the arrival, not danger.
	let quarry = null;
	const seen = async (promise) => {
		const result = await promise;
		if (result?.state === 'RUNNING' && typeof result.actionId === 'string') running = result;
		if (danger === null && forkStop() === null && isDanger(result, result?.reasonCode === 'HOSTILE_NEAR' ? withoutQuarry(await rawBody.observe().catch(() => null), quarry) : null)) {
			danger = `${result.reasonCode}: ${String(result.message ?? '').slice(0, 160)}`;
			lowLeg = result.reasonCode === 'LOW_HEALTH';
		}
		return result;
	};
	// The last cells the body stood in (feet), newest last: where a table or furnace surely fits.
	const trail = [];
	// The last place the body stood out of the water: the way back out once a bucket is filled.
	let lastDry = null;
	// lastDry is from before a find search: only obtain's own observes refresh it, and a search's legs can carry the body
	// hundreds of blocks from it. Other moves (a walk to water) start from a spot observed, so it stays a way back.
	let dryBeforeSearch = false;
	const observe = async () => {
		let o;
		try { o = await rawBody.observe(); }
		catch (error) { if (checkingCleanup) cleanupObservationFailed = true; throw error; }
		if (checkingCleanup) {
			if (o == null) cleanupObservationFailed = true;
			danger ??= bodyDanger(o);
		}
		refreshApproaches(approaches, o, now());
		const at = bodyAt(o);
		if (at && o.player?.onGround !== false && o.player?.inWater !== true && o.player?.underWater !== true) { lastDry = at; dryBeforeSearch = false; }
		if (at && o.player?.onGround !== false) {
			const key = `${Math.floor(at.x)},${Math.floor(at.y + 0.01)},${Math.floor(at.z)}`;
			if (trail.at(-1) !== key) { trail.push(key); if (trail.length > 24) trail.shift(); }
		}
		return o;
	};
	// Once danger (or a fork) stopped the body, nothing more is dispatched: every loop (search legs, digging) ends at its
	// next move.
	const halted = () => ({ state: 'INTERRUPTED', reasonCode: forkStop()?.reasonCode ?? 'DANGER' });
	const expired = { state: 'TIMED_OUT', reasonCode: 'OBTAIN_TIMEOUT' };
	const unavailable = { state: 'FAILED', reasonCode: 'OBSERVATION_UNAVAILABLE' };
	const cleanupStopped = (o) => {
		if (o == null) cleanupObservationFailed = true;
		danger ??= bodyDanger(o);
		return body.interrupted() || body.stopped();
	};
	const nightRefused = { state: 'FAILED', reasonCode: 'NIGHT' };
	// How far gather's own walks can take the body between targets (NativeToolRuntime gathers within 32 blocks).
	const GATHER_WALK = 32;
	const errandStop = async (type, args) => {
		if (nightStop !== null) return nightRefused;
		const o = await observe();
		// A fresh observation yields: preserve cancellation and the deadline before dispatching after it.
		if (danger !== null || rawBody.interrupted() || rawBody.stopped()) return halted();
		if (left() <= 0) return expired;
		// A walk to water already under way keeps on as its next leg when night falls, as the one long walk did.
		const night = type === undefined || walkingOn ? null : nightMoveStop(o, type, args, { openSky: typeof rawBody.openSky === 'function' ? rawBody.openSky() : null });
		if (night !== null) { nightStop = night; step(`not now: ${night}`); return nightRefused; }
		if (blazeBlocksErrand(o) === null) return null;
		danger = 'blaze exposure: stay in cover or choose combat before resource travel';
		return halted();
	};
	const guard = async (call, errand = false, type, args) => {
		if (checkingCleanup && cleanupStopped(await observe().catch(() => null))) return halted();
		if (danger !== null || rawBody.interrupted() || rawBody.stopped()) return halted();
		if (capacityStop !== null && !cleaning) return { state: 'FAILED', reasonCode: 'INVENTORY_FULL' };
		if (cleanupObservationFailed) return unavailable;
		if (left() <= 0) return expired;
		if (errand) { const stopped = await errandStop(type, args); if (stopped !== null) return stopped; }
		const result = await seen(call());
		if (checkingCleanup) cleanupStopped(await observe().catch(() => null));
		return result;
	};
	const body = { ...rawBody, observe, interrupted: () => danger !== null || rawBody.interrupted(), stopped: () => rawBody.stopped() || left() <= 0 || fillToolStop !== null || capacityStop !== null || nightStop !== null || cleanupObservationFailed,
		act: (type, args) => type === 'dig_to' ? withMiningRoom(() => guard(() => rawBody.act(type, cap(args)), true, type, args)) : guard(() => rawBody.act(type, cap(args)), ['travel_to', 'navigate_to', 'dig_to', 'mine_vein'].includes(type), type, args),
		mine: (args) => withMiningRoom(() => guard(() => rawBody.mine(cap(args)))),
		// Night check for these too (review of #117): a walk to a point, and gather's own walks between trees or blocks,
		// which can reach the whole gather radius (32 blocks) on open ground.
		moveTo: (args) => guard(() => rawBody.moveTo(cap(args)), true, 'travel_to', args),
		gather: (args) => guard(() => rawBody.gather(cap(args)), true, 'travel_to', { distance: Number.isFinite(args?.radius) ? args.radius : GATHER_WALK }),
		// find's search, inside obtain's time; its danger stop is obtain's danger, its leg still running is handed back.
		search: rawBody.search && (async (target, options) => {
			if (danger !== null) return halted();
			if (cleanupObservationFailed) return unavailable;
			if (left() <= 0) return expired;
			{ const stopped = await errandStop(); if (stopped !== null) return stopped; }
			const result = await rawBody.search(target, { ...options, timeoutMs: Math.max(5_000, Math.min(options.timeoutMs, left())) });
			dryBeforeSearch = lastDry !== null;
			if (result?.reasonCode === 'FIND_NIGHT' && nightStop === null) nightStop = String(result.message ?? 'night').replace(/\. Covered in .*$/, '');
			// A search a fork stopped ends with the fork's code (the loop top), not as danger.
			const fork = forkStop() !== null;
			if (!fork && result?.reasonCode === 'FIND_DANGER' && danger === null) {
				// A find leg's own LOW_HEALTH stop is handed back as LOW_HEALTH, as a gather leg's is (seen()).
				lowLeg = result.find?.stopCode === 'LOW_HEALTH';
				danger = `find: ${String(result.message ?? '').replace(lowLeg ? /^Stopped for danger: / : /^$/, '').slice(0, 160)}`;
			}
			if (result?.state === 'RUNNING' && typeof result.actionId === 'string') { running = result; if (!fork) danger ??= 'find: danger stopped the search'; }
			return result;
		}) };
	const asked = shortId(String(item).trim().toLowerCase().replace(/[\s-]+/g, '_'));
	const fluid = FILLS[asked] ?? null;
	const target = fluid !== null ? { ids: [asked], label: asked } : resolveObtainItem(item, index);
	if (target.ids.length === 0) return { state: 'FAILED', reasonCode: 'NO_SUCH_ITEM', message: `No item named ${item} in the game data${target.candidates?.length ? `; did you mean ${target.candidates.slice(0, 5).join(', ')}?` : ''}` };
	const startedAt = now();
	// placed is the caller's list, kept across calls: a call that danger interrupted leaves its stations to the next.
	// loads, the same: furnaces a smelt loaded and danger left before the output was taken ({x, y, z, dimension,
	// output, want, readyAt}). The next call takes that output first, before planning from the inventory.
	const everPlaced = [], removed = new Set(placed.filter((station) => station.drop).map((station) => `${station.x},${station.y},${station.z}`));
	// Why the body is still in the water after a fill (the walk back out failed or had nowhere to go), or null.
	let wet = null;
	const log = [];
	const failures = new Map();
	// Blocks and mobs of needs out of tries: seen, but no source the body reached. The plan no longer counts them as
	// seen, so it turns to another way (planks for fuel when the coal ore it saw stays out of reach).
	const spent = new Set();
	const budget = { failed: new Set(), dug: 0, herds: [], approaches, veins: new Set(), passed: new Set(), doorsSkipped: [] };
	const rememberFlood = (result, source, o) => {
		if (result?.reasonCode !== 'TUNNEL_FLOODED' || !['FAILED', 'INTERRUPTED'].includes(result.state)
			|| result.executionStarted !== true || result.physicalAttempted !== true || rawBody.stopped()) return false;
		const context = refreshApproaches(approaches, o, now());
		if (context === null) return false;
		approaches.push({ source: { x: source.x, y: source.y, z: source.z, blockId: source.blockId },
			context, at: now(), reasonCode: result.reasonCode, actionId: result.actionId ?? null });
		if (approaches.length > FLOODED_APPROACH_LIMIT) approaches.splice(0, approaches.length - FLOODED_APPROACH_LIMIT);
		return true;
	};
	// held: what the plan may use (the next pickaxe's sticks kept back); counts: everything in the inventory.
	let held = new Map(), counts = new Map(), have = 0, startHave = null, rounds = 0, origin = null, noSurface = null, coalShort = false;
	const label = target.label;
	const food = target.ids.length > 0 && target.ids.every((member) => FOODS.has(bare(member)));
	// A non-food obtain recovers at low health itself; while it recovers (active) the coordinator folds the low-health wakes.
	if (!food) rawBody.recovering?.('armed');
	// The food hunt's flee line, set once from the health at the first hunt: later rounds never lower it.
	let foodFlee = null, lastWeighed = null, kitTrip = false, lastPlan = null;
	let lastFailure = null, fuelDiagnostic = null, approachStop = null;
	const fuelMembers = (group) => (typeof group === 'string' ? index.tags[group] ?? [] : group);
	const smeltsPer = (itemId) => (index.fuels?.[bare(itemId)] ?? 0) / 200;
	const fuelCover = (counts) => Math.max(0, ...FUEL_GROUPS.map((group) => Math.max(0, ...fuelMembers(group).map((member) => Math.floor(Math.min(64, counts.get(member) ?? 0) * smeltsPer(member))))));
	const act = async (type, args) => {
		let result;
		try { result = await body.act(type, args); }
		catch (error) {
			// A move the tool refuses comes back from the production body as a FAILED result (native-tool-runtime's obtain
			// run); a body that throws the refusal instead is taken the same way, so the step's why names it.
			if (error?.code !== 'INVALID_MINECRAFT_TOOL_ARGUMENTS') throw error;
			result = { state: 'FAILED', reasonCode: error.code, message: String(error?.message ?? error).slice(0, 300) };
		}
		if (result?.state !== 'SUCCEEDED') lastFailure = `${type} ${result?.reasonCode ?? result?.state ?? 'failed'}${result?.message ? `: ${String(result.message).slice(0, 160)}` : ''}`;
		return result;
	};
	const fail = (key) => { failures.set(key, (failures.get(key) ?? 0) + 1); return failures.get(key); };
	// Smelt outputs whose held input was loaded early this call (once each: the rest then smelts as usual).
	const overlapped = new Set();
	let spareFirst = false;
	const step = (text) => { log.push(text); if (log.length > 40) log.shift(); body.note(text); };
	const end = async (state, reasonCode, why, extra = {}) => {
		let before = null;
		if (!['INTERRUPTED'].includes(state)) {
			const fresh = await rawBody.observe().catch(() => null);
			before = fresh?.player?.health;
			if (fresh === null && placed.length > 0) cleanupObservationFailed = true;
			danger ??= bodyDanger(fresh);
			cleaning = true;
			await cleanup().catch(() => {});
		}
		const o = await rawBody.observe().catch(() => null);
		if (o) { held = heldCounts(o); have = target.ids.reduce((sum, member) => sum + (held.get(member) ?? 0), 0); }
		// The ending is decided after cleanup, from what is true now: danger, damage or death during cleanup, health at or
		// under the low-health line, or the item lost, is never reported as obtained.
		const health = o?.player?.health;
		const hurt = (lowLeg ? null : danger) ?? bodyDanger(o) ?? (o?.player?.dead || Number.isFinite(health) && health <= 0 ? 'died'
			: Number.isFinite(health) && Number.isFinite(before) && health < before ? `health ${before} -> ${health} while picking up the stations` : null);
		const fork = hurt === null ? forkStop() : null;
		if (rawBody.stopped()) {
			state = 'CANCELLED'; reasonCode = 'CANCELLED'; why = 'Cancelled';
		} else if (hurt !== null || rawBody.interrupted() && fork === null) {
			state = 'INTERRUPTED'; reasonCode = 'DANGER';
			why = `${why}, then danger while picking up the stations (${hurt ?? 'raw interruption'}); decide, then call obtain again`;
		} else if (fork !== null) {
			if (reasonCode !== fork.reasonCode) why = `${why}, then stopped (${fork.message ?? fork.reasonCode}); decide, then call obtain again`;
			state = 'INTERRUPTED'; reasonCode = fork.reasonCode;
		} else if (reasonCode === 'LOW_HEALTH' || !food && Number.isFinite(health) && health <= LOW_HEALTH) {
			// Low health alone is obtain's own hand-back to recover, not danger: a low-health stop keeps its code and line.
			if (reasonCode !== 'LOW_HEALTH') why = `${why}, but health is ${health}, at or under ${LOW_HEALTH}; recover, then call obtain again`;
			state = 'INTERRUPTED'; reasonCode = 'LOW_HEALTH';
		} else if (cleanupObservationFailed) {
			state = 'FAILED'; reasonCode = 'OBSERVATION_UNAVAILABLE';
			why = 'Stopped station cleanup because a fresh safety observation was unavailable; decide, then call obtain again';
		}
		if (state === 'SUCCEEDED' && (o === null || have < count)) {
			state = 'FAILED'; reasonCode = 'OBTAIN_LOST';
			why = `${why}, but the inventory now holds ${o === null ? 'an unknown number' : have} (a sample after cleanup)`;
		}
		const swimming = fluid !== null && (o?.player?.inWater === true || o?.player?.underWater === true);
		const at = swimming ? bodyAt(o) : null;
		if (state === 'SUCCEEDED' && swimming) why = `${why}, but the body is still in the ${fluid}${at ? ` at ${Math.floor(at.x)},${Math.floor(at.y)},${Math.floor(at.z)}` : ''}`
			+ ` (${wet ?? 'the walk back out did not get it out'}); get onto dry ground first: find and dig_to refuse from the ${fluid}`;
		if (placed.length > 0) why += `; workstation recovery incomplete: ${placed.slice(0, 3).map((station) => `${station.kind} ${station.drop ? 'drop' : 'placed'} at ${station.x},${station.y},${station.z}`).join('; ')}`;
		const seconds = Math.round((now() - startedAt) / 1000);
		return { state, reasonCode, held: have, asked: count, item: label, seconds, rounds,
			message: `${why}. Holding ${have} ${label} (asked ${count}) after ${seconds} s and ${rounds} round(s)`,
			steps: fuelDiagnostic === null ? log.slice(-12) : [...log.slice(-11), fuelDiagnostic], stations: { placed: everPlaced, left: placed.length, ...(placed.length ? { pending: placed.map(({ kind, x, y, z, drop }) => ({ kind, x, y, z, state: drop ? 'dropped' : 'placed' })) } : {}), ...(loads.length ? { loaded: loads.length } : {}) },
			...(swimming ? { inWater: true } : {}), ...extra, ...handle() };
	};
	// Workstations this run placed go back into the inventory before it walks away and at the end.
	const cleanup = async () => {
		checkingCleanup = true;
		try {
			for (let pass = 0; pass < 2 && placed.length > 0; pass++) for (const station of [...placed]) {
				if (body.interrupted() || body.stopped()) return;
				const o = await body.observe();
				if (cleanupStopped(o)) return;
				const at = bodyAt(o);
				const dimension = o.world?.dimension ?? null;
				// A station in another dimension or out of walking reach (after a death, a long trip) is given up for good:
				// going back for it costs more than a new one.
				if (at === null || station.dimension && dimension && station.dimension !== dimension
					|| Math.hypot(station.x + 0.5 - at.x, station.y - at.y, station.z + 0.5 - at.z) > STATION_WALK) {
					step(`leave the ${station.kind} at ${station.x},${station.y},${station.z}: out of reach`);
					placed.splice(placed.indexOf(station), 1);
					continue;
				}
				// A sample lists few blocks (none behind the body in a tunnel), so a station not listed may still stand:
				// go back and break it; break_block's expected block says whether it was there.
				if (eyeDistance(at, station) > REACH) {
					await body.moveTo({ x: station.x + 0.5, y: station.y, z: station.z + 0.5, tolerance: 2, timeoutMs: 20_000 });
					const fresh = await body.observe();
					if (cleanupStopped(fresh)) return;
					const after = bodyAt(fresh);
					if (!after || eyeDistance(after, station) > REACH + 1) {
						step(`leave the ${station.kind} at ${station.x},${station.y},${station.z}: could not reach it`);
						placed.splice(placed.indexOf(station), 1);
						continue;
					}
				}
				const fits = (sample) => {
					if (!Array.isArray(sample.inventory?.items) || sample.continuity?.rememberedSections?.includes('inventory')) return null;
					const rows = (sample.inventory?.items ?? []).filter((row) => row.count > 0 &&
						(Number.isSafeInteger(row.slot) && row.slot >= 0 && row.slot < 36 || row.slot === 'mainhand'));
					return rows.length < 36 || rows.some((row) => bare(row.itemId) === station.kind && row.count < 64);
				};
				let broken = null;
				let heldBefore;
				if (!station.drop) {
					let capacity = await body.observe();
					if (cleanupStopped(capacity)) return;
					if (!fits(capacity)) {
						if (fits(capacity) === false) await makeRoom(new Set([...materialsKeep, ...target.ids, ...OBTAIN_STATIONS]), fits);
						capacity = await body.observe();
						if (cleanupStopped(capacity)) return;
						if (!fits(capacity)) {
							step(`leave the ${station.kind} placed: inventory has no known room for it`);
							return;
						}
					}
					heldBefore = heldCounts(capacity).get(station.kind) ?? 0;
					step(`pick up the ${station.kind} at ${station.x},${station.y},${station.z}`);
					broken = await act('break_block', { x: station.x, y: station.y, z: station.z, expectedBlockId: id(station.kind), timeoutMs: 15_000 });
					if (broken?.state === 'SUCCEEDED') station.drop = true;
					if (cleanupStopped(await body.observe())) return;
					const gone = station.drop || /AIR|MISMATCH|NOT_FOUND|NO_LONGER/.test(String(broken?.reasonCode ?? ''));
					if (!gone) {
						if (pass === 0) continue;
						step(`could not pick up the ${station.kind} at ${station.x},${station.y},${station.z}: ${broken?.reasonCode ?? 'failed'}; leave it`);
						placed.splice(placed.indexOf(station), 1);
						continue;
					}
				} else {
					const fresh = await body.observe();
					if (cleanupStopped(fresh) || fits(fresh) === null) return;
					heldBefore = heldCounts(fresh).get(station.kind) ?? 0;
				}
				removed.add(`${station.x},${station.y},${station.z}`);
				if (station.drop) {
					// Q-dropped junk can return during a slow break. Reclaim room at the pickup, then take only the station.
					const room = async () => {
						let fresh = await body.observe();
						if (cleanupStopped(fresh)) return false;
						if ((heldCounts(fresh).get(station.kind) ?? 0) > heldBefore) return false;
						if (fits(fresh) === false) await makeRoom(new Set([...materialsKeep, ...target.ids, ...OBTAIN_STATIONS]), fits);
						fresh = await body.observe();
						return !cleanupStopped(fresh) && fits(fresh) === true;
					};
					await pickUpNear(station, [station.kind], 4, false, room);
					const fresh = await body.observe();
					if (cleanupStopped(fresh)) return;
					if (fresh.continuity?.rememberedSections?.includes('inventory') || !Array.isArray(fresh.inventory?.items)
						|| (heldCounts(fresh).get(station.kind) ?? 0) <= heldBefore) {
						step(`leave the ${station.kind} drop at ${station.x},${station.y},${station.z}: not confirmed in inventory`);
						return;
					}
				}
				placed.splice(placed.indexOf(station), 1);
				for (const load of loads.filter((one) => one.x === station.x && one.y === station.y && one.z === station.z)) loads.splice(loads.indexOf(load), 1);
				if (station.drop) await pickUpNear(station, ['coal', 'charcoal', 'raw_iron', 'iron_ingot', ...OBTAIN_STATIONS], 4);

			}
		} finally { checkingCleanup = false; }
	};
	const pickUpNear = async (center, ids, radius, any = false, room = null) => {
		let looked = false;
		for (let pass = 0; pass < 7; pass++) {
			const o = await body.observe();
			const wanted = new Set(ids.map(id));
			const drop = (o.items ?? []).filter((row) => (any || wanted.has(row.itemId)) && typeof row.stableId === 'string' && Math.hypot(row.x - center.x - 0.5, row.z - center.z - 0.5) <= radius
				&& Math.abs(row.y - center.y) <= 4 && !budget.failed.has(row.stableId))[0];
			if (!drop && !looked && pass === 0 && !body.interrupted() && !body.stopped()) {
				looked = true;
				await act('look_at', { x: center.x + 0.5, y: center.y + 0.5, z: center.z + 0.5 });
				continue;
			}
			if (!drop) return;
			if (room !== null && !await room()) return;
			let result = await act('pick_up_item', { targetSelector: drop.stableId, timeoutMs: 30_000 });
			const at = bodyAt(o);
			if (result?.state !== 'SUCCEEDED' && UNREACHED_DROP.has(result?.reasonCode) && o.player?.skyOpen === false && at !== null
				&& Math.hypot(drop.x - at.x, drop.z - at.z) <= DROP_DIG && Math.abs(drop.y - at.y) <= 2 && !body.interrupted() && !body.stopped()) {
				step(`dig to the ${bare(drop.itemId)} drop at ${Math.floor(drop.x)},${Math.floor(drop.y)},${Math.floor(drop.z)}`);
				await act('dig_to', { pattern: 'tunnel', x: Math.floor(drop.x), z: Math.floor(drop.z), maxBlocks: 2 * Math.ceil(DROP_DIG), throughCaves: 'small', timeoutMs: 20_000 });
				if (!body.interrupted() && !body.stopped()) result = await act('pick_up_item', { targetSelector: drop.stableId, timeoutMs: 15_000 });
			}
			if (result?.state !== 'SUCCEEDED') budget.failed.add(drop.stableId);
		}
	};
	// An ore the body could not reach: it and the cells of its vein the body knows go out of obtain's picks
	// (budget.unreached) and out of find's sightings (missPlace), or another search points straight back at it.
	const outOfReach = async (need, where) => {
		const cell = { x: where.x, y: where.y, z: where.z };
		(budget.unreached ??= []).push(cell);
		const blocks = new Set(need.blocks.map(id));
		const vein = [...sameVein([cell], knownBlocks(await body.observe()).filter((row) => blocks.has(row.blockId)))]
			.filter((row) => row.x !== cell.x || row.y !== cell.y || row.z !== cell.z);
		for (const row of [cell, ...vein].slice(0, VEIN_MISSES)) body.missPlace?.({ x: row.x, y: row.y, z: row.z }, 'unreachable');
	};
	const gaveUp = (where, result) => {
		if (where.dug || typeof where.blockId !== 'string' || result?.state === 'INTERRUPTED' || NOT_REACH.has(result?.reasonCode) || body.interrupted() || body.stopped()) return;
		body.missPlace?.({ x: where.x, y: where.y, z: where.z, blockId: id(where.blockId) }, UNREACHED);
	};
	const veinRest = async (need, where, total, heldBefore, mined) => {
		const count = () => body.observe().then((o) => heldOf(need.accept.join('|'), heldCounts(o), index));
		const have = await count();
		const minedCount = Number(/mined: (\d+)/.exec(String(mined?.message ?? ''))?.[1] ?? 0);
		if (have >= total || have - heldBefore >= minedCount) return;
		step(`into the mined ${bare(where.blockId)} pocket at ${where.x},${where.y},${where.z} for its drops`);
		// Into the pocket itself, not its rim: drops at the bottom of a narrow pocket lie behind its wall from the rim and
		// never show in sight (22 Nov rooms: 2 raw iron 2 blocks down, unlisted, 3 of 10 runs searched anew). Stepping into
		// the cell drops the body onto them; it picks up what it touches. Tolerance 1 counted the rim as arrived.
		// Never into a pocket with lava or water known in it or under it; travel itself steps down only onto a floor it has
		// seen, so an unseen bottom is no step either.
		const before = await body.observe();
		const rim = bodyAt(before);
		// Only what the body would land in or on counts: the first known block down the pocket's column (a sample never
		// lists air). Water further down, under the pocket's solid floor, is no reason to stay out.
		const below = knownBlocks(before).filter((row) => row.x === where.x && row.z === where.z && row.y <= where.y && row.y >= where.y - 4
			&& !ORE_BLOCKS.test(bare(row.blockId)))
			.sort((a, b) => b.y - a.y)[0];
		const wet = below !== undefined && /(^|:)(lava|water)$/.test(below.blockId);
		if (wet || rim === null) { await pickUpNear(where, need.accept, 6); return; }
		// navigate_to: travel_to takes no tolerance under 1 block, which is the rim again.
		// The pocket's floor is where the last of the vein was, one or two below its top cell: the first standable one.
		for (let down = 0; down <= 2; down++) {
			const went = await act('navigate_to', { x: where.x + 0.5, y: where.y - down, z: where.z + 0.5, tolerance: 0.4, timeoutMs: 20_000 });
			if (went?.state === 'SUCCEEDED' || went?.reasonCode !== 'NO_STANDABLE_PATH' || body.interrupted() || body.stopped()) break;
		}
		if (body.interrupted() || body.stopped()) return;
		await pickUpNear(where, need.accept, 6);
	};
	// A table or furnace to use: one in reach, else one within walking reach (walk to it), else place the held one.
	const ensureStation = async (kind) => {
		let o = await body.observe();
		const near = nearStation(o, kind, placed, removed);
		const at = bodyAt(o);
		if (near && at) {
			if (eyeDistance(at, near) <= REACH) return near;
			step(`walk to the ${kind} at ${near.x},${near.y},${near.z}`);
			await body.moveTo({ x: near.x + 0.5, y: near.y, z: near.z + 0.5, tolerance: 2, timeoutMs: 30_000 });
			o = await body.observe();
			const after = bodyAt(o);
			if (after && eyeDistance(after, near) <= REACH) return near;
		}
		if ((heldCounts(o).get(kind) ?? 0) === 0) return null;
		const tried = new Set();
		for (let round = 0; round < 2; round++) {
			// The full visible block list, not the sample's few rows: cells are judged on what is really around.
			const near = typeof body.blocksNear === 'function' ? await body.blocksNear() : [];
			const seenAround = near.length > 0 ? { ...o, blocks: [...near, ...(o.blocks ?? [])] } : o;
			for (const cell of placementCells(seenAround, tried, { trail }).slice(0, 8)) {
				tried.add(`${cell.x},${cell.y},${cell.z}`);
				const result = await act('place_block', { x: cell.x, y: cell.y, z: cell.z, face: cell.face, itemId: id(kind) });
				if (result?.state === 'SUCCEEDED') {
					step(`placed a ${kind} at ${cell.x},${cell.y},${cell.z}`);
					placed.push({ kind, x: cell.x, y: cell.y, z: cell.z, dimension: o.world?.dimension ?? null }); everPlaced.push({ kind, x: cell.x, y: cell.y, z: cell.z });
					removed.delete(`${cell.x},${cell.y},${cell.z}`);
					return cell;
				}
				if (body.stopped() || body.interrupted()) return null;
			}
			if (round === 1) break;
			step(`no cell here takes the ${kind}; step aside`);
			await act('travel_to', { yaw: Math.round((((o.player?.yaw ?? 0) + 180) % 360 + 360) % 360 - 180), distance: 3, tolerance: 1, timeoutMs: 15_000 });
			o = await body.observe();
		}
		return null;
	};
	const craft = async (op, times, o) => {
		let recipeId = op.recipeId, output = op.outputs[0];
		if (op.choices) {
			const choice = op.choices.find((c) => heldOf(c.input.join('|'), held, index) >= op.inputs[0].count / op.times);
			if (!choice) return false;
			recipeId = choice.recipeId; output = choice.output;
			times = Math.min(times, Math.floor(heldOf(choice.input.join('|'), held, index) / (op.inputs[0].count / op.times)));
		}
		const amount = times * op.yieldCount;
		const keep = new Set([...target.ids, bare(output), ...op.inputs.flatMap((input) => fuelMembers(input.spec.startsWith('#') ? input.spec : input.spec.split('|'))).map(bare)]);
		const once = async () => {
			if (op.station === 'inventory') {
				step(`craft ${amount} ${output}`);
				return act('craft_inventory', { recipeId: id(recipeId), count: amount, timeoutMs: 30_000 });
			}
			const table = await ensureStation('crafting_table');
			if (!table) return null;
			step(`craft ${amount} ${output} at the table`);
			return act('craft_table', { recipeId: id(recipeId), x: table.x, y: table.y, z: table.z, count: amount, timeoutMs: 30_000 });
		};
		let result = await once();
		if (result?.reasonCode === 'DESTINATION_FULL' && await makeRoom(keep) > 0) result = await once();
		return result?.state === 'SUCCEEDED';
	};
	// Q-drops up to ROOM_STACKS junk stacks (never one in keep), one fresh sample per drop; returns how many it dropped.
	const makeRoom = async (keep, fits = null) => {
		const dropped = [];
		while (dropped.length < ROOM_STACKS && !body.interrupted() && !body.stopped()) {
			const o = await body.observe();
			danger ??= bodyDanger(o);
			if (body.interrupted() || body.stopped()) break;
			if (fits !== null && fits(o) !== false) break;
			const selected = o?.inventory?.selectedSlot;
			const rows = (o?.inventory?.items ?? []).map((row) => ({ ...row, kind: bare(row.itemId), slotIndex: Number.isSafeInteger(row.slot) ? row.slot : row.slot === 'mainhand' && Number.isSafeInteger(selected) ? selected : null }))
				.filter((row) => row.slotIndex !== null && row.slotIndex >= 0 && row.slotIndex <= 35 && row.count > 0);
			const cobble = rows.filter((row) => COBBLE.has(row.kind)).reduce((sum, row) => sum + row.count, 0);
			const junk = rows.filter((row) => DISCARD.includes(id(row.kind)) && !keep.has(row.kind) && Number.isSafeInteger(row.count) && row.count <= 64
				&& (!COBBLE.has(row.kind) || cobble - row.count >= KEEP_COBBLE))
				.sort((a, b) => COBBLE.has(a.kind) - COBBLE.has(b.kind) || a.count - b.count)[0];
			if (!junk) break;
			if ((await act('drop_item', { slot: junk.slotIndex, count: junk.count }))?.state !== 'SUCCEEDED') break;
			dropped.push(`${junk.count} ${junk.kind}`);
		}
		if (dropped.length > 0) step(`inventory full: Q-dropped ${dropped.join(', ')}`);
		return dropped.length;
	};
	// Capacity is not a reach failure. Reuse the crafting junk policy, then retry the exact action once.
	const withMiningRoom = async (once) => {
		let result = await once();
		if (fluid !== null || cleaning || result?.reasonCode !== 'INVENTORY_FULL') return result;
		danger ??= bodyDanger(await body.observe());
		if (body.interrupted() || body.stopped()) return result;
		if (await makeRoom(materialsKeep) > 0 && !body.interrupted() && !body.stopped()) result = await once();
		if (result?.reasonCode === 'INVENTORY_FULL' && !body.interrupted() && !body.stopped()) {
			capacityStop = `Inventory capacity blocked mining or tunneling after junk recovery: ${String(result.message ?? 'INVENTORY_FULL').slice(0, 240)}`;
		}
		return result;
	};
	const smelt = async (op, times, wait = true) => {
		const furnace = await ensureStation('furnace');
		if (!furnace) return false;
		let o = await body.observe();
		const members = op.inputs[0].spec.startsWith('#') ? index.tags[op.inputs[0].spec] ?? [] : op.inputs[0].spec.split('|');
		const input = slotOf(o, members);
		if (!input) return false;
		const wanted = Math.min(times, input.count, 64);
		const stacks = FUEL_GROUPS.map((group) => slotOf(o, fuelMembers(group), input.slotIndex)).filter(Boolean)
			.map((row) => ({ row: { ...row, count: Math.min(row.count, held.get(bare(row.itemId)) ?? 0) }, per: smeltsPer(row.itemId) })).filter((fuel) => fuel.per > 0 && fuel.row.count > 0);
		const fuel = stacks.find((one) => Math.floor(one.row.count * one.per) >= wanted) ?? stacks.sort((a, b) => b.row.count * b.per - a.row.count * a.per)[0];
		if (!fuel) return false;
		const n = Math.max(1, Math.min(wanted, Math.floor(fuel.row.count * fuel.per)));
		const fuelCount = Math.min(fuel.row.count, Math.ceil(n / fuel.per));
		step(`smelt ${n} ${bare(input.itemId)} with ${fuelCount} ${bare(fuel.row.itemId)}`);
		const loaded = await act('furnace_transaction', { x: furnace.x, y: furnace.y, z: furnace.z, operation: 'load', inventorySlot: input.slotIndex, count: n,
			expectedItemId: input.itemId, fuelSlot: fuel.row.slotIndex, fuelCount, expectedFuelItemId: fuel.row.itemId, timeoutMs: 15_000 });
		if (loaded?.state !== 'SUCCEEDED') return false;
		const load = { x: furnace.x, y: furnace.y, z: furnace.z, dimension: o.world?.dimension ?? null, output: op.outputs[0], want: n * op.yieldCount, readyAt: now() + n * SMELT_MS };
		loads.push(load);
		if (!wait) return true;
		return (await collect(load)) > 0;
	};
	// Waits out a load and takes its output (up to 4 takes); the load stays listed while output is still in the furnace
	// and danger or the deadline cut the wait short, for the next call to take. Returns how many came out.
	const collect = async (load) => {
		let collected = 0;
		for (let wait = 0; wait < 4 && collected < load.want; wait++) {
			const rest = wait === 0 ? load.readyAt - now() + 1_000 : SMELT_MS;
			if (rest > 0) await waitWatching(Math.min(600_000, rest));
			if (danger !== null) break;
			const taken = await act('furnace_transaction', { x: load.x, y: load.y, z: load.z, operation: 'take_output', timeoutMs: 15_000 });
			const got = Number(/Collected (\d+)/.exec(String(taken?.message ?? ''))?.[1] ?? 0);
			collected += got;
			if (taken?.state !== 'SUCCEEDED' && got === 0 && !body.interrupted()) break;
			if (body.stopped()) break;
		}
		load.want -= collected;
		if (load.want <= 0 || danger === null && !body.interrupted() && !body.stopped()) loads.splice(loads.indexOf(load), 1);
		return collected;
	};
	const collectLoads = async () => {
		for (const load of [...loads]) {
			if (body.interrupted() || body.stopped()) return;
			const o = await body.observe();
			const at = bodyAt(o);
			const dimension = o.world?.dimension ?? null;
			const where = `${load.x},${load.y},${load.z}`;
			const away = at === null || load.dimension && dimension && load.dimension !== dimension
				|| Math.hypot(load.x + 0.5 - at.x, load.y - at.y, load.z + 0.5 - at.z) > STATION_WALK;
			if (!away && eyeDistance(at, load) > REACH) {
				step(`back to the furnace at ${where} for the ${bare(load.output)} left smelting`);
				await body.moveTo({ x: load.x + 0.5, y: load.y, z: load.z + 0.5, tolerance: 2, timeoutMs: 30_000 });
				if (body.interrupted() || body.stopped()) return;
			}
			const after = away ? null : bodyAt(await body.observe());
			if (after === null || eyeDistance(after, load) > REACH + 1) {
				step(`leave the ${bare(load.output)} in the furnace at ${where}: out of reach`);
				loads.splice(loads.indexOf(load), 1);
				continue;
			}
			step(`take the ${bare(load.output)} left in the furnace at ${where}`);
			await collect(load);
		}
	};
	const waitWatching = async (ms) => {
		const before = (await body.observe()).player?.health;
		for (let done = 0; done < ms && !body.interrupted() && !body.stopped(); done += WAIT_SLICE_MS) {
			await act('wait', { durationMs: Math.min(WAIT_SLICE_MS, ms - done) });
			const o = await body.observe();
			const health = o.player?.health;
			if (Number.isFinite(health) && Number.isFinite(before) && health < before) { danger ??= `health ${before} -> ${health} while waiting at the furnace`; return; }
			const unsafe = bodyDanger(o);
			if (unsafe !== null) { danger ??= unsafe; return; }
		}
	};
	// The right tool in hand: the best pickaxe with uses left goes to the hotbar (dig_to and mining use hotbar tools).
	const pickaxeToHotbar = async () => {
		const o = await body.observe();
		const selected = o.inventory?.selectedSlot;
		// Healthy before about to break, then the best tier, then the most uses left, then the one in hand: a near-broken
		// pickaxe earlier in the inventory never replaces a sound one in hand.
		const uses = (row) => (row.maxDamage > 0 ? row.maxDamage - (row.damage ?? 0) : Infinity);
		const rows = (o.inventory?.items ?? []).filter((row) => /_pickaxe$/.test(row.itemId ?? '') && uses(row) > 3)
			.map((row) => ({ ...row, uses: uses(row), rank: TOOL_TIERS.indexOf(bare(row.itemId).split('_')[0]), slotIndex: Number.isSafeInteger(row.slot) ? row.slot : row.slot === 'mainhand' ? selected : null }))
			.filter((row) => row.slotIndex !== null)
			.sort((a, b) => (b.uses >= LOW_USES) - (a.uses >= LOW_USES) || b.rank - a.rank || (b.uses === a.uses ? 0 : b.uses - a.uses) || (b.slotIndex === selected) - (a.slotIndex === selected));
		const best = rows[0];
		if (!best || best.slotIndex === selected) return;
		step(best.slotIndex < 9 ? `take the ${bare(best.itemId)} in hand` : `move the ${bare(best.itemId)} to the hotbar`);
		const into = best.slotIndex < 9 ? best.slotIndex : Number.isSafeInteger(selected) ? selected : 0;
		await act('select_tool', { sourceSlot: best.slotIndex, hotbarSlot: into, expectedItemId: best.itemId, minRemainingDurability: 3 });
	};
	// Trees and animals live on the surface: from down a mine, go back up the way the body came (retrace to where this
	// run started), or stair straight up, before looking for them. Searching sideways underground finds neither.
	// Returns null once the body is up (or the need is not a surface one), else why it could not get there. Up is open
	// sky over the body: altitude alone (a retrace ending under an overhang near the origin) is not.
	const up = (o) => bodyAt(o) !== null && o.player?.skyOpen !== false;
	const surfaceFirst = async (need) => {
		if (!(need.kind === 'kill' || need.blocks.some((block) => /_(log|stem)$/.test(block)))) return null;
		let o = await body.observe();
		if (bodyAt(o) === null || up(o)) return null;
		if (origin) {
			step(`back up to the surface for ${need.accept[0]}`);
			await act('travel_to', { x: origin.x, y: origin.y, z: origin.z, retrace: true, tolerance: 3, timeoutMs: 120_000 });
			if (body.interrupted() || body.stopped()) return null;
			o = await body.observe();
			if (up(o)) return null;
		} else step(`up toward the surface for ${need.accept[0]}`);
		for (let legs = 0; legs < CLIMB_LEGS; legs++) {
			const from = bodyAt(o);
			const climbed = await act('dig_to', { pattern: 'stairs_up', y: Math.floor(from.y) + CLIMB_LEG, maxBlocks: 80, throughCaves: 'small', timeoutMs: 120_000 });
			if (body.interrupted() || body.stopped()) return null;
			o = await body.observe();
			if (up(o)) return null;
			const at = bodyAt(o);
			if (at === null || at.y < from.y + 2) return `the climb to the surface stopped at y ${Math.floor(at?.y ?? from.y)} under cover (${climbed?.reasonCode ?? climbed?.state ?? 'no move'}${climbed?.message ? `: ${String(climbed.message).slice(0, 120)}` : ''})`;
		}
		return `still under cover after climbing ${CLIMB_LEGS * CLIMB_LEG} blocks`;
	};
	// New ground before the next search: a tunnel leg underground (ore), a walk on the surface (trees, animals, gravel).
	const moveOff = async (need) => {
		const ore = need.blocks?.some((block) => ORE_BLOCKS.test(block));
		const o = await body.observe();
		danger ??= bodyDanger(o) ?? hostileOn(o);
		if (body.interrupted() || body.stopped()) return;
		if (ore && origin && (o.player?.underWater === true || o.player?.inWater === true)) {
			step('out of the water first: back up the way the body came');
			const out = await act('travel_to', { x: origin.x, y: origin.y, z: origin.z, retrace: true, tolerance: 3, timeoutMs: 120_000 });
			if (out?.state !== 'SUCCEEDED') body.note(`move stopped: ${out?.reasonCode ?? out?.state}`);
			return out;
		}
		const heading = ['north', 'east', 'south', 'west'][Math.floor(Math.random() * 4)];
		step(ore ? `that ore is out of reach: tunnel 16 ${heading} and search again` : 'search again from new ground: walk 24');
		const moved = ore ? await act('dig_to', { pattern: 'tunnel', heading, maxBlocks: 32, throughCaves: 'small', timeoutMs: 60_000 })
			: await act('travel_to', { yaw: Math.round(Math.random() * 360 - 180), distance: 24, timeoutMs: 45_000 });
		if (moved?.state !== 'SUCCEEDED') body.note(`move stopped: ${moved?.reasonCode ?? moved?.state}`);
		return moved;
	};
	const groundUnder = async () => {
		if (typeof body.blocksNear !== 'function') return null;
		const o = await body.observe();
		const at = bodyAt(o);
		if (at === null || o.player?.onGround === false) return null;
		const feet = { x: Math.floor(at.x), y: Math.floor(at.y + 0.01) - 1, z: Math.floor(at.z) };
		const under = (await body.blocksNear()).find((row) => row?.x === feet.x && row?.y === feet.y && row?.z === feet.z);
		return under ? { ...feet, blockId: under.blockId } : null;
	};
	const groundRound = async (feet) => {
		const rows = [];
		for (const [dx, dz] of [[1, 0], [0, 1], [-1, 0], [0, -1]]) {
			await act('look_at', { x: feet.x + 0.5 + dx * 6, y: feet.y - 4, z: feet.z + 0.5 + dz * 6 });
			if (body.interrupted() || body.stopped()) return null;
			const o = await body.observe();
			rows.push(...(o.blocks ?? []), ...(o.world?.landmarks ?? o.landmarks ?? []));
		}
		rows.push(...await body.blocksNear());
		const below = rows.filter((row) => typeof row?.blockId === 'string' && [row.x, row.y, row.z].every(Number.isSafeInteger)
			&& row.y < feet.y && Math.hypot(row.x - feet.x, row.z - feet.z) <= CANOPY_REACH);
		if (below.some((row) => /lava/.test(row.blockId))) return null;
		const ground = below.filter((row) => PLAIN_GROUND.test(bare(row.blockId))).map((row) => row.y + 1);
		return ground.length > 0 ? Math.min(...ground) : null;
	};
	const offCanopy = async () => {
		let groundTop;
		for (let breaks = 0; breaks < CANOPY_BREAKS; breaks++) {
			const under = await groundUnder();
			if (!/_leaves$/.test(String(under?.blockId ?? ''))) return;
			const feet = under;
			// The drop if this leaf is the last one: from the feet down to the ground seen round the tree.
			groundTop ??= await groundRound(feet);
			if (body.interrupted() || body.stopped()) return;
			const fall = groundTop === null ? null : feet.y + 1 - groundTop;
			const health = (await body.observe()).player?.health;
			if (fall === null || fall > CANOPY_FALL || (Number.isFinite(health) && health - Math.max(0, fall - 3) <= LOW_HEALTH)) {
				step(fall === null ? 'on a tree canopy with no ground seen round it: not breaking down through the leaves'
					: `on a tree canopy ${fall} blocks above the ground seen round it: not breaking down through the leaves`);
				return;
			}
			if (breaks === 0) step(`down off the tree canopy (${fall} blocks above the ground)`);
			const broken = await act('break_block', { x: feet.x, y: feet.y, z: feet.z, expectedBlockId: under.blockId, timeoutMs: 10_000 });
			if (broken?.state !== 'SUCCEEDED' || body.interrupted() || body.stopped()) return;
			await act('wait', { durationMs: 600 });
		}
	};
	const gatherNeed = async (need) => {
		if (need.kind === 'loot') return lootNeed(need);
		await offCanopy();
		if (body.interrupted() || body.stopped()) return 'stopped';
		// A mob to hunt already in view under cover (a cave spider in a mineshaft) is hunted where it is, not climbed away from.
		const covered = need.kind === 'kill' && huntHere(need, await body.observe(), budget) ? null : await surfaceFirst(need);
		if (body.interrupted() || body.stopped()) return 'stopped';
		// Searching sideways underground finds neither trees nor animals: hand back, saying why.
		if (covered !== null) { noSurface = `no way up to the surface for ${need.accept[0]}: ${covered}`; return noSurface; }
		if (need.kind === 'mine' && need.blocks.some((block) => ORE_BLOCKS.test(block) || STONE_BLOCKS.test(block))) await pickaxeToHotbar();
		const logs = need.kind === 'mine' && need.blocks.length > 0 && need.blocks.every((block) => /_(log|stem)$/.test(block));
		const total = heldOf(need.accept.join('|'), counts, index) + (logs ? Math.max(need.count, LOGS_PER_TRIP) : need.count);
		const searched = () => budget.lastSearch ? `${budget.lastSearch.reasonCode ?? budget.lastSearch.state}: ${String(budget.lastSearch.message ?? '').slice(0, 200)}` : 'not in view and no search here';
		if (need.kind === 'kill') {
			budget.lastSearch = null;
			const mob = await find(need, body, { budget, timeoutMs: left() });
			if (!mob) return `no ${need.mobs.join('/')} found (${searched()})`;
			// fight_until chases a target only 32 blocks: walk up to the herd first, then fight where the body stands.
			const o = await body.observe();
			const at = bodyAt(o);
			if (at && Math.hypot(mob.x - at.x, mob.z - at.z) > 12) {
				const where = `${Math.floor(mob.x)},${Math.floor(mob.y)},${Math.floor(mob.z)}`;
				step(`walk to the ${bare(mob.mob)} at ${where}`);
				// A hostile quarry stops the walk itself once it is close (HOSTILE_NEAR): that is the hunt's arrival. A hostile
				// of another kind near the body still stops it as danger.
				quarry = { type: id(mob.mob), id: typeof mob.stableId === 'string' ? mob.stableId : null };
				let walked;
				try { walked = await act('travel_to', { x: Math.floor(mob.x) + 0.5, z: Math.floor(mob.z) + 0.5, tolerance: 5, timeoutMs: 90_000 }); }
				finally { quarry = null; }
				if (body.interrupted() || body.stopped()) return 'stopped';
				// The walk stopped out of the hunt's reach (water, no route): a hunt from here sees no herd for 30 s. 4-seed
				// check B-3: two walks to one far cow stopped 70+ blocks short, and each was followed by a 30 s empty hunt.
				const after = bodyAt(await body.observe());
				if (after && Math.hypot(mob.x - after.x, mob.z - after.z) > HUNT_RADIUS) {
					budget.herds.push({ x: mob.x, z: mob.z });
					return `could not reach the ${bare(mob.mob)} at ${where} (${walked?.reasonCode ?? walked?.state ?? 'no move'}, ${Math.round(Math.hypot(mob.x - after.x, mob.z - after.z))} blocks short)`;
				}
			}
			step(`hunt ${bare(mob.mob)} for ${need.count} ${need.accept[0]}`);
			// fight_until's default fleeAtHealth (6) refuses a hunt for food at once at low health. For food it bails at the
			// next hit instead: any damage still ends the hunt (LOW_HEALTH_BAILOUT is a damage stop, so obtain hands back).
			const health = (await body.observe()).player?.health;
			if (food && foodFlee === null && Number.isFinite(health) && health <= LOW_HEALTH) foodFlee = Math.max(0.5, health - 1);
			const flee = foodFlee !== null ? { fleeAtHealth: foodFlee } : {};
			const underCover = (await body.observe()).player?.skyOpen === false;
			const fought = await act('fight_until', { mob: mob.mob, untilItem: id(need.accept[0]), untilCount: total, radius: 24, timeoutMs: 180_000, ...flee });
			// A hunt under cover that ended without the item (no route to the mob, no sight of it, out of time), not for
			// danger: the next round climbs out instead of trying the same mob again.
			// The mark keeps its height: a mob on the surface above the spot is another hunt.
			if (underCover && fought?.state !== 'SUCCEEDED' && fought?.state !== 'INTERRUPTED' && !body.interrupted()) budget.herds.push({ x: mob.x, z: mob.z, y: mob.y });
			return fought?.state === 'SUCCEEDED' ? null : `fight_until ${bare(mob.mob)}: ${fought?.reasonCode ?? 'failed'}`;
		}
		budget.lastSearch = null;
		// Carried chance-drop input can be reused before searching for a deposit. Keep known sources first.
		if (need.chance) {
			const o = await body.observe();
			counts = heldCounts(o);
			if (heldOf(need.accept.join('|'), counts, index) >= total) return null;
			if ((counts.get(need.blocks[0]) ?? 0) > 0 && !inView(need, o, budget)) {
				const why = await rebreak(need, total);
				if (body.interrupted() || body.stopped()) return 'stopped';
				const after = await body.observe();
				counts = heldCounts(after);
				danger ??= bodyDanger(after) ?? hostileOn(after);
				if (danger !== null) return 'stopped';
				if (Number.isFinite(after?.player?.health) && after.player.health <= LOW_HEALTH) return why;
				if (heldOf(need.accept.join('|'), counts, index) >= total) return null;
				// No placement cell, exhausted input or unlucky breaks: acquisition can still succeed elsewhere.
			}
		}
		// Stone lies under the soil everywhere: with none in view, dig a few steps down into it rather than search.
		const stoneOnly = need.blocks.every((block) => STONE_BLOCKS.test(block));
		const searchMs = coalShort && need.accept.includes('coal') ? Math.min(COAL_SEARCH_MS, left()) : left();
		let where = stoneOnly ? inView(need, await body.observe(), budget) : await find(need, body, { budget, timeoutMs: searchMs });
		// Nothing in view: look round once before digging, as a player turns to see what is about before reaching for a
		// pickaxe. Whatever it shows that drops the item (a seen source the planner could not count yet: a village's
		// cobblestone, a house's planks) becomes a block of this need.
		if (!where && stoneOnly && typeof body.look === 'function' && !budget.lookedRound && left() >= 10_000) {
			budget.lookedRound = true;
			step('look round before digging');
			await body.look({ pitch: 10 });
			if (body.interrupted() || body.stopped()) return 'stopped';
			const after = await body.observe();
			const seenNow = seenIds(after);
			const dropping = need.accept.flatMap((accepted) => (index.blockDrops?.[bare(accepted)] ?? []).filter(([, flags]) => !/[sh]/.test(flags)).map(([block]) => block));
			const extra = [...new Set(dropping)].filter((block) => seenNow.has(block) && !need.blocks.includes(block));
			if (extra.length > 0) need.blocks = [...extra, ...need.blocks];
			where = inView(need, after, budget);
		}
		if (!where && budget.lastSearch?.reasonCode === 'OBTAIN_APPROACH_FLOODED') {
			// A remembered flood cannot authorize the same approach. Use the existing relocation,
			// and require fresh evidence that it changed this context before selecting the ore again.
			const before = await body.observe();
			danger ??= bodyDanger(before) ?? hostileOn(before);
			if (body.interrupted() || body.stopped()) return 'relocation stopped';
			const moved = await moveOff(need);
			if (body.interrupted() || body.stopped()) return 'relocation stopped';
			const fresh = await body.observe();
			danger ??= bodyDanger(fresh) ?? hostileOn(fresh);
			if (body.interrupted() || body.stopped()) return 'relocation stopped';
			if (moved?.state !== 'SUCCEEDED' || approaches.length > 0) {
				approachStop = { reasonCode: TOOL_STOPS.has(moved?.reasonCode) ? moved.reasonCode : 'OBTAIN_STUCK',
					message: `Flooded ore approach relocation stopped (${moved?.reasonCode ?? moved?.state ?? 'unknown'}); no changed safe approach observed` };
				return approachStop.message;
			}
			budget.lastSearch = null;
			where = await find(need, body, { budget, timeoutMs: left() });
		}
		if (!where && stoneOnly) {
			for (let aside = 0; aside < 3; aside++) {
				const ground = (await groundUnder())?.blockId;
				if (ground === undefined || PLAIN_GROUND.test(bare(ground))) break;
				step(`not digging down through ${bare(ground)}: step aside`);
				await act('travel_to', { yaw: Math.round(Math.random() * 360 - 180), distance: 8, timeoutMs: 20_000 });
				if (body.interrupted() || body.stopped()) return 'stopped';
			}
			for (let legs = 0, wet = 0; legs < STONE_DIG_LEGS; legs++) {
				const here = bodyAt(await body.observe());
				if (!here) break;
				step(legs === 0 ? 'dig down into the stone' : 'no stone in view yet: dig down further');
				const dug = await act('dig_to', { pattern: 'stairs_down', y: Math.floor(here.y) - 6, maxBlocks: 24, throughCaves: 'small', timeoutMs: 60_000 });
				if (body.interrupted() || body.stopped()) return 'stopped';
				const o = await body.observe();
				const after = bodyAt(o);
				if (after) where = { ...after, blockId: id(need.blocks[0]), dug: true };
				if (inView(need, o, budget)) break;
				const water = after && wet < WET_STONE_MOVES && /^(WATER_AHEAD|TUNNEL_FLOODED)$/.test(dug?.reasonCode ?? '')
					? /(?:Water|tunnel) at (-?\d+),(-?\d+),(-?\d+)/.exec(String(dug.message ?? '')) : null;
				if (water) {
					wet += 1;
					legs = -1;
					const yaw = Math.round(Math.atan2(-(after.x - Number(water[1]) - 0.5), after.z - Number(water[3]) - 0.5) * 180 / Math.PI);
					step(`water under the dig at ${water[1]},${water[2]},${water[3]}: walk ${WET_STONE_WALK} away from it and dig again`);
					await act('travel_to', { yaw, distance: WET_STONE_WALK, timeoutMs: 30_000 });
					if (body.interrupted() || body.stopped()) return 'stopped';
					continue;
				}
				if (dug?.state !== 'SUCCEEDED') break;
			}
		}
		if (!where) {
			if (need.blocks.some((block) => ORE_BLOCKS.test(block) || STONE_BLOCKS.test(block))
				&& budget.lastSearch?.reasonCode === 'FIND_BLOCKED' && /\b(TOOL_WORN|NO_TOOL)\b/.test(String(budget.lastSearch.message ?? '')) && !(failures.get('worn') >= 6)) {
				fail('worn');
				step(`search stopped: the pickaxe is worn (${String(budget.lastSearch.message ?? '').slice(0, 120)})`);
				return null;
			}
			// find stops at its first sighting, which can be one obtain already failed at (out of reach inside rock, or a
			// vein it already took that a survey still lists): search again from new ground, not from here.
			if (budget.lastSearch?.reasonCode === 'FIND_SEEN') await moveOff(need);
			else if (budget.lastSearch?.reasonCode === 'FIND_BLOCKED' && WET_STOP.test(String(budget.lastSearch.message ?? ''))) {
				await moveOff(need);
			}
			return `no ${bare(stoneOnly ? need.blocks[0] : searchBlock(need, await body.observe()))} found (${searched()})`;
		}
		let o = await body.observe();
		const at = bodyAt(o);
		// Ores and stone: go to the block, then take the whole vein; the body collects what drops beside it.
		if (ORE_BLOCKS.test(bare(where.blockId)) || STONE_BLOCKS.test(bare(where.blockId)) && need.blocks.length > 0 && !need.chance) {
			const stops = [];
			if (at && eyeDistance(at, where) > REACH) {
				step(`go to the ${bare(where.blockId)} at ${where.x},${where.y},${where.z}`);
				// A remembered ore out of view is walked toward until it shows (stopWhenSeen), aimed at the cell over it rather
				// than the solid ore cell: aimed at the ore itself, travel tunnelled 12 blocks round to a cell 2 off with the ore
				// behind rock (22 Nov remembered-ore room). Once it shows, the reach check below digs the last blocks.
				const went = await act('travel_to', where.remembered
					? { x: where.x + 0.5, y: where.y + 1, z: where.z + 0.5, tolerance: 2, stopWhenSeen: id(where.blockId), timeoutMs: 120_000 }
					: { x: where.x + 0.5, y: where.y, z: where.z + 0.5, tolerance: 2, timeoutMs: 120_000 });
				if (went?.state !== 'SUCCEEDED') { stops.push(went?.reasonCode); body.note(`walk stopped: ${went?.reasonCode ?? went?.state} ${String(went?.message ?? '').slice(0, 140)}`); }
				// The walk stops at the first block of the id in sight, which need not be the remembered one: the ore in view
				// is the one to take (its cell is in the receipt), not the old cell further on behind rock.
				const sighted = where.remembered && went?.reasonCode === 'TARGET_SEEN' ? /seen at (-?\d+),\s*(-?\d+),\s*(-?\d+)/.exec(String(went?.message ?? '')) : null;
				if (sighted !== null) {
					const cell = { x: Number(sighted[1]), y: Number(sighted[2]), z: Number(sighted[3]) };
					if (cell.x !== where.x || cell.y !== where.y || cell.z !== where.z) step(`the walk saw ${bare(where.blockId)} at ${cell.x},${cell.y},${cell.z} first: take that one`);
					Object.assign(where, cell, { remembered: false });
				}
				o = await body.observe();
				if (ORE_BLOCKS.test(bare(where.blockId)) && rememberFlood(went, where, o)) return 'ore approach flooded';
				if (body.interrupted() || body.stopped()) return 'approach stopped';
			}
			let here = bodyAt(o);
			if (ORE_BLOCKS.test(bare(where.blockId)) && here && eyeDistance(here, where) > REACH) {
				// Ore in the rock the walk could not reach: tunnel straight to it, as a player digs toward an ore in the wall.
				step(`tunnel to the ${bare(where.blockId)} at ${where.x},${where.y},${where.z}`);
				if (Math.abs(here.y - where.y) > 2) {
					const stair = await act('dig_to', { pattern: where.y < here.y ? 'stairs_down' : 'stairs_up', y: where.y, maxBlocks: 48, throughCaves: 'small', timeoutMs: 120_000 });
					stops.push(stair?.reasonCode);
					if (rememberFlood(stair, where, await body.observe())) return 'ore approach flooded';
					if (body.interrupted() || body.stopped()) return 'approach stopped';
				}
				const dug = await act('dig_to', { pattern: 'tunnel', x: where.x, z: where.z, maxBlocks: 32, throughCaves: 'small', timeoutMs: 120_000 });
				if (dug?.state !== 'SUCCEEDED') { stops.push(dug?.reasonCode); body.note(`tunnel stopped: ${dug?.reasonCode ?? dug?.state} ${String(dug?.message ?? '').slice(0, 140)}`); }
				o = await body.observe();
				here = bodyAt(o);
				if (rememberFlood(dug, where, o)) return 'ore approach flooded';
				if (body.interrupted() || body.stopped()) return 'approach stopped';
			}
			if (body.interrupted() || body.stopped()) return 'stopped';
			if (ORE_BLOCKS.test(bare(where.blockId))) {
				if (!here || eyeDistance(here, where) > REACH + 1) {
					const notReach = stops.find((code) => NOT_REACH.has(code));
					if (notReach === undefined) {
						budget.failed.add(`${where.x},${where.y},${where.z}`);
						await outOfReach(need, where);
					}
					return `could not reach the ${bare(where.blockId)} at ${where.x},${where.y},${where.z}${notReach === undefined ? '' : ` (${notReach})`}`;
				}
				step(`mine the ${bare(where.blockId)} vein at ${where.x},${where.y},${where.z}`);
				const beforeMine = await body.observe();
				const heldBefore = heldOf(need.accept.join('|'), heldCounts(beforeMine), index);
				const level = bodyAt(beforeMine)?.y ?? null;
				budget.veins.add(`${where.x},${where.y},${where.z}`);
				let mined = await body.mine({ x: where.x, y: where.y, z: where.z, vein: true, maxBlocks: 24, timeoutMs: 90_000 });
				if (['INVALID_VEIN_TARGET', 'NOTHING_MINED'].includes(mined?.reasonCode) && !body.interrupted() && !body.stopped()) {
					step(`dig to the hidden ${bare(where.blockId)} at ${where.x},${where.y},${where.z}`);
					await act('dig_to', { pattern: 'tunnel', x: where.x, z: where.z, maxBlocks: 6, stopWhenSeen: id(where.blockId), throughCaves: 'small', timeoutMs: 30_000 });
					mined = await body.mine({ x: where.x, y: where.y, z: where.z, vein: true, maxBlocks: 24, timeoutMs: 90_000 });
				}
				// Every block in reach under the feet and no stance mine_vein could see or reach: step back the way the body
				// faced from and try once more from there, as a player steps off an ore to mine it.
				if (mined?.reasonCode === 'VEIN_UNDER_BODY' && !body.interrupted() && !body.stopped()) {
					const facing = (await body.observe()).player?.yaw ?? 0;
					step(`step off the ${bare(where.blockId)} at ${where.x},${where.y},${where.z} and mine it from beside`);
					await act('travel_to', { yaw: Math.round((((facing + 180) % 360) + 540) % 360 - 180), distance: 2, tolerance: 1, timeoutMs: 15_000 });
					if (!body.interrupted() && !body.stopped()) mined = await body.mine({ x: where.x, y: where.y, z: where.z, vein: true, maxBlocks: 24, timeoutMs: 90_000 });
				}
				if (body.interrupted() || body.stopped()) return 'stopped';
				if (mined?.state !== 'SUCCEEDED') {
					if (!TOOL_STOPS.has(mined?.reasonCode)) budget.failed.add(`${where.x},${where.y},${where.z}`);
					if (OUT_OF_REACH.has(mined?.reasonCode)) await outOfReach(need, where);
				}
				await pickUpNear(where, need.accept, 6);
				if (mined?.state === 'SUCCEEDED' && !body.interrupted() && !body.stopped()) await veinRest(need, where, total, heldBefore, mined);
				// A pickup that walked down into the mined pocket (or a vein that ended in it) leaves the body in a hole: stairs
				// back up to the level it mined from, cut into the pocket's wall as a player does.
				const after = bodyAt(await body.observe());
				if (level !== null && after !== null && after.y < level - 0.5 && !body.interrupted() && !body.stopped()) {
					step(`climb back out of the pocket to y${Math.floor(level)}`);
					await act('dig_to', { pattern: 'stairs_up', y: Math.floor(level), maxBlocks: 12, throughCaves: 'small', timeoutMs: 30_000 });
				}
				return mined?.state === 'SUCCEEDED' ? null : `mine ${bare(where.blockId)}: ${mined?.reasonCode ?? 'failed'}`;
			}
		} else if (at && !where.dug && flatDistance(at, where) > 8) {
			step(`walk to the ${bare(where.blockId)} at ${where.x},${where.y},${where.z}`);
			await act('travel_to', { x: where.x + 0.5, z: where.z + 0.5, tolerance: 3, timeoutMs: 120_000 });
		}
		// A chance drop (flint): take the block itself first, then break and re-place it until the drop comes.
		if (need.chance) {
			const block = need.blocks[0];
			step(`gather ${block} for ${need.accept[0]}`);
			const taken = await body.gather({ itemIds: [id(block), ...need.accept.map(id)], blockIds: need.blocks.slice(0, 8).map(id), count: Math.min(64, heldOf(block, counts, index) + heldOf(need.accept.join('|'), counts, index) + 4), radius: SURFACE_RADIUS, timeoutMs: 120_000 });
			// A gather danger or a low-health stop cut short says nothing about the block: obtain may recover and come back.
			if (taken?.state !== 'SUCCEEDED' && (body.interrupted() || body.stopped())) return 'stopped';
			if (taken?.state !== 'SUCCEEDED') {
				budget.failed.add(`${where.x},${where.y},${where.z}`);
				gaveUp(where, taken);
				body.note(`gather ${block}: ${taken?.reasonCode ?? taken?.state}${taken?.message ? ` ${String(taken.message).slice(0, 140)}` : ''}`);
			}
			return rebreak(need, total);
		}
		step(`gather ${need.count} ${need.accept.length > 3 ? need.accept[0].replace(/^[a-z]+_/, 'any ') : need.accept.join('/')}`);
		const blockIds = [...new Set([where.blockId, ...need.blocks.map(id)])].slice(0, 8);
		const gathered = await body.gather({ itemIds: need.accept.map(id), blockIds, count: Math.min(64, total), radius: SURFACE_RADIUS, timeoutMs: 180_000 });
		if (gathered?.state === 'SUCCEEDED') return null;
		if ((gathered?.broken ?? 0) > 0) return null;
		if (body.interrupted() || body.stopped()) return 'stopped';
		// gather could not reach the trunk (tall spruce, jungle): walk up beside the tree found and fell it whole.
		if (/_(log|stem)$/.test(bare(where.blockId))) {
			step(`fell the ${bare(where.blockId)} at ${where.x},${where.y},${where.z} from beside it`);
			await act('travel_to', { x: where.x + 0.5, y: where.y, z: where.z + 0.5, tolerance: 2, timeoutMs: 60_000 });
			const felled = await body.mine({ x: where.x, y: where.y, z: where.z, vein: true, maxBlocks: 32, timeoutMs: 90_000 });
			await pickUpNear(where, need.accept, 8);
			if (felled?.state === 'SUCCEEDED') return null;
			body.note(`fell stopped: ${felled?.reasonCode ?? felled?.state}`);
		}
		budget.failed.add(`${where.x},${where.y},${where.z}`);
		gaveUp(where, gathered);
		if (!/_(log|stem)$/.test(bare(where.blockId))) {
			const yaw = Math.round(Math.random() * 360 - 180);
			step(`nothing in reach here: walk 24 at yaw ${yaw}`);
			await act('travel_to', { yaw, distance: 24, timeoutMs: 45_000 });
		}
		return `gather ${need.blocks[0]}: ${gathered?.reasonCode ?? 'failed'}`;
	};
	// A drop that comes only sometimes (flint from gravel): place the block back and break it again until it drops.
	// A chest the body knows of, or a structure whose chests it looks for: walk there, open the nearest unopened chest,
	// take what the plan needs and what a player keeps. Opened chests and searched structures stop being sources, so the
	// next plan prices what is left (often mining).
	const lootNeed = async (need) => {
		const why = await lootOnce(need);
		if (why !== null && why !== 'stopped') fail('loot');
		return why;
	};
	// A door no row lists yet: find's sight search for any door kind, kept to the structure and to doors not yet tried.
	const doorInSight = async (source, reach) => {
		if (typeof body.search !== 'function') return null;
		const result = await body.search({ block: 'minecraft:oak_door', also: DOOR_KINDS.slice(1) }, { timeoutMs: Math.min(20_000, left()), within: 24 });
		const at = result?.find?.seen;
		if (result?.reasonCode !== 'FIND_SEEN' || !at || ![at.x, at.y, at.z].every(Number.isFinite) || Math.hypot(at.x - source.x, at.z - source.z) > reach
			|| looted.doors.some((d) => (d.dimension ?? null) === (source.dimension ?? d.dimension ?? null) && Math.hypot(d.x - at.x, d.z - at.z) < 2 && Math.abs(d.y - at.y) < 2)) return null;
		return { x: at.x, y: at.y, z: at.z, blockId: at.id };
	};
	// A house's price for the plan: its building kind (the nearest job block within a house's reach of the door, else an
	// ordinary house), what that kind holds for the plan (planned.lootValue), and the walk plus the look inside.
	const housePrice = (door, jobs, at, need) => {
		const near = jobs.filter((row) => Math.hypot(row.x - door.x, row.z - door.z) <= HOUSE_REACH && Math.abs(row.y - door.y) <= 3)
			.sort((a, b) => Math.hypot(a.x - door.x, a.z - door.z) - Math.hypot(b.x - door.x, b.z - door.z))[0];
		const job = near ? bare(near.blockId) : 'none';
		const value = lastPlan?.lootValue;
		const saving = value ? value((item) => houseYield(job, item)).saving : need.accept.reduce((sum, item) => sum + houseYield(job, item), 0);
		const cost = (at ? Math.hypot(door.x + 0.5 - at.x, door.z + 0.5 - at.z) : 0) / 20 + HOUSE_LOOK;
		return { job, saving, cost, gain: saving - cost };
	};
	// Everything the current plan still needs (every need's items, every craft's output, the target), the visit's own
	// first: an open chest gives what any of them asks for.
	const planWanted = (need) => [...new Set([...need.accept, ...(lastPlan?.needs ?? []).flatMap((n) => n.accept), ...(lastPlan?.ops ?? []).flatMap((op) => op.outputs), ...target.ids].map(bare))];
	const lootOnce = async (need) => {
		const source = need.sources?.[0];
		if (!source) return `no chest left for ${need.accept[0]}`;
		const dimension = (await body.observe()).world?.dimension ?? null;
		// Ledger keys carry the dimension: a Nether chest at a village chest's coordinates is another chest.
		const cellKey = (row) => lootKey(row, dimension);
		const sameDoor = (d, row) => (d.dimension ?? null) === dimension && Math.hypot(d.x - row.x, d.z - row.z) < 2 && Math.abs(d.y - row.y) < 2;
		const walk = async (row, tolerance) => {
			const o = await body.observe();
			const at = bodyAt(o);
			if (at && Math.hypot(row.x + 0.5 - at.x, row.y - at.y, row.z + 0.5 - at.z) <= tolerance + 0.5) return true;
			const walked = await act('travel_to', { x: Math.floor(row.x) + 0.5, y: Math.floor(row.y), z: Math.floor(row.z) + 0.5, tolerance, timeoutMs: 120_000 });
			return walked?.state === 'SUCCEEDED';
		};
		let chest = source.kind === 'chest' ? source : null;
		let houseDoor = null, doorsDone = false;
		if (chest === null) {
			step(`look for chests in the ${source.name} at ${source.x},${source.y},${source.z}`);
			if (source.distance > 24 && !(await walk(source, 8)) && (body.interrupted() || body.stopped())) return 'stopped';
			const inSight = lootSources(await body.observe(), { opened: new Set([...looted.opened, ...budget.failed]), searched: new Set([...looted.searched, ...budget.passed]), structures: looted.structures, partial: new Set(looted.partial ?? []) })
				.find((row) => row.kind === 'chest');
			chest = inSight ?? null;
			// A village's chests stand inside its houses, out of sight from the street: look in through the doors, nearest
			// first, as a player walks into each house.
			const reach = structureReach(source.name);
			const known = () => body.observe().then((o) => [...(Array.isArray(o.seenResources) ? o.seenResources.map((row) => ({ ...row, blockId: row.id })) : []), ...knownBlocks(o)]);
			for (let tries = 0; chest === null && tries < DOOR_VISITS && left() > 20_000; tries++) {
				const rows = await known();
				const at = bodyAt(await body.observe());
				// Each house priced like any source: what its kind of building (the job block by its door) holds for this plan,
				// chests it may lack included, against the walk and the look inside. The best first; none once none pays.
				const jobs = rows.filter((row) => JOB_BLOCK.test(row.blockId ?? '') && [row.x, row.y, row.z].every(Number.isFinite));
				const priced = rows.filter((row) => DOOR.test(row.blockId ?? '') && [row.x, row.y, row.z].every(Number.isFinite)
					&& Math.hypot(row.x - source.x, row.z - source.z) <= reach && !looted.doors.some((d) => sameDoor(d, row)) && !budget.doorsSkipped.some((d) => sameDoor(d, row)))
					.map((row) => ({ row, ...housePrice(row, jobs, at, need) }))
					.sort((a, b) => b.gain - a.gain);
				const best = priced[0];
				if (best && !(best.gain > 0)) { step(`no house left worth a look (best: ${best.job} at ${cellKey(best.row)}, ${best.saving.toFixed(1)} saved for ${best.cost.toFixed(1)})`); doorsDone = true; break; }
				const door = best?.row ?? await doorInSight(source, reach);
				if (!door) break;
				if (best) step(`house by the ${best.job} door at ${cellKey(door)}: ${best.saving.toFixed(1)} saved for ${best.cost.toFixed(1)}`);
				// A house counts as looked into (for good) only once the body stood in its doorway; one it never entered (no way
				// there, a hostile by the door) is passed over for this call only.
				const doorAt = { x: door.x, y: door.y, z: door.z, dimension };
				budget.doorsSkipped.push(doorAt);
				step(`look into the house through the door at ${cellKey(door)}`);
				if (!(await walk(door, 2))) { if (body.interrupted() || body.stopped()) return 'stopped'; continue; }
				// The way in is away from where the body stands outside the door.
				const from = bodyAt(await body.observe()) ?? { x: door.x + 0.5, z: door.z + 1.5 };
				// A hostile in or by the house (seen before the door opens, and again once it shows the room): not a house to
				// walk into; shut it again and try the next.
				const hostileByDoor = async () => {
					const near = ((await body.observe()).entities ?? []).filter((row) => row?.alive !== false && [row.x, row.z].every(Number.isFinite)
						&& Math.hypot(row.x - door.x - 0.5, row.z - door.z - 0.5) <= HOUSE_REACH);
					if (near.length > 0) step(`by the door: ${near.slice(0, 6).map((row) => `${bare(row.type ?? '?')}${row.hostile === true ? ' (hostile flag)' : ''}`).join(', ')}`);
					return near.find(hostileMob) ?? null;
				};
				let inside = await hostileByDoor();
				if (inside) { step(`a ${bare(inside.type)} by the door at ${cellKey(door)}: not going in`); continue; }
				await act('set_door', { x: door.x, y: door.y, z: door.z, open: true });
				inside = await hostileByDoor();
				if (inside) { await act('set_door', { x: door.x, y: door.y, z: door.z, open: false }); step(`a ${bare(inside.type)} by the door at ${cellKey(door)}: not going in`); continue; }
				// Through the doorway: two blocks past the door on the far side from where the body stands (travel's tolerance
				// is at least a block, so a target in the doorway itself can stop outside).
				const dx = door.x + 0.5 - from.x, dz = door.z + 0.5 - from.z;
				const axisX = Math.abs(dx) >= Math.abs(dz);
				const into = { x: Math.floor(door.x) + 0.5 + (axisX ? 2 * Math.sign(dx || 1) : 0), z: Math.floor(door.z) + 0.5 + (axisX ? 0 : 2 * Math.sign(dz || 1)) };
				// travel_to settles within a block across, at any height (a house up a step stays out of sight): navigate_to
				// takes the body into the doorway cell itself, then a step inside.
				const inDoorway = await act('navigate_to', { x: Math.floor(door.x) + 0.5, y: Math.floor(door.y), z: Math.floor(door.z) + 0.5, tolerance: 0.6, sprint: false, timeoutMs: 10_000 });
				if (inDoorway?.state === 'SUCCEEDED') looted.doors.push(doorAt);
				if (body.interrupted() || body.stopped()) return 'stopped';
				// From the doorway a small house is in view already; a step further in only when it shows no chest.
				const seenFromDoor = lootSources(await body.observe(), { opened: new Set([...looted.opened, ...budget.failed]), searched: new Set([...looted.searched, ...budget.passed]), structures: looted.structures, partial: new Set(looted.partial ?? []) })
					.find((row) => row.kind === 'chest');
				// The door's facing is not in the rows: the far side from the body first, the other side when that is no room.
				if (!seenFromDoor) {
					const stepped = await act('navigate_to', { x: into.x, y: Math.floor(door.y), z: into.z, tolerance: 1, sprint: false, timeoutMs: 10_000 });
					if (stepped?.state !== 'SUCCEEDED' && !body.interrupted() && !body.stopped()) {
						const back = { x: 2 * (Math.floor(door.x) + 0.5) - into.x, z: 2 * (Math.floor(door.z) + 0.5) - into.z };
						await act('navigate_to', { x: back.x, y: Math.floor(door.y), z: back.z, tolerance: 1, sprint: false, timeoutMs: 10_000 });
					}
				}
				if (body.interrupted() || body.stopped()) return 'stopped';
				chest = lootSources(await body.observe(), { opened: new Set([...looted.opened, ...budget.failed]), searched: new Set([...looted.searched, ...budget.passed]), structures: looted.structures, partial: new Set(looted.partial ?? []) })
					.find((row) => row.kind === 'chest') ?? null;
				// Shut behind: now when the house holds nothing, after the loot when it does.
				if (chest === null) await act('set_door', { x: door.x, y: door.y, z: door.z, open: false });
				else houseDoor = door;
			}
			// A chest search sees only chests in the open (a shipwreck's, a ruined portal's): a village's stand indoors.
			if (chest === null && typeof body.search === 'function' && !/^village/.test(source.name)) {
				// Kept to the structure: legs of half the radius, a hand-back at its edge.
				const result = await body.search({ block: 'minecraft:chest' }, { timeoutMs: Math.min(60_000, left()), within: Math.min(48, reach) });
				const at = result?.find?.seen;
				// Only a chest inside this structure, not yet opened or given up on: a chest elsewhere is someone's storage.
				if (result?.reasonCode === 'FIND_SEEN' && at && [at.x, at.y, at.z].every(Number.isFinite) && !looted.opened.includes(cellKey(at))
					&& !budget.failed.has(cellKey(at)) && Math.hypot(at.x - source.x, at.z - source.z) <= structureReach(source.name)) chest = { x: at.x, y: at.y, z: at.z };
			}
			if (body.interrupted() || body.stopped()) return 'stopped';
			if (chest === null) {
				// Twice without a new chest, or no house left that pays its look: the structure's chests are done.
				const misses = (looted.misses[cellKey(source)] ?? 0) + (doorsDone ? 0 : 1);
				looted.misses[cellKey(source)] = misses;
				// No house worth a look is this goal's verdict, not the village's: it is passed over for this call only.
				if (doorsDone) budget.passed.add(cellKey(source));
				else if (misses >= 2) looted.searched.push(cellKey(source));
				return `no unopened chest found in the ${source.name}`;
			}
		}
		step(`loot the chest at ${cellKey(chest)}`);
		if (!(await walk(chest, 2))) {
			if (body.interrupted() || body.stopped()) return 'stopped';
			budget.failed.add(cellKey(chest));
			return `no way to the chest at ${cellKey(chest)}: ${lastFailure ?? 'walk failed'}`;
		}
		// travel_to counts arrival within 3 blocks of height: a chest on a house floor up a step can be out of sight from
		// there. navigate_to keeps height: beside the chest, inside its reach.
		{
			const at = bodyAt(await body.observe());
			if (at && (Math.abs(at.y - chest.y) > 1 || eyeDistance(at, chest) > REACH - 0.5))
				await act('navigate_to', { x: Math.floor(chest.x) + 0.5, y: Math.floor(chest.y), z: Math.floor(chest.z) + 0.5, tolerance: 1.5, sprint: false, timeoutMs: 10_000 });
		}
		const o = await body.observe();
		// A use on the cell is only safe on a container still there now: a stale target could be anything (TNT, a bed).
		const here = [...(o.blocks ?? []), ...(o.nearbyContainers ?? [])].find((row) => row?.x === chest.x && row?.y === chest.y && row?.z === chest.z);
		if (!here || !CONTAINER.test(here.blockId ?? '')) { budget.failed.add(cellKey(chest)); return `no chest at ${cellKey(chest)} now (${here?.blockId ?? 'not in view'})`; }
		// Opening a chest takes the screen for a moment: never with danger or a hostile near.
		const risk = bodyDanger(o) ?? hostileOn(o);
		if (risk) { danger ??= `before opening a chest: ${risk}`; return 'stopped'; }
		const heldItem = o.inventory?.selectedItem ?? (o.inventory?.items ?? []).find((row) => row.slot === 'mainhand')?.itemId ?? 'minecraft:air';
		// The close goes out even after danger stopped the run (obtain's own act refuses new moves then): no chest stays open.
		const close = rawBody.closeMenu ?? ((args) => rawBody.act('menu_close', args));
		const hands = { menu: body.menu, act: (type, args) => (type === 'menu_close' ? close(args) : body.act(type, args)) };
		const result = typeof body.menu === 'function'
			? await lootChest(hands, chest, { wanted: planWanted(need), heldItem, from: bodyAt(o) })
			: { ok: false, read: false, taken: {}, why: 'this body cannot read an open chest' };
		// A take a stop cut short leaves the chest a source to come back to; one fully read and taken from is done.
		looted.partial ??= [];
		if (result.read && result.stopped) { if (!looted.partial.includes(cellKey(chest))) looted.partial.push(cellKey(chest)); }
		else if (result.read) { looted.opened.push(cellKey(chest)); looted.partial = looted.partial.filter((cell) => cell !== cellKey(chest)); }
		else budget.failed.add(cellKey(chest));
		if (result.closed === false) step('the chest screen may still be open: closed at the next step');
		if (houseDoor !== null && !rawBody.interrupted() && !rawBody.stopped()) {
			await act('navigate_to', { x: Math.floor(houseDoor.x) + 0.5, y: Math.floor(houseDoor.y), z: Math.floor(houseDoor.z) + 0.5, tolerance: 0.6, sprint: false, timeoutMs: 15_000 });
			await act('set_door', { x: houseDoor.x, y: houseDoor.y, z: houseDoor.z, open: false });
		}
		if (looted.opened.length > 256) looted.opened.splice(0, looted.opened.length - 256);
		const got = Object.entries(result.taken).map(([kind, n]) => `${n} ${kind}`).join(', ');
		step(got ? `took ${got}` : `the chest at ${cellKey(chest)} held nothing to take`);
		return result.ok ? null : result.why;
	};

	const rebreak = async (need, total) => {
		const block = need.blocks[0];
		for (let attempt = 0; attempt < 24; attempt++) {
			if (danger !== null || body.interrupted() || body.stopped()) return 'stopped';
			const o = await body.observe();
			danger ??= bodyDanger(o) ?? hostileOn(o);
			if (danger !== null) return 'stopped';
			const health = o?.player?.health;
			if (Number.isFinite(health) && health <= LOW_HEALTH) return `health ${health}: stopped breaking ${block}`;
			const counts = heldCounts(o);
			if (heldOf(need.accept.join('|'), counts, index) >= total) return null;
			if ((counts.get(block) ?? 0) === 0) return `no ${block} left to break for ${need.accept[0]}`;
			// On the ground: a falling block placed against a wall drops away.
			const cell = placementCell(o, new Set(), { ground: true, trail });
			if (!cell) return `no free cell to place ${block}`;
			const placedBlock = await act('place_block', { x: cell.x, y: cell.y, z: cell.z, face: cell.face, itemId: id(block) });
			if (placedBlock?.state !== 'SUCCEEDED') continue;
			await body.mine({ x: cell.x, y: cell.y, z: cell.z, expectedBlockId: id(block), timeoutMs: 15_000 });
			await pickUpNear(cell, [...need.accept, block], 3);
		}
		return `${need.accept[0]} did not drop in 24 breaks`;
	};

	// A filled bucket: a scoop at the sources in reach, else a walk into reach of the nearest one known (in view, else
	// find's search, which looks round first, then goes back up the way the body came when it is under cover), then a
	// scoop there. Returns null once the bucket filled, else why not.
	const fillAt = async () => {
		const seenRows = async (o) => {
			const near = typeof body.blocksNear === 'function' ? await body.blocksNear() : [];
			return [...near, ...knownBlocks(o)].filter((row) => [row?.x, row?.y, row?.z].every(Number.isSafeInteger));
		};
		const sources = async (o, rows = null) => {
			const at = bodyAt(o);
			return at === null ? [] : (rows ?? await seenRows(o)).filter((row) => row.blockId === id(fluid) && String(row.state?.level) === '0'
				&& !budget.failed.has(`${row.x},${row.y},${row.z}`))
				.map((row) => ({ x: row.x, y: row.y, z: row.z, d: eyeDistance(at, row) })).sort((a, b) => a.d - b.d);
		};
		const cell = (row) => `${row.x},${row.y},${row.z}`;
		// What the rows seen now say of a cell: true a source of the fluid, false its flow, null no row of it with a level
		// (unseen, or a landmark). The bucket takes a source only: aimed at a flow its ray passes on to what lies behind.
		const sourceAt = (rows, at) => {
			const levels = rows.filter((row) => row.blockId === id(fluid) && row.x === at.x && row.y === at.y && row.z === at.z && row.state?.level !== undefined);
			return levels.length === 0 ? null : levels.every((row) => String(row.state.level) === '0');
		};
		const inside = (row) => row?.player?.inWater === true || row?.player?.underWater === true;
		const outOfWater = async (wasIn, emptied, way) => {
			const here = await body.observe();
			const refills = async () => {
				const near = typeof body.blocksNear === 'function' ? await body.blocksNear() : [];
				return [...near, ...knownBlocks(here)].some((row) => row?.blockId === id(fluid) && ((row.y === emptied.y && Math.abs(row.x - emptied.x) + Math.abs(row.z - emptied.z) === 1)
					|| (row.y === emptied.y + 1 && row.x === emptied.x && row.z === emptied.z)));
			};
			if (!inside(here) && !(wasIn && await refills())) { wet = null; return; }
			const from = bodyAt(here);
			const near = way.dry !== null && from !== null && Math.hypot(way.dry.x - from.x, way.dry.y - from.y, way.dry.z - from.z) <= DRY_WALK;
			const dry = way.dry !== null && (!way.searched || near) ? way.dry : null;
			const sky = dry === null && typeof rawBody.openSky === 'function' ? rawBody.openSky() : null;
			if (dry === null && sky === null) {
				wet = way.dry === null ? 'it has not stood on dry ground during this obtain, so there was no known way back out'
					: `a find search ended in the water, and the last dry ground it stood on is more than ${DRY_WALK} blocks back, so there was no known way back out`;
				return;
			}
			const to = dry ?? sky;
			const where = `${Math.floor(to.x)},${Math.floor(to.y)},${Math.floor(to.z)}`;
			step(`back out of the ${fluid} to ${where}${dry === null ? ' (the last open sky, the way the body came)' : ''}`);
			const out = await act('travel_to', { x: to.x, y: to.y, z: to.z, tolerance: 2, ...(dry === null ? { retrace: true } : { build: false }), timeoutMs: 60_000 });
			wet = inside(await body.observe()) ? `the walk back to dry ground at ${where} ended ${out?.reasonCode ?? out?.state ?? 'with no move'}` : null;
		};
		const ownCells = (o, rows) => {
			const at = bodyAt(o);
			if (at === null || !inside(o)) return [];
			const x = Math.floor(at.x), z = Math.floor(at.z);
			const levels = rows.filter((row) => row.blockId === id(fluid) && row.state?.level !== undefined);
			const fed = (c) => levels.length === 0 || levels.some((row) => String(row.state.level) === '0' && Math.abs(row.x - c.x) + Math.abs(row.y - c.y) + Math.abs(row.z - c.z) === 1);
			return [{ x, y: Math.floor(at.y + 1.62), z }, { x, y: Math.floor(at.y + 0.01), z }]
				.filter((row) => !budget.failed.has(cell(row)) && (sourceAt(rows, row) ?? fed(row)));
		};
		const scoop = async (o, also = null) => {
			const fresh = async () => {
				const sample = await body.observe();
				danger ??= bodyDanger(sample);
				return sample;
			};
			danger ??= bodyDanger(o);
			if (body.interrupted() || body.stopped()) return 'stopped';
			const seen = new Set();
			const eye = bodyAt(o);
			const rows = await seenRows(o);
			// A sighting no row lists is still tried (a source seen only through its flow), but not one the rows show is not one.
			const named = also === null || eye === null || budget.failed.has(cell(also)) || eyeDistance(eye, also) > REACH + 0.5 || sourceAt(rows, also) === false ? [] : [also];
			const inReach = [...ownCells(o, rows), ...(await sources(o, rows)).filter((row) => row.d <= REACH + 0.5), ...named]
				.filter((row) => !seen.has(cell(row)) && seen.add(cell(row))).slice(0, SCOOPS);
			if (inReach.length === 0) return null;
			const bucket = slotOf(o, ['bucket']);
			if (!bucket) return 'no empty bucket held';
			const selected = o.inventory?.selectedSlot;
			if (bucket.slotIndex >= 9) await act('select_tool', { sourceSlot: bucket.slotIndex, hotbarSlot: Number.isSafeInteger(selected) ? selected : 0, expectedItemId: 'minecraft:bucket', minRemainingDurability: 0 });
			else if (bucket.slotIndex !== selected) await act('select_item', { itemId: 'minecraft:bucket' });
			if (body.interrupted() || body.stopped()) return 'stopped';
			const before = heldCounts(o).get(asked) ?? 0;
			const way = { dry: lastDry, searched: dryBeforeSearch };
			let last = null, at = null;
			const cleared = new Set();
			for (const source of inReach) {
				step(`fill a bucket at the ${fluid} at ${cell(source)}`);
				const use = () => act('use_item', { durationMs: 1000, mode: 'once', expectedItemId: 'minecraft:bucket', aimX: source.x + 0.5, aimY: source.y + 0.5, aimZ: source.z + 0.5 });
				last = await use();
				const plant = PLANT_HIT.exec(String(last?.message ?? ''));
				let afterUse = await fresh();
				if (body.interrupted() || body.stopped()) return 'stopped';
				if (plant && !cleared.has(plant.slice(2).join(',')) && (heldCounts(afterUse).get(asked) ?? 0) <= before) {
					cleared.add(plant.slice(2).join(','));
					step(`clear the ${bare(plant[1])} the bucket's ray meets`);
					await act('break_block', { x: Number(plant[2]), y: Number(plant[3]), z: Number(plant[4]), expectedBlockId: plant[1], timeoutMs: 5_000 });
					await fresh();
					if (body.interrupted() || body.stopped()) return 'stopped';
					last = await use();
					afterUse = await fresh();
				}
				const after = afterUse;
				if (body.interrupted() || body.stopped()) return 'stopped';
				if ((heldCounts(after).get(asked) ?? 0) > before) { await outOfWater(inside(o), source, way); return true; }
				budget.failed.add(cell(source));
				if (fluid === 'water' && last?.reasonCode === 'USE_NOT_ACCEPTED') body.missPlace?.({ x: source.x, y: source.y, z: source.z }, UNREACHED_SPOT);
				at = source;
				if (body.interrupted() || body.stopped()) return 'stopped';
			}
			// None filled: out of the water before the next move (find and dig_to refuse from it).
			if (inside(await fresh())) await outOfWater(false, at, way);
			return `the bucket did not fill at ${inReach.length} source(s) in reach, last ${cell(at)} (${last?.reasonCode ?? last?.state ?? 'no use'}${last?.message ? `: ${String(last.message).slice(0, 120)}` : ''})`;
		};
		let o = await body.observe();
		const here = await scoop(o);
		if (here === true) return null;
		if (here === 'stopped' || here === 'no empty bucket held') return here;
		o = await body.observe();
		let source = (await sources(o))[0] ?? null;
		if (source === null) {
			if (typeof body.search !== 'function' || left() < 5_000) return here ?? `no ${fluid} in view`;
			step(`find ${fluid} to fill a bucket`);
			const result = await body.search({ block: id(fluid) }, { timeoutMs: Math.min(MAX_FIND_TIMEOUT_MS, left()) });
			budget.lastSearch = result;
			if (body.interrupted() || body.stopped()) return 'stopped';
			const seenAt = result?.find?.seen;
			const tool = result?.reasonCode === 'FIND_BLOCKED' ? (String(result?.message ?? '').match(/\b(TOOL_WORN|NO_TOOL)\b/) ?? (HAND_SPEED_STONE.test(String(result?.message ?? '')) ? [null, 'NO_TOOL'] : null)) : null;
			if (tool) { fillToolStop = { reasonCode: tool[1] ?? 'NO_TOOL', message: result.message }; return 'stopped'; }
			if (result?.reasonCode !== 'FIND_SEEN' || !seenAt || ![seenAt.x, seenAt.y, seenAt.z].every(Number.isFinite))
				return `no ${fluid} found (${result?.reasonCode ?? result?.state ?? 'no search'}: ${String(result?.message ?? '').slice(0, 160)})`;
			o = await body.observe();
			// The search's sighting itself only while no fill failed there: it stops at the first water it sees.
			source = (await sources(o))[0] ?? (budget.failed.has(cell(seenAt)) ? null : { x: seenAt.x, y: seenAt.y, z: seenAt.z });
			if (source === null) {
				if (fluid === 'water') body.missPlace?.({ x: seenAt.x, y: seenAt.y, z: seenAt.z }, UNREACHED_SPOT);
				return `the only ${fluid} found, at ${cell(seenAt)}, is one a fill already failed at`;
			}
		}
		const at = bodyAt(o);
		if (at !== null && eyeDistance(at, source) > REACH) {
			step(`walk to the ${fluid} at ${cell(source)}`);
			const plain = (o.inventory?.items ?? []).filter((row) => PLAIN_BLOCKS.test(bare(row.itemId))).reduce((sum, row) => sum + row.count, 0);
			let walked = null, after = null;
			// Any source in reach now will do (the walk ends at the bank, beside others of the same water).
			const reaches = async () => {
				const rows = await seenRows(o);
				return (await sources(o, rows)).some((row) => row.d <= REACH + 0.5) || ownCells(o, rows).length > 0 || eyeDistance(after, source) <= REACH + 0.5;
			};
			// In legs, with a look for water in reach after each: a player walking to water seen far off scoops the first that
			// comes within reach. Room water-8-y-54 (3 of 3 misses): the far bank of a lake was seen from 80 blocks, and the
			// walk reached the near bank, then bridged across the lake toward that one block until the 180 s ran out.
			const walkEnds = now() + FILL_WALK_MS;
			let closest = eyeDistance(at, source), closerAt = now();
			for (let leg = 0; ; leg += 1) {
				walkingOn = leg > 0;
				try {
					walked = await act('travel_to', { x: source.x + 0.5, y: source.y + 1, z: source.z + 0.5, tolerance: 2, build: plain > SPARE_BLOCKS, timeoutMs: Math.max(1_000, Math.min(FILL_LEG_MS, walkEnds - now())) });
				} finally { walkingOn = false; }
				if (body.interrupted() || body.stopped()) return 'stopped';
				o = await body.observe();
				after = bodyAt(o);
				if (walked?.reasonCode !== 'TRAVEL_TIMEOUT' || after === null || walkEnds - now() < FILL_LEG_MIN_MS || left() < FILL_LEG_MIN_MS || await reaches()) break;
				const d = eyeDistance(after, source);
				if (d < closest - FILL_PROGRESS) { closest = d; closerAt = now(); }
				else if (now() - closerAt >= FILL_STALL_MS) {
					walked = { state: 'FAILED', reasonCode: 'NO_ROUTE', message: `No closer to the ${fluid} for ${FILL_STALL_MS / 1000} s` };
					break;
				}
			}
			// Tool exhaustion says nothing about the source's reachability. Leave recovery to the model;
			// the next loop still checks cancellation, danger and fresh inventory before handing back.
			if (TOOL_STOPS.has(walked?.reasonCode)) { fillToolStop = walked; return 'stopped'; }
			if (after !== null && Math.floor(after.y) - source.y >= 3 && flatDistance(after, source) <= REACH && !(await reaches())) {
				step(`dig down to the ${fluid} at ${cell(source)}`);
				await act('dig_to', { pattern: 'shaft', y: source.y + 2, maxBlocks: 8, throughCaves: 'small', timeoutMs: 20_000 });
				if (body.interrupted() || body.stopped()) return 'stopped';
				o = await body.observe();
				after = bodyAt(o);
			}
			// A walk that ends at an edge over water below (room kit-gate-6: a ledge 5 blocks above a pool, beyond the 7-high
			// block sample, so no row lists it): a player digs down beside the drop until the water is in reach.
			// Once per obtain, and not after a walk a mob or damage stopped. Without a water bucket on the hotbar the shaft goes
			// down as two-column stairs that see each floor; with one it is the 1x1 bucket shaft beside a drop already known to
			// end in water, which stops where it opens into more than a small cave.
			const stoppedBy = ['HOSTILE_NEAR', ...DAMAGE_STOPS].includes(walked?.reasonCode);
			const edge = FILL_EDGE && !budget.edgeDug && !stoppedBy && after !== null && fluid === 'water' && !(await reaches()) ? waterBelowEdge(o) : null;
			if (process.env.MINEAGEN_FILL_TRACE) fillTrace({ at: after, walked: walked?.reasonCode ?? walked?.state ?? null, source, edges: o.player?.edges ?? null, edge,
				rows: (await seenRows(o)).filter((row) => row.blockId === id(fluid)).length });
			if (edge !== null) {
				budget.edgeDug = true;
				step(`dig down beside the drop to the ${fluid} at ${cell(edge)}`);
				// 'small': a drop of at most 4 on the way down, so the stairs never land the body below the pool it came for.
				const dug = await act('dig_to', { pattern: 'shaft', y: edge.y + 2, heading: edge.away, maxBlocks: 2 * (Math.floor(after.y) - edge.y), throughCaves: 'small', timeoutMs: 20_000 });
				if (body.interrupted() || body.stopped()) return 'stopped';
				if (TOOL_STOPS.has(dug?.reasonCode)) { fillToolStop = dug; return 'stopped'; }
				o = await body.observe();
				after = bodyAt(o);
				const filled = after === null ? null : await scoop(o, { x: edge.x, y: edge.y, z: edge.z });
				fillTrace({ dug: dug?.reasonCode ?? dug?.state ?? null, at: after, scooped: filled });
				if (filled === true) return null;
				if (filled === 'stopped' || filled === 'no empty bucket held') return filled;
				// The pool's own rows are in the block sample from down here: the next round picks a source among them, and the
				// far sighting this walk aimed at is not marked out by a dig that changed where the body stands.
				return EDGE_REDO;
			}
			if (after === null || !(await reaches())) {
				budget.failed.add(cell(source));
				// Out of find's sightings too, else the next search stops at the same spot; only that spot, not the water joined
				// to it, which can be a whole lake or sea with reachable shore elsewhere.
				if (fluid === 'water' && !['HOSTILE_NEAR', ...DAMAGE_STOPS].includes(walked?.reasonCode)) body.missPlace?.({ x: source.x, y: source.y, z: source.z }, UNREACHED_SPOT);
				return `could not get within reach of the ${fluid} at ${cell(source)} (${walked?.reasonCode ?? walked?.state ?? 'no move'})`;
			}
		}
		// The sighting itself is tried too, though no sample lists it as a source now (seen once, from afar).
		const filled = await scoop(o, source);
		if (filled === true) return null;
		// The walk stopped at other water in reach and none of it filled: the far sighting is the same long walk's end, so it
		// is out too, or the next search points straight back at it.
		if (typeof filled === 'string' && filled !== 'stopped' && filled !== 'no empty bucket held' && !budget.failed.has(cell(source))) {
			budget.failed.add(cell(source));
			if (fluid === 'water') body.missPlace?.({ x: source.x, y: source.y, z: source.z }, UNREACHED_SPOT);
			return filled;
		}
		if (filled === null && !budget.failed.has(cell(source))) {
			budget.failed.add(cell(source));
			if (fluid === 'water') body.missPlace?.({ x: source.x, y: source.y, z: source.z }, UNREACHED_SPOT);
			return `no source of the ${fluid} at ${cell(source)} is in reach from where the walk ended`;
		}
		return filled ?? `no ${fluid} source in reach`;
	};

	// Low health on a non-food obtain: eat carried food or let health regenerate (fork-rule.mjs), in slices of at most
	// WAIT_SLICE_MS for up to RECOVER_MS, judged again on each fresh sample. Returns null once health is back at the resume
	// line, 'stopped' when danger, an interruption or cancellation ended it (the loop top ends the run with that code),
	// else the fork that hands the choice back. A body already using an item (the eat reflex mid-bite) is left to finish.
	const recover = async () => {
		const began = now(), until = Math.min(deadline, began + RECOVER_MS);
		let ate = false, last = null;
		rawBody.recovering?.('active');
		try {
			while (true) {
				if (danger !== null || rawBody.interrupted() || rawBody.stopped()) return 'stopped';
				const o = await observe();
				const unsafe = bodyDanger(o);
				if (unsafe !== null) { danger ??= unsafe; return 'stopped'; }
				const health = o?.player?.health;
				if (!Number.isFinite(health)) return 'health unknown while recovering';
				if (last !== null && health < last) return `health fell ${last} -> ${health} while recovering`;
				if (health >= (ate ? EAT_RESUME_HEALTH : REGEN_RESUME_HEALTH)) return null;
				if (now() >= until) return `health ${health} after ${Math.round((now() - began) / 1000)} s of recovering`;
				last = health;
				const judged = lowHealthFork(o);
				if (judged.fork !== undefined) return judged.starved && health >= REGEN_RESUME_HEALTH ? null : judged.fork;
				// Food edible at any hunger (a golden apple) is not eaten again once the bar can regenerate: its effect heals.
				const fed = judged.food?.alwaysEdible === true && Number.isFinite(o.player?.foodLevel) && o.player.foodLevel >= 18;
				if (judged.recover === 'eat' && o.interaction?.usingItem !== true && !(ate && fed)) {
					step(`health ${health}: eat ${bare(judged.food.itemId)}`);
					for (const { actionType, arguments: args } of eatCalls(judged.food, o.inventory?.selectedSlot)) {
						const result = await act(actionType, args);
						if (danger !== null || rawBody.interrupted() || rawBody.stopped()) return 'stopped';
						if (result?.state !== 'SUCCEEDED') return `eating ${bare(judged.food.itemId)} failed (${lastFailure})`;
					}
					ate = true;
				} else if (judged.recover === 'regen') step(`health ${health}: wait for regeneration`);
				// One slice between bites as well: health climbs by regeneration (or the food's effect), not by the bite.
				const waited = await act('wait', { durationMs: Math.min(WAIT_SLICE_MS, Math.max(1_000, until - now())) });
				if (danger !== null || rawBody.interrupted() || rawBody.stopped()) return 'stopped';
				if (waited?.state !== 'SUCCEEDED') return `waiting to recover failed (${lastFailure})`;
			}
		} finally { rawBody.recovering?.('armed'); }
	};
	// Recovery's answer at the loop top: go on, or hand the fork back as LOW_HEALTH (never as danger).
	const recovered = async (stop) => {
		const why = await recover();
		if (why === null || why === 'stopped') return null;
		return end('INTERRUPTED', 'LOW_HEALTH', `${stop}, then ${why}; decide, then call obtain again to continue`, handle());
	};
	// The action danger left running (a body leg, or find's leg inside a search) goes back with every danger ending.
	const handle = () => (running === null ? {} : { running: { actionId: running.actionId, ...(running.recoveryHint ? { recoveryHint: running.recoveryHint } : {}) } });
	while (true) {
		if (danger !== null && lowLeg) {
			if (food) return end('INTERRUPTED', 'LOW_HEALTH', `Stopped at low health (${danger}); recover, then call obtain again to continue`, handle());
			// A leg's own low-health stop is recovered from here once, then the work goes on.
			const stop = `Stopped at low health (${danger})`;
			danger = null; lowLeg = false;
			const ended = await recovered(stop);
			if (ended !== null) return ended;
			continue;
		}
		if (danger !== null) return end('INTERRUPTED', 'DANGER', `Stopped for danger (${danger}); decide, then call obtain again to continue`, handle());
		if (rawBody.interrupted()) {
			const fork = forkStop();
			return fork === null ? end('INTERRUPTED', 'DANGER', 'Stopped for danger the reflexes did not handle; decide, then call obtain again to continue', handle())
				: end('INTERRUPTED', fork.reasonCode, `${fork.message ?? `Stopped: ${fork.reasonCode}`}; decide, then call obtain again to continue`, handle());
		}
		if (rawBody.stopped()) return end('CANCELLED', 'CANCELLED', 'Cancelled');
		if (cleanupObservationFailed) return end('FAILED', 'OBSERVATION_UNAVAILABLE', 'Fresh station cleanup observation unavailable');
		let o = await body.observe();
		// A container screen left open (a loot close that did not land before a stop): shut it before anything else.
		const screen = o.interaction?.menu;
		if (screen && CONTAINER_SCREEN.test(String(screen.type ?? screen.menuId ?? '')) && Number.isSafeInteger(screen.containerId) && screen.containerId !== 0) {
			await (rawBody.closeMenu ?? ((args) => rawBody.act('menu_close', args)))({ menuId: screen.type ?? screen.menuId, containerId: screen.containerId, stateId: screen.stateId });
			o = await body.observe();
		}
		counts = heldCounts(o);
		held = keepPickaxeMakings(counts, target.ids, index);
		have = target.ids.reduce((sum, member) => sum + (counts.get(member) ?? 0), 0);
		startHave ??= have;
		origin ??= o.player?.skyOpen === false ? null : bodyAt(o);
		// This sample can satisfy the inventory goal and report danger at the same time.
		const unsafe = bodyDanger(o);
		if (unsafe !== null) { danger ??= unsafe; continue; }
		// On a kit-iron trip (an iron tool's call that took on the rest of the kit's iron), the target alone does not end
		// it: the kit's iron still short, and the armour's, is mined from ore at hand first, while raw-iron tries and time are left.
		const kitShort = kitTrip ? kitAndArmourIronShort(o) : 0;
		// "At the ore": only while iron ore is in view or known within reach, never a fresh search after the target is held.
		const topUp = have >= count && kitShort > 0 && (failures.get('need:raw_iron') ?? 0) < 5 && left() > 60_000
			&& inView({ kind: 'mine', blocks: ['iron_ore', 'deepslate_iron_ore'], mobs: [] }, o, { ...budget, topUp: true }) !== null;
		budget.topUp = topUp;
		if (have >= count && !topUp) return end('SUCCEEDED', 'OBTAINED', `Obtained ${label}${kitTrip && kitShort > 0 ? `; the kit and its armour are still ${kitShort} iron short` : ''}`);
		if (now() - startedAt >= timeoutMs) return end('TIMED_OUT', 'OBTAIN_TIMEOUT', `timeoutMs ${timeoutMs} ran out`);
		if (capacityStop !== null) return end('FAILED', 'OBTAIN_STUCK', capacityStop);
		if (nightStop !== null) return end('INTERRUPTED', 'NIGHT', `Waiting for morning: ${nightStop}; call obtain again at dawn or from under cover`);
		if (approachStop !== null) return end('FAILED', approachStop.reasonCode, approachStop.message);
		if (++rounds > MAX_ROUNDS) return end('FAILED', 'OBTAIN_STUCK', `${MAX_ROUNDS} rounds without finishing`);
		const health = o.player?.health;
		if (!food && Number.isFinite(health) && health <= RECOVER_AT) {
			const ended = await recovered(`Health ${health}: stopped to recover`);
			if (ended !== null) return ended;
			continue;
		}
		if (fillToolStop !== null) return end('FAILED', fillToolStop.reasonCode,
			`The approach to ${fluid} stopped (${fillToolStop.reasonCode}: ${String(fillToolStop.message ?? '').slice(0, 240)}); replace or equip a usable tool, then call obtain again. The source was not marked unreachable`, handle());
		// Output an earlier call left in a furnace comes out first: the plan counts only the inventory.
		if (loads.length > 0) { await collectLoads(); continue; }
		// A filled bucket: an empty one first (the plan below makes it), then a source to fill it at.
		const goal = topUp ? { ids: ['raw_iron'], count: (counts.get('raw_iron') ?? 0) + kitShort }
			: fluid === null ? { ids: target.ids, count } : (held.get('bucket') ?? 0) > 0 ? null : { ids: ['bucket'], count: 1 };
		if (goal === null) {
			if (placed.length > 0) await cleanup();
			const why = await fillAt();
			if (why !== null && why !== 'stopped' && why !== EDGE_REDO) {
				failures.set('why:fill', why);
				step(why);
				if (fail('fill') >= FILL_TRIES) return end('FAILED', 'NO_SOURCE', `Stuck on ${fluid} to fill a bucket at: ${why}`);
			}
			continue;
		}
		const stations = Object.fromEntries(OBTAIN_STATIONS.map((kind) => [kind, nearStation(o, kind, placed, removed) !== null]));
		let plan;
		const seen = new Set([...seenIds(o)].filter((seenId) => !spent.has(seenId)));
		// Under cover, smelting fuel is coal first (held, seen, or a short search) before a climb for logs.
		const coalFirst = o.player?.skyOpen === false && (failures.get('need:coal') ?? 0) < COAL_FUEL_TRIES;
		coalShort = coalFirst && !seen.has('coal_ore') && !seen.has('deepslate_coal_ore');
		try {
			rememberStructures(looted, o);
			// Three loot steps that came to nothing (no way in, no chest found, a menu that would not open): chests drop out
			// of this call's plans, so the other ways are planned again rather than a stuck loot need.
			const loot = !OBTAIN_COSTS || (failures.get('loot') ?? 0) >= 3 ? [] : lootSources(o, { opened: new Set([...looted.opened, ...budget.failed]), searched: new Set([...looted.searched, ...budget.passed]), structures: looted.structures, partial: new Set(looted.partial ?? []) });
			const places = OBTAIN_COSTS ? seenPlaces(o) : null;
			// The food the trip down still lacks: a village's bread is then worth the visit before the trip, not after; with a
			// full bar's worth held, none is.
			const foodShort = OBTAIN_COSTS ? tripFoodShort(counts) : 0;
			plan = planObtain(goal, { held, seen, stations, index, coalFirst, dimension: o.world?.dimension, loot, gear: gearOf(o), places, food: foodShort });
			lastPlan = plan;
			// What the plan weighed, once per change: the loot it knew of and the way each need takes.
			const weighed = `plan: ${plan.needs.map((need) => `${need.kind} ${need.count} ${need.accept[0]}`).join(', ') || 'crafts only'}; loot known: ${loot.length === 0 ? 'none' : loot.slice(0, 3).map((row) => `${row.kind === 'chest' ? 'chest' : row.name} ${Math.round(row.distance)}m`).join(', ')}`;
			if (weighed !== lastWeighed) { lastWeighed = weighed; step(weighed); }
			// At the ore for an iron tool, the rest of the route's kit iron comes in the same trip: a second trip down for
			// the shield's, buckets' and flint and steel's iron costs the whole descent again.
			const extra = OBTAIN_COSTS && !topUp ? kitIronExtra(o, plan) : 0;
			if (extra > 0) kitTrip = true;
			if (extra > 0) plan = planObtain({ ...goal, also: [{ ids: ['raw_iron'], count: extra }] }, { held, seen, stations, index, coalFirst, dimension: o.world?.dimension, loot, gear: gearOf(o), places, food: foodShort });
			// The wood kept back for the next pickaxes never sends the body up for wood from under cover: there it is spent
			// on what this call needs (a table, sticks, a shield). On the surface a log is near and the reserve holds.
			const woodNeed = (candidate) => candidate.accept.some((member) => /(_log|_wood|_planks|^stick)$/.test(bare(member)));
			if (held !== counts && o.player?.skyOpen === false && plan.needs.some(woodNeed)) {
				const full = planObtain(goal, { held: counts, seen, stations, index, coalFirst, dimension: o.world?.dimension, loot, gear: gearOf(o), places });
				if (!full.needs.some(woodNeed)) { plan = full; held = counts; }
			}
			const sound = [...counts].some(([item, n]) => /_pickaxe$/.test(item) && n > 0);
			// Not once its own craft has failed twice (no table spot underground, #319's case): then the goal goes on as before.
			if (goal !== null && !sound && o.player?.skyOpen === false && !target.ids.some((one) => /_pickaxe$/.test(one))
				&& !(failures.get('op:stone_pickaxe') >= 2)) {
				const spare = planObtain({ ids: ['stone_pickaxe'], count: 1 }, { held: counts, seen, stations, index, coalFirst, dimension: o.world?.dimension, places });
				if (spare.needs.length === 0 && spare.unreachable.length === 0 && spare.ops.length > 0) {
					if (!spareFirst) step('no sound pickaxe under cover: a stone pickaxe first, from what is held');
					spareFirst = true;
					plan = spare; held = counts;
				}
			}
		}
		catch (error) { return end('FAILED', 'OBTAIN_STUCK', `The plan for ${label} could not be made (${String(error?.message ?? error).slice(0, 120)})`); }
		lastPlan = plan;
		materialsKeep = new Set([...target.ids, ...plan.needs.flatMap((n) => n.accept),
			...plan.ops.flatMap((op) => op.inputs.flatMap((input) => fuelMembers(input.spec.startsWith('#') ? input.spec : input.spec.split('|'))))].map(bare));

		if (plan.unreachable.length > 0) return end('FAILED', 'NO_WAY', `No way the body can make ${plan.unreachable.join(', ')} from the game data (no recipe at a table or furnace, block in this dimension or supported mob)`);
		// Surface sources (trees, gravel, animals) before stone, stone before ore: the body is on the surface first.
		const depth = (candidate) => candidate.kind === 'kill' || candidate.kind === 'loot' ? 0 : candidate.blocks.some((block) => ORE_BLOCKS.test(block)) ? 2 : candidate.blocks.every((block) => STONE_BLOCKS.test(block)) ? 1 : 0;
		// A need that failed waits until the others have had their turn: gravel missed on the surface is often in the
		// tunnels dug for iron.
		// A loot visit's misses count apart from the item's other ways: three empty chests must not use up the tree's tries.
		const needKey = (candidate) => `${candidate.kind === 'loot' ? 'loot-need' : 'need'}:${candidate.accept[0]}`;
		const tries = (candidate) => failures.get(needKey(candidate)) ?? 0;
		// Ore gets more tries than a surface source: each try is another vein, and the deadline still bounds them.
		const triesLeft = (candidate) => tries(candidate) < (depth(candidate) === 2 ? 5 : 3);
		// A need still to gather (its tool held, tries left) that brings more of any of these items.
		const gathering = (members) => plan.needs.some((need) => !need.tool && triesLeft(need) && need.accept.some((accepted) => members.includes(accepted)));
		// Every craft and smelt possible now, crafts first (planks for fuel before the load), each in dependency order;
		// stations count as ready when held or near.
		const stationReady = (op) => op.station === 'inventory' || stations[op.station] || (held.get(op.station) ?? 0) > 0;
		const smeltReady = (op) => {
			const n = readyTimes(op, held, index);
			const input = op.inputs[0].spec.startsWith('#') ? index.tags[op.inputs[0].spec] ?? [] : op.inputs[0].spec.split('|');
			if (n < op.times && gathering(input)) return false;
			const cover = fuelCover(held);
			return cover >= n || (cover > 0 && !gathering(FUEL_GROUPS.flatMap(fuelMembers)));
		};
		const ready = plan.ops.filter((candidate) => !(failures.get(`op:${candidate.outputs[0]}`) >= 2) && stationReady(candidate) && readyTimes(candidate, held, index) > 0);
		const op = ready.find((candidate) => candidate.kind !== 'smelt') ?? ready.find((candidate) => candidate.kind === 'smelt' && smeltReady(candidate));
		if (!op) {
			const early = ready.find((candidate) => candidate.kind === 'smelt' && !overlapped.has(candidate.outputs[0]) && readyTimes(candidate, held, index) >= 2 && !smeltReady(candidate));
			const input = early ? (early.inputs[0].spec.startsWith('#') ? index.tags[early.inputs[0].spec] ?? [] : early.inputs[0].spec.split('|')) : [];
			const rest = early ? plan.needs.find((candidate) => !candidate.tool && triesLeft(candidate) && candidate.accept.some((accepted) => input.includes(accepted))) : null;
			const source = rest ? inView(rest, o, budget) : null;
			const at = bodyAt(o);
			if (source && at && Math.hypot(source.x + 0.5 - at.x, source.y - at.y, source.z + 0.5 - at.z) <= OVERLAP_WALK) {
				overlapped.add(early.outputs[0]);
				const n = readyTimes(early, held, index);
				lastFailure = null;
				if (await smelt(early, n, false)) {
					step(`${n} ${bare(input[0])} smelting while the rest is mined`);
					// The loaded input left the inventory: the gather counts from what is held now, not from before the load.
					counts = heldCounts(await body.observe());
					const why = await gatherNeed(rest);
					if (why !== null && why !== 'stopped') { failures.set(`why:${rest.accept[0]}`, why); step(why); fail(`need:${rest.accept[0]}`); }
				}
				continue;
			}
		}
		if (op) {
			const times = readyTimes(op, held, index);
			lastFailure = null;
			const ok = op.kind === 'smelt' ? await smelt(op, times) : await craft(op, times, o);
			if (!ok) {
				failures.set(`why:${op.outputs[0]}`, lastFailure ?? 'no result');
				if (fail(`op:${op.outputs[0]}`) >= 2) step(`${op.kind} ${op.outputs[0]} failed twice: ${lastFailure ?? 'no result'}`);
			}
			continue;
		}
		// Then one raw need in full: the cheapest whose tool is held (logs before stone before ore).
		const need = plan.needs.filter((candidate) => !candidate.tool && triesLeft(candidate)).sort((a, b) => tries(a) - tries(b) || depth(a) - depth(b))[0];
		if (!need) {
			const blocked = plan.ops.filter((candidate) => readyTimes(candidate, held, index) > 0 && !stationReady(candidate)).map((candidate) => `${candidate.outputs[0]} needs a ${candidate.station}`);
			const failedOps = plan.ops.filter((candidate) => failures.get(`op:${candidate.outputs[0]}`) >= 2).map((candidate) => `${candidate.kind} ${candidate.outputs[0]} failed: ${failures.get(`why:${candidate.outputs[0]}`)}`);
			const why = [...failedOps, ...blocked, ...plan.needs.map((n) => `${n.count} ${n.accept[0]}${n.tool ? ` (needs ${n.tool})` : ''}${failures.has(needKey(n)) ? `: ${failures.get(`why:${n.accept[0]}`) ?? 'failed'}` : ''}`)];
			const sourceless = plan.needs.filter((n) => !n.tool && !triesLeft(n));
			if (sourceless.length > 0) return end('FAILED', 'NO_SOURCE', `Stuck on ${sourceless.map((n) => `${n.accept[0]}: ${failures.get(`why:${n.accept[0]}`)}`).join('; ')}`, { missing: why });
			return end('FAILED', 'OBTAIN_STUCK', `Stuck: still missing ${why.join('; ') || 'a step the game data does not show'}`, { missing: why });
		}
		// Keep the last coal decision in the result: remote runs retain steps but not inventory observations or traces.
		if (need.accept.includes('coal') && plan.fuel !== null) {
			fuelDiagnostic = `coal fuel decision ${JSON.stringify({ goal, counts: Object.fromEntries(counts), available: Object.fromEntries(held),
				skyOpen: o.player?.skyOpen ?? null, stations, seen: [...seen], coalFirst, coalFailures: failures.get('need:coal') ?? 0,
				tools: (o.inventory?.items ?? []).filter((row) => /_pickaxe$/.test(row.itemId ?? '')).map(({ itemId, slot, count, damage, maxDamage }) => ({ itemId, slot, count, damage, maxDamage })),
				plan: { needs: plan.needs, ops: plan.ops, fuel: plan.fuel } })}`;
			body.note(fuelDiagnostic);
		}
		if (placed.length > 0) await cleanup();
		// Needs over the same blocks (any log for planks, oak log for a boat) are one trip: gather them together.
		const together = plan.needs.filter((other) => other.kind === need.kind && !other.tool && (other.blocks.some((block) => need.blocks.includes(block)) || other.mobs.some((mob) => need.mobs.includes(mob))));
		const merged = together.length < 2 ? need : { ...need, count: together.reduce((sum, other) => sum + other.count, 0),
			accept: [...new Set([...need.accept, ...together.flatMap((other) => other.accept)])], blocks: [...new Set([...need.blocks, ...together.flatMap((other) => other.blocks)])] };
		const why = await gatherNeed(merged);
		if (capacityStop === null && noSurface !== null && danger === null && !rawBody.interrupted()) return end('FAILED', 'NO_SOURCE', noSurface);
		if (why !== null) {
			failures.set(`why:${need.accept[0]}`, why);
			step(why);
			fail(needKey(need));
			if (!triesLeft(need)) for (const source of [...(need.blocks ?? []), ...(need.mobs ?? [])]) spent.add(source);
		}
	}
}
