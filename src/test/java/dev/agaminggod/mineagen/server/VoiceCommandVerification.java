package dev.agaminggod.mineagen.server;

import carpet.patches.EntityPlayerMPFake;
import com.mojang.authlib.GameProfile;
import com.mojang.brigadier.CommandDispatcher;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.compat.TestCompat;
import dev.agaminggod.mineagen.compat.TestServerLevelBase;
import dev.agaminggod.mineagen.server.voice.*;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.CompletionStage;
import net.minecraft.commands.CommandSource;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.core.RegistryAccess;
import net.minecraft.network.chat.Component;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedPlayerList;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.permissions.PermissionSet;
import net.minecraft.util.datafix.DataFixers;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.storage.SavedDataStorage;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

/** Checks the registered /mineagen tree, then executes ordinary-agent voice commands with a fake add-on. */
public final class VoiceCommandVerification {
	private static int assertions;
	private VoiceCommandVerification() { }

	@SuppressWarnings("unchecked")
	public static int verify() throws Exception {
		assertions = 0;
		var dispatcher = new CommandDispatcher<CommandSourceStack>(new FixtureRoot());
		AgentCommands.register(dispatcher);
		var operator = source(null, PermissionSet.ALL_PERMISSIONS);
		var nonOperator = source(null, PermissionSet.NO_PERMISSIONS);
		check(dispatcher.getRoot().getChild("mineagen") != null, "agent commands live under /mineagen");
		check(dispatcher.getRoot().getChild("codex") == null, "the old /codex root is gone");
		var root = dispatcher.getRoot().getChild("mineagen");
		check(root.getRequirement().test(nonOperator), "the /mineagen root itself is open to every player");
		for (String literal : List.of("stop", "status", "dm")) {
			check(root.getChild(literal).getChildren().stream().map(com.mojang.brigadier.tree.CommandNode::getName).toList()
					.equals(List.of("agent")), "/mineagen " + literal + " takes only the agent argument");
		}
		String agentId = UUID.randomUUID().toString();
		check(complete(dispatcher, operator, "mineagen stop " + agentId), "an operator can stop an agent");
		check(!complete(dispatcher, nonOperator, "mineagen stop " + agentId), "stop remains operator-only");
		check(complete(dispatcher, operator, "mineagen status") && complete(dispatcher, operator, "mineagen status " + agentId),
				"an operator can read every agent's status or one agent's");
		check(!complete(dispatcher, nonOperator, "mineagen status " + agentId), "status remains operator-only");
		check(complete(dispatcher, nonOperator, "mineagen dm " + agentId + " Meet me at the bridge."), "any player can message an agent");
		check(complete(dispatcher, operator, dev.agaminggod.mineagen.control.AgentControlCommandBuilder.agent("stop", agentId))
				&& complete(dispatcher, operator, dev.agaminggod.mineagen.control.AgentControlCommandBuilder.prompt("start", agentId, "Build a shelter.")),
				"commands the Agents screen sends parse against the registered tree");
		check(root.getChild("skit") == null, "skit command root is removed");
		check(root.getChild("group") == null, "group command root is removed");
		check(root.getChild("camera") == null, "camera commands are removed");
		check(root.getChild("voice").getChild("script") == null, "speech scripts are removed");
		check(!complete(dispatcher, nonOperator, "mineagen voice profiles"), "voice settings remain operator-only");

		Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
		var unsafe = (sun.misc.Unsafe) field.get(null);
		var server = (MinecraftServer) unsafe.allocateInstance(DedicatedServer.class);
		var manager = (AgentManager) unsafe.allocateInstance(AgentManager.class);
		set(unsafe, manager, AgentManager.class, "server", server);
		set(unsafe, manager, AgentManager.class, "savedData", new AgentSavedData());
		var agent = manager.registry().create("codex", "gpt-6.1-sol", "low", Optional.of("Voice Agent"), 1_000L);
		var player = (EntityPlayerMPFake) unsafe.allocateInstance(EntityPlayerMPFake.class);
		UUID identity = OfflineAgentPlayers.offlineUuid(agent.agentId(), agent.profile());
		set(unsafe, player, Entity.class, "uuid", identity);
		set(unsafe, player, Player.class, "gameProfile", new GameProfile(identity, OfflineAgentPlayers.playerName(agent.agentId(), agent.profile())));
		Field healthField = net.minecraft.world.entity.LivingEntity.class.getDeclaredField("DATA_HEALTH_ID");
		healthField.setAccessible(true);
		var health = (net.minecraft.network.syncher.EntityDataAccessor<Float>) healthField.get(null);
		var items = new SynchedEntityData.DataItem<?>[health.id() + 1];
		items[health.id()] = new SynchedEntityData.DataItem<>(health, 20.0F);
		var dataConstructor = SynchedEntityData.class.getDeclaredConstructor(
				net.minecraft.network.syncher.SyncedDataHolder.class, SynchedEntityData.DataItem[].class);
		dataConstructor.setAccessible(true);
		set(unsafe, player, Entity.class, "entityData", dataConstructor.newInstance(player, items));
		var players = (FixturePlayers) unsafe.allocateInstance(FixturePlayers.class);
		players.speaker = player;
		set(unsafe, server, MinecraftServer.class, "playerList", players);
		var level = (FixtureLevel) unsafe.allocateInstance(FixtureLevel.class);
		level.server = server;
		set(unsafe, level, Level.class, "dimension", Level.OVERWORLD);
		set(unsafe, player, Entity.class, "level", level);
		set(unsafe, server, MinecraftServer.class, "levels", Map.of(Level.OVERWORLD, level));
		Field instances = AgentManager.class.getDeclaredField("INSTANCES"); instances.setAccessible(true);
		var managers = (Map<MinecraftServer, AgentManager>) instances.get(null);
		managers.put(server, manager);
		var voice = new RecordingVoice();
		try (var storage = new SavedDataStorage(Files.createTempDirectory("mineagen-voice-commands-"), DataFixers.getDataFixer(), RegistryAccess.EMPTY)) {
			level.storage = storage;
			var startVoice = VoiceSubsystemRuntime.class.getDeclaredMethod("start", MinecraftServer.class,
					VoiceSubsystemConfiguration.class, Iterable.class);
			startVoice.setAccessible(true);
			startVoice.invoke(null, server, new VoiceSubsystemConfiguration("http://127.0.0.1:18775/v1/tts", "fixture-secret-".repeat(3)),
					List.<VoiceSubsystemProvider>of(actual -> voice));
			var actualOperator = source(level, PermissionSet.ALL_PERMISSIONS);
			set(unsafe, actualOperator, CommandSourceStack.class, "server", server);
			String selector = "\"Voice Agent\"";
			check(dispatcher.execute("mineagen voice profile " + selector + " voice.ethan.v1 dramatic 1.25 64", actualOperator) == 1,
					"profile command resolves an ordinary named agent");
			var saved = new VoiceProfile("voice.ethan.v1", "dramatic", 1.25, 64);
			check(saved.equals(VoiceDirector.profile(server, agent.agentId())), "profile command persists exact settings");
			check(dispatcher.execute("mineagen voice say " + selector + " Saved settings.", actualOperator) == 1, "say works without a skit mode");
			check(voice.requests.getLast().equals(new VoiceRequest(agent.agentId(), "Saved settings.", "voice.ethan.v1", 64, 1, 1.25, "dramatic")),
					"ordinary say reaches the add-on with saved settings");
			check(dispatcher.execute("mineagen voice say_with " + agent.agentId() + " voice.selene.v1 warm 0.75 24 Preview only.", actualOperator) == 1,
					"preview resolves an ordinary agent UUID");
			check(voice.requests.getLast().equals(new VoiceRequest(agent.agentId(), "Preview only.", "voice.selene.v1", 24, 2, 0.75, "warm")),
					"preview reaches the add-on with the selected settings");
			check(saved.equals(VoiceDirector.profile(server, agent.agentId())), "preview preserves saved settings");
			var savedCodec = VoiceDirectorSavedData.TYPE.codec();
			check(dispatcher.execute("mineagen voice profile " + selector + " voice.auto.v1 warm", actualOperator) == 1,
					"profile command accepts a tone without a speed");
			var reloaded = savedCodec.parse(com.mojang.serialization.JsonOps.INSTANCE, savedCodec.encodeStart(
					com.mojang.serialization.JsonOps.INSTANCE, VoiceDirectorSavedData.get(server)).getOrThrow()).getOrThrow();
			VoiceRequest inherited = reloaded.request(agent.agentId(), "Automatic pacing.", 9L);
			check(!inherited.explicitSpeed() && inherited.profileId().equals("voice.auto.v1") && inherited.tone().equals("warm")
					&& inherited.radius() == 48, "a saved profile without a speed keeps automatic pacing after reload");
			check(dispatcher.execute("mineagen voice say " + selector + " Inherited pace.", actualOperator) == 1, "say uses inherited settings");
			check(!voice.requests.getLast().explicitSpeed() && voice.requests.getLast().tone().equals("warm"),
					"say with an inherited saved speed lets the voice worker choose the pace");
			check(dispatcher.execute("mineagen voice profile " + selector + " voice.auto.v1 warm 1.0 48", actualOperator) == 1,
					"profile command accepts an explicit speed of 1.0");
			var encodedExplicit = savedCodec.encodeStart(com.mojang.serialization.JsonOps.INSTANCE,
					VoiceDirectorSavedData.get(server)).getOrThrow().getAsJsonObject();
			check(encodedExplicit.getAsJsonObject("profiles").getAsJsonObject(agent.agentId().toString()).has("speed"),
					"an explicit 1.0 speed is written to the save");
			VoiceRequest explicitOne = savedCodec.parse(com.mojang.serialization.JsonOps.INSTANCE, encodedExplicit).getOrThrow()
					.request(agent.agentId(), "Explicit pace.", 10L);
			check(explicitOne.explicitSpeed() && explicitOne.speed() == 1.0D && explicitOne.tone().equals("warm"),
					"an explicit 1.0 speed stays explicit after reload");
			VoiceSubsystemRuntime.close(server);
			try {
				dispatcher.execute("mineagen voice say " + selector + " No add-on.", actualOperator);
				throw new AssertionError("missing add-on must reject speech");
			} catch (com.mojang.brigadier.exceptions.CommandSyntaxException expected) {
				check(expected.getMessage().contains("VOICE_UNAVAILABLE"), "missing add-on reports voice unavailability");
			}
			check(voice.requests.size() == 3, "unavailable speech makes no synthesis request");
		} finally {
			VoiceSubsystemRuntime.close(server);
			managers.remove(server);
			OfflineAgentPlayers.clearIdentityCache();
		}
		System.out.println("PASS: " + assertions + " command tree and voice command assertions");
		return assertions;
	}

