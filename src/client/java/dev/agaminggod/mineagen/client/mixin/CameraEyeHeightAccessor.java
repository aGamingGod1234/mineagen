package dev.agaminggod.mineagen.client.mixin;

import net.minecraft.client.Camera;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(Camera.class)
public interface CameraEyeHeightAccessor {
	@Accessor("eyeHeight")
	void mineagen$setEyeHeight(float height);

	@Accessor("eyeHeightOld")
	void mineagen$setEyeHeightOld(float height);
}
