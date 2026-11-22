package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.UUID;

/**
 * roof:true in a warped-forest hunt (WarpedForestHunt): a shelter is built only on real contact, a calm enderman within
 * CONTACT_RANGE that has stayed in view CONTACT_MS (a glimpse across the forest is not one), and a shelter already built
 * and still standing nearby is walked back into instead of building another. Live round 5 built 3 shelters for 1 kill.
 * The contact is the fight's first target through the build. The body keeps blocks for its low-health perch: a shelter
 * starts only with the shelter's blocks plus the perch's.
 */
final class ForestRoof {
	static final double CONTACT_RANGE = 12.0D;
	static final long CONTACT_MS = 1_000L;
	static final int MAX_ROOFS = 3;
	static final double REUSE_RANGE = 16.0D;

	private UUID contact;
	private long since;

	/** Whether this contact builds a shelter now. */
	static boolean build(boolean roofWanted, boolean roofed, boolean building, int roofBuilds, double distance, long inViewMs, boolean angry) {
		return roofWanted && !roofed && !building && roofBuilds < MAX_ROOFS && !angry && distance <= CONTACT_RANGE && inViewMs >= CONTACT_MS;
	}

	/** Blocks a forest shelter needs carried before it starts: the shelter's own plus the perch's. */
	static int blocksNeeded(int shelter, boolean forest, int perch) {
		return shelter + (forest ? perch : 0);
	}

	/** A built shelter is reused when it still stands and is this near. */
	static boolean reuse(boolean intact, double distance) {
		return intact && distance <= REUSE_RANGE;
	}

	/** How long (ms) the same calm enderman in range has been in view; 0 when there is none this tick. */
	long observe(UUID target, boolean calmInRange, long elapsedMs) {
		if (target == null || !calmInRange) {
			contact = null;
			return 0L;
		}
		if (!target.equals(contact)) {
			contact = target;
			since = elapsedMs;
		}
		return elapsedMs - since;
	}
}
