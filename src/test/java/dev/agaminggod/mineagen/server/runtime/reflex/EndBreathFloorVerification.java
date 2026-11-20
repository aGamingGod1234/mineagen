package dev.agaminggod.mineagen.server.runtime.reflex;

import com.google.gson.JsonParser;
import java.util.List;
import java.util.Map;

/**
 * The End's breath default (late-game wall, order 12) is a hazard floor: it keeps the body through a model command while
 * the breath holds, fires again while it holds, is never switched off, and gives way to a waiting command once cornered.
 * The rules are the exact End defaults the coordinator sends (src/test/resources/end-reflex-rules.json).
 */
public final class EndBreathFloorVerification {
	private static final ReflexScheduler.ActionStatus RUNNING = ReflexScheduler.ActionStatus.RUNNING;
	private static final ReflexScheduler.ActionStatus FAILED = ReflexScheduler.ActionStatus.FAILED;
	private static final String BREATH = "default-breath";
	private static int assertions;

	private EndBreathFloorVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " End breath floor assertions");
	}

	public static int verify() {
		assertions = 0;
		List<ReflexSpec.Rule> end = endDefaults();
		breathIsFloorAndThrowIsNot(end);
		breathKeepsTheBodyThroughACommand(end);
		breathRefiresWhileInTheCloud(end);
		corneredBreathHandsTheWaitingCommandTheBody(end);
		corneredBreathYieldsToALaterCommand(end);
		timeoutsInTheCloudDoNotCorner(end);
		commandNeverMovesBetweenFirings(end);
		doneInTheCloudKeepsTheCountAndTheWaitingCommand(end);
		failedRunWaitsItsCooldown(end);
		corneredBreathHandsARunningCommandTheBody(end);
		endDefaultsAreEndOnly(end);
		breathStaysArmedAtTheLoopLimits(end);
		return assertions;
	}

	private static void breathIsFloorAndThrowIsNot(List<ReflexSpec.Rule> end) {
		check(ReflexScheduler.FLOOR_HAZARDS.contains("cloud_near"), "cloud_near is a floor hazard");
		check(ReflexScheduler.floor(named(end, BREATH)), "default-breath is the breath floor");
		check(!ReflexScheduler.floor(named(end, "default-end-throw")), "default-end-throw is not floor: it still yields to a command");
		ReflexSpec.Rule model = rule("{\"id\":\"default-breath\",\"priority\":9,\"when\":{\"type\":\"cloud_near\",\"within\":1},\"do\":{\"type\":\"sprint_away\",\"blocks\":10}}");
		check(!ReflexScheduler.floor(model), "a model rule replacing default-breath by id is not floor");
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(model), 0L);
		step(scheduler, 1L, true, RUNNING);
		check(scheduler.yield(2L).endOutcome() == ReflexScheduler.Outcome.YIELDED, "the model's own breath rule still yields to its command");
	}

	/** The 02c13 shape: commands kept pausing a model rule, which walked back into the breath. The floor keeps the body. */
	private static void breathKeepsTheBodyThroughACommand(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		check(BREATH.equals(step(scheduler, 1L, true, RUNNING).started()), "breath fires");
		for (long tick = 2L; tick < 10L; tick++) {
			check(scheduler.yield(tick).ended() == null && scheduler.current() != null, "breath keeps the body through a command while in the cloud");
			check(!step(scheduler, tick, true, RUNNING).changed(), "the run keeps going");
		}
		// Out of the cloud but still running: the command keeps waiting (released at once, it sprinted back in).
		for (long tick = 10L; tick < 20L; tick++) check(!step(scheduler, tick, false, RUNNING).changed() && !scheduler.deferredYielded(), "out but still running: the command still waits");
		ReflexScheduler.Decision out = step(scheduler, 20L, false, ReflexScheduler.ActionStatus.DONE, "ran 10.0 blocks");
		check(out.endOutcome() == ReflexScheduler.Outcome.DONE && scheduler.deferredYielded(), "the run done out of the cloud, the waiting command takes the body");
		for (long tick = 21L; tick < 40L; tick++) check(step(scheduler, tick, false, RUNNING).started() == null, "and keeps it while out");

		// Timed out at a rim, out of the cloud: the command gets the body too.
		ReflexScheduler rim = new ReflexScheduler();
		rim.replace(List.of(named(end, BREATH)), 0L);
		step(rim, 1L, true, RUNNING);
		rim.yield(2L);
		long max = rim.current().maxTicks();
		step(rim, 3L, false, RUNNING);
		check(step(rim, 1L + max, false, RUNNING).endOutcome() == ReflexScheduler.Outcome.TIMEOUT && rim.deferredYielded(), "a run timed out out of the cloud hands the command the body");
		// Done but still in the cloud: no hand-over, it fires again.
		ReflexScheduler inside = new ReflexScheduler();
		inside.replace(List.of(named(end, BREATH)), 0L);
		step(inside, 1L, true, RUNNING);
		inside.yield(2L);
		step(inside, 3L, true, ReflexScheduler.ActionStatus.DONE, "ran 10.0 blocks");
		check(!inside.deferredYielded(), "done but still in the cloud: the command still waits");
	}

	/** The 928b1 shape: a cloud trigger fired once for 0.4 s and never again while the body stood in the breath. */
	private static void breathRefiresWhileInTheCloud(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		long cooldown = Math.max(1L, named(end, BREATH).cooldownMs() / 50L);
		step(scheduler, 1L, true, RUNNING);
		ReflexScheduler.Decision done = step(scheduler, 9L, true, ReflexScheduler.ActionStatus.DONE, "ran 10.0 blocks");
		check(done.endOutcome() == ReflexScheduler.Outcome.DONE && BREATH.equals(done.started()), "still near the cloud after a finished run: it fires again in the same tick, no new edge or cooldown");
		long max = scheduler.current().maxTicks();
		ReflexScheduler.Decision timeout = step(scheduler, 9L + max, true, RUNNING);
		check(timeout.endOutcome() == ReflexScheduler.Outcome.TIMEOUT && BREATH.equals(timeout.started()), "a run that times out near the cloud fires again in the same tick: no gap for a paused command to walk back in");
		check(cooldown >= 1L, "the rule's own cooldown is not what decides it");
	}

	/** No heading out (a pillar in the void): after four failures in a row the waiting command gets the body. */
	private static void corneredBreathHandsTheWaitingCommandTheBody(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		long cooldown = Math.max(1L, named(end, BREATH).cooldownMs() / 50L);
		long tick = 0L;
		step(scheduler, ++tick, true, RUNNING);
		check(scheduler.yield(++tick).ended() == null, "a command waits under the breath floor");
		for (int failure = 1; failure <= ReflexScheduler.MAX_FAILURES_IN_A_ROW; failure++) {
			ReflexScheduler.Decision decision = step(scheduler, ++tick, true, FAILED, "no safe heading away");
			if (failure < ReflexScheduler.MAX_FAILURES_IN_A_ROW) {
				check(!scheduler.deferredYielded(), "failure " + failure + ": the command still waits");
				tick += cooldown;
				check(BREATH.equals(step(scheduler, ++tick, true, RUNNING).started()), "failure " + failure + ": it fires again in the cloud");
			} else {
				check(decision.endOutcome() == ReflexScheduler.Outcome.FAILED && scheduler.deferredYielded(), "cornered: the waiting command takes the body");
			}
		}
		for (int wait = 0; wait < 40; wait++) check(step(scheduler, ++tick, true, RUNNING).started() == null, "cornered and yielded: it does not take the body back in the cloud");
		step(scheduler, ++tick, false, RUNNING);
		tick += 30L;
		check(BREATH.equals(step(scheduler, ++tick, true, RUNNING).started()), "out and back in: the floor fires again");
		check(scheduler.events().stream().noneMatch(event -> event.outcome() == ReflexScheduler.Outcome.DISABLED), "never disabled");
	}

	/** Cornered with no command waiting, it keeps trying; a command that then arrives takes the body. */
	private static void corneredBreathYieldsToALaterCommand(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		long cooldown = Math.max(1L, named(end, BREATH).cooldownMs() / 50L);
		long tick = 0L;
		for (int failure = 1; failure <= ReflexScheduler.MAX_FAILURES_IN_A_ROW; failure++) {
			check(BREATH.equals(step(scheduler, ++tick, true, RUNNING).started()), "try " + failure + " fires");
			step(scheduler, ++tick, true, FAILED, "no safe heading away");
			tick += cooldown;
		}
		check(BREATH.equals(step(scheduler, ++tick, true, RUNNING).started()), "cornered with nothing waiting: it keeps trying");
		check(scheduler.yield(++tick).endOutcome() == ReflexScheduler.Outcome.YIELDED, "a command now takes the body at once");
		for (int wait = 0; wait < 40; wait++) check(step(scheduler, ++tick, true, RUNNING).started() == null, "and keeps it while in the cloud");
		// The same command before cornering waits (the hold), checked above; a fresh scheduler shows the contrast.
		ReflexScheduler fresh = new ReflexScheduler();
		fresh.replace(List.of(named(end, BREATH)), 0L);
		step(fresh, 1L, true, RUNNING);
		check(fresh.yield(2L).ended() == null, "not cornered: the same command waits");
	}

	/** Runs that time out still moving are not out of options: four of them keep the command waiting. */
	private static void timeoutsInTheCloudDoNotCorner(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		long tick = 0L;
		step(scheduler, ++tick, true, RUNNING);
		check(scheduler.yield(++tick).ended() == null, "a command waits");
		for (int timeout = 1; timeout <= ReflexScheduler.MAX_FAILURES_IN_A_ROW + 1; timeout++) {
			long max = scheduler.current().maxTicks();
			tick = scheduler.current().startTick() + max;
			ReflexScheduler.Decision decision = step(scheduler, tick, true, RUNNING);
			check(decision.endOutcome() == ReflexScheduler.Outcome.TIMEOUT && !scheduler.deferredYielded(), "timeout " + timeout + " in the cloud: the command still waits");
			check(BREATH.equals(decision.started()), "timeout " + timeout + ": it runs again in the same tick");
			check(scheduler.yield(++tick).ended() == null, "timeout " + timeout + ": a new command still waits");
		}
	}

	/** Whether the engine lets a model command's action run this tick: neither a firing nor a kept command between firings. */
	private static boolean commandRuns(ReflexScheduler scheduler) {
		return scheduler.current() == null && !ReflexEngine.holdsCommandBetweenFirings(scheduler, true);
	}

	/** Council R1: a tick between two breath runs let a paused travel_to step back toward the cloud. It gets none now. */
	private static void commandNeverMovesBetweenFirings(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		long tick = 0L;
		step(scheduler, ++tick, true, RUNNING);
		scheduler.yield(++tick);
		int freeTicks = 0;
		ReflexScheduler.ActionStatus[] ends = { ReflexScheduler.ActionStatus.DONE, RUNNING, FAILED, ReflexScheduler.ActionStatus.DONE, RUNNING };
		for (ReflexScheduler.ActionStatus ending : ends) {
			// RUNNING here means: let the run reach its maxS (a timeout).
			if (ending == RUNNING) tick = scheduler.current().startTick() + scheduler.current().maxTicks();
			else tick++;
			step(scheduler, tick, true, ending, "no safe heading further");
			if (commandRuns(scheduler)) freeTicks++;
			// A failed run waits its cooldown: walk through it a tick at a time.
			while (scheduler.current() == null) {
				step(scheduler, ++tick, true, RUNNING);
				if (commandRuns(scheduler)) freeTicks++;
			}
		}
		check(freeTicks == 0, "the waiting command got " + freeTicks + " executor ticks between breath runs in the cloud");
	}

	/** Council R1: a run done still in the cloud neither resets the corner count nor drops the waiting command. */
	private static void doneInTheCloudKeepsTheCountAndTheWaitingCommand(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		long cooldown = Math.max(1L, named(end, BREATH).cooldownMs() / 50L);
		long tick = 0L;
		step(scheduler, ++tick, true, RUNNING);
		check(scheduler.yield(++tick).ended() == null, "a command waits");
		ReflexScheduler.ActionStatus[] runs = { FAILED, ReflexScheduler.ActionStatus.DONE, FAILED, ReflexScheduler.ActionStatus.DONE, FAILED, FAILED };
		boolean handed = false;
		for (int run = 0; run < runs.length; run++) {
			ReflexScheduler.Decision decision = step(scheduler, ++tick, true, runs[run], "no safe heading further");
			check(scheduler.holdsWaitingCommand() || scheduler.deferredYielded(), "run " + run + ": the command is still owed the body");
			if (run < runs.length - 1) {
				check(!scheduler.deferredYielded(), "run " + run + ": not cornered yet (3 failures with done runs between)");
				if (decision.started() == null) {
					tick += cooldown;
					check(BREATH.equals(step(scheduler, tick, true, RUNNING).started()), "run " + run + ": it fires again");
				}
			} else {
				handed = scheduler.deferredYielded() && scheduler.anySuppressed();
			}
		}
		check(handed, "the fourth failure corners it and the hand-over follows the command (command.yielded runs)");
		CommandFollower follower = new CommandFollower();
		ReflexEngine.followDeferredYield(scheduler, follower, tick);
		check(!scheduler.holdsWaitingCommand(), "handed over: nothing kept");
	}

	/** Council R1: no-gap refire is for timeouts and runs done in the cloud; a failed run waits the rule's own cooldown. */
	private static void failedRunWaitsItsCooldown(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		long cooldown = Math.max(1L, named(end, BREATH).cooldownMs() / 50L);
		check(cooldown > 1L, "the breath rule has a cooldown of more than a tick");
		step(scheduler, 1L, true, RUNNING);
		scheduler.yield(2L);
		ReflexScheduler.Decision failed = step(scheduler, 3L, true, FAILED, "no safe heading away");
		check(failed.endOutcome() == ReflexScheduler.Outcome.FAILED && failed.started() == null, "a failed run does not refire in the same tick");
		check(step(scheduler, 4L, true, RUNNING).started() == null, "nor the next tick");
		check(ReflexEngine.holdsCommandBetweenFirings(scheduler, true), "the waiting command stays paused through the cooldown");
		check(BREATH.equals(step(scheduler, 3L + cooldown, true, RUNNING).started()), "it fires again once its cooldown is over");
	}

	/** Council R1: a command running before the cloud, or admitted between firings, also gets the body once cornered. */
	private static void corneredBreathHandsARunningCommandTheBody(List<ReflexSpec.Rule> end) {
		for (boolean betweenFirings : new boolean[] { false, true }) {
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(List.of(named(end, BREATH)), 0L);
			CommandFollower follower = new CommandFollower();
			long cooldown = Math.max(1L, named(end, BREATH).cooldownMs() / 50L);
			long tick = 0L;
			// The command predates the cloud: it asked for the body before, so no yield request comes now.
			for (int failure = 1; failure <= ReflexScheduler.MAX_FAILURES_IN_A_ROW; failure++) {
				check(BREATH.equals(step(scheduler, ++tick, true, RUNNING).started()), "try " + failure + " fires");
				check(ReflexEngine.corneredHandBack(scheduler, follower, !betweenFirings, tick).ended() == null, "try " + failure + ": not cornered, no hand-back");
				step(scheduler, ++tick, true, FAILED, "no safe heading away");
				if (failure < ReflexScheduler.MAX_FAILURES_IN_A_ROW) tick += cooldown;
			}
			check(scheduler.corneredUnyielded(), "cornered in the cloud");
			check(ReflexEngine.corneredHandBack(scheduler, follower, false, tick).ended() == null && scheduler.corneredUnyielded(), "with no command it keeps trying");
			if (!betweenFirings) {
				tick += cooldown;
				check(BREATH.equals(step(scheduler, tick, true, RUNNING).started()), "the cornered floor fires again");
				check(ReflexEngine.corneredHandBack(scheduler, follower, true, ++tick).endOutcome() == ReflexScheduler.Outcome.YIELDED, "the running command takes the body");
			} else {
				ReflexEngine.corneredHandBack(scheduler, follower, true, ++tick);
				check(scheduler.current() == null && !scheduler.corneredUnyielded(), "a command admitted between firings takes the body");
			}
			check(scheduler.anySuppressed() && !scheduler.holdsWaitingCommand(), "the follower tracks the command and nothing keeps it paused");
			for (int wait = 0; wait < 40; wait++) check(step(scheduler, ++tick, true, RUNNING).started() == null, "it does not take the body back in the cloud");
		}
	}

	/** Council R1: the End's defaults are End-only in the mod too (the engine stops them the tick the body leaves). */
	private static void endDefaultsAreEndOnly(List<ReflexSpec.Rule> end) {
		check(ReflexEngine.endOnly(named(end, BREATH)) && ReflexEngine.endOnly(named(end, "default-end-throw")), "both End defaults are End-only");
		ReflexSpec.Rule model = rule("{\"id\":\"default-breath\",\"priority\":9,\"when\":{\"type\":\"cloud_near\",\"within\":1},\"do\":{\"type\":\"sprint_away\",\"blocks\":10}}");
		check(!ReflexEngine.endOnly(model), "a model rule with the same id is the model's: not gated by dimension");
		check(!ReflexEngine.endOnly(null), "no rule is not End-only");
	}

	/** Loop limits wake the model once per crossing but never switch the breath floor off. */
	private static void breathStaysArmedAtTheLoopLimits(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		long cooldown = Math.max(1L, named(end, BREATH).cooldownMs() / 50L);
		long tick = 0L;
		for (int firing = 0; firing < ReflexScheduler.MAX_FIRINGS_PER_MINUTE + 5; firing++) {
			step(scheduler, ++tick, true, RUNNING);
			step(scheduler, ++tick, true, ReflexScheduler.ActionStatus.DONE, "ran 10.0 blocks");
			step(scheduler, ++tick, false, RUNNING);
			tick += cooldown;
		}
		check(scheduler.events().stream().noneMatch(event -> event.outcome() == ReflexScheduler.Outcome.DISABLED), "never disabled at the rate limit");
		check(!"disabled".equals(scheduler.statuses(tick).getFirst().state()), "still armed");
		check(scheduler.events().stream().anyMatch(ReflexScheduler.Event::wake), "the model is woken at the crossing");
	}

	private static List<ReflexSpec.Rule> endDefaults() {
		try {
			return ReflexSpec.parseRules(JsonParser.parseString(java.nio.file.Files.readString(
					java.nio.file.Path.of("src/test/resources/end-reflex-rules.json"))).getAsJsonArray());
		} catch (java.io.IOException failure) {
			throw new java.io.UncheckedIOException(failure);
		}
	}

	private static ReflexSpec.Rule named(List<ReflexSpec.Rule> rules, String id) {
		return rules.stream().filter(rule -> rule.id().equals(id)).findFirst().orElseThrow();
	}

	private static ReflexSpec.Rule rule(String json) {
		return ReflexSpec.parseRule(JsonParser.parseString(json).getAsJsonObject(), "rule");
	}

	private static ReflexScheduler.Decision step(ReflexScheduler scheduler, long now, boolean truth, ReflexScheduler.ActionStatus status) {
		return step(scheduler, now, truth, status, "");
	}

	private static ReflexScheduler.Decision step(ReflexScheduler scheduler, long now, boolean truth, ReflexScheduler.ActionStatus status, String detail) {
		return scheduler.step(now, Map.of(BREATH, new ReflexScheduler.Sense(truth, false)), status, detail, false);
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("EndBreathFloorVerification: " + message);
		assertions++;
	}
}
