import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { CHECKOUT_ROOT, ExperienceStore, experienceHash, experienceSettings, isInsideDirectory, normalizeSeedHash } from '../src/experience-store.mjs';

const GAME_A = experienceHash('world:a'), GAME_B = experienceHash('world:b'), GAME_C = experienceHash('world:c');
const lesson = { id: 'ranged-fled-in-open:mob=skeleton', rule: 'ranged-fled-in-open', slots: { mob: 'skeleton' } };

async function withDirectory(run) {
	const directory = await mkdtemp(join(tmpdir(), 'experience-store-'));
	try { await run(directory); } finally { await rm(directory, { recursive: true, force: true, maxRetries: 10, retryDelay: 50 }); }
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
	const store = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-a' }));
	await store.load();
	store.record(GAME_A, { ...lesson, atEpochMs: 1 });
	store.markShown(GAME_A, [lesson.id], 2);
	store.record(GAME_A, { ...lesson, atEpochMs: 3 });
	await store.flush();
	const restarted = new ExperienceStore(settings(directory));
	await restarted.load();
	// The same game after a coordinator restart: its own lessons, not carried ones.
	assert.deepEqual(restarted.candidates(GAME_A).map(({ games, thisGame }) => ({ games, thisGame })), [{ games: 0, thisGame: 2 }]);
	const later = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-b' }));
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

test('games without a known seed neither receive nor lend carried lessons', () => withDirectory(async (directory) => {
	// One process has one seed hash, so its own earlier games share it and stay blocked; with no seed, nothing carries.
	const store = new ExperienceStore(settings(directory));
	await store.load();
	store.record(GAME_A, { ...lesson, atEpochMs: 1 });
	assert.deepEqual(store.candidates(GAME_B), []);
	await store.flush();
	const known = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-b' }));
	await known.load();
	// The earlier game's seed is unknown, so it could be this seed: it does not carry.
	assert.deepEqual(known.candidates(GAME_C), []);
	const sameProcess = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-b' }));
	await sameProcess.load();
	sameProcess.record(GAME_B, { ...lesson, atEpochMs: 2 });
	assert.deepEqual(sameProcess.candidates(GAME_C), []);
	await store.flush();
}));

test('more than two hundred earlier games still load, so a resumed game keeps its record', () => withDirectory(async (directory) => {
	const writer = new ExperienceStore(settings(directory));
	await writer.load();
	for (let index = 0; index < 205; index++) writer.record(experienceHash(`world:${index}`), { ...lesson, atEpochMs: index });
	writer.record(experienceHash('world:7'), { ...lesson, atEpochMs: 999 });
	await writer.flush();
	const resumed = new ExperienceStore(settings(directory));
	await resumed.load();
	assert.equal(resumed.state().games, 205);
	assert.equal(resumed.candidates(experienceHash('world:7')).find((entry) => entry.id === lesson.id).thisGame, 2);
}));

test('decimal seeds that name the same number hash alike', () => {
	assert.equal(normalizeSeedHash('00042'), normalizeSeedHash('42'));
	assert.equal(normalizeSeedHash('+42'), normalizeSeedHash('42'));
	assert.notEqual(normalizeSeedHash('-42'), normalizeSeedHash('42'));
});

test('a slot outside its vocabulary is refused on record and dropped on load', () => withDirectory(async (directory) => {
	const store = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-a' }));
	await store.load();
	assert.throws(() => store.record(GAME_A, { id: 'melee-at-low-health:mob=steve', rule: 'melee-at-low-health', slots: { mob: 'steve' }, atEpochMs: 1 }), /vocabulary/);
	store.record(GAME_A, { ...lesson, atEpochMs: 1 });
	await store.flush();
	// An older file naming a player: rewrite the saved game with a forged slot, then reload.
	const [folder] = await readdir(directory);
	const [file] = await readdir(join(directory, folder));
	const saved = JSON.parse(await readFile(join(directory, folder, file), 'utf8'));
	saved.lessons['melee-at-low-health:mob=steve'] = { rule: 'melee-at-low-health', slots: { mob: 'steve' }, count: 1 };
	await writeFile(join(directory, folder, file), JSON.stringify(saved));
	const reloaded = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-b' }));
	await reloaded.load();
	assert.deepEqual(reloaded.candidates(GAME_B).map((entry) => entry.id), [lesson.id]);
}));

test('a seedless or excluded game does not hide the same lesson from other games', () => withDirectory(async (directory) => {
	for (const [seed, game] of [['seed-a', GAME_A], [null, GAME_B], ['seed-x', experienceHash('world:x')]]) {
		const store = new ExperienceStore(settings(directory, seed ? { MINEAGEN_WORLD_SEED_HASH: seed } : {}));
		await store.load();
		store.record(game, { ...lesson, atEpochMs: 1 });
		await store.flush();
	}
	const later = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-c', MINEAGEN_EXPERIENCE_EXCLUDE_SEEDS: 'seed-x' }));
	await later.load();
	assert.deepEqual(later.candidates(GAME_C).map(({ id, games, count }) => ({ id, games, count })), [{ id: lesson.id, games: 1, count: 1 }]);
}));

test('a row missing the slots of its rule, or with a key that does not match them, is dropped on load', () => withDirectory(async (directory) => {
	const store = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-a' }));
	await store.load();
	store.record(GAME_A, { ...lesson, atEpochMs: 1 });
	await store.flush();
	const [folder] = await readdir(directory);
	const [file] = await readdir(join(directory, folder));
	const saved = JSON.parse(await readFile(join(directory, folder, file), 'utf8'));
	saved.lessons['bailout-then-death:mob=wither skeleton'] = { rule: 'bailout-then-death', slots: { mob: 'wither skeleton' }, count: 1 };
	saved.lessons['bailout-then-death'] = { rule: 'bailout-then-death', slots: {}, count: 1 };
	saved.lessons['free text key'] = { rule: 'ranged-fled-in-open', slots: { mob: 'skeleton' }, count: 1 };
	await writeFile(join(directory, folder, file), JSON.stringify(saved));
	const reloaded = new ExperienceStore(settings(directory, { MINEAGEN_WORLD_SEED_HASH: 'seed-b' }));
	await reloaded.load();
	assert.deepEqual(reloaded.candidates(GAME_B).map((entry) => entry.id), [lesson.id]);
}));

test('the experience folder must be outside the checkout, by whole path components and through symlinks', () => withDirectory(async (directory) => {
	const root = join(directory, 'checkout');
	await mkdir(join(root, 'private'), { recursive: true });
	await mkdir(join(directory, 'checkout-x'));
	// A child named like ".." is inside; a sibling sharing the prefix is outside.
	assert.equal(isInsideDirectory(join(root, '..data'), root), true);
	assert.equal(isInsideDirectory(join(directory, 'checkout-x'), root), false);
	assert.equal(isInsideDirectory(root, root), true);
	// A link outside the checkout that leads into it, also to a folder that does not exist yet, is inside.
	await symlink(join(root, 'private'), join(directory, 'link'), 'dir');
	assert.equal(isInsideDirectory(join(directory, 'link'), root), true);
	assert.equal(isInsideDirectory(join(directory, 'link', 'new', 'deeper'), root), true);
	// A checkout reached through a link still contains its own folders.
	await symlink(root, join(directory, 'root-link'), 'dir');
	assert.equal(isInsideDirectory(join(root, 'private'), join(directory, 'root-link')), true);
	assert.equal(isInsideDirectory(join(directory, 'elsewhere', 'store'), root), false);
	// The coordinator applies the same check to its own environment, so a harness other than run-long cannot skip it.
	const settings = (dir) => experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: dir }, { checkoutRoot: root });
	assert.throws(() => settings(join(root, '..data')), /must be outside the checkout/);
	assert.throws(() => settings(join(directory, 'link', 'new')), /must be outside the checkout/);
	assert.equal(settings(join(directory, 'checkout-x')).directory, join(directory, 'checkout-x'));
	assert.throws(() => experienceSettings({ MINEAGEN_EXPERIENCE: 'lessons', MINEAGEN_EXPERIENCE_DIR: join(CHECKOUT_ROOT, 'player-lessons') }), /must be outside the checkout/);
	// Off stays off without touching the path.
	assert.equal(experienceSettings({ MINEAGEN_EXPERIENCE: 'off', MINEAGEN_EXPERIENCE_DIR: join(CHECKOUT_ROOT, 'x') }), null);
}));
