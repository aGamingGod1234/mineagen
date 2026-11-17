package dev.agaminggod.mineagen.control;

import java.util.Objects;
import java.util.Optional;

public final class AgentWorldNamePolicy {
	private AgentWorldNamePolicy() {
	}

	public static Optional<String> tag(AgentControlAgent agent) {
		Objects.requireNonNull(agent, "agent must not be null");
		String displayName = agent.displayName();
		return displayName.isBlank() ? Optional.empty() : Optional.of(displayName);
	}
}
