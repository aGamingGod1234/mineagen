package dev.agaminggod.mineagen.mixin;

import net.minecraft.server.players.NameAndId;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

@Mixin(targets = "net.minecraft.server.players.CachedUserNameToIdResolver$GameProfileInfo")
public interface CachedProfileInfoAccessor {
	@Accessor("nameAndId")
	NameAndId mineagen$nameAndId();
}
