// The verdict and repeat rule of scripts/quality/test-find-live.mjs, kept here so they can be tested without a live slot.
// A spot's calls may be any tools, not only find: a lava-safety room acts and never searches.
import { refusedBeforeRunning, rejectedAtAdmission } from './room-evidence.mjs';

export const isFindCall = call => call?.name === 'do_step' && call?.arguments?.verb === 'find';
// A recorded call was a search however it was sent: its verb, a find payload or a FIND_* code.
const searchedEntry = entry => entry?.verb === 'find' || (entry?.find !== undefined && entry?.find !== null) || /^FIND_/.test(String(entry?.reasonCode ?? ''));
// A call that never reached the body: the harness threw (ERROR) or the server refused it before running it.
const neverRan = entry => entry?.state === 'ERROR' || refusedBeforeRunning(entry);
// For the verdict, a call the server turned away at admission never reached the body either. The repeat rule keeps
// neverRan: a busy slot right after the stand-in's cancel clears, so re-asking that find is still right.
const unexercised = entry => neverRan(entry) || rejectedAtAdmission(entry);

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
	if (!spot.repeat || callReached(call, result, spot) || budgetLeftMs < 10_000 || neverRan(result)) return false;
	if (isFindCall(call)) return result?.reasonCode !== 'FIND_BLOCKED';
	return Array.isArray(spot.repeatOn) && spot.repeatOn.includes(result?.reasonCode);
}

/**
 * One spot's verdict with its reason. found is null when the spot made no find call (it is no search, so "not found" is
 * no failure). The expectation is the spot's expectCode on its last call, else the last find's sighting when it
 * searched, else, for a room that only acts (a lava-safety room whose wanted stop is a FAILED LAVA_AHEAD), no damage:
 * its call outcomes are reported, not judged. Every spot also needs no death. Deaths and damage are the vanilla
 * counters; unknown damage is missing evidence, which finishRun reports as invalid, and unknown deaths fail. A spot
 * that measured nothing also gets notExercised (notPlayed below), which finishRun reports as invalid.
 */
export function findSpotVerdict(spot = {}, row = {}) {
	const calls = row.calls ?? [];
	const searched = (spot.calls ?? []).some(isFindCall) || calls.some(searchedEntry);
	const lastFind = searched ? [...calls].reverse().find(searchedEntry) ?? calls.at(-1) : null;
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
		if (Number.isFinite(row.damageTaken) && row.damageTaken > 0) misses.push(`took ${row.damageTaken} HP damage`);
	}
	if (row.deaths !== 0) misses.push(Number.isFinite(row.deaths) ? `${row.deaths} deaths` : 'deaths unknown');
	const pass = misses.length === 0;
	const stood = notPlayed({ searched, found, lastFind, pass, calls, spot, row });
	// When the target was seen: the end of the find that saw it, not of whatever call came after it.
	const foundAtS = found && Number.isFinite(lastFind.atS) && Number.isFinite(lastFind.seconds) ? lastFind.atS + lastFind.seconds : null;
	return { found, foundAtS, pass, expectation, ...(stood ? { notExercised: stood } : {}), ...(pass ? { passReason: expectation } : { failReason: misses.join('; ') }) };
}

/**
 * Why a spot measured nothing, else null. A search whose last find never reached the body (the harness threw, or the
 * server refused it) is no "not found". A safety-only room cannot pass on standing still: no call ran, one never reached
 * the body, every body receipt in row.actions was turned away at admission, or the spot ended on lost observations. A
 * miss it did measure (damage, a death) stays a FAIL.
 */
function notPlayed({ searched, found, lastFind, pass, calls, spot, row }) {
	if (searched) return !found && row.deaths === 0 && (!lastFind || unexercised(lastFind)) ? `find ${lastFind?.reasonCode ?? lastFind?.state ?? 'call'} never reached the body` : null;
	if (spot.expectCode || !pass) return null;
	if (!calls.length) return 'no call ran';
	const lost = calls.filter(unexercised);
	if (lost.length) return `${lost.map(entry => `${entry.call} ${entry.reasonCode ?? entry.state}`).join(', ')} never reached the body`;
	// A background step returns RUNNING; its body receipts are row.actions (find-live's action_result tap). A room whose
	// every receipt was turned away at admission played nothing, however its calls read.
	const actions = row.actions ?? [];
	if (actions.length && actions.every(rejectedAtAdmission)) return `${actions.map(action => `${action.type} ${action.reasonCode}`).join(', ')} never reached the body`;
	return row.ended ? `spot ended early: ${row.ended}` : null;
}

/** The spot's console line: FOUND or NOT FOUND only for a search; a room that only acts reports its verdict. */
export function findSpotLabel(row) {
	if (row.found === true) return 'FOUND';
	if (row.found === false) return 'NOT FOUND';
	return row.pass ? 'PASS' : `FAIL (${row.failReason ?? 'no reason'})`;
}

/**
 * One recorded call of a spot, as find-live saves it in row.calls. It keeps the body's execution evidence
 * (executionStarted, physicalAttempted) when the result reports it, so a reader can tell a call that ran from one the
 * server turned away; it never invents the flags.
 */
export function callEntry(call, result, { attempt, atS, seconds }) {
	return { call: call.name, ...(call.arguments?.verb ? { verb: call.arguments.verb } : {}), attempt, atS, seconds, state: result?.state, reasonCode: result?.reasonCode,
		...(typeof result?.executionStarted === 'boolean' ? { executionStarted: result.executionStarted } : {}),
		...(typeof result?.physicalAttempted === 'boolean' ? { physicalAttempted: result.physicalAttempted } : {}),
		message: String(result?.message ?? '').slice(0, 900), find: result?.find };
}
