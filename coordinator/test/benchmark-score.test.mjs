import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRuns, compareScores, fisher, foldReason, formatComparison, formatScoreboard, groupScores, planBenchmark, scoreRooms } from '../../scripts/quality/lib/benchmark-score.mjs';
import { parseCommands } from '../../scripts/quality/lib/room-batch-core.mjs';

const root = fileURLToPath(new URL('../..', import.meta.url));
const LINE = 'BUILD_ONLY=a node scripts/quality/test-build-live.mjs scripts/quality/build-spots.json $OUT $JAR --descriptive';

test('a benchmark plays each room as copies x side-by-side arms, longest first, and room-batch reads the commands', () => {
	const plan = planBenchmark([{ room: 'short', line: LINE, estMinutes: 1 }, { room: 'long', line: LINE, estMinutes: 9, tickRate: 60 }], { repeats: 10, slots: 5 });
	assert.equal(plan.copies, 2);
	assert.deepEqual(plan.arms, ['r1', 'r2', 'r3', 'r4', 'r5']);
	assert.deepEqual(plan.instances.map(item => item.name), ['long.c1', 'short.c1', 'long.c2', 'short.c2']);
	const rooms = parseCommands(plan.commands, plan.arms);
	assert.equal(rooms.length, 4);
	assert.equal(rooms[0].lines[0].env.FIXTURE_TICK_RATE, '60');
	assert.equal(rooms[1].lines[4].env.FIXTURE_TICK_RATE, undefined);
	assert.throws(() => planBenchmark([{ room: 'a', line: LINE }, { room: 'a', line: LINE }]), /twice/);
	assert.throws(() => planBenchmark([{ room: 'a', line: 'node x.mjs' }]), /\$OUT/);
	assert.throws(() => planBenchmark([{ room: 'a', line: LINE }], { repeats: 2, slots: 3 }), /slots/);
});

test('runs are read per row, by exit code without rows, and a room that never came back is lost', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-score-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), JSON.stringify(value)); };
	const plan = planBenchmark([{ room: 'a', line: LINE }, { room: 'b', line: LINE }, { room: 'c', line: LINE }], { repeats: 4, slots: 2 });
	await put('rooms/a.c1/done.json', { room: 'a.c1', arms: { r1: { exit: 0, seconds: 30 }, r2: { exit: 1, seconds: 40 } } });
	await put('rooms/a.c1/r1/result.json', [{ name: 'a', pass: true, deaths: 0, damageTaken: 0, seconds: 20 }]);
	await put('rooms/a.c1/r2/result.json', [{ name: 'a', pass: false, failReason: 'fell 12 blocks at 3,4,5', deaths: 1, damageTaken: 20, seconds: 31,
		calls: [{ state: 'FAILED', reasonCode: 'LAVA_AHEAD' }] }]);
	for (const arm of ['r1', 'r2']) await put(`rooms/a.c1/${arm}/result-summary.json`, { planned: 1, status: arm === 'r1' ? 'PASS' : 'FAIL' });
	await put('rooms/b.c1/done.json', { room: 'b.c1', arms: { r1: { exit: 0, seconds: 50 }, r2: { exit: 1, seconds: 60, timedOut: true } } });
	await put('batch.json', { outcomes: [{ room: 'c.c1', lost: true, reason: 'machine gone' }] });
	const runs = await collectRuns(dir, plan);
	const by = (room, arm) => runs.find(run => run.room === room && run.arm === arm && run.copy === 1);
	assert.equal(by('a', 'r1').verdict, 'PASS');
	assert.equal(by('a', 'r2').verdict, 'FAIL');
	assert.equal(by('a', 'r2').reason, 'died');
	assert.equal(by('b', 'r1').verdict, 'PASS');
	assert.equal(by('b', 'r1').exitOnly, true);
	assert.equal(by('b', 'r2').verdict, 'INVALID');
	assert.equal(by('c', 'r1').verdict, 'LOST');
	assert.equal(by('c', 'r1').reason, 'machine gone');
	assert.equal(runs.filter(run => run.copy === 2 && run.verdict === 'LOST').length, 6);
	const rooms = scoreRooms(runs, { a: { stage: 'early', skill: 'building', skill2: 'survival' }, b: { stage: 'end', skill: 'combat' } });
	assert.equal(rooms.a.passRate, 0.5);
	assert.equal(rooms.a.deaths, 1);
	assert.equal(rooms.a.medianSeconds, 25.5);
	assert.equal(rooms.b.deaths, null);
	assert.equal(rooms.c.passRate, null);
	const groups = groupScores(rooms);
	assert.equal(groups.stage.early.passRate, 0.5);
	assert.equal(groups.skill.survival.rooms, 1);
	assert.match(formatScoreboard({ rooms, groups }), /\| a \| building, survival \| 1\/2 \| 50% \|/);
});

