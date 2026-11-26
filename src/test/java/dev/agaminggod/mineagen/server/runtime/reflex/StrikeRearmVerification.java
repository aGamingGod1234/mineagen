package dev.agaminggod.mineagen.server.runtime.reflex;

import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import java.util.Map;

/**
 * Real scheduler and the End's head-strike default; the perched dragon and the head fight's result are simulated, without
 * Minecraft. Four instant "no seen route" failures used to switch the strike off for the rest of the game.
 */
public final class StrikeRearmVerification {
	private static final String STRIKE = "default-perch-strike";
	private static final String RULE = "{\"id\":\"" + STRIKE + "\",\"kind\":\"stance\",\"priority\":6,\"when\":[{\"type\":\"dragon_perched\",\"within\":24},"
			+ "{\"type\":\"health_below\",\"value\":10,\"not\":true}],\"do\":{\"type\":\"strike_head\"},\"maxMs\":20000,\"cooldownMs\":1000,"
			+ "\"ttlMs\":3600000,\"coordinatorDefault\":true}";
	private static final String EAT = "{\"id\":\"meal\",\"kind\":\"stance\",\"priority\":3,\"when\":[{\"type\":\"hunger_below\",\"value\":18}],"
			+ "\"do\":{\"type\":\"eat\"},\"cooldownMs\":20000}";

	private StrikeRearmVerification() { }

	public static void main(String[] args) {
		System.out.println("Strike rearm: " + verify() + " scenarios passed");
	}

	public static int verify() {
		String saved = System.getProperty("mineagen.end.strikeRearm"), savedDefault = System.getProperty("mineagen.reflex.defaultRearm");
		try {
			System.clearProperty("mineagen.end.strikeRearm");
			System.clearProperty("mineagen.reflex.defaultRearm");
			var strike = ReflexSpec.parseRule(JsonParser.parseString(RULE).getAsJsonObject(), "rule");
			check(ReflexScheduler.rearmTicks(strike) == ReflexScheduler.STRIKE_REARM_TICKS, "the head strike rests, not off for the game");
			check(ReflexScheduler.rearmTicks(ReflexSpec.parseRule(JsonParser.parseString(EAT).getAsJsonObject(), "rule")) == ReflexScheduler.FINISHING_REARM_TICKS,
					"a meal still rests its minute");

			var scheduler = scheduler();
			long tick = failFour(scheduler, 0L);
			var disabled = lastDisabled(scheduler);
			check(disabled != null && disabled.wake() && disabled.detail().contains("tried again in 10 s"),
					"four failed strikes rest it and tell the model: " + (disabled == null ? null : disabled.detail()));
			long disabledAt = disabled.endTick();
			for (long at = tick; at < disabledAt + ReflexScheduler.STRIKE_REARM_TICKS; at += 5L) {
				check(scheduler.step(at, perched(true), ReflexScheduler.ActionStatus.RUNNING, "", false).started() == null, "resting at tick " + at);
			}
			// The same perch, 10 s on: the dragon has turned and the strike tries again.
			long rearm = disabledAt + ReflexScheduler.STRIKE_REARM_TICKS;
			check(STRIKE.equals(scheduler.step(rearm, perched(true), ReflexScheduler.ActionStatus.RUNNING, "", false).started()),
					"the strike comes back while the dragon still sits");
			scheduler.step(rearm + 40L, perched(true), ReflexScheduler.ActionStatus.DONE, "at the perched dragon's head", false);
			check(scheduler.statuses(rearm + 41L).stream().anyMatch(row -> STRIKE.equals(row.id()) && row.disabledReason() == null), "a reached head arms it again");

			// A second run of failures in the same fight rests it again without waking the model a second time.
			tick = failFour(scheduler, rearm + 100L);
			var again = lastDisabled(scheduler);
			check(again != null && again.endTick() > disabledAt && !again.wake(), "a later rest is quiet");
			// The next landing a minute on: armed again.
			long next = again.endTick() + 60L * ReflexScheduler.TICKS_PER_SECOND;
			scheduler.step(next - 1L, perched(false), ReflexScheduler.ActionStatus.RUNNING, "", false);
			check(STRIKE.equals(scheduler.step(next, perched(true), ReflexScheduler.ActionStatus.RUNNING, "", false).started()),
					"the next landing gets the strike");

			// Strike rest off: it falls back to the minute every coordinator default rests.
			System.setProperty("mineagen.end.strikeRearm", "false");
			check(ReflexScheduler.rearmTicks(strike) == ReflexScheduler.DEFAULT_REARM_TICKS, "strike rest off: the default minute");
			// Both off keeps the old behaviour: off for the rest of the game.
			System.setProperty("mineagen.reflex.defaultRearm", "false");
			check(ReflexScheduler.rearmTicks(strike) == 0L, "off: no rest");
			scheduler = scheduler();
			tick = failFour(scheduler, 0L);
			var off = lastDisabled(scheduler);
			check(off != null && !off.detail().contains("tried again"), "off: disabled for good");
			check(scheduler.step(tick + 10L * 60L * ReflexScheduler.TICKS_PER_SECOND, perched(true), ReflexScheduler.ActionStatus.RUNNING, "", false).started() == null,
					"off: still disabled ten minutes later");
		} finally {
			if (saved == null) System.clearProperty("mineagen.end.strikeRearm");
			else System.setProperty("mineagen.end.strikeRearm", saved);
			if (savedDefault == null) System.clearProperty("mineagen.reflex.defaultRearm");
			else System.setProperty("mineagen.reflex.defaultRearm", savedDefault);
		}
		return 8;
	}

	private static ReflexScheduler scheduler() {
		JsonArray rules = new JsonArray();
		rules.add(JsonParser.parseString(RULE));
		var scheduler = new ReflexScheduler();
		scheduler.replace(ReflexSpec.parseRules(rules), 0L);
		return scheduler;
	}

	/** Four firings that each fail at once (no seen route to the head), one second apart; returns the tick after. */
	private static long failFour(ReflexScheduler scheduler, long tick) {
		for (int i = 0; i < ReflexScheduler.MAX_FAILURES_IN_A_ROW; i++) {
			check(STRIKE.equals(scheduler.step(tick, perched(true), ReflexScheduler.ActionStatus.RUNNING, "", false).started()), "strike " + i + " starts at " + tick);
			var end = scheduler.step(tick + 1L, perched(true), ReflexScheduler.ActionStatus.FAILED, "head fight NO_SEEN_ROUTE", false);
			check(end.endOutcome() == ReflexScheduler.Outcome.FAILED, "strike " + i + " fails");
			tick += 21L;
		}
		return tick;
	}

	private static ReflexScheduler.Event lastDisabled(ReflexScheduler scheduler) {
		ReflexScheduler.Event last = null;
		for (var event : scheduler.events()) if (STRIKE.equals(event.ruleId()) && event.outcome() == ReflexScheduler.Outcome.DISABLED) last = event;
		return last;
	}

	private static Map<String, ReflexScheduler.Sense> perched(boolean truth) {
		return Map.of(STRIKE, new ReflexScheduler.Sense(truth, false));
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
