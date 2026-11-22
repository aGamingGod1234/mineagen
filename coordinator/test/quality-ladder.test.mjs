import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { parseLadderArgs, runLadder, ladderRow, formatLadderReport } from '../../scripts/quality/run-ladder.mjs';
import { normalizeQualitySetup, applyQualitySetup } from '../src/benchmark/quality-scenarios.mjs';
import { readArtifactReport } from '../src/benchmark/report-artifacts.mjs';

test('parallel workers require bounded distinct port blocks', () => {
	assert.throws(() => parseLadderArgs(['--parallel', '2']), /port-base/);
	assert.throws(() => parseLadderArgs(['--parallel', '0']), /1..8/);
	assert.throws(() => parseLadderArgs(['--parallel', '2', '--port-base', '65530']), /exceed/);
	assert.throws(() => parseLadderArgs(['--arms', 'arms.json']), /paired/);
	const options = parseLadderArgs(['--parallel', '2', '--port-base', '28100']);
	assert.equal(options.runs, 1);
	assert.equal(options.scenarios, null);
});

test('ladder uses supported setups, non-premet inventory goals, and bounded budgets', async () => {
	const data = JSON.parse(await readFile(new URL('../../scripts/quality/ladder.json', import.meta.url), 'utf8'));
	assert.ok(data.scenarios.length >= 18 && data.scenarios.length <= 24);
	assert.equal(new Set(data.scenarios.map(s => s.id)).size, data.scenarios.length);
	for (const s of data.scenarios) {
		normalizeQualitySetup(s.setup);
		assert.ok(s.durationBudgetMs >= 300000 && s.durationBudgetMs <= 1200000);
		assert.equal(s.runPolicy.clock, 'goal-start');
		assert.ok(s.notes && s.successCheck && s.startState);
		for (const previous of s.handoffFrom) assert.ok(data.scenarios.some(s => s.id === previous));
	}
	assert.throws(() => normalizeQualitySetup({ ...data.scenarios[0].setup, standingOn: 'stone bricks' }), /standingOn/);
});

