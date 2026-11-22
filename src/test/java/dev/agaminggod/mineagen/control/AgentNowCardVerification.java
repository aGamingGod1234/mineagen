package dev.agaminggod.mineagen.control;

import com.google.gson.JsonParser;
import java.util.List;

/** The control center's Now card says what the agent is doing and why it stopped, most important first. */
public final class AgentNowCardVerification {
	private static final String ID = "12345678-1234-5678-9abc-123456789abc";

	private AgentNowCardVerification() {
	}

	public static int verify() {
		int assertions = 0;
		// A thinking agent with a plan, a decision and a queue: state with duration, then doing, decision, queue.
		AgentNowCard.Live live = AgentNowCard.Live.from(JsonParser.parseString("""
				{"plan":{"steps":[{"id":"a","label":"Get wood","detail":"","status":"complete"},
				{"id":"b","label":"Mine iron","detail":"cave north of spawn","status":"active"},
				{"id":"c","label":"Smelt iron","detail":"","status":"pending"}]},
				"decision":{"action":"travel_to the cave","purpose":"iron for a pickaxe","reasoning":null},
				"allowance":{"five_hour":{"usedPercent":42.0,"windowDurationMins":300}}}""").getAsJsonObject());
		List<AgentNowCard.Row> thinking = AgentNowCard.rows(agent("PLANNING", "Beat the game", 2, "", "", true), 40_000L, live);
		assertEquals(List.of(AgentNowCard.Kind.STATE, AgentNowCard.Kind.DOING, AgentNowCard.Kind.DECISION, AgentNowCard.Kind.QUEUED),
				thinking.stream().map(AgentNowCard.Row::kind).toList(), "a healthy thinking agent: state, doing, decision, queue");
		assertEquals("Thinking... · 40 s", thinking.get(0).text(), "the state says how long it has lasted");
		assertEquals(AgentControlPresentation.StateTone.ACTIVE, thinking.get(0).tone(), "thinking is not drawn as a problem");
		assertEquals("Mine iron: cave north of spawn", thinking.get(1).text(), "doing is the active plan step, not the whole goal");
		assertEquals("travel_to the cave (iron for a pickaxe)", thinking.get(2).text(), "the last decision with its purpose");
		assertEquals("2 more tasks", thinking.get(3).text(), "the queue is counted");
		assertions += 6;

		// A stuck agent: its warnings and last error come before what it was doing, so a short card keeps them.
		AgentNowCard.Live spent = AgentNowCard.Live.from(JsonParser.parseString(
				"{\"plan\":null,\"allowance\":{\"week\":{\"usedPercent\":97.4,\"windowDurationMins\":null},\"day\":{\"usedPercent\":12.0,\"windowDurationMins\":1440}}}").getAsJsonObject());
		List<AgentNowCard.Row> stuck = AgentNowCard.rows(agent("ERROR", "Beat the game", 0, "Provider session ended", "", false), 125_000L, spent);
		assertEquals(List.of(AgentNowCard.Kind.STATE, AgentNowCard.Kind.WARNING, AgentNowCard.Kind.WARNING, AgentNowCard.Kind.ERROR, AgentNowCard.Kind.DOING),
				stuck.stream().map(AgentNowCard.Row::kind).toList(), "warnings and the error come before doing");
		assertEquals("Needs attention · 2 min", stuck.get(0).text(), "minutes past a minute");
		assertEquals("Its body is not in the world", stuck.get(1).text(), "a missing body is warned about");
		assertEquals("Model allowance 97% used", stuck.get(2).text(), "the most-used allowance window is warned about");
		assertEquals("Provider session ended", stuck.get(3).text(), "the last error is shown");
		assertEquals("Beat the game", stuck.get(4).text(), "with no plan, doing is the task");
		for (AgentNowCard.Row row : stuck.subList(0, 4)) {
			assertEquals(AgentControlPresentation.StateTone.PROBLEM, row.tone(), row.kind() + " is drawn as a problem");
		}
		assertions += 10;

		// Dead, offline and spawning agents have no body by design: no warning. Without a live view the summary stands in.
		for (String state : List.of("DEAD", "DISCONNECTED", "STARTING")) {
			List<AgentNowCard.Row> rows = AgentNowCard.rows(agent(state, "", 0, "", "Reached the cave", false), -1L, null);
			assertTrue(rows.stream().noneMatch(row -> row.kind() == AgentNowCard.Kind.WARNING), state + " without a body is not warned about");
			assertEquals(AgentControlPresentation.stateLabel(state), rows.get(0).text(), state + " with no known duration shows only its label");
			assertEquals("No task right now", rows.get(1).text(), state + " with no task says so");
			assertEquals("Reached the cave", rows.get(2).text(), state + " without a live view shows its last summary as the decision");
			assertions += 4;
		}
		List<AgentNowCard.Row> idle = AgentNowCard.rows(agent("IDLE", "", 0, "", "", true), 5_000L, AgentNowCard.Live.NONE);
		assertEquals(2, idle.size(), "an idle agent with nothing to report shows its state and that it has no task");
		assertions++;

		// A view shape it does not expect reads as absent rather than failing the screen.
		AgentNowCard.Live odd = AgentNowCard.Live.from(JsonParser.parseString(
				"{\"plan\":{\"steps\":[7,{\"label\":3}]},\"decision\":\"nope\",\"allowance\":{\"x\":{\"usedPercent\":\"high\"}}}").getAsJsonObject());
		assertEquals(AgentNowCard.Live.NONE, odd, "an unexpected live view reads as no live view");
		assertEquals(AgentNowCard.Live.NONE, AgentNowCard.Live.from(null), "no live view reads as none");
		AgentNowCard.Live pendingOnly = AgentNowCard.Live.from(JsonParser.parseString(
				"{\"plan\":{\"steps\":[{\"label\":\"Craft a table\",\"detail\":\"\",\"status\":\"pending\"}]}}").getAsJsonObject());
		assertEquals("Craft a table", pendingOnly.doing(), "with no active step, doing is the first pending one");
		AgentNowCard.Live finished = AgentNowCard.Live.from(JsonParser.parseString(
				"{\"active\":false,\"plan\":{\"steps\":[{\"label\":\"Mine iron\",\"detail\":\"\",\"status\":\"active\"}]}}").getAsJsonObject());
		assertEquals("", finished.doing(), "a finished task's leftover plan step is not what the bot is doing");
		assertions += 4;

		assertEquals("0 s", AgentNowCard.duration(0L), "zero");
		assertEquals("59 s", AgentNowCard.duration(59_999L), "seconds below a minute");
		assertEquals("1 min", AgentNowCard.duration(60_000L), "a minute");
		assertEquals("1 h", AgentNowCard.duration(3_600_000L), "an hour");
		assertEquals("2 h 5 min", AgentNowCard.duration(7_500_000L), "hours and minutes");
		assertEquals("0 s", AgentNowCard.duration(-5L), "a clock step back is not negative");
		return assertions + 6 + verifyStateClock();
	}

