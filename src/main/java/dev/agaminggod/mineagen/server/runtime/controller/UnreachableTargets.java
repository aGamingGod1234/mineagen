package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.world.phys.Vec3;

/**
 * Count fights (fight_until): mobs a sword approach found out of reach, passed over until the mob or the body has moved
 * {@link #MOVED} blocks from where the approach failed, or the mob hurt the body since. A player who cannot get at an
 * enderman on a pillar stops walking at it and looks for another, and tries again once one of them has moved. The
 * reach answer is the sword engagement's own search over seen terrain (TARGET_UNREACHABLE, NO_SEEN_ROUTE).
 *
 * <p>Off by default (-Dmineagen.fight.skipUnreachable=true turns it on). Live pearl hunts on 19-20 Nov: an angry
 * enderman in view but out of reach was re-engaged 156-867 times a call (each "kept on" as an attacker), so the hunt's
 * quiet spell never started. Bow volleys and blaze fights are never marked: out of sword reach is normal there.
 */
final class UnreachableTargets {
	static final String PROPERTY = "mineagen.fight.skipUnreachable";
	/** How far the mob or the body moves (blocks) before the mob is tried again. */
	static final double MOVED = 3.0D;
	private static final Set<String> CODES = Set.of("TARGET_UNREACHABLE", "NO_SEEN_ROUTE");

	private record Mark(Vec3 mob, Vec3 body, int tick) {}

	private final boolean enabled;
	private final Map<UUID, Mark> marks = new HashMap<>();
	private int failed;
	private int readmitted;

	UnreachableTargets(boolean enabled) {
		this.enabled = enabled;
	}

	/** Read once per call, so a fixture can run both arms in one JVM. */
	static UnreachableTargets fromProperty() {
		return new UnreachableTargets("true".equals(System.getProperty(PROPERTY)));
	}

	boolean enabled() {
		return enabled;
	}

	/**
	 * An engagement ended. Marks the mob when the switch is on, the engagement was a sword approach, no blaze is
	 * involved, and the code says the search found no way to a spot within reach. True when it was marked.
	 */
	boolean failed(UUID id, String code, boolean melee, boolean blaze, Vec3 mob, Vec3 body, int tick) {
		if (!enabled || !melee || blaze || id == null || !CODES.contains(code)) return false;
		marks.put(id, new Mark(mob, body, tick));
		failed++;
		return true;
	}

	/**
	 * Whether the mob is still passed over. A mark is dropped (the mob is a target again) once the mob or the body is
	 * {@link #MOVED} blocks or more from where the approach failed, or the mob hurt the body after that tick.
	 */
	boolean passedOver(UUID id, Vec3 mob, Vec3 body, int hurtTick) {
		if (!enabled) return false;
		Mark mark = marks.get(id);
		if (mark == null) return false;
		if (hurtTick > mark.tick() || mob.distanceTo(mark.mob()) >= MOVED || body.distanceTo(mark.body()) >= MOVED) {
			marks.remove(id);
			readmitted++;
			return false;
		}
		return true;
	}

	/** Whether a mark stands (no position check): for walks to remembered sightings of the mob. */
	boolean marked(UUID id) {
		return enabled && marks.containsKey(id);
	}

	int failures() {
		return failed;
	}

	int readmitted() {
		return readmitted;
	}
}
