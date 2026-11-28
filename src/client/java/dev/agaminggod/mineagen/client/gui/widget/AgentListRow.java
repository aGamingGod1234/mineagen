package dev.agaminggod.mineagen.client.gui.widget;

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
import net.minecraft.client.gui.narration.NarratedElementType;
import net.minecraft.client.gui.narration.NarrationElementOutput;
import net.minecraft.client.input.KeyEvent;
import net.minecraft.client.input.MouseButtonEvent;
import net.minecraft.network.chat.Component;
import com.mojang.blaze3d.platform.InputConstants;

/** One agent in the mission board's list: its name in its provider's colour and a state mark. Click selects; a double click opens Manage. */
public final class AgentListRow extends AbstractWidget implements ConsoleFocusTarget {
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
	}

	@Override
	protected void extractWidgetRenderState(GuiGraphicsExtractor graphics, int mouseX, int mouseY, float partialTick) {
		float lift = ConsoleMotion.smooth(hover.toward(active && (isHovered() || isFocused()) ? 1F : 0F, 120));
		int rest = selected ? ConsoleTheme.ROSTER_SELECTED_SURFACE : ConsoleTheme.SURFACE;
		int lit = selected ? 0xFF1B3B47 : ConsoleTheme.SURFACE_HOVER;
		ConsoleDraw.surface(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CONTROL, ConsoleDraw.mix(rest, lit, lift));
		if (selected) ConsoleDraw.surface(graphics, getX(), getY() + 4, 2, getHeight() - 8, 1, ConsoleTheme.ACCENT);
		if (isFocused()) ConsoleDraw.ring(graphics, getX(), getY(), getWidth(), getHeight(), ConsoleDraw.RADIUS_CONTROL, ConsoleTheme.FOCUS);
		int markSize = 10;
		int markX = getX() + getWidth() - markSize - 6;
		ConsoleDraw.stateMark(graphics, ConsoleDraw.stateMark(AgentControlPresentation.stateCue(agent.state())), markX,
				getY() + (getHeight() - markSize) / 2, markSize);
		int textLeft = getX() + 8;
		String name = fit(agent.displayName(), markX - 4 - textLeft);
		graphics.text(font, ConsoleText.strong(name), textLeft, getY() + (getHeight() - 8) / 2,
				ConsoleTheme.rosterProviderColor(agent.provider()), false);
	}

	private String fit(String value, int available) {
		if (ConsoleText.strongWidth(font, value) <= available) return value;
		int end = value.length();
		while (end > 0 && ConsoleText.strongWidth(font, value.substring(0, end) + "...") > available) end--;
		return value.substring(0, end) + "...";
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
