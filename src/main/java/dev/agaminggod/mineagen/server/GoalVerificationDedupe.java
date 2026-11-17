package dev.agaminggod.mineagen.server;

import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.agent.goal.GoalEvidence;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;

/**
 * Announces each goal-verification outcome once. The runtime and the bridge share one instance
 * per server so a proactive verification and a completion request do not both reach chat.
 */
public final class GoalVerificationDedupe {
	private static final Map<MinecraftServer, GoalVerificationDedupe> SERVER_STATES = new ConcurrentHashMap<>();

	private final Map<AgentId, GoalVerificationActivity> goalVerifications = new HashMap<>();

	public static GoalVerificationDedupe forServer(MinecraftServer server) {
		return SERVER_STATES.computeIfAbsent(
				Objects.requireNonNull(server, "server must not be null"),
				ignored -> new GoalVerificationDedupe()
		);
	}

	static void release(MinecraftServer server) {
		if (server == null) return;
		GoalVerificationDedupe state = SERVER_STATES.remove(server);
		if (state != null) state.clear();
	}

	public synchronized void clear() {
		goalVerifications.clear();
	}

	public synchronized boolean goalVerificationChanged(
			AgentId agentId,
			long goalRevision,
			boolean verified,
			List<GoalEvidence.Fact> facts
	) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		String fingerprint = Boolean.toString(verified) + Objects.requireNonNull(facts, "facts must not be null").toString();
		GoalVerificationActivity next = new GoalVerificationActivity(goalRevision, fingerprint);
		if (next.equals(goalVerifications.get(agentId))) return false;
		goalVerifications.put(agentId, next);
		return true;
	}

	private record GoalVerificationActivity(long goalRevision, String fingerprint) { }
}
