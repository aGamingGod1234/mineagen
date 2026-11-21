import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGate, readRun, compare, verdict, funnel, parseCli, SCHEMA } from '../../scripts/quality/gate-report.mjs';
import { findGateFunnel, collectReplays } from '../../scripts/quality/lib/stake-comparison.mjs';
import { formatFunnel, formatReplays } from '../src/decision-eval/stake-summary.mjs';

const T0 = 1_794_170_000_000, MIN = 60_000;
const milestone = (at) => ({ firstObservedAt: at === null ? null : T0 + at * MIN, reached: at !== null });
const SHA = 'e62adcea2c08e42973c9e1a928358ab19b043ccc';

/** A long-run folder as the farm saves it: stage-score, long-run, the runner's log beside it, and a decision log. */
async function longRun(root, name, { seed, iron = null, bucket = null, flint = null, nether = null, afterDeathIron = null, deaths = 0, usd = 1.5, log = [], windowMin = 40, endMin = null, samples = null, model = 'gpt-6.1-sol', effort = 'low', stop = undefined }) {
	const dir = path.join(root, name);
	await mkdir(path.join(dir, 'raw'), { recursive: true });
	const lives = { firstLife: { milestones: { iron_pickaxe: milestone(iron), bucket: milestone(bucket), flint_and_steel: milestone(flint), nether: milestone(nether) } },
		afterDeath: { milestones: { iron_pickaxe: milestone(afterDeathIron) } } };
	// endMin: the scorer's observed end (last sample and the stop it recorded); older scores leave both out.
	const window = { startedAt: T0, windowMs: windowMin * MIN, ...(endMin === null ? {} : { observedThrough: T0 + endMin * MIN, plannedEndAt: T0 + windowMin * MIN }) };
	await writeFile(path.join(dir, 'stage-score.json'), JSON.stringify({ window, ...(endMin === null ? {} : { ending: { kind: 'stopped', at: T0 + endMin * MIN } }), identity: { seed }, observedDeaths: deaths, ...lives }));
	await writeFile(path.join(dir, 'long-run.json'), JSON.stringify({ seed, windowMs: windowMin * MIN, profile: { provider: 'codex', model, reasoningEffort: effort }, spend: { usd }, ...(stop ? { stop } : {}) }));
	if (samples) await writeFile(path.join(dir, 'raw', 'quality-samples.jsonl'), samples.map((row) => JSON.stringify(row)).join('\n') + '\n');
	await writeFile(`${dir}.log`, `Running q-1: /home/user/micro/roots/${SHA}/runtime/headless-runs/x\n`);
	await writeFile(path.join(dir, 'raw', 'decision-1-agent.jsonl'), log.map((row) => JSON.stringify(row)).join('\n') + '\n');
	return dir;
}

