package dev.agaminggod.mineagen.server.runtime.reflex;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.server.AgentManager;
import dev.agaminggod.mineagen.server.perception.ObservationVisibility;
import dev.agaminggod.mineagen.protocol.ActionType;
import dev.agaminggod.mineagen.server.pov.AgentControlReservations;
import dev.agaminggod.mineagen.server.runtime.ServerActionRequest;
import dev.agaminggod.mineagen.server.runtime.ServerActionResult;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import dev.agaminggod.mineagen.server.runtime.input.InputLease;
import dev.agaminggod.mineagen.server.runtime.input.InputOwner;
import dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.LinkedHashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Optional;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;
import org.slf4j.Logger;
import org.slf4j.LoggerFactory;

/**
 * Runs each agent's model-authored reflex rules every server tick, before actions tick. A firing takes the body through
 * a REFLEX input lease above every action; the agent's running action is paused (not ticked, its input lease kept
 * alive) and resumes when the firing ends, so the program waiting on it continues. Rules come only from the model via
 * the coordinator; nothing here invents one.
 */
public final class ReflexEngine {
	public static final int INPUT_PRIORITY = 400;
	/** Health a firing may lose before it counts as not making progress. */
	static final float HARM_HEALTH = 2.0F;
	/** Agents whose shield stance is held by their own fight this tick (the fight shields between its swings). */
	private static final Set<UUID> FIGHT_SHIELDS = ConcurrentHashMap.newKeySet();
	private static final Logger LOGGER = LoggerFactory.getLogger(ReflexEngine.class);
	/** Reflex actions that move the body away from danger (see the cornered rule in tickAgent). */
	static final Set<String> MOVES_AWAY = Set.of("sprint_away", "take_cover", "step_back");
	/** Conditions naming a hazard the body must leave whatever else it is doing. */
	static final Set<String> HAZARDS = Set.of("creeper_fusing", "fireball_incoming", "in_lava", "in_fire", "air_below", "edge_near",
			"suffocating", "lava_flowing");

	/**
	 * A coordinator default that moves the body away because it is losing (low health), not because of a hazard:
	 * default-retreat and default-cover, never default-creeper. Those are the rules a cornered stand holds back.
	 */
	static boolean backsOffWhenWeaker(ReflexSpec.Rule rule) {
		if (!rule.coordinatorDefault() || !MOVES_AWAY.contains(rule.action().type())) return false;
		boolean weaker = false;
		for (ReflexSpec.Condition condition : rule.when()) {
			if (HAZARDS.contains(condition.type())) return false;
			if ("health_below".equals(condition.type()) && !condition.negated()) weaker = true;
		}
		return weaker;
	}

	/**
	 * Keep a moving retreat through a melee chase. Hunger and low-health cover can turn the body back into the pack, and the
	 * default arrow shield would take the whole firing for a drawn bow: the body stops to block while the pack closes.
	 */
	static boolean chaseGate(ReflexScheduler scheduler, ReflexSpec.Rule rule, boolean truth, boolean fleeingWithChaser) {
		String type = rule.action().type();
		if (!fleeingWithChaser || !rule.coordinatorDefault() || !(backsOffWhenWeaker(rule) || "eat".equals(type) || "shield".equals(type))) return truth;
		scheduler.discardPendingStart(rule.id());
		return false;
	}

	/**
	 * The body walling itself in from a shooter, or standing in the cell its walls closed: the low-health back-off rules
	 * (retreat, cover) and the arrow dodge do not take it there. They ran or stepped it out into the open under the same
	 * shooter, and defend was not there to roof the cell (defend-shallow: all 3 deaths left after #209). Neither does the
	 * arrow shield: a body with a shield walls in from two or more shooters, and a shield firing on each shot would end the
	 * walls half built. Hazard flinches still interrupt. A queued start goes too, as in the other gates.
	 */
	static boolean shelterGate(ReflexScheduler scheduler, ReflexSpec.Rule rule, boolean truth, boolean sheltered) {
		String type = rule.action().type();
		if (!sheltered || !(backsOffWhenWeaker(rule) || "dodge".equals(type) || rule.coordinatorDefault() && "shield".equals(type))) return truth;
		scheduler.discardPendingStart(rule.id());
		return false;
	}

	/** How near a chasing melee mob must be for the retreat's pace check to count it: default-retreat's hostile_near. */
	static final double PACE_RANGE = 6.0D;

	/**
	 * Issue 2 Step 2 (instincts arm): whether a run at {@code bodySpeed} would be caught by any of these chasers' movement
	 * speeds ({@link ReflexActions.Defend#outpaces}). Then default-retreat does not fire: running from a baby zombie (or a spider when
	 * the body cannot sprint) only turns the body's back, and defend and cover still answer the hits.
	 */
	static boolean retreatOutpaced(double bodySpeed, List<Double> chaserSpeeds) {
		for (double speed : chaserSpeeds) if (!ReflexActions.Defend.outpaces(bodySpeed, speed)) return true;
		return false;
	}

	/** {@link #retreatOutpaced} for the coordinator's default-retreat over the melee mobs targeting the body within 6 blocks. */
	static boolean paceHoldsRetreat(ReflexSpec.Rule rule, ServerPlayer player) {
		if (!rule.coordinatorDefault() || !"default-retreat".equals(rule.id())) return false;
		List<Double> speeds = player.level().getEntitiesOfClass(net.minecraft.world.entity.Mob.class, player.getBoundingBox().inflate(PACE_RANGE),
						mob -> mob.isAlive() && mob.getTarget() == player && !(mob instanceof net.minecraft.world.entity.monster.Creeper)
								&& player.distanceTo(mob) <= PACE_RANGE && ReflexActions.packMember(mob, player))
				.stream().map(mob -> mob.getAttributeValue(net.minecraft.world.entity.ai.attributes.Attributes.MOVEMENT_SPEED)).toList();
		return retreatOutpaced(ReflexActions.Defend.runSpeed(player), speeds);
	}

	/**
	 * Actions that are the body's own fight or flight. A defend rule stands aside for them: it does not fire while one runs,
	 * and a defend firing ends on the tick one starts (a program's fight or flee that no model command yielded it to).
	 * Defend covers every other action, as it covers the idle body.
	 */
	static final Set<ActionType> DEFEND_STANDS_ASIDE = Set.copyOf(java.util.EnumSet.of(ActionType.FIGHT_TARGET, ActionType.FIGHT_UNTIL,
			ActionType.USE_RANGED, ActionType.FLEE_FROM));

