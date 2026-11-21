package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import java.util.function.Function;

/** travel_to out of water: air before a bank under a roof, breath bounds every swim under water, no swimming off a drop. */
public final class SwimOutVerification {
	private static int assertions;

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " swim-out assertions");
	}

	public static int verify() {
		assertions = 0;
		check(ServerTravelController.underWater(300, false, 3.0D, false, 8.0D, false) == ServerTravelController.SwimStep.AIR,
				"a known route to air comes before a low bank under a roof");
		check(ServerTravelController.underWater(300, false, 0.0D, false, 2.0D, false) == ServerTravelController.SwimStep.AIR,
				"already under the air cell: rise, even with a bank beside");
		// No route to air seen (a roofed, flooded passage): the bank only when the breath left covers it with the reserve kept.
		check(ServerTravelController.underWater(300, false, Double.NaN, false, 8.0D, false) == ServerTravelController.SwimStep.SHORE,
				"no air route, a bank 8 blocks away on a full breath: swim to it");
		check(ServerTravelController.underWater(120, false, Double.NaN, false, 20.0D, true) == ServerTravelController.SwimStep.STOP,
				"looked round, a bank 20 blocks away on 6 s of air: stop, never swim farther than the air");
		check(ServerTravelController.underWater(300, false, Double.NaN, false, 30.0D, true) == ServerTravelController.SwimStep.STOP,
				"a bank farther than a full breath is never swum to under water");
		// Air running out: an air route longer than the breath left is not started either.
		check(ServerTravelController.underWater(40, false, 6.0D, false, Double.NaN, false) == ServerTravelController.SwimStep.STOP,
				"2 s of air, air 6 blocks away under a ceiling: stop with the air reported");
		check(ServerTravelController.underWater(40, false, 6.0D, true, Double.NaN, false) == ServerTravelController.SwimStep.AIR,
				"2 s of air, open water straight up 6 blocks: rise anyway, stopping there only drowns");
		check(ServerTravelController.underWater(0, false, 6.0D, true, 9.0D, true) == ServerTravelController.SwimStep.AIR,
				"no air left, open water straight up: still up, never off to a bank");
		check(ServerTravelController.underWater(40, false, 2.0D, false, Double.NaN, false) == ServerTravelController.SwimStep.AIR,
				"2 s of air, air 2 blocks away: the reserve is spent reaching it");
		check(ServerTravelController.underWater(300, true, Double.NaN, false, 30.0D, false) == ServerTravelController.SwimStep.WAIT,
				"the route to air still being found, the only bank beyond the breath: rise in place");
		check(ServerTravelController.underWater(300, false, Double.NaN, false, Double.NaN, false) == ServerTravelController.SwimStep.LOOK,
				"nothing seen yet on a full breath: look round once for the way up (a flooded stair turns out of sight)");
		check(ServerTravelController.underWater(300, false, Double.NaN, false, Double.NaN, true) == ServerTravelController.SwimStep.STOP,
				"looked round and still no way up or bank: stop, never swim blind under water");
		check(ServerTravelController.underWater(50, true, Double.NaN, false, Double.NaN, false) == ServerTravelController.SwimStep.STOP,
				"at the reserve with nothing found: stop");

		// The last step into a lit portal: walked in from up to 2 above its floor (lava-gate-1 stood 1.2 above, 1 block off).
		check(ServerTravelController.nudgesIntoPortal(1.3D * 1.3D + 0.1D * 0.1D, 1.2D), "1.2 above the floor, 1.3 blocks across: walk in");
		check(ServerTravelController.nudgesIntoPortal(1.0D, -0.5D), "half a block below the floor: walk in, as before");
		check(!ServerTravelController.nudgesIntoPortal(1.0D, 2.6D), "on the frame's top, 2.6 above: no walk in (a fall onto the frame)");
		check(!ServerTravelController.nudgesIntoPortal(9.0D, 0.0D), "3 blocks across: a leg, not a nudge");
		check(ServerTravelController.stepsUpToPortal(1.1D * 1.1D, -2.0D), "2 below the floor beside the frame (lava-gate-1's ledge): pillar one, then step in");
		check(!ServerTravelController.stepsUpToPortal(1.0D, -0.5D), "within a block of the floor: no pillar, the walk in does it");
		check(!ServerTravelController.stepsUpToPortal(1.0D, -3.5D), "3.5 below: not one block's climb");
		check(!ServerTravelController.nudgesIntoPortal(1.1D * 1.1D, -2.0D), "2 below: no plain walk in");
		check(ServerTravelController.underWater(85, false, Double.NaN, false, Double.NaN, false, true) == ServerTravelController.SwimStep.PEEK,
				"capped head, no way up seen, 4 s of air: duck out to the open cell beside (stopping there only drowns it)");
		check(ServerTravelController.underWater(50, false, Double.NaN, false, Double.NaN, true, true) == ServerTravelController.SwimStep.PEEK,
				"at the reserve and looked round, the head still capped: duck out before stopping");
		check(ServerTravelController.underWater(85, false, 3.0D, false, Double.NaN, false, true) == ServerTravelController.SwimStep.AIR,
				"a seen way up still comes first");
		check(ServerTravelController.underWater(300, false, Double.NaN, false, 8.0D, false, true) == ServerTravelController.SwimStep.SHORE,
				"a bank within the breath still comes before a peek");
		check(ServerTravelController.underWater(85, false, 30.0D, false, Double.NaN, true, true) == ServerTravelController.SwimStep.STOP,
				"a seen route too long for the breath: the breath rule stops it, no peek");

		// Straight up means the body's own column, every cell open: a detour round an overhead block through the column
		// beside it (a flooded shaft going up 6) is not, so it goes through the breath rule.
		net.minecraft.core.BlockPos eye = new net.minecraft.core.BlockPos(10, 60, 10);
		java.util.List<net.minecraft.core.BlockPos> column = java.util.List.of(eye, eye.above(), eye.above(2), eye.above(3), eye.above(4), eye.above(5), eye.above(6));
		java.util.List<net.minecraft.core.BlockPos> detour = java.util.List.of(eye, eye.east(), eye.east().above(), eye.east().above(2), eye.east().above(3),
				eye.east().above(4), eye.east().above(5), eye.east().above(6));
		check(ServerTravelController.openColumnUp(column, 10, 10, cell -> true), "open water up the body's own column: straight up");
		check(!ServerTravelController.openColumnUp(detour, 10, 10, cell -> true), "a shaft in the next column round an overhead block: not straight up");
		check(!ServerTravelController.openColumnUp(column, 10, 10, cell -> cell.getY() != 63), "a solid or non-water cell in the column: not straight up");
		check(ServerTravelController.underWater(40, false, 7.0D, ServerTravelController.openColumnUp(detour, 10, 10, cell -> true), Double.NaN, false)
				== ServerTravelController.SwimStep.STOP, "2 s of air, the detour shaft 7 blocks: the breath rule stops it");
		WalkabilityView cliff = view(cell -> cell.x() <= 2 ? (cell.y() <= 63 && cell.y() >= 60 ? WalkabilityView.Cell.WATER : cell.y() < 60 ? WalkabilityView.Cell.SAFE_SUPPORT
				: cell.y() == 64 ? WalkabilityView.Cell.WATER : WalkabilityView.Cell.CLEAR) : cell.y() <= 50 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR);
		check(ServerTravelController.dropAhead(cliff, 1.5D, 64, 0.5D, -90.0F), "open air past the edge with the floor 14 below: a drop");
		check(!ServerTravelController.dropAhead(cliff, 0.5D, 64, 0.5D, 90.0F), "water ahead (west, back into the pool): no drop");
		WalkabilityView bank = view(cell -> cell.x() <= 2 ? (cell.y() <= 64 ? WalkabilityView.Cell.WATER : WalkabilityView.Cell.CLEAR)
				: cell.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR);
		check(!ServerTravelController.dropAhead(bank, 1.5D, 64, 0.5D, -90.0F), "a bank level with the water: floor under the cell ahead");
		WalkabilityView wall = view(cell -> cell.x() <= 2 ? (cell.y() <= 64 ? WalkabilityView.Cell.WATER : WalkabilityView.Cell.CLEAR)
				: cell.y() <= 66 ? WalkabilityView.Cell.BLOCKED : WalkabilityView.Cell.CLEAR);
		check(!ServerTravelController.dropAhead(wall, 1.5D, 64, 0.5D, -90.0F), "a wall ahead is not a drop");
		WalkabilityView step = view(cell -> cell.x() <= 2 ? (cell.y() <= 64 ? WalkabilityView.Cell.WATER : WalkabilityView.Cell.CLEAR)
				: cell.y() <= 61 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR);
		check(!ServerTravelController.dropAhead(step, 1.5D, 64, 0.5D, -90.0F), "floor 3 below past the edge: a drop the walking code takes");
		WalkabilityView lip = view(cell -> cell.x() <= 3 && cell.y() == 64 ? WalkabilityView.Cell.WATER : cell.x() <= 2 && cell.y() == 63 ? WalkabilityView.Cell.SAFE_SUPPORT
				: cell.y() <= 50 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR);
		check(ServerTravelController.dropAhead(lip, 1.5D, 64, 0.5D, -90.0F), "water spilling over an edge with air below: a drop");
		WalkabilityView fall = view(cell -> cell.x() <= 2 ? (cell.y() == 64 ? WalkabilityView.Cell.WATER : cell.y() == 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR)
				: cell.x() == 3 && cell.y() <= 64 && cell.y() > 50 ? WalkabilityView.Cell.WATER : cell.y() <= 50 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR);
		check(!ServerTravelController.dropAhead(fall, 1.5D, 64, 0.5D, -90.0F), "a waterfall's full column ahead: a landing, not a dry fall");
		check(!ServerTravelController.dropAhead(cliff, 0.5D, 62, 0.5D, 90.0F), "still deep water ahead: no drop");
		WalkabilityView unseen = view(cell -> cell.x() <= 2 ? (cell.y() <= 64 ? WalkabilityView.Cell.WATER : WalkabilityView.Cell.CLEAR) : WalkabilityView.Cell.UNLOADED);
		check(ServerTravelController.dropAhead(unseen, 1.5D, 64, 0.5D, -90.0F), "unseen terrain ahead is not swum into blind");

		// Across water toward the target (gate B-5's beach): from the sand (x <= 2, feet at y 64) east into the sea, whose
		// surface is at y 63 one block down from the feet.
		WalkabilityView beach = view(cell -> cell.x() <= 2 ? (cell.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR)
				: cell.y() <= 55 ? WalkabilityView.Cell.SAFE_SUPPORT : cell.y() <= 63 ? WalkabilityView.Cell.WATER : WalkabilityView.Cell.CLEAR);
		check(ServerTravelController.waterAhead(beach, 1.5D, 64, 0.5D, -90.0F), "the sea a step ahead of the sand: wade in");
		check(!ServerTravelController.waterAhead(beach, 1.5D, 64, 0.5D, 90.0F), "sand ahead the other way: no water to wade into");
		WalkabilityView seawall = view(cell -> cell.x() <= 2 ? (cell.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR)
				: cell.x() == 3 ? (cell.y() <= 66 ? WalkabilityView.Cell.BLOCKED : WalkabilityView.Cell.CLEAR) : cell.y() <= 63 ? WalkabilityView.Cell.WATER : WalkabilityView.Cell.CLEAR);
		check(!ServerTravelController.waterAhead(seawall, 1.5D, 64, 0.5D, -90.0F), "a wall between the body and the water: no wading");
		check(!ServerTravelController.waterAhead(cliff, 1.5D, 64, 0.5D, -90.0F), "a drop ahead: no wading off it");
		check(ServerTravelController.waterAhead(cliff, 0.5D, 64, 0.5D, 90.0F), "the pool's own water ahead: wade back in");
		WalkabilityView lake = view(cell -> cell.x() <= 2 || cell.x() >= 13 ? (cell.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR)
				: cell.y() <= 55 ? WalkabilityView.Cell.SAFE_SUPPORT : cell.y() <= 63 ? WalkabilityView.Cell.WATER : WalkabilityView.Cell.CLEAR);
		check(ServerTravelController.bankAcross(lake, 1.5D, 64, 0.5D, -90.0F, 48), "a bank 11 blocks across the lake: swim it");
		check(!ServerTravelController.bankAcross(beach, 1.5D, 64, 0.5D, -90.0F, 48), "open sea with no bank within 48: do not set out");
		WalkabilityView foggy = view(cell -> cell.x() >= 20 ? WalkabilityView.Cell.UNLOADED : beach.cellAt(cell));
		check(!ServerTravelController.bankAcross(foggy, 1.5D, 64, 0.5D, -90.0F, 48), "the far side not loaded: no bank seen");
		check(ServerTravelController.crossingGains(Double.NaN, 80.0D), "not crossing: every bank counts");
		check(!ServerTravelController.crossingGains(50.0D, 49.0D), "crossing: the bank swum from (no nearer the target) is not taken");
		check(ServerTravelController.crossingGains(50.0D, 40.0D), "crossing: a far bank 10 blocks nearer the target is taken");
		return assertions;
	}

	private static WalkabilityView view(Function<GridPosition, WalkabilityView.Cell> cells) {
		return cells::apply;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
