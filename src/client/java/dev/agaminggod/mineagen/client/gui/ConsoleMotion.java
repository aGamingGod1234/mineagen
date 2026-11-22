package dev.agaminggod.mineagen.client.gui;

/**
 * One eased value that follows a target at a fixed speed, advanced by real frame time. Widgets keep one per
 * animated property (hover, selection, a sliding highlight); a new widget starts at its target, so rebuilding a
 * screen never replays motion.
 */
public final class ConsoleMotion {
	private float value;
	private long lastNanos;
	private boolean started;

	/** Moves toward {@code target}, covering the full 0..1 range in {@code durationMs}; returns the eased value. */
	public float toward(float target, int durationMs) {
		long now = System.nanoTime();
		if (!started) {
			started = true;
			value = target;
			lastNanos = now;
			return target;
		}
		float elapsedMs = Math.min(100F, (now - lastNanos) / 1_000_000F);
		lastNanos = now;
		float step = durationMs <= 0 ? 1F : elapsedMs / durationMs;
		value += Math.clamp(target - value, -step, step);
		return value;
	}

	/** Raw linear value, for positions that should ease with {@link #smooth(float)}. */
	public float value() {
		return value;
	}

	public static float smooth(float t) {
		float x = Math.clamp(t, 0F, 1F);
		return x * x * (3F - 2F * x);
	}
}
