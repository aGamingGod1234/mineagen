package dev.agaminggod.mineagen.server.runtime.reflex;

import dev.agaminggod.mineagen.protocol.ActionType;
import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import java.util.ArrayList;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.item.Items;

/**
 * A player who has just lost the shield (or is low) under fire from a shooter does not walk back out on an errand
 * while the shots are still coming. In the fortress records 5 of 8 Nether deaths came seconds after the model's next
 * walk took the body out of cover or a wall-in, into a blaze's fireballs and then lava or a fall.
 *
 * <p>While the danger lasts, a cover or defend firing keeps the body against the model's walking commands, and between
 * firings a hidden body waits in its cover. The danger ends when no shooter that is after the body can see it and no
 * shot has hit it for {@link #QUIET_TICKS}. A hold never lasts past {@link #MAX_TICKS}: by a spawner the danger never
 * ends, and the spawner's own back-out (a fight action, never held here) or the model's command takes over.
 */
final class ShelterHold {
	/** Quiet this long (no hit from a shooter, none after the body in sight) ends the danger: a few seconds. */
	static final int QUIET_TICKS = 60;
	/** The longest one hold keeps the body (20 s), so a hold by a spawner hands over instead of trapping the body. */
	static final int MAX_TICKS = 400;
	/** Blazes shoot from up to 48 blocks; the fortress deaths were hit from 19 to 38. */
	static final double SHOOTER_RANGE = 40.0D;
	/** At or above this health with a shield in hand the body may walk on under fire, as before. */
	static final float WEAK_HEALTH = 14.0F;
	/** The model's commands that only walk the body somewhere; anything else (a fight, escape, shelter build) is not held. */
	static final Set<ActionType> HELD_WALKS = Set.copyOf(EnumSet.of(ActionType.TRAVEL_TO, ActionType.NAVIGATE_TO, ActionType.MOVE_TO,
			ActionType.PICK_UP_ITEM));

	private long since = -1L;
	/** Set once a hold reached its cap; cleared when the danger ends, so the same fire does not hold the body again. */
	private boolean spent;

	/** One tick: whether the hold is on now. */
	boolean tick(boolean danger, boolean weak, long tick) {
		if (!danger) {
			since = -1L;
			spent = false;
			return false;
		}
		if (!weak || spent) return false;
		if (since < 0L) since = tick;
		if (tick - since >= MAX_TICKS) {
			spent = true;
			since = -1L;
			return false;
		}
		return true;
	}

	/** Shot at lately, or a shooter after the body can see it. */
	static boolean danger(ServerPlayer player) {
		LivingEntity hitter = player.getLastHurtByMob();
		if (hitter instanceof Mob mob && hitter.isAlive() && ThreatPerception.isRanged(mob)
				&& player.tickCount - player.getLastHurtByMobTimestamp() <= QUIET_TICKS) return true;
		return shooterSees(player);
	}

	/** A ranged hostile within {@link #SHOOTER_RANGE} that is after the body and has it in sight. */
	static boolean shooterSees(ServerPlayer player) {
		return !shooters(player).isEmpty();
	}

	/** The ranged hostiles within {@link #SHOOTER_RANGE} after the body with it in sight, nearest first. */
	static List<Mob> shooters(ServerPlayer player) {
		List<Mob> mobs = new ArrayList<>(player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(SHOOTER_RANGE),
				mob -> mob.isAlive() && ThreatPerception.isRanged(mob) && ThreatPerception.isHostileTo(mob, player)
						&& mob.getTarget() == player && player.distanceTo(mob) <= SHOOTER_RANGE && mob.hasLineOfSight(player)));
		mobs.sort(java.util.Comparator.comparingDouble(player::distanceTo));
		return mobs;
	}

	/** No shield in either hand, or low. */
	static boolean weak(ServerPlayer player) {
		return !player.getOffhandItem().is(Items.SHIELD) && !player.getMainHandItem().is(Items.SHIELD) || player.getHealth() < WEAK_HEALTH;
	}

	/** A firing that shelters the body: taking cover, or defend (which walls in from shooters). */
	static boolean shelters(ReflexActions.Behaviour behaviour) {
		return behaviour instanceof ReflexActions.TakeCover || behaviour instanceof ReflexActions.Defend;
	}

	static boolean heldWalk(ActionType type) {
		return type != null && HELD_WALKS.contains(type);
	}
}
