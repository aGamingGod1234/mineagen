package dev.agaminggod.mineagen.server.voice;

import carpet.patches.EntityPlayerMPFake;
import com.google.gson.JsonObject;
import com.mojang.authlib.GameProfile;
import dev.agaminggod.mineagen.agent.AgentGameMode;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.protocol.ActionType;
import dev.agaminggod.mineagen.server.AgentSavedData;
import dev.agaminggod.mineagen.server.CodexAgentManager;
import dev.agaminggod.mineagen.server.OfflineAgentPlayers;
import dev.agaminggod.mineagen.server.runtime.ActionProvenance;
import dev.agaminggod.mineagen.server.runtime.ServerActionExecutor;
import dev.agaminggod.mineagen.server.runtime.ServerActionRequest;
import dev.agaminggod.mineagen.server.runtime.ServerActionResult;
import dev.agaminggod.mineagen.server.runtime.ServerActionState;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedPlayerList;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.ChatVisiblity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

/**
 * Actual chat action: a whole-line voice fallback still sends the nearby text to nearby agent bodies, which is the
 * input {@code PovMessageRelay} forwards to a takeover operator. Success and cancellation keep bodies silent.
 */
final class VoiceRelayFallbackVerification {
	private static final String MESSAGE = "Watch the ravine.";

	private VoiceRelayFallbackVerification() { }

	static void verify() {
		for (String outcome : List.of("degraded", "accepted", "cancelled")) verify(outcome);
	}

