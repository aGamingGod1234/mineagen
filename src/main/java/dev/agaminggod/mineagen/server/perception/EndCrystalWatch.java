package dev.agaminggod.mineagen.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import java.util.WeakHashMap;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.boss.enderdragon.EndCrystal;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

/**
 * End crystals a player on the island saw blow up. A crystal's end is a power-6 explosion with a flash and a boom heard
 * across the island, so a player knows which pillar went dark even when the pillar's own rim hides its top from below.
 * The bot only learned of a broken crystal from its own shot's result, so a crystal that went another way (the shot
 * cancelled while the arrow flew, a neighbour's blast) stayed "standing" in its memory: in 8 of 16 End games that broke
 * all ten, the fact claimed 1-3 standing for the rest of the game (5-29 min) and the bot climbed after them.
 * <p>
 * Each End observation scans the crystals near the agent and keeps the live ones. A crystal counts as gone when it is
 * later found removed as killed (not unloaded with its chunk), or when the agent has a clear view of the spot where it
 * stood, that spot's entities are loaded, and no crystal with its id is there. A gone crystal is reported for
 * {@link #REPORT_TICKS} as an entity row with {@code alive:false} to agents within {@link #WITNESS_RANGE} of where it
 * stood.
 */
public final class EndCrystalWatch {
	/** A crystal blast is seen and heard from anywhere on the main island (its pillars stand within 43 of the centre). */
	static final double WITNESS_RANGE = 128.0D;
	/** Reported this long after the blast (the coordinator remembers it from the first report). */
	static final long REPORT_TICKS = 1200L;
	private static final int MAX_TRACKED = 32;
	/** Rows reserved for gone crystals; the main island has ten. */
	static final int MAX_ROWS = 12;

	record Gone(UUID id, Vec3 position, long tick) { }

	private static final class State {
		final Map<UUID, EndCrystal> live = new HashMap<>();
		/** Where each crystal seen alive stood, kept while its chunk is unloaded so a later empty view can clear it. */
		final Map<UUID, Vec3> stood = new HashMap<>();
		final Map<UUID, Gone> gone = new LinkedHashMap<>();
	}

	private static final Map<ServerLevel, State> STATES = new WeakHashMap<>();

	private EndCrystalWatch() { }

	/** Scans for this agent and returns the crystals it saw destroyed within the report window, nearest first. */
	static synchronized List<Gone> witnessed(ServerLevel level, ServerPlayer agent, ObservationVisibility.Frame visibility) {
		if (level.dimension() != Level.END) return List.of();
		State state = STATES.computeIfAbsent(level, key -> new State());
		long tick = level.getGameTime();
		for (EndCrystal crystal : level.getEntitiesOfClass(EndCrystal.class, agent.getBoundingBox().inflate(WITNESS_RANGE), EndCrystal::isAlive)) {
			// Alive again (a misread empty view, or the dragon fight reset): it is not gone.
			state.gone.remove(crystal.getUUID());
			if (state.stood.size() >= MAX_TRACKED && !state.stood.containsKey(crystal.getUUID())) continue;
			state.live.put(crystal.getUUID(), crystal);
			state.stood.put(crystal.getUUID(), crystal.position());
		}
		for (Iterator<EndCrystal> it = state.live.values().iterator(); it.hasNext(); ) {
			EndCrystal crystal = it.next();
			if (!crystal.isRemoved()) continue;
			it.remove();
			if (crystal.getRemovalReason() == Entity.RemovalReason.KILLED) markGone(state, crystal.getUUID(), crystal.position(), tick);
		}
		for (Map.Entry<UUID, Vec3> entry : new ArrayList<>(state.stood.entrySet())) {
			if (state.live.containsKey(entry.getKey()) || state.gone.containsKey(entry.getKey())) continue;
			if (seenEmpty(level, agent, visibility, entry.getKey(), entry.getValue())) markGone(state, entry.getKey(), entry.getValue(), tick);
		}
		state.gone.values().removeIf(gone -> tick - gone.tick() > REPORT_TICKS);
		List<Gone> seen = new ArrayList<>();
		for (Gone gone : state.gone.values()) {
			if (gone.position().distanceTo(agent.position()) <= WITNESS_RANGE) seen.add(gone);
		}
		seen.sort(Comparator.comparingDouble(gone -> gone.position().distanceToSqr(agent.position())));
		return seen;
	}

	private static void markGone(State state, UUID id, Vec3 position, long tick) {
		state.live.remove(id);
		state.stood.remove(id);
		state.gone.putIfAbsent(id, new Gone(id, position, tick));
	}

	/** The agent can see the spot the crystal stood in, its entities are loaded, and the crystal is not there. */
	private static boolean seenEmpty(ServerLevel level, ServerPlayer agent, ObservationVisibility.Frame visibility, UUID id, Vec3 position) {
		if (visibility == null || position.distanceTo(agent.position()) > WITNESS_RANGE) return false;
		BlockPos cell = BlockPos.containing(position);
		if (!level.isPositionEntityTicking(cell)) return false;
		Entity entity = level.getEntity(id);
		if (entity != null && entity.isAlive()) return false;
		return visibility.seesCellOnce(cell) || visibility.seesCellOnce(cell.above());
	}

	/** Adds the destroyed crystals as {@code alive:false} rows, skipping ids already present and staying within {@code limit}. */
	static JsonArray rows(List<Gone> witnessed, ServerPlayer agent, int limit) {
		JsonArray rows = new JsonArray();
		for (Gone gone : witnessed) {
			if (rows.size() >= limit) break;
			String id = gone.id().toString();
			JsonObject json = new JsonObject();
			json.addProperty("uuid", id);
			json.addProperty("type", "minecraft:end_crystal");
			json.addProperty("name", "End Crystal");
			json.addProperty("distance", (float) gone.position().distanceTo(agent.position()));
			JsonObject position = new JsonObject();
			position.addProperty("x", gone.position().x);
			position.addProperty("y", gone.position().y);
			position.addProperty("z", gone.position().z);
			json.add("position", position);
			json.addProperty("alive", false);
			json.addProperty("perceivedBy", "sight");
			rows.add(json);
		}
		return rows;
	}

	/** Test hook: forget every level's state. */
	static synchronized void reset() {
		STATES.clear();
	}
}
