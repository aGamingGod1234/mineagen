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

function pretty(id) { return String(id).replace(/_/g, ' '); }
function recentlyRan(context, types, withinMs = 15_000) {
	return context.running.some((type) => types.has(type))
		|| context.results.some((result) => types.has(result.actionType) && context.at - result.at <= withinMs);
}
function healthBefore(context, ms) {
	const sample = [...context.samples].reverse().find((entry) => context.at - entry.at >= ms && Number.isFinite(entry.health));
	return sample?.health ?? null;
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
		text: ({ mob }) => `Running from a ${pretty(mob)} across open ground kept you in its range until you died. Break its line of sight behind a solid block or wall, or close in and kill it; do not just flee in the open.`,
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
		trigger: () => ({ noFood: true, hurtOrThreatened: true }),
		text: () => 'You died carrying no food while already hurt. Keep cooked food in the hotbar: get some before mining trips, long travel or a dimension change, and eat to heal before the next fight.',
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
	if (trigger.lavaNear) { if (situation.lavaNear !== true) return recent; score += 2; }
	if (trigger.hurtOrThreatened) { if (!(Number.isFinite(situation.health) && situation.health <= 14 || Object.keys(situation.hostiles ?? {}).length > 0)) return recent; score += 1; }
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