	private static void verify(String outcome) {
		try {
			Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); unsafeField.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) unsafeField.get(null);
			var server = (MinecraftServer) unsafe.allocateInstance(DedicatedServer.class);
			// Lets server.execute run the fallback inline on the thread that completes the receipt.
			set(unsafe, server, MinecraftServer.class, "serverThread", Thread.currentThread());
			var manager = (CodexAgentManager) unsafe.allocateInstance(CodexAgentManager.class);
			set(unsafe, manager, CodexAgentManager.class, "server", server);
			set(unsafe, manager, CodexAgentManager.class, "savedData", new AgentSavedData());
			var agent = manager.registry().create("codex", "gpt-5.6-sol", "high", Optional.of("RelaySpeaker"),
					AgentGameMode.SURVIVAL, 1000L);
			var watched = manager.registry().create("codex", "gpt-5.6-sol", "high", Optional.of("RelayWatched"),
					AgentGameMode.SURVIVAL, 1000L);
			var level = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
			set(unsafe, level, Level.class, "dimension", Level.OVERWORLD);
			var speaker = (EntityPlayerMPFake) unsafe.allocateInstance(EntityPlayerMPFake.class);
			speaker.setId(1033);
			UUID identity = OfflineAgentPlayers.offlineUuid(agent.agentId(), agent.profile());
			set(unsafe, speaker, Entity.class, "uuid", identity);
			set(unsafe, speaker, Player.class, "gameProfile", new GameProfile(identity,
					OfflineAgentPlayers.playerName(agent.agentId(), agent.profile())));
			set(unsafe, speaker, Entity.class, "level", level);
			set(unsafe, speaker, Entity.class, "position", Vec3.ZERO);
			// The unconstructed fake has no connection; hidden chat makes its own system-message send a no-op.
			set(unsafe, speaker, ServerPlayer.class, "chatVisibility", ChatVisiblity.HIDDEN);
			RecordingPlayer body = player(unsafe, level, "RelayWatchedBody", new Vec3(10, 0, 0));
			manager.registry().attachEntity(watched.agentId(), body.getUUID(), 1001L);
			RecordingPlayer voiceHuman = player(unsafe, level, "VoiceListener", new Vec3(5, 0, 0));
			RecordingPlayer textHuman = player(unsafe, level, "TextListener", new Vec3(3, 0, 0));
			RecordingPlayer farBody = player(unsafe, level, "FarBody", new Vec3(49, 0, 0));
			var farAgent = manager.registry().create("codex", "gpt-5.6-sol", "high", Optional.of("RelayFar"),
					AgentGameMode.SURVIVAL, 1000L);
			manager.registry().attachEntity(farAgent.agentId(), farBody.getUUID(), 1001L);
			var players = (FixturePlayers) unsafe.allocateInstance(FixturePlayers.class);
			players.speaker = speaker;
			players.others = List.of(body, voiceHuman, textHuman, farBody);
			set(unsafe, server, MinecraftServer.class, "playerList", players);
			var voice = new PendingVoice(Set.of(voiceHuman.getUUID()));
			VoiceSubsystemProvider provider = new VoiceSubsystemProvider() {
				@Override public VoiceSubsystem create(MinecraftServer actual) { throw new AssertionError("configured startup required"); }
				@Override public VoiceSubsystem create(MinecraftServer actual, VoiceSubsystemConfiguration configured) { return voice; }
			};
			List<ServerActionResult> results = new CopyOnWriteArrayList<>();
			try (var storage = new net.minecraft.world.level.storage.SavedDataStorage(
					java.nio.file.Files.createTempDirectory("arena-voice-relay-"), null,
					net.minecraft.core.RegistryAccess.EMPTY)) {
				level.storage = storage;
				set(unsafe, server, MinecraftServer.class, "levels", java.util.Map.of(Level.OVERWORLD, level));
				check(VoiceSubsystemRuntime.start(server, new VoiceSubsystemConfiguration(
						"http://127.0.0.1:18775/v1/tts", "a".repeat(32)), List.of(provider)), "relay fixture voice starts");
				var executor = new ServerActionExecutor(manager, results::add);
				JsonObject arguments = new JsonObject();
				arguments.addProperty("audience", "proximity"); arguments.addProperty("message", MESSAGE);
				var provenance = new ActionProvenance("codex", "gpt-5.6-sol", "high", "priority", "relay-voice-program",
						1L, "relay-voice-step", 1L, "relay-voice-trace");
				executor.submitConcurrentChat(new ServerActionRequest(agent.agentId(), agent.goalRevision(),
						"relay-voice-action", ActionType.CHAT, arguments, provenance, "relay-voice-trace"));
				check(results.size() == 1 && results.getFirst().state() == ServerActionState.SUCCEEDED,
						"relay chat action completes: " + outcome);
				check(voice.request != null, "a voice-capable human admits one TTS request: " + outcome);
				String line = "[Nearby] <" + manager.displayName(manager.registry().require(agent.agentId())) + "> " + MESSAGE;
				check(textHuman.messages().equals(List.of(line)), "text-only human gets the line immediately: " + outcome);
				check(body.messages().isEmpty() && voiceHuman.messages().isEmpty(),
						"bodies and voice listeners wait for the speech outcome: " + outcome);
				voice.playback.complete(switch (outcome) {
					case "degraded" -> VoiceReceipt.degraded("fake provider failure");
					case "cancelled" -> VoiceReceipt.cancelled();
					default -> VoiceReceipt.accepted();
				});
				boolean fallback = outcome.equals("degraded");
				check(voiceHuman.messages().equals(fallback ? List.of(line) : List.of()),
						"voice listener gets fallback text exactly when speech fell back: " + outcome);
				check(textHuman.messages().equals(List.of(line)), "text-only human is never sent the line twice: " + outcome);
				check(body.messages().equals(fallback ? List.of(line) : List.of()),
						"nearby agent body gets the relay text exactly when speech fell back: " + outcome);
				check(farBody.messages().isEmpty(), "agent body beyond the voice radius stays silent: " + outcome);
			} finally {
				voice.playback.complete(VoiceReceipt.accepted());
				VoiceSubsystemRuntime.close(server);
			}
		} catch (Exception problem) { throw new AssertionError("relay fallback fixture failed: " + outcome, problem); }
	}

	private static RecordingPlayer player(sun.misc.Unsafe unsafe, FixtureLevel level, String name, Vec3 position)
			throws ReflectiveOperationException {
		var player = (RecordingPlayer) unsafe.allocateInstance(RecordingPlayer.class);
		UUID id = UUID.randomUUID();
		set(unsafe, player, Entity.class, "uuid", id);
		set(unsafe, player, Entity.class, "level", level);
		set(unsafe, player, Entity.class, "position", position);
		set(unsafe, player, Player.class, "gameProfile", new GameProfile(id, name));
		return player;
	}

	private static void set(sun.misc.Unsafe unsafe, Object target, Class<?> owner, String field, Object value)
			throws ReflectiveOperationException {
		unsafe.putObject(target, unsafe.objectFieldOffset(owner.getDeclaredField(field)), value);
	}
	private static void check(boolean passed, String label) { if (!passed) throw new AssertionError(label); }

	private static final class FixturePlayers extends DedicatedPlayerList {
		ServerPlayer speaker;
		List<ServerPlayer> others;
		private FixturePlayers() { super(null, null, null); }
		@Override public ServerPlayer getPlayer(UUID identity) {
			if (speaker.getUUID().equals(identity)) return speaker;
			return others.stream().filter(player -> player.getUUID().equals(identity)).findFirst().orElse(null);
		}
		@Override public ServerPlayer getPlayerByName(String name) { return speaker.getGameProfile().name().equals(name) ? speaker : null; }
		@Override public List<ServerPlayer> getPlayers() { return others; }
	}
	private static final class FixtureLevel extends dev.agaminggod.mineagen.compat.TestServerLevelBase {
		net.minecraft.world.level.storage.SavedDataStorage storage;
		private FixtureLevel() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
		@Override public net.minecraft.world.level.storage.SavedDataStorage getDataStorage() { return storage; }
	}

	private static final class RecordingPlayer extends ServerPlayer {
		private List<String> received;
		private RecordingPlayer() { super(null, null, null, null); }
		List<String> messages() { return received == null ? List.of() : received; }
		@Override public void sendSystemMessage(Component message) { sendSystemMessage(message, false); }
		@Override public void sendSystemMessage(Component message, boolean overlay) {
			if (received == null) received = new ArrayList<>();
			received.add(message.getString());
		}
		@Override public net.minecraft.commands.CommandSourceStack createCommandSourceStack() {
			return dev.agaminggod.mineagen.compat.TestCompat.commandSource(
					net.minecraft.commands.CommandSource.NULL, Vec3.ZERO,
					net.minecraft.world.phys.Vec2.ZERO, (ServerLevel) level(),
					net.minecraft.server.permissions.PermissionSet.NO_PERMISSIONS,
					Component.literal(getGameProfile().name()));
		}
	}

	private static final class PendingVoice implements VoiceSubsystem {
		final CompletableFuture<VoiceReceipt> playback = new CompletableFuture<>();
		final Set<UUID> capable;
		VoiceRequest request;
		PendingVoice(Set<UUID> capable) { this.capable = capable; }
		@Override public boolean canReceive(UUID playerId) { return capable.contains(playerId); }
		@Override public boolean available() { return true; }
		@Override public void registerAgent(AgentId agent, UUID entity) { }
		@Override public void unregisterAgent(AgentId agent) { }
		@Override public CompletionStage<VoiceReceipt> speak(VoiceRequest spoken) { request = spoken; return playback; }
		@Override public void stop(AgentId agent) { }
		@Override public void close() { }
	}
}
