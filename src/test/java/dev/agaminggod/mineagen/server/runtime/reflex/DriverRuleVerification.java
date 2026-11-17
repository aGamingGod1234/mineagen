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
		List<ReflexSpec.Rule> defaults = defaults();
		floorIsTheFourHazardDefaults(defaults);
		floorFiringOutlastsACommandWhileTheHazardHolds(defaults);
		floorTriggerIsLevelTriggered(defaults);
		settledFloorYieldWaitsForAFreshHazard(defaults);
		floorStaysArmedAtTheFailureLimit(defaults);
		floorStaysArmedAtTheRateLimit(defaults);
		yieldableHazardsStillYield(defaults);
		replacementGapKeepsDefendDown();
		return assertions;
	}

	/**
	 * replace_action's yield arrives while the old action still runs; the cancel then leaves the body idle until the replacement
	 * starts. A yielded defend stays down through a gap of up to CommandFollower.IDLE_RESUME_TICKS, so the replacement
	 * (here build_shelter, which defend would otherwise pause) starts with the body; a longer gap lets defend back first.
	 */
	private static void replacementGapKeepsDefendDown() {
		for (long gap : new long[] {CommandFollower.IDLE_RESUME_TICKS, CommandFollower.IDLE_RESUME_TICKS + 1L}) {
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(rules("[" + DEFEND + "]"), 0L);
			CommandFollower follower = new CommandFollower();
			follower.observe(scheduler, false, "old", ActionType.TRAVEL_TO, null, null, 1L);
			check("default-defend".equals(defendTick(scheduler, 1L, true, ActionType.TRAVEL_TO).started()), "defend holds the travel");
			check(scheduler.yield(5L).endOutcome() == ReflexScheduler.Outcome.YIELDED, "replace_action's yield ends it");
			follower.yielded(5L);
			long tick = 6L;
			for (; tick < 8L; tick++) {
				follower.observe(scheduler, false, "old", ActionType.TRAVEL_TO, null, null, tick);
				check(defendTick(scheduler, tick, true, ActionType.TRAVEL_TO).started() == null, "down while the old action is cancelled");
			}
			for (long idle = 0L; idle < gap; idle++, tick++) {
				follower.observe(scheduler, false, null, null, "old", "ACTION_CANCELLED", tick);
				ReflexScheduler.Decision decision = defendTick(scheduler, tick, true, null);
				if (gap <= CommandFollower.IDLE_RESUME_TICKS) check(decision.started() == null, "down in the idle gap before the replacement");
			}
			follower.observe(scheduler, false, "new", ActionType.BUILD_SHELTER, "old", "ACTION_CANCELLED", tick);
			boolean defendBack = scheduler.current() != null || defendTick(scheduler, tick, true, ActionType.BUILD_SHELTER).started() != null;
			check(defendBack == (gap > CommandFollower.IDLE_RESUME_TICKS),
					"a " + gap + "-tick gap " + (defendBack ? "lets defend back before" : "leaves the body to") + " the replacement");
		}
	}

	private static List<ReflexSpec.Rule> defaults() {
		try {
			return ReflexSpec.parseRules(JsonParser.parseString(java.nio.file.Files.readString(
					java.nio.file.Path.of("src/test/resources/default-reflex-rules.json"))).getAsJsonArray());
		} catch (java.io.IOException failure) {
			throw new java.io.UncheckedIOException(failure);
		}
	}

	private static ReflexSpec.Rule named(List<ReflexSpec.Rule> rules, String id) {
		return rules.stream().filter(rule -> rule.id().equals(id)).findFirst().orElseThrow();
	}

	/** The floor is exactly default-lava, default-fire, default-air and default-suffocate; the model's own rules never are. */
	private static void floorIsTheFourHazardDefaults(List<ReflexSpec.Rule> defaults) {
		Set<String> floor = new java.util.TreeSet<>();
		for (ReflexSpec.Rule rule : defaults) if (ReflexScheduler.floor(rule)) floor.add(rule.id());
		check(floor.equals(new java.util.TreeSet<>(List.of("default-air", "default-fire", "default-lava", "default-suffocate"))),
				"the floor is the lava, fire, air and suffocation defaults: " + floor);
		for (String id : List.of("default-lava-flow", "default-creeper", "default-fireball", "default-edge")) {
			check(ReflexEngine.HAZARDS.stream().anyMatch(type -> named(defaults, id).when().stream().anyMatch(c -> c.type().equals(type))),
					id + " stays a hazard rule");
			check(!ReflexScheduler.floor(named(defaults, id)), id + " is not floor: it still yields to a command");
		}
		ReflexSpec.Rule replacement = rule("{\"id\":\"default-lava\",\"priority\":9,\"when\":{\"type\":\"in_lava\"},\"do\":{\"type\":\"leave_lava\"}}");
		check(!ReflexScheduler.floor(replacement), "a model rule that replaces default-lava by id is not floor");
		check(!ReflexScheduler.floor(rule("{\"id\":\"default-x\",\"coordinatorDefault\":true,\"when\":[{\"type\":\"in_lava\",\"not\":true},"
				+ "{\"type\":\"on_fire\"}],\"do\":{\"type\":\"eat\"}}")), "a negated hazard condition is not floor");
	}

	/**
	 * A direct command (an action, or replace_action's yield) does not end a floor firing while its hazard holds and it has not
	 * settled; once out (condition clear) or settled (holding on after its goal), the same yield ends it.
	 */
	private static void floorFiringOutlastsACommandWhileTheHazardHolds(List<ReflexSpec.Rule> defaults) {
		for (String id : List.of("default-lava", "default-fire", "default-air", "default-suffocate")) {
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(List.of(named(defaults, id)), 0L);
			check(id.equals(step(scheduler, 1L, id, true, RUNNING).started()), id + " fires");
			for (long tick = 2L; tick < 6L; tick++) {
				check(scheduler.yield(tick).ended() == null && scheduler.current() != null, id + " keeps the body through a command while in its hazard");
				check(!step(scheduler, tick, id, true, RUNNING).changed(), id + " keeps running");
			}
			step(scheduler, 6L, id, false, RUNNING);
			check(scheduler.yield(7L).endOutcome() == ReflexScheduler.Outcome.YIELDED, id + " yields once out of its hazard");

			ReflexScheduler settled = new ReflexScheduler();
			settled.replace(List.of(named(defaults, id)), 0L);
			step(settled, 1L, id, true, RUNNING);
			settled.settled(true);
			check(settled.yield(2L).endOutcome() == ReflexScheduler.Outcome.YIELDED, id + " yields once settled");
		}
		ReflexScheduler model = new ReflexScheduler();
		model.replace(List.of(rule("{\"id\":\"default-lava\",\"priority\":9,\"when\":{\"type\":\"in_lava\"},\"do\":{\"type\":\"leave_lava\"}}")), 0L);
		step(model, 1L, "default-lava", true, RUNNING);
		check(model.yield(2L).endOutcome() == ReflexScheduler.Outcome.YIELDED, "the model's own lava rule still yields to its command");
	}

	/** A floor trigger fires again after its cooldown while the hazard holds; a model trigger on the same condition fires once. */
	private static void floorTriggerIsLevelTriggered(List<ReflexSpec.Rule> defaults) {
		ReflexSpec.Rule lava = named(defaults, "default-lava");
		long cooldown = lava.cooldownMs() / 50L;
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(lava), 0L);
		step(scheduler, 1L, "default-lava", true, RUNNING);
		check(step(scheduler, 5L, "default-lava", true, ReflexScheduler.ActionStatus.FAILED, "no exit").endOutcome() == ReflexScheduler.Outcome.FAILED,
				"the escape fails while still in lava");
		for (long tick = 6L; tick < 5L + cooldown; tick++) check(step(scheduler, tick, "default-lava", true, RUNNING).started() == null, "cooldown first");
		check("default-lava".equals(step(scheduler, 5L + cooldown, "default-lava", true, RUNNING).started()),
				"then it fires again with no new edge, the body still in lava");
		check(step(scheduler, 40L, "default-lava", false, ReflexScheduler.ActionStatus.DONE, "out").endOutcome() == ReflexScheduler.Outcome.DONE, "out");
		for (long tick = 41L; tick < 100L; tick++) check(step(scheduler, tick, "default-lava", false, RUNNING).started() == null, "out of lava, it stays down");

		ReflexScheduler model = new ReflexScheduler();
		model.replace(List.of(rule("{\"id\":\"lava\",\"priority\":9,\"when\":{\"type\":\"in_lava\"},\"do\":{\"type\":\"leave_lava\"}}")), 0L);
		step(model, 1L, "lava", true, RUNNING);
		step(model, 5L, "lava", true, ReflexScheduler.ActionStatus.FAILED, "no exit");
		for (long tick = 6L; tick < 100L; tick++) check(step(model, tick, "lava", true, RUNNING).started() == null, "a model trigger stays edge-armed");

		// Fire's fight-yield exception ends default-fire DONE out of the fire block (in_fire false): no re-fire loop follows.
		ReflexScheduler fire = new ReflexScheduler();
		fire.replace(List.of(named(defaults, "default-fire")), 0L);
		step(fire, 1L, "default-fire", true, RUNNING);
		check(step(fire, 8L, "default-fire", false, ReflexScheduler.ActionStatus.DONE, "the fight steps off fire").endOutcome()
				== ReflexScheduler.Outcome.DONE, "default-fire hands a burning body to the fight");
		for (long tick = 9L; tick < 200L; tick++) check(step(fire, tick, "default-fire", false, RUNNING).started() == null, "and stays down under it");
	}

	/** A settled floor firing that yielded fires again only once the hazard clears and returns (or the command ends). */
	private static void settledFloorYieldWaitsForAFreshHazard(List<ReflexSpec.Rule> defaults) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(defaults, "default-air")), 0L);
		step(scheduler, 1L, "default-air", true, RUNNING);
		scheduler.settled(true);
		scheduler.yield(2L);
		scheduler.settled(false);
		for (long tick = 3L; tick < 60L; tick++) check(step(scheduler, tick, "default-air", true, RUNNING).started() == null, "the command keeps the body");
		step(scheduler, 60L, "default-air", false, RUNNING);
		check("default-air".equals(step(scheduler, 61L, "default-air", true, RUNNING).started()), "a fresh hazard fires it again");
	}

	/** At four failures in a row a floor rule stays armed and writes one wake row; the next crossing needs progress first. */
	private static void floorStaysArmedAtTheFailureLimit(List<ReflexSpec.Rule> defaults) {
		ReflexSpec.Rule air = named(defaults, "default-air");
		long cooldown = air.cooldownMs() / 50L;
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(air), 0L);
		long tick = 0L;
		for (int failure = 1; failure <= 2 * ReflexScheduler.MAX_FAILURES_IN_A_ROW; failure++) {
			check("default-air".equals(step(scheduler, ++tick, "default-air", true, RUNNING).started()), "failure " + failure + " fires");
			step(scheduler, ++tick, "default-air", true, ReflexScheduler.ActionStatus.FAILED, "route stalled");
			tick += cooldown;
		}
		check(wakes(scheduler) == 1, "one wake row for the crossing, none for the failures past it: " + scheduler.events());
		check(scheduler.events().stream().noneMatch(event -> event.outcome() == ReflexScheduler.Outcome.DISABLED), "never disabled");
		check(!"disabled".equals(scheduler.statuses(tick).getFirst().state()), "still armed");
		ReflexScheduler.Event crossing = scheduler.events().stream().filter(ReflexScheduler.Event::wake).findFirst().orElseThrow();
		check(crossing.outcome() == ReflexScheduler.Outcome.FAILED && crossing.firing()
				&& crossing.detail().equals("fired 4x in a row without progress, still armed; last: route stalled"), "the wake row says why: " + crossing.detail());
		step(scheduler, ++tick, "default-air", true, RUNNING);
		step(scheduler, ++tick, "default-air", true, ReflexScheduler.ActionStatus.DONE, "surfaced");
		tick += cooldown;
		for (int failure = 1; failure <= ReflexScheduler.MAX_FAILURES_IN_A_ROW; failure++) {
			step(scheduler, ++tick, "default-air", true, RUNNING);
			step(scheduler, ++tick, "default-air", true, ReflexScheduler.ActionStatus.FAILED, "route stalled");
			tick += cooldown;
		}
		check(scheduler.events().stream().filter(ReflexScheduler.Event::wake).count() >= 1 && lastWakeAfterProgress(scheduler),
				"after progress, the next four failures cross again and wake once more");
	}

	private static boolean lastWakeAfterProgress(ReflexScheduler scheduler) {
		List<ReflexScheduler.Event> events = scheduler.events();
		int done = -1;
		for (int index = 0; index < events.size(); index++) if (events.get(index).outcome() == ReflexScheduler.Outcome.DONE) done = index;
		return done >= 0 && events.subList(done, events.size()).stream().filter(ReflexScheduler.Event::wake).count() == 1;
	}

	/** Over forty firings a minute a floor rule stays armed and writes one wake row for the crossing. */
	private static void floorStaysArmedAtTheRateLimit(List<ReflexSpec.Rule> defaults) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(defaults, "default-fire")), 0L);
		long tick = 0L;
		int firings = 0;
		long seen = 0L;
		List<ReflexScheduler.Event> rows = new java.util.ArrayList<>();
		for (; tick < 1100L; tick++) {
			ReflexScheduler.Decision decision = step(scheduler, tick, "default-fire", true, scheduler.current() == null ? RUNNING : ReflexScheduler.ActionStatus.DONE, "");
			if (decision.started() != null) firings++;
			for (ReflexScheduler.Event event : scheduler.events()) if (event.sequence() > seen) rows.add(event);
			seen = scheduler.lastSequence();
		}
		check(firings > 2 * ReflexScheduler.MAX_FIRINGS_PER_MINUTE, "a fire that keeps coming back fires " + firings + " times in 55 s");
		List<ReflexScheduler.Event> woke = rows.stream().filter(ReflexScheduler.Event::wake).toList();
		check(woke.size() == 1 && rows.stream().noneMatch(event -> event.outcome() == ReflexScheduler.Outcome.DISABLED),
				"one wake row at the crossing, never disabled: " + woke);
		check(woke.getFirst().detail().startsWith("fired " + (ReflexScheduler.MAX_FIRINGS_PER_MINUTE + 1) + "x within 60 s, still armed"),
				"the wake row says why: " + woke.getFirst().detail());
		check(scheduler.current() != null || "default-fire".equals(step(scheduler, tick + 20L, "default-fire", true, RUNNING).started()), "still firing");
		ReflexScheduler model = new ReflexScheduler();
		model.replace(List.of(rule("{\"id\":\"burn\",\"when\":{\"type\":\"in_fire\"},\"do\":{\"type\":\"leave_fire\"},\"cooldownMs\":250}")), 0L);
		for (long t = 0L, n = 0L; n <= ReflexScheduler.MAX_FIRINGS_PER_MINUTE; t += 8L, n++) {
			step(model, t, "burn", false, RUNNING);
			step(model, t + 1L, "burn", true, RUNNING);
			step(model, t + 2L, "burn", true, ReflexScheduler.ActionStatus.DONE, "");
		}
		check(model.events().getLast().outcome() == ReflexScheduler.Outcome.DISABLED, "a model rule is still disabled at the limit");
	}

	/** Wake rows among the scheduler's last 16 events (enough for the failure-limit scenario). */
	private static long wakes(ReflexScheduler scheduler) {
		return scheduler.events().stream().filter(ReflexScheduler.Event::wake).count();
	}

	/** lava_flowing, creeper_fusing and fireball_incoming defaults still yield to a command while their danger holds. */
	private static void yieldableHazardsStillYield(List<ReflexSpec.Rule> defaults) {
		for (String id : List.of("default-lava-flow", "default-creeper", "default-fireball")) {
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(List.of(named(defaults, id)), 0L);
			check(id.equals(step(scheduler, 1L, id, true, RUNNING).started()), id + " fires");
			check(scheduler.yield(2L).endOutcome() == ReflexScheduler.Outcome.YIELDED, id + " yields to a command with its danger holding");
			for (long tick = 3L; tick < 60L; tick++) check(step(scheduler, tick, id, true, RUNNING).started() == null, id + " stays edge-armed");
		}
		// default-edge is a brace stance: it never takes the body (the engine senses it false), so it has no firing to yield.
		check("brace".equals(named(defaults, "default-edge").action().type()), "default-edge braces and never fires");
	}

	private static ReflexScheduler.Decision step(ReflexScheduler scheduler, long now, String id, boolean truth, ReflexScheduler.ActionStatus status) {
		return step(scheduler, now, id, truth, status, "");
	}

	private static ReflexScheduler.Decision step(ReflexScheduler scheduler, long now, String id, boolean truth, ReflexScheduler.ActionStatus status,
			String detail) {
		return scheduler.step(now, Map.of(id, new ReflexScheduler.Sense(truth, false)), status, detail, false);
	}

	private static ReflexSpec.Rule rule(String json) {
		return ReflexSpec.parseRule(JsonParser.parseString(json).getAsJsonObject(), "rule");
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
