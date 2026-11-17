package dev.agaminggod.mineagen.mixin;

import dev.agaminggod.mineagen.server.perception.ObservationVisibility;
import dev.agaminggod.mineagen.server.runtime.controller.ArrowImpactReceipt;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.UUID;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.projectile.arrow.AbstractArrow;
import net.minecraft.world.phys.EntityHitResult;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.Unique;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(AbstractArrow.class)
abstract class ArrowImpactReceiptMixin implements ArrowImpactReceipt {
	@Unique private final Map<UUID, Boolean> mineagen$visibleHits = new LinkedHashMap<>();
	@Unique private final Map<UUID, String> mineagen$visibleHitTypes = new LinkedHashMap<>();
	@Unique private boolean mineagen$visibleImpact;
	@Unique private boolean mineagen$aliveBeforeImpact;

	@Inject(method = "onHitEntity", at = @At("HEAD"))
	private void mineagen$beforeHit(EntityHitResult hit, CallbackInfo ci) {
		AbstractArrow arrow = (AbstractArrow) (Object) this;
		mineagen$aliveBeforeImpact = hit.getEntity().isAlive();
		mineagen$visibleImpact = arrow.getOwner() instanceof ServerPlayer player
				&& ObservationVisibility.canSeeEntity(player, arrow)
				&& ObservationVisibility.canSeeEntity(player, hit.getEntity());
	}

	@Inject(method = "onHitEntity", at = @At("RETURN"))
	private void mineagen$afterHit(EntityHitResult hit, CallbackInfo ci) {
		if (!mineagen$visibleImpact) return;
		mineagen$visibleHits.put(hit.getEntity().getUUID(), mineagen$aliveBeforeImpact && !hit.getEntity().isAlive());
		mineagen$visibleHitTypes.put(hit.getEntity().getUUID(), net.minecraft.core.registries.BuiltInRegistries.ENTITY_TYPE.getKey(hit.getEntity().getType()).toString());
		while (mineagen$visibleHits.size() > 128) mineagen$visibleHits.remove(mineagen$visibleHits.keySet().iterator().next());
		while (mineagen$visibleHitTypes.size() > 128) mineagen$visibleHitTypes.remove(mineagen$visibleHitTypes.keySet().iterator().next());
	}

	@Override public boolean mineagen$struck(Entity target) { return mineagen$visibleHits.containsKey(target.getUUID()); }
	@Override public String mineagen$struckOther(Entity target) {
		for (var hit : mineagen$visibleHitTypes.entrySet()) if (!hit.getKey().equals(target.getUUID())) return hit.getValue();
		return null;
	}
	@Override public boolean mineagen$destroyed(Entity target) { return Boolean.TRUE.equals(mineagen$visibleHits.get(target.getUUID())); }
}
