import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStake, STAKE_MARKER, stakeHeadline } from '../src/decision-eval/stake-summary.mjs';
import { mkdtemp, cp, readFile, writeFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { STAKE_ROOT } from '../src/decision-eval/decision-stake.mjs';
import { collectComparison, selectShas } from '../../scripts/quality/lib/stake-comparison.mjs';
import { publishStake } from '../../scripts/quality/stake-ci.mjs';

const report = () => ({ pass: true, results: [{ id: 'lava', invariant: true, matches: true, baseSame: true,
	metrics: { holds: 1, steers: 1, handBacks: 1 }, baseMetrics: { holds: 1, steers: 1, handBacks: 1 } }],
	base: { sha: 'base1234' }, head: 'head1234', wallMs: 162, coverageGaps: [{ id: 'full-window' }] });

test('phone headlines show actual base deltas, invariant failure, and no invented gate', () => {
	const good = formatStake(report());
	assert.match(good, /✅ \*\*Stake █ head passes · 1\/1 same · 0 diffs · 162 ms/);
	assert.match(good, /no gate report/);
	assert.match(good, /1 → 1/);
	assert.ok(good.indexOf('Product:') < good.indexOf('| Episode'));
	const bad = report(); bad.pass = false; bad.results[0].invariant = false; bad.results[0].baseSame = false;
	assert.match(formatStake(bad), /❌ \*\*Stake ░ head fails · 0\/1 same · 1 diffs/);
	const intended = report(); intended.results[0].baseSame = false;
	assert.match(formatStake(intended), /✅ \*\*Stake/);
	assert.match(formatStake(intended), /\| lava Δ \| 1 → 1 \| 1 → 1 \| 1 → 1 \| pass \|/);
	assert.equal(stakeHeadline(intended).diffs, 1);
});

test('successive green/red/green publications PATCH one marker comment and post a head status', async () => {
	let comment = null; const calls = [], descriptions = [];
	const api = async (...args) => {
		calls.push(args);
		if (args[0] === 'api' && args[1] === 'repos/o/r/pulls/1') return JSON.stringify({ head: { sha: 'head1234' } });
		if (args.includes('--slurp')) return JSON.stringify([comment ? [comment] : []]);
		if (args.includes('--input')) {
			const body = JSON.parse(args.at(-1).input).body;
			assert.ok(body.includes(STAKE_MARKER));
			comment = { id: 17, html_url: 'https://example.test/comment/17', body }; return JSON.stringify(comment);
		}
		descriptions.push(args.find(arg => typeof arg === 'string' && arg.startsWith('description='))); return '{}';
	};
	const context = { repo: 'o/r', pr: 1, head: 'head1234' };
	for (const pass of [true, false, true]) { const row = report(); row.pass = pass; row.results[0].invariant = pass; await publishStake(context, row, { api }); }
	assert.equal(calls.filter(args => args.includes('POST') && args.includes('repos/o/r/issues/1/comments')).length, 1);
	assert.equal(calls.filter(args => args.includes('PATCH') && args.includes('repos/o/r/issues/comments/17')).length, 2);
	assert.equal(descriptions.length, 3);
	assert.match(descriptions[0], /head passes · 1\/1 same · 0 diffs · 162 ms/);
	await assert.rejects(publishStake({ ...context, head: 'superseded' }, report(), { api }), /Superseded/);
});

// Records every publish call; the status state is what GitHub shows on the PR head.
const recorder = () => {
	const states = [];
	const api = async (...args) => {
		if (args[1] === 'repos/o/r/pulls/1') return JSON.stringify({ head: { sha: 'head1234' } });
		if (args.includes('--slurp')) return JSON.stringify([[]]);
		if (args.includes('--input')) return JSON.stringify({ id: 1, html_url: 'https://example.test/c/1' });
		states.push(args.find(arg => typeof arg === 'string' && arg.startsWith('state='))); return '{}';
	};
	return { api, states };
};

test('a base that cannot be compared reads "not comparable" and stays neutral', async () => {
	const row = report(); row.comparisonError = 'Base episode lava unsupported'; row.baseComparable = false;
	delete row.results[0].baseSame; delete row.results[0].baseMetrics;
	const text = formatStake(row);
	assert.match(text, /✅ \*\*Stake █ head passes · 1\/1 accepted · base not comparable/);
	assert.match(text, /Base not comparable \(neutral/);
	assert.equal(stakeHeadline(row).baseState, 'not comparable');
	const { api, states } = recorder();
	await publishStake({ repo: 'o/r', pr: 1, head: 'head1234' }, row, { api });
	assert.deepEqual(states, ['state=success']);
});

test('a failing head stays red when its base cannot be compared', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stake-failing-head-'));
	try {
		await cp(STAKE_ROOT, dir, { recursive: true });
		const file = path.join(dir, 'expected.json'), expected = JSON.parse(await readFile(file));
		expected['creeper-steer'].decisions = [];
		await writeFile(file, JSON.stringify(expected));
		// The base commit cannot be read or fetched, as for a base that was force-pushed away.
		const git = async (...args) => { throw new Error(`git ${args[0]} failed: no such commit`); };
		const row = await collectComparison({ base: 'f'.repeat(40), head: 'head1234', evaluated: 'merge1234', repo: 'o/r', pr: 1 },
			{ incident: 'creeper-steer', root: dir, git });
		assert.equal(row.pass, false);
		assert.equal(row.baseComparable, false);
		assert.match(row.comparisonError, /no such commit/);
		assert.equal(row.results[0].baseSame, undefined);
		const text = formatStake(row);
		assert.match(text, /❌ \*\*Stake ░ head fails · 0\/1 accepted · base not comparable/);
		assert.match(text, /evaluated merge: `merge123`/);
		const { api, states } = recorder();
		await publishStake({ repo: 'o/r', pr: 1, head: 'head1234' }, row, { api });
		assert.deepEqual(states, ['state=failure']);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('CI evaluates the checked-out merge but publishes to the PR head from the event', () => {
	const event = { pull_request: { head: { sha: 'h'.repeat(40) }, base: { sha: 'b'.repeat(40) } } };
	// GitHub's merge commit: first parent is the base tip it was built on, second the PR head.
	assert.deepEqual(selectShas({ event, pull: event.pull_request, evaluated: 'm'.repeat(40), parents: ['n'.repeat(40), 'h'.repeat(40)] }),
		{ head: 'h'.repeat(40), base: 'n'.repeat(40) });
	// A head checkout (no merge) compares against the event's base.
	assert.deepEqual(selectShas({ event, pull: event.pull_request, evaluated: 'h'.repeat(40), parents: ['p'.repeat(40)] }),
		{ head: 'h'.repeat(40), base: 'b'.repeat(40) });
	// Locally, without an event, the head is the working tree's commit.
	assert.deepEqual(selectShas({ evaluated: 'l'.repeat(40), parents: [] }), { head: 'l'.repeat(40), base: null });
});
