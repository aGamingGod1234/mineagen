package dev.agaminggod.mineagen.server.bridge;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.nio.charset.StandardCharsets;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.HexFormat;
import java.util.Map;

/**
 * Replaces an observation's inventory with {@code {"unchanged": hash}} when it equals the last full inventory this
 * connection delivered for the agent. A full inventory carries its hash in {@code inventoryHash}, so the coordinator can
 * keep it and expand later markers. Only used for a coordinator that announced {@code inventoryMarker} in hello.
 *
 * <p>The baseline lives on the session, so a new connection always starts with a full inventory. Even an unchanged
 * inventory is sent in full every {@link #FULL_EVERY} observations, so a coordinator that lost the baseline recovers
 * without asking.
 */
final class ObservationInventoryMarker {
	static final int FULL_EVERY = 32;

	private ObservationInventoryMarker() {}

	/** The last full inventory delivered on one connection, and how many markers followed it. */
	record Baseline(String json, String hash, int markersSince) {}

	/** The payload to write and the baseline to keep once it is enqueued. */
	record Outgoing(JsonObject payload, Baseline baseline) {}

	/** Never mutates {@code observation}: the publication keeps it, full, as the delivered baseline. */
	static Outgoing prepare(Baseline previous, JsonObject observation) {
		if (!(observation.get("inventory") instanceof JsonObject inventory)) return new Outgoing(observation, previous);
		String json = inventory.toString();
		if (previous != null && previous.json().equals(json) && previous.markersSince() < FULL_EVERY - 1) {
			JsonObject marker = new JsonObject();
			marker.addProperty("unchanged", previous.hash());
			return new Outgoing(replaceInventory(observation, marker, null),
					new Baseline(previous.json(), previous.hash(), previous.markersSince() + 1));
		}
		String hash = hash(json);
		return new Outgoing(replaceInventory(observation, inventory, hash), new Baseline(json, hash, 0));
	}

	/** Records what was enqueued; a payload without an inventory leaves the baseline as it was. */
	static <K> void remember(Map<K, Baseline> delivered, K agentId, Outgoing outgoing) {
		if (outgoing.baseline() == null) delivered.remove(agentId);
		else delivered.put(agentId, outgoing.baseline());
	}

	private static JsonObject replaceInventory(JsonObject observation, JsonElement inventory, String hash) {
		JsonObject copy = new JsonObject();
		for (Map.Entry<String, JsonElement> entry : observation.entrySet()) {
			copy.add(entry.getKey(), entry.getKey().equals("inventory") ? inventory : entry.getValue());
		}
		if (hash != null) copy.addProperty("inventoryHash", hash);
		return copy;
	}

	static String hash(String json) {
		try {
			byte[] digest = MessageDigest.getInstance("SHA-256").digest(json.getBytes(StandardCharsets.UTF_8));
			return HexFormat.of().formatHex(digest, 0, 8);
		} catch (NoSuchAlgorithmException exception) {
			throw new IllegalStateException("SHA-256 is unavailable", exception);
		}
	}
}
