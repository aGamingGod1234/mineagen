package dev.agaminggod.mineagen.control;

import java.util.Set;
import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

/**
 * Serverbound only, and honoured only for the player hosting an integrated world on this machine: the boat account,
 * the Runs on choice and the model sign-ins all belong to the computer the game runs on. Carries no credential.
 */
public record BoatControlPayload(String action) implements CustomPacketPayload {
	public static final Set<String> ACTIONS = Set.of("runs_on:boat", "runs_on:local", "consent:on", "consent:off",
			"sign_in:boat", "sign_out:boat", "sign_in:codex", "sign_in:claude", "stop_machine");
	public static final Type<BoatControlPayload> TYPE = new Type<>(Identifier.fromNamespaceAndPath("mineagen", "boat_control"));
	public static final StreamCodec<RegistryFriendlyByteBuf, BoatControlPayload> CODEC = new StreamCodec<>() {
		@Override public BoatControlPayload decode(RegistryFriendlyByteBuf buffer) { return new BoatControlPayload(buffer.readUtf(32)); }
		@Override public void encode(RegistryFriendlyByteBuf buffer, BoatControlPayload payload) { buffer.writeUtf(payload.action, 32); }
	};

	public BoatControlPayload {
		if (action == null || !ACTIONS.contains(action)) throw new IllegalArgumentException("Unknown boat action");
	}

	@Override public Type<BoatControlPayload> type() { return TYPE; }
}
