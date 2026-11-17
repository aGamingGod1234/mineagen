package dev.agaminggod.mineagen.mixin;

import dev.agaminggod.mineagen.compat.McCompat;

import carpet.patches.EntityPlayerMPFake;
import com.llamalad7.mixinextras.sugar.Share;
import com.llamalad7.mixinextras.sugar.ref.LocalBooleanRef;
import dev.agaminggod.mineagen.server.CodexAgentServerRuntime;
import net.minecraft.advancements.AdvancementHolder;
import net.minecraft.advancements.AdvancementProgress;
import net.minecraft.server.PlayerAdvancements;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Shadow;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfoReturnable;

@Mixin(PlayerAdvancements.class)
abstract class PlayerAdvancementsMixin {
	@Shadow private ServerPlayer player;
	@Shadow public abstract AdvancementProgress getOrStartProgress(AdvancementHolder holder);

	@Inject(method = "award", at = @At("HEAD"))
	private void mineagen$captureAdvancementProgress(AdvancementHolder holder, String criterion, CallbackInfoReturnable<Boolean> callback, @Share("wasDone") LocalBooleanRef wasDone) {
		wasDone.set(player instanceof EntityPlayerMPFake && holder.value().display().isPresent()
				&& getOrStartProgress(holder).isDone());
	}

	@Inject(method = "award", at = @At("RETURN"))
	private void mineagen$advancementGranted(AdvancementHolder holder, String criterion, CallbackInfoReturnable<Boolean> callback, @Share("wasDone") LocalBooleanRef wasDone) {
		if (player instanceof EntityPlayerMPFake && holder.value().display().isPresent() && dev.agaminggod.mineagen.server.goal.PlanProgressFacts.advancementCompleted(
				holder.value().display().isPresent(), wasDone.get(), getOrStartProgress(holder).isDone())) {
			CodexAgentServerRuntime.advancementGranted(player, holder.id().toString());
			holder.value().display().filter(display -> McCompat.advancementShowsToast(display)).ifPresent(display ->
					dev.agaminggod.mineagen.server.perception.PlayerObservationEvents.advancementToast(player, McCompat.advancementTitle(display).getString()));
		}
	}
}
