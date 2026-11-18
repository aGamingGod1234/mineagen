import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ExperienceStore, experienceHash, experienceSettings, normalizeSeedHash } from '../src/experience-store.mjs';

const GAME_A = experienceHash('world:a'), GAME_B = experienceHash('world:b'), GAME_C = experienceHash('world:c');
const lesson = { id: 'death:shot:skeleton:fleeing', rule: 'ranged-fled-in-open', slots: { mob: 'skeleton' } };

async function withDirectory(run) {
	const directory = await mkdtemp(join(tmpdir(), 'experience-store-'));
	try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 20 }); }
}
function settings(directory, overrides = {}) {
	return experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: directory, MINEAGEN_EXPERIENCE_PROFILE: 'profile-one', ...overrides });
}

test('experience is off by default and on only with a directory', () => {
	assert.equal(experienceSettings({}), null);
	assert.equal(experienceSettings({ MINEAGEN_EXPERIENCE: 'off' }), null);
	assert.throws(() => experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons' }), /MINEAGEN_EXPERIENCE_DIR/);
	assert.throws(() => experienceSettings({ MINEAGEN_EXPERIENCE: 'practice', MINEAGEN_EXPERIENCE_DIR: '/x' }), /must be one of/);
	const on = experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: '/x', MINEAGEN_WORLD_SEED_HASH: '12345', MINEAGEN_EXPERIENCE_EXCLUDE_SEEDS: '12345,abcdef0123456789' });
	assert.equal(on.frozen, false);
	// A raw seed is hashed before it is kept.
	assert.equal(on.seedHash, normalizeSeedHash('12345'));
	assert.notEqual(on.seedHash, '12345');
	assert.deepEqual(on.excludedSeedHashes, [normalizeSeedHash('12345'), normalizeSeedHash('abcdef0123456789')]);
});

test('a lesson recorded in one game is a candidate in a later game of the same profile, with its evidence', () => withDirectory(async (directory) => {
	const first = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-a' }));
	await first.load();
	first.record(GAME_A, { ...lesson, atEpochMs: 1 });
	first.record(GAME_A, { ...lesson, atEpochMs: 2 });
	await first.flush();
	const second = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-b' }));
	await second.load();
	assert.deepEqual(second.candidates(GAME_B), [{ id: lesson.id, rule: lesson.rule, slots: lesson.slots, games: 1, count: 2, shownGames: 0, repeatsAfterShown: 0, thisGame: 0 }]);
	assert.equal(second.state().games, 1);
	assert.match(second.state().snapshotSha256, /^[0-9a-f]{64}$/);
	// Another profile shares nothing.
	const other = new ExperienceStore(settings(directory, { MINEAGEN_EXPERIENCE_PROFILE: 'profile-two' }));
	await other.load();
	assert.deepEqual(other.candidates(GAME_B), []);
}));

test('nothing stored names a world, profile, seed or coordinate', () => withDirectory(async (directory) => {
	const store = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: '-4172144997902289642' }));
	await store.load();
	store.record(GAME_A, { ...lesson, atEpochMs: 5 });
	await store.flush();
	const [folder] = await readdir(directory);
	assert.doesNotMatch(folder, /profile-one/);
	const [file] = await readdir(join(directory, folder));
	const text = await readFile(join(directory, folder, file), 'utf8');
	for (const secret of ['world:a', 'profile-one', '-4172144997902289642', '4172144997902289642', '41721449979']) assert.equal(text.includes(secret), false, secret);
	assert.throws(() => store.record(GAME_A, { ...lesson, slots: { where: 'base at 120, 64, -40' }, atEpochMs: 6 }), /vocabulary/);
}));

test('a lesson never loads on its origin seed or an excluded seed', () => withDirectory(async (directory) => {
	const origin = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-a' }));
	await origin.load();
	origin.record(GAME_A, { ...lesson, atEpochMs: 1 });
	await origin.flush();
	const sameSeed = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-a' }));
	await sameSeed.load();
	assert.deepEqual(sameSeed.candidates(GAME_B), []);
	const excluded = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-b', MINEAGEN_EXPERIENCE_EXCLUDE_SEEDS: 'seed-a' }));
	await excluded.load();
	assert.deepEqual(excluded.candidates(GAME_B), []);
	const clean = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-b' }));
	await clean.load();
	assert.equal(clean.candidates(GAME_B).length, 1);
}));

