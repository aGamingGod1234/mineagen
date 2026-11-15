package dev.agaminggod.arenaagents.control;

import net.minecraft.network.RegistryFriendlyByteBuf;
import net.minecraft.network.codec.StreamCodec;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.resources.Identifier;

/** Serverbound only. Never use a command, chat message or record to carry a credential. */
public final class ProviderApiKeyPayload implements CustomPacketPayload {
	public static final Type<ProviderApiKeyPayload> TYPE = new Type<>(Identifier.fromNamespaceAndPath("arenaagents", "provider_api_key"));
	public static final StreamCodec<RegistryFriendlyByteBuf, ProviderApiKeyPayload> CODEC = new StreamCodec<>() {
		@Override public ProviderApiKeyPayload decode(RegistryFriendlyByteBuf buffer) {
			return new ProviderApiKeyPayload(buffer.readUtf(16), buffer.readUtf(512));
		}
		@Override public void encode(RegistryFriendlyByteBuf buffer, ProviderApiKeyPayload payload) {
			buffer.writeUtf(payload.provider, 16);
			buffer.writeUtf(payload.key, 512);
		}
	};
	private final String provider;
	private final String key;

	public ProviderApiKeyPayload(String provider, String key) {
		if (provider == null || provider.length() > 16 || key == null || key.length() > 512)
			throw new IllegalArgumentException("Invalid provider credential request");
		this.provider = provider;
		this.key = key;
	}
	public String provider() { return provider; }
	/** Empty means remove. Read only in the authorized server handler. */
	public String key() { return key; }
	@Override public Type<ProviderApiKeyPayload> type() { return TYPE; }
	@Override public String toString() { return "ProviderApiKeyPayload[REDACTED]"; }
}
