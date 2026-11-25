import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, appendFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { check, feed, freshState, parseStopWhen, verdict } from '../../scripts/quality/lib/stop-when.mjs';
import { expandPlan, scoreGame } from '../../scripts/quality/lib/checkpoint-batch-core.mjs';
import { stopKind } from '../src/benchmark/long-run.mjs';

const start = at => ({ envelope: { type: 'goal_control', agentId: 'a', payload: { operation: 'start', updatedAtEpochMs: at } } });
const advancement = (id, at) => ({ envelope: { type: 'advancement_granted', agentId: 'a', payload: { advancementId: id } }, observedAtMs: at });
const seen = (at, items, dimension = 'minecraft:overworld') => ({ envelope: { type: 'observation', agentId: 'a', payload: { observedAtEpochMs: at, dimension, inventory: { items: items.map(([itemId, count]) => ({ itemId, count, tags: ['#x'] })) } } } });

test('stopWhen checks its keys and names what is wrong', () => {
	assert.deepEqual(parseStopWhen({ advancement: 'nether/obtain_blaze_rod' }), { advancement: ['minecraft:nether/obtain_blaze_rod'] });
	assert.deepEqual(parseStopWhen({ items: { ender_pearl: 12 }, stallMinutes: 30 }), { items: { 'minecraft:ender_pearl': 12 }, stallMinutes: 30 });
	assert.throws(() => parseStopWhen({}), /needs advancement, items or stallMinutes/);
	assert.throws(() => parseStopWhen({ pearls: 12 }), /unknown key pearls/);
	assert.throws(() => parseStopWhen({ items: { 'minecraft:ender_pearl': 0 } }), /maps item ids to counts/);
	assert.throws(() => parseStopWhen({ stallMinutes: 0 }), /at least 1/);
	assert.throws(() => expandPlan({ minutes: 60, deadline: '2026-11-26T09:00:00+08:00', codexHome: '/s', arms: { main: { root: '/r', ref: 'HEAD', jar: '/j' } },
		savepoints: { nether: { fresh: true, repeats: 1, targets: ['fortress'], stopWhen: { stallMinutes: -1 } } } }), /save point nether: stopWhen.stallMinutes/);
});

test('a plan without stopWhen gives its games none, and a save point stopWhen replaces the plan one', () => {
	const plan = { minutes: 60, deadline: '2026-11-26T09:00:00+08:00', codexHome: '/s', arms: { main: { root: '/r', ref: 'HEAD', jar: '/j' } },
		savepoints: { a: { fresh: true, repeats: 1, targets: ['fortress'] }, b: { fresh: true, repeats: 1, targets: ['fortress'], stopWhen: { items: { ender_pearl: 12 } } } } };
	assert.ok(!('stopWhen' in expandPlan(plan).find(g => g.savepoint === 'a')), 'the default is unchanged: a game with no stopWhen plays its whole window');
	const games = expandPlan({ ...plan, stopWhen: { stallMinutes: 30 } });
	assert.deepEqual(games.find(g => g.savepoint === 'a').stopWhen, { stallMinutes: 30 });
	assert.deepEqual(games.find(g => g.savepoint === 'b').stopWhen, { items: { 'minecraft:ender_pearl': 12 } });
});

test('only play after the goal start answers the question: setup advancements and save point items do not', () => {
	const spec = parseStopWhen({ advancement: 'story/enter_the_nether', items: { 'minecraft:ender_pearl': 12 } });
	const state = feed(freshState(), [advancement('minecraft:story/enter_the_nether', 1), start(10), seen(11, [['minecraft:ender_pearl', 11]])], spec);
	assert.equal(verdict(state, spec, 12), null, 'the advancement came back at setup, before the goal start');
	feed(state, [seen(20, [['minecraft:ender_pearl', 7], ['minecraft:ender_pearl', 5]])], spec);
	assert.equal(verdict(state, spec, 21), 'QUESTION_ANSWERED: items 12 minecraft:ender_pearl', 'stacks of one item add up');
	const nether = feed(freshState(), [start(10), advancement('minecraft:story/enter_the_nether', 30)], spec);
	assert.equal(verdict(nether, spec, 31), 'QUESTION_ANSWERED: advancement minecraft:story/enter_the_nether');
	assert.equal(stopKind('ENDED_EARLY:QUESTION_ANSWERED: advancement minecraft:story/enter_the_nether'), 'goal');
	const pearls = parseStopWhen({ items: { 'minecraft:ender_pearl': 12 } });
	const inherited = feed(freshState(), [start(10), seen(11, [['minecraft:ender_pearl', 12]]), seen(12, [['minecraft:ender_pearl', 12]])], pearls);
	assert.equal(verdict(inherited, pearls, 13), null, 'the 12 pearls the save point started with do not answer');
	feed(inherited, [seen(14, [['minecraft:ender_pearl', 13]])], pearls);
	assert.equal(verdict(inherited, pearls, 15), 'QUESTION_ANSWERED: items 12 minecraft:ender_pearl', 'one more than it started with does');
});

