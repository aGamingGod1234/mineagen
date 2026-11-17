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
		return checks + verifyCastPlan() + verifySpill() + verifyCastBlocks() + verifyMaterials() + verifyHoleLanding() + verifyLineCells() + verifyStepCrouch() + verifyCarve();
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
		}
		return checks;
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
				// Lava down the tunnel within the poured water's run, or seen two cells behind the frame, rules the site out;
				// lava further down the tunnel does not.
				int expect = lava == ahead || lava == behind ? -1 : 32;
				if (dig != expect) throw new AssertionError("Carve beside a tunnel heading " + along + " with lava at " + lava + ": dig " + dig + ", expected " + expect);
				checks++;
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
