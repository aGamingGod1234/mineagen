package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.server.perception.ObservationVisibility;
import dev.agaminggod.mineagen.server.perception.ObservedDrops;
import dev.agaminggod.mineagen.server.perception.PickupReceipts;
import dev.agaminggod.mineagen.server.runtime.InventoryRoom;
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
import net.minecraft.world.phys.Vec3;

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
	private final long budgetMs;
	private ServerItemPickupController current;
	private String currentLabel;
	private UUID currentId;
	private BiPredicate<ServerPlayer, net.minecraft.core.BlockPos> mayModify;
	private float healthFloor;
	private ServerTravelController route;
	private long routeTick;
	private final java.util.Set<UUID> built = new java.util.HashSet<>();
	private boolean crouched;
	/** Set by {@link #makingRoom}: who may Q-drop junk to make room for a drop; null leaves a drop with no room behind. */
	private java.util.function.Predicate<ServerPlayer> mayDrop;
	private int roomStacks;
	/**
	 * A drop that fell over an edge below the feet: the pickup walk stops at the brink, which will not step off onto
	 * ground it has not seen (22 Nov checkpoints: a rod fell off a fortress deck, the walk timed out at the brink and the
	 * rod was left). As a player does, the body looks down at the drop from where the walk stopped, so the ground under
	 * it is seen, then walks again once. The drop being looked at, the ticks spent, and the drops already looked for.
	 */
	private UUID lookingDown;
	private int lookTicks;
	/** The step up to the brink before the look down: from 1.5 blocks back the edge hides the floor below. */
	private ServerNavigationController brinkStep;
	private boolean brinkTried;
	private final java.util.Set<UUID> lookedDown = new java.util.HashSet<>();
	static final int LOOK_DOWN_TICKS = 15;
	/** A drop at least this far below the feet is "over an edge". */
	static final double BELOW_FEET = 0.9D;

	public KillDropCollector(Collection<UUID> drops, BiPredicate<ServerPlayer, Entity> mayTake, long nowEpochMs) {
		this(drops, mayTake, nowEpochMs, COLLECT_BUDGET_MS);
	}

	/** A shorter collect time, for the owed pass that must also walk back inside its rule's limit. */
	public KillDropCollector(Collection<UUID> drops, BiPredicate<ServerPlayer, Entity> mayTake, long nowEpochMs, long budgetMs) {
		this.pending = new ArrayDeque<>(drops);
		this.mayTake = mayTake;
		this.deadline = nowEpochMs + budgetMs;
		this.budgetMs = budgetMs;
	}

	public KillDropCollector crouched(boolean crouched) {
		this.crouched = crouched;
		return this;
	}

	/** Q-drop up to {@link #ROOM_STACKS} junk stacks when a drop does not fit (1b): a full inventory left most lost loot. */
	public KillDropCollector makingRoom(java.util.function.Predicate<ServerPlayer> mayDrop) {
		this.mayDrop = mayDrop;
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
			if (lookingDown != null && !brinkTried) {
				Entity seenDrop = ((net.minecraft.server.level.ServerLevel) player.level()).getEntity(lookingDown);
				if (brinkStep == null) {
					Vec3 brink = seenDrop instanceof ItemEntity drop && drop.isAlive() ? brink(player, drop.position()) : null;
					if (brink == null) brinkTried = true;
					else brinkStep = new ServerNavigationController(brink, 0.25D, false, nowEpochMs, 4_000L, false).crouched(true);
				}
				if (brinkStep != null) {
					ServerController.TickResult stepped = brinkStep.tick(player, nowEpochMs);
					if (stepped.state() == ServerController.State.RUNNING) return null;
					brinkStep.cancel(player);
					brinkStep = null;
					brinkTried = true;
				}
			}
			if (lookingDown != null) {
				Entity entity = ((net.minecraft.server.level.ServerLevel) player.level()).getEntity(lookingDown);
				if (entity instanceof ItemEntity item && item.isAlive() && nowEpochMs < deadline - 1000L && lookTicks++ < LOOK_DOWN_TICKS) {
					boolean aimed = ServerLookController.turnToward(player, item.position().add(0.0D, 0.1D, 0.0D));
					if (!aimed || lookTicks < 4) return null;
					// Read the ground under and around the drop from this pose, so the walk finds it seen (SeenTerrain keeps it 10 s).
					var seen = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player);
					int x = net.minecraft.util.Mth.floor(item.getX()), y = net.minecraft.util.Mth.floor(item.getY()), z = net.minecraft.util.Mth.floor(item.getZ());
					for (int dx = -1; dx <= 1; dx++) for (int dz = -1; dz <= 1; dz++) for (int dy = -2; dy <= 2; dy++) seen.known(x + dx, y + dy, z + dz);
					if (ObservationVisibility.canSeeEntity(player, item)) ObservedDrops.remember(player, item);
				}
				notes.add("looked down over the edge at " + ObservedDrops.describe(player, lookingDown));
				pending.addFirst(lookingDown);
				lookingDown = null;
			}
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
				Entity still = result.state() == ServerController.State.SUCCEEDED ? null
						: ((net.minecraft.server.level.ServerLevel) player.level()).getEntity(currentId);
				if (still instanceof ItemEntity fallen && fallen.isAlive() && fallen.getY() < player.getY() - BELOW_FEET
						&& deadline - nowEpochMs > 2000L && lookedDown.add(currentId)) {
					notes.add("walk to " + currentLabel + " stopped: " + result.reasonCode());
					lookingDown = currentId;
					lookTicks = 0;
					brinkTried = false;
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
				notes.add("left " + label + ": on a ledge above the feet");
				continue;
			}
			String below = ServerFightController.burnsBelow(player, item.position());
			if (below.contains("burns")) { notes.add("left " + label + ":" + below); continue; }
			if (mayTake != null && !mayTake.test(player, item)) { notes.add("left " + label + ": PROTECTION_DENIED"); continue; }
			long left = deadline - nowEpochMs;
			if (left <= 0L) { notes.add("left " + label + ": the " + budgetMs / 1000 + " s collect time ran out"); continue; }
			if (!InventoryRoom.canTake(player, item.getItem())) {
				String room = makeRoom(player, item.getItem());
				if (room != null) notes.add(room);
				if (!InventoryRoom.canTake(player, item.getItem())) { notes.add("left " + label + ": INVENTORY_FULL"); continue; }
			}
			current = new ServerItemPickupController(player, item, nowEpochMs, left).crouched(crouched);
			currentLabel = label;
			currentId = id;
		}
	}

	/** Junk a player throws away for loot, the dig_to discard list (ServerDigController's hints). */
	static final java.util.Set<String> JUNK = java.util.Set.of("minecraft:cobblestone", "minecraft:cobbled_deepslate", "minecraft:diorite",
			"minecraft:andesite", "minecraft:granite", "minecraft:tuff", "minecraft:dirt", "minecraft:gravel");
	/** Junk blocks kept for pillars, bridges and shelters, all kinds together (obtain keeps 16 cobble the same way). */
	static final int KEEP_BLOCKS = 16;
	/** Stacks one collector run may throw away. */
	static final int ROOM_STACKS = 2;

	/**
	 * The main-inventory slot (0..35) to Q-drop for room, or -1: a junk stack, only while {@link #KEEP_BLOCKS} junk
	 * blocks of any kind stay for building, and never to take junk (one block kind for another is no gain); the
	 * smallest such stack, then the lowest slot.
	 */
	static int junkSlot(String[] ids, int[] counts, String collecting) {
		if (collecting == null || JUNK.contains(collecting)) return -1;
		int junk = 0;
		for (int slot = 0; slot < Math.min(36, ids.length); slot++) if (ids[slot] != null && JUNK.contains(ids[slot])) junk += counts[slot];
		int best = -1;
		for (int slot = 0; slot < Math.min(36, ids.length); slot++) {
			String id = ids[slot];
			if (id == null || counts[slot] <= 0 || !JUNK.contains(id) || junk - counts[slot] < KEEP_BLOCKS) continue;
			if (best < 0 || counts[slot] < counts[best]) best = slot;
		}
		return best;
	}

	/** Throws junk stacks until the drop fits, at most {@link #ROOM_STACKS} a run; the note says what went, or null. */
	private String makeRoom(ServerPlayer player, net.minecraft.world.item.ItemStack wanted) {
		if (mayDrop == null || !mayDrop.test(player)) return null;
		List<String> dropped = new ArrayList<>();
		String wantedId = BuiltInRegistries.ITEM.getKey(wanted.getItem()).toString();
		var inventory = player.getInventory();
		while (roomStacks < ROOM_STACKS && !InventoryRoom.canTake(player, wanted)) {
			String[] ids = new String[36];
			int[] counts = new int[36];
			for (int slot = 0; slot < 36; slot++) {
				var stack = inventory.getItem(slot);
				if (stack.isEmpty()) continue;
				ids[slot] = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
				counts[slot] = stack.getCount();
			}
			int slot = junkSlot(ids, counts, wantedId);
			if (slot < 0) break;
			var removed = inventory.removeItem(slot, counts[slot]);
			if (removed.isEmpty()) break;
			// As a Q drop: thrown ahead, owned by the body (AdvancedInteractionService.drop does the same).
			if (dev.agaminggod.mineagen.compat.McCompat.drop(player, removed, true, true) == null) {
				inventory.setItem(slot, removed);
				break;
			}
			roomStacks++;
			dropped.add(counts[slot] + "x " + ids[slot]);
		}
		return dropped.isEmpty() ? null : "made room: dropped " + String.join(", ", dropped);
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
						&& dev.agaminggod.mineagen.server.perception.ThreatPerception.isHostileTo(mob, player))) {
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
		lookingDown = null;
		if (brinkStep != null) { brinkStep.cancel(player); brinkStep = null; }
	}

	/**
	 * The last spot on the body's own floor along the line toward a drop below it, 0.3 short of the edge: the column
	 * under each step is checked in the world as the body has walked it (its own floor), or null when the drop is not
	 * past an edge of that floor within 4 blocks.
	 */
	private static Vec3 brink(ServerPlayer player, Vec3 drop) {
		double dx = drop.x - player.getX(), dz = drop.z - player.getZ();
		double length = Math.hypot(dx, dz);
		if (length < 0.5D) return null;
		int floor = net.minecraft.util.Mth.floor(player.getY() - 0.5D);
		var seen = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player);
		Vec3 last = null;
		for (double along = 0.25D; along <= Math.min(length, 4.0D); along += 0.25D) {
			double x = player.getX() + dx / length * along, z = player.getZ() + dz / length * along;
			var under = seen.known(net.minecraft.util.Mth.floor(x), floor, net.minecraft.util.Mth.floor(z));
			if (under == null || under.getCollisionShape(player.level(), new net.minecraft.core.BlockPos(net.minecraft.util.Mth.floor(x), floor, net.minecraft.util.Mth.floor(z))).isEmpty()) {
				if (last == null) return null;
				return last;
			}
			last = new Vec3(x - dx / length * 0.3D, player.getY(), z - dz / length * 0.3D);
		}
		return null;
	}
}
