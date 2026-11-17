package dev.agaminggod.mineagen.control;

import dev.agaminggod.mineagen.agent.AgentGoal;
import dev.agaminggod.mineagen.agent.AgentGameMode;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.agent.AgentLifecycleState;
import dev.agaminggod.mineagen.agent.AgentProfile;
import dev.agaminggod.mineagen.agent.AgentRecord;
import dev.agaminggod.mineagen.agent.AgentRegistry;
import dev.agaminggod.mineagen.agent.RespawnPolicy;
import java.util.List;
import java.util.Optional;
import java.util.UUID;

public final class AgentControlVerification {
	private static final long NOW_EPOCH_MS = 1_750_000_000_000L;
	private static final String AGENT_UUID = "12345678-1234-5678-9abc-123456789abc";

	private AgentControlVerification() {
	}

	public static int verify() {
		int assertions = 0;
		assertions += verifySnapshotRoundTripAndBounds();
		assertions += verifyAggregateCapacity();
		assertions += verifyProviderPresets();
		assertions += verifyRuntimeCatalogBecomesAuthoritative();
		assertions += verifyCommandConstruction();
		assertions += verifySelectionStability();
		assertions += verifyActionSafety();
		assertions += verifySnapshotOrdering();
		return assertions;
	}

	private static int verifySnapshotRoundTripAndBounds() {
		AgentRecord record = new AgentRecord(
				1,
				new AgentId(UUID.fromString(AGENT_UUID)),
				Optional.of(UUID.fromString("aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee")),
				Optional.empty(),
				new AgentProfile("claude", "claude-sonnet-5-5", "high", Optional.of("Builder"), 2),
				AgentLifecycleState.ACTING,
				Optional.of(AgentGoal.create("Build a safe house", NOW_EPOCH_MS)),
				3L,
				List.of(AgentGoal.create("Collect food", NOW_EPOCH_MS)),
				"Placed the foundation",
				"",
				false,
				RespawnPolicy.PAUSE_UNTIL_RESPAWN,
				Optional.empty(),
				NOW_EPOCH_MS,
				NOW_EPOCH_MS,
				""
		);
		AgentControlSnapshot snapshot = AgentControlSnapshot.fromRecords(true, NOW_EPOCH_MS, List.of(record));
		AgentControlSnapshot decoded = AgentControlSnapshotCodec.decode(AgentControlSnapshotCodec.encode(snapshot));
		AgentControlSnapshotPayload outboundPayload = AgentControlSnapshotPayload.fromSnapshot(snapshot);
		assertTrue(outboundPayload.snapshot() == snapshot, "trusted outbound snapshots skip a JSON parse");
		AgentControlSnapshotPayload inboundPayload = new AgentControlSnapshotPayload(outboundPayload.encodedSnapshot());
		assertTrue(inboundPayload.snapshot() == inboundPayload.snapshot(), "validated inbound snapshots are parsed once");
		// Valid multibyte JSON on both sides: only the final whitespace byte differs.
		String valid = outboundPayload.encodedSnapshot();
		String multibyte = valid.substring(0, valid.length() - 1) + ",\"padding\":\"" + "\u00e9".repeat(100) + "\"}";
		String atLimit = multibyte + " ".repeat(AgentControlSnapshotCodec.MAX_ENCODED_BYTES
				- multibyte.getBytes(java.nio.charset.StandardCharsets.UTF_8).length);
		assertEquals(snapshot, AgentControlSnapshotCodec.decode(atLimit), "exact UTF-8 byte boundary accepts valid JSON");
		assertTrue(atLimit.length() < AgentControlSnapshotCodec.MAX_ENCODED_BYTES, "byte and character lengths differ");
		expectFailure(() -> AgentControlSnapshotCodec.decode(atLimit + " "), "otherwise-valid JSON exceeds byte limit");
		AgentControlAgent agent = decoded.agents().getFirst();

		assertEquals(snapshot, decoded, "snapshot JSON round trip");
		assertEquals(AGENT_UUID, agent.agentId(), "snapshot carries stable full agent ID");
		assertEquals("Builder", agent.displayName(), "snapshot carries optional user name");
		AgentRegistry registry = AgentRegistry.createDefault(() -> { }, transition -> { });
		AgentRecord sol = registry.create("codex", "gpt-6.1-sol", "medium", Optional.empty(), NOW_EPOCH_MS);
		AgentControlAgent solView = AgentControlSnapshot.fromRecords(true, NOW_EPOCH_MS, List.of(sol)).agents().getFirst();
		assertEquals("GPT-6.1 Sol", solView.displayName(), "world label uses the readable model name");
		assertEquals("GPT_6_1_Sol", solView.playerName(), "Minecraft keeps its safe technical username");
		assertEquals(Optional.of("GPT-6.1 Sol"), AgentWorldNamePolicy.tag(solView),
				"the actual allocated profile reaches the renderer with punctuation intact");
		AgentRecord secondSol = registry.create("codex", "gpt-6.1-sol", "medium", Optional.empty(), NOW_EPOCH_MS);
		AgentControlAgent secondView = AgentControlSnapshot.fromRecords(true, NOW_EPOCH_MS, List.of(secondSol)).agents().getFirst();
		assertEquals("GPT-6.1 Sol 2", secondView.displayName(), "allocated collisions remain distinct readable labels");
		assertEquals("GPT_6_1_Sol2", secondView.playerName(), "allocated collisions keep their existing command handle");
		assertEquals(Optional.of("Builder"), AgentWorldNamePolicy.tag(agent),
				"world tags use the exact public name without a provider glyph or model suffix");
		assertEquals(Optional.empty(), AgentWorldNamePolicy.tag(agent(AGENT_UUID, "   ")),
				"blank display names omit the world tag");
		assertEquals("Build a safe house", agent.currentGoal(), "snapshot carries active goal");
		assertEquals(1, agent.queuedGoalCount(), "snapshot carries queue count");
		assertEquals(false, agent.automaticProgress(), "snapshot carries automatic progress preference");
		assertTrue(agent.entityPresent(), "snapshot carries entity presence");
		assertTrue(decoded.automationAvailable(), "legacy ready snapshot reports available automation");
		assertEquals("Automation ready", decoded.automationStatus(), "snapshot carries a human-readable readiness message");
		var legacy = com.google.gson.JsonParser.parseString(AgentControlSnapshotCodec.encode(snapshot)).getAsJsonObject();
		legacy.add("groups", com.google.gson.JsonParser.parseString("[{\"name\":\"Builders\",\"memberIds\":[\"" + AGENT_UUID + "\"]}]"));
		assertEquals(snapshot, AgentControlSnapshotCodec.decode(legacy.toString()),
				"old snapshots load with saved groups dropped");
		assertTrue(!AgentControlSnapshotCodec.encode(snapshot).contains("\"groups\""),
				"new snapshots carry no group data");
		expectFailure(() -> AgentControlSnapshotCodec.decode("{\"schemaVersion\":999}"), "unsupported snapshot schema");
		expectFailure(
				() -> new AgentControlSnapshot(true, NOW_EPOCH_MS, java.util.Collections.nCopies(17, agent)),
				"snapshot agent bound"
		);
		return 22;
	}

