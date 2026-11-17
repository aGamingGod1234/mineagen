package dev.agaminggod.mineagen.client.render;

import dev.agaminggod.mineagen.agent.CodexAgentEntities;
import net.fabricmc.fabric.api.client.rendering.v1.EntityRendererRegistry;

public final class CodexAgentRenderers {
	private CodexAgentRenderers() {
	}

	public static void register() {
		EntityRendererRegistry.register(CodexAgentEntities.CODEX_AGENT, CodexAgentRenderer::new);
	}
}
