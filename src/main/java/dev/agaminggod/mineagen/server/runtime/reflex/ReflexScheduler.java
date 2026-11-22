package dev.agaminggod.mineagen.server.runtime.reflex;

import java.util.ArrayDeque;
import java.util.ArrayList;
import java.util.Deque;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.Set;

/**
 * One agent's reflex rules and their firing state, advanced once per server tick. Pure: the engine supplies each rule's
 * condition truth and the running action's status, and applies the returned decision to the body.
 * <ul>
 * <li>A trigger fires once on a rising edge of its condition (latched briefly while a higher rule holds the body).</li>
 * <li>A stance fires while its condition holds and releases when it stops holding.</li>
 * <li>Only one rule fires at a time; a higher priority rule that becomes ready preempts a lower one.</li>
 * <li>Every firing is bounded by the rule's maxMs, followed by its cooldown (debounce).</li>
 * <li>Loop protection: four firings in a row without progress, or more than forty in a minute, disable the rule.
 * A stance that hits maxS while the body loses health is not making progress either, and wakes the model at once; a
 * stance held for three maxS spans in a row without its condition clearing wakes the model once (it may need to flee
 * instead of holding). A stance whose action finishes (eat) that runs out of maxS has failed, like a trigger.</li>
 * <li>Rules expire after ttlMs, when an until condition holds, or after maxFirings.</li>
 * <li>The hazard floor ({@link #floor}): a coordinator default for lava, fire, air, suffocation or dragon breath fires while
 * its condition holds, not only on its edge; a model command does not end its firing while the hazard holds and it has not
 * settled; and at the loop limits it stays armed and wakes the model once per crossing instead of being disabled. A breath
 * floor that failed {@link #MAX_FAILURES_IN_A_ROW} times in a row in the cloud is cornered: the model's command then takes
 * the body (a pearl, a potion, a way the run could not see), and the floor fires again once the body is out.</li>
 * </ul>
 */
public final class ReflexScheduler {
	public static final long TICKS_PER_SECOND = 20L;
	/** A trigger edge that cannot fire at once (cooldown, a higher rule firing) stays pending this long. */
	public static final long PENDING_TICKS = 20L;
	public static final int MAX_FAILURES_IN_A_ROW = 4;
	public static final int MAX_FIRINGS_PER_MINUTE = 40;
	public static final int MAX_EVENTS = 16;
	/** Consecutive maxS spans a stance may hold, its condition never clearing, before the model is told. */
	public static final int HELD_SPANS_BEFORE_WAKE = 3;
	/**
	 * Conditions whose coordinator default is the hazard floor: the body must leave them whatever it was told. A fusing
	 * creeper is one: a command that took the body from the run left it standing in the blast (COMBAT-9).
	 */
	public static final Set<String> FLOOR_HAZARDS = Set.of("in_lava", "in_fire", "air_below", "suffocating", "cloud_near", "creeper_fusing");
	/** Floor hazards whose firing gives way to a model command once it is cornered (see {@link State#cornered}). */
	public static final Set<String> CORNERED_RELEASE = Set.of("cloud_near");
	/**
	 * Floor hazards whose run keeps a waiting command until the run ends, not only until the condition clears: the body is
	 * past the condition's line before it is safe. A breath run clears the cloud's reach; a creeper run (sense line 5 blocks)
	 * runs on to 6+ blocks with the fuse out, as a blast reaches about 6 blocks (one released at 5 still takes about 4 HP).
	 */
	public static final Set<String> RUN_KEEPS_COMMAND = Set.of("cloud_near", "creeper_fusing");

	/**
	 * A hazard-floor rule: a coordinator default with a non-negated lava, fire, air or suffocation condition. A model-written
	 * rule never is, even one that replaces a default by id. (The falling clutch is the engine's own exception to yield.)
	 */
	public static boolean floor(ReflexSpec.Rule rule) {
		if (!rule.coordinatorDefault()) return false;
		for (ReflexSpec.Condition condition : rule.when()) if (!condition.negated() && FLOOR_HAZARDS.contains(condition.type())) return true;
		return false;
	}

	public enum ActionStatus { RUNNING, DONE, FAILED }

	public enum Outcome {
		DONE, TIMEOUT, FAILED, PREEMPTED, YIELDED, DISABLED, EXPIRED, REMOVED;

		public String wire() {
			return name().toLowerCase(java.util.Locale.ROOT);
		}
	}

	/**
	 * One scheduler event. {@code endTick} is the server tick it happened at; {@code firing} is true only when a real firing
	 * ended (then {@code endTick - durationTicks} is its start), false for held-back, disabled and idle expiry events.
	 */
	public record Event(long sequence, String ruleId, Outcome outcome, long durationTicks, String detail, boolean wake, long endTick, boolean firing) {
	}

	public record Firing(String ruleId, long startTick, long maxTicks) {
	}

