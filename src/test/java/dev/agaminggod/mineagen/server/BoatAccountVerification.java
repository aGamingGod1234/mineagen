package dev.agaminggod.mineagen.server;

import com.sun.net.httpserver.HttpServer;
import java.net.InetAddress;
import java.net.InetSocketAddress;
import java.net.URI;
import java.net.URLDecoder;
import java.net.http.HttpClient;
import java.net.http.HttpRequest;
import java.net.http.HttpResponse;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.security.MessageDigest;
import java.util.ArrayList;
import java.util.Base64;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.TreeMap;
import java.util.concurrent.TimeUnit;

/** Boat sign-in (PKCE, rotation, revoke) against a stand-in token server, settings, and the runner's environment. */
public final class BoatAccountVerification {
	private static int checks;

	private BoatAccountVerification() { }

	public static int verify() throws Exception {
		checks = 0;
		Path root = Files.createTempDirectory("arena-boat-account-test-");
		ProviderKeyProtector platformProtector = ProviderApiKeyStore.protector;
		URI platformToken = BoatAccount.tokenEndpoint, platformRevoke = BoatAccount.revokeEndpoint;
		String platformClient = System.getProperty("mineagen.boatClientId");
		HttpServer boat = HttpServer.create(new InetSocketAddress(InetAddress.getLoopbackAddress(), 0), 0);
		List<Map<String, String>> tokenRequests = new ArrayList<>();
		List<Map<String, String>> revokes = new ArrayList<>();
		String[] challenge = new String[1];
		try {
			ProviderApiKeyStore.protector = null;
			System.setProperty("mineagen.boatClientId", "boatapp_test");
			boat.createContext("/token", exchange -> {
				Map<String, String> form = form(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8));
				tokenRequests.add(form);
				int n = tokenRequests.size();
				boolean ok = "boatapp_test".equals(form.get("client_id"));
				if ("authorization_code".equals(form.get("grant_type"))) ok &= challenge[0] != null && challenge[0].equals(s256(form.get("code_verifier"))) && "code-1".equals(form.get("code"));
				if ("refresh_token".equals(form.get("grant_type"))) ok &= ("refresh-" + (n - 1)).equals(form.get("refresh_token"));
				// Expires in 60 s: inside the ten-minute margin, so the next use refreshes.
				byte[] body = (ok ? "{\"access_token\":\"access-" + n + "\",\"refresh_token\":\"refresh-" + n + "\",\"expires_in\":60}" : "{\"error\":\"invalid_grant\"}").getBytes(StandardCharsets.UTF_8);
				exchange.sendResponseHeaders(ok ? 200 : 400, body.length);
				try (var out = exchange.getResponseBody()) { out.write(body); }
			});
			boat.createContext("/revoke", exchange -> {
				revokes.add(form(new String(exchange.getRequestBody().readAllBytes(), StandardCharsets.UTF_8)));
				exchange.sendResponseHeaders(200, -1);
				exchange.close();
			});
			boat.start();
			String base = "http://127.0.0.1:" + boat.getAddress().getPort();
			BoatAccount.tokenEndpoint = URI.create(base + "/token");
			BoatAccount.revokeEndpoint = URI.create(base + "/revoke");

			// Runs on this PC by default: no runner variables.
			Map<String, String> environment = new TreeMap<>();
			check(!BoatAccount.configureEnvironment(root, environment) && environment.isEmpty(), "local by default");
			check(BoatAccount.status(root).phase().equals("signed_out"), "signed out before sign-in");

			// Sign in: the browser gets a PKCE S256 authorize URL with the minimum scopes and no billing scope.
			HttpClient http = HttpClient.newHttpClient();
			URI[] opened = new URI[1];
			var signIn = BoatAccount.signIn(root, uri -> opened[0] = uri);
			Map<String, String> authorize = form(opened[0].getRawQuery());
			challenge[0] = authorize.get("code_challenge");
			check("S256".equals(authorize.get("code_challenge_method")) && authorize.get("redirect_uri").startsWith("http://localhost:"), "PKCE and a loopback redirect");
			check(authorize.get("scope").contains("sandbox.delete-own") && !authorize.get("scope").contains("billing"), "minimum scopes, never billing");
			String redirect = authorize.get("redirect_uri");
			// A request with the wrong state is ignored, and the real callback still completes.
			http.send(HttpRequest.newBuilder(URI.create(redirect + "?code=evil&state=wrong")).build(), HttpResponse.BodyHandlers.discarding());
			check(!signIn.isDone(), "wrong state ignored");
			http.send(HttpRequest.newBuilder(URI.create(redirect + "?code=code-1&state=" + authorize.get("state"))).build(), HttpResponse.BodyHandlers.discarding());
			signIn.get(10, TimeUnit.SECONDS);
			check(tokenRequests.size() == 1 && BoatAccount.oauthSignedIn(root), "code exchanged once and saved");
			Path sealed = root.resolve("runtime/boat/oauth.key");
			check(PosixFilePermissions.toString(Files.getPosixFilePermissions(sealed)).equals("rw-------"), "token file owner-only");

			// Runs on boat: the runner gets a fresh access token file; the 60 s token is refreshed and the rotated refresh token kept.
			BoatAccount.saveSettings(root, new BoatAccount.Settings(true, true));
			check(BoatAccount.configureEnvironment(root, environment), "boat mode reported");
			check("boat".equals(environment.get("MINEAGEN_RUNS_ON")) && "1".equals(environment.get("MINEAGEN_BOAT_SIGNIN_CONSENT")), "runs on and consent passed");
			Path tokenFile = Path.of(environment.get("MINEAGEN_BOAT_TOKEN_FILE"));
			check(tokenRequests.size() == 2 && "refresh-1".equals(tokenRequests.get(1).get("refresh_token")), "expiring token refreshed with the saved refresh token");
			check(Files.readString(tokenFile).equals("access-2"), "runner reads the newest access token");
			check(PosixFilePermissions.toString(Files.getPosixFilePermissions(tokenFile)).equals("rw-------"), "access token file owner-only");
			BoatAccount.freshAccessToken(root);
			check(tokenRequests.size() == 3 && "refresh-2".equals(tokenRequests.get(2).get("refresh_token")), "rotated refresh token used next");
			check(!environment.containsKey("MINEAGEN_BOAT_BACKEND"), "OAuth wins over the command-line tool");

			// Sign out revokes the newest refresh token and forgets both files.
			BoatAccount.signOut(root);
			check(revokes.size() == 1 && "refresh-3".equals(revokes.get(0).get("token")), "newest refresh token revoked");
			check(!Files.exists(sealed) && !Files.exists(tokenFile), "tokens removed");

			// A stale status file from a dead runner does not show a running machine.
			Files.writeString(root.resolve("runtime/boat/status.json"), "{\"phase\":\"running\",\"machine\":\"bx_x\",\"updatedAt\":1,\"estimatedCostDollars\":0.01}");
			check(!BoatAccount.status(root).phase().equals("running"), "stale running status ignored");
		} finally {
			boat.stop(0);
			ProviderApiKeyStore.protector = platformProtector;
			BoatAccount.tokenEndpoint = platformToken;
			BoatAccount.revokeEndpoint = platformRevoke;
			if (platformClient == null) System.clearProperty("mineagen.boatClientId"); else System.setProperty("mineagen.boatClientId", platformClient);
		}
		return checks;
	}

	private static Map<String, String> form(String raw) {
		Map<String, String> values = new HashMap<>();
		if (raw == null) return values;
		for (String pair : raw.split("&")) {
			int equals = pair.indexOf('=');
			if (equals > 0) values.put(URLDecoder.decode(pair.substring(0, equals), StandardCharsets.UTF_8), URLDecoder.decode(pair.substring(equals + 1), StandardCharsets.UTF_8));
		}
		return values;
	}

	private static String s256(String verifier) {
		try { return Base64.getUrlEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(verifier.getBytes(StandardCharsets.US_ASCII))); }
		catch (Exception impossible) { throw new IllegalStateException(impossible); }
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("BoatAccount: " + message);
		checks++;
	}
}
