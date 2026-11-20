// The surface step: do_step dig_to until "open_sky", behind MINEAGEN_SURFACE_STEP=1 (off by default). One call takes
// the body from under cover back up to open sky with obtain's climb (surface-climb.mjs) and says how it ended.
import { DAMAGE_STOPS, DEFAULT_FIND_TIMEOUT_MS, LIFE_SAFETY_STOPS } from './find-search.mjs';
import { CLIMB_LEG, CLIMB_LEGS, bodyAt, climbToSky } from './surface-climb.mjs';

// The provider holds a tool call at most 600 s: the step, like find, ends in time to report.
export const SURFACE_STEP_DEFAULT_TIMEOUT_MS = DEFAULT_FIND_TIMEOUT_MS;
const NETHER = 'minecraft:the_nether';
const DANGER = new Set(['HOSTILE_NEAR', 'LOW_FOOD', ...DAMAGE_STOPS, ...LIFE_SAFETY_STOPS]);

/** Whether MINEAGEN_SURFACE_STEP turns the surface step on (off by default). */
export function surfaceStepEnabled(environment = process.env) {
	return environment.MINEAGEN_SURFACE_STEP === '1';
}

/** A body result's code and message, short. */
export function resultWhy(result) {
	return `${result?.reasonCode ?? result?.state ?? 'no move'}${result?.message ? `: ${String(result.message).slice(0, 120)}` : ''}`;
}

/**
 * The surface step: from under cover, back up the way the body came (the last open-sky spot it stood on, when that is
 * higher) and stairs up until the sky is open over it. body: observe(), act(type, args) (a result with interruptedBy
 * when danger interrupted it), openSky() and now(). Ends SUCCEEDED OPEN_SKY with the height, or says why it stopped:
 * SURFACE_DANGER (an interrupt or a danger stop; the model decides), SURFACE_BLOCKED (a leg could not rise),
 * SURFACE_OUT_OF_LEGS, SURFACE_TIMED_OUT, or SURFACE_NO_SKY (the Nether).
 */
export async function runSurfaceStep(body, { timeoutMs = SURFACE_STEP_DEFAULT_TIMEOUT_MS } = {}) {
	const startedAt = body.now();
	let o = await body.observe();
	const start = bodyAt(o);
	const report = (state, reasonCode, message, end = o, extra = {}) => {
		const at = bodyAt(end) ?? start;
		return { state, reasonCode, message, ...extra,
			surface: { y: at === null ? null : Math.floor(at.y), startY: start === null ? null : Math.floor(start.y), skyOpen: end?.player?.skyOpen ?? null } };
	};
	if (start === null) return report('FAILED', 'SURFACE_UNKNOWN', 'No body position in the observation: nothing to climb from');
	if (o.world?.dimension === NETHER) return report('FAILED', 'SURFACE_NO_SKY', 'The Nether has no sky to climb to; use a portal');
	// Out only when the body reports open sky; unknown is not outside.
	const up = (sample) => bodyAt(sample) !== null && sample?.player?.skyOpen === true;
	if (up(o)) return report('SUCCEEDED', 'OPEN_SKY', `Already under open sky at y ${Math.floor(start.y)}`);
	const sky = body.openSky?.() ?? null;
	const retraceTo = sky !== null && [sky.x, sky.y, sky.z].every(Number.isFinite) && sky.y > start.y + 1 ? sky : null;
	const climb = await climbToSky({ act: (type, args) => body.act(type, args), observe: () => body.observe(), up,
		halted: (result) => result?.interruptedBy !== undefined || DANGER.has(result?.reasonCode),
		left: () => timeoutMs - (body.now() - startedAt), retraceTo }, o);
	const legs = `${climb.legs} stair leg(s)${climb.retraced ? ' after the way back' : ''}`;
	if (climb.stop === null) {
		const at = bodyAt(climb.o);
		return report('SUCCEEDED', 'OPEN_SKY', `Under open sky at y ${Math.floor(at.y)} (from y ${Math.floor(start.y)}) after ${legs}`, climb.o, { legs: climb.legs });
	}
	if (climb.stop === 'halted') {
		const result = climb.result;
		let end = o;
		try { end = await body.observe(); } catch { /* the last sample stands */ }
		if (result?.interruptedBy !== undefined) {
			return { ...result, ...report(result.state, 'SURFACE_DANGER', `Danger stopped the climb at y ${Math.floor((bodyAt(end) ?? start).y)}; the leg still runs (${result.actionId}): deal with it, then climb again`, end), legs: climb.legs };
		}
		return report('FAILED', 'SURFACE_DANGER', `Stopped for danger at y ${Math.floor((bodyAt(end) ?? start).y)} under cover (${resultWhy(result)})`, end, { legs: climb.legs });
	}
	const at = bodyAt(climb.o) ?? start;
	if (climb.stop === 'stalled') return report('FAILED', 'SURFACE_BLOCKED', `The climb stopped at y ${Math.floor(at.y)} under cover after ${legs} (${resultWhy(climb.result)})`, climb.o, { legs: climb.legs });
	if (climb.stop === 'time') return report('TIMED_OUT', 'SURFACE_TIMED_OUT', `Still under cover at y ${Math.floor(at.y)} when the step's ${Math.round(timeoutMs / 1000)} s ran out, after ${legs}`, climb.o, { legs: climb.legs });
	return report('FAILED', 'SURFACE_OUT_OF_LEGS', `Still under cover at y ${Math.floor(at.y)} after ${legs} (up to ${CLIMB_LEGS * CLIMB_LEG} blocks)`, climb.o, { legs: climb.legs });
}