	/** What changed this tick: a firing that ended (with its outcome) and/or a rule that starts firing now. */
	public record Decision(Firing ended, Outcome endOutcome, String started) {
		static final Decision NONE = new Decision(null, null, null);

		public boolean changed() {
			return ended != null || started != null;
		}
	}

	/** One rule's sensed state for this tick. */
	public record Sense(boolean truth, boolean until) {
		public static final Sense FALSE = new Sense(false, false);
	}

	public record RuleStatus(String id, ReflexSpec.Kind kind, String state, int fired, long expiresInTicks, String disabledReason) {
	}

	private static final class State {
		final ReflexSpec.Rule rule;
		final long installedTick;
		final boolean floor;
		/** A floor rule is over the firings-a-minute limit; it wakes the model again only after dropping back under it. */
		boolean overRate;
		boolean lastTruth;
		long pendingUntil = -1L;
		long cooldownUntil;
		boolean suppressed;
		/** A trigger whose firing a model command took over; it may fire again once that command is over. */
		boolean yieldedTrigger;
		int fired;
		int failuresInARow;
		String lastFailure;
		String disabledReason;
		/** A finishing stance disabled by the loop limits comes back at this tick (see {@link #FINISHING_REARM_TICKS}). */
		long rearmAt = Long.MAX_VALUE;
		int heldSpans;
		/** First tick of the current false run of the condition (for a held action's release grace). */
		long falseSince = Long.MIN_VALUE;
		/** The rule could not fire while the body had to do something first (breathe): fire once that is over. */
		boolean heldBack;
		/** Tick of the condition's latest rising edge (triggers). */
		long edgeTick = Long.MIN_VALUE;
		final Deque<Long> recentFirings = new ArrayDeque<>();
		/** A floor rule that gives way to a model command once cornered ({@link #CORNERED_RELEASE}). */
		final boolean releasesCornered;
		/** A floor rule whose run keeps a waiting command until it ends ({@link #RUN_KEEPS_COMMAND}). */
		final boolean keepsCommandToRunEnd;
		/** Runs in a row that failed still in the hazard (a timeout is not one: the run was still moving). */
		int cornerFailures;

		State(ReflexSpec.Rule rule, long installedTick) {
			this.rule = rule;
			this.installedTick = installedTick;
			this.floor = ReflexScheduler.floor(rule);
			boolean release = false, keeps = false;
			if (floor) for (ReflexSpec.Condition condition : rule.when()) {
				if (condition.negated()) continue;
				release |= CORNERED_RELEASE.contains(condition.type());
				keeps |= RUN_KEEPS_COMMAND.contains(condition.type());
			}
			this.releasesCornered = release;
			this.keepsCommandToRunEnd = keeps;
		}

		/** Out of options in its hazard: failed this many times in a row, so the model's command may try instead. */
		boolean cornered() {
			return releasesCornered && cornerFailures >= MAX_FAILURES_IN_A_ROW;
		}

		/**
		 * The same rule with new numbers (an automatic stance flip): {@code rule} stays final, so a new state takes over
		 * every counter, cooldown, edge and limit of the old one.
		 */
		State carriedTo(ReflexSpec.Rule next) {
			State state = new State(next, installedTick);
			state.overRate = overRate;
			state.lastTruth = lastTruth;
			state.pendingUntil = pendingUntil;
			state.cooldownUntil = cooldownUntil;
			state.suppressed = suppressed;
			state.yieldedTrigger = yieldedTrigger;
			state.fired = fired;
			state.failuresInARow = failuresInARow;
			state.cornerFailures = cornerFailures;
			state.lastFailure = lastFailure;
			state.disabledReason = disabledReason;
			state.rearmAt = rearmAt;
			state.heldSpans = heldSpans;
			state.falseSince = falseSince;
			state.heldBack = heldBack;
			state.edgeTick = edgeTick;
			state.recentFirings.addAll(recentFirings);
			return state;
		}

		long expiresAt() {
			return installedTick + Math.max(1L, rule.ttlMs() / 50L);
		}
	}

	private static final java.util.concurrent.atomic.AtomicLong GENERATIONS = new java.util.concurrent.atomic.AtomicLong();

	/** Which scheduler this is: a replacement ({@code clearAll}, {@code forget}) numbers its events from 1 again. */
	private final long generation = GENERATIONS.incrementAndGet();
	private final Map<String, State> states = new LinkedHashMap<>();
	private final Deque<Event> events = new ArrayDeque<>();
	private Firing current;
	private long nextSequence = 1L;
	private long lastTick;
	/** Rules that must not hold the body this step, with why (see {@link #step}). */
	private Map<String, String> heldNow = Map.of();
	/** Whether the running firing has cost health (set each step by the engine). */
	private boolean harmed;
	/** Whether the running firing has met its goal and only holds on (set each step by the engine; see {@link #settled}). */
	private boolean settledHold;
	/**
	 * The floor rule whose firing a model command's yield was kept through: it yields in {@link #step} once out of its hazard
	 * or settled. Kept per rule while the hazard holds, so a firing that hits its maxS, fails or is preempted in the hazard
	 * and fires again (another rule may hold the body between) still owes the waiting command its yield.
	 */
	private String deferredYield;
	/** The last step ended a firing for a deferred yield (read by the engine, which then follows the command). */
	private boolean deferredYielded;

