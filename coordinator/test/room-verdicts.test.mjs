// The provider-free practice rooms (scripts/quality) must never report a verdict that a hand count of their own records
// contradicts. Each test below is one case from the gameplay friction logs where the summary disagreed with the rows.
import test from 'node:test';
import assert from 'node:assert/strict';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { finishRun, fixtureSummary, roomVerdict, terminalCounter } from '../../scripts/quality/lib/fixture-run.mjs';
import { deathCounter, deathEvidence } from '../../scripts/quality/lib/damage-counter.mjs';
import { healthFloor, startHealthWatch, reflexHold, refusedBeforeRunning } from '../../scripts/quality/lib/room-evidence.mjs';
import { shouldRepeat, findSpotVerdict, findSpotLabel, callEntry, awaitActionReceipts } from '../../scripts/quality/lib/find-spot.mjs';
import { surviveTicks, proposedGoalTicks, newerGoalRevision, liveRecord } from '../../scripts/quality/watch-replay.mjs';

const quality = fileURLToPath(new URL('../../scripts/quality/', import.meta.url));
const exitOf = async rows => (await finishRun(rows.map((row, i) => ({ startedAt: i, finishedAt: i + 1, ...row })), { setExitCode: false })).exitCode;
const act = (state, reasonCode) => ({ call: 'act', state, reasonCode });

test('a room with no find call is judged on deaths and damage, not on a find it never made', async () => {
	// The lava-sea room: walk up, stop at LAVA_AHEAD (a FAILED act that is the wanted stop), walk on. No damage, no death.
	const spot = { name: 'lava-room-1', calls: [{ name: 'act', arguments: {} }, { name: 'act', arguments: {} }] };
	const row = { calls: [act('SUCCEEDED', 'DESTINATION_REACHED'), act('FAILED', 'LAVA_AHEAD'), act('SUCCEEDED', 'ARRIVED')], deaths: 0, damageTaken: 0 };
	const verdict = findSpotVerdict(spot, row);
	assert.equal(verdict.found, null, 'no search ran, so nothing was "not found"');
	assert.equal(verdict.pass, true);
	assert.match(verdict.passReason, /no find call/);
	assert.equal(await exitOf([{ name: spot.name, ...row, ...verdict }]), 0);
	// The same room hurt or killed fails, with the reason.
	assert.match(findSpotVerdict(spot, { ...row, damageTaken: 3 }).failReason, /3 HP damage/);
	assert.match(findSpotVerdict(spot, { ...row, deaths: 1 }).failReason, /1 deaths/);
	// A search still needs its sighting, from the last find call even when an act follows it.
	const search = { calls: [{ name: 'do_step', arguments: { verb: 'find' } }, { name: 'act', arguments: {} }] };
	const seen = { calls: [{ call: 'do_step', verb: 'find', state: 'SUCCEEDED', reasonCode: 'FIND_SEEN' }, act('SUCCEEDED', 'ARRIVED')], deaths: 0, damageTaken: 0 };
	assert.deepEqual([findSpotVerdict(search, seen).found, findSpotVerdict(search, seen).pass], [true, true]);
	const missed = { ...seen, calls: [{ call: 'do_step', verb: 'find', state: 'FAILED', reasonCode: 'FIND_BUDGET' }] };
	assert.equal(findSpotVerdict(search, missed).pass, false);
	assert.match(findSpotVerdict(search, missed).failReason, /FIND_BUDGET/);
	// A search sent some other way is still judged as a search, from its recorded find code.
	const odd = { calls: [{ name: 'find', arguments: {} }] };
	assert.deepEqual(Object.values((({ found, pass }) => ({ found, pass }))(findSpotVerdict(odd, { calls: [{ call: 'find', state: 'FAILED', reasonCode: 'FIND_BUDGET' }], deaths: 0, damageTaken: 0 }))), [false, false]);
});

