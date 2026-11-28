package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.control.AgentControlProvider;
import dev.agaminggod.mineagen.server.BoatAccount;
import java.util.List;
import java.util.Locale;

/**
 * What the mission board's "Runs on" rail says for each boat state, as language keys, so every state is verified
 * headless. Boat is where agents run, never a model: it has a machine block and a sign-in row, nothing in the model
 * picker.
 */
public final class BoatPanelPresentation {
	public enum Tone { BOAT, WARNING, MUTED, ERROR, SUCCESS }

	public enum Action {
		NONE(""),
		SIGN_IN("sign_in:boat"),
		SIGN_OUT("sign_out:boat"),
		STOP_MACHINE("stop_machine");

		private final String command;

		Action(String command) {
			this.command = command;
		}

		/** The action string {@code AgentControlClient.sendBoatAction} takes; empty for none. */
		public String command() {
			return command;
		}
	}

	/** One rendering of the machine block. {@code costShown}: the cost line; {@code specShown}: machine size and price. */
	public record Machine(String phase, String titleKey, Tone tone, String detailKey, boolean specShown, boolean costShown,
			boolean progress, Action action, String actionKey, boolean switchEnabled, String error) {
	}

	/** One "Found on this machine" row: the status key and whether it offers a sign-in button. */
	public record ProviderRow(String id, String nameKey, String statusKey, Tone tone, boolean signIn, String signInAction,
			String signInKey) {
	}

	public static final String CONSENT_KEY = "screen.mineagen.boat.consent";
	public static final List<String> PHASES = List.of("signed_out", "idle", "starting", "running", "stopping");

	private BoatPanelPresentation() {
	}

	/** The machine block for {@code status}, or the unavailable block when this client does not host the world (null). */
	public static Machine machine(BoatAccount.Status status, BoatAccount.Settings settings) {
		boolean runsOnBoat = settings != null && settings.runsOnBoat();
		if (status == null) {
			return new Machine("unavailable", "screen.mineagen.boat.unavailable.title", Tone.MUTED,
					"screen.mineagen.boat.unavailable.detail", false, false, false, Action.NONE, "", false, null);
		}
		String error = status.error() == null || status.error().isBlank() ? null : status.error().strip();
		String phase = status.phase() == null ? "" : status.phase().toLowerCase(Locale.ROOT);
		if (!PHASES.contains(phase)) phase = status.signedIn() ? "idle" : "signed_out";
		return switch (phase) {
			case "signed_out" -> new Machine(phase, "screen.mineagen.boat.signed_out.title", Tone.MUTED,
					"screen.mineagen.boat.signed_out.detail", true, false, false, Action.SIGN_IN,
					"screen.mineagen.boat.sign_in", true, error);
			case "idle" -> new Machine(phase, "screen.mineagen.boat.idle.title", Tone.BOAT,
					runsOnBoat ? "screen.mineagen.boat.idle.detail_boat" : "screen.mineagen.boat.idle.detail_local", true, false, false,
					Action.SIGN_OUT, "screen.mineagen.boat.sign_out", true, error);
			case "starting" -> new Machine(phase, "screen.mineagen.boat.starting.title", Tone.WARNING,
					"screen.mineagen.boat.starting.detail", false, true, true, Action.STOP_MACHINE,
					"screen.mineagen.boat.stop_machine", true, error);
			case "running" -> new Machine(phase, "screen.mineagen.boat.running.title", Tone.BOAT,
					"", true, true, false, Action.STOP_MACHINE, "screen.mineagen.boat.stop_machine", true, error);
			default -> new Machine(phase, "screen.mineagen.boat.stopping.title", Tone.MUTED,
					"screen.mineagen.boat.stopping.detail", false, true, false, Action.NONE, "", false, error);
		};
	}

	/** The header pill: boat with its size and price while agents run there, otherwise "This PC". */
	public static boolean pillShowsBoat(BoatAccount.Status status, BoatAccount.Settings settings) {
		if (status == null) return false;
		boolean active = "starting".equals(status.phase()) || "running".equals(status.phase()) || "stopping".equals(status.phase());
		return active || settings != null && settings.runsOnBoat() && status.signedIn();
	}

	/**
	 * The header's compute pill: where agents run in a word or two, the live cost while a machine runs, and a dot
	 * when a model tool needs signing in. {@code arg} fills the key's one placeholder, empty when it has none.
	 */
	public record Pill(String key, String arg, Tone tone, boolean attention) {
	}

	public static Pill pill(BoatAccount.Status status, BoatAccount.Settings settings, List<ProviderRow> providers) {
		boolean attention = providers != null && providers.stream()
				.anyMatch(row -> !"boat".equals(row.id()) && row.signIn() && row.tone() == Tone.WARNING);
		if (status == null) return new Pill("screen.mineagen.boat.pill_local", "", Tone.MUTED, attention);
		if (status.error() != null && !status.error().isBlank()) return new Pill("screen.mineagen.boat.pill_error", "", Tone.ERROR, attention);
		String phase = status.phase() == null ? "" : status.phase().toLowerCase(Locale.ROOT);
		return switch (phase) {
			case "starting" -> new Pill("screen.mineagen.boat.pill_starting", "", Tone.WARNING, attention);
			case "stopping" -> new Pill("screen.mineagen.boat.pill_stopping", "", Tone.MUTED, attention);
			case "running" -> new Pill("screen.mineagen.boat.pill", dollars(status.costDollars()), Tone.BOAT, attention);
			default -> settings != null && settings.runsOnBoat() && status.signedIn()
					? new Pill("screen.mineagen.boat.pill_ready", "", Tone.BOAT, attention)
					: new Pill("screen.mineagen.boat.pill_local", "", Tone.MUTED, attention);
		};
	}