test('parallel execution isolates ports and artifacts, keeps failed launches and repetitions', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'ladder-'));
	const active = new Set(), dirs = new Set(), calls = [];
	try {
		const options = parseLadderArgs(['--scenarios', 'L-A1,L-A3,L-H1', '--runs', '2', '--parallel', '2', '--port-base', '28100', '--out', out]);
		const runs = await runLadder(options, async o => {
			assert.ok(!active.has(o.portBase)); active.add(o.portBase);
			assert.ok(!dirs.has(o.out)); dirs.add(o.out); calls.push(o);
			await new Promise(r => setTimeout(r, o.scenarios[0] === 'L-A1' ? 15 : 2));
			active.delete(o.portBase);
			if (o.scenarios[0] === 'L-A3') throw new Error('occupied port');
			return { runs: [{ scenario: o.scenarios[0], repetition: o.repetition, profile: { provider: o.provider }, goalCompleted: true, measurementStatus: 'MEASURED', metrics: { playWallTimeMs: 60000, deaths: 0, bodyIdleShare: 0.25, toolFailuresByCode: {} } }] };
		});
		assert.equal(calls.length, 6);
		assert.equal(runs.length, 6);
		assert.equal(runs.filter(r => r.termination === 'LAUNCH_ERROR').length, 2);
		assert.deepEqual([...new Set(calls.map(o => o.portBase))].sort(), [28100, 28110]);
		const report = await readArtifactReport(path.join(out, 'results.json'));
		assert.deepEqual(report.runs.map(r => r.scenario), ['L-A1', 'L-A1', 'L-A3', 'L-A3', 'L-H1', 'L-H1']);
		assert.match(await readFile(path.join(out, 'ladder-report.md'), 'utf8'), /occupied port/);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('report distinguishes verified completion, missing evidence and observed failure', () => {
	const pass = { scenario: 'L-A1', goalCompleted: true, measurementStatus: 'INCOMPLETE', metrics: { playWallTimeMs: 120000, bodyIdleShare: 0.2, deaths: 0, toolFailuresByCode: { BLOCKED: 2 } } };
	assert.equal(ladderRow(pass).bodyBusyPct, 80);
	assert.equal(ladderRow(pass).minutesToGoal, 2);
	assert.equal(ladderRow({ ...pass, goalCompleted: false }).minutesToGoal, null);
	assert.equal(ladderRow({ metrics: null }).deaths, null);
	assert.equal(ladderRow({ metrics: null }).bodyBusyPct, null);
	assert.match(formatLadderReport([pass]), /PASS \(INCOMPLETE\)/);
});

test('fixture construction waits for both dimensions and releases every owned chunk after failure', async () => {
	const commands = [];
	const setup = { dimension: 'minecraft:the_nether', position: [0,80,0], freezeUntilGoalStart: true,
		loadChunks: [{ dimension: 'minecraft:overworld', position: [3,81,-3] }], commands: ['fill 0 0 0 1 1 1 minecraft:stone'] };
	await assert.rejects(applyQualitySetup(setup, async c => {
		commands.push(c);
		return { text: c.startsWith('fill ') ? 'That position is not loaded' : c.includes(' if loaded ') ? 'The time is 0' : 'ok' };
	}, 'Check'), /not loaded/);
	assert.ok(commands.some(c => c.includes('minecraft:the_nether if loaded 0 80 0')));
	assert.ok(commands.some(c => c.includes('minecraft:overworld if loaded 3 81 -3')));
	assert.ok(commands.includes('execute in minecraft:overworld run forceload remove 3 -3'));
	assert.equal(commands.at(-1), 'execute in minecraft:the_nether run forceload remove 0 0');
});

test('structure placement requires the declared floor and checks frozen summoned entities after a tick', async () => {
	const commands = [];
	await applyQualitySetup({ dimension: 'minecraft:the_nether', position: [0,80,0], standingOn: 'minecraft:nether_bricks', airBlock: 'minecraft:cave_air',
		caveMaxY: 50, caveMinY: 49, freezeUntilGoalStart: true, commands: [],
		mobs: [{ id: 'minecraft:piglin', offset: [6,0,0], tag: 'trader' }] }, async c => {
		commands.push(c);
		return { text: c.includes(' if loaded ') ? 'The time is 0' : c.includes(' run tp ') && c.includes(' if block ') ? 'Teleported Check' : 'Check has the following entity data: [0d,50d,0d]' };
	}, 'Check');
	assert.ok(commands.some(c => c.includes('if block ~ ~-1 ~ minecraft:nether_bricks run tp')));
	assert.ok(commands.some(c => c.includes('if block ~ ~ ~ minecraft:cave_air if block ~ ~1 ~ minecraft:cave_air')));
	const summon = commands.findIndex(c => c.includes(' summon minecraft:piglin'));
	const verify = commands.findIndex(c => c.includes('tag=trader'));
	assert.ok(commands.slice(summon + 1, verify).includes('tick step 1'));
});

test('every ladder successCheck parses into a machine-readable evaluator spec', async () => {
	const { parseSuccessCheck } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const data = JSON.parse(await readFile(new URL('../../scripts/quality/ladder.json', import.meta.url), 'utf8'));
	for (const s of data.scenarios) assert.ok(parseSuccessCheck(s.successCheck).type, s.id);
	assert.deepEqual(parseSuccessCheck('inventory_contains_any: cooked_beef|cooked_porkchop >=20'), { type: 'inventory', items: ['minecraft:cooked_beef', 'minecraft:cooked_porkchop'], count: 20, sum: true });
	assert.throws(() => parseSuccessCheck('vibes: good'), /Unparseable/);
});

test('evaluator passes on any in-budget sample and reports time to pass', async () => {
	const { LadderEvaluator, parseSuccessCheck } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const inv = (...items) => `[${items.map(([id, count], i) => `{count: ${count}, Slot: ${i}b, id: "minecraft:${id}"}`).join(', ')}]`;
	const run = (check, samples, options) => { const e = new LadderEvaluator(parseSuccessCheck(check), options); for (const s of samples) if (e.push(s)) break; return e.finish(); };
	const crafts = run('inventory: iron_pickaxe, bucket >=1', [
		{ at: 1000, inventoryNbt: inv(['iron_pickaxe', 1]) }, { at: 5000, inventoryNbt: inv(['iron_pickaxe', 1], ['bucket', 1]) }], { goalStartAt: 1000, budgetMs: 10000 });
	assert.deepEqual([crafts.pass, crafts.timeToPassMs], [true, 4000]);
	assert.equal(run('inventory: bucket >=1', [{ at: 20000, inventoryNbt: inv(['bucket', 1]) }], { goalStartAt: 1000, budgetMs: 10000 }).pass, false, 'after the budget');
	const any = run('inventory_contains_any: cooked_beef|cooked_porkchop >=20', [{ at: 1, inventoryNbt: inv(['cooked_beef', 12], ['cooked_porkchop', 8]) }], { goalStartAt: 0 });
	assert.equal(any.pass, true);
	assert.equal(run('any advancement: nether/find_fortress OR nether/find_bastion', [{ at: 1, advancements: ['nether/find_bastion'] }], { goalStartAt: 0 }).pass, true);
	const near = { at: 1, dimension: 'minecraft:overworld', position: { x: 3, y: 81, z: 1 }, inventoryNbt: inv(['ender_eye', 12]) };
	const check = 'all: inventory ender_eye >=12 AND position_within overworld (2,81,0) radius6';
	assert.equal(run(check, [near], { goalStartAt: 0 }).pass, true);
	assert.equal(run(check, [{ ...near, dimension: 'minecraft:the_nether' }], { goalStartAt: 0 }).pass, false);
	assert.equal(run('advancement: story/enter_the_nether', [{ at: 1, advancements: [] }], { goalStartAt: 0, logAdvancements: ['story/enter_the_nether'] }).pass, false, 'unscoped advancement strings cannot prove success');
});

test('survive check needs the full duration and no death', async () => {
	const { LadderEvaluator, parseSuccessCheck } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const spec = parseSuccessCheck('survive_duration: 100 ticks; any death fails attempt');
	const feed = samples => { const e = new LadderEvaluator(spec, { goalStartAt: 0 }); samples.forEach(s => e.push(s)); return e.finish(); };
	assert.equal(feed([{ at: 1000, deathCounter: 0 }, { at: 5000, deathCounter: 0 }]).pass, true);
	assert.equal(feed([{ at: 1000, deathCounter: 0 }, { at: 2000, deathCounter: 1 }, { at: 9000, deathCounter: 1 }]).pass, false);
	assert.equal(feed([{ at: 1000, deathCounter: 0 }, { at: 4000, deathCounter: 0 }]).pass, false);
});

test('ladder rows separate the evaluator verdict from the agent goalCompleted', () => {
	const row = ladderRow({ scenario: 'L-A3', goalCompleted: false, measurementStatus: 'MEASURED', metrics: { playWallTimeMs: 300000 }, evaluation: { status: 'EVALUATED', pass: true, timeToPassMs: 27000, source: 'samples' } });
	assert.deepEqual([row.result, row.goalCompleted, row.evaluatorPass, row.minutesToGoal], ['PASS', false, true, 0.45]);
	assert.match(formatLadderReport([{ scenario: 'L-A3', goalCompleted: false, evaluation: { status: 'EVALUATED', pass: true, timeToPassMs: 27000 } }]), /\| PASS .*\| 0\.45 \| pass \| no \|/);
});

test('surface starts use the heightmap with the advertised biome and fail setup instead of going underground', async () => {
	const data = JSON.parse(await readFile(new URL('../../scripts/quality/ladder.json', import.meta.url), 'utf8'));
	const a1 = data.scenarios.find(s => s.id === 'L-A1').setup;
	assert.equal(a1.expectedBiome, 'minecraft:forest');
	assert.equal(a1.locate.id, 'minecraft:forest');
	const commands = [];
	await applyQualitySetup({ ...a1, locate: undefined, commands: [] }, async c => {
		commands.push(c);
		return { text: c.includes(' if loaded ') ? 'The time is 0' : c.includes(' run tp ') && c.includes('motion_blocking_no_leaves') ? 'Teleported Check' : 'Check has the following entity data: [134.5d,66d,488.5d]' };
	}, 'Check');
	const search = commands.find(c => c.includes(' run tp ') && c.includes('motion_blocking_no_leaves'));
	assert.ok(search.includes('if biome ~ ~ ~ minecraft:forest'));
	assert.ok(commands.some(c => c.includes('as Check at @s positioned over motion_blocking_no_leaves if entity @s[distance=..6]')));
	assert.ok(!commands.some(c => / positioned [\d.]+ -?\d+ [\d.]+ if block/.test(c)), 'no vertical scan for surface starts');
	await assert.rejects(applyQualitySetup({ ...a1, locate: undefined, commands: [] }, async c => ({ text: c.includes(' if loaded ') ? 'The time is 0' : c.includes('motion_blocking_no_leaves') && c.includes(' run tp ') ? 'Nothing matched' : 'Check has the following entity data: [134.5d,66d,488.5d]' }), 'Check'), /QUALITY_SETUP_SURFACE_GROUND_SEARCH/);
});

test('frozen fixtures step observation ticks after setup and record the prepared pose', async () => {
	const commands = [];
	const receipt = await applyQualitySetup({ dimension: 'minecraft:overworld', position: [0, 80, 0], freezeUntilGoalStart: true, commands: [] },
		async c => { commands.push(c); return { text: c.includes(' if loaded ') ? 'The time is 0' : 'Check has the following entity data: [1d,70d,2d]' }; }, 'Check');
	assert.deepEqual(receipt.definition.freshObservation.position, [1, 70, 2]);
	const survival = commands.lastIndexOf('gamemode survival Check');
	assert.ok(commands.slice(survival).filter(c => c === 'tick step 1').length >= 3);
});

const sample = (at, gameTime, extra = {}) => ({ at, gameTime, position: { x: 0, y: 64, z: 0 }, dimension: 'minecraft:overworld', health: 20, deathCounter: 0, advancements: [], ...extra });

test('survive_duration counts game ticks, not wall time', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const check = { successCheck: 'survive_duration: 1000 ticks; any death fails attempt', durationBudgetMs: 600000, goalStartAt: 0 };
	// Server at half speed: 50 s of wall time is only 500 ticks.
	const slow = Array.from({ length: 51 }, (_, i) => sample(i * 1000, 100 + i * 10));
	assert.equal(evaluateSamples(slow, check).pass, false);
	// Server at full speed passes at exactly 1000 ticks after the goal-start tick.
	const fast = Array.from({ length: 60 }, (_, i) => sample(i * 1000, 100 + i * 20));
	const ok = evaluateSamples(fast, check);
	assert.equal(ok.pass, true);
	assert.equal(ok.passTicks, 1000);
	assert.equal(ok.timeToPassMs, 50000);
});

