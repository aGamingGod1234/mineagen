import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { DANGER_SCHEMA, judgeRooms, noiseFloor, pairRuns, reconcileDamage, roomWindowMs, scoreRun, windowDeaths } from '../../scripts/quality/lib/reflex-round.mjs';
import { buildReport, parseReportArgs } from '../../scripts/quality/reflex-round-report.mjs';
import { readWatchDir } from '../../scripts/quality/watch-files.mjs';

// The same lines src/test/java/dev/agaminggod/mineagen/server/watch/WatchVerification.java generates from DangerLog.
const FIXTURE = new URL('./fixtures/reflex-danger-rows.jsonl', import.meta.url);
const golden = async () => (await readFile(FIXTURE, 'utf8')).trim().split('\n').map(line => JSON.parse(line));
const START = 1_700_000_000_000 - 1_000;
const counter = (atMs, tenths, deaths = 0) => ({ at: atMs, damageTakenCounter: tenths, deathCounter: deaths, health: 20 });
const damage = (atMs, healthDrop, extra = {}) => ({ type: 'damage', schema: DANGER_SCHEMA, atMs, healthDrop, absorbed: 0, paired: true, lethal: false, blocked: false, ...extra });

test('the fixture has one row of each kind the Watcher writes, all on the current schema', async () => {
	const rows = await golden();
	assert.deepEqual(rows.map(row => row.type).sort(), ['clear', 'damage', 'firing', 'onset', 'reflex_event']);
	assert.ok(rows.every(row => row.schema === DANGER_SCHEMA && Number.isFinite(row.atMs) && Number.isFinite(row.gameTime)));
	const firing = rows.find(row => row.type === 'firing');
	assert.ok(firing.startGameTime <= firing.endGameTime);
});

test('a run is scored on window damage, deaths and success, reconciled with the vanilla counter', async () => {
	const rows = await golden();
	const samples = [counter(START, 0), counter(START + 60_000, 20), counter(START + 300_000, 20)];
	const run = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples, dangerRows: rows, evaluation: { status: 'EVALUATED', pass: true } });
	assert.equal(run.status, 'valid');
	assert.equal(run.damage, 2);
	assert.equal(run.absorbedHp, 3);
	assert.equal(run.deaths, 0);
	assert.equal(run.success, true);
	assert.equal(run.windowMs, 300_000);
	assert.equal(run.diagnostics.onsets, 1);
	assert.equal(run.diagnostics.opportunity, 'opportunity');
	assert.equal(run.diagnostics.threatMs, 500);
	assert.deepEqual(run.diagnostics.responses.paths, { 'command:model': 1 });
	assert.equal(run.diagnostics.responses.latencyTicks.p50, 6);
	assert.equal(run.diagnostics.damagePerThreatMinute, 240);
	assert.equal(run.diagnostics.firings.count, 1);
	assert.equal(run.diagnostics.firings.orderViolations, 0);
	assert.equal(scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples, dangerRows: rows }).success, null, 'no evaluation is unknown success, not a failure');
});

test('a counter that disagrees is invalid, a missing counter or Watcher file is unknown, never 0', async () => {
	const rows = await golden();
	const mismatch = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples: [counter(START, 0), counter(START + 300_000, 50)], dangerRows: rows });
	assert.equal(mismatch.status, 'invalid');
	assert.equal(mismatch.damage, null);
	const noCounter = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples: [{ at: START, health: 20 }], dangerRows: rows });
	assert.equal(noCounter.status, 'unknown');
	assert.equal(noCounter.damage, null);
	const noWatch = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples: [counter(START, 0), counter(START + 300_000, 0)], dangerRows: null });
	assert.equal(noWatch.status, 'unknown');
	assert.equal(noWatch.diagnostics, undefined);
	const unpaired = reconcileDamage([damage(START + 10, null, { paired: false })], [counter(START, 0), counter(START + 1000, 10)]);
	assert.equal(unpaired.status, 'unknown');
	const decreasing = reconcileDamage([], [counter(START, 10), counter(START + 1000, 0)]);
	assert.equal(decreasing.status, 'unknown');
});

