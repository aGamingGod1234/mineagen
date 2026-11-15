package dev.agaminggod.arenaagents.server.perception;

import java.util.ArrayDeque;
import java.util.HashSet;
import java.util.Set;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.Fluids;

/**
 * The one rule for lava a portal cast can use, shared by find (every sighting path) and build. A cast takes one lava
 * source per frame cell not carried as obsidian (a scoop takes the source; lava does not refill), so a seen source is
 * usable only when its pool holds that many sources a bucket takes: joined to it through lava, and open to the air above
 * (directly, or under more lava that a scoop clears). Script-first round 4, seed 1: find stopped at a two-source pocket,
 * build cast 2 of 10 cells and ended BUILD_SHORT; round 1, seed 5: a one-source pocket, the main lava 8-14 blocks lower.
 */
public final class CastLava {
	public static final int FRAME_CELLS = 10;
	private static final int REACH = 16, DEPTH = 3, MAX_CELLS = 1024;

	private CastLava() { }

	/** Sources the cast needs: one per frame cell the carried obsidian does not cover. */
	public static int needed(ServerPlayer player) {
		int obsidian = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++)
			if (player.getInventory().getItem(slot).is(Items.OBSIDIAN)) obsidian += player.getInventory().getItem(slot).getCount();
		return Math.max(1, FRAME_CELLS - obsidian);
	}

	/** Whether the pool of the lava source at {@code source} feeds a cast for {@code player}; true for anything but a lava source. */
	public static boolean usable(ServerPlayer player, BlockPos source) {
		BlockState state = player.level().getBlockState(source);
		return !lava(state) || sources(player.level()::getBlockState, source, needed(player)) >= needed(player);
	}

	/** Sources a bucket takes in the pool of {@code source}, counted up to {@code cap} within 16 blocks across and 3 below it. */
	public static int sources(Function<BlockPos, BlockState> world, BlockPos source, int cap) {
		if (!lava(world.apply(source))) return 0;
		Set<BlockPos> visited = new HashSet<>(Set.of(source.immutable()));
		ArrayDeque<BlockPos> open = new ArrayDeque<>(visited);
		int count = 0;
		while (!open.isEmpty() && count < cap && visited.size() < MAX_CELLS) {
			BlockPos at = open.poll();
			BlockState state = world.apply(at);
			if (state != null && state.getFluidState().isSource() && openAbove(world, at)) count++;
			for (Direction direction : Direction.values()) {
				BlockPos next = at.relative(direction);
				if (Math.abs(next.getX() - source.getX()) > REACH || Math.abs(next.getZ() - source.getZ()) > REACH
						|| next.getY() < source.getY() - DEPTH || next.getY() > source.getY() + DEPTH || !visited.add(next)) continue;
				if (lava(world.apply(next))) open.add(next);
			}
		}
		return count;
	}

	/** Air over the column of lava above {@code at}: a bucket reaches it from the shore, scooping the lava over it first. */
	private static boolean openAbove(Function<BlockPos, BlockState> world, BlockPos at) {
		BlockPos up = at.above();
		for (int k = 0; k < 8 && lava(world.apply(up)); k++) up = up.above();
		BlockState over = world.apply(up);
		return over != null && over.isAir();
	}

	private static boolean lava(BlockState state) {
		return state != null && state.getFluidState().getType().isSame(Fluids.LAVA);
	}
}
