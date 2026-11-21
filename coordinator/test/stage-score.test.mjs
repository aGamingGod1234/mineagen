import test from 'node:test';
import assert from 'node:assert/strict';
import os from 'node:os';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { mkdtemp, mkdir, writeFile, readFile, rm } from 'node:fs/promises';
import { scoreStageRun, resourceCounts, classifyEnding } from '../../scripts/quality/stage-score.mjs';
import { recordOperatorStop } from '../../scripts/quality/operator-stop.mjs';
import { parseLogAdvancements, evaluateSamples } from '../../scripts/quality/ladder-evaluator.mjs';
import { deriveRunMetrics } from '../src/benchmark/live-speed-benchmark.mjs';
import { buildReport, renderMarkdown } from '../src/decision-eval/report.mjs';
import { compareCases, screenVerdict } from '../src/decision-eval/stats.mjs';

const inventory = items => `[${Object.entries(items).map(([id, n]) => `{id: "minecraft:${id}", count: ${n}}`).join(', ')}]`;

test('stage scoring invalidates corrupt and missing report sidecars instead of parsing around them', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-integrity-'));
	try {
		const sha256 = createHash('sha256').update('[]').digest('hex');
		const relative = `report-artifacts/${sha256}.json`;
		await mkdir(path.join(dir, 'report-artifacts'));
		await writeFile(path.join(dir, 'long-run.json'), JSON.stringify({ timeline: { reportArtifact: { version: 1, path: relative, sha256, bytes: 2 } } }));
		for (const contents of [null, '{}']) {
			if (contents !== null) await writeFile(path.join(dir, relative), contents);
			const score = await scoreStageRun(dir);
			assert.equal(score.measurementStatus, 'INVALID');
			assert.equal(score.integrity.length, 1);
			assert.equal(score.integrity[0].file, 'long-run.json');
			assert.match(score.integrity[0].error, contents === null ? /ENOENT/ : /integrity mismatch/);
		}
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('missing optional reports stay unobserved, and BOM JSON uses the verified reader', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-optional-'));
	try {
		assert.deepEqual((await scoreStageRun(dir)).integrity, []);
		await writeFile(path.join(dir, 'long-run.json'), '\uFEFF' + JSON.stringify({ seed: 'fixture-seed' }));
		const score = await scoreStageRun(dir);
		assert.deepEqual(score.integrity, []);
		assert.equal(score.identity.seed, 'fixture-seed');
		assert.equal(score.measurementStatus, 'UNOBSERVED');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a historical stop without start evidence stays unknown; explicit pre-start cancellation is separate', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-start-'));
	try {
		await recordOperatorStop(dir, 'stopped', { at: 5000 });
		assert.equal((await scoreStageRun(dir)).execution.started, null);
		await writeFile(path.join(dir, 'long-run-start.json'), JSON.stringify({ status: 'cancelled_before_start' }));
		const score = await scoreStageRun(dir);
		assert.equal(score.execution.started, false);
		assert.equal(score.execution.cancelledBeforeStart, true);
		assert.equal(score.execution.completed, null);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the scorer counts in-window receipts once rather than repeated lastResult observations', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-counts-'));
	try {
		const receipt = { type: 'action_result', agentId: 'a', payload: { goalRevision: 1, actionId: 'water', state: 'FAILED', reasonCode: 'WATER_AHEAD' } };
		await writeFile(path.join(dir, 'quality-samples.jsonl'), JSON.stringify({ at: 1000, health: 20, inventoryNbt: '[]' }));
		await writeFile(path.join(dir, 'quality-protocol.jsonl'), [
			{ observedAtMs: 1000, envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'start' } } },
			{ observedAtMs: 1100, envelope: receipt }, { observedAtMs: 1200, envelope: receipt },
			...Array.from({ length: 199 }, () => ({ observedAtMs: 1300, envelope: { type: 'observation', agentId: 'a', payload: { lastResult: receipt.payload } } })),
		].map(row => JSON.stringify(row)).join('\n'));
		const score = await scoreStageRun(dir);
		assert.equal(score.actionCounts.byReason.WATER_AHEAD, 1);
		assert.equal(score.actionCounts.duplicates, 1);
		assert.equal(score.execution.started, true);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('equivalent resources survive rod/powder/eye recipes without invented gain or loss', () => {
	assert.deepEqual(resourceCounts({}), { rods: null, pearlsEyes: null, gold: null });
	assert.deepEqual(resourceCounts({ inventoryNbt: inventory({ blaze_rod: 2, blaze_powder: 2, ender_eye: 4, ender_pearl: 3, gold_block: 2, gold_nugget: 9 }) }), { rods: 5, pearlsEyes: 7, gold: 19 });
});

