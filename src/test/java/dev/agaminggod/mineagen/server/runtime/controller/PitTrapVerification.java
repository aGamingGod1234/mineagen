package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

/** The window pit (PitTrap): site choice, supports, an existing trap, and when it drops in or climbs back, one rule each. */
public final class PitTrapVerification {
	private static int assertions;

	private PitTrapVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PitTrapVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		check(PitTrap.ENABLED, "fight.pitTrap is on by default");
		verifySite();
		verifySupports();
		verifyExisting();
		verifyDropAndRise();
		return assertions;
	}

	private enum Kind { SOLID, OPEN, LAVA }

	/** Flat ground: solid at y <= 63, open above; the body stands with its feet at y 64. */
	private static final class Grid implements PitTrap.Cells {
		final Map<BlockPos, Kind> cells = new HashMap<>();
		Kind at(BlockPos p) { return cells.getOrDefault(p, p.getY() <= 63 ? Kind.SOLID : Kind.OPEN); }
		Grid set(BlockPos p, Kind k) { cells.put(p, k); return this; }
		public boolean solid(BlockPos p) { return at(p) == Kind.SOLID; }
		public boolean open(BlockPos p) { return at(p) == Kind.OPEN; }
		public boolean hazard(BlockPos p) { return at(p) == Kind.LAVA; }
	}

	private static final BlockPos FEET = new BlockPos(0, 64, 0);

	private static void verifySite() {
		check(PitTrap.site(new Grid(), FEET) != null, "flat solid ground is a pit site");
		check(PitTrap.site(new Grid().set(FEET.below(2), Kind.OPEN), FEET) == null, "a cave under the stance: no pit (the floor is not where it should be)");
		check(PitTrap.site(new Grid().set(FEET.below(3), Kind.OPEN), FEET) == null, "air under the pit floor: no pit");
		check(PitTrap.site(new Grid().set(FEET.below(2).east(), Kind.LAVA), FEET) == null, "lava beside the pit: no pit (it would pour in)");
		check(PitTrap.site(new Grid().set(FEET.below().north().east(), Kind.OPEN), FEET) == null,
				"a low rim cell on a diagonal: no pit (an enderman with its feet at G-1 reaches into the pit)");
		check(PitTrap.site(new Grid().set(FEET.east(), Kind.LAVA), FEET) == null, "lava at ground level beside the body: no pit");
		check(PitTrap.site(new Grid().set(FEET.below().south(), Kind.LAVA), FEET) == null, "lava in the rim: no pit");
		check(PitTrap.site(new Grid().set(FEET.below(4), Kind.LAVA), FEET) == null, "lava right under the floor: no pit");
		Grid cave = new Grid().set(FEET.below(2), Kind.OPEN);
		BlockPos near = PitTrap.nearestSite(cave, FEET);
		check(near != null && near.getY() == FEET.getY() && Math.max(Math.abs(near.getX()), Math.abs(near.getZ())) == 2,
				"a cave under the feet: the nearest site is two steps off, clear of the cave's rim");
		check(PitTrap.nearestSite(new Grid(), FEET).equals(FEET), "the feet are a site: no step");
		Grid lavaSea = new Grid();
		for (int dx = -5; dx <= 5; dx++) for (int dz = -5; dz <= 5; dz++) lavaSea.set(FEET.offset(dx, -4, dz), Kind.LAVA);
		check(PitTrap.nearestSite(lavaSea, FEET) == null, "lava under every floor near: no site to step to");
	}

	private static void verifySupports() {
		Grid flat = new Grid();
		check(PitTrap.supportCost(flat, FEET, Direction.NORTH) == 2, "flat ground: two blocks build the cap's support");
		check(PitTrap.blocksNeeded(flat, FEET, Direction.NORTH) == 3, "flat ground: 3 blocks carried (two supports and the cap)");
		Grid stem = new Grid().set(FEET.east(), Kind.SOLID).set(FEET.east().above(), Kind.SOLID);
		check(PitTrap.site(stem, FEET) == Direction.EAST, "a stem beside the body at cap height holds the cap: that side wins");
		check(PitTrap.blocksNeeded(stem, FEET, Direction.EAST) == 1, "with a natural support only the cap is carried");
		Grid step = new Grid().set(FEET.west(), Kind.SOLID);
		check(PitTrap.supportCost(step, FEET, Direction.WEST) == 1, "a one-high step beside: one block on it");
		check(PitTrap.site(step, FEET) == Direction.WEST, "the side needing fewer placed blocks wins");
	}

	private static void verifyExisting() {
		BlockPos ground = FEET;
		Grid built = new Grid().set(ground.below(), Kind.OPEN).set(ground.below(2), Kind.OPEN)
				.set(ground.above(), Kind.SOLID).set(ground.north(), Kind.SOLID).set(ground.north().above(), Kind.SOLID);
		PitTrap inPit = PitTrap.existing(built, ground.below(2));
		check(inPit != null && inPit.phase == PitTrap.Phase.PIT && inPit.ground.equals(ground), "feet 2 under a capped column: the trap stands, the body in its pit");
		Grid stance = new Grid().set(ground.below(), Kind.OPEN).set(ground.above(), Kind.SOLID).set(ground.north().above(), Kind.SOLID);
		PitTrap inStance = PitTrap.existing(stance, ground.below());
		check(inStance != null && inStance.phase == PitTrap.Phase.STANCE && inStance.inStance(ground.below()), "feet 1 under the cap: the body in the stance");
		check(PitTrap.existing(new Grid(), FEET) == null, "open sky over the body: no trap");
		check(PitTrap.existing(new Grid().set(ground.below(), Kind.OPEN).set(ground.below().east(), Kind.OPEN).set(ground.above(), Kind.SOLID), ground.below()) == null,
				"an open side at the feet: not a trap");
	}

	private static void verifyDropAndRise() {
		check(PitTrap.drop(true, false), "one hunting the body: down into the pit");
		check(PitTrap.drop(false, true), "low health in the stance: down into the pit");
		check(!PitTrap.drop(false, false), "calm around: stay in the stance and stare");
		check(!PitTrap.rise(PitTrap.CLEAR_MS - 1, false, false), "one hunted the body a moment ago: stay in the pit");
		check(PitTrap.rise(PitTrap.CLEAR_MS, false, false), "none hunting it for the clear spell: back up to the stance");
		check(!PitTrap.rise(PitTrap.CLEAR_MS * 10, true, false), "mid-fight: stay");
		check(!PitTrap.rise(PitTrap.CLEAR_MS * 10, false, true), "low health: stay in the pit");
		check(PitTrap.returning(PitTrap.Phase.AWAY, 1) && PitTrap.returning(PitTrap.Phase.BACK, 5), "out for a pearl short of 12: the count waits until the body is back under the cap");
		check(!PitTrap.returning(PitTrap.Phase.AWAY, PitTrap.LEAVE_AT), "12 pearls held: the count ends where the body is");
		check(!PitTrap.returning(PitTrap.Phase.STANCE, 1) && !PitTrap.returning(PitTrap.Phase.PIT, 1), "inside the trap: the count ends there");
		PitTrap trap = new PitTrap(FEET, Direction.NORTH, PitTrap.Phase.STANCE);
		check(trap.cap().equals(FEET.above()) && trap.pit().equals(FEET.below(2)) && trap.high().equals(FEET.north().above()),
				"the cap is one over the ground cell, the pit two under, the support beside the cap");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
