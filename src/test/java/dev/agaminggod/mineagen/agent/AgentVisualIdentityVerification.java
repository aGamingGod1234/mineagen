package dev.agaminggod.mineagen.agent;

import com.google.gson.JsonParser;
import dev.agaminggod.mineagen.control.AgentControlCatalog;
import dev.agaminggod.mineagen.control.AgentControlModelOption;
import dev.agaminggod.mineagen.control.TestCatalog;
import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.Optional;

/** Brand sharing must preserve identity, provider discovery and safe loading of older saves. */
public final class AgentVisualIdentityVerification {
	private static int checks;
	private AgentVisualIdentityVerification() { }

	public static int verify() {
		checks = 0;
		for (int variant = 0; variant < 4; variant++) {
			for (String provider : List.of("codex", "claude")) {
				String brand = provider.equals("codex") ? "openai" : "claude";
				for (String model : List.of("gpt-6.1-sol", "claude-sonnet-5-5", "future-model")) {
					var identity = AgentVisualIdentity.resolve(provider, model, variant);
					equal("mineagen:textures/entity/brand_" + brand + "_agent_" + variant + ".png",
							identity.texturePath(), "every model uses its provider brand");
					equal(identity.texturePath(), AgentVisualIdentity.renderTexturePath(identity), "renderer uses the same skin");
				}
			}
		}
		for (String provider : List.of("gemini", "deepseek", "antigravity", "opencode")) {
			try {
				new AgentProfile(provider, "old-model", "high", Optional.empty(), 0);
				throw new AssertionError("removed provider accepted");
			} catch (AgentDomainException expected) {
				equal("PROVIDER_REMOVED", expected.code(), "profile admission rejects the removed provider");
				check(expected.getMessage().contains(provider) && expected.getMessage().contains("Codex"),
						"rejection identifies the provider and a supported choice");
			}
		}
		var registry = AgentRegistry.createDefault(() -> { }, transition -> { });
		registry.create("codex", "gpt-6.1-sol", "high", Optional.of("Kept"), AgentGameMode.SURVIVAL, 1_000L);
		var codec = new AgentRegistrySnapshotCodec();
		var encoded = JsonParser.parseString(codec.encode(registry.snapshot())).getAsJsonObject();
		for (String provider : List.of("gemini", "deepseek", "opencode")) {
			var legacy = encoded.getAsJsonArray("agents").get(0).deepCopy().getAsJsonObject();
			legacy.addProperty("agent_id", AgentId.random().toString());
			legacy.getAsJsonObject("profile").addProperty("provider", provider);
			encoded.getAsJsonArray("agents").add(legacy);
		}
		var restored = codec.decode(encoded.toString());
		equal(1, restored.records().size(), "unsupported saved profiles do not prevent supported agents loading");
		equal("codex", restored.records().getFirst().profile().provider(), "the supported saved profile is retained");
		var options = new ArrayList<>(TestCatalog.OPTIONS);
		for (String provider : List.of("gemini", "deepseek", "opencode", "future-provider")) {
			options.add(new AgentControlModelOption(provider, "custom/model", "Custom model", List.of("high"), List.of()));
		}
		try {
			AgentControlCatalog.installRuntimeCatalog(options, TestCatalog.rows());
			check(!AgentControlCatalog.providers().contains("gemini") && !AgentControlCatalog.providers().contains("deepseek"),
					"an older coordinator cannot reintroduce removed choices");
			check(!AgentControlCatalog.providers().contains("opencode"), "OpenCode cannot be reintroduced by an older coordinator");
			check(AgentControlCatalog.providers().contains("future-provider"), "future providers need no bridge change");
			equal("mineagen:textures/entity/brand_openai_agent_0.png",
					new AgentProfile("future-provider", "custom/model", "high", Optional.empty(), 0).visualIdentity().texturePath(),
					"a new provider has a usable retained skin");
		} finally {
			TestCatalog.install();
		}
		return checks;
	}

	private static void equal(Object expected, Object actual, String label) {
		checks++;
		if (!Objects.equals(expected, actual)) throw new AssertionError(label + ": expected=" + expected + ", actual=" + actual);
	}

	private static void check(boolean condition, String label) {
		checks++;
		if (!condition) throw new AssertionError(label);
	}
}
