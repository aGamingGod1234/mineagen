package dev.agaminggod.mineagen.client.gui.widget;

import dev.agaminggod.mineagen.client.gui.AgentFaces;
import dev.agaminggod.mineagen.client.gui.BrandMarks;
import dev.agaminggod.mineagen.client.gui.ConsoleDraw;
import dev.agaminggod.mineagen.client.gui.ConsoleFocusTarget;
import dev.agaminggod.mineagen.client.gui.ConsoleMotion;
import dev.agaminggod.mineagen.client.gui.ConsoleText;
import dev.agaminggod.mineagen.client.gui.ConsoleTheme;
import dev.agaminggod.mineagen.control.AgentControlAgent;
import dev.agaminggod.mineagen.control.AgentControlPresentation;
import java.util.Objects;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Tooltip;
import net.minecraft.client.gui.narration.NarratedElementType;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import com.mojang.blaze3d.platform.InputConstants;

/**
 * One agent in the mission board's list: its face, its name in its provider's colour over its model, and a state
 * mark. Narrow lists show the face alone, with the state as a dot on its corner and the name as a tooltip. Click
 * selects; a double click opens Manage.
 */
public final class AgentListRow extends AbstractWidget implements ConsoleFocusTarget {
	/** Rows narrower than this show only the face. */
	public static final int COMPACT_WIDTH = 48;
	private final Font font;
	private final AgentControlAgent agent;
	private final boolean selected;
	private final Runnable onSelect;
	private final Runnable onOpen;
	private final ConsoleMotion hover = new ConsoleMotion();

	public AgentListRow(Font font, int x, int y, int width, int height, AgentControlAgent agent, boolean selected,
			Runnable onSelect, Runnable onOpen) {
		super(x, y, width, height, Component.literal(Objects.requireNonNull(agent, "agent must not be null").displayName()));
		this.font = Objects.requireNonNull(font, "font must not be null");
		this.agent = agent;
		this.selected = selected;
		this.onSelect = Objects.requireNonNull(onSelect, "onSelect must not be null");
		this.onOpen = Objects.requireNonNull(onOpen, "onOpen must not be null");
		if (width < COMPACT_WIDTH) {
			setTooltip(Tooltip.create(Component.literal(agent.displayName() + "\n" + AgentControlPresentation.stateLabel(agent.state()))));
		}
	}

	@Override
	protected void extractWidgetRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
		float lift = ConsoleMotion.smooth(hover.toward(active && (isHovered() || isFocused()) ? 1F : 0F, 120));
		int rest = selected ? 0xB0173440 : 0x661A2029;
		int lit = selected ? 0xD01B3B47 : 0xA0232B36;
		int x = getX(), y = getY(), w = getWidth(), h = getHeight();
		ConsoleDraw.surface(graphics, x, y, w, h, ConsoleDraw.RADIUS_CONTROL, ConsoleDraw.mix(rest, lit, lift));
		if (selected) ConsoleDraw.ring(graphics, x, y, w, h, ConsoleDraw.RADIUS_CONTROL, ConsoleDraw.withAlpha(ConsoleTheme.ACCENT, 0.55F));
		if (isFocused()) ConsoleDraw.ring(graphics, x, y, w, h, ConsoleDraw.RADIUS_CONTROL, ConsoleTheme.FOCUS);
		ConsoleDraw.StateMark mark = ConsoleDraw.stateMark(AgentControlPresentation.stateCue(agent.state()));
		int face = Math.min(16, h - 8);
		if (w < COMPACT_WIDTH) {
			int faceX = x + (w - face) / 2, faceY = y + (h - face) / 2;
			face(graphics, faceX, faceY, face);
			// The state as a dot on the face's corner, ringed in the row colour so it reads over any skin.
			int dot = 6;
			ConsoleDraw.surface(graphics, faceX + face - dot + 2, faceY + face - dot + 2, dot + 2, dot + 2, ConsoleDraw.RADIUS_SMALL,
					selected ? 0xFF173440 : 0xFF161C24);
			ConsoleDraw.surface(graphics, faceX + face - dot + 3, faceY + face - dot + 3, dot, dot, ConsoleDraw.RADIUS_SMALL, mark.color());
			return;
		}
		int faceX = x + 6, faceY = y + (h - face) / 2;
		face(graphics, faceX, faceY, face);
		int markSize = 10;
		int markX = x + w - markSize - 6;
		ConsoleDraw.stateMark(graphics, mark, markX, y + (h - markSize) / 2, markSize);
		int textLeft = faceX + face + 6;
		int room = markX - 4 - textLeft;
		String name = fit(agent.displayName(), room, true);
		boolean twoLines = h >= 24;
		int nameY = twoLines ? y + h / 2 - 9 : y + (h - 8) / 2;
		graphics.text(font, ConsoleText.strong(name), textLeft, nameY, ConsoleTheme.rosterProviderColor(agent.provider()), false);
		if (twoLines) {
			int modelX = textLeft;
			int brand = BrandMarks.draw(graphics, BrandMarks.forProvider(agent.provider()), modelX, nameY + 11, 7);
			if (brand > 0) modelX += brand + 3;
			String model = fitLabel(AgentControlPresentation.profileLabel(agent), markX - 4 - modelX);
			ConsoleDraw.label(graphics, font, model, modelX, nameY + 11, ConsoleTheme.MUTED);
		}
	}

	private void face(GuiGraphicsExtractor graphics, int x, int y, int size) {
		ConsoleDraw.surface(graphics, x - 1, y - 1, size + 2, size + 2, ConsoleDraw.RADIUS_SMALL, 0x66000000);
		if (!AgentFaces.draw(graphics, agent, x, y, size)) {
			ConsoleDraw.surface(graphics, x, y, size, size, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.SURFACE_RAISED);
		}
	}

	private String fit(String value, int available, boolean strong) {
		if (width(value, strong) <= available) return value;
		int end = value.length();
		while (end > 0 && width(value.substring(0, end) + "...", strong) > available) end--;
		return value.substring(0, end) + "...";
	}

	private String fitLabel(String value, int available) {
		if (ConsoleDraw.labelWidth(font, value) <= available) return value;
		int end = value.length();
		while (end > 0 && ConsoleDraw.labelWidth(font, value.substring(0, end) + "...") > available) end--;
		return end == 0 ? "" : value.substring(0, end) + "...";
	}

	private int width(String value, boolean strong) {
		return strong ? ConsoleText.strongWidth(font, value) : ConsoleText.width(font, value);
	}

	@Override
	public void onClick(MouseButtonEvent event, boolean doubled) {
		if (!active) return;
		if (doubled) onOpen.run();
		else onSelect.run();
	}

	@Override
	public boolean keyPressed(KeyEvent event) {
		if (active && (event.key() == InputConstants.KEY_RETURN || event.key() == InputConstants.KEY_SPACE)) {
			onSelect.run();
			return true;
		}
		return super.keyPressed(event);
	}

	@Override
	protected void updateWidgetNarration(NarrationElementOutput output) {
		output.add(NarratedElementType.TITLE, Component.literal(agent.displayName() + ", "
				+ AgentControlPresentation.stateLabel(agent.state())));
		String hint = ConsoleButton.selectionNarrationKey(selected);
		if (!hint.isEmpty()) output.add(NarratedElementType.HINT, Component.translatable(hint));
	}

	@Override
	public String consoleFocusIdentity() {
		return "agent-row:" + agent.agentId();
	}
}
