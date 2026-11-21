#!/usr/bin/env node
// The script arm of an AI room: plays the room's practice-room stand-in unchanged, then makes sure its output holds the
// finishRun rows a room batch merges (result.json and result-summary.json).
//   node scripts/quality/ai-room-standin.mjs OUT_DIR FIXTURE.mjs [FIXTURE ARGS...]
// Most fixtures write those rows themselves and are left alone. Some write only their own report:
// test-travel-live.mjs (results.json, no summary) or test-drawn-bow-live.mjs (acceptance.json, damage per rule arm in
// results.json). For those, lib/standin-rows.mjs reads the report into rows, so the batch's merged results, its
// summary.txt and ai-room-report.mjs all count the same pass, deaths and damage. An arm with no rows at all is one
// INVALID row, never a silent gap. The fixture's own exit code is kept.
import { spawn } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishRun } from './lib/fixture-run.mjs';
import { readArmRows } from './lib/standin-rows.mjs';

/** Writes result.json and result-summary.json from the stand-in's own files when the fixture wrote none. */
export async function normalizeStandIn(out) {
	const file = path.join(out, 'result.json');
	if (await access(file).then(() => true, () => false)) return { wrote: false };
	await mkdir(out, { recursive: true });
	const rows = await readArmRows(out).catch(error => [{ pass: false, error: `stand-in output unreadable: ${error.message}` }]);
	const kept = rows.length ? rows : [{ name: path.basename(out), pass: false, error: 'the stand-in wrote no result rows' }];
	await finishRun(kept, { file, strict: false, setExitCode: false });
	return { wrote: true, rows: kept.length };
}

async function main([out, fixture, ...args]) {
	if (!out || !fixture || out === '--help') { console.log('Usage: ai-room-standin.mjs OUT_DIR FIXTURE.mjs [FIXTURE ARGS...]'); process.exitCode = out === '--help' ? 0 : 2; return; }
	const code = await new Promise(resolve => {
		const child = spawn(process.execPath, [fixture, ...args], { stdio: 'inherit' });
		child.on('error', () => resolve(2));
		child.on('close', (exit, signal) => resolve(exit ?? (signal ? 1 : 2)));
	});
	await normalizeStandIn(path.resolve(out));
	process.exitCode = code;
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main(process.argv.slice(2)).catch(error => { console.error(error.message); process.exitCode = 2; });
