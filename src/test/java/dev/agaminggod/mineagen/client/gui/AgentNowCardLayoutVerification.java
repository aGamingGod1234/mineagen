package dev.agaminggod.mineagen.client.gui;

/**
 * The control center's Now card has a place on every layout: the context rail when it is wide, a strip under the
 * roster when it is narrow (1080p at GUI scale 3 is 640x360, at scale 4 480x270), and the Manage page.
 */
public final class AgentNowCardLayoutVerification {
	private AgentNowCardLayoutVerification() {
	}

	public static int verify() {
		int assertions = 0;
		for (int[] size : new int[][] {{480, 270}, {640, 360}, {320, 240}, {700, 360}}) {
			AgentControlLayout layout = AgentControlLayout.calculate(size[0], size[1]);
			String at = size[0] + "x" + size[1];
			assertTrue(!layout.splitWorkspace(), at + " has no context rail, so the overview needs its own Now strip");
			for (int agents : new int[] {1, 2, 4, 8, 16}) {
				String with = at + " with " + agents + " agents";
				boolean filters = AgentControlLayout.rosterFiltersVisible(agents);
				AgentControlLayout.Bounds now = AgentControlScreen.overviewNowBounds(layout, filters, agents);
				AgentControlLayout.Bounds roster = AgentControlScreen.overviewRosterBounds(layout, filters, agents);
				AgentControlLayout.Bounds full = AgentControlScreen.overviewRosterBounds(layout, filters);
				assertTrue(now != null, with + ": the overview shows a Now strip");
				assertTrue(AgentControlScreen.nowRowCapacity(now.height()) >= 1, with + ": the strip fits at least the state row");
				assertTrue(now.left() == layout.canvasLeft() && now.right() == layout.canvasRight(), with + ": the strip spans the canvas");
				assertTrue(now.bottom() <= layout.contentBottom() && now.bottom() < layout.footerY(), with + ": the strip stays above the footer");
				assertTrue(roster.bottom() + AgentControlScreen.NOW_GAP <= now.top(), with + ": the roster ends above the strip");
				assertTrue(roster.top() == full.top(), with + ": the roster keeps its top under the title and filters");
				AgentRosterGridLayout grid = AgentRosterGridLayout.calculate(roster.left(), roster.top(), roster.right(), roster.bottom(), agents);
				assertTrue(grid.tileHeight() >= 24 && grid.rows() >= 1, with + ": the roster still has readable tiles");
				if (agents <= 2) assertTrue(AgentControlScreen.nowRowCapacity(now.height()) >= 3,
						with + ": a small roster leaves the strip room for the state, doing and more");
				assertions += 8 + (agents <= 2 ? 1 : 0);
			}
			AgentControlLayout.Bounds manage = AgentControlScreen.manageNowBounds(layout);
			assertTrue(manage != null && AgentControlScreen.nowRowCapacity(manage.height()) >= 1, at + ": the Manage page shows a Now card");
			assertTrue(manage.bottom() <= layout.contentBottom() && manage.top() >= AgentControlScreen.bodyTop(layout), at + ": inside the content");
			assertions += 2;
		}
		for (int[] size : new int[][] {{640, 360}, {480, 270}}) {
			AgentControlLayout layout = AgentControlLayout.calculate(size[0], size[1]);
			assertTrue(AgentControlScreen.nowRowCapacity(AgentControlScreen.manageNowBounds(layout).height()) >= 3,
					size[0] + "x" + size[1] + ": the Manage page's Now card has room for state, doing and decision");
			assertions++;
		}
		AgentControlLayout wide = AgentControlLayout.calculate(960, 540);
		assertTrue(wide.splitWorkspace() && AgentControlScreen.overviewNowBounds(wide, false, 1) == null,
				"a wide overview carries the Now card in its context rail, not a strip");
		assertTrue(AgentControlScreen.overviewRosterBounds(wide, false, 1).equals(AgentControlScreen.overviewRosterBounds(wide, false)),
				"and keeps its whole roster region");
		assertTrue(AgentControlScreen.overviewNowBounds(AgentControlLayout.calculate(640, 360), false, 0) == null,
				"with no agents there is no strip (the empty state is shown)");
		assertTrue(AgentControlScreen.nowRowCapacity(AgentControlScreen.NOW_PAD * 2 + AgentControlScreen.NOW_ROW - 1) == 0
				&& AgentControlScreen.nowRowCapacity(AgentControlScreen.NOW_PAD * 2 + AgentControlScreen.NOW_ROW * 2) == 2,
				"row capacity is measured from the card height");
		for (int[] size : new int[][] {{320, 180}, {200, 150}, {1, 1}}) {
			AgentControlLayout tiny = AgentControlLayout.calculate(size[0], size[1]);
			AgentControlScreen.overviewNowBounds(tiny, true, 16);
			AgentControlScreen.overviewRosterBounds(tiny, true, 16);
			AgentControlScreen.manageNowBounds(tiny);
		}
		return assertions + 4;
	}

	private static void assertTrue(boolean actual, String label) {
		if (!actual) throw new AssertionError(label);
	}
}