	/**
	 * Installs a complete rule set. A rule whose definition is unchanged keeps its state (cooldown, counters, edges);
	 * a changed or new rule starts fresh, and a firing whose rule changed or disappeared ends as REMOVED.
	 */
	public Decision replace(List<ReflexSpec.Rule> rules, long now) {
		Objects.requireNonNull(rules, "rules must not be null");
		if (rules.size() > ReflexSpec.MAX_RULES) throw new IllegalArgumentException("too many reflex rules");
		lastTick = Math.max(lastTick, now);
		Map<String, State> next = new LinkedHashMap<>();
		// Rules kept through a number-only change: the same rule for the running firing and a deferred yield.
		java.util.Set<String> carried = new java.util.HashSet<>();
		for (ReflexSpec.Rule rule : rules) {
			State previous = states.get(rule.id());
			State state;
			if (previous != null && previous.rule.equals(rule)) state = previous;
			else if (previous != null && numbersOnly(previous.rule, rule)) {
				state = previous.carriedTo(rule);
				carried.add(rule.id());
			} else state = new State(rule, now);
			next.put(rule.id(), state);
		}
		Decision decision = Decision.NONE;
		if (current != null) {
			State kept = next.get(current.ruleId());
			if (kept == null || kept != states.get(current.ruleId()) && !carried.contains(current.ruleId())) {
				decision = new Decision(current, Outcome.REMOVED, null);
				recordEnd(states.get(current.ruleId()), Outcome.REMOVED, now, "");
				current = null;
				settledHold = false;
			}
		}
		if (deferredYield != null && next.get(deferredYield) != states.get(deferredYield) && !carried.contains(deferredYield)) deferredYield = null;
		states.clear();
		states.putAll(next);
		return decision;
	}

	/**
	 * Whether {@code next} is {@code previous} with only condition numbers changed, both coordinator defaults: the
	 * coordinator's automatic stance moves a default's health or hunger line this way (issue 2 Step 2). The running
	 * behaviour keeps its action's numbers (the action is unchanged); sensing reads the new conditions from the next tick.
	 */
	static boolean numbersOnly(ReflexSpec.Rule previous, ReflexSpec.Rule next) {
		if (!previous.coordinatorDefault() || !next.coordinatorDefault() || !previous.id().equals(next.id()) || previous.kind() != next.kind()
				|| previous.priority() != next.priority() || !previous.action().equals(next.action()) || !previous.until().equals(next.until())
				|| previous.maxMs() != next.maxMs() || previous.cooldownMs() != next.cooldownMs() || previous.ttlMs() != next.ttlMs()
				|| previous.maxFirings() != next.maxFirings() || previous.wake() != next.wake() || previous.when().size() != next.when().size()) return false;
		for (int index = 0; index < previous.when().size(); index++) {
			ReflexSpec.Condition before = previous.when().get(index), after = next.when().get(index);
			if (!before.type().equals(after.type()) || before.negated() != after.negated() || !before.params().keySet().equals(after.params().keySet())) return false;
			for (String key : before.params().keySet()) {
				var a = before.params().get(key);
				var b = after.params().get(key);
				boolean numbers = a.isJsonPrimitive() && a.getAsJsonPrimitive().isNumber() && b.isJsonPrimitive() && b.getAsJsonPrimitive().isNumber();
				if (!numbers && !a.equals(b)) return false;
			}
		}
		return true;
	}

	public boolean isEmpty() {
		return states.isEmpty();
	}

	public List<ReflexSpec.Rule> rules() {
		return states.values().stream().map(state -> state.rule).toList();
	}

	public ReflexSpec.Rule rule(String id) {
		State state = states.get(id);
		return state == null ? null : state.rule;
	}

	public Firing current() {
		return current;
	}

	/** Forget a waiting trigger edge without ending an escape that has already started. */
	void discardPendingStart(String ruleId) {
		State state = states.get(ruleId);
		if (state == null || state.rule.kind() != ReflexSpec.Kind.TRIGGER || current != null && current.ruleId().equals(ruleId)) return;
		state.pendingUntil = -1L;
		state.edgeTick = Long.MIN_VALUE;
	}

	/** Rules whose conditions are worth sensing this tick (disabled rules are not). */
	public List<ReflexSpec.Rule> activeRules() {
		return states.values().stream().filter(state -> state.disabledReason == null).map(state -> state.rule).toList();
	}

