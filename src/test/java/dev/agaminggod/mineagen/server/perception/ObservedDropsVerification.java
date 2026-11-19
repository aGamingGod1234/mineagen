package dev.agaminggod.mineagen.server.perception;

import java.util.LinkedHashMap;
import java.util.Map;
import net.minecraft.world.phys.Vec3;

/** K10: drop sources and the eviction order that keeps a fight's loot through a dig. */
public final class ObservedDropsVerification {
	private ObservedDropsVerification() {
	}

	public static int verify() {
		check(ObservedDrops.Source.KILL, ObservedDrops.keptSource(ObservedDrops.Source.KILL, null), "a re-sighting keeps a kill source");
		check(ObservedDrops.Source.KILL, ObservedDrops.keptSource(ObservedDrops.Source.KILL, ObservedDrops.Source.BREAK), "a kill drop stays a kill drop");
		check(ObservedDrops.Source.KILL, ObservedDrops.keptSource(ObservedDrops.Source.OTHER, ObservedDrops.Source.KILL), "an OTHER sighting learns its kill source");
		check(ObservedDrops.Source.OTHER, ObservedDrops.keptSource(null, null), "a first plain sighting is OTHER");
		check(ObservedDrops.Source.BREAK, ObservedDrops.keptSource(null, ObservedDrops.Source.BREAK), "a first break sighting is BREAK");

		Map<Integer, ObservedDrops.Drop> drops = new LinkedHashMap<>();
		for (int i = 0; i < 4; i++) drops.put(i, drop(ObservedDrops.Source.KILL));
		for (int i = 4; i < ObservedDrops.CAPACITY + 10; i++) {
			drops.put(i, drop(ObservedDrops.Source.BREAK));
			ObservedDrops.evict(drops, 0L, id -> false);
		}
		check(ObservedDrops.CAPACITY, drops.size(), "capacity holds");
		for (int i = 0; i < 4; i++) check(true, drops.containsKey(i), "a dig never pushes out kill drop " + i);
		check(false, drops.containsKey(4), "the oldest break drop goes first");

		Map<Integer, ObservedDrops.Drop> kills = new LinkedHashMap<>();
		for (int i = 0; i <= ObservedDrops.CAPACITY; i++) {
			kills.put(i, drop(ObservedDrops.Source.KILL));
			ObservedDrops.evict(kills, 0L, id -> false);
		}
		check(false, kills.containsKey(0), "with only kill drops the oldest goes");
		check(ObservedDrops.CAPACITY, kills.size(), "capacity holds for kill drops");
		// Review fix: kill entries that expired or whose drop is gone never crowd out a new break drop.
		Map<Integer, ObservedDrops.Drop> stale = new LinkedHashMap<>();
		for (int i = 0; i < ObservedDrops.CAPACITY; i++) stale.put(i, drop(ObservedDrops.Source.KILL));
		stale.put(100, new ObservedDrops.Drop(Vec3.ZERO, "minecraft:overworld", 1_300L, "minecraft:cobblestone", 1, true, ObservedDrops.Source.BREAK));
		ObservedDrops.evict(stale, 1_300L, id -> false);
		check(true, stale.containsKey(100), "expired kill sightings go before a fresh break drop");
		check(1, stale.size(), "every expired sighting is swept");
		Map<Integer, ObservedDrops.Drop> picked = new LinkedHashMap<>();
		for (int i = 0; i <= ObservedDrops.CAPACITY; i++) picked.put(i, drop(i < ObservedDrops.CAPACITY ? ObservedDrops.Source.KILL : ObservedDrops.Source.BREAK));
		ObservedDrops.evict(picked, 10L, id -> id < 5);
		check(true, picked.containsKey(ObservedDrops.CAPACITY), "picked-up kill drops go before a fresh break drop");
		check(ObservedDrops.CAPACITY + 1 - 5, picked.size(), "only the gone drops were removed");
		return 17;
	}

	private static ObservedDrops.Drop drop(ObservedDrops.Source source) {
		return new ObservedDrops.Drop(Vec3.ZERO, "minecraft:overworld", 0L, "minecraft:cobblestone", 1, true, source);
	}

	private static void check(Object expected, Object actual, String message) {
		if (!java.util.Objects.equals(expected, actual)) throw new AssertionError(message + ": expected " + expected + ", got " + actual);
	}
}
