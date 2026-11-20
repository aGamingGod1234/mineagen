package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.LocalPathfinder;
import dev.agaminggod.mineagen.client.navigation.PathNode;
import dev.agaminggod.mineagen.client.navigation.PathPlan;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

/**
 * Nether lava safety. Lava killed 10 agents in 7 of 22 games, 6 with no mob near: same-level
 * walk-ins and floods. Pins the contract's lava rules: the step guard refuses a move whose coast to a stop would touch
 * lava at the body's own level and nothing else; the seal picks a face to place against; navigation routes go round
 * cells lava fills next (a body already in the flow may still walk out); a bridge over a lava sea still plans.
 */
public final class LavaStepVerification {
	private static int assertions;
	private static final BlockState AIR = Blocks.AIR.defaultBlockState();
	private static final BlockState STONE = Blocks.NETHERRACK.defaultBlockState();
	private static final BlockState LAVA = Blocks.LAVA.defaultBlockState();
	private static final double WALK = 0.216D;
	private static final double ACCELERATION = 0.13D;

	private LavaStepVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " lava step assertions");
	}

	public static int verify() {
		assertions = 0;
		verifyStepGuard();
		verifySealFace();
		verifyRouteRefusal();
		verifyBridgeOverLavaSea();
		return assertions;
	}

	/** Floor of netherrack at y 63 everywhere, air above, with the cells set. */
	private static final class Room {
		final Map<Long, BlockState> blocks = new HashMap<>();

		Room set(int x, int y, int z, BlockState state) {
			blocks.put(BlockPos.asLong(x, y, z), state);
			return this;
		}

		BlockState at(int x, int y, int z) {
			BlockState state = blocks.get(BlockPos.asLong(x, y, z));
			if (state != null) return state;
			return y <= 63 ? STONE : AIR;
		}
	}

	/** The player's 0.6 x 1.8 box with its feet centred at (x, 64, z). */
	private static AABB body(double x, double z) {
		return new AABB(x - 0.3D, 64.0D, z - 0.3D, x + 0.3D, 65.8D, z + 0.3D);
	}

	private static void verifyStepGuard() {
		// A lava source at the feet two cells east of the body's cell, level with the walk.
		Room room = new Room().set(2, 64, 0, LAVA);
		LavaStep.Read read = room::at;
		double[] east = {1.0D, 0.0D}, north = {0.0D, -1.0D};
		check(LavaStep.touched(read, body(1.5D, 0.5D)) == null, "a body centred in the cell beside lava does not touch it");
		check(new BlockPos(2, 64, 0).equals(LavaStep.touched(read, body(1.75D, 0.5D))), "a box over the cell boundary touches the lava");
		check(new BlockPos(2, 64, 0).equals(LavaStep.refused(read, body(1.5D, 0.5D), WALK, 0.0D, east, ACCELERATION)),
				"walking east at speed from the cell beside it would coast into the lava: refused");
		check(LavaStep.refused(read, body(0.5D, 0.5D), 0.0D, 0.0D, east, ACCELERATION) == null,
				"a first step east from two cells away stops short of it: allowed");
		check(LavaStep.refused(read, body(1.5D, 0.5D), 0.0D, -WALK, north, ACCELERATION) == null,
				"walking along the lava, beside it, is allowed");
		check(LavaStep.refused(read, body(1.9D, 0.5D), WALK, 0.0D, east, ACCELERATION) == null,
				"a body already in the lava is not held: the hazard floor gets it out");
		// Lava at head height only (a flow over a low wall, a pour from above the step).
		Room head = new Room().set(2, 65, 0, LAVA).set(2, 64, 0, STONE);
		check(LavaStep.refused(head::at, body(1.5D, 0.5D), WALK, 0.0D, east, ACCELERATION) == null,
				"a step up blocked by a wall is no lava touch at the feet, and the head row is checked too");
		Room overhang = new Room().set(2, 65, 0, LAVA);
		check(new BlockPos(2, 65, 0).equals(LavaStep.refused(overhang::at, body(1.5D, 0.5D), WALK, 0.0D, east, ACCELERATION)),
				"lava at head height ahead is refused like lava at the feet");
		// A thin flow across the floor (level 7, a ninth of a block deep) still burns.
		Room thin = new Room().set(2, 64, 0, LAVA.setValue(LiquidBlock.LEVEL, 7));
		check(LavaStep.refused(thin::at, body(1.5D, 0.5D), WALK, 0.0D, east, ACCELERATION) != null,
				"a thin flowing edge on the floor is refused");
		// A sprint jump east from two cells short of a lava strip at the feet comes down in it: refused. A wall over the
		// way stops the jump first; a jump along the strip lands on the floor.
		Room strip = new Room();
		for (int x = 3; x <= 5; x++) for (int z = -3; z <= 3; z++) strip.set(x, 64, z, LAVA);
		check(new BlockPos(3, 64, 0).equals(LavaStep.jumpLands(strip::at, body(0.5D, 0.5D), jumpShifts(east, true))),
				"a sprint jump that comes down in same-level lava is refused");
		Room walled = new Room();
		for (int x = 3; x <= 5; x++) for (int z = -3; z <= 3; z++) walled.set(x, 64, z, LAVA);
		for (int z = -3; z <= 3; z++) { walled.set(2, 64, z, STONE); walled.set(2, 65, z, STONE); walled.set(2, 66, z, STONE); }
		check(LavaStep.jumpLands(walled::at, body(0.5D, 0.5D), jumpShifts(east, true)) == null, "a wall in the way stops the jump before the lava");
		check(LavaStep.jumpLands(strip::at, body(0.5D, -5.5D), jumpShifts(new double[] {-1.0D, 0.0D}, true)) == null,
				"a jump away from the lava lands on the floor");
		// Lava a block below the walk (a pool beside a ledge) is the drop check's (BrinkGuard.fall), not this one's.
		Room pool = new Room().set(2, 63, 0, LAVA);
		check(LavaStep.touched(pool::at, body(2.5D, 0.5D)) == null, "a box standing over a lava pool does not touch it at its feet");
	}

	private static double[][] jumpShifts(double[] heading, boolean sprint) {
		double[][] shifts = new double[BrinkGuard.JUMP_AIR_TICKS + 3 - BrinkGuard.JUMP_FIRST_LANDING_TICK][];
		for (int ticks = BrinkGuard.JUMP_FIRST_LANDING_TICK; ticks <= BrinkGuard.JUMP_AIR_TICKS + 2; ticks++)
			shifts[ticks - BrinkGuard.JUMP_FIRST_LANDING_TICK] = BrinkGuard.jumpDisplacement(0.0D, 0.0D, heading, sprint, ticks);
		return shifts;
	}

	private static void verifySealFace() {
		BlockPos lava = new BlockPos(2, 64, 0);
		Predicate<BlockPos> floor = pos -> pos.getY() <= 63;
		check(LavaStep.sealFace(lava, floor) == Direction.UP, "a flow on a floor is plugged on the floor's top face");
		Predicate<BlockPos> west = pos -> pos.equals(new BlockPos(1, 64, 0));
		check(LavaStep.sealFace(lava, west) == Direction.EAST, "with no floor, the block goes against a solid side (clicked from the west)");
		check(lava.relative(Direction.EAST.getOpposite()).equals(new BlockPos(1, 64, 0)), "the clicked support is the solid side");
		check(LavaStep.sealFace(lava, pos -> false) == null, "lava with nothing solid beside it cannot be plugged");
	}

	/** A flat floor at y 63 with feet cells at y 64; {@code fills} marks the cells lava fills next. */
	private static WalkabilityView flat(Predicate<GridPosition> fills, boolean refuses) {
		return new WalkabilityView() {
			@Override
			public Cell cellAt(GridPosition position) {
				if (Math.abs(position.x()) > 12 || Math.abs(position.z()) > 12) return Cell.BLOCKED;
				return position.y() <= 63 ? Cell.SAFE_SUPPORT : Cell.CLEAR;
			}

			@Override
			public boolean lavaFillsNext(GridPosition position) {
				return fills.test(position);
			}

			@Override
			public boolean refusesLavaFlowCells() {
				return refuses;
			}
		};
	}

	private static boolean found(PathPlan plan) {
		return plan.outcome() == dev.agaminggod.mineagen.client.navigation.PathOutcome.FOUND;
	}

	private static boolean crosses(PathPlan plan, Predicate<GridPosition> cells) {
		for (PathNode node : plan.nodes()) if (cells.test(node.position())) return true;
		return false;
	}

	private static void verifyRouteRefusal() {
		Predicate<GridPosition> wall = p -> p.y() == 64 && p.x() == 3 && Math.abs(p.z()) <= 1;
		GridPosition start = new GridPosition(0, 64, 0), end = new GridPosition(6, 64, 0);
		PathPlan round = new LocalPathfinder().findPath(flat(wall, true), start, end);
		check(found(round), "a route still exists round the flow: " + round.outcome());
		check(!crosses(round, wall), "the route goes round every cell lava fills next");
		PathPlan through = new LocalPathfinder().findPath(flat(wall, false), start, end);
		check(found(through) && crosses(through, wall), "a view that does not refuse (fight, flee) keeps its straight line");
		// Standing in the flow's way: the body walks out through flow cells to the first dry one.
		Predicate<GridPosition> lane = p -> p.y() == 64 && p.x() >= -1 && p.x() <= 1 && Math.abs(p.z()) <= 12;
		PathPlan out = new LocalPathfinder().findPath(flat(lane, true), start, new GridPosition(4, 64, 0));
		check(found(out), "a body in a flow's way may cross flow cells to get out: " + out.outcome());
	}

	private static void verifyBridgeOverLavaSea() {
		// A lava sea with its top at y 31; a bridge of placed netherrack at y 31 under feet at y 32.
		Map<Long, BlockState> sea = new HashMap<>();
		for (int x = -3; x <= 3; x++) for (int z = -3; z <= 3; z++) for (int y = 25; y <= 31; y++) sea.put(BlockPos.asLong(x, y, z), LAVA);
		for (int x = -3; x <= 3; x++) sea.put(BlockPos.asLong(x, 31, 0), STONE);
		MinecraftNavigationWorld.StateRead read = (x, y, z) -> sea.getOrDefault(BlockPos.asLong(x, y, z), y <= 24 ? STONE : AIR);
		check(!MinecraftNavigationWorld.lavaFills(read, 0, 32, 0), "a bridge cell over the sea is no cell lava fills next: the lava is below its support");
		check(!MinecraftNavigationWorld.lavaContact(read, 0, 32, 0), "nor does lava flow into it");
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
		assertions++;
	}
}
