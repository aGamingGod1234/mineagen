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
		verifyBannerCap();
		return 62 + verifyMissionBoard();
	}

	/**
	 * The mission board at a 1080p screen's GUI scales 2, 3 and 4 (960x540, 640x360, 480x270) and the small sizes: the
	 * rail has its own column at scales 2 and 3 and folds under the live view at scale 4, and no region overlaps another.
	 */
	private static int verifyMissionBoard() {
		int assertions = 0;
		for (int[] size : new int[][] {{960, 540}, {640, 360}, {480, 270}, {427, 240}, {320, 240}, {320, 180}, {200, 150}, {1, 1}}) {
			String at = " at " + size[0] + "x" + size[1];
			MissionBoardLayout board = MissionBoardLayout.calculate(size[0], size[1]);
			AgentControlLayout shell = board.shell();
			assertTrue(board.list().left() >= shell.contentLeft() && board.list().right() <= board.centre().left(),
					"the agent list sits left of the live view" + at);
			assertTrue(board.centre().right() <= (board.railFolded() ? shell.contentRight() : board.rail().left()),
					"the live view ends before the rail" + at);
			assertTrue(board.rail().right() <= shell.contentRight(), "the rail stays inside the panel" + at);
			assertTrue(board.list().bottom() <= shell.contentBottom() && board.centre().bottom() <= shell.contentBottom(),
					"the columns end above the task row" + at);
			assertTrue(board.taskRow().top() >= board.centre().bottom() && board.taskRow().bottom() <= shell.panelBottom(),
					"the task row sits below the columns and inside the panel" + at);
			assertions += 5;
		}
		for (int[] size : new int[][] {{960, 540}, {640, 360}}) {
			String at = " at " + size[0] + "x" + size[1];
			MissionBoardLayout board = MissionBoardLayout.calculate(size[0], size[1]);
			assertTrue(!board.railFolded(), "the rail keeps its own column" + at);
			assertTrue(board.rail().width() >= MissionBoardLayout.RAIL_MINIMUM, "the rail is wide enough for a sign-in button" + at);
			assertTrue(board.centre().width() >= 240, "the live view keeps a readable width beside the rail" + at);
			assertTrue(board.listCompact() ? board.list().width() == MissionBoardLayout.LIST_COMPACT
					: board.list().width() >= MissionBoardLayout.LIST_MINIMUM, "the agent list shows full rows or heads only" + at);
			assertTrue(board.centre().height() >= AgentControlScreen.LIVE_NATURAL, "every live view row fits without scrolling" + at);
			assertEquals(0, board.centreScrollMaximum(AgentControlScreen.LIVE_NATURAL + 400), "an unfolded centre never scrolls" + at);
			assertions += 6;
		}
		for (int[] size : new int[][] {{480, 270}, {427, 240}, {320, 240}, {320, 180}}) {
			String at = " at " + size[0] + "x" + size[1];
			MissionBoardLayout board = MissionBoardLayout.calculate(size[0], size[1]);
			assertTrue(board.railFolded(), "the rail folds under the live view" + at);
			assertEquals(board.centre().width(), board.railContentWidth(), "the folded rail takes the live view's width" + at);
			assertEquals(board.shell().contentRight(), board.centre().right(), "the live view spans to the panel edge once folded" + at);
			assertEquals(AgentControlScreen.LIVE_NATURAL, board.liveHeight(AgentControlScreen.LIVE_NATURAL),
					"folded, the live view takes its natural height and the rail follows" + at);
			int stack = AgentControlScreen.LIVE_NATURAL + AgentControlScreen.STACK_GAP + 200;
			assertTrue(board.centreScrollMaximum(stack) == Math.max(0, stack - board.centre().height()),
					"the folded column scrolls exactly as far as the stack overflows" + at);
			assertions += 5;
		}
		assertTrue(!MissionBoardLayout.calculate(960, 540).listCompact(), "at GUI scale 2 the list shows names");
		assertTrue(MissionBoardLayout.calculate(640, 360).listCompact(), "at GUI scale 3 the list shows heads so the live view keeps its room");
		assertTrue(MissionBoardLayout.calculate(640, 360).centre().width() >= BoardLiveView.SIDE_BY_SIDE,
				"at GUI scale 3 Mission and Activity sit side by side");
		MissionBoardLayout scaleFour = MissionBoardLayout.calculate(480, 270);
		assertTrue(scaleFour.centre().width() >= 300, "at GUI scale 4 the folded column is wide enough for the rail's rows");
		assertTrue(scaleFour.centreScrollMaximum(AgentControlScreen.LIVE_NATURAL + AgentControlScreen.STACK_GAP + 150) > 0,
				"at GUI scale 4 the live view and rail scroll together");
		MissionBoardLayout banner = MissionBoardLayout.calculate(640, 360, AgentControlScreen.bannerInset(2));
		assertTrue(banner.centre().top() > AgentControlScreen.bannerBounds(banner.shell(), 2).bottom(),
				"the board's columns start below a status banner");
		dev.agaminggod.mineagen.server.BoatAccount.Status signedIn = new dev.agaminggod.mineagen.server.BoatAccount.Status(
				"idle", true, "oauth", null, 0D, null);
		dev.agaminggod.mineagen.server.BoatAccount.Status signedOut = new dev.agaminggod.mineagen.server.BoatAccount.Status(
				"signed_out", false, "none", null, 0D, null);
		assertEquals(AgentControlScreen.RunsOnStep.ASK_CONSENT, AgentControlScreen.runsOnStep("boat", false, signedIn),
				"switching to boat asks for consent before anything is sent");
		assertEquals(AgentControlScreen.RunsOnStep.SIGN_IN_FIRST, AgentControlScreen.runsOnStep("boat", false, signedOut),
				"switching to boat while signed out asks for the boat sign-in first");
		assertEquals(AgentControlScreen.RunsOnStep.HOST_ONLY, AgentControlScreen.runsOnStep("boat", false, null),
				"off the host the switch cannot move agents");
		assertEquals(AgentControlScreen.RunsOnStep.SWITCH_LOCAL, AgentControlScreen.runsOnStep("local", true, signedIn),
				"switching back to this PC needs no consent");
		assertEquals(AgentControlScreen.RunsOnStep.NOTHING, AgentControlScreen.runsOnStep("boat", true, signedIn),
				"choosing the current place does nothing");
		List<String> sent = new java.util.ArrayList<>();
		assertTrue(AgentControlScreen.sendSwitchToBoat(action -> sent.add(action)), "an accepted consent switches to boat");
		assertEquals(List.of("consent:on", "runs_on:boat"), sent, "consent is sent before the switch");
		sent.clear();
		assertTrue(!AgentControlScreen.sendSwitchToBoat(action -> { sent.add(action); return false; }),
				"a refused consent reports failure");
		assertEquals(List.of("consent:on"), sent, "the switch is never sent when consent was not taken");
		com.google.gson.JsonObject view = com.google.gson.JsonParser.parseString(
				"{\"plan\":{\"steps\":[{\"status\":\"complete\"},{\"status\":\"active\"},{\"status\":\"pending\"}]}}").getAsJsonObject();
		assertTrue(java.util.Arrays.equals(new int[] {1, 3}, AgentControlScreen.planProgress(view)), "the progress bar counts complete steps");
		assertTrue(java.util.Arrays.equals(new int[] {0, 0}, AgentControlScreen.planProgress(null)), "no live view means no plan");
		assertTrue(AgentControlScreen.boatShapeChanged(signedIn, signedOut), "a sign-out rebuilds the rail");
		assertTrue(!AgentControlScreen.boatShapeChanged(new dev.agaminggod.mineagen.server.BoatAccount.Status("running", true, "oauth", "m", 0.01D, null),
				new dev.agaminggod.mineagen.server.BoatAccount.Status("running", true, "oauth", "m", 0.02D, null)),
				"the cost ticking up redraws in place without a rebuild");
		return assertions + 3 + 13 + 3 + verifyLiveViewData();
	}

	private static int verifyLiveViewData() {
		com.google.gson.JsonObject view = com.google.gson.JsonParser.parseString("""
				{"plan":{"steps":[{"label":"Find wood","status":"complete"},{"id":"craft","status":"active"},{"label":" "}]},
				 "events":[{"stage":"tool","message":"mine log","at":5},{"stage":"live_delta","message":"looking\nfor trees"},{"stage":"x","message":""}],
				 "decision":{"action":"Mine the oak","purpose":"planks"}}""").getAsJsonObject();
		com.google.gson.JsonObject usage = new com.google.gson.JsonObject();
		usage.addProperty("inputTokens", 12_400);
		view.add("usage", usage);
		List<BoardLiveView.Step> steps = BoardLiveView.steps(view);
		assertEquals(2, steps.size(), "plan steps without any name are left out");
		assertEquals("craft", steps.get(1).label(), "a step with no label falls back to its id");
		List<BoardLiveView.Event> events = BoardLiveView.events(view);
		assertEquals(2, events.size(), "events without a message are left out");
		assertEquals("thinking", events.get(0).tag(), "events show newest first, thoughts tagged as thinking");
		assertEquals("looking for trees", events.get(0).message(), "a multi-line event reads as one line");
		assertEquals("Mine the oak: planks", BoardLiveView.decision(view), "the next decision shows its action and purpose");
		assertEquals("", BoardLiveView.decision(null), "no live view means no decision");
		assertEquals("", BoardLiveView.usage(null), "no usage is left out, not shown as zero");
		assertEquals("12.4k", BoardLiveView.tokens(12_400), "token counts read in thousands");
		assertEquals("Nether", AgentBody.dimensionLabel("minecraft:the_nether"), "dimensions read by name");
		assertEquals("Deep dark", AgentBody.dimensionLabel("mod:deep_dark"), "a modded dimension reads in title case");
		assertTrue(BoardLiveView.naturalHeight(400) < BoardLiveView.naturalHeight(300), "a narrow live view stacks its panels");
		return 12;
	}

	/** Pending feedback is neutral, and a long offline reason gets a measured banner that the Now card stays below. */
	private static void verifyStatusBanner() {
		assertEquals(dev.agaminggod.mineagen.control.AgentControlResult.Tone.PENDING, AgentControlScreen.feedbackTone(false, false),
				"a \"Sending...\" line the screen wrote itself is pending, not success");
		assertEquals(dev.agaminggod.mineagen.control.AgentControlResult.Tone.SUCCESS, AgentControlScreen.feedbackTone(false, true),
				"a line the server confirmed is a success");
		assertEquals(dev.agaminggod.mineagen.control.AgentControlResult.Tone.REFUSED, AgentControlScreen.feedbackTone(true, false),
				"an error line is a refusal");
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

	/** The banner holds only as many lines as keep the Manage page's last row above the footer. */
	private static void verifyBannerCap() {
		java.util.function.ToIntFunction<String> measure = text -> text.length() * 6;
		List<String> four = List.of("one two", "three four", "five six", "seven eight");
		assertEquals(3, AgentControlScreen.capBannerLines(four, 3, 600, measure).size(), "a cap of three keeps three lines");
		assertEquals(List.of("one two", "three four five six seven eight..."), AgentControlScreen.capBannerLines(four, 2, 600, measure),
				"a cap of two keeps two lines and the last one carries the rest");
		assertTrue(AgentControlScreen.capBannerLines(four, 0, 600, measure).isEmpty(),
				"a cap of zero gives way to the shortened header line");
		assertTrue(AgentControlScreen.capBannerLines(four, 2, 60, measure).get(1).length() * 6 <= 60,
				"a shortened last line still fits its width");
		assertEquals(four.subList(0, 3), AgentControlScreen.capBannerLines(four.subList(0, 3), 3, 600, measure),
				"lines within the cap are kept as they are");
		for (int[] size : new int[][] {{320, 180}, {320, 240}, {427, 240}, {480, 270}, {640, 360}}) {
			String at = " at " + size[0] + "x" + size[1];
			int lines = AgentControlScreen.maxBannerLines(size[0], size[1]);
			assertTrue(lines >= 0 && lines <= 3, "the banner cap stays between 0 and 3" + at);
			AgentControlLayout withBanner = AgentControlLayout.calculate(size[0], size[1], AgentControlScreen.bannerInset(lines));
			assertTrue(lines == 0 || AgentControlScreen.manageRowsBottom(withBanner) <= withBanner.footerY(),
					"under the largest allowed banner the Manage page's last row ends above the footer" + at);
		}
		assertTrue(AgentControlScreen.maxBannerLines(640, 360) >= 2, "a 640x360 screen holds a multi-line banner");
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
