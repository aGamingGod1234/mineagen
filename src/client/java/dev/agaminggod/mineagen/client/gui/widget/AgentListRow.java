package dev.agaminggod.mineagen.client.gui.widget;

import dev.agaminggod.mineagen.client.gui.AgentFaces;
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
 * One agent in the mission board's list: its face on its own colour tile, its name, and its state over its model. Narrow lists show the face alone, with the state as a dot on its corner and the name as a tooltip. Click
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
		int x = getX(), y = getY(), w = getWidth(), h = getHeight();
		// No outline: the selected row is a lighter tone with a short accent bar, a hovered row only lifts a little.
		int rest = selected ? 0x1CFFFFFF : 0x00FFFFFF;
		int lit = selected ? 0x24FFFFFF : 0x0EFFFFFF;
		ConsoleDraw.surface(graphics, x, y, w, h, ConsoleDraw.RADIUS_CONTROL, ConsoleDraw.mix(rest, lit, lift));
		if (selected) graphics.fill(x, y + 5, x + 2, y + h - 5, ConsoleTheme.ACCENT);
		if (isFocused()) ConsoleDraw.ring(graphics, x, y, w, h, ConsoleDraw.RADIUS_CONTROL, ConsoleTheme.FOCUS);
		AgentControlPresentation.StateCue cue = AgentControlPresentation.stateCue(agent.state());
		int stateColor = ConsoleTheme.stateColor(cue.tone());
		int tile = Math.min(20, h - 6);
		if (w < COMPACT_WIDTH) {
			int tileX = x + (w - tile) / 2, tileY = y + (h - tile) / 2;
			AgentFaces.tile(graphics, agent, tileX, tileY, tile);
			// The state as a dot on the tile's corner, cut out of the panel colour so it reads over any skin.
			ConsoleDraw.surface(graphics, tileX + tile - 5, tileY + tile - 5, 8, 8, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.NAVIGATION);
			ConsoleDraw.surface(graphics, tileX + tile - 4, tileY + tile - 4, 6, 6, ConsoleDraw.RADIUS_SMALL, stateColor);
			return;
		}
		int tileX = x + 6, tileY = y + (h - tile) / 2;
		AgentFaces.tile(graphics, agent, tileX, tileY, tile);
		int textLeft = tileX + tile + 6;
		int room = x + w - 6 - textLeft;
		boolean twoLines = h >= 24;
		int nameY = twoLines ? y + h / 2 - 9 : y + (h - 8) / 2;
		graphics.text(font, ConsoleText.strong(fit(agent.displayName(), room, true)), textLeft, nameY, ConsoleTheme.TEXT, false);
		if (twoLines) {
			// What it is doing, in its state colour, then the model it runs: "Working · gpt-5.5".
			String state = AgentControlPresentation.stateLabel(agent.state());
			String line = fitLabel(state, room);
			ConsoleDraw.label(graphics, font, line, textLeft, nameY + 11, stateColor);
			int after = textLeft + ConsoleDraw.labelWidth(font, line);
			String model = "  " + AgentControlPresentation.profileLabel(agent);
			if (line.equals(state) && after + 16 < x + w - 6) {
				ConsoleDraw.label(graphics, font, fitLabel(model, x + w - 6 - after), after, nameY + 11, ConsoleTheme.SUBTLE);
			}
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
