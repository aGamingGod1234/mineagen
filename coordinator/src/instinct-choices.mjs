// Choices System 1 owns. The model (System 2) may still go against one, but only on purpose: a do_step that sets an
// owned field against the instinct runs with the instinct's value unless it carries overrule:"<the fact it saw>". The
// result says what was kept and how to overrule, so the call is never wasted, and every keep and overrule is traced so
// rounds can count how often System 2 accepts System 1.
//
// CP2r (16 games): the model set throughCaves:false on 593 of 724 dig and travel calls that named it, 13 of 16 games
// from their first minutes and before any cave result, citing our own guide's "supported staircase" and "dry" words.

/** The most characters an overrule may hold: one fact, not a plan. */
export const OVERRULE_CHARS = 160;
/** Health a cave drop must keep (the body's own floor for drops); below it the model's choice stands. */
export const CAVE_MIN_HEALTH = 14;
/**
 * A food bar that stands in for carried food. The voice round (16 games) found the bar at 6 or lower in under 1.1% of
 * samples, yet 204 of 348 asks to avoid caves came with no food carried, so a carried-food check alone rarely held.
 */
export const CAVE_MIN_FOOD = 14;

const FOOD = /^minecraft:(cooked_\w+|bread|baked_potato|golden_carrot|golden_apple|pumpkin_pie|\w+_stew|beetroot_soup|beef|porkchop|mutton|chicken|rabbit|cod|salmon|apple|carrot|potato|sweet_berries|melon_slice|cookie|dried_kelp)$/;

/**
 * Each owned choice: the body verbs and field it covers, the instinct's value, the values it replaces, when it holds
 * (from the latest observation), and the book rule it comes from.
 */
export const INSTINCT_CHOICES = Object.freeze([
	Object.freeze({
		id: 'caves', rule: 'ore-cave-first', actionTypes: Object.freeze(['dig_to', 'travel_to']), field: 'throughCaves', value: 'small', replaces: Object.freeze([false]),
		says: 'a player digs on into a cave it meets: cave walls show far more ore than a tunnel, and a drop is at most 4 blocks with health kept at 14+',
		holds: (observation) => {
			const health = Number(observation?.player?.health);
			const foodLevel = observation?.player?.foodLevel;
			const items = Array.isArray(observation?.inventory?.items) ? observation.inventory.items : [];
			return (observation?.world?.dimension ?? observation?.dimension) === 'minecraft:overworld' && Number.isFinite(health) && health >= CAVE_MIN_HEALTH
				&& ((Number.isFinite(foodLevel) && foodLevel >= CAVE_MIN_FOOD) || items.some(item => FOOD.test(item?.itemId ?? '')));
		},
	}),
]);

/** MINEAGEN_INSTINCT_CHOICES=off lets the model's values stand (an A/B round's off arm); on otherwise. */
export function instinctChoicesEnabled(environment = {}) {
	return String(environment?.MINEAGEN_INSTINCT_CHOICES ?? '').trim().toLowerCase() !== 'off';
}

/**
 * Applies the owned choices to one body action. Returns { arguments, kept, overruled }: kept lists choices the
 * instinct held (the model's value replaced), overruled those the model went against with a reason.
 */
export function applyInstinctChoices(actionType, args, observation, { overrule = null, choices = INSTINCT_CHOICES } = {}) {
	const kept = [], overruled = [];
	if (args === null || typeof args !== 'object') return { arguments: args, kept, overruled };
	let next = args;
	for (const choice of choices) {
		if (!choice.actionTypes.includes(actionType) || !Object.hasOwn(args, choice.field) || !choice.replaces.includes(args[choice.field])) continue;
		if (!choice.holds(observation)) continue;
		const row = { id: choice.id, rule: choice.rule, field: choice.field, asked: args[choice.field], instinct: choice.value };
		if (overrule !== null) { overruled.push({ ...row, because: overrule }); continue; }
		next = { ...next, [choice.field]: choice.value };
		kept.push(row);
	}
	return { arguments: next, kept, overruled };
}

/** The result line for kept choices: what ran instead, why, and how to go against it. */
export function keptNote(kept) {
	if (kept.length === 0) return null;
	return kept.map(row => {
		const choice = INSTINCT_CHOICES.find(c => c.id === row.id);
		return `instinct kept ${row.field}:${JSON.stringify(row.instinct)} (you asked ${JSON.stringify(row.asked)}; ${choice?.says ?? row.rule}). To go against it, repeat with overrule:"<the fact you see that it does not>".`;
	}).join(' ');
}
