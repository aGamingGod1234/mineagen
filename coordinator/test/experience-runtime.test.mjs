import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeMemoryContext } from '../src/runtime-memory-context.mjs';
import { TaskMemoryStore } from '../src/task-memory-store.mjs';
import { ExperienceStore, experienceHash, experienceSettings } from '../src/experience-store.mjs';
import { classifyDeath, createExperience, MAX_SHOWN_LESSONS } from '../src/experience-runtime.mjs';
import { deathLessons, LESSON_RULES, lessonEntry } from '../src/experience-lessons.mjs';

const record = { agentId: 'agent-a', goalRevision: 1, provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'low', serviceTier: 'default' };
const T0 = 1_800_000_000_000;

function observation(worldId, at, { hostiles = [], health = 20, edible = 3, dimension = 'minecraft:overworld' } = {}) {
	return { observedAtEpochMs: at, world: { worldId, dimension }, worldTick: Math.floor((at - T0) / 50),
		player: { x: 10.5, y: 64, z: -20.5, health, armor: 0 },
		entities: hostiles.map((type, index) => ({ stableId: `mob-${index}`, type: `minecraft:${type}`, x: 20, y: 64, z: -20, distance: 9, hostile: true })),
		// The adapter's shape: food.items is the count of edible items carried.
		inventory: { items: [], food: { items: edible, nutrition: edible * 5 } } };
}
function experience(directory, env = {}) {
	return createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p', ...env }));
}
async function withDirectory(run) {
	const directory = await mkdtemp(join(tmpdir(), 'experience-runtime-'));
	try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
}

/** Game one: a skeleton shoots the agent dead while it flees across open ground. */
async function playSkeletonDeath(directory, { worldId = 'world-one', seed = 'seed-one' } = {}) {
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: experience(directory, { MINEAGEN_WORLD_SEED_HASH: seed }) });
	memory.observe(record, observation(worldId, T0, { hostiles: ['skeleton'], health: 14, edible: 2 }));
	await memory.recordDispatch(record, { actionId: 'flee-1', actionType: 'flee_from', goalRevision: 1, arguments: { targetId: '00000000-0000-4000-8000-000000000001', distance: 16, timeoutMs: 10000 } });
	memory.observe(record, observation(worldId, T0 + 3_000, { hostiles: ['skeleton'], health: 6, edible: 2 }));
	memory.observe(record, { death: { cause: 'agent_name was shot by Skeleton', dimensionId: 'minecraft:overworld', x: 11, y: 64, z: -21, diedAtEpochMs: T0 + 6_000 } });
	// A supervised retry replays the same death; it is reviewed once.
	memory.observe(record, { death: { cause: 'agent_name was shot by Skeleton', dimensionId: 'minecraft:overworld', x: 11, y: 64, z: -21, diedAtEpochMs: T0 + 6_000 } });
	await memory.flush();
	return memory;
}

test('death messages normalise to a cause without the player name', () => {
	assert.deepEqual(classifyDeath('Some_Player was shot by Skeleton'), { cause: 'skeleton', kind: 'shot' });
	assert.deepEqual(classifyDeath('Some_Player tried to swim in lava while trying to escape Zombified Piglin'), { cause: 'lava', kind: 'hazard', escaping: 'zombified_piglin' });
	assert.deepEqual(classifyDeath('Some_Player was slain by Wither Skeleton'), { cause: 'wither_skeleton', kind: 'melee' });
	assert.deepEqual(classifyDeath('Some_Player hit the ground too hard while trying to escape Skeleton'), { cause: 'fall', kind: 'hazard', escaping: 'skeleton' });
	assert.equal(JSON.stringify(classifyDeath('Some_Player drowned')).includes('Some_Player'), false);
});

test('every rule renders advice without digits beyond its evidence counts', () => {
	for (const [rule, spec] of Object.entries(LESSON_RULES)) {
		const text = lessonEntry({ rule, slots: { mob: 'skeleton', dimension: 'the_nether', hazard: 'lava' }, games: 2, count: 3, thisGame: 0 }).summary;
		assert.doesNotMatch(text, /\d/, rule);
		assert.ok(text.length <= 220, `${rule} is ${text.length} characters`);
		assert.equal(typeof spec.trigger, 'function');
	}
});

