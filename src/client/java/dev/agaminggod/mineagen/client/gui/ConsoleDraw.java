package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.control.AgentControlPresentation;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.network.chat.Component;
import net.minecraft.resources.Identifier;

/**
 * Drawing primitives for the control center: rounded surfaces, rings, the panel shadow, icons and type.
 *
 * GUI sprites are point-sampled, so a single hi-res texture scaled by 3 or 5 gets uneven corners. Every sprite
 * exists once per GUI scale at one texel per screen pixel (scripts/generate-console-sprites.py), and these
 * helpers draw it in screen pixels by undoing the GUI scale around the blit.
 */
public final class ConsoleDraw {
	public static final int RADIUS_SMALL = 3;
	public static final int RADIUS_CONTROL = 4;
	public static final int RADIUS_CARD = 6;
	public static final int RADIUS_PANEL = 8;
	private static final int MAX_SHAPE_SCALE = 6;
	private static final int MAX_ICON_SCALE = 4;
	public static final int SHADOW_SPREAD = 10;

	public enum Icon {
		PLUS, REFRESH, KEY, CHEVRON_DOWN, CHEVRON_LEFT, CHEVRON_RIGHT, CHECK, PLAY, PAUSE, TRASH, TERMINAL, MAP,
		SPARK, TASK, RESPAWN, AGENTS, BACK, EYE, LOGO;

		String sprite() {
			return name().toLowerCase(java.util.Locale.ROOT);
		}
	}

	private ConsoleDraw() {
	}

	public static int guiScale() {
		Minecraft minecraft = Minecraft.getInstance();
		return minecraft == null ? 2 : Math.max(1, minecraft.getWindow().getGuiScale());
	}

	/**
	 * A filled rectangle in GUI pixels, tinted with an ARGB color. Corners are square with a one-screen-pixel chamfer:
	 * the console is a crisp tool, not a stack of rounded cards. {@code radius} 0 draws a fully square block; any
	 * other value only asks for the chamfer, whatever its size.
	 */
	public static void surface(GuiGraphicsExtractor graphics, int x, int y, int width, int height, int radius, int color) {
		if (width <= 0 || height <= 0 || (color >>> 24) == 0) return;
		int scale = guiScale();
		graphics.pose().pushMatrix();
		graphics.pose().scale(1F / scale, 1F / scale);
		int left = x * scale, top = y * scale, right = (x + width) * scale, bottom = (y + height) * scale;
		if (radius <= 0 || right - left < 4 || bottom - top < 4) {
			graphics.fill(left, top, right, bottom, color);
		} else {
			// Three bands that never overlap, so a translucent fill stays even.
			graphics.fill(left + 1, top, right - 1, bottom, color);
			graphics.fill(left, top + 1, left + 1, bottom - 1, color);
			graphics.fill(right - 1, top + 1, right, bottom - 1, color);
		}
		graphics.pose().popMatrix();
	}

	/** An outline one screen pixel thick (two from GUI scale 4), used for keyboard focus. */
	public static void ring(GuiGraphicsExtractor graphics, int x, int y, int width, int height, int radius, int color) {
		if (width <= 0 || height <= 0 || (color >>> 24) == 0) return;
		int scale = guiScale();
		int line = scale >= 4 ? 2 : 1;
		graphics.pose().pushMatrix();
		graphics.pose().scale(1F / scale, 1F / scale);
		int left = x * scale, top = y * scale, right = (x + width) * scale, bottom = (y + height) * scale;
		graphics.fill(left + 1, top, right - 1, top + line, color);
		graphics.fill(left + 1, bottom - line, right - 1, bottom, color);
		graphics.fill(left, top + line, left + line, bottom - line, color);
		graphics.fill(right - line, top + line, right, bottom - line, color);
		graphics.pose().popMatrix();
	}