test('a negative or fractional damage counter sample is corrupt: unknown damage, never a clean 0', () => {
	for (const bad of [-100, 1.5, '0']) {
		const samples = [counter(START, bad), counter(START + 150_000, 0), counter(START + 300_000, 0)];
		assert.equal(reconcileDamage([], samples).status, 'unknown', `counter ${bad}`);
		const run = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples, dangerRows: [] });
		assert.equal(run.status, 'unknown', `counter ${bad} through scoreRun`);
		assert.equal(run.damage, null);
	}
	assert.equal(reconcileDamage([], [counter(START, null), counter(START + 300_000, 0)]).status, 'valid', 'a sample with no reading is missing, not corrupt');
});

test('reconciliation tolerates rounding per hit, an edge hit, and a lethal hit read in full by the counter', () => {
	const end = START + 300_000;
	const samples = [counter(START, 0), counter(end, 31)];
	assert.equal(reconcileDamage([damage(START + 5, 1.55), damage(START + 9, 1.53)], samples).status, 'valid', 'rounding within 0.05 HP per hit');
	assert.equal(reconcileDamage([damage(START + 5, 2.0)], samples).status, 'invalid');
	// The counter's final sample may land either side of a hit within the clock slack.
	const edge = [damage(START + 5, 2.1), damage(end + 1_000, 1.0)];
	assert.equal(reconcileDamage(edge, [counter(START, 0), counter(end, 21)]).status, 'valid', 'counter before the edge hit');
	assert.equal(reconcileDamage(edge, [counter(START, 0), counter(end, 31)]).status, 'valid', 'counter after the edge hit');
	// A lethal hit's row stops at 0 health while the counter counts the whole hit: the counter may only read higher.
	const lethal = [damage(START + 5, 3, { lethal: true })];
	assert.equal(reconcileDamage(lethal, [counter(START, 0), counter(end, 80)]).status, 'valid');
	assert.equal(reconcileDamage(lethal, [counter(START, 0), counter(end, 10)]).status, 'invalid');
});

test('a capture that stops before the room window ends is unknown, never a clean room', () => {
	const truncated = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples: [counter(START, 0, 0)], dangerRows: [] });
	assert.equal(truncated.status, 'unknown');
	assert.equal(truncated.damage, null);
	assert.equal(truncated.deaths, null);
	assert.match(truncated.reconciliation.reason, /do not cover the room window/);
	const lateStart = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples: [counter(START + 60_000, 0, 0), counter(START + 300_000, 0, 0)], dangerRows: [] });
	assert.equal(lateStart.status, 'unknown', 'samples must reach the window start too');
	const full = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples: [counter(START, 0, 0), counter(START + 299_000, 0, 0)], dangerRows: [] });
	assert.equal(full.status, 'valid');
	assert.equal(full.damage, 0);
	const [a] = [scored('R-SKELETON', 1, 4)];
	assert.equal(pairRuns([a], [{ ...truncated, pairId: 'R-SKELETON-r1' }])[0].deltas.damage, null, 'the pair is incomplete');
});

test('each room is scored over its own window; deaths come from the death counter', () => {
	assert.equal(roomWindowMs('R-FLOOD'), 360_000);
	assert.equal(roomWindowMs('R-TOOLBREAK'), 180_000);
	assert.equal(roomWindowMs('R-CREEPER'), 300_000);
	const rows = [damage(START + 100_000, 2), damage(START + 200_000, 4)];
	const samples = [counter(START, 0, 0), counter(START + 250_000, 60, 1), counter(START + 300_000, 60, 1)];
	const toolbreak = scoreRun({ scenario: 'R-TOOLBREAK', goalStartedAtMs: START, samples, dangerRows: rows });
	assert.equal(toolbreak.damage, 2, 'a hit after 180 s is outside R-TOOLBREAK');
	const creeper = scoreRun({ scenario: 'R-CREEPER', goalStartedAtMs: START, samples, dangerRows: rows });
	assert.equal(creeper.damage, 6);
	assert.equal(creeper.deaths, 1);
	assert.equal(creeper.diagnostics.opportunity, 'no_opportunity', 'no onset is no opportunity, not a clean pass');
	assert.equal(creeper.diagnostics.damagePerThreatMinute, null);
	const other = scoreRun({ scenario: 'R-CREEPER', goalStartedAtMs: START, samples, dangerRows: [...rows, { type: 'damage', schema: 99, atMs: START, healthDrop: 9 }] });
	assert.equal(other.otherSchemaRows, 1);
	assert.equal(other.damage, 6, 'rows of another schema are counted apart, never mixed in');
});

const scored = (scenario, repetition, damageHp, { deaths = 0, success = true, status = 'valid' } = {}) =>
	({ pairId: `${scenario}-r${repetition}`, scenario, status, damage: status === 'valid' ? damageHp : null, deaths: status === 'valid' ? deaths : null, success });

