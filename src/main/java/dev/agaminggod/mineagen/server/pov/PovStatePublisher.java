package dev.agaminggod.mineagen.server.pov;

import dev.agaminggod.mineagen.pov.AgentPovMenuPayload;
import dev.agaminggod.mineagen.pov.AgentPovPosePayload;
import dev.agaminggod.mineagen.pov.AgentPovStatePayload;
import dev.agaminggod.mineagen.pov.PovDeath;
import dev.agaminggod.mineagen.pov.PovIdentity;
import dev.agaminggod.mineagen.pov.PovMode;
import dev.agaminggod.mineagen.server.runtime.menu.AgentInventoryView;
import java.util.Objects;
import java.util.Optional;
import java.util.UUID;
import java.util.function.Supplier;
import net.fabricmc.fabric.api.networking.v1.ServerPlayNetworking;
import net.minecraft.network.protocol.common.custom.CustomPacketPayload;
import net.minecraft.server.level.ServerPlayer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Streams one agent's POV to one operator. End-tick publications share the common agent snapshot, with separate
 * menu visibility and sent baselines per operator. Poses are sent every tick; state and menus only when changed.
 * Server thread only.
 */
public final class PovStatePublisher {
	private static final Logger LOGGER = LoggerFactory.getLogger(PovStatePublisher.class);

	interface PacketSender {
		boolean canSend(ServerPlayer operator, CustomPacketPayload.Type<?> type);
		void send(ServerPlayer operator, CustomPacketPayload payload);
	}
	private static final PacketSender NETWORK = new PacketSender() {
		@Override public boolean canSend(ServerPlayer operator, CustomPacketPayload.Type<?> type) {
			return ServerPlayNetworking.canSend(operator, type);
		}
		@Override public void send(ServerPlayer operator, CustomPacketPayload payload) {
			ServerPlayNetworking.send(operator, payload);
		}
	};
	private final PacketSender sender;

	private final long sessionId;
	private final PovMode mode;
	private final UUID agentUuid;
	private final String agentName;
	private int revision;
	private boolean inventoryOpen;
	private PovAgentSnapshot lastKnown;
	private PovAgentSnapshot lastState;
	private Optional<PovDeath> lastDeath = Optional.empty();
	private int lastLookResetSeq;
	private PovAgentSnapshot lastMenu;
	private boolean absentPublished;
	private boolean failureLogged;
	private boolean stateResyncPending;
	private boolean menuResyncPending;

	public PovStatePublisher(long sessionId, PovMode mode, UUID agentUuid, String agentName) {
		this(sessionId, mode, agentUuid, agentName, NETWORK);
	}

	PovStatePublisher(long sessionId, PovMode mode, UUID agentUuid, String agentName, PacketSender sender) {
		this.sender = Objects.requireNonNull(sender, "sender must not be null");
		this.sessionId = sessionId;
		this.mode = Objects.requireNonNull(mode, "mode must not be null");
		this.agentUuid = Objects.requireNonNull(agentUuid, "agentUuid must not be null");
		this.agentName = Objects.requireNonNull(agentName, "agentName must not be null");
	}

	/**
	 * Called at the end of every server tick, after physics, so the pose carries the position that tick produced.
	 * Sends AgentPovPosePayload every call when the agent is present; sends
	 * AgentPovStatePayload only when vitals/inventory/effects/menu/death/identity changed (revision increments);
	 * sends AgentPovMenuPayload when the agent's open menu contents, carried stack or data slots changed. agent may
	 * be null (dead and removed / not spawned): then a state payload with the last known inventory and a FLAG_DEAD
	 * pose is sent once (again only if death or lookResetSeq change).
	 */
	public void tick(ServerPlayer operator, ServerPlayer agent, Optional<PovDeath> death, int lookResetSeq,
			int inputSequence) {
		tick(operator, agent, death, lookResetSeq, inputSequence, new PovAgentSnapshot.Frame());
	}

	void tick(ServerPlayer operator, ServerPlayer agent, Optional<PovDeath> death, int lookResetSeq,
			int inputSequence, PovAgentSnapshot.Frame frame) {
		publish(operator, agent, death, lookResetSeq, inputSequence, false, frame);
	}

	/** Sends the current full state and menu immediately, e.g. on session start. */
	public void sendFull(ServerPlayer operator, ServerPlayer agent, Optional<PovDeath> death, int lookResetSeq,
			int inputSequence) {
		publish(operator, agent, death, lookResetSeq, inputSequence, true, new PovAgentSnapshot.Frame());
	}

	/**
	 * Mirrors the agent's player inventory (container id 0) to the operator: the state payload carries a menu with an
	 * empty type and the menu payload carries the inventory menu slots. Opening a real container clears the flag,
	 * as vanilla replaces the inventory screen.
	 */
	public void setInventoryOpen(boolean open) {
		inventoryOpen = open;
	}

