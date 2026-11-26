// Night as a player without armour plays it: off the surface by dusk, back out at dawn. From-scratch games on main
// (22 Nov, 16 games): 10 of 14 deaths were surface mobs at night, and in each the body had walked or climbed up into the
// dark for a search (water for a bucket, gravel, logs, sheep) or respawned at night into the same pack.
const DAY_TICKS = 24_000;
import { getSwitch } from './switches.mjs';
/** Mobs spawn on open ground from dusk; sunrise burns zombies and skeletons from about here. */
export const NIGHT_FROM = 12_000;
export const NIGHT_UNTIL = 23_500;
/** A climb takes a minute or two: within this many ticks before dusk (about a minute) the body stays down. */
export const DUSK_PLAN_TICKS = 1_200;
/** Full iron armour: at or above it a night on the surface is a fight the body can take. */
export const NIGHT_ARMOUR = 15;
/** A walk this short on the surface is a step to cover (a stair, a hole), not an errand. */
const SHORT_WALK = 8;
/** A walk ending this far below the body is a way down into a cave, not a walk across the hills. */
const WAY_DOWN = 8;
/**
 * ServerRestController.underground: more than this much ground over the eyes and rest returns UNDERGROUND at once, so
 * the gate does not offer it there. EYE_HEIGHT is a standing player's eye above its feet.
 */
const REST_UNDERGROUND_DEPTH = 4;
const EYE_HEIGHT = 1.62;

const WALKS = new Set(['travel_to', 'navigate_to']);

function tickOf(dayTime) {
	return Number.isFinite(dayTime) ? ((dayTime % DAY_TICKS) + DAY_TICKS) % DAY_TICKS : null;
}

function bodyAt(observation) {
	const p = observation?.position ?? observation?.player;
	return p && [p.x, p.y, p.z].every(Number.isFinite) ? p : null;
}

/** 'night', 'dusk' (the minute before it), or null, for an unarmoured body in the Overworld. */
export function nightFor(observation) {
	const world = observation?.world, player = observation?.player;
	if (world?.dimension !== 'minecraft:overworld' || player?.dead === true) return null;
	if (Number.isFinite(player?.armor) && player.armor >= NIGHT_ARMOUR) return null;
	const tick = tickOf(world.dayTime);
	if (tick === null) return null;
	if (tick >= NIGHT_FROM && tick < NIGHT_UNTIL) return 'night';
	return tick >= NIGHT_FROM - DUSK_PLAN_TICKS && tick < NIGHT_FROM ? 'dusk' : null;
}

/** A climb up to this many blocks is a step out of a pocket (a mined vein, a pickup hole), not a way to the surface. */
const POCKET_CLIMB = 8;
/** A climb ending this close under the last open sky the body stood under comes out at the surface. */
const SKY_MARGIN = 4;

/**
 * A move that takes the body up out of cover: a retrace back toward the open sky it came down from, stairs with no
 * height (they run to the surface), or a climb that rises past a pocket's depth or ends near the known open sky.
 * Review of #117: obtain's stairs out of the pocket a vein left (a few blocks, deep underground) stay allowed.
 */
function climbsUp(actionType, args, at, openSky) {
	if (WALKS.has(actionType) && args?.retrace === true) return true;
	const up = actionType === 'dig_to' ? args?.pattern === 'stairs_up' || Number.isFinite(args?.y) && at !== null && args.y > at.y + 2 && args.pattern !== 'stairs_down'
		: WALKS.has(actionType) && Number.isFinite(args?.y) && at !== null && args.y > at.y + 3;
	if (!up) return false;
	if (!Number.isFinite(args?.y) || at === null) return true;
	if (args.y - at.y > POCKET_CLIMB) return true;
	return Number.isFinite(openSky?.y) && args.y >= openSky.y - SKY_MARGIN;
}

function walkLength(args, at) {
	if (Number.isFinite(args?.distance)) return args.distance;
	if (at === null || !Number.isFinite(args?.x) || !Number.isFinite(args?.z)) return Infinity;
	return Math.hypot(args.x - at.x, args.z - at.z);
}

