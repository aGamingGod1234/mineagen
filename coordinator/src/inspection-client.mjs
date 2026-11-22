import { randomUUID } from 'node:crypto';

/** Correlates bounded read requests with the exact server sample, never a cached heartbeat. */
export class InspectionClient {
	#bridge;
	#pending = new Map();
	#pausedAt = null;
	constructor(bridge) { this.#bridge = bridge; }
	/**
	 * A paused single-player server answers no inspection until it resumes: no request times out while paused, and on
	 * resume each gets the time it had left (a find or obtain step observing as Esc opened failed after 10 s otherwise).
	 */
	serverPaused(paused) {
		if (paused === (this.#pausedAt !== null)) return false;
		const now = Date.now();
		if (paused) {
			this.#pausedAt = now;
			for (const request of this.#pending.values()) {
				clearTimeout(request.timer);
				request.timer = null;
				request.remainingMs = Math.max(1, request.dueAt - now);
			}
			return true;
		}
		this.#pausedAt = null;
		for (const [requestId, request] of this.#pending) this.#arm(requestId, request, request.remainingMs ?? Math.max(1, request.dueAt - now));
		return true;
	}
	#arm(requestId, request, timeoutMs) {
		request.dueAt = Date.now() + timeoutMs;
		request.remainingMs = timeoutMs;
		if (this.#pausedAt !== null) { request.timer = null; return; }
		request.timer = setTimeout(() => {
			if (this.#pending.get(requestId) !== request) return;
			this.#pending.delete(requestId);
			request.reject(Object.assign(new Error('Fresh server inspection timed out'), { code: 'INSPECTION_TIMEOUT' }));
		}, timeoutMs);
		request.timer.unref?.();
	}
	request(record, query, { timeoutMs = 10_000, connectionEpoch } = {}) {
		const { agentId, goalRevision } = record;
		query = structuredClone(query);
		if (this.#pending.size >= 64) return Promise.reject(Object.assign(new Error('Too many pending inspections'), { code: 'INSPECTION_BUSY' }));
		const requestId = randomUUID();
		return new Promise((resolve, reject) => {
			const request = { agentId, goalRevision, resolve, reject, timer: null };
			this.#pending.set(requestId, request);
			this.#arm(requestId, request, timeoutMs);
			Promise.resolve().then(() => {
				if (!this.#pending.has(requestId)) return;
				return this.#bridge.send('inspection_request', agentId, { requestId, goalRevision, query }, { connectionEpoch });
			}).catch((error) => {
				clearTimeout(request.timer);
				this.#pending.delete(requestId);
				reject(error);
			});
		});
	}
	accept(message) {
		const request = this.#pending.get(message.payload.requestId);
		if (!request || request.agentId !== message.agentId || request.goalRevision !== message.payload.goalRevision) return false;
		this.#pending.delete(message.payload.requestId);
		clearTimeout(request.timer);
		if (message.payload.error) request.reject(Object.assign(new Error(message.payload.error.message), { code: message.payload.error.code }));
		else request.resolve(message.payload.result);
		return true;
	}
	cancel(agentId, reason = 'INSPECTION_CANCELLED') {
		for (const [key, request] of this.#pending) {
			if (agentId !== undefined && request.agentId !== agentId) continue;
			clearTimeout(request.timer);
			this.#pending.delete(key);
			request.reject(Object.assign(new Error('Inspection authority ended'), { code: reason }));
		}
	}
}
