package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.control.AgentControlCatalog;
import dev.agaminggod.mineagen.control.AgentControlModelOption;
import java.util.List;

public final class AgentControlLayoutVerification {
	private AgentControlLayoutVerification() {
	}

	public static int verify() {
		AgentControlLayout wide = AgentControlLayout.calculate(960, 540);
		assertTrue(wide.splitWorkspace(), "wide control center reserves a readable context rail");
		assertTrue(wide.canvasWidth() >= 420, "wide control center keeps a useful primary canvas");
		assertTrue(wide.contextWidth() >= 180, "wide control center context rail remains readable");
		assertTrue(wide.contentTop() - wide.panelTop() >= AgentControlLayout.HEADER_HEIGHT,
				"content starts below the header row");
		assertTrue(wide.contentBottom() < wide.footerY(), "wide content never collides with footer actions");
		assertTrue(wide.roomy(), "wide panels show page titles and field labels");
		assertTrue(wide.panelWidth() <= 760, "the panel stops growing so lines stay a readable length");

		AgentControlLayout compact = AgentControlLayout.calculate(320, 240);
		assertTrue(!compact.splitWorkspace(), "compact control center stacks context below the primary task");
		assertTrue(compact.canvasWidth() >= 276, "compact canvas stays wide enough for prompt and roster controls");
		assertTrue(compact.contentTop() > compact.headerBottom(), "compact content begins after the header");
		assertTrue(compact.footerY() + AgentControlLayout.CONTROL_HEIGHT <= compact.panelBottom(),
				"compact footer remains fully on screen");
		assertTrue(compact.minimumTargetHeight() >= 24, "custom controls meet the minimum target-height contract");
		assertTrue(!compact.roomy(), "short panels drop page titles to fit their controls");

		AgentControlLayout scaleThree = AgentControlLayout.calculate(640, 360);
		assertTrue(!scaleThree.splitWorkspace(), "a 1080p screen at GUI scale 3 avoids a cramped context rail");
		assertTrue(scaleThree.roomy(), "a 1080p screen at GUI scale 3 has room for page titles");
		assertTrue(scaleThree.formWidth() == scaleThree.contentWidth(), "narrow panels give forms the full width");

		// A 1280x720 window at scale 3 with Force Unicode Font becomes scale 4: 320x180. Smaller sizes must degrade, not crash.
		for (int[] size : new int[][] {{320, 180}, {319, 240}, {200, 150}, {1, 1}}) {
			AgentControlLayout tiny = AgentControlLayout.calculate(size[0], size[1]);
			assertTrue(tiny.panelRight() > tiny.panelLeft() && tiny.panelBottom() > tiny.panelTop(),
					"a " + size[0] + "x" + size[1] + " GUI still gets a panel");
			assertTrue(tiny.contentRight() > tiny.contentLeft() && tiny.contentBottom() >= tiny.contentTop()
					&& tiny.footerY() >= tiny.contentTop(), "a " + size[0] + "x" + size[1] + " GUI keeps its regions ordered");
			assertTrue(!tiny.roomy(), "a " + size[0] + "x" + size[1] + " GUI drops page titles");
		}
		AgentControlLayout unicode = AgentControlLayout.calculate(320, 180);
		assertTrue(unicode.footerY() + AgentControlLayout.CONTROL_HEIGHT <= unicode.panelBottom(),
				"the 320x180 footer stays fully on screen");

		try {
			AgentControlCatalog.installRuntimeCatalog(List.of(new AgentControlModelOption(
					"codex", "gpt-future", "GPT Future", List.of("medium"), List.of("priority")
			)));
			AgentControlScreen.CreateSelection normalized = AgentControlScreen.normalizeCreateSelection(
					"codex", "gpt-5.6-luna", "xhigh", "fast"
			);
			assertEquals("codex", normalized.provider(), "catalog refresh preserves an available provider");
			assertEquals("gpt-future", normalized.model(), "catalog refresh replaces a removed model");
			assertEquals("medium", normalized.reasoning(), "catalog refresh replaces removed reasoning");
			assertEquals("default", normalized.serviceTier(), "catalog refresh replaces removed speed mode");
			assertEquals("Create an agent, scanning for providers", AgentControlScreen.createNarration("", ""),
					"create narration before the provider scan names no provider instead of throwing");
			assertEquals("Create an agent, scanning for providers", AgentControlScreen.createNarration(null, null),
					"create narration with no remembered choice does not throw");
			assertEquals("Create an agent, Codex, GPT Future", AgentControlScreen.createNarration("codex", "gpt-future"),
					"create narration names a discovered provider and model");
			assertEquals("Create an agent, Codex", AgentControlScreen.createNarration("codex", "gpt-removed"),
					"create narration survives a model the catalog no longer offers");
		} finally {
			dev.agaminggod.mineagen.control.TestCatalog.install();
		}

		assertEquals("********", dev.agaminggod.mineagen.client.gui.widget.ConsoleEditBox.maskedText("fake-key"), "input masks every character");
		assertEquals("API key, hidden", dev.agaminggod.mineagen.client.gui.widget.ConsoleEditBox.secretNarration(), "narration never speaks input");
		dev.agaminggod.mineagen.control.AgentControlProvider planRow = new dev.agaminggod.mineagen.control.AgentControlProvider(
				"claude", "Claude Code", 0xD97757, true, "2.1.330", true, "player-name", "max", null, List.of(), "plan_percent", null, 0L);
		assertEquals("Max plan", AgentControlScreen.providerSignIn(planRow), "sign-in names the plan, never the account");
		dev.agaminggod.mineagen.control.AgentControlProvider accountOnly = new dev.agaminggod.mineagen.control.AgentControlProvider(
				"codex", "Codex CLI", 0x42D39B, true, "0.171.0", true, "player-name", null, null, List.of(), "plan_percent", null, 0L);
		assertEquals("Signed in", AgentControlScreen.providerSignIn(accountOnly), "an account name alone is never shown");
		assertEquals("API key ····abcd", AgentControlScreen.providerSignIn(accountOnly.withApiKeySuffix("abcd")),
				"a stored key shows only its last four characters");
		verifyReviewFixes();
		verifyStatusBanner();
		return 46;
	}