	/**
	 * Advances one tick. {@code status} and {@code detail} describe the running firing's action (ignored when nothing
	 * fires); {@code holdsWhileTrue} marks actions such as a raised shield that end when their condition clears even
	 * for a trigger.
	 */
	public Decision step(long now, Map<String, Sense> senses, ActionStatus status, String detail, boolean holdsWhileTrue) {
		return step(now, senses, status, detail, holdsWhileTrue, false);
	}

	/** As above; {@code harmed} says the running firing has cost the body health. */
	public Decision step(long now, Map<String, Sense> senses, ActionStatus status, String detail, boolean holdsWhileTrue, boolean harmed) {
		return step(now, senses, status, detail, holdsWhileTrue, harmed, 0L);
	}

	/**
	 * As above; a held action ends only after its condition has been false for {@code releaseGraceTicks} (a shield stays
	 * up through the rest of a volley instead of dropping between shots).
	 */
	public Decision step(long now, Map<String, Sense> senses, ActionStatus status, String detail, boolean holdsWhileTrue, boolean harmed,
			long releaseGraceTicks) {
		return step(now, senses, status, detail, holdsWhileTrue, harmed, releaseGraceTicks, Map.of());
	}

	/**
	 * As above; {@code heldBack} names rules that must not hold the body this tick, with why (a melee rule while the body
	 * is short of air: a player stops fighting to breathe). A held-back firing ends as YIELDED with that reason, neither
	 * progress nor failure; a held-back rule does not start, and a trigger whose condition still holds fires once it is
	 * released. A rule held back before it fired is reported once per hold.
	 */
	public Decision step(long now, Map<String, Sense> senses, ActionStatus status, String detail, boolean holdsWhileTrue, boolean harmed,
			long releaseGraceTicks, Map<String, String> heldBack) {
		Objects.requireNonNull(senses, "senses must not be null");
		heldNow = Objects.requireNonNull(heldBack, "heldBack must not be null");
		this.harmed = current != null && harmed;
		lastTick = Math.max(lastTick, now);
		Firing ended = null;
		Outcome endOutcome = null;
		// Expiry first: a rule past its time or situation is gone even mid-firing.
		for (State state : List.copyOf(states.values())) {
			Sense sense = senses.getOrDefault(state.rule.id(), Sense.FALSE);
			boolean exhausted = state.rule.maxFirings() > 0 && state.fired >= state.rule.maxFirings()
					&& (current == null || !current.ruleId().equals(state.rule.id()));
			String why = now >= state.expiresAt() ? "ttl reached" : sense.until() ? "until condition holds" : exhausted ? "maxFirings reached" : null;
			if (why == null) continue;
			if (current != null && current.ruleId().equals(state.rule.id())) {
				ended = current;
				endOutcome = Outcome.EXPIRED;
				current = null;
			}
			states.remove(state.rule.id());
			boolean wasFiring = ended != null && ended.ruleId().equals(state.rule.id());
			addEvent(state.rule.id(), Outcome.EXPIRED, wasFiring ? now - ended.startTick() : 0L, why, false, now, wasFiring);
		}
		for (State state : states.values()) {
			if (state.disabledReason != null && now >= state.rearmAt) {
				// A bot that can never eat again starves: a meal blocked once (facing a table) is tried again later.
				addEvent(state.rule.id(), Outcome.DONE, 0L, "re-armed after " + (FINISHING_REARM_TICKS / TICKS_PER_SECOND) + " s disabled", false, now, false);
				state.disabledReason = null;
				state.rearmAt = Long.MAX_VALUE;
				state.failuresInARow = 0;
				state.recentFirings.clear();
			}
			if (state.disabledReason != null) continue;
			boolean truth = senses.getOrDefault(state.rule.id(), Sense.FALSE).truth();
			if (state.rule.kind() == ReflexSpec.Kind.TRIGGER && truth && !state.lastTruth) {
				state.pendingUntil = now + PENDING_TICKS;
				state.edgeTick = now;
			}
			if (!truth) {
				state.suppressed = false;
				state.yieldedTrigger = false;
				state.cornerFailures = 0;
				// A breath edge queued behind another firing goes with the cloud: fired late, the run would start from a safe
				// body with no cloud point and sprint from an unrelated mob or the body's facing.
				if (state.releasesCornered) state.pendingUntil = -1L;
				state.heldSpans = 0;
				if (state.lastTruth || state.falseSince == Long.MIN_VALUE) state.falseSince = now;
			} else {
				state.falseSince = Long.MIN_VALUE;
			}
			state.lastTruth = truth;
			String held = heldBack.get(state.rule.id());
			boolean firing = current != null && current.ruleId().equals(state.rule.id());
			boolean waiting = state.rule.kind() == ReflexSpec.Kind.TRIGGER ? state.pendingUntil >= now : truth && !state.suppressed;
			if (held != null && truth && !state.heldBack && waiting && !firing && now >= state.cooldownUntil) {
				state.heldBack = true;
				addEvent(state.rule.id(), Outcome.YIELDED, 0L, "held back: " + held, false, now, false);
			} else if (held == null && state.heldBack) {
				state.heldBack = false;
				if (truth && state.rule.kind() == ReflexSpec.Kind.TRIGGER) state.pendingUntil = Math.max(now, state.cooldownUntil) + PENDING_TICKS;
			}
			if (!truth) state.heldBack = false;
		}
		State owed = deferredYield == null ? null : states.get(deferredYield);
		if (owed == null || !owed.lastTruth && (current == null || !current.ruleId().equals(deferredYield))) deferredYield = null;
		deferredYielded = false;
		if (current != null) {
			State state = states.get(current.ruleId());
			Outcome outcome = null;
			String reason = detail == null ? "" : detail;
			String held = heldBack.get(current.ruleId());
			// A breath floor keeps a waiting command until its run ends, not the first tick out: released 1 block clear, the
			// command sprinted straight back into the cloud before the reflex could turn the body (live breath room).
			if (current.ruleId().equals(deferredYield) && (!state.lastTruth && !state.keepsCommandToRunEnd || settledHold) && status == ActionStatus.RUNNING) {
				outcome = Outcome.YIELDED;
				reason = "model command";
				if (state.rule.kind() == ReflexSpec.Kind.STANCE) state.suppressed = true;
				else state.yieldedTrigger = true;
				deferredYielded = true;
				yieldStancesTo(state);
			} else if (held != null && status == ActionStatus.RUNNING) {
				outcome = Outcome.YIELDED;
				reason = (reason.isEmpty() ? "" : reason + "; ") + held;
				state.heldBack = state.lastTruth;
			} else if (status == ActionStatus.FAILED) outcome = Outcome.FAILED;
			else if (status == ActionStatus.DONE) outcome = Outcome.DONE;
			else if ((state.rule.kind() == ReflexSpec.Kind.STANCE || holdsWhileTrue) && !state.lastTruth
					&& (!holdsWhileTrue || now - state.falseSince >= releaseGraceTicks)) outcome = Outcome.DONE;
			else if (now - current.startTick() >= current.maxTicks()) outcome = Outcome.TIMEOUT;
			else {
				// A firing that only holds on after its goal (decision 13: a burn running out) yields to any ready rule.
				State challenger = best(now, settledHold ? Integer.MIN_VALUE : state.rule.priority());
				if (challenger != null) {
					outcome = Outcome.PREEMPTED;
					reason = "by " + challenger.rule.id();
				}
			}
			if (outcome != null) {
				ended = current;
				endOutcome = outcome;
				current = null;
				// A floor firing that ran out, failed or was preempted in its hazard fires again: the command still waits for its yield.
				// A breath run that ends done still in reach of the cloud (no safe heading further) has not got the body out either.
				boolean refires = state.lastTruth && (outcome == Outcome.TIMEOUT || outcome == Outcome.FAILED || outcome == Outcome.PREEMPTED
						|| outcome == Outcome.DONE && state.keepsCommandToRunEnd);
				boolean kept = ended.ruleId().equals(deferredYield);
				if (kept && !refires) deferredYield = null;
				recordEnd(state, outcome, now, reason);
				if (kept && state.keepsCommandToRunEnd && !state.lastTruth && outcome != Outcome.YIELDED) {
					// The breath (or creeper) run ended out of its hazard: the command it kept waiting takes the body now.
					deferredYield = null;
					deferredYielded = true;
					state.yieldedTrigger = true;
					yieldStancesTo(state);
				} else if (kept && state.cornered()) {
					// Cornered with a command waiting: the command takes the body; the floor waits until the body is out.
					deferredYield = null;
					deferredYielded = true;
					state.yieldedTrigger = true;
					yieldStancesTo(state);
				}
				rearmSwallowedEdges(ended, now);
			}
		}
		String started = null;
		if (current == null) {
			State next = best(now, Integer.MIN_VALUE);
			if (next != null) {
				current = new Firing(next.rule.id(), now, Math.max(1L, next.rule.maxMs() / 50L));
				next.fired++;
				next.pendingUntil = -1L;
				next.recentFirings.addLast(now);
				while (!next.recentFirings.isEmpty() && next.recentFirings.peekFirst() <= now - 60L * TICKS_PER_SECOND) next.recentFirings.removeFirst();
				started = next.rule.id();
			}
		}
		// The engine's settled flag described the firing it was set for; a new firing is unsettled until the engine says so.
		if (ended != null || started != null) settledHold = false;
		return ended == null && started == null ? Decision.NONE : new Decision(ended, endOutcome, started);
	}

