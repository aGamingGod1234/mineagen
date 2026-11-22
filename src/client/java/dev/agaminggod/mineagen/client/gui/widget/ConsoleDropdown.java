package dev.agaminggod.mineagen.client.gui.widget;

import dev.agaminggod.mineagen.client.gui.ConsoleFocusTarget;
import dev.agaminggod.mineagen.client.gui.ConsoleDraw;
import dev.agaminggod.mineagen.client.gui.ConsoleMotion;
import dev.agaminggod.mineagen.client.gui.ConsoleText;
import dev.agaminggod.mineagen.client.gui.ConsoleTheme;
import java.util.List;
import java.util.function.Consumer;
import java.util.function.Function;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.gui.narration.NarratedElementType;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import com.mojang.blaze3d.platform.InputConstants;

/** A selectable popup list. The host routes popup input before other controls and draws it last. */
public final class ConsoleDropdown<T> extends AbstractWidget implements ConsoleFocusTarget {
	private static final int OPTION_HEIGHT = 20;
	private final ConsoleMotion hover = new ConsoleMotion();
	private final Font font;
	private final String label;
	private final List<T> values;
	private final Function<T, String> formatter;
	private final Consumer<T> changed;
	private final int viewportWidth;
	private final int viewportHeight;
	private int selected;
	private int highlighted;
	private int first;
	private boolean open;

	public ConsoleDropdown(Font font, int x, int y, int width, int height, String label,
			List<T> values, T initial, Function<T, String> formatter, Consumer<T> changed,
			int viewportWidth, int viewportHeight) {
		super(x, y, width, height, Component.empty());
		this.font = font;
		this.label = label;
		this.values = List.copyOf(values);
		this.selected = values.indexOf(initial);
		if (selected < 0) throw new IllegalArgumentException("Dropdown selection must exist");
		this.highlighted = selected;
		this.formatter = formatter;
		this.changed = changed;
		this.viewportWidth = viewportWidth;
		this.viewportHeight = viewportHeight;
		updateMessage();
	}

	public boolean isOpen() { return open && visible && active; }
	public void close() { open = false; }
	private int rows() { return Math.min(values.size(), Math.max(1, Math.min(8, (viewportHeight - 24) / OPTION_HEIGHT))); }
	private int popupWidth() { return Math.min(Math.max(getWidth(), 160), Math.max(1, viewportWidth - 16)); }
	private int popupX() { return Math.max(8, Math.min(getX(), viewportWidth - popupWidth() - 8)); }
	private int popupY() { return Math.max(12, Math.min(getBottom() + 8, viewportHeight - rows() * OPTION_HEIGHT - 12)); }
	private void reveal() { first = Math.clamp(first, Math.max(0, highlighted - rows() + 1), highlighted); }
	private void updateMessage() { setMessage(Component.literal(label + ": " + formatter.apply(values.get(selected)))); }

