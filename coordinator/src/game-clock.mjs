/**
 * The clock the native tool runtime times gameplay with: now() in epoch-like milliseconds, sleep(ms), and
 * setTimeout/clearTimeout. Production uses wall time (WALL_CLOCK). A fixture that runs the server at a raised tick rate
 * (/tick rate 60) passes gameClockFromObservations(), so a find, gather or obtain gets the same game time and checks for
 * sightings as often per game second as at 20 TPS. Traces and latency measurements stay on wall time.
 */

export const GAME_MS_PER_TICK = 50;

// Bound late to the globals, so a test that mocks timers after a runtime is built still drives it.
export const WALL_CLOCK = Object.freeze({
	now: () => Date.now(),
	// at(sample): when a sample was taken, on this clock's timeline, or null when it carries no time.
	at: (observation) => (Number.isFinite(observation?.observedAtEpochMs) ? observation.observedAtEpochMs : null),
	sleep: (ms) => new Promise((resolve) => { setTimeout(resolve, ms); }),
	setTimeout: (callback, ms, ...args) => setTimeout(callback, ms, ...args),
	clearTimeout: (handle) => clearTimeout(handle),
});

/**
 * A clock with all five methods: setTimeout/clearTimeout are built on sleep() when the clock has none, and a clock
 * without at() stamps every sample with its own now() (the time it reached the runtime).
 */
export function completeClock(clock) {
	if (clock === WALL_CLOCK) return clock;
	if (typeof clock?.now !== 'function' || typeof clock?.sleep !== 'function') throw new TypeError('clock must provide now() and sleep(ms)');
	if ((typeof clock.setTimeout === 'function') !== (typeof clock.clearTimeout === 'function')) throw new TypeError('clock.setTimeout and clock.clearTimeout come together');
	const timers = typeof clock.setTimeout === 'function' ? {
		setTimeout: (callback, ms, ...args) => clock.setTimeout(callback, ms, ...args),
		clearTimeout: (handle) => clock.clearTimeout(handle),
	} : {
		setTimeout: (callback, ms, ...args) => {
			const handle = { cancelled: false, unref() { return handle; }, ref() { return handle; } };
			Promise.resolve(clock.sleep(Math.max(0, ms))).then(() => { if (!handle.cancelled) callback(...args); });
			return handle;
		},
		clearTimeout: (handle) => { if (handle != null) handle.cancelled = true; },
	};
	return Object.freeze({
		now: () => clock.now(),
		at: typeof clock.at === 'function' ? (observation) => clock.at(observation) : () => clock.now(),
		sleep: (ms) => clock.sleep(ms),
		...timers,
		...(typeof clock.observe === 'function' ? { observe: (observation) => clock.observe(observation) } : {}),
	});
}

/**
 * Game time read from observation samples: each sample's world.gameTime (ticks, 50 ms each) against its
 * observedAtEpochMs. now() starts at wall time and then advances by the game ticks samples report, extrapolated between
 * samples at tickRate for at most maxExtrapolateMs of wall time, and never goes backwards. At 20 TPS on a healthy server
 * it tracks wall time; on a lagging server it falls behind it; on a frozen world (/tick freeze) gameTime stops, so now()
 * stops once the extrapolation cap runs out.
 *
 * Tick counts are per world: a sample from another world or dimension, or a gameTime that went backwards, re-anchors
 * with no time added. Samples older than the anchor, and samples from the anchor's own tick, change nothing.
 *
 * A timer or sleep fires when game time reaches it. It also fires after its own length in wall time once the clock is
 * starved (no sample has advanced gameTime for maxExtrapolateMs of wall time), so a timer never waits forever when
 * samples stop (a quiet leg pushes none, and the search's 2 s watcher is what asks for the next) or the world is frozen.
 * A slow server that still ticks is not starved: its timers stay on game time, as the body's tick-counted timeouts do.
 *
 * at(sample) puts a sample on the same timeline: from its gameTime when it is from the anchor's world and dimension,
 * else from its observedAtEpochMs scaled at tickRate from the anchor, never later than now(); null when it has neither.
 * Ages and windows the runtime measures between samples (a repeated failure's 60 s, a start sample's age) then count
 * game time, as their now() side does.
 */
