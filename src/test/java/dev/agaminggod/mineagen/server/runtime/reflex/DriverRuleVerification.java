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
		engineExitsForARunningFiring();
		List<ReflexSpec.Rule> defaults = defaults();
		floorIsTheFourHazardDefaults(defaults);
		floorFiringOutlastsACommandWhileTheHazardHolds(defaults);
		keptYieldOutlastsARefireInTheHazard(defaults);
		deferredYieldHandsTheCommandItsYield(defaults);
		deferredYieldHoldsDefendForTheCommand(defaults);
		settledFloorYieldHoldsDefendForTheCommand(defaults);
		floorTriggerIsLevelTriggered(defaults);
		settledFloorYieldWaitsForAFreshHazard(defaults);
		replacedSettledFiringIsUnsettled(defaults);
		floorStaysArmedAtTheFailureLimit(defaults);
		floorStaysArmedAtTheRateLimit(defaults);
		yieldableHazardsStillYield(defaults);
		replacementGapKeepsDefendDown();
		handOffCodesAreKeyedByActionType();
		stoppedTravelAndFailedDefenceHandOff();
		return assertions;
	}

	private static void handOffCodesAreKeyedByActionType() {
		for (String code : CommandFollower.HANDOFF_CODES) {
			check(CommandFollower.handsOff(null, code) && CommandFollower.handsOff(ActionType.MINE_VEIN, code), code + " hands off for any action");
		}
		check(CommandFollower.handsOff(ActionType.TRAVEL_TO, "TRAVEL_DAMAGED") && CommandFollower.handsOff(ActionType.TRAVEL_TO, "HOSTILE_NEAR"),
				"a travel stopped by a hit or a hostile hands off");
		for (ActionType work : List.of(ActionType.DIG_TO, ActionType.MINE_VEIN, ActionType.CAST_OBSIDIAN, ActionType.BARTER_UNTIL)) {
			check(!CommandFollower.handsOff(work, "HOSTILE_NEAR"), work.wireName() + " stopping on HOSTILE_NEAR hands nothing off");
		}
		check(!CommandFollower.handsOff(null, "TRAVEL_DAMAGED") && !CommandFollower.handsOff(null, "NO_STANDABLE_PATH"),
				"an unknown action type gets only the shared codes");
		for (ActionType ordinary : List.of(ActionType.NAVIGATE_TO, ActionType.MOVE_TO, ActionType.PICK_UP_ITEM, ActionType.TRAVEL_TO)) {
			check(!CommandFollower.handsOff(ordinary, "NO_STANDABLE_PATH"), ordinary.wireName() + " ending NO_STANDABLE_PATH hands nothing off");
		}
		check(CommandFollower.handsOff(ActionType.BUILD_SHELTER, "NO_STANDABLE_PATH") && CommandFollower.handsOff(ActionType.BUILD_SHELTER, "SHELTER_BLOCKED")
				&& CommandFollower.handsOff(ActionType.BUILD_SHELTER, "SHELTER_TIMEOUT"), "a failed shelter hands off");
		check(CommandFollower.handsOff(ActionType.FLEE_FROM, "FLEE_BLOCKED") && CommandFollower.handsOff(ActionType.FLEE_FROM, "FLEE_TIMED_OUT"),
				"a failed flee hands off");
		for (ActionType defence : List.of(ActionType.BUILD_SHELTER, ActionType.FLEE_FROM, ActionType.TRAVEL_TO)) {
			for (String code : List.of("SHELTER_BUILT", "ESCAPED", "TARGET_LOST", "ACTION_CANCELLED", "AGENT_DEAD", "DESTINATION_REACHED")) {
				check(!CommandFollower.handsOff(defence, code), defence.wireName() + " ending " + code + " hands nothing off");
			}
		}
		check(!CommandFollower.handsOff(ActionType.TRAVEL_TO, null), "no code, no hand-off");
	}

	/**
	 * A protective trigger that already fired and still holds (the low-health retreat) fires again at once when a travel stops
	 * on TRAVEL_DAMAGED or a flee fails; a navigation ending NO_STANDABLE_PATH leaves it waiting for a new edge.
	 */
	private static void stoppedTravelAndFailedDefenceHandOff() {
		String retreat = "[{\"id\":\"retreat\",\"priority\":7,\"when\":[{\"type\":\"health_below\",\"value\":7},{\"type\":\"hostile_near\",\"within\":6}],"
				+ "\"do\":{\"type\":\"sprint_away\",\"blocks\":10}}]";
		Object[][] endings = {
				{ActionType.TRAVEL_TO, "TRAVEL_DAMAGED", true}, {ActionType.TRAVEL_TO, "HOSTILE_NEAR", true},
				{ActionType.FLEE_FROM, "FLEE_BLOCKED", true}, {ActionType.BUILD_SHELTER, "NO_STANDABLE_PATH", true},
				{ActionType.NAVIGATE_TO, "NO_STANDABLE_PATH", false}, {ActionType.PICK_UP_ITEM, "NO_STANDABLE_PATH", false},
				{ActionType.DIG_TO, "HOSTILE_NEAR", false}};
		for (Object[] ending : endings) {
			ActionType type = (ActionType) ending[0];
			String code = (String) ending[1];
			boolean expected = (boolean) ending[2];
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(rules(retreat), 0L);
			CommandFollower follower = new CommandFollower();
			check("retreat".equals(step(scheduler, 1L, "retreat", true, RUNNING).started()), "the retreat fires");
			step(scheduler, 20L, "retreat", true, ReflexScheduler.ActionStatus.DONE, "ran 10 blocks");
			for (long tick = 21L; tick < 60L; tick++) {
				follower.observe(scheduler, false, "act", type, null, null, null, tick);
				check(step(scheduler, tick, "retreat", true, RUNNING).started() == null, "it waits for a new edge while " + type.wireName() + " runs");
			}
			CommandFollower.Result ended = follower.observe(scheduler, false, null, null, "act", type, code, 60L);
			check(ended.handedOff() == expected, type.wireName() + " ending " + code + (expected ? " hands off" : " hands nothing off"));
			check(("retreat".equals(step(scheduler, 60L, "retreat", true, RUNNING).started())) == expected,
					type.wireName() + " ending " + code + (expected ? ": the retreat fires again at once" : ": the retreat still waits"));
		}
	}

	/**
	 * replace_action's yield arrives while the old action still runs; the cancel then leaves the body idle until the replacement
	 * starts. The action being replaced is not the command: a yielded defend stays down through the cancel and an idle gap of
	 * up to CommandFollower.REPLACEMENT_WAIT_TICKS, so the replacement (here build_shelter, which defend would otherwise pause)
	 * starts with the body; with no command by then, defend guards the idle body again.
	 */
	private static void replacementGapKeepsDefendDown() {
		long wait = CommandFollower.REPLACEMENT_WAIT_TICKS;
		for (long gap : new long[] {CommandFollower.IDLE_RESUME_TICKS + 1L, wait, wait + 1L}) {
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(rules("[" + DEFEND + "]"), 0L);
			CommandFollower follower = new CommandFollower();
			follower.observe(scheduler, false, "old", ActionType.TRAVEL_TO, null, null, 1L);
			check("default-defend".equals(defendTick(scheduler, 1L, true, ActionType.TRAVEL_TO).started()), "defend holds the travel");
			check(ReflexEngine.commandYield(scheduler, follower, false, 5L).endOutcome() == ReflexScheduler.Outcome.YIELDED, "replace_action's yield ends it");
			long tick = 6L;
			for (; tick < 8L; tick++) {
				follower.observe(scheduler, false, "old", ActionType.TRAVEL_TO, null, null, tick);
				check(defendTick(scheduler, tick, true, ActionType.TRAVEL_TO).started() == null, "down while the old action is cancelled");
			}
			for (long idle = 0L; idle < gap; idle++, tick++) {
				follower.observe(scheduler, false, null, null, "old", "ACTION_CANCELLED", tick);
				ReflexScheduler.Decision decision = defendTick(scheduler, tick, true, null);
				if (gap <= wait) check(decision.started() == null, "down in a " + gap + "-tick idle gap before the replacement");
			}
			follower.observe(scheduler, false, "new", ActionType.BUILD_SHELTER, "old", "ACTION_CANCELLED", tick);
			boolean defendBack = scheduler.current() != null || defendTick(scheduler, tick, true, ActionType.BUILD_SHELTER).started() != null;
			check(defendBack == (gap > wait), "a " + gap + "-tick gap " + (defendBack ? "lets defend back before" : "leaves the body to") + " the replacement");
			if (defendBack) continue;
			// The replacement is the command: once it ends, defend comes back after the usual idle wait.
			for (tick++; tick < 60L; tick++) {
				follower.observe(scheduler, false, "new", ActionType.BUILD_SHELTER, null, null, tick);
				check(defendTick(scheduler, tick, true, ActionType.BUILD_SHELTER).started() == null, "down while the replacement runs");
			}
			long ended = tick;
			for (; scheduler.anySuppressed() && tick < ended + 100L; tick++) follower.observe(scheduler, false, null, null, "new", "SHELTER_BUILT", tick);
			check(tick - ended == CommandFollower.IDLE_RESUME_TICKS + 1L, "defend is back " + (tick - ended) + " ticks after the replacement ends");
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
			// The command's one yield is remembered: the firing yields to it on the first tick out, with no second yield.
			ReflexScheduler.Decision out = step(scheduler, 6L, id, false, RUNNING);
			check(out.endOutcome() == ReflexScheduler.Outcome.YIELDED && scheduler.deferredYielded()
					&& scheduler.events().getLast().detail().equals("model command"), id + " yields to the waiting command once out of its hazard");
			for (long tick = 7L; tick < 60L; tick++) check(step(scheduler, tick, id, tick >= 30L, RUNNING).started() == null || tick == 30L,
					id + " waits for a fresh hazard after yielding");

			ReflexScheduler settles = new ReflexScheduler();
			settles.replace(List.of(named(defaults, id)), 0L);
			step(settles, 1L, id, true, RUNNING);
			check(settles.yield(2L).ended() == null, id + " is kept while unsettled");
			settles.settled(true);
			check(settles.step(3L, Map.of(id, new ReflexScheduler.Sense(true, false)), RUNNING, "holding until the burn is out", false).endOutcome()
					== ReflexScheduler.Outcome.YIELDED, id + " yields to the waiting command once it settles");
			settles.settled(false);

			ReflexScheduler settled = new ReflexScheduler();
			settled.replace(List.of(named(defaults, id)), 0L);
			step(settled, 1L, id, true, RUNNING);
			settled.settled(true);
			check(settled.yield(2L).endOutcome() == ReflexScheduler.Outcome.YIELDED, id + " yields at once when already settled");

			// A kept yield is forgotten when its firing ends any other way; the next firing is not yielded by it.
			ReflexScheduler stale = new ReflexScheduler();
			stale.replace(List.of(named(defaults, id)), 0L);
			step(stale, 1L, id, true, RUNNING);
			stale.yield(2L);
			check(step(stale, 3L, id, true, ReflexScheduler.ActionStatus.DONE, "out").endOutcome() == ReflexScheduler.Outcome.DONE && !stale.deferredYielded(),
					id + " finishing on its own is DONE, not yielded");
			step(stale, 4L, id, false, RUNNING);
			check(id.equals(step(stale, 30L, id, true, RUNNING).started()), id + " fires for a new hazard");
			check(step(stale, 31L, id, false, RUNNING).ended() == null, "the old command's yield does not end the new firing");
		}
		ReflexScheduler model = new ReflexScheduler();
		model.replace(List.of(rule("{\"id\":\"default-lava\",\"priority\":9,\"when\":{\"type\":\"in_lava\"},\"do\":{\"type\":\"leave_lava\"}}")), 0L);
		step(model, 1L, "default-lava", true, RUNNING);
		check(model.yield(2L).endOutcome() == ReflexScheduler.Outcome.YIELDED, "the model's own lava rule still yields to its command");
	}

	/**
	 * A kept floor firing that hits its maxS (or fails) still in its hazard ends and fires again; the command's one yield
	 * carries over to the new firing, which yields to it on the first tick out.
	 */
	private static void keptYieldOutlastsARefireInTheHazard(List<ReflexSpec.Rule> defaults) {
		for (ReflexScheduler.ActionStatus ending : List.of(RUNNING, ReflexScheduler.ActionStatus.FAILED)) {
			ReflexSpec.Rule lava = named(defaults, "default-lava");
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(List.of(lava), 0L);
			step(scheduler, 1L, "default-lava", true, RUNNING);
			long maxTicks = scheduler.current().maxTicks();
			check(scheduler.yield(2L).ended() == null, "the yield is kept while in lava");
			long end = ending == RUNNING ? 1L + maxTicks : 5L;
			for (long tick = 3L; tick < end; tick++) step(scheduler, tick, "default-lava", true, RUNNING);
			ReflexScheduler.Decision first = step(scheduler, end, "default-lava", true, ending);
			check(first.endOutcome() == (ending == RUNNING ? ReflexScheduler.Outcome.TIMEOUT : ReflexScheduler.Outcome.FAILED), "the kept firing ends " + first.endOutcome());
			long tick = end + 1L;
			for (; scheduler.current() == null && tick < end + 200L; tick++) step(scheduler, tick, "default-lava", true, RUNNING);
			check(scheduler.current() != null, "it fires again in the lava");
			ReflexScheduler.Decision out = step(scheduler, tick, "default-lava", false, RUNNING);
			check(out.endOutcome() == ReflexScheduler.Outcome.YIELDED && scheduler.deferredYielded() && scheduler.anySuppressed(),
					"the refired firing still yields to the waiting command after " + first.endOutcome());
		}
		// Attacked in the lava: defend takes the body in the cooldown gap, lava preempts it again, and still owes the yield.
		ReflexScheduler both = new ReflexScheduler();
		both.replace(List.of(named(defaults, "default-lava"), rules("[" + DEFEND + "]").getFirst()), 0L);
		Map<String, ReflexScheduler.Sense> inLava = Map.of("default-lava", new ReflexScheduler.Sense(true, false),
				"default-defend", new ReflexScheduler.Sense(true, false));
		both.step(1L, inLava, RUNNING, "", false);
		check("default-lava".equals(both.current().ruleId()) && both.yield(2L).ended() == null, "lava keeps the body through the yield");
		both.step(3L, inLava, ReflexScheduler.ActionStatus.FAILED, "no exit", false);
		check(both.current() != null && "default-defend".equals(both.current().ruleId()), "defend takes the body in lava's cooldown");
		long tick = 4L;
		for (; !"default-lava".equals(both.current() == null ? null : both.current().ruleId()) && tick < 200L; tick++) both.step(tick, inLava, RUNNING, "", false);
		check(both.current() != null && "default-lava".equals(both.current().ruleId()), "lava takes the body back");
		ReflexScheduler.Decision out = both.step(tick, Map.of("default-lava", new ReflexScheduler.Sense(false, false),
				"default-defend", new ReflexScheduler.Sense(true, false)), RUNNING, "", false);
		check(out.endOutcome() == ReflexScheduler.Outcome.YIELDED && "default-lava".equals(out.ended().ruleId()) && both.deferredYielded(),
				"lava yields to the waiting command once out, after defend held the body between");
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

	/**
	 * The engine's settled flag describes the firing it was set for. When that firing is replaced (a settled fire afterburn
	 * preempted by suffocation), the new firing is unsettled until the engine says otherwise: a command arriving before the
	 * engine's next tick waits under the suffocation escape instead of ending it.
	 */
	private static void replacedSettledFiringIsUnsettled(List<ReflexSpec.Rule> defaults) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(defaults, "default-fire"), named(defaults, "default-suffocate")), 0L);
		scheduler.step(1L, Map.of("default-fire", new ReflexScheduler.Sense(true, false), "default-suffocate", new ReflexScheduler.Sense(false, false)), RUNNING, "", false);
		check("default-fire".equals(scheduler.current().ruleId()), "fire fires");
		scheduler.settled(true);
		ReflexScheduler.Decision replaced = scheduler.step(2L, Map.of("default-fire", new ReflexScheduler.Sense(true, false),
				"default-suffocate", new ReflexScheduler.Sense(true, false)), RUNNING, "holding until the burn is out", false);
		check(replaced.endOutcome() == ReflexScheduler.Outcome.PREEMPTED && "default-suffocate".equals(replaced.started()), "suffocation takes the body from the settled burn");
		check(scheduler.yield(3L).ended() == null && "default-suffocate".equals(scheduler.current().ruleId()),
				"a command before the engine's next tick waits under the suffocation escape");
		check(scheduler.step(4L, Map.of("default-fire", new ReflexScheduler.Sense(true, false), "default-suffocate", new ReflexScheduler.Sense(true, false)),
				RUNNING, "", false).ended() == null, "the escape keeps the body while suffocating");
		ReflexScheduler.Decision out = scheduler.step(5L, Map.of("default-fire", new ReflexScheduler.Sense(false, false),
				"default-suffocate", new ReflexScheduler.Sense(false, false)), RUNNING, "", false);
		check(out.endOutcome() == ReflexScheduler.Outcome.YIELDED && scheduler.deferredYielded(), "and yields to the waiting command once out");
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

	/** One engine tick for a defend rule: its gated truth and, while it fires, its own exit (ReflexEngine.tickAgent's helpers). */
	private static ReflexScheduler.Decision defendTick(ReflexScheduler scheduler, long now, boolean attacked, ActionType active) {
		ReflexSpec.Rule rule = scheduler.rule("default-defend");
		boolean truth = ReflexEngine.gatedTruth(rule, attacked, active);
		ReflexScheduler.Firing firing = scheduler.current();
		ReflexScheduler.ActionStatus status = firing == null ? RUNNING
				: ReflexEngine.firingStep(rule, RUNNING, "", active, false, now - firing.startTick(), firing.maxTicks(), false).status();
		// Chased: defend's longest release grace, which only its own exit cuts short.
		return scheduler.step(now, Map.of("default-defend", new ReflexScheduler.Sense(truth, false)), status, "", true, false,
				ReflexActions.Defend.CHASED_GRACE_TICKS);
	}

	/** The engine's own exits: defend hands over to a fight or flee, a settled hold ends at its maxS, a fight-yielding action under a fight. */
	private static void engineExitsForARunningFiring() {
		ReflexSpec.Rule defend = rules("[" + DEFEND + "]").getFirst();
		ReflexSpec.Rule leave = rule("{\"id\":\"leave\",\"priority\":9,\"when\":{\"type\":\"in_lava\"},\"do\":{\"type\":\"leave_lava\"}}");
		ReflexEngine.FiringStep handed = ReflexEngine.firingStep(defend, RUNNING, "blocking", ActionType.FLEE_FROM, false, 3L, 200L, false);
		check(handed.status() == ReflexScheduler.ActionStatus.DONE && "blocking; handed to flee_from".equals(handed.detail()), "defend hands the body to a flee: " + handed);
		check(ReflexEngine.firingStep(defend, RUNNING, "", ActionType.TRAVEL_TO, false, 3L, 200L, false).status() == RUNNING, "defend keeps holding a travel");
		check(ReflexEngine.firingStep(defend, ReflexScheduler.ActionStatus.FAILED, "", ActionType.FIGHT_TARGET, false, 3L, 200L, false).status()
				== ReflexScheduler.ActionStatus.FAILED, "a failed defend stays failed");
		check(ReflexEngine.firingStep(leave, RUNNING, "", ActionType.FIGHT_TARGET, false, 3L, 200L, false).status() == RUNNING, "only defend stands aside");
		check(ReflexEngine.firingStep(leave, RUNNING, "", ActionType.FIGHT_TARGET, false, 3L, 200L, true).status() == ReflexScheduler.ActionStatus.DONE,
				"a fight-yielding action ends under a paused fight");
		check(ReflexEngine.firingStep(leave, RUNNING, "", ActionType.TRAVEL_TO, false, 3L, 200L, true).status() == RUNNING, "but not under a travel");
		check(ReflexEngine.firingStep(leave, RUNNING, "", null, true, 200L, 200L, false).status() == ReflexScheduler.ActionStatus.DONE
				&& ReflexEngine.firingStep(leave, RUNNING, "", null, true, 199L, 200L, false).status() == RUNNING, "a settled hold ends done at its maxS");
		check(!ReflexEngine.gatedTruth(defend, true, ActionType.USE_RANGED) && ReflexEngine.gatedTruth(defend, true, ActionType.DIG_TO)
				&& ReflexEngine.gatedTruth(leave, true, ActionType.FLEE_FROM), "only defend's truth is gated by a fight or flee");
	}

	/**
	 * The engine's hand-off: when a kept floor firing yields once out of its hazard, the command follower takes over as for a
	 * direct yield, so the yielded rule comes back once the command has ended.
	 */
	private static void deferredYieldHandsTheCommandItsYield(List<ReflexSpec.Rule> defaults) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(defaults, "default-lava")), 0L);
		CommandFollower follower = new CommandFollower();
		follower.observe(scheduler, false, null, null, null, null, 0L);
		step(scheduler, 1L, "default-lava", true, RUNNING);
		check(follower.requestYield(false, 2L) && scheduler.yield(2L).ended() == null, "the command's yield is kept in lava");
		follower.observe(scheduler, false, "cmd", ActionType.MINE_VEIN, null, null, 3L);
		check(step(scheduler, 4L, "default-lava", false, RUNNING).endOutcome() == ReflexScheduler.Outcome.YIELDED && scheduler.anySuppressed(), "it yields once out");
		ReflexEngine.followDeferredYield(scheduler, follower, 4L);
		long tick = 5L;
		for (; tick < 20L; tick++) follower.observe(scheduler, false, "cmd", ActionType.MINE_VEIN, null, null, tick);
		check(scheduler.anySuppressed(), "the rule stays yielded while the command runs");
		for (long end = tick + CommandFollower.IDLE_RESUME_TICKS + 1L; tick < end; tick++) follower.observe(scheduler, false, null, null, "cmd", "DONE", tick);
		check(!scheduler.anySuppressed(), "the follower brings the rule back once the command has ended");
	}

	/**
	 * A non-fight command (build_shelter) asked for the body while lava held it and the body was attacked: when lava yields
	 * to it, default-defend stays down for that command too, as it would had it held the body when the command came. Another
	 * floor hazard still fires; defend comes back once the command ends, or after the replacement wait if it never starts.
	 */
	private static void deferredYieldHoldsDefendForTheCommand(List<ReflexSpec.Rule> defaults) {
		for (boolean commandStarts : new boolean[] {true, false}) {
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(List.of(named(defaults, "default-lava"), named(defaults, "default-fire"), rules("[" + DEFEND + "]").getFirst()), 0L);
			CommandFollower follower = new CommandFollower();
			follower.observe(scheduler, false, null, null, null, null, 0L);
			check("default-lava".equals(hazardTick(scheduler, 1L, true, false, true, null).started()), "lava takes the body under attack");
			check(follower.requestYield(false, 2L) && scheduler.yield(2L).ended() == null, "the command's yield is kept in lava");
			ActionType command = commandStarts ? ActionType.BUILD_SHELTER : null;
			String commandId = commandStarts ? "cmd" : null;
			follower.observe(scheduler, false, commandId, command, null, null, 3L);
			hazardTick(scheduler, 3L, true, false, true, command);
			ReflexScheduler.Decision out = hazardTick(scheduler, 4L, false, false, true, command);
			check(out.endOutcome() == ReflexScheduler.Outcome.YIELDED && out.started() == null, "lava yields to the command and defend does not take the body");
			ReflexEngine.followDeferredYield(scheduler, follower, 4L);
			long tick = 5L;
			if (commandStarts) {
				for (; tick < 40L; tick++) {
					follower.observe(scheduler, false, commandId, command, null, null, tick);
					check(hazardTick(scheduler, tick, false, false, true, command).started() == null, "defend stays down while the command runs");
				}
				ReflexScheduler fire = new ReflexScheduler();
				fire.replace(List.of(named(defaults, "default-lava"), named(defaults, "default-fire"), rules("[" + DEFEND + "]").getFirst()), 0L);
				hazardTick(fire, 1L, true, false, true, command);
				fire.yield(2L);
				check("default-fire".equals(hazardTick(fire, 3L, false, true, true, command).started()), "another floor hazard still takes the body");
				long ended = tick;
				for (; scheduler.anySuppressed() && tick < ended + 100L; tick++) {
					follower.observe(scheduler, false, null, null, commandId, "SHELTER_BUILT", tick);
					if (scheduler.anySuppressed()) check(hazardTick(scheduler, tick, false, false, true, null).started() == null, "defend waits out the idle resume");
				}
				check(tick - ended == CommandFollower.IDLE_RESUME_TICKS + 1L, "defend is back " + (tick - ended) + " ticks after the command ends");
			} else {
				long waited = tick;
				for (; scheduler.anySuppressed() && tick < waited + 100L; tick++) {
					follower.observe(scheduler, false, null, null, null, null, tick);
					if (scheduler.anySuppressed()) hazardTick(scheduler, tick, false, false, true, null);
				}
				check(tick - waited <= CommandFollower.REPLACEMENT_WAIT_TICKS + 1L && !scheduler.anySuppressed(), "with no command, defend is back after the replacement wait");
			}
			check("default-defend".equals(hazardTick(scheduler, tick, false, false, true, null).started()), "defend guards the body again");
		}
	}

	/**
	 * A lava firing that has settled (out of lava, holding on) yields to a non-fight command (build_shelter) at once, under
	 * attack: default-defend stays down for that command too, as on the kept-yield path. Another floor hazard still takes the
	 * body; defend comes back once the command ends, or after the replacement wait if it never starts.
	 */
	private static void settledFloorYieldHoldsDefendForTheCommand(List<ReflexSpec.Rule> defaults) {
		for (boolean commandStarts : new boolean[] {true, false}) {
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(List.of(named(defaults, "default-lava"), named(defaults, "default-fire"), rules("[" + DEFEND + "]").getFirst()), 0L);
			CommandFollower follower = new CommandFollower();
			follower.observe(scheduler, false, null, null, null, null, 0L);
			check("default-lava".equals(hazardTick(scheduler, 1L, true, false, true, null).started()), "lava takes the body under attack");
			scheduler.settled(true);
			ReflexScheduler.Decision yielded = ReflexEngine.commandYield(scheduler, follower, false, 2L);
			check(yielded.endOutcome() == ReflexScheduler.Outcome.YIELDED && "default-lava".equals(yielded.ended().ruleId()), "the settled lava firing yields at once");
			ActionType command = commandStarts ? ActionType.BUILD_SHELTER : null;
			String commandId = commandStarts ? "cmd" : null;
			long tick = 3L;
			if (commandStarts) {
				for (; tick < 60L; tick++) {
					follower.observe(scheduler, false, commandId, command, null, null, tick);
					// The fire firing puts the flames out the tick after it starts.
					ReflexScheduler.Decision decision = hazardTick(scheduler, tick, false, tick == 10L, true, command, tick == 11L ? ReflexScheduler.ActionStatus.DONE : RUNNING);
					if (tick == 10L) check("default-fire".equals(decision.started()), "another floor hazard still takes the body");
					else check(decision.started() == null, "defend stays down while the command runs (tick " + tick + ")");
				}
				check(scheduler.current() == null, "the fire firing has ended before the command does");
				long ended = tick;
				for (; scheduler.anySuppressed() && tick < ended + 100L; tick++) {
					follower.observe(scheduler, false, null, null, commandId, "SHELTER_BUILT", tick);
					if (scheduler.anySuppressed()) check(hazardTick(scheduler, tick, false, false, true, null).started() == null, "defend waits out the idle resume");
				}
				check(tick - ended == CommandFollower.IDLE_RESUME_TICKS + 1L, "defend is back " + (tick - ended) + " ticks after the command ends");
			} else {
				long waited = tick;
				for (; scheduler.anySuppressed() && tick < waited + 100L; tick++) {
					follower.observe(scheduler, false, null, null, null, null, tick);
					if (scheduler.anySuppressed()) check(hazardTick(scheduler, tick, false, false, true, null).started() == null, "defend waits for a command");
				}
				check(tick - waited <= CommandFollower.REPLACEMENT_WAIT_TICKS + 1L && !scheduler.anySuppressed(), "with no command, defend is back after the replacement wait");
			}
			check("default-defend".equals(hazardTick(scheduler, tick, false, false, true, null).started()), "defend guards the body again");
		}
	}

	/** One tick with lava, fire and defend sensed (defend gated by the running action). */
	private static ReflexScheduler.Decision hazardTick(ReflexScheduler scheduler, long now, boolean lava, boolean fire, boolean attacked, ActionType active) {
		return hazardTick(scheduler, now, lava, fire, attacked, active, RUNNING);
	}

	private static ReflexScheduler.Decision hazardTick(ReflexScheduler scheduler, long now, boolean lava, boolean fire, boolean attacked, ActionType active,
			ReflexScheduler.ActionStatus status) {
		return scheduler.step(now, Map.of("default-lava", new ReflexScheduler.Sense(lava, false), "default-fire", new ReflexScheduler.Sense(fire, false),
				"default-defend", new ReflexScheduler.Sense(ReflexEngine.gatedTruth(scheduler.rule("default-defend"), attacked, active), false)), status, "", false);
	}

	private static List<ReflexSpec.Rule> rules(String json) {
		return ReflexSpec.parseRules(JsonParser.parseString(json).getAsJsonArray());
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("DriverRuleVerification: " + message);
		assertions++;
	}
}