	static boolean defendStandsAside(ActionType activeType) {
		return activeType != null && DEFEND_STANDS_ASIDE.contains(activeType);
	}

	/**
	 * The commands a run to a perched dragon's head may pause: waits and walks, whose navigation leases sit below the fight's.
	 * A paused key, look, mine or place command keeps its own lease (direct control 250, interaction 300) over the fight's
	 * combat lease (200), so its old keys would drive the body instead of the approach.
	 */
	static final Set<ActionType> STRIKE_TAKES_FROM = Set.copyOf(java.util.EnumSet.of(ActionType.WAIT, ActionType.TRAVEL_TO,
			ActionType.MOVE_TO, ActionType.NAVIGATE_TO));

	/**
	 * A head run whose dragon has lifted off holds on while its fight steps clear (CombatBailout.dragonTakeoff): ended
	 * there, the retreat stopped on its first tick and left the body under the departing dragon's head and wings.
	 */
	static boolean strikeHoldsThroughTakeoff(ReflexSpec.Rule rule, boolean firing, boolean retreating) {
		return firing && retreating && "strike_head".equals(rule.action().type());
	}

	/**
	 * A rule's sensed truth after the engine's gates: defend reads false while the body's own fight or flight runs. The walk
	 * to the fountain takes only an idle or waiting body: a walk, shot or build the model chose is its own call.
	 */
	static boolean gatedTruth(ReflexSpec.Rule rule, boolean truth, ActionType activeType) {
		return gatedTruth(rule, truth, activeType, false);
	}

	/**
	 * As above; {@code escapingShooter}: the body's escape step runs with a shooter in sight. Defend stands aside as it
	 * does for a flee: its melee stance held the body in the open behind a shield while the escape's own walk to cover
	 * (which blocks with the shield itself) waited (skeleton escape room: paused 7 to 30 s of a 30 s window).
	 */
	static boolean gatedTruth(ReflexSpec.Rule rule, boolean truth, ActionType activeType, boolean escapingShooter) {
		// The run to a perched dragon's head stands aside the same way: the body's own fight, shot or flight is its choice.
		return truth && !("defend".equals(rule.action().type()) && (defendStandsAside(activeType) || escapingShooter))
				&& !("strike_head".equals(rule.action().type()) && activeType != null && !STRIKE_TAKES_FROM.contains(activeType))
				&& !("hold_post".equals(rule.action().type()) && activeType != null && activeType != ActionType.WAIT);
	}

	/**
	 * A shield rule that answers shots ({@code incoming_projectile}, not negated) does not take the body from a firing that
	 * blocks shots itself (cover with a shield in hand). Taken, the cover would end and, its shooter still in sight, not
	 * fire again (a pre-empted trigger is not re-armed), leaving the body shielding in the open. A shield for melee keeps
	 * its priority, as cover does not guard against a swing; so does one on {@code fireball_incoming}, which also senses
	 * ghast and dragon fireballs, wither skulls and wind charges that cover does not turn its shield to.
	 */
	static boolean shieldStandsAsideFor(ReflexSpec.Rule rule, boolean firingBlocksShots) {
		return firingBlocksShots && "shield".equals(rule.action().type())
				&& rule.when().stream().anyMatch(condition -> "incoming_projectile".equals(condition.type()) && !condition.negated());
	}

	/**
	 * A dodge stands aside for whatever already moves or guards the body against the shooter: the body's own fight or
	 * flight (as defend does), an escape walking to cover from a shooter, and a firing that runs or hides (take_cover,
	 * sprint_away, defend backing out, walling in or walking to cover). Stepping sideways there would pause the walk to
	 * cover or the run that gets the body out of the shot line for good.
	 */
	static boolean dodgeStandsAside(ReflexSpec.Rule rule, ActionType activeType, boolean escapingShooter, boolean firingMoves) {
		return "dodge".equals(rule.action().type()) && (defendStandsAside(activeType) || escapingShooter || firingMoves);
	}

	/**
	 * A dodge mid-volley gives way to a cover rule that is due (default-cover, default-blaze-cover: priority 6, as the dodge
	 * is, and only a strictly higher priority preempts a firing that has not settled). Marked settled, the firing yields to the
	 * highest ready rule, which is that cover rule or one above it, so a body losing health under a volley goes for cover.
	 */
	static boolean dodgeGivesWayToCover(ReflexActions.Behaviour behaviour, boolean coverReady) {
		return behaviour instanceof ReflexActions.Dodge && coverReady;
	}

	/** Whether the running firing moves or shelters the body itself, so a dodge must not take it (see dodgeStandsAside). */
	static boolean firingMovesBody(ReflexActions.Behaviour behaviour) {
		return behaviour instanceof ReflexActions.TakeCover || behaviour instanceof ReflexActions.SprintAway
				|| behaviour instanceof ReflexActions.Defend defend && defend.movingBody();
	}

	/** Apply the dodge's stand-aside gate, dropping a queued start too (as the shield's gate does). */
	static boolean dodgeGate(ReflexScheduler scheduler, ReflexSpec.Rule rule, boolean truth, ActionType activeType, boolean escapingShooter,
			boolean firingMoves) {
		if (!dodgeStandsAside(rule, activeType, escapingShooter, firingMoves)) return truth;
		scheduler.discardPendingStart(rule.id());
		return false;
	}

	/**
	 * Apply the retreat pace check. Forcing truth false alone leaves a retreat edge queued before the outpacing chaser came
	 * (while a higher-priority firing held the body) to start within its pending window, so the queued start goes too.
	 */
	static boolean paceGate(ReflexScheduler scheduler, ReflexSpec.Rule rule, boolean truth, boolean paceHolds) {
		if (!paceHolds) return truth;
		scheduler.discardPendingStart(rule.id());
		return false;
	}

	/**
	 * Whether the firing that ends hands its reflex input lease straight to {@code next}. Keeping it avoids dropping a
	 * raised shield for a tick and restarting its 5-tick raise, the window a trigger exists to cover. A behaviour that
	 * drives its own navigation (owed-drops collection) gets a released lease instead: the kept one, renewed every tick,
	 * would outrank its navigation leases and hold the body still until the pass timed out.
	 */
	static boolean handsOverLease(ReflexActions.Behaviour next) {
		return next != null && !next.drivesOwnNavigation();
	}

