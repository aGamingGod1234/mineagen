package dev.agaminggod.mineagen.server.pov;

import com.mojang.serialization.JsonOps;
import dev.agaminggod.mineagen.agent.AgentId;
import java.nio.file.Files;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import net.minecraft.core.RegistryAccess;
import net.minecraft.util.datafix.DataFixers;
import net.minecraft.world.level.storage.SavedDataStorage;

/** Offline reports use a fake admission sink; no operator player, coordinator or model is required. */
public final class PovReportOutboxVerification {
	private static int passed;
	public static int verify() {
		passed = 0;
		verifyOfflineRetryOrder();
		verifyIndependentAgentsAndRemoval();
		verifyExpiryAndCapacity();
		verifySavedDataReload();
		verifyOfflineDirectMessagePath();
		verifyShutdownQueuesFinalReport();
		return passed;
	}

	private static void verifyOfflineRetryOrder() {
		var outbox = new PovReportOutbox();
		var agent = AgentId.random();
		var first = report(agent, "first");
		var second = report(agent, "second");
		var outcomes = new ArrayList<PovReportOutbox.Outcome>();
		outbox.enqueue(first, (r, o) -> outcomes.add(o));
		outbox.enqueue(second, (r, o) -> outcomes.add(o));
		outbox.enqueue(first, (r, o) -> outcomes.add(o));
		check(outbox.reports().equals(List.of(first, second)), "separate delivery ids retain both takeovers; same id is idempotent");
		var attempts = new ArrayList<UUID>();
		outbox.drain(1_000L, id -> true, id -> false, r -> {
			attempts.add(r.deliveryId()); return false;
		}, (r, o) -> outcomes.add(o));
		check(attempts.equals(List.of(first.deliveryId())), "unavailable sink retries the head without overtaking it");
		check(outcomes.equals(List.of(PovReportOutbox.Outcome.RETRY)), "retry is observable");
		check(outbox.reports().size() == 2, "retry preserves both reports");
		outbox.drain(2_000L, id -> true, id -> true, r -> { throw new AssertionError("reserved agent"); }, (r, o) -> {});
		check(outbox.reports().size() == 2, "new takeover defers older reports until control is returned");
		var delivered = new ArrayList<PovReportOutbox.Report>();
		outbox.drain(3_000L, id -> true, id -> false, r -> { delivered.add(r); return true; }, (r, o) -> outcomes.add(o));
		outbox.drain(4_000L, id -> true, id -> false, r -> { delivered.add(r); return true; }, (r, o) -> outcomes.add(o));
		check(delivered.equals(List.of(first, second)), "offline operator reports arrive once and in order when sink reconnects");
		check(delivered.getFirst().operatorName().equals("Disconnected operator"), "name survives without a live player lookup");
		check(outcomes.equals(List.of(PovReportOutbox.Outcome.RETRY, PovReportOutbox.Outcome.DELIVERED,
				PovReportOutbox.Outcome.DELIVERED)), "each admission has one observable success");
		check(outbox.isEmpty(), "successful admission acknowledges and removes reports");
	}

	private static void verifyIndependentAgentsAndRemoval() {
		var outbox = new PovReportOutbox();
		var unavailable = AgentId.random();
		var available = AgentId.random();
		outbox.enqueue(report(unavailable, "blocked"), (r, o) -> {});
		outbox.enqueue(report(unavailable, "blocked again"), (r, o) -> {});
		outbox.enqueue(report(available, "available"), (r, o) -> {});
		var delivered = new ArrayList<AgentId>();
		outbox.drain(1_000L, id -> true, id -> false, r -> {
			if (r.agentId().equals(unavailable)) return false;
			delivered.add(r.agentId()); return true;
		}, (r, o) -> {});
		check(delivered.equals(List.of(available)), "one blocked agent does not block others");
		var outcomes = new ArrayList<PovReportOutbox.Outcome>();
		outbox.removeAgent(unavailable, (r, o) -> outcomes.add(o));
		check(outbox.isEmpty() && outcomes.equals(List.of(PovReportOutbox.Outcome.AGENT_REMOVED,
				PovReportOutbox.Outcome.AGENT_REMOVED)), "removal prunes every report for that agent with observable outcomes");
		outbox.enqueue(report(available, "removed while offline"), (r, o) -> {});
		outbox.drain(1_000L, id -> false, id -> false, r -> { throw new AssertionError("removed agent"); }, (r, o) -> outcomes.add(o));
		check(outbox.isEmpty(), "retry also prunes removed agents after reload");
	}

