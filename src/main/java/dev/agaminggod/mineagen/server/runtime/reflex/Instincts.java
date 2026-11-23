package dev.agaminggod.mineagen.server.runtime.reflex;

/**
 * Issue 2 Step 2's instincts arm on the mod side: {@code MINEAGEN_INSTINCTS} lists {@code instincts} (a comma list), the
 * same variable the coordinator reads (the mod starts it with its own environment), or {@code -Dmineagen.instincts=true}.
 * Off, the mod behaves as before.
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
