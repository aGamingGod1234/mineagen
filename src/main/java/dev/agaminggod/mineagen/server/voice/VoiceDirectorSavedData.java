package dev.agaminggod.mineagen.server.voice;

import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import dev.agaminggod.mineagen.agent.AgentId;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.world.level.saveddata.SavedData;
import net.minecraft.world.level.saveddata.SavedDataType;

/**
 * World-scoped persistence for agent voice settings. Unknown legacy script fields are ignored.
 * A stored speed is an explicit override (1.0 included); no stored speed inherits automatic-assignment pacing
 * for voice.auto.v1. Other selected IDs keep the worker's default pace.
 * Saves written before this distinction omitted speed when it was 1.0, so those records load as inherited:
 * the command filled in 1.0 when no speed was typed, which is the common case. A typed 1.0 in an old save
 * cannot be told apart and also loads as inherited. Nondefault old speeds were always written and stay explicit.
 */
public final class VoiceDirectorSavedData extends SavedData {
	private static final Codec<VoiceProfile> PROFILE_CODEC = RecordCodecBuilder.create(instance -> instance.group(
			Codec.STRING.fieldOf("profile").forGetter(VoiceProfile::profileId),
			Codec.STRING.optionalFieldOf("tone", VoiceProfile.DEFAULT_TONE).forGetter(VoiceProfile::tone),
			Codec.DOUBLE.optionalFieldOf("speed").forGetter(profile -> profile.explicitSpeed()
					? Optional.of(profile.speed()) : Optional.empty()),
			Codec.INT.optionalFieldOf("radius", VoiceProfile.DEFAULT_RADIUS).forGetter(VoiceProfile::radius)
	).apply(instance, (profile, tone, speed, radius) -> new VoiceProfile(profile, tone,
			speed.orElse(VoiceProfile.DEFAULT_SPEED), radius, speed.isPresent())));
	private static final Codec<VoiceDirectorSavedData> CODEC = Codec.unboundedMap(Codec.STRING, PROFILE_CODEC)
			.optionalFieldOf("profiles", Map.of()).codec()
			.xmap(VoiceDirectorSavedData::new, data -> Map.copyOf(data.profiles));
	public static final SavedDataType<VoiceDirectorSavedData> TYPE = new SavedDataType<>(
			Identifier.fromNamespaceAndPath("mineagen", "voice_director"),
			VoiceDirectorSavedData::new, CODEC, DataFixTypes.SAVED_DATA_COMMAND_STORAGE);
	private static final int MAX_PROFILES = 256;
	private final Map<String, VoiceProfile> profiles;

	public VoiceDirectorSavedData() {
		this(Map.of());
	}

	private VoiceDirectorSavedData(Map<String, VoiceProfile> profiles) {
		if (profiles.size() > MAX_PROFILES) throw new IllegalArgumentException("Too many persisted voice profiles");
		this.profiles = new LinkedHashMap<>(Objects.requireNonNull(profiles, "profiles must not be null"));
	}

	public static VoiceDirectorSavedData get(MinecraftServer server) {
		return Objects.requireNonNull(server, "server must not be null").overworld().getDataStorage().computeIfAbsent(TYPE);
	}

	public VoiceProfile profile(AgentId agentId) {
		return profiles.getOrDefault(agentId.toString(), VoiceProfile.defaults());
	}

	public VoiceRequest request(AgentId agentId, String text, long sequence) {
		VoiceProfile settings = profiles.get(agentId.toString());
		if (settings == null) return new VoiceRequest(agentId, text, VoiceProfile.DEFAULT_PROFILE_ID,
				VoiceProfile.DEFAULT_RADIUS, sequence);
		return new VoiceRequest(agentId, text, settings.profileId(), settings.radius(), sequence,
				settings.speed(), settings.tone(), settings.explicitSpeed());
	}

	public Map<String, VoiceProfile> profiles() { return Map.copyOf(profiles); }

	public void removeProfile(AgentId agentId) {
		if (profiles.remove(agentId.toString()) != null) setDirty();
	}

	public void putProfile(AgentId agentId, VoiceProfile profile) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		Objects.requireNonNull(profile, "profile must not be null");
		if (!profiles.containsKey(agentId.toString()) && profiles.size() >= MAX_PROFILES) throw new IllegalArgumentException("Too many voice profiles");
		profiles.put(agentId.toString(), profile);
		setDirty();
	}

}
