import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectRuns, compareGroups, compareScores, fisher, foldReason, formatComparison, formatScoreboard, groupScores, planBenchmark, pooledTest, scoreRooms } from '../../scripts/quality/lib/benchmark-score.mjs';
import { handRolledTickRate } from '../../scripts/quality/lib/fixture-play.mjs';
import { roomVerdict } from '../../scripts/quality/lib/fixture-run.mjs';
import { damageCounter, recordDamageEvidence } from '../../scripts/quality/lib/damage-counter.mjs';
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

const tally = (pass, fail) => ({ pass, fail, invalid: 0, lost: 0, passRate: pass + fail ? pass / (pass + fail) : null, deaths: 0, damage: 0, medianSeconds: 1 });

test('per-room p values are Holm-adjusted over the rooms compared, so many rooms do not make chance changes', () => {
	// One room at 0/10 -> 7/10 is p .0031 alone. Among 20 rooms Holm multiplies the smallest p by 20: .0619, no longer better.
	// A room at 2/10 -> 7/10 (p .0698 alone) was never better; 4/10 -> 9/10 (p .0573) neither.
	const before = { rooms: { big: tally(0, 10), mid: tally(2, 8), near: tally(4, 6) } }, after = { rooms: { big: tally(7, 3), mid: tally(7, 3), near: tally(9, 1) } };
	for (let i = 0; i < 17; i++) { before.rooms[`flat${i}`] = tally(5, 5); after.rooms[`flat${i}`] = tally(5, 5); }
	const rows = Object.fromEntries(compareScores(before, after).map(row => [row.room, row]));
	assert.equal(rows.big.p, 0.0031);
	assert.equal(rows.big.pAdjusted, 0.0619, '20 rooms x .0031: not past 5% after adjustment');
	assert.equal(rows.big.change, 'within noise');
	assert.equal(rows.flat0.pAdjusted, 1);
	assert.equal(rows.flat0.change, 'same');
	// Holm steps down: alone, 0/10 -> 10/10 (p .0000108) stays better whatever the room count.
	const strong = compareScores({ rooms: { ...before.rooms, big: tally(0, 10) } }, { rooms: { ...after.rooms, big: tally(10, 0) } });
	assert.equal(strong.find(row => row.room === 'big').change, 'better');
	// Rooms with no valid runs on a side are no test and take no share.
	const sparse = compareScores({ rooms: { a: tally(0, 10), empty: tally(0, 0) } }, { rooms: { a: tally(7, 3), empty: tally(3, 0) } });
	assert.equal(sparse.find(row => row.room === 'a').pAdjusted, 0.0031);
	assert.equal(sparse.find(row => row.room === 'empty').pAdjusted, undefined);
	assert.equal(sparse.find(row => row.room === 'empty').change, 'no valid runs');
});

test('the pooled exact test: known values, and a small gain in every room adds up where no single room shows it', () => {
	// 12/20 against 8/20, one room: one-sided exact p .1715 (half of Fisher's two-sided .3431).
	const one = compareScores({ rooms: { a: tally(8, 12) } }, { rooms: { a: tally(12, 8) } });
	assert.equal(one[0].p, 0.3431);
	assert.deepEqual(pooledTest(one), { rooms: ['a'], before: { pass: 8, valid: 20 }, after: { pass: 12, valid: 20 }, pBetter: 0.1715, pWorse: 0.9436 });
	// 30 rooms, each 5/10 -> 6/10 (+1 a room): every room p 1, pooled p(better) .0101.
	const before = { rooms: {} }, after = { rooms: {} };
	for (let i = 0; i < 30; i++) { before.rooms[`r${i}`] = tally(5, 5); after.rooms[`r${i}`] = tally(6, 4); }
	const rows = compareScores(before, after);
	assert.ok(rows.every(row => row.p === 1 && row.change === 'within noise'));
	const all = pooledTest(rows);
	assert.equal(all.pBetter, 0.0101);
	assert.equal(all.pWorse, 0.9935);
	assert.deepEqual([all.before, all.after], [{ pass: 150, valid: 300 }, { pass: 180, valid: 300 }]);
	// The same set the other way round is worse at the same p.
	assert.equal(pooledTest(compareScores(after, before)).pWorse, 0.0101);
});

