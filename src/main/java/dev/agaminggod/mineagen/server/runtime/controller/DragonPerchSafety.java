package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.AreaEffectCloud;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.boss.enderdragon.EnderDragon;
import net.minecraft.world.entity.boss.enderdragon.EnderDragonPart;
import net.minecraft.world.entity.boss.enderdragon.phases.EnderDragonPhase;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * Where a player stands to hit a perched dragon's head. Perched, the head and neck hurt 10 on contact with their boxes
 * grown by 1 and the wings throw anyone in their boxes grown by 4 across and 2 up and down (shifted down 2); all of these
 * start about 2 blocks above the fountain's ground, so a body on the ground under the head is clear of them, and one that
 * jumps or stands a block higher is not (the perch watch: two 10-damage neck hits from a cell one block up, a wing throw
 * into a pit after a jump). Its breath is a cloud of radius 5 on the ground 2.5 blocks beyond the head, placed half a second
 * into each breath and harmless for its first second. A spot in reach of the head is safe when the standing body (a small
 * step's height over it, never a jump) meets none of the contact boxes and no breath: the live clouds, and while a breath
 * has begun with no cloud down yet, the one it will place.
 */
public final class DragonPerchSafety {
	/** A step-up or a bob over the standing body's 1.8; jumps are off near a perched dragon. */
	static final double STEP_MARGIN = 0.4D;
	/** Past the cloud's radius (vanilla measures the body's centre against it). */
	static final double CLOUD_MARGIN = 0.5D;
	static final double BREATH_AHEAD = 2.5D, BREATH_RADIUS = 5.0D;
	/** Across the head and neck boxes: the head bobs and turns between samples (the watch: a hit at 1.9 across, 0.1 past the box). */
	static final double SIDE_MARGIN = 0.3D;
	/** Steps along the turn a scanning dragon makes to face you, which its head and neck sweep through. */
	static final int SWEEP_STEPS = 4;
	/** A jump rises about 1.25 blocks. */
	static final double JUMP_RISE = 1.25D;

	public record Circle(double x, double y, double z, double radius) { }

	public record Zones(List<AABB> contacts, List<Circle> breath) {
		public boolean unsafe(double x, double feetY, double z) { return unsafe(x, feetY, z, 0.0D); }

		/** {@code slack}: how far the body may stand off that point (anywhere in a cell is half a block). */
		public boolean unsafe(double x, double feetY, double z, double slack) {
			double half = 0.3D + slack;
			AABB body = new AABB(x - half, feetY, z - half, x + half, feetY + 1.8D + STEP_MARGIN, z + half);
			for (AABB box : contacts) if (box.intersects(body)) return true;
			for (Circle c : breath) {
				// The cloud's box is half a block tall from its y; a body overlaps it from 1.8 below to 0.5 above.
				if (feetY >= c.y() + 0.5D || feetY + 1.8D <= c.y()) continue;
				if (Math.hypot(x - c.x(), z - c.z()) <= c.radius() + CLOUD_MARGIN + slack) return true;
			}
			return false;
		}

		/**
		 * Anywhere in the cell, not only its centre: a body in a cell stands up to half a block off it as it walks in and
		 * swings (the perch probe: every head hit was a body 0.4 off a cell's centre toward the head, one block up).
		 */
		public boolean unsafeCell(GridPosition cell) { return unsafe(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D, 0.5D); }
	}

	private DragonPerchSafety() { }

	/** The dragon of a struck part while it sits on the fountain, else null. */
	static EnderDragon perched(Entity strike) {
		if (!(strike instanceof EnderDragonPart part)) return null;
		EnderDragon dragon = part.parentMob;
		return dragon.isAlive() && dragon.getPhaseManager().getCurrentPhase().isSitting() ? dragon : null;
	}

	/** The head, neck and wing boxes alone (a run already out of the breath checks the cloud itself). */
	public static Zones contacts(ServerPlayer player, EnderDragon dragon) {
		return new Zones(zones(player, dragon).contacts(), List.of());
	}

	static Zones zones(ServerPlayer player, EnderDragon dragon) {
		List<AABB> contacts = new ArrayList<>(4);
		EnderDragonPart head = null;
		for (EnderDragonPart part : dragon.getSubEntities()) {
			if ("head".equals(part.name)) { head = part; contacts.add(part.getBoundingBox().inflate(1.0D + SIDE_MARGIN, 1.0D, 1.0D + SIDE_MARGIN)); }
			else if ("neck".equals(part.name)) contacts.add(part.getBoundingBox().inflate(1.0D + SIDE_MARGIN, 1.0D, 1.0D + SIDE_MARGIN));
			else if ("wing".equals(part.name)) contacts.add(part.getBoundingBox().inflate(4.0D, 2.0D, 4.0D).move(0.0D, -2.0D, 0.0D));
		}
		// Scanning, it turns to face you (DragonSittingScanningPhase) and its head and neck swing round with it: the whole arc
		// from where the head is now to where it will point is contact (the watch: a body beside the head hit as it turned).
		if (head != null && dragon.getPhaseManager().getCurrentPhase().getPhase() == EnderDragonPhase.SITTING_SCANNING) sweep(contacts, player, dragon, head);
		List<Circle> breath = new ArrayList<>(2);
		AABB near = player.getBoundingBox().inflate(32.0D);
		boolean live = false;
		for (AreaEffectCloud cloud : player.level().getEntitiesOfClass(AreaEffectCloud.class, near, AreaEffectCloud::isAlive)) {
			if (cloud.getParticle().getType() != ParticleTypes.DRAGON_BREATH) continue;
			breath.add(new Circle(cloud.getX(), cloud.getY(), cloud.getZ(), cloud.getRadius()));
			if (head != null && Math.hypot(cloud.getX() - head.getX(), cloud.getZ() - head.getZ()) < BREATH_AHEAD + 2.0D) live = true;
		}
		// A breath begun with no cloud down yet: the one it places, as vanilla places it (DragonSittingFlamingPhase).
		if (!live && head != null && dragon.getPhaseManager().getCurrentPhase().getPhase() == EnderDragonPhase.SITTING_FLAMING) {
			Circle next = predictedBreath(player, dragon, head);
			if (next != null) breath.add(next);
		}
		return new Zones(contacts, breath);
	}

	/** Head and neck boxes (grown as vanilla checks them) along the turn from the head's bearing to the player's. */
	static void sweep(List<AABB> contacts, ServerPlayer player, EnderDragon dragon, EnderDragonPart head) {
		double from = Math.atan2(head.getX() - dragon.getX(), -(head.getZ() - dragon.getZ()));
		double to = Math.atan2(player.getX() - dragon.getX(), -(player.getZ() - dragon.getZ()));
		double turn = Math.atan2(Math.sin(to - from), Math.cos(to - from));
		double y = head.getY();
		for (int i = 1; i <= SWEEP_STEPS; i++) {
			double a = from + turn * i / SWEEP_STEPS, sx = Math.sin(a), sz = -Math.cos(a);
			double hx = dragon.getX() + sx * 6.5D, hz = dragon.getZ() + sz * 6.5D;
			contacts.add(new AABB(hx - 0.5D, y, hz - 0.5D, hx + 0.5D, y + 1.0D, hz + 0.5D).inflate(1.0D + SIDE_MARGIN, 1.0D, 1.0D + SIDE_MARGIN));
			double nx = dragon.getX() + sx * 5.5D, nz = dragon.getZ() + sz * 5.5D;
			contacts.add(new AABB(nx - 1.5D, y, nz - 1.5D, nx + 1.5D, y + 3.0D, nz + 1.5D).inflate(1.0D + SIDE_MARGIN, 1.0D, 1.0D + SIDE_MARGIN));
		}
	}

	static Circle predictedBreath(ServerPlayer player, EnderDragon dragon, EnderDragonPart head) {
		Vec3 look = new Vec3(head.getX() - dragon.getX(), 0.0D, head.getZ() - dragon.getZ());
		if (look.lengthSqr() < 1.0E-6D) return null;
		look = look.normalize();
		double x = head.getX() + look.x * BREATH_AHEAD, z = head.getZ() + look.z * BREATH_AHEAD;
		double y = head.getY(0.5D);
		BlockPos.MutableBlockPos pos = new BlockPos.MutableBlockPos(x, y, z);
		int steps = 0;
		while (player.level().isEmptyBlock(pos) && steps++ < 64) { y -= 1.0D; pos.set(x, y, z); }
		// No floor found (over the void): vanilla places the cloud at the head's height.
		if (player.level().isEmptyBlock(pos)) return new Circle(x, head.getY(0.5D), z, BREATH_RADIUS);
		return new Circle(x, Math.floor(y) + 1.0D, z, BREATH_RADIUS);
	}
}
