package dev.agaminggod.arenaagents.server;

import dev.agaminggod.arenaagents.control.AgentControlProvider;
import dev.agaminggod.arenaagents.control.AgentControlSnapshot;
import dev.agaminggod.arenaagents.control.AgentControlSnapshotCodec;
import dev.agaminggod.arenaagents.control.ProviderApiKeyPayload;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.HashMap;
import java.util.List;
import java.util.Map;

public final class ProviderApiKeyVerification {
	private ProviderApiKeyVerification() { }
	public static int verify() throws Exception {
		Path root = Files.createTempDirectory("arena-provider-key-test-");
		String key = "synthetic-key-1234";
		try {
			try { ProviderApiKeyStore.update(false, root, "codex", key); throw new AssertionError("non-operator accepted"); }
			catch (IllegalArgumentException denied) { check(!denied.toString().contains(key), "denial never echoes key"); }
			check(!Files.exists(root.resolve("runtime")), "operator rejection precedes storage");
			for (String invalid : List.of("short", "token with spaces", "line\nbreak-token", "é".repeat(16), "x".repeat(513), "\"quoted-key\"")) {
				try { ProviderApiKeyStore.update(true, root, "codex", invalid); throw new AssertionError("invalid key accepted"); }
				catch (IllegalArgumentException rejected) { check(!rejected.toString().contains(invalid), "validation never echoes input"); }
			}
			try { ProviderApiKeyStore.update(true, root, "../world", key); throw new AssertionError("invalid provider accepted"); }
			catch (IllegalArgumentException expected) { }
			for (String provider : ProviderApiKeyStore.PROVIDERS) ProviderApiKeyStore.update(true, root, provider, key);
			Path file = root.resolve("runtime/provider-keys/codex.key");
			check(Files.readString(file).equals(key), "key stored only in runtime credential file");
			check(ProviderApiKeyStore.suffix(root, "codex").equals("1234"), "only last four read for UI");
			if (Files.getFileStore(file).supportsFileAttributeView("posix")) {
				check(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")), "file is owner-only");
				check(Files.getPosixFilePermissions(file.getParent()).equals(PosixFilePermissions.fromString("rwx------")), "directory is owner-only");
			}
			Map<String, String> env = new HashMap<>();
			ProviderApiKeyStore.configureEnvironment(root, env);
			check(env.equals(Map.of("OPENAI_API_KEY", key, "ANTHROPIC_API_KEY", key, "GEMINI_API_KEY", key, "OPENCODE_API_KEY", key)), "all stored credentials feed CLI variables");
			Map<String, String> explicit = new HashMap<>(Map.of("openai_api_key", "external-openai", "ANTHROPIC_API_KEY", "external-claude", "GEMINI_API_KEY", "external-gemini", "OPENCODE_API_KEY", "external-zen"));
			Map<String, String> before = Map.copyOf(explicit);
			ProviderApiKeyStore.configureEnvironment(root, explicit);
			check(explicit.equals(before), "explicit environment wins case-insensitively");
			Map<String, String> alias = new HashMap<>(Map.of("CODEX_API_KEY", "external-codex"));
			ProviderApiKeyStore.configureEnvironment(root, alias);
			check(!alias.containsKey("OPENAI_API_KEY"), "explicit Codex alias wins over stored OpenAI key");
			AgentControlSnapshot empty = new AgentControlSnapshot(AgentControlSnapshot.SCHEMA_VERSION, true, false, "offline", 1L, List.of(), List.of(), List.of(), List.of());
			AgentControlSnapshot metadata = ProviderApiKeyStore.withMetadata(empty, root);
			String encoded = AgentControlSnapshotCodec.encode(metadata);
			check(!encoded.contains(key) && encoded.contains("1234"), "snapshot never echoes full key even without coordinator");
			check(metadata.providers().size() == 4, "all known providers remain visible before discovery");
			AgentControlProvider row = AgentControlSnapshotCodec.decode(encoded).providers().getFirst();
			check(row.apiKeyLabel().equals("API key ····1234"), "stored key label is masked");
			check(!new ProviderApiKeyPayload("codex", key).toString().contains(key), "payload diagnostics never echo key");
			ProviderApiKeyStore.update(true, root, "codex", "replacement-5678");
			check(ProviderApiKeyStore.suffix(root, "codex").equals("5678"), "replacement updates suffix atomically");
			ProviderApiKeyStore.update(true, root, "codex", "");
			check(!Files.exists(file) && ProviderApiKeyStore.suffix(root, "codex") == null, "remove deletes key");
			Map<String, String> removed = new HashMap<>();
			ProviderApiKeyStore.configureEnvironment(root, removed);
			check(!removed.containsKey("OPENAI_API_KEY"), "removal restores subscription environment on coordinator restart");
			Files.writeString(file, "bad\ncredential");
			check(ProviderApiKeyStore.suffix(root, "codex") == null, "malformed local file ignored");
			Files.delete(file);
			if (Files.getFileStore(root).supportsFileAttributeView("posix")) {
				Files.createSymbolicLink(file, root.resolve("outside"));
				try { ProviderApiKeyStore.update(true, root, "codex", key); throw new AssertionError("symlink accepted"); }
				catch (IllegalStateException rejected) { check(!rejected.toString().contains(key), "IO errors never echo key"); }
				check(!Files.exists(root.resolve("outside")), "symlink target untouched");
			}
			return 29;
		} finally {
			try (var files = Files.walk(root)) { for (Path path : files.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
		}
	}
	private static void check(boolean value, String label) { if (!value) throw new AssertionError(label); }
}
