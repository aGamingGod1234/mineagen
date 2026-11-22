import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import { attachHits } from './danger-rows.mjs';
import { refusedBeforeRunning } from './room-evidence.mjs';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/**
 * Count receipts, never copies of lastResult carried by observations. A command the server refused before running it
 * (STALE_REVISION) is counted as refused, not as a call that ran.
 */
export function terminalCounter() {
	const seen = new Map(), byReason = {};
	let duplicates = 0, missingActionIds = 0, conflicts = 0, refused = 0;
	return {
		accept(row) {
			const event = row.envelope ?? row, result = event.payload ?? {};
			if (event.type !== 'action_result' || !TERMINAL.has(result.state)) return;
			if (!result.actionId) { missingActionIds++; return; }
			const key = JSON.stringify([event.agentId, result.goalRevision, result.actionId]);
			const signature = JSON.stringify([result.state, result.reasonCode]);
			// Identity first, so a repeated refusal is one refusal and a different receipt for it is a conflict.
			if (seen.has(key)) { duplicates++; if (seen.get(key) !== signature) conflicts++; return; }
			seen.set(key, signature);
			if (refusedBeforeRunning(result)) { refused++; return; }
			const code = result.reasonCode ?? result.state;
			byReason[code] = (byReason[code] ?? 0) + 1;
		},
		snapshot: () => ({ terminalResults: seen.size - refused, byReason: { ...byReason }, duplicates, missingActionIds, conflicts, refused }),
	};
}

const firstLine = text => String(text).split('\n')[0].slice(0, 300);
const roomName = (row, index) => {
	const repeat = row.repeat ?? row.run;
	return String(row.name ?? row.case ?? row.room ?? row.spot ?? `row-${index}`) + (repeat === undefined || repeat === null ? '' : `#${repeat}`);
};

/**
 * One room's verdict and why, so a reader never has to recount result.json by hand. Exactly one of PASS, FAIL,
 * INVALID (or SKIPPED). INVALID means the room measured nothing it could be judged on: an error, missing evidence
 * (integrity), a room that was never exercised (notExercised, or a reflexHold that never fired) or no verdict at all.
 * FAIL is a measured miss: pass false, bar false, or a pass that the room's own reflex evidence contradicts (the rule
 * under test yielded or was preempted before it held; see reflexHold in room-evidence.mjs). Fixtures may give the reason
 * themselves (failReason, passReason).
 */
export function roomVerdict(row) {
	if (row.skipped) return { verdict: 'SKIPPED', reason: row.skipped === true ? 'skipped' : firstLine(row.skipped) };
	if (row.cancelledBeforeStart === true) return { verdict: 'INVALID', reason: 'cancelled before it started' };
	if (row.error) return { verdict: 'INVALID', reason: `error: ${firstLine(row.error)}` };
	const integrity = [...(row.integrity ?? []), ...(row.tick?.integrity ?? []), ...(row.play?.integrity ?? [])];
	if (integrity.length) return { verdict: 'INVALID', reason: `missing evidence: ${integrity.map(item => [item.file, item.error].filter(Boolean).join(' ')).join('; ')}` };
	if (row.measurementStatus === 'INVALID') return { verdict: 'INVALID', reason: firstLine(row.measurementReason ?? 'measurement status INVALID') };
	if (row.notExercised) return { verdict: 'INVALID', reason: `not exercised: ${firstLine(row.notExercised)}` };
	if (row.reflexHold?.verdict === 'INVALID') return { verdict: 'INVALID', reason: row.reflexHold.reason };
	if (row.pass === undefined || row.pass === null) return { verdict: 'INVALID', reason: 'no verdict recorded (pass unset)' };
	if (row.pass === false) return { verdict: 'FAIL', reason: firstLine(row.failReason ?? 'pass false') };
	if (row.bar === false) return { verdict: 'FAIL', reason: firstLine(row.barReason ?? 'bar missed') };
	if (row.reflexHold?.verdict === 'FAIL') return { verdict: 'FAIL', reason: row.reflexHold.reason };
	return { verdict: 'PASS', reason: firstLine(row.passReason ?? 'pass') };
}

