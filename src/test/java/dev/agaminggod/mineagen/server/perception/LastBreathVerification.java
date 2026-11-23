package dev.agaminggod.mineagen.server.perception;

import java.util.List;
import net.minecraft.core.BlockPos;

/**
 * The way back to the last breath: the eye cells swum through under water since the eyes were last in air, newest first
 * and the breath cell last; a loop over its own track is cut, a teleport, a dimension change or a trail longer than a
 * breath drops it, and each breath starts it again.
 */
public final class LastBreathVerification {
	private LastBreathVerification() {
	}

	private static final String OVERWORLD = "minecraft:overworld";

	public static int verify() {
		int checks = 0;
		LastBreath dive = new LastBreath();
		dive.step(new BlockPos(0, 64, 0), false, OVERWORLD);
		for (int y = 63; y >= 60; y--) dive.step(new BlockPos(0, y, 0), true, OVERWORLD);
		for (int x = 1; x <= 12; x++) dive.step(new BlockPos(x, 60, 0), true, OVERWORLD);
		List<BlockPos> back = dive.wayBack(new BlockPos(12, 60, 0), OVERWORLD);
		checks += check(back.size() == 17 && back.get(0).equals(new BlockPos(12, 60, 0)) && back.get(16).equals(new BlockPos(0, 64, 0)),
				"down 4 and along 12: the way back starts at the eye cell and ends at the breath cell, 17 cells (got " + back + ")");
		checks += check(back.get(1).equals(new BlockPos(11, 60, 0)), "back the way it came: the cell swum through last comes first");
		checks += check(dive.wayBack(new BlockPos(5, 60, 0), OVERWORLD).isEmpty(), "asked from a cell that is not the eye's own: no way back");
		dive.step(new BlockPos(11, 60, 0), true, OVERWORLD);
		checks += check(dive.wayBack(new BlockPos(11, 60, 0), OVERWORLD).size() == 16, "swimming back over its own track cuts the loop");
		dive.step(new BlockPos(11, 61, 0), true, OVERWORLD);
		checks += check(dive.wayBack(new BlockPos(11, 61, 0), OVERWORLD).get(1).equals(new BlockPos(11, 60, 0)), "a new cell off the track joins the way back");
		dive.step(new BlockPos(30, 61, 0), true, OVERWORLD);
		checks += check(dive.wayBack(new BlockPos(30, 61, 0), OVERWORLD).isEmpty(), "a jump past one tick's swim (a teleport) drops the way back");
		dive.step(new BlockPos(31, 61, 0), true, OVERWORLD);
		checks += check(dive.wayBack(new BlockPos(31, 61, 0), OVERWORLD).isEmpty(), "and it stays unknown until the next breath");

		LastBreath far = new LastBreath();
		far.step(new BlockPos(0, 64, 0), false, OVERWORLD);
		for (int x = 1; x <= LastBreath.MAX_TRAIL; x++) far.step(new BlockPos(x, 63, 0), true, OVERWORLD);
		checks += check(far.wayBack(new BlockPos(LastBreath.MAX_TRAIL, 63, 0), OVERWORLD).isEmpty(), "a swim longer than any breath lasts keeps no way back");

		LastBreath other = new LastBreath();
		other.step(new BlockPos(0, 64, 0), false, OVERWORLD);
		other.step(new BlockPos(0, 63, 0), true, OVERWORLD);
		checks += check(other.wayBack(new BlockPos(0, 63, 0), "minecraft:the_nether").isEmpty(), "another dimension's eye cell is not on this way back");
		other.step(new BlockPos(0, 62, 0), true, "minecraft:the_nether");
		checks += check(other.wayBack(new BlockPos(0, 62, 0), "minecraft:the_nether").isEmpty(), "a dimension change drops the way back");
		other.step(new BlockPos(5, 70, 5), false, OVERWORLD);
		other.step(new BlockPos(5, 69, 5), true, OVERWORLD);
		checks += check(other.wayBack(new BlockPos(5, 69, 5), OVERWORLD).equals(List.of(new BlockPos(5, 69, 5), new BlockPos(5, 70, 5))), "each breath starts the way back again");
		return checks;
	}

	private static int check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		return 1;
	}
}
