package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.agent.AgentVisualIdentity;
import dev.agaminggod.mineagen.client.render.AgentRenderer;
import dev.agaminggod.mineagen.control.AgentControlAgent;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.resources.Identifier;

/** An agent's face, cut from the same skin its body wears in the world: the face and the hat layer over it. */
public final class AgentFaces {
	private AgentFaces() {
	}

	/** The skin the agent's body renders with, or null when its provider has no skin. */
	public static Identifier skin(AgentControlAgent agent) {
		if (agent == null) return null;
		try {
			return AgentRenderer.textureFor(AgentVisualIdentity.resolve(agent.provider(), agent.model(), agent.skinVariant()));
		} catch (RuntimeException unknownModel) {
			try {
				return AgentRenderer.textureFor(AgentVisualIdentity.resolveProviderFallback(agent.provider(), agent.skinVariant()));
			} catch (RuntimeException unknownProvider) {
				return null;
			}
		}
	}

	/** Draws the face in a {@code size} square; returns false when there is no skin to cut it from. */
	public static boolean draw(GuiGraphicsExtractor graphics, AgentControlAgent agent, int x, int y, int size) {
		Identifier skin = skin(agent);
		if (skin == null) return false;
		graphics.blit(RenderPipelines.GUI_TEXTURED, skin, x, y, 8F, 8F, size, size, 8, 8, 64, 64);
		graphics.blit(RenderPipelines.GUI_TEXTURED, skin, x, y, 40F, 8F, size, size, 8, 8, 64, 64);
		return true;
	}
}