test('paired arms: per-pair deltas summed by room, judged against a margin set in advance', () => {
	const a = [1, 2, 3, 4].map(n => scored('R-SKELETON', n, 4));
	const same = [1, 2, 3, 4].map(n => scored('R-SKELETON', n, [5, 3, 4, 4][n - 1]));
	const pairs = pairRuns(a, same);
	assert.deepEqual(pairs.map(pair => pair.deltas.damage), [1, -1, 0, 0]);
	assert.deepEqual(judgeRooms(pairs).rooms['R-SKELETON'].damage.verdict, 'NO_MARGIN');
	const floor = noiseFloor(pairs);
	assert.equal(floor.rooms['R-SKELETON'].damage.pairs, 4);
	assert.ok(floor.rooms['R-SKELETON'].damage.perPairSd > 0.8 && floor.rooms['R-SKELETON'].damage.perPairSd < 0.83);
	const margin = { z: 2, rooms: { 'R-SKELETON': { damage: { perPairSd: 1 }, deaths: { perPairSd: 0.5 }, success: { perPairSd: 0.5 } } } };
	const identical = judgeRooms(pairs, margin);
	assert.equal(identical.rooms['R-SKELETON'].damage.verdict, 'INCONCLUSIVE', 'identical arms stay inside the margin');
	assert.equal(identical.rooms['R-SKELETON'].damage.margin, 4, 'z x SD x sqrt(4 pairs)');
	assert.equal(identical.overall, 'INCONCLUSIVE');
	const worse = judgeRooms(pairRuns(a, [1, 2, 3, 4].map(n => scored('R-SKELETON', n, 8))), margin);
	assert.equal(worse.rooms['R-SKELETON'].damage.sum, 16);
	assert.equal(worse.rooms['R-SKELETON'].damage.verdict, 'WORSE');
	assert.equal(worse.overall, 'FAIL');
	const lost = judgeRooms(pairRuns(a, [1, 2, 3, 4].map(n => scored('R-SKELETON', n, 4, { success: false }))), margin);
	assert.equal(lost.rooms['R-SKELETON'].success.verdict, 'WORSE', 'fewer successes is worse');
	const better = judgeRooms(pairRuns(a, [1, 2, 3, 4].map(n => scored('R-SKELETON', n, 0))), margin);
	assert.equal(better.rooms['R-SKELETON'].damage.verdict, 'BETTER');
});

test('deaths and success keep a one-event margin when the A/A run never varied', () => {
	const a = [1, 2, 3, 4].map(n => scored('R-CREEPER', n, 4));
	const flat = { z: 2, rooms: { 'R-CREEPER': { damage: { perPairSd: 1 }, deaths: { perPairSd: 0 }, success: { perPairSd: 0 } } } };
	const oneDeath = judgeRooms(pairRuns(a, [1, 2, 3, 4].map(n => scored('R-CREEPER', n, 4, { deaths: n === 1 ? 1 : 0 }))), flat);
	assert.equal(oneDeath.rooms['R-CREEPER'].deaths.margin, 1);
	assert.equal(oneDeath.rooms['R-CREEPER'].deaths.verdict, 'INCONCLUSIVE', 'one death is not a result');
	const twoDeaths = judgeRooms(pairRuns(a, [1, 2, 3, 4].map(n => scored('R-CREEPER', n, 4, { deaths: n <= 2 ? 1 : 0 }))), flat);
	assert.equal(twoDeaths.rooms['R-CREEPER'].deaths.verdict, 'WORSE');
	const oneLoss = judgeRooms(pairRuns(a, [1, 2, 3, 4].map(n => scored('R-CREEPER', n, 4, { success: n !== 1 }))), flat);
	assert.equal(oneLoss.rooms['R-CREEPER'].success.verdict, 'INCONCLUSIVE');
});

