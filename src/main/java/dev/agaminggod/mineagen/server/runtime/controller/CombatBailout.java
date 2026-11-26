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
	/** The receipt's reason code: LOW_HEALTH_BAILOUT, or DRAGON_TOOK_OFF for a dragon that lifted off its perch. */
	private final String code;
	private TickResult finished;

	CombatBailout(ServerController retreat, String trigger) {
		this(retreat, trigger, "LOW_HEALTH_BAILOUT");
	}

	private CombatBailout(ServerController retreat, String trigger, String code) {
		this.retreat = retreat;
		this.trigger = trigger;
		this.code = code;
	}

	/**
	 * The perched Ender Dragon whose part was the target has stopped perching: it lifts off over the portal, where its wings
	 * throw and its head and neck hurt anything near. A player stops swinging and steps clear. Dragon room A/B: 10 of 12
	 * deaths with the crystals fix came during or right after a perch melee, the large hits while the dragon was already
	 * airborne over the body.
	 */
	static CombatBailout dragonTakeoff(ServerPlayer player, Entity dragon, boolean mayMove, long remainingMs, long now) {
		String trigger = "The dragon stopped perching and is lifting off (its wings throw and its head hurts anything near)";
		if (!mayMove) return new CombatBailout(null, trigger + "; hold-ground choice forbids movement; no retreat attempted", "DRAGON_TOOK_OFF");
		if (budget(remainingMs) == 0L) return new CombatBailout(null, trigger + "; action deadline reached; no retreat attempted", "DRAGON_TOOK_OFF");
		return new CombatBailout(new ServerFleeController(dragon, SEPARATION, budget(remainingMs), now).retreatOnly(), trigger, "DRAGON_TOOK_OFF");
	}

	/**
	 * The model's own hold-ground fight_target (pursue:false) that bails out at low health still backs away on open ground outside the End. Fresh
	 * games: a bot that stopped at low health with no retreat stood still in reach until the next model turn. The retreat
	 * steers around lava and deep drops, so a pillar top or roof stays put only where every heading is unsafe; the End keeps
	 * the old stand-still (pillars over the void).
	 */
	static boolean holdRetreat = dev.agaminggod.mineagen.server.Switches.get("fight.holdBailRetreat");

	static boolean retreatsFromHold(boolean enabled, boolean onGround, boolean inEnd) {
		return enabled && onGround && !inEnd;
	}

	static long budget(long remainingMs) {
		return Math.max(0L, Math.min(MAX_RETREAT_MS, remainingMs));
	}

	static CombatBailout start(ServerPlayer player, Entity target, float threshold, boolean mayMove,
			long remainingMs, long now) {
		return start(player, target, threshold, mayMove, false, remainingMs, now);
	}

	/** {@code holdMayRetreat}: a model's own fight_target pursue:false, never a roofed or perched stand inside another action. */
	static CombatBailout start(ServerPlayer player, Entity target, float threshold, boolean mayMove, boolean holdMayRetreat,
			long remainingMs, long now) {
		String trigger = String.format(Locale.ROOT, "Health %.1f reached fleeAtHealth %.1f", player.getHealth(), threshold);
		if (!mayMove && !(holdMayRetreat && holdRetreat && retreatsFromHold(true, player.onGround(),
				player.level().dimension() == net.minecraft.world.level.Level.END))) {
			return new CombatBailout(null, trigger + "; hold-ground choice forbids movement; no retreat attempted");
		}
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
		if (retreat == null) return finished = TickResult.failed(code, trigger, 0.0D);
		TickResult result = retreat.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(0.0D);
		retreat.cancel(player);
		return finished = receipt(code, trigger, result);
	}

	static TickResult receipt(String trigger, TickResult retreat) {
		return receipt("LOW_HEALTH_BAILOUT", trigger, retreat);
	}

	static TickResult receipt(String code, String trigger, TickResult retreat) {
		// Escaping is not completing the requested kill/count. Preserve the bailout handoff code.
		if (retreat.reasonCode().equals("AGENT_DEAD")) return retreat;
		return TickResult.failed(code, trigger + "; retreat attempted: " + retreat.reasonCode()
				+ "; " + retreat.message() + "; combat stopped; reassess before fighting again", 0.0D);
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (retreat != null) retreat.cancel(player);
	}
}
