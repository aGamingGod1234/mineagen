package dev.agaminggod.mineagen.client.gui;

import java.util.Locale;
import java.util.regex.Matcher;
import java.util.regex.Pattern;

/**
 * Turns the coordinator's live events into lines a player reads: "Mining 3 iron ore", "Walking to 120, 64, -30",
 * "Said: on my way". Tool calls arrive as {@code <tool> <json args>} and are cut at 1200 characters, so arguments are
 * read field by field and a cut-off value is simply missing. Plumbing (provider, planner, status...) is dropped, and
 * an event this class does not know is dropped too rather than shown raw.
 */
final class ActivityText {
	enum Kind { ACTION, THOUGHT, SAID, LIFE, WARNING, ERROR }

	record Line(Kind kind, String text) {
	}

	private static final Pattern STRING_FIELD = Pattern.compile("\"(\\w+)\"\\s*:\\s*\"([^\"]*)\"");
	private static final Pattern NUMBER_FIELD = Pattern.compile("\"(\\w+)\"\\s*:\\s*(-?\\d+(?:\\.\\d+)?)");
	private static final Pattern FIRST_IN_ARRAY = Pattern.compile("\"(blockIds|ids|items|itemIds)\"\\s*:\\s*\\[\\s*\"([^\"]+)\"");
	private static final int MAX = 160;

	private ActivityText() {
	}

	/** The line for one event, or null when it is plumbing or unknown. {@code stage} may carry its "live_" prefix. */
	static Line of(String stage, String message) {
		String kind = stage == null ? "" : stage.trim().toLowerCase(Locale.ROOT);
		if (kind.startsWith("live_")) kind = kind.substring(5);
		String text = message == null ? "" : message.replace('\n', ' ').replace('\r', ' ').replaceAll("\\s+", " ").trim();
		if (text.isEmpty()) return null;
		return switch (kind) {
			case "tool", "action" -> tool(text);
			case "delta", "summary", "reasoning", "thinking" -> new Line(Kind.THOUGHT, cap(text));
			case "agent_message", "say", "chat" -> new Line(Kind.SAID, "Said: " + cap(unquote(text)));
			case "lifecycle" -> lifecycle(text);
			case "retry" -> new Line(Kind.WARNING, "Hit a snag, trying again");
			case "error", "failure" -> new Line(Kind.ERROR, cap(sentence(text)));
			default -> null;
		};
	}

	static Line lifecycle(String text) {
		String lower = text.toLowerCase(Locale.ROOT);
		if (lower.contains("registered and ready")) return new Line(Kind.LIFE, "Joined the world");
		if (lower.contains("reconciled and ready")) return new Line(Kind.LIFE, "Reconnected");
		if (lower.contains("removed from the coordinator")) return new Line(Kind.LIFE, "Left the roster");
		Matcher operation = Pattern.compile("operation '(\\w+)'").matcher(lower);
		if (operation.find()) {
			return switch (operation.group(1)) {
				case "start" -> new Line(Kind.LIFE, "Started a new task");
				case "queue" -> new Line(Kind.LIFE, "Queued the next task");
				case "steer" -> new Line(Kind.LIFE, "Took new directions");
				case "stop", "pause" -> new Line(Kind.LIFE, "Paused");
				case "resume" -> new Line(Kind.LIFE, "Picked the task back up");
				default -> null;
			};
		}
		return null;
	}

	/** A tool call, {@code name {args...}}: the verb from the name, the object from the first argument that names one. */
	static Line tool(String text) {
		int space = text.indexOf(' ');
		String name = (space < 0 ? text : text.substring(0, space)).trim();
		String args = space < 0 ? "" : text.substring(space + 1);
		String block = firstOf(args, "expectedBlockId", "blockId", "block", "targetBlock");
		String item = firstOf(args, "itemId", "item", "output", "recipe");
		String entity = firstOf(args, "entityId", "entity", "target", "mob");
		if (block.isEmpty()) block = firstInArray(args);
		long count = number(args, "count", "quantity", "amount");
		String key = name.replaceAll("[_\\-\\s]", "").toLowerCase(Locale.ROOT);
		String phrase = switch (key) {
			case "mine", "gather", "collect", "harvest", "dig", "break", "breakblock", "mineblock" ->
					"Mining " + amount(count, block.isEmpty() ? item : block, "blocks");
			case "digdown" -> "Digging down";
			case "travelto", "moveto", "goto", "walkto", "navigate", "walk", "pathto" -> "Walking to " + place(args);
			case "explorefrontier", "explore", "wander" -> "Exploring";
			case "craft", "craftitem" -> "Crafting " + amount(count, item, "an item");
			case "smelt", "smeltitem" -> "Smelting " + amount(count, item, "an item");
			case "place", "placeblock" -> "Placing " + amount(count, block.isEmpty() ? item : block, "a block");
			case "equip" -> "Equipping " + named(item, "gear");
			case "eat", "consume" -> "Eating " + named(item, "").trim();
			case "attack", "fight", "kill", "hunt" -> "Fighting " + named(entity, "a mob");
			case "observe", "inspect", "lookaround", "survey", "scan", "look" -> "Looking around";
			case "wait", "sleep", "idle" -> "Waiting";
			case "taskplan", "plan", "updateplan" -> "Planning the task";
			case "dostep", "step" -> "Working on the plan";
			case "finish", "done", "complete" -> "Wrapping up the task";
			case "runprogram", "program" -> "Running a routine";
			case "inventory", "checkinventory" -> "Checking its inventory";
			case "say", "chat" -> null;
			case "act" -> act(args, item, block, entity, count);
			default -> words(name);
		};
		return phrase == null || phrase.isBlank() ? null : new Line(Kind.ACTION, cap(phrase.trim()));
	}