	private void rearmSwallowedEdges(Firing ended, long now) {
		for (State other : states.values()) {
			if (other.rule.kind() != ReflexSpec.Kind.TRIGGER || other.disabledReason != null || !other.lastTruth) continue;
			if (other.rule.id().equals(ended.ruleId()) || other.edgeTick < ended.startTick() || other.pendingUntil >= now) continue;
			other.pendingUntil = now + PENDING_TICKS;
		}
	}

	/**
	 * Marks the running firing as settled for the next {@link #step}: its goal is met and it only holds on (out of lava,
	 * the burn running out), so any ready rule the model armed may take the body, whatever its priority.
	 */
	public void settled(boolean settled) {
		settledHold = settled;
	}

	/** A firing that only holds on after its goal ends done at its maxS: no timeout strike, no timeout wake. */
	public static ActionStatus settledStatus(ActionStatus status, boolean settled, long elapsedTicks, long maxTicks) {
		return status == ActionStatus.RUNNING && settled && elapsedTicks >= maxTicks ? ActionStatus.DONE : status;
	}

	/**
	 * A direct model command took the body: end the firing; a stance waits until its condition clears once or {@link #resume}.
	 * A hazard-floor firing is kept while its hazard holds and it has not settled; the command waits under it.
	 */
	public Decision yield(long now) {
		suppressIdleShields();
		// A cornered breath floor between its refirings yields too, or it would take the body back from the command next tick.
		for (State state : states.values()) {
			if (!state.cornered() || !state.lastTruth) continue;
			state.yieldedTrigger = true;
			if (state.rule.id().equals(deferredYield)) deferredYield = null;
		}
		if (current == null) return Decision.NONE;
		Firing ended = current;
		State state = states.get(ended.ruleId());
		// A breath run keeps a new command waiting until the run ends, also once the body is just out of the cloud and still
		// sprinting: released then, the command walked straight back in (council R3).
		if (state.floor && (state.lastTruth || state.keepsCommandToRunEnd) && !settledHold && !state.cornered()) {
			deferredYield = current.ruleId();
			return Decision.NONE;
		}
		current = null;
		settledHold = false;
		recordEnd(state, Outcome.YIELDED, now, "model command");
		if (state.rule.kind() == ReflexSpec.Kind.STANCE) state.suppressed = true;
		else state.yieldedTrigger = true;
		if (state.floor) yieldStancesTo(state);
		return new Decision(ended, Outcome.YIELDED, null);
	}

