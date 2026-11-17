package dev.agaminggod.mineagen.server.voice;

import dev.agaminggod.mineagen.agent.AgentDomainException;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.server.CodexAgentManager;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/** World-persisted voice settings and immediate speech for ordinary agents. */
public final class VoiceDirector {
	private VoiceDirector() {
	}

	public static VoiceProfile profile(MinecraftServer server, AgentId agentId) {
		return VoiceDirectorSavedData.get(server).profile(agentId);
	}

	public static VoiceProfile setProfile(MinecraftServer server, AgentId agentId, VoiceProfile profile) {
		VoiceDirectorSavedData.get(server).putProfile(agentId, profile);
		return profile;
	}

	/** Speaks with the agent's saved settings; automatic profiles are resolved by the voice worker. */
	public static void say(MinecraftServer server, AgentId agentId, String text) {
		speak(server, agentId, text, profile(server, agentId));
	}

	/** Previews exactly the selected settings without changing saved settings. */
	public static void say(MinecraftServer server, AgentId agentId, String text, VoiceProfile settings) {
		if (!VoiceCatalog.accepts(settings.profileId())) throw new AgentDomainException(
				"VOICE_PROFILE_UNKNOWN", "Unknown voice profile. Use /codex voice profiles");
		speak(server, agentId, text, settings);
	}

	public static void requireAvailable(MinecraftServer server) {
		if (!VoiceSubsystemRuntime.available(server)) throw new AgentDomainException("VOICE_UNAVAILABLE",
				"Voice is unavailable. Install the voice add-on and Simple Voice Chat, then check the voice provider");
	}

	private static void speak(MinecraftServer server, AgentId agentId, String text, VoiceProfile settings) {
		requireAvailable(server);
		if (CodexAgentManager.get(server).findAgentPlayer(agentId).filter(ServerPlayer::isAlive).isEmpty()) {
			throw new AgentDomainException("AGENT_NOT_PRESENT", "Respawn the agent before speaking");
		}
		var request = new VoiceRequest(agentId, text.strip(), settings.profileId(), settings.radius(),
				VoiceSubsystemRuntime.nextConversationSequence(server, agentId), settings.speed(), settings.tone(),
				settings.explicitSpeed());
		VoiceSubsystemRuntime.stopSpeaking(server, agentId);
		VoiceSubsystemRuntime.speak(server, request);
	}
}
