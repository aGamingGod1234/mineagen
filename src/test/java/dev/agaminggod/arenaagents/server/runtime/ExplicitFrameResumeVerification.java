package dev.agaminggod.arenaagents.server.runtime;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/** Mechanics control through the production selector and site-cost evaluator, without a live server. */
public final class ExplicitFrameResumeVerification {
	private static int assertions;
	private static final BlockPos ORIGIN = new BlockPos(0, 64, 0);
	private ExplicitFrameResumeVerification() { }

	public static int verify() {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		Map<BlockPos, BlockState> seen = flat();
		var original = cast(true);
		// Four witnessed original frame cells, but a cheaper naturally complete plane nearby.
		for (BlockPos p : original.frameCells().subList(0, 4)) seen.put(p, Blocks.OBSIDIAN.defaultBlockState());
		var other = new ServerCastObsidianController(ORIGIN.offset(4, 0, 4), "x", true, 1, 60_000, 0, (p, at) -> true);
		for (BlockPos p : other.frameCells()) seen.put(p, Blocks.OBSIDIAN.defaultBlockState());
		var fresh = cast(false);
		choose(fresh, seen, at -> true);
		choose(original, seen, at -> true);
		check(!fresh.frameCells().equals(cast(false).frameCells()), "default mode relocates in the same fixture");
		check(original.frameCells().equals(cast(true).frameCells()), "resume retains exact origin and z axis despite a cheaper x plane");
		check(ServerCastObsidianController.readFrame(original.frameCells(), Set.of(), seen::get).done() == 4, "only the original four cells count on the pinned plane");
		check(!ServerCastObsidianController.readFrame(original.frameCells(), Set.of(), seen::get).complete(), "partial frame is not complete");

		// No known obsidian is required to validate an explicit resume intent.
		var zero = cast(true);
		choose(zero, flat(), at -> true);
		check(field(zero, "siteRejection") == null, "zero known cast cells still use validation");
		check(zero.frameCells().equals(cast(true).frameCells()), "zero-cell resume stays pinned");
		Map<BlockPos, BlockState> blocked = flat();
		blocked.put(ORIGIN.offset(0, 1, 1), Blocks.OBSIDIAN.defaultBlockState());
		var invalid = cast(true);
		choose(invalid, blocked, at -> true);
		check(String.valueOf(field(invalid, "siteRejection")).contains("opening cell 0,65,1"), "invalid plane gives the exact known obstruction");
		check(invalid.frameCells().equals(cast(true).frameCells()), "invalid plane never chooses an alternative");
		check(((List<?>) field(invalid, "digs")).isEmpty() && field(invalid, "mining") == null, "invalid plane commits no mining preparation");
		var fallback = cast(false);
		choose(fallback, blocked, at -> true);
		check(!fallback.frameCells().equals(invalid.frameCells()), "same invalid fixture permits default fallback");

		Map<BlockPos, BlockState> unknown = flat();
		BlockPos hidden = cast(true).frameCells().get(5);
		unknown.remove(hidden);
		var unseen = cast(true);
		choose(unseen, unknown, at -> true);
		var read = ServerCastObsidianController.readFrame(unseen.frameCells(), Set.of(), unknown::get);
		check(read.unknown().equals(List.of(hidden)) && !read.complete(), "unseen resumed cell remains unknown, never air or completed");
		check(((List<?>) field(unseen, "digs")).contains(hidden), "unknown cell still enters observe-before-preparation");
		var whollyUnknown = cast(true);
		choose(whollyUnknown, Map.of(), at -> true);
		check(String.valueOf(field(whollyUnknown, "siteRejection")).contains("no known safe standing spot"), "unseen standing terrain cannot pass site validation");
		check(ServerCastObsidianController.readFrame(whollyUnknown.frameCells(), Set.of(), at -> null).unknown().size() == 10, "all ten unseen cells stay unknown");
		var protectedSite = cast(true);
		choose(protectedSite, unknown, at -> !at.equals(hidden));
		check(String.valueOf(field(protectedSite, "siteRejection")).contains("modification protected"), "resume retains protection on unknown preparation cells");
		check(((List<?>) field(protectedSite, "digs")).isEmpty(), "protected plane commits no mining");
		System.out.println("ExplicitFrameResumeVerification: " + assertions + " assertions passed");
		return assertions;
	}

	private static ServerCastObsidianController cast(boolean resume) {
		return new ServerCastObsidianController(ORIGIN, "z", true, resume, 1, 60_000, 0, (p, at) -> true);
	}

	private static Map<BlockPos, BlockState> flat() {
		Map<BlockPos, BlockState> seen = new HashMap<>();
		for (BlockPos p : BlockPos.betweenClosed(ORIGIN.offset(-9, -4, -9), ORIGIN.offset(12, 8, 12)))
			seen.put(p.immutable(), p.getY() < 64 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState());
		return seen;
	}

	private static void choose(ServerCastObsidianController cast, Map<BlockPos, BlockState> seen, java.util.function.Predicate<BlockPos> mayModify) {
		cast.chooseSite(Direction.Axis.Z, (o, a, need) -> ServerCastObsidianController.siteCost(EmptyBlockGetter.INSTANCE,
				seen::get, (p, s) -> s == null ? -1 : s.isAir() ? 0 : s.is(Blocks.STONE) ? 1 : -1,
				mayModify, seen::get, o, a, need, reason -> set(cast, "siteRejection", reason)), Vec3.atCenterOf(ORIGIN));
	}

	private static Object field(Object target, String name) {
		try { var f = target.getClass().getDeclaredField(name); f.setAccessible(true); return f.get(target); }
		catch (ReflectiveOperationException e) { throw new AssertionError(e); }
	}
	private static void set(Object target, String name, Object value) {
		try { var f = target.getClass().getDeclaredField(name); f.setAccessible(true); f.set(target, value); }
		catch (ReflectiveOperationException e) { throw new AssertionError(e); }
	}
	private static void check(boolean ok, String message) { if (!ok) throw new AssertionError(message); assertions++; }
}
