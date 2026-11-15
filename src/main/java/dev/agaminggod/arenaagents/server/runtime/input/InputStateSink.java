package dev.agaminggod.arenaagents.server.runtime.input;

import dev.agaminggod.arenaagents.agent.AgentId;

public interface InputStateSink {
	void apply(AgentId agentId, AgentInputState previous, AgentInputState state);

	default void tick(AgentId agentId, AgentInputState state) {
	}

	default long acceptedUses(AgentId agentId) { return 0L; }

	/** Full lifecycle revocation, including after the last lease has already released. */
	default void revoke(AgentId agentId) { }

	void clear(AgentId agentId, AgentInputState previous);
}