	private static void verifyExpiryAndCapacity() {
		var outbox = new PovReportOutbox();
		var outcomes = new ArrayList<PovReportOutbox.Outcome>();
		for (int index = 0; index <= PovReportOutbox.MAX_REPORTS; index++) {
			outbox.enqueue(report(AgentId.random(), "report " + index), (r, o) -> outcomes.add(o));
		}
		check(outbox.reports().size() == PovReportOutbox.MAX_REPORTS, "outbox is bounded");
		check(outcomes.equals(List.of(PovReportOutbox.Outcome.CAPACITY)), "capacity eviction is observable");
		check(outbox.reports().getFirst().text().equals("report 1"), "capacity discards the oldest entry");
		outbox.drain(301_001L, id -> true, id -> false, r -> { throw new AssertionError("expired report"); }, (r, o) -> outcomes.add(o));
		check(outbox.isEmpty() && outcomes.stream().filter(o -> o == PovReportOutbox.Outcome.EXPIRED).count()
				== PovReportOutbox.MAX_REPORTS, "every expired report has an observable outcome");
	}

	private static void verifySavedDataReload() {
		try {
			var path = Files.createTempDirectory("arena-pov-outbox-");
			var agent = AgentId.random();
			var expected = List.of(report(agent, "before shutdown"), report(agent, "during shutdown"));
			try (var storage = new SavedDataStorage(path, DataFixers.getDataFixer(), RegistryAccess.EMPTY)) {
				var outbox = storage.computeIfAbsent(PovReportOutbox.TYPE);
				for (var report : expected) outbox.enqueue(report, (r, o) -> {});
				storage.saveAndJoin();
			}
			try (var storage = new SavedDataStorage(path, DataFixers.getDataFixer(), RegistryAccess.EMPTY)) {
				var reloaded = storage.computeIfAbsent(PovReportOutbox.TYPE);
				check(reloaded.reports().equals(expected), "real saved-data reload retains ids, order, identity, text and wall-clock expiry");
				reloaded.drain(2_000L, id -> true, id -> false, r -> true, (r, o) -> {});
				storage.saveAndJoin();
			}
			try (var storage = new SavedDataStorage(path, DataFixers.getDataFixer(), RegistryAccess.EMPTY)) {
				check(storage.computeIfAbsent(PovReportOutbox.TYPE).isEmpty(), "acknowledged reports stay absent after another reload");
			}
			var codec = PovReportOutbox.TYPE.codec();
			check(codec.parse(JsonOps.INSTANCE, com.google.gson.JsonParser.parseString("{}")).getOrThrow().isEmpty(),
					"worlds without report data load with an empty outbox");
		} catch (Exception failure) { throw new AssertionError(failure); }
	}

