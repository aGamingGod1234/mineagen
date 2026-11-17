package dev.agaminggod.mineagen.world;

import net.minecraft.core.BlockPos;

public interface WorldMutationRevisionAccess {
	long mineagen$worldMutationRevision(BlockPos center, int radius);

	void mineagen$recordWorldMutation(BlockPos position);
}
