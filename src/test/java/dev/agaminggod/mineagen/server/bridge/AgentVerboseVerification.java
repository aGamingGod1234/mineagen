package dev.agaminggod.mineagen.server.bridge;

import com.google.gson.JsonObject;
import dev.agaminggod.mineagen.server.AgentSavedData;
import dev.agaminggod.mineagen.server.AgentChatSanitizer;
import dev.agaminggod.mineagen.server.AgentManager;
import java.io.BufferedReader;
import java.io.InputStreamReader;
import java.lang.reflect.Field;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.security.MessageDigest;
import java.util.Base64;
import java.util.List;
import java.util.Optional;
import java.util.concurrent.ConcurrentHashMap;

public final class AgentVerboseVerification {
	private AgentVerboseVerification() {
	}

	public static void main(String[] args) {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		int assertions = verify();
		System.out.println("Agent activity event verification passed: " + assertions + " assertions");
	}

	public static int verify() {
		verifyStrictVerboseEventIsAccepted();
		verifyStrictSchemaAndRedaction();
		return 24;
	}

	private static void verifyStrictSchemaAndRedaction() {
		JsonObject valid = verbosePayload("planner", "Planning next action");
		MultiplexedServerBridge.VerboseEvent decoded = MultiplexedServerBridge.decodeVerboseEvent(valid);
		assertEquals(7L, decoded.goalRevision(), "verbose event retains its guarded revision");
		assertEquals("planner", decoded.stage(), "verbose event retains an approved stage");
		assertEquals("Planning next action", decoded.message(), "verbose event retains bounded plain text");
		for (String stage : List.of(
				"conversation", "lifecycle", "planner", "provider", "output", "decision",
				"action", "progress", "result", "retry", "error"
		)) {
			assertEquals(stage, MultiplexedServerBridge.decodeVerboseEvent(verbosePayload(stage, "message")).stage(),
					"wire contract accepts the approved " + stage + " stage");
		}

		JsonObject extra = valid.deepCopy();
		extra.addProperty("prompt", "private task");
		assertThrows(() -> MultiplexedServerBridge.decodeVerboseEvent(extra),
				"verbose events reject extra fields that could smuggle prompt data");
		assertThrows(() -> MultiplexedServerBridge.decodeVerboseEvent(verbosePayload("unknown", "message")),
				"verbose events reject unknown stages");
		assertThrows(() -> MultiplexedServerBridge.decodeVerboseEvent(verbosePayload("output", "x".repeat(257))),
				"verbose events reject messages beyond 256 characters");

		assertEquals("Sensitive details redacted.",
				AgentChatSanitizer.sanitizeMessage("Authorization: Bearer sk-private-token"),
				"credential-shaped text is never sent to Minecraft chat");
		assertEquals("Private prompt details redacted.",
				AgentChatSanitizer.sanitizeMessage("System prompt: private task text"),
				"private prompt text is never sent to Minecraft chat");
		assertEquals("World details redacted.",
				AgentChatSanitizer.sanitizeMessage("Raw observation {\"blocks\":[1,2,3]}"),
				"raw world dumps are never sent to Minecraft chat");
		assertEquals("Technical details hidden.",
				AgentChatSanitizer.sanitizeMessage("{\"directive\":\"replace\",\"summary\":\"Gather wood\"}"),
				"raw planner JSON never reaches Minecraft chat");
		AgentManager manager = uninitializedManager();
		var record = manager.registry().create("gpt-5.6-luna", "high", Optional.of("RedactionAgent"), 1_000L);
		record = manager.registry().start(record.agentId(), "Find the hidden diamond cache", 1_001L).after();
		assertEquals("Private prompt details redacted.",
				AgentChatSanitizer.sanitizeMessage(record, "Find the hidden diamond cache"),
				"unlabelled current prompt text is never sent to Minecraft chat");
	}

	private static JsonObject verbosePayload(String stage, String message) {
		JsonObject payload = new JsonObject();
		payload.addProperty("goalRevision", 7L);
		payload.addProperty("stage", stage);
		payload.addProperty("message", message);
		return payload;
	}

