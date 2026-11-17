import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { buildGate, readRun, compare, verdict, SCHEMA } from '../../scripts/quality/gate-report.mjs';
import { findGateFunnel, collectReplays } from '../../scripts/quality/lib/stake-comparison.mjs';
import { formatFunnel, formatReplays } from '../src/decision-eval/stake-summary.mjs';

const T0 = 1_794_170_000_000, MIN = 60_000;
const milestone = (at) => ({ firstObservedAt: at === null ? null : T0 + at * MIN, reached: at !== null });
const SHA = 'e62adcea2c08e42973c9e1a928358ab19b043ccc';

/** A long-run folder as the farm saves it: stage-score, long-run, the runner's log beside it, and a decision log. */
async function longRun(root, name, { seed, iron = null, bucket = null, flint = null, nether = null, afterDeathIron = null, deaths = 0, usd = 1.5, log = [] }) {
	const dir = path.join(root, name);
	await mkdir(path.join(dir, 'raw'), { recursive: true });
	const lives = { firstLife: { milestones: { iron_pickaxe: milestone(iron), bucket: milestone(bucket), flint_and_steel: milestone(flint), nether: milestone(nether) } },
		afterDeath: { milestones: { iron_pickaxe: milestone(afterDeathIron) } } };
	await writeFile(path.join(dir, 'stage-score.json'), JSON.stringify({ window: { startedAt: T0, windowMs: 40 * MIN }, identity: { seed }, observedDeaths: deaths, ...lives }));
	await writeFile(path.join(dir, 'long-run.json'), JSON.stringify({ seed, windowMs: 40 * MIN, profile: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low' }, spend: { usd } }));
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
		assert.deepEqual(cohort.funnel.ironPickaxe, { reached: 2, total: 2, medianMin: 7.8, runs: { reached: 3, total: 4 } });
		assert.deepEqual(cohort.repeats.map((row) => [row.seed, row.flipped]), [['1', ['ironPickaxe']], ['2', []]]);
		assert.match(report.notes.join(' '), /No pair/);
	} finally { await rm(root, { recursive: true, force: true }); }
});

test('pairs: under 2 seeds is "no change", and seeds only one side ran are named', () => {
	assert.equal(verdict(1), 'no change');
	assert.equal(verdict(-1), 'no change');
	assert.equal(verdict(2), 'better');
	assert.equal(verdict(-2), 'worse');
	const run = (seed, iron) => ({ seed, milestones: { ironPickaxe: iron } });
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
	assert.deepEqual(product.gate.comparison.milestones.ironPickaxe, { before: 7, after: 8, total: 8, diff: 1, verdict: 'no change', beforeMedianMin: 8, afterMedianMin: 8.5 });
	const text = formatFunnel(product).join('\n');
	assert.match(text, /\| Milestone \| Seeds \| Median \| gate3 → gate4 \|/);
	assert.match(text, /\| 7 → 8 no change \|/);
	assert.match(text, /Noise: 8 paired seeds with gate 3;/);
	const other = { ...base, 'docs/gates/gate-3.json': JSON.stringify({ ...gate3, cohorts: [{ ...gate3.cohorts[0], windowMin: 20 }] }) };
	assert.equal((await findGateFunnel({ base: 'base', evaluated: 'merge' }, fakeGit({ base: other, merge: other }))).gate.comparison, null);
});

test('a pair uses each seed\'s first run, so a cohort run twice gets no second chance', () => {
	const run = (seed, iron) => ({ seed, milestones: { ironPickaxe: iron } });
	const twice = { name: 'round1', runs: [run('1', null), run('1', 5), run('2', 4), run('2', null)] };
	const once = { name: 'round2', runs: [run('1', null), run('2', 4)] };
	assert.equal(compare(twice, once).milestones.ironPickaxe.before, 1);
});

test('scripted repeats are labelled scripted, and an unknown commit is not "mixed"', () => {
	const product = { gate: { gate: 5, source: 'base', comparison: null, cohort: { label: 'x', commit: null, seeds: 8, mode: 'model', funnel: {}, deaths: 0, costUsd: 0 } },
		repeats: { cohorts: [{ label: '#178 round 1', mode: 'scripted', windowMin: 15, seeds: 8, flipped: 3, milestones: ['ironPickaxe'] }] } };
	const text = formatFunnel(product).join('\n');
	assert.match(text, /`unknown commit`/);
	assert.match(text, /repeats \(scripted runs, no model, 15 min\): #178 round 1, 3 of 8 seeds flipped \(iron pickaxe\)/);
	assert.match(formatFunnel({ ...product, gate: { ...product.gate, cohort: { ...product.gate.cohort, commit: ['a', 'b'] } } }).join('\n'), /`mixed commits`/);
});