	/**
	 * Owed-drop collection runs only on an idle body. Its edge, queued while a higher-priority firing held the body, would
	 * otherwise start within its pending window after a model command arrived and pause that command for the pass, so a
	 * false condition (the body no longer idle, or nothing owed) drops the queued start.
	 */
	static void owedDropsGate(ReflexScheduler scheduler, ReflexSpec.Rule rule, boolean truth) {
		if (!truth && "collect_drops".equals(rule.action().type())) scheduler.discardPendingStart(rule.id());
	}

	/**
	 * Apply the shield's stand-aside gate. Forcing truth false alone leaves a queued arrow edge (seen during the shield's
	 * cooldown on the tick cover starts) to pre-empt cover once the cooldown ends, so the queued start goes too.
	 */
	static boolean shieldGate(ReflexScheduler scheduler, ReflexSpec.Rule rule, boolean truth, boolean firingBlocksShots) {
		if (!shieldStandsAsideFor(rule, firingBlocksShots)) return truth;
		scheduler.discardPendingStart(rule.id());
		return false;
	}

	/** The running firing's status and detail for the scheduler, after the engine's own exits. */
	record FiringStep(ReflexScheduler.ActionStatus status, String detail) {
	}

	/**
	 * The engine's own exits for a running firing whose behaviour reports {@code status}: defend hands the body to a fight
	 * or flee the tick one starts (not after its release grace, up to 10 s when chased); a firing that only holds on after
	 * reaching its goal ends done at its maxS; an action that yields to a fight ends done under a paused one.
	 */
	static FiringStep firingStep(ReflexSpec.Rule rule, ReflexScheduler.ActionStatus status, String detail, ActionType activeType, boolean settled,
			long elapsedTicks, long maxTicks, boolean yieldsToFight) {
		if (status == ReflexScheduler.ActionStatus.RUNNING && rule != null && ("defend".equals(rule.action().type()) || "dodge".equals(rule.action().type()))
				&& defendStandsAside(activeType)) {
			status = ReflexScheduler.ActionStatus.DONE;
			detail = (detail == null || detail.isEmpty() ? "" : detail + "; ") + "handed to " + activeType.wireName();
		}
		status = ReflexScheduler.settledStatus(status, settled, elapsedTicks, maxTicks);
		if (status == ReflexScheduler.ActionStatus.RUNNING && yieldsToFight && pausedFight(activeType)) status = ReflexScheduler.ActionStatus.DONE;
		return new FiringStep(status, detail);
	}

	/**
	 * A direct model command asks for the body: a held shield that only moves waits to see the command; anything else yields
	 * now (a floor firing in its hazard keeps the body and yields later). Returns the firing it ended, if any.
	 */
	static ReflexScheduler.Decision commandYield(ReflexScheduler scheduler, CommandFollower command, boolean holdsMoving, long now) {
		return command.requestYield(holdsMoving, now) ? yieldTo(scheduler, command, now) : ReflexScheduler.Decision.NONE;
	}

	/** Ends the firing for the model's command; a yielded rule then follows the command (see {@link CommandFollower}). */
	static ReflexScheduler.Decision yieldTo(ReflexScheduler scheduler, CommandFollower command, long now) {
		ReflexScheduler.Decision decision = scheduler.yield(now);
		if (scheduler.anySuppressed()) command.yielded(now);
		return decision;
	}

	/** Coordinator defaults that exist only in the End (the coordinator arms them there; see reflexes.mjs DIMENSION_REFLEXES). */
	static final Set<String> END_DEFAULTS = Set.of("default-breath", "default-end-throw", "default-gaze", "default-ender-water", "default-perch-strike", "default-fountain-post");

	/** The scheduler's End-only rules, blocked while the body is outside the End. */
	static Set<String> endOnlyIds(ReflexScheduler scheduler) {
		Set<String> ids = new LinkedHashSet<>();
		for (String id : scheduler.ids()) if (endOnly(scheduler.rule(id))) ids.add(id);
		return ids;
	}

	/**
	 * One tick with no firing: while a breath run is owed to a waiting command, hold still input on the reflex lease (taken if
	 * needed) and keep it renewed; otherwise release any lease left from the gap. Returns the lease to keep (null: none).
	 */
	static InputLease gapStep(ReflexScheduler scheduler, LeasedServerInputController controller, AgentId agentId, InputLease lease,
			boolean commandActive, float yaw, float pitch, int slot) {
		if (holdsCommandBetweenFirings(scheduler, commandActive)) {
			InputLease held = holdStill(controller, agentId, lease, yaw, pitch, slot);
			controller.renew(agentId);
			return held;
		}
		releaseLease(controller, lease, yaw, pitch, -1);
		return null;
	}

	/** Gives up a reflex lease, its look (and kept hotbar slot, unless -1) carried into the paused leases below it. */
	static void releaseLease(LeasedServerInputController controller, InputLease lease, float yaw, float pitch, int keptSlot) {
		if (lease == null || controller == null) return;
		try {
			controller.rebase(lease, yaw, pitch, keptSlot);
			controller.release(lease);
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// Already revoked by a lifecycle clear.
		}
	}

	/** The reflex lease (taken if needed) holding still input over the body: no forward, strafe, sprint, jump or use. */
	static InputLease holdStill(LeasedServerInputController controller, AgentId agentId, InputLease lease, float yaw, float pitch, int slot) {
		InputLease held = lease != null ? lease : controller.acquire(agentId, InputOwner.REFLEX, INPUT_PRIORITY);
		try {
			controller.apply(held, AgentInputState.idle(yaw, pitch, slot));
		} catch (LeasedServerInputController.StaleInputLeaseException cleared) {
			held = controller.acquire(agentId, InputOwner.REFLEX, INPUT_PRIORITY);
			controller.apply(held, AgentInputState.idle(yaw, pitch, slot));
		}
		return held;
	}

	/** An End-only coordinator default: it neither fires nor keeps running outside the End. */
	static boolean endOnly(ReflexSpec.Rule rule) {
		return rule != null && rule.coordinatorDefault() && END_DEFAULTS.contains(rule.id());
	}

	/**
	 * A command waiting under a floor firing stays paused in the gap between two of its firings (a failed run's cooldown):
	 * one free tick let a paused travel_to step back toward the cloud.
	 */
	static boolean holdsCommandBetweenFirings(ReflexScheduler scheduler, boolean commandActive) {
		return commandActive && scheduler.current() == null && scheduler.holdsWaitingCommand();
	}

	/**
	 * A cornered breath floor gives the body to the running command, whether it asked for the body (a yield request) or was
	 * already running when the cloud came, or was admitted between two firings.
	 */
	static ReflexScheduler.Decision corneredHandBack(ReflexScheduler scheduler, CommandFollower command, boolean commandActive, long now) {
		return commandActive && scheduler.corneredUnyielded() ? yieldTo(scheduler, command, now) : ReflexScheduler.Decision.NONE;
	}

