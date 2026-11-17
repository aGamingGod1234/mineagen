package dev.agaminggod.mineagen.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayerGameMode;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** Reads the last block destruction committed by this player's vanilla game mode. */
@Mixin(ServerPlayerGameMode.class)
public interface ServerPlayerGameModeBreakAccessor {
	@Accessor("mineagen$lastDestroyedBlock")
	BlockPos mineagen$getLastDestroyedBlock();

	@Accessor("mineagen$lastDestroyedGameTime")
	long mineagen$getLastDestroyedGameTime();
}
