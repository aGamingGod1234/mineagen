package dev.agaminggod.mineagen.client.mixin;

import dev.agaminggod.mineagen.client.pov.input.OperatorInputSender;
import dev.agaminggod.mineagen.client.pov.screen.PovScreens;
import net.minecraft.client.Minecraft;
import net.minecraft.client.player.LocalPlayer;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(LocalPlayer.class)
abstract class LocalPlayerPovMixin {
	@Shadow
	@Final
	protected Minecraft minecraft;

	// With the camera on the agent, applyInput takes the non-controlled branch and keeps stale impulses.
	@Inject(method = "applyInput", at = @At("TAIL"))
	private void mineagen$holdBodyStill(CallbackInfo callback) {
		if (!OperatorInputSender.sessionActive()) return;
		LocalPlayer self = (LocalPlayer) (Object) this;
		self.xxa = 0.0F;
		self.zza = 0.0F;
		self.setJumping(false);
	}

	// Mirrored screens close through here; vanilla would send ServerboundContainerClosePacket for the operator.
	@Inject(method = "closeContainer", at = @At("HEAD"), cancellable = true)
	private void mineagen$closeMirroredScreen(CallbackInfo callback) {
		if (PovScreens.interceptCloseContainer(minecraft)) callback.cancel();
	}
}
