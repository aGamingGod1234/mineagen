import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { LiveTaskViews } from '../src/live-task-view.mjs';
import { emptyKnown } from '../src/plan-checks.mjs';
import { TASK_BUDGET_MS, firedTask, noteTaskDeath, noteTaskTime, taskSwitchLine } from '../src/task-clock.mjs';

const T0 = 1_800_000_000_000, MIN = 60_000;
const step = (id, check, label = id) => ({ id, label, kind: 'milestone', status: 'pending', dependsOn: [], detail: '', evidence: null, check });
const kit = [{ itemId: 'minecraft:iron_pickaxe', count: 1 }, { itemId: 'minecraft:bucket', count: 1 }];
const plan = ids => [step(ids.iron, 'tool:pickaxe:iron+ & has:minecraft:bucket|minecraft:water_bucket|minecraft:lava_bucket*1', 'iron kit'),
	step(ids.depth, 'y<=-45', 'the lava floors'), step(ids.pool, 'lava:10', 'a still lava pool'), step(ids.nether, 'in:minecraft:the_nether', 'the Nether')];
const steps = plan({ iron: 'iron', depth: 'depth', pool: 'pool', nether: 'nether' });
const renamed = plan({ iron: 'iron_kit', depth: 'lava_depth', pool: 'lava_pool', nether: 'enter' });
const sample = (at, { x = 0, y = -55, z = 0, items = kit, dimension = 'minecraft:overworld' } = {}) =>
	({ ready: true, observedAtEpochMs: at, world: { worldId: 'w1', dimension }, player: { x, y, z, dead: false }, inventory: { items } });

// Minutes of samples, one a minute, on the given focus step.
function play(ledger, from, minutes, { plan: s = steps, focus, known = emptyKnown(), ...where } = {}) {
	let l = ledger;
	for (let i = 1; i <= minutes; i++) l = noteTaskTime(l, { at: from + i * MIN, worldId: 'w1', steps: s, focus: s.find(x => x.id === focus) ?? null, observation: sample(from + i * MIN, where), known });
	return l;
}
const meet = (l, at, known = emptyKnown()) => noteTaskTime(l, { at, worldId: 'w1', steps, focus: steps[0], observation: sample(at, { y: -55 }), known });

test('time on a task adds up across a death, a plan rewrite with renamed steps and two sites, and fires once at the budget', () => {
	let l = meet(null, T0);
	l = play(l, T0, 8, { focus: 'pool', x: 0 });
	l = noteTaskDeath(l, 'minecraft:overworld');
	// The rebuild after the death (iron redone) is no time on the pool.
	l = play(l, T0 + 8 * MIN, 10, { focus: 'iron', y: 64, items: [] });
	assert.equal(Math.round(l.clocks['lava:10'].ms / MIN), 8);
	// A rewrite renames every step; the check is the same task.
	l = play(l, T0 + 18 * MIN, 7, { plan: renamed, focus: 'lava_pool', x: 300 });
	assert.equal(firedTask(l, { steps: renamed }), null);
	// Climbing back above the floors (the depth step redone) is still time on the pool.
	l = play(l, T0 + 25 * MIN, 5, { plan: renamed, focus: 'lava_depth', x: 300, y: -20 });
	const fired = firedTask(l, { steps: renamed });
	assert.equal(Math.round(fired.ms / MIN), 20);
	assert.equal(fired.lives, 1);
	assert.deepEqual(fired.sites.map(s => [s.x, Math.round(s.ms / MIN)]), [[300, 12], [0, 8]]);
	assert.equal(l.wake, true);
	l.wake = false;
	l = play(l, T0 + 30 * MIN, 5, { focus: 'pool', x: 300 });
	assert.equal(l.wake, false, 'one wake per clock');
	const line = taskSwitchLine(firedTask(l, { steps }), { observation: sample(T0) });
	assert.match(line, /^a still lava pool: 25 min over 2 lives, 1 death with no gain; tried near 300,0 \(17 min\), 0,0 \(8 min\); switch now: pick a new site at least 100 blocks from the tried ones/);
});

test('alternating between two failed sites never starts the clock over', () => {
	let l = meet(null, T0);
	for (let round = 0; round < 4; round++) l = play(l, T0 + round * 5 * MIN, 5, { focus: 'pool', x: round % 2 ? 200 : 0 });
	assert.equal(Math.round(firedTask(l, { steps }).ms / MIN), 20);
});

