/**
 * The agent_death trace row: one per death, so the scorer can name its cause and the bot's last seconds without a replay.
 * It joins the server's death receipt (vanilla message, damage type, attacker, hunger, armour) with the last 10 s the
 * coordinator observed: health and position, the running action and the firing reflex, plus the plan step.
 */
export const DEATH_TRAIL_MS = 10_000;
// At most one trail point per half second: an observation burst cannot grow the row.
const TRAIL_STEP_MS = 500;
const MAX_TRAIL = Math.ceil(DEATH_TRAIL_MS / TRAIL_STEP_MS) + 1;
const MAX_TEXT = 320;

const finite = (value) => typeof value === 'number' && Number.isFinite(value);
const round = (value, places = 1) => finite(value) ? Math.round(value * 10 ** places) / 10 ** places : null;
const text = (value) => typeof value === 'string' && value ? value.slice(0, MAX_TEXT) : null;

export class DeathRecorder {
	#trails = new Map();
	#now;

	constructor({ now = Date.now } = {}) { this.#now = now; }

	/** Remembers a live observation's body facts for the agent (normalized protocol observation). */
	observe(agentId, observation, atMs = observation?.observedAtEpochMs ?? this.#now()) {
		const player = observation?.player;
		if (!agentId || observation?.ready !== true || !player || player.dead === true || !finite(atMs)) return;
		const trail = this.#trails.get(agentId) ?? [];
		const action = observation.currentAction?.active ? { type: text(observation.currentAction.actionType), id: text(observation.currentAction.actionId) } : null;
		const point = { atMs, health: round(player.health), foodLevel: finite(player.foodLevel) ? player.foodLevel : null, saturation: round(player.saturation),
			armor: finite(player.armor) ? player.armor : null, x: round(observation.position?.x), y: round(observation.position?.y), z: round(observation.position?.z),
			dimension: text(observation.world?.dimension), action, reflex: text(observation.reflexes?.firing?.id) };
		// A slot holds the newest sample of its half second, so the trail keeps the last facts before the death.
		const slot = trail.at(-1);
		if (slot && atMs - slot.slotAt < TRAIL_STEP_MS) trail[trail.length - 1] = { ...point, slotAt: slot.slotAt };
		else trail.push({ ...point, slotAt: atMs });
		while (trail.length > MAX_TRAIL || trail.length && trail[0].atMs < atMs - DEATH_TRAIL_MS) trail.shift();
		this.#trails.set(agentId, trail);
	}

	/**
	 * The trace row for a goal_control dead receipt; the trail ends. `doing` and `step` are the plan's view (live-task-view).
	 * Hunger and armour prefer the server's value at death over the last observation.
	 */
	record(record, death, { step = null, doing = null } = {}) {
		const diedAt = finite(death?.diedAtEpochMs) ? death.diedAtEpochMs : this.#now();
		const trail = (this.#trails.get(record.agentId) ?? []).filter((point) => point.atMs >= diedAt - DEATH_TRAIL_MS && point.atMs <= diedAt);
		this.#trails.delete(record.agentId);
		const last = trail.at(-1) ?? null;
		return {
			agentId: record.agentId, goalRevision: record.goalRevision, diedAtEpochMs: diedAt,
			cause: text(death?.cause), damageType: text(death?.damageType), attacker: text(death?.attacker), directAttacker: text(death?.directAttacker),
			dimension: text(death?.dimensionId) ?? last?.dimension ?? null,
			position: finite(death?.x) ? { x: round(death.x), y: round(death.y), z: round(death.z) } : null,
			foodLevel: finite(death?.foodLevel) ? death.foodLevel : last?.foodLevel ?? null,
			saturation: finite(death?.saturation) ? round(death.saturation) : last?.saturation ?? null,
			armor: finite(death?.armor) ? death.armor : last?.armor ?? null,
			action: last?.action ?? null, reflex: last?.reflex ?? null, step: text(step), doing: text(doing),
			// Seconds before death (negative), health, hunger, position and what was running at each point.
			trail: trail.map(({ atMs, health, foodLevel, x, y, z, action, reflex }) => ({ s: round((atMs - diedAt) / 1000), health, foodLevel, x, y, z,
				action: action?.type ?? null, reflex })),
			trailBasis: trail.length ? 'coordinator observations, at most one per 0.5 s' : 'no live observation in the last 10 s',
		};
	}

	forget(agentId) { this.#trails.delete(agentId); }
}
