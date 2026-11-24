import assert from 'node:assert/strict';
import test from 'node:test';
import { canStart, expandPlan, loseGame, nextGame, scoreGame, summarize, summaryText } from '../../scripts/quality/lib/checkpoint-batch-core.mjs';

const plan = () => ({
	minutes: 90, deadline: '2026-11-22T01:00:00+08:00', codexHome: '/x',
	arms: { main: { root: '/a', ref: 'HEAD', jar: '/a.jar' }, int: { root: '/b', ref: 'HEAD', jar: '/b.jar', env: { MINEAGEN_X: '1' } } },
	savepoints: { nether: { file: '/n.json', repeats: 2, targets: ['fortress', 'blaze_rod'] }, eyes: { file: '/e.json', repeats: 1, targets: ['stronghold', 'end'] } },
});

test('checkpoint batch pairs both arms of a repeat on one shared salt and alternates which arm goes first', () => {
	let n = 0;
	const games = expandPlan(plan(), { salt: () => ++n });
	assert.deepEqual(games.map(g => `${g.id}:${g.salt}`), ['nether-r1-main:1', 'nether-r1-int:1', 'eyes-r1-int:2', 'eyes-r1-main:2', 'nether-r2-int:3', 'nether-r2-main:3']);
});

test('checkpoint batch alternates the first arm per save point even with an even number of save points', () => {
	const p = plan(); p.savepoints.eyes.repeats = 4; p.savepoints.nether.repeats = 4;
	const games = expandPlan(p, { salt: () => 1 });
	for (const point of ['nether', 'eyes']) {
		const firsts = [1, 2, 3, 4].map(r => games.find(g => g.savepoint === point && g.repeat === r).arm);
		assert.deepEqual(firsts.filter(a => a === 'main').length, 2, `${point} starts main first in half its repeats: ${firsts}`);
	}
});

test('checkpoint batch refuses a plan with a bad arm, save point or deadline', () => {
	const bad = plan();
	bad.deadline = 'tonight'; bad.arms.int.env = { 'bad name': '1' }; delete bad.savepoints.eyes.targets;
	assert.throws(() => expandPlan(bad), /deadline[\s\S]*env name[\s\S]*targets/);
});

test('checkpoint batch starts no game whose window would pass the deadline', () => {
	const p = plan(), deadline = Date.parse(p.deadline);
	assert.equal(canStart(deadline - 100 * 60_000, p), true);
	assert.equal(canStart(deadline - 99 * 60_000, p), false);
});

test('checkpoint batch picks the waiting arm of a started repeat first, then requeues a lost game once', () => {
	const games = expandPlan(plan(), { salt: () => 7 });
	games[0].state = 'running';
	games.push(games.splice(1, 1)[0]);
	assert.equal(nextGame(games).id, 'nether-r1-int');
	const lost = games[0]; lost.attempts = 1;
	loseGame(games, lost.id, 'gone');
	assert.equal(games[0].id, lost.id); assert.equal(lost.state, 'queued');
	lost.attempts = 2; loseGame(games, lost.id, 'gone again');
	assert.equal(lost.state, 'lost'); assert.deepEqual(lost.lostReasons, ['gone', 'gone again']);
});

test('checkpoint batch scores earned targets only, keeps inherited and missing ones unknown, and counts deaths', () => {
	const report = { timeline: { startedAt: 1_795_290_758_148, playedMs: 5_400_000, stopReason: 'WALL_CLOCK_BUDGET', milestones: [
		{ id: 'fortress', reached: true, elapsedMs: 1_800_000 }, { id: 'blaze_rod', reached: false, elapsedMs: null }, { id: 'iron_pickaxe', reached: true, elapsedMs: 1000 },
	], deaths: [{ cause: 'lava' }], unexplainedDeaths: 1 } };
	const score = scoreGame(report, ['fortress', 'blaze_rod', 'iron_pickaxe']);
	assert.deepEqual(score.targets, { fortress: 30, blaze_rod: false, iron_pickaxe: null });
	assert.deepEqual(score.inherited, ['iron_pickaxe']);
	assert.equal(score.deaths, 2);
	assert.deepEqual(scoreGame(null, ['fortress']), { known: false, why: 'no report', targets: { fortress: null }, deaths: null, stopReason: null });
	// A game that failed before any gameplay was observed: run-long's fallback timeline has every milestone unreached, no
	// deaths and no start. It is unknown, not a played game with 0 targets and 0 deaths.
	const fallback = { measurementStatus: 'UNAVAILABLE', timeline: { startedAt: null, milestones: [{ id: 'fortress', reached: false, elapsedMs: null }], deaths: [] } };
	assert.equal(scoreGame(fallback, ['fortress']).known, false);
	assert.equal(scoreGame({ ...fallback, measurementStatus: 'INCOMPLETE' }, ['fortress']).known, false);
	const games = [{ savepoint: 'nether', arm: 'main', state: 'done', score }, { savepoint: 'nether', arm: 'main', state: 'lost', score: scoreGame(null, ['fortress', 'blaze_rod']) }];
	const row = summarize(games, plan()).find(r => r.savepoint === 'nether' && r.arm === 'main');
	assert.deepEqual([row.games, row.known, row.lost, row.targets.fortress.reached, row.targets.fortress.of, row.deaths], [2, 1, 1, 1, 1, 2]);
});

