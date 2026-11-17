#!/usr/bin/env node
// Gate report: turns saved gate run folders into one JSON per gate, so every PR can show the product funnel without
// running a game. Each run gives its commit, seed, the minutes to each milestone, deaths, cost, and model or scripted.
//
//   node scripts/quality/gate-report.mjs --gate 3 --title "..." --out docs/gates/gate-3.json \
//     --cohort gate3 "#178 merged into main" DIR... [--cohort NAME LABEL DIR...]
//
// A DIR is a long-run folder (sub/long/<tag>-codex: stage-score.json, long-run.json, raw/decision-*.jsonl) or a
// scripted obtain folder (sub/farm/<round>/<seed>-r<n>: run/result.json, with plan.json one level up).
// Two cohorts on the same seeds make a pair (before and after); the same seed run more than once in one cohort is a
// repeat. Both are reported, and so is every seed that lacks its pair. Rule of thumb: under 2 seeds is "no change".
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

export const SCHEMA = 'arena-gate-report/v1';
// Funnel order. null in a run = not reached in its window; a missing key = this kind of run does not measure it.
export const MILESTONES = [
	{ key: 'ironPickaxe', label: 'Iron pickaxe' },
	{ key: 'bucket', label: 'Bucket' },
	{ key: 'flintAndSteel', label: 'Flint and steel' },
	{ key: 'lavaSeen', label: 'Lava seen' },
	{ key: 'portalLit', label: 'Portal lit' },
	{ key: 'nether', label: 'Nether' },
];
// Rule of thumb (scripts/quality/README.md): a difference under this many seeds is "no change".
export const NO_CHANGE_SEEDS = 2;

const STAGE_KEYS = { ironPickaxe: 'iron_pickaxe', bucket: 'bucket', flintAndSteel: 'flint_and_steel', nether: 'nether' };
const BOUNDARY = '\nNewer coordinator events for this turn (treat them exactly like the turn input):\n';
// Lava the model was shown: the body's lavaSeen cells, a known-lava fact, a cave flagged for lava, or a counted pool.
// Contract text names lava too, but never in these shapes.
const LAVA = /lavaSeen\\*":\[\\*"|lava: lava \d|lava seen nearby|lava pools seen [1-9]/;
const minutes = (ms) => Math.round(ms / 6000) / 10;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
const median = (values) => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
	return Math.round((sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2) * 10) / 10;
};

export function decisionFiles(raw) {
	if (!existsSync(raw)) return [];
	return readdirSync(raw).filter((name) => name.startsWith('decision-') && !name.includes('goal-spec'))
		.sort((a, b) => (b.endsWith('.1') - a.endsWith('.1')) || a.localeCompare(b)).map((name) => path.join(raw, name));
}

/** First lava shown to the model and first PORTAL_LIT result, in ms since the epoch, from the decision log. */
function logMilestones(raw) {
	let lavaSeen = null, portalLit = null;
	for (const file of decisionFiles(raw)) {
		for (const line of readFileSync(file, 'utf8').split('\n')) {
			if (!line) continue;
			if (lavaSeen === null && LAVA.test(line)) lavaSeen = JSON.parse(line).time ?? null;
			if (portalLit === null && line.includes('PORTAL_LIT')) {
				// Contract text in every prompt names PORTAL_LIT; only a result's own reason code counts.
				const record = JSON.parse(line);
				let code = record.type === 'action_result' ? record.result?.reasonCode : null;
				if (record.type === 'tool_result') {
					const text = typeof record.result === 'string' ? record.result : JSON.stringify(record.result);
					try { code = JSON.parse(text.split(BOUNDARY)[0]).reasonCode; } catch { code = null; }
				}
				if (code === 'PORTAL_LIT') portalLit = record.time;
			}
		}
	}
	return { lavaSeen, portalLit };
}

function longRunCommit(dir, longRun) {
	const log = `${dir.replace(/\/+$/, '')}.log`;
	if (existsSync(log)) {
		const found = /\/roots\/([0-9a-f]{40})\//.exec(readFileSync(log, 'utf8'));
		if (found) return found[1];
	}
	return /-([0-9a-f]{7,40})\.jar$/.exec(longRun?.build?.jar?.path ?? '')?.[1] ?? null;
}

