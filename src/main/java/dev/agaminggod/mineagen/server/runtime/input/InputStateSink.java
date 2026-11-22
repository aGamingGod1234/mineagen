package dev.agaminggod.mineagen.server.runtime.input;

import dev.agaminggod.mineagen.agent.AgentId;

public interface InputStateSink {
	void apply(AgentId agentId, AgentInputState previous, AgentInputState state);

	default void tick(AgentId agentId, AgentInputState state) {
	}

	default long acceptedUses(AgentId agentId) { return 0L; }

	/** The block or entity that took the last accepted use click, or null when the held item itself acted. */
	default String lastAcceptedUseTarget(AgentId agentId) { return null; }

	/** Full lifecycle revocation, including after the last lease has already released. */
	default void revoke(AgentId agentId) { }

	void clear(AgentId agentId, AgentInputState previous);
}