	/** A floor firing kept through a command's yield has just yielded to it: follow the command as a yield does. */
	static void followDeferredYield(ReflexScheduler scheduler, CommandFollower command, long now) {
		if (scheduler.deferredYielded() && scheduler.anySuppressed()) command.yielded(now);
	}

	/** The cast hand manages its own pour and cooling; the separate lava-contact rule still interrupts it. */
	static boolean deferFlowDuringCast(ReflexSpec.Rule rule, ActionType activeType) {
		return activeType == ActionType.CAST_OBSIDIAN && rule.coordinatorDefault() && "default-lava-flow".equals(rule.id());
	}
	private static final Map<MinecraftServer, ReflexEngine> ENGINES = new WeakHashMap<>();

	private final AgentManager manager;
	private final Map<AgentId, AgentReflexes> agents = new LinkedHashMap<>();
	private final Set<AgentId> changed = new LinkedHashSet<>();
	private java.util.function.Predicate<AgentId> actionProbe = ignored -> false;

	private static final class AgentReflexes {
		final ReflexScheduler scheduler = new ReflexScheduler();
		final ReflexSensors.Memory memory = new ReflexSensors.Memory();
		long revision;
		ReflexActions.Behaviour behaviour;
		String detail = "";
		float startHealth;
		InputLease lease;
		LeasedServerInputController controller;
		Map<String, Entity> focus = Map.of();
		Map<String, Vec3> points = Map.of();
		/** What the running firing started on, kept while its condition no longer names it (a turned-to mob). */
		Entity firingFocus;
		Vec3 firingPoint;
		String error;
		final CommandFollower command = new CommandFollower();
		/** The body was falling at the last tick (read on the bridge thread when a command asks for the body). */
		boolean falling;
	}

	/** The agent's own action, as the executor sees it. */
	public interface Body {
		Body NONE = new Body() {
			@Override public ServerActionRequest active(AgentId agentId) { return null; }
			@Override public ServerActionResult last(AgentId agentId) { return null; }
		};

		ServerActionRequest active(AgentId agentId);

		ServerActionResult last(AgentId agentId);
	}

	/** Whether the agent's shield stance is riding on its running fight this tick (read by the fight controller). */
	public static boolean fightHoldsShield(ServerPlayer player) {
		return player != null && FIGHT_SHIELDS.contains(player.getUUID());
	}

	public ReflexEngine(AgentManager manager) {
		this.manager = Objects.requireNonNull(manager, "manager must not be null");
	}

	/** How the engine learns whether an agent has an action running (the {@code stop} action waits for it to end). */
	public synchronized void actionProbe(java.util.function.Predicate<AgentId> probe) {
		actionProbe = Objects.requireNonNull(probe, "probe must not be null");
	}

	public static synchronized ReflexEngine of(MinecraftServer server, AgentManager manager) {
		return ENGINES.computeIfAbsent(Objects.requireNonNull(server, "server must not be null"), ignored -> new ReflexEngine(manager));
	}

	public static synchronized Optional<ReflexEngine> existing(MinecraftServer server) {
		return server == null ? Optional.empty() : Optional.ofNullable(ENGINES.get(server));
	}

	/**
	 * Installs the agent's complete rule set (validated first, so a bad set never replaces a good one). {@code yield}
	 * ends the current firing because a direct model command takes the body.
	 */
	public synchronized void update(AgentId agentId, long revision, JsonArray rules, boolean yield) {
		Objects.requireNonNull(agentId, "agentId must not be null");
		List<ReflexSpec.Rule> parsed = ReflexSpec.parseRules(rules);
		AgentReflexes agent = agents.computeIfAbsent(agentId, ignored -> new AgentReflexes());
		long now = now();
		agent.revision = revision;
		// A held shield composes with a command that only moves; that is decided once the command has started.
		if (yield && !clutching(agent)) end(agentId, agent, commandYield(agent.scheduler, agent.command, holdsMoving(agent), now));
		end(agentId, agent, agent.scheduler.replace(parsed, now));
		changed.add(agentId);
	}

	/** As {@link #update}, but an invalid set is recorded on the agent's status instead of thrown. */
	public synchronized void updateOrReport(AgentId agentId, long revision, JsonArray rules, boolean yield) {
		try {
			update(agentId, revision, rules, yield);
			AgentReflexes agent = agents.get(agentId);
			if (agent != null) agent.error = null;
		} catch (ReflexSpec.InvalidRuleException invalid) {
			AgentReflexes agent = agents.computeIfAbsent(agentId, ignored -> new AgentReflexes());
			agent.error = invalid.getMessage();
			changed.add(agentId);
		}
	}

	/** Coordinator gone: its rules go with it (a reconnecting coordinator re-sends what it still holds). */
	public synchronized void clearAll() {
		for (Map.Entry<AgentId, AgentReflexes> entry : agents.entrySet()) {
			endBehaviour(entry.getKey(), entry.getValue());
			release(entry.getKey(), entry.getValue(), false);
		}
		agents.clear();
	}

	public synchronized void forget(AgentId agentId) {
		AgentReflexes agent = agents.remove(agentId);
		if (agent != null) {
			endBehaviour(agentId, agent);
			release(agentId, agent, false);
		}
	}

	private void endBehaviour(AgentId agentId, AgentReflexes agent) {
		if (agent.behaviour == null) return;
		ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
		if (player != null) agent.behaviour.end(player);
	}

	/** Agents whose status changed since the last call (a firing started or ended, rules replaced). */
	public synchronized Set<AgentId> takeChanged() {
		Set<AgentId> result = Set.copyOf(changed);
		changed.clear();
		return result;
	}

	private void yieldNow(AgentId agentId, AgentReflexes agent, long now) {
		end(agentId, agent, yieldTo(agent.scheduler, agent.command, now));
	}

	private static boolean clutching(AgentReflexes agent) {
		ReflexScheduler.Firing firing = agent.scheduler.current();
		if (firing == null || agent.behaviour == null || !agent.falling) return false;
		ReflexSpec.Rule rule = agent.scheduler.rule(firing.ruleId());
		return rule != null && "place".equals(rule.action().type()) && "below".equals(rule.action().text("where"));
	}

	private static boolean holdsMoving(AgentReflexes agent) {
		return agent.scheduler.current() != null && agent.behaviour != null && agent.behaviour.passesMovement();
	}