test('targets and guards: the target rooms are tested for a gain, every other room for a loss, and an unknown target is named', () => {
	const before = { rooms: { cast1: tally(0, 10), cast2: tally(2, 8), lava1: tally(8, 2), lava2: tally(7, 3), gone: tally(5, 5) } };
	const after = { rooms: { cast1: tally(6, 4), cast2: tally(5, 5), lava1: tally(6, 4), lava2: tally(5, 5) } };
	const rows = compareScores(before, after);
	const groups = compareGroups(rows, { targets: ['cast1', 'cast2', 'cast9'] });
	assert.deepEqual(groups.target.rooms, ['cast1', 'cast2']);
	assert.deepEqual([groups.target.before, groups.target.after], [{ pass: 2, valid: 20 }, { pass: 11, valid: 20 }]);
	assert.ok(groups.target.pBetter < 0.01, `targets better: ${groups.target.pBetter}`);
	assert.deepEqual(groups.guard.rooms, ['lava1', 'lava2'], 'a room not run on one side is no guard');
	assert.ok(groups.guard.pWorse > 0.05 && groups.guard.pWorse < 0.2, `guards 15/20 -> 11/20 is not yet worse: ${groups.guard.pWorse}`);
	assert.deepEqual(groups.missingTargets, ['cast9']);
	// A target not run on a side, or without valid runs, is named too, and an empty pool is no test.
	const lost = compareGroups(compareScores({ rooms: { a: tally(0, 10), b: tally(5, 5), c: tally(3, 7) } }, { rooms: { b: tally(5, 5), c: tally(0, 0) } }), { targets: ['a', 'c'] });
	assert.deepEqual(lost.missingTargets, ['a', 'c']);
	assert.deepEqual(lost.target.rooms, []);
	assert.match(formatComparison(compareScores({ rooms: { a: tally(0, 10), b: tally(5, 5) } }, { rooms: { b: tally(5, 5) } }), { targets: ['a'] }),
		/^target rooms: 0\/0 -> 0\/0 over 0 rooms; no test .*\n.*\ntargets left out of the pool \(unknown, not run on a side, or no valid runs\): a$/m);
	const text = formatComparison(rows, { targets: ['cast1', 'cast2', 'cast9'] });
	assert.match(text, /^target rooms: 2\/20 -> 11\/20 over 2 rooms; pooled exact test p\(better\) 0\.\d+/m);
	assert.match(text, /^guard rooms: 15\/20 -> 11\/20 over 2 rooms/m);
	assert.match(text, /^targets left out of the pool \(unknown, not run on a side, or no valid runs\): cast9$/m);
	// A p under the exact test's 1e-12 tolerance prints as a bound, never as a precise-looking number.
	const huge = { rooms: {} }, none = { rooms: {} };
	for (let i = 0; i < 10; i++) { none.rooms[`x${i}`] = tally(0, 10); huge.rooms[`x${i}`] = tally(10, 0); }
	assert.match(formatComparison(compareScores(none, huge)), /p\(better\) < 1e-11/);
	// The verdict reads the unrounded adjusted p: 2/4 against 2/33 is p .04998, worse, though it rounds to .05.
	const edge = compareScores({ rooms: { e: tally(2, 2) } }, { rooms: { e: tally(2, 31) } });
	assert.equal(edge[0].p, 0.04998, 'printed with the digits that put it under .05');
	assert.equal(edge[0].change, 'worse');
	// Without targets the one pooled line covers every room.
	assert.match(formatComparison(rows), /^all rooms: 17\/40 -> 22\/40 over 4 rooms/m);
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

test('a blaze-spawner room passes only alive with a blaze killed and a rod kept, not walled in all window', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-blaze-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const rooms = JSON.parse(await readFile(path.join(root, 'scripts/quality/benchmark-rooms.json'), 'utf8'));
	const meta = Object.fromEntries((Array.isArray(rooms) ? rooms : rooms.rooms).map(room => [room.room, room]));
	for (const room of ['blaze-spawner-gap0', 'blaze-spawner-gap5', 'blaze-spawner-cover'])
		assert.deepEqual(meta[room].passWhen, { field: 'allRunsKilledAndKeptRod', min: 1 }, room);
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), JSON.stringify(value)); };
	await put('rooms/blaze-spawner-cover.c1/done.json', { room: 'blaze-spawner-cover.c1', arms: { kept: { exit: 0, seconds: 300 }, boxed: { exit: 0, seconds: 300 } } });
	const run = (kills, rodsAtEnd) => ({ deaths: 0, kills, rodsAtEnd });
	await put('rooms/blaze-spawner-cover.c1/kept/blaze-spawner.json', { variants: { cover: { runs: [run(3, 2)] } }, runsKilledAndKeptRod: 1, allRunsKilledAndKeptRod: 1 });
	await put('rooms/blaze-spawner-cover.c1/boxed/blaze-spawner.json', { variants: { cover: { runs: [run(0, 0)] } }, runsKilledAndKeptRod: 0, allRunsKilledAndKeptRod: 0 });
	const runs = await collectRuns(dir, null, meta);
	const by = arm => runs.find(r => r.room === 'blaze-spawner-cover' && r.arm === arm);
	assert.equal(by('kept').verdict, 'PASS');
	assert.deepEqual([by('boxed').verdict, by('boxed').reason], ['FAIL', 'allRunsKilledAndKeptRod below 1'], 'alive but no kill or rod');
});