test('damage keeps a 1 HP margin when the A/A run never varied: one half-heart hit is not WORSE', () => {
	const a = [1, 2, 3, 4].map(n => scored('R-CREEPER', n, 0));
	const flat = { z: 2, rooms: { 'R-CREEPER': { damage: { perPairSd: 0 }, deaths: { perPairSd: 0 }, success: { perPairSd: 0 } } } };
	const halfHeart = judgeRooms(pairRuns(a, [1, 2, 3, 4].map(n => scored('R-CREEPER', n, n === 1 ? 0.5 : 0))), flat);
	assert.equal(halfHeart.rooms['R-CREEPER'].damage.margin, 1);
	assert.equal(halfHeart.rooms['R-CREEPER'].damage.verdict, 'INCONCLUSIVE');
	assert.equal(judgeRooms(pairRuns(a, [1, 2, 3, 4].map(n => scored('R-CREEPER', n, n === 1 ? 2 : 0))), flat).rooms['R-CREEPER'].damage.verdict, 'WORSE');
});

test('deaths stand on the death counter, not the damage reconciliation: an unpaired damage row leaves them counted', () => {
	const samples = [counter(START, 0, 0), counter(START + 200_000, 40, 1), counter(START + 300_000, 40, 1)];
	const rows = [damage(START + 100_000, null, { paired: false }), damage(START + 199_000, 4, { lethal: true })];
	const run = scoreRun({ scenario: 'R-CREEPER', goalStartedAtMs: START, samples, dangerRows: rows });
	assert.equal(run.status, 'unknown', 'damage is unknown');
	assert.equal(run.damage, null);
	assert.equal(run.deaths, 1);
	const [pair] = pairRuns([{ ...scored('R-CREEPER', 1, 0), deaths: 0 }], [{ ...run, pairId: 'R-CREEPER-r1' }]);
	assert.equal(pair.deltas.damage, null);
	assert.equal(pair.deltas.deaths, 1, 'the pair counts for deaths');
	// A death counter that stops before the window ends is unknown deaths unless reconciled damage rows stand in for it.
	const shortSamples = [counter(START, 0, 0), counter(START + 100_000, 0, 0), { at: START + 300_000, damageTakenCounter: 0, health: 20 }];
	const short = scoreRun({ scenario: 'R-CREEPER', goalStartedAtMs: START, dangerRows: [damage(START + 10, null, { paired: false })], samples: shortSamples });
	assert.equal(short.status, 'unknown');
	assert.equal(short.deaths, null);
	assert.equal(scoreRun({ scenario: 'R-CREEPER', goalStartedAtMs: START, dangerRows: [], samples: shortSamples }).deaths, 0, 'reconciled rows with no lethal hit');
});

test('an invalid, unknown or missing run leaves its pair incomplete, never a zero', () => {
	const a = [scored('R-BLAZE', 1, 4), scored('R-BLAZE', 2, 4), scored('R-BLAZE', 3, 4)];
	const b = [scored('R-BLAZE', 1, 4, { status: 'invalid' }), scored('R-BLAZE', 2, 6)];
	const judged = judgeRooms(pairRuns(a, b), { rooms: { 'R-BLAZE': { damage: { perPairSd: 1 } } } });
	assert.equal(judged.rooms['R-BLAZE'].damage.complete, 1);
	assert.equal(judged.rooms['R-BLAZE'].damage.incomplete, 2);
	assert.equal(judged.rooms['R-BLAZE'].damage.sum, 2);
	assert.equal(judged.rooms['R-BLAZE'].pairs, 3);
});

