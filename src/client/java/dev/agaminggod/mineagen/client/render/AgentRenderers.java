package dev.agaminggod.mineagen.client.render;

import dev.agaminggod.mineagen.agent.AgentEntities;
import net.fabricmc.fabric.api.client.rendering.v1.EntityRendererRegistry;

public final class AgentRenderers {
	private AgentRenderers() {
	}

	public static void register() {
		EntityRendererRegistry.register(AgentEntities.CODEX_AGENT, AgentRenderer::new);
	}
}
