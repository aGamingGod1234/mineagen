package dev.agaminggod.mineagen.server.voice;

import com.google.gson.JsonParser;
import com.mojang.serialization.JsonOps;
import dev.agaminggod.mineagen.agent.AgentId;

/** Saved settings remain readable when retired dialogue scripts are dropped. */
public final class VoiceDirectorVerification {
	private VoiceDirectorVerification() {
	}

	public static int verify() {
		AgentId id = AgentId.random();
		VoiceProfile profile = new VoiceProfile("voice.ethan.v1", "dramatic", 1.25D, 64);
		var data = new VoiceDirectorSavedData();
		data.putProfile(id, profile);
		var codec = VoiceDirectorSavedData.TYPE.codec();
		var old = codec.encodeStart(JsonOps.INSTANCE, data).getOrThrow().getAsJsonObject();
		old.add("scripts", JsonParser.parseString("[{\"name\":\"intro\",\"agent\":\"removed actor\",\"cues\":[{\"delay_ticks\":0,\"text\":\"Hello\"}]}]"));
		var restored = codec.parse(JsonOps.INSTANCE, old).getOrThrow();
		check(profile.equals(restored.profile(id)), "old worlds retain the exact voice id and delivery settings");
		check(!codec.encodeStart(JsonOps.INSTANCE, restored).getOrThrow().getAsJsonObject().has("scripts"),
				"new saves omit retired speech scripts");
		check(VoiceProfile.defaults().equals(restored.profile(AgentId.random())), "unconfigured agents retain automatic voice");
		// Hand-written records in the pre-fix format, which omitted speed whenever it was 1.0.
		var omitted = codec.parse(JsonOps.INSTANCE, JsonParser.parseString("{\"profiles\":{\"" + id
				+ "\":{\"profile\":\"voice.auto.v1\",\"tone\":\"warm\",\"radius\":32}}}")).getOrThrow().request(id, "Hello", 1L);
		check(!omitted.explicitSpeed() && omitted.profileId().equals("voice.auto.v1") && omitted.tone().equals("warm")
				&& omitted.radius() == 32, "old saves without a speed keep automatic pacing, tone and radius");
		var paced = codec.parse(JsonOps.INSTANCE, JsonParser.parseString("{\"profiles\":{\"" + id
				+ "\":{\"profile\":\"voice.ethan.v1\",\"tone\":\"dramatic\",\"speed\":1.25,\"radius\":64}}}")).getOrThrow().request(id, "Hello", 2L);
		check(paced.explicitSpeed() && paced.speed() == 1.25D && paced.tone().equals("dramatic") && paced.radius() == 64,
				"old saves keep a nondefault speed as an explicit override");
		for (String saved : java.util.List.of("voice.ethan.v1", "voice.moss.v1", "voice.flint.v1", "voice.piper.v1")) {
			check(VoiceCatalog.accepts(saved), "saved voice id remains usable: " + saved);
		}
		check(!VoiceCatalog.selectableIds().contains("voice.moss.v1"), "legacy aliases load without being offered as new choices");
		try {
			new VoiceProfile("voice", "neutral", 2.1D, 48);
			throw new AssertionError("profile speed is bounded");
		} catch (IllegalArgumentException expected) { }
		return 11;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
