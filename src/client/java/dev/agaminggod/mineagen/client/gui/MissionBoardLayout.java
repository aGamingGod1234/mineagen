package dev.agaminggod.mineagen.client.gui;

/**
 * Regions of the control center's one-screen mission board: the agent list on the left, the selected agent's live
 * view in the centre, the "Runs on" rail on the right and the task row along the bottom. The header comes from
 * {@link AgentControlLayout}. On narrow panels (high GUI scale) the rail folds: it has no column of its own and the
 * screen stacks it under the live view in a centre column that scrolls.
 */
public record MissionBoardLayout(
		AgentControlLayout shell,
		AgentControlLayout.Bounds list,
		AgentControlLayout.Bounds centre,
		AgentControlLayout.Bounds rail,
		AgentControlLayout.Bounds taskRow,
		boolean railFolded,
		boolean listCompact
) {
	/** Content narrower than this folds the rail under the live view: a 1080p screen at GUI scale 4 (480x270) folds, scale 3 keeps it. */
	public static final int RAIL_BREAKPOINT = 560;
	public static final int LIST_MINIMUM = 92;
	public static final int LIST_MAXIMUM = 150;
	public static final int RAIL_MINIMUM = 160;
	public static final int RAIL_MAXIMUM = 196;
	public static final int ROW = 20;
	/** Below this content width the list shows each agent as its head only, so the live view keeps its room. */
	public static final int LIST_COMPACT_BREAKPOINT = 700;
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
		int gap = shell.panelWidth() < 400 ? 8 : 10;
		boolean folded = contentWidth < RAIL_BREAKPOINT;
		boolean compact = contentWidth < LIST_COMPACT_BREAKPOINT;
		int listWidth = compact ? LIST_COMPACT : Math.min(Math.max(LIST_MINIMUM, contentWidth * 20 / 100), LIST_MAXIMUM);
		// On a GUI too small for both columns the list keeps a third and the centre the rest.
		if (contentWidth - listWidth - gap < 120) listWidth = Math.max(0, Math.min(listWidth, contentWidth / 3));
		int listRight = Math.min(right, left + listWidth);
		int railWidth = folded ? 0 : Math.min(Math.max(RAIL_MINIMUM, contentWidth * 28 / 100), RAIL_MAXIMUM);
		int railLeft = folded ? right : right - railWidth;
		int centreLeft = Math.min(right, listRight + gap);
		int centreRight = Math.max(centreLeft, folded ? right : railLeft - gap);
		AgentControlLayout.Bounds list = new AgentControlLayout.Bounds(left, top, listRight, bottom);
		AgentControlLayout.Bounds centre = new AgentControlLayout.Bounds(centreLeft, top, centreRight, bottom);
		AgentControlLayout.Bounds rail = new AgentControlLayout.Bounds(railLeft, top, right, bottom);
		int taskTop = shell.footerY();
		AgentControlLayout.Bounds task = new AgentControlLayout.Bounds(left, taskTop, right,
				Math.max(taskTop, Math.min(shell.panelBottom(), taskTop + AgentControlLayout.CONTROL_HEIGHT)));
		return new MissionBoardLayout(shell, list, centre, rail, task, folded, compact);
	}

	/** Width of the rail's content: its own column, or the centre column once folded under the live view. */
	public int railContentWidth() {
		return railFolded ? centre.width() : rail.width();
	}

	/**
	 * Height the live view takes in the centre column. Beside an unfolded rail it fills the column; folded, it takes its
	 * natural height and the rail follows below it, the column scrolling when both are taller than the view.
	 */
	public int liveHeight(int naturalHeight) {
		return railFolded ? Math.max(0, naturalHeight) : centre.height();
	}

	/** How far the folded centre column can scroll for a stack {@code stackHeight} tall; 0 when it fits or the rail has a column. */
	public int centreScrollMaximum(int stackHeight) {
		return railFolded ? Math.max(0, stackHeight - centre.height()) : 0;
	}
}
