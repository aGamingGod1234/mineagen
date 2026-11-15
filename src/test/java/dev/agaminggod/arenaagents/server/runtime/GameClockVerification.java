package dev.agaminggod.arenaagents.server.runtime;

public final class GameClockVerification {
	private GameClockVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " game clock assertions");
	}

	public static int verify() {
		try {
			GameClock.serverStopped();
			long before = System.currentTimeMillis();
			long idle = GameClock.nowMs();
			assertTrue(idle >= before && idle <= System.currentTimeMillis(), "with no server ticking the clock reads the wall clock");

			GameClock.serverTick(1_000L);
			long anchor = GameClock.nowMs();
			assertTrue(Math.abs(anchor - System.currentTimeMillis()) < 1_000L, "the first tick anchors the clock at the wall time");
			assertEquals(anchor, GameClock.nowMs(), "the clock holds still within a tick");
			GameClock.serverTick(1_020L);
			assertEquals(anchor + 1_000L, GameClock.nowMs(), "20 ticks are one second of game time, however fast they ran");
			GameClock.serverTick(1_420L);
			assertEquals(anchor + 21_000L, GameClock.nowMs(), "400 more ticks are 20 more seconds");

			// A body timer measured across ticks: a 20 s timeout ends after 400 ticks whatever the tick rate.
			ElapsedTimeAccumulator elapsed = new ElapsedTimeAccumulator(GameClock.nowMs());
			GameClock.serverTick(1_819L);
			assertTrue(elapsed.advance(GameClock.nowMs()) < 20_000L, "399 ticks are short of a 20 s timeout");
			GameClock.serverTick(1_820L);
			assertEquals(20_000L, elapsed.advance(GameClock.nowMs()), "the 400th tick reaches it");

			// A new server (its tick count starts over) re-anchors without going back in time.
			long last = GameClock.nowMs();
			GameClock.serverTick(0L);
			assertTrue(GameClock.nowMs() >= last, "a restarted tick count does not move the clock back");
			GameClock.serverStopped();
			assertTrue(Math.abs(GameClock.nowMs() - System.currentTimeMillis()) < 1_000L, "a stopped server returns the wall clock");
			return 9;
		} finally {
			GameClock.serverStopped();
		}
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}

	private static void assertEquals(long expected, long actual, String label) {
		if (expected != actual) throw new AssertionError(label + ": expected " + expected + ", got " + actual);
	}
}
