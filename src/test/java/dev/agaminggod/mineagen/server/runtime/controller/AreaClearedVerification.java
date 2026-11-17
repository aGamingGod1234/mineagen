package dev.agaminggod.mineagen.server.runtime.controller;

/**
 * fight_until's cleared area (issue #2 K2), server-free: the no-target wait after a kill. Metric: seconds the body spends
 * looking around an empty area after its last target before the call hands back (was 30 s; pass bar 5 s or less).
 */
public final class AreaClearedVerification {
	private static final long TICK_MS = 50L;
	private static int assertions;

	private AreaClearedVerification() {
	}

	public static void main(String[] args) {
		System.out.println("AreaClearedVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifyGates();
		verifyQuietWait();
		verifyBusyHoldsTheWait();
		return assertions;
	}

	private static void verifyGates() {
		check(!AreaCleared.applies(0, false), "zero kills keeps the 30 s no-target wait");
		check(!AreaCleared.applies(3, true), "blazes keep the 30 s wait (spawners keep making more)");
		check(AreaCleared.applies(1, false), "one kill of any other mob ends a cleared area early");
		check(!AreaCleared.cleared(2_950L, 12), "never before 3 s, however many turns");
		check(!AreaCleared.cleared(4_000L, 5), "not before a full circle of turns");
		check(AreaCleared.cleared(3_000L, 6), "3 s and a full circle");
		check(AreaCleared.cleared(5_000L, 0), "5 s even when the turns were held up");
		check(AreaCleared.MAX_QUIET_MS < ServerFightUntilController.NO_TARGET_MS, "the cleared end comes before the no-target end");
	}

	/** The metric: a 60-degree eased turn settles in about 4 ticks; one held up runs to its 40-tick guard. */
	private static void verifyQuietWait() {
		long typical = secondsToClear(1, false, 4);
		long slow = secondsToClear(1, false, ServerLookController.MAX_TURN_TICKS);
		System.out.printf("K2 metric: no-target wait after a kill %.1f s (turns of 4 ticks), %.1f s (turns of %d ticks); was %.1f s%n",
				typical / 1000.0D, slow / 1000.0D, ServerLookController.MAX_TURN_TICKS, ServerFightUntilController.NO_TARGET_MS / 1000.0D);
		check(typical >= 3_000L && typical <= 5_000L, "a cleared area ends within 3 to 5 s with ordinary turns: " + typical);
		check(slow >= 3_000L && slow <= 5_000L, "and within 5 s with held-up turns: " + slow);
		check(secondsToClear(0, false, 4) < 0L, "zero kills: no early end (the 30 s no-target wait runs as before)");
		check(secondsToClear(2, true, 4) < 0L, "blaze: no early end");
	}

	/** Walking back to the spot, drops waiting on a hostile, or a passed-over mob in view: the quiet time starts after. */
	private static void verifyBusyHoldsTheWait() {
		AreaCleared area = new AreaCleared();
		long lastTarget = 10_000L;
		int step = 0;
		long ended = -1L;
		for (long elapsed = lastTarget + TICK_MS; elapsed <= lastTarget + 20_000L && ended < 0L; elapsed += TICK_MS) {
			if (elapsed <= lastTarget + 8_000L) { area.busy(elapsed); continue; }
			ended = area.observe(1, false, elapsed, lastTarget, false, step);
			if ((elapsed / TICK_MS) % 4 == 0) step++;
			if (ended >= 0L) ended = elapsed - lastTarget;
		}
		check(ended >= 8_000L + AreaCleared.MIN_QUIET_MS && ended <= 8_000L + AreaCleared.MAX_QUIET_MS,
				"8 s walking back, then a full 3 to 5 s look around: " + ended);

		AreaCleared waiting = new AreaCleared();
		long quiet = -1L;
		for (long elapsed = lastTarget + TICK_MS; elapsed <= lastTarget + 10_000L; elapsed += TICK_MS)
			quiet = Math.max(quiet, waiting.observe(1, false, elapsed, lastTarget, true, (int) (elapsed / 200L)));
		check(quiet < 0L, "drops waiting on a hostile, or a passed-over mob in view, keep the area from counting as cleared");

		AreaCleared seenAgain = new AreaCleared();
		long target = 0L;
		long end = -1L;
		int turns = 0;
		for (long elapsed = TICK_MS; elapsed <= 20_000L && end < 0L; elapsed += TICK_MS) {
			if (elapsed == 2_000L) target = elapsed;
			long quietMs = seenAgain.observe(1, false, elapsed, target, false, turns);
			if ((elapsed / TICK_MS) % 4 == 0) turns++;
			if (quietMs >= 0L) end = elapsed;
		}
		check(end >= 2_000L + AreaCleared.MIN_QUIET_MS, "a target seen again restarts the look around: " + end);
	}

	/** Ms from the last target until the area counts as cleared, a turn finishing every turnTicks; -1 within 30 s. */
	private static long secondsToClear(int kills, boolean blaze, int turnTicks) {
		AreaCleared area = new AreaCleared();
		long lastTarget = 40_000L;
		int step = 0;
		for (long elapsed = lastTarget + TICK_MS; elapsed - lastTarget < ServerFightUntilController.NO_TARGET_MS; elapsed += TICK_MS) {
			if (area.observe(kills, blaze, elapsed, lastTarget, false, step) >= 0L) return elapsed - lastTarget;
			if (((elapsed - lastTarget) / TICK_MS) % turnTicks == 0) step++;
		}
		return -1L;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
