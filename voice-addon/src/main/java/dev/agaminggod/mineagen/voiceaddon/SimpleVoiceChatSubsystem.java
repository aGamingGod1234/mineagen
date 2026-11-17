package dev.agaminggod.mineagen.voiceaddon;

import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.server.voice.VoiceReceipt;
import dev.agaminggod.mineagen.server.voice.VoiceRequest;
import dev.agaminggod.mineagen.server.voice.VoiceSubsystem;
import java.util.Objects;
import java.util.UUID;
import java.util.concurrent.CompletionStage;
import net.minecraft.server.MinecraftServer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

final class SimpleVoiceChatSubsystem implements VoiceSubsystem {
	private static final Logger LOGGER = LoggerFactory.getLogger(SimpleVoiceChatSubsystem.class);
	private final MinecraftServer server;
	private final MineagenVoiceChatPlugin.ConfiguredServer configuredServer;
	private final SyntheticPlayerVoiceTransport transport;
	private final VoicePlaybackCoordinator playback;

	SimpleVoiceChatSubsystem(
			MinecraftServer server,
			VoiceWorkerClient worker,
			MineagenVoiceChatPlugin.ConfiguredServer configuredServer
	) {
		this.server = Objects.requireNonNull(server, "server must not be null");
		Objects.requireNonNull(worker, "worker must not be null");
		this.configuredServer = Objects.requireNonNull(configuredServer, "configured server must not be null");
		this.transport = new SyntheticPlayerVoiceTransport(() ->
				this.configuredServer.active() ? this.configuredServer.voicechat() : null,
				(entityId, radius) -> {
					var speaker = server.getPlayerList().getPlayer(entityId);
					return speaker != null && server.getPlayerList().getPlayers().stream().anyMatch(player ->
							player != speaker && player.level() == speaker.level()
							&& speaker.distanceToSqr(player) <= (double) radius * radius && canReceive(player.getUUID()));
				}
		);
		this.playback = new VoicePlaybackCoordinator(
				worker::synthesize,
				server::execute,
				transport,
				latency -> LOGGER.info(
						"Voice output latency agent={} sequence={} synthesisMs={} firstPlaybackMs={}",
						latency.agentId(), latency.conversationSequence(), latency.synthesisMilliseconds(),
						latency.firstPlaybackMilliseconds()
				)
		);
	}

	@Override
	public boolean available() {
		return playback.available();
	}

	@Override
	public boolean canReceive(UUID playerId) {
		if (!configuredServer.active()) return false;
		var connection = configuredServer.voicechat().getConnectionOf(playerId);
		return SyntheticPlayerVoiceTransport.canReceive(connection);
	}

	@Override
	public void registerAgent(AgentId agentId, UUID entityId) {
		playback.registerAgent(agentId, entityId);
		transport.registerAgent(agentId, entityId);
	}

	@Override
	public void refreshAgent(AgentId agentId, UUID entityId) {
		transport.registerAgent(agentId, entityId);
	}

	@Override
	public void unregisterAgent(AgentId agentId) {
		playback.unregisterAgent(agentId);
		transport.unregisterAgent(agentId);
	}

	@Override
	public CompletionStage<VoiceReceipt> speak(VoiceRequest request) {
		return playback.speak(request);
	}

	@Override
	public void stop(AgentId agentId) {
		playback.stop(agentId);
	}

	@Override
	public void cancelHumanSpeech(UUID playerId) {
		configuredServer.cancelHumanSpeech(playerId);
	}

	@Override
	public void close() {
		try {
			playback.close();
		} finally {
			try {
				transport.close();
			} finally {
				configuredServer.close();
			}
		}
	}
}