test('a frozen store reads but never writes, and candidates are side-effect free', () => withDirectory(async (directory) => {
	const writer = new ExperienceStore(settings(directory));
	await writer.load();
	writer.record(GAME_A, { ...lesson, atEpochMs: 1 });
	await writer.flush();
	const frozen = new ExperienceStore(settings(directory, { MINEAGEN_EXPERIENCE_FROZEN: '1' }));
	await frozen.load();
	const before = frozen.state().snapshotSha256;
	frozen.record(GAME_B, { ...lesson, atEpochMs: 2 });
	frozen.markShown(GAME_B, [lesson.id], 3);
	await frozen.flush();
	const [folder] = await readdir(directory);
	assert.equal((await readdir(join(directory, folder))).length, 1);
	const reread = new ExperienceStore(settings(directory));
	await reread.load();
	assert.equal(reread.state().snapshotSha256, before);
	assert.deepEqual(reread.candidates(GAME_C), reread.candidates(GAME_C));
}));

test('a repeat after the lesson was shown counts against it, and a restart continues the same game', () => withDirectory(async (directory) => {
	const store = new ExperienceStore(settings(directory));
	await store.load();
	store.record(GAME_A, { ...lesson, atEpochMs: 1 });
	store.markShown(GAME_A, [lesson.id], 2);
	store.record(GAME_A, { ...lesson, atEpochMs: 3 });
	await store.flush();
	const restarted = new ExperienceStore(settings(directory));
	await restarted.load();
	// The same game after a coordinator restart: its own lessons, not carried ones.
	assert.deepEqual(restarted.candidates(GAME_A).map(({ games, thisGame }) => ({ games, thisGame })), [{ games: 0, thisGame: 2 }]);
	const later = new ExperienceStore(settings(directory));
	await later.load();
	assert.deepEqual(later.candidates(GAME_B).map(({ shownGames, repeatsAfterShown }) => ({ shownGames, repeatsAfterShown })), [{ shownGames: 1, repeatsAfterShown: 1 }]);
}));

test('a positive decimal seed is hashed too, and hashing twice changes nothing', () => {
	const raw = '4172144997902289642';
	const hashed = normalizeSeedHash(raw);
	assert.match(hashed, /^s1-[0-9a-f]{16}$/);
	assert.equal(hashed.includes(raw.slice(0, 8)), false);
	assert.equal(normalizeSeedHash(hashed), hashed);
	assert.equal(experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: '/x', MINEAGEN_WORLD_SEED_HASH: hashed }).seedHash, hashed);
});

test('a lesson blocked from carrying by its seed still shows on this game\'s own evidence', () => withDirectory(async (directory) => {
	const earlier = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-a' }));
	await earlier.load();
	earlier.record(GAME_A, { ...lesson, atEpochMs: 1 });
	await earlier.flush();
	const replayed = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-a' }));
	await replayed.load();
	assert.deepEqual(replayed.candidates(GAME_B), []);
	replayed.record(GAME_B, { ...lesson, atEpochMs: 2 });
	assert.deepEqual(replayed.candidates(GAME_B).map(({ id, games, thisGame }) => ({ id, games, thisGame })), [{ id: lesson.id, games: 0, thisGame: 1 }]);
	await replayed.flush();
}));

test('a game played earlier by the same process carries into the next world', () => withDirectory(async (directory) => {
	// One process has one seed hash, which blocks carry between its own games; without one, worlds carry.
	const store = new ExperienceStore(settings(directory));
	await store.load();
	store.record(GAME_A, { ...lesson, atEpochMs: 1 });
	assert.deepEqual(store.candidates(GAME_B).map(({ id, games, thisGame }) => ({ id, games, thisGame })), [{ id: lesson.id, games: 1, thisGame: 0 }]);
	await store.flush();
}));
