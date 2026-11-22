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

test('a death seen only in the samples takes its cause from the Watcher\'s lethal hit before it', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-causes-'));
	try {
		const rows = [{ at: 1000, health: 20, deathCounter: 0, inventoryNbt: '[]' }, { at: 5000, health: 20, deathCounter: 1, inventoryNbt: '[]' },
			{ at: 9000, health: 20, deathCounter: 2, inventoryNbt: '[]' }];
		await writeFile(path.join(dir, 'quality-samples.jsonl'), rows.map(s => JSON.stringify(s)).join('\n') + '\n');
		await mkdir(path.join(dir, 'arena-watch'));
		// No receipt, episode or run-record death: only the counter steps and the Watcher's lethal hits.
		await writeFile(path.join(dir, 'arena-watch', 'a-danger.jsonl'), [
			{ type: 'damage', agentId: 'a', atMs: 4200, damageType: 'minecraft:lava', attacker: null, lethal: true },
			{ type: 'damage', agentId: 'a', atMs: 8500, damageType: 'minecraft:arrow', attacker: 'minecraft:skeleton', lethal: true },
		].map(r => JSON.stringify(r)).join('\n') + '\n');
		const scored = await scoreStageRun(dir);
		assert.equal(scored.observedDeaths, 2);
		assert.deepEqual(scored.deathCauses, { lava: 1, skeleton_arrow: 1 }, 'both counter-only deaths are named, none is added');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a death seen only in the samples takes its cause from the coordinator\'s death row before it', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-causes-'));
	try {
		const rows = [{ at: 1000, health: 20, deathCounter: 0, inventoryNbt: '[]' }, { at: 5000, health: 20, deathCounter: 1, inventoryNbt: '[]' }];
		await writeFile(path.join(dir, 'quality-samples.jsonl'), rows.map(s => JSON.stringify(s)).join('\n') + '\n');
		await writeFile(path.join(dir, 'coordinator.jsonl'), JSON.stringify({ event: 'agent_death', agentId: 'a', goalRevision: 1, at: 2050, diedAtEpochMs: 2000, cause: 'a tried to swim in lava', damageType: 'minecraft:lava' }) + '\n');
		const alone = await scoreStageRun(dir);
		assert.equal(alone.observedDeaths, 1);
		assert.deepEqual(alone.deathCauses, { lava: 1 }, 'the coordinator row alone names it');
		await mkdir(path.join(dir, 'arena-watch'));
		// The same death's lethal hit too: still one death.
		await writeFile(path.join(dir, 'arena-watch', 'a-danger.jsonl'), JSON.stringify({ type: 'damage', agentId: 'a', atMs: 1990, damageType: 'minecraft:lava', attacker: null, lethal: true }) + '\n');
		const both = await scoreStageRun(dir);
		assert.equal(both.observedDeaths, 1);
		assert.deepEqual(both.deathCauses, { lava: 1 }, 'a hit and a death row of one death stay one death');
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a fatal Watcher episode with no receipt names its death from the episode\'s death message', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-causes-'));
	try {
		const rows = [{ at: 1000, health: 20, deathCounter: 0, inventoryNbt: '[]' }, { at: 5000, health: 20, deathCounter: 1, inventoryNbt: '[]' }];
		await writeFile(path.join(dir, 'quality-samples.jsonl'), rows.map(s => JSON.stringify(s)).join('\n') + '\n');
		await mkdir(path.join(dir, 'arena-watch'));
		await writeFile(path.join(dir, 'arena-watch', 'a-episodes.jsonl'), JSON.stringify({ outcome: 'death', kind: 'mob', closedAt: { epochMs: 3000 }, deathMessage: 'Miner was shot by Skeleton' }) + '\n');
		const scored = await scoreStageRun(dir);
		assert.equal(scored.observedDeaths, 1);
		assert.deepEqual(scored.deathCauses, { skeleton_arrow: 1 });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a run record\'s "unknown" for a counter-only death is no evidence: the lethal hit still names it', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-causes-'));
	try {
		const rows = [{ at: 1000, health: 20, deathCounter: 0, inventoryNbt: '[]' }, { at: 5000, health: 20, deathCounter: 1, inventoryNbt: '[]' }];
		await writeFile(path.join(dir, 'quality-samples.jsonl'), rows.map(s => JSON.stringify(s)).join('\n') + '\n');
		await writeFile(path.join(dir, 'long-run.json'), JSON.stringify({ timeline: { deaths: [{ at: 5000, cause: 'unknown' }] } }));
		await mkdir(path.join(dir, 'arena-watch'));
		await writeFile(path.join(dir, 'arena-watch', 'a-danger.jsonl'), JSON.stringify({ type: 'damage', agentId: 'a', atMs: 2000, damageType: 'minecraft:lava', attacker: null, lethal: true }) + '\n');
		const scored = await scoreStageRun(dir);
		assert.equal(scored.observedDeaths, 1);
		assert.deepEqual(scored.deathCauses, { lava: 1 });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('a lethal hit of a death a coordinator row already named does not take a second death\'s slot', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-causes-'));
	try {
		const rows = [{ at: 1000, health: 20, deathCounter: 0, inventoryNbt: '[]' }, { at: 5000, health: 20, deathCounter: 1, inventoryNbt: '[]' },
			{ at: 9000, health: 20, deathCounter: 2, inventoryNbt: '[]' }];
		await writeFile(path.join(dir, 'quality-samples.jsonl'), rows.map(s => JSON.stringify(s)).join('\n') + '\n');
		await mkdir(path.join(dir, 'arena-watch'));
		await writeFile(path.join(dir, 'arena-watch', 'a-danger.jsonl'), [
			{ type: 'damage', agentId: 'a', atMs: 4200, damageType: 'minecraft:lava', attacker: null, lethal: true },
			{ type: 'damage', agentId: 'a', atMs: 8500, damageType: 'minecraft:arrow', attacker: 'minecraft:skeleton', lethal: true },
		].map(r => JSON.stringify(r)).join('\n') + '\n');
		await writeFile(path.join(dir, 'coordinator.jsonl'), JSON.stringify({ event: 'agent_death', agentId: 'a', goalRevision: 1, at: 4250, diedAtEpochMs: 4200, cause: 'a tried to swim in lava', damageType: 'minecraft:lava' }) + '\n');
		const scored = await scoreStageRun(dir);
		assert.equal(scored.observedDeaths, 2);
		assert.deepEqual(scored.deathCauses, { lava: 1, skeleton_arrow: 1 });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('the long-run capture keeps agent_death rows, so a death\'s record survives trace rotation', async () => {
	const { longTraceRow } = await import('../src/benchmark/long-run-artifacts.mjs');
	const row = { event: 'agent_death', agentId: 'a', cause: 'a drowned' };
	assert.equal(longTraceRow(row), row);
});

test('game facts: milestones, a fall into lava with what ran at its top, the respawn, the End fight and model use per milestone', async () => {
	const { mechanismTable } = await import('../../scripts/quality/lib/game-facts.mjs');
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-facts-'));
	try {
		const t0 = 1_000_000, min = (m) => t0 + m * 60_000;
		const iron = '[{id: "minecraft:iron_helmet", count: 1}, {id: "minecraft:iron_chestplate", count: 1}, {id: "minecraft:iron_leggings", count: 1}, {id: "minecraft:iron_boots", count: 1}]';
		const sample = (m, extra) => ({ at: min(m), health: 20, deathCounter: 0, dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 }, inventoryNbt: '[]', equipmentNbt: iron, ...extra });
		await writeFile(path.join(dir, 'quality-samples.jsonl'), [
			sample(0, { inventoryNbt: inventory({ oak_log: 2 }) }),
			sample(2, { inventoryNbt: inventory({ flint_and_steel: 1 }) }),
			sample(4, { dimension: 'minecraft:the_nether', position: { x: 0, y: 70, z: 0 }, inventoryNbt: inventory({ blaze_rod: 3 }) }),
			sample(5, { dimension: 'minecraft:the_nether', position: { x: 0, y: 31, z: 0 }, health: 0, deathCounter: 1 }),
			sample(5.5, { position: { x: 10, y: 64, z: 10 }, deathCounter: 1, equipmentNbt: '[]', inventoryNbt: inventory({ ender_eye: 12, ender_pearl: 2 }) }),
			sample(8, { advancements: ['story/follow_ender_eye'], deathCounter: 1, equipmentNbt: '[]', inventoryNbt: inventory({ ender_eye: 1 }) }),
			sample(10, { dimension: 'minecraft:the_end', position: { x: 100, y: 49, z: 0 }, deathCounter: 1, equipmentNbt: '[]', inventoryNbt: inventory({ bow: 1 }) }),
			sample(14, { dimension: 'minecraft:the_end', position: { x: 0, y: 64, z: 0 }, deathCounter: 1, equipmentNbt: '[]' }),
		].map(s => JSON.stringify(s)).join('\n') + '\n');
		const command = (m, actionType) => ({ observedAtMs: min(m), envelope: { type: 'action_command', agentId: 'a', payload: { actionId: `${actionType}-${m}`, actionType } } });
		await writeFile(path.join(dir, 'quality-protocol.jsonl'), [
			{ observedAtMs: t0, envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: t0 } } },
			command(1, 'use_ranged'), command(11, 'use_ranged'), command(12, 'use_ranged'), command(12.5, 'travel_to'),
		].map(r => JSON.stringify(r)).join('\n') + '\n');
		const died = min(5) - 500;
		const trail = [{ s: -6, health: 20, y: 70, action: 'travel_to', reflex: null }, { s: -4, health: 20, y: 70, action: 'travel_to', reflex: 'default-defend' }, { s: -1, health: 14, y: 45, action: 'travel_to', reflex: null }];
		await writeFile(path.join(dir, 'coordinator.jsonl'), [
			{ event: 'agent_death', agentId: 'a', goalRevision: 1, at: died + 10, diedAtEpochMs: died, cause: 'a tried to swim in lava', damageType: 'minecraft:lava', dimension: 'minecraft:the_nether', position: { x: 0, y: 31, z: 0 }, armor: 15, action: { type: 'travel_to' }, reflex: null, trail },
			...[0.5, 3, 9, 11].map((m) => ({ event: 'native_model_call', agentId: 'a', goalRevision: 1, at: min(m), totalMs: 2000, inputTokens: 1000, cachedInputTokens: 600 })),
		].map(r => JSON.stringify(r)).join('\n') + '\n');
		await mkdir(path.join(dir, 'arena-watch'));
		await writeFile(path.join(dir, 'arena-watch', 'a-progress.jsonl'), [
			{ type: 'progress', atMs: min(10.5), dim: 'minecraft:the_end', targets: { dragon: { health: 200 }, crystals: { left: 10 } } },
			{ type: 'progress', atMs: min(12), dim: 'minecraft:the_end', targets: { dragon: { health: 170 }, crystals: { left: 8 } } },
			{ type: 'progress', atMs: min(13), dim: 'minecraft:the_end', targets: { dragon: { health: 180 }, crystals: { left: 8 } } },
		].map(r => JSON.stringify(r)).join('\n') + '\n');
		// Another agent's decision log in the same folder never counts.
		await writeFile(path.join(dir, 'decision-1--b-0.jsonl'), JSON.stringify({ time: min(1), type: 'input', text: 'lava seen nearby' }) + '\n');
		await writeFile(path.join(dir, 'decision-1--a-0.jsonl'), [
			{ time: min(3), type: 'input', text: 'lava seen nearby' },
			{ time: min(3.5), type: 'action_result', result: { reasonCode: 'PORTAL_LIT' } },
		].map(r => JSON.stringify(r)).join('\n') + '\n{"time": 1, "text": "lava seen nearby", "cut off\n');
		const { game, deathRecords } = await scoreStageRun(dir);
		assert.equal(deathRecords.length, 1);
		assert.deepEqual(Object.fromEntries(['wood', 'flint_and_steel', 'lava_seen', 'portal_lit', 'nether', 'stronghold', 'end', 'dragon'].map(id => [id, game.milestones[id]?.minute ?? null])),
			{ wood: 0, flint_and_steel: 2, lava_seen: 3, portal_lit: 3.5, nether: 4, stronghold: 8, end: 10, dragon: null });
		const [death] = game.deaths;
		assert.equal(death.dimension, 'minecraft:the_nether');
		assert.equal(death.repeat, false);
		assert.equal(death.armour, 15);
		assert.deepEqual(death.fall && { blocks: death.fall.blocks, top: death.fall.actionAtTop, reflex: death.fall.reflexAtTop, health: death.fall.healthAtTop }, { blocks: 39, top: 'travel_to', reflex: null, health: 20 },
			'the top is the earliest highest point of the trail, 39 blocks above the death');
		assert.equal(death.respawn.dimension, 'minecraft:overworld');
		assert.deepEqual(death.respawn.position, { x: 10, y: 64, z: 10 });
		const [row] = game.deathMechanisms;
		assert.deepEqual({ cause: row.cause, deaths: row.deaths, fell4: row.fell4, fell20: row.fell20, full: row.fullHealthAtTop, first: row.first, actions: row.actionAtTop }, { cause: 'lava', deaths: 1, fell4: 1, fell20: 1, full: 1, first: 1, actions: { travel_to: 1 } });
		assert.deepEqual({ ...game.end, basis: undefined, rangedBasis: undefined, enteredAt: undefined }, { enteredAt: undefined, enteredMinute: 10, rangedCommands: 2, rangedCommandsBeforeEnd: 1, rangedBasis: undefined,
			dragonSeenRows: 3, dragonHealthMin: 170, dragonHealthLast: 180, crystalsLeftMax: 10, crystalsLeftMin: 8, crystalsGone: 2, deathsInEnd: 0, deathsAfterEntry: 0, strongholdToEndMin: 2, dragonKilled: false, basis: undefined });
		assert.deepEqual(game.peakHeld, { blaze_rod: 3, ender_pearl: 2, ender_eye: 12 });
		assert.equal(game.rangedCommands, 3);
		assert.deepEqual({ calls: game.modelUse.calls, inputTokens: game.modelUse.inputTokens }, { calls: 4, inputTokens: 4000 });
		assert.deepEqual(game.modelUse.byMilestone.nether, { calls: 2, inputTokens: 2000, cachedInputTokens: 1200 });
		assert.deepEqual(game.modelUse.byMilestone.end, { calls: 3, inputTokens: 3000, cachedInputTokens: 1800 });
		// Summed over games, a repeat death and a short drop land in their own columns.
		const table = mechanismTable([...game.deaths, { ...death, repeat: true, fall: { ...death.fall, blocks: 2 } }]);
		assert.deepEqual({ deaths: table[0].deaths, first: table[0].first, repeat: table[0].repeat, measured: table[0].measuredFall, fell4: table[0].fell4 }, { deaths: 2, first: 1, repeat: 1, measured: 2, fell4: 1 });
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('game facts stay unknown without their evidence: no End entry, no decision log, no trail, no samples', async () => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'stage-facts-none-'));
	try {
		assert.equal((await scoreStageRun(dir)).game.peakHeld, null, 'no samples: peak holdings unknown, not zero');
		await writeFile(path.join(dir, 'quality-samples.jsonl'), [{ at: 1000, health: 20, deathCounter: 0, dimension: 'minecraft:overworld', position: { x: 0, y: 70, z: 0 }, inventoryNbt: '[]' },
			{ at: 4000, health: 20, deathCounter: 0, dimension: 'minecraft:overworld', position: { x: 0, y: 60, z: 0 }, inventoryNbt: '[]' },
			{ at: 6000, health: 0, deathCounter: 1, dimension: 'minecraft:overworld', position: { x: 0, y: 60, z: 0 }, inventoryNbt: '[]' }].map(s => JSON.stringify(s)).join('\n') + '\n');
		const { game } = await scoreStageRun(dir);
		assert.equal(game.end, null);
		assert.equal('lava_seen' in game.milestones, false, 'no decision log: lava seen is not measured, so its key stays out');
		assert.equal(game.modelUse, null);
		assert.equal(game.rangedCommands, null, 'no protocol: ranged commands unknown');
		const [death] = game.deaths;
		assert.equal(death.action, null);
		assert.equal(death.fall.blocks, 10, 'without a death row trail the samples give the height');
		assert.equal(death.fall.actionAtTop, null);
		assert.equal(death.respawn, null);
		assert.equal(death.armour, null);
	} finally { await rm(dir, { recursive: true, force: true }); }
});

test('game facts review cases: a sample-only death is measured from the dead sample, a portal trip cuts the trail, a reconciled model call counts once', async () => {
	const { gameFacts } = await import('../../scripts/quality/lib/game-facts.mjs');
	const nether = 'minecraft:the_nether', over = 'minecraft:overworld';
	const facts = gameFacts();
	for (const s of [{ at: 1000, health: 20, deathCounter: 0, dimension: nether, position: { x: 0, y: 100, z: 0 } },
		{ at: 4000, health: 0, deathCounter: 1, dimension: nether, position: { x: 0, y: 31, z: 0 } },
		{ at: 6000, health: 20, deathCounter: 1, dimension: over, position: { x: 5, y: 64, z: 5 } },
		{ at: 20_000, health: 20, deathCounter: 1, dimension: over, position: { x: 5, y: 90, z: 5 } },
		{ at: 24_000, health: 20, deathCounter: 1, dimension: nether, position: { x: 0, y: 40, z: 0 } }]) facts.sample(s);
	// A death row whose trail starts in the Overworld, before a portal trip 6 s ago.
	facts.deathRow({ diedAtEpochMs: 30_000, dimension: nether, position: { x: 0, y: 38, z: 0 }, armor: 0, trail: [{ s: -9, y: 90, health: 20 }, { s: -5, y: 41, health: 20, action: 'travel_to' }] });
	facts.modelCall({ at: 2000, modelCallId: 'c1', inputTokens: null });
	facts.modelCall({ at: 2100, modelCallId: 'c1', inputTokens: 1000, outputReconciled: true });
	facts.modelCall({ at: 2200, modelCallId: 'c2' });
	const game = facts.finish({ startedAt: 0, deaths: [{ at: 4000 }, { at: 30_000, damageType: 'minecraft:lava' }] });
	const [counter, row] = game.deaths;
	assert.deepEqual(counter.position, { x: 0, y: 31, z: 0 }, 'the dead sample, not the last living one, gives the height');
	assert.equal(counter.fall.blocks, 69);
	assert.equal(counter.respawn.dimension, over);
	assert.equal(row.fall.blocks, 3, 'the Overworld point before the portal trip is not the top of a Nether fall');
	assert.deepEqual({ calls: game.modelUse.calls, inputTokens: game.modelUse.inputTokens, cached: game.modelUse.cachedInputTokens }, { calls: 2, inputTokens: 1000, cached: null });
	assert.equal(game.end, null);
	const none = gameFacts();
	none.sample({ at: 1000, health: 20, dimension: 'minecraft:the_end', position: { x: 0, y: 64, z: 0 } });
	none.modelCall({ at: 1000 });
	const result = none.finish({ startedAt: 0 });
	assert.equal(result.end.dragonKilled, null, 'samples without advancements cannot show the dragon alive');
	assert.equal(result.modelUse.inputTokens, null, 'no call reported tokens: unknown, not 0');
	// A portal trip with no sample back in the death's dimension: no trail point is known to be there.
	const portal = gameFacts();
	portal.sample({ at: 2000, health: 20, deathCounter: 0, dimension: 'minecraft:the_nether', position: { x: 0, y: 100, z: 0 } });
	portal.sample({ at: 13_000, health: 20, deathCounter: 1, dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 } });
	portal.deathRow({ diedAtEpochMs: 10_000, dimension: 'minecraft:overworld', position: { x: 0, y: 60, z: 0 }, trail: [{ s: -8, y: 100 }, { s: -2, y: 61 }] });
	const [lost] = portal.finish({ startedAt: 0, deaths: [{ at: 10_000, damageType: 'minecraft:fall' }] }).deaths;
	assert.equal(lost.fall, null);
	assert.equal(lost.respawn.secondsAfterDeath, 3, 'the living sample whose counter stepped is the respawn');
	// Two deaths with no sample between them: the second death's respawn is not the first one's.
	const twice = gameFacts();
	twice.sample({ at: 5000, health: 20, deathCounter: 0, dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 } });
	twice.sample({ at: 14_000, health: 20, deathCounter: 2, dimension: 'minecraft:overworld', position: { x: 0, y: 64, z: 0 } });
	const [a, b] = twice.finish({ startedAt: 0, deaths: [{ at: 10_000, damageType: 'minecraft:fall' }, { at: 11_000, damageType: 'minecraft:fall' }] }).deaths;
	assert.equal(a.respawn, null);
	assert.equal(b.respawn.secondsAfterDeath, 3);
	// A later death's body and an earlier life's fall belong to their own deaths.
	const near = gameFacts();
	for (const sample of [{ at: 7000, y: 100, fallDistance: 30 }, { at: 9000, y: 70 }, { at: 9500, y: 70, health: 0, deathCounter: 1 }, { at: 12_000, y: 64, deathCounter: 1 }, { at: 16_000, y: 64, health: 0, deathCounter: 2 }])
		near.sample({ health: 20, deathCounter: 0, dimension: 'minecraft:overworld', ...sample, position: { x: 0, y: sample.y, z: 0 } });
	const [first, second] = near.finish({ startedAt: 0, deaths: [{ at: 9400, damageType: 'minecraft:fall' }, { at: 15_000, damageType: 'minecraft:mob_attack', attacker: 'minecraft:zombie' }] }).deaths;
	assert.equal(first.fall.blocks, 30);
	assert.deepEqual([second.fall?.blocks, second.maxFallDistance], [0, null], 'the earlier life\'s fall is not the second death\'s');
});
