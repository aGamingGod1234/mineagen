package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.HashSet;
import java.util.List;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;

public final class BuildPlanVerification {
	public static int verify() {
		int checks = 0;
		for (Direction.Axis axis : new Direction.Axis[] { Direction.Axis.X, Direction.Axis.Z }) {
			var portal = new ServerBuildController.Portal(new BlockPos(10, 64, -5), axis);
			Set<BlockPos> frame = new HashSet<>(portal.frame());
			if (frame.size() != 10) throw new AssertionError("A portal frame is ten cells");
			for (BlockPos corner : portal.corners()) if (frame.contains(corner)) throw new AssertionError("Corners are not frame cells");
			if (portal.interior().size() != 6) throw new AssertionError("The opening is 2x3");
			for (BlockPos cell : portal.interior()) if (frame.contains(cell)) throw new AssertionError("Opening overlaps the frame");
			checks += 4;
			Set<BlockPos> ground = new HashSet<>(List.of(portal.at(0, 0), portal.at(3, 0)));
			for (int i = -2; i <= 5; i++) ground.add(portal.at(i, -1));
			var order = ServerBuildController.order(portal.frame(), portal.corners(), ground::contains);
			if (order == null) throw new AssertionError("A dug-in portal has a placement order");
			Set<BlockPos> placed = new HashSet<>();
			int scaffolds = 0;
			for (var step : order) {
				boolean touches = false;
				for (Direction side : Direction.values()) if (ground.contains(step.at().relative(side)) || placed.contains(step.at().relative(side))) touches = true;
				if (!touches) throw new AssertionError("Placement in mid-air at " + step.at());
				if (step.scaffold()) { scaffolds++; if (!portal.corners().contains(step.at())) throw new AssertionError("Scaffold off a corner"); }
				placed.add(step.at());
				checks += 2;
			}
			if (scaffolds != 1) throw new AssertionError("The top row needs exactly one corner scaffold, got " + scaffolds);
			if (!placed.containsAll(frame)) throw new AssertionError("Order missed a frame cell");
			if (!order.get(0).at().equals(portal.at(1, 0)) && !order.get(0).at().equals(portal.at(2, 0))) throw new AssertionError("Bottom row goes first");
			checks += 3;
			Set<BlockPos> half = new HashSet<>(ground);
			for (int y = 0; y <= 4; y++) half.add(portal.at(0, y));
			var left = ServerBuildController.order(List.of(portal.at(1, 0), portal.at(2, 0), portal.at(3, 1), portal.at(3, 2), portal.at(3, 3), portal.at(1, 4), portal.at(2, 4)),
					portal.corners(), half::contains);
			if (left == null || left.stream().anyMatch(ServerBuildController.Placement::scaffold)) throw new AssertionError("A standing left column needs no scaffold");
			checks++;
			if (ServerBuildController.order(portal.frame(), List.of(), cell -> false) != null) throw new AssertionError("A frame in the air has no order");
			checks++;
		}
		return checks + verifyCastPlan() + verifySpill() + verifyCrossPour() + verifyCastTiming() + verifyCastBlocks() + verifyMaterials() + verifyHoleLanding() + verifyLineCells() + verifyStepCrouch() + verifyCarve();
	}

