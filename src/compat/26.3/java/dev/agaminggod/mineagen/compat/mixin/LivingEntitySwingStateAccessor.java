package dev.agaminggod.mineagen.compat.mixin;

import net.minecraft.world.entity.LivingEntity;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(LivingEntity.class)
public interface LivingEntitySwingStateAccessor {
	@Accessor("swingState")
	LivingEntity.SwingState mineagen$swingState();
}
