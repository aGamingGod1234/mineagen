// The lesson rules of the coordinator's death and failure review. Each rule names a situation that the coordinator can
// recognise from its own recent history (the death cause, what was running, recent results, health, food, the
// hostiles in view), the advice a player would take from it, and the situation in which that advice is shown again.
// Advice text is fixed here and slots are vocabulary ids, so a lesson can never carry a coordinate or a place name.
//
// Rules cover patterns that repeated across games in recorded rounds and that the body does not already handle
// (see docs/technical-catalogue for the counts). A rule whose cause a skill fix removes should be retired with it.

const RANGED = new Set(['skeleton', 'stray', 'bogged', 'pillager', 'piglin', 'blaze', 'ghast', 'drowned']);
const FLEE_ACTIONS = new Set(['flee_from']);
const MOVE_ACTIONS = new Set(['travel_to', 'move_to', 'pick_up_item', 'find', 'obtain']);
const LOW_HEALTH = 8;
const FIGHTS = new Set(['fight_target', 'fight_until']);
const TRIPS = new Set(['travel_to', 'dig_to', 'build', 'mine_vein', 'navigate_to']);

function pretty(id) { return String(id).replace(/_/g, ' '); }
function recentlyRan(context, types, withinMs = 15_000) {
	return context.running.some((type) => types.has(type))
		|| context.results.some((result) => types.has(result.actionType) && context.at - result.at <= withinMs);
}
function healthBefore(context, ms) {
	const sample = [...context.samples].reverse().find((entry) => context.at - entry.at >= ms && Number.isFinite(entry.health));
	return sample?.health ?? null;
}
function resultWithin(context, types, codes, withinMs) {
	return context.results.some((result) => types.has(result.actionType) && codes.includes(result.reasonCode) && context.at - result.at <= withinMs);
}
/** Counts one failure in this game's tally and says whether it is the nth inside the window. */
function repeated(row, tally, key, times, withinMs) {
	const seen = (tally.get(key) ?? []).filter((at) => row.at - at <= withinMs);
	seen.push(row.at);
	tally.set(key, seen);
	return seen.length === times;
}
function lastKnown(context, field) {
	for (let index = context.samples.length - 1; index >= 0; index--) if (context.samples[index][field] !== undefined) return context.samples[index][field];
	return undefined;
}

/** Rules by id. `death(context)` or `failure(row, tally)` returns slots when the rule applies, else null. */
export const LESSON_RULES = Object.freeze({
	'ranged-fled-in-open': {
		death: (context) => RANGED.has(context.cause.cause) && context.cause.kind !== 'melee' && recentlyRan(context, FLEE_ACTIONS) ? { mob: context.cause.cause } : null,
		trigger: ({ mob }) => ({ mobs: [mob] }),
		text: ({ mob }) => `Running from a ${pretty(mob)} in the open kept you in its range until you died. Put a solid block between you and it, or dig into a hole with a roof and wait until it loses you.`,
	},
	'ranged-death': {
		death: (context) => RANGED.has(context.cause.cause) && context.cause.kind === 'shot' && !recentlyRan(context, FLEE_ACTIONS) ? { mob: context.cause.cause } : null,
		trigger: ({ mob }) => ({ mobs: [mob] }),
		text: ({ mob }) => `A ${pretty(mob)} shot you to death. When one is in view, act on it first: take cover out of its line of sight or close the distance and kill it, and heal before moving on.`,
	},
	'lava-while-moving': {
		death: (context) => context.cause.cause === 'lava' && recentlyRan(context, MOVE_ACTIONS) ? { dimension: context.dimension ?? 'overworld' } : null,
		trigger: ({ dimension }) => ({ dimension, lavaNear: true }),
		text: ({ dimension }) => `You died in lava while walking to a target in the ${pretty(dimension)}. Near lava, deal with hostiles before moving, keep a block between you and the lava, and avoid long routes along its edge.`,
	},
	'escaped-into-hazard': {
		death: (context) => ['lava', 'fall', 'drown', 'fire'].includes(context.cause.cause) && context.cause.escaping ? { hazard: context.cause.cause, mob: context.cause.escaping } : null,
		trigger: ({ mob }) => ({ mobs: [mob] }),
		text: ({ hazard, mob }) => `Escaping a ${pretty(mob)} killed you by ${hazard === 'fall' ? 'a fall' : hazard === 'drown' ? 'drowning' : hazard}. Before you run from one, look where the escape leads; fighting it on safe ground is often safer.`,
	},
	'died-without-food': {
		death: (context) => lastKnown(context, 'edible') === 0 && ['melee', 'shot', 'explosion', 'fireball'].includes(context.cause.kind) && (healthBefore(context, 10_000) ?? 20) <= 14 ? {} : null,
		// No food alone is most of the early game; it is a death risk together with low health.
		trigger: () => ({ noFood: true, lowHealth: true }),
		text: () => 'You died carrying no food while already hurt. Keep cooked food in the hotbar: get some before mining trips, long travel or a dimension change, and eat to heal before the next fight.',
	},
	'bailout-then-death': {
		death: (context) => context.cause.kind !== 'hazard' && resultWithin(context, FIGHTS, ['LOW_HEALTH_BAILOUT'], 30_000) ? { mob: context.cause.cause } : null,
		trigger: () => ({ recentResult: { types: [...FIGHTS], codes: ['LOW_HEALTH_BAILOUT'], withinMs: 30_000 } }),
		text: ({ mob }) => `Right after a fight stopped at low health, a ${pretty(mob)} finished you. Do not restart that fight or switch between moves: wall yourself in (a hole or pillar with a roof) and eat first.`,
	},
	'resumed-near-hostile': {
		death: (context) => context.cause.kind !== 'hazard' && context.cause.kind !== 'unknown' && resultWithin(context, TRIPS, ['HOSTILE_NEAR'], 60_000) ? { mob: context.cause.cause } : null,
		trigger: ({ mob }) => ({ mobs: [mob], recentResult: { types: [...TRIPS], codes: ['HOSTILE_NEAR'], withinMs: 60_000 } }),
		text: ({ mob }) => `A trip stopped because a ${pretty(mob)} was near, and going on with it still there got you killed. Kill it or wall it off before you resume.`,
	},
	'dig-into-water': {
		failure: (row, tally) => row.actionType === 'dig_to' && row.reasonCode === 'WATER_AHEAD' && repeated(row, tally, 'dig_to:WATER_AHEAD', 2, 300_000) ? {} : null,
		trigger: () => ({ recentResult: { types: ['dig_to'], codes: ['WATER_AHEAD'], withinMs: 60_000 } }),
		text: () => 'Digs kept stopping for water ahead. After the first stop, change heading or block the water off before digging on; retrying the same dig wastes minutes.',
	},
	'tool-worn-mid-task': {
		failure: (row, tally) => ['dig_to', 'travel_to'].includes(row.actionType) && row.reasonCode === 'TOOL_WORN' && repeated(row, tally, 'TOOL_WORN', 1, 600_000) ? {} : null,
		trigger: () => ({ recentResult: { types: ['dig_to', 'travel_to'], codes: ['TOOL_WORN'], withinMs: 120_000 } }),
		text: () => 'A worn pickaxe stopped a dig or trip partway. Craft a spare pickaxe before long digs and trips, so a worn one does not end the task.',
	},
	'hunt-without-target': {
		failure: (row, tally) => row.actionType === 'fight_until' && row.reasonCode === 'NO_TARGET_SEEN' && repeated(row, tally, 'fight_until:NO_TARGET_SEEN', 2, 600_000) ? {} : null,
		trigger: () => ({ recentResult: { types: ['fight_until'], codes: ['NO_TARGET_SEEN'], withinMs: 60_000 } }),
		text: () => 'Hunts for a mob that was not in view kept ending with nothing found. Hunt only mobs you can see, or go where they spawn first.',
	},
	'melee-at-low-health': {
		death: (context) => context.cause.kind === 'melee' && (healthBefore(context, 10_000) ?? 20) <= LOW_HEALTH ? { mob: context.cause.cause } : null,
		trigger: ({ mob }) => ({ mobs: [mob], lowHealth: true }),
		text: ({ mob }) => `A ${pretty(mob)} killed you after you stayed at low health. At low health, eat or retreat out of reach first; take the fight only after healing.`,
	},
});

