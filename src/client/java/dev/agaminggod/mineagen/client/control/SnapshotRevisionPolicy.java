package dev.agaminggod.mineagen.client.control;

import dev.agaminggod.mineagen.control.AgentControlSnapshot;
import java.util.Objects;

public final class SnapshotRevisionPolicy {
	private SnapshotRevisionPolicy() {
	}

	public static boolean isNewer(AgentControlSnapshot current, AgentControlSnapshot candidate) {
		Objects.requireNonNull(candidate, "candidate snapshot must not be null");
		return current == null || candidate.generatedAtEpochMs() > current.generatedAtEpochMs();
	}
}