	/** Pending feedback is neutral, and a long offline reason gets a measured banner that the Now card stays below. */
	private static void verifyStatusBanner() {
		assertEquals(ConsoleTheme.MUTED, AgentControlScreen.toneColor(dev.agaminggod.mineagen.control.AgentControlResult.Tone.PENDING),
				"a command still on its way is drawn neutral grey");
		assertTrue(AgentControlScreen.toneColor(dev.agaminggod.mineagen.control.AgentControlResult.Tone.PENDING) != ConsoleTheme.SUCCESS,
				"a command still on its way is never drawn green");
		assertEquals(ConsoleTheme.SUCCESS, AgentControlScreen.toneColor(dev.agaminggod.mineagen.control.AgentControlResult.Tone.SUCCESS),
				"only a confirmed success is green");
		assertEquals(ConsoleTheme.ERROR, AgentControlScreen.toneColor(dev.agaminggod.mineagen.control.AgentControlResult.Tone.REFUSED),
				"a refusal is red");
		String reason = "Automation is offline: the coordinator stopped after restarting 5 times in 2 minutes. Check the server log, then reopen the world.";
		for (int[] size : new int[][] {{480, 270}, {640, 360}, {320, 240}}) {
			String at = " at " + size[0] + "x" + size[1];
			AgentControlLayout base = AgentControlLayout.calculate(size[0], size[1]);
			List<String> lines = dev.agaminggod.mineagen.control.AgentControlResult.wrap(
					reason, AgentControlScreen.bannerTextWidth(base), text -> text.length() * 6);
			assertTrue(lines.size() > 1, "the offline reason wraps onto more than one banner line" + at);
			assertEquals(reason, String.join(" ", lines), "the banner keeps the whole offline reason" + at);
			AgentControlLayout withBanner = AgentControlLayout.calculate(size[0], size[1], AgentControlScreen.bannerInset(lines.size()));
			AgentControlLayout.Bounds banner = AgentControlScreen.bannerBounds(withBanner, lines.size());
			assertTrue(banner.top() >= withBanner.headerBottom(), "the banner starts below the header" + at);
			assertTrue(banner.height() >= lines.size() * AgentControlScreen.BANNER_LINE, "the banner is tall enough for every line" + at);
			assertTrue(banner.bottom() < withBanner.contentTop(), "page content starts below the banner" + at);
			assertTrue(AgentControlScreen.bodyTop(withBanner) > banner.bottom(), "page controls start below the banner" + at);
			assertTrue(withBanner.contentBottom() >= withBanner.contentTop() && withBanner.footerY() + AgentControlLayout.CONTROL_HEIGHT
					<= withBanner.panelBottom(), "the footer stays on screen under a banner" + at);
			for (int agents : new int[] {1, 3}) {
				AgentControlLayout.Bounds now = AgentControlScreen.overviewNowBounds(withBanner, false, agents);
				assertTrue(now == null || now.top() > banner.bottom(), "the overview Now card stays below the banner" + at);
			}
			AgentControlLayout.Bounds manageNow = AgentControlScreen.manageNowBounds(withBanner);
			assertTrue(manageNow == null || manageNow.top() > banner.bottom(), "the Manage Now card stays below the banner" + at);
		}
	}

