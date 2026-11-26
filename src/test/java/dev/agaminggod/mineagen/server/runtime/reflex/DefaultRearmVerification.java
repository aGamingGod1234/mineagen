package dev.agaminggod.mineagen.server.runtime.reflex;

import com.google.gson.JsonArray;
import com.google.gson.JsonParser;
import java.util.Map;

/**
 * Real scheduler and the End's edge step-away default; the dragon's charges and the step's result are simulated, without
 * Minecraft. Four charges the step could not dodge used to switch it off for the rest of the game.
 */
public final class DefaultRearmVerification {
	private static final String THROW = "default-end-throw";
	private static final String RULE = "{\"id\":\"" + THROW + "\",\"kind\":\"trigger\",\"priority\":8,\"when\":[{\"type\":\"dragon_charging\",\"within\":48},"
			+ "{\"type\":\"edge_near\",\"within\":3,\"direction\":\"any\",\"drop\":16}],\"do\":{\"type\":\"away_from_edge\",\"blocks\":6},\"maxMs\":6000,"
			+ "\"cooldownMs\":3000,\"ttlMs\":3600000,\"coordinatorDefault\":true}";
	private static final String OWN = "{\"id\":\"my-step\",\"kind\":\"trigger\",\"priority\":8,\"when\":[{\"type\":\"dragon_charging\",\"within\":48}],"
			+ "\"do\":{\"type\":\"away_from_edge\",\"blocks\":6},\"maxMs\":6000,\"cooldownMs\":3000,\"ttlMs\":3600000}";

	private DefaultRearmVerification() { }

	public static void main(String[] args) {
		System.out.println("Default rearm: " + verify() + " scenarios passed");
	}

	public static int verify() {
		String saved = System.getProperty("mineagen.reflex.defaultRearm");
		try {
			System.clearProperty("mineagen.reflex.defaultRearm");
			check(ReflexScheduler.rearmTicks(rule(RULE)) == ReflexScheduler.DEFAULT_REARM_TICKS, "a coordinator default rests, not off for the game");
			check(ReflexScheduler.rearmTicks(rule(OWN)) == 0L, "the model's own rule stays off; it can rewrite it");

			var scheduler = scheduler(RULE);
			long tick = failFour(scheduler, THROW, 0L);
			var disabled = lastDisabled(scheduler, THROW);
			check(disabled != null && disabled.wake() && disabled.detail().contains("tried again in 60 s"),
					"four undodged charges rest the step-away and tell the model: " + (disabled == null ? null : disabled.detail()));
			long rearm = disabled.endTick() + ReflexScheduler.DEFAULT_REARM_TICKS;
			for (long at = tick; at < rearm; at += 50L) {
				scheduler.step(at, sense(THROW, false), ReflexScheduler.ActionStatus.RUNNING, "", false);
				check(scheduler.step(at + 1L, sense(THROW, true), ReflexScheduler.ActionStatus.RUNNING, "", false).started() == null, "resting at tick " + at);
			}
			// The next charge a minute on gets the step-away again.
			scheduler.step(rearm, sense(THROW, false), ReflexScheduler.ActionStatus.RUNNING, "", false);
			check(THROW.equals(scheduler.step(rearm + 1L, sense(THROW, true), ReflexScheduler.ActionStatus.RUNNING, "", false).started()),
					"the next charge after the rest gets the step-away");
			scheduler.step(rearm + 40L, sense(THROW, false), ReflexScheduler.ActionStatus.DONE, "stepped 6 inland", false);
			tick = failFour(scheduler, THROW, rearm + 200L);
			var again = lastDisabled(scheduler, THROW);
			check(again != null && again.endTick() > disabled.endTick() && !again.wake(), "a later rest is quiet");

			var own = scheduler(OWN);
			failFour(own, "my-step", 0L);
			var ownOff = lastDisabled(own, "my-step");
			check(ownOff != null && ownOff.wake() && !ownOff.detail().contains("tried again"), "the model's own rule is off and the model is told");

			System.setProperty("mineagen.reflex.defaultRearm", "false");
			check(ReflexScheduler.rearmTicks(rule(RULE)) == 0L, "off: no rest");
			scheduler = scheduler(RULE);
			tick = failFour(scheduler, THROW, 0L);
			long later = tick + 10L * 60L * ReflexScheduler.TICKS_PER_SECOND;
			scheduler.step(later, sense(THROW, false), ReflexScheduler.ActionStatus.RUNNING, "", false);
			check(scheduler.step(later + 1L, sense(THROW, true), ReflexScheduler.ActionStatus.RUNNING, "", false).started() == null,
					"off: still disabled ten minutes later");
		} finally {
			if (saved == null) System.clearProperty("mineagen.reflex.defaultRearm");
			else System.setProperty("mineagen.reflex.defaultRearm", saved);
		}
		return 7;
	}

	private static ReflexSpec.Rule rule(String json) {
		return ReflexSpec.parseRule(JsonParser.parseString(json).getAsJsonObject(), "rule");
	}

	private static ReflexScheduler scheduler(String json) {
		JsonArray rules = new JsonArray();
		rules.add(JsonParser.parseString(json));
		var scheduler = new ReflexScheduler();
		scheduler.replace(ReflexSpec.parseRules(rules), 0L);
		return scheduler;
	}

	/** Four charges, each starting the rule and failing (the bot was hit while stepping); returns the tick after. */
	private static long failFour(ReflexScheduler scheduler, String id, long tick) {
		for (int i = 0; i < ReflexScheduler.MAX_FAILURES_IN_A_ROW; i++) {
			scheduler.step(tick, sense(id, false), ReflexScheduler.ActionStatus.RUNNING, "", false);
			check(id.equals(scheduler.step(tick + 1L, sense(id, true), ReflexScheduler.ActionStatus.RUNNING, "", false).started()), "charge " + i + " starts at " + tick);
			var end = scheduler.step(tick + 40L, sense(id, true), ReflexScheduler.ActionStatus.FAILED, "moving 2 cell(s) left; lost 6 health", false);
			check(end.endOutcome() == ReflexScheduler.Outcome.FAILED, "charge " + i + " fails");
			tick += 100L;
		}
		return tick;
	}

	private static ReflexScheduler.Event lastDisabled(ReflexScheduler scheduler, String id) {
		ReflexScheduler.Event last = null;
		for (var event : scheduler.events()) if (id.equals(event.ruleId()) && event.outcome() == ReflexScheduler.Outcome.DISABLED) last = event;
		return last;
	}

	private static Map<String, ReflexScheduler.Sense> sense(String id, boolean truth) {
		return Map.of(id, new ReflexScheduler.Sense(truth, false));
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