/**
 * Counts per verdict and each room's verdict with its reason. status decides the exit code: FAIL when any room failed
 * (a measured miss stands whatever else happened), else INVALID when any room or planned room has no valid evidence,
 * else PASS. armVerdict judges only the valid rooms, so one invalid room cannot hide 13 passing ones: read it with
 * the counts, and rerun the invalid rooms.
 */
export function fixtureSummary(rows, { planned = rows.length } = {}) {
	const rooms = rows.map((row, index) => ({ name: roomName(row, index), ...roomVerdict(row) }));
	const count = verdict => rooms.filter(room => room.verdict === verdict).length;
	const passed = count('PASS'), failed = count('FAIL'), invalid = count('INVALID'), skipped = count('SKIPPED');
	const started = rows.filter(row => Number.isFinite(row.startedAt)).length;
	const notStarted = Math.max(0, planned - rows.filter(row => Number.isFinite(row.startedAt) || row.cancelledBeforeStart === true).length);
	const missing = Math.max(0, planned - rows.length);
	const armVerdict = failed ? 'FAIL' : passed ? 'PASS' : 'NONE';
	const status = failed ? 'FAIL' : invalid || missing || planned === 0 || !passed ? 'INVALID' : 'PASS';
	const why = rooms.filter(room => room.verdict !== 'PASS' && room.verdict !== 'SKIPPED').slice(0, 6).map(room => `${room.name} ${room.verdict}: ${room.reason}`);
	return {
		planned, started,
		completed: rows.filter(row => !row.skipped && Number.isFinite(row.finishedAt) && !row.error).length,
		cancelledBeforeStart: rows.filter(row => row.cancelledBeforeStart === true).length,
		notStarted, skipped, passed, failed, invalid, missing, armVerdict, status,
		line: `${passed} pass, ${failed} fail, ${invalid} invalid${skipped ? `, ${skipped} skipped` : ''}${missing ? `, ${missing} never ran` : ''} of ${planned} planned; valid rooms ${armVerdict}; status ${status}${why.length ? ` | ${why.join(' | ')}` : ''}`,
		rooms,
	};
}

/**
 * Reports survive failed rows; strict callers distinguish failed acceptance from invalid evidence. With a file, each row
 * that ran in a known window gets row.hits, what hit the bot by attacker, from the Watcher's danger rows under the
 * file's folder (lib/danger-rows.mjs; a server booted by watch-replay.mjs boot() writes them).
 */
export async function finishRun(rows, { file, planned = rows.length, strict = true, setExitCode = true, hits = true } = {}) {
	if (file && hits) await attachHits(rows, path.dirname(file)).catch(() => null);
	const summary = fixtureSummary(rows, { planned });
	if (file) await writeFile(file, JSON.stringify(rows, null, 2) + '\n');
	const exitCode = strict ? summary.status === 'INVALID' ? 2 : summary.status === 'FAIL' ? 1 : 0 : 0;
	if (file) await writeFile(file.replace(/\.json$/, '-summary.json'), JSON.stringify({ ...summary, exitCode }, null, 2) + '\n');
	if (setExitCode) process.exitCode = exitCode;
	return { ...summary, exitCode };
}

export const EDIT_LOOP_HELP = `Edit loop: select the recorded failing case; use its report for counts.
Run only the affected incident while editing; reserve the full matrix for the product gate.
Finish with a three-line entry in $ARENA_PRIVATE_INPUTS/docs/gameplay-friction/<pr>-<slug>.md (longest, untrusted, guessed).`;

export const FIXTURE_OUTCOME_HELP = `These body fixtures diagnose mechanics; they do not prove production coordinator steering.
Strict mode is the default: exit 1 = unmet acceptance, exit 2 = invalid evidence.
Use --descriptive for an exploratory report without an acceptance exit code.`;
