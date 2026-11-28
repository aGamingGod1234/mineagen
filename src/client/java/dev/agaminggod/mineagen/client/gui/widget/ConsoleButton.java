package dev.agaminggod.mineagen.client.gui.widget;

import dev.agaminggod.mineagen.client.gui.ConsoleDraw;
import dev.agaminggod.mineagen.client.gui.ConsoleMotion;
import dev.agaminggod.mineagen.client.gui.ConsoleTheme;
import dev.agaminggod.mineagen.client.gui.ConsoleFocusTarget;
import dev.agaminggod.mineagen.client.gui.ConsoleText;
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

/** Rounded control-center button: tone sets its weight, an optional icon leads the label. */
public final class ConsoleButton extends AbstractWidget implements ConsoleFocusTarget {
	public enum Tone {
		SECONDARY,
		PRIMARY,
		DANGER,
		/** Text-only action that gains a surface on hover; for Back and other low-weight actions. */
		GHOST
	}
	private final Font font;
	private final ConsoleMotion hover = new ConsoleMotion();
	private ConsoleDraw.Icon icon;
	private boolean small;
	private final Runnable onPress;
	private final int accent;
	private final boolean selected;
	private final Tone tone;

	public ConsoleButton(
			Font font,
			int x,
			int y,
			int width,
			int height,
			Component message,
			boolean selected,
			int accent,
			Runnable onPress
	) {
		this(font, x, y, width, height, message, selected, accent, Tone.SECONDARY, onPress);
	}

	public ConsoleButton(
			Font font,
			int x,
			int y,
			int width,
			int height,
			Component message,
			boolean selected,
			int accent,
			Tone tone,
			Runnable onPress
	) {
		super(x, y, width, height, Objects.requireNonNull(message, "message must not be null"));
		this.font = Objects.requireNonNull(font, "font must not be null");
		this.onPress = Objects.requireNonNull(onPress, "onPress must not be null");
		this.selected = selected;
		this.accent = accent;
		this.tone = Objects.requireNonNull(tone, "tone must not be null");
	}

	public ConsoleButton withIcon(ConsoleDraw.Icon icon) {
		this.icon = icon;
		return this;
	}

	/** Label-sized text, for small inline actions such as Rescan beside a field label. */
	public ConsoleButton small() {
		this.small = true;
		return this;
	}

	/** Width that fits the label and icon with even padding, so text-only actions line up with content edges. */
	public static int fittedWidth(Font font, String label, boolean icon, boolean small) {
		int text = small ? ConsoleDraw.labelWidth(font, label) : ConsoleText.strongWidth(font, label);
		return text + (icon ? (small ? 14 : 16) : 0) + 18;
	}

	@Override
	protected void extractWidgetRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
		float lift = ConsoleMotion.smooth(hover.toward(active && (isHovered() || isFocused()) ? 1F : 0F, 120));
		Presentation rest = presentation(tone, active, selected, false, false, accent);
		Presentation lit = presentation(tone, active, selected, isFocused(), true, accent);
		int fill = ConsoleDraw.mix(rest.fill(), lit.fill(), lift);
		int text = ConsoleDraw.mix(rest.text(), lit.text(), lift);
		ConsoleDraw.surface(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CONTROL, fill);
		if (isFocused() && active) {
			ConsoleDraw.ring(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CONTROL, lit.border());
		}
		String label = fittedMessage().getString();
		int iconSize = small ? 10 : 12;
		int iconSpace = icon == null ? 0 : label.isEmpty() ? iconSize : iconSize + 4;
		int textWidth = small ? ConsoleDraw.labelWidth(font, label) : ConsoleText.strongWidth(font, label);
		// Ghost actions read as text, so they start at their padding and line up with the content edge.
		int startX = tone == Tone.GHOST ? getX() + 8 : getX() + (getWidth() - textWidth - iconSpace) / 2;
		if (icon != null) ConsoleDraw.icon(graphics, icon, startX, getY() + (getHeight() - iconSize) / 2, iconSize, text);
		if (small) {
			ConsoleDraw.scaledText(graphics, font, ConsoleText.component(label), startX + iconSpace,
					getY() + (getHeight() - 7) / 2F, ConsoleDraw.LABEL_SIZE, text);
		} else {
			graphics.text(font, ConsoleText.strong(label), startX + iconSpace, getY() + (getHeight() - 8) / 2, text, false);
		}
	}

	/**
	 * Colors for one state. {@code border} is the focus ring (fully transparent when none is drawn); buttons have no
	 * outline at rest, so their weight comes from the fill alone.
	 */
	public static Presentation presentation(
			Tone tone,
			boolean active,
			boolean selected,
			boolean focused,
			boolean hovered,
			int accent
	) {
		Objects.requireNonNull(tone, "tone must not be null");
		if (!active) {
			return new Presentation(0, tone == Tone.GHOST ? 0 : ConsoleTheme.ROSTER_UNAVAILABLE_SURFACE, ConsoleTheme.SUBTLE, 0);
		}
		boolean lit = hovered || focused;
		int border = focused ? ConsoleTheme.FOCUS : 0;
		return switch (tone) {
			case PRIMARY -> new Presentation(border, lit ? ConsoleTheme.ACCENT_HOVER : ConsoleTheme.ACCENT, ConsoleTheme.ACCENT_INK, 0);
			case DANGER -> new Presentation(border, lit ? ConsoleTheme.DANGER_HOVER : ConsoleTheme.DANGER_SURFACE, ConsoleTheme.ERROR, 0);
			case GHOST -> new Presentation(border, lit ? ConsoleTheme.SURFACE : 0x001A2029, lit ? ConsoleTheme.TEXT : ConsoleTheme.MUTED, 0);
			case SECONDARY -> selected
					? new Presentation(border, lit ? 0xFF1B3B47 : ConsoleTheme.SURFACE_SELECTED, ConsoleTheme.ACCENT, 0)
					: new Presentation(border, lit ? ConsoleTheme.SURFACE_RAISED : ConsoleTheme.SURFACE_HOVER, ConsoleTheme.TEXT, 0);
		};
	}

	public static String selectionNarrationKey(boolean selected) {
		return selected ? "screen.mineagen.control.selected" : "";
	}

	private Component fittedMessage() {
		String value = getMessage().getString();
		java.util.function.ToIntFunction<String> measure = text -> small ? ConsoleDraw.labelWidth(font, text) : ConsoleText.strongWidth(font, text);
		int available = Math.max(8, getWidth() - 12 - (icon == null ? 0 : small ? 14 : 16));
		if (measure.applyAsInt(value) <= available) return getMessage();
		String suffix = "...";
		int end = value.length();
		int target = Math.max(1, available - measure.applyAsInt(suffix));
		while (end > 0 && measure.applyAsInt(value.substring(0, end)) > target) end--;
		return Component.literal(value.substring(0, end) + suffix);
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
		return super.keyPressed(event);
	}

	@Override
	protected void updateWidgetNarration(NarrationElementOutput output) {
		defaultButtonNarrationText(output);
		String hint = selectionNarrationKey(selected);
		if (!hint.isEmpty()) output.add(NarratedElementType.HINT, Component.translatable(hint));
	}

	@Override
	public String consoleFocusIdentity() {
		return "button:" + getMessage().getString();
	}

	public record Presentation(int border, int fill, int text, int inset) {
	}
}