function readLongRun(dir) {
	const stage = readJson(path.join(dir, 'stage-score.json'));
	const longRun = existsSync(path.join(dir, 'long-run.json')) ? readJson(path.join(dir, 'long-run.json')) : null;
	const t0 = stage.window.startedAt;
	const lives = [stage.firstLife, stage.afterDeath].filter((life) => life?.milestones);
	const at = (name) => {
		const times = lives.map((life) => life.milestones[name]?.firstObservedAt).filter(Number.isFinite);
		return times.length ? Math.min(...times) : null;
	};
	const raw = path.join(dir, 'raw');
	const log = logMilestones(raw);
	const ms = Object.fromEntries(Object.entries(STAGE_KEYS).map(([key, name]) => [key, at(name)]));
	ms.lavaSeen = log.lavaSeen;
	// Entering the Nether needs a lit portal, so a Nether entry with no PORTAL_LIT result bounds it from above.
	ms.portalLit = log.portalLit ?? ms.nether;
	const profile = longRun?.profile ?? stage.identity?.profile;
	return [{
		run: path.basename(dir), seed: String(stage.identity?.seed ?? longRun?.seed), commit: longRunCommit(dir, longRun),
		ranAt: new Date(stage.window.startedAt).toISOString().slice(0, 10), mode: 'model', model: profile ? `${profile.provider} ${profile.model} ${profile.reasoningEffort ?? ''}`.trim() : null,
		windowMin: minutes(longRun?.windowMs ?? stage.window.windowMs),
		milestones: Object.fromEntries(MILESTONES.map(({ key }) => [key, ms[key] === null ? null : minutes(ms[key] - t0)])),
		deaths: stage.observedDeaths ?? 0, costUsd: Math.round((longRun?.spend?.usd ?? 0) * 1000) / 1000,
		decisionLog: decisionFiles(raw).length > 0,
	}];
}

const SCRIPTED_KEYS = { iron_pickaxe: 'ironPickaxe', bucket: 'bucket', flint_and_steel: 'flintAndSteel' };
function readScripted(dir) {
	const plan = path.join(dir, '..', 'plan.json');
	const commit = existsSync(plan) ? readJson(plan).rootSha ?? null : null;
	return readJson(path.join(dir, 'run', 'result.json')).map((row) => {
		const key = SCRIPTED_KEYS[row.item];
		if (!key) throw new Error(`${dir}: scripted item ${row.item} has no funnel milestone`);
		return { run: path.basename(dir), seed: String(row.seed), commit, ranAt: null, mode: 'scripted', model: null, windowMin: minutes(row.budgetMs),
			milestones: { [key]: row.pass ? minutes(row.seconds * 1000) : null }, deaths: row.deaths ?? 0, costUsd: 0, decisionLog: false };
	});
}

export function readRun(dir) {
	if (existsSync(path.join(dir, 'stage-score.json'))) return readLongRun(dir);
	if (existsSync(path.join(dir, 'run', 'result.json'))) return readScripted(dir);
	throw new Error(`${dir}: neither stage-score.json nor run/result.json`);
}

const one = (values) => { const set = [...new Set(values)]; return set.length === 1 ? set[0] : set.length ? set : null; };

/**
 * Per milestone, over seeds (a repeated seed counts once: reached if any of its runs reached it; its time is the median
 * of its runs that did). Repeats are reported separately, so a seed run twice cannot double its weight here.
 */
export function funnel(runs) {
	const seeds = [...new Set(runs.map((run) => run.seed))];
	const out = {};
	for (const { key } of MILESTONES) {
		const measured = seeds.filter((seed) => runs.some((run) => run.seed === seed && key in run.milestones));
		if (measured.length === 0) continue;
		const times = measured.map((seed) => median(runs.filter((run) => run.seed === seed && run.milestones[key] !== null && key in run.milestones).map((run) => run.milestones[key]))).filter((value) => value !== null);
		const tried = runs.filter((run) => key in run.milestones);
		out[key] = { reached: times.length, total: measured.length, medianMin: median(times), runs: { reached: tried.filter((run) => run.milestones[key] !== null).length, total: tried.length } };
	}
	return out;
}

export function repeatsOf(runs) {
	const out = [];
	for (const seed of [...new Set(runs.map((run) => run.seed))]) {
		const same = runs.filter((run) => run.seed === seed);
		if (same.length < 2) continue;
		const keys = MILESTONES.map(({ key }) => key).filter((key) => same.every((run) => key in run.milestones));
		const flipped = keys.filter((key) => new Set(same.map((run) => run.milestones[key] !== null)).size > 1);
		out.push({ seed, runs: same.length, flipped, minutes: Object.fromEntries(keys.map((key) => [key, same.map((run) => run.milestones[key])])) });
	}
	return out;
}

export const verdict = (diff) => Math.abs(diff) < NO_CHANGE_SEEDS ? 'no change' : diff > 0 ? 'better' : 'worse';

// A seed's first run only: a cohort that ran each seed twice would otherwise get two chances against one.
const firstRuns = (runs) => runs.filter((run, i) => runs.findIndex((other) => other.seed === run.seed) === i);

/**
 * Before → after on the seeds both cohorts ran, one run per seed on each side (its first); repeats are reported apart.
 * Seeds only one side ran are named as missing pairs.
 */
