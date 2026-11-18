// Pure scoring for the reflex-room round report (scripts/quality/reflex-round-report.mjs): damage, deaths and room
// success over each room's own window, damage reconciled against the vanilla counter, and paired arms judged against a
// margin set in advance. Rows are the Watcher's arena-watch/<agent>-danger.jsonl rows (schema DANGER_SCHEMA).
import { damageEvidence } from './damage-counter.mjs';

export const DANGER_SCHEMA = 1;
/** Each room is scored over its own window from goal start, whatever the run's budget was. */
export const ROOM_WINDOWS_MS = Object.freeze({ 'R-FLOOD': 360000, 'R-TOOLBREAK': 180000 });
export const DEFAULT_ROOM_WINDOW_MS = 300000;
/** Per-hit tolerance between the Watcher's health drop and the vanilla counter (tenths of HP, rounded per hit). */
export const HIT_TOLERANCE_HP = 0.05;
/** The sampler and the Watcher use different clocks; a hit this close to the final sample may fall on either side. */
export const EDGE_SLACK_MS = 2000;
/** Counter samples must reach this close to both ends of the room window, or a truncated capture would score as clean. */
export const COVERAGE_SLACK_MS = 5000;
/** Margin = z x per-pair SD x sqrt(complete pairs), per room and metric (see scripts/quality/README.md). */
export const DEFAULT_MARGIN_Z = 2;
/**
 * Deaths and room success move in whole events, so one event is never beyond the margin, even when the A/A SD is 0.
 * Damage keeps 1 HP: a room with no damage in any A/A pair would otherwise read a single half-heart hit as WORSE.
 */
export const MIN_MARGIN = Object.freeze({ damage: 1, deaths: 1, success: 1 });
export const METRICS = Object.freeze(['damage', 'deaths', 'success']);
/** Lower is better for damage and deaths; higher for success. */
const BETTER_LOWER = Object.freeze({ damage: true, deaths: true, success: false });

export const roomWindowMs = scenario => ROOM_WINDOWS_MS[scenario] ?? DEFAULT_ROOM_WINDOW_MS;
const round = (value, places = 2) => value === null || value === undefined ? null : Math.round(value * 10 ** places) / 10 ** places;
const finite = Number.isFinite;

/** Danger rows of the current schema only; older or unknown schemas are counted, never mixed in. */
export function splitDangerRows(rows) {
	const current = [], other = [];
	for (const row of rows ?? []) (row?.schema === DANGER_SCHEMA ? current : other).push(row);
	return { rows: current, otherSchema: other.length };
}

/**
 * Reconciles the Watcher's per-hit health drop with the vanilla damage_taken counter (tenths of HP, after armour and
 * absorption) over the whole run up to the final sample. A lethal hit's row stops at 0 health while the counter counts
 * the hit in full, so with a lethal hit the counter may only read higher. Missing counter or rows, or a counter sample that
 * is not a non-negative whole number, = unknown, never 0.
 */
export function reconcileDamage(damageRows, samples) {
	if (damageCounterCorrupt(samples)) return { status: 'unknown', reason: 'a vanilla damage counter sample is not a non-negative whole number' };
	const counted = (samples ?? []).filter(s => finite(s?.damageTakenCounter) && finite(s?.at));
	if (!counted.length) return { status: 'unknown', reason: 'no vanilla damage counter samples' };
	if (damageRows === null) return { status: 'unknown', reason: 'no danger rows' };
	const first = counted[0], last = counted.at(-1);
	const evidence = damageEvidence(0, last.damageTakenCounter, null, null);
	if (evidence.damageTaken === null || counted.some((s, i) => i && s.damageTakenCounter < counted[i - 1].damageTakenCounter)) return { status: 'unknown', reason: 'missing or decreasing vanilla damage counter' };
	if (damageRows.some(row => row.paired === false)) return { status: 'unknown', reason: 'a damage row has no health before the hit' };
	const upTo = limit => damageRows.filter(row => row.atMs <= limit);
	const sum = rows => rows.reduce((total, row) => total + (row.healthDrop ?? 0), 0);
	const early = upTo(last.at - EDGE_SLACK_MS), late = upTo(last.at + EDGE_SLACK_MS);
	const tolerance = HIT_TOLERANCE_HP * Math.max(1, late.length);
	const lethal = late.some(row => row.lethal === true);
	const counter = evidence.damageTaken;
	const low = sum(early) - tolerance, high = lethal ? Infinity : sum(late) + tolerance;
	const status = counter >= low && counter <= high ? 'valid' : 'invalid';
	return { status, counterHp: round(counter), rowsHp: round(sum(upTo(last.at))), hits: upTo(last.at).length, lethal, toleranceHp: round(tolerance, 3),
		firstSampleAt: first.at, finalSampleAt: last.at, ...(status === 'invalid' ? { reason: `counter ${round(counter)} HP outside rows ${round(low)}..${round(high)} HP` } : {}) };
}

