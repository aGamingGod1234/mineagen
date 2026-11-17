import { EventEmitter } from 'node:events';

export class DecisionEvalRenderError extends Error {
	constructor(code, message, details = {}) {
		super(message);
		this.code = code;
		Object.assign(this, details);
	}
}

/**
 * Date.now follows a virtual clock while fn runs, and the coordinator's supervision timers run on it: a timer fires
 * when the replay moves the clock past its due time, in due order. Renders therefore run one at a time.
 */
let clockDepth = 0;
export async function withVirtualClock(start, fn) {
	if (clockDepth > 0) throw new DecisionEvalRenderError('RENDER_BUSY', 'decision-eval renders share the process clock; run them sequentially');
	const realNow = Date.now;
	let sequence = 0;
	const timers = new Map();
	const clock = {
		now: start,
		schedule: (callback, delay) => {
			const handle = { id: ++sequence };
			timers.set(handle.id, { handle, callback, due: clock.now + Math.max(0, Number(delay) || 0) });
			return handle;
		},
		cancel: (handle) => { timers.delete(handle?.id); },
		async advanceTo(time) {
			let fired = 0;
			for (;;) {
				const next = [...timers.values()].filter((timer) => timer.due <= time).sort((a, b) => a.due - b.due || a.handle.id - b.handle.id)[0];
				if (next === undefined) break;
				timers.delete(next.handle.id);
				if (next.due > clock.now) clock.now = next.due;
				await next.callback();
				await settle();
				fired += 1;
			}
			if (time > clock.now) clock.now = time;
			return fired;
		},
		async fireNext() {
			const next = [...timers.values()].sort((a, b) => a.due - b.due || a.handle.id - b.handle.id)[0];
			if (next === undefined) return false;
			await clock.advanceTo(next.due);
			return true;
		},
	};
	clockDepth += 1;
	Date.now = () => clock.now;
	try { return await fn(clock); } finally { Date.now = realNow; clockDepth -= 1; }
}

export class HarnessBridge extends EventEmitter {
	sent = [];
	constructor({ inspection = null } = {}) { super(); this.inspection = inspection; }
	count(type) { return this.sent.reduce((total, message) => total + (message.type === type ? 1 : 0), 0); }
	start() {}
	stop() {}
	async send(type, agentId, payload) {
		this.sent.push({ type, agentId, payload });
		// Rendering has no live server and defaults to unavailable inspection. A caller may supply
		// a recorded-fact inspection adapter; its reconstruction scope belongs in that caller's report.
		if (type === 'inspection_request') {
			const response = this.inspection?.(payload.query, { agentId, payload });
			queueMicrotask(() => this.emit('inspection_result', { agentId, connectionEpoch: 1, payload: {
				requestId: payload.requestId, goalRevision: payload.goalRevision,
				...(response ?? { error: { code: 'INSPECTION_UNAVAILABLE', message: 'decision-eval replay has no live server' } }),
			} }));
		}
	}
}

/** Collects coordinator trace events; replay steps wait on them instead of on wall time. */
export class TraceLog {
	events = [];
	#waiters = new Set();
	write(event, fields) {
		this.events.push({ event, fields });
		for (const waiter of this.#waiters) waiter();
	}
	count(event) { return this.events.reduce((total, row) => total + (row.event === event ? 1 : 0), 0); }
	until(predicate, timeoutMs) {
		if (predicate()) return Promise.resolve(true);
		return new Promise((resolve) => {
			const check = () => { if (predicate()) { cleanup(); resolve(true); } };
			const timer = setTimeout(() => { cleanup(); resolve(false); }, timeoutMs);
			const cleanup = () => { clearTimeout(timer); this.#waiters.delete(check); };
			this.#waiters.add(check);
		});
	}
}

/** A planner that hands each native turn to the replay instead of a provider. */
export class ReplayPlanner {
	turns = [];
	#waiters = [];
	constructor(registry) { this.registry = registry; }
	beginReconcile(records, options) {
		const registry = this.registry.reconcile(records, options);
		return { registry, complete: Promise.resolve({ registry, providers: { valid: registry.records, invalid: [], catalog: { models: [] } } }) };
	}
	async reconcile(records) { return this.beginReconcile(records).complete; }
	async requestPlan() { throw new DecisionEvalRenderError('RENDER_UNSUPPORTED', 'decision-eval renders native tool agents only'); }
	requestGoalSpec() { return new Promise(() => {}); }
	cancelGoalSpec() { return true; }
	async interrupt() {}
	async remove(agentId) { return this.registry.remove(agentId); }
	requestNativeTurn(request) {
		let finish;
		const done = new Promise((resolve) => { finish = resolve; });
		const turn = { request, finish, done };
		this.turns.push(turn);
		for (const waiter of this.#waiters.splice(0)) waiter();
		return done;
	}
	nextTurn(timeoutMs) {
		return new Promise((resolve) => {
			const timer = setTimeout(() => resolve(false), timeoutMs);
			this.#waiters.push(() => { clearTimeout(timer); resolve(true); });
		});
	}
}

export const idleProvider = { catalog: { stale: false, refresh: async () => ({ models: [] }), assertSupported() {} }, async start() {}, async stop() {} };

export async function settle(ticks = 20) {
	for (let index = 0; index < ticks; index += 1) await new Promise((resolve) => setImmediate(resolve));
}
