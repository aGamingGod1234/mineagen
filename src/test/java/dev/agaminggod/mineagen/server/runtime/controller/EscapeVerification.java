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
		check(ServerEscapeController.waterMove(false, 300, true, 1, false, false, false, 3) == ServerEscapeController.WaterMove.TRAVEL, "afloat with a bank travels out");
		check(ServerEscapeController.waterMove(true, 300, true, 3, true, true, false, 0) == ServerEscapeController.WaterMove.STAIRS, "a bank missed twice from the floor gets sealed stairs");
		check(ServerEscapeController.waterMove(true, 300, true, 3, true, true, true, 0) == ServerEscapeController.WaterMove.TRAVEL, "stairs are cut once per bank");
		check(ServerEscapeController.waterMove(true, 300, true, 5, true, true, true, 0) == ServerEscapeController.WaterMove.NO_WAY, "a bank missed four times hands back");
		check(ServerEscapeController.waterMove(false, 300, false, 0, false, false, false, 0) == ServerEscapeController.WaterMove.NO_SHORE, "afloat with no bank hands back breathing");
		check(ServerEscapeController.waterMove(true, 40, false, 0, false, false, false, 3) == ServerEscapeController.WaterMove.NO_WAY, "three failed swims and no bank hand back");
		check(ServerEscapeController.waterMove(true, 40, true, 1, false, true, false, 3) == ServerEscapeController.WaterMove.TRAVEL, "after three swims a known bank is travelled to");
		assertions += 10;
		// Hole: level with the rim steps out; blocks and headroom pillar; else dug stairs; else no way.
		check(ServerEscapeController.pitMove(0, 0, false, false) == ServerEscapeController.PitMove.STEP_OUT, "level with the rim steps out");
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
		assertions += 6;
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
