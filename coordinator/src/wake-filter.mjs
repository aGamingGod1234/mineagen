/**
 * Wake filter for a running model action or skill (System 1 runs, System 2 sleeps). While the model's own action runs,
 * ordinary results and facts (a hit absorbed at safe health by a mob kind the model already knows, another threat
 * signal from a known kind, a fire contact a fire rule is handling, items picked up, routine updates) do not wake the
 * model; they are summed into the next wake as `now.whileActing`. The model is woken at once for a finished or failed
 * action (that path never reaches this filter), health at or below the low floor, a new kind of danger (a mob or
 * projectile kind the model was not shown, lava at the body, burning after a fire rule failed or with none armed), and
 * a new discovery (a fortress, portal, stronghold or bastion sighted; an enderman in range while pearls are open).
 *
 * Pure bookkeeping: no clock, no I/O. The caller asks decide() only while the model's own action runs, and calls take()
 * when it builds a wake for the model.
 */

// Same floor as the low-health danger context (danger-contexts.mjs: 8, or 40% of max health when lower).
export const WAKE_LOW_HEALTH = 8;
// An enderman this close is in pearl range (a player sees and walks to it within the hold).
export const ENDERMAN_RANGE = 24;
export const PEARL_TARGET = 12;
const MAJOR_STRUCTURE = /fortress|portal|stronghold|bastion/i;
const PEARL_GOAL = /pearl|ender[_ ]eye|eye of ender|eyes of ender|stronghold|end portal|the end\b|dragon|beat the game/i;
const FIRE_ACTIONS = new Set(['leave_fire', 'leave_lava']);
const FAILED_OUTCOMES = new Set(['failed', 'timeout', 'disabled']);
// Urgent triggers this filter may hold when the facts show the body coping; every other urgent trigger wakes.
const ABSORBABLE = new Set(['damage', 'threat', 'projectile', 'fire']);
// A creeper about to blow is a new danger whatever kinds the model has seen.
const WAKING_SIGNALS = new Set(['swelling', 'creeper_close']);

export const STEP_ACTIONS = new Set(['travel_to', 'dig_to', 'mine_vein', 'cast_obsidian', 'fight_until', 'build_shelter', 'barter_until', 'rest', 'build', 'escape']);
export const STEP_FOLDED_TRIGGERS = new Set(['attention', 'observation', 'resource_discovery', 'structure_sighted', 'lava_heard', 'heal_opportunity',
	'furnace_ready', 'context_entry', 'no_progress', 'repeated_result', 'movement_loop']);
const FOLDED_LABELS = { resource_discovery: 'resource sighting', structure_sighted: 'structure sighting', lava_heard: 'lava heard', heal_opportunity: 'chance to eat',
	furnace_ready: 'furnace update', context_entry: 'context entered', no_progress: 'plan-stall note', repeated_result: 'repeated-result note', movement_loop: 'movement loop (the body kept going)',
	search_danger: 'danger the search answered itself' };

// A running dig_to or travel_to is woken once for a sighting the plan needs: the needed ore within 24 blocks, or a roomy
// cave within 16 while an ore or lava is needed. Replayed over six 19 Nov games (698 dig and travel steps), 40 air and 24
// blocks with no grace woke 134 steps, a median 2 s in (caves flicker into view as the body turns); these bounds, the
// grace and the cooldown woke 35, a median 25 s in.
export const SIGHTING_STEPS = new Set(['dig_to', 'travel_to']);
export const SIGHTING_REACH = 24;
const SIGHTING_CAVE_REACH = 16;
const SIGHTING_CAVE_AIR = 60;
// Rows that come into view in a step's first seconds are what the body saw while turning to it, not news.
export const SIGHTING_GRACE_MS = 5_000;
// At most one sighting wake per agent in this window, across steps.
export const SIGHTING_COOLDOWN_MS = 120_000;
// A row within this many blocks of one already known is the same place seen again.
const SIGHTING_SAME = 8;

