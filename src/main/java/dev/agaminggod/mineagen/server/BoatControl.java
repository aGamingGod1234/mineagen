package dev.agaminggod.mineagen.server;

import java.io.IOException;
import java.net.URI;
import java.nio.file.Path;
import java.util.List;
import java.util.concurrent.CompletableFuture;
import java.util.concurrent.TimeUnit;
import net.minecraft.network.chat.Component;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;

/** Applies a {@link dev.agaminggod.mineagen.control.BoatControlPayload} for the local host. Runs on the server thread. */
final class BoatControl {
	private BoatControl() { }

	static void handle(MinecraftServer server, ServerPlayer player, String action, boolean allowed) {
		if (!allowed) {
			say(player, "Boat settings belong to the player hosting this world on their own computer.");
			return;
		}
		Path root = ProviderApiKeyStore.runtimeRoot();
		try {
			BoatAccount.Settings settings = BoatAccount.settings(root);
			switch (action) {
				case "runs_on:boat" -> {
					BoatAccount.saveSettings(root, new BoatAccount.Settings(true, settings.signInConsent()));
					AgentServerRuntime.reloadProviderCredentials(server);
					say(player, "Agents now run on a boat machine. Starting it...");
				}
				case "runs_on:local", "stop_machine" -> {
					BoatAccount.saveSettings(root, new BoatAccount.Settings(false, settings.signInConsent()));
					AgentServerRuntime.reloadProviderCredentials(server);
					say(player, "Agents now run on this PC. The boat machine is being stopped and deleted.");
				}
				case "consent:on", "consent:off" -> {
					BoatAccount.saveSettings(root, new BoatAccount.Settings(settings.runsOnBoat(), action.endsWith("on")));
					if (settings.runsOnBoat()) AgentServerRuntime.reloadProviderCredentials(server);
				}
				case "sign_in:boat" -> {
					CompletableFuture<Void> signIn = BoatAccount.oauthAvailable()
							? BoatAccount.signIn(root, BoatControl::openBrowser)
							: BoatAccount.BoatCli.login();
					say(player, "Opening boat sign-in in your browser...");
					signIn.whenComplete((ignored, failure) -> server.execute(() -> {
						say(player, failure == null ? "Signed in to boat." : "Boat sign-in did not finish.");
						if (failure == null && BoatAccount.settings(root).runsOnBoat()) AgentServerRuntime.reloadProviderCredentials(server);
					}));
				}
				case "sign_out:boat" -> {
					BoatAccount.signOut(root);
					if (settings.runsOnBoat()) {
						BoatAccount.saveSettings(root, new BoatAccount.Settings(false, settings.signInConsent()));
						AgentServerRuntime.reloadProviderCredentials(server);
					}
					say(player, "Signed out of boat.");
				}
				case "sign_in:codex", "sign_in:claude" -> {
					String provider = action.substring("sign_in:".length());
					say(player, "Opening " + (provider.equals("codex") ? "Codex" : "Claude") + " sign-in...");
					providerLogin(provider).whenComplete((ignored, failure) -> server.execute(() -> {
						say(player, failure == null ? "Signed in. Scanning model CLIs..." : "Sign-in did not finish.");
						AgentServerRuntime.requestProviderRescan(server);
					}));
				}
				default -> throw new IllegalArgumentException("Unknown boat action");
			}
		} catch (IOException | RuntimeException failure) {
			say(player, "Could not change the boat settings; check the game folder's file access.");
		}
		AgentControlSync.requestSnapshot(player);
	}

	/** The player's default browser. Minecraft's own opener is client-only in 26.x, and this runs on the host's server. */
	private static void openBrowser(URI uri) {
		String os = System.getProperty("os.name", "").toLowerCase(java.util.Locale.ROOT);
		List<String> command = os.startsWith("windows") ? List.of("rundll32", "url.dll,FileProtocolHandler", uri.toString())
				: os.contains("mac") ? List.of("open", uri.toString()) : List.of("xdg-open", uri.toString());
		try { new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start(); }
		catch (IOException failure) { throw new IllegalStateException("could not open the browser"); }
	}

	/** Runs the provider's own sign-in command (it opens the browser), then the caller rescans. */
	static CompletableFuture<Void> providerLogin(String provider) {
		List<String> login = provider.equals("codex") ? List.of("codex", "login") : List.of("claude", "auth", "login");
		boolean windows = System.getProperty("os.name", "").startsWith("Windows");
		List<String> command = windows ? java.util.stream.Stream.concat(java.util.stream.Stream.of("cmd.exe", "/c"), login.stream()).toList() : login;
		return CompletableFuture.runAsync(() -> {
			try {
				Process process = new ProcessBuilder(command).redirectErrorStream(true).redirectOutput(ProcessBuilder.Redirect.DISCARD).start();
				if (!process.waitFor(5, TimeUnit.MINUTES) || process.exitValue() != 0) {
					process.destroyForcibly();
					throw new IllegalStateException("sign-in did not finish");
				}
			} catch (IOException failure) { throw new IllegalStateException("sign-in could not start"); }
			catch (InterruptedException interrupted) { Thread.currentThread().interrupt(); throw new IllegalStateException("interrupted"); }
		});
	}

	private static void say(ServerPlayer player, String message) {
		player.sendSystemMessage(Component.literal(message));
		AgentControlSync.storeResult(player.getUUID(), true, message);
	}
}
