package dev.agaminggod.mineagen.server;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import com.sun.net.httpserver.HttpServer;
import java.io.File;
import java.io.IOException;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.URLEncoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.security.NoSuchAlgorithmException;
import java.security.SecureRandom;
import java.time.Duration;
import java.util.Base64;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.Map;
import java.util.Properties;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.Executors;
import java.util.concurrent.ScheduledExecutorService;
import java.util.concurrent.TimeUnit;
import java.util.function.Consumer;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * The player's boat.dev account and the "Runs on" choice. Boat supplies machines, not models: with Runs on: boat the
 * coordinator (and its Codex/Claude helpers) runs on a boat machine that coordinator/src/boat-runner.mjs creates and
 * deletes. Everything here lives under the runtime root, outside world data, next to the saved provider API keys.
 *
 * <p>Tokens come from "Sign in with boat" (OAuth 2 with PKCE, a public client, a loopback redirect). The access token
 * lasts an hour and every refresh rotates the refresh token (a reused one disconnects the app), so this class is the
 * only refresher: it keeps the sealed pair in {@code oauth.key} and hands the runner just the current access token in an
 * owner-only file, which the runner re-reads on every call. Exceptions and logs never carry token material.
 */
public final class BoatAccount {
	private static final Logger LOGGER = LoggerFactory.getLogger(BoatAccount.class);
	/** Filled in once the Mineagen OAuth app exists; {@code -Dmineagen.boatClientId} overrides it. */
	static final String BUNDLED_CLIENT_ID = "";
	static final String AUTHORIZE_URL = "https://boat.dev/api/boat/oauth2/authorize";
	static final String TOKEN_URL = "https://boat.dev/api/boat/oauth2/token";
	static final String REVOKE_URL = "https://boat.dev/api/boat/oauth2/revoke";
	/** The least the runner needs: make, use, extend and delete its own machine, and publish the relay's port. Never billing. */
	static final String SCOPES = "account.read sandbox.read sandbox.create sandbox.stop sandbox.delete-own exec file.read file.write host";
	private static final long REFRESH_MARGIN_MS = 10 * 60_000L;
	private static final long SIGN_IN_TIMEOUT_MS = 5 * 60_000L;
	public static final double DOLLARS_PER_HOUR = 0.018;
	public static final String MACHINE_SIZE = "2 vCPU · 4 GB";

	static volatile URI tokenEndpoint = URI.create(TOKEN_URL);
	static volatile URI revokeEndpoint = URI.create(REVOKE_URL);
	private static final HttpClient HTTP = HttpClient.newBuilder().connectTimeout(Duration.ofSeconds(15)).build();
	private static final SecureRandom RANDOM = new SecureRandom();
	private static final Object LOCK = new Object();
	private static ScheduledExecutorService refresher;

	private BoatAccount() { }

	public record Settings(boolean runsOnBoat, boolean signInConsent) { }

	/** What the control center shows for boat. {@code phase} is "signed_out", "idle", "starting", "running" or "stopping". */
	public record Status(String phase, boolean signedIn, String via, String machine, double costDollars, String error) { }

	static Path folder(Path root) { return root.resolve("runtime/boat"); }

	/** This machine's runtime root, the one the supervisor launches from. */
	public static Path localRuntimeRoot() { return ProviderApiKeyStore.runtimeRoot(); }

	public static Settings settings(Path root) {
		Properties values = new Properties();
		try (var reader = Files.newBufferedReader(folder(root).resolve("settings.properties"))) { values.load(reader); }
		catch (IOException | SecurityException ignored) { }
		return new Settings("boat".equals(values.getProperty("runsOn")), "true".equals(values.getProperty("signInConsent")));
	}

	public static void saveSettings(Path root, Settings settings) throws IOException {
		Properties values = new Properties();
		values.setProperty("runsOn", settings.runsOnBoat() ? "boat" : "local");
		values.setProperty("signInConsent", Boolean.toString(settings.signInConsent()));
		StringBuilder text = new StringBuilder();
		values.forEach((key, value) -> text.append(key).append('=').append(value).append('\n'));
		writePrivate(folder(root).resolve("settings.properties"), text.toString());
	}