	/**
	 * A command asked for the body a floor firing held, so the stances that would take it now (default-defend under attack)
	 * yield to it too, as they would have had they held the body when it came. Floor rules still fire.
	 */
	private void yieldStancesTo(State floor) {
		for (State other : states.values()) {
			if (other != floor && !other.floor && other.rule.kind() == ReflexSpec.Kind.STANCE && other.lastTruth) other.suppressed = true;
		}
	}

	/**
	 * A breath floor ({@link #CORNERED_RELEASE}) still in its hazard owes the next run: a command, however it arrived, waits in
	 * the gap between two of its firings. Other floors (lava) keep main's behaviour: a waiting command runs in their cooldown.
	 */
	public boolean holdsWaitingCommand() {
		return holdsWaitingCommand(null);
	}

	/**
	 * As {@link #holdsWaitingCommand()}, reading the breath condition from this tick's {@code senses} where they have it (null:
	 * the last step's). The engine ticks a running firing before {@link #step}: the tick the cloud comes, the last step's
	 * reading would still let a shield pass the command's forward input toward it.
	 */
	public boolean holdsWaitingCommand(Map<String, Sense> senses) {
		for (State state : states.values()) {
			if (!state.releasesCornered || state.disabledReason != null || blocked(state)) continue;
			Sense sense = senses == null ? null : senses.get(state.rule.id());
			boolean truth = sense != null ? sense.truth() : state.lastTruth;
			if (truth && !state.yieldedTrigger) return true;
		}
		return false;
	}

	/** Rules that must not fire now whatever their condition (an End default outside the End); see {@link #blockWhere}. */
	private java.util.function.Predicate<ReflexSpec.Rule> blocked;

	/**
	 * Rules matching {@code rule} (null: none) must not fire from now on: their queued edges are dropped and they are left out
	 * of selection until it changes (the End's defaults the tick the body leaves the End, before the coordinator removes them).
	 * Called every tick: it allocates nothing.
	 */
	public void blockWhere(java.util.function.Predicate<ReflexSpec.Rule> rule) {
		blocked = rule;
		if (rule == null) return;
		for (State state : states.values()) if (rule.test(state.rule)) state.pendingUntil = -1L;
	}

	private boolean blocked(State state) {
		return blocked != null && blocked.test(state.rule);
	}

	/** A cornered floor rule, still in its hazard, that has not yet given the body to a command. */
	public boolean corneredUnyielded() {
		for (State state : states.values()) {
			if (!state.cornered() || !state.lastTruth || state.yieldedTrigger) continue;
			if (current == null || current.ruleId().equals(state.rule.id())) return true;
		}
		return false;
	}

