#!/usr/bin/env node
// Gate report: turns saved gate run folders into one JSON per gate, so every PR can show the product funnel without
// running a game. Each run gives its commit, seed, the minutes to each milestone, deaths, cost, and model or scripted.
//
//   node scripts/quality/gate-report.mjs --gate 3 --title "..." --out docs/gates/gate-3.json \
//     --cohort gate3 "#178 merged into main" DIR... [--cohort NAME LABEL DIR...]
//
// A DIR is a long-run folder (sub/long/<tag>-codex: stage-score.json, long-run.json, raw/decision-*.jsonl), a
// scripted obtain folder (sub/farm/<round>/<seed>-r<n>: run/result.json, with plan.json one level up), or a standard
// round: its folder (manifest.json listing games) or one game-N folder (timeline.json, spend.json, raw/manifest.json,
// raw/quality-samples.jsonl). Games with per-second samples also report Nether minutes, deaths and recovery.
// Two cohorts on the same seeds make a pair (before and after); the same seed run more than once in one cohort is a
// repeat. Both are reported, and so is every seed that lacks its pair. Rule of thumb: under 2 seeds is "no change".
import { readFileSync, readdirSync, existsSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { itemCount } from '../../coordinator/src/benchmark/quality-metrics.mjs';
import { netherTravel, sampleObservation } from './nether-travel-metrics.mjs';

export const SCHEMA = 'arena-gate-report/v1';
// Funnel order. null in a run = not reached in its window; a missing key = this kind of run does not measure it.
export const MILESTONES = [
	{ key: 'ironPickaxe', label: 'Iron pickaxe' },
	{ key: 'bucket', label: 'Bucket' },
	{ key: 'flintAndSteel', label: 'Flint and steel' },
	{ key: 'lavaSeen', label: 'Lava seen' },
	{ key: 'portalLit', label: 'Portal lit' },
	{ key: 'nether', label: 'Nether' },
	{ key: 'fortress', label: 'Fortress found' },
	{ key: 'blazeRods', label: 'Blaze rods' },
	{ key: 'enderPearls', label: 'Ender pearls' },
];
// Rule of thumb (scripts/quality/README.md): a difference under this many seeds is "no change".
export const NO_CHANGE_SEEDS = 2;

const STAGE_KEYS = { ironPickaxe: 'iron_pickaxe', bucket: 'bucket', flintAndSteel: 'flint_and_steel', nether: 'nether', fortress: 'fortress', blazeRods: 'blaze_rod', enderPearls: 'ender_pearl' };
const BOUNDARY = '\nNewer coordinator events for this turn (treat them exactly like the turn input):\n';
// Lava the model was shown: the body's lavaSeen cells, a known-lava fact, a cave flagged for lava, or a counted pool.
// Contract text names lava too, but never in these shapes.
const LAVA = /lavaSeen\\*":\[\\*"|lava: lava \d|lava seen nearby|lava pools seen [1-9]/;
const minutes = (ms) => Math.round(ms / 6000) / 10;
const readJson = (file) => JSON.parse(readFileSync(file, 'utf8'));
// Infinity stands for a censored value (never reached); a median that lands on one is unknown, so null.
const median = (values) => {
	if (values.length === 0) return null;
	const sorted = [...values].sort((a, b) => a - b), mid = sorted.length >> 1;
	const value = sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
	return Number.isFinite(value) ? Math.round(value * 10) / 10 : null;
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
	// Folders scored before stage-score tracked a milestone leave its key out: not measured, rather than not reached.
	const ms = Object.fromEntries(Object.entries(STAGE_KEYS).filter(([, name]) => lives.some((life) => name in life.milestones)).map(([key, name]) => [key, at(name)]));
	ms.lavaSeen = log.lavaSeen;
	// Entering the Nether needs a lit portal, so a Nether entry with no PORTAL_LIT result bounds it from above.
	ms.portalLit = log.portalLit ?? ms.nether ?? null;
	const profile = longRun?.profile ?? stage.identity?.profile;
	return [{
		run: path.basename(dir), seed: String(stage.identity?.seed ?? longRun?.seed), commit: longRunCommit(dir, longRun),
		ranAt: new Date(stage.window.startedAt).toISOString().slice(0, 10), mode: 'model', model: profile ? `${profile.provider} ${profile.model} ${profile.reasoningEffort ?? ''}`.trim() : null,
		windowMin: minutes(longRun?.windowMs ?? stage.window.windowMs),
		milestones: Object.fromEntries(MILESTONES.filter(({ key }) => key in ms).map(({ key }) => [key, ms[key] === null ? null : minutes(ms[key] - t0)])),
		deaths: stage.observedDeaths ?? 0, costUsd: Math.round((longRun?.spend?.usd ?? 0) * 1000) / 1000,
		decisionLog: decisionFiles(raw).length > 0,
		...samplesOf(raw, t0, t0 + (longRun?.windowMs ?? stage.window.windowMs)).nether,
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

const BUCKET = /:(water_|lava_)?bucket$/;
/**
 * One pass over raw/quality-samples.jsonl inside [start, end]: the first sample holding any bucket, and the game's Nether
 * numbers. No samples file: neither (a missing nether key means not measured).
 */
function samplesOf(raw, start, end) {
	const file = path.join(raw, 'quality-samples.jsonl');
	if (!existsSync(file)) return { bucketAt: null };
	const travel = netherTravel({ windowStart: start, windowEnd: end });
	let bucketAt = null;
	for (const line of readFileSync(file, 'utf8').split('\n')) {
		if (!line) continue;
		let row; try { row = JSON.parse(line); } catch { continue; }
		if (!Number.isFinite(row.at) || row.at < start || row.at > end) continue;
		if (bucketAt === null && itemCount(`${row.inventoryNbt ?? ''}${row.equipmentNbt ?? ''}`, BUCKET) > 0) bucketAt = row.at;
		travel.observation(sampleObservation(row));
	}
	return { bucketAt, nether: { nether: netherSummary(travel.report(), start) } };
}

/** Per game: Nether minutes, deaths after the first entry, and per Nether death the respawn distance and minutes back. */
function netherSummary(report, start) {
	const { firstEntry, deathsAfterFirstEntry, netherDeaths } = report.recovery;
	const round = (value) => value === null ? null : Math.round(value * 10) / 10;
	return { minutes: round(report.netherMinutes), firstEntryMin: firstEntry ? minutes(firstEntry.atMs - start) : null, deathsAfterFirstEntry,
		deaths: netherDeaths.map((death) => ({ minute: minutes(death.atMs - start), respawnBlocks: death.respawnBlocks === null ? null : Math.round(death.respawnBlocks),
			returned: death.backAtMs !== null, backMin: round(death.backMinutes ?? death.untilEndMinutes) })) };
}

// The standard round's stage names (the round runner's stage list), by funnel key. "buckets" means two buckets, so the
// first bucket comes from the samples; without them the earlier of two buckets and a water bucket bounds it.
const ROUND_STAGES = { ironPickaxe: ['iron pickaxe'], bucket: ['buckets', 'water bucket'], flintAndSteel: ['flint and steel'], lavaSeen: ['lava found'],
	portalLit: ['portal lit'], nether: ['in the Nether'], fortress: ['fortress found'], blazeRods: ['blaze rods'], enderPearls: ['ender pearls'] };
const isRoundGame = (dir) => {
	if (!existsSync(path.join(dir, 'timeline.json'))) return false;
	const timeline = readJson(path.join(dir, 'timeline.json'));
	return Array.isArray(timeline.stageOrder) && Number.isFinite(timeline.startedAt);
};

function readRoundGame(dir) {
	const timeline = readJson(path.join(dir, 'timeline.json'));
	const file = (name) => existsSync(path.join(dir, name)) ? readJson(path.join(dir, name)) : null;
	const manifest = file('raw/manifest.json'), spend = file('spend.json');
	const roundManifest = path.join(dir, '..', 'manifest.json');
	const game = existsSync(roundManifest) ? readJson(roundManifest).games?.find((entry) => entry.id === path.basename(dir)) : null;
	const t0 = timeline.startedAt;
	// Older timelines name no start kind; inherited (snapshot baseline) stages still mark a save point.
	const savePoint = timeline.startKind != null ? timeline.startKind !== 'fresh' : timeline.stages.some((stage) => stage.source === 'snapshot baseline');
	// Some games stopped without a stop time; the timeline's own minute count still gives the end.
	const end = Number.isFinite(timeline.stoppedAt) && timeline.stoppedAt > t0 ? timeline.stoppedAt : t0 + timeline.minute * 60_000;
	const samples = samplesOf(path.join(dir, 'raw'), t0, end);
	const first = (names) => {
		const times = timeline.stages.filter((stage) => names.includes(stage.stage) && stage.source !== 'snapshot baseline').map((stage) => stage.at);
		return times.length ? Math.min(...times) : null;
	};
	const ms = Object.fromEntries(Object.entries(ROUND_STAGES).map(([key, names]) => [key, first(names)]));
	ms.bucket = samples.bucketAt ?? ms.bucket;
	// Entering the Nether needs a lit portal, so a Nether entry bounds it from above.
	if (ms.nether !== null) ms.portalLit = Math.min(ms.portalLit ?? Infinity, ms.nether);
	const profile = manifest ? `${manifest.provider} ${manifest.model} ${manifest.reasoningEffort ?? ''}`.trim() : null;
	return [{
		run: game?.tag ?? path.basename(dir), seed: String(manifest?.world?.seed ?? timeline.spawnCheck?.seed), commit: /-([0-9a-f]{7,40})\.jar$/.exec(game?.jar ?? '')?.[1] ?? null,
		ranAt: new Date(t0).toISOString().slice(0, 10), mode: 'model', model: profile, windowMin: game?.minutes ?? minutes(end - t0), playedMin: minutes(end - t0),
		startKind: timeline.startKind ?? null,
		// A game started from a save point inherits stages (snapshot baseline) and items (a bucket in the first sample):
		// its milestones are not its own, so it measures none.
		...(savePoint ? { milestones: {}, unmeasured: `start ${timeline.startKind ?? 'from a snapshot'}: inherited stages are not this game's` } : {
			milestones: Object.fromEntries(MILESTONES.map(({ key }) => [key, ms[key] === null ? null : minutes(ms[key] - t0)])), ...samples.nether }),
		deaths: timeline.deaths?.length ?? 0, costUsd: Math.round((spend?.usd ?? 0) * 1000) / 1000, decisionLog: false,
	}];
}

export function readRun(dir) {
	if (existsSync(path.join(dir, 'stage-score.json'))) return readLongRun(dir);
	if (existsSync(path.join(dir, 'run', 'result.json'))) return readScripted(dir);
	if (isRoundGame(dir)) return readRoundGame(dir);
	const manifest = path.join(dir, 'manifest.json');
	const games = existsSync(manifest) ? readJson(manifest).games : null;
	if (Array.isArray(games)) {
		const found = games.map((game) => path.join(dir, String(game.id))).filter(isRoundGame);
		if (found.length) return found.flatMap(readRoundGame);
	}
	throw new Error(`${dir}: not a long run (stage-score.json), a scripted run (run/result.json) or a standard round (timeline.json)`);
}

const one = (values) => { const set = [...new Set(values)]; return set.length === 1 ? set[0] : set.length ? set : null; };

/**
 * Kaplan-Meier median minutes over seeds: { t, reached } rows, an unreached one censored at t (the minutes it played).
 * A game that stopped early leaves the risk set at its stop, so it never ranks behind a longer game that reached the
 * milestone. Where the survival curve sits at exactly one half the median is the midpoint to the next reached time (an
 * ordinary median with no censoring); a curve that never falls to one half leaves the median unknown (null).
 */
export function censoredMedian(rows) {
	const reachedAt = [...new Set(rows.filter((row) => row.reached).map((row) => row.t))].sort((a, b) => a - b);
	let survival = 1;
	for (let i = 0; i < reachedAt.length; i++) {
		const t = reachedAt[i];
		const atRisk = rows.filter((row) => row.t >= t).length, reached = rows.filter((row) => row.reached && row.t === t).length;
		survival *= 1 - reached / atRisk;
		if (Math.abs(survival - 0.5) < 1e-9) return i + 1 < reachedAt.length ? Math.round((t + reachedAt[i + 1]) / 2 * 10) / 10 : null;
		if (survival < 0.5) return Math.round(t * 10) / 10;
	}
	return null;
}

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
		const rows = measured.map((seed) => {
			const own = runs.filter((run) => run.seed === seed && key in run.milestones);
			const t = median(own.filter((run) => run.milestones[key] !== null).map((run) => run.milestones[key]));
			// Never reached: censored at the longest it played, else at the window. Early: stopped over a minute short of it.
			return t !== null ? { t, reached: true } : { t: Math.max(...own.map((run) => run.playedMin ?? run.windowMin ?? Infinity)), reached: false,
				early: own.every((run) => Number.isFinite(run.playedMin) && Number.isFinite(run.windowMin) && run.playedMin < run.windowMin - 1) };
		});
		const tried = runs.filter((run) => key in run.milestones);
		const censored = rows.filter((row) => !row.reached);
		out[key] = { reached: rows.length - censored.length, total: measured.length, censored: censored.length,
			...(censored.some((row) => row.early) ? { censoredEarly: censored.filter((row) => row.early).length } : {}),
			medianMin: censoredMedian(rows), runs: { reached: tried.filter((run) => run.milestones[key] !== null).length, total: tried.length } };
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

/**
 * Over the runs that measured the Nether: games that entered, minutes there, deaths after the first entry, Nether deaths
 * and the games they hit, respawn distance from the entry portal, and the minutes back (returned, and never returned
 * before the game ended). null when no run had samples.
 */
export function netherTotals(runs) {
	const measured = runs.filter((run) => run.nether);
	if (!measured.length) return null;
	const deaths = measured.flatMap((run) => run.nether.deaths), back = deaths.filter((death) => death.returned), lost = deaths.filter((death) => !death.returned);
	const blocks = deaths.map((death) => death.respawnBlocks).filter((value) => value !== null);
	const sum = (values) => Math.round(values.reduce((total, value) => total + value, 0) * 10) / 10;
	return { games: measured.length, entered: measured.filter((run) => run.nether.firstEntryMin !== null).length, minutes: sum(measured.map((run) => run.nether.minutes)),
		deathsAfterFirstEntry: measured.reduce((total, run) => total + run.nether.deathsAfterFirstEntry, 0), deaths: deaths.length,
		gamesWithDeaths: measured.filter((run) => run.nether.deaths.length).length,
		respawnBlocks: blocks.length ? { min: Math.min(...blocks), median: median(blocks), max: Math.max(...blocks) } : null,
		back: { returned: back.length, returnedMin: sum(back.map((death) => death.backMin)), neverReturned: lost.length, neverReturnedMin: sum(lost.map((death) => death.backMin)),
			totalMin: sum(deaths.map((death) => death.backMin)) } };
}

export function buildGate({ gate, title, cohorts }) {
	const built = cohorts.map(({ name, label, dirs }) => {
		const runs = dirs.flatMap(readRun);
		return { name, label, commit: one(runs.map((run) => run.commit)), mode: one(runs.map((run) => run.mode)), model: one(runs.map((run) => run.model)),
			windowMin: one(runs.map((run) => run.windowMin)), ranAt: runs.map((run) => run.ranAt).filter(Boolean).sort()[0] ?? null, seeds: [...new Set(runs.map((run) => run.seed))], runs,
			funnel: funnel(runs), deaths: runs.reduce((sum, run) => sum + run.deaths, 0), nether: netherTotals(runs),
			costUsd: Math.round(runs.reduce((sum, run) => sum + run.costUsd, 0) * 100) / 100, repeats: repeatsOf(runs) };
	});
	const notes = [];
	const comparisons = [];
	for (let i = 1; i < built.length; i++) comparisons.push(compare(built[i - 1], built[i]));
	if (built.length === 1) notes.push('No pair in this file: one commit ran this gate. The PR comment pairs it with the previous gate when both ran the same seeds with the same model and window.');
	for (const comparison of comparisons) if (comparison.missingPairs.length) notes.push(`${comparison.before} → ${comparison.after}: ${comparison.missingPairs.length} seed(s) without a pair.`);
	if (!built.some((cohort) => cohort.repeats.length)) notes.push('No repeats: each seed ran once per commit, so run-to-run noise is not measured here.');
	for (const cohort of built) {
		const unmeasured = cohort.runs.filter((run) => run.unmeasured);
		if (unmeasured.length) notes.push(`${cohort.name}: ${unmeasured.length} game(s) measure no milestone (${unmeasured.map((run) => `${run.run}: ${run.unmeasured}`).join('; ')}).`);
	}
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
		const n = cohort.nether;
		if (n) console.error(`  Nether: ${n.entered}/${n.games} games entered, ${n.minutes} min there, ${n.deaths} Nether deaths in ${n.gamesWithDeaths} games (${n.deathsAfterFirstEntry} deaths after first entry), respawn ${n.respawnBlocks ? `${n.respawnBlocks.min}-${n.respawnBlocks.max} blocks, median ${n.respawnBlocks.median}` : '-'}, back ${n.back.returned} in ${n.back.returnedMin} min + ${n.back.neverReturned} never in ${n.back.neverReturnedMin} min`);
	}
}