test('samples without gameTime take their tick from the protocol observation clock', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const rows = [0, 60000].map(at => ({ envelope: { type: 'observation', payload: { observedAtEpochMs: at, world: { gameTime: at / 100 } } } }));
	const samples = Array.from({ length: 61 }, (_, i) => sample(i * 1000, undefined));
	const slow = evaluateSamples(samples, { successCheck: 'survive_duration: 1000 ticks', durationBudgetMs: 600000, goalStartAt: 0, protocolRows: rows });
	assert.equal(slow.pass, false);
});

test('a later death never overwrites a recorded pass', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const samples = [sample(0, 0), sample(1000, 20, { advancements: ['nether/find_fortress'] }), sample(2000, 40, { deathCounter: 1 })];
	const evaluation = evaluateSamples(samples, { successCheck: 'advancement: nether/find_fortress', durationBudgetMs: 60000, goalStartAt: 0 });
	assert.equal(evaluation.pass, true);
	assert.equal(evaluation.timeToPassMs, 1000);
	assert.equal(evaluation.postPass.died, true);
	assert.deepEqual(evaluation.evidence.advancements, ['nether/find_fortress']);
	const row = ladderRow({ scenario: 'L-B1', goalCompleted: false, termination: 'DEAD', evaluation, metrics: { playWallTimeMs: 3000, deaths: 1 } });
	assert.equal(row.result, 'PASS');
	assert.match(row.passedThen, /passed, then died at 2\.0s/);
});

