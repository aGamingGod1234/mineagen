package dev.agaminggod.mineagen.server.runtime;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

public final class PerceptionGateVerification {
	private static int assertions;

	private PerceptionGateVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PerceptionGateVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		assertions += ExplicitFrameResumeVerification.verify();
		verifyHiddenFrameCell();
		verifyStandingSpotsFromSeenTerrain();
		verifyHiddenCellBaseline();
		verifyRememberedWaterNowLavaBehindWall();
		verifySeenLavaPoolStillWorks();
		verifyPiglinAnger();
		verifyBarterJob();
		verifyPouredWaterNeedsFreshEvidence();
		return assertions;
	}

	private static void verifyPouredWaterNeedsFreshEvidence() {
		var memory = new dev.agaminggod.mineagen.server.perception.SeenTerrain.Memory<BlockState>();
		BlockState[] live = { Blocks.AIR.defaultBlockState() };
		boolean[] visible = { true };
		var source = new dev.agaminggod.mineagen.server.perception.SeenTerrain.Source<BlockState>() {
			public BlockState live(int x, int y, int z) { return live[0]; }
			public boolean sees(int x, int y, int z) { return visible[0]; }
		};
		BlockPos at = new BlockPos(1, 64, 0);
		new dev.agaminggod.mineagen.server.perception.SeenTerrain.Reader<>(memory, source, 1L, null).known(1, 64, 0);
		live[0] = Blocks.WATER.defaultBlockState();
		visible[0] = false;
		var reader = new dev.agaminggod.mineagen.server.perception.SeenTerrain.Reader<>(memory, source, 2L, null);
		check(reader.known(1, 64, 0).isAir(), "last sight still says air after the body's pour goes out of view");
		check(!ServerCastObsidianController.sourceGone(reader, at), "old air cannot erase the body's own water pour");
		visible[0] = true;
		check(!ServerCastObsidianController.sourceGone(reader, at), "fresh sight sees the water source remains");
		live[0] = Blocks.AIR.defaultBlockState();
		check(ServerCastObsidianController.sourceGone(reader, at), "fresh sight of air can establish the source is gone");
	}

	private static void verifyHiddenFrameCell() {
		ServerCastObsidianController cast = new ServerCastObsidianController(new BlockPos(0, 64, 0), "x", true, 1, 60_000L, 0L, (p, at) -> true);
		List<BlockPos> cells = cast.frameCells();
		check(cells.size() == 10, "ten frame cells");
		BlockPos hidden = cells.get(5);
		Map<BlockPos, BlockState> live = new HashMap<>();
		for (BlockPos c : cells) live.put(c, Blocks.OBSIDIAN.defaultBlockState());
		live.put(hidden, Blocks.NETHERRACK.defaultBlockState());
		Map<BlockPos, BlockState> seen = new HashMap<>(live);
		seen.remove(hidden);
		ServerCastObsidianController.FrameRead read = ServerCastObsidianController.readFrame(cells, Set.of(), seen::get);
		check(!read.complete(), "a frame with an unseen cell is not complete");
		check(read.unknown().equals(List.of(hidden)) && read.missing().isEmpty(), "the hidden cell is reported unknown, not as its live block");
		check(hidden.equals(read.next()), "the hidden cell is the next to observe (look first)");
		check(read.done() == 9, "nine cells seen cast");
		// Hidden but live obsidian: still unknown; completeness never comes from the live world.
		live.put(hidden, Blocks.OBSIDIAN.defaultBlockState());
		check(!ServerCastObsidianController.readFrame(cells, Set.of(), seen::get).complete(), "a hidden cell that is obsidian live is still unknown");
		seen.put(hidden, Blocks.OBSIDIAN.defaultBlockState());
		check(ServerCastObsidianController.readFrame(cells, Set.of(), seen::get).complete(), "complete once every cell is seen cast");
		seen.put(hidden, Blocks.NETHERRACK.defaultBlockState());
		ServerCastObsidianController.FrameRead blocked = ServerCastObsidianController.readFrame(cells, Set.of(), seen::get);
		check(blocked.missing().equals(List.of(hidden)) && hidden.equals(blocked.next()), "a seen blocked cell is missing and next");
		check(ServerCastObsidianController.readFrame(cells, Set.of(hidden), seen::get).next() == null, "a refused seen cell is not retried");

		BlockPos lava = new BlockPos(5, 64, 5);
		Map<BlockPos, BlockState> water = new HashMap<>();
		water.put(lava.east(), Blocks.WATER.defaultBlockState());
		check(ServerCastObsidianController.cooledKnown(water::get, lava), "seen water beside the cell cools it");
		check(!ServerCastObsidianController.cooledKnown(new HashMap<BlockPos, BlockState>()::get, lava), "unseen water does not count");
	}

	private static void verifyStandingSpotsFromSeenTerrain() {
		BlockPos at = new BlockPos(3, 64, 3);
		Map<BlockPos, BlockState> seen = new HashMap<>();
		seen.put(at.below(), Blocks.NETHERRACK.defaultBlockState());
		seen.put(at, Blocks.AIR.defaultBlockState());
		seen.put(at.above(), Blocks.AIR.defaultBlockState());
		check(ServerCastObsidianController.standable(seen::get, EmptyBlockGetter.INSTANCE, at), "seen floor and seen open cells stand");
		Map<BlockPos, BlockState> noFloor = new HashMap<>(seen);
		noFloor.remove(at.below());
		check(!ServerCastObsidianController.standable(noFloor::get, EmptyBlockGetter.INSTANCE, at), "a floor hidden behind a wall is not a standing spot");
		Map<BlockPos, BlockState> noHead = new HashMap<>(seen);
		noHead.remove(at.above());
		check(!ServerCastObsidianController.standable(noHead::get, EmptyBlockGetter.INSTANCE, at), "an unseen head cell is not a standing spot");
		seen.put(at.north(), Blocks.LAVA.defaultBlockState());
		check(!ServerCastObsidianController.standable(seen::get, EmptyBlockGetter.INSTANCE, at), "seen lava beside the spot rules it out");
	}

	/** MUST 3: the obsidian baseline is what the body knows at the start; a cell it never saw as anything else is not made. */
	private static void verifyHiddenCellBaseline() {
		BlockState obsidian = Blocks.OBSIDIAN.defaultBlockState();
		BlockState lava = Blocks.LAVA.defaultBlockState();
		BlockPos hidden = new BlockPos(3, 64, 0), seenOld = new BlockPos(1, 64, 0), pool = new BlockPos(2, 63, 0);
		Set<BlockPos> open = new java.util.HashSet<>(), made = new java.util.HashSet<>();
		List<BlockPos> cells = List.of(hidden, seenOld, pool);
		Map<BlockPos, BlockState> known = new HashMap<>(Map.of(seenOld, obsidian, pool, lava));
		ServerCastObsidianController.trackObsidian(cells, known::get, open, made);
		check(!open.contains(hidden) && !made.contains(hidden), "an unseen cell is neither open nor made at the start");
		check(!open.contains(seenOld), "seen obsidian at the start is the baseline");
		known.put(hidden, obsidian);
		known.put(pool, obsidian);
		ServerCastObsidianController.trackObsidian(cells, known::get, open, made);
		check(made.equals(Set.of(pool)), "only the cell seen as lava, then obsidian, counts as made: " + made);
		// Memory of the made cell lapses: it stays counted until seen otherwise.
		known.remove(pool);
		ServerCastObsidianController.trackObsidian(cells, known::get, open, made);
		check(made.contains(pool), "a made cell no longer in view stays made");
		known.put(pool, Blocks.AIR.defaultBlockState());
		ServerCastObsidianController.trackObsidian(cells, known::get, open, made);
		check(made.isEmpty(), "a made cell seen broken no longer counts");
	}

	/** MUST 3: remembered water that turned to lava behind a wall is not a seen lava source; remembered lava is. */
	private static void verifyRememberedWaterNowLavaBehindWall() {
		BlockPos behindWall = new BlockPos(5, 63, 0), flowing = new BlockPos(6, 63, 0), goneLava = new BlockPos(7, 63, 0);
		List<BlockPos> cells = List.of(behindWall, flowing, goneLava);
		Map<BlockPos, BlockState> live = Map.of(behindWall, Blocks.LAVA.defaultBlockState(),
				flowing, Blocks.LAVA.defaultBlockState().setValue(net.minecraft.world.level.block.LiquidBlock.LEVEL, 3),
				goneLava, Blocks.STONE.defaultBlockState());
		// Remembered (the wall hides all three now): water, flowing lava, and a lava source that has since gone.
		Map<BlockPos, BlockState> remembered = Map.of(behindWall, Blocks.WATER.defaultBlockState(),
				flowing, Blocks.LAVA.defaultBlockState().setValue(net.minecraft.world.level.block.LiquidBlock.LEVEL, 3),
				goneLava, Blocks.LAVA.defaultBlockState());
		List<BlockPos> found = ServerCastObsidianController.knownLavaSources(cells,
				ServerCastObsidianController.lavaView(remembered::get, live::get, remembered::get));
		check(!found.contains(behindWall), "remembered water now lava behind a wall is not a seen lava source");
		check(!found.contains(flowing), "remembered flowing lava is not a source");
		check(found.equals(List.of(goneLava)), "remembered source lava counts even if it changed unseen: " + found);
		check(ServerCastObsidianController.knownLavaSources(cells, at -> null).isEmpty(), "unknown cells are not lava sources");
	}

	private static void verifySeenLavaPoolStillWorks() {
		List<BlockPos> pool = List.of(new BlockPos(0, 63, 0), new BlockPos(1, 63, 0), new BlockPos(0, 63, 1), new BlockPos(1, 63, 1));
		Map<BlockPos, BlockState> seen = new HashMap<>();
		for (BlockPos c : pool) seen.put(c, Blocks.LAVA.defaultBlockState());
		List<BlockPos> found = ServerCastObsidianController.knownLavaSources(pool, ServerCastObsidianController.lavaView(at -> null, seen::get, seen::get));
		check(found.equals(pool), "every seen lava source in the pool is found: " + found);
		Set<BlockPos> open = new java.util.HashSet<>(found), made = new java.util.HashSet<>();
		for (BlockPos c : pool) seen.put(c, Blocks.OBSIDIAN.defaultBlockState());
		ServerCastObsidianController.trackObsidian(pool, seen::get, open, made);
		check(made.size() == 4, "the four seen-cast cells count as new obsidian: " + made.size());
	}

	private static void verifyPiglinAnger() {
		check(!ServerBarterController.perceivedAngry(false, true), "a piglin behind a wall going for the body is not reported");
		check(ServerBarterController.perceivedAngry(true, true), "a seen piglin going for the body stops the barter");
		check(!ServerBarterController.perceivedAngry(true, false), "a seen calm piglin is not angry (its ANGRY_AT memory is never read)");
	}

	private static void verifyBarterJob() {
		check(dev.agaminggod.mineagen.server.runtime.controller.ServerVeinController.angersPiglins(true, 12.0D), "gold ore with a calm piglin 12 blocks off is left unbroken");
		check(!dev.agaminggod.mineagen.server.runtime.controller.ServerVeinController.angersPiglins(true, 20.0D), "a piglin 20 blocks off is past the 16-block guard");
		check(!dev.agaminggod.mineagen.server.runtime.controller.ServerVeinController.angersPiglins(false, 3.0D), "netherrack beside a piglin is mined");
		check(dev.agaminggod.mineagen.server.runtime.controller.ServerFightController.holdSwingForSweep(true, 1), "a sword swing waits while a calm piglin stands in its sweep");
		check(!dev.agaminggod.mineagen.server.runtime.controller.ServerFightController.holdSwingForSweep(false, 2), "an axe or pickaxe never sweeps, so it swings");
		check(!dev.agaminggod.mineagen.server.runtime.controller.ServerFightController.holdSwingForSweep(true, 0), "no calm neutral in the sweep: swing");
		var blocks = ServerBarterController.conversion(3, 40, false, false);
		check(blocks != null && blocks.recipeId().equals("minecraft:gold_ingot_from_gold_block") && blocks.ingots() == 27 && !blocks.table(),
				"gold blocks craft first, in the inventory grid, 9 ingots each: " + blocks);
		check(ServerBarterController.conversion(20, 0, false, false).ingots() == 63, "at most 7 blocks at once (63 ingots, under a stack)");
		var nuggets = ServerBarterController.conversion(0, 52, false, true);
		check(nuggets != null && nuggets.recipeId().equals("minecraft:gold_ingot_from_nuggets") && nuggets.ingots() == 5 && nuggets.table(),
				"52 nuggets make 5 ingots at a carried table: " + nuggets);
		check(ServerBarterController.conversion(0, 52, false, false) == null, "nuggets with no table in reach or carried cannot be converted");
		check(ServerBarterController.conversion(0, 8, true, true) == null, "fewer than 9 nuggets make no ingot");
		check(ServerBarterController.tradedIngots(2, 0, 0) == 2, "2 ingots held, none left: 2 traded however many throws picked them back up");
		check(ServerBarterController.tradedIngots(6, 63, 9) == 60, "6 held plus 63 crafted, 9 left: 60 traded");
		check(ServerBarterController.isPiglinSideDanger("minecraft:hoglin") && ServerBarterController.isPiglinSideDanger("minecraft:piglin_brute")
				&& !ServerBarterController.isPiglinSideDanger("minecraft:piglin"), "hoglins and brutes are dangers beside a group; piglins are not");
		List<net.minecraft.world.phys.Vec3> hoglin = List.of(new net.minecraft.world.phys.Vec3(10, 64, 0));
		check(ServerBarterController.nearDanger(new net.minecraft.world.phys.Vec3(4, 64, 0), hoglin, 8.0D), "a piglin 6 blocks from a hoglin is passed over");
		check(!ServerBarterController.nearDanger(new net.minecraft.world.phys.Vec3(-4, 64, 0), hoglin, 8.0D), "a piglin 14 blocks from it is not");
		check(ServerBarterController.JUNK.contains("minecraft:gravel") && ServerBarterController.JUNK.contains("minecraft:blackstone")
				&& !ServerBarterController.JUNK.contains("minecraft:ender_pearl") && !ServerBarterController.JUNK.contains("minecraft:obsidian")
				&& !ServerBarterController.JUNK.contains("minecraft:crying_obsidian"), "rubble is left on the ground; pearls and obsidian are kept");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
