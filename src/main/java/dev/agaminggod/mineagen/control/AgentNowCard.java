package dev.agaminggod.mineagen.control;

import com.google.gson.JsonElement;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;

/**
 * What the control center's "Now" card says about one agent: its state and how long it has lasted, then what most
 * needs the player's eye (warnings, the last error), then what it is doing, its last decision and its queue. Rows are
 * in that order so a short card keeps the most important ones. Kept free of client types so it is verified headless.
 */
public final class AgentNowCard {
	/** Below this much model allowance left the card warns: a run that stops for allowance looks like a stuck bot. */
	public static final double ALLOWANCE_WARNING_PERCENT = 80.0D;

	public enum Kind { STATE, WARNING, ERROR, DOING, DECISION, QUEUED }

	public record Row(Kind kind, String label, String text, AgentControlPresentation.StateTone tone) {
		public Row {
			Objects.requireNonNull(kind, "kind must not be null");
			label = label == null ? "" : label;
			text = text == null ? "" : text;
			Objects.requireNonNull(tone, "tone must not be null");
		}
	}

	/** The parts of the coordinator's live task view the card reads; empty when none has arrived for this agent. */
	public record Live(String doing, String decision, double allowanceUsedPercent) {
		public static final Live NONE = new Live("", "", -1.0D);

		public Live {
			doing = doing == null ? "" : doing.trim();
			decision = decision == null ? "" : decision.trim();
		}

		/** Reads a view validated by {@link LiveTaskViewData#parse}; any shape it does not expect reads as absent. */
		public static Live from(JsonObject view) {
			if (view == null || view.size() == 0) return NONE;
			return new Live(doing(view), decision(view), allowance(view));
		}

		private static String doing(JsonObject view) {
			// The coordinator keeps a finished task's plan in the view with active=false: it is not what the bot is doing.
			JsonElement active = view.get("active");
			if (active != null && active.isJsonPrimitive() && active.getAsJsonPrimitive().isBoolean() && !active.getAsBoolean()) return "";
			JsonObject plan = object(view.get("plan"));
			if (plan == null || !plan.has("steps") || !plan.get("steps").isJsonArray()) return "";
			JsonObject pending = null;
			for (JsonElement element : plan.getAsJsonArray("steps")) {
				JsonObject step = object(element);
				if (step == null) continue;
				String status = string(step, "status");
				if (status.equals("active")) return stepText(step);
				if (pending == null && status.equals("pending")) pending = step;
			}
			return pending == null ? "" : stepText(pending);
		}

		private static String stepText(JsonObject step) {
			String label = string(step, "label"), detail = string(step, "detail");
			return detail.isBlank() ? label : label + ": " + detail;
		}

		private static String decision(JsonObject view) {
			JsonObject decision = object(view.get("decision"));
			if (decision == null) return "";
			String action = string(decision, "action"), purpose = string(decision, "purpose");
			if (action.isBlank()) return purpose;
			return purpose.isBlank() ? action : action + " (" + purpose + ")";
		}

		private static double allowance(JsonObject view) {
			JsonObject allowance = object(view.get("allowance"));
			if (allowance == null) return -1.0D;
			double used = -1.0D;
			for (var entry : allowance.entrySet()) {
				JsonObject window = object(entry.getValue());
				if (window == null || !window.has("usedPercent") || !window.get("usedPercent").isJsonPrimitive()) continue;
				try {
					double value = window.get("usedPercent").getAsDouble();
					if (Double.isFinite(value)) used = Math.max(used, value);
				} catch (RuntimeException ignored) {
					// not a number: no warning from this window
				}
			}
			return used;
		}

		private static JsonObject object(JsonElement element) {
			return element != null && element.isJsonObject() ? element.getAsJsonObject() : null;
		}

		private static String string(JsonObject object, String key) {
			JsonElement value = object.get(key);
			return value != null && value.isJsonPrimitive() && value.getAsJsonPrimitive().isString() ? value.getAsString().trim() : "";
		}
	}

	private AgentNowCard() {
	}

	/**
	 * The card's rows for {@code agent}, whose state has lasted {@code stateMs} (negative when unknown), most important
	 * first.
	 */
	public static List<Row> rows(AgentControlAgent agent, long stateMs, Live live) {
		Objects.requireNonNull(agent, "agent must not be null");
		Live view = live == null ? Live.NONE : live;
		List<Row> rows = new ArrayList<>();
		AgentControlPresentation.StateCue cue = AgentControlPresentation.stateCue(agent.state());
		String state = AgentControlPresentation.stateLabel(agent.state());
		rows.add(new Row(Kind.STATE, "", stateMs >= 0 ? state + " · " + duration(stateMs) : state, cue.tone()));
		boolean dead = cue == AgentControlPresentation.StateCue.DEAD;
		boolean offline = cue == AgentControlPresentation.StateCue.DISCONNECTED;
		boolean spawning = cue == AgentControlPresentation.StateCue.STARTING;
		// A dead, offline or still spawning agent has no body by design; any other state without one is worth a look.
		if (!agent.entityPresent() && !dead && !offline && !spawning) {
			rows.add(new Row(Kind.WARNING, "Warning", "Its body is not in the world", AgentControlPresentation.StateTone.PROBLEM));
		}
		if (view.allowanceUsedPercent() >= ALLOWANCE_WARNING_PERCENT) {
			rows.add(new Row(Kind.WARNING, "Warning", "Model allowance " + Math.round(Math.min(100.0D, view.allowanceUsedPercent())) + "% used",
					AgentControlPresentation.StateTone.PROBLEM));
		}
		if (!agent.lastError().isBlank()) {
			rows.add(new Row(Kind.ERROR, "Last error", agent.lastError(), AgentControlPresentation.StateTone.PROBLEM));
		}
		String doing = !view.doing().isBlank() ? view.doing() : agent.currentGoal();
		rows.add(new Row(Kind.DOING, "Doing", doing.isBlank() ? "No task right now" : doing, AgentControlPresentation.StateTone.NEUTRAL));
		String decision = !view.decision().isBlank() ? view.decision() : agent.lastSummary();
		if (!decision.isBlank()) rows.add(new Row(Kind.DECISION, "Last decision", decision, AgentControlPresentation.StateTone.NEUTRAL));
		if (agent.queuedGoalCount() > 0) {
			rows.add(new Row(Kind.QUEUED, "Queued", agent.queuedGoalCount() == 1 ? "1 more task" : agent.queuedGoalCount() + " more tasks",
					AgentControlPresentation.StateTone.NEUTRAL));
		}
		return List.copyOf(rows);
	}

	/** "12 s", "3 min", "1 h 5 min". */
	public static String duration(long ms) {
		long seconds = Math.max(0L, ms) / 1000L;
		if (seconds < 60) return seconds + " s";
		long minutes = seconds / 60;
		if (minutes < 60) return minutes + " min";
		long hours = minutes / 60, rest = minutes % 60;
		return rest == 0 ? hours + " h" : hours + " h " + rest + " min";
	}
}
