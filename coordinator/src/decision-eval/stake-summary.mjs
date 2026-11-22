export const STAKE_MARKER = '<!-- arena-gameplay-stake:v1 -->';
const bar = (n, total) => '█'.repeat(n) + '░'.repeat(Math.max(0, total - n));
const safe = value => String(value).replace(/[|\r\n]/g, ' ');

// Funnel order and labels match scripts/quality/gate-report.mjs MILESTONES.
const FUNNEL = [['ironPickaxe', 'Iron pickaxe'], ['bucket', 'Bucket'], ['flintAndSteel', 'Flint and steel'], ['lavaSeen', 'Lava seen'], ['portalLit', 'Portal lit'], ['nether', 'Nether'],
	['fortress', 'Fortress found'], ['blazeRods', 'Blaze rods'], ['enderPearls', 'Ender pearls']];
const short = sha => typeof sha === 'string' ? sha.slice(0, 8) : Array.isArray(sha) ? 'mixed commits' : 'unknown commit';
const seedBar = (n, total) => total > 10 ? bar(Math.round(n / total * 10), 10) : bar(n, total);

/** The product funnel from a gate report (see findGateFunnel), with pairs, repeats and the noise rule. */
export function formatFunnel(product, base) {
	const gate = product?.gate;
	if (!gate) return [`Product: **no gate report** ${base ? `on base \`${short(base.sha)}\`` : '(base not selected)'}. Build one with scripts/quality/gate-report.mjs.`];
	const { cohort, comparison } = gate;
	const link = gate.url ? ` · [report](${gate.url})` : '';
	const lines = [`**Product: gate ${safe(gate.gate)}** (${gate.source === 'this PR' ? 'from this PR' : 'newest on base'}) · ${safe(cohort.label)} \`${short(cohort.commit)}\``
		+ ` · ${cohort.seeds} seeds · ${cohort.mode === 'scripted' ? 'scripted' : safe(cohort.model ?? 'model')} · ${cohort.windowMin ?? '?'} min${cohort.ranAt ? ` · ran ${cohort.ranAt}` : ''}${link}`, ''];
	const pair = comparison ? ` ${safe(comparison.before)} → ${safe(comparison.after)} |` : '';
	lines.push(`| Milestone | Seeds | Median |${pair}`, `|---|---|---:|${comparison ? '---|' : ''}`);
	for (const [key, label] of FUNNEL) {
		const row = cohort.funnel?.[key];
		if (!row) continue;
		const change = comparison?.milestones?.[key];
		lines.push(`| ${label} | ${seedBar(row.reached, row.total)} ${row.reached}/${row.total} | ${row.medianMin === null ? '–' : `${row.medianMin} min`} |`
			+ (comparison ? ` ${change ? `${change.before} → ${change.after} ${change.verdict}` : '–'} |` : ''));
	}
	const noise = [];
	if (!comparison) noise.push(`no pair (one commit ran gate ${safe(gate.gate)})`);
	else if (comparison.missingPairs?.length) noise.push(`${comparison.missingPairs.length} seed(s) without a pair`);
	else noise.push(`${comparison.pairedSeeds} paired seeds${comparison.acrossGate !== undefined ? ` with gate ${safe(comparison.acrossGate)}` : ''}`);
	for (const row of product.repeats?.cohorts ?? []) noise.push(`repeats${row.mode === 'scripted' ? ` (scripted runs, no model${row.windowMin ? `, ${row.windowMin} min` : ''})` : ''}: ${safe(row.label)}, ${row.flipped} of ${row.seeds} seeds flipped${row.milestones.length ? ` (${row.milestones.map(key => (FUNNEL.find(([name]) => name === key)?.[1] ?? key).toLowerCase()).join(', ')})` : ''}`);
	if (!product.repeats?.cohorts?.length) noise.push('no repeats on record');
	lines.push('', `Deaths ${cohort.deaths} · cost $${cohort.costUsd} (token-price estimate)`,
		`Noise: ${noise.join('; ')}. Rule of thumb: a difference under 2 seeds is "no change".`);
	return lines;
}