test('a long run gives commit, seed, each milestone in minutes, deaths, cost and model', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const contract = 'build nether_portal ... lights it: PORTAL_LIT names the opening to step into';
		const dir = await longRun(root, 'gate3-1-codex', { seed: '42', iron: null, afterDeathIron: 12.5, bucket: 14, deaths: 1, usd: 1.2345, log: [
			{ type: 'decision', time: T0 + 1 * MIN, inputs: [{ text: contract }] },
			{ type: 'tool_result', time: T0 + 6 * MIN, result: '{"known":"lava: lava 26m W y4"}' },
			{ type: 'action_result', time: T0 + 30 * MIN, result: { reasonCode: 'PORTAL_LIT' } },
		] });
		const [run] = readRun(dir);
		assert.equal(run.commit, SHA);
		assert.equal(run.seed, '42');
		assert.equal(run.mode, 'model');
		assert.equal(run.model, 'codex gpt-6.1-sol low');
		// The iron pickaxe came in the second life: the earliest observation over both lives counts.
		assert.deepEqual(run.milestones, { ironPickaxe: 12.5, bucket: 14, flintAndSteel: null, lavaSeen: 6, portalLit: 30, nether: null });
		assert.equal(run.deaths, 1);
		assert.equal(run.costUsd, 1.235);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('contract text naming PORTAL_LIT is not a lit portal; a Nether entry bounds it', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const none = await longRun(root, 'a', { seed: '1', log: [{ type: 'tool_result', time: T0 + MIN, result: 'It ends PORTAL_LIT, PILLAR_BUILT or SHELTER_BUILT' }] });
		assert.equal(readRun(none)[0].milestones.portalLit, null);
		const nether = await longRun(root, 'b', { seed: '1', nether: 33, log: [{ type: 'decision', time: T0 + MIN }] });
		assert.equal(readRun(nether)[0].milestones.portalLit, 33);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('scripted rounds measure only their item; repeats on one commit report the seeds that flipped', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const round = path.join(root, 'nrs-4b5a7088');
		await mkdir(round, { recursive: true });
		await writeFile(path.join(round, 'plan.json'), JSON.stringify({ rootSha: '4b5a7088cda98a9ebe61bcfac07ccbc30b7bae43' }));
		const dirs = [];
		for (const [name, seed, pass, seconds] of [['s1-r1', '1', true, 600], ['s1-r2', '1', false, 900], ['s2-r1', '2', true, 300], ['s2-r2', '2', true, 360]]) {
			const dir = path.join(round, name);
			await mkdir(path.join(dir, 'run'), { recursive: true });
			await writeFile(path.join(dir, 'run', 'result.json'), JSON.stringify([{ seed, item: 'iron_pickaxe', budgetMs: 900_000, seconds, pass, deaths: 0 }]));
			dirs.push(dir);
		}
		const report = buildGate({ gate: 'repeats-178', title: 'rounds', cohorts: [{ name: 'round1', label: '#178 round 1', dirs }] });
		const [cohort] = report.cohorts;
		assert.equal(cohort.mode, 'scripted');
		assert.equal(cohort.commit, '4b5a7088cda98a9ebe61bcfac07ccbc30b7bae43');
		// Only the iron pickaxe is measured; a repeated seed counts once in the funnel, every run in runs.
		assert.deepEqual(Object.keys(cohort.funnel), ['ironPickaxe']);
		assert.deepEqual(cohort.funnel.ironPickaxe, { reached: 2, total: 2, censored: 0, medianMin: 7.8, runs: { reached: 3, total: 4 } });
		assert.deepEqual(cohort.repeats.map((row) => [row.seed, row.flipped]), [['1', ['ironPickaxe']], ['2', []]]);
		assert.match(report.notes.join(' '), /No pair/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('pairs: under 2 seeds is "no change", and seeds only one side ran are named', () => {
	assert.equal(verdict(1), 'no change');
	assert.equal(verdict(-1), 'no change');
	assert.equal(verdict(2), 'better');
	assert.equal(verdict(-2), 'worse');
	const run = (seed, iron) => ({ seed, model: 'codex gpt-6.1-sol low', milestones: { ironPickaxe: iron } });
	const result = compare({ name: 'A', runs: [run('1', null), run('2', null), run('3', 5)] }, { name: 'B', runs: [run('1', 4), run('2', 6), run('4', 7)] });
	assert.equal(result.pairedSeeds, 2);
	assert.deepEqual(result.missingPairs, [{ seed: '3', only: 'A' }, { seed: '4', only: 'B' }]);
	assert.deepEqual(result.milestones.ironPickaxe, { before: 0, after: 2, total: 2, diff: 2, verdict: 'better', beforeMedianMin: null, afterMedianMin: 5 });
});

const gateReport = (gate, iron) => ({ schema: SCHEMA, gate, title: `Gate ${gate}`, notes: [], comparisons: [], cohorts: [{ name: `gate${gate}`, label: `main ${gate}`, commit: '0c6894375817d04bb7523126ff230a16ba743a73',
	mode: 'model', model: 'codex gpt-6.1-sol low', windowMin: 40, ranAt: '2026-11-09', seeds: Array.from({ length: 8 }, (_, i) => String(i)),
	funnel: { ironPickaxe: { reached: iron, total: 8, medianMin: 10.8 }, portalLit: { reached: 0, total: 8, medianMin: null } }, deaths: 6, costUsd: 11.93, repeats: [] }] });
const repeatsReport = { schema: SCHEMA, gate: 'repeats-178', title: 'rounds', cohorts: [{ name: 'round1', label: '#178 round 1', repeats: [
	{ seed: '1', flipped: ['ironPickaxe'] }, { seed: '2', flipped: [] }, { seed: '3', flipped: ['ironPickaxe'] }] }] };

const fakeGit = (trees, touched = []) => async (command, ...args) => {
	if (command === 'diff') return touched.join('\n');
	if (command === 'ls-tree') return Object.keys(trees[args.at(-2)] ?? {}).join('\n');
	if (command === 'show') { const [ref, file] = args[0].split(':'); const body = trees[ref]?.[file]; if (body === undefined) throw new Error('missing'); return body; }
	throw new Error(`unexpected git ${command}`);
};

test('the funnel comes from the newest gate on the base; old lava gate files supply nothing', async () => {
	const base = { 'docs/gates/gate-3.json': JSON.stringify(gateReport(3, 7)), 'docs/gates/gate-4.json': JSON.stringify(gateReport(4, 8)),
		'docs/gates/repeats-178.json': JSON.stringify(repeatsReport), 'docs/gates/gate-9.json': '{"branch":{"metrics":{"validFinds":3},"seeds":[1,2,3,4,5,6,7,8]}}' };
	const product = await findGateFunnel({ base: 'base', evaluated: 'merge', head: 'head', repo: 'o/r' }, fakeGit({ base, merge: base }));
	assert.equal(product.gate.gate, 4);
	assert.equal(product.gate.source, 'base');
	assert.equal(product.gate.url, 'https://github.com/o/r/blob/base/docs/gates/gate-4.json');
	assert.deepEqual(product.repeats.cohorts, [{ name: 'round1', label: '#178 round 1', mode: null, windowMin: null, seeds: 3, flipped: 2, milestones: ['ironPickaxe'] }]);
	const text = formatFunnel(product, { sha: 'base1234' }).join('\n');
	assert.match(text, /\*\*Product: gate 4\*\* \(newest on base\) · main 4 `0c689437` · 8 seeds · codex gpt-6.1-sol low · 40 min · ran 2026-11-09/);
	assert.match(text, /\| Iron pickaxe \| ████████ 8\/8 \| 10.8 min \|/);
	assert.match(text, /\| Portal lit \| ░░░░░░░░ 0\/8 \| – \|/);
	assert.match(text, /no pair \(one commit ran gate 4\); repeats: #178 round 1, 2 of 3 seeds flipped \(iron pickaxe\)/);
	assert.match(text, /a difference under 2 seeds is "no change"/);
	assert.doesNotMatch(text, /target|Lava ███/);
});

test('a gate report this PR adds wins over the base, and a pair shows before → after with the rule', async () => {
	const paired = gateReport(5, 7);
	paired.cohorts.unshift({ ...paired.cohorts[0], name: 'gate5A' });
	paired.comparisons = [{ before: 'gate5A', after: 'gate5', pairedSeeds: 8, missingPairs: [], milestones: { ironPickaxe: { before: 6, after: 7, diff: 1, verdict: 'no change' } } }];
	const base = { 'docs/gates/gate-4.json': JSON.stringify(gateReport(4, 8)) };
	const merge = { ...base, 'docs/gates/gate-5.json': JSON.stringify(paired) };
	const product = await findGateFunnel({ base: 'base', evaluated: 'merge', head: 'head', repo: 'o/r' }, fakeGit({ base, merge }, ['docs/gates/gate-5.json']));
	assert.equal(product.gate.source, 'this PR');
	assert.equal(product.gate.url, 'https://github.com/o/r/blob/head/docs/gates/gate-5.json');
	const text = formatFunnel(product).join('\n');
	assert.match(text, /\| Milestone \| Seeds \| Median \| gate5A → gate5 \|/);
	assert.match(text, /\| Iron pickaxe \| ███████░ 7\/8 \| 10.8 min \| 6 → 7 no change \|/);
	assert.match(text, /8 paired seeds; no repeats on record/);
	assert.match(formatFunnel(null, { sha: 'base1234abcd' }).join('\n'), /no gate report\*\* on base `base1234`/);
});

test('replays print base → head, "no corpus" with no logs, and a base without the module reads not comparable', async () => {
	assert.deepEqual(await collectReplays({ dirs: [] }), { corpus: 0 });
	assert.match(formatReplays({ corpus: 0 }).join('\n'), /\*\*no corpus\*\*/);
	assert.deepEqual(formatReplays(undefined), []);
	const text = formatReplays({ corpus: 8, searchDanger: { base: { error: "Cannot find module '/tmp/x/base/coordinator/src/search-danger.mjs' imported from /tmp/y" }, head: { mobHandBacks: 16, handBacks: 42, recorded: 50 } },
		portalRoute: { base: { portalStep: 0, foodDetour: 141, wakes: 141 }, head: { portalStep: 128, foodDetour: 2, wakes: 141 } } }).join('\n');
	assert.match(text, /mob hand-backs not comparable → 16 · all danger hand-backs not comparable → 42 \(of 50 recorded\)/);
	assert.match(text, /next portal step 0 → 128 · food detours 141 → 2 \(of 141 wakes\)/);
	assert.match(text, /search danger base: Cannot find module 'coordinator\/src\/search-danger.mjs'$/m);
});

test('a gate one commit ran pairs with the previous gate on the same seeds, model and window', async () => {
	const withRuns = (gate, commit, irons) => {
		const report = gateReport(gate, irons.filter(value => value !== null).length);
		Object.assign(report.cohorts[0], { commit, runs: irons.map((iron, seed) => ({ seed: String(seed), milestones: { ironPickaxe: iron } })) });
		return report;
	};
	const gate3 = withRuns(3, 'e62adcea2c08e42973c9e1a928358ab19b043ccc', [5, 6, 7, 8, 9, 10, 11, null]);
	const base = { 'docs/gates/gate-3.json': JSON.stringify(gate3), 'docs/gates/gate-4.json': JSON.stringify(withRuns(4, '0c6894375817d04bb7523126ff230a16ba743a73', [5, 6, 7, 8, 9, 10, 11, 12])) };
	const product = await findGateFunnel({ base: 'base', evaluated: 'merge' }, fakeGit({ base, merge: base }));
	assert.equal(product.gate.comparison.acrossGate, 3);
	assert.deepEqual(product.gate.comparison.milestones.ironPickaxe, { before: 7, after: 8, total: 8, diff: 1, verdict: 'no change', beforeMedianMin: 8.5, afterMedianMin: 8.5 });
	const text = formatFunnel(product).join('\n');
	assert.match(text, /\| Milestone \| Seeds \| Median \| gate3 → gate4 \|/);
	assert.match(text, /\| 7 → 8 no change \|/);
	assert.match(text, /Noise: 8 paired seeds with gate 3;/);
	const other = { ...base, 'docs/gates/gate-3.json': JSON.stringify({ ...gate3, cohorts: [{ ...gate3.cohorts[0], windowMin: 20 }] }) };
	assert.equal((await findGateFunnel({ base: 'base', evaluated: 'merge' }, fakeGit({ base: other, merge: other }))).gate.comparison, null);
});

test('a pair uses each seed\'s first run, so a cohort run twice gets no second chance', () => {
	const run = (seed, iron) => ({ seed, model: 'codex gpt-6.1-sol low', milestones: { ironPickaxe: iron } });
	const twice = { name: 'round1', runs: [run('1', null), run('1', 5), run('2', 4), run('2', null)] };
	const once = { name: 'round2', runs: [run('1', null), run('2', 4)] };
	assert.equal(compare(twice, once).milestones.ironPickaxe.before, 1);
});

test('a milestone pairs only seeds measured on both sides; a save-point game is left out, not counted as never reached', () => {
	const fresh = (seed, iron) => ({ seed, model: 'codex gpt-6.1-sol low', milestones: { ironPickaxe: iron } });
	const savePoint = (seed) => ({ seed, model: 'codex gpt-6.1-sol low', milestones: {} });
	const before = { name: 'fresh', runs: ['1', '2', '3', '4'].map((seed) => fresh(seed, 10)) };
	const after = { name: 'mixed', runs: [savePoint('1'), savePoint('2'), savePoint('3'), fresh('4', 12)] };
	const result = compare(before, after);
	assert.deepEqual(result.milestones.ironPickaxe, { before: 1, after: 1, total: 1, diff: 0, verdict: 'no change', beforeMedianMin: 10, afterMedianMin: 12, unmeasured: ['1', '2', '3'] });
});

test('scripted repeats are labelled scripted, and an unknown commit is not "mixed"', () => {
	const product = { gate: { gate: 5, source: 'base', comparison: null, cohort: { label: 'x', commit: null, seeds: 8, mode: 'model', funnel: {}, deaths: 0, costUsd: 0 } },
		repeats: { cohorts: [{ label: '#178 round 1', mode: 'scripted', windowMin: 15, seeds: 8, flipped: 3, milestones: ['ironPickaxe'] }] } };
	const text = formatFunnel(product).join('\n');
	assert.match(text, /`unknown commit`/);
	assert.match(text, /repeats \(scripted runs, no model, 15 min\): #178 round 1, 3 of 8 seeds flipped \(iron pickaxe\)/);
	assert.match(formatFunnel({ ...product, gate: { ...product.gate, cohort: { ...product.gate.cohort, commit: ['a', 'b'] } } }).join('\n'), /`mixed commits`/);
});

/** A standard round as its runner saves it: the round manifest, then per game a timeline, spend, manifest and samples. */
async function standardRound(root, games, { startKind = 'fresh', baseline = startKind !== 'fresh' } = {}) {
	const dir = path.join(root, 'round9');
	await mkdir(dir, { recursive: true });
	await writeFile(path.join(dir, 'manifest.json'), JSON.stringify({ games: games.map(({ id }, i) => ({ id, tag: `r9-${i + 1}`, jar: `jars/route-${SHA.slice(0, 8)}.jar`, minutes: 180 })) }));
	for (const { id, seed, stages, deaths = 0, minute = 60, samples, model = 'gpt-6.1-sol', reason, agentId, raw = {} } of games) {
		const game = path.join(dir, id);
		await mkdir(path.join(game, 'raw'), { recursive: true });
		await writeFile(path.join(game, 'timeline.json'), JSON.stringify({ stageOrder: ['iron pickaxe', 'in the Nether'], startedAt: T0, stoppedAt: T0 + minute * MIN, minute, startKind,
			stages: Object.entries(stages).map(([stage, at]) => ({ stage, minute: at, at: T0 + at * MIN, source: at === 0 && baseline ? 'snapshot baseline' : 'observation' })), deaths: Array.isArray(deaths) ? deaths : Array.from({ length: deaths }, () => ({ cause: 'x' })), ...(agentId ? { agentId } : {}) }));
		await writeFile(path.join(game, 'spend.json'), JSON.stringify({ usd: 2.5 }));
		await writeFile(path.join(game, 'raw', 'manifest.json'), JSON.stringify({ provider: 'codex', model, reasoningEffort: 'low', world: { seed } }));
		await writeFile(path.join(game, 'controller.json'), JSON.stringify({ state: 'done', at: T0, ...(reason ? { reason } : {}) }));
		if (samples) await writeFile(path.join(game, 'raw', 'quality-samples.jsonl'), samples.map((row) => JSON.stringify(row)).join('\n') + '\n');
		for (const [name, rows] of Object.entries(raw)) await writeFile(path.join(game, 'raw', name), rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
	}
	return dir;
}

const OVER = 'minecraft:overworld', NETHER = 'minecraft:the_nether';
const sample = (minute, dimension, x, z, deathCounter, inventoryNbt = '[]') => ({ at: T0 + minute * MIN, dimension, position: { x, y: 64, z }, health: 20, deathCounter, inventoryNbt, equipmentNbt: '[]', gameTime: minute * 1200 });
// An Overworld death before entering, then two Nether deaths: one back in 5 min, one never back before the game ends at 60.
const ROUTE = [
	sample(0, OVER, 0, 0, 0), sample(8, OVER, 0, 0, 0, '[{count: 1, Slot: 0b, id: "minecraft:bucket"}]'), sample(15, OVER, 0, 0, 1),
	sample(20, OVER, 100, 0, 1), sample(20.5, NETHER, 12, 0, 1), sample(30, NETHER, 40, 0, 1),
	sample(31, OVER, 0, 30, 2), sample(35, OVER, 100, 0, 2), sample(36, NETHER, 12, 0, 2), sample(49, NETHER, 30, 0, 2),
	sample(50, OVER, 100, 50, 3), sample(59, OVER, 90, 50, 3), sample(61, OVER, 0, 0, 4),
];

test('a standard round folder gives each game, with the first bucket and Nether recovery from its samples', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const dir = await standardRound(root, [
			{ id: 'game-1', seed: '777', deaths: 3, stages: { 'iron pickaxe': 5, 'water bucket': 10, buckets: 12, 'portal lit': 20, 'in the Nether': 20.5 }, samples: ROUTE },
			{ id: 'game-2', seed: '778', minute: 40, stages: { 'iron pickaxe': 7, 'water bucket': 14, buckets: 11 } },
		]);
		const runs = readRun(dir);
		assert.deepEqual(readRun(path.join(dir, 'game-1')), [runs[0]]);
		const [first, second] = runs;
		assert.equal(first.seed, '777');
		assert.equal(first.commit, SHA.slice(0, 8));
		assert.equal(first.model, 'codex gpt-6.1-sol low');
		assert.equal(first.windowMin, 180);
		assert.equal(first.playedMin, 60);
		assert.equal(first.deaths, 3);
		assert.equal(first.costUsd, 2.5);
		// The first bucket is the first sample holding one, before "water bucket" and "buckets" (two of them).
		assert.deepEqual(first.milestones, { ironPickaxe: 5, bucket: 8, flintAndSteel: null, lavaSeen: null, portalLit: 20, nether: 20.5, fortress: null, blazeRods: null, enderPearls: null });
		assert.deepEqual(first.nether, { minutes: 22.5, firstEntryMin: 20.5, deathsAfterFirstEntry: 2, deaths: [
			{ minute: 31, respawnBlocks: 104, returned: true, backMin: 5 },
			{ minute: 50, respawnBlocks: 50, returned: false, backMin: 10 },
		] });
		// No samples: the earlier of two buckets and a water bucket bounds the first bucket, and the Nether is not measured.
		assert.equal(second.milestones.bucket, 11);
		assert.equal('nether' in second, false);
		assert.equal(second.playedMin, 40);

		const [cohort] = buildGate({ gate: 'r9', title: 'round 9', cohorts: [{ name: 'r9', label: 'round 9', dirs: [dir] }] }).cohorts;
		// game-2 stopped at 40 of 180 minutes without the Nether: censored early, at 40.
		assert.deepEqual(cohort.funnel.nether, { reached: 1, total: 2, censored: 1, censoredEarly: 1, censoredEarlyBy: { cap: 0, stall: 0, other: 0, unrecorded: 1 }, medianMin: null, runs: { reached: 1, total: 2 } });
		assert.deepEqual(cohort.nether, { games: 1, entered: 1, minutes: 22.5, deathsAfterFirstEntry: 2, deaths: 2, gamesWithDeaths: 1,
			respawnBlocks: { min: 50, median: 77, max: 104 }, back: { returned: 1, returnedMin: 5, neverReturned: 1, neverReturnedMin: 10, totalMin: 15 } });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a samples file with no usable sample in the window leaves the Nether unknown, not zero', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const stages = { 'iron pickaxe': 5 };
		const dir = await standardRound(root, [
			{ id: 'game-1', seed: '1', stages },
			{ id: 'game-2', seed: '2', stages },
			{ id: 'game-3', seed: '3', stages, samples: [sample(-5, NETHER, 0, 0, 0), sample(70, NETHER, 0, 0, 0)] },
			{ id: 'game-4', seed: '4', stages, samples: [sample(0, OVER, 0, 0, 0), sample(30, OVER, 10, 0, 0)] },
		]);
		await writeFile(path.join(dir, 'game-1', 'raw', 'quality-samples.jsonl'), '');
		await writeFile(path.join(dir, 'game-2', 'raw', 'quality-samples.jsonl'), '{"at": 17941\nnot json\n');
		const runs = readRun(dir);
		assert.deepEqual(runs.map((run) => 'nether' in run), [false, false, false, true]);
		assert.match(runs[1].netherUnmeasured, /no usable sample in the playing window \(2 malformed line\(s\)\)/);
		const report = buildGate({ gate: 'r9', title: 'round 9', cohorts: [{ name: 'r9', label: 'round 9', dirs: [dir] }] });
		// Only the game with valid samples counts: it never entered, which is a measured zero.
		assert.equal(report.cohorts[0].nether.games, 1);
		assert.equal(report.cohorts[0].nether.entered, 0);
		assert.equal(report.cohorts[0].nether.minutes, 0);
		assert.ok(report.notes.some((note) => /r9: 3 game\(s\) left out of the Nether totals as unknown \(r9-1: .*; r9-2: .*; r9-3: /.test(note)), report.notes.join('\n'));
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a seed that never reached a milestone stays in the median as censored', () => {
	const run = (seed, nether) => ({ seed, milestones: { nether } });
	assert.deepEqual(funnel([run('1', 30), run('2', 50), run('3', null)]).nether, { reached: 2, total: 3, censored: 1, medianMin: 50, runs: { reached: 2, total: 3 } });
	// Half or more censored: the median lies past the window, so it is unknown.
	assert.equal(funnel([run('1', 30), run('2', null)]).nether.medianMin, null);
	// A seed run twice is reached if either run was; it is not censored.
	assert.equal(funnel([run('1', null), run('1', 40), run('2', 20)]).nether.censored, 0);
});

test('a game that stopped early is censored where it stopped, never ranked behind a longer game that reached the milestone', () => {
	const run = (seed, nether, playedMin = 180) => ({ seed, windowMin: 180, playedMin, milestones: { nether } });
	// Two games stopped at 20 and 25 minutes, before the others reached the Nether at 60, 90 and 120. Counted as never
	// reaching it (past the window) the median was 120; out of the risk set at their stop it is the median of the three.
	const early = funnel([run('1', 60), run('2', 90), run('3', 120), run('4', null, 20), run('5', null, 25)]).nether;
	assert.equal(early.medianMin, 90);
	assert.equal(early.censored, 2);
	assert.equal(early.censoredEarly, 2, 'flagged: they stopped before the window ended');
	// Censored at the window end, they stay later than every reached time, as before.
	const full = funnel([run('1', 60), run('2', 90), run('3', 120), run('4', null), run('5', null)]).nether;
	assert.equal(full.medianMin, 120);
	assert.equal('censoredEarly' in full, false);
	// A game that stopped after the others reached it is still at risk at their times.
	assert.equal(funnel([run('1', 30), run('2', 50), run('3', null, 100)]).nether.medianMin, 50);
});

test('a game started from a save point measures no milestone: its inherited stages are not its own', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const dir = await standardRound(root, [{ id: 'game-1', seed: '777', stages: { 'iron pickaxe': 0, 'in the Nether': 12 } }], { startKind: 'snapshot' });
		const [game] = readRun(dir);
		assert.equal(game.startKind, 'snapshot');
		assert.deepEqual(game.milestones, {});
		const gate = buildGate({ gate: 'r9', title: 'round 9', cohorts: [{ name: 'r9', label: 'round 9', dirs: [dir] }] });
		assert.deepEqual(gate.cohorts[0].funnel, {});
		assert.ok(gate.notes.some((note) => /r9: 1 game\(s\) measure no milestone \(r9-1: start snapshot/.test(note)), gate.notes.join('\n'));
		// An older timeline names no start kind: its inherited stages still mark the save point.
		const older = await standardRound(path.join(root, 'older'), [{ id: 'game-1', seed: '777', stages: { 'iron pickaxe': 0, 'in the Nether': 12 } }], { startKind: null, baseline: true });
		assert.deepEqual(readRun(older)[0].milestones, {});
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a long run scored before stage-score tracked the fortress leaves the late milestones unmeasured', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const dir = await longRun(root, 'old', { seed: '5', nether: 30 });
		const [run] = readRun(dir);
		assert.deepEqual(Object.keys(run.milestones), ['ironPickaxe', 'bucket', 'flintAndSteel', 'lavaSeen', 'portalLit', 'nether']);
		const report = buildGate({ gate: 'old', title: 'old', cohorts: [{ name: 'a', label: 'a', dirs: [dir] }] });
		assert.equal(report.cohorts[0].funnel.fortress, undefined);
		assert.equal(report.cohorts[0].nether, null);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a long run stopped short of its budget ends where the scorer saw it end, for recovery and censoring', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		// A 180-minute run stopped at 60: in the Nether at 40, died there at 50, never back before the stop.
		const samples = [sample(0, OVER, 0, 0, 0), sample(39, OVER, 100, 0, 0), sample(40, NETHER, 12, 0, 0), sample(49, NETHER, 30, 0, 0),
			sample(50, OVER, 100, 50, 1), sample(60, OVER, 90, 50, 1)];
		const dir = await longRun(root, 'stopped', { seed: '9', nether: 40, windowMin: 180, endMin: 60, samples });
		const [run] = readRun(dir);
		assert.deepEqual(run.nether.deaths, [{ minute: 50, respawnBlocks: 50, returned: false, backMin: 10 }]);
		assert.equal(run.windowMin, 180);
		assert.equal(run.playedMin, 60);
		// It never made flint and steel: censored at the 60 minutes it played, flagged early.
		const [cohort] = buildGate({ gate: 'x', title: 'x', cohorts: [{ name: 'x', label: 'x', dirs: [dir] }] }).cohorts;
		assert.equal(cohort.funnel.flintAndSteel.censoredEarly, 1);
		// A score that names no observed end keeps the planned end and leaves the minutes played unknown.
		const old = await longRun(root, 'old', { seed: '9', windowMin: 180 });
		assert.equal('playedMin' in readRun(old)[0], false);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('each game carries its model, effort and stop rule, and cohorts of different models are compared only on purpose', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const arm = async (name, model, effort = 'low') => [
			await longRun(root, `${name}-1`, { seed: '1', iron: 10, model, effort, stop: { kind: 'window', reason: 'WALL_CLOCK_BUDGET' } }),
			await longRun(root, `${name}-2`, { seed: '2', iron: null, model, effort, endMin: 25, stop: { kind: 'cap', reason: 'SPEND_CAP' } }),
		];
		const sol61 = await arm('a', 'gpt-6.1-sol'), sol62 = await arm('b', 'gpt-6.2-sol'), medium = await arm('c', 'gpt-6.1-sol', 'medium');
		const [game] = readRun(sol62[1]);
		assert.equal(game.model, 'codex gpt-6.2-sol low');
		assert.deepEqual([game.provider, game.modelId, game.effort, game.stopKind, game.stopReason], ['codex', 'gpt-6.2-sol', 'low', 'cap', 'SPEND_CAP']);
		const cohorts = (second) => [{ name: 'sol61', label: '6.1 low', dirs: sol61 }, { name: 'other', label: 'other arm', dirs: second }];
		assert.throws(() => buildGate({ gate: 'cp1', title: 't', cohorts: cohorts(sol62) }), /sol61 → other: the cohorts ran different models or efforts \(codex gpt-6\.1-sol low against codex gpt-6\.2-sol low\); pass --allow-model-mismatch/);
		assert.throws(() => buildGate({ gate: 'cp1', title: 't', cohorts: cohorts(medium) }), /different models or efforts/, 'effort counts too');
		assert.throws(() => buildGate({ gate: 'cp1', title: 't', cohorts: cohorts([...sol61, ...sol62]) }), /different models or efforts/, 'a cohort that mixes models matches nothing');
		const report = buildGate({ gate: 'cp1', title: 't', cohorts: cohorts(sol62), allowModelMismatch: true });
		assert.deepEqual(report.comparisons[0].profileMismatch, { before: ['codex gpt-6.1-sol low'], after: ['codex gpt-6.2-sol low'] });
		assert.ok(report.notes.some((note) => /sol61 → other compares different models or efforts on purpose/.test(note)));
		assert.deepEqual([report.cohorts[1].modelId, report.cohorts[1].effort], ['gpt-6.2-sol', 'low']);
		assert.deepEqual(report.cohorts[1].stops, { cap: 1, window: 1 });
		// The game that missed the iron pickaxe stopped 15 min short of its window on the spend cap.
		assert.deepEqual(report.cohorts[1].funnel.ironPickaxe.censoredEarlyBy, { cap: 1, stall: 0, other: 0, unrecorded: 0 });
		assert.deepEqual(buildGate({ gate: 'same', title: 't', cohorts: [{ name: 'x', label: 'x', dirs: [sol61[0]] }, { name: 'y', label: 'y', dirs: [sol61[1]] }] }).comparisons[0].profileMismatch, undefined);
		const unknownEffort = await longRun(root, 'd-1', { seed: '1', iron: 10, effort: null });
		assert.throws(() => buildGate({ gate: 'u', title: 't', cohorts: [{ name: 'x', label: 'x', dirs: [sol61[0]] }, { name: 'y', label: 'y', dirs: [unknownEffort] }] }), /unknown/, 'an unrecorded effort is not a match');
		assert.equal(parseCli(['--gate', '1', '--allow-model-mismatch', '--cohort', 'a', 'A', 'dir']).allowModelMismatch, true);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('games censored early split into cap, stall, other and unrecorded stops', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const dir = await standardRound(root, [
			// The round runner's own wording for a round-wide cap stop.
			{ id: 'game-1', seed: '1', minute: 120, stages: { 'iron pickaxe': 5 }, reason: 'round hard spend cap reached' },
			{ id: 'game-2', seed: '2', minute: 130, stages: { 'iron pickaxe': 6 }, reason: 'OPERATOR_STALL_45MIN' },
			{ id: 'game-3', seed: '3', minute: 90, stages: { 'iron pickaxe': 7 }, reason: 'ENDED_EARLY:RUNNER_ERROR' },
			{ id: 'game-4', seed: '4', minute: 100, stages: { 'iron pickaxe': 8 } },
			{ id: 'game-5', seed: '5', minute: 180, stages: { 'iron pickaxe': 9 }, reason: 'WALL_CLOCK_BUDGET' },
		]);
		const runs = readRun(dir);
		assert.deepEqual(runs.map((run) => run.stopKind), ['cap', 'stall', 'other', null, 'window']);
		const [cohort] = buildGate({ gate: 'r9', title: 'round 9', cohorts: [{ name: 'r9', label: 'round 9', dirs: [dir] }] }).cohorts;
		assert.equal(cohort.funnel.nether.censoredEarly, 4);
		assert.deepEqual(cohort.funnel.nether.censoredEarlyBy, { cap: 1, stall: 1, other: 1, unrecorded: 1 });
		assert.deepEqual(cohort.stops, { cap: 1, other: 1, stall: 1, unrecorded: 1, window: 1 });
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('a round game counts deaths by cause, reading the cause of a counter-only death from its receipt at a later goal revision', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'gate-report-'));
	try {
		const dead = (minute, goalRevision, cause, agentId = 'agent-a') => ({ observedAtMs: T0 + minute * MIN + 100, envelope: { type: 'goal_control', agentId,
			payload: { operation: 'dead', goalRevision, updatedAtEpochMs: T0 + minute * MIN, death: { cause, diedAtEpochMs: T0 + minute * MIN } } } });
		// The round runner kept receipts of the starting revision only; the later two deaths it saw only as death counter steps.
		const dir = await standardRound(root, [{ id: 'game-1', seed: '777', stages: {}, agentId: 'agent-a', deaths: [
			{ at: T0 + 10 * MIN, cause: 'ha_x was shot by Skeleton', source: 'goal_control' },
			{ at: T0 + 30 * MIN + 4000, cause: 'unknown (counter only)', source: 'counter', counterOrdinal: 2 },
			{ at: T0 + 50 * MIN + 2000, cause: 'unknown (counter only)', source: 'counter', counterOrdinal: 3 },
		], raw: {
			'quality-protocol.jsonl': [dead(10, 1, 'ha_x was shot by Skeleton'), dead(30, 2, 'ha_x tried to swim in lava to escape Zombified Piglin'),
				dead(50, 3, 'ha_x was burned to a crisp while fighting Blaze'), dead(40, 1, 'ha_y was slain by Zombie', 'agent-b'), dead(70, 4, 'ha_x drowned')],
		} }, { id: 'game-2', seed: '778', stages: {}, deaths: 1 }]);
		const [first, second] = readRun(dir);
		assert.equal(first.deaths, 3, 'the death after the game stopped is not this game\'s');
		assert.deepEqual(first.deathCauses, { skeleton_arrow: 1, lava: 1, fire: 1 });
		assert.deepEqual(second.deathCauses, { other: 1 }, 'a named cause the classifier does not know is other, not unknown');
		const [cohort] = buildGate({ gate: 'r9', title: 'round 9', cohorts: [{ name: 'r9', label: 'round 9', dirs: [dir] }] }).cohorts;
		assert.deepEqual(cohort.deathCauses, { skeleton_arrow: 1, lava: 1, fire: 1, other: 1 });
	} finally { await rm(root, { recursive: true, force: true }); }
});
