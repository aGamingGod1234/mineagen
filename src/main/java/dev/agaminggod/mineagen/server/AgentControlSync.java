package dev.agaminggod.mineagen.server;

import dev.agaminggod.mineagen.control.AgentControlRequestPayload;
import dev.agaminggod.mineagen.control.AgentControlModelOption;
import dev.agaminggod.mineagen.control.AgentControlRedaction;
import dev.agaminggod.mineagen.control.AgentControlSnapshot;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.agent.AgentRecord;
import dev.agaminggod.mineagen.control.AgentControlSnapshotPayload;
import dev.agaminggod.mineagen.pov.OperatorActionPayload;
import dev.agaminggod.mineagen.pov.OperatorInputPayload;
import dev.agaminggod.mineagen.pov.PovPayloads;
import dev.agaminggod.mineagen.server.pov.PovSessionRuntime;
import java.util.HashSet;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.function.Function;
import net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents;
import net.fabricmc.fabric.api.networking.v1.PayloadTypeRegistry;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.network.chat.Component;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class AgentControlSync {
	private static final Logger LOGGER = LoggerFactory.getLogger(AgentControlSync.class);
	private static final Map<MinecraftServer, Long> CONTROL_REVISIONS = new WeakHashMap<>();
	private static final SnapshotRequestLimiter SNAPSHOT_REQUESTS = new SnapshotRequestLimiter();
	private static boolean registered;

	private AgentControlSync() {
	}

	public static synchronized void register() {
		if (registered) {
			return;
		}
		PovPayloads.registerTypes();
		// Takeover input is routed on the server thread; the runtime re-checks the session and permission.
		if (!ServerPlayNetworking.registerGlobalReceiver(OperatorInputPayload.TYPE,
				(payload, context) -> context.server().execute(() -> PovSessionRuntime.handleInput(context.player(), payload)))
				|| !ServerPlayNetworking.registerGlobalReceiver(OperatorActionPayload.TYPE,
				(payload, context) -> context.server().execute(() -> PovSessionRuntime.handleAction(context.player(), payload)))
				|| !ServerPlayNetworking.registerGlobalReceiver(dev.agaminggod.mineagen.pov.OperatorTextPayload.TYPE,
				(payload, context) -> context.server().execute(() -> PovSessionRuntime.handleText(context.player(), payload)))
				|| !ServerPlayNetworking.registerGlobalReceiver(dev.agaminggod.mineagen.pov.OperatorCreativeSlotPayload.TYPE,
				(payload, context) -> context.server().execute(() -> PovSessionRuntime.handleCreativeSlot(context.player(), payload)))) {
			throw new IllegalStateException("Mineagen takeover input receivers are already registered");
		}
		PayloadTypeRegistry.serverboundPlay().register(dev.agaminggod.mineagen.control.ProviderApiKeyPayload.TYPE,
				dev.agaminggod.mineagen.control.ProviderApiKeyPayload.CODEC);
		ServerPlayNetworking.registerGlobalReceiver(dev.agaminggod.mineagen.control.ProviderApiKeyPayload.TYPE,
				(payload, context) -> context.server().execute(() -> {
					try {
						ProviderApiKeyStore.update(GoalControl.mayControl(context.player().createCommandSourceStack()),
								isLocalKeyHost(context.server(), context.player()),
								ProviderApiKeyStore.runtimeRoot(), payload.provider(), payload.key());
						AgentServerRuntime.reloadProviderCredentials(context.server());
						context.player().sendSystemMessage(Component.literal("Provider API key updated. Scanning model CLIs..."));
					} catch (ProviderApiKeyStore.LocalOnlyException refused) {
						context.player().sendSystemMessage(Component.literal(ProviderApiKeyStore.LOCAL_ONLY_MESSAGE));
					} catch (RuntimeException failure) {
						// Never attach the exception or payload: neither diagnostics nor chat may echo credentials.
						context.player().sendSystemMessage(Component.literal("API key change rejected. Operator permission and a valid key are required; check server file access."));
					}
					sendSnapshot(context.player());
				}));
		PayloadTypeRegistry.serverboundPlay().register(AgentControlRequestPayload.TYPE, AgentControlRequestPayload.CODEC);
		PayloadTypeRegistry.serverboundPlay().register(dev.agaminggod.mineagen.control.ProviderRescanPayload.TYPE, dev.agaminggod.mineagen.control.ProviderRescanPayload.CODEC);
		ServerPlayNetworking.registerGlobalReceiver(dev.agaminggod.mineagen.control.ProviderRescanPayload.TYPE,
				(payload, context) -> context.server().execute(() -> {
					if (GoalControl.mayControl(context.player().createCommandSourceStack())) {
						AgentServerRuntime.requestProviderRescan(context.server());
					}
				}));
		PayloadTypeRegistry.serverboundPlay().register(dev.agaminggod.mineagen.control.LiveTaskViewPayload.Request.TYPE, dev.agaminggod.mineagen.control.LiveTaskViewPayload.Request.CODEC);
		PayloadTypeRegistry.clientboundPlay().register(dev.agaminggod.mineagen.control.LiveTaskViewPayload.Snapshot.TYPE, dev.agaminggod.mineagen.control.LiveTaskViewPayload.Snapshot.CODEC);
		ServerPlayNetworking.registerGlobalReceiver(dev.agaminggod.mineagen.control.LiveTaskViewPayload.Request.TYPE,
				(payload, context) -> context.server().execute(() -> LiveTaskViewSync.request(context.player(), payload.agentId())));
		PayloadTypeRegistry.clientboundPlay().register(AgentControlSnapshotPayload.TYPE, AgentControlSnapshotPayload.CODEC);
		boolean receiverRegistered = ServerPlayNetworking.registerGlobalReceiver(
				AgentControlRequestPayload.TYPE,
				(payload, context) -> context.server().execute(() -> requestSnapshot(context.player()))
		);
		if (!receiverRegistered) {
			throw new IllegalStateException("Mineagen control snapshot receiver is already registered");
		}
		ServerTickEvents.END_SERVER_TICK.register(AgentControlSync::sendDeferredSnapshots);
		registered = true;
	}

	/** True only for the player hosting this integrated world over the in-memory connection, never a LAN guest or a remote client. */
	private static boolean isLocalKeyHost(MinecraftServer server, ServerPlayer player) {
		if (player.connection == null) return false;
		var connection = ((dev.agaminggod.mineagen.mixin.ServerCommonPacketListenerImplAccessor) player.connection).mineagen$connection();
		return ProviderApiKeyStore.localHost(server.isDedicatedServer(),
				server.isSingleplayerOwner(new net.minecraft.server.players.NameAndId(player.getGameProfile())),
				connection != null && connection.isMemoryConnection());
	}

	private static void publishControlDenial(ServerPlayer player, String message) {
		player.sendSystemMessage(Component.literal(message));
		requestSnapshot(player);
	}

	static void requestSnapshot(ServerPlayer player) {
		switch (SNAPSHOT_REQUESTS.request(player.getUUID(), monotonicMillis())) {
			case SEND -> sendSnapshot(player);
			case DEFERRED -> { }
			case DROPPED -> LOGGER.debug("Dropped an over-rate control snapshot request from {}", player.getScoreboardName());
		}
	}

	private static void sendDeferredSnapshots(MinecraftServer server) {
		Map<UUID, Integer> due = SNAPSHOT_REQUESTS.due(monotonicMillis());
		if (due.isEmpty() && SNAPSHOT_REQUESTS.tracked() == 0) return;
		Set<UUID> connected = new HashSet<>();
		for (ServerPlayer player : server.getPlayerList().getPlayers()) {
			connected.add(player.getUUID());
			for (int sent = 0; sent < due.getOrDefault(player.getUUID(), 0); sent++) sendSnapshot(player);
		}
		SNAPSHOT_REQUESTS.retain(connected);
	}

	private static long monotonicMillis() {
		return System.nanoTime() / 1_000_000L;
	}

	public static void sendSnapshot(ServerPlayer player) {
		try {
			var server = player.level().getServer();
			boolean canControl = GoalControl.mayControl(player.createCommandSourceStack());
			AgentManager manager = AgentManager.get(player.level().getServer());
			AgentControlSnapshot snapshot = controlSnapshot(
					canControl,
					AgentServerRuntime.automationAvailable(player.level().getServer()),
					AgentServerRuntime.automationStatus(player.level().getServer()),
					nextControlRevision(player.level().getServer()),
					manager.records(),
					AgentServerRuntime.modelCatalog(player.level().getServer()),
					manager::findAgentPlayer
			);
			if (ServerPlayNetworking.canSend(player, AgentControlSnapshotPayload.TYPE)) {
				ServerPlayNetworking.send(player, AgentControlSnapshotPayload.fromSnapshot(ProviderApiKeyStore.withMetadata(snapshot, ProviderApiKeyStore.runtimeRoot())));
			}
		} catch (RuntimeException exception) {
			LOGGER.warn("Could not send Mineagen control snapshot to {}", player.getScoreboardName(), exception);
		}
	}

	static AgentControlSnapshot controlSnapshot(
			boolean canControl, boolean automationAvailable, String automationStatus, long revision,
			List<AgentRecord> records, List<AgentControlModelOption> catalog,
			Function<AgentId, Optional<ServerPlayer>> findPlayer
	) {
		return AgentControlRedaction.forViewer(AgentControlSnapshot.fromRecords(canControl, automationAvailable, automationStatus, revision,
				records, catalog, dev.agaminggod.mineagen.control.AgentControlCatalog.providerRows(), id -> findPlayer.apply(id).filter(ServerPlayer::isAlive).isPresent()));
	}

	private static synchronized long nextControlRevision(MinecraftServer server) {
		long next = Math.max(System.currentTimeMillis(), CONTROL_REVISIONS.getOrDefault(server, 0L) + 1L);
		CONTROL_REVISIONS.put(server, next);
		return next;
	}

}
