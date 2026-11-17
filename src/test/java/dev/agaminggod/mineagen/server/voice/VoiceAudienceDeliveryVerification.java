package dev.agaminggod.mineagen.server.voice;

import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Set;
import java.util.UUID;
import java.util.concurrent.CompletableFuture;

final class VoiceAudienceDeliveryVerification {
	static void verify() {
		UUID voice = UUID.randomUUID(), text = UUID.randomUUID(), far = UUID.randomUUID(), dimension = UUID.randomUUID();
		List<VoiceAudienceDelivery.Listener> listeners = List.of(
				new VoiceAudienceDelivery.Listener(voice, true, 48 * 48),
				new VoiceAudienceDelivery.Listener(text, true, 1),
				new VoiceAudienceDelivery.Listener(far, true, 48 * 48 + 1),
				new VoiceAudienceDelivery.Listener(dimension, false, 0));
		for (String outcome : List.of("success", "failed", "disconnected", "cancelled")) {
			Set<UUID> connected = new HashSet<>(Set.of(voice));
			List<UUID> delivered = new ArrayList<>();
			int[] calls = { 0 };
			var pending = new CompletableFuture<VoiceReceipt>();
			VoiceAudienceDelivery.speak(listeners, 48, connected::contains, delivered::add,
					() -> { calls[0]++; return pending; }, Runnable::run);
			check(delivered.equals(List.of(text)), "text-only listener receives text immediately");
			check(calls[0] == 1, "one eligible listener admits synthesis");
			if (outcome.equals("disconnected")) connected.clear();
			pending.complete(outcome.equals("failed") ? VoiceReceipt.degraded("fake failure")
					: outcome.equals("cancelled") ? VoiceReceipt.cancelled() : VoiceReceipt.accepted());
			check(delivered.equals(outcome.equals("failed") || outcome.equals("disconnected")
					? List.of(text, voice) : List.of(text)), "fallback is targeted once and cancellation stays silent: " + outcome);
		}
		List<UUID> delivered = new ArrayList<>();
		VoiceAudienceDelivery.speak(listeners, 48, id -> false, delivered::add,
				() -> { throw new AssertionError("text-only audience must make zero TTS calls"); }, Runnable::run);
		check(delivered.equals(List.of(voice, text)), "dimension and distance boundaries exclude ineligible listeners");
		VoiceAudienceDelivery.speak(List.of(), 48, id -> true, delivered::add,
				() -> { throw new AssertionError("empty audience must make zero TTS calls"); }, Runnable::run);
		verifyAgentBodies(listeners, voice, text);
		VoiceRelayFallbackVerification.verify();
	}
	/** Whole-line fallback reaches in-range bodies (the speaker's too) unless their operator already has the line. */
	private static void verifyAgentBodies(List<VoiceAudienceDelivery.Listener> listeners, UUID voice, UUID text) {
		UUID source = UUID.randomUUID(), near = UUID.randomUUID(), driven = UUID.randomUUID(), far = UUID.randomUUID();
		List<VoiceAudienceDelivery.Listener> bodies = List.of(
				new VoiceAudienceDelivery.Listener(source, true, 0),
				new VoiceAudienceDelivery.Listener(near, true, 48 * 48),
				new VoiceAudienceDelivery.Listener(driven, true, 4),
				new VoiceAudienceDelivery.Listener(far, true, 48 * 48 + 1),
				new VoiceAudienceDelivery.Listener(UUID.randomUUID(), false, 0));
		java.util.function.BiPredicate<UUID, UUID> relays = (human, body) -> human.equals(text) && body.equals(driven);
		for (String outcome : List.of("success", "failed", "disconnected", "cancelled", "thrown")) {
			Set<UUID> connected = new HashSet<>(Set.of(voice));
			List<UUID> delivered = new ArrayList<>();
			var pending = new CompletableFuture<VoiceReceipt>();
			VoiceAudienceDelivery.speak(listeners, bodies, 48, connected::contains, delivered::add, relays, Set.of(driven)::contains, () -> {
				if (outcome.equals("thrown")) throw new IllegalStateException("fake transport failure");
				return pending;
			}, Runnable::run);
			if (outcome.equals("disconnected")) connected.clear();
			if (!outcome.equals("thrown")) pending.complete(outcome.equals("failed") ? VoiceReceipt.degraded("fake failure")
					: outcome.equals("cancelled") ? VoiceReceipt.cancelled() : VoiceReceipt.accepted());
			boolean fallback = outcome.equals("failed") || outcome.equals("thrown");
			List<UUID> expected = fallback ? List.of(text, voice, source, near)
					: outcome.equals("disconnected") ? List.of(text, voice) : List.of(text);
			check(delivered.equals(expected), "bodies get text only on whole-line fallback, once, minus relayed operators: " + outcome);
		}
		// Changed on purpose: with no audio audience an operator outside the radius, driving a body inside it, got neither
		// audio nor text. Driven bodies in range now get the text; undriven bodies already have the line as their own
		// conversation event, and a body whose operator already has the line is skipped.
		UUID remote = UUID.randomUUID();
		List<VoiceAudienceDelivery.Listener> withRemote = new ArrayList<>(listeners);
		withRemote.add(new VoiceAudienceDelivery.Listener(remote, true, 48 * 48 + 1));
		java.util.function.BiPredicate<UUID, UUID> driving = (human, body) -> relays.test(human, body)
				|| human.equals(remote) && body.equals(near);
		Set<UUID> drivenBodies = Set.of(driven, near, far);
		List<UUID> delivered = new ArrayList<>();
		VoiceAudienceDelivery.speak(withRemote, bodies, 48, id -> false, delivered::add, driving, drivenBodies::contains,
				() -> { throw new AssertionError("text-only audience must make zero TTS calls"); }, Runnable::run);
		check(delivered.equals(List.of(voice, text, near)), "no audio audience: driven bodies in range get text, once: " + delivered);
		delivered.clear();
		VoiceAudienceDelivery.speak(List.of(), bodies, 48, id -> true, delivered::add, driving, drivenBodies::contains,
				() -> { throw new AssertionError("no human in range must make zero TTS calls"); }, Runnable::run);
		check(delivered.equals(List.of(near, driven)), "no human in range: only driven bodies in range get text: " + delivered);
	}

	private static void check(boolean condition, String message) { if (!condition) throw new AssertionError(message); }
}
