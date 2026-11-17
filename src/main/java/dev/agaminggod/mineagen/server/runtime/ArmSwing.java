package dev.agaminggod.mineagen.server.runtime;

import dev.agaminggod.mineagen.compat.McCompat;

import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.LivingEntity;

public final class ArmSwing {
	private ArmSwing() {
	}

	public static void attack(LivingEntity entity, InteractionHand hand) {
		McCompat.swingAttack(entity, hand);
	}

	public static void use(LivingEntity entity, InteractionHand hand) {
		use(entity, hand, false);
	}

	public static void use(LivingEntity entity, InteractionHand hand, boolean toSelf) {
		McCompat.swingUse(entity, hand, toSelf);
	}
}
