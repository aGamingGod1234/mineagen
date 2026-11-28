package dev.agaminggod.mineagen.client.gui;

/**
 * Regions of the control center's one-screen mission board: the agent list on the left, the selected agent's live
 * view across the rest and the task row along the bottom. Where agents run and how they sign in live in a drawer
 * that opens from the header's compute pill over the live view's right side, so the live view keeps the full width
 * at every GUI scale. The header comes from {@link AgentControlLayout}.
 */
public record MissionBoardLayout(
		AgentControlLayout shell,
		AgentControlLayout.Bounds list,
		AgentControlLayout.Bounds centre,
		AgentControlLayout.Bounds drawer,
		AgentControlLayout.Bounds taskRow,
		boolean listCompact
) {
	public static final int LIST_MINIMUM = 104;
	public static final int LIST_MAXIMUM = 160;
	public static final int DRAWER_MINIMUM = 196;
	public static final int DRAWER_MAXIMUM = 236;
	public static final int ROW = 20;
	/** Below this content width the list shows each agent as its head only: a 1080p screen at GUI scale 4 (480x270). */
	public static final int LIST_COMPACT_BREAKPOINT = 520;
	public static final int LIST_COMPACT = 30;

	public static MissionBoardLayout calculate(int width, int height) {
		return calculate(width, height, 0);
	}

	/** Never throws: on GUIs below the design minimum every region shrinks but stays ordered and inside the panel. */
	public static MissionBoardLayout calculate(int width, int height, int bannerInset) {
		AgentControlLayout shell = AgentControlLayout.calculateBoard(width, height, bannerInset);
		int left = shell.contentLeft();
		int right = shell.contentRight();
		int top = shell.contentTop();
		int bottom = shell.contentBottom();
		int contentWidth = right - left;
		int gap = shell.panelWidth() < 400 ? 10 : 16;
		boolean compact = contentWidth < LIST_COMPACT_BREAKPOINT;
		int listWidth = compact ? LIST_COMPACT : Math.min(Math.max(LIST_MINIMUM, contentWidth * 18 / 100), LIST_MAXIMUM);
		// On a GUI too small for both columns the list keeps a third and the centre the rest.
		if (contentWidth - listWidth - gap < 120) listWidth = Math.max(0, Math.min(listWidth, contentWidth / 3));
		int listRight = Math.min(right, left + listWidth);
		int centreLeft = Math.min(right, listRight + gap);
		AgentControlLayout.Bounds list = new AgentControlLayout.Bounds(left, top, listRight, bottom);
		AgentControlLayout.Bounds centre = new AgentControlLayout.Bounds(centreLeft, top, right, bottom);
		int drawerWidth = Math.min(contentWidth, Math.clamp(contentWidth * 36 / 100, DRAWER_MINIMUM, DRAWER_MAXIMUM));
		int drawerTop = Math.min(bottom, shell.headerBottom() + 2);
		AgentControlLayout.Bounds drawer = new AgentControlLayout.Bounds(right - drawerWidth, drawerTop, right,
				Math.max(drawerTop, bottom));
		int taskTop = shell.footerY();
		AgentControlLayout.Bounds task = new AgentControlLayout.Bounds(left, taskTop, right,
				Math.max(taskTop, Math.min(shell.panelBottom(), taskTop + AgentControlLayout.CONTROL_HEIGHT)));
		return new MissionBoardLayout(shell, list, centre, drawer, task, compact);
	}

	/** Height the live view takes: the whole column, or its natural height when that is taller and the column scrolls. */
	public int liveHeight(int naturalHeight) {
		return Math.max(centre.height(), naturalHeight);
	}

	/** How far the centre column scrolls for a live view {@code naturalHeight} tall; 0 when it fits. */
	public int centreScrollMaximum(int naturalHeight) {
		return Math.max(0, naturalHeight - centre.height());
	}
}
