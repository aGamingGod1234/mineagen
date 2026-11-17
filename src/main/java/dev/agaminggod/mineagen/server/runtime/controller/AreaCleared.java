package dev.agaminggod.mineagen.server.runtime.controller;

/**
 * fight_until's cleared area: after at least one kill, a look around that finds no mob of the type left ends the call
 * with what it got, as a player who has cleared a herd moves on, instead of looking around the empty area for the full
 * {@link ServerFightUntilController#NO_TARGET_MS}. The quiet time starts at the first tick of looking around after the
 * last seen target or the last tick the body was busy (walking back to its spot, drops waiting for a hostile to leave, a
 * passed-over mob still in view), and restarts after ticks spent elsewhere; the look-around turns count from then too,
 * so a mob behind the body is looked for before the area counts as cleared.
 */
final class AreaCleared {
	/** The look around takes at least this long. */
	static final long MIN_QUIET_MS = 3_000L;
	/** A look around whose turns are held up still ends here. */
	static final long MAX_QUIET_MS = 5_000L;
	/** Look-around turns that make a full circle (60 degrees each). */
	static final int SWEEP_TURNS = 6;
	/** A gap this long between looking-around ticks means the body was doing something else (a hunt walk, a perch). */
	static final long GAP_MS = 250L;

	private long busyMs = -1L;
	private long quietFrom = Long.MIN_VALUE;
	private long quietStartMs;
	private long lastObservedMs = Long.MIN_VALUE / 2;
	private int fromStep;

	/**
	 * Zero kills keeps the long wait (nothing was found yet, so the herd may still come into view). Blazes keep it too:
	 * they come from fortress spawners, which keep making more, and nothing handles spawners yet. So does roof:true: from
	 * inside the shelter the body sees out only through its doorway, so a look around there cannot show the area clear.
	 */
	static boolean applies(int kills, boolean waitsForMore) {
		return kills > 0 && !waitsForMore;
	}

	/** The body walked or waited this tick instead of looking around. */
	void busy(long elapsedMs) {
		busyMs = elapsedMs;
	}

	/**
	 * One tick of looking around between targets, before its turn. Returns how long the body has looked around once the
	 * area counts as cleared, else -1.
	 */
	long observe(int kills, boolean waitsForMore, long elapsedMs, long lastTargetMs, boolean busyNow, int lookStep) {
		if (!applies(kills, waitsForMore)) return -1L;
		if (busyNow) busyMs = elapsedMs;
		long from = Math.max(lastTargetMs, busyMs);
		if (from != quietFrom || elapsedMs - lastObservedMs > GAP_MS) {
			quietFrom = from;
			quietStartMs = elapsedMs;
			fromStep = lookStep;
		}
		lastObservedMs = elapsedMs;
		long quietMs = elapsedMs - quietStartMs;
		return cleared(quietMs, lookStep - fromStep) ? quietMs : -1L;
	}

	static boolean cleared(long quietMs, int sweepTurns) {
		return quietMs >= MAX_QUIET_MS || quietMs >= MIN_QUIET_MS && sweepTurns >= SWEEP_TURNS;
	}
}
