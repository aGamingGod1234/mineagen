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
		perchStrikeRunsOnlyForALandingInReach(end);
		gapHoldsStillInputOverTheCommand();
		lavaFloorStillGivesACommandItsCooldown();
		blockedEndDefaultsNeverFire(end);
		aYieldAfterTheCloudWaitsForTheRun(end);
		shieldInTheBreathCooldownDoesNotPassTheCommandThrough(end);
		gapStepTakesAndReleasesTheHold(end);
		blockedEndThrowLosesItsQueuedEdge(end);
		breathStaysArmedAtTheLoopLimits(end);
		queuedBreathEdgeGoesWithTheCloud(end);
		shieldReadsThisTicksCloud(end);
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
		check(end.stream().allMatch(ReflexEngine::endOnly), "every End default is End-only");
		check(ReflexEngine.END_DEFAULTS.equals(end.stream().map(ReflexSpec.Rule::id).collect(java.util.stream.Collectors.toSet())),
				"the mod's End-only ids are exactly the coordinator's End defaults (end-reflex-rules.json)");
		ReflexSpec.Rule model = rule("{\"id\":\"default-breath\",\"priority\":9,\"when\":{\"type\":\"cloud_near\",\"within\":1},\"do\":{\"type\":\"sprint_away\",\"blocks\":10}}");
		check(!ReflexEngine.endOnly(model), "a model rule with the same id is the model's: not gated by dimension");
		check(!ReflexEngine.endOnly(null), "no rule is not End-only");
	}

	/**
	 * The run to a perched dragon's head: a stance under the breath and throw rules, standing aside for the body's own
	 * fight, shot or flight, asleep without a sword or axe, and only for a landing about level with the body.
	 */
	private static void perchStrikeRunsOnlyForALandingInReach(List<ReflexSpec.Rule> end) {
		ReflexSpec.Rule strike = named(end, "default-perch-strike");
		check(strike.kind() == ReflexSpec.Kind.STANCE && "strike_head".equals(strike.action().type()), "the perch strike is a stance that runs strike_head");
		check(strike.when().stream().anyMatch(condition -> "dragon_perched".equals(condition.type()) && condition.number("within", 0.0D) == 24.0D),
				"it fires for a perched dragon within 24 blocks (vanilla keeps a perched dragon down while a player is within 20)");
		check(strike.when().stream().anyMatch(condition -> "health_below".equals(condition.type()) && condition.negated()), "it stays out at low health");
		check(!ReflexScheduler.floor(strike), "it is no hazard floor: a model command takes the body back");
		check(named(end, "default-breath").priority() > strike.priority() && named(end, "default-end-throw").priority() > strike.priority()
				&& named(end, "default-gaze").priority() > strike.priority(), "breath, throw and gaze outrank it");
		for (dev.agaminggod.mineagen.protocol.ActionType own : List.of(dev.agaminggod.mineagen.protocol.ActionType.FIGHT_TARGET,
				dev.agaminggod.mineagen.protocol.ActionType.FIGHT_UNTIL, dev.agaminggod.mineagen.protocol.ActionType.USE_RANGED,
				dev.agaminggod.mineagen.protocol.ActionType.FLEE_FROM)) {
			check(!ReflexEngine.gatedTruth(strike, true, own), "it stands aside while the body's own " + own.wireName() + " runs");
		}
		for (dev.agaminggod.mineagen.protocol.ActionType waiting : List.of(dev.agaminggod.mineagen.protocol.ActionType.WAIT,
				dev.agaminggod.mineagen.protocol.ActionType.TRAVEL_TO, dev.agaminggod.mineagen.protocol.ActionType.MOVE_TO)) {
			check(ReflexEngine.gatedTruth(strike, true, waiting), "it takes the body from a " + waiting.wireName() + " (the waits and walks the landings found)");
		}
		check(ReflexEngine.gatedTruth(strike, true, null), "it takes an idle body");
		check(ReflexEngine.gatedTruth(strike, true, dev.agaminggod.mineagen.protocol.ActionType.NAVIGATE_TO), "it takes the body from a navigate_to");
		for (dev.agaminggod.mineagen.protocol.ActionType keys : List.of(dev.agaminggod.mineagen.protocol.ActionType.CONTROL,
				dev.agaminggod.mineagen.protocol.ActionType.CONTROL_SEQUENCE, dev.agaminggod.mineagen.protocol.ActionType.LOOK_AT,
				dev.agaminggod.mineagen.protocol.ActionType.BREAK_BLOCK, dev.agaminggod.mineagen.protocol.ActionType.PLACE_BLOCK,
				dev.agaminggod.mineagen.protocol.ActionType.USE_ITEM)) {
			check(!ReflexEngine.gatedTruth(strike, true, keys), "it leaves a paused " + keys.wireName() + " alone: that lease outranks the fight's");
		}
		check(ReflexSensors.inStep(0.42D, 0.0D) && ReflexSensors.inStep(-0.3D, 1.2D), "a jump up a block or a short drop is a step of the walk");
		check(!ReflexSensors.inStep(1.1D, 0.0D), "a throw upward is not a step");
		check(!ReflexSensors.inStep(-0.8D, 4.0D), "a fall past 3 blocks is not a step");
		check(ReflexEngine.strikeHoldsThroughTakeoff(strike, true, true), "a firing head run holds on while its fight steps clear of a takeoff");
		check(!ReflexEngine.strikeHoldsThroughTakeoff(strike, true, false), "it ends with the perch once no retreat runs");
		check(!ReflexEngine.strikeHoldsThroughTakeoff(strike, false, true), "only the firing rule holds on");
		check(!ReflexEngine.strikeHoldsThroughTakeoff(named(end, "default-breath"), true, true), "no other rule holds on this way");
		check(ReflexActions.StrikeHead.weapon("minecraft:iron_sword") && ReflexActions.StrikeHead.weapon("minecraft:stone_axe"), "a sword or an axe is the weapon");
		check(!ReflexActions.StrikeHead.weapon("minecraft:iron_pickaxe") && !ReflexActions.StrikeHead.weapon(null), "a pickaxe or an empty hand is not");
		ReflexActions.Held sword = new ReflexActions.Held("minecraft:iron_sword", false, false), pick = new ReflexActions.Held("minecraft:iron_pickaxe", false, false);
		check(ReflexActions.lacks(strike.action(), slot -> slot == 3 ? sword : ReflexActions.Held.EMPTY, 0, ReflexActions.Held.EMPTY) == null, "a hotbar sword wakes it");
		check("no sword or axe in hotbar".equals(ReflexActions.lacks(strike.action(), slot -> slot == 0 ? pick : slot == 20 ? sword : ReflexActions.Held.EMPTY, 0, ReflexActions.Held.EMPTY)),
				"a sword only in the bag (not the hotbar) leaves it asleep");
		check(ReflexSensors.perchLevel(62.0D, 67.0D) && ReflexSensors.perchLevel(59.0D, 67.0D) && ReflexSensors.perchLevel(69.5D, 67.0D),
				"ground round the fountain, 2-8 below the perched dragon, is level with it");
		check(!ReflexSensors.perchLevel(58.0D, 67.0D) && !ReflexSensors.perchLevel(71.0D, 67.0D), "a pit or a tower is not");
		ReflexActions.StrikeHead run = new ReflexActions.StrikeHead();
		check(run.doneAtMaxS() && run.drivesOwnNavigation(), "a 20 s span of the perch ends done and the fight drives its own input");
		check(ReflexActions.StrikeHead.head(null) == null, "no dragon, no head");
	}

	/** Council R2: in the gap the input that wins is the reflex lease's still input, not the command's last forward/sprint/jump. */
	private static void gapHoldsStillInputOverTheCommand() {
		dev.agaminggod.mineagen.agent.AgentId agent = new dev.agaminggod.mineagen.agent.AgentId(java.util.UUID.fromString("00000000-0000-0000-0000-00000000e2d2"));
		dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController controller =
				new dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController(new dev.agaminggod.mineagen.server.runtime.input.InputStateSink() {
					@Override public void apply(dev.agaminggod.mineagen.agent.AgentId id, dev.agaminggod.mineagen.server.runtime.input.AgentInputState previous,
							dev.agaminggod.mineagen.server.runtime.input.AgentInputState state) { }
					@Override public void clear(dev.agaminggod.mineagen.agent.AgentId id, dev.agaminggod.mineagen.server.runtime.input.AgentInputState previous) { }
				});
		dev.agaminggod.mineagen.server.runtime.input.InputLease command = controller.acquire(agent, dev.agaminggod.mineagen.server.runtime.input.InputOwner.NAVIGATION, 100);
		controller.apply(command, new dev.agaminggod.mineagen.server.runtime.input.AgentInputState(1.0F, 0.0F, true, false, true, false, false, 90.0F, 0.0F, 0, net.minecraft.world.InteractionHand.MAIN_HAND));
		check(controller.currentState(agent).orElseThrow().forward() == 1.0F, "the command's travel input drives the body");
		dev.agaminggod.mineagen.server.runtime.input.InputLease held = ReflexEngine.holdStill(controller, agent, null, 90.0F, 0.0F, 0);
		var winning = controller.currentState(agent).orElseThrow();
		check(winning.forward() == 0.0F && winning.strafe() == 0.0F && !winning.sprint() && !winning.jump() && !winning.use(), "in the gap the winning input is still");
		check(ReflexEngine.holdStill(controller, agent, held, 90.0F, 0.0F, 0) == held, "the same lease holds through the gap");
		controller.release(held);
		check(controller.currentState(agent).orElseThrow().forward() == 1.0F, "released: the command's input drives again");
	}

	/** Council R2 (regression guard): only the breath floor holds a command in its gap; a failing lava floor does not, as on main. */
	private static void lavaFloorStillGivesACommandItsCooldown() {
		List<ReflexSpec.Rule> defaults;
		try {
			defaults = ReflexSpec.parseRules(JsonParser.parseString(java.nio.file.Files.readString(
					java.nio.file.Path.of("src/test/resources/default-reflex-rules.json"))).getAsJsonArray());
		} catch (java.io.IOException failure) {
			throw new java.io.UncheckedIOException(failure);
		}
		ReflexSpec.Rule lava = named(defaults, "default-lava");
		check(ReflexScheduler.floor(lava), "default-lava is a floor");
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(lava), 0L);
		Map<String, ReflexScheduler.Sense> inLava = Map.of("default-lava", new ReflexScheduler.Sense(true, false));
		check("default-lava".equals(scheduler.step(1L, inLava, RUNNING, "", false).started()), "lava fires");
		check(scheduler.yield(2L).ended() == null, "a command waits under the lava floor");
		ReflexScheduler.Decision failed = scheduler.step(3L, inLava, FAILED, "no way out", false);
		check(failed.endOutcome() == ReflexScheduler.Outcome.FAILED && scheduler.current() == null, "the lava run failed and waits its cooldown");
		check(!scheduler.holdsWaitingCommand() && !ReflexEngine.holdsCommandBetweenFirings(scheduler, true), "the command runs in the lava floor's cooldown, as on main");
	}

	/** Council R2: outside the End, a blocked End default never fires, even with a queued edge and the coordinator's removal late. */
	private static void blockedEndDefaultsNeverFire(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(end, 0L);
		check(BREATH.equals(step(scheduler, 1L, true, RUNNING).started()), "breath fires in the End");
		// The body leaves the End mid-firing: the engine interrupts the firing and blocks the End's rules.
		check(scheduler.interrupt(2L, "left the End").endOutcome() == ReflexScheduler.Outcome.YIELDED, "the running End default stops");
		scheduler.blockWhere(ReflexEngine::endOnly);
		check(ReflexEngine.endOnlyIds(scheduler).equals(ReflexEngine.END_DEFAULTS), "every End default is blocked");
		// The sense still reads true for a while (a cloud carried over, the coordinator's removal not here yet).
		for (long tick = 3L; tick < 60L; tick++) check(step(scheduler, tick, true, RUNNING).started() == null, "blocked: no firing at tick " + tick);
		check(!scheduler.holdsWaitingCommand(), "blocked: no command is held");
		// A queued edge from before the block is dropped.
		ReflexScheduler edged = new ReflexScheduler();
		edged.replace(end, 0L);
		step(edged, 1L, false, RUNNING);
		edged.blockWhere(rule -> BREATH.equals(rule.id()));
		check(step(edged, 2L, true, RUNNING).started() == null, "a new edge while blocked does not fire");
		edged.blockWhere(ReflexEngine::endOnly);
		for (long tick = 3L; tick < 30L; tick++) check(step(edged, tick, true, RUNNING).started() == null, "the queued edge never fires while blocked");
		edged.blockWhere(null);
		check(BREATH.equals(step(edged, 30L, true, RUNNING).started()), "back in the End it fires again");
	}

	private static dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController controller() {
		return new dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController(new dev.agaminggod.mineagen.server.runtime.input.InputStateSink() {
			@Override public void apply(dev.agaminggod.mineagen.agent.AgentId id, dev.agaminggod.mineagen.server.runtime.input.AgentInputState previous,
					dev.agaminggod.mineagen.server.runtime.input.AgentInputState state) { }
			@Override public void clear(dev.agaminggod.mineagen.agent.AgentId id, dev.agaminggod.mineagen.server.runtime.input.AgentInputState previous) { }
		});
	}

	private static final dev.agaminggod.mineagen.server.runtime.input.AgentInputState TRAVEL = new dev.agaminggod.mineagen.server.runtime.input.AgentInputState(
			1.0F, 0.0F, true, false, true, false, false, 90.0F, 0.0F, 0, net.minecraft.world.InteractionHand.MAIN_HAND);

	/** Council R3 (1): the first yield request arrives after cloud_near turned false while the sprint still runs: it waits. */
	private static void aYieldAfterTheCloudWaitsForTheRun(List<ReflexSpec.Rule> end) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		check(BREATH.equals(step(scheduler, 1L, true, RUNNING).started()), "breath fires");
		check(!step(scheduler, 2L, false, RUNNING).changed(), "out of the cloud, the sprint still runs");
		check(scheduler.yield(3L).ended() == null && BREATH.equals(scheduler.current().ruleId()), "a first command now waits: the run is not ended");
		for (long tick = 4L; tick < 12L; tick++) check(!step(scheduler, tick, false, RUNNING).changed() && !scheduler.deferredYielded(), "the run keeps the body to its end");
		ReflexScheduler.Decision done = step(scheduler, 12L, false, ReflexScheduler.ActionStatus.DONE, "ran 10.0 blocks");
		check(done.endOutcome() == ReflexScheduler.Outcome.DONE && scheduler.deferredYielded(), "the run done out of the cloud hands the waiting command the body");
		// A model rule (not floor) still yields at once, as before.
		ReflexScheduler model = new ReflexScheduler();
		model.replace(List.of(rule("{\"id\":\"default-breath\",\"priority\":9,\"when\":{\"type\":\"cloud_near\",\"within\":1},\"do\":{\"type\":\"sprint_away\",\"blocks\":10}}")), 0L);
		step(model, 1L, true, RUNNING);
		step(model, 2L, false, RUNNING);
		check(model.yield(3L).endOutcome() == ReflexScheduler.Outcome.YIELDED, "the model's own breath rule yields at once");
	}

	/** Council R3 (2): a shield stance firing in the breath cooldown neither walks the command on nor lets it resume. */
	private static void shieldInTheBreathCooldownDoesNotPassTheCommandThrough(List<ReflexSpec.Rule> end) {
		ReflexSpec.Rule guard = rule("{\"id\":\"guard\",\"kind\":\"stance\",\"priority\":5,\"when\":{\"type\":\"hostile_near\",\"within\":4},\"do\":{\"type\":\"shield\"}}");
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH), guard), 0L);
		Map<String, ReflexScheduler.Sense> both = Map.of(BREATH, new ReflexScheduler.Sense(true, false), "guard", new ReflexScheduler.Sense(true, false));
		// The command predates the cloud (no yield request, which would also lower idle shields).
		check(BREATH.equals(scheduler.step(1L, both, RUNNING, "", false).started()), "breath fires first");
		ReflexScheduler.Decision failed = scheduler.step(3L, both, FAILED, "no safe heading away", false);
		check(failed.endOutcome() == ReflexScheduler.Outcome.FAILED && "guard".equals(failed.started()), "in the breath cooldown the shield stance fires");
		check(!ReflexEngine.passesThrough(true, true, scheduler), "a breath run is owed: the shield does not pass the command's movement");
		// The engine pauses the action when nothing passes (tickAgent returns !passes), and builds the shield's context without the
		// command's input below it, so the shield applies its aim only. The winning input is then still.
		var input = controller();
		var agent = new dev.agaminggod.mineagen.agent.AgentId(java.util.UUID.fromString("00000000-0000-0000-0000-00000000e2d3"));
		input.apply(input.acquire(agent, dev.agaminggod.mineagen.server.runtime.input.InputOwner.NAVIGATION, 100), TRAVEL);
		var reflex = input.acquire(agent, dev.agaminggod.mineagen.server.runtime.input.InputOwner.REFLEX, ReflexEngine.INPUT_PRIORITY);
		input.apply(reflex, new dev.agaminggod.mineagen.server.runtime.input.AgentInputState(0.0F, 0.0F, false, false, false, false, true, 90.0F, 0.0F, 0,
				net.minecraft.world.InteractionHand.OFF_HAND));
		var winning = input.currentState(agent).orElseThrow();
		check(winning.forward() == 0.0F && !winning.sprint() && !winning.jump() && winning.use(), "the shield's aim wins: shield up, no forward, sprint or jump");
		// Contrast: with no breath owed, the same shield passes a walking command through, as on main.
		ReflexScheduler plain = new ReflexScheduler();
		plain.replace(List.of(guard), 0L);
		plain.step(1L, Map.of("guard", new ReflexScheduler.Sense(true, false)), RUNNING, "", false);
		check(ReflexEngine.passesThrough(true, true, plain), "no breath owed: a shield still lets a walking command move");
		check(!ReflexEngine.passesThrough(true, false, plain), "and never a command that does not walk");
	}

	/** Council R3 (4): the engine's gap step takes the still-input hold while a run is owed and releases it once nothing is. */
	private static void gapStepTakesAndReleasesTheHold(List<ReflexSpec.Rule> end) {
		var input = controller();
		var agent = new dev.agaminggod.mineagen.agent.AgentId(java.util.UUID.fromString("00000000-0000-0000-0000-00000000e2d4"));
		input.apply(input.acquire(agent, dev.agaminggod.mineagen.server.runtime.input.InputOwner.NAVIGATION, 100), TRAVEL);
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH)), 0L);
		step(scheduler, 1L, true, RUNNING);
		scheduler.yield(2L);
		step(scheduler, 3L, true, FAILED, "no safe heading away");
		check(scheduler.current() == null, "in the failed run's cooldown");
		var lease = ReflexEngine.gapStep(scheduler, input, agent, null, true, 90.0F, 0.0F, 0);
		check(lease != null && input.currentState(agent).orElseThrow().forward() == 0.0F, "the gap step takes the hold: still input wins");
		check(ReflexEngine.gapStep(scheduler, input, agent, lease, true, 90.0F, 0.0F, 0) == lease, "and keeps the same lease the next tick");
		step(scheduler, 4L, false, RUNNING);
		check(ReflexEngine.gapStep(scheduler, input, agent, lease, true, 90.0F, 0.0F, 0) == null, "out of the cloud: nothing owed, the hold is released");
		var after = input.currentState(agent).orElseThrow();
		check(after.forward() == 1.0F && after.sprint(), "the command's input drives again");
		// No command: no hold, nothing taken.
		ReflexScheduler idle = new ReflexScheduler();
		idle.replace(List.of(named(end, BREATH)), 0L);
		step(idle, 1L, true, RUNNING);
		step(idle, 2L, true, FAILED, "no safe heading away");
		check(ReflexEngine.gapStep(idle, input, agent, null, false, 90.0F, 0.0F, 0) == null && input.currentState(agent).orElseThrow().forward() == 1.0F,
				"with no command active the gap takes nothing");
	}

	/** Council R3 (6): default-end-throw's edge, queued while the breath held the body, is dropped by the block and never fires. */
	private static void blockedEndThrowLosesItsQueuedEdge(List<ReflexSpec.Rule> end) {
		String throwId = "default-end-throw";
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(end, 0L);
		java.util.function.BiFunction<Boolean, Boolean, Map<String, ReflexScheduler.Sense>> senses = (breath, swoop) -> Map.of(
				BREATH, new ReflexScheduler.Sense(breath, false), throwId, new ReflexScheduler.Sense(swoop, false));
		check(BREATH.equals(scheduler.step(1L, senses.apply(true, false), RUNNING, "", false).started()), "breath holds the body");
		check(scheduler.step(2L, senses.apply(true, true), RUNNING, "", false).started() == null, "the swoop edge queues behind the higher breath firing");
		check(!scheduler.statuses(2L).isEmpty(), "rules listed");
		scheduler.interrupt(3L, "left the End");
		scheduler.blockWhere(ReflexEngine::endOnly);
		for (long tick = 4L; tick < 10L; tick++) check(scheduler.step(tick, senses.apply(false, true), RUNNING, "", false).started() == null, "blocked: the queued swoop edge does not fire at " + tick);
		scheduler.blockWhere(null);
		for (long tick = 10L; tick < 15L; tick++) check(scheduler.step(tick, senses.apply(false, true), RUNNING, "", false).started() == null, "unblocked inside the old pending window: the dropped edge stays dropped at " + tick);
		scheduler.step(15L, senses.apply(false, false), RUNNING, "", false);
		check(throwId.equals(scheduler.step(16L, senses.apply(false, true), RUNNING, "", false).started()), "a fresh swoop edge in the End fires it");
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

	/**
	 * Codex review: breath came while another priority-9 firing held the body and cleared before it ended. The queued edge must
	 * not start a run from a safe body (no cloud point: SprintAway ran from the body's facing).
	 */
	private static void queuedBreathEdgeGoesWithTheCloud(List<ReflexSpec.Rule> end) {
		ReflexSpec.Rule other = rule("{\"id\":\"other\",\"priority\":9,\"when\":{\"type\":\"hostile_near\",\"within\":4},\"do\":{\"type\":\"sprint_away\",\"blocks\":10}}");
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(other, named(end, BREATH)), 0L);
		java.util.function.BiFunction<Boolean, Boolean, Map<String, ReflexScheduler.Sense>> senses = (cloud, mob) -> Map.of(
				BREATH, new ReflexScheduler.Sense(cloud, false), "other", new ReflexScheduler.Sense(mob, false));
		check("other".equals(scheduler.step(1L, senses.apply(false, true), RUNNING, "", false).started()), "the other priority-9 rule fires first");
		check(scheduler.step(2L, senses.apply(true, true), RUNNING, "", false).started() == null, "breath at equal priority queues behind it");
		check(scheduler.step(3L, senses.apply(false, true), RUNNING, "", false).started() == null, "the cloud clears while the other runs");
		ReflexScheduler.Decision done = scheduler.step(4L, senses.apply(false, false), ReflexScheduler.ActionStatus.DONE, "ran 10.0 blocks", false);
		check(done.endOutcome() == ReflexScheduler.Outcome.DONE && done.started() == null, "the other run ends: the queued breath edge does not start a run out of the cloud");
		for (long tick = 5L; tick < 30L; tick++) check(scheduler.step(tick, senses.apply(false, false), RUNNING, "", false).started() == null, "still out of the cloud: no breath run at " + tick);
		check(BREATH.equals(scheduler.step(30L, senses.apply(true, false), RUNNING, "", false).started()), "back in the cloud it fires");
	}

	/**
	 * Codex review: a shield runs in a failed breath run's cooldown and the cloud returns. The engine ticks the shield before the
	 * scheduler steps, so the shield must read this tick's cloud, or it passes the command's forward input toward the breath.
	 */
	private static void shieldReadsThisTicksCloud(List<ReflexSpec.Rule> end) {
		ReflexSpec.Rule guard = rule("{\"id\":\"guard\",\"kind\":\"stance\",\"priority\":5,\"when\":{\"type\":\"hostile_near\",\"within\":4},\"do\":{\"type\":\"shield\"}}");
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(named(end, BREATH), guard), 0L);
		java.util.function.Function<Boolean, Map<String, ReflexScheduler.Sense>> senses = cloud -> Map.of(
				BREATH, new ReflexScheduler.Sense(cloud, false), "guard", new ReflexScheduler.Sense(true, false));
		check(BREATH.equals(scheduler.step(1L, senses.apply(true), RUNNING, "", false).started()), "breath fires first");
		check("guard".equals(scheduler.step(3L, senses.apply(true), FAILED, "no safe heading away", false).started()), "in the breath cooldown the shield fires");
		check(scheduler.step(4L, senses.apply(false), RUNNING, "", false).started() == null && "guard".equals(scheduler.current().ruleId()), "the cloud clears, the shield keeps running");
		check(ReflexEngine.passesThrough(true, true, scheduler, senses.apply(false)), "out of the cloud the shield lets a walking command move");
		check(!ReflexEngine.passesThrough(true, true, scheduler, senses.apply(true)), "the tick the cloud comes back, before the scheduler steps, the shield already holds the command");
		check(ReflexEngine.passesThrough(true, true, scheduler), "the last step's reading alone would still have passed it");
		scheduler.step(5L, senses.apply(true), RUNNING, "", false);
		check(!ReflexEngine.passesThrough(true, true, scheduler, senses.apply(true)) && !ReflexEngine.passesThrough(true, true, scheduler), "after the step both readings hold it");
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
