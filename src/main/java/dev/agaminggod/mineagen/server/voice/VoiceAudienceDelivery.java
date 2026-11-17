package dev.agaminggod.mineagen.server.voice;

import java.util.LinkedHashSet;
import java.util.List;
import java.util.UUID;
import java.util.concurrent.CompletionStage;
import java.util.concurrent.Executor;
import java.util.function.BiPredicate;
import java.util.function.Consumer;
import java.util.function.Predicate;
import java.util.function.Supplier;

/** Captures human recipients once and keeps audio failures from duplicating text delivery. */
public final class VoiceAudienceDelivery {
	private VoiceAudienceDelivery() { }

	public record Listener(UUID id, boolean sameDimension, double distanceSquared) { }

	public static void speak(List<Listener> listeners, int radius, Predicate<UUID> canReceive,
			Consumer<UUID> text, Supplier<CompletionStage<VoiceReceipt>> speech, Executor executor) {
		speak(listeners, List.of(), radius, canReceive, text, (operator, body) -> false, body -> false, speech, executor);
	}

	/**
	 * Agent bodies in range get the line only when the whole line falls back to text, as the router's player
	 * delivery did before audience routing; that is what a takeover operator sees through the body. A body is skipped
	 * when {@code relaysTo(human, body)} holds for a human who already has the line, which would show it twice. When no
	 * human in range can hear audio, only {@code driven} bodies get it: an undriven body already has the line as its
	 * own conversation event.
	 */
	public static void speak(List<Listener> listeners, List<Listener> agentBodies, int radius, Predicate<UUID> canReceive,
			Consumer<UUID> text, BiPredicate<UUID, UUID> relaysTo, Predicate<UUID> driven,
			Supplier<CompletionStage<VoiceReceipt>> speech, Executor executor) {
		var audio = new LinkedHashSet<UUID>();
		var delivered = new LinkedHashSet<UUID>();
		for (Listener listener : listeners) {
			if (!inRange(listener, radius)) continue;
			if (canReceive.test(listener.id())) audio.add(listener.id());
			else if (delivered.add(listener.id())) text.accept(listener.id());
		}
		var bodies = new LinkedHashSet<UUID>();
		for (Listener body : agentBodies) if (inRange(body, radius)) bodies.add(body.id());
		Runnable bodyFallback = () -> {
			for (UUID body : bodies) {
				if (delivered.stream().noneMatch(human -> relaysTo.test(human, body))) text.accept(body);
			}
		};
		if (audio.isEmpty()) {
			bodies.removeIf(body -> !driven.test(body));
			bodyFallback.run();
			return;
		}
		try {
			speech.get().whenComplete((receipt, failure) -> executor.execute(() -> {
				if (failure == null && receipt != null && receipt.status() == VoiceReceipt.Status.CANCELLED) return;
				boolean fallback = failure != null || receipt == null || receipt.requiresTextFallback();
				for (UUID id : audio) {
					if ((fallback || !canReceive.test(id)) && delivered.add(id)) text.accept(id);
				}
				if (fallback) bodyFallback.run();
			}));
		} catch (RuntimeException failure) {
			for (UUID id : audio) if (delivered.add(id)) text.accept(id);
			bodyFallback.run();
		}
	}

	private static boolean inRange(Listener listener, int radius) {
		return listener.sameDimension() && listener.distanceSquared() <= (double) radius * radius;
	}
}
