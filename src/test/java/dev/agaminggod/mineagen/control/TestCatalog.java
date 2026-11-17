package dev.agaminggod.mineagen.control;

import java.util.ArrayList;
import java.util.List;

/**
 * The mod bundles no catalog; verifications that need models install this one, shaped like a coordinator's
 * discovery on a machine with Codex and Claude Code.
 */
public final class TestCatalog {
	private TestCatalog() {
	}

	public static final List<AgentControlModelOption> OPTIONS = build();

	public static void install() {
		AgentControlCatalog.installRuntimeCatalog(OPTIONS, rows());
	}

	public static List<AgentControlProvider> rows() {
		return List.of(
				row("codex", "Codex CLI", 0x55FFFF, "gpt-6.1-sol", "plan_percent"),
				row("claude", "Claude Code", 0xFFAA00, null, "plan_percent"));
	}

	private static AgentControlProvider row(String id, String label, int color, String defaultModel, String limitKind) {
		List<String> free = OPTIONS.stream().filter(option -> option.provider().equals(id) && option.model().endsWith("-free"))
				.map(AgentControlModelOption::model).toList();
		return new AgentControlProvider(id, label, color, true, "1.0", true, null, null, defaultModel, free, limitKind, null, 1L);
	}

	private static List<AgentControlModelOption> build() {
		ArrayList<AgentControlModelOption> values = new ArrayList<>();
		add(values, "codex", "gpt-6-astra", "GPT 6 Astra", List.of("low", "medium", "high", "xhigh", "max", "ultra"), true);
		add(values, "codex", "gpt-6.1-sol", "GPT-6.1 Sol", List.of("low", "medium", "high", "xhigh", "max", "ultra"), true);
		add(values, "codex", "gpt-6-luna", "GPT 6 Luna", List.of("low", "medium", "high", "xhigh", "max"), true);
		add(values, "claude", "claude-opus-5-5", "Claude Opus 5.5", List.of("low", "medium", "high"), false);
		add(values, "claude", "claude-sonnet-5-5", "Claude Sonnet 5.5", List.of("low", "medium", "high"), false);
		add(values, "claude", "claude-fable-5-1", "Claude Fable 5.1", List.of("low", "medium", "high"), false);
		return List.copyOf(values);
	}

	private static void add(List<AgentControlModelOption> values, String provider, String model,
	                        String displayName, List<String> efforts, boolean fast) {
		values.add(new AgentControlModelOption(provider, model, displayName, efforts,
				fast ? List.of("default", "priority", "fast") : List.of()));
	}
}
