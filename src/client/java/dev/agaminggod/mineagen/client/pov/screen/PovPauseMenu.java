package dev.agaminggod.mineagen.client.pov.screen;

import dev.agaminggod.mineagen.client.compat.McClientCompat;
import dev.agaminggod.mineagen.client.pov.PovClient;
import java.util.List;
import net.fabricmc.fabric.api.client.screen.v1.Screens;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.components.AbstractWidget;
import net.minecraft.client.gui.components.Button;
import net.minecraft.client.gui.screens.PauseScreen;
import net.minecraft.client.gui.screens.Screen;
import net.minecraft.network.chat.Component;

/** Adds "Leave agent view" to the vanilla pause menu while an agent view is active; it takes the exit key's way out. */
final class PovPauseMenu {
	private static final Component LEAVE = Component.translatable("menu.mineagen.leave_agent_view");
	// Vanilla's full-width pause button and its row gap.
	private static final int FULL_WIDTH = 204;
	private static final int BUTTON_HEIGHT = 20;
	private static final int GAP = 4;

	private PovPauseMenu() {
	}

	static void addLeaveButton(Minecraft client, Screen screen, int width, int height) {
		if (!(screen instanceof PauseScreen pause) || !pause.showsPauseMenu() || !PovClient.isActive()) return;
		List<AbstractWidget> widgets = Screens.getWidgets(screen);
		// The pause layout differs between 26.x drops and mods add rows, so the button goes under whatever is lowest.
		int bottom = 0;
		for (AbstractWidget widget : widgets) if (widget.visible) bottom = Math.max(bottom, widget.getBottom());
		int y = bottom + GAP;
		Button.Builder builder = Button.builder(LEAVE, button -> leave(client));
		if (bottom > 0 && y + BUTTON_HEIGHT <= height - GAP) builder.bounds((width - FULL_WIDTH) / 2, y, FULL_WIDTH, BUTTON_HEIGHT);
		// At a large GUI scale there is no room under the menu; the top-left corner is clear of the title and every row.
		else builder.bounds(GAP, GAP, client.font.width(LEAVE) + 16, BUTTON_HEIGHT);
		widgets.add(builder.build());
	}

	private static void leave(Minecraft client) {
		PovClient.requestExit();
		// A single-player pause holds the integrated server, so the exit command only lands once the menu is closed.
		McClientCompat.setScreen(client, null);
	}
}
