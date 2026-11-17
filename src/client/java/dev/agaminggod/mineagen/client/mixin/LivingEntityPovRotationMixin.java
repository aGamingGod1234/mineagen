package dev.agaminggod.mineagen.client.mixin;

import com.llamalad7.mixinextras.injector.ModifyReturnValue;
import com.llamalad7.mixinextras.sugar.Local;
import dev.agaminggod.mineagen.client.pov.PovView;
import net.minecraft.world.entity.LivingEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;

/** LivingEntity overrides getViewYRot with head yaw; players inherit it, so the POV yaw is applied here. */
@Mixin(LivingEntity.class)
abstract class LivingEntityPovRotationMixin {
	@ModifyReturnValue(method = "getViewYRot", at = @At("RETURN"))
	private float mineagen$povViewYaw(float original, @Local(argsOnly = true) float partialTick) {
		return PovView.yaw(this, partialTick, original);
	}
}
