package dev.agaminggod.mineagen.mixin;

import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.phys.Vec3;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.gen.Accessor;

/**
 * Carpet fake connections never acknowledge teleports, so vanilla's pending-teleport position stays set
 * after any teleport and silently rejects relayed use-on-block packets for an operator-controlled body.
 */
@Mixin(ServerGamePacketListenerImpl.class)
public interface ServerGamePacketListenerImplAccessor {
	@Accessor("awaitingPositionFromClient")
	void mineagen$setAwaitingPositionFromClient(Vec3 position);
}
