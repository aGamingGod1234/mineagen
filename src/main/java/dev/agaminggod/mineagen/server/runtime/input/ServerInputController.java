package dev.agaminggod.mineagen.server.runtime.input;

import dev.agaminggod.mineagen.agent.AgentId;
import java.util.Optional;

public interface ServerInputController {
	InputLease acquire(AgentId agentId, InputOwner owner, int priority);

	void apply(InputLease lease, AgentInputState state);

	void release(InputLease lease);

	void clear(AgentId agentId);

	Optional<AgentInputState> currentState(AgentId agentId);
}
