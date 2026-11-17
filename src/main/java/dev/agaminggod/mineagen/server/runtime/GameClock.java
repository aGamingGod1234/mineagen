package dev.agaminggod.mineagen.server.runtime;

/**
 * The body's clock: milliseconds of game time, 50 per server tick. Action timeouts, stall limits, controller deadlines
 * and reported action durations read it, so they keep their nominal length at 20 TPS, stretch with a lagging server
 * (a 20 s dig gets its 400 ticks of digging, not 20 s of wall time at 10 TPS) and shrink with {@code /tick rate}.
 *
 * <p>It starts at the wall time of the first server tick it sees and adds 50 ms per tick after that, so at a steady
 * 20 TPS it stays close to the wall clock. It is not a timestamp: anything sent to the coordinator as an epoch time
 * (observedAtEpochMs, completedAtEpochMs, latency timelines) keeps reading {@link System#currentTimeMillis()}.
 * Before any server tick (unit tests, a stopped server) it reads the wall clock.
 */
public final class GameClock {
	public static final long MS_PER_TICK = 50L;

	private static final Object LOCK = new Object();
	private static long anchorWallMs;
	private static long anchorTick;
	private static long lastTick;
	private static boolean running;
	/** The current tick's game time, read off-thread too (the bridge admits actions between ticks). */
	private static volatile long nowMs = Long.MIN_VALUE;

	private GameClock() { }

	public static void serverTick(long tickCount) {
		synchronized (LOCK) {
			// A new server (or a tick count that went back) re-anchors; the old body state went with the old server.
			if (!running || tickCount < lastTick) {
				running = true;
				anchorTick = tickCount;
				anchorWallMs = Math.max(nowMs, System.currentTimeMillis());
			}
			lastTick = tickCount;
			nowMs = anchorWallMs + (tickCount - anchorTick) * MS_PER_TICK;
		}
	}

	/** The server stopped: until the next one ticks, the clock reads the wall clock again. */
	public static void serverStopped() {
		synchronized (LOCK) {
			running = false;
			nowMs = Long.MIN_VALUE;
		}
	}

	/** Game time in milliseconds (see the class comment); the wall clock while no server ticks. */
	public static long nowMs() {
		long value = nowMs;
		return value == Long.MIN_VALUE ? System.currentTimeMillis() : value;
	}
}