test('a recorded pass survives a failing re-evaluation and relabels the runner termination', async () => {
	const { keepRecordedPass } = await import('../../scripts/quality/run-ladder.mjs');
	const recorded = { status: 'EVALUATED', pass: true, source: 'samples' };
	assert.equal(keepRecordedPass(recorded, { status: 'NO_ARTIFACTS', pass: false }), recorded);
	assert.equal(keepRecordedPass(undefined, { status: 'EVALUATED', pass: false }).pass, false);
});

test('EVALUATOR_PASS requests runner closeout before any owned-process hard stop', async () => {
	const { Observer } = await import('../../scripts/quality/run-scenarios.mjs');
	let kills = 0;
	const dir = await mkdtemp(path.join(os.tmpdir(), 'arena-closeout-'));
	const o = new Observer(dir, { protocolAudit: '', providerTurns: '' }, {}, {}, { stopRetryMs: 0, hardStop: async () => { kills++; } });
	o.agent = 'player'; o.rcon = { command: async () => ({ text: 'Stopped player' }) };
	await o.requestStop('EVALUATOR_PASS', { timeToPassMs: 1 });
	await o.progressStop();
	assert.equal(kills, 0);
	assert.equal(o.stopRequest.state, 'pending');
	assert.equal(JSON.parse(await readFile(path.join(dir, 'quality-stop.json'), 'utf8')).reason, 'EVALUATOR_PASS');
	await rm(dir, { recursive: true, force: true });
	const p = new Observer('.', { protocolAudit: '', providerTurns: '' }, {}, {}, { stopRetryMs: 0, hardStop: async () => { kills++; } });
	p.agent = 'player'; p.rcon = { command: async () => ({ text: 'Stopped player' }) };
	await p.requestStop('ADVANCEMENT');
	await p.progressStop();
	assert.equal(kills, 0);
});

