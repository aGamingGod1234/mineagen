package dev.agaminggod.mineagen.server.watch;

import com.google.gson.JsonObject;
import java.util.Set;
import net.minecraft.core.BlockPos;

/** 1b: the Watcher's kill row and entity_killed's position, gated on killFacts. */
public final class KillRowVerification {
	private KillRowVerification() {
	}

	public static int verify() {
		DangerLog log = new DangerLog("agent-k");
		log.kill("minecraft:zombie", true, 1, 2, 100L, 5_000L);
		log.kill("minecraft:skeleton", false, 0, 0, 101L, 5_050L);
		var rows = log.take();
		check(2, rows.size(), "each kill writes one row");
		JsonObject seen = rows.get(0);
		check("kill", seen.get("type").getAsString(), "row type");
		check(Set.of("type", "schema", "agentId", "atMs", "gameTime", "entityType", "seen", "dropsSeen", "dropsUnseen"), seen.keySet(), "kill row keys");
		check(true, seen.get("seen").getAsBoolean(), "seen kill");
		check(2, seen.get("dropsUnseen").getAsInt(), "drops the sight filter rejected are counted");
		check(false, rows.get(1).get("seen").getAsBoolean(), "unseen kill");

		var plain = dev.agaminggod.mineagen.server.bridge.MultiplexedServerBridge.killPayload(3L, "minecraft:zombie", new BlockPos(1, 64, -2), false);
		check(Set.of("goalRevision", "entityType"), plain.keySet(), "without killFacts the keys stay exactly goalRevision, entityType");
		var unseen = dev.agaminggod.mineagen.server.bridge.MultiplexedServerBridge.killPayload(3L, "minecraft:zombie", null, true);
		check(Set.of("goalRevision", "entityType"), unseen.keySet(), "an unseen kill adds nothing");
		var at = dev.agaminggod.mineagen.server.bridge.MultiplexedServerBridge.killPayload(3L, "minecraft:zombie", new BlockPos(1, 64, -2), true);
		check(Set.of("goalRevision", "entityType", "at"), at.keySet(), "with killFacts a seen kill carries at");
		check("{\"x\":1,\"y\":64,\"z\":-2}", at.get("at").toString(), "at is the block position");
		return 10;
	}

	private static void check(Object expected, Object actual, String message) {
		if (!java.util.Objects.equals(expected, actual)) throw new AssertionError(message + ": expected " + expected + ", got " + actual);
	}
}
