package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import java.util.Comparator;
import java.util.Locale;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;

/** A phase of the authored combat action, never a separately scheduled action or reflex. */
final class CombatBailout implements ServerController {
	static final long MAX_RETREAT_MS = 5_000L;
	static final double SEPARATION = 12.0D;
	private final ServerController retreat;
	private final String trigger;
	private TickResult finished;

	CombatBailout(ServerController retreat, String trigger) {
		this.retreat = retreat;
		this.trigger = trigger;
	}

	static long budget(long remainingMs) {
		return Math.max(0L, Math.min(MAX_RETREAT_MS, remainingMs));
	}

	static CombatBailout start(ServerPlayer player, Entity target, float threshold, boolean mayMove,
			long remainingMs, long now) {
		String trigger = String.format(Locale.ROOT, "Health %.1f reached fleeAtHealth %.1f", player.getHealth(), threshold);
		if (!mayMove) return new CombatBailout(null, trigger + "; hold-ground choice forbids movement; no retreat attempted");
		if (budget(remainingMs) == 0L) return new CombatBailout(null, trigger + "; action deadline reached; no retreat attempted");
		if (target == null || !target.isAlive() || target.isRemoved() || target.level() != player.level()) {
			target = player.level().getEntitiesOfClass(LivingEntity.class,
					player.getBoundingBox().inflate(CombatPlanning.THREAT_RANGE),
					mob -> mob != player && ThreatPerception.isActiveThreat(player, mob) && ThreatPerception.isSensedThreat(player, mob))
					.stream().min(Comparator.comparingDouble((LivingEntity mob) -> player.distanceToSqr(mob))).orElse(null);
		}
		if (target == null) return new CombatBailout(null, trigger + "; no sensed threat to retreat from; escape unproven");
		return new CombatBailout(new ServerFleeController(target, SEPARATION, budget(remainingMs), now).retreatOnly(), trigger);
	}

	@Override
	public TickResult tick(ServerPlayer player, long now) {
		if (finished != null) return finished;
		if (retreat == null) return finished = TickResult.failed("LOW_HEALTH_BAILOUT", trigger, 0.0D);
		TickResult result = retreat.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(0.0D);
		retreat.cancel(player);
		return finished = receipt(trigger, result);
	}

	static TickResult receipt(String trigger, TickResult retreat) {
		// Escaping is not completing the requested kill/count. Preserve the bailout handoff code.
		if (retreat.reasonCode().equals("AGENT_DEAD")) return retreat;
		return TickResult.failed("LOW_HEALTH_BAILOUT", trigger + "; retreat attempted: " + retreat.reasonCode()
				+ "; " + retreat.message() + "; combat stopped; reassess before fighting again", 0.0D);
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (retreat != null) retreat.cancel(player);
	}
}
