package dev.agaminggod.mineagen.server.perception;

import java.util.HashMap;
import java.util.Map;
import java.util.Objects;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.RenderShape;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.block.state.properties.BlockStateProperties;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

public final class ObservationVisibility {
	private static final double TOUCH_AWARENESS_DISTANCE_SQUARED = 4.0D;
	private static final double MINIMUM_VIEW_DOT = 0.25D;
	private static final double[] CELL_SAMPLE_HEIGHTS = {0.98D, 0.15D};

	private ObservationVisibility() {
	}

	public static boolean canSeeEntity(ServerPlayer observer, Entity entity) {
		Objects.requireNonNull(observer, "observer must not be null");
		Objects.requireNonNull(entity, "entity must not be null");
		return frame(observer.level(), observer).canSeeEntity(entity);
	}

	public static boolean canSeeBlock(ServerLevel level, ServerPlayer observer, BlockPos position) {
		Objects.requireNonNull(level, "level must not be null");
		Objects.requireNonNull(observer, "observer must not be null");
		Objects.requireNonNull(position, "position must not be null");
		return frame(level, observer).canSeeBlock(position);
	}

	public static Frame frame(ServerLevel level, ServerPlayer observer) {
		return new Frame(level, observer);
	}

	static boolean isWithinViewCone(Vec3 eye, Vec3 view, Vec3 target) {
		Objects.requireNonNull(eye, "eye must not be null");
		Objects.requireNonNull(view, "view must not be null");
		Objects.requireNonNull(target, "target must not be null");
		return isWithinNormalizedViewCone(
				eye,
				view.lengthSqr() == 0.0D ? Vec3.ZERO : view.normalize(),
				target
		);
	}

	private static boolean isWithinNormalizedViewCone(Vec3 eye, Vec3 normalizedView, Vec3 target) {
		if (target.subtract(eye).lengthSqr() <= TOUCH_AWARENESS_DISTANCE_SQUARED) return true;
		return isInFrontOfEye(eye, normalizedView, target);
	}

	static boolean isInFrontOfEye(Vec3 eye, Vec3 normalizedView, Vec3 target) {
		Vec3 offset = target.subtract(eye);
		if (offset.lengthSqr() == 0.0D || normalizedView.lengthSqr() == 0.0D) return false;
		return offset.normalize().dot(normalizedView) >= MINIMUM_VIEW_DOT;
	}

	public static final class Frame {
		private final ServerLevel level;
		private final ServerPlayer observer;
		private final Vec3 eye;
		private final Vec3 normalizedView;
		private final Map<Long, Boolean> visibleBlocks = new HashMap<>();
		private final Map<Long, Boolean> seenCells = new HashMap<>();

		private Frame(ServerLevel level, ServerPlayer observer) {
			this.level = Objects.requireNonNull(level, "level must not be null");
			this.observer = Objects.requireNonNull(observer, "observer must not be null");
			this.eye = observer.getEyePosition();
			Vec3 view = observer.getViewVector(1.0F);
			this.normalizedView = view.lengthSqr() == 0.0D ? Vec3.ZERO : view.normalize();
		}

		public boolean isEntityWithinView(Entity entity) {
			Objects.requireNonNull(entity, "entity must not be null");
			if (entity instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon && anyPart(dragon, this::isEntityWithinView)) return true;
			return !entity.isInvisibleTo(observer)
					&& isWithinNormalizedViewCone(eye, normalizedView, entity.getBoundingBox().getCenter());
		}

		/**
		 * The dragon's visible body is its parts: its root box centre sits inside them, and inside the fountain when it
		 * perches, so a player looking at its head from beside the fountain still sees the dragon.
		 */
		private static boolean anyPart(net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon, java.util.function.Predicate<Entity> test) {
			var parts = dragon.getSubEntities();
			if (parts != null) for (var part : parts) if (part != null && test.test(part)) return true;
			return false;
		}

		public boolean hasLineOfSight(Entity entity) {
			Objects.requireNonNull(entity, "entity must not be null");
			if (entity instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon && anyPart(dragon, this::hasLineOfSight)) return true;
			CollisionContext context = CollisionContext.of(observer);
			return EntityHitboxSight.point(eye, entity.getBoundingBox(), point -> {
				Vec3 hit = EntityHitboxSight.intersection(eye, point, entity.getBoundingBox());
				return hit != null && hasLoadedSightPath(eye, hit, level::hasChunkAt)
						&& EntityHitboxSight.clear(level, context, eye, hit, ClipContext.Block.VISUAL)
						&& !lavaBetween(level, eye, hit, null);
			}) != null;
		}

