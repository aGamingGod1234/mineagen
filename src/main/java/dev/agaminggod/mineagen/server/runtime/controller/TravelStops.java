package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.Set;

/**
 * Which hostiles and which damage end a travel_to trip and hand it back to the model. A player on a night trip does not
 * stop for every mob that comes into view or for a berry-bush scratch: a mob that is not after them, or that falls
 * behind while they sprint on, is passed; a small knock from a bush, a cactus or a short drop is shrugged off. The trip
 * still stops for anything up close, for a mob targeting the body and closing in, for a ranged mob targeting it (it
 * hits from where it stands), and for every hit from a mob, burning, drowning or anything else.
 */
public final class TravelStops {
	private TravelStops() {
	}

	/** A hostile this close always stops the trip (blocks). */
	public static final double CLOSE = 6.0D;
	/** How much nearer a targeting mob must get between two samples (a quarter second apart) to count as closing in. */
	public static final double CLOSING_STEP = 0.25D;
	/** Most environmental damage one hit may do and still be shrugged off. */
	public static final float MINOR_HIT = 2.0F;
	/** Most environmental damage shrugged off over one trip. */
	public static final float MINOR_TOTAL = 4.0F;
	/** Damage kinds a passing body takes from the terrain itself, with no attacker. */
	static final Set<String> MINOR_SOURCES = Set.of("sweetBerryBush", "cactus", "fall");
	/** Mobs that hurt from range: once targeting, they are a reason to stop wherever they are. */
	static final Set<String> RANGED = Set.of("minecraft:skeleton", "minecraft:stray", "minecraft:bogged", "minecraft:pillager",
			"minecraft:blaze", "minecraft:ghast", "minecraft:witch", "minecraft:shulker", "minecraft:breeze", "minecraft:evoker",
			"minecraft:illusioner", "minecraft:drowned", "minecraft:piglin");

	/** Ticks a mob's {@link #cannotReach} answer is kept before its path is worked out again. */
	static final int REACH_RECHECK_TICKS = 20;
	private static final java.util.Map<net.minecraft.world.entity.Mob, long[]> REACH = new java.util.WeakHashMap<>();

	/**
	 * A melee mob at least 2 blocks above or below the body whose own pathfinder ends short of it: a zombie in the cave
	 * floor under a ledge, still targeting the body, that cannot climb up. A player walks and digs on past it (seed 6006
	 * iron cave: two zombies 3-4 below stopped every walk at 5 blocks, 124 and 142 stops in a row, until the run ran out).
	 * Only a found path that does not reach counts; no path worked out (mid-fall, out of range) is no answer and stops
	 * as before, as do creepers (a blast reaches through) and ranged mobs (they hit from where they stand).
	 */
	public static boolean cannotReach(net.minecraft.server.level.ServerPlayer player, net.minecraft.world.entity.Mob mob) {
		String type = net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString();
		if (RANGED.contains(type) || type.equals("minecraft:creeper") || type.endsWith("guardian")
				|| dev.agaminggod.mineagen.server.perception.ThreatPerception.isRanged(mob)) return false;
		if (Math.abs(mob.getY() - player.getY()) < 2.0D || mob.distanceTo(player) <= 2.0D) return false;
		long now = player.level().getGameTime();
		long[] kept = REACH.get(mob);
		if (kept != null && now - kept[0] < REACH_RECHECK_TICKS) return kept[1] == 1L;
		net.minecraft.world.level.pathfinder.Path path = mob.getNavigation().createPath(player, 1);
		boolean unreachable = path != null && !path.canReach();
		REACH.put(mob, new long[] {now, unreachable ? 1L : 0L});
		return unreachable;
	}

	/** Melee mobs a body with a sword or axe beats one at a time: the instincts arm fights them on the route (issue 2 Step 2). */
	public static final Set<String> BEATABLE = Set.of("minecraft:zombie", "minecraft:husk", "minecraft:zombie_villager", "minecraft:spider");
	/** Another hostile in view this close makes it a pack, not a lone mob. */
	public static final double LONE_RANGE = 12.0D;
	/** The body must outlast this many of the mob's hits (after armour); Defend backs away from a mob below it. */
	public static final int SAFE_HITS = 3;

	/**
	 * Whether a hostile that would stop the trip is one the body fights through instead (instincts arm, the model left
	 * fightThrough unset): a listed melee mob, alone in view within {@link #LONE_RANGE}, a sword or axe in the hotbar, and
	 * health above minHealth and above {@link #SAFE_HITS} of its hits ({@code hit} 0 or less: no estimate, not beatable).
	 */
	public static boolean beatable(String typeId, int othersNear, boolean weapon, float health, float minHealth, double hit) {
		return BEATABLE.contains(typeId) && othersNear == 0 && weapon && health > minHealth && hit > 0.0D && health > SAFE_HITS * hit;
	}

	/**
	 * Whether a hostile in range stops the trip now. {@code known} was in view when the trip began; {@code previous} is
	 * its distance at the last sample (null on its first).
	 */
	public static boolean stopsFor(boolean known, double distance, Double previous, boolean targeting, String typeId) {
		if (distance <= CLOSE) return true;
		if (known || !targeting) return false;
		if (RANGED.contains(typeId)) return true;
		return previous != null && previous - distance >= CLOSING_STEP;
	}

	/**
	 * Whether this hit is shrugged off: terrain damage with no attacker ({@code msgId} a bush, cactus or fall), at most
	 * {@link #MINOR_HIT}, within {@link #MINOR_TOTAL} for the trip, and leaving health above {@code minHealth}.
	 */
	public static boolean shrugsOff(String msgId, boolean fromEntity, float lost, float shruggedSoFar, float health, float minHealth) {
		return !fromEntity && msgId != null && MINOR_SOURCES.contains(msgId) && lost <= MINOR_HIT
				&& shruggedSoFar + lost <= MINOR_TOTAL && health > minHealth;
	}
}
