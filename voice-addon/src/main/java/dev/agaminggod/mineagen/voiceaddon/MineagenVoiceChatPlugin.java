package dev.agaminggod.mineagen.voiceaddon;

import de.maxhenkel.voicechat.api.VoicechatPlugin;
import de.maxhenkel.voicechat.api.VoicechatServerApi;
import de.maxhenkel.voicechat.api.events.EventRegistration;
import de.maxhenkel.voicechat.api.events.MicrophonePacketEvent;
import de.maxhenkel.voicechat.api.events.VoiceDistanceEvent;
import de.maxhenkel.voicechat.api.events.VoicechatServerStartedEvent;
import de.maxhenkel.voicechat.api.events.VoicechatServerStoppedEvent;
import dev.agaminggod.mineagen.server.voice.VoiceSubsystemConfiguration;
import dev.agaminggod.mineagen.server.voice.VoiceSubsystemRuntime;
import java.util.Objects;
import java.util.UUID;
import java.util.function.Function;
import net.minecraft.server.MinecraftServer;

public final class MineagenVoiceChatPlugin implements VoicechatPlugin {
	private static final org.slf4j.Logger LOGGER = org.slf4j.LoggerFactory.getLogger(MineagenVoiceChatPlugin.class);
	private static final VoicechatServerBindings<Object, VoicechatServerApi> PRODUCTION_BINDINGS =
			new VoicechatServerBindings<>(configuration ->
					new HumanSpeechCapture(new SpeechWorkerClient(configuration)));
	private static volatile MineagenVoiceChatPlugin activePlugin;

	private final VoicechatServerBindings<Object, VoicechatServerApi> bindings;
	private final Function<MicrophonePacketEvent, Object> packetServer;

	public MineagenVoiceChatPlugin() {
		this(PRODUCTION_BINDINGS, null);
	}

	MineagenVoiceChatPlugin(
			ServerSpeechCaptureRegistry.CaptureFactory captureFactory,
			Function<MicrophonePacketEvent, Object> packetServer
	) {
		this(new VoicechatServerBindings<>(captureFactory), packetServer);
	}

	private MineagenVoiceChatPlugin(
			VoicechatServerBindings<Object, VoicechatServerApi> bindings,
			Function<MicrophonePacketEvent, Object> packetServer
	) {
		this.bindings = Objects.requireNonNull(bindings, "server bindings must not be null");
		this.packetServer = packetServer;
	}

	@Override
	public String getPluginId() {
		return "mineagen_voice";
	}

	@Override
	public void registerEvents(EventRegistration registration) {
		activePlugin = this;
		registration.registerEvent(VoicechatServerStartedEvent.class,
				event -> bindings.started(event.getVoicechat()));
		registration.registerEvent(MicrophonePacketEvent.class, this::onMicrophonePacket);
		registration.registerEvent(VoiceDistanceEvent.class, SyntheticPlayerVoiceTransport::applyPlaybackDistance);
		registration.registerEvent(VoicechatServerStoppedEvent.class,
				event -> bindings.stopped(event.getVoicechat()));
	}

	private void onMicrophonePacket(MicrophonePacketEvent event) {
		try {
			if (packetServer != null) {
				Object server = packetServer.apply(event);
				if (server != null) bindings.accept(server, event.getVoicechat(), new MicrophonePacketSnapshot(
						server, new UUID(0L, 0L), event.getVoicechat(), false, new byte[0]
				));
				return;
			}
			MicrophonePacketSnapshot captured = MicrophonePacketSnapshot.capture(event);
			if (captured == null) return;
			Object configured = bindings.configuredServer(captured.voicechat());
			if (!(configured instanceof MinecraftServer server)) return;
			MicrophonePacketSnapshot packet = captured.forServer(server);
			server.execute(() -> acceptOnServer(server, packet));
		} catch (RuntimeException exception) {
			LOGGER.error("Mineagen proximity speech capture could not start", exception);
		}
	}

	private void acceptOnServer(MinecraftServer server, MicrophonePacketSnapshot packet) {
		try {
			if (VoiceSubsystemRuntime.isAgentPlayer(server, packet.playerId())) return;
			bindings.accept(server, packet.voicechat(), packet);
		} catch (RuntimeException exception) {
			LOGGER.error("Mineagen proximity speech capture could not start", exception);
		}
	}

	ConfiguredServer configureServer(Object server, VoiceSubsystemConfiguration configuration) {
		return new ConfiguredServer(bindings.configure(server, configuration));
	}

	static ConfiguredServer configure(MinecraftServer server, VoiceSubsystemConfiguration configuration) {
		MineagenVoiceChatPlugin plugin = activePlugin;
		if (plugin == null) throw new IllegalStateException("Simple Voice Chat plugin has not registered its events");
		return plugin.configureServer(server, configuration);
	}

	static final class ConfiguredServer implements AutoCloseable {
		private final VoicechatServerBindings.Binding<VoicechatServerApi> binding;

		private ConfiguredServer(VoicechatServerBindings.Binding<VoicechatServerApi> binding) {
			this.binding = binding;
		}

		VoicechatServerApi voicechat() {
			return binding.owner();
		}

		boolean active() {
			return binding.active();
		}

		void cancelHumanSpeech(java.util.UUID playerId) {
			binding.cancelHumanSpeech(playerId);
		}

		@Override
		public void close() {
			binding.close();
		}
	}
}
