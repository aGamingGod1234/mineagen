#!/usr/bin/env node
// Per-room comparison of an AI-room batch (room-batch.mjs --player model):
//   node scripts/quality/ai-room-report.mjs BATCH_OUT [--json FILE]
// Reads each arm's merged rows (OUT/ai/result.json, OUT/script/result.json) and each room's done.json, groups the
// repeats of a room (NAME-rN), and prints per room and arm: valid runs, pass rate over valid runs, deaths, damage
// taken (HP), median minutes, and for the model arm median and total model calls. Minutes are the model's play time
// for the ai arm (goal start to end) and the arm's whole run (boot included) for the script arm, whose fixtures time
// play differently. INVALID runs count apart and never enter a rate.
import { readFile, readdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { roomVerdict } from './lib/fixture-run.mjs';

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
		(entry[arm] ??= []).push({ ...row, label, verdict: roomVerdict(row).verdict, armSeconds: done[label]?.arms?.[arm]?.seconds ?? null });
		rooms.set(room, entry);
	}
	return [...rooms].map(([room, byArm]) => ({ room, arms: Object.fromEntries(Object.entries(byArm).map(([arm, runs]) => {
		const valid = runs.filter(run => run.verdict === 'PASS' || run.verdict === 'FAIL');
		const passed = valid.filter(run => run.verdict === 'PASS').length;
		const minutes = runs.map(run => Number.isFinite(run.playMinutes) ? run.playMinutes : Number.isFinite(run.armSeconds) ? run.armSeconds / 60 : null);
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

async function main([dir, ...rest]) {
	if (!dir || dir === '--help') { console.log('Usage: ai-room-report.mjs BATCH_OUT [--json FILE]'); return; }
	const out = path.resolve(dir), arms = {};
	for (const arm of ['ai', 'script']) arms[arm] = await readJson(path.join(out, arm, 'result.json')).catch(() => null);
	for (const arm of Object.keys(arms)) if (!Array.isArray(arms[arm])) delete arms[arm];
	const done = {};
	for (const room of await readdir(path.join(out, 'rooms')).catch(() => [])) done[room] = await readJson(path.join(out, 'rooms', room, 'done.json')).catch(() => null);
	const rooms = compareArms({ arms, done });
	console.log(formatComparison(rooms, Object.keys(arms)));
	const json = rest[0] === '--json' ? rest[1] : null;
	if (json) await writeFile(json, JSON.stringify(rooms, null, 2) + '\n');
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 1; });
