package dev.agaminggod.mineagen.server.perception;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.AABB;

/**
 * What the body saw of a kill (issue #2, 1b): where the mob died when it was in view, and how many of the drops that
 * fell at the corpse it could see. A kill out of sight carries no position (D5: perception stays within what a player knows).
 */
public final class KillSighting {
	/** Property that withholds the kill position from the wire (an A/B arm); sight is still measured. */
	public static final String ENABLE_PROPERTY = "mineagen.killPosition";
	/** Within this many blocks of the eye a kill counts as seen, as a player feels a mob die at its feet. */
	static final double AT_THE_FEET = 2.0D;
	/** The corpse box is searched this far for its drops, and a drop counts only this young (the fight's own sampling). */
	static final double DROP_SEARCH_BLOCKS = 1.5D;
	static final int DROP_AGE_TICKS = 5;

	private KillSighting() {
	}

	public static boolean enabled() {
		return !"false".equalsIgnoreCase(System.getProperty(ENABLE_PROPERTY, "true").trim());
	}

	/** The mob's block position when the body saw it die, else null. */
	public static BlockPos seenAt(ServerPlayer player, Entity killed) {
		if (player == null || killed == null || player.level() != killed.level()) return null;
		boolean close = killed.getBoundingBox().distanceToSqr(player.getEyePosition()) <= AT_THE_FEET * AT_THE_FEET;
		return close || ObservationVisibility.canSeeEntity(player, killed) ? killed.blockPosition() : null;
	}

	/** Drops at the corpse now: {seen, unseen} by the body's sight filter (the fight's drop list keeps only the seen). */
	public static int[] drops(ServerPlayer player, Entity killed) {
		int[] counts = new int[2];
		if (player == null || killed == null || player.level() != killed.level()) return counts;
		ObservationVisibility.Frame sight = ObservationVisibility.frame((ServerLevel) player.level(), player);
		AABB box = killed.getBoundingBox().inflate(DROP_SEARCH_BLOCKS);
		for (ItemEntity item : killed.level().getEntitiesOfClass(ItemEntity.class, box,
				item -> item.isAlive() && !item.getItem().isEmpty() && item.getAge() <= DROP_AGE_TICKS)) {
			counts[sight.canSeeEntity(item) ? 0 : 1]++;
		}
		return counts;
	}

	/** The Watcher's kill row fields, without a server. */
	public static com.google.gson.JsonObject row(String entityType, boolean seen, int dropsSeen, int dropsUnseen) {
		com.google.gson.JsonObject row = new com.google.gson.JsonObject();
		row.addProperty("entityType", entityType);
		row.addProperty("seen", seen);
		row.addProperty("dropsSeen", dropsSeen);
		row.addProperty("dropsUnseen", dropsUnseen);
		return row;
	}
}
