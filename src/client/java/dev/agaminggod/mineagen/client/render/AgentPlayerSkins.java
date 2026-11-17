package dev.agaminggod.mineagen.client.render;

import com.mojang.authlib.GameProfile;
import dev.agaminggod.mineagen.agent.AgentIdentity;
import dev.agaminggod.mineagen.agent.AgentVisualIdentity;
import dev.agaminggod.mineagen.client.control.AgentClientRoster;
import dev.agaminggod.mineagen.control.AgentControlAgent;
import java.util.Optional;
import net.minecraft.core.ClientAsset;
import net.minecraft.resources.Identifier;
import net.minecraft.world.entity.player.PlayerModelType;
import net.minecraft.world.entity.player.PlayerSkin;

public final class AgentPlayerSkins {
	private AgentPlayerSkins() {
	}

	public static Optional<PlayerSkin> forProfile(GameProfile profile) {
		String name = profile.name();
		AgentControlAgent agent = AgentClientRoster.agentForPlayer(name).orElse(null);
		AgentVisualIdentity.Resolved identity;
		if (agent != null) {
			if (!profile.id().equals(AgentIdentity.offlinePlayerUuid(agent.playerName()))) return Optional.empty();
			identity = AgentVisualIdentity.resolve(agent.provider(), agent.model(), agent.skinVariant());
		} else {
			// Old transport names can identify a body before its first roster arrives.
			AgentIdentity.SkinIdentity legacy = AgentIdentity.skinForPlayerName(name).orElse(null);
			if (legacy == null || !profile.id().equals(AgentIdentity.offlinePlayerUuid(name))) return Optional.empty();
			identity = legacy.modelFamily().isBlank()
					? AgentVisualIdentity.resolveProviderFallback(legacy.provider(), legacy.variant())
					: AgentVisualIdentity.resolveFamily(legacy.provider(), legacy.modelFamily(), legacy.variant());
		}
		Identifier texture = CodexAgentRenderer.textureFor(identity);
		ClientAsset.Texture body = new ClientAsset.ResourceTexture(texture, texture);
		return Optional.of(new PlayerSkin(body, null, null, PlayerModelType.WIDE, false));
	}
}
