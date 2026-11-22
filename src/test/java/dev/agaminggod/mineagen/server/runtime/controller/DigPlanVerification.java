package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

public final class DigPlanVerification {
	private DigPlanVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " dig plan assertions");
	}

	public static int verify() {
		int assertions = 0;
		BlockPos feet = new BlockPos(10, 64, -3);
		for (Direction heading : List.of(Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST)) {
			for (ServerDigController.Pattern pattern : ServerDigController.Pattern.values()) {
				if (pattern == ServerDigController.Pattern.SHAFT) continue;
				for (BlockPos cell : ServerDigController.stepCells(pattern, feet, heading)) {
					check(!(cell.getX() == feet.getX() && cell.getZ() == feet.getZ() && cell.getY() < feet.getY()),
							pattern + " never opens the block the body stands on or anything below it");
					assertions++;
				}
			}
		}
		check(ServerDigController.stepCells(ServerDigController.Pattern.STAIRS_DOWN, feet, Direction.EAST)
				.equals(List.of(new BlockPos(11, 65, -3), new BlockPos(11, 64, -3), new BlockPos(11, 63, -3))),
				"a step down opens head, feet and the cell below, ahead, top first");
		assertions++;
		check(ServerDigController.stepTarget(ServerDigController.Pattern.STAIRS_DOWN, feet, Direction.EAST).equals(new BlockPos(11, 63, -3)),
				"a step down lands one block ahead and one lower");
		assertions++;
		check(ServerDigController.stepCells(ServerDigController.Pattern.STEEP_DOWN, feet, Direction.SOUTH)
				.equals(List.of(new BlockPos(10, 65, -2), new BlockPos(10, 64, -2), new BlockPos(10, 63, -2), new BlockPos(10, 62, -2))),
				"a steep step opens four cells ahead, top first");
		assertions++;
		check(ServerDigController.stepTarget(ServerDigController.Pattern.STEEP_DOWN, feet, Direction.SOUTH).equals(new BlockPos(10, 62, -2)),
				"a steep step drops two blocks: no fall damage");
		assertions++;
		check(ServerDigController.stepCells(ServerDigController.Pattern.STAIRS_UP, feet, Direction.NORTH)
				.equals(List.of(new BlockPos(10, 65, -4), new BlockPos(10, 66, -4), new BlockPos(10, 66, -3))),
				"a step up opens the next step's feet at eye level, then its head, then the jump headroom over the body");
		assertions++;
		check(ServerDigController.stepTarget(ServerDigController.Pattern.STAIRS_UP, feet, Direction.NORTH).equals(new BlockPos(10, 65, -4)),
				"a step up stands on the block ahead");
		assertions++;
		check(ServerDigController.stepCells(ServerDigController.Pattern.TUNNEL, feet, Direction.WEST)
				.equals(List.of(new BlockPos(9, 65, -3), new BlockPos(9, 64, -3))), "a tunnel opens two cells ahead");
		assertions++;
		check(ServerDigController.stepCells(ServerDigController.Pattern.SHAFT, feet, Direction.WEST).equals(List.of(new BlockPos(10, 63, -3)))
				&& ServerDigController.stepTarget(ServerDigController.Pattern.SHAFT, feet, Direction.WEST).equals(new BlockPos(10, 63, -3)),
				"a shaft step breaks only the block underfoot and drops one block into it, whatever the heading");
		assertions++;
		check(ServerDigController.Pattern.parse("shaft").down() && !ServerDigController.Pattern.STAIRS_UP.down(), "the shaft digs down");
		assertions++;
		check(ServerDigController.DEFAULT_MAX_SHAFT_Y == -20, "a shaft goes on as steep_down from y-20 down by default");
		// The rooms' kit (an iron and a stone pickaxe, about 380 uses) at y71 heading for y-54: the shaft, not stairs.
		check(!ServerDigController.stairsAffordable(380, 125), "a lava search short of pickaxe uses keeps the one-wide shaft");
		check(ServerDigController.stairsAffordable(380, 70), "a lava search whose pickaxes cover stairs and the reserve checks each floor");
		check(ServerDigController.stairsAffordable(Long.MAX_VALUE / 2, 300), "an unbreakable pickaxe always affords the stairs");
		// The check is priced at what it cuts: 2 per level, so 380 uses pay for 110 levels and the 160 reserve, not 111.
		check(ServerDigController.stairsAffordable(380, 110) && !ServerDigController.stairsAffordable(380, 111),
				"380 uses afford the floor check for the last 110 levels down and keep the reserve");
		// Two-column stairs turn back every step: count the cells they open over 20 levels below a 2-high start.
		java.util.Set<BlockPos> opened = new java.util.HashSet<>(List.of(new BlockPos(0, 70, 0), new BlockPos(0, 71, 0)));
		BlockPos stepFeet = new BlockPos(0, 70, 0);
		Direction turn = Direction.EAST;
		int cutCells = 0;
		for (int level = 0; level < 20; level++) {
			for (BlockPos cell : ServerDigController.stepCells(ServerDigController.Pattern.STAIRS_DOWN, stepFeet, turn)) if (opened.add(cell)) cutCells++;
			stepFeet = ServerDigController.stepTarget(ServerDigController.Pattern.STAIRS_DOWN, stepFeet, turn);
			turn = turn.getOpposite();
		}
		// The first step also opens its own head cell; every later one reuses the column the body left.
		check(stepFeet.getY() == 50 && cutCells == 1 + 20 * ServerDigController.STAIR_USES_PER_DEPTH,
				"two-column stairs cut " + ServerDigController.STAIR_USES_PER_DEPTH + " blocks per level, the price the floor check pays (cut " + cutCells + " over 20)");
		assertions++;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		check(net.minecraft.world.level.block.Blocks.SNOW_BLOCK.defaultDestroyTime() <= ServerDigController.HAND_BREAKS
				&& net.minecraft.world.level.block.Blocks.SNOW.defaultDestroyTime() <= ServerDigController.HAND_BREAKS
				&& net.minecraft.world.level.block.Blocks.STONE.defaultDestroyTime() > ServerDigController.HAND_BREAKS,
				"snow is dug by hand without a shovel; stone still needs its pickaxe");
		assertions++;
		check(TravelCheckpoints.left(0.5D, 60.0D, 0.5D, 0.5D, 40.0D, 0.5D, 3.0D) == 17.0D
				&& TravelCheckpoints.left(0.5D, 60.0D, 0.5D, 10.5D, Double.NaN, 0.5D, 3.0D) == 10.0D,
				"travel_to counts the height past its arrival band toward a target y as distance left (a cave floor below)");
		assertions++;
		check(ServerDigController.towardTarget(20, -1, feet) == Direction.EAST, "the larger remaining axis is dug first");
		assertions++;
		check(ServerDigController.towardTarget(11, -30, feet) == Direction.NORTH, "north is -z");
		assertions++;
		check(ServerDigController.towardTarget(null, null, feet) == null && ServerDigController.towardTarget(10, -3, feet) == null,
				"no x/z left keeps the given heading");
		assertions++;
		check(ServerDigController.dropDamage(3) == 0.0F && ServerDigController.dropDamage(ServerDigController.MAX_DROP) == 4.0F,
				"a drop of 3 does no fall damage; the deepest chosen drop costs 4");
		assertions++;
		check(ServerDigController.DROP_HEALTH_LEFT - ServerDigController.dropDamage(ServerDigController.MAX_DROP) > ServerDigController.LOW_HEALTH,
				"a chosen drop never brings health to LOW_HEALTH");
		assertions++;
		check(ServerDigController.Pattern.parse(null) == ServerDigController.Pattern.STAIRS_DOWN, "stairs_down is the default pattern");
		assertions++;
		check(ServerDigController.Pattern.parse(null, 56, -24) == ServerDigController.Pattern.STAIRS_UP
				&& ServerDigController.Pattern.parse(null, -40, -24) == ServerDigController.Pattern.STAIRS_DOWN
				&& ServerDigController.Pattern.parse(null, -24, -24) == ServerDigController.Pattern.STAIRS_DOWN
				&& ServerDigController.Pattern.parse("stairs_down", 56, -24) == ServerDigController.Pattern.STAIRS_DOWN,
				"with no pattern, a target y above the feet climbs stairs_up; a named pattern stays as named");
		assertions++;
		boolean rejected = false;
		try {
			new ServerDigController(ServerDigController.Pattern.STAIRS_DOWN, null, null, null, null, 10, 1000L, 0L, null);
		} catch (IllegalArgumentException expected) {
			rejected = true;
		}
		check(rejected, "a staircase without a target y is refused");
		assertions++;
		check(!ServerDigController.stopsDig(11.6D, 12.0D, 12.0D, true, false, false), "a hostile after the body behind rock does not stop the dig");
		check(!ServerDigController.stopsDig(8.8D, 9.5D, 9.5D, false, true, false), "a hostile in sight that is not after the body does not stop the dig");
		check(ServerDigController.stopsDig(10.0D, 10.6D, 10.6D, true, true, false), "a hostile after the body in sight and closing in stops it");
		check(ServerDigController.stopsDig(3.5D, 3.5D, 3.5D, false, false, false), "any hostile within 4 blocks stops it");
		check(!ServerDigController.stopsDig(11.0D, null, null, true, true, false), "a creeper first sensed in sight is judged at the next check");
		check(!ServerDigController.stopsClimb(7.1D, 8.0D, 9.0D, true, true, false) && !ServerDigController.stopsClimb(10.0D, 12.0D, 12.0D, true, true, true),
				"climbing a stair out, a hunting mob closing from 7 blocks (or an archer in sight) does not stop the climb");
		check(ServerDigController.stopsClimb(3.5D, 4.0D, 6.0D, true, true, false), "climbing out, a mob within 4 blocks still stops it");
		check(!ServerDigController.stopsDig(11.0D, 11.0D, 11.0D, true, true, false), "a creeper in sight that stays where it is does not stop the dig");
		check(!ServerDigController.stopsDig(9.6D, 9.7D, 9.7D, true, true, false), "drifting a tenth of a block nearer is not closing in");
		check(ServerDigController.stopsDig(9.0D, 9.6D, 9.6D, true, true, false), "a creeper coming at the body stops it");
		check(ServerDigController.stopsDig(14.0D, null, null, true, true, true), "a ranged mob after the body in sight stops it at once: it shoots from where it stands");
		check(!ServerDigController.stopsDig(14.0D, null, null, true, false, true), "a ranged mob without sight of the body does not");
		double[] angle = {11.0D, 10.82D, 10.64D, 10.46D, 10.28D, 10.10D, 9.92D};
		boolean stopped = false;
		int at = -1;
		for (int k = 1; k < angle.length && !stopped; k++) {
			stopped = ServerDigController.stopsDig(angle[k], angle[k - 1], angle[0], true, true, false);
			at = k;
		}
		check(stopped && at == 6, "a creeper closing 0.18 a check at an angle stops the dig once a block nearer than first sensed");
		// Vein mining: a melee mob after the body closing in stops it out of sight too; a still one does not.
		check(ServerDigController.stopsVein(9.0D, 9.6D, 9.6D, true, false, false), "vein mining stops for a mob after the body closing in through a cave, out of sight");
		check(!ServerDigController.stopsDig(9.0D, 9.6D, 9.6D, true, false, false), "the dig does not: rock is between them");
		check(!ServerDigController.stopsVein(9.7D, 9.7D, 9.7D, true, true, false), "vein mining passes a creeper after the body that stays put (b13-laptop seed 6)");
		check(ServerDigController.stopsVein(3.9D, 3.9D, 3.9D, false, false, false), "anything within 4 blocks stops vein mining");
		check(ServerDigController.stopsVein(9.0D, 9.6D, 9.6D, false, true, false), "vein mining warns for a visible closing mob before it targets the body");
		check(!ServerDigController.stopsVein(9.7D, 9.7D, 9.7D, false, true, false), "vein mining still passes a visible stationary melee mob without a target");
		check(ServerDigController.stopsVein(9.0D, null, null, false, true, true), "vein mining warns for a visible ranged mob before it targets the body");
		check(ServerDigController.stopsVein(9.0D, 9.6D, 9.6D, true, false, true), "vein mining warns for a hunting ranged mob closing in out of sight");
		assertions += 19;
		return assertions;
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
	}
}
