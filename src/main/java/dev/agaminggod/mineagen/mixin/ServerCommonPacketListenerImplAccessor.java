package dev.agaminggod.mineagen.mixin;

import net.minecraft.network.Connection;
import net.minecraft.server.network.ServerCommonPacketListenerImpl;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/** A provider API key is accepted only over the integrated host's in-memory connection, so the server needs to see it. */
@Mixin(ServerCommonPacketListenerImpl.class)
public interface ServerCommonPacketListenerImplAccessor {
	@Accessor("connection")
	Connection mineagen$connection();
}