test('server completion of a different predicate cannot replace the requested advancement', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const rows = (predicate) => [
		{ envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: 1000, goalSpec: { predicate } } } },
		{ envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'complete', updatedAtEpochMs: 31000 } } },
	];
	const check = { successCheck: 'advancement: story/mine_stone', durationBudgetMs: 600000, goalStartAt: 1000 };
	const samples = [{ at: 2000, advancements: [], inventoryNbt: '' }];
	const factual = evaluateSamples(samples, { ...check, protocolRows: rows({ type: 'inventory_contains', itemId: 'minecraft:stone', count: 1 }) });
	assert.deepEqual([factual.pass, factual.source, factual.timeToPassMs], [false, null, null]);
	const row = ladderRow({ scenario: 'L-A3', goalCompleted: true, evaluation: factual, metrics: { playWallTimeMs: 31000 } });
	assert.deepEqual([row.result, row.evaluatorSource, row.minutesToGoal], ['FAIL', null, null]);
	assert.match(formatLadderReport([{ scenario: 'L-A3', goalCompleted: true, evaluation: factual }]), /\| fail \| yes \| n\/a \|/);
	const confirmed = evaluateSamples(samples, { ...check, protocolRows: rows({ type: 'operator_confirmed' }) });
	assert.equal(confirmed.pass, false);
});

// Partial credit (evaluator version 3): reported beside PASS/FAIL, never part of it.
const nbt = (...items) => `[${items.map(([id, count], i) => `{count: ${count}, Slot: ${i}b, id: "minecraft:${id}"}`).join(', ')}]`;
const verdict = e => ({ pass: e.pass, passAt: e.passAt, timeToPassMs: e.timeToPassMs, source: e.source, died: e.died, lastSampleAt: e.lastSampleAt, passTicks: e.passTicks, evidence: e.evidence, postPass: e.postPass });

