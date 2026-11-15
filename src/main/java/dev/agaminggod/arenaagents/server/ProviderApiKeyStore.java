package dev.agaminggod.arenaagents.server;

import dev.agaminggod.arenaagents.control.AgentControlProvider;
import dev.agaminggod.arenaagents.control.AgentControlSnapshot;
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
import java.util.EnumSet;
import java.util.List;
import net.fabricmc.loader.api.FabricLoader;

/** Optional machine credentials, outside world data. Exceptions deliberately never contain input or IO causes. */
public final class ProviderApiKeyStore {
	public static final List<String> PROVIDERS = List.of("codex", "claude", "gemini", "opencode");
	private ProviderApiKeyStore() { }

	static Path runtimeRoot() {
		return CoordinatorProcessSupervisor.DefaultDependencyResolver.selectedRuntimeRoot(FabricLoader.getInstance().getGameDir());
	}

	public static boolean validKey(String value) {
		return value != null && value.matches("[A-Za-z0-9._~+/=-]{8,512}");
	}

	/** Permission is checked before even validating or touching the filesystem. */
	static void update(boolean canControl, Path root, String provider, String key) {
		if (!canControl) throw new IllegalArgumentException("Operator permission is required to change API keys");
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
			Files.writeString(temporary, key, StandardCharsets.UTF_8);
			try { Files.move(temporary, target, StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING); }
			catch (java.nio.file.AtomicMoveNotSupportedException unsupported) { Files.move(temporary, target, StandardCopyOption.REPLACE_EXISTING); }
		} catch (IOException | SecurityException failure) {
			throw new IllegalStateException("Could not update the server API key file");
		} finally {
			if (temporary != null) try { Files.deleteIfExists(temporary); } catch (IOException ignored) { }
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
		String[] variables = {"OPENAI_API_KEY", "ANTHROPIC_API_KEY", "GEMINI_API_KEY", "OPENCODE_API_KEY"};
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
			if (!Files.isRegularFile(file, LinkOption.NOFOLLOW_LINKS) || Files.size(file) > 512) return null;
			String key = Files.readString(file, StandardCharsets.UTF_8);
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
						case "gemini" -> "Antigravity / Gemini";
						default -> "OpenCode / Zen";
					}, 0xA9B4BF, null, null, null, null, null, null, List.of(), "unknown", null, 0L));
			rows.add(row.withApiKeySuffix(suffix(root, id)));
		}
		return new AgentControlSnapshot(snapshot.schemaVersion(), snapshot.canControl(), snapshot.automationAvailable(),
				snapshot.automationStatus(), snapshot.generatedAtEpochMs(), snapshot.agents(), snapshot.groups(), snapshot.catalog(), rows);
	}
}