	private static String act(String args, String item, String block, String entity, long count) {
		String type = firstOf(args, "actionType", "type", "action");
		String key = type.replaceAll("[_\\-\\s]", "").toLowerCase(Locale.ROOT);
		return switch (key) {
			case "craft", "craftitem" -> "Crafting " + amount(count, item, "an item");
			case "smelt", "smeltitem" -> "Smelting " + amount(count, item, "an item");
			case "place", "placeblock" -> "Placing " + amount(count, block.isEmpty() ? item : block, "a block");
			case "equip" -> "Equipping " + named(item, "gear");
			case "eat" -> ("Eating " + named(item, "")).trim();
			case "attack" -> "Fighting " + named(entity, "a mob");
			case "use", "useitem" -> "Using " + named(item, "an item");
			case "" -> "Acting";
			default -> {
				String verb = words(type);
				String object = !item.isEmpty() ? item : !block.isEmpty() ? block : entity;
				yield object.isEmpty() ? verb : verb + " " + name(object);
			}
		};
	}

	private static String amount(long count, String id, String fallback) {
		if (id.isEmpty()) return fallback;
		String noun = name(id);
		return count > 1 ? count + " " + noun : noun;
	}

	private static String named(String id, String fallback) {
		return id.isEmpty() ? fallback : name(id);
	}

	private static String place(String args) {
		long x = number(args, "x"), y = number(args, "y"), z = number(args, "z");
		if (x != Long.MIN_VALUE && z != Long.MIN_VALUE) return y != Long.MIN_VALUE ? x + ", " + y + ", " + z : x + ", " + z;
		String target = firstOf(args, "target", "destination", "label", "name", "blockId");
		return target.isEmpty() ? "a new spot" : name(target);
	}

	/** "minecraft:iron_ore" reads "iron ore". */
	static String name(String id) {
		String path = id.substring(id.indexOf(':') + 1);
		return path.replace('_', ' ').replace('/', ' ').trim().toLowerCase(Locale.ROOT);
	}

	/** "lookAround" or "check_furnace" reads "Look around", "Check furnace". */
	static String words(String name) {
		String spaced = name.replaceAll("([a-z])([A-Z])", "$1 $2").replace('_', ' ').replace('-', ' ').trim().toLowerCase(Locale.ROOT);
		if (spaced.isEmpty() || !spaced.matches("[a-z0-9 ]+")) return null;
		return Character.toUpperCase(spaced.charAt(0)) + spaced.substring(1);
	}

	private static String firstOf(String args, String... keys) {
		Matcher matcher = STRING_FIELD.matcher(args);
		String[] found = new String[keys.length];
		while (matcher.find()) {
			for (int index = 0; index < keys.length; index++) {
				if (found[index] == null && matcher.group(1).equals(keys[index]) && !matcher.group(2).isBlank()) found[index] = matcher.group(2).trim();
			}
		}
		for (String value : found) if (value != null) return value;
		return "";
	}

	private static String firstInArray(String args) {
		Matcher matcher = FIRST_IN_ARRAY.matcher(args);
		return matcher.find() ? matcher.group(2).trim() : "";
	}

	private static long number(String args, String... keys) {
		Matcher matcher = NUMBER_FIELD.matcher(args);
		while (matcher.find()) {
			for (String key : keys) {
				if (matcher.group(1).equals(key)) return Math.round(Double.parseDouble(matcher.group(2)));
			}
		}
		return Long.MIN_VALUE;
	}

	private static String unquote(String text) {
		if (text.length() >= 2 && text.startsWith("\"") && text.endsWith("\"")) return text.substring(1, text.length() - 1);
		return text;
	}

	private static String sentence(String text) {
		return Character.toUpperCase(text.charAt(0)) + text.substring(1);
	}

	private static String cap(String text) {
		return text.length() <= MAX ? text : text.substring(0, MAX).stripTrailing() + "...";
	}
}
