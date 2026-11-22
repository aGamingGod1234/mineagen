package dev.agaminggod.mineagen.control;

import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;

/**
 * How long each agent has been in its current state, as far as this client has watched without a break. A duration is
 * known only from a state change seen while watching: after a gap (control center closed, no snapshot) the state may have
 * changed and changed back unseen, so the duration is unknown until the next change is seen.
 */
public final class AgentStateClock {
	/** A longer gap between observations than this loses the thread. */
	public static final long OBSERVATION_GAP_MS = 3_000L;
	private static final int MAXIMUM_AGENTS = 64;

	private record Seen(String state, long sinceMs, long seenAtMs, boolean known) {
	}

	private final Map<String, Seen> seen = new HashMap<>();

	/** Observes every agent in a snapshot at {@code nowMs}; call it each time the agents are looked at. */
	public void observe(List<AgentControlAgent> agents, long nowMs) {
		Objects.requireNonNull(agents, "agents must not be null");
		if (seen.size() > MAXIMUM_AGENTS) seen.clear();
		for (AgentControlAgent agent : agents) observe(agent.agentId(), agent.state(), nowMs);
	}

	public void observe(String agentId, String state, long nowMs) {
		Seen previous = seen.get(agentId);
		Seen next;
		if (previous == null || nowMs - previous.seenAtMs() > OBSERVATION_GAP_MS || nowMs < previous.seenAtMs()) next = new Seen(state, nowMs, nowMs, false);
		else if (!previous.state().equals(state)) next = new Seen(state, nowMs, nowMs, true);
		else next = new Seen(previous.state(), previous.sinceMs(), nowMs, previous.known());
		seen.put(agentId, next);
	}

	/** Milliseconds the agent has been in {@code state}, or -1 when this client has not watched it since it began. */
	public long durationMs(String agentId, String state, long nowMs) {
		Seen current = seen.get(agentId);
		if (current == null || !current.known() || !current.state().equals(state)) return -1L;
		return Math.max(0L, nowMs - current.sinceMs());
	}
}
