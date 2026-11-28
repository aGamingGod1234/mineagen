package dev.agaminggod.mineagen.client.control;

import dev.agaminggod.mineagen.agent.AgentIdentity;
import dev.agaminggod.mineagen.control.AgentControlAgent;
import dev.agaminggod.mineagen.control.AgentControlCatalog;
import dev.agaminggod.mineagen.control.AgentControlModelOption;
import dev.agaminggod.mineagen.control.AgentControlSnapshot;
import dev.agaminggod.mineagen.client.gui.BoatPanelPresentation;
import dev.agaminggod.mineagen.server.BoatAccount;
import java.nio.charset.StandardCharsets;
import java.util.List;
import java.util.UUID;

public final class AgentClientPresentationVerification {
	private AgentClientPresentationVerification() {
	}

	public static int verify() {
		SnapshotRefreshPolicy.Tick disconnected = SnapshotRefreshPolicy.advance(0, false, 20);
		assertFalse(disconnected.requestSnapshot(), "disconnected clients do not send snapshot requests");
		assertEquals(0, disconnected.nextCountdown(), "disconnect resets the background refresh timer");

		SnapshotRefreshPolicy.Tick due = SnapshotRefreshPolicy.advance(0, true, 20);
		assertTrue(due.requestSnapshot(), "connected clients refresh snapshots even with the control center closed");
		assertEquals(19, due.nextCountdown(), "a refresh starts an exact twenty-tick interval");
		SnapshotRefreshPolicy.Tick waiting = SnapshotRefreshPolicy.advance(7, true, 20);
		assertFalse(waiting.requestSnapshot(), "background polling waits until the interval expires");
		assertEquals(6, waiting.nextCountdown(), "background polling advances once per client tick");
		SnapshotRefreshPolicy.Tick hidden = SnapshotRefreshPolicy.advance(0, true, false, 20, 100);
		assertTrue(hidden.requestSnapshot(), "hidden controls retain a slow roster heartbeat");
		assertEquals(99, hidden.nextCountdown(), "hidden controls avoid polling a full snapshot every second");
		SnapshotRefreshPolicy.Tick shown = SnapshotRefreshPolicy.advance(99, true, true, 20, 100);
		assertFalse(shown.requestSnapshot(), "showing controls advances the next request without a duplicate tick send");
		assertEquals(0, shown.nextCountdown(), "showing controls makes the next tick immediately due");

		AgentControlClient.SnapshotAcknowledgements acknowledgements =
				new AgentControlClient.SnapshotAcknowledgements();
		acknowledgements.recordRequest();
		long mutationId = acknowledgements.beginMutation();
		acknowledgements.recordRequest();
		assertEquals(0L, acknowledgements.acceptSnapshot(),
				"a refresh already in flight cannot acknowledge a later mutation");
		assertEquals(mutationId, acknowledgements.acceptSnapshot(),
				"the first request sent after the mutation carries its acknowledgement");
		long disconnectedMutation = acknowledgements.beginMutation();
		acknowledgements.recordRequest();
		acknowledgements.clear();
		assertEquals(0L, acknowledgements.acceptSnapshot(),
				"disconnect clears queued mutation acknowledgements");
		assertTrue(disconnectedMutation > mutationId, "mutation receipts increase monotonically");

		AgentControlAgent agent = new AgentControlAgent(
				"12345678-1234-1234-1234-123456789abc", "12345678", "Builder", "codex",
				"gpt-5.6-sol", "high", "SolCyan_12345678", 0, "IDLE", "", 0, "", "", true, true
		);
		AgentControlSnapshot snapshot = new AgentControlSnapshot(true, 1L, List.of(agent));
		assertTrue(SnapshotRevisionPolicy.isNewer(null, snapshot),
				"the first control snapshot is accepted");
		assertFalse(SnapshotRevisionPolicy.isNewer(snapshot,
				new AgentControlSnapshot(false, 1L, List.of(agent))),
				"an equal revision cannot replace current permissions or presentation state");
		AgentControlSnapshot readOnly = new AgentControlSnapshot(false, 2L, List.of(agent));
		assertFalse(SnapshotRevisionPolicy.isNewer(readOnly, snapshot),
				"an older revision is ignored");
		assertTrue(SnapshotRevisionPolicy.isNewer(snapshot, readOnly),
				"a newer revision can publish a read-only snapshot");
		assertEquals(agent, AgentPlayerIdentity.find(snapshot, "SolCyan_12345678").orElseThrow(),
				"exact player profile names resolve the custom agent identity");
		assertEquals(agent, AgentPlayerIdentity.find(snapshot, "solcyan_12345678").orElseThrow(),
				"profile-name casing differences do not break custom skins or label suppression");
		assertTrue(AgentPlayerIdentity.find(snapshot, "DifferentPlayer").isEmpty(),
				"ordinary players never inherit agent presentation");
		assertTrue(AgentPlayerIdentity.find(snapshot, "  ").isEmpty(),
				"blank profile names never match an agent");

		String patternHumanName = agent.playerName();
		UUID offlineHumanUuid = UUID.nameUUIDFromBytes(
				("OfflinePlayer:" + patternHumanName).getBytes(StandardCharsets.UTF_8)
		);
		assertEquals(AgentIdentity.offlinePlayerUuid(patternHumanName), offlineHumanUuid,
				"an offline human with an agent-pattern name has the same deterministic UUID as the old fallback");
		AgentControlSnapshot loadingSnapshot = new AgentControlSnapshot(true, 2L, List.of());
		assertTrue(AgentPlayerIdentity.find(loadingSnapshot, patternHumanName).isEmpty(),
				"name pattern and matching offline UUID do not grant agent presentation before snapshot membership");
		assertEquals(agent, AgentPlayerIdentity.find(snapshot, patternHumanName).orElseThrow(),
				"authoritative snapshot membership enables agent presentation after synchronization");

		try {
			AgentControlCatalog.installRuntimeCatalog(List.of(new AgentControlModelOption(
					"codex", "gpt-future", "GPT Future", List.of("medium"), List.of("priority")
			)));
			AgentControlClient.Preferences remembered = new AgentControlClient.Preferences("codex", "gpt-future");
			dev.agaminggod.mineagen.control.TestCatalog.install();
			assertEquals(remembered, AgentControlClient.Preferences.reconcile(remembered, false),
					"temporary fallback catalog preserves a runtime-only preference");

			AgentControlCatalog.installRuntimeCatalog(List.of(new AgentControlModelOption(
					"codex", "gpt-next", "GPT Next", List.of("high", "low"), List.of("fast", "priority")
			)));
			AgentControlClient.Preferences repaired = AgentControlClient.Preferences.reconcile(remembered, true);
			assertEquals("codex", repaired.provider(), "catalog change replaces an unavailable preferred provider");
			assertEquals("gpt-next", repaired.model(), "authoritative catalog chooses the available model");
			assertEquals("low", AgentControlCatalog.defaultReasoning(repaired.provider(), repaired.model()),
					"a reopened menu starts at the lowest thinking depth rather than a remembered one");
			assertEquals("default", AgentControlCatalog.defaultServiceTier(repaired.provider(), repaired.model()),
					"a reopened menu starts at the standard tier rather than a remembered tier");
		} finally {
			dev.agaminggod.mineagen.control.TestCatalog.install();
		}
		return 26 + verifyBoatRail();
	}

