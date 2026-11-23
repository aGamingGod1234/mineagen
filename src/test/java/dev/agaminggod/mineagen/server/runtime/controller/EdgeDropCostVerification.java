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
		int seenFrom = Integer.MIN_VALUE;
		@Override public BlockEntity getBlockEntity(BlockPos position) { return null; }
		@Override public BlockState getBlockState(BlockPos position) {
			return states.getOrDefault(position, position.getY() == 63 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState());
		}
		@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
		@Override public int getHeight() { return 384; }
		@Override public int getMinY() { return -64; }
		@Override public BlockState live(int x, int y, int z) { return getBlockState(new BlockPos(x, y, z)); }
		@Override public boolean sees(int x, int y, int z) { return y >= seenFrom; }

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
		check(view(new World()).edgeDropCost(at) == 0, "flat floor all round: no edge");
		// The fortress-search death on its fixed start: a block beside a hole 5 down to the lava sea.
		check(view(new World().pit(1, 0, 59, lava)).edgeDropCost(at) == MinecraftNavigationWorld.EDGE_DROP_COST,
				"lava 5 below the open cell beside is an edge, though the fall alone would not kill");
		check(view(new World().pit(1, 0, 60, stone)).edgeDropCost(at) == 0, "a seen 3-block drop onto stone is a step down, no edge");
		check(view(new World().pit(1, 0, 52, stone)).edgeDropCost(at) == MinecraftNavigationWorld.EDGE_DROP_COST,
				"a seen 11-block drop onto stone is an edge");
		check(view(new World().pit(1, 0, 55, stone)).edgeDropCost(at) == 0, "a seen 8-block drop hurts but is no edge");
		World unseen = new World().pit(1, 0, 40, stone);
		unseen.seenFrom = 60;
		check(view(unseen).edgeDropCost(at) == MinecraftNavigationWorld.EDGE_DROP_COST, "a drop seen open 4 down to a bottom not seen is an edge");
		World ditch = new World().pit(1, 0, 40, stone);
		ditch.seenFrom = 62;
		check(view(ditch).edgeDropCost(at) == 0, "seen open only 2 down, it is a ditch the view has not reached, no edge");
		check(view(new World().pit(1, 0, 20, stone)).edgeDropCost(at) == MinecraftNavigationWorld.EDGE_DROP_COST,
				"a column open past the scan's depth (a fall far down to the lava sea or the void) is an edge");
		check(view(new World().pit(1, 0, 54, Blocks.WATER.defaultBlockState())).edgeDropCost(at) == 0, "water at the bottom breaks the fall");
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
		// A 1-wide bridge over the lava sea is still a route when it is the only way: pads at both ends, a lava pit between
		// them wider than the search reaches round, and the bridge lane z 0 left standing.
		World bridge = new World();
		for (int x = 2; x <= 10; x++) for (int z = -30; z <= 30; z++) if (z != 0) bridge.pit(x, z, 58, lava);
		check(view(bridge).edgeDropCost(new GridPosition(6, 64, 0)) > 0, "every bridge cell is beside the lava");
		PathPlan across = find(view(bridge), new GridPosition(0, 64, 0), new GridPosition(12, 64, 0));
		check(across.outcome() == PathOutcome.FOUND && across.nodes().stream().allMatch(node -> node.position().z() == 0 || node.position().x() < 2 || node.position().x() > 10),
				"a 1-wide bridge over lava that is the only way still plans, and the route crosses on it");
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
