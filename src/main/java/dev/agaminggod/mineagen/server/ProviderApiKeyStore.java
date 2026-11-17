package dev.agaminggod.mineagen.server;

import dev.agaminggod.mineagen.control.AgentControlProvider;
import dev.agaminggod.mineagen.control.AgentControlSnapshot;
import java.io.IOException;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.LinkOption;
import java.nio.file.Path;
import java.nio.file.StandardCopyOption;
import java.nio.file.attribute.AclEntry;
import java.nio.file.attribute.AclEntryPermission;
import java.nio.file.attribute.AclEntryType;
import java.nio.file.attribute.AclFileAttributeView;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.Base64;
import java.util.EnumSet;
import java.util.List;
import java.util.Set;
import java.util.concurrent.ConcurrentHashMap;
import java.util.function.Consumer;
import net.fabricmc.loader.api.FabricLoader;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/** Optional machine credentials, outside world data. Exceptions deliberately never contain input or IO causes. */
public final class ProviderApiKeyStore {
	public static final List<String> PROVIDERS = List.of("codex", "claude");
	private static final long MAX_FILE_BYTES = 4096;
	public static final String LOCAL_ONLY_MESSAGE = "A saved API key only works in a world hosted on your own machine. "
			+ "On a dedicated server, use the CLI login or the API key environment variables on the server machine.";

	/** The sender is not the host of an integrated world on this machine. Carries only the fixed chat line. */
	static final class LocalOnlyException extends IllegalArgumentException {
		LocalOnlyException() { super(LOCAL_ONLY_MESSAGE); }
	}

	/** First line of a protected key file: {@code mineagen-provider-key:1:<scheme>:<base64>}. A bare key is the plain form. */
	static final String PROTECTED_HEADER = "mineagen-provider-key:1:";
	private static final Logger LOGGER = LoggerFactory.getLogger(ProviderApiKeyStore.class);
	private static final Set<String> REPORTED = ConcurrentHashMap.newKeySet();
	/** DPAPI on Windows, null elsewhere. Tests inject a reversible stand-in because the native call needs Windows. */
	static volatile ProviderKeyProtector protector = ProviderKeyProtector.platformDefault();
	static volatile Consumer<String> warnings = LOGGER::warn;

	private ProviderApiKeyStore() { }

	static void resetWarningsForTest() { REPORTED.clear(); }

	/** Each fixed message goes to the server log once per run; none of them ever includes key material. */
	private static void reportOnce(String message) {
		if (REPORTED.add(message)) warnings.accept(message);
	}

	/** A key may only come from the player hosting an integrated world, over the in-memory connection, so it never crosses a network. */
	static boolean localHost(boolean dedicatedServer, boolean singleplayerOwner, boolean memoryConnection) {
		return !dedicatedServer && singleplayerOwner && memoryConnection;
	}

	static Path runtimeRoot() {
		return CoordinatorProcessSupervisor.DefaultDependencyResolver.selectedRuntimeRoot(FabricLoader.getInstance().getGameDir());
	}

	public static boolean validKey(String value) {
		return value != null && value.matches("[A-Za-z0-9._~+/=-]{8,512}");
	}

	/** Permission, then locality, are checked before even validating or touching the filesystem. Clearing follows the same rule. */
	static void update(boolean canControl, boolean localHost, Path root, String provider, String key) {
		if (!canControl) throw new IllegalArgumentException("Operator permission is required to change API keys");
		if (!localHost) throw new LocalOnlyException();
		if (!PROVIDERS.contains(provider) || key == null || (!key.isEmpty() && !validKey(key)))
			throw new IllegalArgumentException("Invalid provider API key; use 8 to 512 token characters");
		Path temporary = null;
		try {
			Path directory = root.resolve("runtime/provider-keys");
			if (Files.isSymbolicLink(root.resolve("runtime")) || Files.isSymbolicLink(directory)) throw new IOException();
			Files.createDirectories(directory);
			ownerOnly(directory, true);
			Path target = directory.resolve(provider + ".key");
			if (Files.isSymbolicLink(target)) throw new IOException();
			if (key.isEmpty()) {
				Files.deleteIfExists(target);
				return;
			}
			if (Files.getFileStore(directory).supportsFileAttributeView("posix")) {
				temporary = Files.createTempFile(directory, ".key-", ".tmp", PosixFilePermissions.asFileAttribute(PosixFilePermissions.fromString("rw-------")));
			} else {
				temporary = Files.createTempFile(directory, ".key-", ".tmp");
			}
			ownerOnly(temporary, false);
			Files.writeString(temporary, sealed(key), StandardCharsets.UTF_8);
			try { Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
			catch (java.nio.file.AtomicMoveNotSupportedException unsupported) { Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING); }
		} catch (IOException | SecurityException failure) {
			throw new IllegalStateException("Could not update the server API key file");
		} finally {
			if (temporary != null) try { Files.deleteIfExists(temporary); } catch (IOException ignored) { }
		}
	}

