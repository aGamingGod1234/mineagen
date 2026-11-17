package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.control.AgentControlCatalog;
import dev.agaminggod.mineagen.control.AgentControlModelOption;
import java.util.List;

public final class AgentControlLayoutVerification {
	private AgentControlLayoutVerification() {
	}

	public static int verify() {
		AgentControlLayout wide = AgentControlLayout.calculate(960, 540);
		assertTrue(wide.sideNavigation(), "wide command center keeps persistent side navigation");
		assertTrue(wide.splitWorkspace(), "wide command center reserves a readable context rail");
		assertTrue(wide.canvasWidth() >= 420, "wide command center keeps a useful primary canvas");
		assertTrue(wide.contextWidth() >= 180, "wide command center context rail remains readable");
		assertTrue(wide.navigationTop() - wide.panelTop() >= 57,
				"wide navigation leaves breathing room below the console header");
		assertTrue(wide.contentBottom() < wide.footerY(), "wide content never collides with footer actions");

		AgentControlLayout compact = AgentControlLayout.calculate(320, 240);
		assertTrue(!compact.sideNavigation(), "compact command center reflows navigation above the canvas");
		assertTrue(!compact.splitWorkspace(), "compact command center stacks context below the primary task");
		assertTrue(compact.canvasWidth() >= 276, "compact canvas stays wide enough for prompt and roster controls");
		assertTrue(compact.contentTop() > compact.navigationBottom(), "compact content begins after navigation");
		assertTrue(compact.navigationTop() - compact.panelTop() >= 45,
				"compact navigation leaves breathing room below the console header");
		assertTrue(compact.footerY() + AgentControlLayout.CONTROL_HEIGHT <= compact.panelBottom(),
				"compact footer remains fully on screen");
		assertTrue(compact.minimumTargetHeight() >= 24, "custom controls meet the minimum target-height contract");

		AgentControlLayout mid = AgentControlLayout.calculate(700, 360);
		assertTrue(mid.sideNavigation(), "medium screens preserve stable side navigation when space permits");
		assertTrue(!mid.splitWorkspace(), "medium screens avoid cramped three-column layouts");
		assertTrue(mid.canvasWidth() > 500, "medium workspace uses the freed context-rail width");

		assertThrows(IllegalArgumentException.class, () -> AgentControlLayout.calculate(319, 240),
				"unsupported widths fail explicitly instead of creating negative widgets");
		assertThrows(IllegalArgumentException.class, () -> AgentControlLayout.calculate(320, 239),
				"unsupported heights fail explicitly instead of creating overlapping widgets");

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
		assertTrue(AgentControlScreen.providerKeyScrollMaximum(80, 210, 110, 4) > 0, "compact setup scrolls to all provider keys");
		assertEquals(0, AgentControlScreen.providerKeyScrollMaximum(80, 600, 110, 4), "tall setup fits all inline rows");
		return 33;
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