test('reasons fold numbers so the same failure counts once', () => {
	assert.equal(foldReason('fell 12.5 blocks at -3,4,5\nmore'), foldReason('fell 3 blocks at 1,2,-9'));
});

test('a change counts as better or worse only past a two-sided Fisher test', () => {
	assert.ok(Math.abs(fisher(10, 0, 0, 10) - 0.0000108) < 1e-6);
	assert.equal(fisher(5, 5, 5, 5), 1);
	const score = (pass, fail) => ({ pass, fail, invalid: 0, lost: 0, passRate: pass / (pass + fail), deaths: 0, damage: 0, medianSeconds: 1 });
	const rows = compareScores({ rooms: { a: score(2, 8), b: score(5, 5), c: score(9, 1), gone: score(1, 1) } }, { rooms: { a: score(9, 1), b: score(6, 4), c: score(1, 9), fresh: score(1, 0) } });
	const change = Object.fromEntries(rows.map(row => [row.room, row.change]));
	assert.deepEqual(change, { a: 'better', b: 'within noise', c: 'worse', fresh: 'new room', gone: 'not run' });
	assert.match(formatComparison(rows), /1 better, 1 worse/);
});

test('the committed room list plans and every fixture it names exists', async () => {
	const rooms = JSON.parse(await readFile(path.join(root, 'scripts/quality/benchmark-rooms.json'), 'utf8'));
	const list = Array.isArray(rooms) ? rooms : rooms.rooms;
	assert.ok(list.length > 0);
	const plan = planBenchmark(list, { repeats: 10, slots: 5 });
	parseCommands(plan.commands, plan.arms);
	for (const room of list) {
		const script = /node\s+(\S+)/.exec(room.line)[1];
		await readFile(path.join(root, script));
		assert.ok(!/(^|\s)\/(home|Users|tmp)\//.test(room.line), `${room.room} names a private path`);
	}
});

test('a fixture outside finishRun gives deaths and damage from its own rows, and a room with no bar fails on a death', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-other-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value)); };
	await put('rooms/rest.c1/done.json', { room: 'rest.c1', arms: { r1: { exit: 0, seconds: 60 }, r2: { exit: 0, seconds: 61 } } });
	await put('rooms/rest.c1/r1/rows.json', [{ died: false, damage: 3 }]);
	await put('rooms/rest.c1/r2/rows.json', [{ died: true, damage: 20 }]);
	await put('rooms/rest.c1/r2/manifest.json', { died: true });
	await put('rooms/bed.c1/done.json', { room: 'bed.c1', arms: { r1: { exit: 1, seconds: 30 } } });
	await put('rooms/bed.c1/r1.log', 'boot\nError: bed live check failed at 1,2,3\n    at file:///x.mjs:4:5\n');
	const runs = await collectRuns(dir, null, { rest: { bar: 'none' } });
	const by = (room, arm) => runs.find(run => run.room === room && run.arm === arm);
	assert.deepEqual([by('rest', 'r1').verdict, by('rest', 'r1').deaths, by('rest', 'r1').damage], ['PASS', 0, 3]);
	assert.deepEqual([by('rest', 'r2').verdict, by('rest', 'r2').reason, by('rest', 'r2').deaths], ['FAIL', 'died', 1]);
	assert.equal(by('bed', 'r1').verdict, 'FAIL');
	assert.equal(by('bed', 'r1').reason, 'Error: bed live check failed at N,N,N');
	assert.equal(by('bed', 'r1').deaths, null);
});