/** A damage counter sample is present but malformed: not a non-negative whole number (tenths of HP). */
export function damageCounterCorrupt(samples) {
	return (samples ?? []).some(s => s?.damageTakenCounter !== undefined && s?.damageTakenCounter !== null
		&& !(Number.isSafeInteger(s.damageTakenCounter) && s.damageTakenCounter >= 0));
}

/** Threat spans from onset and clear rows, clipped to the window; a span still open at the window end runs to it. */
export function threatTime(rows, start, end) {
	const onsets = rows.filter(row => row.type === 'onset' && row.atMs >= start && row.atMs <= end);
	const clears = rows.filter(row => row.type === 'clear').sort((a, b) => a.atMs - b.atMs);
	let ms = 0;
	for (const clear of clears) {
		const from = Math.max(start, clear.startAtMs), to = Math.min(end, clear.endAtMs);
		if (to > from) ms += to - from;
	}
	const lastClear = clears.at(-1)?.atMs ?? -Infinity;
	const open = onsets.filter(row => row.atMs > lastClear);
	if (open.length) ms += Math.max(0, end - Math.max(start, Math.min(...open.map(row => row.atMs))));
	return { onsets: onsets.length, threatMs: ms };
}

/** Response paths and latency of the onsets in the window (diagnostic). */
export function responses(rows, start, end) {
	const onsets = rows.filter(row => row.type === 'onset' && row.atMs >= start && row.atMs <= end);
	const paths = {}, latencies = [];
	for (const row of onsets) {
		const path = String(row.response ?? 'none').startsWith('instinct:') ? 'instinct' : row.response ?? 'none';
		paths[path] = (paths[path] ?? 0) + 1;
		if (finite(row.latencyTicks)) latencies.push(row.latencyTicks);
	}
	latencies.sort((a, b) => a - b);
	const pct = p => latencies.length ? latencies[Math.min(latencies.length - 1, Math.floor(p * latencies.length))] : null;
	const byKind = {};
	for (const row of onsets) byKind[row.onset] = (byKind[row.onset] ?? 0) + 1;
	return { paths, byKind, latencyTicks: { p50: pct(0.5), p95: pct(0.95), n: latencies.length } };
}

/**
 * One room run. dangerRows null = no Watcher file (unknown). Returns window damage, deaths and success, each null when
 * unknown, with the damage status: valid, invalid (rows and counter disagree) or unknown (either is missing).
 */