test('a failed run keeps its best and end counts across a death', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const rods = [0, 1, 3, 5, 5, 0, 1], deaths = [0, 0, 0, 0, 1, 1, 1];
	const samples = rods.map((n, i) => sample(i * 1000, i * 20, { deathCounter: deaths[i], inventoryNbt: nbt(['ender_pearl', 14], ...(n ? [['blaze_rod', n]] : [])) }));
	const kit = [{ item: 'minecraft:ender_pearl', count: 14 }];
	const e = evaluateSamples(samples, { successCheck: 'inventory: blaze_rod >=7', durationBudgetMs: 60000, goalStartAt: 0, setup: { inventory: kit } });
	assert.equal(e.pass, false);
	assert.equal(e.died, true);
	assert.equal(e.evaluatorVersion, 3);
	assert.deepEqual(e.progress, [{ type: 'inventory', items: ['blaze_rod'], target: 7, supplied: 0, kitSource: 'scenario setup', needed: 7, bestHeld: 5, endHeld: 1, bestEarned: 5, endEarned: 1, samples: 7 }]);
	const row = ladderRow({ scenario: 'L-D1', goalCompleted: false, evaluation: e, metrics: { deaths: 1 } });
	assert.deepEqual([row.result, row.progressText], ['FAIL', 'blaze_rod best 5/7, end 1']);
	assert.match(formatLadderReport([{ scenario: 'L-D1', goalCompleted: false, evaluation: e }]), /\| FAIL \(\?\) \| blaze_rod best 5\/7, end 1 \| \? \| fail \| no \|/);
	// Samples after the budget never count, like the verdict.
	const late = evaluateSamples([...samples, sample(70000, 1400, { inventoryNbt: nbt(['blaze_rod', 6]) })], { successCheck: 'inventory: blaze_rod >=7', durationBudgetMs: 60000, goalStartAt: 0 });
	assert.equal(late.progress[0].bestHeld, 5);
});

test('the starting kit is not counted as progress and unreadable inventories are unknown, not zero', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const pearls = [4, 6, 10, null, 8];
	const samples = pearls.map((n, i) => sample(i * 1000, i * 20, { inventoryNbt: n === null ? undefined : nbt(['ender_pearl', n]) }));
	const check = { successCheck: 'inventory: ender_pearl >=14', durationBudgetMs: 60000, goalStartAt: 0 };
	const given = evaluateSamples(samples, { ...check, setup: { inventory: [{ item: 'minecraft:ender_pearl', count: 4 }] } });
	assert.deepEqual([given.progress[0].supplied, given.progress[0].needed, given.progress[0].bestEarned, given.progress[0].endEarned, given.progress[0].samples], [4, 10, 6, 4, 4]);
	assert.equal(ladderRow({ scenario: 'L-C3', evaluation: given }).progressText, 'ender_pearl best 6/10, end 4 (net of 4 given)');
	// An explicit kit (the applied quality-setup.json) wins over the scenario setup; with neither, the first readable sample is the baseline.
	const applied = evaluateSamples(samples, { ...check, setup: { inventory: [] }, startingInventory: [{ item: 'ender_pearl', count: 2 }], startingInventorySource: 'applied setup' });
	assert.deepEqual([applied.progress[0].supplied, applied.progress[0].kitSource, applied.progress[0].bestEarned], [2, 'applied setup', 8]);
	const fallback = evaluateSamples(samples, check);
	assert.deepEqual([fallback.progress[0].supplied, fallback.progress[0].kitSource], [4, 'first sample']);
	// Spending kit items reads as zero earned, never negative.
	assert.equal(evaluateSamples([sample(0, 0, { inventoryNbt: nbt(['ender_pearl', 1]) })], { ...check, setup: { inventory: [{ item: 'minecraft:ender_pearl', count: 4 }] } }).progress[0].endEarned, 0);
	// The kit changes progress only: the verdict is identical with or without it.
	assert.deepEqual(verdict(given), verdict(fallback));
	assert.deepEqual(verdict(given), verdict(applied));
});

test('an unreadable final inventory leaves the end count unknown instead of reusing an earlier one', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const rods = [0, 5, null];
	const samples = rods.map((n, i) => sample(i * 1000, i * 20, { inventoryNbt: n === null ? undefined : nbt(...(n ? [['blaze_rod', n]] : [])) }));
	const e = evaluateSamples(samples, { successCheck: 'inventory: blaze_rod >=7', durationBudgetMs: 60000, goalStartAt: 0, setup: { inventory: [] } });
	assert.deepEqual([e.progress[0].bestHeld, e.progress[0].endHeld, e.progress[0].endEarned, e.progress[0].samples], [5, null, null, 2]);
	assert.equal(ladderRow({ scenario: 'L-D1', evaluation: e }).progressText, 'blaze_rod best 5/7, end unknown');
});