	/** Whether the last {@link #step} ended a floor firing for a model command it had been kept through. */
	public boolean deferredYielded() {
		return deferredYielded;
	}

	/** A shield stance guards idle time; it cannot seize a model command in the gap before its first firing. */
	void suppressIdleShields() {
		for (State state : states.values()) {
			if (state.rule.kind() == ReflexSpec.Kind.STANCE && "shield".equals(state.rule.action().type())) state.suppressed = true;
		}
	}

	public void resume(long now, boolean rearmTriggers) {
		lastTick = Math.max(lastTick, now);
		for (State state : states.values()) {
			boolean rearm = (rearmTriggers || state.yieldedTrigger) && state.rule.kind() == ReflexSpec.Kind.TRIGGER && state.lastTruth
					&& state.disabledReason == null && (current == null || !current.ruleId().equals(state.rule.id()));
			state.suppressed = false;
			state.yieldedTrigger = false;
			if (rearm) state.pendingUntil = Math.max(now, state.cooldownUntil) + PENDING_TICKS;
		}
	}

	/** Whether a yielded rule is waiting for its condition to clear or the model's command to end. */
	public boolean anySuppressed() {
		for (State state : states.values()) if (state.suppressed || state.yieldedTrigger) return true;
		return false;
	}

	/** The body is gone (death, removal): end any firing without counting it against the rule. */
	public Decision interrupt(long now, String why) {
		if (current == null) return Decision.NONE;
		Firing ended = current;
		current = null;
		settledHold = false;
		addEvent(ended.ruleId(), Outcome.YIELDED, now - ended.startTick(), why, false, now, true);
		State state = states.get(ended.ruleId());
		if (state != null) state.cooldownUntil = now + Math.max(1L, state.rule.cooldownMs() / 50L);
		return new Decision(ended, Outcome.YIELDED, null);
	}

	private State best(long now, int abovePriority) {
		State best = null;
		for (State state : states.values()) {
			if (state.rule.priority() <= abovePriority || !ready(state, now)) continue;
			if (best == null || state.rule.priority() > best.rule.priority()) best = state;
		}
		return best;
	}

	private boolean ready(State state, long now) {
		if (state.disabledReason != null || now < state.cooldownUntil || state.heldBack || heldNow.containsKey(state.rule.id()) || blocked(state)) return false;
		if (current != null && current.ruleId().equals(state.rule.id())) return false;
		if (state.rule.maxFirings() > 0 && state.fired >= state.rule.maxFirings()) return false;
		// A floor trigger is level-triggered: ready whenever its hazard holds, unless a settled firing of it yielded. A breath
		// floor is only level-triggered: a queued edge (a rearm after another firing) never starts it once the cloud has cleared.
		if (state.rule.kind() == ReflexSpec.Kind.TRIGGER && state.releasesCornered) return state.lastTruth && !state.yieldedTrigger;
		if (state.rule.kind() == ReflexSpec.Kind.TRIGGER) return state.pendingUntil >= now || state.floor && state.lastTruth && !state.yieldedTrigger;
		return state.lastTruth && !state.suppressed;
	}