test('a fire room with missing or decreasing damage evidence is invalid even when its reflex passed', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-damage-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const room = path.join(dir, 'rooms', 'fire.c1');
	const afterByArm = { missing: null, decreased: 8, valid: 10 };
	const reason = 'missing evidence: damage_taken Missing or decreasing vanilla damage counter';
	await mkdir(room, { recursive: true });
	await writeFile(path.join(room, 'done.json'), JSON.stringify({
		arms: Object.fromEntries(Object.keys(afterByArm).map(arm => [arm, { exit: 0 }])),
	}));
	for (const [arm, after] of Object.entries(afterByArm)) {
		let reads = 0;
		const command = async text => {
			if (text === 'scoreboard players get Body arena_damage') {
				const score = reads++ === 0 ? 10 : after;
				if (score === null) throw new Error('RCON read failed');
				return `Body has ${score} [arena_damage]`;
			}
			if (text === 'scoreboard players get Body fixture_deaths') return 'Body has 0 [fixture_deaths]';
			return '';
		};
		const rate = handRolledTickRate(command, new EventEmitter(), 'Body', { tickRate: 60 });
		const end = await rate.play();
		const armed = { pass: true, tick: await end() };
		assert.equal(rate.rate, 20);
		assert.equal(roomVerdict(armed).verdict, arm === 'valid' ? 'PASS' : 'INVALID');
		await mkdir(path.join(room, arm));
		await writeFile(path.join(room, arm, 'results.json'), JSON.stringify({ armed }));
	}
	const runs = await collectRuns(dir);
	for (const { arm, verdict, reason: why, damage } of runs) {
		assert.deepEqual([verdict, why, damage], arm === 'valid' ? ['PASS', null, 0] : ['INVALID', reason, null]);
	}
	const { pass, invalid } = scoreRooms(runs).fire;
	assert.deepEqual({ pass, invalid }, { pass: 1, invalid: 2 });
});

test('a portal crossing with an unreadable damage score is invalid in its own verdict and the benchmark', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-portal-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const room = path.join(dir, 'rooms', 'portal.c1');
	await mkdir(path.join(room, 'r1'), { recursive: true });
	await writeFile(path.join(room, 'done.json'), JSON.stringify({ arms: { r1: { exit: 0 } } }));
	let reads = 0;
	const readDamage = await damageCounter(async command => {
		if (!command.startsWith('scoreboard players get ')) return '';
		if (++reads === 1) return 'Portal has 7 [arena_damage]';
		throw new Error('RCON read failed');
	}, 'Portal');
	const play = {};
	recordDamageEvidence(play, await readDamage(), await readDamage());
	const crossing = { ok: true, play };
	await writeFile(path.join(room, 'r1', 'result.json'), JSON.stringify({ ok: true, cases: { nether: crossing } }));
	const verdict = roomVerdict({ ...crossing, pass: crossing.ok });
	assert.equal(verdict.verdict, 'INVALID');
	assert.match(verdict.reason, /damage_taken/);
	const [run] = await collectRuns(dir);
	assert.deepEqual([run.verdict, run.reason, run.damage], ['INVALID', verdict.reason, null]);
});

