package dev.agaminggod.mineagen.server.pov;

import carpet.patches.EntityPlayerMPFake;
import com.mojang.authlib.GameProfile;
import dev.agaminggod.mineagen.agent.AgentRecord;
import dev.agaminggod.mineagen.compat.TestServerLevelBase;
import dev.agaminggod.mineagen.compat.TestServerPlayerBase;
import dev.agaminggod.mineagen.pov.AgentPovPosePayload;
import dev.agaminggod.mineagen.pov.AgentPovStatePayload;
import dev.agaminggod.mineagen.pov.PovMode;
import dev.agaminggod.mineagen.pov.PovViewAnchors;
import dev.agaminggod.mineagen.server.AgentSavedData;
import dev.agaminggod.mineagen.server.CodexAgentManager;
import dev.agaminggod.mineagen.server.OfflineAgentPlayers;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedPlayerList;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.level.ServerPlayerGameMode;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.ai.attributes.AttributeMap;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.GameType;
import net.minecraft.world.level.Level;
import net.minecraft.world.phys.Vec3;

/** Real end-tick publication and inventory copying, with an in-memory packet sink and no client. */
public final class PovRuntimeCaptureVerification {
	private static int passed;

	public static int verify() {
		passed = 0;
		try (var fixture = new Fixture()) {
			for (int tick = 0; tick < 20; tick++) PovSessionRuntime.endTick(fixture.server);
			System.out.println("POV capture fixture: viewers=2 endTicks=20 commonInventoryCaptures=" + fixture.inventory.captures);
			check(fixture.sessions.size() == 2, "headless publication must keep both spectator sessions alive");
			check(fixture.inventory.captures == 20,
					"two spectators must share one common inventory capture per end tick; actual=" + fixture.inventory.captures);
			for (var sink : fixture.sinks) {
				check(sink.payloads.stream().filter(p -> p instanceof AgentPovPosePayload).count() == 20,
						"each spectator keeps one pose publication per end tick");
				check(sink.payloads.stream().filter(p -> p instanceof AgentPovStatePayload).count() == 1,
						"unchanged common state is published once per spectator");
			}
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
		try {
			verifySharedMenus();
			verifyRejectedPublications();
			verifyTrackingMetrics();
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
		return passed;
	}

	private static void verifySharedMenus() throws ReflectiveOperationException {
		try (var fixture = new Fixture()) {
			set(fixture.agent, Player.class, "inventoryMenu", new FixtureInventoryMenu(fixture.inventory, fixture.agent));
			fixture.agent.containerMenu = fixture.agent.inventoryMenu;
			var spectatorPackets = new Packets();
			var takeoverPackets = new Packets();
			var spectator = new PovStatePublisher(11L, PovMode.SPECTATE, fixture.agent.getUUID(), "Agent", spectatorPackets);
			var takeover = new PovStatePublisher(12L, PovMode.TAKEOVER, fixture.agent.getUUID(), "Agent", takeoverPackets);
			takeover.setInventoryOpen(true);
			var frame = new PovAgentSnapshot.Frame();
			var common = frame.capture(fixture.agent, false);
			var inventory = frame.capture(fixture.agent, true);
			check(common.inventory() == inventory.inventory() && common.effects() == inventory.effects(),
					"inventory projection reuses the common private inventory and effects copies");
			check(common.menu().isEmpty() && inventory.menu().orElseThrow().containerId() == 0,
					"takeover inventory visibility does not leak into the spectator view");
			spectator.tick(fixture.viewers.get(0), fixture.agent, Optional.empty(), 0, 0, frame);
			takeover.tick(fixture.viewers.get(1), fixture.agent, Optional.empty(), 0, 0, frame);
			check(count(spectatorPackets, dev.agaminggod.mineagen.pov.AgentPovMenuPayload.class) == 0
					&& count(takeoverPackets, dev.agaminggod.mineagen.pov.AgentPovMenuPayload.class) == 1,
					"only the takeover viewer receives its requested inventory menu");
			dev.agaminggod.mineagen.server.runtime.menu.AgentInventoryView.open(fixture.agent);
			frame = new PovAgentSnapshot.Frame();
			spectator.tick(fixture.viewers.get(0), fixture.agent, Optional.empty(), 0, 0, frame);
			takeover.tick(fixture.viewers.get(1), fixture.agent, Optional.empty(), 0, 0, frame);
			check(lastState(spectatorPackets).menu().orElseThrow().containerId() == 0,
					"an agent opening its own inventory remains visible to spectators");
			check(spectator.revision() == 2 && takeover.revision() == 1,
					"shared captures retain independent per-session publication revisions");
			fixture.inventory.setItem(0, new ItemStack(net.minecraft.world.item.Items.OAK_LOG, 3));
			check(common.inventory().hotbar().getFirst().isEmpty() && frame.capture(fixture.agent, false).inventory().hotbar().getFirst().isEmpty(),
					"captured common state owns copies and remains fixed within the end tick");
			check(new PovAgentSnapshot.Frame().capture(fixture.agent, false).inventory().hotbar().getFirst().getCount() == 3,
					"the next end tick captures inventory changes");
			dev.agaminggod.mineagen.server.runtime.menu.AgentInventoryView.close(fixture.agent);
			fixture.agent.containerMenu = new FixtureContainerMenu();
			frame = new PovAgentSnapshot.Frame();
			spectator.tick(fixture.viewers.get(0), fixture.agent, Optional.empty(), 0, 0, frame);
			takeover.tick(fixture.viewers.get(1), fixture.agent, Optional.empty(), 0, 0, frame);
			check(frame.capture(fixture.agent, false) == frame.capture(fixture.agent, true),
					"a real container shares its descriptor and contents across both menu projections");
			check(lastState(spectatorPackets).menu().orElseThrow().containerId() == 5
					&& lastState(takeoverPackets).menu().orElseThrow().containerId() == 5 && !takeover.inventoryOpen(),
					"a real container replaces the requested inventory for both viewer modes");
		}
	}

	private static void verifyRejectedPublications() throws ReflectiveOperationException {
		try (var fixture = new Fixture()) {
			fixture.agent.containerMenu = new FixtureContainerMenu();
			var packets = new Packets();
			var publisher = new PovStatePublisher(21L, PovMode.TAKEOVER, fixture.agent.getUUID(), "Agent", packets);
			var rejectState = new java.util.concurrent.atomic.AtomicBoolean(true);
			packets.rejection = p -> p instanceof AgentPovStatePayload && rejectState.getAndSet(false);
			publisher.tick(fixture.viewers.getFirst(), fixture.agent, Optional.empty(), 0, 0);
			check(publisher.revision() == 0 && packets.payloads.stream().noneMatch(p -> p instanceof dev.agaminggod.mineagen.pov.AgentPovMenuPayload),
					"rejected state neither advances revision nor publishes a menu without its descriptor");
			publisher.tick(fixture.viewers.getFirst(), fixture.agent, Optional.empty(), 0, 0);
			check(publisher.revision() == 1 && count(packets, AgentPovStatePayload.class) == 1
					&& count(packets, dev.agaminggod.mineagen.pov.AgentPovMenuPayload.class) == 1,
					"unchanged state and menu retry after the rejected state");
			rejectState.set(true);
			publisher.sendFull(fixture.viewers.getFirst(), fixture.agent, Optional.empty(), 0, 0);
			publisher.tick(fixture.viewers.getFirst(), fixture.agent, Optional.empty(), 0, 0);
			check(publisher.revision() == 2 && count(packets, AgentPovStatePayload.class) == 2
					&& count(packets, dev.agaminggod.mineagen.pov.AgentPovMenuPayload.class) == 2,
					"a rejected forced resync remains pending even when the state values are unchanged");
			fixture.agent.containerMenu.setCarried(new ItemStack(net.minecraft.world.item.Items.DIAMOND, 2));
			var rejectMenu = new java.util.concurrent.atomic.AtomicBoolean(true);
			packets.rejection = p -> p instanceof dev.agaminggod.mineagen.pov.AgentPovMenuPayload && rejectMenu.getAndSet(false);
			publisher.tick(fixture.viewers.getFirst(), fixture.agent, Optional.empty(), 0, 0);
			publisher.tick(fixture.viewers.getFirst(), fixture.agent, Optional.empty(), 0, 0);
			check(publisher.revision() == 2 && count(packets, dev.agaminggod.mineagen.pov.AgentPovMenuPayload.class) == 3,
					"rejected menu contents retry without advancing an unchanged state revision");
			check(count(packets, AgentPovPosePayload.class) == 6, "pose attempts keep their end-tick cadence across state/menu rejection");
			var absentPackets = new Packets();
			absentPackets.unavailable.add(AgentPovStatePayload.TYPE);
			var absent = new PovStatePublisher(22L, PovMode.SPECTATE, fixture.agent.getUUID(), "Agent", absentPackets);
			absent.tick(fixture.viewers.getFirst(), null, Optional.empty(), 0, 0);
			absentPackets.unavailable.clear();
			absent.tick(fixture.viewers.getFirst(), null, Optional.empty(), 0, 0);
			absent.tick(fixture.viewers.getFirst(), null, Optional.empty(), 0, 0);
			check(absent.revision() == 1 && count(absentPackets, AgentPovStatePayload.class) == 1,
					"an absent-body state retries after rejection and then stops repeating");
		}
	}

	private static void verifyTrackingMetrics() throws ReflectiveOperationException {
		try (var fixture = new Fixture()) {
			for (var viewer : fixture.viewers) PovViewAnchors.set(viewer.getUUID(), fixture.agent.getUUID());
			var before = PovViewRedirect.trackingWork();
			for (int tick = 0; tick < 20; tick++) {
				set(fixture.agent, Entity.class, "position", new Vec3(tick < 10 ? 100 : 117, 64, 100));
				var rechecks = new ArrayList<ServerPlayer>();
				PovViewRedirect.addAnchoredViewers(fixture.viewers, rechecks);
				check(rechecks.equals(fixture.viewers), "stationary and moving anchors retain every viewer recheck");
				for (var viewer : rechecks) check(PovViewRedirect.positionAnchor(viewer, Vec3.ZERO) == fixture.agent.position(),
						"entity tracking still measures from the current agent position");
			}
			var after = PovViewRedirect.trackingWork();
			check(after.anchoredViewerAdds() - before.anchoredViewerAdds() == 40, "tracking instrumentation counts anchored viewer additions");
			check(after.entityRangeChecks() - before.entityRangeChecks() == 40, "tracking instrumentation counts entity range hook reads");
			System.out.println("POV tracking fixture: anchoredViewerAdds=40 entityRangeChecks=40; hook invocations, not server timing");
		}
	}

	private static long count(Packets packets, Class<? extends CustomPacketPayload> type) {
		return packets.payloads.stream().filter(type::isInstance).count();
	}
	private static AgentPovStatePayload lastState(Packets packets) {
		return packets.payloads.stream().filter(p -> p instanceof AgentPovStatePayload)
				.map(p -> (AgentPovStatePayload) p).reduce((a, b) -> b).orElseThrow();
	}

	private static final class FixtureInventoryMenu extends net.minecraft.world.inventory.InventoryMenu
			implements dev.agaminggod.mineagen.mixin.AbstractContainerMenuAccessor {
		FixtureInventoryMenu(Inventory inventory, Player player) { super(inventory, false, player); }
		@Override public List<net.minecraft.world.inventory.DataSlot> mineagen$getDataSlots() { return List.of(); }
		@Override public net.minecraft.world.inventory.MenuType<?> mineagen$getMenuType() { return null; }
	}
	private static final class FixtureContainerMenu extends net.minecraft.world.inventory.AbstractContainerMenu
			implements dev.agaminggod.mineagen.mixin.AbstractContainerMenuAccessor {
		FixtureContainerMenu() {
			super(net.minecraft.world.inventory.MenuType.GENERIC_9x1, 5);
			var container = new net.minecraft.world.SimpleContainer(9);
			for (int index = 0; index < 9; index++) addSlot(new net.minecraft.world.inventory.Slot(container, index, 0, 0));
		}
		@Override public ItemStack quickMoveStack(Player player, int slot) { return ItemStack.EMPTY; }
		@Override public boolean stillValid(Player player) { return true; }
		@Override public List<net.minecraft.world.inventory.DataSlot> mineagen$getDataSlots() { return List.of(); }
		@Override public net.minecraft.world.inventory.MenuType<?> mineagen$getMenuType() { return net.minecraft.world.inventory.MenuType.GENERIC_9x1; }
	}

	static final class Packets implements PovStatePublisher.PacketSender {
		final List<CustomPacketPayload> payloads = new ArrayList<>();
		final java.util.Set<CustomPacketPayload.Type<?>> unavailable = new java.util.HashSet<>();
		java.util.function.Predicate<CustomPacketPayload> rejection = payload -> false;
		@Override public boolean canSend(ServerPlayer operator, CustomPacketPayload.Type<?> type) { return !unavailable.contains(type); }
		@Override public void send(ServerPlayer operator, CustomPacketPayload payload) {
			if (rejection.test(payload)) throw new IllegalStateException("Fake packet rejection");
			payloads.add(payload);
		}
	}

	static final class CountingInventory extends Inventory {
		int captures;
		CountingInventory(Player player, EntityEquipment equipment) { super(player, equipment); }
		@Override public ItemStack getItem(int slot) {
			// The common inventory capture reads the head slot once; hands and pose do not read it.
			if (slot == Inventory.INVENTORY_SIZE + 3) captures++;
			return super.getItem(slot);
		}
	}

	static final class Fixture implements AutoCloseable {
		final MinecraftServer server;
		final AgentRecord record;
		final EntityPlayerMPFake agent;
		final CountingInventory inventory;
		final List<ServerPlayer> viewers = new ArrayList<>();
		final List<Packets> sinks = new ArrayList<>();
		final Map<UUID, PovSession> sessions;
		final Map<MinecraftServer, CodexAgentManager> managers;
		final Map<MinecraftServer, Object> states;

		@SuppressWarnings("unchecked")
		Fixture() throws ReflectiveOperationException {
			server = allocate(DedicatedServer.class);
			var players = allocate(FixturePlayers.class);
			players.connected = new HashMap<>();
			set(server, MinecraftServer.class, "playerList", players);
			var level = allocate(FixtureLevel.class);
			level.server = server;
			set(level, Level.class, "dimension", Level.OVERWORLD);
			set(server, MinecraftServer.class, "levels", Map.of(Level.OVERWORLD, level));
			var manager = allocate(CodexAgentManager.class);
			set(manager, CodexAgentManager.class, "server", server);
			set(manager, CodexAgentManager.class, "savedData", new AgentSavedData());
			record = manager.registry().create("codex", "gpt-6.1-sol", "low", Optional.of("Snapshot Agent"), 1_000L);
			UUID agentId = OfflineAgentPlayers.offlineUuid(record.agentId(), record.profile());
			agent = allocate(EntityPlayerMPFake.class);
			initializePlayer(agent, level, agentId, OfflineAgentPlayers.playerName(record.agentId(), record.profile()));
			agent.setId(1003);
			set(agent, LivingEntity.class, "activeEffects", new HashMap<>());
			set(agent, LivingEntity.class, "attributes", new AttributeMap(Player.createAttributes().build()));
			set(agent, LivingEntity.class, "useItem", ItemStack.EMPTY);
			var equipment = new EntityEquipment();
			set(agent, LivingEntity.class, "equipment", equipment);
			inventory = new CountingInventory(agent, equipment);
			set(agent, Player.class, "inventory", inventory);
			set(agent, Player.class, "foodData", new net.minecraft.world.food.FoodData());
			set(agent, Player.class, "abilities", new net.minecraft.world.entity.player.Abilities());
			var gameMode = allocate(ServerPlayerGameMode.class);
			set(gameMode, ServerPlayerGameMode.class, "gameModeForPlayer", GameType.SURVIVAL);
			set(agent, ServerPlayer.class, "gameMode", gameMode);
			var dataItems = new SynchedEntityData.DataItem<?>[64];
			data(dataItems, Entity.class, "DATA_SHARED_FLAGS_ID", (byte) 0);
			data(dataItems, Entity.class, "DATA_AIR_SUPPLY_ID", 300);
			data(dataItems, Entity.class, "DATA_POSE", net.minecraft.world.entity.Pose.STANDING);
			data(dataItems, LivingEntity.class, "DATA_HEALTH_ID", 20.0F);
			data(dataItems, LivingEntity.class, "DATA_LIVING_ENTITY_FLAGS", (byte) 0);
			data(dataItems, Player.class, "DATA_PLAYER_ABSORPTION_ID", 0.0F);
			var dataConstructor = SynchedEntityData.class.getDeclaredConstructor(
					net.minecraft.network.syncher.SyncedDataHolder.class, SynchedEntityData.DataItem[].class);
			dataConstructor.setAccessible(true);
			set(agent, Entity.class, "entityData", dataConstructor.newInstance(agent, dataItems));
			players.connected.put(agentId, agent);
			var managersField = CodexAgentManager.class.getDeclaredField("INSTANCES"); managersField.setAccessible(true);
			managers = (Map<MinecraftServer, CodexAgentManager>) managersField.get(null);
			var statesField = PovSessionRuntime.class.getDeclaredField("STATES"); statesField.setAccessible(true);
			states = (Map<MinecraftServer, Object>) statesField.get(null);
			var stateType = Class.forName(PovSessionRuntime.class.getName() + "$State");
			var constructor = stateType.getDeclaredConstructor(); constructor.setAccessible(true);
			var state = constructor.newInstance();
			var sessionsField = stateType.getDeclaredField("sessions"); sessionsField.setAccessible(true);
			sessions = (Map<UUID, PovSession>) sessionsField.get(state);
			for (int index = 0; index < 2; index++) {
				var viewer = allocate(FixtureViewer.class);
				UUID id = UUID.randomUUID();
				initializePlayer(viewer, level, id, "Viewer" + index);
				viewers.add(viewer); players.connected.put(id, viewer);
				var sink = new Packets(); sinks.add(sink);
				long sessionId = index + 1L;
				var publisher = new PovStatePublisher(sessionId, PovMode.SPECTATE, agentId, "Snapshot Agent", sink);
				sessions.put(id, new PovSession(sessionId, id, record.agentId(), agentId, "Snapshot Agent", "Snapshot Agent",
						PovMode.SPECTATE, Level.OVERWORLD, Vec3.ZERO, 1_000L, publisher, null, false));
			}
			managers.put(server, manager); states.put(server, state);
		}

		@Override public void close() {
			for (var viewer : viewers) PovViewAnchors.clear(viewer.getUUID());
			dev.agaminggod.mineagen.server.runtime.menu.AgentInventoryView.close(agent);
			states.remove(server); managers.remove(server);
		}
	}

	private static void initializePlayer(ServerPlayer player, FixtureLevel level, UUID id, String name)
			throws ReflectiveOperationException {
		set(player, Entity.class, "uuid", id);
		set(player, Player.class, "gameProfile", new GameProfile(id, name));
		set(player, Entity.class, "level", level);
		set(player, Entity.class, "position", Vec3.ZERO);
		set(player, Entity.class, "deltaMovement", Vec3.ZERO);
	}

	private static final class FixtureLevel extends TestServerLevelBase {
		MinecraftServer server;
		private FixtureLevel() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
		@Override public MinecraftServer getServer() { return server; }
	}
	private static final class FixtureViewer extends TestServerPlayerBase {
		private FixtureViewer() { super(null, null, null, null); }
		@Override public boolean hasDisconnected() { return false; }
	}
	private static final class FixturePlayers extends DedicatedPlayerList {
		Map<UUID, ServerPlayer> connected;
		private FixturePlayers() { super(null, null, null); }
		@Override public ServerPlayer getPlayer(UUID id) { return connected.get(id); }
		@Override public ServerPlayer getPlayerByName(String name) {
			return connected.values().stream().filter(p -> p.getGameProfile().name().equals(name)).findFirst().orElse(null);
		}
		@Override public List<ServerPlayer> getPlayers() { return List.copyOf(connected.values()); }
	}

	@SuppressWarnings("unchecked")
	private static <T> void data(SynchedEntityData.DataItem<?>[] items, Class<?> owner, String name, T value)
			throws ReflectiveOperationException {
		var field = owner.getDeclaredField(name); field.setAccessible(true);
		var accessor = (net.minecraft.network.syncher.EntityDataAccessor<T>) field.get(null);
		items[accessor.id()] = new SynchedEntityData.DataItem<>(accessor, value);
	}

	private static <T> T allocate(Class<T> type) throws ReflectiveOperationException {
		var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
		return type.cast(((sun.misc.Unsafe) field.get(null)).allocateInstance(type));
	}
	static void set(Object target, Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		var field = owner.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
	}
	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		passed++;
	}
}
