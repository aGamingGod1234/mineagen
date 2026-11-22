package dev.agaminggod.mineagen.client.gui.widget;

import dev.agaminggod.mineagen.client.gui.ConsoleDraw;
import dev.agaminggod.mineagen.client.gui.ConsoleFocusTarget;
import dev.agaminggod.mineagen.client.gui.ConsoleMotion;
import dev.agaminggod.mineagen.client.gui.ConsoleText;
import dev.agaminggod.mineagen.client.gui.ConsoleTheme;
import java.util.Objects;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.narration.NarratedElementType;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import com.mojang.blaze3d.platform.InputConstants;

/**
 * A selectable card for one model tool: a colored mark, its name, and one status line (ready or why not, how it
 * signs in, version). The tool's sign-in shows where you pick it, so there is no separate "found" table.
 */
public final class ConsoleChoiceCard extends AbstractWidget implements ConsoleFocusTarget {
	private final Font font;
	private final String title;
	private final String status;
	private final int statusColor;
	private final String detail;
	private final int mark;
	private final boolean selected;
	private final Runnable onPress;
	private final ConsoleMotion hover = new ConsoleMotion();
	private final ConsoleMotion pick = new ConsoleMotion();

	public ConsoleChoiceCard(Font font, int x, int y, int width, int height, String title, String status, int statusColor,
			String detail, int mark, boolean selected, Runnable onPress) {
		super(x, y, width, height, Component.literal(title + ", " + status + (detail.isBlank() ? "" : ", " + detail)));
		this.font = Objects.requireNonNull(font, "font must not be null");
		this.title = title;
		this.status = status;
		this.statusColor = statusColor;
		this.detail = detail;
		this.mark = mark;
		this.selected = selected;
		this.onPress = Objects.requireNonNull(onPress, "onPress must not be null");
	}

	/**
	 * Starts the selection accent from nothing. The screen rebuilds its widgets when a tool is picked, so the new
	 * card fades its accent in and the choice visibly lands; cards rebuilt for other reasons start settled.
	 */
	public ConsoleChoiceCard animateSelection() {
		pick.toward(0F, 0);
		return this;
	}

	@Override
	protected void extractWidgetRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
		float lift = ConsoleMotion.smooth(hover.toward(active && (isHovered() || isFocused()) ? 1F : 0F, 120));
		float chosen = ConsoleMotion.smooth(pick.toward(selected ? 1F : 0F, 180));
		int base = !active ? ConsoleTheme.ROSTER_UNAVAILABLE_SURFACE : ConsoleDraw.mix(ConsoleTheme.SURFACE, ConsoleTheme.SURFACE_HOVER, lift);
		int fill = ConsoleDraw.mix(base, ConsoleTheme.SURFACE_SELECTED, selected ? chosen : 0F);
		ConsoleDraw.surface(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CARD, fill);
		if (selected) {
			ConsoleDraw.ring(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CARD,
					ConsoleDraw.withAlpha(ConsoleTheme.ACCENT, chosen));
		} else if (isFocused() && active) {
			ConsoleDraw.ring(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CARD, ConsoleTheme.FOCUS);
		}
		int markSize = Math.min(20, getHeight() - 12);
		int markX = getX() + 7;
		int markY = getY() + (getHeight() - markSize) / 2;
		int markColor = active ? mark : ConsoleDraw.mix(mark, ConsoleTheme.SURFACE, 0.6F);
		ConsoleDraw.surface(graphics, markX, markY, markSize, markSize, ConsoleDraw.RADIUS_CONTROL, ConsoleDraw.withAlpha(markColor, 0.22F));
		String initial = title.isEmpty() ? "?" : title.substring(0, 1);
		Component initialText = ConsoleText.strong(initial);
		graphics.text(font, initialText, markX + (markSize - font.width(initialText)) / 2 + 1, markY + (markSize - 8) / 2, markColor, false);
		int textX = markX + markSize + 8;
		int available = getRight() - textX - (selected ? 20 : 8);
		graphics.text(font, ConsoleText.strong(fit(title, available, true)), textX, getY() + getHeight() / 2 - 10,
				active ? ConsoleTheme.TEXT : ConsoleTheme.MUTED, false);
		int lineY = getY() + getHeight() / 2 + 2;
		ConsoleDraw.surface(graphics, textX, lineY + 2, 4, 4, ConsoleDraw.RADIUS_SMALL, statusColor);
		String line = status + (detail.isBlank() ? "" : "  ·  " + detail);
		int lineWidth = available - 7;
		ConsoleDraw.label(graphics, font, fitLabel(line, lineWidth), textX + 7, lineY, ConsoleTheme.MUTED);
		if (selected) {
			ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHECK, getRight() - 17, getY() + (getHeight() - 12) / 2,
					ConsoleDraw.withAlpha(ConsoleTheme.ACCENT, chosen));
		}
	}

	private String fit(String value, int width, boolean strong) {
		java.util.function.ToIntFunction<String> measure = text -> strong ? ConsoleText.strongWidth(font, text) : ConsoleText.width(font, text);
		if (measure.applyAsInt(value) <= width) return value;
		int end = value.length();
		while (end > 0 && measure.applyAsInt(value.substring(0, end) + "...") > width) end--;
		return value.substring(0, end) + "...";
	}

	private String fitLabel(String value, int width) {
		if (ConsoleDraw.labelWidth(font, value) <= width) return value;
		int end = value.length();
		while (end > 0 && ConsoleDraw.labelWidth(font, value.substring(0, end) + "...") > width) end--;
		return value.substring(0, end) + "...";
	}

	@Override
	public void onClick(MouseButtonEvent event, boolean doubled) {
		if (active) onPress.run();
	}

	@Override
	public boolean keyPressed(KeyEvent event) {
		if (active && (event.key() == InputConstants.KEY_RETURN || event.key() == InputConstants.KEY_SPACE)) {
			onPress.run();
			return true;
		}
		return false;
	}

	@Override
	protected void updateWidgetNarration(NarrationElementOutput output) {
		defaultButtonNarrationText(output);
		if (selected) output.add(NarratedElementType.HINT, Component.translatable("screen.mineagen.control.selected"));
	}

	@Override
	public String consoleFocusIdentity() {
		return "card:" + title;
	}
}
