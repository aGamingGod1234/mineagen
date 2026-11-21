// The verdict and repeat rule of scripts/quality/test-find-live.mjs, kept here so they can be tested without a live slot.
// A spot's calls may be any tools, not only find: a lava-safety room acts and never searches.

export const isFindCall = call => call?.name === 'do_step' && call?.arguments?.verb === 'find';

/** A call reached its target: it ended with the spot's expectCode, or a find saw its target, or another call succeeded. */
export function callReached(call, result, spot = {}) {
	if (spot.expectCode && result?.reasonCode === spot.expectCode) return true;
	if (isFindCall(call)) return result?.state === 'SUCCEEDED' && result?.reasonCode === 'FIND_SEEN';
	return result?.state === 'SUCCEEDED';
}

/**
 * Whether the provider-free stand-in asks the same call again, as a model that only re-asks would: only for a spot with
 * repeat, while the call has not reached its target, budget is left, and the reason is one a re-ask can change. A find
 * re-asks after a budget or danger handback (not FIND_BLOCKED); another tool re-asks only on a result its spot names in
 * repeatOn, so a stop such as OPEN_SKY never spins until the budget runs out.
 */
export function shouldRepeat(call, result, spot = {}, { budgetLeftMs = Infinity } = {}) {
	if (!spot.repeat || callReached(call, result, spot) || budgetLeftMs < 10_000) return false;
	if (isFindCall(call)) return result?.reasonCode !== 'FIND_BLOCKED';
	return Array.isArray(spot.repeatOn) && spot.repeatOn.includes(result?.reasonCode);
}

/**
 * One spot's verdict with its reason. found is null when the spot made no find call (it is no search, so "not found" is
 * no failure). The expectation is the spot's expectCode on its last call, else the last find's sighting when it
 * searched, else, for a room that only acts (a lava-safety room whose wanted stop is a FAILED LAVA_AHEAD), no damage:
 * its call outcomes are reported, not judged. Every spot also needs no death. Deaths and damage are the vanilla
 * counters; unknown damage is missing evidence, which finishRun reports as invalid, and unknown deaths fail.
 */
export function findSpotVerdict(spot = {}, row = {}) {
	const calls = row.calls ?? [];
	const searched = (spot.calls ?? []).some(isFindCall);
	const lastFind = searched ? [...calls].reverse().find(entry => entry.verb === 'find') ?? calls.at(-1) : null;
	const found = searched ? lastFind?.state === 'SUCCEEDED' && lastFind?.reasonCode === 'FIND_SEEN' : null;
	const last = calls.at(-1);
	const misses = [];
	let expectation;
	if (spot.expectCode) {
		expectation = `last call ${spot.expectCode}`;
		if (last?.reasonCode !== spot.expectCode) misses.push(`last call ended ${last?.reasonCode ?? last?.state ?? 'never'}, expected ${spot.expectCode}`);
	} else if (searched) {
		expectation = 'find saw its target';
		if (!found) misses.push(`find ended ${lastFind?.reasonCode ?? lastFind?.state ?? 'never'}`);
	} else {
		expectation = 'no find call: no death and no damage';
		if (!calls.length) misses.push('no call ran');
		if (Number.isFinite(row.damageTaken) && row.damageTaken > 0) misses.push(`took ${row.damageTaken} HP damage`);
	}
	if (row.deaths !== 0) misses.push(Number.isFinite(row.deaths) ? `${row.deaths} deaths` : 'deaths unknown');
	const pass = misses.length === 0;
	return { found, pass, expectation, ...(pass ? { passReason: expectation } : { failReason: misses.join('; ') }) };
}

/** The spot's console line: FOUND or NOT FOUND only for a search; a room that only acts reports its verdict. */
export function findSpotLabel(row) {
	if (row.found === true) return 'FOUND';
	if (row.found === false) return 'NOT FOUND';
	return row.pass ? 'PASS' : `FAIL (${row.failReason ?? 'no reason'})`;
}
