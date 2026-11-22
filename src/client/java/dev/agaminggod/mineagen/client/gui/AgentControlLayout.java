package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.control.AgentRosterFilter;
import java.util.Objects;

/**
 * Regions of the control center panel. A header row (mark, breadcrumb, link status) sits above one content area
 * and a footer row of actions; wide panels add a context rail beside the content. There is no navigation column:
 * the control center has one section, so the breadcrumb carries where you are.
 */
public record AgentControlLayout(
		int panelLeft,
		int panelTop,
		int panelRight,
		int panelBottom,
		int headerBottom,
		int contentLeft,
		int contentTop,
		int contentRight,
		int contentBottom,
		int canvasLeft,
		int canvasRight,
		int contextLeft,
		int contextRight,
		int footerY,
		boolean splitWorkspace,
		boolean roomy
) {
	public static final int CONTROL_HEIGHT = 24;
	public static final int HEADER_HEIGHT = 32;
	public static final int GUTTER = 16;
	private static final int MINIMUM_WIDTH = 320;
	private static final int MINIMUM_HEIGHT = 240;
	private static final int OUTER_MARGIN = 8;
	private static final int MAXIMUM_PANEL_WIDTH = 760;
	private static final int MAXIMUM_PANEL_HEIGHT = 440;
	private static final int CONTEXT_RAIL_BREAKPOINT = 700;
	private static final int CONTEXT_RAIL_WIDTH = 208;
	private static final int REGION_GAP = 16;
	private static final int ROSTER_FILTER_HEIGHT = 30;
	private static final int WORKSPACE_ACTION_GAP = 6;
	/** Content taller than this shows page titles and field labels; shorter panels drop them to fit. */
	private static final int ROOMY_CONTENT_HEIGHT = 250;

	public static AgentControlLayout calculate(int screenWidth, int screenHeight) {
		if (screenWidth < MINIMUM_WIDTH || screenHeight < MINIMUM_HEIGHT) {
			throw new IllegalArgumentException("Agent control requires at least a 320x240 GUI");
		}
		int panelWidth = Math.min(MAXIMUM_PANEL_WIDTH, screenWidth - OUTER_MARGIN * 2);
		int panelLeft = (screenWidth - panelWidth) / 2;
		int verticalMargin = screenHeight <= 280 ? 4 : OUTER_MARGIN;
		// On tall GUIs the panel stops growing and centers, so a short form doesn't float above a tall empty sheet.
		int panelHeight = Math.min(MAXIMUM_PANEL_HEIGHT, screenHeight - verticalMargin * 2);
		int panelTop = (screenHeight - panelHeight) / 2;
		int panelRight = panelLeft + panelWidth;
		int panelBottom = panelTop + panelHeight;
		int gutter = panelWidth < 400 ? 10 : GUTTER;
		int headerBottom = panelTop + HEADER_HEIGHT;
		int contentLeft = panelLeft + gutter;
		int contentRight = panelRight - gutter;
		int contentTop = headerBottom + 4;
		int footerY = panelBottom - CONTROL_HEIGHT - (panelWidth < 400 ? 6 : 10);
		int contentBottom = footerY - 8;
		int contentWidth = contentRight - contentLeft;
		boolean splitWorkspace = contentWidth >= CONTEXT_RAIL_BREAKPOINT;
		int contextLeft = splitWorkspace ? contentRight - CONTEXT_RAIL_WIDTH : contentRight;
		int canvasRight = splitWorkspace ? contextLeft - REGION_GAP : contentRight;
		return new AgentControlLayout(
				panelLeft, panelTop, panelRight, panelBottom, headerBottom,
				contentLeft, contentTop, contentRight, contentBottom,
				contentLeft, canvasRight, contextLeft, contentRight,
				footerY, splitWorkspace, contentBottom - contentTop >= ROOMY_CONTENT_HEIGHT
		);
	}

	/** Forms use the whole content width; the panel's own width cap keeps lines a readable length. */
	public int formWidth() {
		return contentWidth();
	}

	public int formLeft() {
		return contentLeft;
	}

	public int panelWidth() {
		return panelRight - panelLeft;
	}

	public int contentWidth() {
		return contentRight - contentLeft;
	}

	public int contentHeight() {
		return contentBottom - contentTop;
	}

	public int canvasWidth() {
		return canvasRight - canvasLeft;
	}

	public int contextWidth() {
		return splitWorkspace ? contextRight - contextLeft : 0;
	}

	public int minimumTargetHeight() {
		return CONTROL_HEIGHT;
	}

	public static boolean rosterFiltersVisible(int authoritativeCount) {
		if (authoritativeCount < 0) {
			throw new IllegalArgumentException("Authoritative roster count cannot be negative");
		}
		return authoritativeCount >= 9;
	}

	public static int rosterPageAfterFilterUpdate(
			AgentRosterFilter currentFilter,
			AgentRosterFilter nextFilter,
			int currentPage
	) {
		Objects.requireNonNull(currentFilter, "current filter must not be null");
		Objects.requireNonNull(nextFilter, "next filter must not be null");
		if (currentPage < 1) throw new IllegalArgumentException("Roster page must be positive");
		return currentFilter.equals(nextFilter) ? currentPage : 1;
	}

	public Bounds rosterBounds(boolean filtersVisible, boolean reserveActionRow) {
		return rosterBounds(contentTop, filtersVisible, reserveActionRow);
	}

	public Bounds rosterBounds(int bodyTop, boolean filtersVisible, boolean reserveActionRow) {
		int top = bodyTop + (filtersVisible ? ROSTER_FILTER_HEIGHT : 0);
		int bottom = contentBottom - (reserveActionRow ? CONTROL_HEIGHT + WORKSPACE_ACTION_GAP : 0);
		return new Bounds(canvasLeft, top, canvasRight, bottom);
	}


	public record Bounds(int left, int top, int right, int bottom) {
		public Bounds {
			if (right < left || bottom < top) throw new IllegalArgumentException("Layout bounds cannot be inverted");
		}

		public int width() {
			return right - left;
		}

		public int height() {
			return bottom - top;
		}
	}
}
