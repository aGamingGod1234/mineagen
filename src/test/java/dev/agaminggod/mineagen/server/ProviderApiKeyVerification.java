package dev.agaminggod.mineagen.server;

import dev.agaminggod.mineagen.control.AgentControlProvider;
import dev.agaminggod.mineagen.control.AgentControlSnapshot;
import dev.agaminggod.mineagen.control.AgentControlSnapshotCodec;
import dev.agaminggod.mineagen.control.ProviderApiKeyPayload;
import java.nio.charset.StandardCharsets;
import java.nio.file.Files;
import java.nio.file.Path;
import java.nio.file.attribute.PosixFilePermissions;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.function.Consumer;
import java.util.function.Supplier;

public final class ProviderApiKeyVerification {
	private ProviderApiKeyVerification() { }
	public static int verify() throws Exception {
		Path root = Files.createTempDirectory("arena-provider-key-test-");
		String key = "synthetic-key-1234";
		ProviderKeyProtector platformProtector = ProviderApiKeyStore.protector;
		Consumer<String> platformWarnings = ProviderApiKeyStore.warnings;
		List<String> warnings = new ArrayList<>();
		checks = 0;
		try {
			// Tests run on Linux: start from the plain owner-only behaviour, then inject protectors explicitly.
			ProviderApiKeyStore.protector = null;
			ProviderApiKeyStore.warnings = warnings::add;
			ProviderApiKeyStore.resetWarningsForTest();

			try { ProviderApiKeyStore.update(false, true, root, "codex", key); throw new AssertionError("non-operator accepted"); }
			catch (IllegalArgumentException denied) { check(!denied.toString().contains(key), "denial never echoes key"); }
			check(!Files.exists(root.resolve("runtime")), "operator rejection precedes storage");
			try { ProviderApiKeyStore.update(false, false, root, "codex", key); throw new AssertionError("non-operator remote accepted"); }
			catch (ProviderApiKeyStore.LocalOnlyException wrongOrder) { throw new AssertionError("operator permission must be checked before locality"); }
			catch (IllegalArgumentException denied) { check(denied.getMessage().contains("Operator"), "operator check comes first"); }

			// A. Local only: a non-host or non-memory sender is refused before validation and before any file access.
			check(ProviderApiKeyStore.localHost(false, true, true), "integrated host over memory connection is local");
			check(!ProviderApiKeyStore.localHost(true, true, true), "dedicated server is never local");
			check(!ProviderApiKeyStore.localHost(false, false, true), "LAN guest is not the host");
			check(!ProviderApiKeyStore.localHost(false, true, false), "host name over a network connection is not local");
			check(!ProviderApiKeyStore.localHost(false, false, false), "remote guest is not local");
			for (String attempt : List.of(key, "", "bad key with spaces")) {
				try { ProviderApiKeyStore.update(true, false, root, "codex", attempt); throw new AssertionError("remote sender accepted"); }
				catch (ProviderApiKeyStore.LocalOnlyException refused) {
					check(attempt.isEmpty() || !refused.toString().contains(attempt), "local-only refusal never echoes input");
					check(refused.getMessage().equals(ProviderApiKeyStore.LOCAL_ONLY_MESSAGE), "refusal carries the local-only chat line");
				}
				check(!Files.exists(root.resolve("runtime")), "remote refusal precedes validation and storage");
			}
			check(ProviderApiKeyStore.LOCAL_ONLY_MESSAGE.contains("your own machine")
					&& ProviderApiKeyStore.LOCAL_ONLY_MESSAGE.contains("dedicated server")
					&& ProviderApiKeyStore.LOCAL_ONLY_MESSAGE.contains("environment variables"), "chat line explains the dedicated server path");
			try { ProviderApiKeyStore.update(true, false, root, "../world", key); throw new AssertionError("remote provider accepted"); }
			catch (ProviderApiKeyStore.LocalOnlyException refused) { }

			for (String invalid : List.of("short", "token with spaces", "line\nbreak-token", "é".repeat(16), "x".repeat(513), "\"quoted-key\"")) {
				try { ProviderApiKeyStore.update(true, true, root, "codex", invalid); throw new AssertionError("invalid key accepted"); }
				catch (IllegalArgumentException rejected) { check(!rejected.toString().contains(invalid), "validation never echoes input"); }
			}
			try { ProviderApiKeyStore.update(true, true, root, "../world", key); throw new AssertionError("invalid provider accepted"); }
			catch (IllegalArgumentException expected) { }
			// The host is accepted.
			for (String provider : ProviderApiKeyStore.PROVIDERS) ProviderApiKeyStore.update(true, true, root, provider, key);
			Path file = root.resolve("runtime/provider-keys/codex.key");
			check(Files.readString(file).equals(key), "without a protector the key stays a plain owner-only file");
			check(ProviderApiKeyStore.suffix(root, "codex").equals("1234"), "only last four read for UI");
			if (Files.getFileStore(file).supportsFileAttributeView("posix")) {
				check(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")), "file is owner-only");
				check(Files.getPosixFilePermissions(file.getParent()).equals(PosixFilePermissions.fromString("rwx------")), "directory is owner-only");
			}
			Map<String, String> env = new HashMap<>();
			ProviderApiKeyStore.configureEnvironment(root, env);
			check(env.equals(Map.of("OPENAI_API_KEY", key, "ANTHROPIC_API_KEY", key)), "all stored credentials feed CLI variables");
			Map<String, String> explicit = new HashMap<>(Map.of("openai_api_key", "external-openai", "ANTHROPIC_API_KEY", "external-claude", "GEMINI_API_KEY", "external-gemini", "OPENCODE_API_KEY", "external-zen"));
			Map<String, String> before = Map.copyOf(explicit);
			ProviderApiKeyStore.configureEnvironment(root, explicit);
			check(explicit.equals(before), "explicit environment wins case-insensitively");
			Map<String, String> alias = new HashMap<>(Map.of("CODEX_API_KEY", "external-codex"));
			ProviderApiKeyStore.configureEnvironment(root, alias);
			check(!alias.containsKey("OPENAI_API_KEY"), "explicit Codex alias wins over stored OpenAI key");
			AgentControlSnapshot empty = new AgentControlSnapshot(AgentControlSnapshot.SCHEMA_VERSION, true, false, "offline", 1L, List.of(), List.of(), List.of());
			AgentControlSnapshot metadata = ProviderApiKeyStore.withMetadata(empty, root);
			String encoded = AgentControlSnapshotCodec.encode(metadata);
			check(!encoded.contains(key) && encoded.contains("1234"), "snapshot never echoes full key even without coordinator");
			check(metadata.providers().size() == 2, "all known providers remain visible before discovery");
			AgentControlProvider row = AgentControlSnapshotCodec.decode(encoded).providers().getFirst();
			check(row.apiKeyLabel().equals("API key ····1234"), "stored key label is masked");
			check(!new ProviderApiKeyPayload("codex", key).toString().contains(key), "payload diagnostics never echo key");

			// B. Versioned protected format round-trips through an injected protector.
			FakeProtector fake = new FakeProtector("test", key);
			ProviderApiKeyStore.protector = fake;
			check(ProviderApiKeyStore.suffix(root, "codex").equals("1234"), "an old plain file still loads with a protector active");
			ProviderApiKeyStore.update(true, true, root, "codex", key);
			String stored = Files.readString(file, StandardCharsets.UTF_8);
			check(stored.startsWith("mineagen-provider-key:1:test:"), "protected file carries the versioned header");
			check(!stored.contains(key) && !stored.contains("1234"), "protected file never holds the key or its suffix");
			check(fake.protectCalls == 1, "saving re-protects the old plain file");
			check(ProviderApiKeyStore.suffix(root, "codex").equals("1234"), "protected key round-trips to its suffix");
			Map<String, String> protectedEnv = new HashMap<>();
			ProviderApiKeyStore.configureEnvironment(root, protectedEnv);
			check(key.equals(protectedEnv.get("OPENAI_API_KEY")), "protected key reaches the coordinator environment");
			if (Files.getFileStore(file).supportsFileAttributeView("posix")) {
				check(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")), "protected file is still owner-only");
			}
			// A protected file this machine cannot open is ignored, never thrown, and never treated as a plain key.
			ProviderApiKeyStore.protector = null;
			check(ProviderApiKeyStore.suffix(root, "codex") == null, "protected file without its protector is not loaded");
			ProviderApiKeyStore.protector = new FakeProtector("other", key);
			check(ProviderApiKeyStore.suffix(root, "codex") == null, "protected file with another scheme is not loaded");
			for (Supplier<Throwable> failure : List.<Supplier<Throwable>>of(() -> new IllegalStateException(key), () -> new UnsatisfiedLinkError(key))) {
				FakeProtector broken = new FakeProtector("test", key);
				broken.unprotectFailure = failure;
				ProviderApiKeyStore.protector = broken;
				check(ProviderApiKeyStore.suffix(root, "codex") == null, "unprotect failure reads as no key");
				Map<String, String> brokenEnv = new HashMap<>();
				ProviderApiKeyStore.configureEnvironment(root, brokenEnv);
				check(!brokenEnv.containsKey("OPENAI_API_KEY"), "unprotect failure feeds nothing to the coordinator");
			}
			Files.writeString(file, "mineagen-provider-key:1:test:%%%not-base64");
			ProviderApiKeyStore.protector = fake;
			check(ProviderApiKeyStore.suffix(root, "codex") == null, "corrupt protected file is ignored");
			check(warnings.stream().noneMatch(line -> line.contains(key)), "read warnings never echo key");

			// A protector failure falls back to the owner-only plain file, says so once and never leaks the key.
			for (Supplier<Throwable> failure : List.<Supplier<Throwable>>of(() -> new IllegalStateException("boom " + key), () -> new UnsatisfiedLinkError(key), () -> new NoClassDefFoundError(key))) {
				ProviderApiKeyStore.resetWarningsForTest();
				warnings.clear();
				FakeProtector failing = new FakeProtector("test", key);
				failing.protectFailure = failure;
				ProviderApiKeyStore.protector = failing;
				ProviderApiKeyStore.update(true, true, root, "codex", key);
				ProviderApiKeyStore.update(true, true, root, "claude", key);
				check(Files.readString(file).equals(key), "protector failure keeps the plain owner-only file");
				check(ProviderApiKeyStore.suffix(root, "codex").equals("1234"), "plain fallback is read back through the plain path");
				if (Files.getFileStore(file).supportsFileAttributeView("posix")) {
					check(Files.getPosixFilePermissions(file).equals(PosixFilePermissions.fromString("rw-------")), "fallback file is owner-only");
				}
				check(warnings.size() == 1, "protector failure is logged once");
				check(warnings.stream().noneMatch(line -> line.contains(key) || line.contains("1234")), "fallback warning never echoes key");
				check(warnings.getFirst().contains("owner-only"), "fallback warning names the kept protection");
			}

			ProviderApiKeyStore.protector = null;
			check(ProviderApiKeyStore.suffix(root, "codex").equals("1234"), "plain fallback file loads without a protector");
			ProviderApiKeyStore.update(true, true, root, "codex", "replacement-5678");
			check(ProviderApiKeyStore.suffix(root, "codex").equals("5678"), "replacement updates suffix atomically");
			ProviderApiKeyStore.update(true, true, root, "codex", "");
			check(!Files.exists(file) && ProviderApiKeyStore.suffix(root, "codex") == null, "remove deletes key");
			Map<String, String> removed = new HashMap<>();
			ProviderApiKeyStore.configureEnvironment(root, removed);
			check(!removed.containsKey("OPENAI_API_KEY"), "removal restores subscription environment on coordinator restart");
			Files.writeString(file, "bad\ncredential");
			check(ProviderApiKeyStore.suffix(root, "codex") == null, "malformed local file ignored");
			Files.delete(file);
			if (Files.getFileStore(root).supportsFileAttributeView("posix")) {
				Files.createSymbolicLink(file, root.resolve("outside"));
				try { ProviderApiKeyStore.update(true, true, root, "codex", key); throw new AssertionError("symlink accepted"); }
				catch (IllegalStateException rejected) { check(!rejected.toString().contains(key), "IO errors never echo key"); }
				check(!Files.exists(root.resolve("outside")), "symlink target untouched");
			}
			return checks;
		} finally {
			ProviderApiKeyStore.protector = platformProtector;
			ProviderApiKeyStore.warnings = platformWarnings;
			ProviderApiKeyStore.resetWarningsForTest();
			try (var files = Files.walk(root)) { for (Path path : files.sorted(java.util.Comparator.reverseOrder()).toList()) Files.deleteIfExists(path); }
		}
	}

	/** Reversible stand-in for DPAPI: the real native call cannot run on Linux. */
	private static final class FakeProtector implements ProviderKeyProtector {
		private final String scheme;
		private final String secret;
		int protectCalls;
		Supplier<Throwable> protectFailure;
		Supplier<Throwable> unprotectFailure;
		FakeProtector(String scheme, String secret) { this.scheme = scheme; this.secret = secret; }
		@Override public String scheme() { return scheme; }
		@Override public byte[] protect(byte[] plain) {
			protectCalls++;
			if (protectFailure != null) sneaky(protectFailure.get());
			return flip(plain);
		}
		@Override public byte[] unprotect(byte[] sealed) {
			if (unprotectFailure != null) sneaky(unprotectFailure.get());
			return flip(sealed);
		}
		private static byte[] flip(byte[] input) {
			byte[] output = new byte[input.length];
			for (int index = 0; index < input.length; index++) output[index] = (byte) (input[input.length - 1 - index] ^ 0x5A);
			return output;
		}
		private static void sneaky(Throwable failure) {
			if (failure instanceof RuntimeException runtime) throw runtime;
			throw (Error) failure;
		}
		@Override public String toString() { return "FakeProtector[" + scheme + "]"; }
	}

	private static int checks;
	private static void check(boolean value, String label) { if (!value) throw new AssertionError(label); checks++; }
}
