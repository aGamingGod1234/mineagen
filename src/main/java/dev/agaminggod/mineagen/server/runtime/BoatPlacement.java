package dev.agaminggod.mineagen.server.runtime;

import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Locale;
import net.minecraft.commands.arguments.EntityAnchorArgument;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.item.BoatItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * Putting a boat down the way a player does: vanilla refuses a boat whose 1.375-wide box would overlap a block or a body
 * (the player's own included), and the click then does nothing. A player sees that and turns to a clear patch of floor
 * in reach. This finds such a floor face near the spot asked for, puts the boat there, and says why the first was refused.
 */
final class BoatPlacement {
	private static final double HALF = 0.6875D;
	private static final double HEIGHT = 0.5625D;
	private static final int TRIES = 8;

	private BoatPlacement() {}

	static boolean is(ItemStack held) {
		return held != null && !held.isEmpty() && held.getItem() instanceof BoatItem;
	}

	/** Why a boat put down with its base centred here would be refused, or null when it fits. */
	static String problem(ServerPlayer player, Vec3 at) {
		if (at == null) return "the aim meets no block within reach";
		ServerLevel level = player.level();
		AABB box = new AABB(at.x - HALF, at.y, at.z - HALF, at.x + HALF, at.y + HEIGHT, at.z + HALF);
		if (!level.noCollision(box.deflate(1.0E-3D))) return "a block stands in its 1.4-wide footprint at " + format(at);
		List<Entity> bodies = level.getEntities((Entity) null, box, entity -> entity.isAlive() && !entity.isSpectator() && entity.isPushable());
		if (bodies.isEmpty()) return null;
		Entity body = bodies.contains(player) ? player : bodies.get(0);
		return (body == player ? "your own body" : "a " + BuiltInRegistries.ENTITY_TYPE.getKey(body.getType()).getPath()) + " stands in its footprint at " + format(at);
	}

	/** Where the player's look along this aim point meets a block face within reach, or null. */
	static Vec3 aimHit(ServerPlayer player, Vec3 aim) {
		Vec3 eye = player.getEyePosition();
		Vec3 toward = aim == null ? player.getViewVector(1.0F) : aim.subtract(eye).normalize();
		BlockHitResult hit = player.level().clip(new ClipContext(eye, eye.add(toward.scale(player.blockInteractionRange())),
				ClipContext.Block.OUTLINE, ClipContext.Fluid.ANY, player));
		return hit.getType() == HitResult.Type.BLOCK ? hit.getLocation() : null;
	}

	/**
	 * Puts the held boat on the clear floor face in reach nearest the preferred point: a sturdy top with open air above,
	 * not a block that takes clicks (a table, a chest), with no block or body in the boat's footprint and seen from the eye.
	 * Returns where it landed, or null when no face in reach fits.
	 */
	static String place(ServerPlayer player, InteractionHand hand, Vec3 preferred) {
		ServerLevel level = player.level();
		ItemStack held = player.getItemInHand(hand);
		if (!is(held)) return null;
		int before = held.getCount();
		Vec3 eye = player.getEyePosition();
		Vec3 target = preferred != null ? preferred : eye.add(player.getViewVector(1.0F).multiply(1.0D, 0.0D, 1.0D).normalize().scale(3.0D));
		BlockPos feet = player.blockPosition();
		List<Vec3> faces = new ArrayList<>();
		for (int dx = -4; dx <= 4; dx++) for (int dz = -4; dz <= 4; dz++) for (int dy = -3; dy <= 1; dy++) {
			BlockPos pos = feet.offset(dx, dy, dz);
			if (!level.hasChunkAt(pos) || !player.isWithinBlockInteractionRange(pos, 0.0D)) continue;
			BlockState state = level.getBlockState(pos);
			if (!state.isFaceSturdy(level, pos, Direction.UP) || level.getBlockEntity(pos) != null || state.getMenuProvider(level, pos) != null) continue;
			if (!level.getBlockState(pos.above()).getCollisionShape(level, pos.above()).isEmpty()) continue;
			Vec3 top = new Vec3(pos.getX() + 0.5D, pos.getY() + 1.0D, pos.getZ() + 0.5D);
			if (problem(player, top) != null) continue;
			BlockHitResult hit = level.clip(new ClipContext(eye, top.add(top.subtract(eye).normalize().scale(0.01D)),
					ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
			if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(pos) || hit.getDirection() != Direction.UP) continue;
			faces.add(top);
		}
		faces.sort(Comparator.comparingDouble(top -> top.distanceToSqr(target)));
		for (Vec3 top : faces.subList(0, Math.min(TRIES, faces.size()))) {
			player.lookAt(EntityAnchorArgument.Anchor.EYES, top);
			player.gameMode.useItem(player, level, held, hand);
			ItemStack now = player.getItemInHand(hand);
			if (now.isEmpty() || now.getCount() < before || !ItemStack.isSameItem(now, held)) return format(top);
		}
		return null;
	}

	private static String format(Vec3 at) {
		return String.format(Locale.ROOT, "%.1f %.1f %.1f", at.x, at.y, at.z);
	}
}
