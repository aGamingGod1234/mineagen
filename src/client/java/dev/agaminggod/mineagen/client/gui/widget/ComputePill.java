package dev.agaminggod.mineagen.client.gui.widget;

import dev.agaminggod.mineagen.client.gui.ConsoleDraw;
import dev.agaminggod.mineagen.client.gui.ConsoleFocusTarget;
import dev.agaminggod.mineagen.client.gui.ConsoleMotion;
import dev.agaminggod.mineagen.client.gui.ConsoleText;
import dev.agaminggod.mineagen.client.gui.ConsoleTheme;
import com.mojang.blaze3d.platform.InputConstants;
import java.util.Objects;
import java.util.function.BooleanSupplier;
import java.util.function.Supplier;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;

/**
 * The header's compute pill: a dot in the place's colour, where agents run ("This PC", "boat · $0.013") and a
 * chevron. It reads its text every frame, so the cost ticks without a rebuild; a click opens or closes the compute
 * drawer. A second, amber dot asks for a sign-in.
 */
public final class ComputePill extends AbstractWidget implements ConsoleFocusTarget {
	/** What the pill shows right now. */
	public record Look(String text, int color, boolean attention) {
	}

	private final Font font;
	private final Supplier<Look> look;
	private final BooleanSupplier open;
	private final Runnable onPress;
	private final ConsoleMotion hover = new ConsoleMotion();

	public ComputePill(Font font, int right, int y, int height, Supplier<Look> look, BooleanSupplier open, Runnable onPress) {
		super(right, y, 0, height, Component.translatable("screen.mineagen.board.compute"));
		this.font = Objects.requireNonNull(font, "font must not be null");
		this.look = Objects.requireNonNull(look, "look must not be null");
		this.open = Objects.requireNonNull(open, "open must not be null");
		this.onPress = Objects.requireNonNull(onPress, "onPress must not be null");
		setWidth(preferredWidth(font, look.get()));
		setX(right - getWidth());
	}

	/** Dot, text, the optional sign-in dot and the chevron, with even padding. */
	public static int preferredWidth(Font font, Look look) {
		return 8 + 5 + 6 + ConsoleText.strongWidth(font, look.text()) + (look.attention() ? 9 : 0) + 4 + 10 + 4;
	}

	@Override
	protected void extractWidgetRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
		Look current = look.get();
		boolean opened = open.getAsBoolean();
		float lift = ConsoleMotion.smooth(hover.toward(active && (isHovered() || isFocused() || opened) ? 1F : 0F, 120));
		int x = getX(), y = getY(), w = getWidth(), h = getHeight();
		ConsoleDraw.surface(graphics, x, y, w, h, ConsoleDraw.RADIUS_CONTROL, ConsoleDraw.mix(0x0FFFFFFF, 0x1FFFFFFF, lift));
		if (isFocused()) ConsoleDraw.ring(graphics, x, y, w, h, ConsoleDraw.RADIUS_CONTROL, ConsoleTheme.FOCUS);
		int middle = y + h / 2;
		int cx = x + 8;
		ConsoleDraw.surface(graphics, cx, middle - 2, 5, 5, ConsoleDraw.RADIUS_SMALL, current.color());
		cx += 11;
		int room = x + w - 18 - (current.attention() ? 9 : 0) - cx;
		String text = fit(current.text(), room);
		graphics.text(font, ConsoleText.strong(text), cx, middle - 4, ConsoleDraw.mix(ConsoleTheme.MUTED, ConsoleTheme.TEXT, lift), false);
		cx += ConsoleText.strongWidth(font, text) + 4;
		if (current.attention()) {
			ConsoleDraw.surface(graphics, cx + 1, middle - 2, 4, 4, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.WARNING);
		}
		ConsoleDraw.icon(graphics, ConsoleDraw.Icon.CHEVRON_DOWN, x + w - 15, middle - 5, 10,
				ConsoleDraw.mix(ConsoleTheme.SUBTLE, ConsoleTheme.TEXT, lift));
	}

	private String fit(String value, int available) {
		if (ConsoleText.strongWidth(font, value) <= available) return value;
		int end = value.length();
		while (end > 0 && ConsoleText.strongWidth(font, value.substring(0, end) + "...") > available) end--;
		return end == 0 ? "" : value.substring(0, end) + "...";
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
	}

	@Override
	public String consoleFocusIdentity() {
		return "compute-pill";
	}
}