test('a death review in one game becomes a lesson the model sees in a later game when the situation returns', () => withDirectory(async (directory) => {
	await playSkeletonDeath(directory);
	const later = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: experience(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-two' }) });
	// No skeleton in view: the lesson stays out of the summary.
	later.observe(record, observation('world-two', T0 + 100_000, { hostiles: ['zombie'] }));
	assert.deepEqual((await later.taskContext(record)).lessons, []);
	// A skeleton in view: the carried lesson is in all three summary paths.
	later.observe(record, observation('world-two', T0 + 101_000, { hostiles: ['skeleton'] }));
	await later.flush();
	const peeked = later.peekTaskContext(record).lessons;
	const lessons = (await later.taskContext(record)).lessons;
	assert.deepEqual(peeked, lessons);
	assert.equal(lessons.length, 1);
	assert.match(lessons[0].summary, /shot you dead while you were fleeing/);
	assert.equal(lessons[0].src, 'from your past play: 1 time in 1 earlier game');
	assert.doesNotMatch(JSON.stringify(lessons), /world-one|agent_name|-21|seed-one/);
	assert.ok(Buffer.byteLength(JSON.stringify(lessons)) < 400);
	await later.flush();
}));

test('the lesson is shown on the respawn wake of the game that learned it, and never on its origin seed later', () => withDirectory(async (directory) => {
	const memory = await playSkeletonDeath(directory);
	memory.observe(record, observation('world-one', T0 + 20_000, { hostiles: [] }));
	const own = (await memory.taskContext(record)).lessons;
	assert.equal(own.length, 1);
	assert.equal(own[0].src, 'from your past play: 1 this game');
	const sameSeed = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: experience(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-one' }) });
	sameSeed.observe(record, observation('world-three', T0 + 200_000, { hostiles: ['skeleton'] }));
	assert.deepEqual((await sameSeed.taskContext(record)).lessons, []);
	await Promise.all([memory.flush(), sameSeed.flush()]);
}));

test('with experience off the summary is exactly what it was', async () => {
	const plain = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }) });
	const none = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: createExperience(experienceSettings({})) });
	for (const memory of [plain, none]) memory.observe(record, observation('world-one', T0, { hostiles: ['skeleton'] }));
	assert.deepEqual(await none.taskContext(record), await plain.taskContext(record));
});

test('at most three lessons are shown, and carried lessons are trimmed first', () => withDirectory(async (directory) => {
	const runtime = experience(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-one' });
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: runtime });
	memory.observe(record, observation('world-one', T0, { hostiles: ['skeleton', 'zombie', 'stray'], health: 6, edible: 0 }));
	await memory.recordDispatch(record, { actionId: 'flee-1', actionType: 'flee_from', goalRevision: 1, arguments: { targetId: '00000000-0000-4000-8000-000000000001', distance: 16, timeoutMs: 10000 } });
	for (const [index, cause] of ['was shot by Skeleton', 'was slain by Zombie', 'was shot by Stray'].entries()) {
		memory.observe(record, observation('world-one', T0 + 30_000 * index + 1_000, { hostiles: ['skeleton', 'zombie', 'stray'], health: 6, edible: 0 }));
		memory.observe(record, { death: { cause: `x ${cause}`, dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 30_000 * index + 16_000 } });
	}
	memory.observe(record, observation('world-one', T0 + 100_000, { hostiles: ['skeleton', 'zombie', 'stray'], health: 6, edible: 0 }));
	await memory.flush();
	const summary = await memory.taskContext(record);
	assert.equal(summary.lessons.length, MAX_SHOWN_LESSONS);
	assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 6000);
	await memory.flush();
}));

test('the death review reads only what the coordinator saw before the death', () => {
	const context = { cause: classifyDeath('x was shot by Skeleton'), dimension: 'overworld', running: [], at: 10_000,
		samples: [{ at: 0, health: 12, edible: 0, hostiles: { skeleton: 8 } }], results: [{ actionType: 'flee_from', state: 'CANCELLED', at: 5_000 }] };
	// No food alone does not make a lesson show; no food at low health does.
	// The flee ended 5 s before the death, so it was not fleeing when shot: the plain archer lesson, not the fled one.
	assert.deepEqual(deathLessons(context).map((lesson) => lesson.rule), ['ranged-death', 'died-without-food']);
});