	/**
	 * The cast blueprint: each frame cell's water goes above or beside it (vanilla casts a lava source only from there), into
	 * a cell that is not a frame cell; when its turn comes, the water cell and the frame cell each have a solid neighbour
	 * (ground, mould or a cell already cast) to pour against; and the mould has a placement order from the ground.
	 */
	private static int verifyCastPlan() {
		int checks = 0;
		for (Direction.Axis axis : new Direction.Axis[] { Direction.Axis.X, Direction.Axis.Z }) {
			var portal = new ServerBuildController.Portal(new BlockPos(10, 64, -5), axis);
			for (Direction wall : new Direction[] { portal.normal(), portal.normal().getOpposite() }) {
				Set<BlockPos> frame = new HashSet<>(portal.frame());
				Set<BlockPos> solid = new HashSet<>(List.of(portal.at(0, 0), portal.at(3, 0)));
				for (int i = -2; i <= 5; i++) for (int k = -2; k <= 2; k++) solid.add(portal.at(i, -1).relative(portal.normal(), k));
				for (int i = 0; i <= 3; i++) solid.add(portal.at(i, 0).relative(wall));
				List<BlockPos> mould = ServerBuildController.wallCells(portal, wall);
				if (mould.size() != 12) throw new AssertionError("The mould is 12 blocks");
				var order = ServerBuildController.order(mould, List.of(), solid::contains);
				if (order == null || order.stream().anyMatch(ServerBuildController.Placement::scaffold)) throw new AssertionError("The mould builds up from the ground");
				solid.addAll(mould);
				var pairs = ServerBuildController.castPairs(portal);
				Set<BlockPos> cast = new HashSet<>();
				for (BlockPos[] pair : pairs) {
					BlockPos cell = pair[0], water = pair[1];
					if (!frame.contains(cell) || frame.contains(water)) throw new AssertionError("Pairs are a frame cell and a cell outside the frame");
					boolean cools = water.equals(cell.above());
					for (Direction side : Direction.Plane.HORIZONTAL) cools |= water.equals(cell.relative(side));
					if (!cools) throw new AssertionError("Water at " + water + " does not cast " + cell);
					for (BlockPos target : new BlockPos[] { water, cell }) {
						boolean face = false;
						for (Direction side : Direction.values()) { BlockPos n = target.relative(side); if (!n.equals(water) && !n.equals(cell) && (solid.contains(n) || cast.contains(n))) face = true; }
						if (!face) throw new AssertionError("Nothing to pour against for " + target);
					}
					cast.add(cell);
					checks += 3;
				}
				if (!cast.equals(frame)) throw new AssertionError("The cast covers the whole frame");
				checks += 3;
			}
		}
		return checks;
	}

	/**
	 * The cast's water on flat stone: a lava source two blocks in front of the frame is in its run (the water would cast it
	 * where it lies), one eight blocks behind the mould is not (the first pours run out round the uncast side columns), nor is one deep under the ground.
	 */
	private static int verifySpill() {
		int checks = 0;
		for (Direction.Axis axis : new Direction.Axis[] { Direction.Axis.X, Direction.Axis.Z }) {
			var portal = new ServerBuildController.Portal(new BlockPos(10, 64, -5), axis);
			Direction wall = portal.normal(), front = wall.getOpposite();
			BlockPos inFront = portal.at(1, 0).relative(front, 2), behind = portal.at(1, 0).relative(wall, 8), deep = portal.at(1, 0).relative(front, 2).below(4);
			for (BlockPos lava : new BlockPos[] { inFront, behind, deep }) {
				java.util.function.Function<BlockPos, BlockState> world = cell -> cell.equals(lava) ? Blocks.LAVA.defaultBlockState()
						: cell.getY() <= 64 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
				boolean meets = ServerBuildController.spillMeetsLava(world, portal, wall);
				if (meets != (lava == inFront)) throw new AssertionError("Spill toward lava at " + lava + ": " + meets);
				checks++;
			}
			checks += verifySpillDownSlope(portal, wall);
		}
		return checks;
	}