	/** A duration is shown only for a state change this client watched without a break. */
	private static int verifyStateClock() {
		AgentStateClock clock = new AgentStateClock();
		clock.observe(ID, "PLANNING", 0L);
		assertEquals(-1L, clock.durationMs(ID, "PLANNING", 0L), "a state first seen mid-way has no known start");
		clock.observe(ID, "ACTING", 1_000L);
		clock.observe(ID, "ACTING", 2_000L);
		assertEquals(1_500L, clock.durationMs(ID, "ACTING", 2_500L), "a watched change starts the clock");
		clock.observe(ID, "PLANNING", 3_000L);
		assertEquals(500L, clock.durationMs(ID, "PLANNING", 3_500L), "the next watched change restarts it");
		// The player looks away for a minute; the bot may have acted and planned again unseen.
		clock.observe(ID, "PLANNING", 63_000L);
		assertEquals(-1L, clock.durationMs(ID, "PLANNING", 63_000L), "after a gap the duration is unknown, not a minute");
		clock.observe(ID, "ACTING", 64_000L);
		assertEquals(0L, clock.durationMs(ID, "ACTING", 64_000L), "until the next watched change");
		assertEquals(-1L, clock.durationMs(ID, "PLANNING", 64_000L), "a state the agent is no longer in has no duration");
		assertEquals(-1L, clock.durationMs("other", "ACTING", 64_000L), "an agent never seen has none");
		clock.observe(ID, "ACTING", 60_000L);
		assertEquals(-1L, clock.durationMs(ID, "ACTING", 60_000L), "a clock stepping back loses the thread");
		AgentStateClock all = new AgentStateClock();
		all.observe(List.of(agent("IDLE", "", 0, "", "", true)), 0L);
		all.observe(List.of(agent("ACTING", "", 0, "", "", true)), 1_000L);
		assertEquals(2_000L, all.durationMs(ID, "ACTING", 3_000L), "observing a snapshot tracks its agents");
		return 9;
	}

	private static AgentControlAgent agent(String state, String goal, int queued, String error, String summary, boolean body) {
		return new AgentControlAgent(ID, ID.substring(0, 8), "Rook", "codex", "gpt-5.6-sol", "high", "Rook_" + ID.substring(0, 8),
				0, state, goal, queued, summary, error, false, body);
	}

	private static void assertTrue(boolean actual, String label) {
		if (!actual) throw new AssertionError(label);
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!java.util.Objects.equals(expected, actual)) throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
	}
}
