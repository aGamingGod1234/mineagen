package dev.agaminggod.arenaagents.server.runtime.controller;

import java.util.HashMap;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.function.Predicate;
import net.minecraft.world.phys.Vec3;

/**
 * Where the body last saw each enderman during one count fight, and which ones it has given up walking to. A walk goes
 * only to a sighting inside the model's area (radius around its center); one outside is kept as a fact for the result.
 * An enderman whose walk ended with no seen route, or whose walks ended without a fight twice, is left for the rest of
 * the skill: seeing it again does not start another walk, so a visible enderman with no route cannot keep the skill busy.
 */
final class EndermanHuntLeads {
	static final int MAX_WALKS = 2;

	record Lead(UUID id, Vec3 at) {}

	private record Sighting(Vec3 at, long seenMs) {}

	private final Vec3 center;
	private final double radius;
	private final long lifetimeMs;
	private final Map<UUID, Sighting> sightings = new LinkedHashMap<>();
	private final Map<UUID, Integer> walks = new HashMap<>();
	private final Set<UUID> left = new HashSet<>();
	private int reached;
	private int noRoute;

	EndermanHuntLeads(Vec3 center, double radius, long lifetimeMs) {
		this.center = center;
		this.radius = radius;
		this.lifetimeMs = lifetimeMs;
	}

	/** The body sees this enderman now. Ignored for one it has left. */
	void saw(UUID id, Vec3 at, long nowMs) {
		if (!left.contains(id)) sightings.put(id, new Sighting(at, nowMs));
	}

	/** Killed or otherwise done with. */
	void forget(UUID id) {
		sightings.remove(id);
	}

	/**
	 * The nearest live sighting inside the area that is farther than arrive from the body, or null. Sightings the body
	 * already stands at are dropped (it is there and sees no enderman).
	 */
	Lead next(Vec3 from, long nowMs, double arrive, Predicate<UUID> skip) {
		sightings.values().removeIf(s -> nowMs - s.seenMs() > lifetimeMs);
		while (true) {
			UUID bestId = null;
			double best = Double.MAX_VALUE;
			for (Map.Entry<UUID, Sighting> entry : sightings.entrySet()) {
				if (skip.test(entry.getKey()) || entry.getValue().at().distanceTo(center) > radius) continue;
				double distance = from.distanceTo(entry.getValue().at());
				if (distance < best) { best = distance; bestId = entry.getKey(); }
			}
			if (bestId == null) return null;
			if (best > arrive) {
				walks.merge(bestId, 1, Integer::sum);
				return new Lead(bestId, sightings.get(bestId).at());
			}
			sightings.remove(bestId);
		}
	}

	/** A walk ended. Reached or not, the sighting is spent; no route, or the walk cap, leaves the enderman. */
	void walkEnded(UUID id, boolean arrived, String reasonCode) {
		sightings.remove(id);
		if (arrived) reached++;
		boolean blocked = !arrived && "NO_SEEN_ROUTE".equals(reasonCode);
		if (blocked) noRoute++;
		if (blocked || walks.getOrDefault(id, 0) >= MAX_WALKS) left.add(id);
	}

	/** The nearest live sighting outside the area (a fact for the model), or null. */
	Vec3 nearestOutside(Vec3 from, long nowMs) {
		Vec3 best = null;
		double bestDistance = Double.MAX_VALUE;
		for (Sighting s : sightings.values()) {
			if (nowMs - s.seenMs() > lifetimeMs || s.at().distanceTo(center) <= radius) continue;
			double distance = from.distanceTo(s.at());
			if (distance < bestDistance) { bestDistance = distance; best = s.at(); }
		}
		return best;
	}

	boolean left(UUID id) {
		return left.contains(id);
	}

	int tried() {
		return walks.size();
	}

	int reached() {
		return reached;
	}

	int noRoute() {
		return noRoute;
	}

	/** True when a hunt walk missed at least one game tick since its last key press (its input lease may have lapsed). */
	static boolean walkLeftUnticked(long lastTick, long tick) {
		return tick - lastTick > 1L;
	}
}