/** Visible cave and vein rows of a sample with a position (what SightedFeatures shows on every update). */
export function sightingRows(observation) {
	const sighted = observation?.continuity?.rememberedSections?.includes('sighted') ? {} : observation?.sighted ?? {};
	return [...rowsOf(sighted.caves).map((row) => ({ ...row, kind: 'cave' })), ...rowsOf(sighted.veins).map((row) => ({ ...row, kind: 'vein' }))]
		.filter((row) => [row.x, row.y, row.z].every(Number.isFinite));
}

/**
 * The sighting rows that could wake a step now: a vein within reach, or a roomy Overworld cave within its shorter reach.
 * Only these become known: a vein first seen 27 blocks off, or a cave seen small, can still wake once it is close.
 */
export function eligibleSightingRows(observation) {
	const overworld = (observation?.world?.dimension ?? 'minecraft:overworld') === 'minecraft:overworld';
	return sightingRows(observation).filter((row) => Number.isFinite(row.distance) && row.distance <= SIGHTING_REACH
		&& (row.kind === 'vein' || overworld && Number.isFinite(row.air) && row.air >= SIGHTING_CAVE_AIR && row.distance <= SIGHTING_CAVE_REACH));
}

/**
 * Why a running step's sample should wake the model at once, or null: a row in reach that is new against `known` (rows
 * already seen during this step) and that `needed` accepts (needed(kind, row) from the plan's open needs). The 19 Nov
 * games dug on past listed caves and ore: discovery wakes were folded while dig_to and travel_to ran.
 */
export function stepSightingReason({ step, observation, known = [], needed }) {
	if (!SIGHTING_STEPS.has(step) || typeof needed !== 'function') return null;
	const fresh = eligibleSightingRows(observation).filter((row) => !known.some((other) => other.kind === row.kind && (row.kind !== 'vein' || other.blockId === row.blockId)
		&& Math.hypot(other.x - row.x, other.y - row.y, other.z - row.z) < SIGHTING_SAME));
	if (fresh.length === 0) return null;
	const vein = fresh.find((row) => row.kind === 'vein' && needed('vein', row));
	if (vein) return `${short(vein.blockId ?? 'ore')} in view ${Math.round(vein.distance)} blocks away`;
	const cave = fresh.find((row) => row.kind === 'cave' && needed('cave', row));
	return cave ? `cave in reach ${Math.round(cave.distance)} blocks away @${cave.x},${cave.y},${cave.z}` : null;
}

/**
 * Whether this attention is folded into the next wake because a step owns the body. step: the running step's verb
 * (or null), attention: the classified wake { trigger, priority }. A major discovery (decide() wakes for it) is not
 * ordinary news, so the caller asks decide() first.
 */
export function stepFolds(step, attention, observation = null) {
	if (typeof step !== 'string' || step.length === 0) return false;
	if (STEP_FOLDED_TRIGGERS.has(attention?.trigger)) return true;
	// escape is already answering a drowning edge (it swims to air and out of the water), so the edge joins its end wake,
	// but never the last few seconds of air: a stalled escape must not hide the final warning.
	const air = observation?.player?.airSecondsLeft;
	return step === 'escape' && ESCAPE_FOLDED_TRIGGERS.has(attention?.trigger) && Number.isFinite(air) && air > ESCAPE_FOLD_MIN_AIR_S;
}
export const ESCAPE_FOLDED_TRIGGERS = new Set(['drowning']);
export const ESCAPE_FOLD_MIN_AIR_S = 4;

const typeOf = (value) => (typeof value === 'string' && value.length > 0 ? (value.includes(':') ? value : `minecraft:${value}`) : null);
const short = (id) => String(id).replace(/^minecraft:/u, '');
const rowsOf = (value) => (Array.isArray(value) ? value : []);