	/**
	 * A one-screen-pixel horizontal line. A GUI-pixel line is 3 or 4 screen pixels thick at GUI scale 3 or 4, which is
	 * what made dividers read as heavy boxes.
	 */
	public static void hairline(GuiGraphicsExtractor graphics, int x1, int x2, int y, int color) {
		if (x2 <= x1 || (color >>> 24) == 0) return;
		int scale = guiScale();
		graphics.pose().pushMatrix();
		graphics.pose().scale(1F / scale, 1F / scale);
		graphics.fill(x1 * scale, y * scale, x2 * scale, y * scale + 1, color);
		graphics.pose().popMatrix();
	}

	/** A one-screen-pixel vertical line; see {@link #hairline}. */
	public static void vhairline(GuiGraphicsExtractor graphics, int x, int y1, int y2, int color) {
		if (y2 <= y1 || (color >>> 24) == 0) return;
		int scale = guiScale();
		graphics.pose().pushMatrix();
		graphics.pose().scale(1F / scale, 1F / scale);
		graphics.fill(x * scale, y1 * scale, x * scale + 1, y2 * scale, color);
		graphics.pose().popMatrix();
	}

	/** Soft shadow that spreads {@link #SHADOW_SPREAD} GUI px beyond the given panel bounds. */
	public static void shadow(GuiGraphicsExtractor graphics, int x, int y, int width, int height, int alpha) {
		int scale = guiScale();
		int set = Math.min(scale, MAX_SHAPE_SCALE);
		int spread = SHADOW_SPREAD;
		blitScaled(graphics, Identifier.fromNamespaceAndPath("mineagen", "console/shadow_s" + set),
				x - spread, y - spread + 3, width + spread * 2, height + spread * 2, (alpha & 0xFF) << 24, scale, set);
	}

	public static void icon(GuiGraphicsExtractor graphics, Icon icon, int x, int y, int color) {
		icon(graphics, icon, x, y, icon == Icon.LOGO ? 16 : 12, color);
	}

	/** Icons are authored at 12 GUI px (the logo at 16); other sizes scale the nearest set. */
	public static void icon(GuiGraphicsExtractor graphics, Icon icon, int x, int y, int size, int color) {
		int scale = guiScale();
		int set = Math.min(scale, MAX_ICON_SCALE);
		Identifier id = Identifier.fromNamespaceAndPath("mineagen", "console/icon/" + icon.sprite() + "_s" + set);
		blitScaled(graphics, id, x, y, size, size, color, scale, set);
	}

	/**
	 * The state mark's size: the icons' own 12 GUI px, so each sprite set maps texel for texel. Drawn smaller, point
	 * sampling skipped whole columns of the art (the pause bars all but vanished at GUI scale 1).
	 */
	public static final int STATE_MARK_SIZE = 12;

	/** How a state is marked: an icon for what the bot is doing, else a dot (hollow when the state is not known live). */
	public record StateMark(Icon icon, boolean hollow, int color) {
	}

	public static StateMark stateMark(AgentControlPresentation.StateCue cue) {
		int color = ConsoleTheme.stateColor(cue.tone());
		return switch (cue) {
			case STARTING -> new StateMark(Icon.REFRESH, false, color);
			case THINKING -> new StateMark(Icon.SPARK, false, color);
			case WORKING -> new StateMark(Icon.PLAY, false, color);
			case PAUSED -> new StateMark(Icon.PAUSE, false, color);
			case DONE -> new StateMark(Icon.CHECK, false, color);
			case DEAD -> new StateMark(Icon.RESPAWN, false, color);
			case READY, NEEDS_ATTENTION -> new StateMark(null, false, color);
			case DISCONNECTED, UNKNOWN -> new StateMark(null, true, color);
		};
	}

	/** Draws the mark of a raw lifecycle state (AgentLifecycleState name) in a {@link #STATE_MARK_SIZE} square. */
	public static void stateMark(GuiGraphicsExtractor graphics, String lifecycleState, int x, int y) {
		stateMark(graphics, stateMark(AgentControlPresentation.stateCue(lifecycleState)), x, y, STATE_MARK_SIZE);
	}

