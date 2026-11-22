package dev.agaminggod.mineagen.control;

import dev.agaminggod.mineagen.agent.AgentModelNames;
import java.util.Locale;
import java.util.Objects;

public final class AgentControlPresentation {
	private AgentControlPresentation() {
	}

	public static String stateLabel(String state) {
		return switch (Objects.requireNonNull(state, "state must not be null").toUpperCase(Locale.ROOT)) {
			case "IDLE" -> "Ready";
			case "STARTING" -> "Starting up...";
			case "PLANNING" -> "Thinking...";
			case "ACTING" -> "Working";
			case "PAUSED" -> "Paused";
			case "COMPLETED" -> "Task complete";
			case "ERROR" -> "Needs attention";
			case "DEAD" -> "Dead - ready to respawn";
			case "DISCONNECTED" -> "Disconnected";
			default -> "Unknown";
		};
	}

	/** The colour family a state is drawn in. */
	public enum StateTone { POSITIVE, ACTIVE, PROBLEM, NEUTRAL }

	/**
	 * How a lifecycle state reads at a glance, chosen from the raw state (never from its label text), so the roster tile
	 * and the selected-agent panel always agree.
	 */
	public enum StateCue {
		READY(StateTone.POSITIVE),
		STARTING(StateTone.ACTIVE),
		THINKING(StateTone.ACTIVE),
		WORKING(StateTone.ACTIVE),
		PAUSED(StateTone.ACTIVE),
		DONE(StateTone.POSITIVE),
		NEEDS_ATTENTION(StateTone.PROBLEM),
		DEAD(StateTone.PROBLEM),
		DISCONNECTED(StateTone.PROBLEM),
		UNKNOWN(StateTone.NEUTRAL);

		private final StateTone tone;

		StateCue(StateTone tone) {
			this.tone = tone;
		}

		public StateTone tone() {
			return tone;
		}
	}

	public static StateCue stateCue(String state) {
		return switch (state == null ? "" : state.trim().toUpperCase(Locale.ROOT)) {
			case "IDLE" -> StateCue.READY;
			case "STARTING" -> StateCue.STARTING;
			case "PLANNING" -> StateCue.THINKING;
			case "ACTING" -> StateCue.WORKING;
			case "PAUSED" -> StateCue.PAUSED;
			case "COMPLETED" -> StateCue.DONE;
			case "ERROR" -> StateCue.NEEDS_ATTENTION;
			case "DEAD" -> StateCue.DEAD;
			case "DISCONNECTED" -> StateCue.DISCONNECTED;
			default -> StateCue.UNKNOWN;
		};
	}

	public static String profileLabel(AgentControlAgent agent) {
		Objects.requireNonNull(agent, "agent must not be null");
		return AgentModelNames.displayName(agent.provider(), agent.model()) + " | " + capitalize(agent.reasoning());
	}

	public static String speedLabel(String serviceTier) {
		String value = Objects.requireNonNull(serviceTier, "serviceTier must not be null");
		return switch (value.toLowerCase(Locale.ROOT)) {
			case "fast" -> "Fast mode";
			case "priority", "default" -> "Normal";
			default -> capitalize(value);
		};
	}

	/** Codex "priority" is its Fast tier (increased usage), unlike the other providers' normal "priority". */
	public static String speedLabel(String provider, String serviceTier) {
		String value = Objects.requireNonNull(serviceTier, "serviceTier must not be null");
		if ("codex".equalsIgnoreCase(provider) && value.equalsIgnoreCase("priority")) return "Priority (Fast)";
		return speedLabel(value);
	}

	private static String capitalize(String value) {
		if (value == null || value.isBlank()) return "";
		return Character.toUpperCase(value.charAt(0)) + value.substring(1).toLowerCase(Locale.ROOT);
	}
}
