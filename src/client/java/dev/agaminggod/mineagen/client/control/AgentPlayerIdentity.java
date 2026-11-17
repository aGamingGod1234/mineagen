package dev.agaminggod.mineagen.client.control;

import dev.agaminggod.mineagen.control.AgentControlAgent;
import dev.agaminggod.mineagen.control.AgentControlSnapshot;
import java.util.Objects;
import java.util.Optional;

public final class AgentPlayerIdentity {
	private AgentPlayerIdentity() {
	}

	public static Optional<AgentControlAgent> find(AgentControlSnapshot snapshot, String profileName) {
		Objects.requireNonNull(snapshot, "snapshot must not be null");
		String checkedName = Objects.requireNonNull(profileName, "profileName must not be null").strip();
		if (checkedName.isEmpty()) return Optional.empty();

		Optional<AgentControlAgent> exact = snapshot.agents().stream()
				.filter(agent -> agent.playerName().equals(checkedName))
				.findFirst();
		if (exact.isPresent()) return exact;
		return snapshot.agents().stream()
				.filter(agent -> agent.playerName().equalsIgnoreCase(checkedName))
				.findFirst();
	}
}
