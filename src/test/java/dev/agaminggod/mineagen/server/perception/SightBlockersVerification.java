package dev.agaminggod.mineagen.server.perception;

import java.util.HashMap;
import java.util.Map;
import java.util.SplittableRandom;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.SlabBlock;
import net.minecraft.world.level.block.entity.BlockEntity;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.block.state.properties.SlabType;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/**
 * Cell sight that skips rays through a full block already found in the way answers exactly as tracing every ray did:
 * random scenes, eyes at cell centres, on cell edges and anywhere, compared against the full-trace reference.
 */
public final class SightBlockersVerification {
	private SightBlockersVerification() {
	}

	public static void main(String[] args) {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		System.out.println("assertions " + verify());
		timing();
	}

	public static int verify() {
		int assertions = 0;
		Map<BlockPos, BlockState> states = new HashMap<>();
		BlockGetter world = new BlockGetter() {
			@Override public BlockEntity getBlockEntity(BlockPos position) { return null; }
			@Override public BlockState getBlockState(BlockPos position) { return states.getOrDefault(position, Blocks.AIR.defaultBlockState()); }
			@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
			@Override public int getHeight() { return 384; }
			@Override public int getMinY() { return -64; }
		};
		BlockState[] palette = {
				Blocks.AIR.defaultBlockState(), Blocks.AIR.defaultBlockState(), Blocks.AIR.defaultBlockState(),
				Blocks.AIR.defaultBlockState(), Blocks.AIR.defaultBlockState(), Blocks.STONE.defaultBlockState(),
				Blocks.STONE.defaultBlockState(), Blocks.DIRT.defaultBlockState(), Blocks.GLASS.defaultBlockState(),
				Blocks.OAK_LEAVES.defaultBlockState(), Blocks.WATER.defaultBlockState(), Blocks.LAVA.defaultBlockState(),
				Blocks.OAK_SLAB.defaultBlockState().setValue(SlabBlock.TYPE, SlabType.BOTTOM),
				Blocks.SNOW.defaultBlockState().setValue(BlockStateProperties.LAYERS, 1),
				Blocks.SNOW.defaultBlockState().setValue(BlockStateProperties.LAYERS, 4),
				Blocks.OAK_FENCE.defaultBlockState(), Blocks.GRASS_BLOCK.defaultBlockState(), Blocks.TORCH.defaultBlockState()
		};
		SplittableRandom random = new SplittableRandom(0x5EE5L);
		CollisionContext context = CollisionContext.empty();
		int seen = 0;
		int hidden = 0;
		for (int scene = 0; scene < 400; scene++) {
			states.clear();
			// Denser scenes hide more cells, which is where blockers are used.
			double fill = 0.2D + random.nextDouble() * 0.6D;
			for (int x = -5; x <= 5; x++) {
				for (int y = 60; y <= 70; y++) {
					for (int z = -5; z <= 5; z++) {
						if (random.nextDouble() > fill) continue;
						states.put(new BlockPos(x, y, z), palette[random.nextInt(palette.length)]);
					}
				}
			}
			for (int look = 0; look < 50; look++) {
				int kind = random.nextInt(3);
				double ex = coordinate(random, kind, -4, 4);
				double ey = coordinate(random, kind, 62, 68) + (kind == 0 ? 0.12D : 0.0D);
				double ez = coordinate(random, kind, -4, 4);
				Vec3 eye = new Vec3(ex, ey, ez);
				Vec3 view = new Vec3(random.nextDouble() * 2 - 1, random.nextDouble() * 2 - 1, random.nextDouble() * 2 - 1);
				if (view.lengthSqr() < 1.0E-6D) continue;
				view = view.normalize();
				// Axis-aligned views put many rays exactly along cell faces.
				if (random.nextInt(4) == 0) view = new Vec3(Math.signum(view.x), 0.0D, 0.0D);
				BlockPos.MutableBlockPos cursor = new BlockPos.MutableBlockPos();
				for (int cell = 0; cell < 20; cell++) {
					cursor.set(random.nextInt(-5, 6), random.nextInt(60, 71), random.nextInt(-5, 6));
					boolean expected = referenceSeesCell(world, context, eye, view, cursor.immutable());
					boolean actual = ObservationVisibility.seesCell(world, context, eye, view, cursor);
					check(actual == expected, "cell sight with blockers matches the full trace at " + cursor + " from " + eye + " looking " + view);
					assertions++;
					if (expected) seen++;
					else hidden++;
				}
			}
		}
		check(seen > 1000 && hidden > 1000, "the random scenes cover both seen and hidden cells: " + seen + " seen, " + hidden + " hidden");
		assertions++;
		check(ObservationVisibility.Blockers.crossesInside(new Vec3(-1, 0.5, 0.5), new Vec3(2, 0.5, 0.5), 0, 0, 0),
				"a ray through a block's middle crosses its inside");
		check(!ObservationVisibility.Blockers.crossesInside(new Vec3(-1, 0.0, 0.5), new Vec3(2, 0.0, 0.5), 0, 0, 0),
				"a ray along a block's face does not cross its inside");
		check(!ObservationVisibility.Blockers.crossesInside(new Vec3(-1, 0.0, 0.0), new Vec3(2, 0.0, 0.0), 0, 0, 0),
				"a ray along a block's edge does not cross its inside");
		check(!ObservationVisibility.Blockers.crossesInside(new Vec3(-1, 0.5, 0.5), new Vec3(-0.5, 0.5, 0.5), 0, 0, 0),
				"a ray that stops short does not cross the block");
		assertions += 4;
		return assertions;
	}

