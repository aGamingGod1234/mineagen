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
