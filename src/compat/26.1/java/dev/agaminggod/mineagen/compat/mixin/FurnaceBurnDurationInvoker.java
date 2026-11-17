package dev.agaminggod.mineagen.compat.mixin;

import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.entity.AbstractFurnaceBlockEntity;
import net.minecraft.world.level.block.entity.FuelValues;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Invoker;

/** Preserve virtual burn-duration adjustments, including smokers and blast furnaces. */
@Mixin(AbstractFurnaceBlockEntity.class)
public interface FurnaceBurnDurationInvoker {
	@Invoker("getBurnDuration")
	int mineagen$burnDuration(FuelValues values, ItemStack stack);
}
