package dev.agaminggod.mineagen.server;

public final class AgentChatSanitizerVerification {
	private AgentChatSanitizerVerification() {
	}

	public static void main(String[] args) {
		System.out.println("Agent chat sanitizer verification passed: " + verify() + " assertions");
	}

	public static int verify() {
		verifyTechnicalTextIsHidden();
		return 21;
	}

	private static void verifyTechnicalTextIsHidden() {
		for (String technical : new String[] {
			"native:item/completed actionId=move-7",
			"Provider chunk native:item/completed",
			"trace 123e4567-e89b-12d3-a456-426614174000 finished",
			"trace 00000000-0000-0000-0000-000000000000 finished",
			"{\"type\":\"tool_call\",\"callId\":\"call-1\"}",
			"Result payload {\"action\":\"move-7\"}",
			"tool call action_id=mine-4",
			"Action ID: action-progress-1",
			"call_id=call_abc123",
			"ArenaScript dispatched action-progress-1",
			"Completed program-1-1:1:1:arena-state-1",
			"Completed agent-a:1:1:1:program-1-1:1:1:arena-state-1",
			"Completed program-1-1:1:1:step-7",
			"Completed trace-agent-a-1-1-initial",
			"Result payload [1,2,3]",
			"Result payload [{\"action\":\"move-7\"}]"
		}) {
			assertEquals("Technical details hidden.", AgentChatSanitizer.sanitizeMessage(technical),
					"technical provider and action records never reach player chat");
		}
		assertEquals("I will collect wood, then craft tools.",
				AgentChatSanitizer.sanitizeMessage("I will collect wood, then craft tools."),
				"ordinary public summaries remain readable");
		for (String ordinary : new String[] {
			"Take an action-oriented approach and wait.",
			"Make a call-back plan before nightfall.",
			"Trace-based planning is useful.",
			"Use [the east entrance] and wait."
		}) {
			assertEquals(ordinary, AgentChatSanitizer.sanitizeMessage(ordinary),
					"ordinary prose that resembles a technical prefix remains readable");
		}
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
	}
}
