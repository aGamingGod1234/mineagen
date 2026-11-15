/**
 * Whether an armed reflex did its job at a recorded fail spot (scripts/quality/test-reflex-failspots-live.mjs).
 * Every spot needs the body alive. Cloud and cover spots pass with no failed reflex event; a control spot that replays
 * the game's empty inventory (`namedFailureOk`) may fail, as long as each failure names its reason (take_cover names the
 * missing blocks, sprint_away each direction's barrier). The tunnel passes when the body escaped the way it came; a clutch
 * when it placed its water.
 */
export function spotPassed(spot, r) {
	if (r.died !== false) return false;
	const failures = (r.events ?? []).filter(event => event.outcome === 'failed');
	const failedOk = spot.namedFailureOk ? failures.every(event => String(event.detail ?? '').trim().length > 0) : !failures.length;
	if (spot.kind === 'cloud' || spot.kind === 'cover') return failedOk;
	if (spot.kind === 'tunnel') return r.escaped === true;
	return r.waterPlaced === true;
}