test('a repeated failure becomes a lesson that is shown right after the same failure in a later game', () => withDirectory(async (directory) => {
	const dig = (memory, actionId, at) => memory.recordDispatch(record, { actionId, actionType: 'dig_to', goalRevision: 1, arguments: { x: 1, y: 60, z: 1, timeoutMs: 60000 } })
		.then(() => memory.recordResult(record, { actionId, goalRevision: 1, state: 'FAILED', reasonCode: 'WATER_AHEAD', observedAtEpochMs: at }));
	const first = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: experience(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-one' }) });
	first.observe(record, observation('world-one', T0));
	await dig(first, 'dig-1', T0 + 1_000);
	await dig(first, 'dig-2', T0 + 60_000);
	await first.flush();
	const later = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: experience(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-two' }) });
	later.observe(record, observation('world-two', T0 + 500_000));
	assert.deepEqual((await later.taskContext(record)).lessons, []);
	await dig(later, 'dig-3', T0 + 501_000);
	later.observe(record, observation('world-two', T0 + 502_000));
	const lessons = (await later.taskContext(record)).lessons;
	assert.equal(lessons.length, 1);
	assert.match(lessons[0].summary, /water ahead/);
	assert.equal(lessons[0].src, 'from your past play: 1 time in 1 earlier game');
	await later.flush();
}));

test('a death right after a low-health bailout teaches the bailout lesson, shown after the next bailout', () => {
	const context = { cause: classifyDeath('x was shot by Skeleton'), dimension: 'overworld', running: [], at: 20_000,
		samples: [{ at: 0, health: 18, edible: 4, hostiles: { skeleton: 8 } }], results: [{ actionType: 'fight_target', reasonCode: 'LOW_HEALTH_BAILOUT', state: 'FAILED', at: 12_000 }] };
	assert.ok(deathLessons(context).some((lesson) => lesson.id === 'bailout-then-death:mob=skeleton'));
});

test('a store that cannot load turns lessons off for the run without breaking memory', () => withDirectory(async (directory) => {
	// An injected failing load: an unreadable folder fails differently on each OS (ENOTDIR here, ENOENT on Windows).
	const settingsValue = experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' });
	const real = new ExperienceStore(settingsValue), events = [];
	const store = { load: async () => { throw Object.assign(new Error('unreadable'), { code: 'EACCES' }); }, state: () => real.state(), record: (...args) => real.record(...args),
		markShown: (...args) => real.markShown(...args), candidates: (...args) => real.candidates(...args), flush: () => real.flush(), noteDeathReviewed: (...args) => real.noteDeathReviewed(...args) };
	const runtime = createExperience(settingsValue, { store, trace: (event, fields) => events.push({ event, ...fields }) });
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: runtime });
	memory.observe(record, observation('world-one', T0, { hostiles: ['skeleton'] }));
	memory.observe(record, { death: { cause: 'x was shot by Skeleton', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 1_000 } });
	assert.deepEqual((await memory.taskContext(record)).lessons, []);
	await memory.flush();
	assert.ok(events.some((event) => event.event === 'experience_error' && event.stage === 'load'));
	assert.equal(events.some((event) => event.event === 'experience_lesson_recorded'), false);
}));

test('live observations that still name the last death keep feeding the history', () => withDirectory(async (directory) => {
	const runtime = experience(directory);
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: runtime });
	const death = { cause: 'x was slain by Zombie', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 1_000 };
	memory.observe(record, observation('world-one', T0));
	memory.observe(record, { death });
	// After respawn the body is alive again but the observation still carries the death record.
	for (let index = 0; index < 3; index++) memory.observe(record, { ...observation('world-one', T0 + 40_000 + index * 1_000, { hostiles: ['skeleton'], health: 6, edible: 0 }), death });
	await memory.flush();
	await memory.recordDispatch(record, { actionId: 'flee-9', actionType: 'flee_from', goalRevision: 1, arguments: { targetId: '00000000-0000-4000-8000-000000000001', distance: 16, timeoutMs: 10000 } });
	memory.observe(record, { death: { cause: 'x was shot by Skeleton', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 64_000 } });
	await memory.flush();
	memory.observe(record, observation('world-one', T0 + 90_000, { hostiles: ['skeleton'], health: 6, edible: 0 }));
	const lessons = (await memory.taskContext(record)).lessons.map((lesson) => lesson.summary);
	assert.ok(lessons.some((text) => /shot you dead while you were fleeing/.test(text)), JSON.stringify(lessons));
	assert.ok(lessons.some((text) => /no food/.test(text)), JSON.stringify(lessons));
	await memory.flush();
}));

