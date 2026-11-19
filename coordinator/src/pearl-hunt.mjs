// Enderman pearl hunts as the body runs them (wall breaker "pearls"): a count fight on endermen bails out at the stance's
// retreat line, not above it, and runs for a hunt-length time when the model gave none. Measured before: fleeAtHealth
// was 14 on every one of 22 fresh-game hunts, so one or two enderman hits (7 each, about 4.5 through iron) ended the
// call; and fight_until's own default (180 s) handed a hunt back after three minutes. Nothing starts from this; it only
// adjusts fields of a call the model made, and says so in the result.
import { STANCE_SETTINGS, resolveAutoStance } from './reflexes.mjs';

/** A hunt with no timeoutMs of the model's runs this long: find's default, under the 600 s a provider holds a call. */
export const PEARL_HUNT_TIMEOUT_MS = 540_000;
const ENDERMAN = 'minecraft:enderman';
const PEARL = 'minecraft:ender_pearl';

/** The retreat line a stance bails out at (reflexes.mjs default-retreat); stance null resolves as the auto stance would. */
export function huntFleeLine(stance, observation = null) {
	const settings = STANCE_SETTINGS['default-retreat'];
	const resolved = Object.hasOwn(settings, stance ?? '') && stance !== 'condition' ? stance : resolveAutoStance(observation);
	return { stance: resolved, line: settings[resolved] };
}

/** Whether a native action is an enderman pearl count fight: fight_until on endermen, or a count fight_target on one. */
export function isPearlHunt(tool, entities = []) {
	const args = tool?.arguments;
	if (args === null || typeof args !== 'object') return false;
	if (tool.actionType === 'fight_until') return args.mob === ENDERMAN;
	if (tool.actionType !== 'fight_target' || args.untilItem !== PEARL) return false;
	const target = (Array.isArray(entities) ? entities : []).find((entry) => entry && (entry.uuid ?? entry.stableId) === args.targetId);
	return target?.type === ENDERMAN;
}

/**
 * tool: { actionType, arguments }. Returns { tool, note } when an enderman pearl hunt was adjusted (fleeAtHealth above
 * the stance's retreat line lowered to it; a missing timeoutMs set to PEARL_HUNT_TIMEOUT_MS), else { tool }.
 */
export function pearlHuntDefaults(tool, { stance = null, observation = null } = {}) {
	if (!isPearlHunt(tool, observation?.entities)) return { tool };
	const args = { ...tool.arguments };
	const notes = [];
	const { stance: resolved, line } = huntFleeLine(stance, observation);
	if (Number.isFinite(args.fleeAtHealth) && args.fleeAtHealth > line) {
		notes.push(`fleeAtHealth ${args.fleeAtHealth} lowered to ${line} (${resolved} stance retreat line; an enderman hits ~7, ~4.5 through iron)`);
		args.fleeAtHealth = line;
	}
	if (args.timeoutMs === undefined) {
		args.timeoutMs = PEARL_HUNT_TIMEOUT_MS;
		notes.push(`timeoutMs ${PEARL_HUNT_TIMEOUT_MS / 1000} s (a hunt keeps going; in a warped forest it walks on when quiet)`);
	}
	if (notes.length === 0) return { tool };
	return { tool: { ...tool, arguments: args }, note: `Pearl hunt: ${notes.join('; ')}.` };
}