test('streaming stage score preserves a first-life failure when an operator censors recovery', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'd38-measure-test-'));
	try {
		await writeFile(path.join(dir, 'long-run.json'), JSON.stringify({ windowMs: 10000, definition: { setup: { inventory: [{ item: 'minecraft:blaze_rod', count: 6 }, { item: 'minecraft:gold_ingot', count: 10 }] } } }));
		const rows = [
			{ at: 1000, health: 20, deathCounter: 0, damageTakenCounter: 0, inventoryNbt: inventory({ blaze_rod: 6, gold_ingot: 10 }) },
			{ at: 2000, health: 10, deathCounter: 0, damageTakenCounter: 100, inventoryNbt: inventory({ blaze_powder: 12, gold_ingot: 8, ender_pearl: 2 }) },
			{ at: 3000, health: 0, deathCounter: 1, damageTakenCounter: 200, inventoryNbt: '[]' },
			{ at: 4000, health: 20, deathCounter: 1, damageTakenCounter: 200, inventoryNbt: inventory({ blaze_powder: 2 }) },
		];
		await writeFile(path.join(dir, 'quality-samples.jsonl'), rows.map(s => JSON.stringify(s)).join('\n') + '\n{truncated');
		await writeFile(path.join(dir, 'quality-protocol.jsonl'), [
			{ observedAtMs: 1000, envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 1000 } } },
			{ observedAtMs: 2500, envelope: { type: 'action_result', agentId: 'a', payload: { actionId: 'x', actionType: 'wait', state: 'SUCCEEDED', message: 'done', replayProof: 'fixture-private-receipt-proof' } } },
		].map(r => JSON.stringify(r)).join('\n'));
		await recordOperatorStop(dir, 'checkpoint recovery ends here', { at: 5000 });
		const scored = await scoreStageRun(dir);
		assert.equal(scored.ending.kind, 'stopped');
		assert.equal(scored.ending.at, 5000);
		assert.equal(scored.firstLife.status, 'observed_death');
		assert.equal(scored.afterDeath.status, 'censored');
		assert.equal(scored.firstLife.resources.rods.supplied, 6);
		assert.equal(scored.firstLife.damageTakenCounterDelta, 200);
		assert.equal(scored.afterDeath.damageTakenCounterDelta, 0);
		assert.equal(scored.firstLife.resources.rods.observedGains, 0);
		assert.equal(scored.firstLife.resources.rods.lost, 6);
		assert.equal(scored.afterDeath.resources.rods.lost, 0, 'do not count the first death twice');
		assert.equal(scored.afterDeath.resources.rods.recoveredOrEarned, 1);
		assert.equal(scored.firstLife.resources.pearlsEyes.earned, null, 'an inventory gain alone does not prove earnings');
		assert.equal(scored.firstLife.resources.gold.spent, null, 'a decrease alone does not prove barter');
		assert.equal(scored.firstLife.resources.gold.unexplainedDecrease, 2);
		assert.equal(scored.firstLife.milestones.blaze_rod.heldAtStageEnd, false);
		assert.ok(scored.firstLifeDeathTrace.gaps.length);
		assert.equal(scored.firstLifeDeathTrace.actionReceipts[0].message, 'done');
		assert.doesNotMatch(JSON.stringify(scored), /fixture-private-receipt-proof|replayProof/);
		assert.ok(scored.coverage.diagnostics.some(s => s.includes('malformed')));
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('budget, failure, and missing termination provenance remain distinct', () => {
	assert.equal(classifyEnding({ startedAt: 1000, lastAt: 61000, windowMs: 60000, termination: 'TIMEOUT' }).kind, 'budget_end');
	assert.equal(classifyEnding({ termination: 'NO_OBSERVER' }).kind, 'failure');
	assert.equal(classifyEnding({ termination: 'SIGTERM' }).kind, 'unknown');
	assert.equal(classifyEnding({ operatorStop: { status: 'stop_failed', at: 1000, reason: 'worker refused stop' } }).kind, 'failure');
});

