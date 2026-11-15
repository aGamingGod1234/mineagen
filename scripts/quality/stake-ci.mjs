#!/usr/bin/env node
import { writeFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { pathToFileURL } from 'node:url';
import { resolveContext, collectComparison, gh } from './lib/stake-comparison.mjs';
import { printStake } from '../../coordinator/src/decision-eval/decision-stake.mjs';
import { formatStake, stakeHeadline, STAKE_MARKER } from '../../coordinator/src/decision-eval/stake-summary.mjs';

export async function publishStake(context, report, { api = gh } = {}) {
	// A superseded workflow must never overwrite the current PR's sticky comment/status.
	const pull = JSON.parse(await api('api', `repos/${context.repo}/pulls/${context.pr}`));
	if (pull.head.sha !== context.head) throw new Error('Superseded PR head; refusing publication');
	const body = formatStake(report);
	const pages = JSON.parse(await api('api', '--paginate', '--slurp', `repos/${context.repo}/issues/${context.pr}/comments?per_page=100`));
	const matches = pages.flat().filter(comment => comment.body.includes(STAKE_MARKER));
	if (matches.length > 1) throw new Error('Multiple stake markers; refusing to add or guess a comment');
	const existing = matches[0];
	const payload = JSON.stringify({ body });
	// Structured stdin via gh's --input avoids shell quoting and preserves Markdown/newlines.
	const posted = JSON.parse(await api('api', '--method', existing ? 'PATCH' : 'POST',
		existing ? `repos/${context.repo}/issues/comments/${existing.id}` : `repos/${context.repo}/issues/${context.pr}/comments`, '--input', '-', { input: payload }));
	await api('api', '--method', 'POST', `repos/${context.repo}/statuses/${context.head}`, '-f', `state=${report.pass ? 'success' : 'failure'}`, '-f', 'context=gameplay-stake',
		'-f', `description=${stakeHeadline(report).description.slice(0, 140)}`, '-f', `target_url=${context.summaryUrl ?? posted.html_url}`);
	return posted;
}

async function main() {
	const { values } = parseArgs({ options: { base: { type: 'string' }, head: { type: 'string' }, pr: { type: 'string' }, 'post-status': { type: 'boolean' }, out: { type: 'string' } } });
	let context = null;
	try {
		context = await resolveContext(values);
		const report = await collectComparison(context);
		await printStake(report);
		if (values.out) await writeFile(values.out, JSON.stringify(report, null, 2) + '\n');
		if (values['post-status']) {
			if (!context.pr) throw new Error('PR number is required to publish');
			const posted = await publishStake(context, report);
			console.log(`Updated sticky comment: ${posted.html_url}`);
		}
		process.exitCode = report.pass ? 0 : 1;
	} catch (error) {
		console.error(error.message);
		process.exitCode = 2;
		// The CI step cannot fail the job, so a crash must still leave a red status on the PR head.
		if (values['post-status'] && context?.head && context.repo && !/Superseded/.test(error.message)) {
			await gh('api', '--method', 'POST', `repos/${context.repo}/statuses/${context.head}`, '-f', 'state=error', '-f', 'context=gameplay-stake',
				'-f', `description=${`stake crashed: ${error.message}`.slice(0, 140)}`, ...(context.summaryUrl ? ['-f', `target_url=${context.summaryUrl}`] : []))
				.catch(statusError => console.error(`Could not post the error status: ${statusError.message}`));
		}
	}
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) await main();
