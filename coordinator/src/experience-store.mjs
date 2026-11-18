import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { AtomicAgentStore } from './observed-memory-store.mjs';

// Experience that outlives one world: one player profile's lessons, written by the coordinator's own review of
// deaths and failures (never by the model), and read back in later games by situation.
//
// Layout: <directory>/profile-<hash>/game-<hash>.json, one file per game. A game writes only its own file, so
// parallel games on one profile never contend, and a frozen snapshot is the set of files read at load.
// Nothing stored names a world, a player, a seed or a coordinate: games and seeds are salted hashes, and a lesson is
// a rule id plus a few vocabulary slots (a mob id, an action type, a dimension).

export const EXPERIENCE_MODES = Object.freeze(['off', 'lessons']);
const VERSION = 1;
const MAX_GAME_FILES = 200;
const MAX_LESSONS_PER_GAME = 32;
const HASH_SALT = 'mineagen-experience-v1';
const SLOT = /^[a-z0-9_:.-]{1,64}$/;

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
export function experienceSettings(environment = process.env) {
	const mode = (environment.MINEAGEN_EXPERIENCE ?? 'off').trim().toLowerCase() || 'off';
	if (!EXPERIENCE_MODES.includes(mode)) throw new TypeError(`MINEAGEN_EXPERIENCE must be one of ${EXPERIENCE_MODES.join(', ')}`);
	if (mode === 'off') return null;
	const directory = environment.MINEAGEN_EXPERIENCE_DIR?.trim();
	if (!directory) throw new TypeError('MINEAGEN_EXPERIENCE_DIR is required when MINEAGEN_EXPERIENCE is on');
	const profile = environment.MINEAGEN_EXPERIENCE_PROFILE?.trim() || 'default';
	const seedHash = normalizeSeedHash(environment.MINEAGEN_WORLD_SEED_HASH);
	const excludedSeedHashes = (environment.MINEAGEN_EXPERIENCE_EXCLUDE_SEEDS ?? '').split(',').map(normalizeSeedHash).filter(Boolean);
	return Object.freeze({ mode, directory: resolve(directory), profile, frozen: environment.MINEAGEN_EXPERIENCE_FROZEN === '1', seedHash,
		excludedSeedHashes: Object.freeze([...new Set(excludedSeedHashes)]) });
}

/** A seed hash is opaque text; a raw numeric seed is hashed so it is never stored. */
export function normalizeSeedHash(value) {
	if (typeof value !== 'string' || value.trim().length === 0) return null;
	const text = value.trim();
	return /^[0-9a-f]{16,64}$/.test(text) ? text.slice(0, 16) : experienceHash(`seed:${text}`);
}

export class ExperienceStore {
	#settings; #directory; #disk; #loaded = null; #games = new Map(); #snapshotSha256 = null; #writeErrors = 0; #pendingWrites = new Set();
	#current = new Map(); // gameHash -> this game's record (in memory; persisted unless frozen)
	constructor(settings) {
		if (settings === null || typeof settings !== 'object') throw new TypeError('experience settings are required');
		this.#settings = settings;
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

	/** Records one occurrence of a lesson in this game. Returns the lesson's count in this game. */
	record(gameHash, { id, rule, slots = {}, atEpochMs }) {
		requireHash(gameHash);
		if (typeof id !== 'string' || id.length > 160 || typeof rule !== 'string' || !SLOT.test(rule)) throw new TypeError('lesson id and rule are required');
		for (const value of Object.values(slots)) if (typeof value !== 'string' || !SLOT.test(value)) throw new TypeError('lesson slots must be vocabulary ids');
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
	 * Lessons available in this game: earlier games' lessons (never from an excluded or the current seed) and this
	 * game's own. Each comes with its evidence counts. Side-effect free.
	 */
	candidates(gameHash) {
		requireHash(gameHash);
		const blocked = new Set(this.#settings.excludedSeedHashes);
		if (this.#settings.seedHash !== null) blocked.add(this.#settings.seedHash);
		const carried = new Map();
		for (const game of this.#games.values()) {
			if (game.game === gameHash) continue;
			for (const [id, lesson] of Object.entries(game.lessons)) {
				const entry = carried.get(id) ?? { id, rule: lesson.rule, slots: lesson.slots, games: 0, count: 0, shownGames: 0, repeatsAfterShown: 0, blocked: false };
				entry.games += 1; entry.count += lesson.count; entry.repeatsAfterShown += lesson.repeatsAfterShown ?? 0;
				if (game.seedHash !== null && blocked.has(game.seedHash)) entry.blocked = true;
				carried.set(id, entry);
			}
			for (const id of Object.keys(game.shown)) { const entry = carried.get(id); if (entry) entry.shownGames += 1; }
		}
		const own = this.#current.get(gameHash) ?? this.#games.get(gameHash);
		const result = [...carried.values()].filter((entry) => !entry.blocked).map(({ blocked, ...entry }) => ({ ...entry, thisGame: own?.lessons[entry.id]?.count ?? 0 }));
		for (const [id, lesson] of Object.entries(own?.lessons ?? {})) {
			if (!carried.has(id)) result.push({ id, rule: lesson.rule, slots: lesson.slots, games: 0, count: 0, shownGames: 0, repeatsAfterShown: 0, thisGame: lesson.count });
		}
		return result;
	}

	#persist(game) {
		if (this.#settings.frozen) return;
		const pending = this.#disk.write(game.game, game).catch(() => { this.#writeErrors += 1; });
		this.#pendingWrites.add(pending);
		pending.finally(() => this.#pendingWrites.delete(pending));
	}
	async flush() { while (this.#pendingWrites.size) await Promise.all([...this.#pendingWrites]); }
}

function requireHash(value) { if (typeof value !== 'string' || !/^[0-9a-f]{16}$/.test(value)) throw new TypeError('game hash must be 16 hex characters'); }

function validGame(value) {
	if (value === null || typeof value !== 'object' || value.version !== VERSION || typeof value.game !== 'string' || !/^[0-9a-f]{16}$/.test(value.game)) return null;
	if (value.seedHash !== null && (typeof value.seedHash !== 'string' || !/^[0-9a-f]{16}$/.test(value.seedHash))) return null;
	const lessons = {}, shown = {};
	for (const [id, lesson] of Object.entries(value.lessons ?? {}).slice(0, MAX_LESSONS_PER_GAME)) {
		if (id.length > 160 || typeof lesson?.rule !== 'string' || !SLOT.test(lesson.rule) || !Number.isSafeInteger(lesson.count) || lesson.count < 1) continue;
		const slots = Object.fromEntries(Object.entries(lesson.slots ?? {}).filter(([, slot]) => typeof slot === 'string' && SLOT.test(slot)));
		lessons[id] = { rule: lesson.rule, slots, count: lesson.count, firstAtMs: lesson.firstAtMs ?? null, lastAtMs: lesson.lastAtMs ?? null,
			...(Number.isSafeInteger(lesson.repeatsAfterShown) && lesson.repeatsAfterShown > 0 ? { repeatsAfterShown: lesson.repeatsAfterShown } : {}) };
	}
	for (const [id, entry] of Object.entries(value.shown ?? {})) if (Number.isSafeInteger(entry?.wakes) && entry.wakes > 0) shown[id] = { wakes: entry.wakes, firstAtMs: entry.firstAtMs ?? null };
	return { version: VERSION, game: value.game, seedHash: value.seedHash, lessons, shown };
}
