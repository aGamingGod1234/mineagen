package dev.agaminggod.mineagen.server.perception;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.BlockGetter;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.material.Fluid;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

public final class BucketReach {
	private BucketReach() { }

	/** The nearest source of {@code fluid} within {@code reach} that an empty bucket reaches only through its flow, or null. */
	public static BlockPos nearest(BlockGetter level, CollisionContext context, Vec3 eye, double reach, Fluid fluid) {
		int r = (int) Math.ceil(reach);
		BlockPos center = BlockPos.containing(eye);
		BlockPos best = null;
		double bestDistance = Double.MAX_VALUE;
		for (BlockPos at : BlockPos.betweenClosed(center.offset(-r, -r, -r), center.offset(r, r, r))) {
			FluidState state = level.getFluidState(at);
			if (!state.isSource() || !state.getType().isSame(fluid)) continue;
			double distance = Vec3.atCenterOf(at).distanceToSqr(eye);
			if (distance < bestDistance && throughFlow(level, context, eye, reach, at)) { best = at.immutable(); bestDistance = distance; }
		}
		return best;
	}

	/** Whether an empty bucket aimed from {@code eye} meets the source at {@code source} within reach, past flowing fluid of its kind. */
	public static boolean throughFlow(BlockGetter level, CollisionContext context, Vec3 eye, double reach, BlockPos source) {
		FluidState fluid = level.getFluidState(source);
		if (!fluid.isSource() || Vec3.atCenterOf(source).distanceTo(eye) > reach + 0.9D) return false;
		for (Vec3 aim : aims(eye, source)) {
			Vec3 end = eye.add(aim.subtract(eye).normalize().scale(reach));
			BlockHitResult bucket = level.clip(new ClipContext(eye, end, ClipContext.Block.OUTLINE, ClipContext.Fluid.SOURCE_ONLY, context));
			if (bucket.getType() != HitResult.Type.BLOCK || !bucket.getBlockPos().equals(source)) continue;
			BlockHitResult sight = level.clip(new ClipContext(eye, end, ClipContext.Block.OUTLINE, ClipContext.Fluid.ANY, context));
			if (sight.getType() != HitResult.Type.BLOCK || sight.getBlockPos().equals(source)) continue;
			FluidState first = level.getFluidState(sight.getBlockPos());
			if (!first.isEmpty() && !first.isSource() && first.getType().isSame(fluid.getType())) return true;
		}
		return false;
	}

	/** The source's centre and the middle of each face toward the eye, below a source's surface (8/9 of the cell). */
	private static Vec3[] aims(Vec3 eye, BlockPos source) {
		Vec3 center = Vec3.atCenterOf(source);
		Vec3[] aims = new Vec3[7];
		int n = 0;
		aims[n++] = center;
		for (Direction face : Direction.values()) {
			Vec3 point = center.add(face.getStepX() * 0.45D, face.getStepY() * 0.3D, face.getStepZ() * 0.45D);
			if (point.subtract(center).dot(eye.subtract(center)) > 0.0D) aims[n++] = point;
		}
		return java.util.Arrays.copyOf(aims, n);
	}
}
