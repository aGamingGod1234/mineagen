package dev.agaminggod.mineagen.server;

import com.google.gson.JsonElement;
import com.google.gson.JsonParser;
import dev.agaminggod.mineagen.agent.AgentRecord;
import java.util.ArrayDeque;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.regex.Pattern;

/** Hides credentials, prompts, world dumps and technical identifiers before agent text reaches chat. */
public final class AgentChatSanitizer {
	public static final int MAX_MESSAGE_LENGTH = 256;
	private static final Pattern UUID_PATTERN = Pattern.compile(
			"(?i)\\b[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}\\b"
	);
	private static final List<Pattern> TECHNICAL_ID_PATTERNS = List.of(
			Pattern.compile("(?i)\\b(?:action|call|trace)[ _-]?id\\b\\s*[:=]"),
			Pattern.compile("(?i)\\baction-progress-\\d+\\b"),
			Pattern.compile("(?i)\\bcall_[a-z0-9]{3,}\\b"),
			Pattern.compile("(?i)\\b[a-z0-9._-]+:\\d+:\\d+:\\d+:program-\\d+-\\d+:\\d+:\\d+:(?:arena-state|step)-\\d+\\b"),
			Pattern.compile("(?i)\\bprogram-\\d+-\\d+:\\d+:\\d+:(?:arena-state|step)-\\d+\\b"),
			Pattern.compile("(?i)\\btrace-[a-z0-9._:-]+-\\d+-\\d+-[a-z][a-z0-9_-]*\\b")
	);
	private static final List<String> CREDENTIAL_MARKERS = List.of(
			"api key", "api_key", "apikey", "authorization", "bearer ", "credential",
			"password", "secret", "token", "x-api-key", "sk-", "aiza"
	);
	private static final List<String> WORLD_DUMP_MARKERS = List.of(
			"world dump", "observation dump", "block dump", "entity dump", "chunk dump",
			"inventory dump", "raw observation"
	);
	private static final List<String> TECHNICAL_MARKERS = List.of(
			"actionid", "action_id", "callid", "call_id", "tool call", "tool_call",
			"traceid", "trace_id", "program step", "diagnostic"
	);

	private AgentChatSanitizer() {
	}

	public static String sanitizeMessage(String message) {
		String compact = compact(Objects.requireNonNull(message, "message must not be null"));
		String lower = compact.toLowerCase(Locale.ROOT);
		if (CREDENTIAL_MARKERS.stream().anyMatch(lower::contains)) return "Sensitive details redacted.";
		if (lower.contains("prompt:") || lower.contains("system prompt") || lower.contains("private instruction")) {
			return "Private prompt details redacted.";
		}
		if (WORLD_DUMP_MARKERS.stream().anyMatch(lower::contains)) {
			return "World details redacted.";
		}
		if (lower.contains("native:") || containsJsonContainer(compact)
				|| TECHNICAL_MARKERS.stream().anyMatch(lower::contains) || UUID_PATTERN.matcher(compact).find()
				|| TECHNICAL_ID_PATTERNS.stream().anyMatch(pattern -> pattern.matcher(compact).find())) {
			return "Technical details hidden.";
		}
		if (compact.isBlank()) return "No details.";
		return bound(compact);
	}

	public static String sanitizeMessage(AgentRecord record, String message) {
		String safe = sanitizeMessage(message);
		if (safe.endsWith("redacted.")) return safe;
		String lower = compact(message).toLowerCase(Locale.ROOT);
		boolean exposesCurrentGoal = record.currentGoal()
				.map(goal -> compact(goal.prompt()).toLowerCase(Locale.ROOT))
				.filter(prompt -> prompt.length() >= 8)
				.map(prompt -> lower.contains(prompt) || lower.length() >= 16 && prompt.contains(lower))
				.orElse(false);
		if (exposesCurrentGoal) return "Private prompt details redacted.";
		return safe;
	}

	private static String compact(String value) {
		StringBuilder result = new StringBuilder(value.length());
		boolean separatorPending = false;
		for (int offset = 0; offset < value.length();) {
			int codePoint = value.codePointAt(offset);
			offset += Character.charCount(codePoint);
			if (Character.isWhitespace(codePoint) || Character.isISOControl(codePoint)) {
				separatorPending = result.length() > 0;
				continue;
			}
			if (separatorPending) result.append(' ');
			separatorPending = false;
			result.appendCodePoint(codePoint);
		}
		return result.toString();
	}

	private static boolean containsJsonContainer(String value) {
		for (int start = 0; start < value.length(); start++) {
			char opening = value.charAt(start);
			if (opening != '[' && opening != '{') continue;
			int end = matchingJsonContainerEnd(value, start);
			if (end < 0) continue;
			try {
				JsonElement parsed = JsonParser.parseString(value.substring(start, end + 1));
				if (parsed.isJsonArray() || parsed.isJsonObject()) return true;
			} catch (RuntimeException ignored) {
				// Bracketed natural-language prose is not a technical JSON record.
			}
		}
		return false;
	}

	private static int matchingJsonContainerEnd(String value, int start) {
		ArrayDeque<Character> closings = new ArrayDeque<>();
		closings.push(value.charAt(start) == '[' ? ']' : '}');
		boolean quoted = false;
		boolean escaped = false;
		for (int index = start + 1; index < value.length(); index++) {
			char current = value.charAt(index);
			if (quoted) {
				if (escaped) {
					escaped = false;
				} else if (current == '\\') {
					escaped = true;
				} else if (current == '"') {
					quoted = false;
				}
				continue;
			}
			if (current == '"') {
				quoted = true;
			} else if (current == '[') {
				closings.push(']');
			} else if (current == '{') {
				closings.push('}');
			} else if (current == ']' || current == '}') {
				if (closings.isEmpty() || closings.pop() != current) return -1;
				if (closings.isEmpty()) return index;
			}
		}
		return -1;
	}

	private static String bound(String value) {
		if (value.length() <= MAX_MESSAGE_LENGTH) return value;
		int end = MAX_MESSAGE_LENGTH - 3;
		if (Character.isHighSurrogate(value.charAt(end - 1)) && Character.isLowSurrogate(value.charAt(end))) end--;
		return value.substring(0, end) + "...";
	}
}