function threatRows(observation) {
	const rows = rowsOf(observation?.player?.threats);
	return rows.length > 0 ? rows : rowsOf(observation?.threats?.entries);
}

/** Mob and projectile kinds the observation shows (what a wake built from it tells the model). */
export function shownKinds(observation) {
	const kinds = new Set();
	for (const row of threatRows(observation)) { const type = typeOf(row?.type); if (type) kinds.add(type); }
	for (const row of rowsOf(observation?.entities)) {
		const type = typeOf(row?.type);
		if (type && (row?.hostile === true || row?.targetingAgent === true || type === 'minecraft:enderman')) kinds.add(type);
	}
	const attacker = typeOf(observation?.player?.lastAttacker?.type);
	if (attacker) kinds.add(attacker);
	for (const row of rowsOf(observation?.player?.incomingProjectiles ?? observation?.incomingProjectiles)) {
		const type = typeOf(row?.type);
		if (type) kinds.add(`projectile:${type}`);
	}
	return kinds;
}

function lowHealth(player) {
	if (!Number.isFinite(player?.health)) return false;
	const max = Number.isFinite(player.maxHealth) && player.maxHealth > 0 ? player.maxHealth : 20;
	return player.health <= Math.min(WAKE_LOW_HEALTH, max * 0.4);
}

function itemCounts(observation) {
	const counts = new Map();
	for (const item of rowsOf(observation?.inventory?.items)) {
		if (typeof item?.itemId !== 'string' || !Number.isFinite(item.count)) continue;
		counts.set(item.itemId, (counts.get(item.itemId) ?? 0) + item.count);
	}
	return counts;
}

export function pearlsOpen(goalText, observation) {
	if (typeof goalText !== 'string' || !PEARL_GOAL.test(goalText)) return false;
	const counts = itemCounts(observation);
	return (counts.get('minecraft:ender_pearl') ?? 0) + (counts.get('minecraft:ender_eye') ?? 0) < PEARL_TARGET;
}

/** Types of threats whose new signals this sample carries (changed facts "threats.<uuid>.<signal>"). */
function signalledThreats(changedFacts, observation) {
	const byId = new Map(threatRows(observation).map((row) => [row?.uuid ?? row?.stableId, typeOf(row?.type)]));
	const kinds = new Set(), signals = new Set();
	for (const fact of rowsOf(changedFacts)) {
		if (typeof fact !== 'string' || !fact.startsWith('threats.')) continue;
		const key = fact.slice('threats.'.length);
		const uuid = key.slice(0, key.lastIndexOf('.'));
		kinds.add(byId.get(uuid) ?? 'unknown');
		signals.add(key.slice(key.lastIndexOf('.') + 1));
	}
	return { kinds, signals };
}

function newMajorStructure(observation) {
	for (const row of rowsOf(observation?.sighted?.structures)) {
		if (row?.new !== true) continue;
		const name = [row.type, row.kind, row.structure, row.name, row.id].find((value) => typeof value === 'string');
		if (name !== undefined && MAJOR_STRUCTURE.test(name)) return short(name);
	}
	for (const row of rowsOf(observation?.sighted?.poi)) {
		if (row?.new !== true) continue;
		const name = [row.type, row.kind, row.blockId, row.name].find((value) => typeof value === 'string');
		if (name !== undefined && MAJOR_STRUCTURE.test(name)) return short(name);
	}
	return null;
}

function nearEnderman(observation) {
	const rows = [...rowsOf(observation?.entities), ...threatRows(observation)];
	return rows.some((row) => typeOf(row?.type) === 'minecraft:enderman' && Number.isFinite(row?.distance) && row.distance <= ENDERMAN_RANGE);
}

// Shots each count-skill mob fires (a blaze's small fireball): its own shots are part of the fight the skill runs.
const MOB_SHOTS = new Map([['minecraft:blaze', ['minecraft:small_fireball']], ['minecraft:ghast', ['minecraft:fireball']],
	['minecraft:skeleton', ['minecraft:arrow']], ['minecraft:stray', ['minecraft:arrow']], ['minecraft:wither_skeleton', []]]);