test('a room with no find call that never played cannot pass on standing still', async () => {
	const spot = { name: 'lava-room-1', calls: [{ name: 'act', arguments: {} }] };
	const still = { deaths: 0, damageTaken: 0 };
	// The harness threw (schema rejection), the server refused the command, nothing ran, or observations were lost.
	for (const [row, reason] of [
		[{ ...still, calls: [act('ERROR', 'INVALID_ARGUMENTS')] }, /act INVALID_ARGUMENTS never reached the body/],
		[{ ...still, calls: [act('SUCCEEDED', 'ARRIVED'), act('FAILED', 'STALE_REVISION')] }, /STALE_REVISION never reached the body/],
		[{ ...still, calls: [] }, /no call ran/],
		[{ ...still, calls: [act('SUCCEEDED', 'ARRIVED')], ended: 'death or lost observations' }, /spot ended early/],
	]) {
		const verdict = findSpotVerdict(spot, row);
		assert.match(verdict.notExercised, reason);
		assert.equal(roomVerdict({ ...row, ...verdict }).verdict, 'INVALID');
	}
	// Nor can a search whose find threw before it reached the body be called "not found".
	const search = { calls: [{ name: 'do_step', arguments: { verb: 'find' } }] };
	const threw = { ...still, calls: [{ call: 'do_step', verb: 'find', state: 'ERROR', reasonCode: 'ERROR' }] };
	assert.equal(roomVerdict({ ...threw, ...findSpotVerdict(search, threw) }).verdict, 'INVALID');
	// A measured miss stays a FAIL even when a call errored.
	const hurt = { deaths: 1, damageTaken: 20, calls: [act('ERROR', 'INVALID_ARGUMENTS')], ended: 'death or lost observations' };
	assert.equal(roomVerdict({ ...hurt, ...findSpotVerdict(spot, hurt) }).verdict, 'FAIL');
});

test('a safety room whose calls the server rejected at admission is not exercised; a first-tick hazard stop still is', async () => {
	const spot = { name: 'lava-room-1', calls: [{ name: 'act', arguments: {} }] };
	const still = { deaths: 0, damageTaken: 0 };
	// sendRejectedAction: a FAILED receipt with executionStarted and physicalAttempted false, for a quarantined runtime or
	// a slot already in use. No safety behaviour ran, so standing still with no damage measures nothing.
	const rejected = reasonCode => ({ ...act('FAILED', reasonCode), executionStarted: false, physicalAttempted: false });
	for (const calls of [[rejected('ACTION_RUNTIME_QUARANTINED')], [rejected('ACTION_ALREADY_ACTIVE'), rejected('ACTION_ALREADY_ACTIVE')],
		[act('FAILED', 'ACTION_RUNTIME_QUARANTINED')]]) {
		const row = { ...still, calls };
		const verdict = findSpotVerdict(spot, row);
		assert.match(verdict.notExercised ?? '', /never reached the body/, JSON.stringify(calls));
		assert.equal(roomVerdict({ ...row, ...verdict }).verdict, 'INVALID');
	}
	// A search whose last find was rejected at admission is no "not found" either.
	const search = { calls: [{ name: 'do_step', arguments: { verb: 'find' } }] };
	const busy = { ...still, calls: [{ call: 'do_step', verb: 'find', ...rejected('ACTION_ALREADY_ACTIVE') }] };
	assert.equal(roomVerdict({ ...busy, ...findSpotVerdict(search, busy) }).verdict, 'INVALID');
	// A hazard stop on the first tick also reports both flags false, and it is the stop a lava room wants: still a PASS.
	const stopped = { ...still, calls: [{ ...act('FAILED', 'LAVA_AHEAD'), executionStarted: false, physicalAttempted: false }] };
	const verdict = findSpotVerdict(spot, stopped);
	assert.equal(verdict.notExercised, undefined);
	assert.equal(roomVerdict({ ...stopped, ...verdict }).verdict, 'PASS');
	// A background step (do_step build) returns RUNNING; its receipt reaches only row.actions through the action_result tap.
	const build = { name: 'carve-hidden-lava', calls: [{ name: 'do_step', arguments: { verb: 'build' } }] };
	const started = { call: 'do_step', verb: 'build', state: 'RUNNING' };
	const turnedAway = { ...still, calls: [started], actions: [{ type: 'build', ...rejected('ACTION_RUNTIME_QUARANTINED') }] };
	const away = findSpotVerdict(build, turnedAway);
	assert.match(away.notExercised ?? '', /build ACTION_RUNTIME_QUARANTINED never reached the body/);
	assert.equal(roomVerdict({ ...turnedAway, ...away }).verdict, 'INVALID');
	// One refused re-ask beside a step the body did run is no unplayed room.
	const played = { ...turnedAway, actions: [{ type: 'build', ...rejected('ACTION_ALREADY_ACTIVE') }, { type: 'build', state: 'SUCCEEDED', reasonCode: 'BUILT', executionStarted: true, physicalAttempted: true }] };
	assert.equal(roomVerdict({ ...played, ...findSpotVerdict(build, played) }).verdict, 'PASS');
	// The stand-in still re-asks a find the busy slot refused: that race clears once the cancelled action ends.
	assert.equal(shouldRepeat({ name: 'do_step', arguments: { verb: 'find' } }, rejected('ACTION_ALREADY_ACTIVE'), { repeat: true }), true);
});

