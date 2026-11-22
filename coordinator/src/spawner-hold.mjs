/**
 * Wall breaker rods (c): a running blaze fight_until in the Nether is the body's spawner hold (the mod builds a roofed cell
 * by the spawner and fights from it until the rod count). The model cancelled 26 of 65 staged blaze fights itself; its
 * first cancel or replace of a hold is refused with what the hold is doing and when it stops by itself, and the same call
 * repeated within CONFIRM_MS goes through, so a stop is a decision the model makes twice, not a reflex. (A reason field
 * would cost tool-schema bytes the pinned budget does not have.) Only the model's own cancelAction and replaceAction are
 * gated: the coordinator's internal cancels (danger, leg chains, programs) never are.
 */
export const CONFIRM_MS = 60_000;

/**
 * True for a blaze fight_until the mod may run as a spawner hold (roof:false keeps the open fight). pursue:false,
 * sneak:true and an explicit spot (x, y, z) keep the ordinary fight in the mod too (ServerActionExecutor.fightUntil), so
 * replacing those is never delayed.
 */
export function blazeHold(active) {
	const args = active?.arguments ?? {};
	return active?.actionType === 'fight_until' && args.mob === 'minecraft:blaze'
		&& args.roof !== false && args.pursue !== false && args.sneak !== true && args.x === undefined && args.y === undefined && args.z === undefined && (active.dimension === undefined || active.dimension === null || active.dimension === 'minecraft:the_nether');
}

/**
 * Null when the model may cancel or replace the running action, else the refusal { code, message }. `refused` is the
 * earlier refusal for this agent ({ actionId, at }) or null; `now` is the wall clock in ms.
 */
export function holdCancelRefusal(active, tool, refused, now) {
	if (!blazeHold(active)) return null;
	// Running from danger is never delayed: the gate also matches open-ground blaze fights the mod did not hold.
	if (tool?.kind === 'replace_action' && tool.actionType === 'flee_from') return null;
	if (refused?.actionId === active.actionId && now - refused.at <= CONFIRM_MS) return null;
	const verb = tool?.kind === 'replace_action' ? 'replaceAction' : 'cancelAction';
	return { code: 'CANCEL_CONFIRM_REQUIRED', message: `${active.actionId} is the blaze spawner hold: it fights from a roofed cell by the spawner and stops by itself at the rod count, a health or food floor, the time cap, or a gone or quiet spawner. Send the same ${verb} again within ${CONFIRM_MS / 1000} s to stop it anyway.` };
}
