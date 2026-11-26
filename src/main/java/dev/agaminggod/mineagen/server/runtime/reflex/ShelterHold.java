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

/**
 * A safety reflex keeps the body against the model's walk that would undo it. In the fortress records 5 of 8 Nether
 * deaths came seconds after the model's next walk took the body out of cover or a wall-in, into a blaze's fireballs and
 * then lava or a fall; a fresh game died when the walk after a lava escape went straight back in.
 *
 * <p>While a safety firing runs (cover, a fire or lava leave, a retreat, defend moving the body) the model's plain walks
 * wait under it instead of taking the body, and after it the walk waits until the danger has passed for
 * {@link #QUIET_TICKS}: no shooter after the body in sight, no shot hit, out of fire and lava. A hidden body waits still
 * in its cover meanwhile. One hold never lasts past {@link #MAX_TICKS}: by a spawner the danger never ends, and the
 * spawner's own back-out (a fight action, never held here) or the model's command takes over.
 */
final class ShelterHold {
	/** Quiet this long (no hit from a shooter, none after the body in sight) ends the danger: a few seconds. */
	static final int QUIET_TICKS = 60;
	/** The longest one hold keeps the body (20 s), so a hold by a spawner hands over instead of trapping the body. */
	static final int MAX_TICKS = 400;
	/** Blazes shoot from up to 48 blocks; the fortress deaths were hit from 19 to 38. */
	static final double SHOOTER_RANGE = 40.0D;
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

	/** The hold's signal: a safety firing now, or one within the cap and the danger not yet quiet since it. */
	static boolean on(boolean safetyNow, long lastSafetyTick, long lastHazardTick, long tick) {
		if (safetyNow) return true;
		if (lastSafetyTick < 0L || tick - lastSafetyTick >= MAX_TICKS) return false;
		return tick - Math.max(lastSafetyTick, lastHazardTick) < QUIET_TICKS;
	}

	/** A safety firing: taking cover, leaving fire or lava, a retreat, or defend backing out, walling in or taking cover. */
	static boolean shelters(ReflexActions.Behaviour behaviour) {
		return behaviour instanceof ReflexActions.TakeCover || behaviour instanceof ReflexActions.LeaveFire
				|| behaviour instanceof ReflexActions.SprintAway || behaviour instanceof ReflexActions.Defend defend && defend.movingBody();
	}

	/** A run a model command waits for under reflex.holdRun: a safety firing, or defend whether it moves the body or hits back. */
	static boolean holdsRun(ReflexActions.Behaviour behaviour) {
		return shelters(behaviour) || behaviour instanceof ReflexActions.Defend;
	}

	static boolean heldWalk(ActionType type) {
		return type != null && HELD_WALKS.contains(type);
	}
}