	public synchronized Set<AgentId> tick() {
		return tick(Body.NONE);
	}

	/** Advances every agent's rules one tick; returns the agents whose action is paused under a firing this tick. */
	public synchronized Set<AgentId> tick(Body body) {
		FIGHT_SHIELDS.clear();
		if (agents.isEmpty()) return Set.of();
		long now = now();
		Set<AgentId> paused = new LinkedHashSet<>();
		for (Map.Entry<AgentId, AgentReflexes> entry : agents.entrySet()) {
			AgentId agentId = entry.getKey();
			AgentReflexes agent = entry.getValue();
			if (agent.scheduler.isEmpty()) {
				// No rules left (all removed): a still-input lease held between breath runs must not outlive them.
				release(agentId, agent, false);
				continue;
			}
			try {
				if (tickAgent(agentId, agent, now, body)) paused.add(agentId);
			} catch (RuntimeException failure) {
				LOGGER.error("Reflex tick failed for {}", agentId, failure);
				end(agentId, agent, agent.scheduler.interrupt(now, "reflex error"));
			}
		}
		return paused;
	}

	/** Follows the agent's own command (see {@link CommandFollower}). */
	private void followCommand(AgentId agentId, AgentReflexes agent, ServerActionRequest active, Body body, long now) {
		ServerActionResult last = body.last(agentId);
		CommandFollower.Result result = agent.command.observe(agent.scheduler, holdsMoving(agent), active == null ? null : active.actionId(),
				CommandFollower.movesUnderHold(active) ? active.type() : null, last == null ? null : last.actionId(), last == null ? null : last.actionType(),
				last == null ? null : last.reasonCode(), now);
		if (result.handedOff()) changed.add(agentId);
		if (result.yieldNow()) yieldNow(agentId, agent, now);
	}

	/** The agent's paused action is a fight (melee, bow volley or count fight) that handles fire footing itself. */
	static boolean pausedFight(ActionType type) {
		return type == ActionType.FIGHT_TARGET || type == ActionType.FIGHT_UNTIL || type == ActionType.USE_RANGED;
	}

	private static boolean passesThrough(AgentReflexes agent, ServerActionRequest active, Map<String, ReflexScheduler.Sense> senses) {
		return passesThrough(agent.behaviour != null && agent.behaviour.passesMovement(), active != null && CommandFollower.movesUnderHold(active), agent.scheduler, senses);
	}

	/**
	 * A firing that lets a walking command move behind it (a held shield) does not while a breath run is owed: in the breath
	 * cooldown a shield stance composed the command's forward input and resumed it toward the cloud (council R3).
	 */
	static boolean passesThrough(boolean passesMovement, boolean commandMoves, ReflexScheduler scheduler) {
		return passesThrough(passesMovement, commandMoves, scheduler, null);
	}

	/** As above, with this tick's senses (null: the scheduler's last step), read before the scheduler steps on them. */
	static boolean passesThrough(boolean passesMovement, boolean commandMoves, ReflexScheduler scheduler, Map<String, ReflexScheduler.Sense> senses) {
		return passesMovement && commandMoves && !scheduler.holdsWaitingCommand(senses);
	}

