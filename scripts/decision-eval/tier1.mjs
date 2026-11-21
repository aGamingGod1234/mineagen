#!/usr/bin/env node
// Tier-1 decision test: one score for how often the play model picks the player-like move at recorded game moments,
// with a score per category, compared against a stored baseline. Any commit or checkout can be tested.
//
//   node scripts/decision-eval/tier1.mjs [--build <checkout|commit>] [--samples 3] [--sample-offset 0]
//        [--wording production|fresh-question|fresh|choose] [--out <dir>] [--baseline <file>] [--write-baseline]
//        [--concurrency 24] [--cache-dir <dir>] [--judge-provider claude|codex] [--judge-model <id>]
//        [--judge-effort <level>] [--judge-max-usd 20] [--keep-worktrees]
//
// The cases are the families named in tier1.json, read from the private archive (ARENA_PRIVATE_INPUTS). Each build
// renders every case with its own production code (run.mjs), the play model answers --samples times per case, and
// predicates or the cross-family rubric judge grade each answer. A case scores its share of good answers among graded
// ones; a category is the mean of its cases; the score is the mean of the categories. The score among answers that
// acted leaves out answers whose first call only read. Differences from the baseline come with a 90% interval from a
// paired two-level bootstrap (cases, then each case's answers); "real" means the interval excludes zero.
// Writes <out>/tier1.json, <out>/tier1.md and <out>/graded-samples.jsonl. Exit 0 when scored, 2 on a setup or run error.
import { privateInput, skipWithoutPrivateInputs } from '../../coordinator/scripts/private-inputs.mjs';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseArgs } from 'node:util';
import { RUNNER_SCRIPT, resolveBuild, removeWorktrees } from './builds.mjs';
import { gradeSamples, isGoodVerdict, loadCases, loadRun, UNGRADED } from '../../coordinator/src/decision-eval/grade.mjs';
import { createJudge } from '../../coordinator/src/decision-eval/judge.mjs';

const here = path.dirname(fileURLToPath(import.meta.url));
const harnessRoot = path.resolve(here, '..', '..');
const config = JSON.parse(await readFile(path.join(here, 'tier1.json'), 'utf8'));
const { values: args } = parseArgs({
	options: {
		build: { type: 'string', default: harnessRoot }, samples: { type: 'string', default: String(config.samples) }, 'sample-offset': { type: 'string', default: '0' },
		wording: { type: 'string', default: 'production' }, out: { type: 'string' }, baseline: { type: 'string', default: path.join(here, 'tier1-baseline.json') },
		'write-baseline': { type: 'boolean', default: false }, concurrency: { type: 'string', default: '24' }, 'cache-dir': { type: 'string' },
		'judge-provider': { type: 'string' }, 'judge-model': { type: 'string' }, 'judge-effort': { type: 'string' }, 'judge-max-usd': { type: 'string', default: '20' },
		'keep-worktrees': { type: 'boolean', default: false }, help: { type: 'boolean', default: false },
	},
});
if (args.help) {
	const header = (await readFile(fileURLToPath(import.meta.url), 'utf8')).split('\n').slice(1, 16);
	process.stdout.write(`${header.map((line) => line.replace(/^\/\/ ?/, '')).join('\n')}\n`);
	process.exit(0);
}
const fail = (message) => { process.stderr.write(`tier1: ${message}\n`); process.exit(2); };
const positive = (value, name, min = 1) => { const n = Number(value); if (!Number.isSafeInteger(n) || n < min) fail(`--${name} must be an integer >= ${min}`); return n; };
const samples = positive(args.samples, 'samples');
const sampleOffset = positive(args['sample-offset'], 'sample-offset', 0);
const concurrency = positive(args.concurrency, 'concurrency');
skipWithoutPrivateInputs('decision-eval tier1');
const corpus = config.corpus.map((relative) => privateInput(relative));
const out = path.resolve(args.out ?? path.join(os.tmpdir(), 'arena-decision-eval', `tier1-${new Date().toISOString().replace(/[:.]/g, '-')}`));
const cacheDir = path.resolve(args['cache-dir'] ?? path.join(os.homedir(), '.cache', 'arena-decision-eval'));
await mkdir(out, { recursive: true });
const say = (line) => process.stderr.write(`${line}\n`);