test('a single result object counts its own deaths and a room passes only on its own bar', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-bar-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), JSON.stringify(value)); };
	await put('rooms/pearl.c1/done.json', { room: 'pearl.c1', arms: { r1: { exit: 0, seconds: 1200 }, r2: { exit: 0, seconds: 1200 } } });
	await put('rooms/pearl.c1/r1/result.json', { endPearls: 2, deaths: 0 });
	await put('rooms/pearl.c1/r2/result.json', { endPearls: 0, deaths: 0 });
	await put('rooms/rest.c1/done.json', { room: 'rest.c1', arms: { r1: { exit: 0, seconds: 60 } } });
	await put('rooms/rest.c1/r1/rows.json', [{ died: true, damage: 20 }]);
	await put('rooms/rest.c1/r1/summary.json', { deaths: 1, damage: 20 });
	const runs = await collectRuns(dir, null, { pearl: { passWhen: { field: 'endPearls', min: 1 } }, rest: { bar: 'none' } });
	const by = (room, arm) => runs.find(run => run.room === room && run.arm === arm);
	assert.deepEqual([by('pearl', 'r1').verdict, by('pearl', 'r1').deaths], ['PASS', 0]);
	assert.deepEqual([by('pearl', 'r2').verdict, by('pearl', 'r2').reason], ['FAIL', 'endPearls below 1']);
	assert.deepEqual([by('rest', 'r1').deaths, by('rest', 'r1').damage], [1, 20]);
});

test('a death repeated by a variant and its counter counts once, and an item wear is not health damage', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-nest-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	await writeFile(path.join(dir, 'blaze.json'), JSON.stringify({ variants: { cover: { deaths: 1, runs: [{ deaths: 1, deathCounter: { deaths: 1 } }] } } }));
	await writeFile(path.join(dir, 'results.json'), JSON.stringify({ wear: { damage: 55, pass: true } }));
	const { otherEvidence } = await import('../../scripts/quality/lib/benchmark-score.mjs');
	const found = await otherEvidence(dir);
	assert.equal(found.deaths, 1);
	assert.equal(found.damage, null);
});

test('finishRun rows count only with a valid summary, under any name, and every planned row is accounted for', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-score-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), JSON.stringify(value)); };
	const plan = planBenchmark([{ room: 'a', line: LINE }], { repeats: 4, slots: 4 });
	await put('rooms/a.c1/done.json', { room: 'a.c1', arms: { r1: { exit: 0 }, r2: { exit: 0 }, r3: { exit: 1 }, r4: { exit: 0 } } });
	const row = (pass) => ({ name: 'a', pass, deaths: 0, damageTaken: 0, seconds: 5 });
	// r1: passing rows with no summary (the fixture died before writing it).
	await put('rooms/a.c1/r1/result.json', [row(true)]);
	// r2: the summary planned 3 rows, 2 came back.
	await put('rooms/a.c1/r2/result.json', [row(true), row(true)]);
	await put('rooms/a.c1/r2/result-summary.json', { planned: 3, status: 'INVALID' });
	// r3: seven cases written to runs.json, as the End-breath room does; result.json is an object.
	await put('rooms/a.c1/r3/runs.json', [...Array(6)].map(() => row(true)).concat([row(false)]));
	await put('rooms/a.c1/r3/runs-summary.json', { planned: 7, status: 'FAIL' });
	await put('rooms/a.c1/r3/result.json', { runs: 7 });
	// r4: a corrupt summary.
	await put('rooms/a.c1/r4/result.json', [row(true)]);
	await writeFile(path.join(dir, 'rooms/a.c1/r4/result-summary.json'), '{not json');
	const runs = await collectRuns(dir, plan);
	const of = arm => runs.filter(run => run.arm === arm && run.copy === 1).map(run => run.verdict);
	assert.deepEqual(of('r1'), ['INVALID'], 'rows without their summary are unknown evidence');
	assert.deepEqual(of('r2'), ['PASS', 'PASS', 'INVALID'], 'a planned row that never came back is INVALID');
	assert.deepEqual(of('r3').sort(), ['FAIL', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS', 'PASS'], 'seven cases scored one by one');
	assert.deepEqual(of('r4'), ['INVALID']);
});

