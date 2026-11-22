// Scores a benchmark batch (room-batch.mjs output) per practice room and compares it with a saved baseline.
// A benchmark room plays REPEATS times: as `copies` room-batch rooms (ROOM.cN) x `slots` arms (r1..rK, same jar, side
// by side on one machine). Every row a fixture writes is one run; a fixture that writes no result.json (not yet on
// finishRun) counts as one run judged by its exit code (0 pass, 1 fail, anything else invalid). Pure apart from reading
// the batch folder, so the scoring and the comparison are unit-tested.
import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { holmAdjust, stratifiedExactTest } from '../../../coordinator/src/decision-eval/stats.mjs';
import { roomVerdict } from './fixture-run.mjs';
import { armRows } from './room-batch-core.mjs';

/**
 * The room-batch commands for a benchmark: each room ROOM becomes `copies` rooms ROOM.c1.. (longest first, so long
 * rooms do not trail at the end), each played by `slots` arms r1..rK with the same jar side by side.
 */
export function planBenchmark(rooms, { repeats = 10, slots = 5 } = {}) {
	if (!Number.isInteger(repeats) || repeats < 1) throw new Error('repeats wants a whole number of 1 or more');
	if (!Number.isInteger(slots) || slots < 1 || slots > repeats) throw new Error('slots wants a whole number from 1 to repeats');
	const copies = Math.ceil(repeats / slots);
	const arms = Array.from({ length: slots }, (_, i) => `r${i + 1}`);
	const ids = new Set();
	for (const room of rooms) {
		if (!/^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(room.room ?? '')) throw new Error(`room id must be letters, digits, _ or -: ${room.room}`);
		if (ids.has(room.room)) throw new Error(`room ${room.room} appears twice`);
		ids.add(room.room);
		if (!/\$OUT\b/.test(room.line ?? '') || !/(^|\s)node\s/.test(room.line)) throw new Error(`room ${room.room} needs a "node ... $OUT ..." line`);
	}
	const sorted = [...rooms].sort((a, b) => (b.estMinutes ?? 0) - (a.estMinutes ?? 0) || a.room.localeCompare(b.room));
	const instances = [], lines = [];
	for (let copy = 1; copy <= copies; copy++) for (const room of sorted) {
		const name = `${room.room}.c${copy}`;
		instances.push({ name, room: room.room, copy });
		const rate = Number(room.tickRate ?? 20) > 20 ? `FIXTURE_TICK_RATE=${room.tickRate} ` : '';
		lines.push(`@${name} ${rate}${room.line}`);
	}
	return { repeats, slots, copies, arms, instances, commands: lines.join('\n') + '\n' };
}

export const STAGES = ['early', 'iron-kit', 'portal-lava', 'nether-fortress', 'nether-rods', 'nether-pearls', 'end'];
export const SKILLS = ['combat', 'movement', 'building', 'survival'];
const COPY = /^(.+)\.c(\d+)$/;

/** A file that is there but does not parse (a write cut short): unknown evidence for its run, never a crash of the scoreboard. */
const CORRUPT = Symbol('corrupt JSON');
const readJson = file => readFile(file, 'utf8').then(text => { try { return JSON.parse(text); } catch { return CORRUPT; } }, () => null);
const median = values => {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (!sorted.length) return null;
	const mid = sorted.length >> 1;
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};

/** A failure reason short enough to count: the last failed call's code when the row has calls, else the verdict reason with numbers and coordinates folded. */
export function reasonKey(row, verdict) {
	if (Number(row.deaths) > 0) {
		const cause = row.deathCause ?? row.deathMessage ?? row.deaths_cause ?? null;
		return `died${cause ? `: ${foldReason(cause)}` : ''}`;
	}
	const calls = Array.isArray(row.calls) ? row.calls : [];
	const failed = [...calls].reverse().find(call => call && call.state && call.state !== 'SUCCEEDED' && call.reasonCode);
	if (verdict.verdict === 'FAIL' && failed) return `${failed.reasonCode}`;
	return foldReason(verdict.reason);
}
export const foldReason = text => String(text ?? '').split('\n')[0]
	.replace(/-?\d+(\.\d+)?/g, 'N').replace(/\s+/g, ' ').trim().slice(0, 90);