test('a long action counts as running for its own lease, and a death-caused result after the review stays with that life', () => withDirectory(async (directory) => {
	const events = [];
	const runtime = createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' }), { trace: (event, fields) => events.push({ event, ...fields }) });
	runtime.observe('agent-a', 'world-one', observation('world-one', T0, { dimension: 'minecraft:the_nether' }), T0);
	// travel_to with no timeout runs up to 600 s; a lava death 150 s in still finds it running.
	runtime.noteDispatch('agent-a', { actionId: 'travel-1', actionType: 'travel_to', arguments: { x: 100, y: 64, z: 100 } });
	await runtime.observe('agent-a', 'world-one', { death: { cause: 'x tried to swim in lava', dimensionId: 'minecraft:the_nether', diedAtEpochMs: T0 + 150_000 } }, T0 + 150_000);
	// A flee the first death ended reports AGENT_DEAD after that review; it must not make the next death "while fleeing".
	runtime.observe('agent-a', 'world-one', observation('world-one', T0 + 151_000, { hostiles: ['skeleton'] }), T0 + 151_000);
	await runtime.noteResult('agent-a', { actionId: 'flee-old', actionType: 'flee_from', state: 'FAILED', reasonCode: 'AGENT_DEAD', executionStarted: true }, T0 + 150_500);
	await runtime.observe('agent-a', 'world-one', { death: { cause: 'x was shot by Skeleton', dimensionId: 'minecraft:the_nether', diedAtEpochMs: T0 + 160_000 } }, T0 + 160_000);
	await runtime.flush();
	const reviewed = events.filter((event) => event.event === 'experience_death_reviewed');
	assert.ok(reviewed[0].lessons.includes('lava-while-moving:dimension=the_nether'), JSON.stringify(reviewed[0]));
	assert.deepEqual(reviewed[1].lessons, ['ranged-death:mob=skeleton']);
	// An action with no result at all stops counting once its lease would have ended.
	runtime.noteDispatch('agent-a', { actionId: 'flee-2', actionType: 'flee_from', arguments: { timeoutMs: 10_000 } });
	await runtime.observe('agent-a', 'world-one', { death: { cause: 'x was shot by Skeleton', dimensionId: 'minecraft:the_nether', diedAtEpochMs: T0 + 360_000 } }, T0 + 360_000);
	assert.deepEqual(events.filter((event) => event.event === 'experience_death_reviewed')[2].running, []);
}));

test('a coordinator restart inside a game does not review its last death twice', () => withDirectory(async (directory) => {
	const counts = [];
	for (let run = 0; run < 2; run++) {
		const events = [];
		const runtime = createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' }), { trace: (event, fields) => events.push({ event, ...fields }) });
		runtime.observe('agent-a', 'world-one', observation('world-one', T0, { health: 6, edible: 0 }), T0);
		await runtime.observe('agent-a', 'world-one', { death: { cause: 'x was slain by Zombie', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 15_000 } }, T0 + 15_000);
		await runtime.flush();
		counts.push(events.filter((event) => event.event === 'experience_lesson_recorded').map((event) => event.countThisGame));
	}
	assert.ok(counts[0].length > 0);
	assert.deepEqual(counts[1], []);
}));

test('a replayed terminal receipt feeds the failure review once', () => withDirectory(async (directory) => {
	const events = [];
	const runtime = createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' }), { trace: (event, fields) => events.push({ event, ...fields }) });
	runtime.observe('agent-a', 'world-one', observation('world-one', T0), T0);
	runtime.noteDispatch('agent-a', { actionId: 'dig-1', actionType: 'dig_to' });
	for (let replay = 0; replay < 3; replay++) await runtime.noteResult('agent-a', { actionId: 'dig-1', actionType: 'dig_to', state: 'FAILED', reasonCode: 'WATER_AHEAD' }, T0 + 1_000);
	await runtime.flush();
	assert.equal(events.some((event) => event.event === 'experience_lesson_recorded'), false);
}));

