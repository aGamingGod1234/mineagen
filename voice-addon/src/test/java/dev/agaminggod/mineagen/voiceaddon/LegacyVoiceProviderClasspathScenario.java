package dev.agaminggod.mineagen.voiceaddon;

import de.maxhenkel.voicechat.api.VoicechatServerApi;
import de.maxhenkel.voicechat.api.events.Event;
import de.maxhenkel.voicechat.api.events.EventRegistration;
import de.maxhenkel.voicechat.api.events.VoicechatServerStartedEvent;
import dev.agaminggod.mineagen.server.voice.VoiceSubsystem;
import dev.agaminggod.mineagen.server.voice.VoiceSubsystemProvider;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.server.voice.VoiceReceipt;
import dev.agaminggod.mineagen.server.voice.VoiceRequest;
import java.lang.reflect.InvocationHandler;
import java.lang.reflect.Proxy;
import java.net.URI;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.Map;
import java.util.UUID;
import java.util.concurrent.ConcurrentHashMap;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.atomic.AtomicBoolean;
import java.util.function.Consumer;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedServer;

/** Executes inside the isolated legacy-core classloader. */
public final class LegacyVoiceProviderClasspathScenario {
	private LegacyVoiceProviderClasspathScenario() {
	}

	public static int verify() throws Exception {
		if (VoiceSubsystemProvider.class.getDeclaredMethods().length != 1) {
			throw new AssertionError("Legacy core provider fixture must expose only create(server)");
		}
		Path secretFile = Files.createTempFile("mineagen-legacy-provider", ".secret");
		Files.writeString(secretFile, "legacy-provider-secret-0123456789\n", StandardCharsets.UTF_8);
		String previousUrl = System.getProperty("mineagen.voiceUrl");
		String previousSttUrl = System.getProperty("mineagen.sttUrl");
		String previousSecretFile = System.getProperty("mineagen.voiceSecretFile");
		String previousTimeout = System.getProperty("mineagen.voiceRequestTimeoutMs");
		try {
			System.setProperty("mineagen.voiceUrl", "http://127.0.0.1:18765/v1/tts");
			System.setProperty("mineagen.sttUrl", "http://127.0.0.1:18765/v1/stt");
			System.setProperty("mineagen.voiceSecretFile", secretFile.toString());
			System.setProperty("mineagen.voiceRequestTimeoutMs", "12345");
			RecordingEventRegistration events = new RecordingEventRegistration();
			MineagenVoiceProvider provider = new MineagenVoiceProvider();
			provider.registerEvents(events);
			events.fire(VoicechatServerStartedEvent.class, startedEvent());

			VoiceSubsystemProvider legacyProvider = provider;
			VoiceSubsystem subsystem = legacyProvider.create(testServer());
			if (subsystem == null) throw new AssertionError("Legacy provider returned null");
			if (!subsystem.available()) throw new AssertionError("Legacy voice-chat registration was not retained");
			subsystem.close();

			verifyLegacySttEndpointValidation();
			verifyLegacyConsentCapture(testServer());
			verifyLegacyPlaybackCancellation();
			return 7;
		} finally {
			restoreProperty("mineagen.voiceUrl", previousUrl);
			restoreProperty("mineagen.sttUrl", previousSttUrl);
			restoreProperty("mineagen.voiceSecretFile", previousSecretFile);
			restoreProperty("mineagen.voiceRequestTimeoutMs", previousTimeout);
			Files.deleteIfExists(secretFile);
		}
	}

	private static void verifyLegacySttEndpointValidation() {
		System.setProperty("mineagen.sttUrl", "https://example.com:443/v1/stt");
		try {
			MineagenVoiceProvider.legacySpeechEndpoint(URI.create("http://127.0.0.1:18765/v1/tts"));
			throw new AssertionError("Legacy STT endpoint accepted a non-loopback host");
		} catch (IllegalArgumentException expected) {
			// The legacy override must follow the same endpoint boundary as TTS.
		} finally {
			System.setProperty("mineagen.sttUrl", "http://127.0.0.1:18765/v1/stt");
		}
	}

