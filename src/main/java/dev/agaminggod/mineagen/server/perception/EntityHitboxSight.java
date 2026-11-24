package dev.agaminggod.mineagen.server.perception;

import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;
import net.minecraft.world.phys.shapes.EntityCollisionContext;
import net.minecraft.world.phys.shapes.Shapes;
import net.minecraft.world.phys.shapes.VoxelShape;

public final class EntityHitboxSight {
	private EntityHitboxSight() { }

	/** The centre is cheapest; only a concealed centre needs the nearer face and inset corners. */
	public static Vec3 point(Vec3 eye, AABB box, Predicate<Vec3> clear) {
		Vec3 centre = box.getCenter();
		if (clear.test(centre)) return centre;
		double inset = Math.min(1.0E-4D, Math.min(box.getXsize(), Math.min(box.getYsize(), box.getZsize())) / 4.0D);
		AABB inside = box.deflate(inset);
		Vec3 near = new Vec3(Math.clamp(eye.x, inside.minX, inside.maxX), Math.clamp(eye.y, inside.minY, inside.maxY),
				Math.clamp(eye.z, inside.minZ, inside.maxZ));
		if (clear.test(near)) return near;
		for (double x : new double[]{inside.minX, inside.maxX}) {
			for (double y : new double[]{inside.maxY, inside.minY}) {
				for (double z : new double[]{inside.minZ, inside.maxZ}) {
					Vec3 corner = new Vec3(x, y, z);
					if (clear.test(corner)) return corner;
				}
			}
		}
		return null;
	}

	/** Stops at the first real box surface, rather than rejecting a visible front because its rear is covered. */
	public static Vec3 intersection(Vec3 eye, Vec3 aim, AABB box) {
		return box.contains(eye) ? eye : box.clip(eye, aim).orElse(null);
	}

	/** Tests the ray reconstructed from the actual float angles, even after a turn has settled. */
	public static boolean clearRay(BlockGetter world, CollisionContext context, Vec3 eye, float yaw, float pitch,
			AABB box, double range) {
		Vec3 end = eye.add(Vec3.directionFromRotation(pitch, yaw).scale(range));
		return clear(world, context, eye, intersection(eye, end, box), ClipContext.Block.COLLIDER);
	}

	public static boolean clear(BlockGetter world, CollisionContext context, Vec3 eye, Vec3 hit, ClipContext.Block shape) {
		if (hit == null) return false;
		ClipContext clip = shape == ClipContext.Block.VISUAL || shape == ClipContext.Block.COLLIDER
				? new FluidAwareClip(eye, hit, shape, context) : new ClipContext(eye, hit, shape, ClipContext.Fluid.NONE, context);
		return world.clip(clip).getType() == HitResult.Type.MISS;
	}

	/**
	 * The visual or collision shape of a liquid block for this context, or null to ask the block. Vanilla's liquid
	 * shape is a full block only for a context that always collides with fluid (left to the block), and otherwise
	 * empty unless it is a source under a living body that can stand on that fluid. Players cannot, so a ray through
	 * water skips the per-cell lookup of the fluid above and the optional chain that ends in the same empty shape.
	 */
	static VoxelShape fluidBlockShape(BlockState state, CollisionContext context) {
		if (state.getBlock().getClass() != LiquidBlock.class || context.getClass() != EntityCollisionContext.class) return null;
		EntityCollisionContext entityContext = (EntityCollisionContext) context;
		if (entityContext.alwaysCollideWithFluid()) return null;
		if (state.getValue(LiquidBlock.LEVEL) != 0) return Shapes.empty();
		if (!(entityContext.getEntity() instanceof LivingEntity living)) return Shapes.empty();
		return living.canStandOnFluid(state.getFluidState()) ? null : Shapes.empty();
	}

	private static final class FluidAwareClip extends ClipContext {
		private final ClipContext.Block shape;
		private final CollisionContext context;

		FluidAwareClip(Vec3 eye, Vec3 hit, ClipContext.Block shape, CollisionContext context) {
			super(eye, hit, shape, ClipContext.Fluid.NONE, context);
			this.shape = shape;
			this.context = context;
		}

		@Override
		public VoxelShape getBlockShape(BlockState state, BlockGetter world, BlockPos cell) {
			VoxelShape fluid = fluidBlockShape(state, context);
			return fluid != null ? fluid : shape.get(state, world, cell, context);
		}
	}
}
