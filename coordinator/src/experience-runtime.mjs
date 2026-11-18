import { ExperienceStore, experienceHash } from './experience-store.mjs';
import { LESSON_RULES, deathLessons, failureLessons, lessonEntry, situationScore } from './experience-lessons.mjs';

// The coordinator's own review of deaths and failures, and the read path back into the model's task memory summary.
// No model call: the review reads a short recent history kept from observations and action results the coordinator
// already receives, matches it against a fixed set of lesson rules, and records the matches for this player profile.

const HISTORY_MS = 60_000;
const MAX_SAMPLES = 90;
const MAX_RESULTS = 24;
const NEAR_BLOCKS = 16;
export const MAX_SHOWN_LESSONS = 3;

/** Builds the experience runtime from settings (experienceSettings(env)), or null when experience is off. */
export function createExperience(settings, { trace = null, store = null } = {}) {
	if (settings === null || settings === undefined) return null;
	return new ExperienceRuntime({ store: store ?? new ExperienceStore(settings), trace });
}

/** Normalises a vanilla death message to a cause without keeping the message, which starts with the player's name. */
export function classifyDeath(message) {
	const text = typeof message === 'string' ? message : '';
	const suffix = / (?:while|whilst) (?:trying to escape|fighting) ([A-Z][A-Za-z ]{1,40}?)(?: using .*)?$/.exec(text);
	const escaping = suffix ? mobId(suffix[1]) : null;
	const base = suffix ? text.slice(0, suffix.index) : text;
	const rules = [
		[/was shot by ([A-Z][A-Za-z ]{1,40}?)(?: using .*)?$/, 'shot'],
		[/was fireballed by ([A-Z][A-Za-z ]{1,40}?)(?: using .*)?$/, 'fireball'],
		[/was blown up by ([A-Z][A-Za-z ]{1,40}?)(?: using .*)?$/, 'explosion'],
		[/was (?:slain|killed|pummeled|stung|impaled|squashed) by ([A-Z][A-Za-z ]{1,40}?)(?: using .*)?$/, 'melee'],
	];
	for (const [pattern, kind] of rules) {
		const found = pattern.exec(base);
		const killer = found ? mobId(found[1]) : null;
		if (killer) return { cause: killer, kind, ...(escaping ? { escaping } : {}) };
	}
	const hazards = [
		[/tried to swim in lava/, 'lava'], [/(?:burned to death|went up in flames|walked into fire|was burned to a crisp)/, 'fire'],
		[/(?:hit the ground too hard|fell from a high place|fell off|fell out of|doomed to fall|fell too far)/, 'fall'],
		[/drowned/, 'drown'], [/suffocated in a wall|was squished/, 'suffocate'], [/starved to death/, 'starve'],
		[/blew up|was blown up/, 'explosion'], [/was killed by magic|was killed by .*using magic/, 'magic'],
		[/withered away/, 'wither'], [/froze to death/, 'freeze'], [/experienced kinetic energy/, 'kinetic'],
	];
	for (const [pattern, cause] of hazards) if (pattern.test(text)) return { cause, kind: 'hazard', ...(escaping ? { escaping } : {}) };
	return { cause: 'unknown', kind: 'unknown', ...(escaping ? { escaping } : {}) };
}

function mobId(name) {
	const id = name.trim().toLowerCase().replace(/\s+/g, '_');
	return /^[a-z_]{2,40}$/.test(id) ? id : null;
}

