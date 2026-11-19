package dev.agaminggod.mineagen.server.runtime.controller;

import net.minecraft.core.Direction;

/**
 * The spawner hold's decisions for fight_until blaze, server-free so each hand-back rule is pinned by a test
 * ({@code SpawnerHoldVerification}). The controller ({@link ServerSpawnerHoldController}) only senses and acts.
 *
 * <p>Why a roofed cell with a two-high doorway: a wither skeleton is 2.4 blocks tall (EntityType sized 0.7 x 2.4 in every
 * 26.x target) and cannot enter a doorway with a block over it, while a 1.8-tall blaze can; staged fortress runs lost 12
 * of 28 deaths to wither skeletons on open decks, not to the blaze fight.
 */
public final class SpawnerHold {
	/** Fixture A/B switch (-Dmineagen.fight.spawnerHold=false); on by default. */
	public static final boolean ENABLED = !"false".equals(System.getProperty("mineagen.fight.spawnerHold"));
	/** A seen fortress spawner within this many blocks of the body starts a hold. */
	public static final double SCAN = 24.0D;
	/** The cell stands this far (horizontal) from the spawner: a vanilla spawner runs only with a player within 16. */
	static final double SITE_MIN = 6.0D, SITE_MAX = 12.0D, SITE_IDEAL = 8.0D;
	/** Feet from this far below the spawner's block to this far above it (blazes spawn at the spawner's height +-1). */
	static final int SITE_BELOW = 3, SITE_ABOVE = 1;
	static final int MAX_SITES = 3;
	/** Rods within this range of the cell are walked to, under {@link #mayCollect}. */
	static final double COLLECT_RANGE = 16.0D;
	static final float COLLECT_HEALTH = 12.0F;
	static final double WITHER_CLEAR = 10.0D;
	static final double BLAZE_NEAR_ROD = 4.0D;
	/** Health regrows only at hunger 18+; below 14 health a bite is worth the shield going down. */
	static final int EAT_HUNGER = 18;
	static final float EAT_HEALTH = 14.0F;
	/** No blaze seen for this long with the body in the cell: the spawner is not making more (light, range, or broken). */
	static final long QUIET_MS = 90_000L;
	/** Wither skeleton hits taken inside the finished cell within this window that mean the cell does not hold. */
	static final int BREACH_HITS = 2;
	static final long BREACH_WINDOW_TICKS = 200L;
	/** Outside the cell, a mob targeting the body this close is fought (sword and shield) for up to DEFEND_MS. */
	static final double DEFEND_RANGE = 3.5D;
	static final long DEFEND_MS = 20_000L;

	private SpawnerHold() {
	}

	/** Whether fight_until starts a spawner hold instead of the open-ground fight. roof:false keeps the open fight. */
	public static boolean applies(boolean nether, boolean blaze, Boolean roofArgument, boolean spawnerNear) {
		return nether && blaze && spawnerNear && !Boolean.FALSE.equals(roofArgument);
	}

	/** True when a mob of this height cannot pass a gap of that many blocks (a block over a two-high doorway). */
	public static boolean keptOut(float mobHeight, int gapBlocks) {
		return mobHeight > gapBlocks;
	}

	/** A candidate cell's place: horizontal distance from the spawner and feet height relative to the spawner block. */
	static boolean siteInRange(double horizontal, int feetDy) {
		return horizontal >= SITE_MIN && horizontal <= SITE_MAX && feetDy >= -SITE_BELOW && feetDy <= SITE_ABOVE;
	}

	/** Lower is better: near the ideal distance, near the body, few blocks to place (a standing shelter is reused). */
	static double siteScore(double horizontal, double fromBody, int blocksToPlace) {
		return Math.abs(horizontal - SITE_IDEAL) + 0.15D * fromBody + 0.5D * blocksToPlace;
	}

	/** The doorway faces the spawner along the larger horizontal axis. */
	static Direction facing(double dx, double dz) {
		if (Math.abs(dx) >= Math.abs(dz)) return dx >= 0.0D ? Direction.EAST : Direction.WEST;
		return dz >= 0.0D ? Direction.SOUTH : Direction.NORTH;
	}

	/**
	 * A walk out to a rod: health enough, no wither skeleton near the body or the rod (they are what kill on fortress
	 * floors), no blaze over the rod. Distances are {@link Double#POSITIVE_INFINITY} when none is seen. Never "no hostile
	 * within 16": at a live spawner that never clears and rods despawn after 5 minutes.
	 */
	static boolean mayCollect(float health, double witherToBody, double witherToRod, double blazeToRod) {
		return health >= COLLECT_HEALTH && witherToBody > WITHER_CLEAR && witherToRod > WITHER_CLEAR && blazeToRod > BLAZE_NEAR_ROD;
	}

	/** Eat inside the cell: hungry enough to stop regrowing, or hurt with room to eat, and no shot about to land. */
	static boolean shouldEat(int hunger, float health, boolean shotInbound, boolean blazeInReach, boolean hasFood) {
		if (!hasFood || shotInbound || blazeInReach) return false;
		return hunger < EAT_HUNGER || health < EAT_HEALTH && hunger < 20;
	}

	/** Two wither skeleton hits inside the cell within the window: the doorway does not keep them out here. */
	static boolean breached(long[] witherHitTicks, long now) {
		int recent = 0;
		for (long tick : witherHitTicks) if (tick != Long.MIN_VALUE && now - tick <= BREACH_WINDOW_TICKS) recent++;
		return recent >= BREACH_HITS;
	}

	/** What the hold senses each tick, for {@link #handBack}. */
	record Sense(int held, int untilCount, float health, float fleeAtHealth, int hunger, boolean hasFood, long elapsedMs,
			long timeoutMs, boolean spawnerGone, long quietMs, boolean inCell, int sitesFailed, boolean noSiteLeft, boolean breached) {
	}

	/**
	 * The hand-back code, or null to hold on. Order: success first, then the body's own safety, then the spawner, then
	 * time. AGENT_DEAD and IN_LAVA are checked by the controller before this (they need no sensing).
	 */
	static String handBack(Sense s) {
		if (s.held() >= s.untilCount()) return "UNTIL_COUNT_REACHED";
		if (s.health() <= s.fleeAtHealth()) return "LOW_HEALTH_BAILOUT";
		if (s.breached()) return "HOLD_BREACHED";
		if (!s.hasFood() && s.hunger() < EAT_HUNGER && s.health() < EAT_HEALTH) return "OUT_OF_FOOD";
		if (s.spawnerGone()) return "SPAWNER_GONE";
		if (s.noSiteLeft() || s.sitesFailed() >= MAX_SITES) return "SPAWNER_UNREACHABLE";
		if (s.elapsedMs() >= s.timeoutMs()) return "FIGHT_UNTIL_TIMED_OUT";
		if (s.inCell() && s.quietMs() >= QUIET_MS) return "SPAWNER_QUIET";
		return null;
	}

	/**
	 * What an engine hand-back inside the cell means: the hold's own stop (its code) or null to restart the engine in the
	 * cell. The engine's danger stops hand back; its no-target, out-of-reach and failure stops restart it.
	 */
	static String engineEnd(String code) {
		return switch (code) {
			case "UNTIL_COUNT_REACHED", "AGENT_DEAD", "IN_LAVA", "LOW_HEALTH_BAILOUT", "FIGHT_UNTIL_TIMED_OUT" -> code;
			default -> null;
		};
	}
}
