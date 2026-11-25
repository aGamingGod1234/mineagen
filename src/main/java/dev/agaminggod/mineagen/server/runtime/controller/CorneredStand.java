package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputStates;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.item.Items;
import net.minecraft.world.phys.Vec3;

public final class CorneredStand {
	/** Bodies whose flee is standing its ground this moment (read by the reflex engine on the server thread). */
	private static final Set<UUID> STANDING = java.util.concurrent.ConcurrentHashMap.newKeySet();
	static final float LOW_HEALTH = 10.0F;
	static float lowFor(long near) {
		return Math.max(LOW_HEALTH, HEALTH_PER_THREAT * near);
	}

	static final float HEALTH_PER_THREAT = 4.0F;

	/** Two or more threats this near is outnumbered. */
	static final double NEAR = 8.0D;
	static final int OUTNUMBERED = 2;
	/**
	 * Walls go up only while no threat is this close: placing blocks with a zombie in the cell a wall needs, or hitting
	 * the body meanwhile, lost every such try in the cornered fixture (dead at 8 health, 3 zombies adjacent). A player
	 * walls in before they arrive and fights once they are there.
	 */
	static final double CONTACT = 2.5D;
	/**
	 * A target this near is fought where the body stands. The cornered fixture's 3-zombie tunnel: chasing with a
	 * back-step after each hit ended at 3 health; the defend stance's stand-and-swing at 12.
	 */
	static final double MELEE = 3.5D;
	/** No threat sensed for this long ends the stand. */
	static final long CLEAR_MS = 1_500L;
	/** A threat no fight could reach is not tried again for this long (it is faced behind the shield meanwhile). */
	static final long UNREACHABLE_MS = 5_000L;
	/** After a seal attempt fails (a mob stands where a wall goes), fight this long before trying again. */
	static final long SEAL_RETRY_MS = 3_000L;
	static final long FIGHT_MS = 20_000L;
	static final long SEAL_MS = 30_000L;
	private static final Set<String> UNREACHABLE = Set.of("TARGET_UNREACHABLE", "NO_SEEN_ROUTE", "APPROACH_BLOCKED", "TARGET_ESCAPED",
			"TARGET_NOT_VISIBLE");

	private final Entity named;
	private final ServerFightUntilController.Roofing roofing;
	private final float startHealth;
	private final CombatInputLease input = new CombatInputLease();
	private final Map<UUID, Long> unreachable = new HashMap<>();
	private final List<String> kills = new ArrayList<>();
	private ServerFightController fight;
	private String fighting;
	private ServerController seal;
	private long sealRetryAt;
	private String sealNote;
	private String sealWhy;
	private long clearSince = -1L;
	private int fights;
	private int guardTicks;

	CorneredStand(Entity named, ServerFightUntilController.Roofing roofing, ServerPlayer player, long now) {
		this.named = named;
		this.roofing = roofing;
		this.startHealth = player.getHealth();
		this.lastHealth = startHealth;
	}

	/**
	 * A stand taken at a dead end before contact holds its spot: a melee mob coming for the body is let walk into reach
	 * behind the shield instead of chased. Chasing walked the body out of a tunnel's end into a file of three zombies and
	 * cost 22.5 health a run against 13.8 for a stand at the end (cornered corridor room, 10 runs a side).
	 */
	CorneredStand holdGround() {
		hold = true;
		return this;
	}

	private boolean hold;
	/** When the hold began; a chaser that has not come into reach by {@link #HOLD_MS} (stuck across a gap) is gone after. */
	private long holdSinceMs = -1L;
	static final long HOLD_MS = 3_000L;

	public static boolean standing(ServerPlayer player) {
		return player != null && STANDING.contains(player.getUUID());
	}

