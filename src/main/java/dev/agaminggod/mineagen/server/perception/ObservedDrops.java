package dev.agaminggod.mineagen.server.perception;

import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.phys.Vec3;

/** Drops witnessed at a kill or a break, retained at their last seen position, never followed through walls. */
public final class ObservedDrops {
	private static final long KEEP_TICKS = 1200L;
	static final int CAPACITY = 32;
	private static final Map<ServerPlayer, Map<UUID, Drop>> MEMORY = new WeakHashMap<>();
	/** Where a drop came from: a mob the body killed, a block it broke, or a drop it only saw (a pickup's own target). */
	public enum Source { KILL, BREAK, OTHER }
	public record Drop(Vec3 position, String dimension, long tick, String item, int count, boolean landed, Source source) { }
	private ObservedDrops() { }

	/** A re-sighting: keeps the source the drop was first remembered with, else {@link Source#OTHER}. */
	public static void remember(ServerPlayer player, ItemEntity item) {
		remember(player, item, null);
	}

	/** {@code source} null keeps the remembered one; a kill or break source replaces an OTHER sighting. */
	public static void remember(ServerPlayer player, ItemEntity item, Source source) {
		Map<UUID, Drop> drops = MEMORY.computeIfAbsent(player, ignored -> new LinkedHashMap<>());
		Drop known = drops.get(item.getUUID());
		Source kept = keptSource(known == null ? null : known.source(), source);
		drops.put(item.getUUID(), new Drop(item.position(), player.level().dimension().identifier().toString(),
				player.level().getGameTime(), net.minecraft.core.registries.BuiltInRegistries.ITEM.getKey(item.getItem().getItem()).toString(),
				item.getItem().getCount(), item.onGround(), kept));
		long now = player.level().getGameTime();
		var level = (net.minecraft.server.level.ServerLevel) player.level();
		evict(drops, now, id -> !(level.getEntity(id) instanceof ItemEntity live) || !live.isAlive());
	}

	/** The source a sighting stores: a known kill or break keeps its own; an OTHER sighting takes a kill or break source. */
	static Source keptSource(Source known, Source given) {
		if (known != null && (given == null || known != Source.OTHER)) return known;
		return given == null ? Source.OTHER : given;
	}

	/**
	 * Over capacity: first every sighting that expired or whose drop is gone (picked up, burnt, merged, despawned), then
	 * the oldest drop that is not a kill's, so a dig never pushes out the loot a fight left, and old kill entries never
	 * crowd out a new break drop.
	 */
	static <K> void evict(Map<K, Drop> drops, long now, java.util.function.Predicate<K> gone) {
		if (drops.size() <= CAPACITY) return;
		drops.entrySet().removeIf(entry -> now < entry.getValue().tick() || now - entry.getValue().tick() > KEEP_TICKS || gone.test(entry.getKey()));
		while (drops.size() > CAPACITY) {
			K victim = null;
			for (Map.Entry<K, Drop> entry : drops.entrySet()) {
				if (entry.getValue().source() != Source.KILL) { victim = entry.getKey(); break; }
			}
			drops.remove(victim != null ? victim : drops.keySet().iterator().next());
		}
	}

	public static Drop recall(ServerPlayer player, UUID id) {
		Map<UUID, Drop> drops = MEMORY.get(player);
		if (drops == null) return null;
		Drop drop = drops.get(id);
		long now = player.level().getGameTime();
		if (drop != null && (!drop.dimension().equals(player.level().dimension().identifier().toString())
				|| now < drop.tick() || now - drop.tick() > KEEP_TICKS)) {
			drops.remove(id);
			return null;
		}
		return drop;
	}

	/** The ids of every drop still remembered (last sight not expired), oldest first. */
	public static java.util.List<UUID> remembered(ServerPlayer player) {
		Map<UUID, Drop> drops = MEMORY.get(player);
		if (drops == null) return java.util.List.of();
		java.util.List<UUID> ids = new java.util.ArrayList<>();
		for (UUID id : new java.util.ArrayList<>(drops.keySet())) if (recall(player, id) != null) ids.add(id);
		return ids;
	}

	/** Read current coordinates only when the item is visible; a hidden item keeps its last seen coordinates. */
	public static Vec3 position(ServerPlayer player, ItemEntity item) {
		if (ObservationVisibility.canSeeEntity(player, item)) {
			remember(player, item);
			return item.position();
		}
		Drop drop = recall(player, item.getUUID());
		return drop == null ? null : drop.position();
	}

	public static String describe(ServerPlayer player, UUID id) {
		Drop drop = recall(player, id);
		if (drop == null) return "drop " + id + " last sight expired";
		Vec3 at = drop.position();
		return drop.count() + "x " + drop.item() + " at " + net.minecraft.util.Mth.floor(at.x) + ","
				+ net.minecraft.util.Mth.floor(at.y) + "," + net.minecraft.util.Mth.floor(at.z) + " uuid=" + id
				+ (drop.landed() ? " (landed, last seen)" : " (falling, last seen)");
	}
}
