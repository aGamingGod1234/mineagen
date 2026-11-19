package dev.agaminggod.mineagen.server.runtime.reflex;

import com.google.gson.JsonParser;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * Skeleton cover (issue 2, K8), without a server: default-blaze-cover also hides from bow skeletons, blocks shots with a
 * held shield while it takes cover and is not switched off by open ground.
 */
public final class CoverRuleVerification {
	private static final ReflexScheduler.ActionStatus RUNNING = ReflexScheduler.ActionStatus.RUNNING;
	private static final ReflexScheduler.ActionStatus DONE = ReflexScheduler.ActionStatus.DONE;
	private static final ReflexScheduler.ActionStatus FAILED = ReflexScheduler.ActionStatus.FAILED;
	private static final String COVER = "default-blaze-cover";
	private static final String ARROW = "default-arrow";
	private static int assertions;

	private CoverRuleVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " cover rule assertions");
	}

	public static int verify() {
		assertions = 0;
		List<ReflexSpec.Rule> defaults = defaults();
		coverListsBowSkeletons(defaults);
		hazardsStillPreemptCover(defaults);
		corneredStandHoldsCoverBack(defaults);
		shieldRulesStandAsideForABlockingCover(defaults);
		preemptedCoverStaysOffWhileTheShooterSees(defaults);
		gatedShieldLetsCoverFinish(defaults);
		queuedArrowDuringCooldownDoesNotPreemptCover(defaults);
		coverBlocksOnlyAroundAShot();
		openGroundEndingsDoNotDisableCover(defaults);
		finishedCoverWaitsForAFreshSighting(defaults);
		return assertions;
	}

	private static void coverListsBowSkeletons(List<ReflexSpec.Rule> defaults) {
		ReflexSpec.Rule cover = rule(defaults, COVER);
		ReflexSpec.Condition exposed = cover.when().stream().filter(condition -> "exposed".equals(condition.type())).findFirst().orElseThrow();
		check(exposed.ids("mobs").equals(Set.of("minecraft:blaze", "minecraft:skeleton", "minecraft:stray", "minecraft:bogged")),
				"shooter cover hides from blazes and the three bow skeletons: " + exposed.ids("mobs"));
		check(exposed.number("within", 0.0D) == 12.0D && cover.priority() == 6 && "take_cover".equals(cover.action().type()),
				"range, priority and action are unchanged");
		check(cover.maxMs() == 8_000L && cover.maxMs() > ReflexSpec.DEFAULT_TRIGGER_MAX_MS,
				"cover has 8 s, room for a walk with stops to block, before a timeout counts against it");
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(cover), 0);
		scheduler.step(1, Map.of(COVER, on()), RUNNING, "", false);
		boolean ended = false;
		for (long tick = 2; tick <= 1 + 6 * 20; tick++) ended |= scheduler.step(tick, Map.of(COVER, on()), RUNNING, "blocking a shot", false).ended() != null;
		check(!ended, "a 6 s walk to cover is not cut off");
		check(rule(defaults, "default-cover").maxMs() == 8_000L, "default-cover has 8 s too");
	}

	private static void hazardsStillPreemptCover(List<ReflexSpec.Rule> defaults) {
		int cover = rule(defaults, COVER).priority();
		for (String id : List.of("default-lava", "default-lava-flow", "default-fire", "default-air", "default-suffocate", "default-creeper",
				"default-fireball")) {
			check(rule(defaults, id).priority() > cover, id + " pre-empts cover");
		}
	}

	private static void corneredStandHoldsCoverBack(List<ReflexSpec.Rule> defaults) {
		check(ReflexEngine.backsOffWhenWeaker(rule(defaults, COVER)), "a cornered stand still holds shooter cover back");
	}

	private static void shieldRulesStandAsideForABlockingCover(List<ReflexSpec.Rule> defaults) {
		ReflexSpec.Rule arrow = rule(defaults, ARROW);
		check(ReflexEngine.shieldStandsAsideFor(arrow, true), "the arrow shield does not take the body from cover that blocks shots itself");
		check(!ReflexEngine.shieldStandsAsideFor(arrow, false), "the arrow shield keeps its priority over a firing that does not block shots");
		check(!ReflexEngine.shieldStandsAsideFor(rule(defaults, "default-lava"), true), "only shield rules stand aside");
		List<ReflexSpec.Rule> model = rules("[{\"id\":\"shots\",\"kind\":\"trigger\",\"priority\":9,"
				+ "\"when\":{\"type\":\"incoming_projectile\",\"withinS\":1},\"do\":{\"type\":\"shield\"}},"
				+ "{\"id\":\"guard\",\"kind\":\"stance\",\"priority\":9,\"when\":{\"type\":\"hostile_near\",\"within\":12},"
				+ "\"do\":{\"type\":\"shield\"}},"
				+ "{\"id\":\"counter\",\"kind\":\"stance\",\"priority\":9,\"when\":{\"type\":\"hostile_near\",\"within\":4},"
				+ "\"do\":{\"type\":\"shield\",\"counter\":true}},"
				+ "{\"id\":\"fireball\",\"kind\":\"trigger\",\"priority\":9,\"when\":{\"type\":\"fireball_incoming\",\"withinS\":1.5},"
				+ "\"do\":{\"type\":\"shield\"}}]");
		check(ReflexEngine.shieldStandsAsideFor(rule(model, "shots"), true), "a model incoming_projectile shield stands aside while cover blocks shots");
		check(!ReflexEngine.shieldStandsAsideFor(rule(model, "guard"), true), "a hostile_near shield stance keeps its priority over blocking cover");
		check(!ReflexEngine.shieldStandsAsideFor(rule(model, "counter"), true), "a counter shield stance keeps its priority over blocking cover");
		check(!ReflexEngine.shieldStandsAsideFor(rule(model, "fireball"), true), "a fireball_incoming shield keeps its priority over blocking cover");
		check(!ReflexActions.create(rule(defaults, COVER).action()).blocksShots(), "a cover firing claims to block nothing before its first tick");
		check(!ReflexActions.create(arrow.action()).blocksShots() && !new ReflexActions.Defend().blocksShots(),
				"no other behaviour claims to block for a shield rule");
	}

	/**
	 * Why the shield stands aside: a shield that pre-empts cover leaves it off for as long as the shooter keeps line of
	 * sight, because a pre-empted trigger is not re-armed. This is the scheduler as it is.
	 */
	private static void preemptedCoverStaysOffWhileTheShooterSees(List<ReflexSpec.Rule> defaults) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(rule(defaults, ARROW), rule(defaults, COVER)), 0);
		long tick = 1;
		ReflexScheduler.Decision start = scheduler.step(tick, Map.of(COVER, on(), ARROW, off()), RUNNING, "", false);
		check(COVER.equals(start.started()), "cover fires on the sighting");
		ReflexScheduler.Decision shot = scheduler.step(++tick, Map.of(COVER, on(), ARROW, on()), RUNNING, "walking to cover", false);
		check(shot.endOutcome() == ReflexScheduler.Outcome.PREEMPTED && ARROW.equals(shot.started()), "an ungated arrow shield pre-empts cover");
		scheduler.step(++tick, Map.of(COVER, on(), ARROW, off()), DONE, "shield lowered", false);
		boolean refired = false;
		for (int i = 0; i < 400; i++) {
			ReflexScheduler.Decision next = scheduler.step(++tick, Map.of(COVER, on(), ARROW, off()), RUNNING, "", false);
			if (COVER.equals(next.started())) refired = true;
		}
		check(!refired, "the pre-empted cover does not fire again while its shooter keeps sight (20 s)");
	}

	private static void gatedShieldLetsCoverFinish(List<ReflexSpec.Rule> defaults) {
		ReflexSpec.Rule arrow = rule(defaults, ARROW);
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(arrow, rule(defaults, COVER)), 0);
		long tick = 1;
		scheduler.step(tick, Map.of(COVER, on(), ARROW, off()), RUNNING, "", false);
		for (int i = 0; i < 40; i++) {
			// The engine reads the arrow's truth through the gate while the cover firing has a shield in hand (blocksShots).
			boolean arrowTruth = !ReflexEngine.shieldStandsAsideFor(arrow, scheduler.current() != null);
			ReflexScheduler.Decision next = scheduler.step(++tick, Map.of(COVER, on(), ARROW, new ReflexScheduler.Sense(arrowTruth, false)),
					RUNNING, "blocking a shot on the way to cover", false);
			check(next.ended() == null, "cover keeps the body while shots come in");
		}
		ReflexScheduler.Decision hidden = scheduler.step(++tick, Map.of(COVER, off(), ARROW, off()), DONE, "in cover", false);
		check(hidden.endOutcome() == ReflexScheduler.Outcome.DONE && hidden.ended().ruleId().equals(COVER), "cover reaches its cell");
	}

	/** An arrow seen during the shield's cooldown on the tick cover starts must not pre-empt cover when the cooldown ends. */
	private static void queuedArrowDuringCooldownDoesNotPreemptCover(List<ReflexSpec.Rule> defaults) {
		ReflexSpec.Rule arrow = rule(defaults, ARROW);
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(arrow, rule(defaults, COVER)), 0);
		long tick = 1;
		check(ARROW.equals(scheduler.step(tick, Map.of(COVER, off(), ARROW, on()), RUNNING, "", false).started()), "the shield blocks a first shot");
		scheduler.step(++tick, Map.of(COVER, off(), ARROW, off()), DONE, "shield lowered", false);
		// Cover starts on the tick a second arrow shows, while the shield is still cooling down: the arrow edge queues.
		ReflexScheduler.Decision start = scheduler.step(++tick, Map.of(COVER, on(), ARROW, on()), RUNNING, "", false);
		check(COVER.equals(start.started()), "cover fires on the sighting while the shield cools down");
		boolean preempted = false;
		for (int i = 0; i < 140; i++) {
			boolean arrowTruth = ReflexEngine.shieldGate(scheduler, arrow, false, scheduler.current() != null);
			ReflexScheduler.Decision next = scheduler.step(++tick, Map.of(COVER, on(), ARROW, new ReflexScheduler.Sense(arrowTruth, false)),
					RUNNING, "walking to cover", false);
			if (ARROW.equals(next.started())) preempted = true;
		}
		check(!preempted, "a queued arrow edge does not pre-empt cover after the shield's cooldown (7 s, inside cover's 8 s)");
	}

	private static void coverBlocksOnlyAroundAShot() {
		long after = ReflexActions.TakeCover.BLOCK_AFTER_SHOT_TICKS;
		int cap = ReflexActions.TakeCover.MAX_SHIELD_TICKS;
		check(ReflexActions.TakeCover.blocksNow(true, 0L, 0), "a shot seen coming stops cover to block");
		check(ReflexActions.TakeCover.blocksNow(true, after, 0), "the shield stays up through its raise");
		check(!ReflexActions.TakeCover.blocksNow(true, after + 1, 0), "then cover goes on without the shield");
		check(!ReflexActions.TakeCover.blocksNow(false, 0L, 0), "with no shield in hand cover never stops for a shot");
		check(cap == 40, "the shield cap is 40 ticks (2 s)");
		check(ReflexActions.TakeCover.blocksNow(true, 0L, cap - 1), "the 40th tick of shield still blocks a shot");
		check(!ReflexActions.TakeCover.blocksNow(true, 0L, cap), "after 40 ticks of shield a shot no longer stops cover");
	}

	private static void openGroundEndingsDoNotDisableCover(List<ReflexSpec.Rule> defaults) {
		ReflexSpec.Rule cover = rule(defaults, COVER);
		check(((ReflexActions.TakeCover) ReflexActions.create(cover.action())).endsDoneInOpenGround(),
				"a cover rule's firing ends done in open ground");
		check(!new ReflexActions.TakeCover(8, false).endsDoneInOpenGround(), "defend's own cover step keeps its failure");
		for (ReflexScheduler.ActionStatus ending : List.of(DONE, FAILED)) {
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(List.of(cover), 0);
			long tick = 0;
			for (int firing = 0; firing < ReflexScheduler.MAX_FAILURES_IN_A_ROW; firing++) {
				scheduler.step(++tick, Map.of(COVER, off()), RUNNING, "", false);
				scheduler.step(++tick, Map.of(COVER, on()), RUNNING, "", false);
				scheduler.step(++tick, Map.of(COVER, on()), ending, "no cell within 8 steps hides from skeleton", false);
				tick += 200;
			}
			boolean disabled = scheduler.events().stream().anyMatch(event -> event.outcome() == ReflexScheduler.Outcome.DISABLED);
			check(disabled == (ending == FAILED), "four open-ground endings in a row " + (ending == FAILED ? "as failures disable" : "as done keep") + " the rule");
		}
	}

	/** An unbroken sighting fires cover once; only a fresh sighting after the cooldown fires it again. */
	private static void finishedCoverWaitsForAFreshSighting(List<ReflexSpec.Rule> defaults) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(rule(defaults, COVER)), 0);
		long tick = 1;
		scheduler.step(tick, Map.of(COVER, on()), RUNNING, "", false);
		scheduler.step(++tick, Map.of(COVER, on()), DONE, "no cell hides; stayed in the open", false);
		int fired = 0;
		for (int i = 0; i < 400; i++) if (COVER.equals(scheduler.step(++tick, Map.of(COVER, on()), RUNNING, "", false).started())) fired++;
		check(fired == 0, "cover does not fire again while the same shooter keeps sight");
		scheduler.step(++tick, Map.of(COVER, off()), RUNNING, "", false);
		check(COVER.equals(scheduler.step(++tick, Map.of(COVER, on()), RUNNING, "", false).started()), "a fresh sighting after the cooldown fires it");
	}

	private static ReflexScheduler.Sense on() {
		return new ReflexScheduler.Sense(true, false);
	}

	private static ReflexScheduler.Sense off() {
		return ReflexScheduler.Sense.FALSE;
	}

	private static ReflexSpec.Rule rule(List<ReflexSpec.Rule> rules, String id) {
		return rules.stream().filter(rule -> rule.id().equals(id)).findFirst().orElseThrow(() -> new AssertionError("no rule " + id));
	}

	private static List<ReflexSpec.Rule> defaults() {
		try {
			return ReflexSpec.parseRules(JsonParser.parseString(java.nio.file.Files.readString(
					java.nio.file.Path.of("src/test/resources/default-reflex-rules.json"))).getAsJsonArray());
		} catch (java.io.IOException failure) {
			throw new java.io.UncheckedIOException(failure);
		}
	}

	private static List<ReflexSpec.Rule> rules(String json) {
		return ReflexSpec.parseRules(JsonParser.parseString(json).getAsJsonArray());
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("CoverRuleVerification: " + message);
		assertions++;
	}
}