test('a fire room with an invalid death count cannot pass even with valid damage evidence', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-deaths-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const room = path.join(dir, 'rooms', 'fire.c1');
	const replies = { rejected: null, malformed: 'unavailable', decreased: 'Body has 1 [fixture_deaths]', valid: 'Body has 2 [fixture_deaths]' };
	await mkdir(room, { recursive: true });
	await writeFile(path.join(room, 'done.json'), JSON.stringify({
		arms: Object.fromEntries(Object.keys(replies).map(arm => [arm, { exit: 0 }])),
	}));
	for (const [arm, reply] of Object.entries(replies)) {
		let deathReads = 0;
		const command = async text => {
			if (text === 'scoreboard players get Body arena_damage') return 'Body has 0 [arena_damage]';
			if (text !== 'scoreboard players get Body fixture_deaths') return '';
			if (++deathReads === 1) return 'Body has 2 [fixture_deaths]';
			if (reply === null) throw new Error('RCON read failed');
			return reply;
		};
		const rate = handRolledTickRate(command, new EventEmitter(), 'Body', { tickRate: 60 });
		const end = await rate.play();
		const armed = { pass: true, tick: await end() };
		assert.equal(armed.tick.damageTaken, 0);
		assert.equal(roomVerdict(armed).verdict, arm === 'valid' ? 'PASS' : 'INVALID');
		await mkdir(path.join(room, arm));
		await writeFile(path.join(room, arm, 'results.json'), JSON.stringify({ armed }));
	}
	const runs = await collectRuns(dir);
	const reason = 'missing evidence: deaths Missing or decreasing vanilla death counter';
	for (const { arm, verdict, reason: why, deaths } of runs) {
		assert.deepEqual([verdict, why, deaths], arm === 'valid' ? ['PASS', null, 0] : ['INVALID', reason, null]);
	}
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

test('the edge room judges the shield shot and only records the empty-handed knockback', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-edge-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), JSON.stringify(value)); };
	const shot = (offBridge) => ({ cases: [{ case: 'edge-control', mode: 'defaults', alive: true, knockedOff: true }, { case: 'edge-control-shield', mode: 'defaults', alive: true, offBridge },
		{ case: 'edge-control-shield', mode: 'none', alive: true, offBridge: true }] });
	for (const [room, offBridge] of [['held', false], ['fell', true]]) {
		await put(`rooms/${room}.c1/done.json`, { room: `${room}.c1`, arms: { r1: { exit: 0, seconds: 60 } } });
		await put(`rooms/${room}.c1/r1/default-reflex.json`, shot(offBridge));
	}
	const runs = await collectRuns(dir, null, { held: { bar: 'none' }, fell: { bar: 'none' } });
	const of = room => runs.filter(run => run.room === room).map(run => run.verdict);
	assert.deepEqual(of('held'), ['PASS'], 'knocked off empty-handed, on the bridge behind the shield');
	assert.deepEqual(of('fell'), ['FAIL'], 'off the bridge with a shield in hand');
});

