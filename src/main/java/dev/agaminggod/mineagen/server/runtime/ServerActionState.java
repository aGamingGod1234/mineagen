package dev.agaminggod.mineagen.server.runtime;

public enum ServerActionState {
	RUNNING,
	SUCCEEDED,
	FAILED,
	CANCELLED,
	TIMED_OUT;

	public boolean terminal() {
		return this != RUNNING;
	}
}
