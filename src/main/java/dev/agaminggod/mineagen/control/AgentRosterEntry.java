package dev.agaminggod.mineagen.control;

public record AgentRosterEntry(
		String id,
		String name,
		String provider,
		String modelLabel,
		String state,
		boolean selectable,
		String unavailableReason,
		String lifecycleState
) {
	/** An entry whose raw lifecycle state is unknown: its state cue reads as unknown, never as a guess from the label. */
	public AgentRosterEntry(String id, String name, String provider, String modelLabel, String state, boolean selectable, String unavailableReason) {
		this(id, name, provider, modelLabel, state, selectable, unavailableReason, "");
	}

	public AgentRosterEntry {
		id = requiredId(id);
		name = normalized(name);
		provider = normalized(provider);
		modelLabel = normalized(modelLabel);
		state = normalized(state);
		unavailableReason = normalized(unavailableReason);
		lifecycleState = normalized(lifecycleState);
	}

	private static String requiredId(String value) {
		String normalized = normalized(value);
		if (normalized.isEmpty()) {
			throw new IllegalArgumentException("Agent roster ID must not be blank");
		}
		return normalized;
	}

	private static String normalized(String value) {
		return value == null ? "" : value.trim();
	}
}
