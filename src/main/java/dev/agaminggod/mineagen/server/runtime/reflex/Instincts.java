package dev.agaminggod.mineagen.server.runtime.reflex;

import java.util.Arrays;

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
		if (Boolean.getBoolean("mineagen.instincts")) return true;
		String listedValue = System.getenv("MINEAGEN_INSTINCTS");
		return listed(listedValue);
	}

	static boolean listed(String value) {
		return value != null && Arrays.stream(value.split(",")).map(String::trim).anyMatch("instincts"::equals);
	}

	/** Verifications only: force the arm on or off ({@code null} reads the environment again). */
	public static void overrideForTests(Boolean value) {
		override = value;
	}
}