	/**
	 * A cave room's site: the floor in front of the frame steps down a block at 4 and 6 cells out, to a pool 2 below the
	 * frame's ground. The scooped water still runs its whole course, afresh below each drop, so a pool 8 cells out (10 cells
	 * of run) is in it, and one 15 cells out, past the 7-cell flat run after the last drop, is not.
	 */
	private static int verifySpillDownSlope(ServerBuildController.Portal portal, Direction wall) {
		int checks = 0;
		Direction front = wall.getOpposite();
		BlockPos origin = portal.origin();
		BlockPos along = portal.at(1, 0).subtract(portal.at(0, 0));
		for (int pool : new int[] { 8, 15 }) {
			java.util.function.Function<BlockPos, BlockState> world = cell -> {
				BlockPos d = cell.subtract(origin);
				int k = d.getX() * front.getStepX() + d.getZ() * front.getStepZ(), i = d.getX() * along.getX() + d.getZ() * along.getZ(), y = cell.getY() - origin.getY();
				if (k < 1 || k > pool + 3 || i < -1 || i > 4 || y > 3) return Blocks.STONE.defaultBlockState();
				int floor = k >= 6 ? -2 : k >= 4 ? -1 : 0;
				if (y > floor) return Blocks.CAVE_AIR.defaultBlockState();
				return y == -2 && k >= pool ? Blocks.LAVA.defaultBlockState() : Blocks.STONE.defaultBlockState();
			};
			boolean meets = ServerBuildController.spillMeetsLava(world, portal, wall);
			if (meets != (pool == 8)) throw new AssertionError("Standing water down a sloping floor toward a pool " + pool + " cells out, frame axis " + portal.axis() + ": " + meets);
			// In the cast's own order the water is scooped before its first spread: the same site is fit for it.
			if (ServerBuildController.spillMeetsLava(world, portal, wall, ServerBuildController.QUICK_SPILL_CELLS))
				throw new AssertionError("Water scooped the tick after it lands, down a sloping floor toward a pool " + pool + " cells out, frame axis " + portal.axis() + ", met lava");
			checks += 2;
		}
		return checks;
	}

	private static int verifyCrossPour() {
		BlockPos water = new BlockPos(0, 40, 0), frame = water.above();
		for (int pool : new int[] { 8, 9 }) {
			var lava = water.east(pool);
			boolean spills = ServerBuildController.crossPourMeetsLava(
					cell -> cell.equals(lava) ? Blocks.LAVA.defaultBlockState()
							: cell.getY() == 40 && cell.getZ() == 0 ? Blocks.AIR.defaultBlockState() : Blocks.STONE.defaultBlockState(),
					water, frame, Set.of());
			if (spills != (pool == 8)) throw new AssertionError("Seven flat flow steps can cool a source on the eighth cell");
		}
		if (!ServerBuildController.crossPourMeetsLava(
				cell -> cell.equals(water.below(35).east(7)) ? Blocks.LAVA.defaultBlockState()
						: cell.getX() == 0 && cell.getZ() == 0 && cell.getY() >= 5 || cell.getY() == 5 && cell.getZ() == 0
						? Blocks.AIR.defaultBlockState() : Blocks.STONE.defaultBlockState(), water, frame, Set.of()))
			throw new AssertionError("A fall past 32 cells still leaves seven flat steps");
		var lava = water.east(4);
		var drop = water.west().below();
		var terrain = (java.util.function.Function<BlockPos, BlockState>) cell -> cell.equals(lava) ? Blocks.LAVA.defaultBlockState()
				: cell.equals(drop) || cell.getY() == 40 && cell.getZ() == 0 ? Blocks.AIR.defaultBlockState() : Blocks.STONE.defaultBlockState();
		if (ServerBuildController.crossPourMeetsLava(terrain, water, frame, Set.of()))
			throw new AssertionError("Water follows the closer drop, away from the pool");
		if (!ServerBuildController.crossPourMeetsLava(terrain, water, frame, Set.of(drop)))
			throw new AssertionError("A filled drop restores the flat path toward lava");
		if (ServerBuildController.crossPourMeetsLava(terrain, water, frame, Set.of(drop, water.east())))
			throw new AssertionError("Solid frame blocks the flat path to the pool");
		// Standing water left from an earlier pour lies between the pour and a pool 4 cells out: the run-off goes through it.
		var standing = (java.util.function.Function<BlockPos, BlockState>) cell -> cell.equals(lava) ? Blocks.LAVA.defaultBlockState()
				: cell.getY() == 40 && cell.getZ() == 0 && (cell.getX() == 1 || cell.getX() == 2) ? Blocks.WATER.defaultBlockState()
				: cell.getY() == 40 && cell.getZ() == 0 ? Blocks.AIR.defaultBlockState() : Blocks.STONE.defaultBlockState();
		if (!ServerBuildController.crossPourMeetsLava(standing, water, frame, Set.of()))
			throw new AssertionError("Water already standing on the way to the pool carries the pour on to the lava");
		// The two cells before the pool were never seen: they may be open, so the pour may run on into the lava.
		var unseen = (java.util.function.Function<BlockPos, BlockState>) cell -> cell.equals(lava) ? Blocks.LAVA.defaultBlockState()
				: cell.getY() == 40 && cell.getZ() == 0 && (cell.getX() == 2 || cell.getX() == 3) ? null
				: cell.getY() == 40 && cell.getZ() == 0 ? Blocks.AIR.defaultBlockState() : Blocks.STONE.defaultBlockState();
		if (!ServerBuildController.crossPourMeetsLava(unseen, water, frame, Set.of()))
			throw new AssertionError("Unseen cells next to the pool may carry the pour into it");
		// Unseen cells away from any pool lava stay walls: a pool 8 cells out behind three unseen cells is safe.
		var far = water.east(8);
		var unseenFar = (java.util.function.Function<BlockPos, BlockState>) cell -> cell.equals(far) ? Blocks.LAVA.defaultBlockState()
				: cell.getY() == 40 && cell.getZ() == 0 && cell.getX() >= 1 && cell.getX() <= 3 ? null
				: cell.getY() == 40 && cell.getZ() == 0 ? Blocks.AIR.defaultBlockState() : Blocks.STONE.defaultBlockState();
		if (ServerBuildController.crossPourMeetsLava(unseenFar, water, frame, Set.of()))
			throw new AssertionError("Unseen cells far from the pool stop the trace");
		return 9;
	}

