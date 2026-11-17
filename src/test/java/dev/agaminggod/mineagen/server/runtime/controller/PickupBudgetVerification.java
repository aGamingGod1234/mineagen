package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

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
		verifyRouteLimit();
		verifyWalkIsOnThePickupBudget();
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

	/**
	 * A drop on a ledge 8 blocks off whose only way up is a stair 12 blocks along and back: about 30 blocks of walk. The
	 * straight line gave 8.8 s; the planned route's length gives the walk its time.
	 */
	private static void verifyRouteLimit() {
		List<GridPosition> straight = new ArrayList<>();
		for (int x = 1; x <= 8; x++) straight.add(new GridPosition(x, 64, 0));
		check(Math.abs(PickupBudget.routeBlocks(0.5D, 64.0D, 0.5D, straight) - 8.0D) < 1.0E-9D, "a straight route is its distance");
		List<GridPosition> ledge = new ArrayList<>();
		for (int z = 1; z <= 12; z++) ledge.add(new GridPosition(0, 64, z));
		for (int x = 1; x <= 8; x++) ledge.add(new GridPosition(x, 64 + Math.min(x, 3), 12));
		for (int z = 11; z >= 0; z--) ledge.add(new GridPosition(8, 67, z));
		double blocks = PickupBudget.routeBlocks(0.5D, 64.0D, 0.5D, ledge);
		long start = PickupBudget.walkLimitMs(8.0D, 30_000L);
		long limit = PickupBudget.routeLimitMs(start, blocks, 30_000L);
		System.out.printf("K3 metric: ledge drop 8 blocks off, %.0f blocks of route: walk limit %.1f s (straight line gave %.1f s)%n", blocks, limit / 1000.0D,
				start / 1000.0D);
		check(blocks > 30.0D && limit == PickupBudget.walkLimitMs(blocks, 30_000L) && limit > blocks / 4.3D * 1_000L * 2.0D,
				"the route's length sets the limit, with room for a detour: " + limit);
		check(PickupBudget.routeLimitMs(start, 3.0D, 30_000L) == start, "a route shorter than the straight line never shortens the limit");
		check(PickupBudget.routeLimitMs(start, 200.0D, 30_000L) == 30_000L, "never past the call's own timeout");
		check(PickupBudget.routeBlocks(0.5D, 64.0D, 0.5D, List.of()) == 0.0D, "no route, no length");
	}

	/** The walk the controller starts runs on the pickup's stall budget, over seen cells only (not the shared 4 s and three replans). */
	private static void verifyWalkIsOnThePickupBudget() {
		for (int spent : new int[] {0, 1}) {
			ServerNavigationController walk = ServerItemPickupController.walk(new Vec3(4.5D, 64.0D, 0.5D), new AABB(3, 64, 0, 5, 65, 1), 0L, 30_000L, spent,
					false, false, 64.0D);
			check(field(walk, "stallTimeoutMs").equals(PickupBudget.STALL_MS) && field(walk, "maxReplans").equals(PickupBudget.replansLeft(spent))
					&& field(walk, "seenRouteOnly").equals(true), "the pickup walk has the pickup's own stall budget after " + spent + " replans");
		}
	}

	private static Object field(Object target, String name) {
		try {
			java.lang.reflect.Field field = target.getClass().getDeclaredField(name);
			field.setAccessible(true);
			return field.get(target);
		} catch (ReflectiveOperationException failure) {
			throw new AssertionError(failure);
		}
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
