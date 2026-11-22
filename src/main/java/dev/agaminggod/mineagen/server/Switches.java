package dev.agaminggod.mineagen.server;

import java.util.Collections;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Properties;

/**
 * The server's gameplay switches, mirroring coordinator/src/switches.mjs for every entry whose side is server or both.
 * Each parser copies its reader's current semantics (exact or any case, trimmed or not), so moving a reader here changes
 * nothing. Nothing calls this yet: the readers move over in a later sweep. coordinator/test/switches.test.mjs reads this
 * source and checks names, sources, defaults, parsers and statuses match the coordinator registry, so keep one entry per
 * line in {@link #ALL} and one {@link Flag} per line.
 */
public final class Switches {
	private Switches() {
	}

	/**
	 * A two-way parser: raw text matching {@code token} means {@code meansOn}, anything else the opposite; with
	 * {@code list}, on when the comma list (items trimmed, exact case) holds the token. Unset is the opposite of the
	 * token's meaning.
	 */
	public record Flag(String token, boolean meansOn, boolean trim, boolean anyCase, boolean list) {
		public String id() {
			if (list) return "list-has:" + token;
			return (meansOn ? "on-if:" : "off-if:") + token + (trim ? "/trim" : "") + (anyCase ? "/any-case" : "");
		}

		public boolean parse(String raw) {
			if (list) {
				for (String word : raw.split(",", -1)) {
					if (word.trim().equals(token)) return true;
				}
				return false;
			}
			String text = trim ? raw.trim() : raw;
			boolean hit = anyCase ? text.equalsIgnoreCase(token) : text.equals(token);
			return hit == meansOn;
		}
	}

	/** One switch: env and property may each be null (not both); a two-source switch is on when either source is. */
	public record Switch(String name, String env, String property, String side, boolean defaultValue, Flag parser, Flag propertyParser, String status) {
	}

	/** A resolved value and where it came from: default, env or property. */
	public record Resolved(boolean value, String source) {
	}

	// Reader shapes: Boolean.getBoolean (any case, no trim), "true".equals, !"false".equals, and the trimmed any-case forms.
	static final Flag JAVA_GET_BOOLEAN = new Flag("true", true, false, true, false);
	static final Flag JAVA_TRUE_EXACT = new Flag("true", true, false, false, false);
	static final Flag JAVA_NOT_FALSE_EXACT = new Flag("false", false, false, false, false);
	static final Flag TRUE_WORD = new Flag("true", true, true, true, false);
	static final Flag NOT_FALSE_WORD = new Flag("false", false, true, true, false);
	static final Flag ON_WORD = new Flag("on", true, true, true, false);
	static final Flag LIST_HAS_INSTINCTS = new Flag("instincts", true, false, false, true);