	private static int verifyAggregateCapacity() {
		var agents = new java.util.ArrayList<AgentControlAgent>();
		for (int i = 0; i < 16; i++) {
			String id = new UUID(0, i + 1).toString();
			agents.add(new AgentControlAgent(id, id.substring(0, 8), "<".repeat(160), "<".repeat(32),
					"<".repeat(64), "<".repeat(128), "<".repeat(64), "<".repeat(16), 0,
					"<".repeat(32), "<".repeat(512), 32, "<".repeat(512), "<".repeat(256), true, true));
		}
		var efforts = java.util.stream.IntStream.range(0, 12).mapToObj(i -> "<".repeat(30) + String.format("%02d", i)).toList();
		var tiers = java.util.stream.IntStream.range(0, 8).mapToObj(i -> "<".repeat(22) + String.format("%02d", i)).toList();
		var option = new AgentControlModelOption("claude", "<".repeat(128), "<".repeat(96), efforts, tiers);
		var saturated = new AgentControlSnapshot(AgentControlSnapshot.SCHEMA_VERSION, true, true, "<".repeat(160),
				Long.MAX_VALUE, agents, java.util.Collections.nCopies(128, option));
		String encoded = AgentControlSnapshotCodec.encode(saturated);
		assertEquals(saturated, AgentControlSnapshotCodec.decode(encoded), "maximum aggregate keeps every field and identity");
		assertTrue(encoded.getBytes(java.nio.charset.StandardCharsets.UTF_8).length > 32767,
				"aggregate regression exceeds the original cap");
		assertTrue(AgentControlSnapshotCodec.MAX_ENCODED_BYTES + 256 < 1_048_576,
				"aggregate bound plus packet framing stays within clientbound transport budget");
		var buffer = new net.minecraft.network.RegistryFriendlyByteBuf(io.netty.buffer.Unpooled.buffer(),
				net.minecraft.core.RegistryAccess.EMPTY);
		try {
			AgentControlSnapshotPayload.CODEC.encode(buffer, AgentControlSnapshotPayload.fromSnapshot(saturated));
			assertEquals(saturated, AgentControlSnapshotPayload.CODEC.decode(buffer).snapshot(),
					"maximum aggregate round trips through the actual packet string codec");
		} finally { buffer.release(); }
		return 4;
	}

