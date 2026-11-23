#!/usr/bin/env node
// Per-room comparison of an AI-room batch (room-batch.mjs --player model):
//   node scripts/quality/ai-room-report.mjs BATCH_OUT [--json FILE]
// Reads each room's arm folders (OUT/rooms/ROOM/ARM/) and done.json, groups the repeats of a room (NAME-rN), and
// prints per room and arm: valid runs, pass rate over valid runs, deaths, damage
// taken (HP), median minutes, and for the model arm median and total model calls. Minutes are the model's play time
// for the ai arm (goal start to end) and the arm's whole run (boot included) for the script arm, whose fixtures time
// play differently. INVALID runs count apart and never enter a rate.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roomVerdict } from './lib/fixture-run.mjs';
import { readArmRows } from './lib/standin-rows.mjs';
import { armRows } from './lib/room-batch-core.mjs';

export { readArmRows };

const median = values => {
	const sorted = values.filter(Number.isFinite).sort((a, b) => a - b);
	if (!sorted.length) return null;
	const mid = Math.floor(sorted.length / 2);
	return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
};
const total = values => values.every(Number.isFinite) ? values.reduce((a, b) => a + b, 0) : null;
const baseRoom = name => String(name).replace(/-r\d+$/, '');
const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
export function compareArms({ arms, done }) {
	const rooms = new Map();
	for (const [arm, rows] of Object.entries(arms)) for (const row of rows) {
		const label = row.room ?? row.name, room = baseRoom(label);
		const entry = rooms.get(room) ?? {};
		(entry[arm] ??= []).push({ ...row, label, verdict: roomVerdict(row).verdict, armSeconds: row.armSeconds ?? done[label]?.arms?.[arm]?.seconds ?? null });
		rooms.set(room, entry);
	}
	return [...rooms].map(([room, byArm]) => ({ room, arms: Object.fromEntries(Object.entries(byArm).map(([arm, runs]) => {
		const valid = runs.filter(run => run.verdict === 'PASS' || run.verdict === 'FAIL');
		const passed = valid.filter(run => run.verdict === 'PASS').length;
		const minutes = runs.map(run => Number.isFinite(run.playMinutes) ? run.playMinutes : Number.isFinite(run.minutes) ? run.minutes : Number.isFinite(run.armSeconds) ? run.armSeconds / 60 : null);
		return [arm, { runs: runs.length, valid: valid.length, passed, invalid: runs.length - valid.length, passRate: valid.length ? passed / valid.length : null,
			deaths: total(valid.map(run => run.deaths)), damage: total(valid.map(run => run.damageTaken)), medianMinutes: median(minutes),
			medianModelCalls: median(runs.map(run => run.modelCalls)), modelCalls: runs.some(run => Number.isFinite(run.modelCalls)) ? total(runs.map(run => run.modelCalls ?? 0)) : null,
			invalidReasons: runs.filter(run => run.verdict === 'INVALID').map(run => `${run.label}: ${roomVerdict(run).reason}`) }];
	})) }));
}

export function formatComparison(rooms, arms) {
	const n = (value, digits = 1) => value === null || value === undefined ? '?' : Number(value).toFixed(digits).replace(/\.0+$/, '');
	const lines = ['| room | ' + arms.map(arm => `${arm} pass | ${arm} deaths | ${arm} damage | ${arm} min`).join(' | ') + ' | model calls (median) |',
		'|---|' + arms.map(() => '---|---|---|---').join('|') + '|---|'];
	for (const { room, arms: byArm } of rooms) {
		const cells = arms.map(arm => {
			const a = byArm[arm];
			if (!a) return '- | - | - | -';
			return `${a.passed}/${a.valid}${a.invalid ? ` (+${a.invalid} invalid)` : ''} | ${n(a.deaths, 0)} | ${n(a.damage)} | ${n(a.medianMinutes)}`;
		});
		lines.push(`| ${room} | ${cells.join(' | ')} | ${n(byArm.ai?.medianModelCalls, 0)} |`);
	}
	const invalid = rooms.flatMap(room => Object.entries(room.arms).flatMap(([arm, a]) => a.invalidReasons.map(reason => `- ${arm} ${reason}`)));
	return lines.join('\n') + (invalid.length ? `\n\nInvalid runs:\n${invalid.join('\n')}` : '') + '\n';
}

/**
 * One arm's rows, judged the way the batch merge judges them (mergeArms): a finishRun rows file needs its summary and
 * a summary that plans rows; otherwise the rows are INVALID. Each missing row is one more INVALID row. A summary that
 * reads INVALID voids the arm only when it wrote no rows: otherwise each row keeps its own verdict, so one errored
 * course never voids the courses beside it. An arm with no finishRun rows at all (a stand-in recorded before
 * ai-room-standin.mjs, which wrote only its own report) falls back to that report, read by readArmRows.
 */