export function scoreRun({ scenario, goalStartedAtMs, samples = [], dangerRows = null, dangerDropped = 0, lifecycle = [], evaluation = null, runBudgetMs = null }) {
	const windowMs = roomWindowMs(scenario);
	const split = dangerRows === null ? { rows: null, otherSchema: 0 } : splitDangerRows(dangerRows);
	const rows = split.rows;
	const start = finite(goalStartedAtMs) ? goalStartedAtMs : null;
	const success = roomSuccess(evaluation, start, windowMs, samples, runBudgetMs);
	if (start === null) return { scenario, windowMs, status: 'unknown', reason: 'no goal start', damage: null, deaths: null, success, otherSchemaRows: split.otherSchema };
	const end = start + windowMs;
	const damageRows = rows?.filter(row => row.type === 'damage') ?? null;
	const counted = samples.filter(s => finite(s?.at) && finite(s?.damageTakenCounter));
	// The sampler pauses while the player is dead, so a body that died and stayed dead to the window end is covered by its
	// dead event instead of a closing sample.
	const covered = counted.length > 0 && counted[0].at <= start + COVERAGE_SLACK_MS
		&& (counted.at(-1).at >= end - COVERAGE_SLACK_MS || deadThroughEnd(lifecycle, counted.at(-1).at, end) !== null);
	const reconciliation = dangerDropped > 0 ? { status: 'unknown', reason: `${dangerDropped} malformed danger row(s): the Watcher file is corrupt` }
		: covered ? reconcileDamage(damageRows, samples)
		: { status: 'unknown', reason: `counter samples do not cover the room window (${counted.length ? `${counted[0].at - start}..${counted.at(-1).at - start} ms of 0..${windowMs} ms` : 'none'})` };
	const inWindow = damageRows?.filter(row => row.atMs >= start && row.atMs <= end) ?? [];
	const damage = reconciliation.status === 'valid' ? round(inWindow.reduce((total, row) => total + (row.healthDrop ?? 0), 0)) : null;
	// Deaths stand on the death counter's own coverage of the window, not the damage reconciliation: one unpaired damage
	// row leaves damage unknown but says nothing about deaths. Without that counter, the lethal rows when damage reconciled.
	const counterDeaths = windowDeaths(samples, start, end, lifecycle);
	const lethalRows = inWindow.filter(row => row.lethal === true).length;
	// A corrupt counter is unknown evidence, not an absent one: it never falls back to the lethal rows.
	const deaths = deathCounterCorrupt(samples) ? null
		: counterDeaths !== null && counterDeaths >= 0 ? Math.max(counterDeaths, lethalRows) : reconciliation.status === 'valid' ? lethalRows : null;
	const threat = rows === null ? null : threatTime(rows, start, end);
	const result = { scenario, windowMs, goalStartedAtMs: start, status: reconciliation.status, damage, deaths, success, reconciliation,
		hits: inWindow.length, absorbedHp: round(inWindow.reduce((total, row) => total + (row.absorbed ?? 0), 0)), blockedHits: inWindow.filter(row => row.blocked === true).length,
		otherSchemaRows: split.otherSchema };
	if (threat) {
		result.diagnostics = { ...threat, opportunity: threat.onsets === 0 ? 'no_opportunity' : 'opportunity', responses: responses(rows, start, end),
			damagePerThreatMinute: damage !== null && threat.threatMs > 0 ? round(damage / (threat.threatMs / 60000)) : null,
			firings: firingSummary(rows, start, end) };
	}
	return result;
}

/**
 * Room success inside the room's own window: the whole-run evaluation's pass counts only when its pass time (passAt, or
 * timeToPassMs from goal start) falls by the window end, within the clock slack. A pass with no recorded time counts only
 * when the run did not outlast the window (its budget and its samples end by then); otherwise it is unknown.
 */
export function roomSuccess(evaluation, start, windowMs, samples = [], runBudgetMs = null) {
	if (evaluation?.status !== 'EVALUATED') return null;
	if (evaluation.pass !== true) return false;
	const passMs = finite(evaluation.passAt) && start !== null ? evaluation.passAt - start : finite(evaluation.timeToPassMs) ? evaluation.timeToPassMs : null;
	if (passMs !== null) return passMs <= windowMs + EDGE_SLACK_MS;
	const lastAt = (samples ?? []).filter(s => finite(s?.at)).at(-1)?.at;
	const outlasted = (finite(runBudgetMs) && runBudgetMs > windowMs) || (start !== null && finite(lastAt) && lastAt > start + windowMs + EDGE_SLACK_MS);
	return outlasted ? null : true;
}

/**
 * The time of a goal_control `dead` event after the sample at `after` (within the clock slack) and by the window end, with
 * no `start` or `respawn` after it by the end: the body died and stayed dead to the end. Null otherwise.
 */
export function deadThroughEnd(lifecycle, after, end) {
	let deadAt = null;
	for (const event of [...(lifecycle ?? [])].filter(e => finite(e?.at) && e.at <= end).sort((a, b) => a.at - b.at)) {
		if (event.operation === 'dead' && event.at >= after - EDGE_SLACK_MS) deadAt ??= event.at;
		else if (event.operation === 'respawn' || event.operation === 'start') deadAt = null;
	}
	return deadAt;
}

const deathRows = samples => (samples ?? []).filter(s => finite(s?.at) && s?.deathCounter !== undefined && s?.deathCounter !== null);