	private static int verifyProviderPresets() {
		assertEquals(List.of("codex", "claude"), AgentControlCatalog.providers(), "provider order");

		assertEquals("gpt-6.1-sol", AgentControlCatalog.defaultModel("codex"), "Codex model default");
		assertEquals("low", AgentControlCatalog.defaultReasoning("codex", "gpt-6-luna"),
				"Codex thinking depth starts at the lowest effort");
		assertEquals("default", AgentControlCatalog.defaultServiceTier("codex", "gpt-6-luna"),
				"Codex speed starts at the standard tier even when fast is offered");
		assertEquals("claude-opus-5-5", AgentControlCatalog.defaultModel("claude"), "Claude model default");
		assertEquals(List.of("claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1"), AgentControlCatalog.models("claude"),
				"Claude model presets");
		assertEquals("low", AgentControlCatalog.defaultReasoning("claude", "claude-sonnet-5-5"), "Claude reasoning default");
		assertEquals("priority", AgentControlCatalog.defaultServiceTier("claude", "claude-sonnet-5-5"), "Claude has no fast tier");
		for (String model : List.of("claude-opus-5-5", "claude-sonnet-5-5", "claude-fable-5-1")) {
			assertEquals(List.of("low", "medium", "high"), AgentControlCatalog.reasoningEfforts("claude", model),
					"Claude models offer Low through High only");
		}
		assertEquals("Claude Fable 5.1", AgentControlCatalog.displayName("claude", "claude-fable-5-1"),
				"Claude display name");
		expectFailure(() -> AgentControlCatalog.defaultModel("kimi"), "retired Kimi provider");
		expectFailure(() -> AgentControlCatalog.defaultModel("cursor"), "retired Cursor provider");
		assertEquals(List.of("low", "medium", "high", "xhigh", "max", "ultra"),
				AgentControlCatalog.reasoningEfforts("codex", "gpt-6.1-sol"), "Codex effort choices");
		assertEquals(List.of("default", "priority", "fast"), AgentControlCatalog.serviceTiers("codex", "gpt-6.1-sol"),
				"Codex speed choices");
		assertTrue(AgentControlCatalog.hasSpeedMode("codex", "gpt-6.1-sol"),
				"Codex exposes speed mode only when the live profile advertises it");
		assertEquals(List.of("gpt-6-astra", "gpt-6.1-sol", "gpt-6-luna"), AgentControlCatalog.models("codex"),
				"only the selected GPT-6 Codex models are offered for new agents");
		expectFailure(() -> AgentControlCatalog.defaultModel("unknown"), "unknown provider");
		return 22;
	}