	/** Rough cost of both traces over one dense scene (not asserted: only printed for the record). */
	private static void timing() {
		Map<BlockPos, BlockState> states = new HashMap<>();
		BlockGetter world = new BlockGetter() {
			@Override public BlockEntity getBlockEntity(BlockPos position) { return null; }
			@Override public BlockState getBlockState(BlockPos position) { return states.getOrDefault(position, Blocks.AIR.defaultBlockState()); }
			@Override public FluidState getFluidState(BlockPos position) { return getBlockState(position).getFluidState(); }
			@Override public int getHeight() { return 384; }
			@Override public int getMinY() { return -64; }
		};
		// A hillside: stone below a rolling surface, the eye above it looking across.
		for (int x = -24; x <= 24; x++) for (int z = -24; z <= 24; z++) {
			int top = 64 + (int) Math.round(3 * Math.sin(x / 5.0D) + 2 * Math.cos(z / 4.0D));
			for (int y = 50; y <= top; y++) states.put(new BlockPos(x, y, z), y == top ? Blocks.GRASS_BLOCK.defaultBlockState() : Blocks.STONE.defaultBlockState());
		}
		Vec3 eye = new Vec3(0.5D, 70.62D, 0.5D);
		Vec3 view = new Vec3(1, -0.3, 0.2).normalize();
		CollisionContext context = CollisionContext.empty();
		for (int round = 0; round < 3; round++) {
			long reference = 0L;
			long blockers = 0L;
			int cells = 0;
			for (int x = -20; x <= 20; x++) for (int z = -20; z <= 20; z++) for (int y = 56; y <= 70; y++) {
				BlockPos cell = new BlockPos(x, y, z);
				long start = System.nanoTime();
				boolean expected = referenceSeesCell(world, context, eye, view, cell);
				long middle = System.nanoTime();
				boolean actual = ObservationVisibility.seesCell(world, context, eye, view, cell);
				long end = System.nanoTime();
				check(actual == expected, "hillside cell sight matches at " + cell);
				reference += middle - start;
				blockers += end - middle;
				cells++;
			}
			System.out.printf("hillside %d cells: full trace %.1f ms, with blockers %.1f ms%n", cells, reference / 1e6, blockers / 1e6);
		}
	}

	private static double coordinate(SplittableRandom random, int kind, int low, int high) {
		int cell = random.nextInt(low, high + 1);
		return switch (kind) {
			case 0 -> cell + 0.5D;
			case 1 -> cell;
			default -> cell + random.nextDouble();
		};
	}

	private static final double[] CELL_SAMPLE_HEIGHTS = {0.98D, 0.15D};

	/** The cell sight trace as it was before blockers: every ray traced in full. */
	private static boolean referenceSeesCell(BlockGetter level, CollisionContext context, Vec3 eye, Vec3 normalizedView, BlockPos position) {
		Vec3 center = Vec3.atCenterOf(position);
		if (ObservationVisibility.isInFrontOfEye(eye, normalizedView, center) && referenceSeesPoint(level, context, eye, position, center)) return true;
		for (double dy : CELL_SAMPLE_HEIGHTS) {
			for (double dx = 0.15D; dx < 1.0D; dx += 0.7D) {
				for (double dz = 0.15D; dz < 1.0D; dz += 0.7D) {
					Vec3 sample = new Vec3(position.getX() + dx, position.getY() + dy, position.getZ() + dz);
					if (ObservationVisibility.isInFrontOfEye(eye, normalizedView, sample) && referenceSeesPoint(level, context, eye, position, sample)) return true;
				}
			}
		}
		BlockState state = level.getBlockState(position);
		if (state.isAir()) return false;
		for (AABB local : state.getShape(level, position, context).toAabbs()) {
			AABB box = local.move(position);
			Vec3 viewHit = EntityHitboxSight.intersection(eye, eye.add(normalizedView.scale(eye.distanceTo(box.getCenter()) + 2D)), box);
			if (viewHit != null && ObservationVisibility.isInFrontOfEye(eye, normalizedView, viewHit)
					&& referenceSeesPoint(level, context, eye, position, viewHit)) return true;
			if (EntityHitboxSight.point(eye, box, point -> ObservationVisibility.isInFrontOfEye(eye, normalizedView, point)
					&& referenceSeesPoint(level, context, eye, position, point)) != null) return true;
		}
		return false;
	}

	private static boolean referenceSeesPoint(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos position, Vec3 target) {
		BlockHitResult hit = level.clip(new ClipContext(eye, target, ClipContext.Block.VISUAL, ClipContext.Fluid.NONE, context) {
			@Override public net.minecraft.world.phys.shapes.VoxelShape getBlockShape(BlockState state, BlockGetter world, BlockPos cell) {
				if (cell.getX() == position.getX() && cell.getZ() == position.getZ() && cell.getY() == position.getY() + 1
						&& state.is(Blocks.SNOW) && state.getValue(BlockStateProperties.LAYERS) == 1) {
					return net.minecraft.world.phys.shapes.Shapes.empty();
				}
				return super.getBlockShape(state, world, cell);
			}
		});
		if (hit.getType() != HitResult.Type.MISS && !hit.getBlockPos().equals(position)) return false;
		return !ObservationVisibility.lavaBetween(level, eye, target, position);
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