/**
 * Why this errand move waits for morning, or null. Under cover, a climb up is refused from a minute before dusk; on open
 * ground, a walk longer than a step to cover is refused after dark. Getting out of water and going down are never
 * refused (breath and cover come first), nor anything in full iron or outside the Overworld.
 */
export function nightMoveStop(observation, actionType, args = {}, { environment = process.env, openSky = null } = {}) {
	// MINEAGEN_NIGHT_COVER=off restores the old behaviour, for room A/Bs on one code bundle.
	if (!getSwitch('night.cover', environment).value) return null;
	const phase = nightFor(observation);
	if (phase === null || !(WALKS.has(actionType) || actionType === 'dig_to')) return null;
	const player = observation.player ?? {};
	if (player.inWater === true || player.underWater === true) return null;
	const at = bodyAt(observation);
	const armour = Number.isFinite(player.armor) ? player.armor : 0;
	const when = phase === 'dusk' ? 'dusk is a minute away' : 'it is night';
	if (player.skyOpen === false && climbsUp(actionType, args, at, openSky)) {
		// Rest only seals a shallow spot: deeper it hands back UNDERGROUND at once, so only what works down here is named.
		// Depth is estimated from the last open sky the body stood under, not the ground straight above it (the
		// observation has no such height): under a hill or a valley away from that spot the estimate can be off either
		// way, and with no open sky known it counts as deep. The deep line names only steps that work anywhere under cover.
		const shallow = at !== null && Number.isFinite(openSky?.y) && openSky.y - (at.y + EYE_HEIGHT) <= REST_UNDERGROUND_DEPTH;
		return shallow
			? `${when} and armour is ${armour}: staying under cover instead of climbing to the surface. Work down here (smelt, craft, mine), or rest (it seals the way up) and go up at dawn`
			: `${when} and armour is ${armour}: staying under cover instead of climbing to the surface. Down here the night changes nothing: smelt, craft or mine on, or wait for dawn, then go up`;
	}
	if (phase === 'night' && player.skyOpen !== false && WALKS.has(actionType) && !(Number.isFinite(args?.y) && at !== null && args.y < at.y - WAY_DOWN) && walkLength(args, at) > SHORT_WALK) {
		return `${when} on open ground and armour is ${armour}: not walking out among the mobs. rest (bed, walls or a dug hole) until dawn, or dig down and work underground`;
	}
	return null;
}

/** What a fresh body walks, digs or gathers with: the errands a night respawn rests before. */
const ERRAND_KINDS = new Set(['obtain', 'find', 'gather', 'lookAround', 'repair_inventory']);
const ERRAND_ACTIONS = new Set(['travel_to', 'navigate_to', 'dig_to', 'mine_vein', 'build', 'build_shelter', 'fight_until', 'barter_until', 'cast_obsidian']);

function errandOf(tool) {
	if (ERRAND_KINDS.has(tool?.kind)) return true;
	const action = tool?.kind === 'sequence' ? tool.actions?.[0] : ['action', 'start_action'].includes(tool?.kind) ? tool : null;
	if (!ERRAND_ACTIONS.has(action?.actionType)) return false;
	// A way down is cover already.
	return !(action.actionType === 'dig_to' && action.arguments?.pattern === 'stairs_down');
}

/**
 * respawn.restFirst: a body that respawned at night with no armour on open ground rests (a dug, roofed hole) before its
 * first errand, the way a player does. Fresh games on main (8 games, 42 deaths): 5 deaths came out of a night respawn
 * that went straight back out (a sheep hunt, a pickaxe, a walk) beside the mobs that had just killed it, the model
 * ignoring the respawn line's "rest first". Fights, flight, eating, shields and rest itself pass untouched.
 */
export function restsFirst(observation, tool, { environment = process.env } = {}) {
	if (!getSwitch('respawn.restFirst', environment).value) return false;
	if (nightFor(observation) !== 'night' || observation?.player?.skyOpen === false) return false;
	if (observation.player.inWater === true || observation.player.underWater === true) return false;
	return errandOf(tool);
}
