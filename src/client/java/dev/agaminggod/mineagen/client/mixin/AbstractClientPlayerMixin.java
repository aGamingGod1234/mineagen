package dev.agaminggod.mineagen.client.mixin;

import dev.agaminggod.mineagen.client.render.AgentPlayerSkins;
import net.minecraft.client.player.AbstractClientPlayer;
import net.minecraft.world.entity.player.PlayerSkin;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(AbstractClientPlayer.class)
abstract class AbstractClientPlayerMixin {
	@Inject(method = "getSkin", at = @At("HEAD"), cancellable = true)
	private void mineagen$agentSkin(CallbackInfoReturnable<PlayerSkin> callback) {
		AbstractClientPlayer player = (AbstractClientPlayer) (Object) this;
		AgentPlayerSkins.forProfile(player.getGameProfile()).ifPresent(callback::setReturnValue);
	}

}