	private static void verifyStrictVerboseEventIsAccepted() {
		MultiplexedServerBridge bridge = null;
		Path secretFile = null;
		try {
			String secret = "fedcba9876543210fedcba9876543210";
			secretFile = Files.createTempFile("mineagen-verbose-event-", ".txt");
			Files.writeString(secretFile, secret);
			AgentManager manager = uninitializedManager();
			var record = manager.registry().create("gpt-5.6-luna", "high", Optional.of("VerboseAgent"), 1_000L);
			manager.registry().start(record.agentId(), "private task text", 1_001L);
			bridge = new MultiplexedServerBridge(manager, 0, secretFile);
			bridge.start();
			BridgeEnvelopeCodec codec = new BridgeEnvelopeCodec();
			try (Socket socket = new Socket(MultiplexedServerBridge.LOOPBACK_HOST, bridge.boundPortForVerification());
				 BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8))) {
				socket.setSoTimeout(1_000);
				sendHello(socket, reader, codec, secret, "hello-verbose-event");
				BridgeEnvelope helloAck = codec.decode(reader.readLine());
				assertEquals("hello_ack", helloAck.type(), "event fixture authenticates");

				JsonObject event = new JsonObject();
				event.addProperty("goalRevision", 1L);
				event.addProperty("stage", "planner");
				event.addProperty("message", "Planning next action");
				socket.getOutputStream().write(codec.encode(new BridgeEnvelope(
						2, helloAck.serverInstanceId(), record.agentId().toString(), "verbose_event", "verbose-event-1", event
				)).getBytes(StandardCharsets.UTF_8));
				socket.getOutputStream().flush();

				JsonObject heartbeat = new JsonObject();
				socket.getOutputStream().write(codec.encode(new BridgeEnvelope(
						2, helloAck.serverInstanceId(), "server", "heartbeat", "verbose-heartbeat-1", heartbeat
				)).getBytes(StandardCharsets.UTF_8));
				socket.getOutputStream().flush();
				BridgeEnvelope response = pollBridgeResponse(bridge, socket, reader, codec);
				assertEquals("heartbeat", response.type(), "strict verbose events preserve the authenticated session");
			}
		} catch (AssertionError error) {
			throw error;
		} catch (Exception exception) {
			throw new AssertionError("verbose event verification failed", exception);
		} finally {
			if (bridge != null) bridge.close();
			if (secretFile != null) {
				try {
					Files.deleteIfExists(secretFile);
				} catch (java.io.IOException exception) {
					throw new AssertionError("could not remove temporary event secret", exception);
				}
			}
		}
	}

	private static AgentManager uninitializedManager() {
		try {
			Field field = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			field.setAccessible(true);
			sun.misc.Unsafe unsafe = (sun.misc.Unsafe) field.get(null);
			AgentManager manager = (AgentManager) unsafe.allocateInstance(AgentManager.class);
			Field savedData = AgentManager.class.getDeclaredField("savedData");
			unsafe.putObject(manager, unsafe.objectFieldOffset(savedData), new AgentSavedData());
			Field pendingRegistrations = AgentManager.class.getDeclaredField("pendingAgentRegistrations");
			unsafe.putObject(manager, unsafe.objectFieldOffset(pendingRegistrations), ConcurrentHashMap.newKeySet());
			return manager;
		} catch (ReflectiveOperationException exception) {
			throw new AssertionError("could not allocate verbose-only manager", exception);
		}
	}

	private static void sendHello(Socket socket, BufferedReader reader, BridgeEnvelopeCodec codec, String secret, String messageId)
			throws Exception {
		String clientNonce = Base64.getUrlEncoder().withoutPadding().encodeToString(
				MessageDigest.getInstance("SHA-256").digest(messageId.getBytes(StandardCharsets.UTF_8))
		);
		JsonObject challenge = new JsonObject();
		challenge.addProperty("clientNonce", clientNonce);
		socket.getOutputStream().write(codec.encode(new BridgeEnvelope(
				2, "pending", "server", "auth_challenge", messageId + "-challenge", challenge
		)).getBytes(StandardCharsets.UTF_8));
		socket.getOutputStream().flush();
		BridgeEnvelope response = codec.decode(reader.readLine());
		String serverNonce = response.payload().get("serverNonce").getAsString();
		JsonObject hello = new JsonObject();
		hello.addProperty("replyTo", response.messageId());
		hello.addProperty("clientNonce", clientNonce);
		hello.addProperty("serverNonce", serverNonce);
		hello.addProperty("proof", MultiplexedServerBridge.authenticationProof(
				secret, "coordinator", clientNonce, serverNonce, response.serverInstanceId(), null
		));
		socket.getOutputStream().write(codec.encode(new BridgeEnvelope(
				2, response.serverInstanceId(), "server", "hello", messageId, hello
		)).getBytes(StandardCharsets.UTF_8));
		socket.getOutputStream().flush();
	}

	private static BridgeEnvelope pollBridgeResponse(
			MultiplexedServerBridge bridge,
			Socket socket,
			BufferedReader reader,
			BridgeEnvelopeCodec codec
	) throws Exception {
		return MultiplexedServerBridgeVerification.pollBridgeResponse(bridge, socket, reader, codec);
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!java.util.Objects.equals(expected, actual)) {
			throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
		}
	}

	private static void assertThrows(Runnable action, String label) {
		try {
			action.run();
		} catch (BridgeProtocolException exception) {
			return;
		}
		throw new AssertionError(label);
	}
}