test('log advancements require the agent AND an absolute in-window event timestamp', () => {
	const start = Date.parse('2026-10-24T10:00:00Z');
	const log = '[2026-10-24T10:00:02Z] [Server/INFO]: OtherPlayer has made the advancement [Free the End]\n'
		+ '[2026-10-24T09:59:59Z] [Server/INFO]: Sol has made the advancement [Free the End]\n'
		+ '[10:00:02] [Server/INFO]: Sol has made the advancement [Free the End]\n'
		+ '[2026-10-24T10:00:03Z] [Server/INFO]: Sol has made the advancement [Free the End]';
	const scope = { agentName: 'Sol', goalStartAt: start, goalEndAt: start + 5000 };
	const events = parseLogAdvancements(log, scope);
	assert.deepEqual(events, [{ id: 'end/kill_dragon', at: start + 3000, agentName: 'Sol' }]);
	assert.deepEqual(parseLogAdvancements(log), []);
	const options = { successCheck: 'advancement: end/kill_dragon', durationBudgetMs: 5000, goalStartAt: start, agentName: 'Sol' };
	assert.equal(evaluateSamples([], { ...options, logAdvancements: events }).pass, true);
	assert.equal(evaluateSamples([], { ...options, logAdvancements: ['end/kill_dragon'] }).pass, false);
	assert.equal(evaluateSamples([], { ...options, logAdvancements: [{ ...events[0], agentName: 'OtherPlayer' }] }).pass, false);
});

test('decision latency uses seconds-long provider boundaries instead of usage bookkeeping', () => {
	const common = { agentId: 'a', goalRevision: 1, provider: 'codex', model: 'gpt-6.1-sol' };
	const m = deriveRunMetrics({ profile: { provider: 'codex', model: 'gpt-6.1-sol', reasoningEffort: 'low', serviceTier: 'default' }, traceRows: [
		{ ...common, event: 'native_model_call', totalMs: 11 },
		{ ...common, event: 'native_decision_timing', outcome: 'completed', segmentDurationMs: 5000 },
	] });
	assert.equal(m.medianModelRoundMs, 5000);
	assert.equal(m.providerUsageTimingMs.median, 11);
});

test('zero-good paired PASS and missing continuations are prominent in reports', () => {
	const cases = [{ id: 'a', family: 'fight', candidate: { good: 0, n: 3 }, baseline: { good: 0, n: 3 } }];
	const comparison = compareCases(cases), verdict = screenVerdict(comparison);
	const report = buildReport({ comparison, verdict, baseline: {}, candidate: {}, caseDefinitions: [{ id: 'a' }] });
	const md = renderMarkdown(report);
	assert.match(md, /UNINFORMATIVE/);
	assert.match(md, /1\/1 cases have no continuation/);
	assert.match(md, /both arms have zero good/);
});

test('deaths are counted by cause from the receipt, the Watcher\'s lethal hit and the coordinator\'s death row; only a bare counter step is unknown', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-causes-'));
	try {
		const rows = [
			{ at: 1000, health: 20, deathCounter: 0, inventoryNbt: '[]' }, { at: 3000, health: 0, deathCounter: 1, inventoryNbt: '[]' },
			{ at: 9000, health: 0, deathCounter: 2, inventoryNbt: '[]' }, { at: 20000, health: 0, deathCounter: 3, inventoryNbt: '[]' },
		];
		await writeFile(path.join(dir, 'quality-samples.jsonl'), rows.map(s => JSON.stringify(s)).join('\n') + '\n');
		const dead = (at, revision, death) => ({ observedAtMs: at, envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'dead', goalRevision: revision, updatedAtEpochMs: at, death: { diedAtEpochMs: at, ...death } } } });
		await writeFile(path.join(dir, 'quality-protocol.jsonl'), [
			{ observedAtMs: 1000, envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 1000 } } },
			dead(2900, 1, { cause: 'a was shot by Skeleton', damageType: 'minecraft:arrow', attacker: 'minecraft:skeleton' }),
			// After a steer the revision is 2; an older server sent only the message.
			dead(8900, 2, { cause: 'a burned to death' }),
		].map(r => JSON.stringify(r)).join('\n') + '\n');
		await mkdir(path.join(dir, 'arena-watch'));
		await writeFile(path.join(dir, 'arena-watch', 'a-danger.jsonl'), JSON.stringify({ type: 'damage', agentId: 'a', atMs: 8901, damageType: 'minecraft:on_fire', attacker: null, lethal: true }) + '\n');
		await writeFile(path.join(dir, 'coordinator.jsonl'), JSON.stringify({ event: 'agent_death', agentId: 'a', goalRevision: 2, at: 8950, diedAtEpochMs: 8900, cause: 'a burned to death', attacker: null }) + '\n');
		const scored = await scoreStageRun(dir);
		assert.equal(scored.observedDeaths, 3);
		assert.deepEqual(scored.deathCauses, { skeleton_arrow: 1, fire: 1, unknown: 1 });
		assert.equal(scored.deathRecords[1].damageType, 'minecraft:on_fire', 'the Watcher row fills the damage type an older receipt lacks');
	} finally { await rm(dir, { recursive: true, force: true }); }
});
