package dev.agaminggod.mineagen.server.runtime.reflex;

import dev.agaminggod.mineagen.protocol.ActionType;
import java.util.EnumSet;
import java.util.Map;
import java.util.Set;

/**
 * Follows the agent's own command for its reflexes, without a server. A yield asked of a held shield waits to see
 * whether the command only moves (then the two compose); a yielded stance comes back once the command has ended; an
 * action that bails out (fire, lava, low health) hands the body to the agent's rules at once.
 */
final class CommandFollower {
	static final Set<ActionType> MOVES_UNDER_HOLD = Set.copyOf(EnumSet.of(ActionType.MOVE_TO, ActionType.NAVIGATE_TO, ActionType.TRAVEL_TO,
			ActionType.FIGHT_TARGET, ActionType.FIGHT_UNTIL, ActionType.FOLLOW_ENTITY, ActionType.CONTROL, ActionType.CONTROL_SEQUENCE,
			ActionType.WAIT, ActionType.PICK_UP_ITEM, ActionType.SELECT_ITEM));
	/** An action that stops on these leaves the body to the model's reflexes instead of standing still until its turn. */
	static final Set<String> HANDOFF_CODES = Set.of("LOW_HEALTH_BAILOUT", "ON_FIRE", "IN_LAVA", "NAVIGATION_DAMAGED");
	/** Navigation failures a shelter's walk to its site ends on (as ServerNavigationController reports them). */
	private static final Set<String> APPROACH_FAILURES = Set.of("NO_STANDABLE_PATH", "NO_SEEN_ROUTE", "PATH_BLOCKED", "NO_PROGRESS",
			"REACHED_FRONTIER", "MISSED_LANDING", "DISPLACED", "ACTION_TIMEOUT", "LAVA_FLOW", "SNEAK_HOLDS_EDGE", "DESTINATION_NEAR_UNVERIFIED");
	/**
	 * Codes that hand off only for the action that stops on them: a travel stopped by danger, and a failed defence. Keyed by
	 * type because the same code ends ordinary work too (NO_STANDABLE_PATH ends navigation and pickup, HOSTILE_NEAR digging).
	 */
	static final Map<ActionType, Set<String>> HANDOFF_CODES_BY_TYPE = Map.of(
			ActionType.TRAVEL_TO, Set.of("TRAVEL_DAMAGED", "HOSTILE_NEAR"),
			ActionType.FLEE_FROM, Set.of("FLEE_BLOCKED", "FLEE_TIMED_OUT", "TARGET_GONE"),
			ActionType.BUILD_SHELTER, union(APPROACH_FAILURES, Set.of("SHELTER_TIMEOUT", "SHELTER_BLOCKED", "SNEAK_SHELTER_BLOCKED",
					"SHELTER_DISPLACED", "NO_TOOL", "TOOL_WORN", "ITEM_NOT_FOUND", "TARGET_OCCUPIED", "PROTECTION_DENIED")));

	private static Set<String> union(Set<String> first, Set<String> second) {
		java.util.HashSet<String> all = new java.util.HashSet<>(first);
		all.addAll(second);
		return Set.copyOf(all);
	}

	/** Whether an action of {@code type} that stopped on {@code code} hands the body to the agent's rules. */
	static boolean handsOff(ActionType type, String code) {
		if (code == null) return false;
		return HANDOFF_CODES.contains(code) || type != null && HANDOFF_CODES_BY_TYPE.getOrDefault(type, Set.of()).contains(code);
	}
	/** A yielded stance fires again once the body has been without an action this long after the model's command. */
	static final long IDLE_RESUME_TICKS = 10L;
	/** How long a yield waits for the model's command to start (a held shield). */
	static final long COMMAND_WAIT_TICKS = 20L;
	/**
	 * How long a yielded stance stays down with the body idle and the model's command not yet started. replace_action yields
	 * before its cancel, and the replacement starts only after the cancel's receipt; past this the command is taken to have
	 * never come (rejected, or a skill that needed no action) and the stance guards the idle body again.
	 */
	static final long REPLACEMENT_WAIT_TICKS = 20L;