/** A compact, coordinate-free sample of what the body perceived. */
export function sampleOf(observation, at) {
	const player = observation?.player ?? {};
	const hostiles = new Map();
	for (const entity of Array.isArray(observation?.entities) ? observation.entities : []) {
		if (entity?.hostile !== true || typeof entity.type !== 'string') continue;
		const distance = Number.isFinite(entity.distance) ? entity.distance : null;
		if (distance !== null && distance > NEAR_BLOCKS) continue;
		const type = entity.type.replace(/^minecraft:/, '');
		hostiles.set(type, Math.min(hostiles.get(type) ?? Infinity, distance ?? NEAR_BLOCKS));
	}
	const food = observation?.inventory?.food;
	const edible = Array.isArray(food?.items) ? food.items.reduce((sum, item) => sum + (Number.isSafeInteger(item?.count) ? item.count : 0), 0)
		: Number.isSafeInteger(food?.items) ? food.items : null;
	const dimension = observation?.world?.dimension ?? observation?.world?.dimensionId;
	return {
		at,
		...(typeof dimension === 'string' ? { dimension: dimension.replace(/^minecraft:/, '') } : {}),
		...(Number.isFinite(player.health) ? { health: player.health } : {}),
		...(Number.isFinite(player.armor) ? { armor: player.armor } : {}),
		...(edible === null ? {} : { edible }),
		...(player.inLava === true ? { inLava: true } : {}),
		// Lava touched, seen within a few blocks lately, or heard close by.
		...(player.inLava === true || player.lavaSeen != null || Number.isFinite(player.heardLava?.distance) && player.heardLava.distance <= 12 ? { lavaNear: true } : {}),
		...(typeof player.lastAttacker?.type === 'string' ? { attacker: player.lastAttacker.type.replace(/^minecraft:/, '') } : {}),
		hostiles: Object.fromEntries([...hostiles].sort((a, b) => a[1] - b[1]).slice(0, 4)),
	};
}

