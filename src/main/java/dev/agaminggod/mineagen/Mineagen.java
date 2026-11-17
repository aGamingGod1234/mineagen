package dev.agaminggod.mineagen;

import dev.agaminggod.mineagen.agent.CodexAgentEntities;
import dev.agaminggod.mineagen.server.AgentControlSync;
import dev.agaminggod.mineagen.server.AgentModelArgumentType;
import dev.agaminggod.mineagen.server.CodexAgentCommands;
import dev.agaminggod.mineagen.server.CodexAgentServerRuntime;
import net.fabricmc.api.ModInitializer;

public final class Mineagen implements ModInitializer {
	@Override
	public void onInitialize() {
		// Fabric runs this from the start of the dedicated server's Main, before Main opens or creates the world: the
		// intervention audit's evidence that this server is creating it.
		if (net.fabricmc.loader.api.FabricLoader.getInstance().getEnvironmentType() == net.fabricmc.api.EnvType.SERVER) {
			dev.agaminggod.mineagen.server.audit.StartupWorldProvenance.capture(
					net.fabricmc.loader.api.FabricLoader.getInstance().getGameDir(), net.fabricmc.loader.api.FabricLoader.getInstance().getLaunchArguments(false));
		}
		CodexAgentEntities.register();
		AgentModelArgumentType.register();
		AgentControlSync.register();
		dev.agaminggod.mineagen.risk.RiskOverlayPublisher.register();
		CodexAgentCommands.register();
		CodexAgentServerRuntime.register();
	}
}