const SKIP_FILES = new Set(['manifest.json', 'actions.json', 'timeline.json', 'result-summary.json', 'done.json']);
/** A room's own bar from its meta: passWhen { field, min } on a top-level number of the fixture's JSON, e.g. pearls held at the end. */
const meetsBar = (passWhen, fields) => Number.isFinite(fields?.[passWhen.field]) && fields[passWhen.field] >= passWhen.min;
/**
 * Deaths and damage from a fixture's own JSON files when it writes no result.json: every list of row objects counts
 * died: true (or deaths: N) and sums damageTaken (or damage, healthLost); a row with pass: false or ok: false is noted.
 * A field nobody wrote stays null (unknown), never 0.
 */
export async function otherEvidence(dir) {
	let failed = null, failedPass = false, deathsUnread = false;
	const fields = {}, corrupt = [], integrity = [];
	// The deepest object that names a death or a hurt counts it; a parent (a variant, a summary, a deathCounter) that
	// repeats its children's total adds nothing. A bare "damage" counts only beside died/deaths, since elsewhere it is
	// often an item's wear, not health.
	const visit = (value, depth) => {
		if (depth > 6 || value === null || typeof value !== 'object') return { deaths: null, damage: null };
		const children = { deaths: null, damage: null };
		const entries = Array.isArray(value) ? value.map(item => [null, item]) : Object.entries(value);
		for (const [key, child] of entries) {
			if (child === null || typeof child !== 'object' || key === 'summary') continue;
			const below = visit(child, depth + 1);
			if (below.deaths !== null) children.deaths = (children.deaths ?? 0) + below.deaths;
			if (below.damage !== null) children.damage = (children.damage ?? 0) + below.damage;
		}
		if (Array.isArray(value)) return children;
		if (depth === 0) for (const [key, child] of Object.entries(value)) if (Number.isFinite(child)) fields[key] = child;
		// The default-reflex room's rule-less body (mode "none") is its control and dies on purpose: it never counts.
		if (value.mode === 'none' && typeof value.alive === 'boolean') return { deaths: null, damage: null };
		if (value.pass === false || value.ok === false) failed ??= value.pass === false ? 'pass' : 'ok';
		if (value.pass === false) failedPass = true;
		// The default-reflex edge room's bar is staying on the bridge (its own tally); resistance keeps both bodies alive.
		if (value.offBridge === true) failed ??= 'offBridge';
		if (Array.isArray(value.integrity)) integrity.push(...value.integrity);
		// A death counter that says it could not be read (the blaze room's deathCounter.valid false) leaves deaths unknown.
		if (value.valid === false && 'deaths' in value) deathsUnread = true;
		// The crowd room writes survived: false per run and a died count in its summary.
		const own = typeof value.died === 'boolean' ? (value.died ? 1 : 0) : Number.isFinite(value.died) ? value.died : Number.isFinite(value.deaths) ? value.deaths
			: typeof value.survived === 'boolean' ? (value.survived ? 0 : 1) : typeof value.alive === 'boolean' ? (value.alive ? 0 : 1) : null;
		const hurt = [value.damageTaken, value.healthLost, own !== null ? value.damage : undefined].find(Number.isFinite) ?? null;
		// A parent that repeats its children's total adds nothing, but one that counted a death after them (the blaze room
		// samples its counter before the last health check) keeps it: the larger count stands.
		const deaths = children.deaths === null ? own : own === null ? children.deaths : Math.max(children.deaths, own);
		return { deaths, damage: children.damage ?? hurt };
	};
	let deaths = null, damage = null;
	const names = await readdir(dir).catch(() => []);
	for (const file of names.filter(file => file.endsWith('.json') && !SKIP_FILES.has(file))) {
		const value = await readJson(path.join(dir, file));
		if (value === CORRUPT) { corrupt.push(file); continue; }
		const found = visit(value, 0);
		// Two files saying the same thing (rows.json and summary.json) must not add up: keep the larger count.
		if (found.deaths !== null) deaths = Math.max(deaths ?? 0, found.deaths);
		if (found.damage !== null) damage = Math.max(damage ?? 0, found.damage);
	}
	// A crowd, defend or rest room that caught an error writes error.txt and still exits 0.
	const error = names.includes('error.txt') ? (await readFile(path.join(dir, 'error.txt'), 'utf8').catch(() => '')).split('\n')[0] || 'error.txt' : null;
	return { deaths, damage: damage === null ? null : +damage.toFixed(1), failed, failedPass, deathsUnread, fields, corrupt, integrity, error };
}
/** The thrown error of a fixture that failed by exception, from its log, folded to count. */
async function failureLine(log) {
	const text = await readFile(log, 'utf8').catch(() => '');
	const line = text.split('\n').reverse().find(item => /^\s*(\w*Error|AssertionError)\b/.test(item) || /^Error:/.test(item));
	if (!line) return null;
	// A thrown action result carries its own code; that is the reason to count, not the JSON around it.
	const code = /"reasonCode":"([A-Z_]+)"/.exec(line)?.[1];
	return code ? `Error: ${code}` : foldReason(line.trim());
}