export class ExperienceRuntime {
	#store; #trace; #agents = new Map(); #ready; #state = null;
	constructor({ store, trace = null }) {
		this.#store = store;
		this.#trace = typeof trace === 'function' ? trace : null;
		this.#ready = store.load().then((loaded) => {
			this.#state = store.state();
			this.#emit('experience_state', { ...this.#state, skippedFiles: loaded.skipped });
		});
		this.#ready.catch(() => {});
	}
	get ready() { return this.#ready; }
	state() { return this.#state === null ? null : { ...this.#store.state() }; }

	#agent(agentId) {
		let agent = this.#agents.get(agentId);
		if (agent === undefined) { agent = { game: null, samples: [], results: [], running: new Map(), deaths: new Set(), failures: new Map(), shown: new Set(), recent: [], clock: null }; this.#agents.set(agentId, agent); }
		return agent;
	}
	#emit(event, fields) { try { this.#trace?.(event, fields); } catch { /* tracing never blocks play */ } }

	/** Feeds one accepted observation. Returns a promise that settles once any death it carries has been reviewed. */
	observe(agentId, worldId, observation, at) {
		const agent = this.#agent(agentId);
		if (typeof worldId === 'string' && !worldId.startsWith('session:')) {
			const game = experienceHash(`world:${worldId}`);
			if (agent.game !== game) { agent.game = game; agent.samples = []; agent.results = []; agent.running.clear(); agent.failures.clear(); agent.shown.clear(); agent.recent = []; }
		}
		const death = observation?.death;
		if (death && typeof death === 'object') return this.#reviewDeath(agentId, agent, death, at);
		if (observation?.player?.dead === true || observation?.ready === false) return Promise.resolve();
		agent.clock = Math.max(agent.clock ?? at, at);
		agent.samples.push(sampleOf(observation, at));
		while (agent.samples.length > MAX_SAMPLES || agent.samples.length && at - agent.samples[0].at > HISTORY_MS) agent.samples.shift();
		return Promise.resolve();
	}

	/** `at` defaults to the agent's latest observation time, so a replayed recording keeps its own clock. */
	noteDispatch(agentId, { actionId, actionType }, at = undefined) {
		const agent = this.#agent(agentId);
		at ??= agent.clock ?? Date.now();
		if (typeof actionId === 'string' && typeof actionType === 'string') agent.running.set(actionId, { actionType, at });
		while (agent.running.size > 16) agent.running.delete(agent.running.keys().next().value);
	}

	/** Feeds one terminal action result; a failure pattern that crosses its rule's bar records a lesson. */
	async noteResult(agentId, { actionId, actionType, state, reasonCode, dimension }, at = undefined) {
		const agent = this.#agent(agentId);
		at ??= agent.clock ?? Date.now();
		const started = agent.running.get(actionId);
		agent.running.delete(actionId);
		const type = actionType ?? started?.actionType;
		if (typeof type !== 'string') return;
		const row = { actionType: type, state, reasonCode, at, elapsedMs: started ? Math.max(0, at - started.at) : null,
			...(typeof dimension === 'string' ? { dimension: dimension.replace(/^minecraft:/, '') } : {}) };
		agent.results.push(row);
		while (agent.results.length > MAX_RESULTS || agent.results.length && at - agent.results[0].at > HISTORY_MS) agent.results.shift();
		if (agent.game === null || !['FAILED', 'TIMED_OUT', 'CANCELLED'].includes(state)) return;
		for (const lesson of failureLessons(row, agent.failures, agent.samples.at(-1) ?? null)) await this.#record(agent, lesson, at);
	}

	async #reviewDeath(agentId, agent, death, at) {
		const diedAt = Number.isFinite(death.diedAtEpochMs) ? death.diedAtEpochMs : null;
		const key = diedAt ?? `${death.cause}`;
		// Supervised retries and reconciliation replay the same death; it is reviewed once.
		if (agent.deaths.has(key)) return;
		agent.deaths.add(key);
		if (agent.game === null) return;
		const when = diedAt ?? at;
		const cause = classifyDeath(death.cause);
		const running = [...agent.running.values()].filter((entry) => entry.at <= when).map((entry) => entry.actionType);
		const context = { cause, dimension: typeof death.dimensionId === 'string' ? death.dimensionId.replace(/^minecraft:/, '') : agent.samples.at(-1)?.dimension,
			running, samples: agent.samples.filter((sample) => sample.at <= when), results: agent.results.filter((result) => result.at <= when), at: when };
		const lessons = deathLessons(context);
		this.#emit('experience_death_reviewed', { cause: cause.cause, kind: cause.kind, ...(cause.escaping ? { escaping: cause.escaping } : {}), dimension: context.dimension ?? null,
			running, lessons: lessons.map((lesson) => lesson.id) });
		for (const lesson of lessons) await this.#record(agent, lesson, when);
		// History before a death does not describe the next life.
		agent.samples = []; agent.results = []; agent.running.clear();
	}

	async #record(agent, lesson, at) {
		await this.#ready;
		const count = this.#store.record(agent.game, { ...lesson, atEpochMs: at });
		// A lesson just learned is shown on the next wakes (the respawn decision) even before its situation returns.
		agent.recent = [...agent.recent.filter((entry) => entry.id !== lesson.id), { id: lesson.id, at }].slice(-4);
		this.#emit('experience_lesson_recorded', { lessonId: lesson.id, rule: lesson.rule, countThisGame: count });
	}

	/**
	 * The lessons to show now, as task memory lesson entries, best match first, at most MAX_SHOWN_LESSONS.
	 * `markShown` counts their exposure; pass it only where the summary goes to the model.
	 */
	async lessonsFor(agentId, { markShown = false, at = undefined } = {}) {
		await this.#ready;
		const agent = this.#agents.get(agentId);
		if (agent?.game == null) return [];
		at ??= agent.clock ?? Date.now();
		const situation = situationOf(agent, at);
		const ranked = this.#store.candidates(agent.game)
			.map((candidate) => ({ candidate, score: situationScore(candidate, situation) }))
			.filter(({ score }) => score > 0)
			.sort((a, b) => b.score - a.score || (b.candidate.count + b.candidate.thisGame) - (a.candidate.count + a.candidate.thisGame) || a.candidate.id.localeCompare(b.candidate.id))
			.map(({ candidate }) => candidate)
			// One lesson per mob: the best supported one says enough.
			.filter((candidate, index, all) => candidate.slots.mob === undefined || all.findIndex((other) => other.slots.mob === candidate.slots.mob) === index)
			.slice(0, MAX_SHOWN_LESSONS);
		if (markShown && ranked.length) {
			const first = this.#store.markShown(agent.game, ranked.map((entry) => entry.id), at);
			const fresh = ranked.filter((entry) => !agent.shown.has(entry.id));
			for (const entry of fresh) agent.shown.add(entry.id);
			if (fresh.length) this.#emit('experience_lessons_shown', { lessonIds: fresh.map((entry) => entry.id), carried: fresh.filter((entry) => entry.games > 0).length, firstInGame: first.length });
		}
		return ranked.map(lessonEntry);
	}

	async flush() { await this.#ready.catch(() => {}); await this.#store.flush(); }
}

const RECENT_LESSON_MS = 180_000;
function situationOf(agent, at) {
	const sample = agent.samples.at(-1) ?? { hostiles: {} };
	const running = [...agent.running.values()].map((entry) => entry.actionType);
	return { ...sample, at, running, results: agent.results, recentLessons: agent.recent.filter((entry) => at - entry.at <= RECENT_LESSON_MS).map((entry) => entry.id) };
}

export { LESSON_RULES };
