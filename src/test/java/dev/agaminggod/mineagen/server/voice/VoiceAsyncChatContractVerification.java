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
import java.util.List;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.CopyOnWriteArrayList;
import java.util.concurrent.CountDownLatch;
import java.util.concurrent.TimeUnit;
import java.util.concurrent.atomic.AtomicReference;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedPlayerList;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;

/** Actual chat admission and result publication while the voice provider retains a pending playback receipt. */
public final class VoiceAsyncChatContractVerification {
	private static int assertions;
	private static VoiceProfile requestedProfile;
	private static VoiceRequest captured;

	public static VoiceRequest captureOrdinaryReply(VoiceProfile profile) {
		requestedProfile = profile;
		try { verifyAudience(true); return captured; }
		finally { requestedProfile = null; }
	}
	private VoiceAsyncChatContractVerification() { }

	public static void main(String[] args) {
		dev.agaminggod.mineagen.control.TestCatalog.install();
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		verify();
	}

	public static int verify() {
		assertions = 0;
		VoiceAudienceDeliveryVerification.verify();
		verifyAudience(false);
		verifyAudience(true);
		captureOrdinaryReply(new VoiceProfile("voice.ethan.v1", "dramatic", 1.25, 64));
		captureOrdinaryReply(VoiceProfile.inheritingSpeed("voice.auto.v1", "warm", 32));
		return assertions;
	}

