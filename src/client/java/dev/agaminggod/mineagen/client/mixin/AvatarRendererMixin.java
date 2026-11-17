package dev.agaminggod.mineagen.client.mixin;

import dev.agaminggod.mineagen.client.control.AgentControlClient;
import dev.agaminggod.mineagen.agent.AgentIdentity;
import dev.agaminggod.mineagen.control.AgentControlAgent;
import dev.agaminggod.mineagen.control.AgentWorldNamePolicy;
import java.util.Optional;
import net.minecraft.client.renderer.entity.state.AvatarRenderState;
import net.minecraft.client.renderer.entity.player.AvatarRenderer;
import net.minecraft.network.chat.Component;
import net.minecraft.world.entity.EntityAttachment;
import net.minecraft.world.entity.Avatar;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Keeps generated offline-player identifiers out of the world view for known Mineagen. */
@Mixin(AvatarRenderer.class)
abstract class AvatarRendererMixin {
	@Inject(
			method = "shouldShowName(Lnet/minecraft/world/entity/Avatar;D)Z",
			at = @At("HEAD"),
			cancellable = true
	)
	private void mineagen$showAgentName(Avatar avatar, double distance, CallbackInfoReturnable<Boolean> callback) {
		avatar.getProfile().name().ifPresent(name -> {
			Optional<AgentControlAgent> snapshotAgent = AgentControlClient.agentForPlayer(name);
			if (snapshotAgent.isPresent()) {
				if (hasExpectedOfflineUuid(avatar, snapshotAgent.orElseThrow())) callback.setReturnValue(true);
				return;
			}
			if (AgentIdentity.skinForPlayerName(name).isPresent()
					&& avatar.getUUID().equals(AgentIdentity.offlinePlayerUuid(name))) {
				callback.setReturnValue(true);
			}
		});
	}

	@Inject(
			method = "extractRenderState(Lnet/minecraft/world/entity/Avatar;Lnet/minecraft/client/renderer/entity/state/AvatarRenderState;F)V",
			at = @At("RETURN")
	)
	private void mineagen$extractFriendlyName(
			Avatar avatar,
			AvatarRenderState state,
			float partialTick,
			CallbackInfo callback
	) {
		AgentControlAgent agent = avatar.getProfile().name()
				.flatMap(AgentControlClient::agentForPlayer)
				.filter(candidate -> hasExpectedOfflineUuid(avatar, candidate))
				.orElse(null);
		if (agent == null) {
			avatar.getProfile().name()
					.filter(name -> AgentIdentity.skinForPlayerName(name).isPresent())
					.filter(name -> avatar.getUUID().equals(AgentIdentity.offlinePlayerUuid(name)))
					.ifPresent(name -> {
						state.nameTag = Component.literal(name);
						state.nameTagAttachment = avatar.getAttachments().getNullable(
								EntityAttachment.NAME_TAG, 0, avatar.getYRot());
					});
			return;
		}

		state.nameTag = null;
		state.nameTagAttachment = null;
		if (state.distanceToCameraSq > 4096.0D) return;
		AgentWorldNamePolicy.tag(agent).ifPresent(tag -> {
			state.nameTag = Component.literal(tag);
			state.nameTagAttachment = avatar.getAttachments().getNullable(
					EntityAttachment.NAME_TAG, 0, avatar.getYRot());
		});
	}

	/** Runs after the friendly-name injection above: appends the watched agent's risk label (presentation only). */
	@Inject(
			method = "extractRenderState(Lnet/minecraft/world/entity/Avatar;Lnet/minecraft/client/renderer/entity/state/AvatarRenderState;F)V",
			at = @At("RETURN")
	)
	private void mineagen$riskLabel(Avatar avatar, AvatarRenderState state, float partialTick, CallbackInfo callback) {
		if (!dev.agaminggod.mineagen.client.presentation.RiskOverlayClient.has(avatar.getId())) return;
		state.nameTag = dev.agaminggod.mineagen.client.presentation.RiskOverlayClient.decorate(avatar.getId(), state.nameTag);
		if (state.nameTagAttachment == null) {
			state.nameTagAttachment = avatar.getAttachments().getNullable(EntityAttachment.NAME_TAG, 0, avatar.getYRot());
		}
	}

	private static boolean hasExpectedOfflineUuid(Avatar avatar, AgentControlAgent agent) {
		return avatar.getUUID().equals(AgentIdentity.offlinePlayerUuid(agent.playerName()));
	}
}