const rowSeconds = row => Number.isFinite(row.seconds) ? row.seconds
	: Number.isFinite(row.startedAt) && Number.isFinite(row.finishedAt) ? (row.finishedAt - row.startedAt) / 1000 : null;

/**
 * Every run of a room-batch output folder: { room, copy, arm, verdict, reason, deaths, damage, seconds }. plan (from
 * planBenchmark) names the room instances and arms that should be there, so a room that never came back counts as lost.
 */
export async function collectRuns(batchDir, planned = null, meta = null) {
	const runs = [];
	const roomsDir = path.join(batchDir, 'rooms');
	const outcomes = new Map(((await readJson(path.join(batchDir, 'batch.json')))?.outcomes ?? []).filter(Boolean).map(item => [item.room, item]));
	const names = (await readdir(roomsDir).catch(() => [])).filter(name => !name.startsWith('.'));
	const seen = new Set(names);
	// Rooms the plan names but the batch never brought back are lost runs, never silently missing.
	for (const instance of planned?.instances ?? []) if (!seen.has(instance.name)) {
		for (const arm of planned.arms) runs.push({ room: instance.room, copy: instance.copy, arm, verdict: 'LOST', reason: outcomes.get(instance.name)?.reason ?? 'room never came back', deaths: null, damage: null, seconds: null });
	}
	for (const name of names) {
		const match = COPY.exec(name);
		const room = match ? match[1] : name, copy = match ? Number(match[2]) : 1;
		const doneRead = await readJson(path.join(roomsDir, name, 'done.json'));
		const done = doneRead === CORRUPT ? null : doneRead;
		const arms = planned?.arms ?? Object.keys(done?.arms ?? {});
		for (const arm of arms) {
			const run = done?.arms?.[arm];
			const base = { room, copy, arm };
			if (doneRead === CORRUPT) { runs.push({ ...base, verdict: 'INVALID', reason: 'corrupt done.json', deaths: null, damage: null, seconds: null }); continue; }
			if (!done || !run) { runs.push({ ...base, verdict: 'LOST', reason: outcomes.get(name)?.reason ?? 'no done.json', deaths: null, damage: null, seconds: null }); continue; }
			const killed = run.timedOut ? 'room timeout' : run.signal ? `killed by ${run.signal}` : run.error ? `launch error: ${run.error}` : null;
			// finishRun's rows and their summary, under whatever name the fixture gave them (armRows, as the batch merger
			// reads them); a missing or corrupt summary or one that planned more rows than came back is unknown evidence.
			const found = await armRows(path.join(roomsDir, name, arm));
			const rows = found.rows.filter(row => row && typeof row === 'object');
			// A rows file finishRun wrote, even an empty one, is judged by its summary, never by the exit code.
			if (rows.length || found.problem || found.file) {
				const own = found.summary;
				const ownValid = Boolean(own && typeof own === 'object' && Number.isInteger(own.planned));
				// An INVALID summary needs no room-wide verdict: its invalid rows read INVALID themselves, its missing ones below.
				const invalid = killed ?? found.problem ?? (!ownValid ? 'missing or corrupt room summary' : own.planned <= 0 ? 'room planned 0 rows' : null);
				for (const row of rows) {
					const verdict = invalid ? { verdict: 'INVALID', reason: invalid } : roomVerdict(row);
					runs.push({ ...base, verdict: verdict.verdict, reason: verdict.verdict === 'PASS' ? null : invalid ?? reasonKey(row, verdict),
						deaths: Number.isFinite(row.deaths) ? row.deaths : null, damage: Number.isFinite(row.damageTaken) ? row.damageTaken : null,
						seconds: rowSeconds(row), wallSeconds: run.seconds ?? null, cantKeepUp: run.cantKeepUp ?? null });
				}
				const missing = Math.max(rows.length ? 0 : 1, ownValid ? own.planned - rows.length : 0);
				for (let i = 0; i < missing; i++) runs.push({ ...base, verdict: 'INVALID', reason: invalid ?? 'a planned row was never written', deaths: null, damage: null, seconds: null });
				continue;
			}
			// No rows: a fixture outside finishRun reports by its exit code; its own JSON files give deaths and damage
			// where they name them, and a fixture with no pass bar (bar "none") passes when the body survived.
			const evidence = await otherEvidence(path.join(roomsDir, name, arm));
			let verdict = killed ? 'INVALID' : run.exit === 0 ? 'PASS' : run.exit === 1 ? 'FAIL' : 'INVALID';
			let reason = verdict === 'PASS' ? null : killed ?? (await failureLine(path.join(roomsDir, name, `${arm}.log`))) ?? `exit ${run.exit ?? '?'}`;
			const passWhen = meta?.[room]?.passWhen;
			const survivalBar = meta?.[room]?.bar === 'none' || passWhen;
			// What the fixture wrote outranks its exit code: an error it caught, a file cut short, or a pass: false it recorded.
			if (!killed && evidence.integrity.length) ({ verdict, reason } = roomVerdict({ integrity: evidence.integrity }));
			if (verdict === 'PASS' && evidence.deathsUnread) { verdict = 'INVALID'; reason = 'death counter unreadable'; }
			if (verdict === 'PASS' && evidence.error) { verdict = 'INVALID'; reason = `fixture error: ${foldReason(evidence.error)}`; }
			// A file cut short is unknown evidence whatever the exit code said.
			if (verdict !== 'INVALID' && evidence.corrupt.length) { verdict = 'INVALID'; reason = `corrupt ${evidence.corrupt.join(', ')}`; }
			if (verdict === 'PASS' && evidence.failedPass && !survivalBar) { verdict = 'FAIL'; reason = 'pass false'; }
			if (verdict === 'PASS' && survivalBar && (evidence.deaths > 0 || evidence.failed)) { verdict = 'FAIL'; reason = evidence.deaths > 0 ? 'died' : evidence.failed === 'offBridge' ? 'off the bridge' : `${evidence.failed} false`; }
			// A room judged on survival must record a death count.
			if (verdict === 'PASS' && survivalBar && evidence.deaths === null) { verdict = 'INVALID'; reason = 'no death record'; }
			if (verdict === 'PASS' && passWhen && !meetsBar(passWhen, evidence.fields)) { verdict = 'FAIL'; reason = `${passWhen.field} below ${passWhen.min}`; }
			runs.push({ ...base, verdict, reason, deaths: evidence.deaths, damage: evidence.damage,
				seconds: run.seconds ?? null, wallSeconds: run.seconds ?? null, cantKeepUp: run.cantKeepUp ?? null, exitOnly: true });
		}
	}
	return runs;
}