/** Lessons a death supports, from the review context { cause, dimension, running, samples, results, at }. */
export function deathLessons(context) {
	const lessons = [];
	for (const [rule, spec] of Object.entries(LESSON_RULES)) {
		if (typeof spec.death !== 'function') continue;
		const slots = spec.death(context);
		if (slots) lessons.push({ id: lessonId(rule, slots), rule, slots });
	}
	return lessons;
}

/** Lessons a failed result supports, given this game's running failure tally (mutated). */
export function failureLessons(row, tally) {
	const lessons = [];
	for (const [rule, spec] of Object.entries(LESSON_RULES)) {
		if (typeof spec.failure !== 'function') continue;
		const slots = spec.failure(row, tally);
		if (slots) lessons.push({ id: lessonId(rule, slots), rule, slots });
	}
	return lessons;
}

export function lessonId(rule, slots) {
	return [rule, ...Object.keys(slots).sort().map((key) => `${key}=${slots[key]}`)].join(':');
}

/**
 * How well a lesson fits the current situation: 0 means do not show. A lesson recorded in the last few minutes is
 * shown on the next wakes (the respawn decision) even before its situation returns.
 */
export function situationScore(candidate, situation) {
	const spec = LESSON_RULES[candidate.rule];
	if (!spec) return 0;
	const trigger = spec.trigger(candidate.slots);
	const recent = situation.recentLessons?.includes(candidate.id) ? 3 : 0;
	let score = 0;
	if (trigger.dimension !== undefined) { if (situation.dimension !== trigger.dimension) return recent; score += 1; }
	if (trigger.mobs !== undefined) { if (!trigger.mobs.some((mob) => situation.hostiles?.[mob] !== undefined)) return recent; score += 2; }
	if (trigger.running !== undefined) { if (!situation.running?.some((type) => trigger.running.includes(type))) return recent; score += 1; }
	if (trigger.lowHealth) { if (!(Number.isFinite(situation.health) && situation.health <= LOW_HEALTH + 4)) return recent; score += 1; }
	if (trigger.noFood) { if (situation.edible !== 0) return recent; score += 1; }
	if (trigger.recentResult) {
		const { types, codes, withinMs } = trigger.recentResult;
		if (!situation.results?.some((result) => types.includes(result.actionType) && codes.includes(result.reasonCode) && situation.at - result.at <= withinMs)) return recent;
		score += 2;
	}
	if (trigger.lavaNear) { if (situation.lavaNear !== true) return recent; score += 2; }
	return score + recent;
}

/** The task memory lesson entry the model sees: the advice and its evidence, nothing else. */
export function lessonEntry(candidate) {
	const spec = LESSON_RULES[candidate.rule];
	const seen = [];
	if (candidate.games > 0) seen.push(`${candidate.count} time${candidate.count === 1 ? '' : 's'} in ${candidate.games} earlier game${candidate.games === 1 ? '' : 's'}`);
	if (candidate.thisGame > 0) seen.push(`${candidate.thisGame} this game`);
	return { kind: 'lesson', summary: spec.text(candidate.slots), src: `review: ${seen.join(', ')}` };
}
