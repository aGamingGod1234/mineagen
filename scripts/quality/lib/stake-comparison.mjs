import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, cp, rm, readFile } from 'node:fs/promises';
import { existsSync, readdirSync } from 'node:fs';
import { tmpdir, homedir } from 'node:os';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { runStake, expectedDecisions } from '../../../coordinator/src/decision-eval/decision-stake.mjs';
import { SCHEMA, decisionFiles, compare, profileMismatch } from '../gate-report.mjs';
import { loadDangerCorpus, replaySearchDanger } from '../search-danger-replay.mjs';
import { loadPortalCorpus, replayPortalRoute } from '../portal-route-replay.mjs';
const exec = promisify(execFile);
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
export const git = async (...args) => (await exec('git', args, { cwd: REPO_ROOT, maxBuffer: 32 * 1024 * 1024, timeout: 30000 })).stdout.trim();
export const gh = async (...args) => {
	const options = typeof args.at(-1) === 'object' ? args.pop() : {};
	const pending = exec('gh', args, { cwd: REPO_ROOT, maxBuffer: 8 * 1024 * 1024, timeout: 30000 });
	if (options.input !== undefined) pending.child.stdin.end(options.input);
	return (await pending).stdout.trim();
};

// A shallow checkout keeps the commit object but not its parents, so read the parent lines directly.
async function parentsOf(ref) {
	try { return (await git('cat-file', '-p', ref)).split('\n').filter(line => line.startsWith('parent ')).map(line => line.slice(7)); } catch { return []; }
}

export function selectShas({ base, head, event, pull, evaluated, parents = [] }) {
	const headSha = head ?? event?.pull_request?.head.sha ?? evaluated;
	const mergeBase = parents.length === 2 && parents[1] === headSha && evaluated !== headSha ? parents[0] : null;
	return { head: headSha, base: base ?? mergeBase ?? pull?.base.sha ?? null };
}

/**
 * evaluated: the tree this checkout runs (in Actions, GitHub's PR merge commit).
 * head: the PR head SHA the status and comment belong to, taken from the event, never from the checkout.
 * base: what the evaluated tree is compared against. For GitHub's merge commit that is its first parent,
 * the base tip it was built on; otherwise the PR base from the event or GitHub.
 */
export async function resolveContext({ base, head, pr } = {}) {
	let event = null;
	if (process.env.GITHUB_EVENT_PATH) event = JSON.parse(await readFile(process.env.GITHUB_EVENT_PATH));
	let pull = event?.pull_request;
	if (!pull && (!base || pr)) {
		try {
			const row = JSON.parse(await gh('pr', 'view', ...(pr ? [String(pr)] : []), '--json', 'baseRefOid,headRefOid,number,url'));
			pull = { base: { sha: row.baseRefOid }, head: { sha: row.headRefOid }, number: row.number, html_url: row.url };
		} catch { /* A local branch can compare explicitly without GitHub access. */ }
	}
	const evaluated = await git('rev-parse', 'HEAD');
	const shas = selectShas({ base, head, event, pull, evaluated, parents: await parentsOf(evaluated) });
	return { base: shas.base ?? await git('merge-base', 'HEAD', 'origin/main'), head: shas.head, evaluated, pr: pr ?? pull?.number,
		repo: process.env.GITHUB_REPOSITORY ?? (await git('remote', 'get-url', 'origin')).replace(/^.*github.com[:/]/, '').replace(/\.git$/, ''),
		summaryUrl: process.env.GITHUB_RUN_ID ? `https://github.com/${process.env.GITHUB_REPOSITORY}/actions/runs/${process.env.GITHUB_RUN_ID}#summary` : null };
}

const GATE_FILE = /^docs\/gates\/gate-(\d+)\.json$/;
const REPEATS_FILE = /^docs\/gates\/repeats-[^/]+\.json$/;

/**
 * The comment's view of a gate report: its newest cohort's funnel, the last before → after, and the notes. A gate one
 * commit ran pairs with `previous` (the gate before it) when both ran the same seeds with the same model and window.
 */
export function summarizeGate(report, extra = {}, previous = null) {
	const cohort = report.cohorts.at(-1);
	return { gate: report.gate, title: report.title, rule: report.rule, notes: report.notes ?? [], comparison: report.comparisons?.at(-1) ?? pairAcross(previous, report),
		cohort: { name: cohort.name, label: cohort.label, commit: cohort.commit, mode: cohort.mode, model: cohort.model, windowMin: cohort.windowMin,
			ranAt: cohort.ranAt ?? null, seeds: cohort.seeds.length, funnel: cohort.funnel, deaths: cohort.deaths, costUsd: cohort.costUsd }, ...extra };
}