	private static int verifyCommandConstruction() {
		assertEquals(
				"codex summon-configured codex gpt-6.1-sol high default survival \"Builder One\"",
				AgentControlCommandBuilder.summon("codex", "gpt-6.1-sol", "high", "Builder One"),
				"Codex summon command defaults to the standard tier"
		);
		assertEquals(
				"codex summon-configured claude claude-opus-5-5 high priority survival Scout",
				AgentControlCommandBuilder.summon("claude", "claude-opus-5-5", "high", "Scout"),
				"Claude summon command"
		);
		assertEquals(
				"codex summon-configured codex gpt-6.1-sol ultra fast survival Speedy",
				AgentControlCommandBuilder.summon(
						"codex", "gpt-6.1-sol", "ultra", "fast", "Speedy", AgentGameMode.SURVIVAL),
				"Codex fast-mode command"
		);
		assertEquals(
				"codex start " + AGENT_UUID + " Build a safe shelter",
				AgentControlCommandBuilder.prompt("start", AGENT_UUID, "  Build\na safe\tshelter  "),
				"prompt whitespace normalization"
		);
		assertEquals(
				"codex stop " + AGENT_UUID,
				AgentControlCommandBuilder.agent("stop", AGENT_UUID),
				"agent lifecycle command"
		);
		assertEquals(
				"codex respawn " + AGENT_UUID,
				AgentControlCommandBuilder.agent("respawn", AGENT_UUID),
				"dead-agent respawn command"
		);
		expectFailure(
				() -> AgentControlCommandBuilder.agent("remove;op", AGENT_UUID),
				"operation allowlist"
		);
		expectFailure(
				() -> AgentControlCommandBuilder.prompt("start", AGENT_UUID, " "),
				"blank prompt"
		);
		return 8;
	}

	private static int verifySelectionStability() {
		AgentControlAgent first = agent(AGENT_UUID, "First");
		AgentControlAgent second = agent("87654321-4321-8765-cba9-987654321abc", "Second");
		assertEquals(first.agentId(), AgentControlSelection.resolve("", List.of(first, second)), "select first initially");
		assertEquals(second.agentId(), AgentControlSelection.resolve(second.agentId(), List.of(first, second)),
				"retain existing selection");
		assertEquals(first.agentId(), AgentControlSelection.resolve("missing", List.of(first, second)),
				"fall back after removal");
		assertEquals("", AgentControlSelection.resolve(first.agentId(), List.of()), "clear empty selection");
		assertEquals(first.agentId(), AgentControlSelection.move(second.agentId(), -1, List.of(first, second)),
				"previous moves both the visual anchor and command selection");
		assertEquals(second.agentId(), AgentControlSelection.move(first.agentId(), 1, List.of(first, second)),
				"next moves both the visual anchor and command selection");
		assertEquals("Remove 2 agents? First and Second and their saved state will be removed.",
				AgentControlSelection.removalDescription(List.of(first, second)),
				"batch removal confirmation identifies the exact destructive scope");
		assertEquals(second.agentId(), AgentControlSelection.resolveSelected(
				"missing", java.util.Set.of(second.agentId()), List.of(first, second)
		), "snapshot refresh keeps the visual anchor inside the command selection");
		return 8;
	}

