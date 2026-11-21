package dev.agaminggod.mineagen.server;

import dev.agaminggod.mineagen.control.AgentControlRedaction;
import dev.agaminggod.mineagen.control.AgentControlSnapshot;
import java.util.List;

public final class CoordinatorExhaustedStatusSnapshotVerification {
	private CoordinatorExhaustedStatusSnapshotVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		System.out.println("PASS: " + verify() + " exhausted status snapshot assertions");
	}

	public static int verify() throws Exception {
		var statusMethod = Class.forName("dev.agaminggod.mineagen.server.AgentServerRuntime")
				.getDeclaredMethod("startupFailureStatus", String.class);
		statusMethod.setAccessible(true);
		String status = (String) statusMethod.invoke(null, "COORDINATOR_RESTART_EXHAUSTED");
		int assertions = 0;
		for (boolean canControl : List.of(false, true)) {
			// Match the publisher: construction must succeed before redaction can bound fields.
			AgentControlSnapshot snapshot = AgentControlRedaction.forViewer(AgentControlSnapshot.fromRecords(
					canControl, false, status, 1L, List.of(), List.of(), List.of(), ignored -> false));
			assertTrue(snapshot.automationStatus().equals(status), "the complete failure status survives publication");
			assertTrue(!snapshot.automationAvailable(), "exhausted coordinator remains unavailable");
			assertTrue(snapshot.canControl() == canControl, "viewer permissions survive publication");
			assertions += 3;
		}
		assertTrue(status.contains(CoordinatorLaunchPolicy.EXHAUSTED_RETRY_MS / 60_000L + " minutes"),
				"status explains the current slow retry interval");
		assertTrue(status.contains("coordinator error log"), "status points to diagnostic logs");
		assertTrue(status.contains("runtime/config") && status.contains("restart Minecraft"),
				"status retains recovery guidance");
		assertions += 3;
		// Every startup failure must fit the snapshot, or the control center never leaves "Syncing".
		for (String code : List.of("NODE_RUNTIME_NOT_FOUND", "NODE_RUNTIME_RECOVERY_FAILED",
				"BRIDGE_SECRET_PATH_CONFLICT", "COORDINATOR_RESTART_EXHAUSTED", "UNKNOWN_FAILURE")) {
			String failure = (String) statusMethod.invoke(null, code);
			AgentControlSnapshot snapshot = AgentControlSnapshot.fromRecords(
					true, false, failure, 1L, List.of(), List.of(), List.of(), ignored -> false);
			assertTrue(snapshot.automationStatus().equals(failure), code + " status survives publication");
			assertions++;
		}
		String node = (String) statusMethod.invoke(null, "NODE_RUNTIME_NOT_FOUND");
		assertTrue(node.contains("Node.js 22+") && node.contains("mineagen.nodePath"), "Node status keeps its fix");
		return assertions + 1;
	}

	private static void assertTrue(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