test('a death reviewed while the store loads is recorded against its own game after a world change', () => withDirectory(async (directory) => {
	const settingsValue = experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' });
	const real = new ExperienceStore(settingsValue), gate = Promise.withResolvers();
	const store = { load: async () => { await gate.promise; return real.load(); }, state: () => real.state(), record: (...args) => real.record(...args),
		markShown: (...args) => real.markShown(...args), candidates: (...args) => real.candidates(...args), flush: () => real.flush(), noteDeathReviewed: (...args) => real.noteDeathReviewed(...args) };
	const runtime = createExperience(settingsValue, { store });
	runtime.observe('agent-a', 'world-one', observation('world-one', T0, { health: 6, edible: 0 }), T0);
	const reviewed = runtime.observe('agent-a', 'world-one', { death: { cause: 'x was slain by Zombie', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 15_000 } }, T0 + 15_000);
	runtime.observe('agent-a', 'world-two', observation('world-two', T0 + 20_000), T0 + 20_000);
	gate.resolve();
	await reviewed;
	await runtime.flush();
	assert.ok(real.candidates(experienceHash('world:world-one')).some((entry) => entry.thisGame > 0));
	assert.equal(real.candidates(experienceHash('world:world-two')).some((entry) => entry.thisGame > 0), false);
}));

test('observations every 100 ms still keep the ten-second health lookback', () => withDirectory(async (directory) => {
	const events = [];
	const runtime = createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' }), { trace: (event, fields) => events.push({ event, ...fields }) });
	for (let at = T0; at <= T0 + 20_000; at += 100) runtime.observe('agent-a', 'world-one', observation('world-one', at, { hostiles: ['zombie'], health: 6, edible: 0 }), at);
	await runtime.observe('agent-a', 'world-one', { death: { cause: 'x was slain by Zombie', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 20_100 } }, T0 + 20_100);
	await runtime.flush();
	const recorded = events.filter((event) => event.event === 'experience_lesson_recorded').map((event) => event.rule);
	assert.ok(recorded.includes('melee-at-low-health') && recorded.includes('died-without-food'), JSON.stringify(recorded));
}));

test('history gathered while a death review waits for the store is kept', () => withDirectory(async (directory) => {
	const settingsValue = experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' });
	const real = new ExperienceStore(settingsValue), gate = Promise.withResolvers(), events = [];
	const store = { load: async () => { await gate.promise; return real.load(); }, state: () => real.state(), record: (...args) => real.record(...args),
		markShown: (...args) => real.markShown(...args), candidates: (...args) => real.candidates(...args), flush: () => real.flush(), noteDeathReviewed: (...args) => real.noteDeathReviewed(...args) };
	const runtime = createExperience(settingsValue, { store, trace: (event, fields) => events.push({ event, ...fields }) });
	runtime.observe('agent-a', 'world-one', observation('world-one', T0, { hostiles: ['skeleton'] }), T0);
	const first = runtime.observe('agent-a', 'world-one', { death: { cause: 'x was shot by Skeleton', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 1_000 } }, T0 + 1_000);
	runtime.observe('agent-a', 'world-two', observation('world-two', T0 + 5_000, { hostiles: ['zombie'], health: 6, edible: 0 }), T0 + 5_000);
	gate.resolve();
	await first;
	await runtime.observe('agent-a', 'world-two', { death: { cause: 'x was slain by Zombie', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 20_000 } }, T0 + 20_000);
	await runtime.flush();
	assert.ok(events.some((event) => event.event === 'experience_lesson_recorded' && event.rule === 'melee-at-low-health'));
}));

test('a late result from a world the agent has left is not reviewed as part of the new game', () => withDirectory(async (directory) => {
	const events = [];
	const runtime = createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' }), { trace: (event, fields) => events.push({ event, ...fields }) });
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: runtime });
	memory.observe(record, observation('world-one', T0));
	await memory.recordDispatch(record, { actionId: 'dig-1', actionType: 'dig_to', goalRevision: 1, arguments: { x: 1, y: 60, z: 1, timeoutMs: 60000 } });
	memory.observe(record, observation('world-two', T0 + 5_000));
	await memory.recordResult(record, { actionId: 'dig-1', goalRevision: 1, state: 'FAILED', reasonCode: 'TOOL_WORN', observedAtEpochMs: T0 + 6_000 });
	await memory.flush();
	assert.equal(events.some((event) => event.event === 'experience_lesson_recorded'), false);
}));