export function pairAcross(previous, report) {
	const before = previous?.cohorts?.at(-1), after = report.cohorts.at(-1);
	if (!before?.runs?.length || !after?.runs?.length || before.commit === after.commit) return null;
	if (['mode', 'model', 'windowMin'].some(key => JSON.stringify(before[key]) !== JSON.stringify(after[key]))) return null;
	// Games of different models or efforts never pair across gates, even when the cohort labels agree.
	if (profileMismatch(before, after)) return null;
	const comparison = compare(before, after);
	return comparison.pairedSeeds ? { ...comparison, acrossGate: previous.gate } : null;
}

/** Repeats: per cohort, how many seeds ran more than once on one commit and how many of those flipped a milestone. */
export function summarizeRepeats(report, extra = {}) {
	const cohorts = report.cohorts.filter(cohort => cohort.repeats?.length)
		.map(cohort => ({ name: cohort.name, label: cohort.label, mode: cohort.mode ?? null, windowMin: cohort.windowMin ?? null, seeds: cohort.repeats.length, flipped: cohort.repeats.filter(row => row.flipped.length).length,
			milestones: [...new Set(cohort.repeats.flatMap(row => row.flipped))] }));
	return { title: report.title, cohorts, ...extra };
}

/**
 * The product funnel for the comment: a gate report this PR adds or changes, else the newest gate on its base.
 * Only docs/gates/gate-N.json in the gate-report schema counts; nothing else supplies product numbers.
 */
export async function findGateFunnel({ base, evaluated, head = evaluated, repo }, run = git) {
	const touched = (await run('diff', '--name-only', base, evaluated, '--', 'docs/gates')).split('\n').filter(Boolean);
	const onBase = (await run('ls-tree', '-r', '--name-only', base, 'docs/gates')).split('\n').filter(Boolean);
	const read = async (ref, file) => { try { const parsed = JSON.parse(await run('show', `${ref}:${file}`)); return parsed.schema === SCHEMA ? parsed : null; } catch { return null; } };
	const newest = async (ref, files, pattern, below = Infinity) => {
		let best = null;
		for (const file of files.filter(name => pattern.test(name))) {
			const order = Number(pattern.exec(file)[1] ?? 0);
			if (order >= below) continue;
			const report = await read(ref, file);
			if (!report?.cohorts?.length) continue;
			if (!best || order > best.order || (order === best.order && file > best.file)) best = { report, file, order };
		}
		return best;
	};
	const url = (ref, file) => repo ? `https://github.com/${repo}/blob/${ref}/${file}` : null;
	const fromPr = await newest(evaluated, touched, GATE_FILE);
	// Links use the PR head: GitHub's merge commit is not a stable address for a file.
	const gate = fromPr ? { ...fromPr, ref: head, source: 'this PR' } : { ...(await newest(base, onBase, GATE_FILE)), ref: base, source: 'base' };
	const gateRef = gate.source === 'this PR' ? evaluated : base;
	const previous = gate.report && !gate.report.comparisons?.length
		? await newest(gateRef, gate.source === 'this PR' ? (await run('ls-tree', '-r', '--name-only', evaluated, 'docs/gates')).split('\n').filter(Boolean) : onBase, GATE_FILE, gate.order)
		: null;
	const repeatsFromPr = await newest(evaluated, touched, REPEATS_FILE);
	const repeats = repeatsFromPr ? { ...repeatsFromPr, ref: head } : { ...(await newest(base, onBase, REPEATS_FILE)), ref: base };
	return {
		gate: gate.report ? summarizeGate(gate.report, { file: gate.file, source: gate.source, url: url(gate.ref, gate.file) }, previous?.report) : null,
		repeats: repeats.report ? summarizeRepeats(repeats.report, { file: repeats.file, url: url(repeats.ref, repeats.file) }) : null,
	};
}

// The gate 3 games both replays were written against (#179, #181). ARENA_GATE_LOGS points at another sub/long folder.
const GATE3_RUN = /^gate3-\d+-codex$/;
export function gateLogDirs(root = process.env.ARENA_GATE_LOGS ?? path.join(homedir(), 'Desktop/Projects/arena-beat-game/sub/long')) {
	if (!existsSync(root)) return [];
	return readdirSync(root).filter(name => GATE3_RUN.test(name)).sort().map(name => path.join(root, name))
		.filter(dir => decisionFiles(path.join(dir, 'raw')).length > 0 && existsSync(path.join(dir, 'raw', 'quality-samples.jsonl')));
}

const loadTree = root => file => import(pathToFileURL(path.join(root, 'coordinator/src', file)).href);

/**
 * Both log replays over one parsed corpus, judged with the base tree's modules and then the head's. A side whose
 * modules cannot load reads not comparable; it never changes the stake result.
 */