export function gameClockFromObservations({ tickRate = 20, maxExtrapolateMs = 1_000, maxPollMs = 250, wallNow = () => Date.now() } = {}) {
	if (!(Number.isFinite(tickRate) && tickRate > 0)) throw new TypeError('tickRate must be a positive number');
	if (!(Number.isFinite(maxExtrapolateMs) && maxExtrapolateMs >= 0)) throw new TypeError('maxExtrapolateMs must be a nonnegative number');
	if (!(Number.isFinite(maxPollMs) && maxPollMs >= 1)) throw new TypeError('maxPollMs must be at least 1');
	const speed = tickRate / 20;
	const scopeOf = (observation) => `${observation?.world?.worldId ?? ''}:${observation?.world?.dimension ?? ''}`;
	// value: the game-paced ms at the anchor sample; wall: when that sample was taken (never later than now on this side).
	let anchor = null, last = -Infinity;
	const starved = () => anchor === null || wallNow() - anchor.wall > maxExtrapolateMs;
	const now = () => {
		const wall = wallNow();
		const value = anchor === null ? wall : anchor.value + Math.min(Math.max(0, wall - anchor.wall), maxExtrapolateMs) * speed;
		last = Math.max(last, value);
		return last;
	};
	const observe = (observation) => {
		const gameTime = observation?.world?.gameTime;
		if (!Number.isSafeInteger(gameTime)) return;
		const wall = Number.isFinite(observation?.observedAtEpochMs) ? Math.min(observation.observedAtEpochMs, wallNow()) : wallNow();
		const scope = scopeOf(observation);
		if (anchor === null) { anchor = { value: now(), gameTime, wall, scope }; return; }
		if (scope !== anchor.scope || gameTime < anchor.gameTime) { anchor = { value: now(), gameTime, wall, scope }; return; }
		if (wall < anchor.wall || gameTime === anchor.gameTime) return;
		anchor = { value: anchor.value + (gameTime - anchor.gameTime) * GAME_MS_PER_TICK, gameTime, wall, scope };
	};
	const at = (observation) => {
		const gameTime = observation?.world?.gameTime, wall = observation?.observedAtEpochMs;
		if (anchor === null) return Number.isFinite(wall) ? Math.min(wall, now()) : null;
		if (Number.isSafeInteger(gameTime) && scopeOf(observation) === anchor.scope) return Math.min(anchor.value + (gameTime - anchor.gameTime) * GAME_MS_PER_TICK, now());
		return Number.isFinite(wall) ? Math.min(anchor.value + (wall - anchor.wall) * speed, now()) : null;
	};
	const setGameTimeout = (callback, ms, ...args) => {
		const length = Math.max(0, Number.isFinite(ms) ? ms : 0);
		const due = now() + length, wallDue = wallNow() + length;
		const handle = { timer: null, unrefed: false, cancelled: false,
			unref() { handle.unrefed = true; handle.timer?.unref?.(); return handle; },
			ref() { handle.unrefed = false; handle.timer?.ref?.(); return handle; } };
		const schedule = (wait) => {
			handle.timer = setTimeout(check, wait);
			if (handle.unrefed) handle.timer.unref?.();
		};
		const check = () => {
			if (handle.cancelled) return;
			const gameLeft = due - now(), wallLeft = wallDue - wallNow();
			if (gameLeft <= 0 || (wallLeft <= 0 && starved())) { handle.timer = null; callback(...args); return; }
			schedule(Math.max(1, Math.min(gameLeft / speed, wallLeft > 0 ? wallLeft : maxPollMs, maxPollMs)));
		};
		schedule(Math.max(0, Math.min(length / speed, maxPollMs)));
		return handle;
	};
	const clearGameTimeout = (handle) => {
		if (handle == null || typeof handle !== 'object') return;
		handle.cancelled = true;
		if (handle.timer !== null) clearTimeout(handle.timer);
		handle.timer = null;
	};
	return {
		tickRate,
		now,
		at,
		observe,
		sleep: (ms) => new Promise((resolve) => { setGameTimeout(resolve, ms); }),
		setTimeout: setGameTimeout,
		clearTimeout: clearGameTimeout,
	};
}
