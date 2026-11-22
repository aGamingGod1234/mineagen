package dev.agaminggod.mineagen.client.gui.widget;

import dev.agaminggod.mineagen.client.gui.ConsoleDraw;
import dev.agaminggod.mineagen.client.gui.ConsoleFocusTarget;
import dev.agaminggod.mineagen.client.gui.ConsoleMotion;
import dev.agaminggod.mineagen.client.gui.ConsoleText;
import dev.agaminggod.mineagen.client.gui.ConsoleTheme;
import java.util.List;
import java.util.Objects;
import java.util.function.Consumer;
import java.util.function.Function;
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
 * A row of mutually exclusive choices with a highlight that slides to the chosen one. Every option stays visible,
 * so short ranked lists (thinking depth, speed, game mode) read at a glance instead of hiding behind arrows.
 */
public final class ConsoleSegmented<T> extends AbstractWidget implements ConsoleFocusTarget {
	private final Font font;
	private final String label;
	private final List<T> values;
	private final Function<T, String> formatter;
	private final Consumer<T> changed;
	private final ConsoleMotion slide = new ConsoleMotion();
	private final ConsoleMotion hover = new ConsoleMotion();
	private int index;
	private float fromIndex;

	public ConsoleSegmented(Font font, int x, int y, int width, int height, String label, List<T> values, T initial,
			Function<T, String> formatter, Consumer<T> changed) {
		super(x, y, width, height, Component.empty());
		this.font = Objects.requireNonNull(font, "font must not be null");
		this.label = Objects.requireNonNull(label, "label must not be null");
		this.values = List.copyOf(values);
		if (this.values.isEmpty()) throw new IllegalArgumentException("values must not be empty");
		this.index = Math.max(0, this.values.indexOf(initial));
		this.fromIndex = index;
		this.formatter = Objects.requireNonNull(formatter, "formatter must not be null");
		this.changed = Objects.requireNonNull(changed, "changed must not be null");
		updateMessage();
	}

	@Override
	protected void extractWidgetRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
		ConsoleDraw.surface(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CONTROL, ConsoleTheme.TRACK);
		int count = values.size();
		float segment = (getWidth() - 4) / (float) count;
		float progress = ConsoleMotion.smooth(slide.toward(1F, 160));
		float position = fromIndex + (index - fromIndex) * progress;
		if (progress >= 1F) fromIndex = index;
		int highlightX = Math.round(getX() + 2 + segment * position);
		int highlightWidth = Math.round(segment);
		float lift = ConsoleMotion.smooth(hover.toward(active && isFocused() ? 1F : 0F, 120));
		if (active) {
			ConsoleDraw.surface(graphics, highlightX, getY() + 2, highlightWidth, getHeight() - 4, ConsoleDraw.RADIUS_SMALL,
					ConsoleDraw.mix(ConsoleTheme.SURFACE_RAISED, 0xFF33404F, lift));
		}
		if (isFocused() && active) ConsoleDraw.ring(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CONTROL, ConsoleTheme.FOCUS);
		int hovered = active && isHovered() ? segmentAt(mouseX) : -1;
		for (int option = 0; option < count; option++) {
			String text = formatter.apply(values.get(option));
			int left = Math.round(getX() + 2 + segment * option);
			int center = left + Math.round(segment) / 2;
			boolean chosen = option == index;
			int color = !active ? ConsoleTheme.SUBTLE : chosen ? ConsoleTheme.TEXT : option == hovered ? 0xFFC9D0DA : ConsoleTheme.MUTED;
			Component styled = chosen ? ConsoleText.strong(text) : ConsoleText.component(text);
			int width = font.width(styled);
			graphics.text(font, styled, center - width / 2, getY() + (getHeight() - 8) / 2, color, false);
		}
	}

	private int segmentAt(double mouseX) {
		float segment = (getWidth() - 4) / (float) values.size();
		return Math.clamp((int) Math.floor((mouseX - getX() - 2) / segment), 0, values.size() - 1);
	}

	@Override
	public void onClick(MouseButtonEvent event, boolean doubled) {
		if (active) choose(segmentAt(event.x()));
	}

	@Override
	public boolean keyPressed(KeyEvent event) {
		if (!active) return false;
		if (event.key() == InputConstants.KEY_LEFT) {
			choose(Math.max(0, index - 1));
			return true;
		}
		if (event.key() == InputConstants.KEY_RIGHT) {
			choose(Math.min(values.size() - 1, index + 1));
			return true;
		}
		return false;
	}

	private void choose(int next) {
		if (next == index) return;
		float progress = ConsoleMotion.smooth(slide.value());
		fromIndex = fromIndex + (index - fromIndex) * progress;
		index = next;
		slide.toward(0F, 0);
		updateMessage();
		changed.accept(values.get(index));
	}

	public T value() {
		return values.get(index);
	}

	private void updateMessage() {
		setMessage(Component.literal(label + ": " + formatter.apply(values.get(index))));
	}

	@Override
	protected void updateWidgetNarration(NarrationElementOutput output) {
		defaultButtonNarrationText(output);
		output.add(NarratedElementType.HINT, Component.literal("Option " + (index + 1) + " of " + values.size()
				+ ". Use Left and Right to choose."));
	}

	@Override
	public String consoleFocusIdentity() {
		return "segmented:" + label;
	}
}
