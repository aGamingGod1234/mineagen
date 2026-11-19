/**
 * Wall breaker rods (c): a running blaze fight_until in the Nether is the body's spawner hold (the mod builds a roofed cell
 * by the spawner and fights from it until the rod count). The model cancelled 26 of 65 staged blaze fights itself; a
 * cancel or replace of one now carries a short reason, so a stop is a decision the model states, not a reflex. Only the
 * model's own cancelAction and replaceAction are gated: the coordinator's internal cancels (danger, leg chains, programs)
 * never are. A refused call changes nothing and the same call with a reason always passes.
 */
export const CANCEL_REASON_MAX = 200;

/** True for a blaze fight_until the mod may run as a spawner hold (roof:false keeps the open fight). */
export function blazeHold(active) {
	return active?.actionType === 'fight_until' && active.arguments?.mob === 'minecraft:blaze'
		&& active.arguments?.roof !== false && (active.dimension === undefined || active.dimension === null || active.dimension === 'minecraft:the_nether');
}

/** Null when the model may cancel or replace the running action, else the refusal { code, message }. */
export function holdCancelRefusal(active, tool) {
	if (!blazeHold(active)) return null;
	if (typeof tool?.reason === 'string' && tool.reason.trim().length > 0) return null;
	const verb = tool?.kind === 'replace_action' ? 'replaceAction' : 'cancelAction';
	return { code: 'CANCEL_REASON_REQUIRED', message: `${active.actionId} is the blaze spawner hold; it keeps fighting from its cell until the rod count, a health or food floor, the time cap or the spawner is gone. To stop it anyway, send ${verb} again with reason (why, up to ${CANCEL_REASON_MAX} characters).` };
}
