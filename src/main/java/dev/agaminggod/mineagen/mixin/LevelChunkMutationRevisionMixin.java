package dev.agaminggod.mineagen.mixin;

import dev.agaminggod.mineagen.world.ChunkMutationRevisionAccess;
import dev.agaminggod.mineagen.world.WorldMutationRevisionAccess;
import it.unimi.dsi.fastutil.longs.LongOpenHashSet;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.chunk.LevelChunk;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Observe the actual write, including callers that bypass Level.setBlock. */
@Mixin(LevelChunk.class)
abstract class LevelChunkMutationRevisionMixin implements ChunkMutationRevisionAccess {
	@Unique
	private static final int MINEAGEN$MAX_CHANGED_POSITIONS = 4_096;

	@Shadow @Final private Level level;
	@Unique
	private long[] mineagen$sectionRevisions;
	@Unique
	private LongOpenHashSet mineagen$changedPositions;
	@Unique
	private boolean mineagen$changesOverflowed;
	@Unique
	private boolean mineagen$postProcessing;

	@Inject(method = "setBlockState", at = @At("RETURN"))
	private void mineagen$recordBlockMutation(
			BlockPos position, BlockState state, int flags,
			CallbackInfoReturnable<BlockState> callback
	) {
		if (callback.getReturnValue() != null) {
			LevelChunk self = (LevelChunk) (Object) this;
			int section = self.getSectionIndex(position.getY());
			if (mineagen$sectionRevisions == null) mineagen$sectionRevisions = new long[self.getSections().length];
			if (section >= 0 && section < mineagen$sectionRevisions.length) mineagen$sectionRevisions[section]++;
			// Generation's own fix-ups (fences joining, stairs shaping) are not changes made after the world was generated.
			if (!mineagen$postProcessing && !mineagen$changesOverflowed) {
				if (mineagen$changedPositions == null) mineagen$changedPositions = new LongOpenHashSet();
				mineagen$changedPositions.add(position.asLong());
				if (mineagen$changedPositions.size() > MINEAGEN$MAX_CHANGED_POSITIONS) {
					mineagen$changedPositions = null;
					mineagen$changesOverflowed = true;
				}
			}
			((WorldMutationRevisionAccess) level).mineagen$recordWorldMutation(position);
		}
	}

	@Inject(method = "postProcessGeneration", at = @At("HEAD"))
	private void mineagen$beginPostProcessing(ServerLevel level, CallbackInfo callback) {
		mineagen$postProcessing = true;
	}

	@Inject(method = "postProcessGeneration", at = @At("RETURN"))
	private void mineagen$endPostProcessing(ServerLevel level, CallbackInfo callback) {
		mineagen$postProcessing = false;
	}

	@Override
	public long mineagen$sectionMutationRevision(int sectionIndex) {
		long[] revisions = mineagen$sectionRevisions;
		return revisions == null || sectionIndex < 0 || sectionIndex >= revisions.length ? 0L : revisions[sectionIndex];
	}

	@Override
	public boolean mineagen$changedSinceLoad(BlockPos position) {
		if (mineagen$changesOverflowed) return true;
		LongOpenHashSet changed = mineagen$changedPositions;
		return changed != null && changed.contains(position.asLong());
	}
}