export async function roomArmRows(dir) {
	const found = await armRows(dir);
	if (!found.file && !found.problem) return readArmRows(dir);
	const own = found.summary, ownValid = Boolean(own && typeof own === 'object' && Number.isInteger(own.planned));
	const problem = found.problem ?? (!ownValid ? 'missing or corrupt room summary' : own.status === 'INVALID' && !found.rows.length ? 'room summary INVALID' : own.planned <= 0 ? 'room planned 0 rows' : null);
	// A fixture's own named pair (acceptance.json from drawn-bow) holds the verdict; its report holds the damage.
	const adapted = found.file !== 'result.json' ? await readArmRows(dir).catch(() => []) : [];
	const merged = adapted.length === found.rows.length ? found.rows.map((row, i) => ({ ...adapted[i], ...row, deaths: row.deaths ?? adapted[i].deaths, damageTaken: row.damageTaken ?? adapted[i].damageTaken })) : found.rows;
	const rows = merged.map(row => problem ? { ...row, integrity: [...(Array.isArray(row.integrity) ? row.integrity : []), { file: 'summary', error: problem }] } : row);
	const planned = ownValid ? own.planned : Math.max(rows.length, 1);
	for (let i = rows.length; i < planned; i++) rows.push({ pass: false, error: `planned row ${i + 1} of ${planned} missing${problem ? ` (${problem})` : ''}`, deaths: null, damageTaken: null });
	return rows;
}

/**
 * Every planned arm of every planned room in one batch folder as rows. The plan is batch.json's rooms and arms, so a room
 * that was lost, or never started because the batch stopped, is an INVALID row (with the batch's reason) instead of
 * dropping out of the rate: 4 passes and 1 lost read 4/4 (+1 invalid), not 4/4. Without batch.json (the batch never
 * finished) the plan is unknown, so the rows found are kept and a warning says the inventory may be short.
 */
export async function readBatchArms(out) {
	const batch = await readJson(path.join(out, 'batch.json')).catch(() => null);
	const found = (await readdir(path.join(out, 'rooms')).catch(() => [])).filter(name => !name.startsWith('.')).sort();
	const planned = Array.isArray(batch?.rooms) ? batch.rooms : found;
	const armNames = Array.isArray(batch?.arms) ? batch.arms.map(arm => arm.name).filter(name => ['ai', 'script'].includes(name)) : ['ai', 'script'];
	const outcomes = new Map((batch?.outcomes ?? []).filter(Boolean).map(outcome => [outcome.room, outcome]));
	const arms = {}, warnings = batch ? [] : [`${out}: no batch.json, so rooms the batch lost or never started are not counted`];
	for (const room of planned) {
		const done = await readJson(path.join(out, 'rooms', room, 'done.json')).catch(() => null), outcome = outcomes.get(room);
		for (const arm of armNames) {
			const run = done?.arms?.[arm];
			if (!run) {
				if (!batch && !done) continue;
				const reason = outcome?.lost ? `lost: ${outcome.reason ?? 'no reason recorded'}` : done ? 'the arm did not run' : 'never started';
				(arms[arm] ??= []).push({ room, pass: false, error: reason, deaths: null, damageTaken: null });
				continue;
			}
			const killed = run.timedOut ? 'room timeout' : run.signal ? `signal ${run.signal}` : run.error ? `launch error: ${run.error}` : null;
			const rows = await roomArmRows(path.join(out, 'rooms', room, arm));
			(arms[arm] ??= []).push(...(rows.length ? rows : [{ pass: false, error: 'no result rows' }]).map(row => ({ ...row, room, armSeconds: run.seconds ?? null,
				...(killed ? { integrity: [...(row.integrity ?? []), { file: 'arm', error: `killed (${killed})` }] } : {}) })));
		}
	}
	return { arms, warnings };
}

async function main(argv) {
	const jsonAt = argv.indexOf('--json'), json = jsonAt >= 0 ? argv[jsonAt + 1] : null;
	const dirs = argv.filter((arg, i) => jsonAt < 0 || (i !== jsonAt && i !== jsonAt + 1));
	if (!dirs.length || dirs[0] === '--help') { console.log('Usage: ai-room-report.mjs BATCH_OUT [BATCH_OUT ...] [--json FILE]  (several batches of the same rooms pool their repeats)'); return; }
	const arms = {}, warnings = [];
	for (const dir of dirs) {
		const batch = await readBatchArms(path.resolve(dir));
		for (const [arm, rows] of Object.entries(batch.arms)) (arms[arm] ??= []).push(...rows);
		warnings.push(...batch.warnings);
	}
	const rooms = compareArms({ arms, done: {} });
	console.log(formatComparison(rooms, Object.keys(arms)));
	for (const warning of warnings) console.log(`warning: ${warning}`);
	if (json) await writeFile(json, JSON.stringify(rooms, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
