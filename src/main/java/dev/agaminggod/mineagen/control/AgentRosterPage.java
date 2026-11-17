package dev.agaminggod.mineagen.control;

import java.util.List;

public record AgentRosterPage(
		List<AgentRosterEntry> entries,
		int firstIndex,
		int lastIndex,
		int totalFiltered,
		int page,
		int pageCount,
		int hiddenSelectedCount
) {
	public AgentRosterPage {
		entries = List.copyOf(entries);
	}
}
