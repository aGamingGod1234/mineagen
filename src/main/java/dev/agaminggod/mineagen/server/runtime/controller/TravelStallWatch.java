package dev.agaminggod.mineagen.server.runtime.controller;

/**
 * travel_to's stall watchdog: feet that move under a block in {@link #WINDOW_TICKS} ticks, with no block placed or
 * mined in that time, end the trip with STALLED_IN_PLACE instead of cycling through failed legs and looks until the
 * trip's 60 s no-closer limit. Digging and building count apart from standing still: a body tunnelling, bridging or
 * pillaring moves slowly between blocks, and a hard block can take longer than the window to mine, so a placed block or
 * a tick of mining restarts the window. The window counts the trip's own ticks, so a reflex pause or server lag does
 * not trip it; {@link #reset} restarts it where the trip lets the body stand on purpose (a fight, the portal wait).
 */
final class TravelStallWatch {
	/** Feet this far from where the window started (any direction: a pillar or a staircase moves up or down) are moving. */
	static final double MOVE_BLOCKS = 1.0D;
	/** About 10 s at 20 ticks a second. */
	static final int WINDOW_TICKS = 200;

	enum Verdict { MOVED, WORKED, STILL, STALLED }

	private boolean anchored;
	private double anchorX, anchorY, anchorZ;
	private long anchorTick;
	private long lastWork;
	private long workHolds;

	void reset() {
		anchored = false;
	}

	/**
	 * One trip tick: {@code work} is a count the trip raises whenever the body places a block or mines (any increase is
	 * work since the last tick).
	 */
	Verdict observe(long tick, double x, double y, double z, long work) {
		if (!anchored || moved(x, y, z) >= MOVE_BLOCKS) {
			anchored = true;
			anchorX = x;
			anchorY = y;
			anchorZ = z;
			anchorTick = tick;
			lastWork = work;
			return Verdict.MOVED;
		}
		if (work != lastWork) {
			lastWork = work;
			anchorTick = tick;
			workHolds++;
			return Verdict.WORKED;
		}
		return tick - anchorTick >= WINDOW_TICKS ? Verdict.STALLED : Verdict.STILL;
	}

	/** Blocks the feet are from where the window started. */
	double moved(double x, double y, double z) {
		double dx = x - anchorX, dy = y - anchorY, dz = z - anchorZ;
		return Math.sqrt(dx * dx + dy * dy + dz * dz);
	}

	/** Ticks the window has run without movement or work. */
	long stillTicks(long tick) {
		return anchored ? tick - anchorTick : 0L;
	}

	/** Ticks on which digging or building kept the window open. */
	long workHolds() {
		return workHolds;
	}
}
