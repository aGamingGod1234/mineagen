package dev.agaminggod.mineagen.mixin;

import dev.agaminggod.mineagen.world.WorldMutationRevisionAccess;
import dev.agaminggod.mineagen.world.WorldMutationRevisions;
import net.minecraft.core.BlockPos;
import net.minecraft.world.level.Level;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;

/** Invalidates cached perception samples when a level successfully changes a block. */
@Mixin(Level.class)
abstract class LevelMutationRevisionMixin implements WorldMutationRevisionAccess {
	@Unique
	private final WorldMutationRevisions mineagen$worldMutationRevisions = new WorldMutationRevisions();

	@Override
	public void mineagen$recordWorldMutation(BlockPos position) {
		mineagen$worldMutationRevisions.recordMutation(position.getX(), position.getZ());
	}

	@Override
	public long mineagen$worldMutationRevision(BlockPos center, int radius) {
		return mineagen$worldMutationRevisions.revision(center.getX(), center.getZ(), radius);
	}
}