	/**
	 * The cast's clicks for one frame cell, tick by tick, against vanilla's timing: a lava source cast to obsidian the tick
	 * water lands beside it, a water source's first spread at 5 ticks, lava's first flow at 30. The body takes
	 * {@code turn} ticks from the lava's aim to the water's and back. Lava goes first, then water, then the scoop the next
	 * tick (water gone before it spreads); with the water click failing, the lava is taken back before it flows.
	 */
	private static int verifyCastTiming() {
		int checks = 0;
		for (int turn = 0; turn <= 8; turn++) for (boolean waterOk : new boolean[] { true, false }) {
			boolean lava = false, obsidian = false, water = false;
			long lavaAt = -1, waterAt = -1, scoopAt = -1, takenAt = -1, busyUntil = -1;
			StringBuilder order = new StringBuilder();
			for (long t = 0; t < 120 && !(obsidian && !water) && takenAt < 0; t++) {
				if (t < busyUntil) continue;
				var step = ServerBuildController.castStep(water, lava || obsidian, lava, lava ? t - lavaAt : 0, waterOk);
				if (obsidian && step != ServerBuildController.CastStep.SCOOP) throw new AssertionError("A cast cell asked for " + step);
				switch (step) {
					case LAVA -> { lava = true; lavaAt = t; busyUntil = t + 1 + turn; order.append('L'); }
					case WATER -> { water = true; waterAt = t; lava = false; obsidian = true; busyUntil = t + 1; order.append('W'); }
					case SCOOP -> { water = false; scoopAt = t; order.append('S'); }
					case TAKE_BACK -> { lava = false; takenAt = t + turn; order.append('T'); }
				}
			}
			if (waterOk) {
				if (!order.toString().equals("LWS")) throw new AssertionError("Cast order with a " + turn + "-tick turn: " + order);
				if (scoopAt - waterAt >= 5) throw new AssertionError("Water stood " + (scoopAt - waterAt) + " ticks, past its first spread");
				if (waterAt - lavaAt >= 30) throw new AssertionError("Lava stood " + (waterAt - lavaAt) + " ticks before the water");
			} else {
				if (!order.toString().equals("LT")) throw new AssertionError("Cast order with the water click failing: " + order);
				if (takenAt - lavaAt >= 30) throw new AssertionError("Lava taken back after " + (takenAt - lavaAt) + " ticks, past its first flow");
			}
			checks += 3;
		}
		return checks + verifyPourLine();
	}

