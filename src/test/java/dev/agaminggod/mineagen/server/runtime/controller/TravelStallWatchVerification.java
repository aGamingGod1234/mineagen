package dev.agaminggod.mineagen.server.runtime.controller;

/**
 * travel_to's stall watchdog (issue #2 K4), server-free. Metric: seconds a body standing in place waits before the trip
 * reports it (was up to STALL_MS, 60 s; pass bar 10 s), while a body tunnelling, bridging, pillaring or mining one hard
 * block never trips it.
 */
public final class TravelStallWatchVerification {
	private static int assertions;

	private TravelStallWatchVerification() {
	}

	public static void main(String[] args) {
		System.out.println("TravelStallWatchVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifyStandingStill();
		verifyWorkIsNotStanding();
		verifyResets();
		return assertions;
	}

	private static void verifyStandingStill() {
		long still = ticksToStall((tick, at) -> { }, 0L);
		long jitter = ticksToStall((tick, at) -> at[0] = 0.45D * Math.sin(tick / 7.0D), 0L);
		long legLoop = ticksToStall((tick, at) -> at[0] = (tick / 40) % 2 == 0 ? 0.0D : 0.9D, 0L);
		System.out.printf("K4 metric: a body standing in place reports after %.1f s (jittering %.1f s, failed legs going nowhere %.1f s); was up to %.0f s%n",
				still / 20.0D, jitter / 20.0D, legLoop / 20.0D, ServerTravelController.STALL_MS / 1000.0D);
		check(still == TravelStallWatch.WINDOW_TICKS, "standing still stops at the 10 s window: " + still);
		check(jitter == TravelStallWatch.WINDOW_TICKS, "shuffling under a block is still standing in place: " + jitter);
		check(legLoop == TravelStallWatch.WINDOW_TICKS, "legs that end where they began are standing in place: " + legLoop);
		check(TravelStallWatch.WINDOW_TICKS * 50L < ServerTravelController.STALL_MS, "the watchdog reports before the 60 s no-closer limit");
	}

	private static void verifyWorkIsNotStanding() {
		// Tunnel: mine the head and feet cells (25 ticks each, attack held), then step one block on (6 ticks).
		check(ticksToStall((tick, at) -> at[0] = (tick / 56) * 1.0D, 0L, tick -> tick % 56 < 50) < 0L, "a tunnelling body is not stalled");
		// One block that takes 15 s to mine with the tool at hand, the feet on one block the whole time.
		check(ticksToStall((tick, at) -> { }, 0L, tick -> tick < 300) == 299L + TravelStallWatch.WINDOW_TICKS,
				"a 15 s mine holds the window open; standing after it counts from its last tick");
		// Bridge: a block placed every 40 ticks, a step onto it 10 ticks later, sneaking slowly.
		check(ticksToStall((tick, at) -> at[0] = tick / 40 * 1.0D, 0L, tick -> tick % 40 == 30) < 0L, "a bridging body is not stalled");
		// Pillar: up a block every 15 ticks, a block placed under the feet each jump.
		check(ticksToStall((tick, at) -> at[1] = tick / 15 * 1.0D, 0L, tick -> tick % 15 == 8) < 0L, "a pillaring body is not stalled");
		// A bridge whose clicks never place: the window runs out.
		check(ticksToStall((tick, at) -> { }, 0L, tick -> false) == TravelStallWatch.WINDOW_TICKS, "a build that places nothing is standing still");
	}

	private static void verifyResets() {
		TravelStallWatch watch = new TravelStallWatch();
		for (long tick = 0L; tick < 150L; tick++) watch.observe(tick, 0, 64, 0, 0L);
		check(watch.observe(150L, 0, 64, 0, 1L) == TravelStallWatch.Verdict.WORKED, "a placed block is work");
		check(watch.workHolds() == 1L, "work holds are counted");
		check(watch.observe(349L, 0, 64, 0, 1L) == TravelStallWatch.Verdict.STILL, "the window restarts at the work");
		check(watch.observe(350L, 0, 64, 0, 1L) == TravelStallWatch.Verdict.STALLED, "and runs out 10 s after it");
		watch.reset();
		check(watch.observe(351L, 0, 64, 0, 1L) == TravelStallWatch.Verdict.MOVED, "a fight, the portal wait or a reflex pause restarts the window");
		check(watch.stillTicks(400L) == 49L, "still time counts from the restart");
		check(watch.observe(352L, 0, 65.2D, 0, 1L) == TravelStallWatch.Verdict.MOVED, "a block up or down is movement");
	}

	private interface Body { void at(long tick, double[] position); }
	private interface Work { boolean on(long tick); }

	private static long ticksToStall(Body body, long startWork) {
		return ticksToStall(body, startWork, tick -> false);
	}

	/** Ticks until STALLED for a body moving as {@code body} and working when {@code working}; -1 within 2000 ticks. */
	private static long ticksToStall(Body body, long startWork, Work working) {
		TravelStallWatch watch = new TravelStallWatch();
		long work = startWork;
		for (long tick = 0L; tick < 2_000L; tick++) {
			double[] at = { 0.0D, 64.0D, 0.0D };
			body.at(tick, at);
			if (working.on(tick)) work++;
			if (watch.observe(tick, at[0], at[1], at[2], work) == TravelStallWatch.Verdict.STALLED) return tick;
		}
		return -1L;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
