package dev.agaminggod.mineagen.server;

public enum CoordinatorRecoveryState {
	STARTING,
	AUTHENTICATING,
	HEALTHY,
	DEGRADED,
	BACKOFF,
	BLOCKED_RETRYABLE,
	STOPPED
}
