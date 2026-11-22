import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { finishRun, roomVerdict } from '../../scripts/quality/lib/fixture-run.mjs';
import { armTotals, mergeArms, parseCommands } from '../../scripts/quality/lib/room-batch-core.mjs';
import { pickaxeUsesPer100, travelRow } from '../../scripts/quality/lib/travel-rows.mjs';

// A finished course as test-travel-live.mjs's runCourse returns it (the fields the row reads).
const course = (id, extra = {}) => ({ id, mode: 'travel', arrived: true, deaths: 0, damage: 0, damageTaken: 0, startDistance: 200, endDistance: 12, progressBlocks: 188,
	pickaxeUses: 47, blocksMined: 60, wallSeconds: 300, startedAtEpochMs: 1_000, endedAtEpochMs: 301_000, ...extra });
const LINE = 'node scripts/quality/test-travel-live.mjs scripts/quality/travel-courses.json $OUT --mode travel';

test('a travel course passes on arrival with no death and fails when it stops short or dies', () => {
	const arrived = travelRow(course('a'));
	assert.deepEqual(roomVerdict(arrived), { verdict: 'PASS', reason: 'arrived, 12 blocks from the target' });
	assert.equal(arrived.name, 'a');
	assert.equal(arrived.startedAt, 1_000);
	assert.equal(arrived.finishedAt, 301_000);
	assert.equal(arrived.minutes, 5, 'the course\'s own wall time, not the arm\'s');
	assert.equal(arrived.pickaxeUsesPer100Blocks, 25);
	assert.equal(arrived.bar, undefined, 'no cap declared, no bar');
	assert.equal(roomVerdict(travelRow(course('seen', { arrived: true, targetSeen: 'fortress at 40 blocks', endDistance: 90 }))).verdict, 'PASS');
	const short = roomVerdict(travelRow(course('b', { arrived: false, endDistance: 150, gaveUp: 'no progress over 3 actions' })));
	assert.deepEqual(short, { verdict: 'FAIL', reason: 'not arrived: 150 of 200 blocks left (no progress over 3 actions)' });
	assert.deepEqual(roomVerdict(travelRow(course('c', { deaths: 1 }))), { verdict: 'FAIL', reason: '1 death' });
	assert.deepEqual(roomVerdict(travelRow(course('d', { deaths: null }))), { verdict: 'INVALID', reason: 'missing evidence: scoreboard death count unknown' }, 'an unknown death count is never a pass');
});

test('a course without evidence is INVALID, never a pass: an error, an unreadable counter, a server that never booted', () => {
	const errored = travelRow({ id: 'e', mode: 'travel', error: 'Error: TIMEOUT observation', startedAt: 5, finishedAt: 9 });
	assert.equal(roomVerdict(errored).verdict, 'INVALID');
	assert.equal(errored.startedAt, 5, 'a course that errored mid-run did start');
	assert.equal(errored.pass, undefined);
	const counters = travelRow(course('f', { pickaxeUses: null, blocksMined: null, integrity: [{ file: 'scoreboard', error: 'travel counters unknown' }] }));
	assert.equal(roomVerdict(counters).verdict, 'INVALID');
	const deaths = travelRow(course('g', { integrity: [{ file: 'scoreboard', error: 'death counter unreadable at the end of the course' }] }));
	assert.match(roomVerdict(deaths).reason, /death counter unreadable/);
	const noBoot = travelRow({ id: 'h', mode: 'travel', error: 'server did not boot: Error: bridge never ready' });
	assert.equal(roomVerdict(noBoot).verdict, 'INVALID');
	assert.equal(noBoot.startedAt, null);
});

test('pickaxe wear is uses per 100 blocks gained, and a declared cap is the bar', () => {
	assert.equal(pickaxeUsesPer100(course('a')), 25);
	assert.equal(pickaxeUsesPer100(course('a', { progressBlocks: 0 })), null, 'nothing gained, no rate');
	assert.equal(pickaxeUsesPer100(course('a', { progressBlocks: -20 })), null);
	assert.equal(pickaxeUsesPer100(course('a', { pickaxeUses: null })), null);
	assert.equal(roomVerdict(travelRow(course('a'), { maxPickaxeUsesPer100: 30 })).verdict, 'PASS');
	const over = travelRow(course('a'), { maxPickaxeUsesPer100: 20 });
	assert.deepEqual(roomVerdict(over), { verdict: 'FAIL', reason: '25 pickaxe uses per 100 blocks gained, over 20' });
	assert.equal(over.pickaxeBar, 20);
	const stuck = travelRow(course('s', { arrived: true, targetSeen: 'fortress', progressBlocks: 0, pickaxeUses: 9 }), { maxPickaxeUsesPer100: 20 });
	assert.deepEqual(roomVerdict(stuck), { verdict: 'FAIL', reason: '9 pickaxe uses with no blocks gained' });
	assert.equal(travelRow(course('t', { arrived: true, targetSeen: 'fortress', progressBlocks: 0, pickaxeUses: 0 }), { maxPickaxeUsesPer100: 20 }).bar, true);
});