/** The death counter is present but malformed: not a whole number, negative, or going down between samples. */
export function deathCounterCorrupt(samples) {
	const rows = deathRows(samples);
	return rows.some(s => !Number.isInteger(s.deathCounter) || s.deathCounter < 0) || rows.some((s, i) => i && s.deathCounter < rows[i - 1].deathCounter);
}

/**
 * Deaths in the window: the larger of the death counter's rise and the goal_control dead events since the base sample,
 * the base within COVERAGE_SLACK_MS of the window start and the closing sample within it of the window end, the counter a
 * non-decreasing whole number throughout. A body that died after its last sample and stayed dead to the end
 * (deadThroughEnd) needs no closing sample: its dead event covers the end. A closing sample after the end has the dead
 * events between the end and it taken off its rise. Null (unknown) when either boundary is uncovered, the counter is
 * malformed or goes down, or such a rise has deaths no dead event places.
 */
export function windowDeaths(samples, start, end, lifecycle = []) {
	const rows = deathRows(samples);
	if (deathCounterCorrupt(samples)) return null;
	const near = at => rows.filter(s => Math.abs(s.at - at) <= COVERAGE_SLACK_MS);
	const atStart = near(start), atEnd = near(end);
	if (!atStart.length) return null;
	// Both boundary samples are taken inside the window where one is near (the first at or after the start, the last at or
	// before the end), so the counter's rise never takes in a death just outside it.
	const base = atStart.find(s => s.at >= start) ?? atStart.at(-1);
	// A sample's time is stamped before its counter is read, so a death near a sample may or may not be in it. Each death
	// also has a dead event; the larger of the counter's rise and the dead events inside the window counts each death once,
	// including one between a boundary sample and the window edge, or one the body never respawned from.
	const deadSince = (lifecycle ?? []).filter(e => e?.operation === 'dead' && finite(e.at) && e.at > start && e.at <= end).length;
	if (!atEnd.length) {
		const lastBefore = rows.filter(s => s.at <= end).at(-1);
		if (!lastBefore || lastBefore.at < base.at || deadThroughEnd(lifecycle, lastBefore.at, end) === null) return null;
		return Math.max(lastBefore.deathCounter - base.deathCounter, deadSince);
	}
	const last = atEnd.filter(s => s.at <= end).at(-1) ?? atEnd[0];
	if (last.at <= base.at) return null;
	const rise = last.deathCounter - base.deathCounter;
	if (last.at <= end) return Math.max(rise, deadSince);
	// The only closing sample is after the end: its rise takes in the deaths between the end and it, so their dead events
	// come off. A rise left over beyond the in-window dead events has no event to place it on either side: unknown.
	const deadAfter = (lifecycle ?? []).filter(e => e?.operation === 'dead' && finite(e.at) && e.at > end && e.at <= last.at).length;
	const inside = Math.max(0, rise - deadAfter);
	return inside > deadSince ? null : deadSince;
}

/** Firing rows that ended in the window, by outcome (diagnostic); start must never follow end. */
export function firingSummary(rows, start, end) {
	const firings = rows.filter(row => row.type === 'firing' && row.atMs >= start && row.atMs <= end);
	const outcomes = {};
	for (const row of firings) outcomes[row.outcome] = (outcomes[row.outcome] ?? 0) + 1;
	return { count: firings.length, outcomes, orderViolations: firings.filter(row => !(row.startGameTime <= row.endGameTime)).length };
}

// Damage counts only when reconciled; deaths carry their own coverage (scoreRun leaves them null when unknown).
const metricValue = (run, metric) => metric === 'success' ? (run.success === null ? null : Number(run.success))
	: metric === 'deaths' ? run.deaths ?? null : run.status === 'valid' ? run[metric] : null;

/**
 * Pairs scored runs by pairId (run-scenarios' <room>-r<n>); a pair counts for a metric only when both runs have it.
 * Deltas are B minus A, A the baseline.
 */
export function pairRuns(armA, armB) {
	const byId = runs => new Map(runs.map(run => [run.pairId, run]));
	const a = byId(armA), b = byId(armB);
	const pairs = [];
	for (const id of [...new Set([...a.keys(), ...b.keys()])].sort()) {
		const left = a.get(id), right = b.get(id);
		const deltas = {};
		for (const metric of METRICS) {
			const x = left ? metricValue(left, metric) : null, y = right ? metricValue(right, metric) : null;
			deltas[metric] = x === null || y === null ? null : round(y - x);
		}
		pairs.push({ pairId: id, scenario: (left ?? right).scenario, deltas, statusA: left?.status ?? 'missing', statusB: right?.status ?? 'missing' });
	}
	return pairs;
}