	/**
	 * The mission board's Runs on rail in every boat state: signed out, signed in and idle, starting, running and
	 * stopping, plus a client that does not host the world. Every key it can show exists in the English file.
	 */
	private static int verifyBoatRail() {
		int assertions = 0;
		BoatAccount.Settings local = new BoatAccount.Settings(false, false);
		BoatAccount.Settings onBoat = new BoatAccount.Settings(true, true);
		BoatPanelPresentation.Machine signedOut = BoatPanelPresentation.machine(
				new BoatAccount.Status("signed_out", false, "none", null, 0D, null), local);
		assertEquals("screen.mineagen.boat.signed_out.title", signedOut.titleKey(), "signed out says so");
		assertEquals(BoatPanelPresentation.Action.SIGN_IN, signedOut.action(), "signed out offers Sign in with boat");
		assertEquals("sign_in:boat", signedOut.action().command(), "the sign-in button sends the boat sign-in action");
		assertFalse(signedOut.costShown(), "signed out shows no running cost");
		BoatPanelPresentation.Machine idle = BoatPanelPresentation.machine(
				new BoatAccount.Status("idle", true, "oauth", null, 0D, null), local);
		assertEquals("screen.mineagen.boat.idle.title", idle.titleKey(), "signed in and idle says boat is connected");
		assertEquals("screen.mineagen.boat.idle.detail_local", idle.detailKey(), "idle on this PC says agents run here");
		assertTrue(idle.specShown(), "idle names the machine size and price");
		assertEquals(BoatPanelPresentation.Action.SIGN_OUT, idle.action(), "idle offers Sign out, never a made-up Start machine");
		assertEquals("screen.mineagen.boat.idle.detail_boat", BoatPanelPresentation.machine(
				new BoatAccount.Status("idle", true, "oauth", null, 0D, null), onBoat).detailKey(),
				"idle with Runs on boat says the machine starts with the agents");
		BoatPanelPresentation.Machine starting = BoatPanelPresentation.machine(
				new BoatAccount.Status("starting", true, "oauth", "m-1", 0.001D, null), onBoat);
		assertEquals("screen.mineagen.boat.starting.title", starting.titleKey(), "starting says the machine is starting");
		assertTrue(starting.progress(), "starting shows a progress bar");
		assertEquals(BoatPanelPresentation.Action.STOP_MACHINE, starting.action(), "a starting machine can be stopped");
		BoatPanelPresentation.Machine running = BoatPanelPresentation.machine(
				new BoatAccount.Status("running", true, "oauth", "m-1", 0.013D, null), onBoat);
		assertEquals("screen.mineagen.boat.running.title", running.titleKey(), "running says the machine runs");
		assertTrue(running.costShown() && running.specShown(), "running shows its size, price and cost so far");
		assertEquals("stop_machine", running.action().command(), "running offers Stop machine");
		assertEquals(BoatPanelPresentation.Tone.BOAT, running.tone(), "running is drawn in boat blue");
		BoatPanelPresentation.Machine stopping = BoatPanelPresentation.machine(
				new BoatAccount.Status("stopping", true, "oauth", "m-1", 0.02D, null), onBoat);
		assertEquals("screen.mineagen.boat.stopping.title", stopping.titleKey(), "stopping says so");
		assertEquals(BoatPanelPresentation.Action.NONE, stopping.action(), "a stopping machine offers no second stop");
		assertFalse(stopping.switchEnabled(), "Runs on waits while the machine stops");
		BoatPanelPresentation.Machine remote = BoatPanelPresentation.machine(null, local);
		assertEquals("screen.mineagen.boat.unavailable.title", remote.titleKey(), "off the host the rail says boat is not available");
		assertFalse(remote.switchEnabled(), "off the host Runs on is disabled");
		assertEquals(BoatPanelPresentation.Action.NONE, remote.action(), "off the host no boat action is offered");
		assertEquals("disk full", BoatPanelPresentation.machine(
				new BoatAccount.Status("running", true, "oauth", "m-1", 0D, " disk full "), onBoat).error(),
				"a runner error is shown, trimmed");
		assertEquals("idle", BoatPanelPresentation.machine(
				new BoatAccount.Status("rebooting", true, "oauth", null, 0D, null), onBoat).phase(),
				"an unknown phase from a newer runner reads as idle when signed in");
		assertEquals(5, BoatPanelPresentation.PHASES.size(), "five runner phases are drawn");
		assertions += 25;

		assertEquals("$0.013", BoatPanelPresentation.dollars(0.0134D), "cost below a dollar keeps a third digit");
		assertEquals("$0.018", BoatPanelPresentation.dollars(BoatAccount.DOLLARS_PER_HOUR), "the hourly price reads $0.018");
		assertEquals("$12.40", BoatPanelPresentation.dollars(12.4D), "cost above a dollar shows cents");
		assertEquals("$0.000", BoatPanelPresentation.dollars(Double.NaN), "a broken cost reads as zero");
		assertTrue(BoatPanelPresentation.pillShowsBoat(new BoatAccount.Status("running", true, "oauth", "m", 0D, null), local),
				"the header pill shows boat while a machine runs");
		assertFalse(BoatPanelPresentation.pillShowsBoat(new BoatAccount.Status("idle", true, "oauth", null, 0D, null), local),
				"the header pill says This PC while agents run here");
		assertFalse(BoatPanelPresentation.pillShowsBoat(null, onBoat), "off the host the pill never claims boat");
		assertions += 7;

		dev.agaminggod.mineagen.control.AgentControlProvider claudeOut = new dev.agaminggod.mineagen.control.AgentControlProvider(
				"claude", "Claude Code", 0xD97757, true, "2.1.330", false, null, null, null, List.of(), "plan_percent", null, 0L);
		List<BoatPanelPresentation.ProviderRow> rows = BoatPanelPresentation.providerRows(List.of(claudeOut),
				new BoatAccount.Status("signed_out", false, "none", null, 0D, null));
		assertEquals(List.of("codex", "claude", "boat"), rows.stream().map(BoatPanelPresentation.ProviderRow::id).toList(),
				"Codex, Claude and boat always get a row");
		assertTrue(rows.stream().allMatch(BoatPanelPresentation.ProviderRow::signIn),
				"a missing Codex, a signed-out Claude and a signed-out boat each offer Sign in");
		assertEquals("screen.mineagen.provider.status.missing", rows.get(0).statusKey(), "a tool the scan did not find is missing");
		assertEquals("sign_in:claude", rows.get(1).signInAction(), "Claude's button sends the Claude sign-in");
		dev.agaminggod.mineagen.control.AgentControlProvider codexReady = new dev.agaminggod.mineagen.control.AgentControlProvider(
				"codex", "Codex CLI", 0x42D39B, true, "0.171.0", true, null, null, null, List.of(), "plan_percent", null, 0L);
		List<BoatPanelPresentation.ProviderRow> ready = BoatPanelPresentation.providerRows(
				List.of(codexReady, claudeOut.withApiKeySuffix("abcd")), new BoatAccount.Status("idle", true, "cli", null, 0D, null));
		assertTrue(ready.stream().noneMatch(BoatPanelPresentation.ProviderRow::signIn), "ready rows offer no sign-in");
		assertEquals("screen.mineagen.provider.status.boat_cli", ready.get(2).statusKey(), "a command-line boat sign-in says so");
		assertFalse(BoatPanelPresentation.providerRows(List.of(), null).get(2).signIn(), "off the host boat offers no sign-in");
		assertFalse(AgentControlCatalog.providers().contains("boat"), "boat is never a model provider in the picker");
		assertions += 8;

		com.google.gson.JsonObject language;
		try (java.io.InputStream stream = AgentClientPresentationVerification.class.getResourceAsStream("/assets/mineagen/lang/en_us.json")) {
			language = com.google.gson.JsonParser.parseString(new String(stream.readAllBytes(), StandardCharsets.UTF_8)).getAsJsonObject();
		} catch (java.io.IOException | RuntimeException failure) {
			throw new AssertionError("English language resource could not be read", failure);
		}
		for (String key : BoatPanelPresentation.keys()) {
			assertTrue(language.has(key) && !language.get(key).getAsString().isBlank(), "English copy exists for " + key);
			assertions++;
		}
		String consent = language.get(BoatPanelPresentation.CONSENT_KEY).getAsString();
		assertTrue(consent.contains("this session only") && consent.contains("never saved"),
				"the consent line says the sign-in is for this session only and never saved");
		return assertions + 1;
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}

	private static void assertFalse(boolean condition, String label) {
		assertTrue(!condition, label);
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}
}
