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
	/** Off until live runs pass the rods bar; fixtures turn it on with -Dmineagen.fight.spawnerHold=true. */
	public static final boolean ENABLED = "true".equals(System.getProperty("mineagen.fight.spawnerHold"));
	/**
	 * The doorway faces away from the spawner (-Dmineagen.fight.spawnerHoldDoor=toward faces it). Vanilla BlazeAttackGoal:
	 * a blaze that sees its target hovers and shoots; one that has not seen it for 5 ticks flies toward it. A doorway
	 * facing the spawner let every blaze shoot in (round 3 live: 36-45 blocked fireballs a run wore the shield out in about
	 * 4 minutes); facing away, they come round to the doorway one at a time, into sword reach.
	 */
	public static final boolean DOOR_AWAY = !"toward".equals(System.getProperty("mineagen.fight.spawnerHoldDoor"));
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
	static final double BLAZE_CLEAR = 10.0D;
	/** 3.5 minutes: a rod despawns at 5 (6000 ticks). */
	static final long LATE_ROD_TICKS = 4_200L;
	static final float LATE_ROD_HEALTH = 16.0F;
	/** Health regrows only at hunger 18+; below 14 health a bite is worth the shield going down. */
	static final int EAT_HUNGER = 18;
	static final float EAT_HEALTH = 14.0F;
	/** Eating waits only for a blaze in melee reach: at 6-12 blocks from a live spawner one is nearly always within 6. */
	static final double EAT_BLAZE_CLEAR = 3.0D;
	/**
	 * Below TURTLE_HEALTH in the cell the body stops shooting, raises the shield toward the nearest blaze (or out of the
	 * doorway) and eats, until TURTLE_DONE or TURTLE_MS: four of five live runs lost health in the cell to fireballs that
	 * landed while the bow was drawn, then burning, down to the 6-health hand-back and one death after it.
	 */
	static final float TURTLE_HEALTH = 12.0F, TURTLE_DONE = 18.0F;
	static final long TURTLE_MS = 45_000L;
	/** No blaze seen for this long with the body in the cell: the spawner is not making more (light, range, or broken). */
	static final long QUIET_MS = 90_000L;
	/** Wither skeleton hits taken inside the finished cell within this window that mean the cell does not hold. */
	static final int BREACH_HITS = 2;
	static final long BREACH_WINDOW_TICKS = 200L;
	/** Outside the cell, a mob targeting the body this close is fought (sword and shield) for up to DEFEND_MS. */
	static final double DEFEND_RANGE = 3.5D;

	/** Blazes are not defended against outside the cell: they hover out of sword reach and the cell is where they are fought. */
	public static boolean defendAgainst(boolean blaze) {
		return !blaze;
	}
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
	 * floors), and no blaze within {@link #BLAZE_CLEAR} of the body or the rod (a live spawner sends waves with lulls
	 * between them; the smoke run died to fireballs on a trip mid-wave). A rod near its despawn (5 minutes, vanilla) is
	 * fetched at {@link #LATE_ROD_HEALTH}+ health with blazes about. Distances are {@link Double#POSITIVE_INFINITY} when
	 * none is seen.
	 */
	static boolean mayCollect(float health, double witherToBody, double witherToRod, double blazeNear, long rodAgeTicks) {
		if (witherToBody <= WITHER_CLEAR || witherToRod <= WITHER_CLEAR) return false;
		if (rodAgeTicks >= LATE_ROD_TICKS) return health >= LATE_ROD_HEALTH;
		return health >= COLLECT_HEALTH && blazeNear > BLAZE_CLEAR;
	}

	/** Eat inside the cell: hungry enough to stop regrowing, or hurt with room to eat, and a bite that ends before a volley. */
	static boolean shouldEat(int hunger, float health, boolean biteSafe, boolean blazeInReach, boolean hasFood) {
		if (!hasFood || !biteSafe || blazeInReach) return false;
		return hunger < EAT_HUNGER || health < EAT_HEALTH && hunger < 20;
	}

	/**
	 * Vanilla BlazeAttackGoal: a blaze glows charged for 60 ticks before its three fireballs. A bite takes 32 ticks (bread)
	 * and a shield blocks only after it has been up for 5 ticks; SHIELD_READY_TICKS leaves twice that.
	 */
	static final int CHARGE_TICKS = 60, BITE_TICKS = 32, SHIELD_READY_TICKS = 10;

	/**
	 * Whether a bite started now ends with the shield back up before any volley lands: no blockable shot inbound, and no
	 * blaze with a line to the body charged longer than the bite leaves room for. oldestCharge is the longest such charge
	 * in ticks, or -1 when none. Round 3 live: the shield heal lowered the shield for a bite on every tick with no shot in
	 * the air, raised it too late when one came (0 of 299 heal ticks blocking), and both seeds died in the cell.
	 */
	static boolean biteSafe(int oldestCharge, boolean shotInbound) {
		return !shotInbound && (oldestCharge < 0 || oldestCharge + BITE_TICKS < CHARGE_TICKS - SHIELD_READY_TICKS);
	}

	/** A bite under way stops for a shot inbound or a volley due before the shield would be ready. */
	static boolean stopBite(int oldestCharge, boolean shotInbound) {
		return shotInbound || oldestCharge >= CHARGE_TICKS - SHIELD_READY_TICKS;
	}

	/** In the shield heal the shield stays up; it comes down only for a bite that is safe (any hunger below full). */
	static boolean healBite(int hunger, boolean biteSafe, boolean hasFood) {
		return hasFood && hunger < 20 && biteSafe;
	}

	/**
	 * Whether the body takes cover behind its shield now, or (when turtling since sinceMs) keeps doing so. Below
	 * TURTLE_HEALTH it never stops for time: the cell is where it heals, with no hand-back at the health floor.
	 */
	static boolean turtle(boolean inCell, float health, long sinceMs, long elapsedMs) {
		if (!inCell) return false;
		if (sinceMs < 0L) return health < TURTLE_HEALTH;
		return health < TURTLE_HEALTH || health < TURTLE_DONE && elapsedMs - sinceMs < TURTLE_MS;
	}

	/** Walled in, the body heals to TURTLE_DONE before it opens the doorway again, for at most SEALED_MS. */
	static final long SEALED_MS = 120_000L;

	static boolean sealedHeal(float health, long sinceMs, long elapsedMs) {
		return sinceMs >= 0L && health < TURTLE_DONE && elapsedMs - sinceMs < SEALED_MS;
	}

	/** A rod trip (or any step out of the cell) turns back to the cell below this health: the cell is where it heals. */
	static boolean backToCell(float health) {
		return health < TURTLE_HEALTH;
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
	 * time. AGENT_DEAD and IN_LAVA are checked by the controller before this (they need no sensing). The health floor
	 * hands back only before the cell stands: once it does (inCell, the hold phase) the body heals in it behind its shield,
	 * because after a hand-back no action holds the body and the back-off reflexes walked it out to die (round 1: 3 of 4
	 * deaths).
	 */
	static String handBack(Sense s) {
		if (s.held() >= s.untilCount()) return "UNTIL_COUNT_REACHED";
		if (!s.inCell() && s.health() <= s.fleeAtHealth()) return "LOW_HEALTH_BAILOUT";
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
	 * cell. The engine's danger stops hand back; its no-target, out-of-reach and failure stops restart it, and so does its
	 * low-health stop (the hold heals in the cell instead).
	 */
	static String engineEnd(String code) {
		return ENGINE_STOPS.contains(code) ? code : null;
	}

	/** The engine's own stops the hold passes on unchanged (each is produced and catalogued at the engine). */
	private static final java.util.Set<String> ENGINE_STOPS = java.util.Set.of("UNTIL_COUNT_REACHED", "AGENT_DEAD", "IN_LAVA",
			"FIGHT_UNTIL_TIMED_OUT");
}