	private void recordEnd(State state, Outcome outcome, long now, String detail) {
		if (state == null) return;
		Firing firing = current != null && current.ruleId().equals(state.rule.id()) ? current : null;
		long started = firing != null ? firing.startTick() : state.recentFirings.isEmpty() ? now : state.recentFirings.peekLast();
		long duration = Math.max(0L, now - started);
		// A stance that finishes (each firing eats one item) has not held anything at its maxS: it failed, waits its cooldown
		// (the paused command runs meanwhile) and counts toward the loop limit. A holding stance (defend, brace) is progress.
		boolean stance = state.rule.kind() == ReflexSpec.Kind.STANCE && !finishes(state.rule);
		state.cooldownUntil = stance && outcome == Outcome.TIMEOUT && state.lastTruth ? now : now + Math.max(1L, state.rule.cooldownMs() / 50L);
		// A breath floor that times out or ends done still in reach of the cloud runs again in the same tick: in its cooldown
		// the paused command resumed and walked back into the cloud (live breath room, a run timed out at a small island's
		// rim). A failed run waits the rule's own cooldown (the engine keeps a waiting command paused through it).
		if (state.keepsCommandToRunEnd && state.lastTruth && outcome != Outcome.YIELDED && outcome != Outcome.FAILED) state.cooldownUntil = now;
		boolean harmedHold = stance && outcome == Outcome.TIMEOUT && harmed;
		boolean failure = outcome == Outcome.FAILED || outcome == Outcome.TIMEOUT && !stance || harmedHold;
		boolean progress = !failure && (outcome == Outcome.DONE || outcome == Outcome.TIMEOUT && stance);
		boolean wake = state.rule.wake() && outcome != Outcome.PREEMPTED || harmedHold;
		if (stance && outcome == Outcome.TIMEOUT && ++state.heldSpans == HELD_SPANS_BEFORE_WAKE) {
			wake = true;
			detail = (detail == null || detail.isEmpty() ? "" : detail + "; ") + "held " + (duration * HELD_SPANS_BEFORE_WAKE / TICKS_PER_SECOND)
					+ " s and the condition has not cleared";
		}
		if (state.releasesCornered) {
			// Only a run that got the body out resets the count; a run done still in the cloud is like a timeout: neither.
			if (outcome == Outcome.FAILED && state.lastTruth) state.cornerFailures++;
			else if (outcome == Outcome.DONE && !state.lastTruth) state.cornerFailures = 0;
		}
		if (failure) {
			state.failuresInARow++;
			state.lastFailure = detail;
		} else if (progress) {
			state.failuresInARow = 0;
		}
		if (state.floor) {
			// The floor is never switched off: crossing a loop limit marks this firing's report as a wake, once per crossing.
			String crossed = null;
			if (failure && state.failuresInARow == MAX_FAILURES_IN_A_ROW) crossed = "fired " + state.failuresInARow + "x in a row without progress";
			boolean over = state.recentFirings.size() > MAX_FIRINGS_PER_MINUTE;
			if (crossed == null && over && !state.overRate) crossed = "fired " + state.recentFirings.size() + "x within 60 s";
			state.overRate = over;
			if (crossed != null) {
				wake = true;
				detail = crossed + ", still armed" + (detail == null || detail.isEmpty() ? "" : "; last: " + detail);
			}
			addEvent(state.rule.id(), outcome, duration, detail, wake, now, true);
			return;
		}
		addEvent(state.rule.id(), outcome, duration, detail, wake, now, true);
		String disabled = null;
		if (state.failuresInARow >= MAX_FAILURES_IN_A_ROW) {
			disabled = "fired " + state.failuresInARow + "x in a row without progress"
					+ (state.lastFailure == null || state.lastFailure.isEmpty() ? "" : "; last: " + state.lastFailure);
		} else if (state.recentFirings.size() > MAX_FIRINGS_PER_MINUTE) {
			disabled = "fired " + state.recentFirings.size() + "x within 60 s";
		}
		if (disabled != null) {
			state.disabledReason = disabled;
			if (finishes(state.rule)) {
				state.rearmAt = now + FINISHING_REARM_TICKS;
				disabled += "; tried again in " + (FINISHING_REARM_TICKS / TICKS_PER_SECOND) + " s";
			}
			addEvent(state.rule.id(), Outcome.DISABLED, 0L, disabled, true, now, false);
		}
	}

	/** Stance actions that end when done (one meal), so running out of maxS is a failure, not a hold. */
	public static final Set<String> FINISHING_STANCE_ACTIONS = Set.of("eat");
	/** A finishing stance the loop limits disabled is armed again after this long, so a blocked meal never means starving. */
	public static final long FINISHING_REARM_TICKS = 60L * TICKS_PER_SECOND;

	/** A stance whose action finishes, see {@link #FINISHING_STANCE_ACTIONS}. */
	public static boolean finishes(ReflexSpec.Rule rule) {
		return rule.kind() == ReflexSpec.Kind.STANCE && FINISHING_STANCE_ACTIONS.contains(rule.action().type());
	}

	private void addEvent(String ruleId, Outcome outcome, long durationTicks, String detail, boolean wake, long endTick, boolean firing) {
		String bounded = detail == null ? "" : detail.length() > 160 ? detail.substring(0, 160) : detail;
		events.addLast(new Event(nextSequence++, ruleId, outcome, durationTicks, bounded, wake, endTick, firing));
		while (events.size() > MAX_EVENTS) events.removeFirst();
	}

	public long generation() {
		return generation;
	}

	public List<Event> events() {
		return List.copyOf(events);
	}

	public long lastSequence() {
		return nextSequence - 1L;
	}

	public List<RuleStatus> statuses(long now) {
		List<RuleStatus> rows = new ArrayList<>(states.size());
		for (State state : states.values()) {
			String label = state.disabledReason != null ? "disabled"
					: current != null && current.ruleId().equals(state.rule.id()) ? "firing"
					: now < state.cooldownUntil ? "cooldown"
					: state.suppressed || state.yieldedTrigger ? "yielded" : "armed";
			rows.add(new RuleStatus(state.rule.id(), state.rule.kind(), label, state.fired, Math.max(0L, state.expiresAt() - now), state.disabledReason));
		}
		return List.copyOf(rows);
	}

	/** Ids whose condition must still be sensed (all non-disabled rules), for engines that cache per-type sampling. */
	public Set<String> ids() {
		return Set.copyOf(states.keySet());
	}
}