	@Override protected void extractWidgetRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
		float lift = ConsoleMotion.smooth(hover.toward(active && (isHovered() || isFocused() || open) ? 1F : 0F, 120));
		ConsoleDraw.surface(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CONTROL,
				active ? ConsoleDraw.mix(ConsoleTheme.SURFACE, ConsoleTheme.SURFACE_HOVER, lift) : ConsoleTheme.ROSTER_UNAVAILABLE_SURFACE);
		if (isFocused() || open) ConsoleDraw.ring(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CONTROL,
				open ? ConsoleTheme.ACCENT : ConsoleTheme.FOCUS);
		String value = formatter.apply(values.get(selected));
		int textY = getY() + (height - 8) / 2;
		graphics.text(font, ConsoleText.strong(fit(value, getWidth() - 30)), getX() + 9, textY, active ? ConsoleTheme.TEXT : ConsoleTheme.SUBTLE, false);
		ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHEVRON_DOWN, getRight() - 17, getY() + (height - 12) / 2,
				ConsoleDraw.mix(ConsoleTheme.MUTED, ConsoleTheme.TEXT, lift));
	}

	private String fit(String value, int width) {
		if (ConsoleText.strongWidth(font, value) <= width) return value;
		int end = value.length();
		while (end > 0 && ConsoleText.strongWidth(font, value.substring(0, end) + "...") > width) end--;
		return value.substring(0, end) + "...";
	}

	public void renderPopup(GuiGraphicsExtractor graphics, int mouseX, int mouseY) {
		if (!isOpen()) return;
		graphics.nextStratum();
		int x = popupX(), y = popupY(), width = popupWidth();
		int height = rows() * OPTION_HEIGHT + 8;
		ConsoleDraw.shadow(graphics, x, y - 4, width, height, 0x90);
		ConsoleDraw.surface(graphics, x, y - 4, width, height, ConsoleDraw.RADIUS_CARD, ConsoleTheme.POPUP);
		for (int row = 0; row < rows(); row++) {
			int index = first + row;
			int top = y + row * OPTION_HEIGHT;
			boolean hover = mouseX >= x && mouseX < x + width && mouseY >= top && mouseY < top + OPTION_HEIGHT;
			if (hover || index == highlighted) {
				ConsoleDraw.surface(graphics, x + 4, top, width - 8, OPTION_HEIGHT, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.SURFACE_RAISED);
			}
			boolean chosen = index == selected;
			String text = formatter.apply(values.get(index));
			int color = chosen ? ConsoleTheme.ACCENT : ConsoleTheme.TEXT;
			graphics.text(font, chosen ? ConsoleText.strong(fit(text, width - 40)) : ConsoleText.component(font.plainSubstrByWidth(text, width - 40)),
					x + 12, top + (OPTION_HEIGHT - 8) / 2, color, false);
			if (chosen) ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHECK, x + width - 22, top + (OPTION_HEIGHT - 12) / 2, ConsoleTheme.ACCENT);
		}
		if (rows() < values.size()) {
			int track = rows() * OPTION_HEIGHT;
			int thumb = Math.max(8, track * rows() / values.size());
			int offset = (track - thumb) * first / (values.size() - rows());
			ConsoleDraw.surface(graphics, x + width - 5, y + offset, 2, thumb, 1, ConsoleTheme.SUBTLE);
		}
	}

	@Override public void onClick(MouseButtonEvent event, boolean doubled) {
		open = !open;
		highlighted = selected;
		reveal();
	}

	/** Consumes even outside clicks so closing the list cannot trigger an underlying action. */
	public boolean popupClick(MouseButtonEvent event) {
		if (!isOpen()) return false;
		int row = (int) Math.floor((event.y() - popupY()) / OPTION_HEIGHT);
		if (event.button() == 0 && event.x() >= popupX() && event.x() < popupX() + popupWidth() && row >= 0 && row < rows()) select(first + row);
		close();
		return true;
	}

	public boolean popupScroll(double vertical) {
		if (!isOpen()) return false;
		if (vertical != 0) first = Math.clamp(first + (vertical > 0 ? -1 : 1), 0, values.size() - rows());
		return true;
	}

	private void select(int index) {
		selected = index;
		highlighted = index;
		close();
		updateMessage();
		changed.accept(values.get(selected));
	}

	@Override public boolean keyPressed(KeyEvent event) {
		if (!active || !visible) return false;
		int key = event.key();
		if (key == InputConstants.KEY_ESCAPE && open) { close(); return true; }
		if (key == InputConstants.KEY_TAB) { close(); return false; }
		if (key == InputConstants.KEY_RETURN || key == InputConstants.KEY_SPACE) {
			if (open) select(highlighted); else { open = true; highlighted = selected; reveal(); }
			return true;
		}
		if (key == InputConstants.KEY_DOWN || key == InputConstants.KEY_UP || key == InputConstants.KEY_HOME || key == InputConstants.KEY_END) {
			open = true;
			highlighted = key == InputConstants.KEY_HOME ? 0 : key == InputConstants.KEY_END ? values.size() - 1
					: Math.clamp(highlighted + (key == InputConstants.KEY_DOWN ? 1 : -1), 0, values.size() - 1);
			reveal();
			return true;
		}
		return false;
	}

	@Override protected void updateWidgetNarration(NarrationElementOutput output) {
		defaultButtonNarrationText(output);
		output.add(NarratedElementType.HINT, Component.literal(open ? formatter.apply(values.get(highlighted)) + ". Use arrows to browse, Enter to select, Escape to cancel." : "Press Enter to open choices."));
	}
	@Override public String consoleFocusIdentity() { return "dropdown:" + label; }
}