test('a replayed death keeps the recording on its own clock', () => withDirectory(async (directory) => {
	// A recording from the past: wall time is later than every recorded time.
	const past = 1_600_000_000_000, events = [];
	const runtime = createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' }), { trace: (event, fields) => events.push({ event, ...fields }) });
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: runtime });
	memory.observe(record, observation('world-one', past, { hostiles: ['zombie'] }));
	memory.observe(record, { death: { cause: 'x was slain by Zombie', dimensionId: 'minecraft:overworld', diedAtEpochMs: past + 5_000 } });
	memory.observe(record, observation('world-one', past + 10_000, { hostiles: ['skeleton'] }));
	await memory.recordDispatch(record, { actionId: 'flee-2', actionType: 'flee_from', goalRevision: 1, arguments: { targetId: '00000000-0000-4000-8000-000000000001', distance: 16, timeoutMs: 10000 } });
	memory.observe(record, { death: { cause: 'x was shot by Skeleton', dimensionId: 'minecraft:overworld', diedAtEpochMs: past + 15_000 } });
	await memory.flush();
	assert.ok(events.some((event) => event.event === 'experience_lesson_recorded' && event.rule === 'ranged-fled-in-open'), JSON.stringify(events.map((event) => event.rule)));
}));

test('a player or name-tagged killer is never stored or named, and vanilla phrasings classify', () => {
	assert.deepEqual(classifyDeath('Agent was slain by Steve'), { cause: 'unknown', kind: 'unknown' });
	assert.deepEqual(classifyDeath('Agent was shot by Bob using Bow'), { cause: 'unknown', kind: 'unknown' });
	assert.deepEqual(classifyDeath('Agent tried to swim in lava to escape Zombified Piglin'), { cause: 'lava', kind: 'hazard', escaping: 'zombified_piglin' });
	assert.deepEqual(classifyDeath('Agent was doomed to fall by Skeleton'), { cause: 'fall', kind: 'hazard', escaping: 'skeleton' });
	assert.deepEqual(classifyDeath('Agent was killed by Witch using magic'), { cause: 'magic', kind: 'hazard' });
	const context = { cause: classifyDeath('Agent was slain by Steve'), dimension: 'overworld', running: [], at: 20_000,
		samples: [{ at: 0, health: 4, edible: 0, hostiles: {} }], results: [{ actionType: 'fight_target', reasonCode: 'LOW_HEALTH_BAILOUT', state: 'FAILED', at: 15_000 }] };
	assert.doesNotMatch(JSON.stringify(deathLessons(context)), /steve/);
	assert.match(lessonEntry({ rule: 'lava-while-moving', slots: { dimension: 'the_nether' }, games: 1, count: 1, thisGame: 0 }).summary, /in the Nether\./);
});

test('under byte pressure the summary keeps the best lesson, and only named lessons count as shown', () => withDirectory(async (directory) => {
	// The summary trim drops lessons from the front; lessonsFor passes them worst first.
	const store = new TaskMemoryStore({ directory: null });
	const scope = { agentId: 'agent-a', worldId: 'world-one', dimension: 'minecraft:overworld', goalRevision: 1 };
	await store.observe(scope, observation('world-one', T0));
	const big = (name) => ({ kind: 'lesson', summary: `${name} ${'x'.repeat(2_500)}`, src: 'from your past play: 1 this game' });
	const trimmed = await store.summary(scope, { extraLessons: [big('worst'), big('middle'), big('best')] });
	assert.ok(trimmed.lessons.length < 3);
	assert.match(trimmed.lessons.at(-1).summary, /^best /);
	assert.equal(trimmed.lessons.some((lesson) => /^worst /.test(lesson.summary)), false);

	const events = [];
	const runtime = createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' }), { trace: (event, fields) => events.push({ event, ...fields }) });
	runtime.observe('agent-a', 'world-one', observation('world-one', T0, { hostiles: ['skeleton', 'zombie'], health: 6, edible: 0 }), T0);
	runtime.noteDispatch('agent-a', { actionId: 'flee-1', actionType: 'flee_from' });
	await runtime.observe('agent-a', 'world-one', { death: { cause: 'x was shot by Skeleton', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 15_000 } }, T0 + 15_000);
	runtime.observe('agent-a', 'world-one', observation('world-one', T0 + 20_000, { hostiles: ['skeleton'], health: 6, edible: 0 }), T0 + 20_000);
	const { ids, entries } = await runtime.lessonsFor('agent-a');
	assert.ok(ids.length >= 2 && entries.length === ids.length);
	assert.equal(events.some((event) => event.event === 'experience_lessons_shown'), false, 'reading lessons counts nothing');
	runtime.markShown('agent-a', ids.slice(0, 1));
	await runtime.flush();
	assert.deepEqual(events.filter((event) => event.event === 'experience_lessons_shown').flatMap((event) => event.lessonIds), [ids[0]]);
}));