	ServerController.TickResult tick(ServerPlayer player, long now) {
		STANDING.add(player.getUUID());
		if (!player.isAlive()) return end(player, ServerController.TickResult.failed("AGENT_DEAD", "died while standing ground" + facts(player), 0.0D));
		if (seal != null) {
			ServerController.TickResult built = seal.tick(player, now);
			if (built.state() == ServerController.State.RUNNING) return built;
			seal.cancel(player);
			seal = null;
			if (built.state() == ServerController.State.SUCCEEDED) {
				return end(player, ServerController.TickResult.succeeded("WALLED_IN", (sealWhy == null ? "" : sealWhy) + ", so walled in where it stood: "
						+ built.message() + facts(player)));
			}
			sealNote = built.reasonCode();
			sealRetryAt = now + SEAL_RETRY_MS;
		}
		List<LivingEntity> threats = threats(player);
		if (threats.isEmpty() && fight == null) {
			if (clearSince < 0L) clearSince = now;
			if (now - clearSince >= CLEAR_MS) {
				return end(player, ServerController.TickResult.succeeded("STOOD_GROUND", "stood ground and fought; no threat left" + facts(player)));
			}
		} else {
			clearSince = -1L;
		}
		long near = threats.stream().filter(mob -> player.distanceTo(mob) <= NEAR).count();
		boolean contact = threats.stream().anyMatch(mob -> player.distanceTo(mob) <= CONTACT);
		// Hit from beyond reach (an archer across a gap) twice within RANGED_WINDOW_MS, or while waiting for a threat it cannot
		// reach: walls stop arrows; standing or chasing there does not (cornered fixture, nook with a skeleton: 4 health lost
		// every 3 s with no shield until dead).
		float health = player.getHealth();
		LivingEntity attacker = player.getLastHurtByMob();
		if (health < lastHealth - 0.5F && attacker != null && player.distanceTo(attacker) > MELEE) rangedHits.addLast(now);
		lastHealth = health;
		while (!rangedHits.isEmpty() && now - rangedHits.peekFirst() > RANGED_WINDOW_MS) rangedHits.removeFirst();
		boolean shotWhileWaiting = (guarding && player.hurtTime > 0) || rangedHits.size() >= 2;
		boolean outnumberedLow = near >= OUTNUMBERED && player.getHealth() <= lowFor(threats.size());
		if (roofing != null && (outnumberedLow || shotWhileWaiting) && !contact && now >= sealRetryAt) {
			String item = roofing.blockItem(player);
			if (item != null) {
				if (fight != null) fight.cancel(player);
				fight = null;
				input.release();
				BlockPos feet = BlockPos.containing(player.getX(), player.getY() + 0.2D, player.getZ());
				// The plan builds the side opposite its opening first: open away from the threat so its side goes up first.
				Entity facing = !threats.isEmpty() ? threats.get(0) : attacker;
				Direction opening = facing != null ? toward(player, facing).getOpposite() : player.getDirection().getOpposite();
				seal = roofing.seal(sealCell(player, feet, facing, opening), opening, item, SEAL_MS, now);
				sealWhy = outnumberedLow ? "outnumbered at low health" : "shot while no threat was in reach";
				return ServerController.TickResult.running(0.5D);
			}
		}
		if (fight != null) {
			ServerController.TickResult result = fight.tick(player, now);
			if (result.state() == ServerController.State.RUNNING) return result;
			fight.cancel(player);
			fight = null;
			if ("TARGET_KILLED".equals(result.reasonCode())) kills.add(fighting);
			else if (UNREACHABLE.contains(result.reasonCode()) && fightingId != null) unreachable.put(fightingId, now + UNREACHABLE_MS);
		}
		unreachable.values().removeIf(until -> until <= now);
		LivingEntity target = null;
		for (LivingEntity mob : threats) {
			if (mob instanceof Creeper || unreachable.containsKey(mob.getUUID())) continue;
			target = mob;
			break;
		}
		// Another mob already in reach is fought first: holding for the named one would let it hit freely.
		for (LivingEntity mob : threats) {
			if (mob == target || mob instanceof Creeper || unreachable.containsKey(mob.getUUID()) || player.distanceTo(mob) > MELEE) continue;
			target = mob;
			break;
		}
		if (target != null && hold && holdSinceMs < 0L) holdSinceMs = now;
		if (target != null && hold && now - holdSinceMs < HOLD_MS && player.distanceTo(target) > MELEE
				&& target instanceof net.minecraft.world.entity.Mob mob && mob.getTarget() == player && !ThreatPerception.isRanged(mob)) {
			guard(player, target);
			guarding = true;
			return ServerController.TickResult.running(0.5D);
		}
		if (target != null) {
			input.release();
			boolean shield = player.getOffhandItem().is(Items.SHIELD);
			boolean chase = player.distanceTo(target) > MELEE;
			fight = new ServerFightController(target, null, null, true, CombatPlanning.TargetPolicy.NAMED, false, chase, false, shield,
					FIGHT_MS, now);
			guarding = false;
			fighting = typeOf(target);
			fightingId = target.getUUID();
			fights++;
			return fight.tick(player, now);
		}
		guard(player, threats.isEmpty() ? null : threats.get(0));
		guarding = true;
		return ServerController.TickResult.running(0.5D);
	}