	/** The protected form when the platform protector works; otherwise the bare key, still in an owner-only file. */
	private static String sealed(String key) {
		ProviderKeyProtector active = protector;
		if (active == null) return key;
		try {
			byte[] cipher = active.protect(key.getBytes(StandardCharsets.UTF_8));
			return PROTECTED_HEADER + active.scheme() + ":" + Base64.getEncoder().encodeToString(cipher);
		} catch (RuntimeException | LinkageError failure) {
			// Neither the failure nor its message is logged: a native error could in principle describe its input.
			reportOnce("Could not encrypt the saved provider API key for this Windows account; it is stored as an owner-only file instead.");
			return key;
		}
	}

	private static String unsealed(String content) {
		if (!content.startsWith(PROTECTED_HEADER)) return content;
		String body = content.substring(PROTECTED_HEADER.length());
		int separator = body.indexOf(':');
		ProviderKeyProtector active = protector;
		if (separator <= 0 || active == null || !body.substring(0, separator).equals(active.scheme())) {
			reportOnce("A saved provider API key is encrypted for another account or machine and was ignored; save it again from the control center.");
			return null;
		}
		try {
			return new String(active.unprotect(Base64.getDecoder().decode(body.substring(separator + 1).strip())), StandardCharsets.UTF_8);
		} catch (RuntimeException | LinkageError failure) {
			reportOnce("A saved provider API key could not be decrypted and was ignored; save it again from the control center.");
			return null;
		}
	}

	private static void ownerOnly(Path path, boolean directory) throws IOException {
		if (Files.getFileStore(path).supportsFileAttributeView("posix")) {
			Files.setPosixFilePermissions(path, PosixFilePermissions.fromString(directory ? "rwx------" : "rw-------"));
		} else {
			AclFileAttributeView acl = Files.getFileAttributeView(path, AclFileAttributeView.class, LinkOption.NOFOLLOW_LINKS);
			if (acl != null) acl.setAcl(List.of(AclEntry.newBuilder().setType(AclEntryType.ALLOW)
					.setPrincipal(Files.getOwner(path)).setPermissions(EnumSet.allOf(AclEntryPermission.class)).build()));
		}
	}

	static void configureEnvironment(Path root, java.util.Map<String, String> environment) {
		String[] variables = {"OPENAI_API_KEY", "ANTHROPIC_API_KEY"};
		for (int index = 0; index < PROVIDERS.size(); index++) {
			String provider = PROVIDERS.get(index);
			String variable = variables[index];
			boolean explicit = environment.entrySet().stream().anyMatch(entry ->
					(entry.getKey().equalsIgnoreCase(variable) || provider.equals("codex") && entry.getKey().equalsIgnoreCase("CODEX_API_KEY"))
					&& entry.getValue() != null && !entry.getValue().isBlank());
			if (explicit) continue;
			String key = read(root, provider);
			if (key != null) {
				environment.keySet().removeIf(name -> name.equalsIgnoreCase(variable));
				environment.put(variable, key);
			}
		}
	}

	static String suffix(Path root, String provider) {
		String key = read(root, provider);
		return key == null ? null : key.substring(key.length() - 4);
	}

	private static String read(Path root, String provider) {
		if (!PROVIDERS.contains(provider)) return null;
		Path file = root.resolve("runtime/provider-keys/" + provider + ".key");
		try {
			// A DPAPI blob for a 512-character key, in base64, stays well under this cap.
			if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > MAX_FILE_BYTES) return null;
			String key = unsealed(Files.readString(file, StandardCharsets.UTF_8));
			return validKey(key) ? key : null;
		} catch (IOException | SecurityException ignored) { return null; }
	}

	static AgentControlSnapshot withMetadata(AgentControlSnapshot snapshot, Path root) {
		List<AgentControlProvider> rows = new ArrayList<>();
		for (String id : PROVIDERS) {
			AgentControlProvider row = snapshot.providers().stream().filter(p -> p.id().equals(id)).findFirst().orElseGet(() ->
					new AgentControlProvider(id, switch (id) {
						case "codex" -> "Codex / OpenAI";
						case "claude" -> "Claude Code / Anthropic";
						default -> throw new IllegalArgumentException("Unsupported provider");
					}, 0xA9B4BF, null, null, null, null, null, null, List.of(), "unknown", null, 0L));
			rows.add(row.withApiKeySuffix(suffix(root, id)));
		}
		return new AgentControlSnapshot(snapshot.schemaVersion(), snapshot.canControl(), snapshot.automationAvailable(),
				snapshot.automationStatus(), snapshot.generatedAtEpochMs(), snapshot.agents(), snapshot.catalog(), rows);
	}
}
