package dev.agaminggod.mineagen.server;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.agaminggod.mineagen.server.bridge.BridgeEnvelope;
import dev.agaminggod.mineagen.server.bridge.BridgeEnvelopeCodec;

import java.io.BufferedReader;
import java.io.BufferedWriter;
import java.io.ByteArrayInputStream;
import java.io.IOException;
import java.io.InputStreamReader;
import java.io.OutputStreamWriter;
import java.io.RandomAccessFile;
import java.net.InetAddress;
import java.net.ServerSocket;
import java.net.Socket;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.util.ArrayList;
import java.util.Base64;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HexFormat;
import java.util.List;
import java.util.Map;
import java.util.Properties;
import javax.crypto.Mac;
import javax.crypto.spec.SecretKeySpec;

public final class CoordinatorStartupSmokeVerification {
	private static final long STARTUP_TIMEOUT_MS = 15_000L;

	private CoordinatorStartupSmokeVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		if (arguments.length != 0) throw new IllegalArgumentException("Coordinator startup smoke takes no arguments");
		verify();
	}

	public static int verify() throws Exception {
		verifyCatalogPredicate();
		Path sourceCoordinator = Path.of("coordinator").toAbsolutePath().normalize();
		if (!Files.isRegularFile(sourceCoordinator.resolve("src/dynamic-main.mjs"))) {
			throw new AssertionError("startup smoke requires the coordinator source package");
		}
		Path packageRoot = Files.createTempDirectory("arena-startup-smoke");
		String oldPackageRoot = System.getProperty("mineagen.packageRoot");
		String oldNodePath = System.getProperty(NodeRuntimeLocator.PROPERTY);
		String oldBridgeSecret = System.getProperty("mineagen.bridgeSecretFile");
		String oldVoiceSecret = System.getProperty("mineagen.voiceSecretFile");
		String oldVoiceUrl = System.getProperty("mineagen.voiceUrl");
		String oldVoiceRequestTimeout = System.getProperty("mineagen.voiceRequestTimeoutMs");
		CoordinatorProcessSupervisor supervisor = null;
		Throwable primaryFailure = null;
		try {
			int cleanupAssertions = verifyFixtureCleanup(packageRoot);
			int trustBoundaryAssertions = verifyPathRejectedBeforeSecretRead(
					packageRoot.resolve("path-rejection"), oldPackageRoot, oldNodePath
			);
			stageCoordinator(sourceCoordinator, packageRoot);
			System.setProperty("mineagen.packageRoot", packageRoot.toString());
			assertEquals(2, CoordinatorProcessSupervisor.ownershipRoots(packageRoot.resolve("game")).size(),
					"startup checks default and configured ownership roots");
			assertEquals(packageRoot.toAbsolutePath().normalize(),
					CoordinatorProcessSupervisor.ownershipRoots(packageRoot.resolve("game")).getFirst(),
					"custom package ownership is reaped before launch");
			int credentialAssertions = verifyOptionalVoiceCredential(packageRoot.resolve("credential-test"));
			Path node = stageBundledNode(packageRoot);
			FakeCodexEnvironment fakeCodex = stageFakeCodex(packageRoot, node);
			Path secret = packageRoot.resolve("runtime/bridge-secret.txt");
			Files.createDirectories(secret.getParent());
			Files.writeString(secret, "s".repeat(32), StandardCharsets.UTF_8);
			Files.writeString(
					packageRoot.resolve("runtime/fish-api-key.txt"),
					"test-fish-api-key",
					StandardCharsets.UTF_8
			);
			System.clearProperty(NodeRuntimeLocator.PROPERTY);
			System.clearProperty("mineagen.bridgeSecretFile");
			System.clearProperty("mineagen.voiceSecretFile");
			System.clearProperty("mineagen.voiceUrl");
			System.clearProperty("mineagen.voiceRequestTimeoutMs");

			try (ServerSocket bridge = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
				int voicePort = unusedLoopbackPort();
				writeSmokeConfig(packageRoot, bridge.getLocalPort(), voicePort);
				Map<String, String> isolatedEnvironment = new HashMap<>();
				isolatedEnvironment.put("PATH", fakeCodex.path());
				isolatedEnvironment.put("APPDATA", fakeCodex.appData().toString());
				isolatedEnvironment.put("FISH_AUDIO_API_KEY", "");
				isolatedEnvironment.put("FISH_API_KEY", "");
				supervisor = new CoordinatorProcessSupervisor(packageRoot.resolve("game"), isolatedEnvironment);
				long configurationDeadline = System.currentTimeMillis() + STARTUP_TIMEOUT_MS;
				while (!supervisor.configured() && System.currentTimeMillis() < configurationDeadline) {
					supervisor.tick(false);
					Thread.sleep(10L);
				}
				assertTrue(supervisor.configured(), "staged package is configured");
				assertEquals(bridge.getLocalPort(), supervisor.bridgePort(),
					"production supervisor publishes the nondefault coordinator bridge port");
				assertEquals("http://127.0.0.1:" + voicePort + "/v1/tts", System.getProperty("mineagen.voiceUrl"),
					"coordinator shares the existing optional voice endpoint before startup");
				assertEquals("91234", System.getProperty("mineagen.voiceRequestTimeoutMs"),
					"coordinator local inference deadline is shared with the addon before voice startup");
				assertEquals(node.toAbsolutePath().normalize(), NodeRuntimeLocator.locate(packageRoot).executable(),
						"bundled runtime is selected before the empty PATH");

				long deadline = System.currentTimeMillis() + STARTUP_TIMEOUT_MS;
				while (System.currentTimeMillis() < deadline && supervisor.failureCode() == null) {
					supervisor.tick(false);
					if (bridge.getSoTimeout() == 0) bridge.setSoTimeout(250);
					try (Socket socket = bridge.accept()) {
						socket.setSoTimeout(15_000);
						boolean catalogReady;
						try {
							catalogReady = completeHandshakeAndCatalog(socket);
						} catch (AssertionError catalogFailure) {
							throw new AssertionError(catalogFailure.getMessage() + System.lineSeparator() + coordinatorLogTails(packageRoot), catalogFailure);
						}
						if (catalogReady) {
							assertTrue(awaitLoopbackListener(voicePort, 5_000L),
								"runtime Fish credential starts the loopback voice worker");
							return 16 + credentialAssertions + trustBoundaryAssertions + cleanupAssertions;
						}
					} catch (java.net.SocketTimeoutException ignored) {
						// The supervisor's startup grace is intentionally polled without shell state.
					}
					Thread.sleep(100L);
				}
				Path errorLog = packageRoot.resolve("game/logs/mineagen-coordinator-error.log");
				String errorDetail = Files.isRegularFile(errorLog)
						? Files.readString(errorLog, StandardCharsets.UTF_8)
						: "<missing coordinator error log>";
				throw new AssertionError("staged coordinator did not reach the catalog-ready boundary: "
						+ supervisor.failureCode() + "\n" + errorDetail);
			}
		} catch (Exception | Error failure) {
			primaryFailure = failure;
			throw failure;
		} finally {
			// Capture before close clears ownership and deletion removes the logs and runtime image.
			CleanupEvidence evidence = cleanupEvidence(packageRoot);
			String logs = coordinatorLogTails(packageRoot);
			CoordinatorProcessSupervisor closingSupervisor = supervisor;
			finishCleanup(primaryFailure,
					() -> { if (closingSupervisor != null) closingSupervisor.close(); },
					() -> {
						if (closingSupervisor == null) return;
						try {
							long ownershipDeadline = System.currentTimeMillis() + 5_000L;
							while (Files.exists(CoordinatorProcessOwnership.ownershipFile(packageRoot))
									&& System.currentTimeMillis() < ownershipDeadline) Thread.sleep(25L);
							assertTrue(!Files.exists(CoordinatorProcessOwnership.ownershipFile(packageRoot)),
									"coordinator close clears the ownership record");
						} catch (InterruptedException interrupted) {
							Thread.currentThread().interrupt();
							throw new AssertionError("ownership cleanup wait was interrupted", interrupted);
						}
					},
					() -> {
						restoreProperty("mineagen.packageRoot", oldPackageRoot);
						restoreProperty(NodeRuntimeLocator.PROPERTY, oldNodePath);
						restoreProperty("mineagen.bridgeSecretFile", oldBridgeSecret);
						restoreProperty("mineagen.voiceSecretFile", oldVoiceSecret);
						restoreProperty("mineagen.voiceUrl", oldVoiceUrl);
						restoreProperty("mineagen.voiceRequestTimeoutMs", oldVoiceRequestTimeout);
					},
					() -> {
						try {
							deleteTree(packageRoot, evidence.identities());
						} catch (Exception | Error failure) {
							try {
								failure.addSuppressed(new IOException("Startup smoke cleanup evidence (observations, not lock ownership):\n"
										+ evidence + "\nObserved identities still alive: "
										+ evidence.identities().stream().filter(CoordinatorProcessOwnership.ProcessIdentity::isAlive).toList()
										+ "\nAt deletion failure: " + cleanupEvidence(packageRoot) + "\n" + logs));
							} catch (Exception diagnosticFailure) {
								failure.addSuppressed(diagnosticFailure);
							}
							throw failure;
						}
					});
		}
	}

	@FunctionalInterface
	private interface CleanupAction {
		void run() throws Exception;
	}

	/** Like try-with-resources: keep the primary failure and still attempt every cleanup action. */
	private static void finishCleanup(Throwable primary, CleanupAction... actions) throws Exception {
		Throwable failure = primary;
		for (CleanupAction action : actions) {
			try {
				action.run();
			} catch (Exception | Error cleanupFailure) {
				if (failure == null) failure = cleanupFailure;
				else failure.addSuppressed(cleanupFailure);
			}
		}
		if (primary == null) {
			if (failure instanceof Exception exception) throw exception;
			if (failure instanceof Error error) throw error;
		}
	}

	private record CleanupEvidence(String observations, List<CoordinatorProcessOwnership.ProcessIdentity> identities) {
	}

	private static CleanupEvidence cleanupEvidence(Path root) {
		StringBuilder observations = new StringBuilder();
		List<CoordinatorProcessOwnership.ProcessIdentity> identities = new ArrayList<>();
		try {
			Path ownership = CoordinatorProcessOwnership.ownershipFile(root);
			observations.append("ownershipRecordPresent=").append(Files.exists(ownership)).append('\n');
			if (Files.exists(ownership)) {
				Properties record = new Properties();
				try (var reader = Files.newBufferedReader(ownership, StandardCharsets.UTF_8)) { record.load(reader); }
				var identity = new CoordinatorProcessOwnership.ProcessIdentity(
						Long.parseLong(record.getProperty("pid")), Long.parseLong(record.getProperty("startedAtEpochMs")));
				observations.append("recorded root=").append(identity).append(" alive=").append(identity.isAlive()).append('\n');
				identities.add(identity);
				identity.resolve().ifPresent(process -> {
					observeProcess(process, "recorded-root", observations, identities);
					try (var descendants = process.descendants()) {
						descendants.forEach(child -> observeProcess(child, "observed-root-descendant", observations, identities));
					}
				});
			}
			Path node = isWindows() ? root.resolve("runtime/toolchains/node/node.exe")
					: root.resolve("runtime/toolchains/node/bin/node");
			if (Files.exists(node)) {
				Path hostNode = findHostNode();
				observations.append("stagedNode=").append(node).append(" hostNode=").append(hostNode)
						.append(" sameFile=").append(Files.isSameFile(node, hostNode)).append('\n');
			}
			// A hardlink can share its image with unrelated host Node processes. Never terminate these candidates.
			try (var processes = ProcessHandle.allProcesses()) {
				processes.forEach(process -> process.info().command().ifPresent(command -> {
					try {
						if (Files.isSameFile(node, Path.of(command))) {
							observeProcess(process, "same-runtime-image-candidate", observations, identities);
						}
					} catch (IOException | RuntimeException ignored) {
						// Processes can exit or deny image access during enumeration.
					}
				}));
			}
		} catch (Exception unavailable) {
			observations.append("process evidence unavailable: ").append(unavailable);
		}
		return new CleanupEvidence(observations.toString(), List.copyOf(identities));
	}

	private static void observeProcess(ProcessHandle process, String relationship, StringBuilder observations,
			List<CoordinatorProcessOwnership.ProcessIdentity> identities) {
		var info = process.info();
		CoordinatorProcessOwnership.ProcessIdentity.from(process).ifPresent(identities::add);
		observations.append(relationship).append(" pid=").append(process.pid())
				.append(" start=").append(info.startInstant()).append(" command=").append(info.command())
				.append(" parentPid=").append(process.parent().map(ProcessHandle::pid)).append('\n');
	}

	/** The last 4 KB of each coordinator log, so a CI-only startup failure explains itself. */
	private static String coordinatorLogTails(Path packageRoot) {
		StringBuilder tails = new StringBuilder();
		try (var logs = Files.list(packageRoot.resolve("game/logs"))) {
			for (Path log : logs.sorted().toList()) {
				String text = Files.readString(log, StandardCharsets.UTF_8);
				tails.append("--- ").append(log.getFileName()).append(System.lineSeparator())
						.append(text.substring(Math.max(0, text.length() - 4096))).append(System.lineSeparator());
			}
		} catch (Exception unreadable) {
			tails.append("<coordinator logs unavailable: ").append(unreadable).append('>');
		}
		return tails.toString();
	}

	private static boolean completeHandshakeAndCatalog(Socket socket) throws Exception {
		BridgeEnvelopeCodec codec = new BridgeEnvelopeCodec();
		try (BufferedReader reader = new BufferedReader(new InputStreamReader(socket.getInputStream(), StandardCharsets.UTF_8));
			 BufferedWriter writer = new BufferedWriter(new OutputStreamWriter(socket.getOutputStream(), StandardCharsets.UTF_8))) {
			String secret = "s".repeat(32);
			JsonObject challenge = JsonParser.parseString(reader.readLine()).getAsJsonObject();
			assertEquals("auth_challenge", challenge.get("type").getAsString(),
					"coordinator starts without releasing a secret-derived proof");
			String clientNonce = challenge.getAsJsonObject("payload").get("clientNonce").getAsString();
			String serverNonce = Base64.getUrlEncoder().withoutPadding().encodeToString(
					MessageDigest.getInstance("SHA-256").digest("startup-smoke-server".getBytes(StandardCharsets.UTF_8))
			);
			JsonObject authPayload = new JsonObject();
			authPayload.addProperty("replyTo", challenge.get("messageId").getAsString());
			authPayload.addProperty("clientNonce", clientNonce);
			authPayload.addProperty("serverNonce", serverNonce);
			authPayload.addProperty("proof", authenticationProof(
					secret, "server", clientNonce, serverNonce, "startup-smoke-server", null
			));
			writer.write(codec.encode(new BridgeEnvelope(
					2, "startup-smoke-server", "server", "auth_response", "startup-smoke-auth", authPayload
			)));
			writer.flush();
			String helloLine = reader.readLine();
			JsonObject hello = JsonParser.parseString(helloLine).getAsJsonObject();
			assertEquals("hello", hello.get("type").getAsString(), "coordinator authenticates after the server proof");
			String launchId = hello.getAsJsonObject("payload").get("launchId").getAsString();
			java.util.UUID.fromString(launchId);
			assertEquals(
					authenticationProof(secret, "coordinator", clientNonce, serverNonce, "startup-smoke-server", launchId),
					hello.getAsJsonObject("payload").get("proof").getAsString(),
					"coordinator proof is bound to both nonces and the staged launch identity"
			);
			JsonObject payload = new JsonObject();
			payload.addProperty("replyTo", hello.get("messageId").getAsString());
			payload.addProperty("authenticated", true);
			payload.add("registry", new JsonArray());
			payload.addProperty("launchId", launchId);
			writer.write(codec.encode(new BridgeEnvelope(
					2,
					"startup-smoke-server",
					"server",
					"hello_ack",
					"startup-smoke-ack",
					payload
			)));
			writer.flush();
			boolean discoveryRequested = false;
			boolean stagedModelReady = false;
			long acknowledgedAt = System.currentTimeMillis();
			long deadline = acknowledgedAt + STARTUP_TIMEOUT_MS;
			String lateProcessTree = null;
			while (System.currentTimeMillis() < deadline) {
				String line = reader.readLine();
				// The coordinator stops at its 15 s heartbeat deadline; record what discovery is waiting on before then.
				if (lateProcessTree == null && System.currentTimeMillis() - acknowledgedAt >= 12_000L) lateProcessTree = processTreeSnapshot();
				if (line == null) break;
				JsonObject message = JsonParser.parseString(line).getAsJsonObject();
				if (!"catalog_snapshot".equals(message.get("type").getAsString())) continue;
				JsonArray models = message.getAsJsonObject("payload").getAsJsonArray("models");
				if (containsStagedModel(models)) {
					stagedModelReady = true;
					break;
				}
				if (discoveryRequested) continue;
				discoveryRequested = true;
				writer.write(codec.encode(new BridgeEnvelope(
						2,
						"startup-smoke-server",
						"server",
						"catalog_request",
						"startup-smoke-catalog-request",
						new JsonObject()
				)));
				writer.flush();
			}
			assertTrue(stagedModelReady, "catalog-ready boundary contains the unique fake discovery result"
					+ (lateProcessTree == null ? "" : System.lineSeparator() + lateProcessTree));
			return true;
		}
	}

	private static String processTreeSnapshot() {
		StringBuilder tree = new StringBuilder("--- process tree 12 s after hello_ack").append(System.lineSeparator());
		long now = System.currentTimeMillis();
		ProcessHandle.current().descendants().forEach(process -> {
			ProcessHandle.Info info = process.info();
			tree.append(process.pid())
					.append(" parent=").append(process.parent().map(ProcessHandle::pid).map(String::valueOf).orElse("?"))
					.append(" age=").append(info.startInstant().map(start -> (now - start.toEpochMilli()) + "ms").orElse("?"))
					.append(" cpu=").append(info.totalCpuDuration().map(cpu -> cpu.toMillis() + "ms").orElse("?"))
					// The wrapper's command line ends in its base64 environment; the head names the process.
					.append(' ').append(info.commandLine().or(info::command).map(line -> line.substring(0, Math.min(line.length(), 200))).orElse("?"))
					.append(System.lineSeparator());
		});
		return tree.toString();
	}

	static boolean containsStagedModel(JsonArray models) {
		if (models == null) return false;
		for (var element : models) {
			if (!element.isJsonObject()) continue;
			JsonObject model = element.getAsJsonObject();
			if (new com.google.gson.JsonPrimitive("codex").equals(model.get("provider"))
					&& new com.google.gson.JsonPrimitive("gpt-5.6-luna").equals(model.get("id"))
					&& new com.google.gson.JsonPrimitive("Smoke model").equals(model.get("displayName"))) return true;
		}
		return false;
	}

	static void verifyCatalogPredicate() {
		JsonArray models = JsonParser.parseString("[{\"provider\":\"codex\",\"id\":\"gpt-5.6-luna\",\"displayName\":\"gpt-5.6-luna\"}]").getAsJsonArray();
		assertTrue(!containsStagedModel(models), "builtin fallback cannot satisfy discovery smoke");
		models.get(0).getAsJsonObject().addProperty("displayName", "Smoke model");
		assertTrue(containsStagedModel(models), "fake live discovery satisfies smoke");
		models.get(0).getAsJsonObject().addProperty("provider", "other");
		assertTrue(!containsStagedModel(models), "another provider cannot satisfy discovery smoke");
		assertTrue(!containsStagedModel(JsonParser.parseString("[null,{},\"gpt-5.6-luna Smoke model\"]").getAsJsonArray()),
				"malformed rows and serialized substrings cannot satisfy discovery smoke");
	}

	private static int verifyPathRejectedBeforeSecretRead(
			Path root,
			String oldPackageRoot,
			String oldNodePath
	) throws Exception {
		Path maliciousDirectory = root.resolve("malicious-path");
		Path maliciousNode = maliciousDirectory.resolve(isWindows() ? "node.exe" : "node");
		Files.createDirectories(maliciousDirectory);
		stageHostNode(maliciousNode);
		Path invalidSecret = root.resolve("runtime/bridge-secret.txt");
		Files.createDirectories(invalidSecret);
		Map<String, String> maliciousPath = new HashMap<>();
		maliciousPath.put("PATH", maliciousDirectory.toString());
		CoordinatorProcessSupervisor blocked = null;
		try {
			System.setProperty("mineagen.packageRoot", root.toString());
			System.clearProperty(NodeRuntimeLocator.PROPERTY);
			blocked = new CoordinatorProcessSupervisor(root.resolve("game"), maliciousPath);
			long deadline = System.currentTimeMillis() + STARTUP_TIMEOUT_MS;
			while (blocked.failureCode() == null && System.currentTimeMillis() < deadline) {
				blocked.tick(false);
				Thread.sleep(10L);
			}
			assertEquals("NODE_RUNTIME_NOT_FOUND", blocked.failureCode(),
					"malicious PATH cannot satisfy coordinator Node trust");
			assertTrue(Files.isDirectory(invalidSecret),
					"Node trust fails before the bridge secret target is examined");
			assertTrue(!Files.exists(root.resolve("coordinator")),
					"Node trust fails before coordinator installation reads or creates secrets");
			return 3;
		} finally {
			if (blocked != null) blocked.close();
			restoreProperty("mineagen.packageRoot", oldPackageRoot);
			restoreProperty(NodeRuntimeLocator.PROPERTY, oldNodePath);
			deleteTree(root);
		}
	}

	private static String authenticationProof(
			String secret,
			String role,
			String clientNonce,
			String serverNonce,
			String serverInstanceId,
			String launchId
	) throws Exception {
		String context = String.join("\0", "mineagen-v2", role, clientNonce, serverNonce, serverInstanceId)
				+ ("coordinator".equals(role) ? "\0" + (launchId == null ? "" : launchId) : "");
		Mac mac = Mac.getInstance("HmacSHA256");
		mac.init(new SecretKeySpec(secret.getBytes(StandardCharsets.UTF_8), "HmacSHA256"));
		return Base64.getUrlEncoder().withoutPadding().encodeToString(
				mac.doFinal(context.getBytes(StandardCharsets.UTF_8))
		);
	}

	private static void stageCoordinator(Path source, Path root) throws IOException {
		String manifest = coordinatorManifest(source);
		BundledCoordinatorInstaller.install(root, resourcePath -> {
			String prefix = "mineagen/coordinator/";
			if (!resourcePath.startsWith(prefix)) throw new IOException("Unexpected coordinator resource: " + resourcePath);
			String relative = resourcePath.substring(prefix.length());
			if (relative.equals("coordinator-manifest.txt")) {
				return new ByteArrayInputStream(manifest.getBytes(StandardCharsets.UTF_8));
			}
			Path file = source.resolve(relative).normalize();
			if (!file.startsWith(source) || !Files.isRegularFile(file)) {
				throw new IOException("Missing coordinator fixture resource: " + relative);
			}
			return Files.newInputStream(file);
		});
	}

	private static String coordinatorManifest(Path source) throws IOException {
		List<Path> files = new ArrayList<>();
		for (String fixed : List.of("package.json", "package-lock.json")) {
			Path file = source.resolve(fixed);
			if (Files.isRegularFile(file)) files.add(file);
		}
		for (String directory : List.of("config", "src", "node_modules/acorn")) {
			try (var paths = Files.walk(source.resolve(directory))) {
				paths.filter(Files::isRegularFile).forEach(files::add);
			}
		}
		files.sort(Comparator.comparing(file -> source.relativize(file).toString().replace('\\', '/')));
		StringBuilder manifest = new StringBuilder();
		for (Path file : files) {
			manifest.append(sha256(Files.readAllBytes(file))).append(' ')
					.append(source.relativize(file).toString().replace('\\', '/')).append('\n');
		}
		return manifest.toString();
	}

	private static String sha256(byte[] bytes) {
		try {
			return HexFormat.of().formatHex(MessageDigest.getInstance("SHA-256").digest(bytes));
		} catch (NoSuchAlgorithmException impossible) {
			throw new IllegalStateException(impossible);
		}
	}

	private static Path stageBundledNode(Path root) throws IOException {
		Path bundled = isWindows()
				? root.resolve("runtime/toolchains/node/node.exe")
				: root.resolve("runtime/toolchains/node/bin/node");
		Files.createDirectories(bundled.getParent());
		stageHostNode(bundled);
		return bundled;
	}

	private static void stageHostNode(Path target) throws IOException {
		Path hostNode = findHostNode();
		try {
			Files.createLink(target, hostNode);
		} catch (IOException linkUnavailable) {
			// The fallback is temporary test state only; no runtime binary is stored in git or the release archive.
			Files.copy(hostNode, target, StandardCopyOption.REPLACE_EXISTING);
		}
	}

	private static FakeCodexEnvironment stageFakeCodex(Path root, Path node) throws IOException {
		Path entrypoint = root.resolve("fake-appdata/npm/node_modules/@openai/codex/bin/codex.js");
		Files.createDirectories(entrypoint.getParent());
		Files.writeString(entrypoint, """
				import readline from 'node:readline';
				const input = readline.createInterface({ input: process.stdin });
				input.on('line', (line) => {
					const request = JSON.parse(line);
					if (!Object.hasOwn(request, 'id')) return;
					const result = request.method === 'model/list'
						? { data: [{ id: 'gpt-5.6-luna', model: 'gpt-5.6-luna', displayName: 'Smoke model', supportedReasoningEfforts: ['xhigh'], serviceTiers: ['fast'] }] }
						: {};
					process.stdout.write(JSON.stringify({ id: request.id, result }) + '\\n');
				});
				""", StandardCharsets.UTF_8);
		Path appData = root.resolve("fake-appdata");
		if (isWindows()) return new FakeCodexEnvironment(appData, "");
		Path bin = root.resolve("fake-bin");
		Path launcher = bin.resolve("codex");
		Files.createDirectories(bin);
		Files.writeString(launcher, "#!/bin/sh\nexec " + shellQuote(node) + " " + shellQuote(entrypoint) + " \"$@\"\n",
				StandardCharsets.UTF_8);
		if (!launcher.toFile().setExecutable(true, true) && !Files.isExecutable(launcher)) {
			throw new IOException("could not make the fake Codex launcher executable");
		}
		return new FakeCodexEnvironment(appData, bin.toString());
	}

	private static String shellQuote(Path path) {
		return "'" + path.toString().replace("'", "'\"'\"'") + "'";
	}

	private static void writeSmokeConfig(Path root, int port, int voicePort) throws IOException {
		String config = """
				{
				  "bridge": { "host": "127.0.0.1", "port": %d, "secretEnvironmentVariable": "ARENA_AGENT_BRIDGE_SECRET", "reconnectDelayMs": 50, "maxReconnectDelayMs": 100 },
				  "codex": { "cwd": "%s", "planningTimeoutMs": 1000, "catalogTtlMs": 60000, "serviceTier": "fast", "launchProfile": { "model": "gpt-5.6-luna", "reasoningEffort": "xhigh", "serviceTier": "fast" } },
				  "voice": { "port": %d, "maxConcurrent": 1, "localSpeechTimeoutMs": 91234 },
				  "limits": { "agentCap": 1, "goalQueueCap": 1, "planningConcurrency": 1, "planningMode": "fixed", "urgentReserve": 0, "invalidDecisionRetries": 0 }
				}
				""".formatted(port, root.toString().replace("\\", "\\\\"), voicePort);
		Files.createDirectories(root.resolve("runtime"));
		Files.writeString(root.resolve("runtime/dynamic-agents.json"), config, StandardCharsets.UTF_8);
	}

	private static int verifyOptionalVoiceCredential(Path runtimeRoot) throws IOException {
		Path credential = runtimeRoot.resolve("runtime/fish-api-key.txt");
		Files.createDirectories(credential.getParent());
		Files.writeString(credential, "bad", StandardCharsets.UTF_8);
		Map<String, String> environment = new HashMap<>();
		CoordinatorProcessSupervisor.configureVoiceProviderCredential(runtimeRoot, environment);
		assertTrue(!environment.containsKey("FISH_AUDIO_API_KEY"),
				"malformed optional TTS credential is ignored");
		Files.writeString(credential, "valid-test-fish-key", StandardCharsets.UTF_8);
		CoordinatorProcessSupervisor.configureVoiceProviderCredential(runtimeRoot, environment);
		assertEquals("valid-test-fish-key", environment.get("FISH_AUDIO_API_KEY"),
				"valid optional TTS credential is injected");
		return 2;
	}

	private static int unusedLoopbackPort() throws IOException {
		try (ServerSocket socket = new ServerSocket(0, 1, InetAddress.getLoopbackAddress())) {
			return socket.getLocalPort();
		}
	}

	private static boolean awaitLoopbackListener(int port, long timeoutMs) throws InterruptedException {
		long deadline = System.currentTimeMillis() + timeoutMs;
		while (System.currentTimeMillis() < deadline) {
			try (Socket ignored = new Socket(InetAddress.getLoopbackAddress(), port)) {
				return true;
			} catch (IOException unavailable) {
				Thread.sleep(25L);
			}
		}
		return false;
	}

	private static Path findHostNode() throws IOException {
		String path = System.getenv("PATH");
		String executableName = isWindows() ? "node.exe" : "node";
		if (path != null) {
			for (String entry : path.split(java.util.regex.Pattern.quote(java.io.File.pathSeparator), -1)) {
				if (entry.isBlank()) continue;
				Path candidate = Path.of(entry).resolve(executableName).toAbsolutePath().normalize();
				if (Files.isRegularFile(candidate) && Files.isExecutable(candidate)) return candidate;
			}
		}
		throw new IOException("STARTUP_SMOKE_NODE_MISSING: Node 22+ is required to create the temporary bundled-runtime hardlink");
	}

	private static boolean isWindows() {
		return System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT).contains("win");
	}

	private static void copyTree(Path source, Path target) throws IOException {
		if (!Files.isDirectory(source)) throw new IOException("Startup smoke source tree is missing: " + source);
		try (var paths = Files.walk(source)) {
			for (Path path : paths.toList()) {
				Path destination = target.resolve(source.relativize(path));
				if (Files.isDirectory(path)) Files.createDirectories(destination);
				else Files.copy(path, destination, StandardCopyOption.REPLACE_EXISTING);
			}
		}
	}

	private static void restoreProperty(String name, String value) {
		if (value == null) System.clearProperty(name);
		else System.setProperty(name, value);
	}

	private static void deleteTree(Path root) throws IOException {
		deleteTree(root, List.of());
	}

	/**
	 * Deletes the staged tree once the processes that ran from it are gone. Windows can hold a sharing lock on an exited
	 * node.exe for several seconds (CI saw the lock outlast a 2 s window with every observed process already exited), so
	 * cleanup first waits for each observed process to exit, then retries each path for {@link #DELETE_WINDOW_SECONDS}.
	 * A file still locked after that, when processes were observed and all have exited, is quarantined (see
	 * {@link #quarantine}) rather than failing CI; a process still alive is a real leak and fails, and a cleanup that
	 * observed no process stays strict.
	 */
	private static void deleteTree(Path root, List<CoordinatorProcessOwnership.ProcessIdentity> identities) throws IOException {
		if (!Files.exists(root)) return;
		awaitExit(identities, EXIT_WAIT_SECONDS);
		List<Path> left = new ArrayList<>();
		try (var paths = Files.walk(root)) {
			for (Path path : paths.sorted(Comparator.reverseOrder()).toList()) {
				// A folder that still holds a quarantined-in-place file cannot be emptied.
				if (left.stream().anyMatch(kept -> kept.startsWith(path))) continue;
				if (!deleteEventually(path, identities)) left.add(path);
			}
		}
	}

	private static final long DELETE_WINDOW_SECONDS = 20L;
	private static final long EXIT_WAIT_SECONDS = 15L;

	private static void awaitExit(List<CoordinatorProcessOwnership.ProcessIdentity> identities, long seconds) throws IOException {
		long deadline = System.nanoTime() + java.util.concurrent.TimeUnit.SECONDS.toNanos(seconds);
		for (var identity : identities) {
			var process = identity.resolve();
			if (process.isEmpty()) continue;
			long remaining = deadline - System.nanoTime();
			if (remaining <= 0L) break;
			try {
				process.get().onExit().get(remaining, java.util.concurrent.TimeUnit.NANOSECONDS);
			} catch (java.util.concurrent.TimeoutException stillRunning) {
				System.err.println("Startup smoke cleanup: " + identity + " still running after " + seconds + " s");
				break;
			} catch (java.util.concurrent.ExecutionException unexpected) {
				throw new IOException("Waiting for " + identity + " to exit failed", unexpected);
			} catch (InterruptedException interrupted) {
				Thread.currentThread().interrupt();
				throw new IOException("Interrupted while waiting for " + identity + " to exit", interrupted);
			}
		}
	}

	private static int verifyFixtureCleanup(Path root) throws Exception {
		int assertions = verifyCleanupFailurePreservation();
		if (!isWindows()) return assertions;
		Path locked = Files.createTempFile(root, "cleanup-sharing-", ".tmp");
		try (RandomAccessFile handle = new RandomAccessFile(locked.toFile(), "rw")) {
			var release = new java.util.concurrent.FutureTask<Void>(() -> {
				Thread.sleep(150L);
				handle.close();
				return null;
			});
			Thread.ofPlatform().daemon(true).start(release);
			try {
				deleteEventually(locked);
				assertTrue(!Files.exists(locked), "fixture cleanup waits for Windows sharing locks to release");
			} finally {
				release.get(5L, java.util.concurrent.TimeUnit.SECONDS);
			}
		}
		return assertions + 1;
	}

	private static int verifyCleanupFailurePreservation() throws Exception {
		AssertionError startup = new AssertionError("original startup failure");
		AssertionError ownership = new AssertionError("ownership failure");
		IOException deletion = new IOException("deletion failure");
		boolean[] restored = { false };
		finishCleanup(startup, () -> { throw ownership; }, () -> restored[0] = true, () -> { throw deletion; });
		assertTrue(restored[0], "property restoration runs after an ownership failure");
		assertEquals(List.of(ownership, deletion), List.of(startup.getSuppressed()),
				"startup failure retains both ownership and deletion failures");
		IOException cleanupOnly = new IOException("cleanup-only failure");
		try {
			finishCleanup(null, () -> { throw cleanupOnly; }, () -> { throw ownership; });
			throw new AssertionError("cleanup-only failure must fail the smoke test");
		} catch (IOException failure) {
			assertTrue(failure == cleanupOnly, "cleanup-only failure is propagated unchanged");
			assertEquals(List.of(ownership), List.of(failure.getSuppressed()),
					"later cleanup failures remain visible without a startup failure");
		}
		finishCleanup(null, () -> restored[0] = false);
		assertTrue(!restored[0], "successful cleanup completes normally");
		return 5;
	}

	/**
	 * A file still locked after the delete window, with every observed process gone, on a GitHub runner: renamed into a
	 * quarantine folder under RUNNER_TEMP (the runner empties it after the job), or under the JVM temp folder when
	 * RUNNER_TEMP is on another volume, since only a rename on the same volume works on a locked file. If even the rename
	 * is refused, the file is left where it is: the hosted runner is discarded after the job, so a leftover file there
	 * is not a product fault. Off a runner the original failure stands.
	 */
	private static boolean quarantine(Path path, java.nio.file.FileSystemException failure) throws IOException {
		if (!"true".equals(System.getenv("GITHUB_ACTIONS"))) throw failure;
		List<Path> folders = new ArrayList<>();
		String runnerTemp = System.getenv("RUNNER_TEMP");
		if (runnerTemp != null && !runnerTemp.isBlank()) folders.add(Path.of(runnerTemp));
		folders.add(Path.of(System.getProperty("java.io.tmpdir")));
		var store = Files.getFileStore(path);
		for (Path folder : folders) {
			try {
				if (!Files.isDirectory(folder) || !Files.getFileStore(folder).equals(store)) continue;
				Path target = Files.createDirectories(folder.resolve("mineagen-smoke-quarantine"))
						.resolve(java.util.UUID.randomUUID() + "-" + path.getFileName());
				Files.move(path, target, StandardCopyOption.ATOMIC_MOVE);
				System.err.println("Startup smoke cleanup: quarantined locked " + path + " as " + target + " (" + failure.getMessage() + ")");
				return true;
			} catch (IOException refused) {
				failure.addSuppressed(refused);
			}
		}
		System.err.println("Startup smoke cleanup: left locked " + path + " in place on the discarded runner (" + failure.getMessage()
				+ "; " + failure.getSuppressed().length + " quarantine attempts refused)");
		return false;
	}

	private static void deleteEventually(Path path) throws IOException {
		if (!deleteEventually(path, List.of())) throw new IOException("Startup smoke cleanup left " + path + " in place");
	}

	/** True once the path is gone or quarantined; false when it is left in place on a CI runner (see quarantine). */
	private static boolean deleteEventually(Path path, List<CoordinatorProcessOwnership.ProcessIdentity> identities) throws IOException {
		long start = System.nanoTime();
		long deadline = start + java.util.concurrent.TimeUnit.SECONDS.toNanos(DELETE_WINDOW_SECONDS);
		long nextLog = start + java.util.concurrent.TimeUnit.SECONDS.toNanos(1L);
		int attempts = 0;
		while (true) {
			try {
				Files.deleteIfExists(path);
				if (attempts > 0) System.err.println("Startup smoke cleanup: deleted " + path + " after " + attempts + " retries");
				return true;
			} catch (java.nio.file.FileSystemException exception) {
				attempts++;
				long now = System.nanoTime();
				if (now >= nextLog) {
					System.err.println("Startup smoke cleanup: retry " + attempts + " for " + path + " ("
							+ java.util.concurrent.TimeUnit.NANOSECONDS.toMillis(now - start) + " ms): " + exception.getMessage());
					nextLog = now + java.util.concurrent.TimeUnit.SECONDS.toNanos(1L);
				}
				if (now >= deadline) {
					// Only a cleanup that observed the processes (and saw them all exit) may quarantine; one that observed none
					// cannot tell a lingering lock from a live holder, so it stays strict.
					var alive = identities.stream().filter(CoordinatorProcessOwnership.ProcessIdentity::isAlive).toList();
					if (identities.isEmpty() || !alive.isEmpty() || Files.isDirectory(path)) throw exception;
					return quarantine(path, exception);
				}
				try {
					Thread.sleep(25L);
				} catch (InterruptedException interrupted) {
					Thread.currentThread().interrupt();
					throw new IOException("Interrupted while waiting for the fixture to release " + path, interrupted);
				}
			}
		}
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!java.util.Objects.equals(expected, actual)) throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
	}

	private record FakeCodexEnvironment(Path appData, String path) {
	}
}
