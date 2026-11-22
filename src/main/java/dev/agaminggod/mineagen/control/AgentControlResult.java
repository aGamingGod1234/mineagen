package dev.agaminggod.mineagen.control;

import java.util.ArrayList;
import java.util.List;
import java.util.Objects;
import java.util.function.ToIntFunction;

/**
 * What the server did with the viewer's latest control command: accepted, or refused with a plain reason. It rides
 * in that viewer's control snapshot so the Control Center can show a refusal instead of leaving it in chat only.
 * {@code sequence} rises with every result the server records, so a screen shows each one once.
 */
public record AgentControlResult(long sequence, boolean accepted, String message) {
	public static final int MAX_MESSAGE_LENGTH = 240;

	public AgentControlResult {
		if (sequence <= 0L) throw new IllegalArgumentException("result sequence must be positive");
		message = Objects.requireNonNull(message, "message must not be null").strip();
		if (message.isEmpty()) message = accepted ? "Done." : "The server refused that change.";
		if (message.length() > MAX_MESSAGE_LENGTH) message = message.substring(0, MAX_MESSAGE_LENGTH - 3) + "...";
	}

	/** How a status line is drawn: a change still on its way, a confirmed success, or a refusal. */
	public enum Tone {
		PENDING,
		SUCCESS,
		REFUSED
	}

	public Tone tone() {
		return accepted ? Tone.SUCCESS : Tone.REFUSED;
	}

	/**
	 * {@code text} broken at spaces into lines no wider than {@code width} as {@code measure} counts them. A word wider
	 * than a whole line is split by character. Every word of the text is kept; nothing is cut off with "...".
	 */
	public static List<String> wrap(String text, int width, ToIntFunction<String> measure) {
		Objects.requireNonNull(measure, "measure must not be null");
		String checked = Objects.requireNonNullElse(text, "").strip();
		List<String> lines = new ArrayList<>();
		if (checked.isEmpty()) return List.of();
		int limit = Math.max(1, width);
		String line = "";
		for (String word : checked.split("\\s+")) {
			String candidate = line.isEmpty() ? word : line + " " + word;
			if (measure.applyAsInt(candidate) <= limit) {
				line = candidate;
				continue;
			}
			if (!line.isEmpty()) lines.add(line);
			line = word;
			// A word wider than a whole line is split by character so none of it is lost.
			while (line.length() > 1 && measure.applyAsInt(line) > limit) {
				int fits = 1;
				while (fits < line.length() - 1 && measure.applyAsInt(line.substring(0, fits + 1)) <= limit) fits++;
				lines.add(line.substring(0, fits));
				line = line.substring(fits);
			}
		}
		if (!line.isEmpty()) lines.add(line);
		return List.copyOf(lines);
	}
}
