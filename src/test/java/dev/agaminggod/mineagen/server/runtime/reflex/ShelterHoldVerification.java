package dev.agaminggod.mineagen.server.runtime.reflex;

import dev.agaminggod.mineagen.protocol.ActionType;

/** The shelter hold's timing: on under fire when weak, off once quiet, never past its cap, not again for the same fire. */
final class ShelterHoldVerification {
	private ShelterHoldVerification() {
	}

	static int verify() {
		int checks = 0;
		ShelterHold hold = new ShelterHold();
		check(!hold.tick(true, false, 0L), "a shield in hand and good health walk on under fire"); checks++;
		check(hold.tick(true, true, 1L), "weak under fire holds"); checks++;
		check(hold.tick(true, true, 1L + ShelterHold.MAX_TICKS - 1), "the hold lasts up to its cap"); checks++;
		check(!hold.tick(true, true, 1L + ShelterHold.MAX_TICKS), "the cap ends the hold (a spawner's fire never ends)"); checks++;
		check(!hold.tick(true, true, 2L + ShelterHold.MAX_TICKS), "the same fire does not hold again after the cap"); checks++;
		check(!hold.tick(false, true, 3L + ShelterHold.MAX_TICKS), "quiet ends the danger"); checks++;
		check(hold.tick(true, true, 4L + ShelterHold.MAX_TICKS), "new fire after quiet holds again"); checks++;
		check(ShelterHold.heldWalk(ActionType.TRAVEL_TO) && !ShelterHold.heldWalk(ActionType.FIGHT_UNTIL) && !ShelterHold.heldWalk(ActionType.ESCAPE)
				&& !ShelterHold.heldWalk(null), "only plain walks wait; fights, escapes and the spawner back-out take the body"); checks++;
		return checks;
	}

	private static void check(boolean ok, String what) {
		if (!ok) throw new AssertionError(what);
	}
}