	private static void verifyLegacyConsentCapture(MinecraftServer server) {
		AtomicBoolean captured = new AtomicBoolean();
		if (!HumanSpeechCapture.captureWhileGranted(server, UUID.randomUUID(), () -> captured.set(true))) {
			throw new AssertionError("Granted legacy speech capture was rejected");
		}
		if (!captured.get()) throw new AssertionError("Granted legacy speech was not captured");
	}

	private static void verifyLegacyPlaybackCancellation() {
		AgentId agentId = AgentId.parse("00000000-0000-4000-8000-000000000099");
		CompletableFuture<short[]> synthesis = new CompletableFuture<>();
		VoicePlaybackCoordinator coordinator = new VoicePlaybackCoordinator(
				request -> synthesis,
				Runnable::run,
				new VoicePlaybackCoordinator.Transport() {
					@Override public boolean available() { return true; }

					@Override
					public VoicePlaybackCoordinator.Playback create(
							AgentId ignoredAgent,
							UUID ignoredEntity,
							int ignoredRadius,
							short[] ignoredSamples,
							Runnable ignoredStopped,
							Runnable ignoredFailed
					) {
						throw new AssertionError("Pending synthesis must not reach playback");
					}
				}
		);
		coordinator.registerAgent(agentId, UUID.randomUUID());
		CompletableFuture<VoiceReceipt> receipt = coordinator.speak(new VoiceRequest(
				agentId, "Legacy cancellation", "voice.auto.v1", 48, 1L
		)).toCompletableFuture();
		coordinator.stop(agentId);
		if (receipt.join().status() != VoiceReceipt.Status.DEGRADED_TO_TEXT) {
			throw new AssertionError("Legacy cancellation did not settle with an old-core receipt");
		}
		coordinator.close();
	}

	private static MinecraftServer testServer() throws Exception {
		Class<?> unsafeType = Class.forName("sun.misc.Unsafe");
		var field = unsafeType.getDeclaredField("theUnsafe");
		field.setAccessible(true);
		Object unsafe = field.get(null);
		return (MinecraftServer) unsafeType.getMethod("allocateInstance", Class.class)
				.invoke(unsafe, DedicatedServer.class);
	}

	private static VoicechatServerStartedEvent startedEvent() {
		VoicechatServerApi api = proxy(VoicechatServerApi.class, (proxy, method, arguments) ->
				defaultValue(method.getReturnType()));
		return proxy(VoicechatServerStartedEvent.class, (proxy, method, arguments) ->
				method.getName().equals("getVoicechat") ? api : defaultValue(method.getReturnType()));
	}

	private static <T> T proxy(Class<T> type, InvocationHandler handler) {
		return type.cast(Proxy.newProxyInstance(type.getClassLoader(), new Class<?>[] { type }, handler));
	}

	private static Object defaultValue(Class<?> type) {
		if (!type.isPrimitive()) return null;
		if (type == boolean.class) return false;
		if (type == char.class) return '\0';
		return 0;
	}

	private static void restoreProperty(String key, String value) {
		if (value == null) System.clearProperty(key);
		else System.setProperty(key, value);
	}

	private static final class RecordingEventRegistration implements EventRegistration {
		private final Map<Class<?>, Consumer<?>> handlers = new ConcurrentHashMap<>();

		@Override
		public <T extends Event> void registerEvent(Class<T> eventType, Consumer<T> handler, int priority) {
			handlers.put(eventType, handler);
		}

		private <T extends Event> void fire(Class<T> eventType, T event) {
			@SuppressWarnings("unchecked")
			Consumer<T> handler = (Consumer<T>) handlers.get(eventType);
			if (handler == null) throw new AssertionError("No handler registered for " + eventType.getSimpleName());
			handler.accept(event);
		}
	}
}