const ITEM_MOBS = new Map([['minecraft:blaze_rod', 'minecraft:blaze'], ['minecraft:ender_pearl', 'minecraft:enderman']]);

/**
 * The kinds a running count skill fights itself (its mob and that mob's shots, as shownKinds names them), or null when
 * the running action is no count skill: fight_until, or fight_target / use_ranged with untilItem. The mob is fight_until's
 * `mob`, else the named target's type in the observation, else the mob untilItem comes from.
 */
export function countSkillKinds(running, observation) {
	const args = running?.arguments;
	if (args === null || typeof args !== 'object') return null;
	const type = running.actionType;
	const counting = type === 'fight_until' || ((type === 'fight_target' || type === 'use_ranged') && typeof args.untilItem === 'string');
	if (!counting) return null;
	let mob = type === 'fight_until' ? typeOf(args.mob) : null;
	if (mob === null && typeof args.targetId === 'string') {
		const row = [...rowsOf(observation?.entities), ...threatRows(observation)].find((entry) => (entry?.uuid ?? entry?.stableId) === args.targetId);
		mob = typeOf(row?.type);
	}
	mob ??= ITEM_MOBS.get(typeOf(args.untilItem)) ?? null;
	if (mob === null) return null;
	return new Set([mob, ...(MOB_SHOTS.get(mob) ?? []).map((shot) => `projectile:${shot}`)]);
}

/** A discovery wakes whatever the trigger: an enderman in range while pearls are open, a major structure seen. */
function discoveryReason(known, attention, observation, goalText) {
	if (!known.has('minecraft:enderman') && nearEnderman(observation) && pearlsOpen(goalText, observation)) return 'enderman in range while pearls are open';
	const structure = attention?.trigger === 'structure_sighted' ? newMajorStructure(observation) : null;
	return structure === null ? null : `${structure} sighted`;
}

export class WakeFilter {
	#agents = new Map();