const replaySide = (side, pick) => side?.error ? 'not comparable' : pick(side);
/** Both log replays, base → head. "no corpus" when this machine has no gate 3 logs. */
export function formatReplays(replays) {
	if (replays === undefined) return [];
	if (replays.error) return [`Replays: not run (${safe(replays.error)}).`];
	if (!replays.corpus) return ['Replays on gate 3 logs: **no corpus** (no gate 3 logs on this machine).'];
	const pair = (entry, pick) => `${replaySide(entry.base, pick)} → ${replaySide(entry.head, pick)}`;
	const { searchDanger: danger, portalRoute: portal } = replays;
	const errors = [['search danger', danger], ['portal route', portal]].flatMap(([name, entry]) => ['base', 'head'].filter(side => entry[side]?.error).map(side => `${name} ${side}: ${safe(entry[side].error).replace(/ imported from .*$/, '').replace(/'[^']*\/coordinator\/src\//, "'coordinator/src/").slice(0, 120)}`));
	return [`**Replays on gate 3 logs** (${replays.corpus} games, no model calls), base → head:`,
		`- Search danger: mob hand-backs ${pair(danger, s => s.mobHandBacks)} · all danger hand-backs ${pair(danger, s => s.handBacks)} (of ${danger.head?.recorded ?? danger.base?.recorded ?? '?'} recorded)`,
		`- Portal route: kit wakes shown the next portal step ${pair(portal, s => s.portalStep)} · food detours ${pair(portal, s => s.foodDetour)} (of ${portal.head?.wakes ?? portal.base?.wakes ?? '?'} wakes)`,
		...(errors.length ? [`- Not comparable: ${errors.join('; ')}`] : [])];
}

/**
 * Two separate results: whether the head passes (invariants and expectations; this alone sets pass/fail),
 * and whether the base could be compared. An incomparable base reads "not comparable" and is neutral.
 */
export function baseState(report) {
	if (report.base === undefined) return 'not compared';
	return report.baseComparable === false || report.comparisonError ? 'not comparable' : 'compared';
}

/**
 * What the stake can speak for in this diff. It replays recorded episodes through the coordinator's decision code
 * (coordinator/src), never Java, scripts, instructions or a model, so a diff with no coordinator/src change is "not
 * covered" (the green it posts says only that nothing it replays changed), and a mixed diff is "partly covered".
 * changed: the diff's file paths, or null when the diff could not be read.
 */
/**
 * The coordinator code a stake replay can reach: coordinator/src, without the parts it never loads (traced 23 Nov:
 * benchmark harnesses, the decision-eval tooling, the simulator, voice, headless launchers, process helpers, scripts).
 */
export const decisionCode = file => /^coordinator\/src\//.test(file) && !/\.ps1$/.test(file)
	&& !/^coordinator\/src\/(benchmark|decision-eval|simulator|voice)\//.test(file) && !/^coordinator\/src\/(headless-[^/]*|posix-process-[^/]*)$/.test(file);

export function stakeCoverage(changed) {
	if (!Array.isArray(changed)) return { state: 'unknown', short: 'coverage unknown', line: 'Coverage unknown: the changed files could not be listed.' };
	// Tests and docs change no behaviour. The in-game agent's instructions (coordinator/config: AGENTS.md, SKILL.md,
	// references) are Markdown that changes how the bot plays, so they count as code.
	const neutral = file => /^(coordinator\/test|src\/test|src\/compat\/[^/]+\/test)\//.test(file) || /^docs\//.test(file) || (/\.md$/i.test(file) && !/^coordinator\/config\//.test(file));
	const code = changed.filter(file => !neutral(file));
	const covered = code.filter(decisionCode);
	const java = code.filter(file => /\.java$/.test(file));
	const count = (n, what) => `${n} ${what}${n === 1 ? '' : 's'}`;
	if (!code.length) return { state: 'no code change', covered: 0, code: 0, java: 0, short: 'no code change', line: `Coverage: no code change (${count(changed.length, 'file')}: tests and docs only).` };
	if (!covered.length) {
		const javaOnly = java.length === code.length;
		return { state: 'not covered', covered: 0, code: code.length, java: java.length, short: `not covered (${javaOnly ? 'Java-only diff' : 'no decision-code change'})`,
			line: `Coverage: **not covered**. ${count(code.length, 'changed code file')}${java.length ? ` (${java.length} Java)` : ''}, none in the coordinator decision code, which is all the stake replays. A pass here says nothing about this change.` };
	}
	if (covered.length < code.length) return { state: 'partly covered', covered: covered.length, code: code.length, java: java.length, short: `partly covered (${covered.length} of ${code.length} code files)`,
		line: `Coverage: **partly covered**. ${covered.length} of ${count(code.length, 'changed code file')} ${covered.length === 1 ? 'is' : 'are'} coordinator decision code, which the stake replays; ${code.length - covered.length === 1 ? 'the other is' : `the other ${code.length - covered.length} are`} not exercised${java.length ? ` (${java.length} Java)` : ''}.` };
	return { state: 'covered', covered: covered.length, code: code.length, java: 0, short: `covers ${count(covered.length, 'decision-code file')}`, line: `Coverage: every changed code file (${covered.length}) is coordinator decision code, which the stake replays.` };
}

