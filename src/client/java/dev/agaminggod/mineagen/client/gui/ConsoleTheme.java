package dev.agaminggod.mineagen.client.gui;

import java.util.Locale;

/** Shared, contrast-auditable visual language for every Mineagen screen and HUD. */
public final class ConsoleTheme {
	// Diamond: deep ink surfaces separated by tone, not outlines; one cyan accent for the current choice and the
	// main action. Every token is audited for contrast in ConsoleThemeVerification.
	public static final int BACKDROP = 0xA6070A0F;
	public static final int PANEL = 0xFA11151C;
	public static final int NAVIGATION = 0xFF0E1218;
	public static final int TRACK = 0xFF0B0F14;
	public static final int SURFACE = 0xFF1A2029;
	public static final int SURFACE_HOVER = 0xFF232B36;
	public static final int SURFACE_RAISED = 0xFF2A3340;
	public static final int SURFACE_SELECTED = 0xFF15303A;
	public static final int POPUP = 0xFF1D242E;
	public static final int BORDER = 0xFF2B3440;
	public static final int FOCUS = 0xFFD8F5FF;
	public static final int TEXT = 0xFFEEF1F5;
	public static final int MUTED = 0xFF8F99A8;
	public static final int SUBTLE = 0xFF6A7484;
	public static final int ACCENT = 0xFF5FD4F4;
	public static final int ACCENT_HOVER = 0xFF8BE2F8;
	public static final int ACCENT_INK = 0xFF04212B;
	public static final int ROSTER_FOCUS = 0xFFCAD2DC;
	public static final int ROSTER_SELECTED_SURFACE = 0xFF15303A;
	public static final int ROSTER_UNAVAILABLE_SURFACE = 0xFF151A21;

	/** The colour of a lifecycle state's tone, wherever the state is drawn. */
	public static int stateColor(dev.agaminggod.mineagen.control.AgentControlPresentation.StateTone tone) {
		return switch (tone) {
			case POSITIVE -> SUCCESS;
			case ACTIVE -> ACCENT;
			case PROBLEM -> ERROR;
			case NEUTRAL -> MUTED;
		};
	}
	public static final int SUCCESS = 0xFF5EE0A0;
	public static final int WARNING = 0xFFF5C451;
	public static final int ERROR = 0xFFFF6B7A;
	public static final int DANGER_SURFACE = 0xFF3A1E25;
	public static final int DANGER_HOVER = 0xFF4B2630;
	public static final int CODEX = 0xFF42D39B;
	public static final int CLAUDE = 0xFFD97757;
	/** Boat is where agents run, not a model: its pill, machine block and sign-in row share this blue. */
	public static final int BOAT = 0xFF5AB4FF;
	public static final int BOAT_SURFACE = 0xFF14263A;
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
