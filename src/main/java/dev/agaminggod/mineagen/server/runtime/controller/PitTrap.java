package dev.agaminggod.mineagen.server.runtime.controller;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

/**
 * The window pit (switch fight.pitTrap): an enderman pearl hunt's trap, built from the cell the body stands on with no
 * walking. Ground level G is the feet of a body standing on the surface at {@link #ground}.
 *
 * <pre>
 *   G+1  [cap]  [R1]     cap: one block over the pit, placed against R1 (or a natural block there)
 *   G    window [R0]     the 1-high window: the body sees and hits through it
 *   G-1  stance rim      stance: feet here, eyes just above the ground, to stare at a calm enderman
 *   G-2  pit    rim      pit: feet here once one is provoked
 *   G-3  floor
 * </pre>
 *
 * Vanilla facts it rests on: a mob's melee box (Mob.getAttackBoundingBox) is its own box inflated sideways only, so an
 * enderman standing on the rim (feet at G) never reaches a body whose head is at G-0.2. The cap leaves one block of room
 * over the rim in the pit's column, and a 2.9-block enderman needs three, so it cannot step or drop in (an open pit lets
 * it fall onto the body). The stare line is the body's eyes to the enderman's eyes (LivingEntity.isLookingAtMe), which
 * the window lets through from the stance. A drop on the rim lies inside the vanilla pickup box of a body in the pit
 * (its box grown 1 sideways and 0.5 up), so the pearl is picked up with no step.
 */
final class PitTrap {
	static final boolean ENABLED = dev.agaminggod.mineagen.server.Switches.get("fight.pitTrap");
	/** An enderman after the body this near sends it down into the pit from the stance. */
	static final double DANGER_RANGE = 24.0D;
	/** In the pit with none after the body for this long, it climbs back to the stance to stare at the next. */
	static final long CLEAR_MS = 2_500L;
	/** One that hunts the body but has not been seen for this long is taken as gone. */
	static final long UNSEEN_MS = 10_000L;
	/** In the stance with no calm enderman to stare at for this long, the call hands back. */
	static final long QUIET_MS = 60_000L;
	/** In the stance with no calm enderman to stare at for this long, it opens the cap and walks on to the last one seen. */
	static final long RELOCATE_MS = 20_000L;
	/** It digs in only with a calm enderman to stare at this near, or one already after it: an empty pit catches none. */
	static final double DIG_RANGE = 32.0D;
	/** Each placement or break gets this many ticks before the trap is dropped. */
	static final int STEP_TICKS = 80;
	/** An already angry enderman this near at the start is fought as main fights it; the trap waits. */
	static final double START_CLEAR = 6.0D;

	/** Pearls held at which a finished call opens the trap to walk on (12 eyes of ender); short of it the body stays in. */
	static final int LEAVE_AT = 12;

	/**
	 * LOOT opens the cap for a pearl lying in view, AWAY collects it, BACK walks into the stance again (then CAP). MOVE
	 * opens the cap of an empty trap and leaves it, so the hunt walks on and digs in again where endermen are.
	 */
	enum Phase { SUPPORT_LOW, SUPPORT_HIGH, DIG_STANCE, CAP, STANCE, DROP, PIT, RISE, LOOT, AWAY, BACK, EXIT, MOVE, DONE }

	/** Whether the hunt digs a new trap here: a calm enderman to stare at within DIG_RANGE, or one already after the body. */
	static boolean digsIn(double calmDistance, boolean angryNear) {
		return angryNear || calmDistance <= DIG_RANGE;
	}

	/** Whether the stance, empty of calm endermen for {@code quietMs} with none after the body, is left for a new spot. */
	static boolean moves(long quietMs, boolean angryNear) {
		return !angryNear && quietMs >= RELOCATE_MS;
	}

	/** A pearl lying this near the trap and in view from the stance is fetched once none hunts the body. */
	static final double LOOT_RANGE = 8.0D;

	/** Whether a finished count waits for the body to get back under the cap first (out for a pearl, short of LEAVE_AT). */
	static boolean returning(Phase phase, int held) {
		return held < LEAVE_AT && (phase == Phase.LOOT || phase == Phase.AWAY || phase == Phase.BACK || phase == Phase.CAP);
	}

	/** What the trap reads about a cell: test seam over the level. */
	interface Cells {
		/** A full collision block that holds a body (not a fluid, not air). */
		boolean solid(BlockPos at);
		/** Air or another cell with no collision a body passes through. */
		boolean open(BlockPos at);
		/** Lava, water or fire, or anything else that must not touch the pit. */
		boolean hazard(BlockPos at);
	}

	final BlockPos ground;
	final Direction side;
	Phase phase;
	int ticks;
	int kills;

	PitTrap(BlockPos ground, Direction side, Phase phase) {
		this.ground = ground;
		this.side = side;
		this.phase = phase;
	}

	BlockPos stance() { return ground.below(); }
	BlockPos pit() { return ground.below(2); }
	BlockPos cap() { return ground.above(); }
	BlockPos low() { return ground.relative(side); }
	BlockPos high() { return ground.relative(side).above(); }

	void to(Phase next) {
		phase = next;
		ticks = 0;
	}

	/** Whether this body (feet cell) stands in the stance or the pit. */
	boolean inStance(BlockPos feet) { return feet.equals(stance()); }
	boolean inPit(BlockPos feet) { return feet.equals(pit()); }

