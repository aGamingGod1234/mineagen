package dev.agaminggod.mineagen.server.runtime.controller;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.util.Mth;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

/**
 * The same-level lava step (Nether lava safety). Lava killed 10 agents in 7 of 22 games; 6 had no mob near, and
 * those were walk-ins and floods at the body's own level, 20 HP to dead in about 2 s. The brink guard already refuses a
 * step over lava below (an unsupported box over a burning column); this is the other half: a supported step whose box
 * would overlap lava at the feet or head (a flow across the floor, a pool level with the walk, lava pouring in).
 */
public final class LavaStep {
	/** Ticks a refusal stays readable by the walker that caused it (for its seal). */
	public static final int REFUSAL_TICKS = 10;
	/** Reach (squared distance from the eye to the support face) within which a walker seals the lava cell. */
	public static final double SEAL_REACH_SQUARED = 4.5D * 4.5D;
	/** Seals at most this many lava cells per walk before handing back. */
	public static final int MAX_SEALS = 4;

	private LavaStep() {
	}

	/** One block state at a cell, or null when unknown. */
	@FunctionalInterface
	public interface Read {
		BlockState at(int x, int y, int z);
	}

	static boolean lava(BlockState state) {
		return state != null && state.getFluidState().getType().isSame(net.minecraft.world.level.material.Fluids.LAVA);
	}

	/**
	 * The first lava cell the box overlaps at the body's own height (the cells from its feet to its head), or null. A cell
	 * counts when the box enters the fluid's surface: vanilla's lava contact is the box against the fluid height, and lava
	 * with lava over it is full height.
	 */
	public static BlockPos touched(Read read, AABB box) {
		AABB body = box.deflate(1.0E-3D);
		for (int y = Mth.floor(body.minY); y <= Mth.floor(body.maxY); y++) {
			for (int x = Mth.floor(body.minX); x <= Mth.floor(body.maxX); x++) {
				for (int z = Mth.floor(body.minZ); z <= Mth.floor(body.maxZ); z++) {
					BlockState state = read.at(x, y, z);
					if (!lava(state)) continue;
					double surface = lava(read.at(x, y + 1, z)) ? 1.0D : Math.max(state.getFluidState().getOwnHeight(), 0.1D);
					if (body.minY < y + surface) return new BlockPos(x, y, z);
				}
			}
		}
		return null;
	}

	/**
	 * A lava cell the move would touch that the body does not touch already: the step to refuse, or null. Vanilla ground
	 * motion: the keys held one more tick add {@code acceleration} along {@code heading}, the body moves, then every tick
	 * with the keys released it moves again and loses to friction (0.6 block slipperiness times 0.91 drag). If that path
	 * meets lava, the keys must stop now. A body already overlapping lava is the hazard floor's to get out (the guard
	 * never holds a body in lava).
	 */
	public static BlockPos refused(Read read, AABB box, double motionX, double motionZ, double[] heading, double acceleration) {
		if (touched(read, box) != null) return null;
		BlockPos cell = coast(read, box, motionX + heading[0] * acceleration, motionZ + heading[1] * acceleration);
		if (cell == null) return null;
		// Keys that brake: when the body would reach the lava coasting with no keys at all, keys that take speed off
		// toward it are kept, since zeroing them would only lengthen the slide in.
		if (heading[0] * motionX + heading[1] * motionZ < 0.0D && coast(read, box, motionX, motionZ) != null) return null;
		return cell;
	}

	/** The first lava cell the box touches moving at (vx, vz) and then losing speed to ground friction, or null. */
	private static BlockPos coast(Read read, AABB box, double vx, double vz) {
		double x = 0.0D, z = 0.0D;
		for (int tick = 0; tick < COAST_TICKS && (tick == 0 || vx * vx + vz * vz > 1.0E-6D); tick++) {
			// A wall stops motion on its own axis only, as vanilla's collide does (the larger axis first): a body sliding
			// along a wall keeps its other component, which may carry it into lava beside the wall.
			boolean zFirst = Math.abs(vx) < Math.abs(vz);
			for (int axis = 0; axis < 2; axis++) {
				if ((axis == 0) != zFirst) {
					if (blocked(read, box.move(x + vx, 0.0D, z))) vx = 0.0D; else x += vx;
				} else {
					if (blocked(read, box.move(x, 0.0D, z + vz))) vz = 0.0D; else z += vz;
				}
			}
			if (vx == 0.0D && vz == 0.0D) return null;
			BlockPos cell = touched(read, box.move(x, 0.0D, z));
			if (cell != null) return cell;
			vx *= GROUND_DRAG;
			vz *= GROUND_DRAG;
		}
		return null;
	}