test('a room batch merges travel courses as passes and fails, where the old results.json alone read as INVALID and never started', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'travel-rows-'));
	try {
		const rooms = parseCommands(`@courses ${LINE}\n@legacy ${LINE}`, ['new']);
		const runs = [course('ssv-867'), course('entry9-fortress', { arrived: false, endDistance: 120 })];
		// What test-travel-live.mjs now writes: its own report beside finishRun's rows and summary.
		const dir = path.join(out, 'rooms', 'courses', 'new');
		await mkdir(dir, { recursive: true });
		await writeFile(path.join(dir, 'results.json'), JSON.stringify({ mode: 'travel', jar: 'x.jar', results: runs }));
		const summary = await finishRun(runs.map(run => travelRow(run)), { file: path.join(dir, 'result.json'), planned: 2, setExitCode: false });
		assert.equal(summary.exitCode, 1, 'strict: one course missed');
		assert.equal(summary.notStarted, 0);
		// What it wrote before: results.json only.
		const legacy = path.join(out, 'rooms', 'legacy', 'new');
		await mkdir(legacy, { recursive: true });
		await writeFile(path.join(legacy, 'results.json'), JSON.stringify({ mode: 'travel', jar: 'x.jar', results: runs }));
		const outcomes = ['courses', 'legacy'].map(name => ({ room: name, lost: false, worker: 'vm1', attempts: 1, arms: { new: { exit: 0, seconds: 600 } } }));
		const merged = await mergeArms({ out, rooms, arms: ['new'], outcomes });
		const verdicts = merged.new.summary.rooms.map(room => `${room.name} ${room.verdict}`);
		assert.deepEqual(verdicts.slice(0, 2), ['ssv-867 PASS', 'entry9-fortress FAIL']);
		assert.match(verdicts[2], /^legacy INVALID/, 'the old output gave the batch nothing to judge');
		const totals = armTotals(merged.new);
		assert.equal(totals.pass, 1);
		assert.equal(totals.fail, 1);
		assert.equal(merged.new.perRoom.find(room => room.room === 'courses').rows, 2);
		const written = JSON.parse(await readFile(path.join(dir, 'result-summary.json'), 'utf8'));
		assert.equal(written.started, 2);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('one course that errored leaves the other courses in its room judged on their own evidence', async () => {
	const out = await mkdtemp(path.join(os.tmpdir(), 'travel-rows-mixed-'));
	try {
		const rooms = parseCommands(`@courses ${LINE}`, ['new']);
		const runs = [course('a'), course('b'), course('c'), { id: 'd', mode: 'travel', error: 'server did not boot: Error: bridge never ready' }];
		const dir = path.join(out, 'rooms', 'courses', 'new');
		await mkdir(dir, { recursive: true });
		const own = await finishRun(runs.map(run => travelRow(run)), { file: path.join(dir, 'result.json'), planned: 4, setExitCode: false });
		assert.equal(own.status, 'INVALID');
		const merged = await mergeArms({ out, rooms, arms: ['new'], outcomes: [{ room: 'courses', lost: false, worker: 'vm1', attempts: 1, arms: { new: { exit: 2, seconds: 900 } } }] });
		assert.deepEqual(merged.new.summary.rooms.map(room => `${room.name} ${room.verdict}`), ['a PASS', 'b PASS', 'c PASS', 'd INVALID']);
		assert.equal(merged.new.summary.status, 'INVALID', 'the arm still reads INVALID: rerun the course that never played');
		assert.equal(armTotals(merged.new).pass, 3);
	} finally { await rm(out, { recursive: true, force: true }); }
});

test('a room-wide flag on a merged row names itself in the verdict reason', () => {
	assert.deepEqual(roomVerdict({ pass: true, integrity: ['arm killed (room timeout)'] }), { verdict: 'INVALID', reason: 'missing evidence: arm killed (room timeout)' });
});
