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

export function stakeHeadline(report) {
	const accepted = report.results.filter(row => row.matches && row.invariant && !row.error).length;
	const state = baseState(report), compared = state === 'compared';
	const same = compared ? report.results.filter(row => row.baseSame).length : accepted;
	const diffs = compared ? report.results.length - same : null;
	return { accepted, same, diffs, headPasses: report.pass === true, baseState: state,
		description: `${report.pass ? 'head passes' : 'head fails'} · ${same}/${report.results.length} ${compared ? 'same' : 'accepted'} · ${compared ? `${diffs} diffs` : `base ${state}`} · ${Math.round(report.wallMs)} ms` };
}

export function formatStake(report, { summaryUrl = report.summaryUrl } = {}) {
	const { accepted, same, description } = stakeHeadline(report);
	const metric = (row, key) => `${row.baseMetrics?.[key] ?? '?'} → ${row.metrics?.[key] ?? '?'}`;
	return [STAKE_MARKER, '## Gameplay stake', '', `${report.pass ? '✅' : '❌'} **Stake ${bar(same, report.results.length)} ${description}**`,
		`Expected: ${accepted}/${report.results.length} accepted · ${report.coverageGaps?.length ?? 0} coverage gap(s) · 0 Minecraft boots / model calls`, '',
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