test('progress reaches the target exactly when the inventory verdict passes', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const checks = ['inventory: blaze_rod >=7', 'inventory_contains_any: cooked_beef|cooked_porkchop >=20', 'inventory: iron_ingot >=3'];
	let seed = 7;
	const rand = n => { seed = (seed * 1103515245 + 12345) % 2147483648; return seed % n; };
	for (let trial = 0; trial < 200; trial++) {
		const samples = Array.from({ length: 1 + rand(8) }, (_, i) => sample(i * 1000, i * 20, { inventoryNbt: nbt(['blaze_rod', rand(9)], ['cooked_beef', rand(15)], ['cooked_porkchop', rand(15)], ['iron_ingot', rand(5)]) }));
		for (const successCheck of checks) {
			const e = evaluateSamples(samples, { successCheck, durationBudgetMs: 60000, goalStartAt: 0, setup: { inventory: [] } });
			assert.equal(e.progress[0].bestHeld >= e.progress[0].target, e.pass, `${successCheck} trial ${trial}`);
		}
	}
});

test('a horizontal position clause ignores height, for a walk over or round a hill', async () => {
	const { evaluateSamples, parseSuccessCheck } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const check = 'all: position_within_xz overworld (213.5, 108.5) radius 16 AND survive_duration: 0 ticks';
	assert.deepEqual(parseSuccessCheck(check).of[0], { type: 'position', horizontal: true, dimension: 'minecraft:overworld', center: [213.5, 108.5], radius: 16 });
	const at = (x, y, t) => sample(t, t / 50, { dimension: 'minecraft:overworld', position: { x, y, z: 108.5 } });
	// 40 blocks up a hill at the target column passes; a 3D sphere of radius 16 round y 66 would not.
	const high = evaluateSamples([at(13.5, 66, 0), at(120, 90, 1000), at(205, 106, 2000)], { successCheck: check, durationBudgetMs: 60000, goalStartAt: 0 });
	assert.equal(high.pass, true);
	const short = evaluateSamples([at(13.5, 66, 0), at(150, 66, 1000)], { successCheck: check, durationBudgetMs: 60000, goalStartAt: 0 });
	assert.equal(short.pass, false);
	assert.equal(short.progress[0].closest, 63.5);
});

test('survival, position and advancement clauses report how far the run got', async () => {
	const { evaluateSamples } = await import('../../scripts/quality/ladder-evaluator.mjs');
	const survive = evaluateSamples([sample(0, 100), sample(1000, 120), sample(2000, 140), sample(3000, 160, { deathCounter: 1 }), sample(4000, 180, { deathCounter: 1 })],
		{ successCheck: 'survive_duration: 1000 ticks; any death fails attempt', durationBudgetMs: 600000, goalStartAt: 0 });
	assert.equal(survive.pass, false);
	assert.deepEqual(survive.progress, [{ type: 'survive', target: 1000, survivedTicks: 40, died: true, clock: 'game-ticks' }]);
	assert.equal(ladderRow({ evaluation: survive }).progressText, 'survived 40/1000 ticks, died');
	const at = (d, x, t) => sample(t, t / 50, { dimension: `minecraft:${d}`, position: { x, y: 64, z: 0 } });
	const check = 'position_within the_end (0,64,0) radius40';
	const far = evaluateSamples([at('overworld', 5, 0), at('the_end', 90, 1000), at('the_end', 60, 2000), at('the_end', 75, 3000)], { successCheck: check, durationBudgetMs: 60000, goalStartAt: 0 });
	assert.equal(far.pass, false);
	assert.deepEqual([far.progress[0].closest, far.progress[0].end, far.progress[0].reached], [60, 75, false]);
	assert.equal(ladderRow({ evaluation: far }).progressText, 'the_end (0,64,0) closest 60/40 blocks, end 75');
	const never = evaluateSamples([at('overworld', 5, 0)], { successCheck: check, durationBudgetMs: 60000, goalStartAt: 0 });
	assert.equal(ladderRow({ evaluation: never }).progressText, 'the_end (0,64,0) not reached');
	const both = evaluateSamples([sample(0, 0, { inventoryNbt: nbt(['ender_eye', 9]), position: { x: 2, y: 81, z: 0 } })],
		{ successCheck: 'all: inventory ender_eye >=12 AND position_within overworld (2,81,0) radius6', durationBudgetMs: 60000, goalStartAt: 0, setup: { inventory: [] } });
	assert.equal(both.pass, false);
	assert.equal(ladderRow({ evaluation: both }).progressText, 'ender_eye best 9/12, end 9; overworld (2,81,0) closest 0/6 blocks, end 0');
	const any = evaluateSamples([sample(0, 0, { advancements: ['nether/find_bastion'] })], { successCheck: 'any advancement: nether/find_fortress OR nether/find_bastion', durationBudgetMs: 60000, goalStartAt: 0 });
	assert.equal(ladderRow({ evaluation: any }).progressText, 'nether/find_fortress not reached; nether/find_bastion reached');
});