	private UUID fightingId;
	/** Two hits from beyond {@link #MELEE} within this window: losing to a ranged attacker. */
	static final long RANGED_WINDOW_MS = 10_000L;
	private final java.util.ArrayDeque<Long> rangedHits = new java.util.ArrayDeque<>();
	private float lastHealth = Float.NaN;
	private boolean guarding;

	private void guard(ServerPlayer player, LivingEntity nearest) {
		int weapon = HotbarWeapons.bestSlotOrNone(player);
		int slot = weapon >= 0 ? weapon : player.getInventory().getSelectedSlot();
		boolean shield = player.getOffhandItem().is(Items.SHIELD) && nearest != null;
		float yaw = player.getYRot(), pitch = player.getXRot();
		if (nearest != null) {
			Vec3 delta = nearest.getBoundingBox().getCenter().subtract(player.getEyePosition());
			double horizontal = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
			yaw = AgentInputStates.turnYaw(yaw, (float) Math.toDegrees(Math.atan2(-delta.x, delta.z)));
			pitch = AgentInputStates.turnPitch(pitch, (float) -Math.toDegrees(Math.atan2(delta.y, horizontal)));
		}
		if (shield) guardTicks++;
		input.apply(player, new AgentInputState(0.0F, 0.0F, false, false, false, false, shield, yaw, pitch, slot,
				shield ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND));
	}

	/** Living threats within 16 blocks the body senses (the named one first while alive), nearest first after it. */
	private List<LivingEntity> threats(ServerPlayer player) {
		List<LivingEntity> found = new ArrayList<>(player.level().getEntitiesOfClass(LivingEntity.class,
				player.getBoundingBox().inflate(CombatPlanning.THREAT_RANGE),
				mob -> mob != player && ThreatPerception.isActiveThreat(player, mob) && ThreatPerception.isSensedThreat(player, mob)));
		found.sort((a, b) -> Double.compare(player.distanceTo(a), player.distanceTo(b)));
		if (named instanceof LivingEntity living && found.remove(living)) found.addFirst(living);
		return found;
	}

	/**
	 * Where to wall in: the feet cell, or with the nearest threat within {@link #CLOSE_STEP} blocks the cell one step away
	 * from it when the body has seen it open with solid floor, so the wall facing the threat goes up before the mob
	 * stands in it (cornered crowd fixture: the flee's backtrack carried the body a step toward 3 zombies, the front
	 * wall cell was taken, and 2 of 9 runs fought and died). The shelter walks the body there first.
	 */
	static BlockPos sealCell(ServerPlayer player, BlockPos feet, Entity nearest, Direction opening) {
		if (nearest == null || player.distanceTo(nearest) > CLOSE_STEP) return feet;
		BlockPos back = feet.relative(opening);
		var seen = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player);
		net.minecraft.world.level.block.state.BlockState foot = seen.known(back.getX(), back.getY(), back.getZ());
		net.minecraft.world.level.block.state.BlockState head = seen.known(back.getX(), back.getY() + 1, back.getZ());
		net.minecraft.world.level.block.state.BlockState floor = seen.known(back.getX(), back.getY() - 1, back.getZ());
		boolean open = foot != null && head != null && foot.canBeReplaced() && head.canBeReplaced() && foot.getFluidState().isEmpty()
				&& head.getFluidState().isEmpty();
		boolean solid = floor != null && floor.isCollisionShapeFullBlock(player.level(), back.below());
		return open && solid ? back : feet;
	}

	static final double CLOSE_STEP = 3.0D;

	private static Direction toward(ServerPlayer player, Entity mob) {
		return Direction.getApproximateNearest(mob.getX() - player.getX(), 0.0D, mob.getZ() - player.getZ());
	}

	String facts(ServerPlayer player) {
		return String.format(Locale.ROOT, "; %d fight(s), %d kill(s)%s; health %.1f -> %.1f%s%s",
				fights, kills.size(), kills.isEmpty() ? "" : " (" + String.join(", ", kills) + ")", startHealth, player.getHealth(),
				guardTicks > 0 ? String.format(Locale.ROOT, "; shield up %.1f s while waiting", guardTicks / 20.0D) : "",
				sealNote == null ? "" : "; walling in failed once: " + sealNote);
	}

	ServerController.TickResult end(ServerPlayer player, ServerController.TickResult result) {
		cancel(player);
		return result;
	}

	void cancel(ServerPlayer player) {
		STANDING.remove(player.getUUID());
		if (fight != null) fight.cancel(player);
		fight = null;
		if (seal != null) seal.cancel(player);
		seal = null;
		input.release();
	}

	private static String typeOf(Entity entity) {
		return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
	}
}
