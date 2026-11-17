package dev.agaminggod.mineagen.client.control;

import dev.agaminggod.mineagen.client.compat.McClientCompat;

import com.mojang.blaze3d.platform.InputConstants;
import dev.agaminggod.mineagen.client.gui.AgentControlScreen;
import dev.agaminggod.mineagen.control.AgentControlCatalog;
import dev.agaminggod.mineagen.control.AgentControlRequestPayload;
import dev.agaminggod.mineagen.control.AgentControlSnapshot;
import dev.agaminggod.mineagen.control.AgentControlSnapshotPayload;
import dev.agaminggod.mineagen.control.AgentControlSnapshotStore;
import java.util.ArrayDeque;
import java.util.LinkedHashSet;
import java.util.Objects;
import java.util.Optional;
import java.util.OptionalLong;
import java.util.Set;
import net.fabricmc.fabric.api.client.event.lifecycle.v1.ClientTickEvents;
import net.fabricmc.fabric.api.client.keymapping.v1.KeyMappingHelper;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayConnectionEvents;
import net.fabricmc.fabric.api.client.networking.v1.ClientPlayNetworking;
import net.minecraft.client.KeyMapping;
import net.minecraft.client.Minecraft;
import net.minecraft.resources.Identifier;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

public final class AgentControlClient {
	public static final int SNAPSHOT_REFRESH_TICKS = 20;
	public static final int HIDDEN_SNAPSHOT_REFRESH_TICKS = 100;
	private static final Logger LOGGER = LoggerFactory.getLogger(AgentControlClient.class);
	private static final KeyMapping.Category KEY_CATEGORY = KeyMapping.Category.register(
			Identifier.fromNamespaceAndPath("mineagen", "controls")
	);
	private static final KeyMapping OPEN_CONTROL = KeyMappingHelper.registerKeyMapping(new KeyMapping(
			"key.mineagen.open_controls",
			McClientCompat.KEYBOARD,
			InputConstants.KEY_G,
			KEY_CATEGORY
	));
	private static final AgentControlSnapshotStore SNAPSHOTS = AgentClientRoster.snapshots();
	private static Preferences preferences = Preferences.defaults();
	private static boolean catalogAuthoritative;
	private static boolean registered;
	private static final Set<String> HIDDEN_AGENT_IDS = new LinkedHashSet<>();
	private static final Set<String> AUTOMATIC_AGENT_IDS = new LinkedHashSet<>();
	private static final Set<String> KNOWN_AGENT_IDS = new LinkedHashSet<>();
	private static int refreshCountdown;
	private static int snapshotContentHash;
	private static String snapshotError = "";
	private static final SnapshotAcknowledgements SNAPSHOT_ACKNOWLEDGEMENTS = new SnapshotAcknowledgements();

	private AgentControlClient() {
	}

	public static synchronized void register() {
		if (registered) {
			return;
		}
		ClientPlayNetworking.registerGlobalReceiver(dev.agaminggod.mineagen.control.LiveTaskViewPayload.Snapshot.TYPE,
				(payload, context) -> context.client().execute(() -> LiveAgentWindows.accept(payload)));
		boolean receiverRegistered = ClientPlayNetworking.registerGlobalReceiver(
				AgentControlSnapshotPayload.TYPE,
				(payload, context) -> context.client().execute(() -> acceptSnapshot(payload.snapshot()))
		);
		if (!receiverRegistered) {
			throw new IllegalStateException("Mineagen control snapshot receiver is already registered");
		}
		ClientTickEvents.END_CLIENT_TICK.register(AgentControlClient::tick);
		ClientPlayConnectionEvents.DISCONNECT.register((handler, client) -> clearConnectionState());
		registered = true;
	}

	public static Optional<AgentControlSnapshot> snapshot() {
		return SNAPSHOTS.current();
	}

	public static Optional<dev.agaminggod.mineagen.control.AgentControlAgent> agentForPlayer(String profileName) {
		return AgentClientRoster.agentForPlayer(profileName);
	}

	public static boolean isAgentPlayer(String profileName) {
		return agentForPlayer(profileName).isPresent();
	}

	public static Preferences preferences() {
		return preferences;
	}

	public static boolean catalogAuthoritative() {
		return catalogAuthoritative;
	}

