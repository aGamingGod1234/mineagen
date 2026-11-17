package dev.agaminggod.mineagen.server.bridge;

import com.google.gson.JsonObject;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.server.runtime.ServerActionExecutor;
import java.util.Map;
import java.util.WeakHashMap;

/**
 * One-way taps out of the bridge for server-side audits: what was delivered to the coordinator and when the model
 * last sent work. Data only flows out; nothing a listener does can reach an observation, wake or tool result, and the
 * bridge does not know who listens.
 */
public final class BridgeTap {
	public interface Listener {
		/** An observation the coordinator accepted; the tree must only be read, never kept or changed. */
		void observationDelivered(AgentId agentId, JsonObject delivery);

		void modelMessage(AgentId agentId, String type, String programId, long programVersion);

		default void actionResult(AgentId agentId, String actionType, String state, String reasonCode) {
		}

		/** A validated action command; {@code issuer} is the coordinator's explicit field, null from one that predates it. */
		default void actionAccepted(AgentId agentId, String actionId, String actionType, String programId, String sourceStepId, String issuer) {
		}
	}

	private static volatile Listener listener;
	private static final Map<net.minecraft.server.MinecraftServer, ServerActionExecutor> EXECUTORS = new WeakHashMap<>();

	private BridgeTap() {
	}

	public static void listen(Listener value) {
		listener = value;
	}

	static synchronized void bind(net.minecraft.server.MinecraftServer server, ServerActionExecutor executor) {
		if (server != null) EXECUTORS.put(server, executor);
	}

	public static synchronized ServerActionExecutor executor(net.minecraft.server.MinecraftServer server) {
		return server == null ? null : EXECUTORS.get(server);
	}

	static void delivered(AgentId agentId, JsonObject delivery) {
		Listener current = listener;
		if (current == null) return;
		try {
			current.observationDelivered(agentId, delivery);
		} catch (RuntimeException ignored) {
			// An audit must never disturb delivery.
		}
	}

	static void result(AgentId agentId, String actionType, String state, String reasonCode) {
		Listener current = listener;
		if (current == null) return;
		try {
			current.actionResult(agentId, actionType, state, reasonCode);
		} catch (RuntimeException ignored) {
			// An audit must never disturb the bridge.
		}
	}

	static void accepted(AgentId agentId, String actionId, String actionType, String programId, String sourceStepId, String issuer) {
		Listener current = listener;
		if (current == null) return;
		try {
			current.actionAccepted(agentId, actionId, actionType, programId, sourceStepId, issuer);
		} catch (RuntimeException ignored) {
			// An audit must never disturb the bridge.
		}
	}

	static void model(AgentId agentId, String type, String programId, long programVersion) {
		Listener current = listener;
		if (current == null) return;
		try {
			current.modelMessage(agentId, type, programId, programVersion);
		} catch (RuntimeException ignored) {
			// An audit must never disturb the bridge.
		}
	}
}