export function compare(before, after) {
	const seedsA = new Set(before.runs.map((run) => run.seed)), seedsB = new Set(after.runs.map((run) => run.seed));
	const paired = [...seedsA].filter((seed) => seedsB.has(seed));
	const missingPairs = [...[...seedsA].filter((seed) => !seedsB.has(seed)).map((seed) => ({ seed, only: before.name })),
		...[...seedsB].filter((seed) => !seedsA.has(seed)).map((seed) => ({ seed, only: after.name }))];
	const a = funnel(firstRuns(before.runs).filter((run) => paired.includes(run.seed))), b = funnel(firstRuns(after.runs).filter((run) => paired.includes(run.seed)));
	const milestones = {};
	for (const { key } of MILESTONES) {
		if (!a[key] || !b[key]) continue;
		const diff = b[key].reached - a[key].reached;
		milestones[key] = { before: a[key].reached, after: b[key].reached, total: paired.length, diff, verdict: verdict(diff), beforeMedianMin: a[key].medianMin, afterMedianMin: b[key].medianMin };
	}
	return { before: before.name, after: after.name, pairedSeeds: paired.length, missingPairs, milestones };
}

export function buildGate({ gate, title, cohorts }) {
	const built = cohorts.map(({ name, label, dirs }) => {
		const runs = dirs.flatMap(readRun);
		return { name, label, commit: one(runs.map((run) => run.commit)), mode: one(runs.map((run) => run.mode)), model: one(runs.map((run) => run.model)),
			windowMin: one(runs.map((run) => run.windowMin)), ranAt: runs.map((run) => run.ranAt).filter(Boolean).sort()[0] ?? null, seeds: [...new Set(runs.map((run) => run.seed))], runs,
			funnel: funnel(runs), deaths: runs.reduce((sum, run) => sum + run.deaths, 0),
			costUsd: Math.round(runs.reduce((sum, run) => sum + run.costUsd, 0) * 100) / 100, repeats: repeatsOf(runs) };
	});
	const notes = [];
	const comparisons = [];
	for (let i = 1; i < built.length; i++) comparisons.push(compare(built[i - 1], built[i]));
	if (built.length === 1) notes.push('No pair in this file: one commit ran this gate. The PR comment pairs it with the previous gate when both ran the same seeds with the same model and window.');
	for (const comparison of comparisons) if (comparison.missingPairs.length) notes.push(`${comparison.before} → ${comparison.after}: ${comparison.missingPairs.length} seed(s) without a pair.`);
	if (!built.some((cohort) => cohort.repeats.length)) notes.push('No repeats: each seed ran once per commit, so run-to-run noise is not measured here.');
	return { schema: SCHEMA, gate, title, generatedBy: 'scripts/quality/gate-report.mjs', rule: `A difference under ${NO_CHANGE_SEEDS} seeds is "no change" (rule of thumb).`,
		milestones: MILESTONES, cohorts: built, comparisons, notes };
}

export function parseCli(argv) {
	const options = { cohorts: [] };
	for (let i = 0; i < argv.length; i++) {
		const arg = argv[i];
		if (arg === '--gate') options.gate = argv[++i];
		else if (arg === '--title') options.title = argv[++i];
		else if (arg === '--out') options.out = argv[++i];
		else if (arg === '--cohort') options.cohorts.push({ name: argv[++i], label: argv[++i], dirs: [] });
		else if (options.cohorts.length) options.cohorts.at(-1).dirs.push(arg);
		else throw new Error(`Unexpected argument ${arg}`);
	}
	if (!options.gate || !options.cohorts.length || options.cohorts.some((cohort) => !cohort.dirs.length)) {
		throw new Error('Usage: --gate N [--title T] [--out FILE] --cohort NAME LABEL DIR... [--cohort NAME LABEL DIR...]');
	}
	options.gate = /^\d+$/.test(options.gate) ? Number(options.gate) : options.gate;
	return options;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
	const options = parseCli(process.argv.slice(2));
	const report = buildGate(options);
	const text = JSON.stringify(report, null, 1) + '\n';
	if (options.out) writeFileSync(options.out, text); else process.stdout.write(text);
	for (const cohort of report.cohorts) {
		console.error(`${cohort.name} @ ${String(cohort.commit).slice(0, 8)}: ${cohort.seeds.length} seeds, ${cohort.runs.length} runs, deaths ${cohort.deaths}, $${cohort.costUsd}`);
		for (const { key, label } of MILESTONES) if (cohort.funnel[key]) console.error(`  ${label.padEnd(16)} ${cohort.funnel[key].reached}/${cohort.funnel[key].total}  median ${cohort.funnel[key].medianMin ?? '-'} min`);
	}
}
