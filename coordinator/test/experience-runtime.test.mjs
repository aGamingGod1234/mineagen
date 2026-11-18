import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { RuntimeMemoryContext } from '../src/runtime-memory-context.mjs';
import { TaskMemoryStore } from '../src/task-memory-store.mjs';
import { experienceSettings } from '../src/experience-store.mjs';
import { classifyDeath, createExperience, MAX_SHOWN_LESSONS } from '../src/experience-runtime.mjs';
import { deathLessons, LESSON_RULES, lessonEntry } from '../src/experience-lessons.mjs';

const record = { agentId: 'agent-a', goalRevision: 1, provider: 'codex', model: 'gpt-6.2-sol', reasoningEffort: 'low', serviceTier: 'default' };
const T0 = 1_800_000_000_000;

function observation(worldId, at, { hostiles = [], health = 20, edible = 3, dimension = 'minecraft:overworld' } = {}) {
	return { observedAtEpochMs: at, world: { worldId, dimension }, worldTick: Math.floor((at - T0) / 50),
		player: { x: 10.5, y: 64, z: -20.5, health, armor: 0 },
		entities: hostiles.map((type, index) => ({ stableId: `mob-${index}`, type: `minecraft:${type}`, x: 20, y: 64, z: -20, distance: 9, hostile: true })),
		inventory: { items: [], food: { items: edible > 0 ? [{ itemId: 'minecraft:bread', count: edible, nutrition: 5 }] : [], nutrition: edible * 5 } } };
}
function experience(directory, env = {}) {
	return createExperience(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'p', ...env }));
}
async function withDirectory(run) {
	const directory = await mkdtemp(join(tmpdir(), 'experience-runtime-'));
	try { await run(directory); } finally { await rm(directory, { recursive: true, force: true }); }
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
	assert.match(lessons[0].summary, /Running from a skeleton across open ground/);
	assert.equal(lessons[0].src, 'review: 1 time in 1 earlier game');
	assert.doesNotMatch(JSON.stringify(lessons), /world-one|agent_name|-21|seed-one/);
	assert.ok(Buffer.byteLength(JSON.stringify(lessons)) < 400);
}));

test('the lesson is shown on the respawn wake of the game that learned it, and never on its origin seed later', () => withDirectory(async (directory) => {
	const memory = await playSkeletonDeath(directory);
	memory.observe(record, observation('world-one', T0 + 20_000, { hostiles: [] }));
	const own = (await memory.taskContext(record)).lessons;
	assert.equal(own.length, 1);
	assert.equal(own[0].src, 'review: 1 this game');
	const sameSeed = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: experience(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-one' }) });
	sameSeed.observe(record, observation('world-three', T0 + 200_000, { hostiles: ['skeleton'] }));
	assert.deepEqual((await sameSeed.taskContext(record)).lessons, []);
}));

test('with experience off the summary is exactly what it was', async () => {
	const plain = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }) });
	const none = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: createExperience(experienceSettings({})) });
	for (const memory of [plain, none]) memory.observe(record, observation('world-one', T0, { hostiles: ['skeleton'] }));
	assert.deepEqual(await none.taskContext(record), await plain.taskContext(record));
});

test('at most three lessons are shown, and they are trimmed before this world\'s own notes', () => withDirectory(async (directory) => {
	const runtime = experience(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-one' });
	const memory = new RuntimeMemoryContext({ taskMemory: new TaskMemoryStore({ directory: null }), experience: runtime });
	memory.observe(record, observation('world-one', T0, { hostiles: ['skeleton', 'zombie', 'stray'], health: 6, edible: 0 }));
	await memory.recordDispatch(record, { actionId: 'flee-1', actionType: 'flee_from', goalRevision: 1, arguments: { targetId: '00000000-0000-4000-8000-000000000001', distance: 16, timeoutMs: 10000 } });
	for (const [index, cause] of ['was shot by Skeleton', 'was slain by Zombie', 'was shot by Stray'].entries()) {
		memory.observe(record, observation('world-one', T0 + 30_000 * index + 1_000, { hostiles: ['skeleton', 'zombie', 'stray'], health: 6, edible: 0 }));
		memory.observe(record, { death: { cause: `x ${cause}`, dimensionId: 'minecraft:overworld', diedAtEpochMs: T0 + 30_000 * index + 2_000 } });
	}
	memory.observe(record, observation('world-one', T0 + 100_000, { hostiles: ['skeleton', 'zombie', 'stray'], health: 6, edible: 0 }));
	await memory.flush();
	const summary = await memory.taskContext(record);
	assert.equal(summary.lessons.length, MAX_SHOWN_LESSONS);
	assert.ok(Buffer.byteLength(JSON.stringify(summary)) <= 6000);
}));

test('the death review reads only what the coordinator saw before the death', () => {
	const context = { cause: classifyDeath('x was shot by Skeleton'), dimension: 'overworld', running: [], at: 10_000,
		samples: [{ at: 0, health: 12, edible: 0, hostiles: { skeleton: 8 } }], results: [{ actionType: 'flee_from', state: 'CANCELLED', at: 5_000 }] };
	assert.deepEqual(deathLessons(context).map((lesson) => lesson.rule), ['ranged-fled-in-open', 'died-without-food']);
});