test('a crowd room that recorded a death fails its survival bar', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-score-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), JSON.stringify(value)); };
	const plan = planBenchmark([{ room: 'crowd', line: LINE }], { repeats: 2, slots: 2 });
	await put('rooms/crowd.c1/done.json', { room: 'crowd.c1', arms: { r1: { exit: 0 }, r2: { exit: 0 } } });
	await put('rooms/crowd.c1/r1/runs.json', [{ trial: 1, survived: false }]);
	await put('rooms/crowd.c1/r1/summary.json', { died: 1 });
	await put('rooms/crowd.c1/r2/runs.json', [{ trial: 1, survived: true }]);
	const runs = await collectRuns(dir, plan, { crowd: { bar: 'none' } });
	const by = arm => runs.find(run => run.arm === arm);
	assert.equal(by('r1').verdict, 'FAIL');
	assert.equal(by('r1').deaths, 1);
	assert.equal(by('r2').verdict, 'PASS');
	assert.equal(by('r2').deaths, 0);
});

test('a rescore uses the saved room definitions, and reads --baseline before --save-baseline replaces it', async t => {
	const { spawnSync } = await import('node:child_process');
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-cli-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), JSON.stringify(value)); };
	// A custom room, not in the default list, whose bar is a pearl held at the end.
	const definitions = [{ room: 'custom-pearl', line: LINE, passWhen: { field: 'endPearls', min: 1 } }];
	const plan = planBenchmark(definitions, { repeats: 2, slots: 2 });
	await put('out/plan.json', { ...plan, commands: undefined, rooms: ['custom-pearl'], roomDefinitions: definitions });
	await put('out/batch/batch.json', { code: 'newcode1', arms: [] });
	await put('out/batch/rooms/custom-pearl.c1/done.json', { room: 'custom-pearl.c1', arms: { r1: { exit: 0 }, r2: { exit: 0 } } });
	for (const arm of ['r1', 'r2']) await put(`out/batch/rooms/custom-pearl.c1/${arm}/result.json`, { endPearls: 0, deaths: 0 });
	const baselineFile = path.join(dir, 'baseline.json');
	await put('baseline.json', { code: 'oldcode1', repeats: 2, rooms: { 'custom-pearl': { pass: 2, fail: 0, invalid: 0, lost: 0, passRate: 1, deaths: 0, damage: 0, medianSeconds: 1 } } });
	const run = spawnSync(process.execPath, [path.join(root, 'scripts/quality/benchmark.mjs'), '--score', path.join(dir, 'out'), '--baseline', baselineFile, '--save-baseline', baselineFile], { encoding: 'utf8' });
	assert.equal(run.status, 0, run.stderr);
	const scored = JSON.parse(await readFile(path.join(dir, 'out', 'score.json'), 'utf8'));
	assert.equal(scored.rooms['custom-pearl'].fail, 2, 'endPearls 0 misses the saved bar even though the default list does not name the room');
	assert.match(await readFile(path.join(dir, 'out', 'comparison.txt'), 'utf8'), /oldcode1/, 'the comparison read the old baseline');
	assert.equal(JSON.parse(await readFile(baselineFile, 'utf8')).code, 'newcode1', 'and the new baseline replaced it afterwards');
});

test('a room judged on survival whose fixture records no death count has no verdict, never a pass', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-nodeath-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), JSON.stringify(value)); };
	await put('rooms/dragon.c1/done.json', { room: 'dragon.c1', arms: { r1: { exit: 0, seconds: 120 } } });
	await put('rooms/dragon.c1/r1/dragon.json', [{ state: 'SUCCEEDED', reasonCode: 'OWNED_PROJECTILE_CONFIRMED' }]);
	const runs = await collectRuns(dir, null, { dragon: { bar: 'none' } });
	assert.deepEqual([runs[0].verdict, runs[0].reason], ['INVALID', 'no death record']);
});