	private boolean tickAgent(AgentId agentId, AgentReflexes agent, long now, Body body) {
		ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
		if (player == null || !player.isAlive() || player.isSpectator()) {
			end(agentId, agent, agent.scheduler.interrupt(now, "body unavailable"));
			release(agentId, agent, false);
			return false;
		}
		if (manager.server() != null && AgentControlReservations.isReserved(manager.server(), agentId)) {
			end(agentId, agent, agent.scheduler.interrupt(now, "operator control"));
			release(agentId, agent, false);
			return false;
		}
		agent.memory.observe(player, now);
		agent.falling = !player.onGround() && !player.isInWater() && player.getDeltaMovement().y < -0.1D;
		agent.memory.actionActive(actionProbe.test(agentId));
		ServerActionRequest active = body.active(agentId);
		ActionType activeType = active == null ? null : active.type();
		followCommand(agentId, agent, active, body, now);
		boolean inEnd = player.level().dimension() == net.minecraft.world.level.Level.END;
		// The End's own defaults stop the tick the body leaves the End, before the coordinator's next rule update.
		ReflexScheduler.Firing running = agent.scheduler.current();
		if (running != null && !inEnd && endOnly(agent.scheduler.rule(running.ruleId()))) end(agentId, agent, agent.scheduler.interrupt(now, "left the End"));
		agent.scheduler.blockWhere(inEnd ? null : ReflexEngine::endOnly);
		ObservationVisibility.Frame frame = ObservationVisibility.frame(player.level(), player);
		// A fortress spawner in view is remembered for a blaze fight started later, cover or not (spawner hold).
		if (player.tickCount % 20 == 0) dev.agaminggod.mineagen.server.runtime.controller.ServerSpawnerHoldController.notice(player);
		// A stand inside a flee, or inside an escape whose climb a mob blocked: running or taking cover there only hands
		// the attackers free hits, so the back-off rules wait; hazard flinches still interrupt.
		boolean cornered = active != null && (active.type() == ActionType.FLEE_FROM || active.type() == ActionType.ESCAPE)
				&& dev.agaminggod.mineagen.server.runtime.controller.CorneredStand.standing(player)
				// A blaze spawner hold owns the body for its whole run: its roofed cell is the cover a retreat would look for,
				// it heals there, and rod trips turn back to it when hurt. Running out onto the fortress floor is what kills.
				|| active != null && (active.type() == ActionType.FIGHT_UNTIL || active.type() == ActionType.FIGHT_TARGET)
				&& dev.agaminggod.mineagen.server.runtime.controller.ServerSpawnerHoldController.holding(player);
		boolean fleeing = activeType == ActionType.FLEE_FROM && !cornered
				|| agent.behaviour instanceof ReflexActions.Defend defend && defend.backingOutOfPack();
		boolean fleeingWithChaser = fleeing && ReflexActions.Defend.nearestChaser(player, ReflexActions.PACK_RANGE) < ReflexActions.PACK_RANGE;
		boolean firingBlocksShots = agent.scheduler.current() != null && agent.behaviour != null && agent.behaviour.blocksShots();
		boolean firingMoves = agent.scheduler.current() != null && firingMovesBody(agent.behaviour);
		// Walling in from a shooter, or standing in the cell its walls closed round it: that cell is the cover (shelterGate).
		boolean sheltered = agent.scheduler.current() != null && agent.behaviour instanceof ReflexActions.Defend walling && walling.wallingIn()
				&& ReflexActions.Defend.nearestChaser(player, ReflexActions.PACK_RANGE) >= ReflexActions.PACK_RANGE
				|| ReflexActions.WallIn.sheltered(player);
		// Defend also stands aside while a cast has a cell half done: lava poured and not yet cooled, or its water not yet
		// scooped back. A pause there leaves the lava to flow onto the body or the water to run into the pool (2-3 s at most).
		boolean escapingShooter = activeType == ActionType.ESCAPE && !EscapeMoves.shooters(player).isEmpty()
				|| activeType == ActionType.BUILD && dev.agaminggod.mineagen.server.runtime.controller.ServerBuildController.castCellOpen(player);
		Map<String, ReflexScheduler.Sense> senses = new HashMap<>();
		Map<String, Entity> focus = new HashMap<>();
		Map<String, Vec3> points = new HashMap<>();
		for (ReflexSpec.Rule rule : agent.scheduler.activeRules()) {
			boolean truth = true;
			Entity found = null;
			Vec3 point = null;
			boolean defend = "defend".equals(rule.action().type());
			boolean guards = defend && !defendStandsAside(activeType) && !escapingShooter;
			for (ReflexSpec.Condition condition : rule.when()) {
				ReflexSensors.Reading reading = ReflexSensors.sense(player, condition, frame, agent.memory, now);
				// For defend, "attacked" also reads a melee hit about to land, as it does a shot about to land.
				if (!reading.truth() && guards) reading = ReflexSensors.meleeAboutToLand(player, condition);
				// And a ranged mob beyond reach that drew at the body lately, as a hit from it would.
				if (!reading.truth() && guards) reading = ReflexSensors.drewAt(player, condition, agent.memory);
				if (!reading.truth()) {
					truth = false;
					break;
				}
				if (found == null && reading.focus() != null) found = reading.focus();
				if (point == null && reading.point() != null) point = reading.point();
			}
			// A default rule sleeps while its action needs an item the body does not hold (no shield, no food), so a
			// default shield or eat rule costs nothing and reports no failure until the item is there.
			if (truth && sleepsWithoutItem(rule, ReflexActions.lacks(player, rule.action(), rule.coordinatorDefault()))) truth = false;
			truth = paceGate(agent.scheduler, rule, truth, Instincts.enabled() && paceHoldsRetreat(rule, player));
			if (deferFlowDuringCast(rule, activeType)) {
				truth = false;
				agent.scheduler.discardPendingStart(rule.id());
			}
			boolean until = !rule.until().isEmpty();
			for (ReflexSpec.Condition condition : rule.until()) {
				if (!until) break;
				until = ReflexSensors.sense(player, condition, frame, agent.memory, now).truth();
			}
			truth = gatedTruth(rule, truth, activeType, escapingShooter);
			ReflexScheduler.Firing headRun = agent.scheduler.current();
			if (!truth && (activeType == null || STRIKE_TAKES_FROM.contains(activeType)) && strikeHoldsThroughTakeoff(rule,
					headRun != null && headRun.ruleId().equals(rule.id()), agent.behaviour instanceof ReflexActions.StrikeHead run && run.retreating())) truth = true;
			if (!inEnd && endOnly(rule)) truth = false;
			truth = shieldGate(agent.scheduler, rule, truth, firingBlocksShots);
			truth = dodgeGate(agent.scheduler, rule, truth, activeType, escapingShooter, firingMoves);
			truth = chaseGate(agent.scheduler, rule, truth, fleeingWithChaser);
			truth = shelterGate(agent.scheduler, rule, truth, sheltered);
			owedDropsGate(agent.scheduler, rule, truth);
			// A default "back off when weaker" rule does not pause a flee that has already found no way out and stands its
			// ground: running or taking cover there only hands the attackers free hits (cornered fixture: 4.6 s paused
			// mid-fight). Hazard flinches (a fusing creeper, fire, lava, air, an edge, suffocation) still interrupt it.
			if (truth && cornered && backsOffWhenWeaker(rule)) truth = false;
			if ("brace".equals(rule.action().type())) {
				// A brace rule never fires: while its condition holds, the brink guard walks a shove back in any stance
				// (not only a commanded one), so a hit near an edge during control keys, a program or a firing is undone too.
				if (truth) dev.agaminggod.mineagen.server.runtime.controller.BrinkGuard.braceArmed(player);
				senses.put(rule.id(), new ReflexScheduler.Sense(false, until));
				continue;
			}
			senses.put(rule.id(), new ReflexScheduler.Sense(truth, until));
			if (truth && found != null) focus.put(rule.id(), found);
			if (truth && point != null) points.put(rule.id(), point);
		}
		agent.focus = focus;
		agent.points = points;
		ReflexScheduler.ActionStatus status = ReflexScheduler.ActionStatus.RUNNING;
		ReflexScheduler.Firing firing = agent.scheduler.current();
		if (firing != null && agent.behaviour != null) {
			ReflexSpec.Rule rule = agent.scheduler.rule(firing.ruleId());
			ReflexActions.Step step = agent.behaviour.tick(context(agentId, player, agent, firing.ruleId(), rule, active, senses), state -> apply(agentId, agent, player, state));
			FiringStep exit = firingStep(rule, step.status(), step.detail(), activeType, agent.behaviour.doneAtMaxS(), now - firing.startTick(), firing.maxTicks(),
					agent.behaviour.yieldsToFight());
			status = exit.status();
			agent.detail = withHealth(exit.detail(), agent.startHealth - player.getHealth());
		}
		// A firing that has cost 2+ health is not making progress, whatever its action reports.
		boolean harmed = firing != null && agent.startHealth - player.getHealth() >= HARM_HEALTH;
		boolean coverDue = dodgeGivesWayToCover(agent.behaviour, agent.behaviour instanceof ReflexActions.Dodge && agent.scheduler.anyReady("take_cover", now));
		agent.scheduler.settled(firing != null && agent.behaviour != null && (agent.behaviour.settled() || coverDue));
		ReflexScheduler.Decision decision = agent.scheduler.step(now, senses, status, agent.detail,
				agent.behaviour != null && agent.behaviour.holdsWhileTrue(), harmed,
				agent.behaviour == null ? 0L : agent.behaviour.releaseGraceTicks(), heldBack(player, agent));
		followDeferredYield(agent.scheduler, agent.command, now);
		ReflexActions.Behaviour next = decision.started() == null ? null : ReflexActions.create(agent.scheduler.rule(decision.started()).action());
		end(agentId, agent, decision, handsOverLease(next));
		if (decision.started() != null) {
			ReflexSpec.Rule rule = agent.scheduler.rule(decision.started());
			agent.behaviour = next;
			agent.startHealth = player.getHealth();
			agent.firingFocus = agent.focus.get(rule.id());
			agent.firingPoint = agent.points.get(rule.id());
			ReflexActions.Step step = agent.behaviour.tick(context(agentId, player, agent, rule.id(), rule, active, senses), state -> apply(agentId, agent, player, state));
			agent.detail = step.detail();
			changed.add(agentId);
		}
		end(agentId, agent, corneredHandBack(agent.scheduler, agent.command, active != null, now));
		if (agent.scheduler.current() == null) {
			// Between two breath runs a waiting command stays paused and the reflex lease holds still input, so the command's
			// last forward/sprint/jump does not replay into the cloud; with nothing owed the lease goes.
			if (agent.controller == null && agent.lease == null && !holdsCommandBetweenFirings(agent.scheduler, active != null)) return false;
			if (agent.controller == null) agent.controller = AgentInputRuntime.controller(player);
			agent.lease = gapStep(agent.scheduler, agent.controller, agentId, agent.lease, active != null,
					player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot());
			return agent.lease != null;
		}
		boolean passes = passesThrough(agent, active, senses);
		if (passes && fightShield(player, active) && agent.behaviour.defersToFight()) {
			// The fight raises the shield itself between swings; a reflex lease over it would block every swing.
			FIGHT_SHIELDS.add(player.getUUID());
			release(agentId, agent, false);
		}
		if (agent.controller != null) agent.controller.renew(agentId);
		else AgentInputRuntime.controller(player).renew(agentId);
		return !passes;
	}