test('results saved before progress existed still load, report n/a and rescore with progress', async () => {
	const { writeArtifactReport } = await import('../src/benchmark/report-artifacts.mjs');
	const { rescoreLadder } = await import('../../scripts/quality/run-ladder.mjs');
	const { writeFile, mkdir } = await import('node:fs/promises');
	const old = { pass: false, passAt: null, timeToPassMs: null, source: null, died: true, lastSampleAt: 4000, evaluatorVersion: 2, status: 'EVALUATED', check: 'inventory: blaze_rod >=7', samples: 4 };
	const row = ladderRow({ scenario: 'L-D1', goalCompleted: false, evaluation: old });
	assert.deepEqual([row.result, row.progress, row.progressText], ['FAIL', null, null]);
	assert.match(formatLadderReport([{ scenario: 'L-D1', evaluation: old }]), /\| FAIL \(\?\) \| n\/a \|/);
	const dir = await mkdtemp(path.join(os.tmpdir(), 'ladder-rescore-'));
	try {
		const artifacts = path.join(dir, 'q-old-L-D1-r1');
		await mkdir(artifacts);
		const rods = [0, 2, 4, 1];
		await writeFile(path.join(artifacts, 'quality-samples.json'), JSON.stringify({ samples: rods.map((n, i) => sample(1000 + i * 1000, i * 20, { deathCounter: i === 3 ? 1 : 0, inventoryNbt: nbt(['ender_pearl', 10], ['blaze_rod', n]) })) }));
		await writeFile(path.join(artifacts, 'quality-setup.json'), JSON.stringify({ definition: { inventory: [{ item: 'minecraft:ender_pearl', count: 10 }] } }));
		await writeFile(path.join(artifacts, 'report.json'), JSON.stringify({ budget: { goalStartedAt: 1000 } }));
		await writeArtifactReport(path.join(dir, 'results.json'), { schemaVersion: 1, benchmark: 'route-ladder', runs: [{ scenario: 'L-D1', repetition: 1, goalCompleted: false, artifacts: '/elsewhere/q-old-L-D1-r1', evaluation: old, metrics: { deaths: 1 } }] });
		const [run] = await rescoreLadder(dir);
		assert.deepEqual([run.evaluation.pass, run.evaluation.died, run.evaluation.evaluatorVersion, run.evaluation.progress[0].kitSource], [false, true, 3, 'applied setup']);
		assert.equal(ladderRow(run).progressText, 'blaze_rod best 4/7, end 1');
		assert.match(await readFile(path.join(dir, 'ladder-rescored.md'), 'utf8'), /\| FAIL \(\?\) \| blaze_rod best 4\/7, end 1 \|/);
		assert.equal(JSON.parse(await readFile(path.join(dir, 'ladder-rescored.json'), 'utf8'))[0].progress[0].bestEarned, 4);
	} finally { await rm(dir, { recursive: true, force: true }); }
});
