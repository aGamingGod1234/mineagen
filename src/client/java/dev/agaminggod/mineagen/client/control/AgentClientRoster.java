package dev.agaminggod.mineagen.client.control;

import com.mojang.authlib.GameProfile;
import dev.agaminggod.mineagen.agent.AgentIdentity;
import dev.agaminggod.mineagen.control.AgentControlAgent;
import dev.agaminggod.mineagen.control.AgentControlSnapshotStore;
import java.util.Optional;

/** Presentation data may be read by skin lookup before Minecraft's keybindings exist. */
public final class AgentClientRoster {
	private static final AgentControlSnapshotStore SNAPSHOTS = new AgentControlSnapshotStore();

	private AgentClientRoster() {
	}

	static AgentControlSnapshotStore snapshots() {
		return SNAPSHOTS;
	}

	public static Optional<AgentControlAgent> agentForPlayer(String name) {
		return SNAPSHOTS.current().flatMap(snapshot -> AgentPlayerIdentity.find(snapshot, name));
	}

	public static Optional<String> displayName(GameProfile profile) {
		return agentForPlayer(profile.name())
				.filter(agent -> profile.id().equals(AgentIdentity.offlinePlayerUuid(agent.playerName())))
				.map(AgentControlAgent::displayName);
	}
}
