package dev.agaminggod.mineagen.server.runtime.controller;

/**
 * pick_up_item's walk budget (issue #2 K3), server-free. Metric: worst-case seconds a doomed pickup walk runs before it
 * hands back. A walk that stalls, gains a little after each replan and stalls again ran four 4 s stall windows on the
 * shared budget (16 s, recorded PATH_BLOCKED p50 17.8 s); pass bar 7 s or less. A walk that keeps creeping without
 * arriving is capped by distance (was the call's 30 s); pass bar 10 s or less for a drop within 10 blocks.
 */
public final class PickupBudgetVerification {
	private static final long TICK_MS = 50L;
	private static int assertions;

	private PickupBudgetVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PickupBudgetVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifyWalkLimit();
		verifyReplansAcrossWalks();
		verifyStalledWalk();
		return assertions;
	}

	private static void verifyWalkLimit() {
		check(PickupBudget.walkLimitMs(0.0D, 30_000L) == 4_000L, "a drop at the feet still has 4 s for its landing and pickup delay");
		check(PickupBudget.walkLimitMs(8.0D, 30_000L) == 8_800L, "8 blocks: 4 s + 0.6 s a block");
		check(PickupBudget.walkLimitMs(10.0D, 30_000L) <= 10_000L, "a drop within 10 blocks gets at most 10 s");
		check(PickupBudget.walkLimitMs(60.0D, 30_000L) == 30_000L, "never past the call's own timeout");
		check(PickupBudget.walkLimitMs(20.0D, 10_000L) == 10_000L, "a caller's shorter timeout (barter, kill drops) still rules");
		check(PickupBudget.walkLimitMs(Double.NaN, 30_000L) == 4_000L, "an unknown distance gets the base");
		// A clear walk at 4.3 blocks a second fits inside the limit with room for a detour.
		for (double blocks : new double[] { 1.0D, 5.0D, 16.0D, 32.0D })
			check(blocks / 4.3D * 1_000L * 2.0D < PickupBudget.walkLimitMs(blocks, 30_000L), "a walk twice the straight line fits at " + blocks + " blocks");
	}

	private static void verifyReplansAcrossWalks() {
		check(PickupBudget.replansLeft(0) == 1, "the first walk may replan once");
		check(PickupBudget.replansLeft(1) == 0, "a walk planned again for a moved drop gets no fresh replans");
		check(PickupBudget.replansLeft(5) == 0, "never negative");
	}

	/** The metric: the stall budget a doomed walk spends, with a small gain after every replan as recorded walks had. */
	private static void verifyStalledWalk() {
		double shared = stalledWalkSeconds(4_000L, 3);
		double pickup = stalledWalkSeconds(PickupBudget.STALL_MS, PickupBudget.REPLANS);
		double creeping = PickupBudget.walkLimitMs(8.0D, 30_000L) / 1000.0D;
		System.out.printf("K3 metric: doomed pickup walk %.1f s on the pickup budget (shared budget %.1f s); creeping walk to a drop 8 blocks away capped at %.1f s (was 30 s)%n",
				pickup, shared, creeping);
		check(shared >= 15.0D, "the shared budget reproduces the recorded ~16-18 s doomed walk: " + shared);
		check(pickup <= 7.0D, "the pickup budget hands a doomed walk back within 7 s: " + pickup);
		check(creeping <= 10.0D, "a creeping walk to a drop 8 blocks away ends within 10 s: " + creeping);
	}

	private static double stalledWalkSeconds(long stallMs, int replans) {
		WaypointProgress progress = new WaypointProgress(5.0D, 0L, stallMs, replans);
		double distance = 5.0D;
		for (long now = TICK_MS; now <= 60_000L; now += TICK_MS) {
			WaypointProgress.Update update = progress.observe(distance, false, now);
			if (update.decision() == WaypointProgress.Decision.FAIL) return now / 1000.0D;
			if (update.decision() == WaypointProgress.Decision.REPLAN) {
				distance -= 0.5D;
				progress.replanned(distance, now);
			}
		}
		throw new AssertionError("a stalled walk never failed");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