	public static String openControlKeyLabel() {
		return OPEN_CONTROL.getTranslatedKeyMessage().getString();
	}

	public static Set<String> hiddenAgentIds() {
		return HIDDEN_AGENT_IDS;
	}

	public static Set<String> automaticAgentIds() {
		return AUTOMATIC_AGENT_IDS;
	}

	public static Set<String> knownAgentIds() {
		return KNOWN_AGENT_IDS;
	}

	public static Optional<String> snapshotError() {
		return Optional.of(snapshotError).filter(value -> !value.isBlank());
	}

	public static void rememberPreferences(String provider, String model) {
		preferences = new Preferences(provider, model);
	}

	public static final String LOCAL_KEY_ONLY_REASON = "API keys can only be saved in a world you host on this machine.";

	/** True only when this client hosts its own integrated world over the in-memory connection, so a key never crosses a network. */
	public static boolean canSaveProviderApiKey() {
		Minecraft minecraft = Minecraft.getInstance();
		var listener = minecraft.getConnection();
		return minecraft.hasSingleplayerServer() && listener != null && listener.getConnection().isMemoryConnection();
	}

	/** Credentials use the serverbound payload so they do not enter command or chat logs. Never sent off this machine. */
	public static boolean setProviderApiKey(String provider, String key) {
		try {
			if (!canSaveProviderApiKey()) return false;
			if (!ClientPlayNetworking.canSend(dev.agaminggod.mineagen.control.ProviderApiKeyPayload.TYPE)) return false;
			ClientPlayNetworking.send(new dev.agaminggod.mineagen.control.ProviderApiKeyPayload(provider, key));
			refreshCountdown = 2;
			return true;
		} catch (RuntimeException failure) { return false; }
	}

	public static void requestProviderRescan() {
		if (ClientPlayNetworking.canSend(dev.agaminggod.mineagen.control.ProviderRescanPayload.TYPE)) {
			ClientPlayNetworking.send(dev.agaminggod.mineagen.control.ProviderRescanPayload.INSTANCE);
		}
	}

	public static void requestSnapshot() {
		try {
			if (ClientPlayNetworking.canSend(AgentControlRequestPayload.TYPE)) {
				snapshotError = "";
				ClientPlayNetworking.send(AgentControlRequestPayload.INSTANCE);
				SNAPSHOT_ACKNOWLEDGEMENTS.recordRequest();
			} else {
				snapshotError = "This server does not support the control center";
			}
		} catch (IllegalStateException exception) {
			snapshotError = "The control center is disconnected";
			LOGGER.debug("Mineagen control snapshot request skipped while disconnected");
		}
	}

	public static boolean sendCommand(String command) {
		return sendCommandWithReceipt(command).isPresent();
	}

	public static OptionalLong sendCommandWithReceipt(String command) {
		Minecraft client = Minecraft.getInstance();
		if (client.getConnection() == null) {
			return OptionalLong.empty();
		}
		client.getConnection().sendCommand(Objects.requireNonNull(command, "command must not be null"));
		refreshCountdown = 2;
		return OptionalLong.of(SNAPSHOT_ACKNOWLEDGEMENTS.beginMutation());
	}

	private static void tick(Minecraft client) {
		LiveAgentWindows.tick(client);
		while (OPEN_CONTROL.consumeClick()) {
			if (client.player != null && client.level != null && McClientCompat.screen(client) == null) {
				McClientCompat.setScreen(client, new AgentControlScreen());
				requestSnapshot();
			}
		}
		boolean connected = client.player != null && client.level != null && client.getConnection() != null;
		boolean controlsVisible = McClientCompat.screen(client) instanceof AgentControlScreen;
		SnapshotRefreshPolicy.Tick refresh = SnapshotRefreshPolicy.advance(
				refreshCountdown, connected, controlsVisible,
				SNAPSHOT_REFRESH_TICKS, HIDDEN_SNAPSHOT_REFRESH_TICKS);
		refreshCountdown = refresh.nextCountdown();
		if (refresh.requestSnapshot()) requestSnapshot();
	}

