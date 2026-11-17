package dev.agaminggod.mineagen.server.perception;

public final class VoidEdgeVerification {
	private static int assertions;

	private VoidEdgeVerification() {
	}

	public static void main(String[] args) {
		System.out.println("VoidEdgeVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		VoidEdge.Columns rim = (x, z) -> x >= 71;
		// Sprinting east (yaw -90) with the box still over the rim column: stopped before it leaves it.
		check(VoidEdge.scan(70.6D, 0.5D, 1.0F, 0.0F, -90.0F, 0.153D, rim) != null, "a sprint at the rim stops");
		// Released input then slides about 2.2 x 0.153 blocks: the first flagged point leaves room for that slide.
		double[] hit = VoidEdge.scan(70.6D, 0.5D, 1.0F, 0.0F, -90.0F, 0.153D, rim);
		check(hit != null && hit[0] - 0.299D >= 71.0D, "the flagged point is where the whole box is over the void");
		double firstFlagged = firstFlaggedX(rim, 0.153D);
		check(firstFlagged + 2.2D * 0.153D + 0.28D < 71.299D, "a sprint flagged at its first unsafe tick stops on the rim: " + firstFlagged);
		check(VoidEdge.scan(69.0D, 0.5D, 1.0F, 0.0F, -90.0F, 0.0D, rim) == null, "two blocks in, starting a walk is not stopped");
		check(VoidEdge.scan(70.9D, 0.5D, 1.0F, 0.0F, 90.0F, 0.153D, rim) == null, "walking back inland from the rim is not stopped");
		check(VoidEdge.scan(70.9D, 0.5D, 1.0F, 0.0F, 0.0F, 0.153D, rim) == null, "walking along the rim keeps the box over ground");
		check(VoidEdge.scan(70.9D, 0.5D, 0.0F, 0.0F, -90.0F, 0.153D, rim) == null, "no walking input is never stopped");
		// Facing south (yaw 0), strafe right (-1) walks toward -x: vanilla's strafe sign.
		VoidEdge.Columns west = (x, z) -> x < 0;
		check(VoidEdge.scan(0.4D, 0.5D, 0.0F, -1.0F, 0.0F, 0.1D, west) != null, "strafing right off a west rim stops");
		check(VoidEdge.scan(0.4D, 0.5D, 0.0F, 1.0F, 0.0F, 0.1D, west) == null, "strafing left away from it does not");
		return assertions;
	}

	private static double firstFlaggedX(VoidEdge.Columns rim, double speed) {
		for (double x = 68.0D; x < 72.0D; x += 0.28D) {
			if (VoidEdge.scan(x, 0.5D, 1.0F, 0.0F, -90.0F, speed, rim) != null) return x;
		}
		return Double.NaN;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