	private static int verifyAudience(boolean hasHuman) {
		try {
			Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); unsafeField.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) unsafeField.get(null);
			var server = (MinecraftServer) unsafe.allocateInstance(DedicatedServer.class);
			var manager = (CodexAgentManager) unsafe.allocateInstance(CodexAgentManager.class);
			set(unsafe, manager, CodexAgentManager.class, "server", server);
			set(unsafe, manager, CodexAgentManager.class, "savedData", new AgentSavedData());
			var agent = manager.registry().create("codex", "gpt-5.6-sol", "high", Optional.of("AsyncVoice"),
					AgentGameMode.SURVIVAL, 1000L);
			var player = (EntityPlayerMPFake) unsafe.allocateInstance(EntityPlayerMPFake.class);
			player.setId(1032); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
			UUID identity = OfflineAgentPlayers.offlineUuid(agent.agentId(), agent.profile());
			set(unsafe, player, Entity.class, "uuid", identity);
			set(unsafe, player, Player.class, "gameProfile", new GameProfile(identity,
					OfflineAgentPlayers.playerName(agent.agentId(), agent.profile())));
			var level = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
			set(unsafe, level, Level.class, "dimension", Level.OVERWORLD);
			set(unsafe, player, Entity.class, "level", level);
			var players = (FixturePlayers) unsafe.allocateInstance(FixturePlayers.class);
			players.speaker = player;
			players.humans = List.of();
			set(unsafe, player, Entity.class, "position", net.minecraft.world.phys.Vec3.ZERO);
			if (hasHuman) {
				var human = (FixtureHuman) unsafe.allocateInstance(FixtureHuman.class);
				set(unsafe, human, Entity.class, "uuid", UUID.randomUUID());
				set(unsafe, human, Entity.class, "level", level);
				set(unsafe, human, Entity.class, "position", net.minecraft.world.phys.Vec3.ZERO);
				set(unsafe, human, Player.class, "gameProfile", new GameProfile(human.getUUID(), "Listener"));
				players.humans = List.of(human);
			}
			set(unsafe, server, MinecraftServer.class, "playerList", players);
			var configuration = new VoiceSubsystemConfiguration("http://127.0.0.1:18775/v1/tts", "a".repeat(32));
			var voice = new PendingVoice();
			AtomicReference<VoiceSubsystemConfiguration> receivedConfiguration = new AtomicReference<>();
			AtomicReference<MinecraftServer> receivedServer = new AtomicReference<>();
			VoiceSubsystemProvider provider = new VoiceSubsystemProvider() {
				@Override public VoiceSubsystem create(MinecraftServer actual) { throw new AssertionError("configured startup required"); }
				@Override public VoiceSubsystem create(MinecraftServer actual, VoiceSubsystemConfiguration configured) {
					receivedServer.set(actual); receivedConfiguration.set(configured); return voice;
				}
			};
			CountDownLatch returned = new CountDownLatch(1);
			AtomicReference<Throwable> failure = new AtomicReference<>();
			List<ServerActionResult> results = new CopyOnWriteArrayList<>();
			Thread chat = null;
			try (var storage = new net.minecraft.world.level.storage.SavedDataStorage(
					java.nio.file.Files.createTempDirectory("arena-voice-chat-"), null,
					net.minecraft.core.RegistryAccess.EMPTY)) {
				level.storage = storage;
				set(unsafe, server, MinecraftServer.class, "levels", java.util.Map.of(Level.OVERWORLD, level));
				if (requestedProfile != null) VoiceDirector.setProfile(server, agent.agentId(), requestedProfile);
				check(VoiceSubsystemRuntime.start(server, configuration, List.of(provider)), "configured available voice provider starts");
				check(receivedServer.get() == server && configuration.equals(receivedConfiguration.get()),
						"voice provider receives the exact server and configuration");
				var executor = new ServerActionExecutor(manager, results::add);
				JsonObject arguments = new JsonObject();
				arguments.addProperty("audience", "proximity"); arguments.addProperty("message", "Playback may finish later.");
				var provenance = new ActionProvenance("codex", "gpt-5.6-sol", "high", "priority", "async-voice-program",
						1L, "async-voice-step", 1L, "async-voice-trace");
				var request = new ServerActionRequest(agent.agentId(), agent.goalRevision(), "async-voice-action", ActionType.CHAT,
						arguments, provenance, "async-voice-trace");
				chat = Thread.ofPlatform().daemon().name("voice-async-chat-contract").unstarted(() -> {
					try { executor.submitConcurrentChat(request); } catch (Throwable problem) { failure.set(problem); }
					finally { returned.countDown(); }
				});
				chat.start();
				await(returned, "actual chat action waited for voice playback");
				check(failure.get() == null, "actual chat entry point returns without a runtime failure");
				check(results.size() == 1 && results.getFirst().state() == ServerActionState.SUCCEEDED
						&& results.getFirst().reasonCode().equals("ACTION_COMPLETED"), "chat publishes one terminal success before playback completion");
				if (!hasHuman) {
					check(voice.request.get() == null, "ordinary agent speech with no human audience makes zero TTS requests");
					return assertions;
				}
				check(!voice.playback.isDone(), "voice playback receipt remains pending after chat action completion");
				VoiceRequest spoken = voice.request.get();
				captured = spoken;
				check(spoken != null && spoken.agentId().equals(agent.agentId()) && spoken.text().equals(arguments.get("message").getAsString()),
						"actual sendConversation preserves exact agent identity and authored text");
				if (requestedProfile == null) {
					check(spoken.profileId().equals("voice.auto.v1") && spoken.radius() == 48 && spoken.conversationSequence() == 1L,
							"actual sendConversation applies its profile, proximity radius and first owned sequence");
				} else {
					check(spoken.profileId().equals(requestedProfile.profileId()) && spoken.radius() == requestedProfile.radius()
							&& spoken.speed() == requestedProfile.speed() && spoken.tone().equals(requestedProfile.tone())
							&& spoken.explicitSpeed() == requestedProfile.explicitSpeed(),
							"ordinary autonomous speech honors persisted profile, speed or inherited pacing, tone and radius");
				}
				check(results.getFirst().agentId().equals(request.agentId()) && results.getFirst().actionId().equals(request.actionId())
						&& results.getFirst().traceId().equals(request.traceId()) && results.getFirst().actionType() == ActionType.CHAT,
						"early chat result retains exact request correlation");
				check(results.getFirst().executionStarted() && !results.getFirst().physicalAttempted(),
						"communication completion records execution without a body attempt");
				ServerActionResult early = results.getFirst();
				check(voice.playback.complete(VoiceReceipt.accepted()), "pending voice receipt can finish independently after the action");
				check(results.size() == 1 && results.getFirst() == early, "later voice completion cannot publish or replace a second chat result");
			} finally {
				voice.playback.complete(VoiceReceipt.accepted());
				if (chat != null) {
					try { chat.join(TimeUnit.SECONDS.toMillis(10)); }
					catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError(interrupted); }
				}
				VoiceSubsystemRuntime.close(server);
			}
			check(voice.closed, "test releases its installed voice provider");
			return assertions;
		} catch (Exception problem) { throw new AssertionError("pending voice chat fixture failed", problem); }
	}

	private static void await(CountDownLatch latch, String label) {
		try { if (!latch.await(10, TimeUnit.SECONDS)) throw new AssertionError(label); }
		catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new AssertionError(interrupted); }
	}
	private static void set(sun.misc.Unsafe unsafe, Object target, Class<?> owner, String field, Object value)
			throws ReflectiveOperationException {
		unsafe.putObject(target, unsafe.objectFieldOffset(owner.getDeclaredField(field)), value);
	}
	private static void check(boolean passed, String label) { if (!passed) throw new AssertionError(label); assertions++; }

	private static final class FixturePlayers extends DedicatedPlayerList {
		ServerPlayer speaker;
		List<ServerPlayer> humans;
		private FixturePlayers() { super(null, null, null); }
		@Override public ServerPlayer getPlayer(UUID identity) { return speaker.getUUID().equals(identity) ? speaker : null; }
		@Override public ServerPlayer getPlayerByName(String name) { return speaker.getGameProfile().name().equals(name) ? speaker : null; }
		@Override public List<ServerPlayer> getPlayers() { return humans; }
	}
	private static final class FixtureLevel extends dev.agaminggod.mineagen.compat.TestServerLevelBase {
		net.minecraft.world.level.storage.SavedDataStorage storage;
		private FixtureLevel() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
		@Override public net.minecraft.world.level.storage.SavedDataStorage getDataStorage() { return storage; }
	}

	private static final class FixtureHuman extends ServerPlayer {
		private FixtureHuman() { super(null, null, null, null); }
		@Override public net.minecraft.commands.CommandSourceStack createCommandSourceStack() {
			return dev.agaminggod.mineagen.compat.TestCompat.commandSource(
					net.minecraft.commands.CommandSource.NULL, net.minecraft.world.phys.Vec3.ZERO,
					net.minecraft.world.phys.Vec2.ZERO, (ServerLevel) level(),
					net.minecraft.server.permissions.PermissionSet.NO_PERMISSIONS,
					net.minecraft.network.chat.Component.literal("Listener"));
		}
	}

	private static final class PendingVoice implements VoiceSubsystem {
		@Override public boolean canReceive(UUID playerId) { return true; }
		final CompletableFuture<VoiceReceipt> playback = new CompletableFuture<>();
		final AtomicReference<VoiceRequest> request = new AtomicReference<>();
		boolean closed;
		@Override public boolean available() { return true; }
		@Override public void registerAgent(AgentId agent, UUID entity) { }
		@Override public void unregisterAgent(AgentId agent) { }
		@Override public CompletionStage<VoiceReceipt> speak(VoiceRequest spoken) { request.set(spoken); return playback; }
		@Override public void stop(AgentId agent) { }
		@Override public void close() { closed = true; }
	}
}
