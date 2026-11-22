import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStake, stakeCoverage, stakeHeadline } from '../src/decision-eval/stake-summary.mjs';
import { publishStake } from '../../scripts/quality/stake-ci.mjs';

const report = changedFiles => ({ pass: true, results: [1, 2, 3, 4].map(n => ({ id: `reflex-${n}`, invariant: true, matches: true, baseSame: true,
	metrics: { holds: 1, steers: 0, handBacks: 0 }, baseMetrics: { holds: 1, steers: 0, handBacks: 0 } })),
	base: { sha: 'base1234' }, head: 'head1234', wallMs: 168, changedFiles });

test('a Java-only diff reads "not covered" first in the status, though the stake still passes', () => {
	const java = report(['src/main/java/dev/agaminggod/mineagen/runtime/reflex/ReflexActions.java', 'src/test/java/dev/agaminggod/mineagen/ReflexActionsTest.java', 'docs/goal-progress.md']);
	const headline = stakeHeadline(java);
	assert.equal(headline.description, 'not covered (Java-only diff) · head passes · 4/4 same · 0 diffs · 168 ms');
	assert.equal(headline.coverage.state, 'not covered');
	assert.equal(headline.coverage.java, 1, 'the Java test file is a test, not code');
	assert.match(formatStake(java), /Coverage: \*\*not covered\*\*\. 1 changed code file \(1 Java\), none in the coordinator decision code, which is all the stake replays\. A pass here says nothing about this change\./);
	assert.ok(headline.description.length <= 140);
	const scripts = stakeHeadline(report(['scripts/quality/lib/room-batch-core.mjs']));
	assert.match(scripts.description, /^not covered \(no decision-code change\) · head passes/);
});

test('a coordinator diff is covered, a mixed diff partly covered, docs alone no code change, an unread diff unknown', () => {
	const coordinator = stakeHeadline(report(['coordinator/src/search-danger.mjs', 'coordinator/src/reflexes.mjs', 'README.md']));
	assert.equal(coordinator.description, 'covers 2 decision-code files · head passes · 4/4 same · 0 diffs · 168 ms');
	const mixed = stakeCoverage(['coordinator/src/search-danger.mjs', 'src/main/java/A.java', 'scripts/quality/x.mjs']);
	assert.deepEqual([mixed.state, mixed.short], ['partly covered', 'partly covered (1 of 3 code files)']);
	assert.match(mixed.line, /1 of 3 changed code files is coordinator decision code, which the stake replays; the other 2 are not exercised \(1 Java\)/);
	assert.equal(stakeCoverage(['docs/a.md', 'AGENTS.md']).state, 'no code change');
	// The in-game agent's instructions are gameplay, not docs: not covered alone, partly covered beside coordinator code.
	assert.equal(stakeCoverage(['coordinator/config/minecraft-agent/AGENTS.md']).short, 'not covered (no decision-code change)');
	// A fix with its own test is covered; coordinator code the stake never loads is not.
	assert.equal(stakeCoverage(['coordinator/src/obtain-runner.mjs', 'coordinator/test/obtain-placement-support.test.mjs']).short, 'covers 1 decision-code file');
	for (const file of ['coordinator/src/posix-process-group.mjs', 'coordinator/src/decision-eval/judge.mjs', 'coordinator/src/benchmark/long-run-artifacts.mjs', 'coordinator/src/voice/x.mjs', 'coordinator/src/headless-runner.mjs'])
		assert.equal(stakeCoverage([file]).state, 'not covered', file);
	assert.equal(stakeCoverage(['coordinator/test/a.test.mjs']).state, 'no code change');
	assert.equal(stakeCoverage(['coordinator/config/minecraft-agent/.codex/skills/minecraft-control/SKILL.md', 'coordinator/src/reflexes.mjs']).state, 'partly covered');
	assert.equal(stakeCoverage(null).short, 'coverage unknown');
	assert.equal(stakeHeadline(report(null)).description, 'head passes · 4/4 same · 0 diffs · 168 ms', 'unknown coverage makes no claim in the status');
	assert.match(formatStake(report(null)), /Coverage unknown: the changed files could not be listed\./);
	// A report with no diff field (the raw local test report) keeps its old headline.
	assert.equal(stakeHeadline(report(undefined)).description, 'head passes · 4/4 same · 0 diffs · 168 ms');
});

test('the posted status carries the coverage word', async () => {
	const calls = [];
	const api = async (...args) => {
		calls.push(args);
		if (args[1] === 'repos/o/r/pulls/7') return JSON.stringify({ head: { sha: 'head1234' } });
		if (args.includes('--paginate')) return '[[]]';
		return JSON.stringify({ html_url: 'https://example.invalid/c/1', id: 1 });
	};
	await publishStake({ repo: 'o/r', pr: 7, head: 'head1234' }, report(['src/main/java/A.java']), { api });
	const status = calls.find(args => args.includes('context=gameplay-stake'));
	assert.ok(status.includes('state=success'));
	assert.ok(status.includes('description=not covered (Java-only diff) · head passes · 4/4 same · 0 diffs · 168 ms'));
});