const sumKnown = values => values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null;

/** Per room: runs, pass/fail/invalid/lost, pass rate over valid runs, deaths, damage, median game seconds, top reasons. */
export function scoreRooms(runs, meta = {}) {
	const byRoom = new Map();
	for (const run of runs) { if (!byRoom.has(run.room)) byRoom.set(run.room, []); byRoom.get(run.room).push(run); }
	const rooms = {};
	for (const [room, list] of [...byRoom].sort(([a], [b]) => a.localeCompare(b))) {
		const count = verdict => list.filter(run => run.verdict === verdict).length;
		const pass = count('PASS'), fail = count('FAIL'), invalid = count('INVALID'), lost = count('LOST');
		const played = list.filter(run => run.verdict === 'PASS' || run.verdict === 'FAIL');
		const reasons = {};
		for (const run of list) if (run.verdict !== 'PASS') reasons[`${run.verdict === 'FAIL' ? '' : `${run.verdict}: `}${run.reason}`] = (reasons[`${run.verdict === 'FAIL' ? '' : `${run.verdict}: `}${run.reason}`] ?? 0) + 1;
		const info = meta[room] ?? {};
		rooms[room] = {
			stage: info.stage ?? null, skill: info.skill ?? null, skill2: info.skill2 ?? null, fixture: info.fixture ?? null,
			runs: list.length, pass, fail, invalid, lost,
			passRate: played.length ? +(pass / played.length).toFixed(3) : null,
			deaths: sumKnown(played.map(run => run.deaths)), runsWithDeath: played.filter(run => run.deaths > 0).length,
			damage: sumKnown(played.map(run => run.damage)), medianDamage: median(played.map(run => run.damage)),
			medianSeconds: median(played.map(run => run.seconds)), exitOnly: list.some(run => run.exitOnly),
			topReasons: Object.entries(reasons).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([reason, n]) => ({ reason, n })),
		};
	}
	return rooms;
}

