#!/usr/bin/env node
// Reflex-room round report: total damage over each room's own window, deaths and room success per run, damage
// reconciled with the vanilla counter, and (for paired arms) per-pair deltas summed by room and judged against a margin
// set in advance from an A/A run. Damage per threat-minute, onsets, response paths and firings are diagnostics only.
// See scripts/quality/README.md ("Reflex round report").
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { findWatchDirs, readWatchDir } from './watch-files.mjs';
import { epoch, resolveGoalWindow } from '../../coordinator/src/benchmark/quality-metrics.mjs';
import { judgeRooms, noiseFloor, pairRuns, scoreRun } from './lib/reflex-round.mjs';

const USAGE = 'node scripts/quality/reflex-round-report.mjs (--run RUN_DIR|results.json ... | --paired PAIRED_RESULTS.json) [--margin MARGIN.json] [--out REPORT.json]';

export function parseReportArgs(argv) {
	const options = { runs: [], paired: null, margin: null, out: null };
	for (let i = 0; i < argv.length; i++) {
		const flag = argv[i], value = argv[i + 1];
		if (flag === '--help') return { help: true };
		if (!['--run', '--paired', '--margin', '--out'].includes(flag) || !value || value.startsWith('--')) throw new Error(`Invalid argument ${flag}; ${USAGE}`);
		i++;
		if (flag === '--run') options.runs.push(path.resolve(value));
		else options[flag.slice(2)] = path.resolve(value);
	}
	if (!options.runs.length === !options.paired) throw new Error(`Pass --run or --paired; ${USAGE}`);
	return options;
}

const readJson = async file => JSON.parse(await readFile(file, 'utf8'));
const maybeJson = async file => { try { return await readJson(file); } catch (error) { if (error.code === 'ENOENT') return null; throw error; } };
const maybeJsonl = async file => { try { return (await readFile(file, 'utf8')).split('\n').filter(line => line.trim()).flatMap(line => { try { return [JSON.parse(line)]; } catch { return []; } }); } catch (error) { if (error.code === 'ENOENT') return []; throw error; } };

/** The run record's goal start; runs recorded before it was stored fall back to the protocol journal's goal start. */
async function goalStart(record, directory) {
	if (Number.isFinite(record.goalStartedAtMs)) return record.goalStartedAtMs;
	return directory ? resolveGoalWindow(await maybeJsonl(path.join(directory, 'quality-protocol.jsonl'))).startedAt : null;
}

/** The run's goal_control lifecycle (start, dead, respawn) from its protocol journal: the sampler pauses while dead. */
async function lifecycle(directory) {
	if (!directory) return [];
	return (await maybeJsonl(path.join(directory, 'quality-protocol.jsonl'))).map(row => ({ row, event: row.envelope ?? row }))
		.filter(({ event }) => event.type === 'goal_control' && ['start', 'dead', 'respawn'].includes(event.payload?.operation))
		.map(({ row, event }) => ({ operation: event.payload.operation, at: event.payload.updatedAtEpochMs ?? epoch(row) }))
		.filter(event => Number.isFinite(event.at));
}

/** One run's inputs from its artifact directory: quality-run.json, quality-samples.json and the arena-watch danger rows. */
export async function loadRun(run) {
	const directory = run.artifacts;
	const record = run.metrics || run.goalStartedAtMs !== undefined || !directory ? run : { ...run, ...(await maybeJson(path.join(directory, 'quality-run.json')) ?? {}) };
	const samples = directory ? (await maybeJson(path.join(directory, 'quality-samples.json')))?.samples ?? [] : [];
	let dangerRows = null, dangerDropped = 0;
	for (const watchDir of directory ? await findWatchDirs(directory) : []) {
		const watch = await readWatchDir(watchDir);
		if (watch.dangerFiles) dangerRows = [...(dangerRows ?? []), ...watch.danger];
		dangerDropped += watch.dangerDropped ?? 0;
	}
	return { pairId: record.pairId ?? `${record.scenario}-r${record.repetition ?? 1}`, ...scoreRun({ scenario: record.scenario ?? record.definition?.id,
		goalStartedAtMs: await goalStart(record, directory), samples, dangerRows, dangerDropped, lifecycle: await lifecycle(directory), evaluation: record.evaluation ?? null }) };
}

/** --run takes a run artifact directory (holding quality-run.json) or a run-scenarios results.json. */
async function runsFrom(target) {
	if (target.endsWith('.json')) return (await readJson(target)).runs ?? [];
	return [{ ...(await readJson(path.join(target, 'quality-run.json'))), artifacts: target }];
}

export async function buildReport(options) {
	const margin = options.margin ? await readJson(options.margin) : null;
	if (options.paired) {
		const paired = await readJson(options.paired);
		const arms = {};
		for (const arm of ['A', 'B']) arms[arm] = await Promise.all((paired.arms?.[arm]?.runs ?? []).map(loadRun));
		const pairs = pairRuns(arms.A, arms.B);
		const aa = paired.configuration?.design === 'A/A';
		return { report: 'reflex-round', design: aa ? 'A/A' : 'A/B', runs: arms, pairs, judgement: judgeRooms(pairs, margin),
			// From an A/A run, this block is the margin file for later steps (pass it back with --margin).
			noiseFloor: { z: margin?.z ?? 2, ...noiseFloor(pairs) } };
	}
	const runs = [];
	for (const target of options.runs) for (const run of await runsFrom(target)) runs.push(await loadRun(run));
	return { report: 'reflex-round', design: 'single', runs };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
	try {
		const options = parseReportArgs(process.argv.slice(2));
		if (options.help) console.log(USAGE);
		else {
			const report = await buildReport(options);
			const text = JSON.stringify(report, null, 2);
			if (options.out) await writeFile(options.out, text + '\n');
			console.log(text);
		}
	} catch (error) { console.error(error.stack); process.exitCode = 1; }
}
