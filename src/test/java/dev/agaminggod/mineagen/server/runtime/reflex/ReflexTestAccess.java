package dev.agaminggod.mineagen.server.runtime.reflex;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import java.util.List;
import java.util.Set;

public final class ReflexTestAccess {
	private ReflexTestAccess() {
	}

	public static GridPosition newFlow(List<GridPosition> ahead, Set<GridPosition> accepted, Set<GridPosition> flows) {
		return ReflexActions.PathWalk.newFlow(ahead, accepted, flows);
	}
}