/** Totals per stage and per skill (a room counts toward its skill and its second skill). */
export function groupScores(rooms) {
	const groups = { stage: {}, skill: {} };
	const add = (kind, key, score) => {
		if (!key) return;
		const group = groups[kind][key] ??= { rooms: 0, runs: 0, pass: 0, fail: 0, invalid: 0, lost: 0, deaths: 0, runsWithDeath: 0 };
		group.rooms++; group.runs += score.runs; group.pass += score.pass; group.fail += score.fail; group.invalid += score.invalid; group.lost += score.lost;
		group.deaths += score.deaths ?? 0; group.runsWithDeath += score.runsWithDeath;
	};
	for (const score of Object.values(rooms)) { add('stage', score.stage, score); add('skill', score.skill, score); if (score.skill2 && score.skill2 !== score.skill) add('skill', score.skill2, score); }
	for (const kind of Object.values(groups)) for (const group of Object.values(kind)) group.passRate = group.pass + group.fail ? +(group.pass / (group.pass + group.fail)).toFixed(3) : null;
	return groups;
}

const logFactorial = (() => { const cache = [0]; return n => { for (let i = cache.length; i <= n; i++) cache[i] = cache[i - 1] + Math.log(i); return cache[n]; }; })();
/** Two-sided Fisher exact test on [[a, b], [c, d]]. */
export function fisher(a, b, c, d) {
	const n = a + b + c + d, row1 = a + b, col1 = a + c;
	const p = x => Math.exp(logFactorial(row1) + logFactorial(n - row1) + logFactorial(col1) + logFactorial(n - col1) - logFactorial(n) - logFactorial(x) - logFactorial(row1 - x) - logFactorial(col1 - x) - logFactorial(n - row1 - col1 + x));
	const observed = p(a);
	let total = 0;
	for (let x = Math.max(0, col1 + row1 - n); x <= Math.min(row1, col1); x++) { const px = p(x); if (px <= observed * (1 + 1e-9)) total += px; }
	return Math.min(1, total);
}

/**
 * Per room, current against baseline: pass counts, the two-sided Fisher p, and pAdjusted, its Holm step-down value over
 * every room compared, so the chance changes of many rooms do not add up (at 10 runs a side an unchanged room reads
 * changed about 1.3% of the time, so a 100-room benchmark shows about one). change is better or worse only when the
 * adjusted p is under 5%.
 */
export function compareScores(baseline, current) {
	const rows = [];
	for (const room of [...new Set([...Object.keys(baseline.rooms ?? {}), ...Object.keys(current.rooms ?? {})])].sort()) {
		const before = baseline.rooms?.[room], after = current.rooms?.[room];
		if (!before || !after) { rows.push({ room, change: !before ? 'new room' : 'not run', before: before ?? null, after: after ?? null }); continue; }
		const p = fisher(before.pass, before.fail, after.pass, after.fail);
		const delta = before.passRate === null || after.passRate === null ? null : +(after.passRate - before.passRate).toFixed(3);
		const deathsDelta = before.deaths === null || after.deaths === null ? null : after.deaths - before.deaths;
		rows.push({ room, p: pValue(p), rawP: p, delta, deathsDelta, before: pick(before), after: pick(after) });
	}
	// Only rooms with valid runs on both sides are tests; the others take no share of the 5%.
	const tested = rows.filter(row => row.delta !== null && row.delta !== undefined);
	// The verdict reads the unrounded adjusted p; only the stored value is rounded.
	holmAdjust(tested.map(row => row.rawP)).forEach((adjusted, i) => { tested[i].rawAdjusted = adjusted; tested[i].pAdjusted = pValue(adjusted); });
	for (const row of rows) {
		if (!row.before || !row.after) continue;
		row.change = row.delta === null ? 'no valid runs' : row.rawAdjusted < 0.05 ? (row.delta > 0 ? 'better' : 'worse') : row.delta === 0 ? 'same' : 'within noise';
		delete row.rawP; delete row.rawAdjusted;
	}
	return rows;
}

