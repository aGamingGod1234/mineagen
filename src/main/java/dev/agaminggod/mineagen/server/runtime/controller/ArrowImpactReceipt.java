package dev.agaminggod.mineagen.server.runtime.controller;

import net.minecraft.world.entity.Entity;

/** A visible collision of this arrow, recorded by vanilla's hit callback rather than inferred from damage nearby. */
public interface ArrowImpactReceipt {
	boolean mineagen$struck(Entity target);
	boolean mineagen$destroyed(Entity target);
	/** The type id of another entity this arrow was seen to strike instead of {@code target}, or null. */
	String mineagen$struckOther(Entity target);
}
