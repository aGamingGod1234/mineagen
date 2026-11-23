package dev.agaminggod.mineagen.mixin;

import dev.agaminggod.mineagen.server.perception.FarSight;
import dev.agaminggod.mineagen.world.ChunkDemotionHook;
import net.minecraft.server.level.ChunkHolder;
import net.minecraft.server.level.ChunkMap;
import net.minecraft.server.level.FullChunkStatus;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.LevelHeightAccessor;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

/**
 * Tells far sight which chunk dropped a full status. getChunkNow stops returning a chunk only when its ticket level
 * leaves full status, and DistanceManager.runAllUpdates lowers the allowed status and calls updateFutures, which calls
 * this, in one pass with no game code between; so a look never sees a chunk gone before far sight heard of it.
 */
@Mixin(ChunkHolder.class)
abstract class ChunkHolderDemotionMixin implements ChunkDemotionHook {
	@Shadow @Final private LevelHeightAccessor levelHeightAccessor;

	@Inject(method = "demoteFullChunk", at = @At("HEAD"))
	private void mineagen$reportDemotion(ChunkMap chunkMap, FullChunkStatus status, CallbackInfo callback) {
		if (levelHeightAccessor instanceof ServerLevel level) FarSight.chunkDemoted(level, ((ChunkHolder) (Object) this).getPos().pack());
	}
}