	private static void verifyOfflineDirectMessagePath() {
		try {
			var manager = allocate(dev.agaminggod.mineagen.server.CodexAgentManager.class);
			var saved = new dev.agaminggod.mineagen.server.AgentSavedData();
			set(manager, dev.agaminggod.mineagen.server.CodexAgentManager.class, "savedData", saved);
			var target = saved.registry().create("codex", "gpt-6.1-sol", "low", java.util.Optional.of("POV Agent"), 1_000L);
			var events = new ArrayList<dev.agaminggod.mineagen.server.conversation.ConversationEvent>();
			var router = new dev.agaminggod.mineagen.server.conversation.ServerAgentConversationRouter(manager, (event, goal) -> {
				check(goal.isEmpty(), "historical summaries never compile a replacement goal");
				events.add(event);
			});
			var outbox = new PovReportOutbox();
			var first = report(target.agentId(), "first");
			var second = report(target.agentId(), "second");
			outbox.enqueue(first, (r, o) -> {});
			outbox.enqueue(second, (r, o) -> {});
			outbox.drain(1_000L, saved.registry()::contains, id -> false,
					r -> router.deliverTakeoverReport(r).deliveredIds().contains(r.agentId().toString()), (r, o) -> {});
			check(events.size() == 2 && events.get(0).text().equals("first") && events.get(1).text().equals("second"),
					"real direct-message router delivers both reports without any server or player object");
			check(events.get(0).sourceId().equals(first.operatorId().toString())
					&& events.get(0).sourceName().equals(first.operatorName()), "direct-message event retains historical operator identity");
			check(events.get(0).sequence() < events.get(1).sequence(), "report conversation sequence preserves delivery order");
			check(events.stream().allMatch(e -> e.audience() == dev.agaminggod.mineagen.server.conversation.ConversationAudience.DIRECT
					&& !e.operator()), "historical identity does not grant current operator authority");
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	@SuppressWarnings("unchecked")
	private static void verifyShutdownQueuesFinalReport() {
		try {
			var server = allocate(net.minecraft.server.dedicated.DedicatedServer.class);
			var players = allocate(OfflinePlayers.class);
			set(server, net.minecraft.server.MinecraftServer.class, "playerList", players);
			var manager = allocate(dev.agaminggod.mineagen.server.CodexAgentManager.class);
			var saved = new dev.agaminggod.mineagen.server.AgentSavedData();
			set(manager, dev.agaminggod.mineagen.server.CodexAgentManager.class, "savedData", saved);
			set(manager, dev.agaminggod.mineagen.server.CodexAgentManager.class, "server", server);
			var target = saved.registry().create("codex", "gpt-6.1-sol", "low", java.util.Optional.of("POV Agent"), 1_000L);
			var managersField = dev.agaminggod.mineagen.server.CodexAgentManager.class.getDeclaredField("INSTANCES");
			managersField.setAccessible(true);
			var managers = (java.util.Map<net.minecraft.server.MinecraftServer, dev.agaminggod.mineagen.server.CodexAgentManager>) managersField.get(null);
			var statesField = PovSessionRuntime.class.getDeclaredField("STATES");
			statesField.setAccessible(true);
			var states = (java.util.Map<Object, Object>) statesField.get(null);
			Class<?> stateType = Class.forName(PovSessionRuntime.class.getName() + "$State");
			var constructor = stateType.getDeclaredConstructor(); constructor.setAccessible(true);
			Object state = constructor.newInstance();
			var sessionsField = stateType.getDeclaredField("sessions"); sessionsField.setAccessible(true);
			var sessions = (java.util.Map<UUID, PovSession>) sessionsField.get(state);
			var operator = UUID.randomUUID();
			var controller = (dev.agaminggod.mineagen.pov.OperatorBodyController) java.lang.reflect.Proxy.newProxyInstance(
					PovReportOutboxVerification.class.getClassLoader(), new Class<?>[] {dev.agaminggod.mineagen.pov.OperatorBodyController.class},
					(proxy, method, args) -> null);
			var session = new PovSession(1L, operator, target.agentId(), UUID.randomUUID(), "POV Agent", "POV Agent",
					dev.agaminggod.mineagen.pov.PovMode.TAKEOVER, net.minecraft.world.level.Level.OVERWORLD,
					net.minecraft.world.phys.Vec3.ZERO, 1_000L,
					new PovStatePublisher(1L, dev.agaminggod.mineagen.pov.PovMode.TAKEOVER, UUID.randomUUID(), "POV Agent"), controller, false);
			session.operatorName("Operator before logout");
			sessions.put(operator, session);
			states.put(server, state); managers.put(server, manager);
			try {
				PovSessionRuntime.release(server);
				var reportsField = stateType.getDeclaredField("reports"); reportsField.setAccessible(true);
				var reports = ((PovReportOutbox) reportsField.get(state)).reports();
				check(reports.size() == 1 && reports.getFirst().operatorName().equals("Operator before logout"),
						"actual shutdown release queues the final report with the stored offline identity");
				check(sessions.isEmpty() && !states.containsKey(server), "shutdown still clears sessions and runtime state");
			} finally { states.remove(server); managers.remove(server); }
		} catch (ReflectiveOperationException failure) { throw new AssertionError(failure); }
	}

	private static final class OfflinePlayers extends net.minecraft.server.dedicated.DedicatedPlayerList {
		private OfflinePlayers() { super(null, null, null); }
		@Override public net.minecraft.server.level.ServerPlayer getPlayer(UUID id) { return null; }
		@Override public net.minecraft.server.level.ServerPlayer getPlayerByName(String name) { return null; }
		@Override public List<net.minecraft.server.level.ServerPlayer> getPlayers() { return List.of(); }
	}

	private static <T> T allocate(Class<T> type) throws ReflectiveOperationException {
		var field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); field.setAccessible(true);
		return type.cast(((sun.misc.Unsafe) field.get(null)).allocateInstance(type));
	}

	private static void set(Object target, Class<?> owner, String name, Object value) throws ReflectiveOperationException {
		var field = owner.getDeclaredField(name); field.setAccessible(true); field.set(target, value);
	}

	private static PovReportOutbox.Report report(AgentId agent, String text) {
		return new PovReportOutbox.Report(UUID.randomUUID(), UUID.randomUUID(), "Disconnected operator", agent,
				"minecraft:overworld", text, 1_000L + PovReportOutbox.RETRY_WINDOW_MS);
	}

	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		passed++;
	}
}