const sd = values => {
	if (values.length < 2) return null;
	const mean = values.reduce((a, b) => a + b, 0) / values.length;
	return Math.sqrt(values.reduce((total, v) => total + (v - mean) ** 2, 0) / (values.length - 1));
};

/** Per room and metric: the SD of per-pair deltas. From an A/A run this is the noise floor the margin file keeps. */
export function noiseFloor(pairs) {
	const rooms = {};
	for (const scenario of [...new Set(pairs.map(pair => pair.scenario))].sort()) {
		rooms[scenario] = {};
		for (const metric of METRICS) {
			const values = pairs.filter(pair => pair.scenario === scenario && pair.deltas[metric] !== null).map(pair => pair.deltas[metric]);
			rooms[scenario][metric] = { perPairSd: round(sd(values), 4), pairs: values.length };
		}
	}
	return { rooms };
}

/**
 * Room-stratified sums of per-pair deltas judged against a margin set in advance: margin = z x perPairSd x sqrt(n). Beyond
 * it the step is WORSE or BETTER on that room; inside it INCONCLUSIVE; with no margin for the room, NO_MARGIN. Overall:
 * FAIL on any WORSE, else INCOMPLETE while any pair lacks a metric, else PASS (some BETTER) or INCONCLUSIVE.
 * firstAttempts is the paired runner's first-attempt failure guard (firstAttemptFailures in quality-metrics.mjs): retries
 * replace runs the rooms never score, so excess B failures among the first attempts fail the step and a guard without
 * complete first-attempt evidence leaves it INCOMPLETE.
 */
export function judgeRooms(pairs, margin = null, firstAttempts = null) {
	const z = finite(margin?.z) ? margin.z : DEFAULT_MARGIN_Z;
	const rooms = {};
	for (const scenario of [...new Set(pairs.map(pair => pair.scenario))].sort()) {
		const inRoom = pairs.filter(pair => pair.scenario === scenario);
		rooms[scenario] = { pairs: inRoom.length };
		for (const metric of METRICS) {
			const deltas = inRoom.map(pair => pair.deltas[metric]).filter(value => value !== null);
			const sum = round(deltas.reduce((a, b) => a + b, 0));
			const perPairSd = margin?.rooms?.[scenario]?.[metric]?.perPairSd;
			const limit = finite(perPairSd) && deltas.length ? round(Math.max(z * perPairSd * Math.sqrt(deltas.length), MIN_MARGIN[metric] ?? 0), 4) : null;
			let verdict = 'NO_MARGIN';
			if (!deltas.length) verdict = 'NO_DATA';
			else if (limit !== null) {
				const worse = BETTER_LOWER[metric] ? sum > limit : sum < -limit;
				const better = BETTER_LOWER[metric] ? sum < -limit : sum > limit;
				verdict = worse ? 'WORSE' : better ? 'BETTER' : 'INCONCLUSIVE';
			}
			rooms[scenario][metric] = { complete: deltas.length, incomplete: inRoom.length - deltas.length, sum, margin: limit, verdict };
		}
	}
	const verdicts = Object.values(rooms).flatMap(room => METRICS.map(metric => room[metric].verdict));
	// A pair with unknown evidence for any metric leaves the step unjudged, whatever its complete pairs say; the per-metric
	// verdicts above stay as diagnostics. A WORSE metric still fails the step.
	const unknown = Object.values(rooms).some(room => METRICS.some(metric => room[metric].incomplete > 0));
	const guard = firstAttempts?.status ?? null;
	const overall = verdicts.includes('WORSE') || guard === 'REGRESSED' ? 'FAIL'
		: !unknown && guard !== 'INCOMPLETE' && verdicts.every(v => v === 'BETTER' || v === 'INCONCLUSIVE') && verdicts.length ? (verdicts.includes('BETTER') ? 'PASS' : 'INCONCLUSIVE') : 'INCOMPLETE';
	return { z, rooms, overall, ...(firstAttempts ? { firstAttemptFailures: firstAttempts } : {}) };
}
