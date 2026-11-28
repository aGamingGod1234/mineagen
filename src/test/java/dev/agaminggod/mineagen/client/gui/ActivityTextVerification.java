package dev.agaminggod.mineagen.client.gui;

/** The live view's activity reads in words, from the coordinator's real event shapes, and never shows raw plumbing. */
final class ActivityTextVerification {
	private ActivityTextVerification() {
	}

	static int verify() {
		int checks = 0;
		checks += line("live_tool", "mine {\"x\":-121,\"y\":15,\"z\":52,\"expectedBlockId\":\"minecraft:iron_ore\",\"count\":2}", "Mining 2 iron ore");
		// The coordinator cuts tool text at 1200 characters, mid-JSON; what was read still makes a line.
		checks += line("live_tool", "mine {\"x\":-112,\"y\":16,\"z\":48,\"expectedBlockId\":\"minecraft:deepslate_iron_o", "Mining blocks");
		checks += line("live_tool", "act {\"actionType\":\"place_block\",\"arguments\":{\"itemId\":\"minecraft:torch\"}}", "Placing torch");
		checks += line("live_tool", "act {\"actionType\":\"craft\",\"arguments\":{\"itemId\":\"minecraft:iron_chestplate\"}}", "Crafting iron chestplate");
		checks += line("live_tool", "craft_item {\"itemId\":\"minecraft:furnace\"}", "Crafting furnace");
		checks += line("live_tool", "travelTo {\"x\":120,\"y\":64,\"z\":-30}", "Walking to 120, 64, -30");
		checks += line("live_tool", "lookAround {}", "Looking around");
		checks += line("live_tool", "dig_down {\"depth\":4}", "Digging down");
		checks += line("live_tool", "checkFurnace {}", "Check furnace");
		checks += line("agent_message", "Found a second iron vein", "Said: Found a second iron vein");
		checks += line("lifecycle", "Goal lifecycle operation 'start' accepted.", "Started a new task");
		checks += line("lifecycle", "Agent registered and ready.", "Joined the world");
		checks += line("retry", "Provider retry 1: request timed out", "Hit a snag, trying again");
		for (String stage : new String[] {"provider", "planner", "decision", "output", "provider_event", "native_turn", "status",
				"quality_first_message", "conversation", "usage", "something_new"}) {
			if (ActivityText.of(stage, "Planning request queued with high priority") != null) {
				throw new AssertionError("plumbing stage " + stage + " is dropped, not shown");
			}
			checks++;
		}
		if (ActivityText.of("live_tool", "say {\"text\":\"hi\"}") != null) throw new AssertionError("say is shown by its message, not its tool call");
		if (ActivityText.of("lifecycle", "Goal lifecycle operation 'rename' accepted.") != null) {
			throw new AssertionError("an unknown lifecycle line is dropped, not shown raw");
		}
		if (ActivityText.of("live_tool", "{\"broken\":") != null) throw new AssertionError("a tool line with no name is dropped");
		if (ActivityText.of("live_delta", "  ") != null) throw new AssertionError("an empty thought is dropped");
		ActivityText.Line thought = ActivityText.of("live_delta", "Torches are low");
		if (thought == null || thought.kind() != ActivityText.Kind.THOUGHT) throw new AssertionError("thinking reads as a thought");
		return checks + 5;
	}

	private static int line(String stage, String message, String expected) {
		ActivityText.Line line = ActivityText.of(stage, message);
		String actual = line == null ? null : line.text();
		if (!expected.equals(actual)) throw new AssertionError(stage + " " + message + ": expected=" + expected + ", actual=" + actual);
		return 1;
	}
}