	private static Map<String, String> heldBack(ServerPlayer player, AgentReflexes agent) {
		Map<String, String> held = null;
		String breath = null;
		for (ReflexSpec.Rule rule : agent.scheduler.activeRules()) {
			if (!ReflexActions.yieldsToBreath(rule.action())) continue;
			if (breath == null) {
				breath = ReflexSensors.breathShort(player);
				if (breath == null) return Map.of();
			}
			if (held == null) held = new HashMap<>();
			held.put(rule.id(), breath);
		}
		return held == null ? Map.of() : held;
	}

	private static boolean fightShield(ServerPlayer player, ServerActionRequest active) {
		return active != null && (active.type() == ActionType.FIGHT_TARGET || active.type() == ActionType.FIGHT_UNTIL)
				&& player.getOffhandItem().getItem() instanceof net.minecraft.world.item.ShieldItem;
	}

	private ReflexActions.Context context(AgentId agentId, ServerPlayer player, AgentReflexes agent, String ruleId, ReflexSpec.Rule rule, ServerActionRequest active,
			Map<String, ReflexScheduler.Sense> senses) {
		Entity focus = agent.focus.get(ruleId);
		Vec3 point = agent.points.get(ruleId);
		if (focus != null) agent.firingFocus = focus;
		if (point != null) agent.firingPoint = point;
		// While the condition no longer names it (the body turned to face the mob), the firing keeps what it started on.
		if (focus == null && agent.firingFocus != null && agent.firingFocus.isAlive()) focus = agent.firingFocus;
		if (point == null) point = agent.firingPoint;
		boolean passes = passesThrough(agent, active, senses);
		AgentInputState below = null;
		if (passes) {
			LeasedServerInputController controller = agent.controller != null ? agent.controller : AgentInputRuntime.controller(player);
			below = controller.stateBelow(agentId, INPUT_PRIORITY).orElse(null);
		}
		return new ReflexActions.Context(player, focus, rule != null && rule.kind() == ReflexSpec.Kind.STANCE, agent.memory, point,
				below, passes && fightShield(player, active));
	}

	private static String withHealth(String detail, float lost) {
		String base = detail == null ? "" : detail;
		return lost >= 0.5F ? base + (base.isEmpty() ? "" : "; ") + String.format(Locale.ROOT, "lost %.1f health", lost) : base;
	}

	private void apply(AgentId agentId, AgentReflexes agent, ServerPlayer player, AgentInputState state) {
		if (agent.controller == null) agent.controller = AgentInputRuntime.controller(player);
		if (agent.lease == null) agent.lease = agent.controller.acquire(agentId, InputOwner.REFLEX, INPUT_PRIORITY);
		try {
			agent.controller.apply(agent.lease, state);
		} catch (LeasedServerInputController.StaleInputLeaseException cleared) {
			// A lifecycle clear revoked every lease; take a fresh one for the rest of this firing.
			agent.lease = agent.controller.acquire(agentId, InputOwner.REFLEX, INPUT_PRIORITY);
			agent.controller.apply(agent.lease, state);
		}
	}

	private void end(AgentId agentId, AgentReflexes agent, ReflexScheduler.Decision decision) {
		end(agentId, agent, decision, false);
	}

	private void end(AgentId agentId, AgentReflexes agent, ReflexScheduler.Decision decision, boolean handOver) {
		if (decision.ended() == null) return;
		changed.add(agentId);
		endBehaviour(agentId, agent);
		boolean keep = agent.behaviour != null && agent.behaviour.keepsSelection();
		if (!handOver) release(agentId, agent, keep);
		else if (keep) rebase(agentId, agent);
		agent.behaviour = null;
		agent.firingFocus = null;
		agent.firingPoint = null;
		agent.detail = "";
	}

	/** Carries a kept hotbar choice into the paused leases while the reflex lease passes to the next firing. */
	private void rebase(AgentId agentId, AgentReflexes agent) {
		if (agent.lease == null || agent.controller == null) return;
		ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
		if (player == null) return;
		try {
			agent.controller.rebase(agent.lease, player.getYRot(), player.getXRot(), player.getInventory().getSelectedSlot());
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// Already revoked by a lifecycle clear.
		}
	}

