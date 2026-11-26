package dev.agaminggod.mineagen.server.runtime.controller;

import net.minecraft.core.BlockPos;
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
	/** On by default; -Dmineagen.fight.spawnerHold=false turns it off (the old open fight_until and fight_target). */
	public static final boolean ENABLED = dev.agaminggod.mineagen.server.Switches.get("fight.spawnerHold");
	/**
	 * On by default (-Dmineagen.fight.spawnerHoldOpen=false fights from the cell): fight the model's own fight (pursue, its drops) while healthy and go back
	 * into the cell to wall in and heal below TURTLE_HEALTH, instead of fighting from the cell. Real fortress room: the open
	 * fight kept 39 rods in 9 runs, the cell fight 7; the plain spawner room: the open fight died in 8 of 10, healing nowhere.
	 */
	public static final boolean OPEN_FIGHT = dev.agaminggod.mineagen.server.Switches.get("fight.spawnerHoldOpen");
	/**
	 * On by default; -Dmineagen.fight.spawnerHoldSpot=false turns off the whole spot rule: a fight_until spot by the
	 * spawner keeps the ordinary fight ({@link #spotAtSpawner}), a spot named before any spawner was seen no longer looks
	 * round, bare ids no longer reach the hold ({@link #blazeRods}), and the fight_until hold hands back at the model's
	 * fleeAtHealth again while a wall-in is left.
	 */
	public static final boolean SPOT = dev.agaminggod.mineagen.server.Switches.get("fight.spawnerHoldSpot");
	/**
	 * On by default; -Dmineagen.fight.spawnerHoldMinTime=false keeps the model's own timeout. A hold runs at least
	 * {@link #MIN_HOLD_MS} before a timeout ends it: real games (26 Nov A/B) gave 7-10 s timeouts to 6 of 20 holds, and
	 * none of those chose a cell, so every one ended in the open. The model can still cancel it.
	 */
	public static final boolean MIN_TIME = dev.agaminggod.mineagen.server.Switches.get("fight.spawnerHoldMinTime");
	/** Long enough to choose a cell 6-12 blocks out, walk there and wall in (game-shape rooms: the first build at 10-40 s). */
	public static final long MIN_HOLD_MS = 45_000L;

	/**
	 * On by default; -Dmineagen.fight.spawnerHoldOwnCell=false hands over to the ordinary fight as before. With no seen cell
	 * 6-12 blocks from the spawner, the hold walls in where the body stands: real games (26 Nov smoke) handed over at once
	 * in 2 of 2 games ("no seen cell"), and the ordinary fight died in both.
	 */
	public static final boolean OWN_CELL = dev.agaminggod.mineagen.server.Switches.get("fight.spawnerHoldOwnCell");

	/** The doorway for a cell where the body stands (offset from the spawner), or null when it is no place to hold. */
	static Direction ownCellOpening(double dx, double dz) {
		double horizontal = Math.hypot(dx, dz);
		return horizontal < 2.0D || horizontal > SCAN ? null : facing(-dx, -dz);
	}

	/** The time a hold runs before its timeout: the model's, raised to {@link #MIN_HOLD_MS} while the switch is on. */
	public static long holdTimeoutMs(long modelMs) {
		return MIN_TIME ? Math.max(modelMs, MIN_HOLD_MS) : modelMs;
	}

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
	/**
	 * Open fight: a blaze targeting the body within this distance (feet to feet) with a clear line can hit it in melee
	 * (vanilla's blaze hits under 2 blocks). No wall-in starts then: it would be built round a blaze that keeps hitting while
	 * the body stops swinging (doorway fix, blaze spawner rooms: in 24 of 28 runs with a death a blaze was within 1 block as
	 * health ran out, 12 of them dying mid wall-in). The open fight goes on and swings at it instead.
	 */
	static final double MELEE_BLAZE = 2.5D;

	private SpawnerHold() {
	}

	/** Whether fight_until starts a spawner hold instead of the open-ground fight. roof:false keeps the open fight. */
	public static boolean applies(boolean nether, boolean blaze, Boolean roofArgument, boolean spawnerNear) {
		return nether && blaze && spawnerNear && !Boolean.FALSE.equals(roofArgument);
	}

	/**
	 * A fight_until spot (x, y, z) that names the seen spawner's own ground: within {@link #SCAN} blocks of it. Such a spot
	 * asks for the fight at the spawner, so the hold takes it and picks its own cell; a spot farther off keeps the ordinary
	 * fight there. A missing y counts as the spawner's height; a spot without x or z is not one. Real games (26 Nov, 55
	 * games): 240 of 270 Nether blaze fight_until calls named a spot, which turned the hold off; 56 of them were made
	 * within 24 blocks of a spawner the body had seen, 30 on the spawner block itself, and none of those fights got a rod.
	 */
	public static boolean spotAtSpawner(BlockPos spawner, Double x, Double y, Double z) {
		if (!SPOT || spawner == null || x == null || z == null) return false;
		double dx = x - (spawner.getX() + 0.5D), dz = z - (spawner.getZ() + 0.5D), dy = y == null ? 0.0D : y - spawner.getY();
		return dx * dx + dy * dy + dz * dz <= SCAN * SCAN;
	}

	/**
	 * True for a blaze-for-rods fight_until, with or without the {@code minecraft:} prefix. The hold's gate compared the raw
	 * strings, so "blaze"/"blaze_rod" (12 and 10 of 276 real-game blaze calls, 26 Nov) never got the hold. With
	 * fight.spawnerHoldSpot off only the full ids count, as before.
	 */
	public static boolean blazeRods(String mob, String untilItem) {
		return "minecraft:blaze".equals(full(mob)) && "minecraft:blaze_rod".equals(full(untilItem));
	}

	/** The full id the hold runs on: the bare id gains {@code minecraft:} while fight.spawnerHoldSpot is on. */
	public static String full(String id) {
		return SPOT && id != null && !id.isBlank() && id.indexOf(':') < 0 ? "minecraft:" + id.trim() : id;
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

	/**
	 * The doorway of a cell walled up right beside the spawner: facing the spawner would make the spawner block itself the
	 * doorway, which no pickaxe opens, so the body stayed sealed in for the rest of the fight (wave 6 blaze spawner rooms,
	 * main: 39 of 135 runs). Then the doorway turns to the side along the other axis instead.
	 */
	static Direction doorway(int cellX, int cellZ, int spawnerX, int spawnerZ, boolean inDoorway,
			java.util.function.Predicate<Direction> wayOut) {
		int dx = spawnerX - cellX, dz = spawnerZ - cellZ;
		Direction toward = facing(dx, dz);
		if (!inDoorway || Math.abs(dx) + Math.abs(dz) != 1) return toward;
		// The two sides along the other axis, then the side away from the spawner: the first with a seen way out past it.
		Direction[] sides = toward.getAxis() == Direction.Axis.X
				? new Direction[] {Direction.SOUTH, Direction.NORTH, toward.getOpposite()}
				: new Direction[] {Direction.EAST, Direction.WEST, toward.getOpposite()};
		for (Direction side : sides) if (wayOut.test(side)) return side;
		return sides[0];
	}

	/** The spawner sits in the feet or head block of a cell's doorway on that side (cell at its level or a block below). */
	static boolean spawnerInDoorway(int cellY, int spawnerY) {
		return spawnerY == cellY || spawnerY == cellY + 1;
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

	/** A ledge rod trip (the platform round the spawner) may go with this many blazes within LEDGE_BLAZE_RANGE of the rod. */
	static final int LEDGE_BLAZES = 1;
	static final double LEDGE_BLAZE_RANGE = 8.0D;
	static final float LEDGE_HEALTH = 16.0F;

	/**
	 * A trip up to rods on the spawner's platform: no wither skeleton near, LEDGE_HEALTH, and at most LEDGE_BLAZES blazes
	 * near the rod (a live spawner always has one within 10, so the floor trip's rule never let one go: real fortress room,
	 * about 20 kills a run, the rods lay on the platform until they despawned). One trip sweeps every rod there.
	 */
	static boolean mayFetchLedge(float health, double witherToBody, double witherToRod, int blazesNearRod) {
		if (witherToBody <= WITHER_CLEAR || witherToRod <= WITHER_CLEAR) return false;
		return health >= LEDGE_HEALTH && blazesNearRod <= LEDGE_BLAZES;
	}

	/** A rod this close to the cell is a step out, not a trip. */
	static final double STEP_OUT = 5.0D;

	/**
	 * A step out of the cell for a rod lying by it: health above the trip turn-back, no wither skeleton near, and at most
	 * LEDGE_BLAZES blazes near the rod. At a busy spawner a blaze is always within 10 blocks, so the trip rule alone left
	 * the rods by the doorway (real fortress room: 20 kills, 1 rod in 10 minutes).
	 */
	static boolean mayStepOut(float health, double witherToBody, double witherToRod, double fromCell, int blazesNearRod) {
		if (witherToBody <= WITHER_CLEAR || witherToRod <= WITHER_CLEAR) return false;
		return fromCell <= STEP_OUT && health >= COLLECT_HEALTH && blazesNearRod <= LEDGE_BLAZES;
	}

	/** A bold trip: this healthy, no blaze this near the rod, and the rod no farther from the cell. */
	static final float BOLD_HEALTH = 16.0F;
	static final double BOLD_BLAZE_CLEAR = 4.0D, BOLD_RANGE = 12.0D;

	/**
	 * A trip out for a rod at a busy spawner: BOLD_HEALTH, no wither skeleton near, no blaze within BOLD_BLAZE_CLEAR of the
	 * rod, the rod within BOLD_RANGE of the cell. Real fortress room, 9 runs: the hold killed about 20 blazes a run from
	 * its cell and kept 7 rods in all, against 39 for the open fight, because a blaze was always within 10 of the rods by
	 * the spawner. The trip turns back below 12 health and the walled-in heal follows.
	 */
	static boolean mayFetchBold(float health, double witherToBody, double witherToRod, double blazeToRod, double fromCell) {
		if (witherToBody <= WITHER_CLEAR || witherToRod <= WITHER_CLEAR) return false;
		return health >= BOLD_HEALTH && blazeToRod > BOLD_BLAZE_CLEAR && fromCell <= BOLD_RANGE;
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
		return turtle(inCell, health, false, sinceMs, elapsedMs);
	}

	/** As {@link #turtle(boolean, float, long, long)}; coverWanted starts the heal above TURTLE_HEALTH (the margin ran out: {@link #backToCell(float, double, float, int)}). */
	static boolean turtle(boolean inCell, float health, boolean coverWanted, long sinceMs, long elapsedMs) {
		if (!inCell) return false;
		if (sinceMs < 0L) return health < TURTLE_HEALTH || coverWanted && health < TURTLE_DONE;
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

	/** Walking pace back to the cell (blocks a second, a walk, not a sprint), and the seconds to wall the doorway up once there. */
	static final double WALK_BACK_SPEED = 4.0D, COVER_SECONDS = 2.0D;
	/** Hits (not burning) taken over this many ticks set the rate the walk back is expected to cost. */
	static final long HIT_RATE_TICKS = 100L;

	/**
	 * The health the body is expected to have once it stands walled in its cell: health now, less the hits it is taking (the
	 * last {@link #HIT_RATE_TICKS}' health lost to hits, as a rate) over the walk back and the wall-in, less the burning still
	 * to come (1 health a second). Round 6b52e71 live: the turn-back read health alone, below 12, after each hit had landed;
	 * blazes hit in volleys of three 5-health fireballs and set the body alight, so it turned at 11 already burning, lost up
	 * to 20 more on the walk back and began the heal at 2.4-8.3, where any hit through the open doorway killed it.
	 */
	static float healthAtCover(float health, double toCell, float hitLossRecent, int fireTicksLeft) {
		double seconds = toCell / WALK_BACK_SPEED + COVER_SECONDS;
		double hitsPerSecond = hitLossRecent / (HIT_RATE_TICKS / 20.0D);
		return (float) (health - hitsPerSecond * seconds - Math.max(0, fireTicksLeft) / 20.0D);
	}

	/**
	 * Go back for the cell (or, in it, start the heal) while the margin holds: as a player does, sooner the farther the cell
	 * and the faster the hits come, so the body arrives with about {@link #TURTLE_HEALTH} rather than leaving at it.
	 */
	static boolean backToCell(float health, double toCell, float hitLossRecent, int fireTicksLeft) {
		return health < TURTLE_HEALTH || healthAtCover(health, toCell, hitLossRecent, fireTicksLeft) < TURTLE_HEALTH;
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