		public boolean canSeeEntity(Entity entity) {
			return isEntityWithinView(entity) && hasLineOfSight(entity);
		}

		/** Visual details have no nearby touch-awareness exception, including behind the viewer. */
		public boolean canSeeAppearance(Entity entity) {
			return !entity.isInvisibleTo(observer)
					&& observer.distanceToSqr(entity) <= 128.0D * 128.0D
					&& (isInFrontOfEye(eye, normalizedView, entity.getBoundingBox().getCenter())
							|| entity instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragon dragon
									&& anyPart(dragon, part -> isInFrontOfEye(eye, normalizedView, part.getBoundingBox().getCenter())))
					&& hasLineOfSight(entity);
		}

		public boolean canSeeBlock(BlockPos position) {
			Objects.requireNonNull(position, "position must not be null");
			return isBlockWithinView(position) && hasLineOfSight(position);
		}

		public boolean isBlockWithinView(BlockPos position) {
			return isWithinNormalizedViewCone(
					eye, normalizedView, Vec3.atCenterOf(Objects.requireNonNull(position, "position must not be null")));
		}

		public boolean hasLineOfSight(BlockPos position) {
			Objects.requireNonNull(position, "position must not be null");
			return memoizedBlockVisibility(visibleBlocks, position, this::traceBlock);
		}

		private boolean traceBlock(BlockPos position) {
			if (!hasLoadedSightPath(eye, Vec3.atCenterOf(position), level::hasChunkAt)) return false;
			return ObservationVisibility.traceBlock(level, CollisionContext.of(observer), eye, position);
		}

		public boolean lavaHides(BlockPos position) {
			Objects.requireNonNull(position, "position must not be null");
			return lavaBetween(level, eye, Vec3.atCenterOf(position), position);
		}

		/** {@link ObservationVisibility#seesCell} from this eye; open air counts, lava hides what is behind it. */
		public boolean seesCell(BlockPos position) {
			Objects.requireNonNull(position, "position must not be null");
			return memoizedBlockVisibility(seenCells, position, this::traceCell);
		}

		/**
		 * {@link #seesCell} without this frame's memo: for a caller that asks each cell of the frame at most once, so
		 * the memo would only be written, never read.
		 */
		public boolean seesCellOnce(BlockPos position) {
			Objects.requireNonNull(position, "position must not be null");
			return traceCell(position);
		}

		private boolean traceCell(BlockPos cell) {
			return hasLoadedSightPath(eye, Vec3.atCenterOf(cell), level::hasChunkAt)
					&& ObservationVisibility.seesCell(level, CollisionContext.of(observer), eye, normalizedView, cell);
		}
	}

	/**
	 * Whether the eye sees this cell, whatever it holds (open air included): in the view cone, with no block and no lava
	 * in between. Unlike block rows there is no touch allowance: being close says nothing about the empty cells and
	 * landings behind the eye. Lava is opaque. For blocks, also test the actual view ray and shared hitbox sight
	 * samples across their shape, including lower edges. Air still needs evidence of the opening's depth.
	 */
	static boolean seesCell(BlockGetter level, CollisionContext context, Vec3 eye, Vec3 normalizedView, BlockPos position) {
		// Copied once: callers pass a reused mutable cursor, and the rays below compare hits against this cell.
		BlockPos cell = position.immutable();
		Blockers blockers = new Blockers();
		Vec3 center = Vec3.atCenterOf(cell);
		if (isInFrontOfEye(eye, normalizedView, center) && seesPoint(level, context, eye, cell, center, blockers)) return true;
		// A nearby opening can be in view at its lower interior while its centre is above the view cone. Checking
		// only the centre and top left jump headroom unknown even beside a plainly visible one-block bank.
		for (double dy : CELL_SAMPLE_HEIGHTS) {
			for (double dx = 0.15D; dx < 1.0D; dx += 0.7D) {
				for (double dz = 0.15D; dz < 1.0D; dz += 0.7D) {
					Vec3 sample = new Vec3(cell.getX() + dx, cell.getY() + dy, cell.getZ() + dz);
					if (isInFrontOfEye(eye, normalizedView, sample) && seesPoint(level, context, eye, cell, sample, blockers)) return true;
				}
			}
		}
		BlockState state = level.getBlockState(cell);
		// A glimpse at an empty cell's near boundary does not establish the depth of that opening.
		if (state.isAir()) return false;
		for (AABB local : state.getShape(level, cell, context).toAabbs()) {
			AABB box = local.move(cell);
			Vec3 viewHit = EntityHitboxSight.intersection(eye, eye.add(normalizedView.scale(eye.distanceTo(box.getCenter()) + 2D)), box);
			if (viewHit != null && isInFrontOfEye(eye, normalizedView, viewHit)
					&& seesPoint(level, context, eye, cell, viewHit, blockers)) return true;
			if (EntityHitboxSight.point(eye, box, point -> isInFrontOfEye(eye, normalizedView, point)
					&& seesPoint(level, context, eye, cell, point, blockers)) != null) return true;
		}
		return false;
	}

