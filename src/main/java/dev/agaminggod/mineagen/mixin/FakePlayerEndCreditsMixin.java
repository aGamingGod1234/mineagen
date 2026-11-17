package dev.agaminggod.mineagen.mixin;

import carpet.patches.EntityPlayerMPFake;
import net.minecraft.network.protocol.game.ServerboundClientCommandPacket;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.TickTask;
import net.minecraft.server.level.ServerPlayer;
import org.spongepowered.asm.mixin.Mixin;
import org.spongepowered.asm.mixin.injection.At;
import org.spongepowered.asm.mixin.injection.Inject;
import org.spongepowered.asm.mixin.injection.callback.CallbackInfo;

@Mixin(ServerPlayer.class)
abstract class FakePlayerEndCreditsMixin {
	@Inject(method = "showEndCredits", at = @At("TAIL"))
	private void mineagen$finishCreditsForFakePlayer(CallbackInfo callback) {
		if (!((Object) this instanceof EntityPlayerMPFake fake) || !fake.wonGame) return;
		MinecraftServer server = fake.level().getServer();
		server.schedule(new TickTask(server.getTickCount(), () -> {
			if (fake.wonGame && fake.connection.player == fake) {
				fake.connection.handleClientCommand(new ServerboundClientCommandPacket(
						ServerboundClientCommandPacket.Action.PERFORM_RESPAWN));
			}
		}));
	}
}