	private static void acceptSnapshot(AgentControlSnapshot nextSnapshot) {
		Objects.requireNonNull(nextSnapshot, "nextSnapshot must not be null");
		long acknowledgedMutationId = SNAPSHOT_ACKNOWLEDGEMENTS.acceptSnapshot();
		AgentControlSnapshot previous = SNAPSHOTS.current().orElse(null);
		if (!SnapshotRevisionPolicy.isNewer(previous, nextSnapshot)) return;
		if (!SNAPSHOTS.accept(nextSnapshot)) {
			return;
		}
		snapshotError = "";
		int nextContentHash = contentHash(nextSnapshot);
		Minecraft client = Minecraft.getInstance();
		if (previous != null && snapshotContentHash == nextContentHash && sameContent(previous, nextSnapshot)) {
			if (McClientCompat.screen(client) instanceof AgentControlScreen screen) {
				screen.acceptSnapshot(nextSnapshot, acknowledgedMutationId, false);
			}
			return;
		}
		snapshotContentHash = nextContentHash;
		AgentControlCatalog.installRuntimeCatalog(nextSnapshot.catalog(), nextSnapshot.providers());
		catalogAuthoritative = true;
		normalizePreferences();
		if (McClientCompat.screen(client) instanceof AgentControlScreen screen) {
			screen.acceptSnapshot(nextSnapshot, acknowledgedMutationId, true);
		}
	}

	private static void clearConnectionState() {
		LiveAgentWindows.disconnect();
		SNAPSHOTS.clear();
		AgentControlCatalog.resetRuntimeCatalog();
		catalogAuthoritative = false;
		refreshCountdown = 0;
		snapshotContentHash = 0;
		snapshotError = "";
		SNAPSHOT_ACKNOWLEDGEMENTS.clear();
	}

	private static int contentHash(AgentControlSnapshot snapshot) {
		return Objects.hash(
				snapshot.canControl(), snapshot.automationAvailable(), snapshot.automationStatus(),
				snapshot.agents(), snapshot.catalog(), snapshot.providers());
	}

	private static boolean sameContent(AgentControlSnapshot left, AgentControlSnapshot right) {
		return left.canControl() == right.canControl()
				&& left.automationAvailable() == right.automationAvailable()
				&& left.automationStatus().equals(right.automationStatus())
				&& left.agents().equals(right.agents())
				&& left.catalog().equals(right.catalog())
				&& left.providers().equals(right.providers());
	}

	private static void normalizePreferences() {
		preferences = Preferences.reconcile(preferences, catalogAuthoritative);
	}

	/**
	 * Only provider and model persist between menu openings; thinking depth and speed deliberately restart at
	 * the catalog defaults (lowest effort, Normal) every time a screen opens.
	 */
	public record Preferences(String provider, String model) {
		/** Blank provider and model mean nothing has been discovered yet. */
		public Preferences {
			provider = Objects.requireNonNull(provider, "provider must not be null");
			model = Objects.requireNonNull(model, "model must not be null");
		}

		private static Preferences defaults() {
			if (AgentControlCatalog.isEmpty()) return new Preferences("", "");
			String provider = AgentControlCatalog.providers().getFirst();
			return new Preferences(provider, AgentControlCatalog.defaultModel(provider));
		}

		static Preferences reconcile(Preferences current, boolean authoritative) {
			Preferences checked = Objects.requireNonNull(current, "preferences must not be null");
			if (!authoritative || AgentControlCatalog.isEmpty()) return checked;
			String provider = AgentControlCatalog.providers().contains(checked.provider())
					? checked.provider() : AgentControlCatalog.providers().getFirst();
			String model = AgentControlCatalog.models(provider).contains(checked.model())
					? checked.model() : AgentControlCatalog.defaultModel(provider);
			return new Preferences(provider, model);
		}
	}

	static final class SnapshotAcknowledgements {
		private final ArrayDeque<Long> requests = new ArrayDeque<>();
		private long nextMutationId;
		private long mutationForNextRequest;

		long beginMutation() {
			mutationForNextRequest = ++nextMutationId;
			return mutationForNextRequest;
		}

		void recordRequest() {
			requests.addLast(mutationForNextRequest);
			mutationForNextRequest = 0L;
		}

		long acceptSnapshot() {
			return requests.isEmpty() ? 0L : requests.removeFirst();
		}

		void clear() {
			requests.clear();
			mutationForNextRequest = 0L;
		}
	}

}