	private static int verifyRuntimeCatalogBecomesAuthoritative() {
		List<AgentControlModelOption> live = List.of(
				new AgentControlModelOption(
						"codex", "gpt-6.1-sol", "GPT-6.1 Sol", List.of("high", "low", "medium"), List.of("fast", "priority")
				),
				new AgentControlModelOption(
						"codex", "gpt-6-sol", "GPT 6 Sol", List.of("high"), List.of("fast")
				),
				new AgentControlModelOption(
						"codex", "gpt-5.6-sol", "GPT 5.6 Sol", List.of("high"), List.of("fast")
				),
				new AgentControlModelOption(
						"claude", "claude-live", "Claude Live", List.of("thinking", "high", "low"), List.of()
				)
		);
		List<AgentControlProvider> rows = List.of(new AgentControlProvider("codex", "Codex CLI", 0x55FFFF, true, "0.163.0", true,
				"agam...", "pro", "gpt-6-sol", List.of(), "plan_percent", "weekly 84% used", 1L));
		try {
			AgentControlCatalog.installRuntimeCatalog(live, rows);
			assertEquals(List.of("codex", "claude"), AgentControlCatalog.providers(),
					"runtime catalog controls provider order");
			assertEquals(List.of("gpt-6.1-sol", "gpt-6-sol", "gpt-5.6-sol"), AgentControlCatalog.models("codex"),
					"every discovered Codex model is offered; there is no fixed selection filter");
			assertEquals("gpt-6-sol", AgentControlCatalog.defaultModel("codex"),
					"the provider CLI's own default model opens the menu");
			assertEquals("claude-live", AgentControlCatalog.defaultModel("claude"),
					"without a CLI default the first discovered model opens the menu");
			assertEquals("GPT-6.1 Sol", AgentControlCatalog.displayName("codex", "gpt-6.1-sol"),
					"runtime catalog preserves provider display names");
			assertEquals(List.of("low", "medium", "high"), AgentControlCatalog.reasoningEfforts("codex", "gpt-6.1-sol"),
					"unsorted runtime reasoning choices are normalised to ascending depth");
			assertEquals(List.of("default", "priority", "fast"), AgentControlCatalog.serviceTiers("codex", "gpt-6.1-sol"),
					"unsorted runtime speed choices put the standard tier first");
			assertEquals("low", AgentControlCatalog.defaultReasoning("codex", "gpt-6.1-sol"),
					"runtime catalog default is the lowest depth");
			assertEquals("default", AgentControlCatalog.defaultServiceTier("codex", "gpt-6.1-sol"),
					"runtime catalog default speed is the standard tier");
			assertEquals(List.of("low", "high", "thinking"), AgentControlCatalog.reasoningEfforts("claude", "claude-live"),
					"unknown efforts keep their input order after the known scale");
			assertEquals(0x55FFFF, AgentControlCatalog.providerColor("codex"), "provider colour comes from discovery");
			assertEquals(AgentControlCatalog.providerColor("newcli"), AgentControlCatalog.providerColor("newcli"),
					"an undiscovered provider still gets a stable colour");
			AgentControlSnapshot snapshot = new AgentControlSnapshot(
					AgentControlSnapshot.SCHEMA_VERSION, true, true, "Automation ready", NOW_EPOCH_MS, List.of(), live, rows
			);
			AgentControlSnapshot decoded = AgentControlSnapshotCodec.decode(AgentControlSnapshotCodec.encode(snapshot));
			assertEquals(live, decoded.catalog(), "runtime catalog survives the client snapshot wire format");
			assertEquals(rows, decoded.providers(), "discovery rows survive the client snapshot wire format");
			AgentControlCatalog.resetRuntimeCatalog();
			assertTrue(AgentControlCatalog.isEmpty() && AgentControlCatalog.providers().isEmpty(),
					"a disconnect leaves nothing offered instead of a bundled catalog");
			AgentControlSnapshot empty = new AgentControlSnapshot(
					AgentControlSnapshot.SCHEMA_VERSION, true, true, "Automation ready", NOW_EPOCH_MS, List.of(), List.of(), rows);
			assertTrue(AgentControlSnapshotCodec.decode(AgentControlSnapshotCodec.encode(empty)).catalog().isEmpty(),
					"an empty catalog is a valid nothing-found snapshot");
			assertEquals("newcli", new AgentControlModelOption("NewCLI", "m", "M", List.of("default"), List.of()).provider(),
					"any well-formed provider id is accepted");
		} finally {
			TestCatalog.install();
		}
		return 17;
	}

