package dev.agaminggod.mineagen.server.runtime.reflex;

import com.google.gson.JsonParser;
import dev.agaminggod.mineagen.protocol.ActionType;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Who drives the body (issue 2, step 1a-i), without a server: default defend covers every action but the body's own fight
 * or flight and lets go the tick one starts.
 */
public final class DriverRuleVerification {
	private static final ReflexScheduler.ActionStatus RUNNING = ReflexScheduler.ActionStatus.RUNNING;
	private static final String DEFEND = "{\"id\":\"default-defend\",\"kind\":\"stance\",\"priority\":5,\"when\":{\"type\":\"attacked\",\"withinS\":4},"
			+ "\"do\":{\"type\":\"defend\"},\"coordinatorDefault\":true}";
	private static int assertions;

	private DriverRuleVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " driver rule assertions");
	}

	public static int verify() {
		assertions = 0;
		defendStandsAsideOnlyForFightAndFlight();
		defendCoversWorkAndExitsForFightOrFlee();
		return assertions;
	}

	private static void defendStandsAsideOnlyForFightAndFlight() {
		Set<ActionType> aside = Set.of(ActionType.FIGHT_TARGET, ActionType.FIGHT_UNTIL, ActionType.USE_RANGED, ActionType.FLEE_FROM);
		for (ActionType type : ActionType.values()) {
			check(ReflexEngine.defendStandsAside(type) == aside.contains(type), "defend stands aside only for a fight or flee: " + type);
		}
		check(!ReflexEngine.defendStandsAside(null), "the idle body is defended");
		for (ActionType work : List.of(ActionType.TRAVEL_TO, ActionType.PICK_UP_ITEM, ActionType.DIG_TO)) {
			check(!ReflexEngine.defendStandsAside(work), "defend covers " + work.wireName());
		}
	}

	/**
	 * The engine's defend gates, played against the scheduler: defend fires while travel_to, pick_up_item or dig_to runs;
	 * it ends DONE on the first tick of a fight or flee (despite its 200-tick chased release grace) and stays down while
	 * that runs, so it neither pauses the flee nor re-fires into the 40-firings limit; it covers the body again after.
	 */
	private static void defendCoversWorkAndExitsForFightOrFlee() {
		for (ActionType work : List.of(ActionType.TRAVEL_TO, ActionType.PICK_UP_ITEM, ActionType.DIG_TO)) {
			for (ActionType takeover : List.of(ActionType.FIGHT_TARGET, ActionType.FIGHT_UNTIL, ActionType.USE_RANGED, ActionType.FLEE_FROM)) {
				ReflexScheduler scheduler = new ReflexScheduler();
				scheduler.replace(rules("[" + DEFEND + "]"), 0L);
				check("default-defend".equals(defendTick(scheduler, 1L, true, work).started()), "defend fires during " + work.wireName());
				for (long tick = 2L; tick < 10L; tick++) check(!defendTick(scheduler, tick, true, work).changed(), "and holds the body during " + work.wireName());
				ReflexScheduler.Decision handed = defendTick(scheduler, 10L, true, takeover);
				check(handed.endOutcome() == ReflexScheduler.Outcome.DONE && handed.started() == null,
						"defend ends on the first tick of " + takeover.wireName() + " after " + work.wireName());
				for (long tick = 11L; tick < 400L; tick++) {
					check(!defendTick(scheduler, tick, true, takeover).changed(), "defend stays down while " + takeover.wireName() + " runs");
				}
				check(scheduler.statuses(400L).getFirst().fired() == 1, "one firing, no re-fire loop under " + takeover.wireName());
				check("default-defend".equals(defendTick(scheduler, 401L, true, null).started()), "the body is defended again once it ends");
			}
		}
		ReflexScheduler underFight = new ReflexScheduler();
		underFight.replace(rules("[" + DEFEND + "]"), 0L);
		for (long tick = 1L; tick < 40L; tick++) {
			check(defendTick(underFight, tick, true, ActionType.FLEE_FROM).started() == null, "hit during a flee, defend does not pause it");
		}
	}

	/** One engine tick for a defend rule: its gated truth and, while it fires, its own exit (as ReflexEngine.tickAgent). */
	private static ReflexScheduler.Decision defendTick(ReflexScheduler scheduler, long now, boolean attacked, ActionType active) {
		boolean truth = attacked && !ReflexEngine.defendStandsAside(active);
		ReflexScheduler.ActionStatus status = scheduler.current() != null && ReflexEngine.defendStandsAside(active)
				? ReflexScheduler.ActionStatus.DONE : RUNNING;
		// Chased: defend's longest release grace, which only its own exit cuts short.
		return scheduler.step(now, Map.of("default-defend", new ReflexScheduler.Sense(truth, false)), status, "", true, false,
				ReflexActions.Defend.CHASED_GRACE_TICKS);
	}

	private static List<ReflexSpec.Rule> rules(String json) {
		return ReflexSpec.parseRules(JsonParser.parseString(json).getAsJsonArray());
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("DriverRuleVerification: " + message);
		assertions++;
	}
}
