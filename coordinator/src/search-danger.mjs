// What a search does about a hostile, as a player keeps searching through what it can handle: one melee mob it can beat
// at good health is fought, a mob behind a wall or not after the body is left alone, and anything else is the model's
// fork, handed back with its reason: low health, a creeper, several mobs after it, a ranged mob shooting from where it
// stands, a mob it does not take on alone. Pure; one rule for find's legs (find-search.mjs) and for the coordinator's
// danger steer while a search runs (dynamic-main.mjs). Gate run 3 (8 games): 24 danger hand-backs during find and
// obtain were about mobs, 8 of them one zombie or mobs behind rock or not after the body, each a model round trip.

// Mobs a body fights alone with what it carries (zombie kin, spiders, silverfish, small slimes).
const FLINCH_MELEE = /^minecraft:(zombie|husk|zombie_villager|spider|cave_spider|silverfish|endermite|slime)$/;
const RANGED = /^minecraft:(skeleton|stray|bogged|parched|pillager|witch|blaze|ghast|breeze|drowned)$/;
const WEAPON = /(^|:)[a-z_]+_(sword|axe)$/;
const TOOL = /(^|:)[a-z_]+_pickaxe$/;
// The mob's hit when the server does not say (a zombie on normal).
const HIT = 3;
const HITS = 3;
export const SEARCH_LOW_HEALTH = 8;
// Threat rows the server senses reach 16 blocks (ThreatPerception.RANGE); a creeper this close counts even unaware.
const RANGE = 16;
const CREEPER_NEAR = 8;
// A mob after the body engages it when it sees the body or is this close; one farther off behind rock is behind a wall.
export const ENGAGE_CLOSE = 6;

const short = (id) => String(id).replace(/^minecraft:/u, '');
const at = (row) => `${short(row.type)} ${Math.round(row.distance)} blocks away`;
const hunting = (row, attacker) => row.targeting === true || (Array.isArray(row.signals) && (row.signals.includes('targeting') || row.signals.includes('attacked')))
	|| (attacker !== null && attacker === row.uuid);

/** The sample's threat rows (the server's ThreatPerception entries) that carry a type and a distance, or null when the
 * sample has no threat rows at all. */
export function threatRows(observation) {
	const rows = Array.isArray(observation?.player?.threats) ? observation.player.threats
		: Array.isArray(observation?.threats?.entries) ? observation.threats.entries : null;
	return rows === null ? null : rows.filter((row) => row !== null && typeof row === 'object' && typeof row.type === 'string' && Number.isFinite(row.distance));
}

/** Melee pursuers can reach a shelter opening after the body has rounded a corner or put some distance between them. */
export function pursuedByPack(observation) {
	const attacker = observation?.player?.lastAttacker?.uuid ?? null;
	const seen = new Set();
	const pursuers = (threatRows(observation) ?? []).filter(row => {
		const id = row.uuid ?? row.stableId;
		return row.alive !== false && row.distance <= RANGE && hunting(row, attacker) && !seen.has(id) && seen.add(id);
	});
	const melee = pursuers.filter(row => !RANGED.test(row.type));
	return melee.length >= 2 || pursuers.length >= 2 && melee.some(row => row.distance <= ENGAGE_CLOSE);
}

export const CREEPER_NO_WALL = 16;

/** The nearest live creeper within CREEPER_NO_WALL blocks in the sample's threat or entity rows ({ uuid, distance, x?, z? }), or null. */
export function creeperNear(observation) {
	const p = observation?.player ?? {};
	const rows = (threatRows(observation) ?? []).filter((row) => row.type === 'minecraft:creeper' && row.alive !== false)
		.map((row) => ({ uuid: row.uuid ?? row.stableId, distance: row.distance, x: row.x, z: row.z }));
	if ([p.x, p.y, p.z].every(Number.isFinite)) {
		for (const row of observation?.entities ?? []) {
			if (row?.type !== 'minecraft:creeper' || row.alive === false || ![row.x, row.y, row.z].every(Number.isFinite)) continue;
			rows.push({ uuid: row.uuid ?? row.stableId, distance: Math.hypot(row.x - p.x, row.y - p.y, row.z - p.z), x: row.x, z: row.z });
		}
	}
	return rows.filter((row) => row.distance <= CREEPER_NO_WALL).sort((a, b) => a.distance - b.distance)[0] ?? null;
}

/** Resource errands must not walk out under a currently seen blaze, even before it targets the body. */
export function blazeBlocksErrand(o) {
 if (o?.ready !== true || o.player?.dead === true || o.continuity?.phase === 'dead' || o.continuity?.rememberedSections?.includes('player')) return null;
 return (threatRows(o) ?? []).find(r => r.type === 'minecraft:blaze' && r.alive !== false
  && (r.lineOfSight === true || r.targeting === true && r.distance <= 3)) ?? null;
}