/**
 * One exact test over a set of rooms, each room its own stratum (stats.mjs stratifiedExactTest): is the current jar
 * better (pBetter) or worse (pWorse), one-sided, over all of them together? A small gain repeated in every room adds up
 * here although no single room shows it. Rooms without valid runs on both sides are left out.
 */
export function pooledTest(rows, rooms = null) {
	const wanted = rooms ? new Set(rooms) : null;
	const used = rows.filter(row => row.before && row.after && row.delta !== null && row.delta !== undefined && (!wanted || wanted.has(row.room)));
	const test = stratifiedExactTest(used.map(row => ({ k1: row.after.pass, n1: row.after.pass + row.after.fail, k0: row.before.pass, n0: row.before.pass + row.before.fail })));
	const total = side => used.reduce((sum, row) => ({ pass: sum.pass + row[side].pass, valid: sum.valid + row[side].pass + row[side].fail }), { pass: 0, valid: 0 });
	return { rooms: used.map(row => row.room), before: total('before'), after: total('after'), pBetter: pValue(test.pUpper), pWorse: pValue(test.pLower) };
}
// Four decimals, or two significant digits below 0.0001, so a very small p never reads as 0.
const pValue = p => p >= 0.0001 ? +p.toFixed(4) : +p.toPrecision(2);
// For print: stratifiedExactTest adds a 1e-12 tolerance to its tails, so anything that small is only "under 1e-11".
const showP = p => p < 1e-11 ? '< 1e-11' : String(p);

/**
 * The A/B question as two pooled tests: are the declared target rooms better (target.pBetter), and are the other rooms,
 * the guards, worse (guard.pWorse)? Without targets every room is a guard, and the one pooled test answers both ways.
 * A declared target that did not enter its pool (unknown, not run on a side, or no valid runs) is listed in
 * missingTargets, never dropped silently.
 */
export function compareGroups(rows, { targets = [] } = {}) {
	const names = new Set(rows.map(row => row.room));
	const declared = [...new Set(targets)];
	const target = declared.length ? pooledTest(rows, declared) : null;
	const guard = pooledTest(rows, [...names].filter(room => !declared.includes(room)));
	return { target, guard, missingTargets: declared.filter(room => !target.rooms.includes(room)) };
}
const pick = score => ({ pass: score.pass, fail: score.fail, invalid: score.invalid, lost: score.lost, passRate: score.passRate, deaths: score.deaths, damage: score.damage, medianSeconds: score.medianSeconds });

const pct = rate => rate === null || rate === undefined ? '-' : `${Math.round(rate * 100)}%`;
const secs = value => value === null || value === undefined ? '-' : value >= 120 ? `${(value / 60).toFixed(1)}m` : `${Math.round(value)}s`;
const pooledLine = (label, test) => `${label}: ${test.before.pass}/${test.before.valid} -> ${test.after.pass}/${test.after.valid} over ${test.rooms.length} rooms; `
	+ (test.rooms.length ? `pooled exact test p(better) ${showP(test.pBetter)}, p(worse) ${showP(test.pWorse)}` : 'no test (no room with valid runs on both sides)');