test('deaths come from counter samples at both room boundaries; a missing boundary or a falling counter is unknown', () => {
	const deathsAt = (...points) => points.map(([seconds, deaths]) => ({ at: START + seconds * 1000, deathCounter: deaths }));
	// R-TOOLBREAK ends at 180 s: samples at 100 s and 250 s leave the end boundary unsampled, so a death at 170 s is unknown.
	assert.equal(windowDeaths(deathsAt([0, 0], [100, 0], [250, 1], [300, 1]), START, START + 180_000), null);
	assert.equal(scoreRun({ scenario: 'R-TOOLBREAK', goalStartedAtMs: START, samples: deathsAt([0, 0], [100, 0], [250, 1], [300, 1]) }).deaths, null);
	assert.equal(windowDeaths(deathsAt([0, 0], [100, 0], [179, 1], [250, 1]), START, START + 180_000), 1);
	assert.equal(windowDeaths(deathsAt([0, 0], [150, 2], [300, 0]), START, START + 300_000), null, 'a counter that goes down is corrupt');
	assert.equal(windowDeaths(deathsAt([0, 0], [300, 1.5]), START, START + 300_000), null, 'a fractional counter is corrupt');
	assert.equal(windowDeaths(deathsAt([-60, 0], [10, 1], [300, 2]), START, START + 300_000), null, 'no sample near the start');
	// The sampler pauses while the player is dead: a death at 280 s with no respawn by 300 s is covered by its dead event.
	const deadLate = [{ operation: 'start', at: START }, { operation: 'dead', at: START + 280_500 }];
	assert.equal(windowDeaths(deathsAt([0, 0], [280, 0]), START, START + 300_000, deadLate), 1);
	assert.equal(windowDeaths(deathsAt([0, 0], [280, 0]), START, START + 300_000, [...deadLate, { operation: 'respawn', at: START + 285_000 }]), null,
		'respawned but no closing sample is still unknown');
	const late = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples: [counter(START, 0, 0), counter(START + 280_000, 120, 0)],
		dangerRows: [damage(START + 100_000, 12), damage(START + 280_400, 8, { lethal: true })], lifecycle: deadLate });
	assert.equal(late.status, 'valid', late.reconciliation.reason);
	assert.equal(late.deaths, 1);
	assert.equal(late.damage, 20);
	// A death inside the closing 5 s margin, after the closing sample, with no respawn by the end.
	assert.equal(windowDeaths(deathsAt([0, 0], [297, 0]), START, START + 300_000, [{ operation: 'dead', at: START + 299_000 }]), 1);
	assert.equal(windowDeaths(deathsAt([0, 0], [297, 0]), START, START + 300_000,
		[{ operation: 'dead', at: START + 298_000 }, { operation: 'respawn', at: START + 299_000 }]), 1, 'a death after the closing sample counts even when it respawned');
	assert.equal(windowDeaths(deathsAt([0, 0], [297, 1]), START, START + 300_000, [{ operation: 'dead', at: START + 296_000 }]), 1, 'a death the closing sample already counts is not counted twice');
	// A sample stamped just before the death that read the raised counter, then no sample to the end: one death, not two.
	const stampedBefore = [{ operation: 'dead', at: START + 280_000 }];
	assert.equal(windowDeaths(deathsAt([0, 0], [278.9, 0], [279.9, 1]), START, START + 300_000, stampedBefore), 1);
	assert.equal(windowDeaths(deathsAt([0, 0], [278.9, 0], [279.9, 1], [280.4, 1]), START, START + 300_000, stampedBefore), 1);
	// Deaths just outside the window do not count: one 3 s after the end, read by a sample 4 s after it, and one 2 s before
	// the start, after a base sample 4 s before it.
	assert.equal(windowDeaths(deathsAt([0, 0], [296, 0], [304, 1]), START, START + 300_000, [{ operation: 'dead', at: START + 303_000 }]), 0);
	assert.equal(windowDeaths(deathsAt([-4, 0], [1, 1], [300, 1]), START, START + 300_000, [{ operation: 'dead', at: START - 2_000 }]), 0);
	// An earlier death and respawn plus a final death with no respawn: two.
	assert.equal(windowDeaths(deathsAt([0, 0], [100, 1], [279, 1]), START, START + 300_000,
		[{ operation: 'dead', at: START + 99_500 }, { operation: 'respawn', at: START + 102_000 }, { operation: 'dead', at: START + 280_000 }]), 2);
});

test('a corrupt death counter leaves deaths unknown through scoreRun and pairing, never a fallback zero', () => {
	for (const deaths of [[1, 0], [0, 1.5]]) {
		const samples = [counter(START, 0, deaths[0]), counter(START + 300_000, 0, deaths[1])];
		const run = scoreRun({ scenario: 'R-SKELETON', goalStartedAtMs: START, samples, dangerRows: [] });
		assert.equal(run.status, 'valid', 'damage itself reconciles');
		assert.equal(run.deaths, null, `deaths ${deaths} are corrupt`);
		const pair = pairRuns([{ ...run, pairId: 'R-SKELETON-r1' }], [scored('R-SKELETON', 1, 0)]);
		assert.equal(pair[0].deltas.deaths, null, 'the pair is incomplete for deaths');
	}
});

async function runDir(root, name, { scenario, rows, samples, pairId, evaluation = { status: 'EVALUATED', pass: true } }) {
	const dir = path.join(root, name);
	await mkdir(path.join(dir, 'arena-watch'), { recursive: true });
	if (rows) await writeFile(path.join(dir, 'arena-watch', 'agent-danger.jsonl'), rows.map(row => JSON.stringify(row)).join('\n') + '\n');
	await writeFile(path.join(dir, 'quality-samples.json'), JSON.stringify({ samples }));
	const run = { scenario, repetition: Number(pairId?.split('-r').at(-1) ?? 1), pairId, goalStartedAtMs: START, metrics: {}, evaluation, artifacts: dir };
	await writeFile(path.join(dir, 'quality-run.json'), JSON.stringify(run));
	return run;
}