export async function collectReplays({ dirs = gateLogDirs(), loadBase = null, loadHead = loadTree(REPO_ROOT) } = {}) {
	if (dirs.length === 0) return { corpus: 0 };
	const [dangerCorpus, portalCorpus] = [loadDangerCorpus(dirs), await loadPortalCorpus(dirs)];
	const side = async (load, judge) => {
		if (!load) return { error: 'base tree not checked out' };
		try { return await judge(load); } catch (error) { return { error: error.message }; }
	};
	const danger = async load => {
		const [{ searchDanger }, { decodeModelFacts }] = await Promise.all([load('search-danger.mjs'), load('model-fact-encoding.mjs')]);
		const { summary } = replaySearchDanger(dangerCorpus, { searchDanger, decodeModelFacts });
		return { mobHandBacks: summary.mobHandBacks.after, handBacks: summary.handBacks.after, recorded: summary.handBacks.before };
	};
	const portal = async load => {
		const [{ routeLine }, { emptyKnown, evaluatePlanCheck }] = await Promise.all([load('skill-fits.mjs'), load('plan-checks.mjs')]);
		const { totals } = replayPortalRoute(portalCorpus, { routeLine, emptyKnown, evaluatePlanCheck });
		return { portalStep: totals.newPortal, foodDetour: totals.newFood, wakes: totals.wakes };
	};
	return { corpus: dirs.length, games: dirs.map(dir => path.basename(dir)),
		searchDanger: { base: await side(loadBase, danger), head: await side(loadHead, danger) },
		portalRoute: { base: await side(loadBase, portal), head: await side(loadHead, portal) } };
}

// replays: true runs both log replays over the gate 3 logs on this machine (CI and check.mjs); tests pass false.
export async function collectComparison(context, { incident = null, root, git: run = git, replays = run === git } = {}) {
	const started = performance.now();
	const report = await runStake({ incident, root });
	const dir = await mkdtemp(path.join(tmpdir(), 'gameplay-stake-base-')), tree = path.join(dir, 'base');
	let added = false, loadBase = null;
	try {
		try { await run('cat-file', '-e', `${context.base}^{commit}`); } catch { await run('fetch', '--no-tags', '--depth=1', 'origin', context.base); }
		await run('worktree', 'add', '--detach', tree, context.base); added = true;
		await cp(path.join(REPO_ROOT, 'coordinator/node_modules'), path.join(tree, 'coordinator/node_modules'), { recursive: true });
		const load = loadBase = loadTree(tree);
		const [{ createDynamicCoordinator }, { searchDanger }, { FactLedger }] = await Promise.all([load('dynamic-main.mjs'), load('search-danger.mjs'), load('fact-ledger.mjs')]);
		const baseline = await runStake({ incident, root, replayOptions: { createCoordinator: createDynamicCoordinator, judgeDanger: searchDanger, Ledger: FactLedger } });
		for (const row of report.results) {
			const old = baseline.results.find(old => old.id === row.id);
			if (!old || old.error) throw new Error(`Base episode ${row.id} unsupported: ${old?.error ?? 'missing'}`);
			row.baseSame = JSON.stringify(expectedDecisions(row)) === JSON.stringify(expectedDecisions(old));
			row.baseMetrics = old.metrics;
		}
	} catch (error) {
		// An incomparable base is neutral: it neither fails a passing head nor rescues a failing one.
		report.comparisonError = error.message;
		for (const row of report.results) { delete row.baseSame; delete row.baseMetrics; }
	}
	try {
		// The base tree stays checked out for the replays; an undecidable decision base does not hide their numbers.
		if (replays) report.replays = await collectReplays({ loadBase });
	} catch (error) { report.replays = { error: error.message }; } finally {
		if (added) await run('worktree', 'remove', '--force', tree).catch(() => {});
		await rm(dir, { recursive: true, force: true });
	}
	report.baseComparable = report.comparisonError === undefined;
	report.base = { sha: context.base }; report.head = context.head; report.evaluated = context.evaluated ?? context.head; report.summaryUrl = context.summaryUrl;
	// The PR head object is not in a merge checkout; the evaluated merge carries the head's files.
	try { report.product = await findGateFunnel({ base: context.base, evaluated: report.evaluated, head: context.head, repo: context.repo }, run); } catch { report.product = null; }
	// What the diff changed, for the coverage line: the working tree against the base (the stake runs the working tree;
	// in CI it is the evaluated merge), from the merge base so a base that moved on is not counted as this change. null
	// (unknown) when git cannot list it, never "covered".
	try {
		const from = (await run('merge-base', context.base, 'HEAD').catch(() => '')).trim() || context.base;
		report.changedFiles = (await run('diff', '--name-only', from)).split('\n').map(line => line.trim()).filter(Boolean);
	} catch { report.changedFiles = null; }
	report.checkMs = Math.round(performance.now() - started);
	return report;
}