	/**
	 * Whether the box would run into a block it cannot step up onto: a part of a collision shape that the box overlaps
	 * and whose top is over a step above the feet. The real shape counts, not its cell: a fence post in a corner of a
	 * cell the box only clips is no wall.
	 */
	static boolean blocked(Read read, AABB box) {
		AABB body = box.deflate(1.0E-3D);
		for (int y = Mth.floor(body.minY); y <= Mth.floor(body.maxY); y++) {
			for (int x = Mth.floor(body.minX); x <= Mth.floor(body.maxX); x++) {
				for (int z = Mth.floor(body.minZ); z <= Mth.floor(body.maxZ); z++) {
					BlockState state = read.at(x, y, z);
					if (state == null) continue;
					var shape = state.getCollisionShape(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
					if (shape.isEmpty()) continue;
					for (AABB part : shape.toAabbs()) {
						AABB placed = part.move(x, y, z);
						if (placed.intersects(body) && placed.maxY > body.minY + STEP_HEIGHT) return true;
					}
				}
			}
		}
		return false;
	}

	private static final double STEP_HEIGHT = 0.6D;

	/**
	 * A lava cell a jump would touch on its way, or null when its whole path is clear. {@code shifts[t]} and
	 * {@code heights[t]} are the jump's horizontal displacement and rise after tick t+1 (rising, falling and landing
	 * ticks; the brink guard's jump model). A wall stops motion on its own axis only, from that tick on, as vanilla's
	 * collide does (the larger axis first), and the check goes on: a jump angled into a tunnel wall slides along it.
	 * Under a low ceiling the rise is cut to what fits and stays cut, never treated as safe.
	 */
	public static BlockPos jumpPath(Read read, AABB box, double[][] shifts, double[] heights) {
		if (touched(read, box) != null) return null;
		double ceiling = Double.MAX_VALUE, x = 0.0D, z = 0.0D, lastX = 0.0D, lastZ = 0.0D;
		boolean xStopped = false, zStopped = false;
		for (int tick = 0; tick < shifts.length; tick++) {
			double dx = xStopped ? 0.0D : shifts[tick][0] - lastX, dz = zStopped ? 0.0D : shifts[tick][1] - lastZ;
			lastX = shifts[tick][0];
			lastZ = shifts[tick][1];
			double want = Math.min(Math.max(0.0D, heights[tick]), ceiling);
			boolean zFirst = Math.abs(dx) < Math.abs(dz);
			for (int axis = 0; axis < 2; axis++) {
				if ((axis == 0) != zFirst) {
					if (dx != 0.0D && clearRise(read, box, x + dx, z, want) < 0.0D) xStopped = true; else x += dx;
				} else {
					if (dz != 0.0D && clearRise(read, box, x, z + dz, want) < 0.0D) zStopped = true; else z += dz;
				}
			}
			double rise = Math.max(0.0D, clearRise(read, box, x, z, want));
			if (rise < want) ceiling = rise;
			BlockPos cell = touched(read, box.move(x, rise, z));
			if (cell != null) return cell;
		}
		return null;
	}

	/** The highest rise up to {@code want} at which the box shifted by (x, z) is not blocked, or -1 when none is. */
	private static double clearRise(Read read, AABB box, double x, double z, double want) {
		for (double rise = want; ; rise = Math.max(0.0D, rise - 0.05D)) {
			if (!blocked(read, box.move(x, rise, z))) return rise;
			if (rise <= 0.0D) return -1.0D;
		}
	}

	/** A vanilla jump's rise above take-off after each of {@code ticks} ticks (0.42 up, then gravity 0.08 and drag 0.98). */
	public static double[] jumpHeights(int ticks) {
		double[] heights = new double[ticks];
		double y = 0.0D, vy = 0.42D;
		for (int tick = 0; tick < ticks; tick++) {
			y += vy;
			vy = (vy - 0.08D) * 0.98D;
			heights[tick] = Math.max(0.0D, y);
		}
		return heights;
	}

	/**
	 * Why a seal or plug may not place a block into {@code target} against {@code support}, or null: the same gates as
	 * a normal placement (ServerActionExecutor.requirePlacementGates): the caller's block policy for both cells, spawn
	 * protection, vanilla interaction rights, and the support within interaction range.
	 */
	public static String placementDenied(java.util.function.Predicate<BlockPos> policy, java.util.function.Predicate<BlockPos> spawnProtected,
			java.util.function.Predicate<BlockPos> mayInteract, boolean supportInReach, BlockPos target, BlockPos support) {
		if (!policy.test(target) || !policy.test(support)) return "protection denies the lava cell or its support";
		if (spawnProtected.test(target) || spawnProtected.test(support)) return "spawn protection covers the lava cell or its support";
		if (!mayInteract.test(target) || !mayInteract.test(support)) return "the lava cell or its support may not be used";
		return supportInReach ? null : "the support is out of reach";
	}

	/** The placement gates above for this body, with the caller's block policy. */
	public static String placementDenied(net.minecraft.server.level.ServerPlayer player, BlockPos target, BlockPos support,
			java.util.function.BiPredicate<net.minecraft.server.level.ServerPlayer, BlockPos> policy) {
		var level = player.level();
		return placementDenied(at -> policy.test(player, at), at -> level.getServer().isUnderSpawnProtection(level, at, player),
				at -> level.mayInteract(player, at), player.isWithinBlockInteractionRange(support, 0.0D), target, support);
	}

	/** Vanilla horizontal drag per tick on ordinary ground: block slipperiness 0.6 times 0.91. */
	static final double GROUND_DRAG = 0.6D * 0.91D;
	/** Ticks of coasting followed (motion falls under a thousandth of a block a tick within about 8). */
	static final int COAST_TICKS = 10;

	/**
	 * The face a block placed into a lava cell goes on: the top of a solid floor under it first (a flow across the floor),
	 * then a solid side beside it. Null when no neighbour holds a placement. {@code solid} says whether a cell is a full
	 * placement support.
	 */
	public static Direction sealFace(BlockPos lava, java.util.function.Predicate<BlockPos> solid) {
		java.util.List<Direction> faces = sealFaces(lava, solid);
		return faces.isEmpty() ? null : faces.get(0);
	}

	/** Every face a seal may go on, in that preference order; the caller takes the first it can reach and may use. */
	public static java.util.List<Direction> sealFaces(BlockPos lava, java.util.function.Predicate<BlockPos> solid) {
		java.util.List<Direction> faces = new java.util.ArrayList<>();
		if (solid.test(lava.below())) faces.add(Direction.UP);
		for (Direction side : Direction.Plane.HORIZONTAL) if (solid.test(lava.relative(side.getOpposite()))) faces.add(side);
		if (solid.test(lava.above())) faces.add(Direction.DOWN);
		return faces;
	}
}
