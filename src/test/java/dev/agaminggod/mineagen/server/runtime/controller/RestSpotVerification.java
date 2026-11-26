package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.List;
import net.minecraft.core.Direction;

public final class RestSpotVerification {
	private RestSpotVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " rest spot assertions");
	}

	public static int verify() {
		int assertions = 0;
		List<int[]> offsets = ServerRestController.bedOffsets();
		// Radius 2 without the centre and the diagonals: 4 cells beside the feet, 4 two out, 8 at (2, 1).
		check(offsets.size() == 16, "bed foot offsets: 4 adjacent, 4 two out, 8 at (2, 1) = 16, got " + offsets.size());
		assertions++;
		int[] first = offsets.get(0);
		check(Math.abs(first[0]) + Math.abs(first[1]) == 1, "the nearest foot cells (right beside the feet) come first");
		assertions++;
		int last = offsets.get(offsets.size() - 1)[0] * offsets.get(offsets.size() - 1)[0] + offsets.get(offsets.size() - 1)[1] * offsets.get(offsets.size() - 1)[1];
		check(last == 5, "the (2, 1) cells come last");
		assertions++;
		for (int[] offset : offsets) {
			check(Math.abs(offset[0]) != Math.abs(offset[1]), "no diagonal offset: the facing there is ambiguous");
			Direction side = ServerRestController.sideOf(offset[0], offset[1]);
			check(side.getStepX() * offset[0] + side.getStepZ() * offset[1] == Math.max(Math.abs(offset[0]), Math.abs(offset[1])),
					"the bed's head points along the offset's larger axis, away from the body");
			assertions += 2;
		}
		check(ServerRestController.softDiggable(true, false) && ServerRestController.softDiggable(false, true) && !ServerRestController.softDiggable(false, false),
				"rest digs through mud and through sand or gravel");
		assertions++;
		check(ServerRestController.sideOf(2, -1) == Direction.EAST && ServerRestController.sideOf(-1, -2) == Direction.NORTH,
				"(2, -1) faces east and (-1, -2) faces north");
		assertions++;
		return assertions;
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
	}
}
