package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import net.minecraft.core.BlockPos;

/** The escape job's choices (way out of water, way out of a hole) and its hole test, over synthetic terrain. */
public final class EscapeVerification {
	private EscapeVerification() {
	}

	/** Terrain: solid at or below {@code ground}, except the cells {@code hole} opens. */
	private interface Solid {
		boolean at(int x, int y, int z);
	}

	public static int verify() {
		int assertions = 0;
		// Water: little air or no bank swims first, a bank in reach is travelled to, a bank tried twice gets dry stairs once.
		check(ServerEscapeController.waterMove(true, 60, true, 1, false, true, false, 0) == ServerEscapeController.WaterMove.SWIM, "little air swims to air first");
		check(ServerEscapeController.waterMove(true, 300, false, 0, false, false, false, 0) == ServerEscapeController.WaterMove.SWIM, "no bank in reach swims to air");
		check(ServerEscapeController.waterMove(true, 300, true, 1, true, true, false, 0) == ServerEscapeController.WaterMove.TRAVEL, "full air with a bank travels out");
		check(ServerEscapeController.waterMove(false, 300, false, 0, false, false, false, 0, false, true) == ServerEscapeController.WaterMove.STEP,
				"afloat with air, no bank, a step cell beside: place the step (the flooded hole whose rim is 2 above)");
		check(ServerEscapeController.waterMove(false, 300, false, 0, false, false, false, 0, false, false) == ServerEscapeController.WaterMove.NO_SHORE,
				"afloat with air, no bank and no step cell: the stop as before");
		check(ServerEscapeController.waterMove(false, 300, false, 0, false, false, false, 0, true, true) == ServerEscapeController.WaterMove.FILL,
				"a confined shaft still fills before a step");
		check(ServerEscapeController.waterMove(true, 300, false, 0, false, false, false, 0, false, true) == ServerEscapeController.WaterMove.STEP,
				"eyes under with full air and a step cell: place it rather than swim off");
		check(ServerEscapeController.waterMove(true, 60, false, 0, false, false, false, 0, false, true) == ServerEscapeController.WaterMove.SWIM,
				"little air still swims to air first");
		check(ServerEscapeController.waterMove(false, 300, true, 1, true, true, false, 0, false, true) == ServerEscapeController.WaterMove.TRAVEL,
				"a bank still comes first");
		check(ServerEscapeController.waterMove(false, 300, true, 1, false, false, false, 3) == ServerEscapeController.WaterMove.TRAVEL, "afloat with a bank travels out");
		check(ServerEscapeController.waterMove(false, 300, true, 3, true, true, false, 0) == ServerEscapeController.WaterMove.STAIRS, "a bank missed twice from breathable footing gets sealed stairs");
		check(ServerEscapeController.waterMove(true, 300, true, 3, true, true, false, 0) == ServerEscapeController.WaterMove.TRAVEL, "with the eyes under water no stairs are cut (dig_to would stop at once)");
		check(ServerEscapeController.waterMove(false, 300, true, 3, true, true, true, 0) == ServerEscapeController.WaterMove.TRAVEL, "stairs are cut once per bank");
		check(ServerEscapeController.waterMove(true, 300, true, 5, true, true, true, 0) == ServerEscapeController.WaterMove.NO_WAY, "a bank missed four times hands back");
		check(ServerEscapeController.waterMove(false, 300, false, 0, false, false, false, 0) == ServerEscapeController.WaterMove.NO_SHORE, "afloat with no bank hands back breathing");
		check(ServerEscapeController.waterMove(true, 40, false, 0, false, false, false, 3) == ServerEscapeController.WaterMove.NO_WAY, "three failed swims and no bank hand back");
		check(ServerEscapeController.waterMove(true, 40, true, 1, false, true, false, 3) == ServerEscapeController.WaterMove.TRAVEL, "after three swims a known bank is travelled to");
		// A flooded shaft with no bank and blocks carried: fill under, afloat or with air in hand; swim first only on little air.
		check(ServerEscapeController.waterMove(false, 300, false, 0, false, false, false, 0, true) == ServerEscapeController.WaterMove.FILL, "afloat in a flooded shaft fills under");
		check(ServerEscapeController.waterMove(true, 250, false, 0, false, false, false, 0, true) == ServerEscapeController.WaterMove.FILL, "under water with air to spare fills under");
		check(ServerEscapeController.waterMove(true, 60, false, 0, false, false, false, 0, true) == ServerEscapeController.WaterMove.SWIM, "under water on little air swims to air first");
		check(ServerEscapeController.waterMove(false, 300, true, 1, false, false, false, 0, true) == ServerEscapeController.WaterMove.TRAVEL, "a bank in reach is still travelled to");
		assertions += 15;
		// Hole: level with the rim steps out; blocks and headroom pillar; else dug stairs; else no way.
		check(ServerEscapeController.pitMove(0, 0, false, false) == ServerEscapeController.PitMove.STEP_OUT, "level with the rim steps out");
		check(ServerEscapeController.climbsAfterStand(2, "pillar 2 up to the rim at y150") == 1
				&& ServerEscapeController.climbsAfterStand(1, "dig stairs 4 up to the rim at y150 heading east") == 0
				&& ServerEscapeController.climbsAfterStand(0, "step out onto the rim at 1,2,3") == 0,
				"a climb a mob stopped is given back when the body stands its ground, never below zero");
		check(ServerEscapeController.climbsAfterStand(2, "travel to the bank at 1,2,3") == 2 && ServerEscapeController.climbsAfterStand(2, null) == 2,
				"steps that are not climbs out of a hole keep their count");
		check(ServerEscapeController.pitMove(4, 4, true, true) == ServerEscapeController.PitMove.PILLAR, "four blocks under open sky pillar a four-deep hole");
		check(ServerEscapeController.pitMove(4, 3, true, true) == ServerEscapeController.PitMove.STAIRS, "too few blocks dig stairs");
		check(ServerEscapeController.pitMove(4, 9, false, true) == ServerEscapeController.PitMove.STAIRS, "a roof over the hole digs stairs");
		check(ServerEscapeController.pitMove(4, 0, true, false) == ServerEscapeController.PitMove.NO_WAY, "no blocks and no tool hands back");
		assertions += 5;
		// A 1x1 hole four deep in flat ground (surface y 63, body feet y 60): the rim is a ground cell at y 64.
		Solid oneByOne = (x, y, z) -> y <= 63 && !(x == 0 && z == 0 && y >= 60);
		BlockPos rim = rim(oneByOne, new GridPosition(0, 60, 0));
		check(rim != null && rim.getY() == 64 && Math.abs(rim.getX()) + Math.abs(rim.getZ()) == 1, "a 1x1 hole four deep has its rim beside it at ground level: " + rim);
		// A 3x3 pit three deep: trapped, rim at y 64.
		Solid pit = (x, y, z) -> y <= 63 && !(Math.abs(x) <= 1 && Math.abs(z) <= 1 && y >= 61);
		rim = rim(pit, new GridPosition(0, 61, 0));
		check(rim != null && rim.getY() == 64, "a 3x3 pit three deep is a hole with its rim at ground level: " + rim);
		// Flat ground: the walk gets far, no hole.
		check(rim((x, y, z) -> y <= 63, new GridPosition(0, 64, 0)) == null, "open flat ground is no hole");
		// A hole one deep: a step up, walkable, no hole.
		check(rim((x, y, z) -> y <= 63 && !(x == 0 && z == 0 && y == 63), new GridPosition(0, 63, 0)) == null, "a one-deep dip is a step, not a hole");
		// A long dead-end tunnel two high: the walk runs out along it, no hole.
		Solid tunnel = (x, y, z) -> !(z == 0 && x >= 0 && x <= 12 && (y == 40 || y == 41));
		check(rim(tunnel, new GridPosition(0, 40, 0)) == null, "a long tunnel is a way out, not a hole");
		// A pit open to a ledge on one side (a drop into a lower cave): not a closed hole.
		Solid ledge = (x, y, z) -> y <= 63 && !(x == 0 && z == 0 && y >= 60) && !(x == 1 && z == 0 && y >= 58 && y <= 61);
		check(rim(ledge, new GridPosition(0, 60, 0)) == null, "a side open to a drop is a way on, not a wall to climb");
		// A roofed 1x2 shelter dug into a hillside (a roof over the body): an enclosed space, never a hole to pillar out of.
		Solid roofed = (x, y, z) -> !(x == 0 && z == 0 && (y == 64 || y == 65)) && (y <= 63 || y >= 66 || x != 0 || z != 0);
		check(rim(roofed, new GridPosition(0, 64, 0)) == null, "a roofed cell is no pit");
		// Banks: a dry cell beside the body's own water counts, one beside another pool across a wall does not.
		java.util.Set<BlockPos> pool = java.util.Set.of(new BlockPos(0, 62, 0), new BlockPos(1, 62, 0));
		check(ServerEscapeController.besideWater(pool, new BlockPos(2, 63, 0)), "the cell beside the pool, a block up, is its bank");
		check(!ServerEscapeController.besideWater(pool, new BlockPos(5, 63, 0)), "a cell beside other water is no bank of this pool");
		assertions += 9;
		// Wade takeoff: feet at y 64 in column x 0 (box 0.2-0.8), a flooded step beside whose top is 65. The body must
		// rise to 65 + 1.8 in its own column, so a ceiling at y 66 over it blocks the jump; one at y 67 does not.
		Solid lowCeiling = (x, y, z) -> y <= 63 || y >= 66;
		check(!ServerEscapeController.takeoffClear(0.2, 0.8, 0.2, 0.8, 65.8, 65, at -> lowCeiling.at(at.getX(), at.getY(), at.getZ())),
				"a ceiling 2 above the feet blocks the takeoff onto a step one up");
		Solid tallerPassage = (x, y, z) -> y <= 63 || y >= 67;
		check(ServerEscapeController.takeoffClear(0.2, 0.8, 0.2, 0.8, 65.8, 65, at -> tallerPassage.at(at.getX(), at.getY(), at.getZ())),
				"a ceiling 3 above the feet leaves room to get onto a step one up");
		// Afloat on the flooded stair (feet 0.3 above the floor top at 41, the step top 42, the column 3 high): clear.
		Solid stairColumn = (x, y, z) -> x == 0 ? y <= 40 || y >= 44 : y <= 41 || y >= 45;
		check(ServerEscapeController.takeoffClear(0.2, 0.8, 0.2, 0.8, 41.3 + 1.8, 42, at -> stairColumn.at(at.getX(), at.getY(), at.getZ())),
				"the flooded stair's 3-high column leaves room to wade onto the next step");
		// The box straddling two columns: a low ceiling over either one blocks it.
		Solid halfCeiling = (x, y, z) -> y <= 63 || (x == 1 && y >= 66);
		check(!ServerEscapeController.takeoffClear(0.7, 1.3, 0.2, 0.8, 65.8, 65, at -> halfCeiling.at(at.getX(), at.getY(), at.getZ())),
				"a ceiling over part of the body's box still blocks the takeoff");
		// The blocks to open for that takeoff: the one ceiling cell over the body, only the covered column's cell when it
		// straddles two, none under a taller passage (seed 6006: a steep cut's roof over a body floating beside its step).
		check(ServerEscapeController.takeoffBlocks(0.2, 0.8, 0.2, 0.8, 65.8, 65, at -> lowCeiling.at(at.getX(), at.getY(), at.getZ()))
				.equals(java.util.List.of(new BlockPos(0, 66, 0))), "the ceiling cell over the head is the one to open");
		check(ServerEscapeController.takeoffBlocks(0.7, 1.3, 0.2, 0.8, 65.8, 65, at -> halfCeiling.at(at.getX(), at.getY(), at.getZ()))
				.equals(java.util.List.of(new BlockPos(1, 66, 0))), "only the ceiling over the covered column is opened");
		check(ServerEscapeController.takeoffBlocks(0.2, 0.8, 0.2, 0.8, 65.8, 65, at -> tallerPassage.at(at.getX(), at.getY(), at.getZ())).isEmpty(),
				"a taller passage needs nothing opened");
		assertions += 3;
		// Already as high as the step needs: nothing to check.
		check(ServerEscapeController.takeoffClear(0.2, 0.8, 0.2, 0.8, 66.9, 65, at -> true), "a body already high enough needs no headroom check");
		// The water-exit climb (test-water-exit-live, 23 Nov): a ledge top up to 0.875 over the water's top face climbed from
		// every start; 0.9375 never did.
		check(SwimPlanning.climbsOut(64.875, 64), "a ledge 0.875 over the water is climbed (measured)");
		check(!SwimPlanning.climbsOut(64.9375, 64), "a ledge 0.9375 over the water is not (measured)");
		check(SwimPlanning.climbsOut(64, 64) && SwimPlanning.climbsOut(63.5, 64), "a bank level with or under the water's top is climbed");
		check(!SwimPlanning.climbsOut(65, 64), "a full block over the water's top is out of reach: a step there raises the way out (iron-kit seed 6006)");
		// The top of a column's water, rising from a cell: water at 40..42 tops out at 43; no water at the start is none.
		java.util.function.IntPredicate column = y -> y >= 40 && y <= 42;
		check(SwimPlanning.waterTop(40, column) == 43 && SwimPlanning.waterTop(42, column) == 43, "the column's water tops out at its highest cell's top face");
		check(SwimPlanning.waterTop(43, column) == Integer.MIN_VALUE, "a dry start cell has no water top");
		// Beside a bank in reach the body pushes onto it with its eyes under water too; low air swims to air first.
		check(ServerEscapeController.climbFirst(true, 0, true, 300), "eyes under beside a bank in reach: push onto it (fresh-r3)");
		check(ServerEscapeController.climbFirst(true, 0, false, 300), "afloat beside a bank: push onto it, as before");
		check(!ServerEscapeController.climbFirst(true, 0, true, 60), "eyes under with little air: swim to air first");
		check(!ServerEscapeController.climbFirst(false, 0, false, 300) && !ServerEscapeController.climbFirst(true, ServerEscapeController.MAX_TRIES, false, 300),
				"no bank in reach, or the climbs spent: no push");
		assertions += 10;
		assertions += 5;
		return assertions;
	}

	private static BlockPos rim(Solid solid, GridPosition start) {
		WalkabilityView view = cell -> solid.at(cell.x(), cell.y(), cell.z()) ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		var reach = SafeStep.reachable(view, start, ServerEscapeController.PIT_STEPS, ServerEscapeController.PIT_CELLS);
		return ServerEscapeController.rim(reach, start, new ServerEscapeController.Cells() {
			public boolean solid(BlockPos cell) { return solid.at(cell.getX(), cell.getY(), cell.getZ()); }
			public boolean standable(BlockPos feet) {
				return solid.at(feet.getX(), feet.getY() - 1, feet.getZ()) && !solid.at(feet.getX(), feet.getY(), feet.getZ())
						&& !solid.at(feet.getX(), feet.getY() + 1, feet.getZ());
			}
		});
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