	public static void stateMark(GuiGraphicsExtractor graphics, StateMark mark, int x, int y, int size) {
		if (mark.icon() != null) {
			icon(graphics, mark.icon(), x, y, size, mark.color());
			return;
		}
		int dot = Math.max(4, size / 2);
		int offset = (size - dot) / 2;
		if (mark.hollow()) ring(graphics, x + offset, y + offset, dot, dot, RADIUS_SMALL, mark.color());
		else surface(graphics, x + offset, y + offset, dot, dot, RADIUS_SMALL, mark.color());
	}

	/** Text in the Medium weight, for titles, values and buttons. */
	public static void strong(GuiGraphicsExtractor graphics, Font font, String text, int x, int y, int color) {
		graphics.text(font, ConsoleText.strong(text), x, y, color, false);
	}

	/** Text drawn at a fractional size from its top-left corner; type scale for labels and titles. */
	public static void scaledText(GuiGraphicsExtractor graphics, Font font, Component text, float x, float y, float size, int color) {
		graphics.pose().pushMatrix();
		graphics.pose().translate(x, y);
		graphics.pose().scale(size, size);
		graphics.text(font, text, 0, 0, color, false);
		graphics.pose().popMatrix();
	}

	public static void label(GuiGraphicsExtractor graphics, Font font, String text, int x, int y, int color) {
		scaledText(graphics, font, ConsoleText.component(text), x, y, LABEL_SIZE, color);
	}

	public static int labelWidth(Font font, String text) {
		return Math.round(ConsoleText.width(font, text) * LABEL_SIZE);
	}

	public static final float LABEL_SIZE = 0.78F;
	public static final float TITLE_SIZE = 1.5F;

	public static void title(GuiGraphicsExtractor graphics, Font font, String text, int x, int y, int color) {
		scaledText(graphics, font, ConsoleText.strong(text), x, y, TITLE_SIZE, color);
	}

	/** Linear blend of two ARGB colors; {@code amount} 0 gives {@code from}, 1 gives {@code to}. */
	public static int mix(int from, int to, float amount) {
		float t = Math.clamp(amount, 0F, 1F);
		int a = Math.round(((from >>> 24) & 0xFF) + (((to >>> 24) & 0xFF) - ((from >>> 24) & 0xFF)) * t);
		int r = Math.round(((from >> 16) & 0xFF) + (((to >> 16) & 0xFF) - ((from >> 16) & 0xFF)) * t);
		int g = Math.round(((from >> 8) & 0xFF) + (((to >> 8) & 0xFF) - ((from >> 8) & 0xFF)) * t);
		int b = Math.round((from & 0xFF) + ((to & 0xFF) - (from & 0xFF)) * t);
		return a << 24 | r << 16 | g << 8 | b;
	}

	public static int withAlpha(int color, float alpha) {
		int a = Math.round(((color >>> 24) & 0xFF) * Math.clamp(alpha, 0F, 1F));
		return a << 24 | (color & 0xFFFFFF);
	}

	static int nearestRadius(int radius) {
		if (radius >= 8) return 8;
		if (radius >= 6) return 6;
		if (radius >= 4) return 4;
		return 3;
	}

	private static void shape(GuiGraphicsExtractor graphics, String kind, int radius, int x, int y, int width, int height, int color) {
		int scale = guiScale();
		int set = Math.min(scale, MAX_SHAPE_SCALE);
		Identifier id = Identifier.fromNamespaceAndPath("mineagen", "console/" + kind + "_r" + radius + "_s" + set);
		blitScaled(graphics, id, x, y, width, height, color, scale, set);
	}

	/**
	 * Blits in screen pixels: the pose shrinks by the GUI scale and the sprite set's own scale brings it back, so
	 * each texel covers exactly one pixel when the set matches the GUI scale.
	 */
	private static void blitScaled(GuiGraphicsExtractor graphics, Identifier id, int x, int y, int width, int height,
			int color, int scale, int set) {
		graphics.pose().pushMatrix();
		float factor = (float) scale / set;
		graphics.pose().translate(x, y);
		graphics.pose().scale(1F / scale * factor, 1F / scale * factor);
		graphics.blitSprite(RenderPipelines.GUI_TEXTURED, id, 0, 0, width * set, height * set, color);
		graphics.pose().popMatrix();
	}
}