/**
 * The search's call on the hostiles in a sample: null when it shows no threat rows (nothing for this rule to judge),
 * { fork: reason } when the model decides, or { handle: 'fight' | 'ignore', mob, why } when the body does.
 */
export function searchDanger(observation) {
	const blaze = blazeBlocksErrand(observation);
	if (blaze !== null) return { fork: `a ${at(blaze)} can threaten an errand; choose cover or combat before fetching resources` };
	const player = observation?.player ?? {};
	const rows = threatRows(observation);
	if (rows === null) return null;
	const seen = new Set();
	const threats = rows.filter((row) => row.distance <= RANGE && !seen.has(row.uuid ?? row.stableId) && seen.add(row.uuid ?? row.stableId));
	if (threats.length === 0) return null;
	const attacker = typeof player.lastAttacker?.uuid === 'string' ? player.lastAttacker.uuid : null;
	const health = Number.isFinite(player.health) ? player.health : null;
	const items = (observation?.inventory?.items ?? []).map((item) => item?.itemId ?? '');
	const armed = items.some((item) => WEAPON.test(item)), tool = items.some((item) => TOOL.test(item));
	const creeper = threats.find((row) => row.type === 'minecraft:creeper' && (hunting(row, attacker) || row.lineOfSight === true || row.swelling === true || row.distance <= CREEPER_NEAR));
	if (creeper !== undefined) return { fork: `a creeper ${Math.round(creeper.distance)} blocks away` };
	const after = threats.filter((row) => hunting(row, attacker));
	const engaged = after.filter((row) => row.lineOfSight === true || row.distance <= ENGAGE_CLOSE);
	if (engaged.length >= 2) return { fork: `${engaged.length} hostiles after it (${engaged.slice(0, 3).map(at).join(', ')})` };
	if (health !== null && health <= SEARCH_LOW_HEALTH && after.length > 0) return { fork: `health ${health} with a ${at(after[0])}` };
	if (engaged.length === 0) {
		if (after.length > 0) return { handle: 'ignore', mob: after[0], why: `${after.map(at).join(', ')}, behind rock out of its sight` };
		const nearest = threats.slice().sort((a, b) => a.distance - b.distance)[0];
		return { handle: 'ignore', mob: nearest, why: `${at(nearest)}, not after the body` };
	}
	const mob = engaged[0];
	if (RANGED.test(mob.type)) {
		// A ranged mob shoots only what it sees: out of its sight it is no danger until it has a line of sight.
		if (mob.lineOfSight !== true) return { handle: 'ignore', mob, why: `${at(mob)}, out of its sight` };
		return { fork: `a ${at(mob)} with a line of sight, shooting from where it stands` };
	}
	if (!FLINCH_MELEE.test(mob.type)) return { fork: `a ${at(mob)}, not one to fight alone` };
	if (!armed && !tool) return { fork: `a ${at(mob)} and nothing to fight it with` };
	const hit = Number.isFinite(mob.expectedHitDamage) && mob.expectedHitDamage > 0 ? mob.expectedHitDamage : HIT;
	if (health === null || health < SEARCH_LOW_HEALTH + HITS * hit) return { fork: `a ${at(mob)} and health ${health ?? '?'}: ${HITS} of its hits would end a fight at ${SEARCH_LOW_HEALTH} with it alive` };
	return { handle: 'fight', mob, why: `one ${at(mob)}, health ${health}` };
}

// Danger steers a running search may answer itself: a hit, and a threat edge (a mob starts hunting, closes in).
export const SEARCH_HELD_TRIGGERS = Object.freeze(new Set(['damage', 'threat']));

/**
 * Why a danger steer is held while a search runs (the body answers it: fights the one mob, or leaves it behind rock), or
 * null when it steers as before. A hit is held only when it came from the mob the search fights; any other damage steers.
 */
export function searchHoldsSteer(attention, observation) {
	if (!SEARCH_HELD_TRIGGERS.has(attention?.trigger)) return null;
	const judged = searchDanger(observation);
	if (judged === null || judged.fork !== undefined) return null;
	if (attention.trigger === 'damage' && !hitBy(observation?.player ?? {}, judged)) return null;
	return judged.why;
}

/**
 * Whether the latest damage was the fought mob's melee hit. Every health drop arrives as trigger 'damage', and
 * lastAttacker stays set 5 s after a hit, so lava, a fall or a wall reached in that time would read as the mob's.
 * hurtBy is the last damage's own source (vanilla keeps it 2 s): 'mob_attack by <type>' for a melee hit.
 */
function hitBy(player, judged) {
	if (judged.handle !== 'fight' || player.inLava === true || player.onFire === true) return false;
	const [cause, , type] = typeof player.hurtBy === 'string' ? player.hurtBy.split(' ') : [];
	if (cause !== 'mob_attack' || (type !== undefined && type !== judged.mob.type)) return false;
	const attacker = player.lastAttacker?.uuid;
	return typeof attacker === 'string' && attacker === (judged.mob.uuid ?? judged.mob.stableId);
}
