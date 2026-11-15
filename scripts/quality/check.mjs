#!/usr/bin/env node
import { parseArgs } from 'node:util';
import { printStake } from '../../coordinator/src/decision-eval/decision-stake.mjs';
import { resolveContext, collectComparison, git } from './lib/stake-comparison.mjs';
import { scoreStageRun } from './stage-score.mjs';

try {
	const { values } = parseArgs({ options: { incident: { type: 'string' }, base: { type: 'string' }, report: { type: 'string' }, help: { type: 'boolean' } } });
	if (values.help) {
		console.log(`Usage: node scripts/quality/check.mjs [--incident ID] [--base REF] | --report RUN_DIR
Default: offline decision stake vs the PR base (or origin/main merge-base); prints the CI/PR headlines.
--base REF selects a base without GitHub. No Minecraft or model calls.
Edit loop: use the selected incident, get counts from --report, run the full matrix only at the product gate.
The stake uses recorded-fact reconstructions; it does not simulate world or model outcomes.
Expectation changes update expected.json plus a one-line PR reason; critical danger and incomplete evidence remain red.
End the gameplay brief with three lines in docs/gameplay-friction/<pr>-<slug>.md.`);
	} else if (values.report) {
		if (values.incident) throw new Error('Choose --report or --incident');
		const score = await scoreStageRun(values.report);
		console.log(JSON.stringify(score, null, 2));
		if (score.measurementStatus === 'INVALID') process.exitCode = 2;
	} else {
		const context = await resolveContext({ base: values.base });
		context.base = await git('rev-parse', context.base);
		const report = await collectComparison(context, { incident: values.incident ?? null });
		await printStake(report);
		process.exitCode = report.results.some(row => row.error) || report.results.length === 0 ? 2 : report.pass ? 0 : 1;
	}
} catch (error) { console.error(error.message); process.exitCode = 2; }
