package dev.agaminggod.mineagen.protocol;

public enum ActionState {
	RUNNING(false),
	SUCCEEDED(true),
	FAILED(true),
	CANCELLED(true),
	TIMED_OUT(true);

	private final boolean terminal;

	ActionState(boolean terminal) {
		this.terminal = terminal;
	}

	public boolean isTerminal() {
		return terminal;
	}
}
