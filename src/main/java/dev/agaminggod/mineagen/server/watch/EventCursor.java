package dev.agaminggod.mineagen.server.watch;

import dev.agaminggod.mineagen.server.runtime.reflex.ReflexScheduler;
import java.util.ArrayList;
import java.util.List;

/**
 * Which reflex scheduler events a reader has already taken. A replaced scheduler ({@code ReflexEngine.clearAll} or
 * {@code forget}) numbers its events from 1 again, so the cursor follows the scheduler's generation, not only its
 * sequence: a new scheduler that already reached the old sequence before the next read would otherwise lose its events.
 */
final class EventCursor {
	private long generation;
	private long sequence;

	/** The events not yet taken, in order; moves the cursor past them. */
	List<ReflexScheduler.Event> fresh(long generation, List<ReflexScheduler.Event> events) {
		if (events.isEmpty()) return List.of();
		if (generation != this.generation) {
			this.generation = generation;
			sequence = 0L;
		}
		List<ReflexScheduler.Event> fresh = new ArrayList<>();
		for (ReflexScheduler.Event event : events) {
			if (event.sequence() <= sequence) continue;
			sequence = event.sequence();
			fresh.add(event);
		}
		return fresh;
	}

	long sequence() {
		return sequence;
	}
}