test('a safety room whose background step never ended is not exercised, and find-live waits for that step', async () => {
	// carve-hidden-lava: do_step build returns RUNNING at once; no damage yet says nothing about the dig toward the lava.
	const build = { name: 'carve-hidden-lava', calls: [{ name: 'do_step', arguments: { verb: 'build' } }] };
	const unfinished = { deaths: 0, damageTaken: 0, calls: [{ call: 'do_step', verb: 'build', state: 'RUNNING' }], actions: [{ actionId: 'a1', type: 'build' }] };
	const verdict = findSpotVerdict(build, unfinished);
	assert.match(verdict.notExercised ?? '', /build has no terminal receipt/);
	assert.equal(roomVerdict({ ...unfinished, ...verdict }).verdict, 'INVALID');
	const ended = { ...unfinished, actions: [{ actionId: 'a1', type: 'build', state: 'SUCCEEDED', reasonCode: 'BUILT', executionStarted: true, physicalAttempted: true }] };
	assert.equal(roomVerdict({ ...ended, ...findSpotVerdict(build, ended) }).verdict, 'PASS');
	// find-live holds the readings until every command has its receipt, a death, or the spot's budget.
	const row = { actions: [{ actionId: 'a1', type: 'build' }] };
	let clock = 0, waits = 0;
	const wait = async ms => { clock += ms; if (++waits === 3) Object.assign(row.actions[0], { state: 'SUCCEEDED', reasonCode: 'BUILT' }); };
	assert.deepEqual(await awaitActionReceipts(row, { deadline: 60_000, now: () => clock, wait, stopped: async () => false }), []);
	assert.equal(waits, 3);
	const stuck = { actions: [{ actionId: 'a2', type: 'build' }] };
	clock = 0;
	assert.deepEqual((await awaitActionReceipts(stuck, { deadline: 2_000, now: () => clock, wait: async ms => { clock += ms; }, stopped: async () => false })).map(a => a.actionId), ['a2']);
	clock = 0;
	assert.equal((await awaitActionReceipts(stuck, { deadline: 60_000, now: () => clock, wait: async ms => { clock += ms; }, stopped: async () => clock >= 1_000 })).length, 1, 'a death ends the wait');
	assert.ok(clock < 60_000);
});

test('find-live keeps the body\'s execution evidence on each call', () => {
	const call = { name: 'act', arguments: {} };
	const entry = callEntry(call, { state: 'FAILED', reasonCode: 'ACTION_ALREADY_ACTIVE', message: 'busy', executionStarted: false, physicalAttempted: false },
		{ attempt: 0, atS: 3, seconds: 0 });
	assert.deepEqual([entry.executionStarted, entry.physicalAttempted], [false, false]);
	assert.equal('executionStarted' in callEntry(call, { state: 'ERROR', reasonCode: 'ERROR' }, { attempt: 0, atS: 0, seconds: 0 }), false, 'no flags reported, none invented');
});