	/**
	 * The water poured against lava poured first, seen from a cave room: frame at -281,-53,14 axis x, lava in side cell
	 * (3,1) at -278,-52,14, its water in the opening at -279,-52,14 against the mould's face behind it. From the body
	 * on the frame's plane to the east the line crosses the lava's cell, which casts as the water lands and then hides the
	 * water from the scoop (it stood 211 ticks and ran out); from the ground in front it does not.
	 */
	private static int verifyPourLine() {
		var portal = new ServerBuildController.Portal(new BlockPos(-281, -53, 14), Direction.Axis.X);
		BlockPos lava = portal.at(3, 1), water = portal.at(2, 1);
		if (!lava.equals(new BlockPos(-278, -52, 14)) || !water.equals(new BlockPos(-279, -52, 14))) throw new AssertionError("Pour line fixture cells");
		net.minecraft.world.phys.Vec3 face = new net.minecraft.world.phys.Vec3(-278.5D, -51.5D, 14.0D);
		net.minecraft.world.phys.Vec3 east = new net.minecraft.world.phys.Vec3(-274.5D, -51.38D, 14.5D), front = new net.minecraft.world.phys.Vec3(-278.5D, -50.38D, 16.5D);
		if (!ServerBuildController.crosses(east, face, lava)) throw new AssertionError("The water's line from the frame's plane passes through the lava's cell");
		if (ServerBuildController.crosses(front, face, lava)) throw new AssertionError("The water's line from in front of the opening misses the lava's cell");
		if (ServerBuildController.crosses(east, face, null)) throw new AssertionError("No cell to avoid crosses nothing");
		return 3;
	}

