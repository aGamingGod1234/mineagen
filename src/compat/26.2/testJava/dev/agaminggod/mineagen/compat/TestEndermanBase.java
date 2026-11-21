package dev.agaminggod.mineagen.compat;

import net.minecraft.world.entity.ai.attributes.AttributeSupplier;
import net.minecraft.world.entity.monster.EnderMan;

/** An enderman fixture base with one name on every target (the vanilla class is EnderMan before 26.3, Enderman from it). */
public abstract class TestEndermanBase extends EnderMan {
	protected TestEndermanBase() {
		super(net.minecraft.world.entity.EntityTypes.ENDERMAN, null);
	}

	public static AttributeSupplier.Builder endermanAttributes() {
		return EnderMan.createAttributes();
	}
}