test('find-live times a sighting by the find that saw it, not by the last call of the spot', () => {
	const call = { name: 'act', arguments: {} };
	// A find that saw its target at 10 s, then an 80 s act: the target was found at 10 s, not 90 s.
	const spot = { calls: [{ name: 'do_step', arguments: { verb: 'find' } }, call] };
	const row = { deaths: 0, damageTaken: 0, calls: [
		{ call: 'do_step', verb: 'find', atS: 0, seconds: 10, state: 'SUCCEEDED', reasonCode: 'FIND_SEEN' },
		{ call: 'act', atS: 10, seconds: 80, state: 'SUCCEEDED', reasonCode: 'ARRIVED' },
	] };
	assert.equal(findSpotVerdict(spot, row).foundAtS, 10);
	assert.equal(findSpotVerdict(spot, { ...row, calls: [{ ...row.calls[0], state: 'FAILED', reasonCode: 'FIND_BUDGET' }] }).foundAtS, null);
	assert.equal(findSpotVerdict({ calls: [call] }, { deaths: 0, damageTaken: 0, calls: [row.calls[1]] }).foundAtS, null, 'no search, no sighting time');
});

test('find-live labels and repeats only find calls as searches', () => {
	const find = { name: 'do_step', arguments: { verb: 'find' } }, climb = { name: 'do_step', arguments: { verb: 'obtain' } };
	assert.equal(findSpotLabel({ found: null, pass: true }), 'PASS', 'a climb that succeeded is no "NOT FOUND"');
	assert.match(findSpotLabel({ found: null, pass: false, failReason: '1 deaths' }), /^FAIL \(1 deaths\)/);
	assert.equal(findSpotLabel({ found: false, pass: false }), 'NOT FOUND');
	const spot = { repeat: true };
	// A finished non-find call never spins until the budget runs out.
	assert.equal(shouldRepeat(climb, { state: 'SUCCEEDED', reasonCode: 'OPEN_SKY' }, spot), false);
	assert.equal(shouldRepeat(climb, { state: 'FAILED', reasonCode: 'OPEN_SKY' }, spot), false);
	assert.equal(shouldRepeat(climb, { state: 'FAILED', reasonCode: 'DANGER' }, { repeat: true, repeatOn: ['DANGER'] }), true);
	// A find re-asks after a danger hand-back, not after FIND_BLOCKED, a sighting or an expected code, and not past its budget.
	assert.equal(shouldRepeat(find, { state: 'INTERRUPTED', reasonCode: 'FIND_DANGER' }, spot), true);
	assert.equal(shouldRepeat(find, { state: 'FAILED', reasonCode: 'FIND_BLOCKED' }, spot), false);
	assert.equal(shouldRepeat(find, { state: 'SUCCEEDED', reasonCode: 'FIND_SEEN' }, spot), false);
	assert.equal(shouldRepeat(find, { state: 'FAILED', reasonCode: 'FIND_DANGER' }, { repeat: true, expectCode: 'FIND_DANGER' }), false);
	assert.equal(shouldRepeat(find, { state: 'INTERRUPTED', reasonCode: 'FIND_DANGER' }, spot, { budgetLeftMs: 5000 }), false);
	assert.equal(shouldRepeat(find, { state: 'INTERRUPTED', reasonCode: 'FIND_DANGER' }, {}), false);
	// A call that never reached the body is not re-asked at once until the budget ends.
	assert.equal(shouldRepeat(find, { state: 'ERROR', reasonCode: 'ERROR' }, spot), false);
	assert.equal(shouldRepeat(find, { state: 'FAILED', reasonCode: 'STALE_REVISION' }, spot), false);
});

