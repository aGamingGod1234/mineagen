// The climb back up to open sky from under cover. obtain (logs and animals live on the surface) and the surface step
// (surface-step.mjs, behind MINEAGEN_SURFACE_STEP=1) run the same climb: back the way the body came, then stairs up a
// leg at a time until the sky is open over the body. find keeps its own climb loop (retrace tries, detours, remembered
// water) and shares the stair leg itself. No imports: find-search.mjs imports this file.

// A stair leg climbs up to this many blocks; enough legs to reach the surface from y -58.
export const CLIMB_LEG = 24;
export const CLIMB_LEGS = 6;
const CLIMB_LEG_MS = 120_000;
// A leg shorter than this is not worth starting.
const MIN_LEG_MS = 5_000;

/** One stairs_up dig leg rise blocks above fromY. */
export function stairsUpArgs(fromY, rise, extra = {}) {
	return { pattern: 'stairs_up', y: Math.floor(fromY) + rise, maxBlocks: 80, throughCaves: 'small', ...extra };
}

export function bodyAt(o) {
	const p = o?.position ?? o?.player;
	return p && [p.x, p.y, p.z].every(Number.isFinite) ? { x: p.x, y: p.y, z: p.z } : null;
}

/**
 * Back the way the body came (retraceTo, when given), then stairs up until up(observation). o is the observation the
 * climb starts from. halted(result) ends the climb after any body call (interrupted, stopped, or danger). left() is the
 * time left in ms (Infinity: no deadline); each call gets at most that, and a stair leg needs MIN_LEG_MS. Returns how
 * it ended: stop null (up), 'halted', 'stalled' (a leg rose under 2 blocks), 'time' or 'legs' (all CLIMB_LEGS used),
 * with the last observation and body result.
 */
export async function climbToSky({ act, observe, up, halted, left = () => Infinity, retraceTo = null }, o) {
	const legMs = () => Math.min(CLIMB_LEG_MS, Math.floor(left()));
	let retraced = false;
	if (retraceTo && legMs() >= MIN_LEG_MS) {
		const back = await act('travel_to', { x: retraceTo.x, y: retraceTo.y, z: retraceTo.z, retrace: true, tolerance: 3, timeoutMs: legMs() });
		retraced = true;
		if (halted(back)) return { stop: 'halted', result: back, legs: 0, retraced };
		o = await observe();
		if (up(o)) return { stop: null, o, result: back, legs: 0, retraced };
	}
	for (let legs = 0; legs < CLIMB_LEGS; legs++) {
		if (legMs() < MIN_LEG_MS) return { stop: 'time', o, legs, retraced };
		const from = bodyAt(o);
		const climbed = await act('dig_to', stairsUpArgs(from.y, CLIMB_LEG, { timeoutMs: legMs() }));
		if (halted(climbed)) return { stop: 'halted', result: climbed, from, legs: legs + 1, retraced };
		o = await observe();
		if (up(o)) return { stop: null, o, result: climbed, legs: legs + 1, retraced };
		const at = bodyAt(o);
		if (at === null || at.y < from.y + 2) return { stop: 'stalled', o, at, from, result: climbed, legs: legs + 1, retraced };
	}
	return { stop: 'legs', o, legs: CLIMB_LEGS, retraced };
}