	/** "$0.013": cents below a dollar keep a third digit so a few minutes of a small machine still shows. */
	public static String dollars(double amount) {
		double value = Double.isFinite(amount) ? Math.max(0D, amount) : 0D;
		return value < 1D ? String.format(Locale.ROOT, "$%.3f", value) : String.format(Locale.ROOT, "$%.2f", value);
	}

	/**
	 * The Codex, Claude and boat rows, always all three. A model tool missing from the scan counts as missing, and a
	 * missing or signed-out row offers its sign-in.
	 */
	public static List<ProviderRow> providerRows(List<AgentControlProvider> scanned, BoatAccount.Status boat) {
		return List.of(modelRow("codex", find(scanned, "codex")), modelRow("claude", find(scanned, "claude")), boatRow(boat));
	}

	private static AgentControlProvider find(List<AgentControlProvider> scanned, String id) {
		if (scanned == null) return null;
		return scanned.stream().filter(row -> id.equals(row.id())).findFirst().orElse(null);
	}

	static ProviderRow modelRow(String id, AgentControlProvider row) {
		String name = "screen.mineagen.provider." + id;
		String signIn = "screen.mineagen.provider.sign_in_" + id;
		String action = "sign_in:" + id;
		if (row == null) return new ProviderRow(id, name, "screen.mineagen.provider.status.missing", Tone.ERROR, true, action, signIn);
		if (Boolean.FALSE.equals(row.installed())) {
			return new ProviderRow(id, name, "screen.mineagen.provider.status.not_installed", Tone.ERROR, true, action, signIn);
		}
		if (row.installed() == null) return new ProviderRow(id, name, "screen.mineagen.provider.status.checking", Tone.MUTED, false, action, signIn);
		if (Boolean.FALSE.equals(row.signedIn()) && row.apiKeySuffix() == null) {
			return new ProviderRow(id, name, "screen.mineagen.provider.status.signed_out", Tone.WARNING, true, action, signIn);
		}
		return new ProviderRow(id, name, row.apiKeySuffix() != null ? "screen.mineagen.provider.status.api_key"
				: "screen.mineagen.provider.status.ready", Tone.SUCCESS, false, action, signIn);
	}

	static ProviderRow boatRow(BoatAccount.Status status) {
		String name = "screen.mineagen.provider.boat";
		String signIn = "screen.mineagen.boat.sign_in";
		if (status == null) return new ProviderRow("boat", name, "screen.mineagen.provider.status.unavailable", Tone.MUTED, false, "sign_in:boat", signIn);
		if (!status.signedIn()) return new ProviderRow("boat", name, "screen.mineagen.provider.status.signed_out", Tone.WARNING, true, "sign_in:boat", signIn);
		return new ProviderRow("boat", name, "cli".equals(status.via()) ? "screen.mineagen.provider.status.boat_cli"
				: "screen.mineagen.provider.status.signed_in", Tone.SUCCESS, false, "sign_in:boat", signIn);
	}

	/** Every key the rail can show, for the localization check. */
	public static List<String> keys() {
		return List.of(CONSENT_KEY,
				"screen.mineagen.boat.unavailable.title", "screen.mineagen.boat.unavailable.detail",
				"screen.mineagen.boat.signed_out.title", "screen.mineagen.boat.signed_out.detail",
				"screen.mineagen.boat.idle.title", "screen.mineagen.boat.idle.detail_boat", "screen.mineagen.boat.idle.detail_local",
				"screen.mineagen.boat.starting.title", "screen.mineagen.boat.starting.detail",
				"screen.mineagen.boat.running.title", "screen.mineagen.boat.stopping.title", "screen.mineagen.boat.stopping.detail",
				"screen.mineagen.boat.sign_in", "screen.mineagen.boat.sign_out", "screen.mineagen.boat.stop_machine",
				"screen.mineagen.provider.codex", "screen.mineagen.provider.claude", "screen.mineagen.provider.boat",
				"screen.mineagen.provider.sign_in_codex", "screen.mineagen.provider.sign_in_claude",
				"screen.mineagen.provider.status.missing", "screen.mineagen.provider.status.not_installed",
				"screen.mineagen.provider.status.checking", "screen.mineagen.provider.status.signed_out",
				"screen.mineagen.provider.status.api_key", "screen.mineagen.provider.status.ready",
				"screen.mineagen.provider.status.unavailable", "screen.mineagen.provider.status.boat_cli",
				"screen.mineagen.provider.status.signed_in");
	}
}