	public boolean inventoryOpen() {
		return inventoryOpen;
	}

	public int revision() {
		return revision;
	}

	private void publish(ServerPlayer operator, ServerPlayer agent, Optional<PovDeath> death, int lookResetSeq,
			int inputSequence, boolean full, PovAgentSnapshot.Frame frame) {
		Objects.requireNonNull(operator, "operator must not be null");
		Objects.requireNonNull(death, "death must not be null");
		if (agent == null) {
			publishAbsent(operator, death, lookResetSeq, inputSequence, full);
			return;
		}
		if (inventoryOpen && agent.containerMenu != agent.inventoryMenu) inventoryOpen = false;
		// The agent opens its own inventory to craft in the 2x2 grid; spectators see that screen too.
		PovAgentSnapshot current = frame.capture(agent, inventoryOpen || AgentInventoryView.isOpen(agent));
		lastKnown = current;
		if (full || absentPublished) {
			stateResyncPending = true;
			menuResyncPending = true;
		}
		absentPublished = false;
		boolean stateReady = true;
		if (stateResyncPending || current.stateDiffers(lastState) || !death.equals(lastDeath) || lookResetSeq != lastLookResetSeq) {
			stateReady = sendState(operator, current, death, lookResetSeq);
			stateResyncPending = !stateReady;
		}
		if (current.menuContents().isEmpty()) {
			lastMenu = null;
			menuResyncPending = false;
		} else if (stateReady && (menuResyncPending || current.menuDiffers(lastMenu))) {
			menuResyncPending = !sendMenu(operator, current);
		}
		sendPose(operator, current.pose(), inputSequence);
	}

	private void publishAbsent(ServerPlayer operator, Optional<PovDeath> death, int lookResetSeq, int inputSequence,
			boolean full) {
		lastMenu = null;
		menuResyncPending = false;
		if (!full && !stateResyncPending && absentPublished && death.equals(lastDeath) && lookResetSeq == lastLookResetSeq) return;
		PovAgentSnapshot absent = PovAgentSnapshot.absent(lastKnown, operator.level().dimension());
		boolean sent = sendState(operator, absent, death, lookResetSeq);
		stateResyncPending = !sent;
		sendPose(operator, absent.pose(), inputSequence);
		absentPublished = sent;
	}

	private boolean sendState(ServerPlayer operator, PovAgentSnapshot snapshot, Optional<PovDeath> death, int lookResetSeq) {
		if (!sender.canSend(operator, AgentPovStatePayload.TYPE)) return false;
		int nextRevision = revision == Integer.MAX_VALUE ? 1 : revision + 1;
		boolean sent = send(operator, () -> new AgentPovStatePayload(
				new PovIdentity(sessionId, nextRevision, mode, agentUuid, snapshot.entityId(), snapshot.dimension(),
						agentName, lookResetSeq),
				snapshot.vitals(),
				PovAgentSnapshot.wireInventory(snapshot.inventory()),
				snapshot.effects(),
				snapshot.menu(),
				death
		));
		if (!sent) return false;
		revision = nextRevision;
		lastState = snapshot;
		lastDeath = death;
		lastLookResetSeq = lookResetSeq;
		return true;
	}

	private boolean sendMenu(ServerPlayer operator, PovAgentSnapshot snapshot) {
		if (!sender.canSend(operator, AgentPovMenuPayload.TYPE)) return false;
		PovAgentSnapshot.MenuContents contents = snapshot.menuContents().orElseThrow();
		boolean sent = send(operator, () -> new AgentPovMenuPayload(
				sessionId,
				contents.containerId(),
				contents.stateId(),
				contents.slots().stream().map(PovAgentSnapshot::wireStack).toList(),
				PovAgentSnapshot.wireStack(contents.carried()),
				contents.dataSlots()
		));
		if (sent) lastMenu = snapshot;
		return sent;
	}

	private void sendPose(ServerPlayer operator, PovAgentSnapshot.Pose pose, int inputSequence) {
		if (!sender.canSend(operator, AgentPovPosePayload.TYPE)) return;
		send(operator, () -> new AgentPovPosePayload(sessionId, pose.yaw(), pose.pitch(), pose.attackStrength(), pose.flags(),
				pose.x(), pose.y(), pose.z(), Math.max(0, inputSequence)));
	}

	private boolean send(ServerPlayer operator, Supplier<? extends CustomPacketPayload> payload) {
		try {
			sender.send(operator, payload.get());
			return true;
		} catch (RuntimeException exception) {
			// One warning per session: rejected publication is retried on following ticks.
			if (!failureLogged) {
				failureLogged = true;
				LOGGER.warn("Could not publish POV state for {} (session {}) to {}", agentName, sessionId,
						operator.getScoreboardName(), exception);
			}
			return false;
		}
	}
}
