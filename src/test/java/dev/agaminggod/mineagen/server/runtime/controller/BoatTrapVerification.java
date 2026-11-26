package dev.agaminggod.mineagen.server.runtime.controller;

/** The boat trap runs only in a pearl hunt for endermen, with the switch on, outside the End, when the body may move. */
public final class BoatTrapVerification {
	private static int assertions;

	private BoatTrapVerification() {
	}

	public static int verify() {
		assertions = 0;
		check(BoatTrap.applies(true, true, true, true, false), "an enderman pearl hunt runs the trap");
		check(!BoatTrap.applies(false, true, true, true, false), "the switch off keeps the fight as before");
		check(!BoatTrap.applies(true, false, true, true, false), "other mobs are fought as before");
		check(!BoatTrap.applies(true, true, false, true, false), "a fight for other drops is not a pearl hunt");
		check(!BoatTrap.applies(true, true, true, false, false), "a body told to hold still does not walk round a boat");
		check(!BoatTrap.applies(true, true, true, true, true), "no boats on the End island");
		check(BoatTrap.PEARLS_DONE >= 12, "the boat comes back only once the frame's pearls are held");
		check(BoatTrap.STANDOFF_MIN > 1.43D, "the swing stand is outside a seated enderman's reach");
		return assertions;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