	private static CommandSourceStack source(FixtureLevel level, PermissionSet permissions) {
		return TestCompat.commandSource(CommandSource.NULL, Vec3.ZERO, Vec2.ZERO, level, permissions, Component.literal("Voice check"));
	}
	private static boolean complete(CommandDispatcher<CommandSourceStack> dispatcher, CommandSourceStack source, String command) {
		var parsed = dispatcher.parse(command, source);
		return !parsed.getReader().canRead() && parsed.getExceptions().isEmpty() && parsed.getContext().getCommand() != null;
	}
	private static void set(sun.misc.Unsafe unsafe, Object target, Class<?> owner, String name, Object value) throws Exception {
		unsafe.putObject(target, unsafe.objectFieldOffset(owner.getDeclaredField(name)), value);
	}
	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}

	/** The plain JVM has no mixin transformer; expose Brigadier's actual maps through the production accessor contract. */
	private static final class FixtureRoot extends com.mojang.brigadier.tree.RootCommandNode<CommandSourceStack>
			implements dev.agaminggod.mineagen.mixin.CommandNodeAccessor {
		@Override public Map<String, com.mojang.brigadier.tree.CommandNode<?>> mineagen$children() { return map("children"); }
		@Override public Map<String, com.mojang.brigadier.tree.LiteralCommandNode<?>> mineagen$literals() { return map("literals"); }
		@Override public Map<String, com.mojang.brigadier.tree.ArgumentCommandNode<?, ?>> mineagen$arguments() { return map("arguments"); }
		@SuppressWarnings("unchecked")
		private <V> Map<String, V> map(String name) {
			try {
				var field = com.mojang.brigadier.tree.CommandNode.class.getDeclaredField(name);
				field.setAccessible(true);
				return (Map<String, V>) field.get(this);
			} catch (ReflectiveOperationException exception) { throw new AssertionError(exception); }
		}
	}

	private static final class FixtureLevel extends TestServerLevelBase {
		MinecraftServer server;
		SavedDataStorage storage;
		private FixtureLevel() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
		@Override public MinecraftServer getServer() { return server; }
		@Override public SavedDataStorage getDataStorage() { return storage; }
	}
	private static final class FixturePlayers extends DedicatedPlayerList {
		ServerPlayer speaker;
		private FixturePlayers() { super(null, null, null); }
		@Override public ServerPlayer getPlayer(UUID id) { return speaker.getUUID().equals(id) ? speaker : null; }
		@Override public ServerPlayer getPlayerByName(String name) { return speaker.getGameProfile().name().equals(name) ? speaker : null; }
		@Override public List<ServerPlayer> getPlayers() { return List.of(); }
	}
	private static final class RecordingVoice implements VoiceSubsystem {
		final List<VoiceRequest> requests = new ArrayList<>();
		@Override public boolean available() { return true; }
		@Override public void registerAgent(AgentId id, UUID player) { }
		@Override public void unregisterAgent(AgentId id) { }
		@Override public CompletionStage<VoiceReceipt> speak(VoiceRequest request) {
			requests.add(request);
			return CompletableFuture.completedFuture(new VoiceReceipt(VoiceReceipt.Status.PLAYED, "Fixture playback"));
		}
		@Override public void stop(AgentId id) { }
		@Override public void close() { }
	}
}
