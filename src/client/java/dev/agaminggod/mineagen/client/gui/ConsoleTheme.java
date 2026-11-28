package dev.agaminggod.mineagen.client.gui;

import java.util.Locale;

/** Shared, contrast-auditable visual language for every Mineagen screen and HUD. */
public final class ConsoleTheme {
	// Obsidian: neutral graphite surfaces over the blurred world, separated by tone rather than outlines. One soft
	// emerald accent marks what is selected or alive; the main action is a quiet near-white button, not a neon one.
	// Every token is audited for contrast in ConsoleThemeVerification.
	public static final int BACKDROP = 0x8C000000;
	public static final int PANEL = 0xE8131416;
	/** Buttons are a faint lift of white over whatever they sit on, so they never read as a box inside a box. */
	public static final int BUTTON = 0x12FFFFFF;
	public static final int BUTTON_HOVER = 0x1FFFFFFF;
	public static final int BUTTON_INACTIVE = 0x0AFFFFFF;
	public static final int NAVIGATION = 0xFF17181B;
	public static final int TRACK = 0xFF0D0E10;
	public static final int SURFACE = 0xFF1D1F22;
	public static final int SURFACE_HOVER = 0xFF25272B;
	public static final int SURFACE_RAISED = 0xFF2D2F34;
	public static final int SURFACE_SELECTED = 0xFF263129;
	public static final int POPUP = 0xFF1B1C1F;
	public static final int BORDER = 0xFF2E3035;
	/** Screen-pixel dividers between regions: barely there, so space does the separating. */
	public static final int HAIRLINE = 0x16FFFFFF;
	public static final int FOCUS = 0xFFF4F4F2;
	public static final int TEXT = 0xFFF1F1EE;
	public static final int MUTED = 0xFF9C9EA3;
	public static final int SUBTLE = 0xFF6C6F75;
	public static final int ACCENT = 0xFF7FD69A;
	public static final int ACCENT_HOVER = 0xFF9BE3B1;
	public static final int ACCENT_INK = 0xFF0C1A11;
	/** The one filled action per page (Start, Create agent): near-white with dark ink. */
	public static final int PRIMARY = 0xFFE9E9E5;
	public static final int PRIMARY_HOVER = 0xFFFFFFFF;
	public static final int PRIMARY_INK = 0xFF131416;
	public static final int ROSTER_FOCUS = 0xFFCDD0D4;
	public static final int ROSTER_SELECTED_SURFACE = 0xFF263129;
	public static final int ROSTER_UNAVAILABLE_SURFACE = 0xFF17181B;

	/** The colour of a lifecycle state's tone, wherever the state is drawn. */
	public static int stateColor(dev.agaminggod.mineagen.control.AgentControlPresentation.StateTone tone) {
		return switch (tone) {
			case POSITIVE -> SUCCESS;
			case ACTIVE -> ACCENT;
			case PROBLEM -> ERROR;
			case NEUTRAL -> MUTED;
		};
	}
	public static final int SUCCESS = ACCENT;
	public static final int WARNING = 0xFFE6C276;
	public static final int ERROR = 0xFFF2837E;
	public static final int DANGER_SURFACE = 0xFF34201F;
	public static final int DANGER_HOVER = 0xFF452926;
	public static final int CODEX = 0xFF42D39B;
	public static final int CLAUDE = 0xFFD97757;
	/** Boat is where agents run, not a model: its pill, machine block and sign-in row share this blue. */
	public static final int BOAT = 0xFF8EC5FF;
	public static final int BOAT_SURFACE = 0xFF1C2530;
	// Slightly lighter Claude orange so roster text clears 4.5:1 on the selected surface.
	public static final int ROSTER_CLAUDE = 0xFFE08A6D;

	private ConsoleTheme() {
	}

	public static int controlOutline(boolean selected, boolean focused, boolean hovered) {
		if (focused) return FOCUS;
		if (selected) return ACCENT;
		return BORDER;
	}

	public static int providerColor(String provider) {
		if (provider == null) return TEXT;
		return switch (provider.toLowerCase(Locale.ROOT)) {
			case "codex" -> CODEX;
			case "claude" -> CLAUDE;
			default -> TEXT;
		};
	}

	public static int rosterProviderColor(String provider) {
		if (provider == null) return TEXT;
		return switch (provider.toLowerCase(Locale.ROOT)) {
			case "claude" -> ROSTER_CLAUDE;
			default -> providerColor(provider);
		};
	}

	public static double contrastRatio(int foreground, int background) {
		double light = luminance(foreground);
		double dark = luminance(background);
		if (light < dark) {
			double swap = light;
			light = dark;
			dark = swap;
		}
		return (light + 0.05D) / (dark + 0.05D);
	}

	private static double luminance(int color) {
		double red = linear((color >> 16) & 0xFF);
		double green = linear((color >> 8) & 0xFF);
		double blue = linear(color & 0xFF);
		return 0.2126D * red + 0.7152D * green + 0.0722D * blue;
	}

	private static double linear(int channel) {
		double value = channel / 255.0D;
		return value <= 0.04045D ? value / 12.92D : Math.pow((value + 0.055D) / 1.055D, 2.4D);
	}
}