test('one invalid room cannot hide 13 passing rooms: the arm reports pass, fail and invalid counts with reasons', async () => {
	const rows = Array.from({ length: 14 }, (_, run) => ({ room: 'breath', run, startedAt: run, finishedAt: run + 1, pass: true }));
	rows[7] = { room: 'breath', run: 7, startedAt: 7, finishedAt: 8, pass: true, notExercised: 'body not placed on the room cell (12 blocks off)' };
	const summary = fixtureSummary(rows);
	assert.deepEqual([summary.passed, summary.failed, summary.invalid], [13, 0, 1]);
	assert.equal(summary.armVerdict, 'PASS', 'the valid rooms all passed');
	assert.equal(summary.status, 'INVALID', 'the arm still asks for the invalid room to be rerun');
	assert.deepEqual(summary.rooms[7], { name: 'breath#7', verdict: 'INVALID', reason: 'not exercised: body not placed on the room cell (12 blocks off)' });
	assert.match(summary.line, /^13 pass, 0 fail, 1 invalid of 14 planned; valid rooms PASS; status INVALID \| breath#7 INVALID: not exercised/);
	assert.equal(await exitOf(rows), 2);
	// A measured failure is never hidden behind an invalid room either.
	assert.equal(await exitOf([{ pass: true }, { pass: false, failReason: 'body died' }, { error: 'TIMEOUT ready' }]), 1);
	// Each room counts once: an errored room is invalid, not also failed; a room with no verdict is counted as invalid.
	const once = fixtureSummary([{ pass: false, error: 'Error: agent never registered' }, { startedAt: 1 }, { pass: true }]);
	assert.deepEqual([once.passed, once.failed, once.invalid], [1, 0, 2]);
	assert.equal(once.rooms[1].reason, 'no verdict recorded (pass unset)');
});

test('a room marked pass whose reflex yielded to the model command reports FAIL; one whose reflex never fired is invalid', () => {
	// Wire outcomes are ReflexScheduler.Outcome in lower case; the breath default yielded after 0.65 s.
	const yielded = { events: [{ seq: 4, id: 'end-breath', outcome: 'yielded', ms: 650 }] };
	const hold = reflexHold(yielded, { id: 'end-breath', sinceSeq: 3 });
	assert.equal(hold.verdict, 'FAIL');
	assert.match(hold.reason, /end-breath yielded after 0\.65 s/);
	assert.deepEqual(roomVerdict({ pass: true, reflexHold: hold }), { verdict: 'FAIL', reason: hold.reason });
	// A room may say how long the rule had to hold before a yield is fine.
	assert.equal(reflexHold(yielded, { id: 'end-breath', holdMs: 500 }).verdict, 'PASS');
	assert.equal(reflexHold({ events: [{ seq: 4, id: 'end-breath', outcome: 'done', ms: 4000 }] }, { id: 'end-breath' }).verdict, 'PASS');
	assert.equal(reflexHold({ events: [], firing: { id: 'end-breath' } }, { id: 'end-breath' }).verdict, 'PASS', 'still firing at the end');
	// The fireball landed 4.8 blocks off and the breath never fired: the room measured nothing.
	for (const reflexes of [{ events: [] }, { events: [{ seq: 4, id: 'end-breath', outcome: 'disabled' }] }, { events: [{ seq: 2, id: 'end-breath', outcome: 'done' }] }]) {
		const never = reflexHold(reflexes, { id: 'end-breath', sinceSeq: 3 });
		assert.equal(never.verdict, 'INVALID');
		assert.equal(roomVerdict({ pass: true, reflexHold: never }).verdict, 'INVALID');
	}
	assert.equal(reflexHold({ events: [{ seq: 4, id: 'end-breath', outcome: 'failed', detail: 'no blocks' }] }, { id: 'end-breath' }).verdict, 'FAIL');
});

test('deaths come from the vanilla counter: "has 1 [deaths]" is one death, and refused commands are no calls', async () => {
	const replies = ['Probe has 1 [deaths]', "Can't get value of deaths for Probe; none is set", 'Unknown scoreboard objective'];
	const read = () => deathCounter(async () => replies.shift(), 'Probe', { objective: 'deaths', unsetIsZero: true });
	assert.equal(await read(), 1);
	assert.equal(await read(), 0, 'boot() adds the objective before the body exists, so unset is no death yet');
	assert.equal(await read(), null);
	assert.equal(await deathCounter(async () => 'Probe has 1 [deaths]', 'Probe'), null, 'the qo_death reader keeps its own objective');
	assert.deepEqual(deathEvidence(0, 1), { before: 0, after: 1, valid: true, deaths: 1 });
	// Command refused for a stale revision: no fight ran.
	assert.equal(refusedBeforeRunning({ state: 'FAILED', reasonCode: 'STALE_REVISION' }), true);
	assert.equal(refusedBeforeRunning({ state: 'FAILED', reasonCode: 'TARGET_LOST' }), false);
	const counter = terminalCounter();
	for (let i = 0; i < 50; i++) counter.accept({ type: 'action_result', agentId: 'a', payload: { actionId: `stale-${i}`, goalRevision: 1, state: 'FAILED', reasonCode: 'STALE_REVISION' } });
	counter.accept({ type: 'action_result', agentId: 'a', payload: { actionId: 'fight', goalRevision: 2, state: 'SUCCEEDED', reasonCode: 'UNTIL_COUNT_REACHED' } });
	assert.deepEqual(counter.snapshot(), { terminalResults: 1, byReason: { UNTIL_COUNT_REACHED: 1 }, duplicates: 0, missingActionIds: 0, conflicts: 0, refused: 50 });
});

test('a repeated refused receipt is one refusal, and a conflicting receipt for it still counts as a conflict', () => {
	const counter = terminalCounter();
	const stale = { type: 'action_result', agentId: 'a', payload: { actionId: 'x', goalRevision: 1, state: 'FAILED', reasonCode: 'STALE_REVISION' } };
	counter.accept(stale);
	counter.accept(stale);
	counter.accept({ type: 'action_result', agentId: 'a', payload: { actionId: 'x', goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'UNTIL_COUNT_REACHED' } });
	assert.deepEqual(counter.snapshot(), { terminalResults: 0, byReason: {}, duplicates: 2, missingActionIds: 0, conflicts: 1, refused: 1 });
});

test('no live fixture reads the deaths scoreboard with a trailing-number parse', async () => {
	// `number(reply) || 0` reads "Probe has 1 [deaths]" as NaN and then 0: every death disappeared.
	for (const name of (await readdir(quality)).filter(file => file.endsWith('.mjs'))) {
		const text = await readFile(path.join(quality, name), 'utf8');
		assert.doesNotMatch(text, /number\(await s\.command\(`scoreboard players get \$\{\w+\} deaths`\)\)/, `${name} parses the deaths reply as a trailing number`);
	}
});

test('the health floor sees a death between samples; unknown deaths give no floor', async () => {
	assert.equal(healthFloor({ samples: [20, 18, 20], deaths: 1 }), 0, 'died and respawned between reads');
	assert.equal(healthFloor({ samples: [20, 14, 19], deaths: 0 }), 14);
	assert.equal(healthFloor({ samples: [20], deaths: null }), null);
	assert.equal(healthFloor({ samples: [], deaths: 0 }), null);
	// The watch samples on its own clock, not between calls: one long call that killed the body still shows the death.
	const deathReads = [0, 1], healthReads = [20, 20, 20, 20];
	const watch = startHealthWatch({ readHealth: async () => healthReads.shift() ?? 20, readDeaths: async () => deathReads.shift(), intervalMs: 1, wait: () => new Promise(done => setImmediate(done)) });
	await new Promise(done => setTimeout(done, 20));
	const report = await watch.stop();
	assert.ok(report.samples >= 2);
	assert.deepEqual([report.minHealth, report.deaths, report.died], [0, 1, true]);
	const unknown = startHealthWatch({ readHealth: async () => 20, readDeaths: async () => { throw new Error('rcon closed'); }, intervalMs: 1, wait: () => new Promise(done => setImmediate(done)) });
	assert.deepEqual([(await unknown.stop()).minHealth, (await unknown.stop()).died], [null, null]);
});

test('boot() proposes the survival the goal text asks for and follows a revision moved without goal_control', async () => {
	assert.equal(surviveTicks('Survive for 1200 seconds.'), 24000);
	assert.equal(surviveTicks('Survive for 36000 seconds.'), 720000);
	assert.equal(surviveTicks('survive 2 minutes'), 2400);
	assert.equal(surviveTicks('Find lava.'), null);
	// The default 24000 fell short of a 36000 s goal, the mod refused the proposal, and goal_control never arrived.
	assert.equal(proposedGoalTicks('Survive for 36000 seconds.'), 720000);
	assert.equal(proposedGoalTicks('Survive for 600 seconds.', 2_000_000), 2_000_000, 'a longer goalTicks still proves the text');
	assert.equal(proposedGoalTicks('Find lava.', 30000), 30000);
	const record = { agentId: 'a', goalRevision: 4 };
	// A low-health hand-back moves the revision; the next message for the agent carries it.
	assert.equal(newerGoalRevision(record, { type: 'action_result', agentId: 'a', payload: { goalRevision: 5, state: 'CANCELLED' } }), 5);
	assert.equal(newerGoalRevision(record, { type: 'conversation_wake', agentId: 'a', payload: { control: { goalRevision: 6 } } }), 6);
	assert.equal(newerGoalRevision(record, { type: 'agent_registered', agentId: 'a', payload: { record: { goalRevision: 7 } } }), 7);
	assert.equal(newerGoalRevision(record, { type: 'goal_control', agentId: 'a', payload: { operation: 'queue', goalRevision: 9 } }), null);
	assert.equal(newerGoalRevision(record, { type: 'action_result', agentId: 'a', payload: { goalRevision: 3 } }), null);
	assert.equal(newerGoalRevision(record, { type: 'action_result', agentId: 'b', payload: { goalRevision: 8 } }), null);
	// A fixture's copy of the record (with its model fields) sends the revision boot() followed, not the one it copied.
	const s = { record: { agentId: 'a', goalRevision: 4 } };
	const copy = liveRecord(s, { provider: 'codex' });
	s.record.goalRevision = 5;
	assert.deepEqual(JSON.parse(JSON.stringify(copy)), { agentId: 'a', goalRevision: 5, provider: 'codex' });
	for (const name of ['test-find-live.mjs', 'test-gather-live.mjs', 'test-build-live.mjs']) {
		assert.doesNotMatch(await readFile(path.join(quality, name), 'utf8'), /const record = \{ \.\.\.s\.record/, `${name} copies a stale revision`);
	}
	// The production coordinator owns run-incident's bridge, so boot() must not answer agent_ready beside it there.
	assert.match(await readFile(path.join(quality, 'run-incident.mjs'), 'utf8'), /followRevision: false/);
});

test('a spot with a final-probe expectation fails when the ground truth after the calls does not match', () => {
	const spot = { expectCode: 'OBTAINED', expectFinalProbe: [{ index: 0, match: 'Test passed' }] };
	const row = { calls: [{ reasonCode: 'OBTAINED', state: 'SUCCEEDED' }], deaths: 0, finalProbe: ['Test passed'] };
	assert.equal(findSpotVerdict(spot, row).pass, true);
	const left = findSpotVerdict(spot, { ...row, finalProbe: ['Test failed'] });
	assert.equal(left.pass, false);
	assert.match(left.failReason, /final probe 0 replied "Test failed"/);
	assert.equal(findSpotVerdict(spot, { ...row, finalProbe: undefined }).pass, false, 'no probe reply is no pass');
});