	record Result(boolean yieldNow, boolean handedOff) {
		static final Result NONE = new Result(false, false);
	}

	/** The action running last tick, to see it end and how. */
	private String lastActionId;
	private long yieldRequestedAt = -1L;
	/** The action running when the model's command asked for the body: the one it replaces, never the command itself. */
	private String yieldBaselineActionId;
	private long yieldedAt = -1L;
	private boolean sawCommand;
	private long idleSince = -1L;

	/** A model command asks for the body; true means yield now, false means a held shield waits to see the command. */
	boolean requestYield(boolean heldPassesMovement, long now) {
		yieldBaselineActionId = lastActionId;
		if (!heldPassesMovement) return true;
		yieldRequestedAt = now;
		return false;
	}

	/**
	 * The firing was yielded: its stance stays down until the command ends (or its condition clears). The action the command
	 * replaces does not count as the command: the stance stays down through its cancel and the idle gap after it.
	 */
	void yielded(long now) {
		yieldRequestedAt = -1L;
		yieldedAt = now;
		sawCommand = false;
		idleSince = -1L;
	}

	/** As below, the finished action's type unknown (only the codes that hand off for any action count). */
	Result observe(ReflexScheduler scheduler, boolean heldPassesMovement, String activeId, ActionType activeType,
			String lastId, String lastReason, long now) {
		return observe(scheduler, heldPassesMovement, activeId, activeType, lastId, null, lastReason, now);
	}

	/**
	 * One tick. {@code activeId}/{@code activeType} name the running action (null when idle); {@code lastId},
	 * {@code lastType} and {@code lastReason} the latest finished one.
	 */
	Result observe(ReflexScheduler scheduler, boolean heldPassesMovement, String activeId, ActionType activeType,
			String lastId, ActionType lastType, String lastReason, long now) {
		boolean handedOff = false;
		if (activeId == null && lastActionId != null && lastActionId.equals(lastId) && handsOff(lastType, lastReason)) {
			scheduler.resume(now, true);
			yieldedAt = -1L;
			handedOff = true;
		}
		lastActionId = activeId;
		boolean yieldNow = false;
		if (yieldRequestedAt >= 0L) {
			boolean started = activeId != null && !activeId.equals(yieldBaselineActionId);
			if (!heldPassesMovement || now - yieldRequestedAt > COMMAND_WAIT_TICKS || started && movesUnderHold(activeType)) {
				yieldRequestedAt = -1L;
			} else if (started) {
				yieldNow = true;
			}
		}
		if (yieldedAt >= 0L) {
			if (activeId != null) {
				if (!movesUnderHold(activeType)) scheduler.suppressIdleShields();
				if (!activeId.equals(yieldBaselineActionId)) sawCommand = true;
				idleSince = -1L;
			} else {
				if (idleSince < 0L) idleSince = now;
				if (now - idleSince >= (sawCommand ? IDLE_RESUME_TICKS : REPLACEMENT_WAIT_TICKS)) scheduler.resume(now, false);
			}
			if (!scheduler.anySuppressed()) yieldedAt = -1L;
		}
		return yieldNow || handedOff ? new Result(yieldNow, handedOff) : Result.NONE;
	}

	static boolean movesUnderHold(dev.agaminggod.mineagen.server.runtime.ServerActionRequest request) {
		if (request == null || !movesUnderHold(request.type())) return false;
		var args = request.arguments();
		if (request.type() == ActionType.CONTROL) return !usesHands(args);
		if (request.type() == ActionType.CONTROL_SEQUENCE) {
			// Reserve the hands for the whole authored sequence, including later and branched frames.
			for (var frame : args.getAsJsonArray("frames")) if (usesHands(frame.getAsJsonObject())) return false;
		}
		return true;
	}

	private static boolean usesHands(com.google.gson.JsonObject frame) {
		return frame.has("attack") && frame.get("attack").getAsBoolean()
				|| frame.has("use") && frame.get("use").getAsBoolean();
	}

	static boolean movesUnderHold(ActionType type) {
		return type != null && MOVES_UNDER_HOLD.contains(type);
	}
}