	private void release(AgentId agentId, AgentReflexes agent, boolean keepSelection) {
		if (agent.lease == null || agent.controller == null) return;
		ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
		if (player != null) {
			releaseLease(agent.controller, agent.lease, player.getYRot(), player.getXRot(), keepSelection ? player.getInventory().getSelectedSlot() : -1);
		} else {
			try {
				agent.controller.release(agent.lease);
			} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
				// Already revoked by a lifecycle clear.
			}
		}
		agent.lease = null;
	}

	/** One rule as an audit sees it: its state label and the condition types of its {@code when}. */
	public record RuleView(String id, String state, Set<String> when) {
	}

	/** Reflex actions that hold the body on purpose for as long as their danger lasts (a fight, a raised shield, a brace). */
	public static final java.util.Set<String> HOLDING_ACTIONS = java.util.Set.of("defend", "shield", "brace");

	/**
	 * Whether the firing that holds the agent now is a hold the reflex-hold limit leaves alone: a hazard floor or a fight,
	 * shield or brace, which hold for as long as their danger lasts. Anything else (a meal, a pickup) that keeps the body
	 * for minutes is stuck.
	 */
	public synchronized boolean firingHoldsOnPurpose(AgentId agentId) {
		AgentReflexes agent = agents.get(agentId);
		ReflexScheduler.Firing firing = agent == null ? null : agent.scheduler.current();
		if (firing == null) return false;
		for (ReflexSpec.Rule rule : agent.scheduler.activeRules()) {
			if (!rule.id().equals(firing.ruleId())) continue;
			return ReflexScheduler.floor(rule) || HOLDING_ACTIONS.contains(rule.action().type());
		}
		return false;
	}

	/** The id of the rule whose firing holds the agent's body now, or null. */
	public synchronized String firingRule(AgentId agentId) {
		AgentReflexes agent = agents.get(agentId);
		ReflexScheduler.Firing firing = agent == null ? null : agent.scheduler.current();
		return firing == null ? null : firing.ruleId();
	}

	/**
	 * A read-only copy of an agent's rules, current firing and recent events, for server-side audits. {@code generation}
	 * names the scheduler the events came from (0 without one).
	 */
	public record View(List<RuleView> rules, ReflexScheduler.Firing current, List<ReflexScheduler.Event> events, long generation, long nowTick) {
	}

	public synchronized View view(AgentId agentId) {
		AgentReflexes agent = agents.get(agentId);
		long now = now();
		if (agent == null) return new View(List.of(), null, List.of(), 0L, now);
		java.util.ArrayList<RuleView> rows = new java.util.ArrayList<>();
		for (ReflexScheduler.RuleStatus row : agent.scheduler.statuses(now)) {
			ReflexSpec.Rule rule = agent.scheduler.rule(row.id());
			Set<String> when = new LinkedHashSet<>();
			if (rule != null) for (ReflexSpec.Condition condition : rule.when()) if (!condition.negated()) when.add(condition.type());
			rows.add(new RuleView(row.id(), row.state(), Set.copyOf(when)));
		}
		return new View(List.copyOf(rows), agent.scheduler.current(), agent.scheduler.events(), agent.scheduler.generation(), now);
	}

	/** The agent's reflex status for its observation, or null when it has no rules and nothing to report. */
	public synchronized JsonObject status(AgentId agentId) {
		AgentReflexes agent = agents.get(agentId);
		if (agent == null) return null;
		long now = now();
		JsonObject status = new JsonObject();
		status.addProperty("revision", agent.revision);
		ReflexScheduler.Firing firing = agent.scheduler.current();
		if (firing != null) {
			JsonObject current = new JsonObject();
			current.addProperty("id", firing.ruleId());
			current.addProperty("ms", Math.max(0L, now - firing.startTick()) * 50L);
			if (!agent.detail.isEmpty()) current.addProperty("detail", wireDetail(agent.detail));
			status.add("firing", current);
		}
		JsonArray rules = new JsonArray();
		ServerPlayer player = manager.findAgentPlayer(agentId).orElse(null);
		for (ReflexScheduler.RuleStatus row : agent.scheduler.statuses(now)) {
			JsonObject rule = new JsonObject();
			rule.addProperty("id", row.id());
			rule.addProperty("kind", row.kind() == ReflexSpec.Kind.STANCE ? "stance" : "trigger");
			rule.addProperty("state", row.state());
			rule.addProperty("fired", row.fired());
			rule.addProperty("expiresInS", (row.expiresInTicks() + 19L) / 20L);
			if (row.disabledReason() != null) rule.addProperty("disabled", row.disabledReason());
			ReflexSpec.Rule spec = agent.scheduler.rule(row.id());
			String lacks = player == null || spec == null ? null : ReflexActions.lacks(player, spec.action(), spec.coordinatorDefault());
			if (lacks != null) rule.addProperty("lacks", lacks);
			rules.add(rule);
		}
		status.add("rules", rules);
		status.add("events", eventRows(agent.scheduler.events()));
		if (agent.error != null) status.addProperty("error", agent.error.length() > 240 ? agent.error.substring(0, 240) : agent.error);
		return status;
	}

	/** The observation's {@code reflexes.events} rows; server-free so its output can be held to a golden string. */
	static JsonArray eventRows(List<ReflexScheduler.Event> recent) {
		JsonArray events = new JsonArray();
		for (ReflexScheduler.Event event : recent) {
			JsonObject row = new JsonObject();
			row.addProperty("seq", event.sequence());
			row.addProperty("id", event.ruleId());
			row.addProperty("outcome", event.outcome().wire());
			row.addProperty("ms", event.durationTicks() * 50L);
			if (!event.detail().isEmpty()) row.addProperty("detail", wireDetail(event.detail()));
			if (event.wake()) row.addProperty("wake", true);
			events.add(row);
		}
		return events;
	}

	private long now() {
		MinecraftServer server = manager.server();
		return server == null ? 0L : server.getTickCount();
	}

	/** A coordinator default rule whose action lacks its item (ReflexActions.lacks) does not fire; a model rule does. */
	static boolean sleepsWithoutItem(ReflexSpec.Rule rule, String lacks) {
		return rule.sleepsWithoutItem(lacks);
	}

	/** The protocol's limit on a reflex detail (protocol-v2 reflexes.firing.detail and reflexes.events.detail). */
	static final int WIRE_DETAIL_CHARS = 240;

	/**
	 * A detail clipped to {@link #WIRE_DETAIL_CHARS} with an ellipsis, never splitting a surrogate pair. A longer one made
	 * the coordinator reject the whole observation and drop the bridge: in the iron-kit room both agents of a server
	 * lost their coordinator 13 min in, and a body left dead with no coordinator stayed dead for the rest of the round.
	 */
	static String wireDetail(String detail) {
		if (detail.length() <= WIRE_DETAIL_CHARS) return detail;
		int end = WIRE_DETAIL_CHARS - 1;
		if (Character.isHighSurrogate(detail.charAt(end - 1))) end--;
		return detail.substring(0, end) + "\u2026";
	}
}
