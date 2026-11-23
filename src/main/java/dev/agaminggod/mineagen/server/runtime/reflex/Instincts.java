package dev.agaminggod.mineagen.server.runtime.reflex;

/**
 * Issue 2 Step 2's instincts arm on the mod side, on by default so practice rooms play as model games do. Turn the arm
 * off with {@code MINEAGEN_INSTINCTS=off} (any comma list without {@code instincts}): the coordinator reads the same
 * variable (the mod starts it with its own environment), so both halves go off together, unless
 * {@code -Dmineagen.instincts=true} turns this half back on (either source on is on). {@code -Dmineagen.instincts=false}
 * with the variable unset turns only this half off. Off, the mod behaves as before.
 */
public final class Instincts {
	private static volatile Boolean override;

	private Instincts() {
	}

	public static boolean enabled() {
		Boolean forced = override;
		if (forced != null) return forced;
		return dev.agaminggod.mineagen.server.Switches.get("instincts");
	}

	/** Verifications only: force the arm on or off ({@code null} reads the environment again). */
	public static void overrideForTests(Boolean value) {
		override = value;
	}
}
