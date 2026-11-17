package dev.agaminggod.mineagen.server.voice;

import dev.agaminggod.mineagen.agent.AgentId;
import java.util.UUID;
import java.util.concurrent.CompletionStage;

public interface VoiceSubsystem extends AutoCloseable {
	boolean available();

	default boolean canReceive(UUID playerId) { return false; }

	void registerAgent(AgentId agentId, UUID entityId);

	default void refreshAgent(AgentId agentId, UUID entityId) {
	}

	void unregisterAgent(AgentId agentId);

	CompletionStage<VoiceReceipt> speak(VoiceRequest request);

	void stop(AgentId agentId);

	default void cancelHumanSpeech(UUID playerId) {
	}

	@Override
	void close();
}
