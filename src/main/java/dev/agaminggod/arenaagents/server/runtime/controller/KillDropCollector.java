package dev.agaminggod.arenaagents.server.runtime.controller;

import dev.agaminggod.arenaagents.server.perception.ObservationVisibility;
import dev.agaminggod.arenaagents.server.perception.ObservedDrops;
import dev.agaminggod.arenaagents.server.perception.PickupReceipts;
import dev.agaminggod.arenaagents.server.runtime.InventoryRoom;
import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Collection;
import java.util.List;
import java.util.UUID;
import java.util.function.BiPredicate;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.item.ItemEntity;

/**
 * The optional {@code collect:true} after a kill: walks to each drop the player saw fall, one at a time, by the same
 * route pick_up_item takes (navigation over seen, hazard-free footing; a blaze rod is followed on the shooter's deck),
 * and reports what came into the inventory or why a drop was left: it burns in lava or fire below, the inventory has
 * no room, the route failed, or the collect time ran out.
 */
public final class KillDropCollector {
	public static final long COLLECT_BUDGET_MS = 15_000L;
	private final ArrayDeque<UUID> pending;
	private final BiPredicate<ServerPlayer, Entity> mayTake;
	private final List<String> notes = new ArrayList<>();
	private final long deadline;
	private ServerItemPickupController current;
	private String currentLabel;
	private UUID currentId;
	private BiPredicate<ServerPlayer, net.minecraft.core.BlockPos> mayModify;
	private float healthFloor;
	private ServerTravelController route;
	private long routeTick;
	private final java.util.Set<UUID> built = new java.util.HashSet<>();
	/** The model's sneak:true: every walk to a drop is crouched (see ServerNavigationController#crouched). */
	private boolean crouched;

	public KillDropCollector(Collection<UUID> drops, BiPredicate<ServerPlayer, Entity> mayTake, long nowEpochMs) {
		this.pending = new ArrayDeque<>(drops);
		this.mayTake = mayTake;
		this.deadline = nowEpochMs + COLLECT_BUDGET_MS;
	}

	public KillDropCollector crouched(boolean crouched) {
		this.crouched = crouched;
		return this;
	}

	/** A model-chosen moving count skill can open a known route; ordinary single pickups keep their own contract. */
	public KillDropCollector buildingRoutes(BiPredicate<ServerPlayer, net.minecraft.core.BlockPos> mayModify, float healthFloor) {
		this.mayModify = mayModify;
		this.healthFloor = healthFloor;
		return this;
	}

