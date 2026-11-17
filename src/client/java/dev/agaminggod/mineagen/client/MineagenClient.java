package dev.agaminggod.mineagen.client;

import dev.agaminggod.mineagen.client.control.AgentControlClient;
import dev.agaminggod.mineagen.client.control.DesktopAwtInitialization;
import dev.agaminggod.mineagen.client.pov.PovClient;
import dev.agaminggod.mineagen.client.pov.PovHudProxy;
import dev.agaminggod.mineagen.client.pov.input.OperatorInputSender;
import dev.agaminggod.mineagen.client.pov.screen.PovScreens;
import dev.agaminggod.mineagen.client.render.CodexAgentRenderers;
import net.fabricmc.api.ClientModInitializer;

public final class MineagenClient implements ClientModInitializer {

	@Override
	public void onInitializeClient() {
		DesktopAwtInitialization.initialize();
		dev.agaminggod.mineagen.client.control.PlanItemIcons.register();
		CodexAgentRenderers.register();
		AgentControlClient.register();
		PovClient.register();
		OperatorInputSender.register();
		dev.agaminggod.mineagen.client.presentation.RiskOverlayClient.register();
		// Mirrored container screens read the same stand-in player the HUD renders from.
		PovScreens.setProxyInventory(() -> {
			var proxy = PovHudProxy.current();
			return proxy == null ? null : proxy.getInventory();
		});
	}
}
