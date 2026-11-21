// The tier-1 decision test's comparison with a baseline run (tier1.mjs), on its own so it can be tested without a run.
export function rate(row) { return row.graded > 0 ? row.good / row.graded : null; }
export function mean(values) { const v = values.filter((x) => x !== null); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; }

/**
 * Paired two-level bootstrap, fixed seed: cases are resampled within each category, and each drawn case's answers are
 * redrawn from its own good rate (smoothed, so 0/3 and 3/3 cases still vary) in both runs, so the interval carries the noise of only 3-6 answers per case as well
 * as the choice of cases (a cases-only bootstrap flagged a 14-point travel swing between two runs of one build).
 */
export function compare(candidate, baseline) {
	const notes = [];
	for (const key of ['model', 'effort', 'provider']) if (candidate.profile[key] !== baseline.profile?.[key]) notes.push(`baseline ${key} ${baseline.profile?.[key]} differs from ${candidate.profile[key]}`);
	if (candidate.wording !== baseline.wording) notes.push(`baseline wording ${baseline.wording}, this run ${candidate.wording}`);
	const pairs = {};
	// A case in both runs with no graded answer in one of them (it would not render, its calls failed, the judge left it
	// ungraded) cannot be paired: its category's change is never called real, since the cases left could be the lucky ones.
	const ungradedIn = {};
	for (const [id, row] of Object.entries(candidate.cases)) {
		const base = baseline.cases?.[id];
		if (!base) continue;
		if (rate(row) === null || rate(base) === null) { ungradedIn[row.category] = (ungradedIn[row.category] ?? 0) + 1; continue; }
		(pairs[row.category] ??= []).push([row, base]);
	}
	const ungraded = Object.values(ungradedIn).reduce((n, k) => n + k, 0);
	if (ungraded) notes.push(`${ungraded} cases in both runs have no graded answer in one of them; their categories are not called real`);
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
		categories[category] = { delta: delta(rows), low, high, pairedCases: rows.length, ungradedCases: ungradedIn[category] ?? 0, real: !ungradedIn[category] && (low > 0 || high < 0) };
	}
	const overallDraws = draws.map((d) => mean(Object.values(d)));
	const [low, high] = interval(overallDraws);
	const overallDelta = mean(Object.values(categories).map((c) => c.delta));
	return { baselineCommit: baseline.commit, baselineGeneratedAt: baseline.generatedAt, overall: { delta: overallDelta, low, high, real: !ungraded && (low > 0 || high < 0) }, categories, notes };
}