	public static String clientId() {
		String configured = System.getProperty("mineagen.boatClientId", BUNDLED_CLIENT_ID);
		return configured == null ? "" : configured.strip();
	}

	/** True when the OAuth app exists; before that, a developer's own `boat` command-line sign-in stands in. */
	public static boolean oauthAvailable() { return !clientId().isEmpty(); }

	public static boolean oauthSignedIn(Path root) { return Files.isRegularFile(folder(root).resolve("oauth.key"), LinkOption.NOFOLLOW_LINKS); }

	public static Status status(Path root) {
		boolean oauth = oauthSignedIn(root);
		boolean cli = !oauth && !oauthAvailable() && BoatCli.signedIn();
		boolean signedIn = oauth || cli;
		String via = oauth ? "oauth" : cli ? "cli" : "none";
		String phase = signedIn ? "idle" : "signed_out";
		String machine = null, error = null;
		double cost = 0;
		Path file = folder(root).resolve("status.json");
		try {
			if (Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) && Files.size(file) < 16_384) {
				JsonObject json = JsonParser.parseString(Files.readString(file)).getAsJsonObject();
				String runner = json.has("phase") ? json.get("phase").getAsString() : "stopped";
				long updated = json.has("updatedAt") ? json.get("updatedAt").getAsLong() : 0L;
				boolean fresh = System.currentTimeMillis() - updated < 30_000L;
				if (fresh && (runner.equals("starting") || runner.equals("running") || runner.equals("stopping"))) phase = runner;
				if (json.has("machine") && !json.get("machine").isJsonNull()) machine = json.get("machine").getAsString();
				if (json.has("estimatedCostDollars")) cost = json.get("estimatedCostDollars").getAsDouble();
				if (json.has("error") && !json.get("error").isJsonNull()) error = json.get("error").getAsString();
			}
		} catch (IOException | RuntimeException ignored) { }
		return new Status(phase, signedIn, via, machine, cost, error);
	}

	/**
	 * Adds the runner's variables when the coordinator runs on boat. Returns whether it does, so the supervisor can allow
	 * for the minute a machine takes to start.
	 */
	static boolean configureEnvironment(Path root, Map<String, String> environment) {
		Settings settings = settings(root);
		if (!settings.runsOnBoat()) return false;
		environment.put("MINEAGEN_RUNS_ON", "boat");
		environment.put("MINEAGEN_BOAT_STATUS_FILE", folder(root).resolve("status.json").toString());
		environment.put("MINEAGEN_BOAT_OWNER_PID", Long.toString(ProcessHandle.current().pid()));
		environment.put("MINEAGEN_BOAT_SIGNIN_CONSENT", settings.signInConsent() ? "1" : "0");
		if (oauthSignedIn(root)) {
			try {
				freshAccessToken(root);
				environment.put("MINEAGEN_BOAT_TOKEN_FILE", folder(root).resolve("access-token").toString());
				ensureRefresher(root);
			} catch (IOException failure) {
				LOGGER.warn("Could not refresh the boat sign-in; sign in with boat again from the control center");
			}
		} else if (!oauthAvailable() && BoatCli.available()) {
			environment.put("MINEAGEN_BOAT_BACKEND", "cli");
			String binary = BoatCli.binary();
			if (binary != null) environment.put("MINEAGEN_BOAT_CLI", binary);
		}
		return true;
	}

	/** Starts the loopback callback, opens the browser, and completes when the tokens are saved. */
	public static CompletableFuture<Void> signIn(Path root, Consumer<URI> openBrowser) {
		CompletableFuture<Void> done = new CompletableFuture<>();
		if (!oauthAvailable()) { done.completeExceptionally(new IllegalStateException("Mineagen's boat app is not set up yet")); return done; }
		try {
			String verifier = randomToken(48);
			String challenge = Base64.getUrlEncoder().withoutPadding().encodeToString(sha256(verifier.getBytes(StandardCharsets.US_ASCII)));
			String state = randomToken(24);
			HttpServer server = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
			String redirect = "http://localhost:" + server.getAddress().getPort() + "/callback";
			server.createContext("/callback", exchange -> {
				Map<String, String> query = query(exchange.getRequestURI().getRawQuery());
				boolean ok = state.equals(query.get("state")) && query.containsKey("code");
				String page = ok ? "Signed in to boat. You can close this tab and go back to Minecraft."
						: "Boat sign-in did not finish. Go back to Minecraft and try again.";
				byte[] body = ("<!doctype html><meta charset=utf-8><title>Mineagen</title><body style=\"font:16px sans-serif;padding:40px\">" + page).getBytes(StandardCharsets.UTF_8);
				exchange.getResponseHeaders().add("content-type", "text/html; charset=utf-8");
				exchange.sendResponseHeaders(200, body.length);
				try (var out = exchange.getResponseBody()) { out.write(body); }
				if (!state.equals(query.get("state"))) return; // a stray request; keep waiting for the real one
				CompletableFuture.runAsync(() -> {
					try {
						if (!ok) throw new IOException("sign-in cancelled");
						Map<String, String> form = new LinkedHashMap<>();
						form.put("grant_type", "authorization_code");
						form.put("code", query.get("code"));
						form.put("redirect_uri", redirect);
						form.put("code_verifier", verifier);
						form.put("client_id", clientId());
						saveTokens(root, post(tokenEndpoint, form));
						done.complete(null);
					} catch (IOException | RuntimeException failure) {
						done.completeExceptionally(new IOException("Boat sign-in failed"));
					} finally { server.stop(0); }
				});
			});
			server.start();
			CompletableFuture.delayedExecutor(SIGN_IN_TIMEOUT_MS, TimeUnit.MILLISECONDS).execute(() -> {
				if (done.completeExceptionally(new IOException("Boat sign-in timed out"))) server.stop(0);
			});
			URI authorize = URI.create(AUTHORIZE_URL + "?response_type=code&client_id=" + encode(clientId())
					+ "&redirect_uri=" + encode(redirect) + "&scope=" + encode(SCOPES) + "&state=" + encode(state)
					+ "&code_challenge=" + encode(challenge) + "&code_challenge_method=S256");
			openBrowser.accept(authorize);
		} catch (IOException | RuntimeException failure) {
			done.completeExceptionally(new IOException("Could not start boat sign-in"));
		}
		return done;
	}

	/** Revokes the refresh token (best effort) and forgets both tokens. */
	public static void signOut(Path root) {
		synchronized (LOCK) {
			JsonObject tokens = readTokens(root);
			if (tokens != null && tokens.has("refresh_token")) {
				try { post(revokeEndpoint, Map.of("token", tokens.get("refresh_token").getAsString(), "client_id", clientId())); }
				catch (IOException | RuntimeException ignored) { }
			}
			try {
				Files.deleteIfExists(folder(root).resolve("oauth.key"));
				Files.deleteIfExists(folder(root).resolve("access-token"));
			} catch (IOException ignored) { }
		}
	}

	/** Refreshes when the access token is within ten minutes of expiring, then writes it for the runner. */
	static String freshAccessToken(Path root) throws IOException {
		synchronized (LOCK) {
			JsonObject tokens = readTokens(root);
			if (tokens == null) throw new IOException("not signed in to boat");
			long expiresAt = tokens.has("expires_at") ? tokens.get("expires_at").getAsLong() : 0L;
			if (expiresAt - System.currentTimeMillis() < REFRESH_MARGIN_MS) {
				Map<String, String> form = new LinkedHashMap<>();
				form.put("grant_type", "refresh_token");
				form.put("refresh_token", tokens.get("refresh_token").getAsString());
				form.put("client_id", clientId());
				JsonObject fresh;
				try { fresh = post(tokenEndpoint, form); }
				catch (IOException failure) { throw new IOException("boat token refresh failed"); }
				tokens = saveTokens(root, fresh);
			}
			String access = tokens.get("access_token").getAsString();
			writePrivate(folder(root).resolve("access-token"), access);
			return access;
		}
	}

	private static synchronized void ensureRefresher(Path root) {
		if (refresher != null) return;
		refresher = Executors.newSingleThreadScheduledExecutor(runnable -> {
			Thread thread = new Thread(runnable, "mineagen-boat-token");
			thread.setDaemon(true);
			return thread;
		});
		refresher.scheduleWithFixedDelay(() -> {
			if (!settings(root).runsOnBoat() || !oauthSignedIn(root)) return;
			try { freshAccessToken(root); } catch (IOException failure) { LOGGER.warn("Could not refresh the boat sign-in"); }
		}, 5, 5, TimeUnit.MINUTES);
	}

	private static JsonObject saveTokens(Path root, JsonObject response) throws IOException {
		if (!response.has("access_token") || !response.has("refresh_token")) throw new IOException("boat returned no tokens");
		JsonObject stored = new JsonObject();
		stored.addProperty("access_token", response.get("access_token").getAsString());
		stored.addProperty("refresh_token", response.get("refresh_token").getAsString());
		long expiresIn = response.has("expires_in") ? response.get("expires_in").getAsLong() : 3600L;
		stored.addProperty("expires_at", System.currentTimeMillis() + expiresIn * 1000L);
		// The new refresh token is saved before anything uses the new access token: the old one is dead now.
		writePrivate(folder(root).resolve("oauth.key"), ProviderApiKeyStore.sealed(stored.toString()));
		return stored;
	}

	private static JsonObject readTokens(Path root) {
		Path file = folder(root).resolve("oauth.key");
		try {
			if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 16_384) return null;
			String plain = ProviderApiKeyStore.unsealed(Files.readString(file, StandardCharsets.UTF_8));
			return plain == null ? null : JsonParser.parseString(plain).getAsJsonObject();
		} catch (IOException | RuntimeException ignored) { return null; }
	}

	private static JsonObject post(URI endpoint, Map<String, String> form) throws IOException {
		StringBuilder body = new StringBuilder();
		for (Map.Entry<String, String> entry : form.entrySet()) {
			if (!body.isEmpty()) body.append('&');
			body.append(encode(entry.getKey())).append('=').append(encode(entry.getValue()));
		}
		HttpRequest request = HttpRequest.newBuilder(endpoint).timeout(Duration.ofSeconds(30))
				.header("content-type", "application/x-www-form-urlencoded").header("accept", "application/json")
				.POST(HttpRequest.BodyPublishers.ofString(body.toString())).build();
		try {
			HttpResponse<String> response = HTTP.send(request, HttpResponse.BodyHandlers.ofString());
			if (response.statusCode() / 100 != 2) throw new IOException("boat answered " + response.statusCode());
			String text = response.body();
			return text == null || text.isBlank() ? new JsonObject() : JsonParser.parseString(text).getAsJsonObject();
		} catch (InterruptedException interrupted) {
			Thread.currentThread().interrupt();
			throw new IOException("interrupted");
		}
	}

	static void writePrivate(Path file, String content) throws IOException {
		Path directory = file.getParent();
		if (Files.isSymbolicLink(directory) || Files.isSymbolicLink(file)) throw new IOException("linked boat file");
		Files.createDirectories(directory);
		ProviderApiKeyStore.ownerOnly(directory, true);
		Path temporary = Files.getFileStore(directory).supportsFileAttributeView("posix")
				? Files.createTempFile(directory, ".boat-", ".tmp", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")))
				: Files.createTempFile(directory, ".boat-", ".tmp");
		try {
			ProviderApiKeyStore.ownerOnly(temporary, false);
			Files.writeString(temporary, content, StandardCharsets.UTF_8);
			try { Files.move(temporary, file, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
			catch (java.nio.file.AtomicMoveNotSupportedException unsupported) { Files.move(temporary, file, StandardCopyOption.REPLACE_EXISTING); }
		} finally { Files.deleteIfExists(temporary); }
	}

	private static Map<String, String> query(String raw) {
		Map<String, String> values = new HashMap<>();
		if (raw == null) return values;
		for (String pair : raw.split("&")) {
			int equals = pair.indexOf('=');
			if (equals <= 0) continue;
			values.put(URLDecoder.decode(pair.substring(0, equals), StandardCharsets.UTF_8), URLDecoder.decode(pair.substring(equals + 1), StandardCharsets.UTF_8));
		}
		return values;
	}

	private static String encode(String value) { return URLEncoder.encode(value, StandardCharsets.UTF_8).replace("+", "%20"); }

	private static String randomToken(int bytes) {
		byte[] value = new byte[bytes];
		RANDOM.nextBytes(value);
		return Base64.getUrlEncoder().withoutPadding().encodeToString(value);
	}

	private static byte[] sha256(byte[] value) {
		try { return MessageDigest.getInstance("SHA-256").digest(value); }
		catch (NoSuchAlgorithmException impossible) { throw new IllegalStateException(impossible); }
	}

	/** A developer's `boat` command-line tool. The mod runs it; it never reads the tool's own token store. */
	static final class BoatCli {
		private static volatile long checkedAt;
		private static volatile boolean signedIn;

		private BoatCli() { }

		static String binary() {
			String path = System.getenv("PATH");
			if (path == null) return null;
			boolean windows = System.getProperty("os.name", "").startsWith("Windows");
			for (String directory : path.split(File.pathSeparator)) {
				if (directory.isBlank()) continue;
				Path candidate = Path.of(directory, windows ? "boat.exe" : "boat");
				if (Files.isRegularFile(candidate) && Files.isExecutable(candidate)) return candidate.toString();
			}
			return null;
		}

		static boolean available() { return binary() != null; }

		/** Whether `boat status` reports a signed-in account. Never blocks: a check runs in the background at most once a minute. */
		static boolean signedIn() {
			long now = System.currentTimeMillis();
			if (now - checkedAt >= 60_000L) {
				checkedAt = now;
				CompletableFuture.runAsync(BoatCli::check);
			}
			return signedIn;
		}

		private static void check() {
			String binary = binary();
			if (binary == null) { signedIn = false; return; }
			try {
				Process process = new ProcessBuilder(binary, "--no-update", "status", "--json").redirectErrorStream(true).start();
				byte[] output = process.getInputStream().readNBytes(64 * 1024);
				if (!process.waitFor(15, TimeUnit.SECONDS)) { process.destroyForcibly(); return; }
				JsonObject account = JsonParser.parseString(new String(output, StandardCharsets.UTF_8)).getAsJsonObject().getAsJsonObject("account");
				signedIn = account != null && account.has("signedIn") && account.get("signedIn").getAsBoolean();
			} catch (IOException | RuntimeException failure) { signedIn = false; }
			catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); }
		}

		/** Opens `boat login` (it prints and opens its own browser sign-in). */
		static CompletableFuture<Void> login() {
			String binary = binary();
			if (binary == null) return CompletableFuture.failedFuture(new IOException("the boat tool is not installed"));
			return CompletableFuture.runAsync(() -> {
				try {
					Process process = new ProcessBuilder(binary, "--no-update", "login").redirectErrorStream(true)
							.redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
					if (!process.waitFor(5, TimeUnit.MINUTES) || process.exitValue() != 0) {
						process.destroyForcibly();
						throw new IllegalStateException("boat login did not finish");
					}
					check();
				} catch (IOException failure) { throw new IllegalStateException("boat login could not start"); }
				catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IllegalStateException("interrupted"); }
			});
		}
	}
}
