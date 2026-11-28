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

	/**
	 * Muted tile colours behind faces. Two agents on the same provider wear near-identical skins (the provider's logo
	 * is the face), so each agent also gets one of these from its id and keeps it everywhere it is shown.
	 */
	private static final int[] TINTS = {
			0xFF3F6A9E, 0xFF7A54A8, 0xFFB0703A, 0xFF3E8F6A, 0xFFA84E66, 0xFF7E9A3C, 0xFF3A8C98, 0xFFB59A3A
	};

	/** The agent's own tile colour, stable for its id. */
	public static int tint(String agentId) {
		if (agentId == null || agentId.isEmpty()) return TINTS[0];
		int hash = agentId.hashCode();
		hash ^= hash >>> 16;
		return TINTS[Math.floorMod(hash * 0x45D9F3B, TINTS.length)];
	}

	/** The face on its agent's tile: {@code size} is the tile, the face sits inside a two-pixel margin of colour. */
	public static void tile(GuiGraphicsExtractor graphics, AgentControlAgent agent, int x, int y, int size) {
		int pad = size >= 28 ? 3 : 2;
		ConsoleDraw.surface(graphics, x, y, size, size, ConsoleDraw.RADIUS_SMALL, tint(agent == null ? "" : agent.agentId()));
		int face = size - pad * 2;
		if (!draw(graphics, agent, x + pad, y + pad, face)) {
			ConsoleDraw.surface(graphics, x + pad, y + pad, face, face, ConsoleDraw.RADIUS_SMALL, ConsoleTheme.SURFACE_RAISED);
		}
	}
}