test('the receipt refresh after a death builds the same summary with experience off, and only adds lessons with it on', () => withDirectory(async (directory) => {
	const build = async (memory) => {
		const death = { cause: 'x was slain by Zombie', dimensionId: 'minecraft:overworld', x: 10, y: 64, z: -20, diedAtEpochMs: T0 + 1_000 };
		memory.observe(record, observation('world-one', T0));
		memory.observe(record, { death }, { recoveryDeath: death });
		memory.observe(record, observation('world-one', T0 + 5_000), { recoveryDeath: death });
		await memory.recordDispatch(record, { actionId: 'place-1', actionType: 'place_block', goalRevision: 1, arguments: { x: 11, y: 64, z: -20, face: 'up', itemId: 'minecraft:crafting_table' } });
		await memory.recordResult(record, { actionId: 'place-1', goalRevision: 1, state: 'SUCCEEDED', reasonCode: 'BLOCK_PLACED', observedAtEpochMs: T0 + 6_000 });
		await memory.flush();
		return memory.peekTaskContext(record);
	};
	const plain = await build(new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }) }));
	const off = await build(new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: createExperience(experienceSettings({})) }));
	const on = await build(new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: experience(directory) }));
	assert.equal(plain.assets.length, 1, 'the receipt refresh ran');
	assert.deepEqual(off, plain);
	const withoutLessons = ({ lessons, ...rest }) => rest;
	assert.deepEqual(withoutLessons(on), withoutLessons(plain));
}));

test('long-run reports keep what the coordinator actually loaded', async () => {
	const { longTraceRow, observedExperience } = await import('../src/benchmark/long-run-artifacts.mjs');
	const rows = [{ event: 'experience_state', mode: 'lessons', frozen: true, games: 3, lessons: 5, snapshotSha256: 'a'.repeat(64), seedHashKnown: true, skippedFiles: 0 },
		{ event: 'experience_error', stage: 'flush', code: 'EACCES' }, { event: 'native_model_call' }, { event: 'something_else' }].map(longTraceRow).filter(Boolean);
	assert.equal(rows.length, 3);
	assert.deepEqual(observedExperience(rows), { loaded: true, mode: 'lessons', frozen: true, games: 3, lessons: 5, snapshotSha256: 'a'.repeat(64), seedHashKnown: true, skippedFiles: 0, errors: [{ stage: 'flush', code: 'EACCES' }] });
	assert.equal(observedExperience([{ event: 'native_model_call' }]), null);
});

