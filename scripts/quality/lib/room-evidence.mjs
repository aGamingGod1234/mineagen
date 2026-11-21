// Evidence helpers for provider-free practice rooms, so a room's verdict agrees with a hand count of its own records.
// Fixtures on or off finishRun may import this file (it does not report a run).

/** A command the server refused before running it: its revision or model profile was stale. It is no call that ran. */
const REFUSED = new Set(['STALE_REVISION', 'STALE_PROVENANCE']);
export const refusedBeforeRunning = result => REFUSED.has(result?.reasonCode);

/**
 * A command the server turned away at admission (ServerActionExecutor, then MultiplexedServerBridge.sendRejectedAction):
 * its action runtime was quarantined or the body's action slot was busy. The receipt is FAILED with executionStarted and
 * physicalAttempted false. The code decides, not the flags alone: a hazard stop on the first tick (LAVA_AHEAD,
 * VOID_EDGE) also reports both false, and that stop is the safety behaviour a room is there to see. A receipt that
 * says the action did start is no rejection, whatever its code.
 */
const ADMISSION_REJECTED = new Set(['ACTION_RUNTIME_QUARANTINED', 'ACTION_ALREADY_ACTIVE']);
export const rejectedAtAdmission = result => ADMISSION_REJECTED.has(result?.reasonCode) && result?.executionStarted !== true && result?.physicalAttempted !== true;

/**
 * The lowest health over a room that also sees deaths: a death in the window makes it 0 whatever the samples say (a
 * body that died and respawned between two reads samples at full health). Unknown deaths or no samples give null, never
 * a healthy 20.
 */
export function healthFloor({ samples = [], deaths } = {}) {
	if (!Number.isSafeInteger(deaths) || deaths < 0) return null;
	if (deaths > 0) return 0;
	const read = samples.filter(Number.isFinite);
	return read.length ? Math.min(...read) : null;
}

/**
 * Samples health on its own clock (default every 250 ms) from the server, not from the body's observations, which a
 * fixture only pulls between calls (one call can span the whole room). readHealth returns a number (0 for a dead or
 * missing body) or null; readDeaths returns the vanilla death count or null. stop() ends the sampling and gives
 * { minHealth, samples, deaths, died } with minHealth from healthFloor.
 */
export function startHealthWatch({ readHealth, readDeaths, intervalMs = 250, wait = ms => new Promise(done => setTimeout(done, ms)) }) {
	const samples = [];
	let running = true, before = null;
	const started = (async () => { before = await readDeaths().catch(() => null); })();
	const loop = (async () => {
		await started;
		while (running) {
			const hp = await readHealth().catch(() => null);
			if (Number.isFinite(hp)) samples.push(hp);
			await wait(intervalMs);
		}
	})();
	return {
		samples,
		async stop() {
			running = false;
			await loop;
			const after = await readDeaths().catch(() => null);
			const valid = [before, after].every(n => Number.isSafeInteger(n) && n >= 0) && after >= before;
			const deaths = valid ? after - before : null;
			return { minHealth: healthFloor({ samples, deaths }), samples: samples.length, deaths, died: deaths === null ? null : deaths > 0 };
		},
	};
}

// Outcomes a real firing ends with (ReflexScheduler.Outcome); disabled, expired and removed rows are not firings.
const FIRING_ENDS = new Set(['done', 'timeout', 'failed', 'preempted', 'yielded']);

/**
 * Whether the reflex a room tests did its job, read from the body's own reflex record (an observation's reflexes:
 * { events: [{ seq, id, outcome, ms, detail }], firing }). A rule that never fired after sinceSeq leaves the room not
 * exercised (INVALID: the body survived for another reason). A firing that failed, or that yielded or was preempted
 * (to a model command, say) before holdMs, is a FAIL even when the body lived; holdMs defaults to Infinity, so any yield
 * fails unless the room says how long the rule had to hold. Otherwise PASS. roomVerdict (fixture-run.mjs) reads the result from
 * row.reflexHold, so a room marked pass that this contradicts reports FAIL.
 */
export function reflexHold(reflexes, { id, sinceSeq = 0, holdMs = Infinity } = {}) {
	if (!id) throw new Error('reflexHold needs the id of the rule under test');
	const rows = (reflexes?.events ?? []).filter(event => event.id === id && (event.seq ?? 0) > sinceSeq);
	const firings = rows.filter(event => FIRING_ENDS.has(event.outcome));
	const firingNow = reflexes?.firing?.id === id;
	const base = { id, firings: firings.length, firingNow, outcomes: firings.map(event => `${event.outcome}@${event.ms ?? '?'}ms`) };
	if (!firings.length && !firingNow) {
		return { ...base, verdict: 'INVALID', held: null, reason: `not exercised: ${id} never fired${rows.length ? ` (only ${[...new Set(rows.map(event => event.outcome))].join(', ')})` : ''}` };
	}
	const failed = firings.find(event => event.outcome === 'failed');
	if (failed) return { ...base, verdict: 'FAIL', held: false, reason: `${id} failed${failed.detail ? `: ${String(failed.detail).slice(0, 160)}` : ''}` };
	const early = firings.find(event => ['yielded', 'preempted'].includes(event.outcome) && !((event.ms ?? 0) >= holdMs));
	if (early) return { ...base, verdict: 'FAIL', held: false, reason: `${id} ${early.outcome} after ${((early.ms ?? 0) / 1000).toFixed(2)} s${Number.isFinite(holdMs) ? `, before the ${(holdMs / 1000).toFixed(2)} s it must hold` : ''}` };
	return { ...base, verdict: 'PASS', held: true, reason: `${id} fired ${firings.length}x${firingNow ? ' and is still firing' : ''}` };
}