test('the CLI reads run directories and paired results, and reports the noise floor of an A/A run', async () => {
	const root = await mkdtemp(path.join(os.tmpdir(), 'reflex-report-'));
	try {
		const rows = await golden();
		const samples = [counter(START, 0), counter(START + 300_000, 20)];
		const single = await runDir(root, 'single', { scenario: 'R-SKELETON', rows, samples });
		const watch = await readWatchDir(path.join(single.artifacts, 'arena-watch'));
		assert.equal(watch.dangerFiles, 1);
		assert.equal(watch.danger.length, rows.length);
		assert.equal(watch.episodes.length, 0, 'danger rows are not episodes');
		const report = await buildReport(parseReportArgs(['--run', single.artifacts]));
		assert.equal(report.runs[0].damage, 2);
		// A run recorded before goalStartedAtMs was stored: the goal start comes from its protocol journal.
		const older = await runDir(root, 'older', { scenario: 'R-SKELETON', rows, samples });
		const olderRecord = JSON.parse(await readFile(path.join(older.artifacts, 'quality-run.json'), 'utf8'));
		delete olderRecord.goalStartedAtMs;
		await writeFile(path.join(older.artifacts, 'quality-run.json'), JSON.stringify(olderRecord));
		await writeFile(path.join(older.artifacts, 'quality-protocol.jsonl'), JSON.stringify({ direction: 'server_to_coordinator',
			envelope: { type: 'goal_control', agentId: 'agent-a', payload: { operation: 'start', updatedAtEpochMs: START } } }) + '\n');
		assert.equal((await buildReport(parseReportArgs(['--run', older.artifacts]))).runs[0].damage, 2);
		// A danger file with a malformed line is corrupt evidence: damage is unknown, never a clean 0.
		const corrupt = await runDir(root, 'corrupt', { scenario: 'R-SKELETON', rows: [], samples: [counter(START, 0), counter(START + 300_000, 0)] });
		await writeFile(path.join(corrupt.artifacts, 'arena-watch', 'agent-danger.jsonl'), '{"type":"damage","schema":1,"atMs":\n');
		const corruptRun = (await buildReport(parseReportArgs(['--run', corrupt.artifacts]))).runs[0];
		assert.equal(corruptRun.status, 'unknown');
		assert.equal(corruptRun.damage, null);
		assert.match(corruptRun.reconciliation.reason, /malformed danger row/);
		const noWatch = await runDir(root, 'no-watch', { scenario: 'R-SKELETON', rows: null, samples });
		assert.equal((await buildReport(parseReportArgs(['--run', noWatch.artifacts]))).runs[0].status, 'unknown');
		const arms = { A: { runs: [] }, B: { runs: [] } };
		for (const arm of ['A', 'B']) for (const n of [1, 2, 3]) {
			arms[arm].runs.push(await runDir(root, `${arm}-${n}`, { scenario: 'R-SKELETON', rows, samples, pairId: `R-SKELETON-r${n}` }));
		}
		const pairedFile = path.join(root, 'results.json');
		await writeFile(pairedFile, JSON.stringify({ configuration: { design: 'A/A' }, arms }));
		const marginFile = path.join(root, 'margin.json');
		await writeFile(marginFile, JSON.stringify({ z: 2, rooms: { 'R-SKELETON': { damage: { perPairSd: 0.5 }, deaths: { perPairSd: 0.5 }, success: { perPairSd: 0.5 } } } }));
		const paired = await buildReport(parseReportArgs(['--paired', pairedFile, '--margin', marginFile]));
		assert.equal(paired.design, 'A/A');
		assert.equal(paired.pairs.length, 3);
		assert.ok(paired.pairs.every(pair => pair.deltas.damage === 0));
		assert.equal(paired.judgement.rooms['R-SKELETON'].damage.verdict, 'INCONCLUSIVE');
		assert.equal(paired.noiseFloor.rooms['R-SKELETON'].damage.perPairSd, 0);
		assert.throws(() => parseReportArgs([]), /Pass --run or --paired/);
		assert.throws(() => parseReportArgs(['--run', 'a', '--paired', 'b']), /Pass --run or --paired/);
	} finally { await rm(root, { recursive: true, force: true }); }
});