	private static void verifyReviewFixes() {
		List<dev.agaminggod.mineagen.control.AgentControlAgent> remaining = List.of(new dev.agaminggod.mineagen.control.AgentControlAgent(
				"00000000-0000-4000-8000-000000000002", "00000000", "Brick", "claude", "claude-opus-5-5", "medium",
				"Brick", 0, "IDLE", "", 0, "", "", true, true));
		assertTrue(AgentControlScreen.pageAgentGone("00000000-0000-4000-8000-000000000001", remaining),
				"a Remove page for an agent someone else removed closes instead of retargeting the next agent");
		assertTrue(!AgentControlScreen.pageAgentGone("00000000-0000-4000-8000-000000000002", remaining),
				"a page for an agent that is still there stays open");
		assertTrue(!AgentControlScreen.pageAgentGone("", remaining), "pages without an agent are never closed");
		try {
			dev.agaminggod.mineagen.control.TestCatalog.install();
			assertEquals("GPT 6 Luna", AgentControlScreen.safeDisplayName("codex", "gpt-6-luna"), "a known model shows its name");
			assertEquals("gpt-removed", AgentControlScreen.safeDisplayName("codex", "gpt-removed"),
					"a model the refreshed catalog dropped shows its id instead of throwing");
			assertEquals("x", AgentControlScreen.safeDisplayName("gone-provider", "x"),
					"a provider the refreshed catalog dropped shows the id instead of throwing");
		} finally {
			dev.agaminggod.mineagen.control.TestCatalog.install();
		}
		assertEquals(30, AgentControlScreen.scrollToReveal(0, 180, 202, 40, 172, 60),
				"tabbing to a control below the view scrolls just far enough to show it");
		assertEquals(10, AgentControlScreen.scrollToReveal(40, 50, 72, 40, 172, 60),
				"tabbing back to a control above the view scrolls up to it");
		assertEquals(60, AgentControlScreen.scrollToReveal(0, 300, 322, 40, 172, 60), "the scroll never passes its end");
		DeferredRebuild gate = new DeferredRebuild();
		assertTrue(gate.request(), "outside input a rebuild runs at once");
		gate.enter();
		assertTrue(!gate.request(), "a rebuild asked for inside a click waits until the click is handled");
		assertTrue(gate.exit(), "the waiting rebuild runs once the click finishes, so focus lands on the new widget");
		assertTrue(!gate.exit(), "nothing runs twice");
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!java.util.Objects.equals(expected, actual)) {
			throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
		}
	}

	private static void assertThrows(Class<? extends Throwable> expected, Runnable action, String label) {
		try {
			action.run();
		} catch (Throwable thrown) {
			if (expected.isInstance(thrown)) return;
			throw new AssertionError(label + ": expected " + expected.getSimpleName()
					+ " but caught " + thrown.getClass().getSimpleName(), thrown);
		}
		throw new AssertionError(label + ": expected " + expected.getSimpleName());
	}
}