	private static boolean seesPoint(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos position, Vec3 target, Blockers blockers) {
		// A ray through the inside of a full block already found in the way stops there, so the trace would only repeat it.
		if (blockers.crosses(eye, target)) return false;
		BlockHitResult hit = level.clip(new CellSightClip(eye, target, context, position));
		if (hit.getType() != HitResult.Type.MISS && !hit.getBlockPos().equals(position)) {
			blockers.note(level, context, eye, position, hit.getBlockPos());
			return false;
		}
		return !lavaBetween(level, eye, target, position);
	}

	/**
	 * The shape a cell sight ray meets: terrain footing includes the backing surface of a zero-collision snow dusting,
	 * so the target's own one-layer coating is ignored, never intervening snow, leaves, thicker cover or an opaque block.
	 */
	private static net.minecraft.world.phys.shapes.VoxelShape cellSightShape(
			BlockState state, BlockGetter world, BlockPos cell, CollisionContext context, BlockPos position) {
		if (cell.getX() == position.getX() && cell.getZ() == position.getZ() && cell.getY() == position.getY() + 1
				&& state.is(Blocks.SNOW) && state.getValue(BlockStateProperties.LAYERS) == 1) {
			return net.minecraft.world.phys.shapes.Shapes.empty();
		}
		net.minecraft.world.phys.shapes.VoxelShape fluid = EntityHitboxSight.fluidBlockShape(state, context);
		return fluid != null ? fluid : ClipContext.Block.VISUAL.get(state, world, cell, context);
	}

	private static final class CellSightClip extends ClipContext {
		private final CollisionContext context;
		private final BlockPos position;

		CellSightClip(Vec3 eye, Vec3 target, CollisionContext context, BlockPos position) {
			super(eye, target, ClipContext.Block.VISUAL, ClipContext.Fluid.NONE, context);
			this.context = context;
			this.position = position;
		}

		@Override
		public net.minecraft.world.phys.shapes.VoxelShape getBlockShape(BlockState state, BlockGetter world, BlockPos cell) {
			return cellSightShape(state, world, cell, context, position);
		}
	}

	/**
	 * Full blocks that already stopped a ray to one target cell during one {@link #seesCell} call, when the world
	 * cannot change. A later ray that passes through the inside of one (kept a margin clear of its faces, so edge and
	 * corner grazes never count) is stopped by it or by a block before it: the trace visits every cell whose inside
	 * the ray crosses, and a full block's shape reports a ray that enters it from outside. A block the eye is in or
	 * touches is never kept, since a ray that starts inside a block can leave it unreported. That block is never the target, whose
	 * cell holds the ray's end, so the ray would fail; skipping its trace gives the same answer.
	 */
	static final class Blockers {
		private static final double MARGIN = 1.0E-4D;
		private long[] cells = new long[4];
		private int size;

		void note(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos position, BlockPos hit) {
			// From inside a block, the trace only finds that block when the ray's first thousandth is still in it.
			if (near(eye.x, hit.getX()) && near(eye.y, hit.getY()) && near(eye.z, hit.getZ())) return;
			long key = hit.asLong();
			for (int index = 0; index < size; index++) if (cells[index] == key) return;
			BlockPos cell = hit.immutable();
			if (cellSightShape(level.getBlockState(cell), level, cell, context, position) != net.minecraft.world.phys.shapes.Shapes.block()) return;
			if (size == cells.length) cells = java.util.Arrays.copyOf(cells, size * 2);
			cells[size++] = key;
		}

