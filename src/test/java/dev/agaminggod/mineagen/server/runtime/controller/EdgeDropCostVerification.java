package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.LocalPathfinder;
import dev.agaminggod.mineagen.client.navigation.PathOutcome;
import dev.agaminggod.mineagen.client.navigation.PathPlan;
import dev.agaminggod.mineagen.server.perception.SeenTerrain;
import java.util.HashMap;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;

/**
 * EV-LAVA-SEA-3: a route cell beside an open edge over lava, the void, a drop of ten or more or an unseen bottom costs
 * more, so a walk keeps a step in from the lip where the ground allows it, and a deck that is the only way still plans.
 */
public final class EdgeDropCostVerification {
	private static int assertions;

	private EdgeDropCostVerification() { }

	/** Stone at y63 everywhere unless set; the body walks at y64. */
	static final class World implements BlockGetter, SeenTerrain.Source<BlockState> {
		final Map<BlockPos, BlockState> states = new HashMap<>();
		boolean seeAll = true;
		@Override public BlockEntity getBlockEntity(BlockPos position) { return null; }
		@Override public BlockState getBlockState(BlockPos position) {
			return states.getOrDefault(position, position.getY() == 63 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState());
		}
		@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
		@Override public BlockState live(int x, int y, int z) { return getBlockState(new BlockPos(x, y, z)); }
		@Override public boolean sees(int x, int y, int z) { return seeAll || y >= 62; }

		/** An open column at (x, z) from the floor down to {@code bottom} exclusive, with {@code base} at {@code bottom}. */
		World pit(int x, int z, int bottom, BlockState base) {
			for (int y = 63; y > bottom; y--) states.put(new BlockPos(x, y, z), Blocks.AIR.defaultBlockState());
			states.put(new BlockPos(x, bottom, z), base);
			return this;
		}
	}

	static MinecraftNavigationWorld view(World world) {
		return new MinecraftNavigationWorld(world, new SeenTerrain.Reader<>(new SeenTerrain.Memory<>(), world, 1L, null));
	}

	public static int verify() {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		BlockState lava = Blocks.LAVA.defaultBlockState(), stone = Blocks.STONE.defaultBlockState();
		GridPosition at = new GridPosition(0, 64, 0);
		{
			MinecraftNavigationWorld debug = view(new World().pit(1, 0, 59, lava));
			StringBuilder out = new StringBuilder("EDGE_DEBUG");
			for (int y = 65; y >= 58; y--) out.append(' ').append(y).append('=').append(debug.cellAt(new GridPosition(1, y, 0)));
			out.append(" standable=").append(debug.isStandable(new GridPosition(1, 64, 0)));
			out.append(" fall=").append(BrinkGuard.fall(debug, new net.minecraft.world.phys.AABB(1.2, 64, 0.2, 1.8, 65.8, 0.8), -64, (x, y, z) -> false, 0.0D, 7.0D));
			out.append(" cost=").append(debug.edgeDropCost(at));
			System.out.println(out);
		}
		check(view(new World()).edgeDropCost(at) == 0, "flat floor all round: no edge");
		// The fortress-search death on its fixed start: a block beside a hole 5 down to the lava sea.
		check(view(new World().pit(1, 0, 59, lava)).edgeDropCost(at) == MinecraftNavigationWorld.EDGE_DROP_COST,
				"lava 5 below the open cell beside is an edge, though the fall alone would not kill");
		check(view(new World().pit(1, 0, 60, stone)).edgeDropCost(at) == 0, "a seen 3-block drop onto stone is a step down, no edge");
		check(view(new World().pit(1, 0, 52, stone)).edgeDropCost(at) == MinecraftNavigationWorld.EDGE_DROP_COST,
				"a seen 11-block drop onto stone is an edge");
		check(view(new World().pit(1, 0, 55, stone)).edgeDropCost(at) == 0, "a seen 8-block drop hurts but is no edge");
		World unseen = new World().pit(1, 0, 40, stone);
		unseen.seeAll = false;
		check(view(unseen).edgeDropCost(at) == MinecraftNavigationWorld.EDGE_DROP_COST, "a drop whose bottom is unseen is an edge");
		World walled = new World().pit(1, 0, 59, lava);
		walled.states.put(new BlockPos(1, 64, 0), stone);
		walled.states.put(new BlockPos(1, 65, 0), stone);
		check(view(walled).edgeDropCost(at) == 0, "a wall beside the cell keeps the body off the hole behind it");
		World diagonal = new World().pit(1, 1, 59, lava);
		check(view(diagonal).edgeDropCost(at) == 0, "a hole only on the diagonal is no cardinal edge");
		check(view(new World().pit(1, 0, 59, lava)).exposureCost(at) == 0,
				"the edge cost is its own: lava 5 below a neighbour does not change the lava-beside exposure that builds read");

		// A 3-wide deck (z -1..1) over a lava pit 6 down: a walk along its lip lane moves to the middle lane.
		World deck = new World();
		for (int x = -2; x <= 14; x++) for (int z : new int[] {-3, -2, 2, 3}) deck.pit(x, z, 58, lava);
		MinecraftNavigationWorld deckView = view(deck);
		check(deckView.edgeDropCost(new GridPosition(5, 64, 1)) > 0 && deckView.edgeDropCost(new GridPosition(5, 64, 0)) == 0,
				"the deck's lip lane is an edge, its middle lane is not");
		PathPlan along = find(deckView, new GridPosition(0, 64, 1), new GridPosition(12, 64, 1));
		check(along.outcome() == PathOutcome.FOUND, "a lip-to-lip walk along the deck plans");
		long middle = along.nodes().stream().filter(node -> node.position().z() == 0).count();
		check(middle >= 8, "the walk keeps to the middle lane for most of the deck, stepping out only at its ends (" + middle + " middle cells)");
		// A 1-wide bridge over the lava sea is still a route when it is the only way.
		World bridge = new World();
		for (int x = -2; x <= 14; x++) for (int z = -3; z <= 3; z++) if (z != 0 || x > 1 && x < 11) bridge.pit(x, z, 58, lava);
		for (int x = -2; x <= 1; x++) for (int z = -3; z <= 3; z++) bridge.states.remove(new BlockPos(x, 63, z));
		for (int x = -2; x <= 1; x++) for (int z = -3; z <= 3; z++) bridge.states.put(new BlockPos(x, 63, z), stone);
		for (int x = 11; x <= 14; x++) for (int z = -3; z <= 3; z++) bridge.states.put(new BlockPos(x, 63, z), stone);
		check(find(view(bridge), new GridPosition(0, 64, 0), new GridPosition(12, 64, 0)).outcome() == PathOutcome.FOUND,
				"a 1-wide bridge over lava that is the only way still plans");
		System.out.println("EDGE_DROP_COST checks=" + assertions);
		return assertions;
	}

	static PathPlan find(MinecraftNavigationWorld view, GridPosition start, GridPosition goal) {
		LocalPathfinder.Search search = new LocalPathfinder().beginSearch(start, Set.of(goal), goal, 24, Set.of());
		PathPlan plan;
		do {
			plan = search.advance(view, new LocalPathfinder.SearchBudget(65536, Long.MAX_VALUE, () -> 0L));
		} while (!search.finished());
		return plan;
	}

	private static void check(boolean condition, String message) {
		assertions++;
		if (!condition) throw new AssertionError(message);
	}
}