	private static int verifyCarve() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		int checks = 0;
		java.util.function.BiPredicate<BlockPos, BlockState> rock = (cell, state) -> state.isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, cell) && state.getFluidState().isEmpty();
		java.util.function.BiPredicate<BlockPos, BlockState> clearable = (cell, state) -> !state.is(Blocks.OBSIDIAN) && !state.is(Blocks.BEDROCK);
		for (Direction along : Direction.Plane.HORIZONTAL) {
			// A tunnel along {@code along} at y-58, the body at its cell 0; the site's mould side is to the tunnel's right.
			BlockPos stand = new BlockPos(6, -58, -130);
			Direction wall = along.getClockWise();
			Direction.Axis axis = wall.getAxis() == Direction.Axis.X ? Direction.Axis.Z : Direction.Axis.X;
			BlockPos frameGround = stand.relative(wall, 2).below();
			var portal = new ServerBuildController.Portal(axis == Direction.Axis.Z ? frameGround.offset(0, 0, -1) : frameGround.offset(-1, 0, 0), axis);
			Set<BlockPos> tunnel = new HashSet<>();
			for (int t = -12; t <= 12; t++) { tunnel.add(stand.relative(along, t)); tunnel.add(stand.relative(along, t).above()); }
			BlockPos ahead = stand.relative(along, 5), far = stand.relative(along, 12), behind = portal.at(2, 2).relative(wall, 2);
			for (BlockPos lava : new BlockPos[] { null, ahead, far, behind }) {
				// The eye knows the tunnel and the rock round it; everything further in is unseen.
				java.util.function.Function<BlockPos, BlockState> world = cell -> {
					if (cell.equals(lava)) return Blocks.LAVA.defaultBlockState();
					if (tunnel.contains(cell)) return Blocks.CAVE_AIR.defaultBlockState();
					for (Direction side : Direction.values()) if (tunnel.contains(cell.relative(side))) return Blocks.DEEPSLATE.defaultBlockState();
					return null;
				};
				int dig = ServerBuildController.carveDig(world, rock, clearable, portal, wall);
				// Lava seen two cells behind the frame rules the site out. Lava down the tunnel does not: the water poured
				// against the cast's lava is scooped the next tick, before it spreads, though left standing its whole run
				// would reach the lava 5 cells along.
				int expect = lava == behind ? -1 : 32;
				if (dig != expect) throw new AssertionError("Carve beside a tunnel heading " + along + " with lava at " + lava + ": dig " + dig + ", expected " + expect);
				if (lava == ahead && !ServerBuildController.spillMeetsLava(world, portal, wall)) throw new AssertionError("Standing water down a tunnel heading " + along + " runs into lava 5 cells along");
				checks += 2;
			}
			// The cells come front row first, bottom up: each one opens onto a cell dug before it or the tunnel.
			Set<BlockPos> open = new HashSet<>(tunnel);
			for (BlockPos cell : ServerBuildController.carveCells(portal, wall)) {
				boolean reachable = false;
				for (Direction side : Direction.values()) if (open.contains(cell.relative(side))) reachable = true;
				if (!reachable) throw new AssertionError("Carve cell " + cell + " is not open to anything dug before it");
				open.add(cell);
				checks++;
			}
			BlockPos wet = portal.at(0, 3).relative(portal.at(0, 3).getX() == portal.at(1, 3).getX() ? Direction.NORTH : Direction.WEST);
			java.util.function.Function<BlockPos, BlockState> aquifer = cell -> cell.equals(wet) ? Blocks.WATER.defaultBlockState()
					: tunnel.contains(cell) ? Blocks.CAVE_AIR.defaultBlockState() : null;
			if (ServerBuildController.carveDig(aquifer, rock, clearable, portal, wall) != -1) throw new AssertionError("Water beside the dig at " + wet + " rules the carve out");
			checks++;
		}
		return checks;
	}

	/** A cast's plain blocks: one per open mould cell and a step up, less the two the dug bottom row gives; the site check refuses no fewer. */
	private static int verifyCastBlocks() {
		int checks = 0;
		for (int mould = 0; mould <= 14; mould++) for (int plain = 0; plain <= 16; plain++) {
			boolean enough = plain >= ServerBuildController.castBlocks(mould);
			if (enough != (mould + 1 <= plain + 2)) throw new AssertionError(mould + " mould cells with " + plain + " plain blocks: " + enough);
			checks++;
		}
		if (ServerBuildController.castBlocks(12) != 11) throw new AssertionError("A 12-cell mould needs 11 plain blocks");
		return checks + 1;
	}

	private static int verifyMaterials() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		int checks = 0;
		for (String ok : List.of("minecraft:cobblestone", "minecraft:dirt", "minecraft:stone", "minecraft:netherrack")) {
			if (ServerBuildController.materialRefusal(ok) != null) throw new AssertionError(ok + " must build a bridge: " + ServerBuildController.materialRefusal(ok));
			checks++;
		}
		String[][] refused = { { "minecraft:sand", "falls" }, { "minecraft:gravel", "falls" }, { "minecraft:oak_planks", "fire" }, { "minecraft:white_wool", "fire" },
				{ "minecraft:obsidian", "plain full block" }, { "minecraft:tnt", "catches fire" }, { "minecraft:diamond", "not a block" }, { "minecraft:no_such_item", "not a block" } };
		for (String[] row : refused) {
			String why = ServerBuildController.materialRefusal(row[0]);
			if (why == null || !why.contains(row[1])) throw new AssertionError(row[0] + " must be refused for '" + row[1] + "', got " + why);
			checks++;
		}
		return checks;
	}

	/** The dug hole is entered only onto a seen dry floor exactly one block down. */
	private static int verifyHoleLanding() {
		int checks = 0;
		var feet = new dev.agaminggod.mineagen.client.navigation.GridPosition(0, 65, 2);
		BlockPos hole = new BlockPos(0, 64, 0);
		var air = net.minecraft.world.level.block.Blocks.AIR.defaultBlockState();
		var stone = net.minecraft.world.level.block.Blocks.STONE.defaultBlockState();
		java.util.function.BiFunction<net.minecraft.world.level.block.state.BlockState, Boolean, java.util.function.Function<BlockPos, net.minecraft.world.level.block.state.BlockState>> world =
				(floor, holeOpen) -> cell -> cell.equals(hole.below()) ? floor : cell.equals(hole) ? (holeOpen ? air : stone) : cell.equals(hole.above()) ? air : null;
		var shapes = net.minecraft.world.level.EmptyBlockGetter.INSTANCE;
		if (!ServerBuildController.safeHoleLanding(world.apply(stone, true), shapes, feet, hole)) throw new AssertionError("A seen stone floor one down is a safe landing");
		if (ServerBuildController.safeHoleLanding(world.apply(air, true), shapes, feet, hole)) throw new AssertionError("A thin roof over a cave (air under the hole) is no landing");
		if (ServerBuildController.safeHoleLanding(world.apply(null, true), shapes, feet, hole)) throw new AssertionError("An unseen floor is no landing");
		if (ServerBuildController.safeHoleLanding(world.apply(net.minecraft.world.level.block.Blocks.WATER.defaultBlockState(), true), shapes, feet, hole)) throw new AssertionError("Water is no floor");
		if (ServerBuildController.safeHoleLanding(world.apply(net.minecraft.world.level.block.Blocks.LAVA.defaultBlockState(), true), shapes, feet, hole)) throw new AssertionError("Lava is no floor");
		if (ServerBuildController.safeHoleLanding(world.apply(net.minecraft.world.level.block.Blocks.MAGMA_BLOCK.defaultBlockState(), true), shapes, feet, hole)) throw new AssertionError("Magma burns");
		if (ServerBuildController.safeHoleLanding(world.apply(stone, false), shapes, feet, hole)) throw new AssertionError("A filled hole cannot be entered");
		var higher = new dev.agaminggod.mineagen.client.navigation.GridPosition(0, 66, 2);
		if (ServerBuildController.safeHoleLanding(world.apply(stone, true), shapes, higher, hole)) throw new AssertionError("A hole two below the feet is a fall, not a step");
		return checks + 8;
	}

	private static int verifyLineCells() {
		var start = new dev.agaminggod.mineagen.client.navigation.GridPosition(10, 64, -3);
		var at = new dev.agaminggod.mineagen.client.navigation.GridPosition(14, 63, -2);
		if (ServerBuildController.lineCells(start, at, Direction.EAST) != 4) throw new AssertionError("Four cells east, whatever the height or a sideways step");
		if (ServerBuildController.lineCells(start, at, Direction.WEST) != 0) throw new AssertionError("Moving back never counts");
		if (ServerBuildController.lineCells(start, start, Direction.SOUTH) != 0) throw new AssertionError("Standing still covers nothing");
		return 3;
	}

	private static int verifyStepCrouch() {
		var STEP = TravelBuilder.Kind.STEP;
		if (!ServerBuildController.stepCrouch(STEP, 1, false, false, false)) throw new AssertionError("A step up with a drop behind the ledge lands crouched");
		if (!ServerBuildController.stepCrouch(STEP, 1, true, false, true)) throw new AssertionError("A step up with a hazard behind it lands crouched");
		if (ServerBuildController.stepCrouch(STEP, 1, true, false, false)) throw new AssertionError("A step up onto open ground keeps its upright jump");
		if (ServerBuildController.stepCrouch(STEP, 1, false, true, false)) throw new AssertionError("A wall behind the ledge stops the body; no crouch needed");
		if (!ServerBuildController.stepCrouch(TravelBuilder.Kind.CROSS, 0, true, false, false)) throw new AssertionError("Magma is crossed crouched");
		if (!ServerBuildController.stepCrouch(STEP, 0, true, false, false)) throw new AssertionError("A level step is crouched");
		return 6;
	}
}