test('what a fixture wrote outranks its exit 0: caught errors, pass false, alive false, empty rows and cut-short files', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-score-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), typeof value === 'string' ? value : JSON.stringify(value)); };
	const rooms = ['crowd', 'gather', 'reflex', 'reflexcontrol', 'edge', 'empty', 'cut', 'fine'];
	const plan = planBenchmark(rooms.map(room => ({ room, line: LINE })), { repeats: 1, slots: 1 });
	for (const room of rooms) await put(`rooms/${room}.c1/done.json`, { room: `${room}.c1`, arms: { r1: { exit: room === 'cut' ? 1 : 0 } } });
	// Crowd: an observation timeout caught and written to error.txt, then exit 0.
	await put('rooms/crowd.c1/r1/runs.json', [{ trial: 1, survived: true }]);
	await put('rooms/crowd.c1/r1/error.txt', 'Error: observation timed out\n    at ...');
	// Nether gather: a scenario-level pass false, exit 0, no survival bar.
	await put('rooms/gather.c1/r1/results.json', { tunnel: { pass: false, error: 'never reached the gold' } });
	// Default reflex: the armed body died in lava (a death), and in the control room only the rule-less body died (by design).
	await put('rooms/reflex.c1/r1/default-reflex.json', { cases: [{ case: 'lavaKnock', mode: 'defaults', alive: false }, { case: 'lavaKnock', mode: 'none', alive: false }] });
	await put('rooms/reflexcontrol.c1/r1/default-reflex.json', { cases: [{ case: 'lavaKnock', mode: 'defaults', alive: true }, { case: 'lavaKnock', mode: 'none', alive: false }] });
	// Default-reflex edge room: the armed body lived but fell off the bridge, the room's own bar.
	await put('rooms/edge.c1/r1/default-reflex.json', { cases: [{ case: 'edge-control', mode: 'defaults', alive: true, offBridge: true }, { case: 'edge-control', mode: 'none', alive: true, offBridge: true }] });
	// finishRun wrote no rows but planned three.
	await put('rooms/empty.c1/r1/result.json', []);
	await put('rooms/empty.c1/r1/result-summary.json', { planned: 3, status: 'INVALID' });
	// A rows file cut short by an interrupted write.
	await put('rooms/cut.c1/r1/rows.json', '[{"trial": 1, "pass": tr');
	await put('rooms/fine.c1/r1/runs.json', [{ trial: 1, survived: true }]);
	const meta = { crowd: { bar: 'none' }, reflex: { bar: 'none' }, reflexcontrol: { bar: 'none' }, edge: { bar: 'none' }, fine: { bar: 'none' } };
	const runs = await collectRuns(dir, plan, meta);
	const of = room => runs.filter(run => run.room === room).map(run => run.verdict);
	assert.deepEqual(of('crowd'), ['INVALID'], 'a caught error is no pass');
	assert.match(runs.find(run => run.room === 'crowd').reason, /fixture error/);
	assert.deepEqual(of('gather'), ['FAIL'], 'pass false counts without a survival bar');
	assert.deepEqual(of('reflex'), ['FAIL'], 'the armed body\'s alive false is a death');
	assert.equal(runs.find(run => run.room === 'reflex').deaths, 1, 'the control body is not counted');
	assert.deepEqual(of('reflexcontrol'), ['PASS'], 'only the control died');
	assert.deepEqual(of('edge'), ['FAIL'], 'alive but off the bridge');
	assert.deepEqual(of('empty'), ['INVALID', 'INVALID', 'INVALID'], 'every planned row is INVALID');
	assert.deepEqual(of('cut'), ['INVALID'], 'a cut-short file makes its run INVALID');
	assert.deepEqual(of('fine'), ['PASS'], 'and the scoreboard goes on to the next room');
});

test('a death counted after the counter sample stands, and an unreadable counter is no verdict', async t => {
	const dir = await mkdtemp(path.join(os.tmpdir(), 'bench-score-'));
	t.after(() => rm(dir, { recursive: true, force: true }));
	const put = async (file, value) => { await mkdir(path.dirname(path.join(dir, file)), { recursive: true }); await writeFile(path.join(dir, file), JSON.stringify(value)); };
	const rooms = ['late', 'unread', 'same'];
	const plan = planBenchmark(rooms.map(room => ({ room, line: LINE })), { repeats: 1, slots: 1 });
	for (const room of rooms) await put(`rooms/${room}.c1/done.json`, { room: `${room}.c1`, arms: { r1: { exit: 0 } } });
	// The blaze room: its final health check found the death after the counter was sampled.
	await put('rooms/late.c1/r1/blaze.json', { variants: { cover: { runs: [{ deaths: 1, deathCounter: { valid: true, deaths: 0 } }] } } });
	await put('rooms/unread.c1/r1/blaze.json', { variants: { cover: { runs: [{ deaths: 0, deathCounter: { valid: false, deaths: null } }] } } });
	// A parent repeating its child's count does not double it.
	await put('rooms/same.c1/r1/blaze.json', { variants: { cover: { deaths: 1, runs: [{ deaths: 1, deathCounter: { valid: true, deaths: 1 } }] } } });
	const meta = { late: { bar: 'none' }, same: { bar: 'none' } };
	const runs = await collectRuns(dir, plan, meta);
	const by = room => runs.find(run => run.room === room);
	assert.equal(by('late').verdict, 'FAIL');
	assert.equal(by('late').deaths, 1);
	assert.equal(by('unread').verdict, 'INVALID');
	assert.equal(by('unread').reason, 'death counter unreadable');
	assert.equal(by('same').deaths, 1);
});
