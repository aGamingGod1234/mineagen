import { writeFile } from 'node:fs/promises';

const TERMINAL = new Set(['SUCCEEDED', 'FAILED', 'CANCELLED', 'TIMED_OUT']);

/** Count receipts, never copies of lastResult carried by observations. */
export function terminalCounter() {
	const seen = new Map(), byReason = {};
	let duplicates = 0, missingActionIds = 0, conflicts = 0;
	return {
		accept(row) {
			const event = row.envelope ?? row, result = event.payload ?? {};
			if (event.type !== 'action_result' || !TERMINAL.has(result.state)) return;
			if (!result.actionId) { missingActionIds++; return; }
			const key = JSON.stringify([event.agentId, result.goalRevision, result.actionId]);
			const signature = JSON.stringify([result.state, result.reasonCode]);
			if (seen.has(key)) { duplicates++; if (seen.get(key) !== signature) conflicts++; return; }
			seen.set(key, signature);
			const code = result.reasonCode ?? result.state;
			byReason[code] = (byReason[code] ?? 0) + 1;
		},
		snapshot: () => ({ terminalResults: seen.size, byReason: { ...byReason }, duplicates, missingActionIds, conflicts }),
	};
}

export function fixtureSummary(rows, { planned = rows.length } = {}) {
	const counted = rows.filter(row => !row.skipped);
	const invalid = counted.filter(row => row.error || row.integrity?.length || row.measurementStatus === 'INVALID');
	const failed = counted.filter(row => row.pass === false || row.bar === false);
	return {
		planned, started: rows.filter(row => Number.isFinite(row.startedAt)).length,
		completed: counted.filter(row => Number.isFinite(row.finishedAt) && !row.error).length,
		cancelledBeforeStart: rows.filter(row => row.cancelledBeforeStart === true).length,
		notStarted: Math.max(0, planned - rows.filter(row => Number.isFinite(row.startedAt) || row.cancelledBeforeStart === true).length),
		skipped: rows.filter(row => row.skipped).length, failed: failed.length, invalid: invalid.length,
		status: invalid.length || planned === 0 || rows.length < planned || counted.some(row => row.pass === undefined) ? 'INVALID' : failed.length ? 'FAIL' : counted.length ? 'PASS' : 'INVALID',
	};
}

/** Reports survive failed rows; strict callers distinguish failed acceptance from invalid evidence. */
export async function finishRun(rows, { file, planned = rows.length, strict = true, setExitCode = true } = {}) {
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
