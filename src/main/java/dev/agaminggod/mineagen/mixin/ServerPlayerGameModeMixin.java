package dev.agaminggod.mineagen.mixin;

import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.level.ServerPlayerGameMode;
import org.spongepowered.asm.mixin.Final;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

/** Records the authoritative world mutation produced by this player's break handler. */
@Mixin(ServerPlayerGameMode.class)
abstract class ServerPlayerGameModeMixin implements dev.agaminggod.mineagen.server.runtime.ServerActionExecutor.BlockBreakReceiptAccess {
	@com.llamalad7.mixinextras.injector.wrapmethod.WrapMethod(method = "useItemOn")
	private net.minecraft.world.InteractionResult mineagen$attributeBlockUse(
			ServerPlayer actor, net.minecraft.world.level.Level level, net.minecraft.world.item.ItemStack stack,
			net.minecraft.world.InteractionHand hand, net.minecraft.world.phys.BlockHitResult hit,
			com.llamalad7.mixinextras.injector.wrapoperation.Operation<net.minecraft.world.InteractionResult> original) {
		return dev.agaminggod.mineagen.server.runtime.BlockUseAttribution.during(actor,
				() -> original.call(actor, level, stack, hand, hit));
	}

	@Shadow
	@Final
	protected ServerPlayer player;

	@Unique
	private BlockPos mineagen$lastDestroyedBlock;

	@Unique
	private long mineagen$lastDestroyedGameTime = -1L;

	@Unique
	private dev.agaminggod.mineagen.server.runtime.ServerActionExecutor.BlockBreakReceipt mineagen$blockBreakReceipt;

	@Unique
	private dev.agaminggod.mineagen.server.runtime.BreakOutcomeEvidence.Snapshot mineagen$breakOutcome;

	@Override
	public dev.agaminggod.mineagen.server.runtime.ServerActionExecutor.BlockBreakReceipt mineagen$getBlockBreakReceipt() {
		return mineagen$blockBreakReceipt;
	}

	@com.llamalad7.mixinextras.injector.wrapoperation.WrapOperation(method = "destroyBlock", at = @At(
			value = "INVOKE", target = "Lnet/minecraft/server/level/ServerLevel;removeBlock(Lnet/minecraft/core/BlockPos;Z)Z"))
	private boolean mineagen$recordRemoval(net.minecraft.server.level.ServerLevel level, BlockPos position,
			boolean moving, com.llamalad7.mixinextras.injector.wrapoperation.Operation<Boolean> original) {
		if (!(player instanceof carpet.patches.EntityPlayerMPFake)) return original.call(level, position, moving);
		net.minecraft.world.level.block.state.BlockState before = level.getBlockState(position);
		mineagen$breakOutcome = dev.agaminggod.mineagen.server.runtime.BreakOutcomeEvidence.capture(player, position, before);
		var exposure = dev.agaminggod.mineagen.server.perception.BreakExposureEvidence.capture(level, player, position);
		boolean removed = original.call(level, position, moving);
		if (removed) {
			mineagen$blockBreakReceipt = new dev.agaminggod.mineagen.server.runtime.ServerActionExecutor.BlockBreakReceipt(
					position, before, level.getBlockState(position), exposure.afterRemoval(true));
		}
		return removed;
	}

	@Inject(method = "destroyBlock", at = @At("RETURN"))
	private void mineagen$recordDestroyedBlock(BlockPos position, CallbackInfoReturnable<Boolean> callback) {
		if (!callback.getReturnValueZ()) return;
		// Vanilla generates loot after removeBlock returns, so inspect visible drops only at destroyBlock's return.
		if (mineagen$breakOutcome != null && mineagen$blockBreakReceipt != null
				&& mineagen$blockBreakReceipt.position().equals(position)) {
			mineagen$blockBreakReceipt = mineagen$blockBreakReceipt.withOutcome(mineagen$breakOutcome.after(player, position));
			mineagen$breakOutcome = null;
		}
		mineagen$lastDestroyedBlock = position.immutable();
		mineagen$lastDestroyedGameTime = player.level().getGameTime();
	}
}