	/**
	 * The side whose support holds the cap when the body digs in at {@code ground}, or null when the cell is no pit site:
	 * two solid blocks under the feet over a solid floor, every cell around the dug ones solid (no open side an enderman
	 * could step down into, no fluid that would pour in), and no hazard next to any of them. A side with a natural block
	 * at cap height wins, then the one needing the fewest placed blocks.
	 */
	static Direction site(Cells cells, BlockPos ground) {
		if (!cells.open(ground) || !cells.open(ground.above())) return null;
		// Walled in at its own height (an old stance, a one-wide hole): no window to stare out of.
		boolean window = false;
		for (Direction d : Direction.Plane.HORIZONTAL) if (cells.open(ground.relative(d))) window = true;
		if (!window) return null;
		BlockPos stance = ground.below(), pit = ground.below(2), floor = ground.below(3);
		if (!cells.solid(stance) || !cells.solid(pit) || !cells.solid(floor) || cells.hazard(floor.below())) return null;
		for (int dx = -1; dx <= 1; dx++) {
			for (int dz = -1; dz <= 1; dz++) {
				if (dx == 0 && dz == 0) continue;
				// The rim all round: an enderman on a lower rim cell (feet at G-1) reaches into the pit.
				if (!cells.solid(stance.offset(dx, 0, dz)) || cells.hazard(stance.offset(dx, 0, dz))) return null;
				if (cells.hazard(ground.offset(dx, 0, dz))) return null;
				if (Math.abs(dx) + Math.abs(dz) == 1 && (!cells.solid(pit.offset(dx, 0, dz)) || cells.hazard(pit.offset(dx, 0, dz)))) return null;
			}
		}
		Direction best = null;
		int bestCost = Integer.MAX_VALUE;
		for (Direction d : Direction.Plane.HORIZONTAL) {
			int cost = supportCost(cells, ground, d);
			if (cost < bestCost) { best = d; bestCost = cost; }
		}
		return best;
	}

	/** A trap gets this far from the feet to a pit site (a short step, not a walk across the forest). */
	static final int SITE_RADIUS = 3;
	/** Projectile hits in the trap that hand the call back: an archer shoots through the window and the pit gives no cover from it. */
	static final int SHOTS_OUT = 2;

	/** The nearest cell within {@link #SITE_RADIUS} sideways and one up or down that is a pit site, or null. */
	static BlockPos nearestSite(Cells cells, BlockPos feet) {
		BlockPos best = null;
		double bestDistance = Double.MAX_VALUE;
		for (int dy = -1; dy <= 1; dy++)
			for (int dx = -SITE_RADIUS; dx <= SITE_RADIUS; dx++)
				for (int dz = -SITE_RADIUS; dz <= SITE_RADIUS; dz++) {
					BlockPos at = feet.offset(dx, dy, dz);
					double distance = feet.distSqr(at);
					if (distance >= bestDistance || site(cells, at) == null) continue;
					best = at;
					bestDistance = distance;
				}
		return best;
	}

	/** Blocks to place before the cap on side {@code d}: 0 with a natural block at cap height, else 1 or 2; MAX when impossible. */
	static int supportCost(Cells cells, BlockPos ground, Direction d) {
		BlockPos low = ground.relative(d), high = low.above();
		if (cells.solid(high)) return 0;
		if (!cells.open(high)) return Integer.MAX_VALUE;
		if (cells.solid(low)) return 1;
		if (!cells.open(low) || !cells.solid(low.below())) return Integer.MAX_VALUE;
		return 2;
	}

	/** Placed blocks the trap needs carried before it starts: its supports and the cap (the climb back reuses dug ones). */
	static int blocksNeeded(Cells cells, BlockPos ground, Direction side) {
		return supportCost(cells, ground, side) + 1;
	}

	/**
	 * A trap already standing around a body whose feet are at {@code feet} (an earlier call built it), or null: the cap
	 * over the column with one open cell under it, and solid walls round the feet.
	 */
	static PitTrap existing(Cells cells, BlockPos feet) {
		for (int depth = 1; depth <= 2; depth++) {
			BlockPos ground = feet.above(depth);
			if (!cells.solid(ground.above()) || !cells.open(ground)) continue;
			boolean walled = true;
			for (Direction d : Direction.Plane.HORIZONTAL) if (!cells.solid(feet.relative(d))) walled = false;
			if (!walled) continue;
			Direction side = null;
			for (Direction d : Direction.Plane.HORIZONTAL) if (cells.solid(ground.relative(d).above())) { side = d; break; }
			return new PitTrap(ground, side == null ? Direction.NORTH : side, depth == 1 ? Phase.STANCE : Phase.PIT);
		}
		return null;
	}

	/** Whether the stance sends the body down now: an enderman hunts it within DANGER_RANGE. */
	static boolean drop(boolean angryNear, boolean lowHealth) {
		return angryNear || lowHealth;
	}

	/** Whether the body climbs from the pit back to the stance: none hunting it for CLEAR_MS, health above the flee line. */
	static boolean rise(long sinceAngryMs, boolean fighting, boolean lowHealth) {
		return !fighting && !lowHealth && sinceAngryMs >= CLEAR_MS;
	}

	String where() {
		return ground.below(2).toShortString();
	}

	String summary() {
		return String.format(java.util.Locale.ROOT, "pit trap at %s (cap %s): %s, %d kill%s from it", where(), cap().toShortString(),
				phase.name().toLowerCase(java.util.Locale.ROOT), kills, kills == 1 ? "" : "s");
	}
}