test('a new best on the task is progress; a gap in samples is a pause, not time', () => {
	const known = emptyKnown();
	let l = meet(null, T0);
	l = play(l, T0, 15, { focus: 'pool', known });
	known.lavaPools.push({ dimension: 'minecraft:overworld', x: 40, y: -56, z: 0, sources: 4, cells: [] });
	l = play(l, T0 + 15 * MIN, 1, { focus: 'pool', known });
	assert.equal(l.clocks['lava:10'].ms, 0, 'four sources seen is progress on the pool');
	// The same four sources again is not.
	l = play(l, T0 + 16 * MIN, 3, { focus: 'pool', known });
	assert.equal(l.clocks['lava:10'].ms, 3 * MIN);
	// A two-hour gap (a restart) adds at most a minute.
	l = noteTaskTime(l, { at: T0 + 140 * MIN, worldId: 'w1', steps, focus: steps[2], observation: sample(T0 + 140 * MIN), known });
	assert.equal(l.clocks['lava:10'].ms, 4 * MIN);
	// The check met for the first time ends the task: the clock goes and the step stays met.
	known.lavaPools[0].sources = 12;
	l = play(l, T0 + 140 * MIN, 1, { focus: 'pool', known });
	assert.equal(l.clocks['lava:10'], undefined);
	assert.ok(l.met.includes('lava:10'));
});

test('a remembered pool away from the tried sites is the switch for the lava stage', () => {
	const known = emptyKnown();
	known.lavaPools.push({ dimension: 'minecraft:overworld', x: 20, y: -56, z: 0, sources: 3, cells: [] }, { dimension: 'minecraft:overworld', x: 260, y: -58, z: 10, sources: 6, cells: [] });
	let l = meet(null, T0, known);
	l = play(l, T0, TASK_BUDGET_MS / MIN, { focus: 'pool', known });
	assert.match(taskSwitchLine(firedTask(l, { steps }), { known, observation: sample(T0) }), /switch now: go to the lava remembered at 260,-58,10 \(6 sources\), away from the tried sites, and cast there/);
});

test('two Nether deaths after real time on a task send the bot to re-kit; quick deaths do not count', () => {
	const rods = [step('nether', 'in:minecraft:the_nether'), step('rods', 'has:minecraft:blaze_rod*6', 'blaze rods')];
	const nether = { plan: rods, focus: 'rods', dimension: 'minecraft:the_nether', y: 70 };
	let l = noteTaskTime(null, { at: T0, worldId: 'w1', steps: rods, focus: rods[0], observation: sample(T0, { dimension: 'minecraft:the_nether' }), known: emptyKnown() });
	l = play(l, T0, 2, nether);
	l = noteTaskDeath(l, 'minecraft:the_nether');
	assert.equal(l.clocks['has:minecraft:blaze_rod*6'].deaths, 0, 'a death after 2 min is a quick failure');
	l = play(l, T0 + 2 * MIN, 6, nether);
	l = noteTaskDeath(l, 'minecraft:the_nether');
	l = play(l, T0 + 8 * MIN, 6, nether);
	l = noteTaskDeath(l, 'minecraft:the_nether');
	// Respawned in the Overworld: the walk back is time on the same task, and the clock fires there.
	l = play(l, T0 + 14 * MIN, 1, { ...nether, dimension: 'minecraft:overworld' });
	const fired = firedTask(l, { steps: rods });
	assert.equal(fired.deaths, 2);
	assert.match(taskSwitchLine(fired, { observation: sample(T0) }), /^blaze rods: 15 min over 4 lives, 2 deaths with no gain; .*switch now: re-kit before going back in: wear armour, carry a shield and food/);
});

test('the plan view keeps the clock across a coordinator restart, wakes once and states the switch above the route', async () => {
	const directory = await mkdtemp(path.join(os.tmpdir(), 'task-clock-'));
	try {
		const record = { agentId: 'a1', goalRevision: 1, currentGoal: 'Beat the game', currentGoalSpec: { originalRequest: 'Beat the game', fingerprint: 'f1' } };
		let now = T0;
		const first = new LiveTaskViews({ directory, now: () => now });
		await first.observe(record, sample(now));
		await first.operate(record, { operation: 'replace', plan: { steps } });
		for (let i = 1; i <= 12; i++) { now += MIN; await first.observe(record, sample(now)); }
		await new Promise(resolve => setTimeout(resolve, 50));
		const second = new LiveTaskViews({ directory, now: () => now });
		await second.observe(record, sample(now));
		for (let i = 1; i <= 8; i++) { now += MIN; await second.observe(record, sample(now)); assert.equal(second.continuity(record).stuck, undefined); }
		now += MIN; await second.observe(record, sample(now));
		assert.match(second.continuity(record).stuck, /^a still lava pool: 20 min with no gain/);
		const wakes = [second.progressWake(record), second.progressWake(record)];
		assert.ok(wakes.includes('no_progress'));
		assert.equal(second.progressWake(record), null);
	} finally { await new Promise(resolve => setTimeout(resolve, 100)); await rm(directory, { recursive: true, force: true, maxRetries: 5 }); }
});
