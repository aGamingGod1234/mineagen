/** FIFO admission with one waiting turn per agent and bounded cancellation-aware waiting. */
export class TtsAdmissionQueue {
	#canStart; #maxQueued; #waitMs; #active = 0; #waiting = []; #closed = false;
	constructor({ canStart, maxQueued = 10, waitMs = 250 }) {
		if (typeof canStart !== 'function') throw new TypeError('canStart is required');
		if (!Number.isSafeInteger(maxQueued) || maxQueued < 1 || maxQueued > 100) throw new TypeError('maxQueued is invalid');
		if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 2000) throw new TypeError('waitMs is invalid');
		this.#canStart = canStart; this.#maxQueued = maxQueued; this.#waitMs = waitMs;
	}
	get active() { return this.#active; }
	get waiting() { return this.#waiting.length; }
	acquire(agentId, signal) {
		agentId = String(agentId).toLowerCase();
		if (this.#closed || signal.aborted) return Promise.reject(signal.reason ?? capacity('Voice admission is closed'));
		if (this.#waiting.length === 0 && this.#canStart(this.#active)) return Promise.resolve(this.#grant());
		if (this.#waitMs === 0 || this.#waiting.length >= this.#maxQueued || this.#waiting.some(entry => entry.agentId === agentId)) {
			return Promise.reject(capacity('Speech admission queue is full for this agent'));
		}
		return new Promise((resolve, reject) => {
			const entry = {agentId, resolve, reject, cleanup: null};
			const remove = error => {
				const index = this.#waiting.indexOf(entry);
				if (index < 0) return;
				this.#waiting.splice(index, 1); entry.cleanup(); reject(error); this.pump();
			};
			const abort = () => remove(signal.reason ?? Object.assign(new Error('Speech cancelled'), {name:'AbortError'}));
			const timer = setTimeout(() => remove(capacity('Speech admission wait expired')), this.#waitMs);
			entry.cleanup = () => {clearTimeout(timer); signal.removeEventListener('abort', abort);};
			this.#waiting.push(entry); signal.addEventListener('abort', abort, {once:true});
			if (signal.aborted) abort();
		});
	}
	#grant() {
		this.#active++;
		let released = false;
		return () => {if (released) return; released = true; this.#active--; this.pump();};
	}
	pump() {
		while (!this.#closed && this.#waiting.length && this.#canStart(this.#active)) {
			const entry = this.#waiting.shift(); entry.cleanup(); entry.resolve(this.#grant());
		}
	}
	close() {
		this.#closed = true;
		for (const entry of this.#waiting.splice(0)) {entry.cleanup(); entry.reject(Object.assign(new Error('Speech admission closed'), {name:'AbortError'}));}
	}
}
function capacity(message) {return Object.assign(new Error(message), {code:'TTS_CAPACITY'});}