	/** Server and both-side switches; the reason, numbers and readers for each are in coordinator/src/switches.mjs. */
	public static final List<Switch> ALL = List.of(
		// Instincts.java:19-21 enabled(): per call; property or env.
		new Switch("instincts", "MINEAGEN_INSTINCTS", "mineagen.instincts", "both", false, LIST_HAS_INSTINCTS, JAVA_GET_BOOLEAN, "experimental"),
		// ServerTravelController.java:241-242 walkAroundEnabled(): per call; property or env.
		new Switch("travel.walkAround", "MINEAGEN_TRAVEL_WALK_AROUND", "mineagen.travel.walkAround", "server", false, ON_WORD, JAVA_GET_BOOLEAN, "default-off"),
		// ServerFightUntilController.java:92 COVER: class load.
		new Switch("fight.cover", null, "mineagen.fight.cover", "server", false, JAVA_TRUE_EXACT, null, "default-off"),
		// ServerFightUntilController.java:262 CHARGE_GUARD: class load.
		new Switch("fight.chargeGuard", null, "mineagen.fight.chargeGuard", "server", true, JAVA_NOT_FALSE_EXACT, null, "default-on"),
		// ServerFightUntilController.java:280 RECOVER: class load.
		new Switch("fight.recover", null, "mineagen.fight.recover", "server", true, JAVA_NOT_FALSE_EXACT, null, "default-on"),
		// SpawnerHold.java:15 ENABLED: class load.
		new Switch("fight.spawnerHold", null, "mineagen.fight.spawnerHold", "server", true, JAVA_NOT_FALSE_EXACT, null, "default-on"),
		// SpawnerHold.java:21 OPEN_FIGHT: class load.
		new Switch("fight.spawnerHoldOpen", null, "mineagen.fight.spawnerHoldOpen", "server", true, JAVA_NOT_FALSE_EXACT, null, "default-on"),
		// WarpedForestHunt.java:148 enabled: class load (tests reassign it).
		new Switch("fight.forestHunt", null, "mineagen.fight.forestHunt", "server", false, JAVA_GET_BOOLEAN, null, "default-off"),
		// UnreachableTargets.java:41 fromProperty(): per fight call.
		new Switch("fight.skipUnreachable", null, "mineagen.fight.skipUnreachable", "server", true, JAVA_NOT_FALSE_EXACT, null, "default-on"),
		// KillSighting.java:27 enabled(): per call.
		new Switch("killPosition", null, "mineagen.killPosition", "server", true, NOT_FALSE_WORD, null, "default-on"),
		// Watcher.java:159 enabled(): per call.
		new Switch("watch", null, "mineagen.watch", "server", false, TRUE_WORD, null, "diagnostic")
	);

	static Resolved resolve(Switch item, Map<String, String> env, Map<String, String> properties) {
		String raw = item.env() == null ? null : env.get(item.env());
		Boolean fromEnv = raw == null ? null : item.parser().parse(raw);
		String propertyRaw = item.property() == null ? null : properties.get(item.property());
		Flag propertyParser = item.env() == null ? item.parser() : item.propertyParser();
		Boolean fromProperty = propertyRaw == null ? null : propertyParser.parse(propertyRaw);
		if (item.property() == null) return fromEnv == null ? new Resolved(item.defaultValue(), "default") : new Resolved(fromEnv, "env");
		if (item.env() == null) return fromProperty == null ? new Resolved(item.defaultValue(), "default") : new Resolved(fromProperty, "property");
		// Two sources: on when either is, as the readers OR them.
		if (Boolean.TRUE.equals(fromEnv)) return new Resolved(true, "env");
		if (Boolean.TRUE.equals(fromProperty)) return new Resolved(true, "property");
		if (fromEnv != null) return new Resolved(false, "env");
		if (fromProperty != null) return new Resolved(false, "property");
		return new Resolved(item.defaultValue(), "default");
	}

	/** Every server switch resolved against the given environment and properties, in registry order. */
	public static Map<String, Resolved> resolve(Map<String, String> env, Map<String, String> properties) {
		Map<String, Resolved> resolved = new LinkedHashMap<>();
		for (Switch item : ALL) resolved.put(item.name(), resolve(item, env, properties));
		return Collections.unmodifiableMap(resolved);
	}

	/** Every server switch resolved against this JVM's environment and system properties. */
	public static Map<String, Resolved> current() {
		Properties system = System.getProperties();
		Map<String, String> properties = new LinkedHashMap<>();
		for (String key : system.stringPropertyNames()) properties.put(key, system.getProperty(key));
		return resolve(System.getenv(), properties);
	}

	/** The same line as describeSwitches in coordinator/src/switches.mjs: {@code switches name=on name=off@property ...}. */
	public static String describe(Map<String, Resolved> resolved) {
		StringBuilder line = new StringBuilder("switches");
		for (Map.Entry<String, Resolved> entry : resolved.entrySet()) {
			Resolved value = entry.getValue();
			line.append(' ').append(entry.getKey()).append('=').append(value.value() ? "on" : "off");
			if (!"default".equals(value.source())) line.append('@').append(value.source());
		}
		return line.toString();
	}

	/** {@link #describe(Map)} for this JVM. */
	public static String describe() {
		return describe(current());
	}
}
