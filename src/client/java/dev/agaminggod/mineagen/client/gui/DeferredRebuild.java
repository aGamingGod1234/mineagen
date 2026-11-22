package dev.agaminggod.mineagen.client.gui;

/**
 * Holds widget rebuilds requested while an input event is being dispatched. Vanilla focuses the widget it just
 * clicked after the click handler returns, so rebuilding inside the handler left focus (and keys) on a discarded
 * widget. The screen wraps each click and key press in {@link #enter()}/{@link #exit()} and rebuilds once afterwards.
 */
final class DeferredRebuild {
	private int depth;
	private boolean pending;

	void enter() {
		depth++;
	}

	/** True when the rebuild may run now; false when it was queued until the current input finishes. */
	boolean request() {
		if (depth > 0) {
			pending = true;
			return false;
		}
		return true;
	}

	/** True when a rebuild was queued during the input that just finished and should run now. */
	boolean exit() {
		depth = Math.max(0, depth - 1);
		if (depth == 0 && pending) {
			pending = false;
			return true;
		}
		return false;
	}
}