	/** Null while walking to a drop; the summary once every drop was taken or left. */
	public String tick(ServerPlayer player, long nowEpochMs) {
		while (true) {
			if (route != null) {
				long tick = player.level().getGameTime();
				if (tick - routeTick > 1L) route.resumed(player);
				routeTick = tick;
				ServerController.TickResult result = route.tick(player, nowEpochMs);
				if (result.state() == ServerController.State.RUNNING) return null;
				route.cancel(player);
				route = null;
				notes.add("built pickup route: " + result.reasonCode());
				if (result.state() == ServerController.State.SUCCEEDED) pending.addFirst(currentId);
			}
			if (current != null) {
				ServerController.TickResult result = current.tick(player, nowEpochMs);
				if (result.state() == ServerController.State.RUNNING) return null;
				current.cancel(player);
				var lastSeen = ObservedDrops.recall(player, currentId);
				if (mayModify != null && lastSeen != null && LedgeFetch.NO_WAY.contains(result.reasonCode())
						&& deadline - nowEpochMs > 1000L && built.add(currentId)) {
					var at = lastSeen.position();
					route = new ServerTravelController(at.x, at.y, at.z, 1.0D, deadline - nowEpochMs,
							true, null, healthFloor, mayModify, nowEpochMs).routeLeg();
					routeTick = player.level().getGameTime();
					current = null;
					continue;
				}
				notes.add(result.state() == ServerController.State.SUCCEEDED ? "picked up " + currentLabel
						: "left " + currentLabel + ": " + result.reasonCode() + " (" + result.message() + ")");
				current = null;
			}
			UUID id = pending.poll();
			if (id == null) return notes.isEmpty() ? "no drop was seen to collect" : String.join("; ", notes);
			Entity entity = ((net.minecraft.server.level.ServerLevel) player.level()).getEntity(id);
			if (!(entity instanceof ItemEntity item) || !item.isAlive() || item.getItem().isEmpty()) {
				notes.add(PickupReceipts.collected(player, id) > 0 ? "picked up " + ObservedDrops.describe(player, id) + " on the way"
						: "left " + ObservedDrops.describe(player, id) + ": it is gone (burnt, despawned or taken)");
				continue;
			}
			String label = item.getItem().getCount() + "x " + BuiltInRegistries.ITEM.getKey(item.getItem().getItem()) + " uuid=" + id;
			if (ObservationVisibility.canSeeEntity(player, item)) ObservedDrops.remember(player, item);
			if (item.getItem().is(net.minecraft.world.item.Items.BLAZE_ROD) && item.onGround() && item.getY() > player.getY() + 0.6D) {
				// The rod pickup keeps to the body's floor: one resting on a ledge above is left to a ledge trip.
				notes.add("left " + label + ": on a ledge above the feet");
				continue;
			}
			String below = ServerFightController.burnsBelow(player, item.position());
			if (below.contains("burns")) { notes.add("left " + label + ":" + below); continue; }
			if (mayTake != null && !mayTake.test(player, item)) { notes.add("left " + label + ": PROTECTION_DENIED"); continue; }
			if (!InventoryRoom.canTake(player, item.getItem())) { notes.add("left " + label + ": INVENTORY_FULL"); continue; }
			long left = deadline - nowEpochMs;
			if (left <= 0L) { notes.add("left " + label + ": the " + COLLECT_BUDGET_MS / 1000 + " s collect time ran out"); continue; }
			current = new ServerItemPickupController(player, item, nowEpochMs, left).crouched(crouched);
			currentLabel = label;
			currentId = id;
		}
	}

	/** collect:false (ExamplePlayer, Oct 29): the body does not leave to collect while a hostile is within this many blocks. */
	public static final double CLEAR_RANGE = 16.0D;

	/**
	 * The nearest hostile within {@link #CLEAR_RANGE} with a clear line to the body or that hurt it in the last 3 s (a blaze
	 * behind a wall still firing), as "minecraft:blaze 7.2 blocks away"; null when the area is clear to walk out for drops.
	 */
	public static String hostileNear(ServerPlayer player) {
		net.minecraft.world.entity.LivingEntity hurtBy = player.getLastHurtByMob();
		boolean recent = hurtBy != null && hurtBy.isAlive() && player.tickCount - player.getLastHurtByMobTimestamp() <= 60;
		net.minecraft.world.entity.Mob nearest = null;
		double best = Double.POSITIVE_INFINITY;
		for (net.minecraft.world.entity.Mob mob : player.level().getEntitiesOfClass(net.minecraft.world.entity.Mob.class,
				player.getBoundingBox().inflate(CLEAR_RANGE), mob -> mob.isAlive()
						&& dev.agaminggod.arenaagents.server.perception.ThreatPerception.isHostileTo(mob, player))) {
			double distance = player.distanceTo(mob);
			if (distance > CLEAR_RANGE || distance >= best) continue;
			// A clear line, not only the view cone: a player knows the blaze it just turned from is there (and hears it).
			if (!(recent && mob == hurtBy) && !player.hasLineOfSight(mob)) continue;
			best = distance;
			nearest = mob;
		}
		return nearest == null ? null : String.format(java.util.Locale.ROOT, "%s %.1f blocks away", BuiltInRegistries.ENTITY_TYPE.getKey(nearest.getType()), best);
	}

	public boolean walking() {
		return current != null || route != null;
	}

	public void cancel(ServerPlayer player) {
		if (route != null) route.cancel(player);
		route = null;
		if (current != null) current.cancel(player);
		current = null;
	}
}
