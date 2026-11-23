import { createHash } from 'node:crypto';
import { lstatSync, readlinkSync, realpathSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { AtomicAgentStore } from './observed-memory-store.mjs';
import { lessonId, validLesson } from './experience-lessons.mjs';
import { getSwitch } from './switches.mjs';

// Experience that outlives one world: one player profile's lessons, written by the coordinator's own review of
// deaths and failures (never by the model), and read back in later games by situation.
//
// Layout: <directory>/profile-<hash>/game-<hash>.json, one file per game. A game writes only its own file, so
// parallel games on one profile never contend, and a frozen snapshot is the set of files read at load.
// Nothing stored names a world, a player, a seed or a coordinate: games and seeds are salted hashes, and a lesson is
// a rule id plus a few vocabulary slots (a mob id, an action type, a dimension).

export const EXPERIENCE_MODES = Object.freeze(['off', 'lessons']);
const VERSION = 1;
// A bound on what one load reads, not a carry window: below it every game is read, so a resumed game is found.
// Past it, load reads an arbitrary subset (names are hashes) and a resumed game may restart empty.
const MAX_GAME_FILES = 2000;
const MAX_LESSONS_PER_GAME = 32;
const MAX_DEATHS_PER_GAME = 64;
const HASH_SALT = 'mineagen-experience-v1';
const SLOT = /^[a-z0-9_:.-]{1,64}$/;
const SEED_HASH = /^s1-[0-9a-f]{16}$/;

/** The checkout that holds this coordinator (coordinator/src/../..). */
export const CHECKOUT_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');

/**
 * The real path of `target`, resolving symlinks in its longest existing prefix; the rest (not created yet) is appended.
 * A dangling link is followed to where it points, so a link to a checkout folder not created yet still counts as it.
 */
function realPathOf(target) {
	let missing = [];
	let current = resolve(target);
	for (let links = 0; ;) {
		try { return join(realpathSync.native(current), ...missing); } catch (error) {
			if (error?.code !== 'ENOENT') throw error;
		}
		let link = null;
		try { if (lstatSync(current).isSymbolicLink()) link = readlinkSync(current); } catch (error) { if (error?.code !== 'ENOENT') throw error; }
		if (link !== null) {
			if (++links > 40) throw Object.assign(new Error('too many symbolic links'), { code: 'ELOOP' });
			current = resolve(dirname(current), link);
			continue;
		}
		const parent = dirname(current);
		if (parent === current) return join(current, ...missing);
		missing = [basename(current), ...missing];
		current = parent;
	}
}

/**
 * Whether `target` is `root` or inside it, compared by whole path components after resolving symlinks, so a sibling
 * named like a prefix (`root-x`, `..data`) is outside and a link that leads into the root is inside.
 */
export function isInsideDirectory(target, root) {
	const path = relative(realPathOf(root), realPathOf(target));
	return path === '' || !(path === '..' || path.startsWith(`..${sep}`) || isAbsolute(path));
}

export function experienceHash(value) {
	return createHash('sha256').update(`${HASH_SALT}\0${value}`).digest('hex').slice(0, 16);
}

/**
 * Reads the experience settings from the coordinator's environment. Returns null when experience is off.
 * MINEAGEN_EXPERIENCE=lessons turns it on; MINEAGEN_EXPERIENCE_DIR names a folder outside the checkout (required);
 * MINEAGEN_EXPERIENCE_PROFILE names the player profile (the player name changes every run, so harnesses set it);
 * MINEAGEN_EXPERIENCE_FROZEN=1 makes the store read-only; MINEAGEN_WORLD_SEED_HASH is this game's seed hash, and
 * MINEAGEN_EXPERIENCE_EXCLUDE_SEEDS a comma list of seed hashes whose lessons never load (the evaluation pool).
 */
export function experienceSettings(environment = process.env, { checkoutRoot = CHECKOUT_ROOT } = {}) {
	// An unknown mode throws SwitchValueError (a TypeError): MINEAGEN_EXPERIENCE must be one of off, lessons.
	const mode = getSwitch('experience', environment).value;
	if (mode === 'off') return null;
	const directory = environment.MINEAGEN_EXPERIENCE_DIR?.trim();
	if (!directory) throw new TypeError('MINEAGEN_EXPERIENCE_DIR is required when MINEAGEN_EXPERIENCE is on');
	// Lessons are private run data: they never land in the checkout, which is public.
	let inside;
	// A folder that cannot be checked refuses to start, with the error code only: the message would name the path.
	try { inside = isInsideDirectory(directory, checkoutRoot); } catch (error) { throw new TypeError(`MINEAGEN_EXPERIENCE_DIR could not be checked: ${typeof error?.code === 'string' ? error.code : 'unknown'}`); }
	if (inside) throw new TypeError('MINEAGEN_EXPERIENCE_DIR must be outside the checkout');
	const profile = environment.MINEAGEN_EXPERIENCE_PROFILE?.trim() || 'default';
	const seedHash = normalizeSeedHash(environment.MINEAGEN_WORLD_SEED_HASH);
	const excludedSeedHashes = (environment.MINEAGEN_EXPERIENCE_EXCLUDE_SEEDS ?? '').split(',').map(normalizeSeedHash).filter(Boolean);
	return Object.freeze({ mode, directory: resolve(directory), profile, frozen: getSwitch('experience.frozen', environment).value, seedHash,
		excludedSeedHashes: Object.freeze([...new Set(excludedSeedHashes)]) });
}

/**
 * Every seed becomes `s1-` plus a salted hash, so a raw seed is never stored. A value already in that form passes
 * through unchanged, which makes the step idempotent: a harness may hash before setting the env.
 */
export function normalizeSeedHash(value) {
	if (typeof value !== 'string' || value.trim().length === 0) return null;
	let text = value.trim();
	if (SEED_HASH.test(text)) return text;
	// One seed, one hash: "00042", "+42" and "42" name the same numeric seed.
	if (/^[-+]?\d+$/.test(text)) text = BigInt(text).toString();
	return `s1-${experienceHash(`seed:${text}`)}`;
}

export class ExperienceStore {
	#settings; #directory; #disk; #loaded = null; #games = new Map(); #snapshotSha256 = null; #writeErrors = 0; #pendingWrites = new Set();
	#current = new Map(); // gameHash -> this game's record (in memory; persisted unless frozen)
	#onError;
	/** `onError(stage, error)` hears failed writes, so a lesson that never reached disk is not reported as learned. */
	constructor(settings, { onError = null } = {}) {
		if (settings === null || typeof settings !== 'object') throw new TypeError('experience settings are required');
		this.#settings = settings;
		this.#onError = typeof onError === 'function' ? onError : null;
		this.#directory = join(settings.directory, `profile-${experienceHash(`profile:${settings.profile}`)}`);
		this.#disk = new AtomicAgentStore({ directory: this.#directory, namespace: 'game', sync: false });
	}
	get settings() { return this.#settings; }

	/** Reads every earlier game of this profile once. A missing folder is an empty store; a corrupt file is skipped and counted. */
	load() {
		this.#loaded ??= (async () => {
			let names = [];
			try { names = (await readdir(this.#directory)).filter((name) => /^game-[0-9a-f]{64}\.json$/.test(name)).sort(); }
			catch (error) { if (error.code !== 'ENOENT') throw error; }
			const snapshot = createHash('sha256');
			let skipped = 0;
			for (const name of names.slice(-MAX_GAME_FILES)) {
				let bytes;
				try { bytes = await readFile(join(this.#directory, name)); } catch { skipped += 1; continue; }
				snapshot.update(name).update('\0').update(bytes).update('\0');
				try {
					const record = validGame(JSON.parse(bytes.toString('utf8')));
					if (record === null) { skipped += 1; continue; }
					this.#games.set(record.game, record);
				} catch { skipped += 1; }
			}
			this.#snapshotSha256 = snapshot.digest('hex');
			return { games: this.#games.size, skipped };
		})();
		return this.#loaded;
	}

	/** Memory state for the round row: never a path, profile name or seed. */
	state() {
		const lessonIds = new Set();
		for (const game of this.#games.values()) for (const id of Object.keys(game.lessons)) lessonIds.add(id);
		return { mode: this.#settings.mode, frozen: this.#settings.frozen, profile: experienceHash(`profile:${this.#settings.profile}`),
			games: this.#games.size, lessons: lessonIds.size, snapshotSha256: this.#snapshotSha256, seedHashKnown: this.#settings.seedHash !== null,
			excludedSeeds: this.#settings.excludedSeedHashes.length, writeErrors: this.#writeErrors };
	}

	#game(gameHash) {
		let record = this.#current.get(gameHash);
		if (record === undefined) {
			// A coordinator restart inside the same game continues that game's file instead of carrying it as another game.
			const earlier = this.#games.get(gameHash);
			record = earlier ? structuredClone(earlier) : { version: VERSION, game: gameHash, seedHash: this.#settings.seedHash, lessons: {}, shown: {} };
			this.#games.delete(gameHash);
			this.#current.set(gameHash, record);
		}
		return record;
	}

	/**
	 * Notes that the death at this time was reviewed in this game. Returns false when it already was (a coordinator
	 * restart inside the game sees the last death again), so it is not counted twice. Persisted with the game.
	 */
	noteDeathReviewed(gameHash, diedAtEpochMs) {
		requireHash(gameHash);
		const game = this.#game(gameHash);
		game.deaths ??= [];
		if (game.deaths.includes(diedAtEpochMs)) return false;
		game.deaths = [...game.deaths, diedAtEpochMs].slice(-MAX_DEATHS_PER_GAME);
		this.#persist(game);
		return true;
	}

	/**
	 * Records one occurrence of a lesson in this game: one death, or one time a failure crossed its rule's bar (not
	 * every failure). Returns the lesson's count in this game.
	 */
	record(gameHash, { id, rule, slots = {}, atEpochMs }) {
		requireHash(gameHash);
		if (typeof id !== 'string' || id.length > 160 || typeof rule !== 'string' || !SLOT.test(rule)) throw new TypeError('lesson id and rule are required');
		for (const value of Object.values(slots)) if (typeof value !== 'string' || !SLOT.test(value)) throw new TypeError('lesson slots must be vocabulary ids');
		if (!validLesson(rule, slots) || id !== lessonId(rule, slots)) throw new TypeError('lesson slots must be vocabulary ids');
		const game = this.#game(gameHash);
		const existing = game.lessons[id];
		if (existing === undefined && Object.keys(game.lessons).length >= MAX_LESSONS_PER_GAME) return 0;
		const shownBefore = game.shown[id] !== undefined;
		game.lessons[id] = existing
			? { ...existing, count: existing.count + 1, lastAtMs: atEpochMs, ...(shownBefore ? { repeatsAfterShown: (existing.repeatsAfterShown ?? 0) + 1 } : {}) }
			: { rule, slots: { ...slots }, count: 1, firstAtMs: atEpochMs, lastAtMs: atEpochMs, ...(shownBefore ? { repeatsAfterShown: 1 } : {}) };
		this.#persist(game);
		return game.lessons[id].count;
	}

	/** Notes that these lessons reached the model in this game. Returns the ids shown for the first time. */
	markShown(gameHash, ids, atEpochMs) {
		requireHash(gameHash);
		const game = this.#game(gameHash);
		const first = [];
		for (const id of ids) {
			if (game.shown[id] === undefined) { game.shown[id] = { wakes: 1, firstAtMs: atEpochMs }; first.push(id); }
			else game.shown[id].wakes += 1;
		}
		if (first.length) this.#persist(game);
		return first;
	}

	/**
	 * Lessons available in this game: earlier games' lessons and this game's own, each with its evidence counts.
	 * Carry needs both seeds known: a game with no seed hash neither receives carried lessons nor lends its own, so a
	 * lesson can never load on its origin seed or an excluded seed unnoticed. Side-effect free.
	 */
	candidates(gameHash) {
		requireHash(gameHash);
		const blocked = new Set(this.#settings.excludedSeedHashes);
		const carryAllowed = this.#settings.seedHash !== null;
		if (carryAllowed) blocked.add(this.#settings.seedHash);
		const carried = new Map();
		// Earlier games: the snapshot read at load, plus games this process played before a world change.
		for (const game of [...this.#games.values(), ...this.#current.values()]) {
			// A seedless or blocked game lends no evidence, and does not hide other games' evidence for the same lesson.
			if (game.game === gameHash || !carryAllowed || game.seedHash === null || blocked.has(game.seedHash)) continue;
			for (const [id, lesson] of Object.entries(game.lessons)) {
				const entry = carried.get(id) ?? { id, rule: lesson.rule, slots: lesson.slots, games: 0, count: 0, shownGames: 0, repeatsAfterShown: 0 };
				entry.games += 1; entry.count += lesson.count; entry.repeatsAfterShown += lesson.repeatsAfterShown ?? 0;
				carried.set(id, entry);
			}
			for (const id of Object.keys(game.shown)) { const entry = carried.get(id); if (entry) entry.shownGames += 1; }
		}
		const own = this.#current.get(gameHash) ?? this.#games.get(gameHash);
		const result = [...carried.values()].map((entry) => ({ ...entry, thisGame: own?.lessons[entry.id]?.count ?? 0 }));
		// A lesson whose carried evidence is blocked (same or excluded seed) still stands on this game's own evidence.
		const shown = new Set(result.map((entry) => entry.id));
		for (const [id, lesson] of Object.entries(own?.lessons ?? {})) {
			if (!shown.has(id)) result.push({ id, rule: lesson.rule, slots: lesson.slots, games: 0, count: 0, shownGames: 0, repeatsAfterShown: 0, thisGame: lesson.count });
		}
		return result;
	}

	#persist(game) {
		if (this.#settings.frozen) return;
		const pending = this.#disk.write(game.game, game).catch((error) => { this.#writeErrors += 1; try { this.#onError?.('write', error); } catch { /* reporting never throws */ } });
		this.#pendingWrites.add(pending);
		pending.finally(() => this.#pendingWrites.delete(pending));
	}
	async flush() { while (this.#pendingWrites.size) await Promise.all([...this.#pendingWrites]); }
}

function requireHash(value) { if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value)) throw new TypeError('game hash must be 16 hex characters'); }

function validGame(value) {
	if (value === null || typeof value !== 'object' || value.version !== VERSION || typeof value.game !== 'string' || !/^[0-9a-f]{16}$/.test(value.game)) return null;
	if (value.seedHash !== null && (typeof value.seedHash !== 'string' || !SEED_HASH.test(value.seedHash))) return null;
	const lessons = {}, shown = {};
	for (const [id, lesson] of Object.entries(value.lessons ?? {}).slice(0, MAX_LESSONS_PER_GAME)) {
		if (id.length > 160 || typeof lesson?.rule !== 'string' || !SLOT.test(lesson.rule) || !Number.isSafeInteger(lesson.count) || lesson.count < 1) continue;
		const slots = lesson.slots && typeof lesson.slots === 'object' && !Array.isArray(lesson.slots) ? { ...lesson.slots } : {};
		// The rule's exact slots from their vocabularies, and the key rebuilt from them; anything else drops the lesson.
		if (!validLesson(lesson.rule, slots) || id !== lessonId(lesson.rule, slots)) continue;
		lessons[id] = { rule: lesson.rule, slots, count: lesson.count, firstAtMs: lesson.firstAtMs ?? null, lastAtMs: lesson.lastAtMs ?? null,
			...(Number.isSafeInteger(lesson.repeatsAfterShown) && lesson.repeatsAfterShown > 0 ? { repeatsAfterShown: lesson.repeatsAfterShown } : {}) };
	}
	for (const [id, entry] of Object.entries(value.shown ?? {})) if (Number.isSafeInteger(entry?.wakes) && entry.wakes > 0) shown[id] = { wakes: entry.wakes, firstAtMs: entry.firstAtMs ?? null };
	const deaths = Array.isArray(value.deaths) ? value.deaths.filter(Number.isFinite).slice(-MAX_DEATHS_PER_GAME) : [];
	return { version: VERSION, game: value.game, seedHash: value.seedHash, lessons, shown, deaths };
}