test('in a fresh world the first item is progress: the empty start is the baseline', () => {
	const spec = parseStopWhen({ stallMinutes: 30 }), min = 60_000;
	const state = feed(freshState(), [start(0), seen(1, []), seen(29 * min, [['minecraft:cobblestone', 1]])], spec);
	assert.equal(verdict(state, spec, 31 * min), null);
	assert.match(verdict(state, spec, 59 * min), /^STALL/);
});

test('a stall is that long with no new advancement, item kind or dimension, and scores as a stall', () => {
	const spec = parseStopWhen({ stallMinutes: 20 }), min = 60_000;
	const state = feed(freshState(), [start(0), seen(1, [['minecraft:dirt', 3]]), seen(5 * min, [['minecraft:dirt', 9]]), seen(6 * min, [['minecraft:dirt', 9], ['minecraft:oak_log', 1]])], spec);
	assert.equal(verdict(state, spec, 25 * min), null, 'the oak log at 6 min was progress; more dirt was not');
	const reason = verdict(state, spec, 26 * min);
	assert.equal(reason, 'STALL: no new advancement, item kind or dimension for 20 min');
	assert.equal(stopKind(`ENDED_EARLY:${reason}`), 'stall');
	feed(state, [seen(27 * min, [['minecraft:dirt', 9]], 'minecraft:the_nether')], spec);
	assert.equal(verdict(state, spec, 30 * min), null, 'a new dimension restarts the clock');
});

test('the machine-side check reads the journal in pieces and leaves the stop reason for run-long', () => {
	const dir = mkdtempSync(path.join(tmpdir(), 'stop-when-')), raw = path.join(dir, 'raw'), game = path.join(dir, 'game');
	try {
		mkdirSync(raw); mkdirSync(path.join(game, 'report'), { recursive: true });
		writeFileSync(path.join(game, 'run.log'), `Running q-LONG-r1: ${raw}\n`);
		const journal = path.join(raw, 'quality-protocol.jsonl'), spec = parseStopWhen({ advancement: 'nether/obtain_blaze_rod' });
		writeFileSync(journal, `${JSON.stringify(start(Date.now()))}\n{"envelope":{"type":"advancement_gr`);
		assert.deepEqual(check(game, spec), { stop: false }, 'a line still being written waits for its end');
		appendFileSync(journal, `anted","agentId":"a","payload":{"advancementId":"minecraft:nether/obtain_blaze_rod"}}}\n`);
		assert.deepEqual(check(game, spec), { stop: true, reason: 'QUESTION_ANSWERED: advancement minecraft:nether/obtain_blaze_rod' });
		const record = JSON.parse(readFileSync(path.join(game, 'report/operator-stop.json'), 'utf8'));
		assert.equal(record.reason, 'QUESTION_ANSWERED: advancement minecraft:nether/obtain_blaze_rod');
		assert.equal(record.kind, 'operator-stop');
	} finally { rmSync(dir, { recursive: true, force: true }); }
});

test('an answered game scores the targets it never played on to as unobserved, a stalled one as misses', () => {
	const report = reason => ({ measurementStatus: 'MEASURED', operatorStop: { reason }, stop: { reason },
		timeline: { startedAt: 1, playedMs: 40 * 60_000, stopReason: 'ENDED_EARLY:INTERRUPTED_SIGTERM', deaths: [],
			milestones: [{ id: 'blaze_rod', reached: true, elapsedMs: 30 * 60_000 }, { id: 'ender_pearl', reached: false }] } });
	const answered = scoreGame(report('QUESTION_ANSWERED: advancement minecraft:nether/obtain_blaze_rod'), ['blaze_rod', 'ender_pearl']);
	assert.equal(answered.known, true);
	assert.deepEqual(answered.targets, { blaze_rod: 30, ender_pearl: null });
	const stalled = scoreGame(report('STALL: no new advancement, item kind or dimension for 30 min'), ['blaze_rod', 'ender_pearl']);
	assert.deepEqual(stalled.targets, { blaze_rod: 30, ender_pearl: false });
});
