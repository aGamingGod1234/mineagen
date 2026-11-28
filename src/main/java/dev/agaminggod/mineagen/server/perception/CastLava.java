package dev.agaminggod.mineagen.server.perception;

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

public final class CastLava {
	public static final int FRAME_CELLS = 10;
	public static final String FIND_BIGGER_POOL = "Leave this pocket using do_step({verb:\"find\",target:{block:\"minecraft:lava\"},why:\"find a larger lava pool for the portal\"}).";
	private static final int REACH = 16, DEPTH = 3, MAX_CELLS = 1024;

	private CastLava() { }

	/** Sources the cast needs: one per frame cell the carried obsidian does not cover. */
	public static int needed(ServerPlayer player) {
		int obsidian = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++)
			if (player.getInventory().getItem(slot).is(Items.OBSIDIAN)) obsidian += player.getInventory().getItem(slot).getCount();
		return Math.max(1, FRAME_CELLS - obsidian);
	}

	public static boolean usable(ServerPlayer player, BlockPos source) {
		BlockState state = player.level().getBlockState(source);
		int need = needed(player);
		return !lava(state) || sources(player, source, need) >= need;
	}

	public static int sources(ServerPlayer player, BlockPos source, int cap) {
		var level = player.level();
		return sources(at -> level.hasChunkAt(at) ? level.getBlockState(at) : null, source, cap);
	}

	/** Sources a bucket takes in the pool of {@code source}, counted up to {@code cap} within 16 blocks across and 3 below it. */
	public static int sources(Function<BlockPos, BlockState> world, BlockPos source, int cap) {
		if (cap <= 0 || !lava(world.apply(source))) return 0;
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
