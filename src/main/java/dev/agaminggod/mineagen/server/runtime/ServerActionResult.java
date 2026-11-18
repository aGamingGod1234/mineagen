package dev.agaminggod.mineagen.server.runtime;

import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.protocol.ActionType;
import java.util.Objects;

public record ServerActionResult(
		AgentId agentId,
		long goalRevision,
	String actionId,
	ActionType actionType,
	String traceId,
	ServerActionState state,
		String reasonCode,
		String message,
		long elapsedMs,
	long observedAtEpochMs,
	boolean executionStarted,
	boolean physicalAttempted,
	ServerActionObservation actionObservation,
	BreakOutcomeEvidence.Summary breakOutcome,
	String cause,
	PausedBy pausedBy
) {
	/** Reflex firings that paused this action: each rule with how often, total paused game time, resumes, and whether it ended paused. */
	public record PausedBy(java.util.List<Rule> rules, long ms, int resumes, boolean endedPaused) {
		public record Rule(String id, int times) {
			public Rule {
				Objects.requireNonNull(id, "id must not be null");
				if (id.isBlank() || id.length() > 128 || times < 1) throw new IllegalArgumentException("pausedBy rule must be named and paused at least once");
			}
		}

		public PausedBy {
			rules = java.util.List.copyOf(rules);
			if (rules.isEmpty() || rules.size() > 32 || ms < 0L || resumes < 0) throw new IllegalArgumentException("pausedBy needs 1..32 rules and nonnegative counts");
		}
	}

	public ServerActionResult {
		Objects.requireNonNull(agentId, "agentId must not be null");
		Objects.requireNonNull(actionId, "actionId must not be null");
		Objects.requireNonNull(actionType, "actionType must not be null");
		if (traceId != null && (traceId.isBlank() || traceId.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 128
				|| traceId.codePoints().anyMatch(codePoint -> codePoint < 0x20 || codePoint == 0x7f))) {
			throw new IllegalArgumentException("traceId must be nonblank and at most 128 UTF-8 bytes");
		}
		Objects.requireNonNull(state, "state must not be null");
		if (!state.terminal()) {
			throw new IllegalArgumentException("Result state must be terminal");
		}
		if (physicalAttempted && !executionStarted) {
			throw new IllegalArgumentException("physicalAttempted requires executionStarted");
		}
		if (cause != null && (actionType != ActionType.PLACE_BLOCK || state == ServerActionState.SUCCEEDED
				|| cause.isBlank() || cause.length() > 128)) {
			throw new IllegalArgumentException("cause requires an unsuccessful placement and at most 128 nonblank characters");
		}
		reasonCode = bounded(reasonCode, 128);
		message = bounded(message, 2_048);
		if (elapsedMs < 0L || observedAtEpochMs <= 0L) {
			throw new IllegalArgumentException("Result timestamps are invalid");
		}
	}

	public ServerActionResult(AgentId agentId, long goalRevision, String actionId, ActionType actionType, String traceId,
			ServerActionState state, String reasonCode, String message, long elapsedMs, long observedAtEpochMs,
			boolean executionStarted, boolean physicalAttempted, ServerActionObservation actionObservation,
			BreakOutcomeEvidence.Summary breakOutcome, String cause) {
		this(agentId, goalRevision, actionId, actionType, traceId, state, reasonCode, message, elapsedMs, observedAtEpochMs,
				executionStarted, physicalAttempted, actionObservation, breakOutcome, cause, null);
	}

	public ServerActionResult withPausedBy(PausedBy value) {
		return new ServerActionResult(agentId, goalRevision, actionId, actionType, traceId, state, reasonCode, message,
				elapsedMs, observedAtEpochMs, executionStarted, physicalAttempted, actionObservation, breakOutcome, cause, value);
	}

	/** Preserve callers without a placement cause. */
	public ServerActionResult(AgentId agentId, long goalRevision, String actionId, ActionType actionType, String traceId,
			ServerActionState state, String reasonCode, String message, long elapsedMs, long observedAtEpochMs,
			boolean executionStarted, boolean physicalAttempted, ServerActionObservation actionObservation,
			BreakOutcomeEvidence.Summary breakOutcome) {
		this(agentId, goalRevision, actionId, actionType, traceId, state, reasonCode, message, elapsedMs, observedAtEpochMs,
				executionStarted, physicalAttempted, actionObservation, breakOutcome, null);
	}

	public ServerActionResult withCause(String cause) {
		return new ServerActionResult(agentId, goalRevision, actionId, actionType, traceId, state, reasonCode, message,
				elapsedMs, observedAtEpochMs, executionStarted, physicalAttempted, actionObservation, breakOutcome, cause, pausedBy);
	}

	/** Results without break evidence. */
	public ServerActionResult(
			AgentId agentId, long goalRevision, String actionId, ActionType actionType, String traceId, ServerActionState state,
			String reasonCode, String message, long elapsedMs, long observedAtEpochMs, boolean executionStarted, boolean physicalAttempted,
			ServerActionObservation actionObservation
	) {
		this(agentId, goalRevision, actionId, actionType, traceId, state, reasonCode, message, elapsedMs, observedAtEpochMs,
				executionStarted, physicalAttempted, actionObservation, null);
	}

	public ServerActionResult(
			AgentId agentId, long goalRevision, String actionId, ActionType actionType,
			ServerActionState state, String reasonCode, String message, long elapsedMs, long observedAtEpochMs
	) {
		this(agentId, goalRevision, actionId, actionType, null, state, reasonCode, message, elapsedMs, observedAtEpochMs, false, false, null);
	}

	public ServerActionResult(
			AgentId agentId, long goalRevision, String actionId, ActionType actionType,
			String traceId, ServerActionState state, String reasonCode, String message, long elapsedMs, long observedAtEpochMs
	) {
		this(agentId, goalRevision, actionId, actionType, traceId, state, reasonCode, message, elapsedMs, observedAtEpochMs, false, false, null);
	}

	public ServerActionResult(
			AgentId agentId, long goalRevision, String actionId, ActionType actionType,
			String traceId, ServerActionState state, String reasonCode, String message,
			long elapsedMs, long observedAtEpochMs, boolean executionStarted, boolean physicalAttempted
	) {
		this(agentId, goalRevision, actionId, actionType, traceId, state, reasonCode, message,
				elapsedMs, observedAtEpochMs, executionStarted, physicalAttempted, null);
	}

	private static String bounded(String value, int maximum) {
		String safe = value == null ? "" : value;
		return safe.length() <= maximum ? safe : safe.substring(0, maximum);
	}
}