export function stakeHeadline(report) {
	const accepted = report.results.filter(row => row.matches && row.invariant && !row.error).length;
	const state = baseState(report), compared = state === 'compared';
	const same = compared ? report.results.filter(row => row.baseSame).length : accepted;
	const diffs = compared ? report.results.length - same : null;
	// Coverage leads, so a green status on a change the stake never runs reads "not covered" in the checks list. An
	// unknown coverage (git could not list the diff) makes no claim there and is said in the comment.
	const coverage = report.changedFiles === undefined ? null : stakeCoverage(report.changedFiles);
	return { accepted, same, diffs, headPasses: report.pass === true, baseState: state, coverage,
		description: `${coverage && coverage.state !== 'unknown' ? `${coverage.short} · ` : ''}${report.pass ? 'head passes' : 'head fails'} · ${same}/${report.results.length} ${compared ? 'same' : 'accepted'} · ${compared ? `${diffs} diffs` : `base ${state}`} · ${Math.round(report.wallMs)} ms` };
}

export function formatStake(report, { summaryUrl = report.summaryUrl } = {}) {
	const { accepted, same, description, coverage } = stakeHeadline(report);
	const metric = (row, key) => `${row.baseMetrics?.[key] ?? '?'} → ${row.metrics?.[key] ?? '?'}`;
	return [STAKE_MARKER, '## Gameplay stake', '', `${report.pass ? '✅' : '❌'} **Stake ${bar(same, report.results.length)} ${description}**`,
		`Expected: ${accepted}/${report.results.length} accepted · ${report.coverageGaps?.length ?? 0} coverage gap(s) · 0 Minecraft boots / model calls`, '',
		...(coverage ? [coverage.line, ''] : []),
		...formatFunnel(report.product, report.base), '', ...formatReplays(report.replays), ...(report.replays === undefined ? [] : ['']),
		...(Number.isFinite(report.checkMs) ? [`Whole check: ${(report.checkMs / 1000).toFixed(1)} s (stake, base checkout, both replays, funnel).`, ''] : []),
		...(report.base ? [`Base: \`${report.base.sha.slice(0, 8)}\` · head: \`${report.head?.slice(0, 8) ?? 'working tree'}\``
			+ (report.evaluated && report.evaluated !== report.head ? ` · evaluated merge: \`${report.evaluated.slice(0, 8)}\`` : ''), ''] : []),
		'| Episode | Hold | Steer | Hand-back | Invariant |', '|---|---:|---:|---:|---|',
		...report.results.map(row => `| ${safe(row.id)}${row.baseSame === false ? ' Δ' : ''} | ${metric(row, 'holds')} | ${metric(row, 'steers')} | ${metric(row, 'handBacks')} | ${row.invariant && !row.error ? 'pass' : '❌ ' + safe(row.error ?? 'failed')} |`), '',
		...(report.comparisonError ? ['', 'Base not comparable (neutral; the head result above stands): ' + safe(report.comparisonError)] : []),
		'Counts: base → head. Δ is a reviewable decision change; ❌ marks failed or incomplete invariants.',
		...(report.base === undefined ? ['Base not compared in this raw test report. The local check command selects the PR base.'] : []),
		...(report.coverageGaps?.length ? ['','Coverage gaps: ' + report.coverageGaps.map(gap => safe(gap.id)).join(', ') + '. Recorded-fact reconstruction; not historical fidelity.'] : []),
		...(summaryUrl ? ['', `[Full step summary](${summaryUrl})`] : []),
		...(report.results.some(row => !row.matches && !row.error) ? ['', '<details><summary>Expectation diffs</summary>', '', ...report.results.filter(row => !row.matches && !row.error).map(row => `**${safe(row.id)}**\n\n\`\`\`json\n${JSON.stringify({ expected: row.expected, actual: { decisions: row.decisions, commands: row.commands, returned: row.returned } }, null, 2).slice(0, 8000)}\n\`\`\``), '</details>'] : [])].join('\n') + '\n';
}
