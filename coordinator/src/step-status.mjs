import { sanitizeStepStatus, STEP_STATUS_MAX_LENGTH } from './protocol-v2.mjs';

/** At most one display update per agent per second: planning_state shares the urgent lane with action_command. */
export const STEP_STATUS_MIN_INTERVAL_MS = 1_000;
// Below this many characters the objective would say nothing, so the heading or route is dropped instead.
const MIN_OBJECTIVE_CHARS = 30;

/**
 * The player's short form of LiveTaskViews.doingLine: without the "Doing: " prefix and without the "last: ..." part
 * (the action bar already names the running action). When the line is too long, the objective is shortened first so
 * the route or heading still shows. Returns sanitised text, '' when there is nothing to show.
 */
export function stepStatusLine(doingLine) {
	if (typeof doingLine !== 'string') return '';
	const [objective = '', ...rest] = doingLine.replace(/^Doing:\s*/, '').split('; ');
	const tail = rest.filter(part => !part.startsWith('last: ')).join('; ');
	const full = sanitizeStepStatus(tail ? `${objective}; ${tail}` : objective);
	if (full.length < STEP_STATUS_MAX_LENGTH || !tail) return full;
	const budget = STEP_STATUS_MAX_LENGTH - sanitizeStepStatus(tail).length - 3;
	if (budget < MIN_OBJECTIVE_CHARS) return sanitizeStepStatus(objective);
	const short = sanitizeStepStatus(objective).slice(0, budget).replace(/[\uD800-\uDBFF]$/, '').trimEnd();
	return sanitizeStepStatus(`${short}…; ${tail}`);
}

/**
 * Sends the step line to Minecraft as planning_state.stepStatus. It sends nothing for a connection epoch and goal
 * revision until the coordinator's own planning_state for them went out (arm), because any planning_state moves a
 * STARTING agent to PLANNING. Repeats of the same (epoch, revision, text) are dropped; a changed line inside the
 * rate window waits for the next update. Delivery is display-only, so every send failure is swallowed.
 */
export class StepStatusPublisher {
	#send;
	#line;
	#now;
	#minIntervalMs;
	#armed = new Map();
	#sent = new Map();

	constructor({ send, line, now = () => Date.now(), minIntervalMs = STEP_STATUS_MIN_INTERVAL_MS }) {
		if (typeof send !== 'function' || typeof line !== 'function') throw new TypeError('StepStatusPublisher needs send and line functions');
		this.#send = send;
		this.#line = line;
		this.#now = now;
		this.#minIntervalMs = minIntervalMs;
	}

	/** The coordinator's own planning_state for this epoch and revision was sent; status updates may follow it. */
	arm(record, connectionEpoch) {
		this.#armed.set(record.agentId, { connectionEpoch, goalRevision: record.goalRevision });
		this.update(record, connectionEpoch, { force: true });
	}

	update(record, connectionEpoch, { force = false } = {}) {
		const armed = this.#armed.get(record.agentId);
		if (!armed || armed.connectionEpoch !== connectionEpoch || armed.goalRevision !== record.goalRevision) return false;
		let text;
		try { text = stepStatusLine(this.#line(record)); } catch { return false; }
		const last = this.#sent.get(record.agentId);
		const same = last && last.connectionEpoch === connectionEpoch && last.goalRevision === record.goalRevision;
		if (same && last.text === text) return false;
		if (!same && text === '') return false;
		const now = this.#now();
		if (!force && same && now - last.at < this.#minIntervalMs) return false;
		this.#sent.set(record.agentId, { connectionEpoch, goalRevision: record.goalRevision, text, at: now });
		const state = typeof record.state === 'string' && /^[A-Z_]{1,32}$/.test(record.state) ? record.state : 'PLANNING';
		try {
			Promise.resolve(this.#send(connectionEpoch, record.agentId, { goalRevision: record.goalRevision, state, stepStatus: text })).catch(() => {});
		} catch { /* display only */ }
		return true;
	}

	forget(agentId) {
		this.#armed.delete(agentId);
		this.#sent.delete(agentId);
	}
}