test('checkpoint batch scores a game that ended early, or whose journals were damaged, as unknown and counts early ends apart', () => {
	const played = (stopReason, extra = {}) => ({ measurementStatus: 'INCOMPLETE', ...extra, timeline: { startedAt: 1, playedMs: 240_000, stopReason, milestones: [{ id: 'fortress', reached: false, elapsedMs: null }], deaths: [] } });
	// A crash or a kill 4 minutes in did not get its chance: not a miss with 0 deaths.
	const crashed = scoreGame(played('ENDED_EARLY:INTERRUPTED_SIGTERM'), ['fortress']);
	assert.deepEqual([crashed.known, crashed.endedEarly, crashed.targets.fortress, crashed.deaths], [false, true, null, null]);
	// A stall or the spend cap is how the game really went, so it still scores.
	for (const reason of ['ENDED_EARLY:STALL', 'ENDED_EARLY:SPEND_CAP']) assert.equal(scoreGame(played(reason), ['fortress']).known, true, reason);
	// A damaged or missing protocol journal loses deaths and can make first-seen times late; ordinary connection noise does not.
	for (const error of ['quality-protocol.jsonl: 3 malformed records', 'Live observer capture unavailable; using retained rotated protocol and provider input snapshots. First-seen milestone times may be late.', 'quality-samples.json: Unexpected end of JSON input'])
		assert.equal(scoreGame(played('WALL_CLOCK_BUDGET', { observerErrors: ['connect ECONNREFUSED 127.0.0.1:1', error] }), ['fortress']).known, false, error);
	assert.equal(scoreGame(played('WALL_CLOCK_BUDGET', { observerErrors: ['connect ECONNREFUSED 127.0.0.1:1', 'RCON client is closed'] }), ['fortress']).known, true);
	const rows = summarize([{ savepoint: 'nether', arm: 'main', state: 'done', score: crashed }], plan());
	assert.match(summaryText(rows.filter(r => r.savepoint === 'nether' && r.arm === 'main')), /0\/1 games scored, 1 ended early/);
});

test('checkpoint batch scores a game an operator stopped for a stall, and keeps one stopped for another reason unknown', () => {
	// operator-stop.mjs records its reason in report.operatorStop and run-long.mjs in report.stop, while the timeline says
	// the game was killed: the recorded reason wins, as in run-long.mjs stopOf and gate-report.mjs.
	const stopped = (reason, at = 'operatorStop') => ({ measurementStatus: 'INCOMPLETE', operatorStop: { reason }, ...(at === 'stop' ? { stop: { kind: null, reason } } : {}), timeline: { startedAt: 1, playedMs: 240_000, stopReason: 'ENDED_EARLY:INTERRUPTED_SIGTERM', milestones: [{ id: 'fortress', reached: false, elapsedMs: null }], deaths: [{ cause: 'lava' }] } });
	for (const at of ['operatorStop', 'stop']) {
		const stall = scoreGame(stopped('Stalled 40 min at the fortress bridge', at), ['fortress']);
		assert.deepEqual([stall.known, stall.targets.fortress, stall.deaths, stall.stopReason], [true, false, 1, 'Stalled 40 min at the fortress bridge'], at);
		const other = scoreGame(stopped('operator needed the machine back', at), ['fortress']);
		assert.deepEqual([other.known, other.endedEarly], [false, true], at);
	}
});

test('checkpoint batch plays a save point only with the arms it lists', () => {
	const p = plan(); p.savepoints.eyes.arms = ['main'];
	const games = expandPlan(p, { salt: () => 1 });
	assert.deepEqual(games.filter(g => g.savepoint === 'eyes').map(g => g.arm), ['main']);
	assert.deepEqual(summarize(games, p).filter(r => r.savepoint === 'eyes').map(r => r.arm), ['main']);
	p.savepoints.eyes.arms = ['nope'];
	assert.throws(() => expandPlan(p), /arms must list arms of the plan/);
});

test('checkpoint batch splits every arm evenly over the sign-ins and gives the arms of a repeat different ones', () => {
	const p = plan(); p.codexHomes = ['/one', '/two']; delete p.codexHome; p.savepoints.nether.repeats = 4;
	const games = expandPlan(p, { salt: () => 1 });
	for (const arm of ['main', 'int']) {
		const mine = games.filter(g => g.arm === arm && g.savepoint === 'nether').map(g => g.account);
		assert.equal(mine.filter(a => a === 0).length, mine.filter(a => a === 1).length, arm);
	}
	for (const repeat of [1, 2, 3, 4]) assert.deepEqual(new Set(games.filter(g => g.savepoint === 'nether' && g.repeat === repeat).map(g => g.account)).size, 2);
	assert.ok(expandPlan(plan(), { salt: () => 1 }).every(g => g.account === 0));
});

test('checkpoint batch plays a fresh world (fresh: true, no file) and allows windows up to the launcher limit of 6 hours', () => {
	const p = plan(); p.minutes = 355; p.savepoints = { fresh: { fresh: true, repeats: 2, targets: ['nether', 'dragon'] } };
	assert.deepEqual(expandPlan(p, { salt: () => 1 }).map(g => `${g.savepoint}-${g.repeat}`), ['fresh-1', 'fresh-1', 'fresh-2', 'fresh-2']);
	p.savepoints.fresh.file = '/f.json';
	assert.throws(() => expandPlan(p), /fresh: true for a new world \(not both\)/);
	delete p.savepoints.fresh.file; p.minutes = 356;
	assert.throws(() => expandPlan(p), /minutes must be an integer 1\.\.355/);
});