		private static boolean near(double eye, int low) {
			return eye >= low - MARGIN && eye <= low + 1.0D + MARGIN;
		}

		boolean crosses(Vec3 from, Vec3 to) {
			for (int index = 0; index < size; index++) {
				long key = cells[index];
				if (crossesInside(from, to, BlockPos.getX(key), BlockPos.getY(key), BlockPos.getZ(key))) return true;
			}
			return false;
		}

		/** Whether the segment runs a positive length through the cube [x, x+1]^3 shrunk by {@link #MARGIN}. */
		static boolean crossesInside(Vec3 from, Vec3 to, int x, int y, int z) {
			double enter = 0.0D;
			double exit = 1.0D;
			double[] starts = {from.x, from.y, from.z};
			double[] deltas = {to.x - from.x, to.y - from.y, to.z - from.z};
			int[] lows = {x, y, z};
			for (int axis = 0; axis < 3; axis++) {
				double min = lows[axis] + MARGIN;
				double max = lows[axis] + 1.0D - MARGIN;
				double start = starts[axis];
				double delta = deltas[axis];
				if (Math.abs(delta) < 1.0E-12D) {
					if (start < min || start > max) return false;
					continue;
				}
				double first = (min - start) / delta;
				double second = (max - start) / delta;
				enter = Math.max(enter, Math.min(first, second));
				exit = Math.min(exit, Math.max(first, second));
				if (enter >= exit) return false;
			}
			return exit - enter > 1.0E-9D;
		}
	}

	public static boolean lavaBetween(BlockGetter level, Vec3 from, Vec3 to, BlockPos target) {
		return BlockGetter.traverseBlocks(from, to, level, (getter, cell) -> {
			if (cell.equals(target)) return null;
			FluidState fluid = getter.getFluidState(cell);
			if (!Fluids.LAVA.isSame(fluid.getType()) || fluid.getShape(getter, cell).clip(from, to, cell) == null) return null;
			return Boolean.TRUE;
		}, getter -> Boolean.FALSE);
	}

	static boolean hasLoadedSightPath(Vec3 origin, Vec3 target, Predicate<BlockPos> loaded) {
		Vec3 delta = target.subtract(origin);
		double distance = delta.length();
		Vec3 direction = delta.normalize();
		Vec3 endpoint = ServerObservationCollector.loadedSightEndpoint(origin, direction, distance, loaded);
		return origin.add(direction.scale(distance)).equals(endpoint);
	}

	static boolean traceBlock(BlockGetter level, CollisionContext context, Vec3 eye, BlockPos position) {
		BlockHitResult hit = level.clip(new ClipContext(
				eye, Vec3.atCenterOf(position), ClipContext.Block.VISUAL, ClipContext.Fluid.NONE, context));
		// Fluids and partial visual shapes can leave a clear ray without a block hit.
		if (hit.getType() != HitResult.Type.MISS) return hit.getBlockPos().equals(position);
		BlockState state = level.getBlockState(position);
		return !state.isAir()
				&& (state.getRenderShape() != RenderShape.INVISIBLE || !state.getFluidState().isEmpty()
						// End portal surfaces are drawn by block-entity renderers, despite an invisible block model.
						|| state.is(Blocks.END_PORTAL) || state.is(Blocks.END_GATEWAY));
	}

	static boolean memoizedBlockVisibility(
			Map<Long, Boolean> visibleBlocks,
			BlockPos position,
			Predicate<BlockPos> trace
	) {
		Objects.requireNonNull(visibleBlocks, "visibleBlocks must not be null");
		Objects.requireNonNull(position, "position must not be null");
		Objects.requireNonNull(trace, "trace must not be null");
		long key = position.asLong();
		Boolean cached = visibleBlocks.get(key);
		if (cached != null || visibleBlocks.containsKey(key)) return Boolean.TRUE.equals(cached);
		boolean visible = trace.test(position);
		visibleBlocks.put(key, visible);
		return visible;
	}
}