test('results the review hears before the death count, including a flee the death ended', () => withDirectory(async (directory) => {
	const events = [];
	const runtime = createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' }), { trace: (event, fields) => events.push({ event, ...fields }) });
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: runtime });
	memory.observe(record, observation('world-one', T0, { hostiles: ['skeleton'], health: 12 }));
	// A live bailout result, its receipt not yet persisted, then a flee the death ends (AGENT_DEAD a moment after it).
	memory.noteLiveResult(record.agentId, { actionId: 'fight-1', actionType: 'fight_target', state: 'FAILED', reasonCode: 'LOW_HEALTH_BAILOUT', executionStarted: true, observedAtEpochMs: T0 + 5_000 });
	memory.noteDispatch(record.agentId, { actionId: 'flee-1', actionType: 'flee_from' });
	memory.noteLiveResult(record.agentId, { actionId: 'flee-1', actionType: 'flee_from', state: 'FAILED', reasonCode: 'AGENT_DEAD', executionStarted: true, observedAtEpochMs: T0 + 10_500 });
	memory.observe(record, { death: { cause: 'x was shot by Skeleton', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 10_000 } });
	// The persisted copy of the bailout arrives later and is not counted again.
	await memory.flush();
	const reviewed = events.find((event) => event.event === 'experience_death_reviewed');
	assert.ok(reviewed.lessons.includes('bailout-then-death:mob=skeleton'), JSON.stringify(reviewed));
	assert.ok(reviewed.lessons.includes('ranged-fled-in-open:mob=skeleton'), JSON.stringify(reviewed));
	// A flee that never started is no evidence of fleeing.
	const context = { cause: classifyDeath('x was shot by Skeleton'), dimension: 'overworld', running: [], at: 20_000, samples: [],
		results: [{ actionType: 'flee_from', state: 'FAILED', reasonCode: 'NO_STANDABLE_PATH', executionStarted: false, at: 15_000 }] };
	assert.equal(deathLessons(context).some((lesson) => lesson.rule === 'ranged-fled-in-open'), false);
}));

test('a failed store write is reported, so a lost lesson does not look learned', () => withDirectory(async (directory) => {
	const events = [];
	const settingsValue = experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' });
	const runtime = createExperience(settingsValue, { trace: (event, fields) => events.push({ event, ...fields }) });
	await runtime.ready;
	// The profile folder's path is taken by a file, so the write cannot create it.
	await (await import('node:fs/promises')).writeFile(join(directory, `profile-${experienceHash('profile:p')}`), 'x');
	runtime.observe('agent-a', 'world-one', observation('world-one', T0, { health: 6, edible: 0 }), T0);
	await runtime.observe('agent-a', 'world-one', { death: { cause: 'x was slain by Zombie', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 15_000 } }, T0 + 15_000);
	await runtime.flush();
	assert.ok(events.some((event) => event.event === 'experience_lesson_recorded'));
	assert.ok(events.some((event) => event.event === 'experience_error' && event.stage === 'write'), JSON.stringify(events.map((event) => event.event)));
}));

test('lava in plain view counts as lava near', async () => {
	const { sampleOf } = await import('../src/experience-runtime.mjs');
	const base = observation('world-one', T0);
	assert.equal(sampleOf({ ...base, blocks: [{ blockId: 'minecraft:lava', x: 13, y: 64, z: -20 }] }, T0).lavaNear, true);
	assert.equal(sampleOf({ ...base, blocks: [{ blockId: 'minecraft:lava', x: 30, y: 64, z: -20 }] }, T0).lavaNear, undefined);
});

test('a task memory write refreshes the cache without counting lessons as shown', () => withDirectory(async (directory) => {
	const events = [];
	const runtime = createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p' }), { trace: (event, fields) => events.push({ event, ...fields }) });
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: runtime });
	memory.observe(record, observation('world-one', T0, { hostiles: ['zombie'], health: 6, edible: 0 }));
	memory.observe(record, { death: { cause: 'x was slain by Zombie', dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 15_000 } });
	memory.observe(record, observation('world-one', T0 + 20_000, { hostiles: ['zombie'], health: 6, edible: 0 }));
	await memory.flush();
	await memory.execute(record, { operation: 'task', arguments: { operation: 'remember', entry: { kind: 'place', key: 'camp', label: 'Camp', summary: 'Shelter by the hill.', position: { x: 1, y: 64, z: 2 } } } });
	assert.equal(events.some((event) => event.event === 'experience_lessons_shown'), false);
	const summary = await memory.taskContext(record);
	assert.ok(summary.lessons.length > 0);
	// Building a turn summary counts nothing; the built input that carries the lesson does.
	assert.equal(events.some((event) => event.event === 'experience_lessons_shown'), false);
	memory.confirmShown(record.agentId, 'unrelated input');
	assert.equal(events.some((event) => event.event === 'experience_lessons_shown'), false);
	await memory.taskContext(record);
	memory.confirmShown(record.agentId, JSON.stringify({ taskMemory: summary }));
	assert.ok(events.some((event) => event.event === 'experience_lessons_shown'));
	await memory.flush();
}));
