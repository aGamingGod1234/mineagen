// Night as a player without armour plays it: off the surface by dusk, back out at dawn. From-scratch games on main
// (22 Nov, 16 games): 10 of 14 deaths were surface mobs at night, and in each the body had walked or climbed up into the
// dark for a search (water for a bucket, gravel, logs, sheep) or respawned at night into the same pack.
const DAY_TICKS = 24_000;
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

/** A move that takes the body up out of cover: stairs up, or a retrace back toward the open sky it came down from. */
function climbsUp(actionType, args, at) {
	if (actionType === 'dig_to') return args?.pattern === 'stairs_up' || Number.isFinite(args?.y) && at !== null && args.y > at.y + 2 && args.pattern !== 'stairs_down';
	return WALKS.has(actionType) && (args?.retrace === true || Number.isFinite(args?.y) && at !== null && args.y > at.y + 3);
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
export function nightMoveStop(observation, actionType, args = {}, environment = process.env) {
	// MINEAGEN_NIGHT_COVER=off restores the old behaviour, for room A/Bs on one code bundle.
	if (String(environment?.MINEAGEN_NIGHT_COVER ?? '').trim().toLowerCase() === 'off') return null;
	const phase = nightFor(observation);
	if (phase === null || !(WALKS.has(actionType) || actionType === 'dig_to')) return null;
	const player = observation.player ?? {};
	if (player.inWater === true || player.underWater === true) return null;
	const at = bodyAt(observation);
	const armour = Number.isFinite(player.armor) ? player.armor : 0;
	const when = phase === 'dusk' ? 'dusk is a minute away' : 'it is night';
	if (player.skyOpen === false && climbsUp(actionType, args, at)) {
		return `${when} and armour is ${armour}: staying under cover instead of climbing to the surface. Work down here (smelt, craft, mine), or rest (it seals the way up) and go up at dawn`;
	}
	if (phase === 'night' && player.skyOpen !== false && WALKS.has(actionType) && !(Number.isFinite(args?.y) && at !== null && args.y < at.y - WAY_DOWN) && walkLength(args, at) > SHORT_WALK) {
		return `${when} on open ground and armour is ${armour}: not walking out among the mobs. rest (bed, walls or a dug hole) until dawn, or dig down and work underground`;
	}
	return null;
}