export function formatComparison(rows, { targets = [] } = {}) {
	const lines = ['room | before | after | change | deaths before -> after'];
	const order = { worse: 0, better: 1, 'within noise': 2, 'no valid runs': 3, 'new room': 4, 'not run': 5, same: 6 };
	for (const row of [...rows].sort((a, b) => (order[a.change] ?? 9) - (order[b.change] ?? 9) || a.room.localeCompare(b.room))) {
		if (!row.before || !row.after) { lines.push(`${row.room} | ${row.before ? `${row.before.pass}/${row.before.pass + row.before.fail}` : '-'} | ${row.after ? `${row.after.pass}/${row.after.pass + row.after.fail}` : '-'} | ${row.change} |`); continue; }
		const p = row.pAdjusted === undefined ? '' : row.change === 'better' || row.change === 'worse' || row.p < 0.05 ? ` (p=${showP(row.p)}, Holm ${showP(row.pAdjusted)})` : '';
		lines.push(`${row.room} | ${row.before.pass}/${row.before.pass + row.before.fail} (${pct(row.before.passRate)}) | ${row.after.pass}/${row.after.pass + row.after.fail} (${pct(row.after.passRate)}) | ${row.change}${p} | ${row.before.deaths ?? '?'} -> ${row.after.deaths ?? '?'}`);
	}
	const count = change => rows.filter(row => row.change === change).length;
	lines.push(`${count('better')} better, ${count('worse')} worse (Fisher p, Holm-adjusted over ${rows.filter(row => row.pAdjusted !== undefined).length} rooms, < 0.05), ${count('within noise') + count('same')} unchanged within noise, ${count('no valid runs')} without valid runs, ${count('new room')} new, ${count('not run')} not run`);
	const groups = compareGroups(rows, { targets });
	if (groups.target) lines.push(pooledLine('target rooms', groups.target));
	lines.push(pooledLine(groups.target ? 'guard rooms' : 'all rooms', groups.guard));
	if (groups.missingTargets.length) lines.push(`targets left out of the pool (unknown, not run on a side, or no valid runs): ${groups.missingTargets.join(', ')}`);
	return lines.join('\n');
}

/** A markdown scoreboard: totals per stage and skill, then one table per stage. */
export function formatScoreboard(score) {
	const lines = [];
	const head = '| room | skill | pass | rate | deaths | damage | median time | invalid/lost | top failure reasons |';
	const sep = '|---|---|---|---|---|---|---|---|---|';
	lines.push('| stage | rooms | runs | pass rate | runs with a death |', '|---|---|---|---|---|');
	for (const stage of [...STAGES, ...Object.keys(score.groups.stage).filter(key => !STAGES.includes(key))]) {
		const group = score.groups.stage[stage];
		if (group) lines.push(`| ${stage} | ${group.rooms} | ${group.pass + group.fail} | ${group.pass}/${group.pass + group.fail} (${pct(group.passRate)}) | ${group.runsWithDeath} |`);
	}
	lines.push('', '| skill | rooms | runs | pass rate | runs with a death |', '|---|---|---|---|---|');
	for (const skill of [...SKILLS, ...Object.keys(score.groups.skill).filter(key => !SKILLS.includes(key))]) {
		const group = score.groups.skill[skill];
		if (group) lines.push(`| ${skill} | ${group.rooms} | ${group.pass + group.fail} | ${group.pass}/${group.pass + group.fail} (${pct(group.passRate)}) | ${group.runsWithDeath} |`);
	}
	const stages = [...STAGES, ...new Set(Object.values(score.rooms).map(room => room.stage).filter(stage => !STAGES.includes(stage)))];
	for (const stage of stages) {
		const entries = Object.entries(score.rooms).filter(([, room]) => (room.stage ?? null) === stage);
		if (!entries.length) continue;
		lines.push('', `### ${stage ?? 'unstaged'}`, '', head, sep);
		for (const [name, room] of entries.sort(([, a], [, b]) => (a.passRate ?? 2) - (b.passRate ?? 2))) {
			const reasons = room.topReasons.map(item => `${item.reason.replace(/\|/g, '/')} (${item.n})`).join('; ');
			lines.push(`| ${name} | ${room.skill ?? '-'}${room.skill2 ? `, ${room.skill2}` : ''} | ${room.pass}/${room.pass + room.fail} | ${pct(room.passRate)} | ${room.deaths ?? (room.exitOnly ? 'n/r' : '?')} | ${room.damage ?? (room.exitOnly ? 'n/r' : '?')} | ${secs(room.medianSeconds)} | ${room.invalid}/${room.lost} | ${reasons || '-'} |`);
		}
	}
	return lines.join('\n');
}