	private static int verifyActionSafety() {
		AgentControlAgent idle = agent(AGENT_UUID, "Idle");
		AgentControlAgent paused = agent(
				"87654321-4321-8765-cba9-987654321abc", "Paused", "PAUSED", "Build shelter"
		);
		AgentControlAgent acting = agent(
				"aaaaaaaa-4321-8765-cba9-987654321abc", "Acting", "ACTING", "Gather food"
		);
		AgentControlAgent dead = agent(
				"bbbbbbbb-4321-8765-cba9-987654321abc", "Dead", "DEAD", ""
		);
		AgentControlAgent disconnected = agent(
				"cccccccc-4321-8765-cba9-987654321abc", "Disconnected", "DISCONNECTED", "Gather food"
		);
		assertTrue(AgentControlActions.supports(idle, "start"), "idle agent can start");
		assertTrue(!AgentControlActions.supports(acting, "start"), "acting agent cannot start another current goal");
		assertTrue(AgentControlActions.supports(acting, "steer"), "active goal can be steered");
		assertTrue(AgentControlActions.supports(paused, "resume"), "paused agent can resume");
		assertTrue(AgentControlActions.supports(disconnected, "resume"), "disconnected agent can resume after coordinator recovery");
		assertTrue(AgentControlActions.supports(dead, "respawn"), "dead agent exposes operator respawn");
		assertTrue(!AgentControlActions.supports(idle, "respawn"), "living agent has no respawn action");
		assertTrue(!AgentControlActions.everySupports(List.of(paused, acting), "resume"),
				"batch action is disabled when any selected agent is incompatible");
		assertEquals("Starting up...", AgentControlPresentation.stateLabel("STARTING"),
				"technical starting state is presented as plain language");
		assertEquals("Working", AgentControlPresentation.stateLabel("ACTING"),
				"technical acting state is presented as plain language");
		assertEquals("Dead - ready to respawn", AgentControlPresentation.stateLabel("DEAD"),
				"dead state advertises the operator respawn affordance");
		assertEquals("GPT 5.6 Sol | High", AgentControlPresentation.profileLabel(idle),
				"agent profile copy is human readable");
		assertEquals("Fast mode", AgentControlPresentation.speedLabel("fast"),
				"fast service tier has a human-readable label");
		assertEquals("Normal", AgentControlPresentation.speedLabel("priority"),
				"provider-native priority tier is presented as the normal player speed");
		return 12;
	}

	private static int verifySnapshotOrdering() {
		AgentControlSnapshotStore store = new AgentControlSnapshotStore();
		AgentControlSnapshot newer = new AgentControlSnapshot(true, NOW_EPOCH_MS + 2L, List.of());
		AgentControlSnapshot older = new AgentControlSnapshot(false, NOW_EPOCH_MS + 1L, List.of());
		assertTrue(store.accept(newer), "new snapshot accepted");
		assertTrue(!store.accept(older), "stale snapshot rejected");
		assertEquals(newer, store.current().orElseThrow(), "stale snapshot does not replace state");
		store.clear();
		assertTrue(store.current().isEmpty(), "disconnect clears snapshot state");
		return 4;
	}

	private static AgentControlAgent agent(String id, String name) {
		return agent(id, name, "IDLE", "");
	}

	private static AgentControlAgent agent(String id, String name, String state, String currentGoal) {
		return new AgentControlAgent(
				id,
				id.substring(0, 8),
				name,
				"codex",
				"gpt-5.6-sol",
				"high",
				"SolCyan_" + id.substring(0, 8).toUpperCase(java.util.Locale.ROOT),
				0,
				state,
				currentGoal,
				0,
				"",
				"",
				true,
				true
		);
	}

	private static void expectFailure(Runnable operation, String label) {
		try {
			operation.run();
			throw new AssertionError(label + " should fail");
		} catch (IllegalArgumentException expected) {
		}
	}

	private static void assertTrue(boolean actual, String label) {
		if (!actual) {
			throw new AssertionError(label);
		}
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!java.util.Objects.equals(expected, actual)) {
			throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
		}
	}
}