const categoryOfFamily = new Map(Object.entries(config.categories).flatMap(([category, { families }]) => families.map((family) => [family, category])));
const cases = (await Promise.all(corpus.map((entry) => loadCases(entry)))).flat().filter((entry) => categoryOfFamily.has(entry.family) && entry.split === 'train');
const caseById = new Map(cases.map((entry) => [entry.id, entry]));
// A sample ends at its first accepted call; when that call only reads, the answer has not chosen a move yet.
const READ_TOOLS = new Set(['capabilities', 'lookAround', 'survey', 'observe', 'inspect', 'queryMemory', 'taskMemory', 'exploreFrontier', 'actionStatus', 'programStatus']);
const firstCallReads = (sample) => { const call = (sample.calls ?? []).find((entry) => !entry.normalizeError); return call !== undefined && READ_TOOLS.has(call.name); };
for (const family of categoryOfFamily.keys()) if (!cases.some((entry) => entry.family === family)) fail(`family ${family} named in tier1.json has no cases in the corpus`);

const temporary = [];
let exitCode = 0;
try {
	const started = performance.now();
	const build = await resolveBuild(args.build, 'tier1', { harnessRoot, temporary });
	say(`build ${build.commit.slice(0, 12)} (${build.temporary ? 'temporary worktree' : build.root}); ${cases.length} cases x ${samples} samples, ${config.profile.provider} ${config.profile.model} ${config.profile.effort}, wording ${args.wording}`);
	const runFile = path.join(out, 'run.json');
	const runArgs = [path.join(build.root, RUNNER_SCRIPT), ...corpus.flatMap((entry) => ['--cases', entry]), '--split', 'train', '--ids', [...caseById.keys()].join(','),
		'--samples', String(samples), '--sample-offset', String(sampleOffset), '--concurrency', String(concurrency),
		'--provider', config.profile.provider, '--model', config.profile.model, '--effort', config.profile.effort, '--wording', args.wording,
		'--cache-dir', cacheDir, '--out', runFile];
	const code = await new Promise((resolve) => {
		const child = spawn(process.execPath, runArgs, { cwd: build.root, stdio: ['ignore', 'ignore', 'pipe'] });
		let buffered = '';
		child.stderr.on('data', (chunk) => {
			buffered += chunk;
			const lines = buffered.split('\n');
			buffered = lines.pop();
			for (const line of lines) if (/^(build|rendered|\{)/.test(line)) say(`[run] ${line.slice(0, 400)}`);
		});
		child.on('close', resolve);
	});
	if (code !== 0) throw new Error(`run.mjs exited ${code}`);
	const askedMs = Math.round(performance.now() - started);
	const run = await loadRun(runFile);
	const summary = run.runs[0]?.summary ?? {};
	if (summary.renderErrors?.length) say(`render errors: ${summary.renderErrors.map((e) => `${e.caseId} ${e.code}`).join(', ')}`);
	const judge = createJudge({ playerProvider: config.profile.provider, cacheFile: path.join(cacheDir, 'judge-cache.jsonl'), maxSpendUsd: Number(args['judge-max-usd']),
		overrides: { ...(args['judge-provider'] ? { provider: args['judge-provider'] } : {}), ...(args['judge-model'] ? { model: args['judge-model'] } : {}), ...(args['judge-effort'] ? { effort: args['judge-effort'] } : {}) } });
	const { graded } = await gradeSamples(caseById, run.samples, { judge });
	await writeFile(path.join(out, 'graded-samples.jsonl'), graded.map(({ sample, grade }) => JSON.stringify({ caseId: sample.caseId, family: sample.family, sample: sample.sample,
		calls: (sample.calls ?? []).map((call) => ({ tool: call.name, args: call.args, normalizeError: call.normalizeError ?? null })), grade: { verdict: grade.verdict, source: grade.source, reason: grade.reason } })).join('\n') + '\n');

	const perCase = {};
	for (const { sample, grade } of graded) {
		const row = (perCase[sample.caseId] ??= { category: categoryOfFamily.get(caseById.get(sample.caseId).family), good: 0, graded: 0, reads: 0, ungraded: 0, errors: 0 });
		if (grade.verdict === 'error') row.errors += 1;
		else if (grade.verdict === UNGRADED) row.ungraded += 1;
		else { row.graded += 1; if (isGoodVerdict(grade.verdict)) row.good += 1; else if (firstCallReads(sample)) row.reads += 1; }
	}
	const result = {
		kind: 'decision-eval-tier1', schemaVersion: 1, generatedAt: new Date().toISOString(), commit: build.commit, profile: config.profile, wording: args.wording,
		samples, sampleOffset, corpusCases: cases.length, cases: perCase, ...score(perCase),
		cost: { samplesAsked: summary.providerSamples ?? null, samplesFromCache: summary.cachedSamples ?? null, playerUsd: summary.billedCostUsd ?? summary.costUsd ?? null,
			judgeCalls: judge.ledger.calls, judgeCacheHits: judge.ledger.cacheHits, judgeUsd: judge.ledger.costUsd,
			askWallMs: askedMs, totalWallMs: Math.round(performance.now() - started) },
	};
	const baseline = !args['write-baseline'] && existsSync(args.baseline) ? JSON.parse(await readFile(args.baseline, 'utf8')) : null;
	if (baseline) result.comparison = compare(result, baseline);
	await writeFile(path.join(out, 'tier1.json'), JSON.stringify(result, null, 1) + '\n');
	const markdown = render(result, baseline);
	await writeFile(path.join(out, 'tier1.md'), markdown);
	process.stdout.write(markdown);
	if (args['write-baseline']) {
		const { comparison: _comparison, ...stored } = result;
		await writeFile(args.baseline, JSON.stringify(stored, null, 1) + '\n');
		say(`baseline written to ${path.relative(process.cwd(), args.baseline)}`);
	}
	say(`report: ${path.join(out, 'tier1.md')}`);
} catch (error) {
	say(`tier1: ${error.message}`);
	exitCode = 2;
} finally {
	if (!args['keep-worktrees']) await removeWorktrees(temporary, { harnessRoot, say });
}
process.exit(exitCode);

function rate(row) { return row.graded > 0 ? row.good / row.graded : null; }
function actingRate(row) { return row.graded - (row.reads ?? 0) > 0 ? row.good / (row.graded - (row.reads ?? 0)) : null; }
function mean(values) { const v = values.filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

function score(perCase) {
	const categories = {};
	for (const category of Object.keys(config.categories)) {
		const rows = Object.values(perCase).filter((row) => row.category === category);
		const rates = rows.map(rate);
		categories[category] = { rate: mean(rates), actingRate: mean(rows.map(actingRate)), cases: rows.length, scoredCases: rates.filter((x) => x !== null).length,
			good: rows.reduce((n, row) => n + row.good, 0), graded: rows.reduce((n, row) => n + row.graded, 0), reads: rows.reduce((n, row) => n + row.reads, 0),
			ungraded: rows.reduce((n, row) => n + row.ungraded + row.errors, 0) };
	}
	return { score: mean(Object.values(categories).map((c) => c.rate)), actingScore: mean(Object.values(categories).map((c) => c.actingRate)), categories };
}

/**
 * Paired two-level bootstrap, fixed seed: cases are resampled within each category, and each drawn case's answers are
 * redrawn from its own good rate (smoothed, so 0/3 and 3/3 cases still vary) in both runs, so the interval carries the noise of only 3-6 answers per case as well
 * as the choice of cases (a cases-only bootstrap flagged a 14-point travel swing between two runs of one build).
 */
function compare(candidate, baseline) {
	const notes = [];
	for (const key of ['model', 'effort', 'provider']) if (candidate.profile[key] !== baseline.profile?.[key]) notes.push(`baseline ${key} ${baseline.profile?.[key]} differs from ${candidate.profile[key]}`);
	if (candidate.wording !== baseline.wording) notes.push(`baseline wording ${baseline.wording}, this run ${candidate.wording}`);
	const pairs = {};
	for (const [id, row] of Object.entries(candidate.cases)) {
		const base = baseline.cases?.[id];
		if (!base || rate(row) === null || rate(base) === null) continue;
		(pairs[row.category] ??= []).push([row, base]);
	}
	const unpaired = Object.keys(candidate.cases).filter((id) => !baseline.cases?.[id]).length + Object.keys(baseline.cases ?? {}).filter((id) => !candidate.cases[id]).length;
	if (unpaired) notes.push(`${unpaired} cases are in only one run and are left out of the deltas`);
	let seed = 20261121;
	const random = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 2 ** 32; };
	const binomialRate = ({ good, graded }) => { const p = (good + 0.5) / (graded + 1); let k = 0; for (let i = 0; i < graded; i++) if (random() < p) k += 1; return k / graded; };
	const delta = (rows) => mean(rows.map(([a]) => rate(a))) - mean(rows.map(([, b]) => rate(b)));
	const drawDelta = (rows) => { let a = 0; let b = 0; for (let i = 0; i < rows.length; i++) { const [x, y] = rows[Math.floor(random() * rows.length)]; a += binomialRate(x); b += binomialRate(y); } return (a - b) / rows.length; };
	const categories = {};
	const draws = [];
	for (let i = 0; i < 2000; i++) {
		const perCategory = {};
		for (const [category, rows] of Object.entries(pairs)) perCategory[category] = drawDelta(rows);
		draws.push(perCategory);
	}
	const interval = (values) => { const sorted = values.filter(Number.isFinite).sort((a, b) => a - b); return [sorted[Math.floor(0.05 * sorted.length)], sorted[Math.floor(0.95 * sorted.length)]]; };
	for (const [category, rows] of Object.entries(pairs)) {
		const [low, high] = interval(draws.map((d) => d[category]));
		categories[category] = { delta: delta(rows), low, high, pairedCases: rows.length, real: low > 0 || high < 0 };
	}
	const overallDraws = draws.map((d) => mean(Object.values(d)));
	const [low, high] = interval(overallDraws);
	const overallDelta = mean(Object.values(categories).map((c) => c.delta));
	return { baselineCommit: baseline.commit, baselineGeneratedAt: baseline.generatedAt, overall: { delta: overallDelta, low, high, real: low > 0 || high < 0 }, categories, notes };
}

function pct(x) { return x === null || x === undefined ? 'n/a' : `${Math.round(x * 100)}%`; }
function pts(x) { return x === null || x === undefined ? 'n/a' : `${x >= 0 ? '+' : ''}${Math.round(x * 100)}`; }

function render(result, baseline) {
	const c = result.comparison;
	const lines = [`# Tier-1 decision test: ${pct(result.score)} player-like`, '',
		`Build ${result.commit.slice(0, 12)}, ${result.profile.provider} ${result.profile.model} ${result.profile.effort}, wording ${result.wording}, ${result.corpusCases} cases x ${result.samples} samples.`];
	if (c) lines.push(`Baseline ${c.baselineCommit.slice(0, 12)} (${c.baselineGeneratedAt.slice(0, 10)}): ${pct(baseline.score)}; change ${pts(c.overall.delta)} points (90% interval ${pts(c.overall.low)} to ${pts(c.overall.high)})${c.overall.real ? ', outside noise' : ', within noise'}.`);
	lines.push(`Among answers that acted (first call not a read): ${pct(result.actingScore)}${baseline?.actingScore !== undefined ? ` (baseline ${pct(baseline.actingScore)})` : ''}.`);
	lines.push('', '| category | player-like | good / graded answers | reads first | among acting | cases | baseline | change (90% interval) |', '|---|---:|---:|---:|---:|---:|---:|---|');
	for (const [category, row] of Object.entries(result.categories)) {
		const d = c?.categories[category];
		const base = baseline?.categories?.[category];
		lines.push(`| ${config.categories[category].label} | ${pct(row.rate)} | ${row.good} / ${row.graded}${row.ungraded ? ` (${row.ungraded} ungraded)` : ''} | ${row.reads} | ${pct(row.actingRate)} | ${row.scoredCases} | ${base ? pct(base.rate) : 'n/a'} | ${d ? `${pts(d.delta)} (${pts(d.low)} to ${pts(d.high)})${d.real ? ' **real**' : ''}` : 'n/a'} |`);
	}
	const k = result.cost;
	lines.push('', `Model calls: ${k.samplesAsked} play samples asked (${k.samplesFromCache} more from the cache), ${k.judgeCalls} judge calls (${k.judgeCacheHits} cached). Player $${(k.playerUsd ?? 0).toFixed(2)}, judge $${(k.judgeUsd ?? 0).toFixed(2)} (price proxies). Wall ${Math.round(k.totalWallMs / 1000)} s (${Math.round(k.askWallMs / 1000)} s asking).`);
	if (c?.notes.length) lines.push('', ...c.notes.map((note) => `- ${note}`));
	return `${lines.join('\n')}\n`;
}
