package dev.agaminggod.mineagen.server.runtime.controller;

/**
 * pick_up_item's own walk budget. With the shared navigation budget (4 s stalls, three replans) a walk that could not
 * reach its drop used about 18 s before it handed back; a drop is a few blocks away and in view, so a stalled walk gets
 * one replan, the whole walk a limit that grows with the drop's distance, and only a route over seen cells is walked.
 */
final class PickupBudget {
	/** No progress toward the next route cell for this long is a stall (a door opens in 1.5 s, a step up in under 1). */
	static final long STALL_MS = 3_000L;
	/** Replans over the whole pickup, however often the drop moves and the walk is planned again. */
	static final int REPLANS = 1;
	/** Turning, planning, a falling drop's landing and vanilla's pickup delay, before any distance is walked. */
	static final long BASE_MS = 4_000L;
	/** About 2.5 times a walk's pace (4.3 blocks a second), for steps, jumps and detours around what lies between. */
	static final long PER_BLOCK_MS = 600L;

	private PickupBudget() {
	}

	/** The walk's limit for a drop this far away, never more than the call's own timeout. */
	static long walkLimitMs(double distance, long timeoutMs) {
		if (timeoutMs <= 0L) throw new IllegalArgumentException("timeout must be positive");
		double blocks = Double.isFinite(distance) ? Math.max(0.0D, distance) : 0.0D;
		return Math.min(timeoutMs, BASE_MS + Math.round(PER_BLOCK_MS * blocks));
	}

	/**
	 * The walk's limit once its first route is planned: the limit for the route's length when that is longer than the
	 * straight line (a ledge drop 8 blocks off but 30 blocks round by the stairs), never shorter than the limit it had.
	 */
	static long routeLimitMs(long limitMs, double routeBlocks, long timeoutMs) {
		return Math.max(limitMs, walkLimitMs(routeBlocks, timeoutMs));
	}

	/** Blocks along a planned route of standing cells, from the body's position through each cell's middle. */
	static double routeBlocks(double fromX, double fromY, double fromZ, java.util.List<dev.agaminggod.mineagen.client.navigation.GridPosition> route) {
		double blocks = 0.0D, x = fromX, y = fromY, z = fromZ;
		for (var cell : route) {
			double nextX = cell.x() + 0.5D, nextY = cell.y(), nextZ = cell.z() + 0.5D;
			blocks += Math.sqrt((nextX - x) * (nextX - x) + (nextY - y) * (nextY - y) + (nextZ - z) * (nextZ - z));
			x = nextX;
			y = nextY;
			z = nextZ;
		}
		return blocks;
	}

	/** Replans a new walk may still use after the earlier walks of the same pickup used {@code spent}. */
	static int replansLeft(int spent) {
		return Math.max(0, REPLANS - Math.max(0, spent));
	}
}