	#agent(agentId) {
		let agent = this.#agents.get(agentId);
		if (agent === undefined) {
			agent = { known: null, held: null, health: null, dimension: null };
			this.#agents.set(agentId, agent);
		}
		return agent;
	}

	#held(agent, observation, reflexEvents) {
		if (agent.held === null) {
			agent.held = {
				hits: 0, healthFrom: agent.health ?? observation?.player?.health ?? null, healthTo: null, by: new Map(),
				threatSignals: 0, threatKinds: new Set(), projectiles: 0, fire: 0, routine: 0, folded: new Map(),
				items: itemCounts(observation), reflexSeq: Math.max(0, ...rowsOf(reflexEvents).map((event) => event?.seq ?? 0)),
			};
		}
		return agent.held;
	}

	/**
	 * The verdict for one attention sample while the model's own action runs: 'wake' (wake now, never held), 'hold'
	 * (absorbed: summed into the next wake, no deadline) or 'default' (the ordinary hold policy decides).
	 * input: { attention, observation, changedFacts, reflexRules, reflexEvents, goalText }.
	 */
	decide(agentId, { attention, observation, changedFacts = [], reflexRules = [], reflexEvents = [], goalText = null, ownKinds = null } = {}) {
		const agent = this.#agent(agentId);
		// The mob a count skill fights (and its shots) was chosen by the model: it is known whatever the last wake showed.
		const known = ownKinds === null ? agent.known ?? new Set() : new Set([...(agent.known ?? []), ...ownKinds]);
		const player = observation?.player ?? {};
		const trigger = attention?.trigger;
		const found = discoveryReason(known, attention, observation, goalText);
		if (found !== null) return this.#wake(agent, observation, found);
		if (attention?.priority !== 'urgent') {
			if (['attention', 'observation'].includes(trigger)) this.#held(agent, observation, reflexEvents).routine += 1;
			return { verdict: 'default' };
		}
		if (!ABSORBABLE.has(trigger)) return { verdict: 'wake', reason: trigger };
		if (lowHealth(player)) return this.#wake(agent, observation, 'health at or below the low floor');
		if (player.inLava === true || player.hazard === 'lava') return this.#wake(agent, observation, 'lava at the body');
		const held = this.#held(agent, observation, reflexEvents);
		const burning = player.onFire === true || player.fire === true || player.hazard === 'fire';
		if (trigger === 'damage') {
			const attacker = typeOf(player.lastAttacker?.type);
			// Damage with no mob behind it is a burn (judged as fire below) or something the filter cannot judge (a fall,
			// drowning, a cactus): that wakes.
			if (attacker === null && !burning) return this.#wake(agent, observation, 'damage with no seen attacker');
			if (attacker !== null && !known.has(attacker)) return this.#wake(agent, observation, `hit by a new kind: ${short(attacker)}`);
			if (attacker !== null && ownKinds !== null && !ownKinds.has(attacker)) return this.#wake(agent, observation, `hit by ${short(attacker)}, not the skill's mob`);
			if (attacker !== null && burning) {
				const fire = this.#fireVerdict(agent, observation, held, reflexRules, reflexEvents);
				if (fire !== null) return fire;
			}
			if (attacker === null) return this.#fireVerdict(agent, observation, held, reflexRules, reflexEvents) ?? { verdict: 'hold', reason: 'fire rule handling it' };
			held.hits += 1;
			held.healthTo = player.health ?? held.healthTo;
			held.by.set(attacker ?? 'unknown', (held.by.get(attacker ?? 'unknown') ?? 0) + 1);
			return { verdict: 'hold', reason: 'hit absorbed' };
		}
		if (trigger === 'threat') {
			const { kinds, signals } = signalledThreats(changedFacts, observation);
			const waking = [...signals].filter((signal) => WAKING_SIGNALS.has(signal));
			if (waking.length > 0) return this.#wake(agent, observation, `threat signal ${waking.join(', ')}`);
			const fresh = [...kinds].filter((kind) => !known.has(kind));
			if (fresh.length > 0) return this.#wake(agent, observation, `new hostile kind: ${fresh.map(short).join(', ')}`);
			const other = ownKinds === null ? [] : [...kinds].filter((kind) => kind !== 'unknown' && !ownKinds.has(kind));
			if (other.length > 0) return this.#wake(agent, observation, `threat from ${other.map(short).join(', ')}, not the skill's mob`);
			held.threatSignals += 1;
			for (const kind of kinds) held.threatKinds.add(kind);
			return { verdict: 'hold', reason: 'known threat' };
		}
		if (trigger === 'projectile') {
			const flights = rowsOf(player.incomingProjectiles ?? observation?.incomingProjectiles).map((row) => typeOf(row?.type)).filter(Boolean);
			const fresh = flights.filter((type) => !known.has(`projectile:${type}`));
			if (fresh.length > 0 || flights.length === 0) return this.#wake(agent, observation, fresh.length > 0 ? `new projectile kind: ${fresh.map(short).join(', ')}` : 'projectile');
			const other = ownKinds === null ? [] : flights.filter((type) => !ownKinds.has(`projectile:${type}`));
			if (other.length > 0) return this.#wake(agent, observation, `projectile ${other.map(short).join(', ')}, not the skill's mob's`);
			held.projectiles += 1;
			return { verdict: 'hold', reason: 'known projectile' };
		}
		return this.#fireVerdict(agent, observation, held, reflexRules, reflexEvents) ?? { verdict: 'hold', reason: 'fire rule handling it' };
	}

	/** The discovery this sample would wake for (decide() wakes for it whatever the trigger), or null; changes nothing. */
	discovery(agentId, { attention, observation, goalText = null } = {}) {
		return discoveryReason(this.#agent(agentId).known ?? new Set(), attention, observation, goalText);
	}

	/** Counts one ordinary wake a running step folded (stepFolds), for the next wake's whileActing line. */
	fold(agentId, trigger, observation, reflexEvents = []) {
		const held = this.#held(this.#agent(agentId), observation, reflexEvents);
		if (trigger === 'attention' || trigger === 'observation') held.routine += 1;
		else held.folded.set(trigger, (held.folded.get(trigger) ?? 0) + 1);
	}

	/** Burning is held only while an armed fire rule handles it and none of its firings failed since the hold began. */
	#fireVerdict(agent, observation, held, reflexRules, reflexEvents) {
		const fireRules = rowsOf(reflexRules).filter((rule) => FIRE_ACTIONS.has(rule?.do?.type) && rule.state !== 'disabled');
		if (fireRules.length === 0) return this.#wake(agent, observation, 'burning with no fire rule armed');
		const ids = new Set(fireRules.map((rule) => rule.id));
		const failed = rowsOf(reflexEvents).some((event) => (event?.seq ?? 0) > held.reflexSeq && FAILED_OUTCOMES.has(event.outcome) && (ids.has(event.id) || FIRE_ACTIONS.has(event.action)));
		if (failed) return this.#wake(agent, observation, 'burning after a fire rule failed');
		held.fire += 1;
		return null;
	}

	#wake(agent, observation, reason) {
		// What triggered this wake is shown in it, so the same kind does not wake again before the model's next turn.
		agent.known = new Set([...(agent.known ?? []), ...shownKinds(observation)]);
		return { verdict: 'wake', reason };
	}

	/**
	 * The facts held since the last wake as one line (consumed), or null. Also records what this wake shows the model
	 * (added to the kinds already shown in this dimension), so the next hold judges "new" against it.
	 */
	take(agentId, observation) {
		const agent = this.#agent(agentId);
		const held = agent.held;
		agent.held = null;
		// Kinds stay known across wakes in one dimension (the model has fought them); a new dimension starts over.
		const dimension = observation?.world?.dimension ?? null;
		agent.known = new Set([...(dimension === agent.dimension ? agent.known ?? [] : []), ...shownKinds(observation)]);
		agent.dimension = dimension;
		agent.health = Number.isFinite(observation?.player?.health) ? observation.player.health : null;
		if (held === null) return null;
		const parts = [];
		if (held.hits > 0) {
			const by = [...held.by].map(([kind, count]) => `${kind === 'unknown' ? 'unseen attacker' : short(kind)} ${count}`).join(', ');
			const health = Number.isFinite(held.healthFrom) && Number.isFinite(held.healthTo) ? `, health ${held.healthFrom} -> ${held.healthTo}` : '';
			parts.push(`${held.hits} hit(s) taken (${by}${health})`);
		}
		if (held.threatSignals > 0) parts.push(`${held.threatSignals} threat signal(s) from ${[...held.threatKinds].map(short).join(', ') || 'known mobs'}`);
		if (held.projectiles > 0) parts.push(`${held.projectiles} incoming projectile(s) of known kinds`);
		if (held.fire > 0) parts.push(`${held.fire} fire contact(s) with a fire rule armed`);
		const gained = [];
		for (const [item, count] of itemCounts(observation)) {
			const before = held.items.get(item) ?? 0;
			if (count > before) gained.push(`${short(item)} +${count - before}`);
		}
		if (gained.length > 0) parts.push(`items gained ${gained.join(', ')}`);
		for (const [trigger, count] of held.folded) parts.push(`${FOLDED_LABELS[trigger] ?? trigger}${count > 1 ? ` x${count}` : ''}`);
		if (held.routine > 0) parts.push(`${held.routine} routine update(s)`);
		return parts.length === 0 ? null : `not woken for: ${parts.join('; ')}`;
	}

	drop(agentId) { this.#agents.delete(agentId); }
}
