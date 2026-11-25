package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.compat.McCompat;

import dev.agaminggod.mineagen.server.runtime.ArmSwing;
import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.LocalPathfinder;
import dev.agaminggod.mineagen.client.navigation.PathNode;
import dev.agaminggod.mineagen.client.navigation.PathPlan;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import dev.agaminggod.mineagen.server.pov.AgentControlReservations;
import dev.agaminggod.mineagen.server.runtime.ElapsedTimeAccumulator;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputStates;
import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import dev.agaminggod.mineagen.server.perception.EntityHitboxSight;
import dev.agaminggod.mineagen.server.perception.RiskAssessment;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashMap;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.util.Mth;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.monster.Creeper;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/**
 * Model-chosen fight_target: selects the best hotbar weapon (visible slot change), turns with the eased
 * player turn, closes to reach, swings only at a full attack charge and steps back briefly after each hit.
 * It ends when the named target dies or is gone. Only when the model opted in (continueWithAttackers:true, or a
 * targetPolicy, which is its own selection rule) does it continue to the next mob already attacking the agent (never a
 * creeper). It also ends at the optional model-chosen fleeAtHealth bail-out, or timeout.
 * The hit itself is the same server call the attack action uses (player.attack + swing).
 *
 * <p>Reachability is checked honestly and early: at the start, when the target moves away from the planned spot and
 * when the approach stalls, a bounded path search (at most once a second, within one combat allowance all fights share
 * per tick) looks for a route to any cell within melee reach of the target, walking, jumping one block and dropping up
 * to three like the path planner. It searches only terrain the player knows: in view now, touched, or seen in the last
 * 10 s as it looked then ({@link dev.agaminggod.mineagen.server.perception.SeenTerrain}). When the whole walkable
 * area was seen and none of it reaches, the fight fails at once (TARGET_UNREACHABLE) with the geometry and the ranged
 * options on both sides. When that area runs on into unseen terrain or past the search box, the approach carries on
 * toward the target until a repeated stall (or 5 s without progress), then returns NO_SEEN_ROUTE with observed
 * melee positions and ranged options. An unchanged zero-hit retry within 5 s returns those prior facts immediately.
 * Without a no-seen-route answer the 5 s clock ends
 * it as APPROACH_BLOCKED, never as unreachable. A check is dropped

 * once the target has a clear hit within reach, and a negative answer is only used while target, terrain and standing area match it.
 * With a route, the approach follows it to the model's target. A stalled approach (no ground gained while pressing forward) reports the refused step, the block in the way and the
 * headroom. Results name any target the model did not name itself (follow-through or policy switch) by uuid.
 *
 * <p>Retargeting stays the model's choice: replaceAction with a new fight_target switches targets and inherits the
 * cancelled fight's weapon slot and swing timing (a short handoff, so the stance carries over), and the optional
 * model-chosen targetPolicy (highest_risk or nearest_attacker) re-evaluates attackers twice a second with
 * hysteresis (see {@link CombatPlanning#policyRetarget}).
 *
 * <p>Follow-through and policy switching only consider mobs. Players (other agents included) are only ever switched to
 * when the model passed includePlayers:true; creative and spectator players never are. A stray sweep, arrow or thorns
 * hit from another player therefore never starts a player fight the model did not choose.
 */
public final class ServerFightController implements ServerController {
	static final double MAX_CHASE_DISTANCE = 32.0D;
	/** No hit landed and no ground gained for this long ends the approach (5 s): NO_SEEN_ROUTE or APPROACH_BLOCKED. */
	static final int UNREACHABLE_TICKS = 100;
	/** A replacement fight_target that starts within 2 s of a cancelled one inherits its weapon and timing. */
	static final long HANDOFF_TICKS = 40L;
	/** Reachability is re-checked at most once a second: a bounded path search, never a per-tick cost. */
	static final long REACH_RECHECK_TICKS = 20L;
	/** A pursuing fight's own shield rises once the target is within reach plus this many blocks. */
	static final double SHIELD_RAISE_MARGIN = 0.5D;
	/** The approach route is replanned once the target has moved this far from where it was planned. */
	static final double REPLAN_TARGET_MOVE = 2.0D;
	/** A negative reachability answer is used only while the target is within this of where it was searched for. */
	static final double STALE_TARGET_MOVE = 0.5D;
	/** Further than this from the next route cell means the body left the route (knockback, a fall). */
	static final double OFF_ROUTE_BLOCKS = 3.0D;
	/** A route cell counts as reached within this horizontal distance of its centre. */
	static final double ROUTE_CELL_REACHED = 0.4D;
	/** The footwork runs within this far beyond the swing's reach; further out the approach walks as before. */
	static final double FOOTWORK_RANGE = 4.0D;
	/** A shot hitting within this is side-stepped (a step takes about half of it). */
	static final double DODGE_SECONDS = 1.0D;
	/** The footwork never jumps with unseen footing or a drop nearer than this (blocks from the body). */
	static final double EDGE_JUMP_CLEARANCE = 2.0D;

	private FightMotion motion;
	private int crits;
	private int sprintHits;
	private int dodges;
	private int brinkTicks;
	private int lipTicks;
	/** Footing missing (or unseen) this near the body makes the footwork step inland first. */
	static final double LIP_REACH = 0.75D;
	private final Set<Integer> dodgingShots = new java.util.HashSet<>();

	private record Handoff(int weaponSlot, int backoffTicks, long gameTime) {
	}

	private static final Map<UUID, Handoff> HANDOFFS = new HashMap<>();
	static final long REPEAT_WINDOW_TICKS = 100L;
	private static final Map<UUID, FailedApproach> FAILED_APPROACHES = new HashMap<>();
	static {
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerEntityEvents.ENTITY_UNLOAD.register((entity, level) -> {
			if (entity instanceof ServerPlayer) FAILED_APPROACHES.remove(entity.getUUID());
		});
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPING.register(server -> FAILED_APPROACHES.clear());
	}

	/** Exact target hitbox: even a change in hover height needs new reach facts. */
	record RetryState(UUID targetId, Vec3 body, AABB targetBox, double range,
			CombatPlanning.TargetPolicy policy, boolean follow, boolean players, float yaw, float pitch, int air, boolean magmaProtected) {
		boolean unchanged(RetryState now, long stopped, long tick, boolean terrainUnchanged, boolean inventoryUnchanged) {
			return tick >= stopped && tick - stopped <= REPEAT_WINDOW_TICKS && targetId.equals(now.targetId)
					&& body.distanceToSqr(now.body) < 1.0E-4D && targetBox.equals(now.targetBox) && range == now.range
					&& policy == now.policy && follow == now.follow && players == now.players && yaw == now.yaw && pitch == now.pitch
					&& SwimPlanning.breathNodes(air) == SwimPlanning.breathNodes(now.air) && magmaProtected == now.magmaProtected
					&& terrainUnchanged && inventoryUnchanged;
		}
	}

	private record FailedApproach(ServerPlayer body, RetryState state, long tick, ReachCheck check,
			List<net.minecraft.world.item.ItemStack> inventory, String facts, String why) { }
	private boolean repeatChecked;
	private ReachCheck lastReach;
	private String reachFacts = "; melee cells: not checked";

	private LivingEntity target;
	/**
	 * What the swings and the approach aim at: the target itself, or the model's chosen part of a multipart mob (the
	 * Ender Dragon is hit through its parts, as a player's crosshair meets them). Life, kills and health stay the mob's.
	 */
	private net.minecraft.world.entity.Entity strike;
	private String targetType;
	/** Null for the model's own target; "follow-through" or the policy name for one the controller switched to. */
	private String switchedBy;
	private final double desiredRange;
	private final Float fleeAtHealth;
	private final boolean continueWithAttackers;
	private final CombatPlanning.TargetPolicy targetPolicy;
	private final boolean includePlayers;
	private CombatBailout bailout;
	private final boolean pursue;
	private final boolean sneak;
	private final boolean shield;
	/**
	 * Run as one engagement of a count fight (fight_until engine): the engine picks every target with the model's
	 * targetPolicy, continueWithAttackers, includePlayers and protection, so this fight never switches on its own.
	 */
	private boolean engineTargets;
	/** The offhand shield broke (or left the offhand) during this fight; the fight goes on without it. */
	private boolean shieldBroke;
	/** shield:true asked with no shield in the offhand at the start; the fight went on unshielded. */
	private boolean shieldMissing;
	private boolean shieldChecked;
	/** Calm neutral mobs this fight's swings hurt besides the target (sword sweeps), "type uuid". */
	private final List<String> neutralHits = new ArrayList<>(4);
	/** Swings held because a calm neutral stood where the sword's sweep would land (a player waits for it to step clear). */
	private int sweepHolds;
	/** Game tick the current run of held swings began, or -1: the hold is capped in game time, not in held swings. */
	private long sweepHoldStart = -1L;
	/** The longest a swing waits for a calm mob to step out of its sweep before it swings anyway (3 s). */
	static final int MAX_SWEEP_HOLD_TICKS = 60;
	private int ticksOnTarget;
	/** The struck dragon part's dragon was seen perching during this fight (its lift-off then ends the melee). */
	private boolean dragonSat;
	private int policyCountdown = CombatPlanning.POLICY_INTERVAL_TICKS;
	private int policySwitches;
	private boolean handoffChecked;
	private final long timeoutMs;
	private final Map<String, Integer> kills = new LinkedHashMap<>();
	private final List<String> drops = new ArrayList<>();
	/** Drops spawn at the body with a small scatter; a kill is noticed the tick after it. */
	static final double DROP_SEARCH_BLOCKS = 1.5D;
	static final int DROP_AGE_TICKS = 5;
	/** A fortress bridge stands about 30 blocks over the lava sea. */
	static final int DROP_FALL_SCAN = 48;
	private int totalHits;
	private final ElapsedTimeAccumulator elapsedTime;
	private final CombatInputLease input = new CombatInputLease();
	private int weaponSlot = -1;
	private int backoffTicks;
	private int hits;
	private final CombatPlanning.ProgressClock clock = new CombatPlanning.ProgressClock();
	private final ServerPathPlanner planner = new ServerPathPlanner();
	private final CombatStallDetector stallDetector = new CombatStallDetector();
	private ReachCheck reachCheck;
	/** Why the last finished check found no route through seen terrain; null when it found one or decided nothing. */
	private String unseenRoute;
	private boolean holdingForReach;
	/** Where the target stood when reachability was last checked (null: check it). */
	private Vec3 reachTargetPosition;
	private long lastReachTick = Long.MIN_VALUE / 2L;
	private boolean recheckRequested;
	/** Contact and breath zones round the struck perched dragon this tick (DragonPerchSafety), or null. */
	private DragonPerchSafety.Zones perchZones;
	private int perchBreathSeen = Integer.MIN_VALUE;
	/** Ticks the body stood in a perched dragon's contact or breath zone and was sent out of it. */
	private int perchUnsafeTicks;
	private List<PathNode> route;
	private boolean keepBlazeRouteLevel;
	/** The spawner hold's defend: its blaze approach stays on the cell's deck (no one-block steps). */
	private boolean holdDeck;
	/** The level a shielded blaze approach is stepping onto (one up or down), until the body lands there; else null. */
	private Integer blazeStepTo;
	/** Route cells a seen lava flow already reached when the route was chosen (the planner paid for them). */
	private Set<GridPosition> routeFlows = Set.of();
	private int routeIndex;
	/** Stalls since the last progress: the first asks for a fresh reachability check, the second ends the fight. */
	private int stalls;
	private final HazardEntry hazard = new HazardEntry();
	/** Set by the model's collect:true: who may take a drop; null leaves drops where they fell. */
	private java.util.function.BiPredicate<ServerPlayer, net.minecraft.world.entity.Entity> collectFilter;
	private KillDropCollector collector;
	private TickResult collectEnd;
	/** collect:false or unset (ExamplePlayer, Oct 29): after the fight, walk to its seen drops only with no hostile within 16 blocks, then back. */
	private java.util.function.BiPredicate<ServerPlayer, net.minecraft.world.entity.Entity> clearFilter;
	private Vec3 clearReturn;
	/**
	 * A kill whose drop the body did not see (it died out of view: above the head after a crit jump, past the shield):
	 * where it died, the tick it died and the result to finish with once the drop look ends. A player knows a blaze drops
	 * its rod where it dies and looks there. Real games (22 Nov checkpoints): a rod lay in view one observation after a
	 * kill whose result said "none from minecraft:blaze", and the bot walked on without it.
	 */
	private Vec3 dropLookAt;
	private long dropLookKillTick, dropLookUntilTick;
	private TickResult dropLookEnd;
	static final int DROP_LOOK_TICKS = 20;
	static final double DROP_LOOK_BLOCKS = 3.0D, DROP_LOOK_BELOW = 8.0D;
	private java.util.function.Predicate<ServerPlayer> mayDrop;
	private ServerNavigationController clearWalk;
	private boolean clearBackUnderFire;
	/** The knockback margin the probe used last; a stall report names what it refused. */
	private CombatPlanning.Margin margin = CombatPlanning.Margin.NONE;
	private CombatPlanning.Refusal routeRefusal;
	private float approachYaw;
	private Vec3 fireExit;
	private int blazeWaitTicks;
	private long lastVisibleTargetTick = Long.MIN_VALUE / 2L;
	/** The last tick this fight saw its target alive; a reflex pause can hide the death tick (1b diagnosis). */
	private long targetAliveTick = Long.MIN_VALUE / 2L;
	private final java.util.Set<UUID> witnessedDrops = new java.util.LinkedHashSet<>();
	private final ObservedProgress observedProgress = new ObservedProgress();

	/** One reachability check in progress, with what it was started from so a stale answer is never used. */
	private static final class ReachCheck {
		final ObservedTerrain view;
		final MeleeReach.ReachCells cells;
		final GridPosition start;
		final GridPosition destination;
		final Vec3 targetPosition;
		final AABB targetBox;
		final int radius;
		MeleeReach.Verdict verdict;
		PathPlan plan;
		final int breathNodes;
		LocalPathfinder.Search search;

		ReachCheck(ObservedTerrain view, MeleeReach.ReachCells cells, GridPosition start, GridPosition destination,
				Vec3 targetPosition, AABB targetBox, int radius, int breathNodes) {
			this.view = view;
			this.cells = cells;
			this.start = start;
			this.destination = destination;
			this.targetPosition = targetPosition;
			this.targetBox = targetBox;
			this.radius = radius;
			this.breathNodes = breathNodes;
		}
	}

	public ServerFightController(LivingEntity target, Double desiredRange, Float fleeAtHealth, long timeoutMs, long startedAt) {
		this(target, desiredRange, fleeAtHealth, false, timeoutMs, startedAt);
	}

	public ServerFightController(LivingEntity target, Double desiredRange, Float fleeAtHealth, boolean continueWithAttackers,
			long timeoutMs, long startedAt) {
		this(target, desiredRange, fleeAtHealth, continueWithAttackers, CombatPlanning.TargetPolicy.NAMED, false, timeoutMs, startedAt);
	}

	public ServerFightController(LivingEntity target, Double desiredRange, Float fleeAtHealth, boolean continueWithAttackers,
			CombatPlanning.TargetPolicy targetPolicy, boolean includePlayers, long timeoutMs, long startedAt) {
		this(target, desiredRange, fleeAtHealth, continueWithAttackers, targetPolicy, includePlayers, true, timeoutMs, startedAt);
	}

	/** pursue:false is the model's choice to aim/swing in place; it applies no movement, including backoff. */
	public ServerFightController(LivingEntity target, Double desiredRange, Float fleeAtHealth, boolean continueWithAttackers,
			CombatPlanning.TargetPolicy targetPolicy, boolean includePlayers, boolean pursue, long timeoutMs, long startedAt) {
		this(target, desiredRange, fleeAtHealth, continueWithAttackers, targetPolicy, includePlayers, pursue, false, false, timeoutMs, startedAt);
	}

	/** The model chooses crouching and offhand shielding between swings; both default to released. */
	public ServerFightController(LivingEntity target, Double desiredRange, Float fleeAtHealth, boolean continueWithAttackers,
			CombatPlanning.TargetPolicy targetPolicy, boolean includePlayers, boolean pursue, boolean sneak, boolean shield,
			long timeoutMs, long startedAt) {
		this.pursue = pursue;
		this.sneak = sneak;
		this.shield = shield;
		this.target = Objects.requireNonNull(target, "target must not be null");
		this.strike = target;
		this.targetPolicy = Objects.requireNonNull(targetPolicy, "targetPolicy must not be null");
		this.includePlayers = includePlayers;
		this.targetType = typeOf(target);
		this.desiredRange = desiredRange == null ? CombatPlanning.DEFAULT_FIGHT_RANGE : desiredRange;
		this.fleeAtHealth = fleeAtHealth;
		this.continueWithAttackers = continueWithAttackers;
		this.timeoutMs = timeoutMs;
		this.elapsedTime = new ElapsedTimeAccumulator(startedAt);
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		long elapsed = elapsedTime.advance(nowEpochMs);
		if (!player.isAlive()) {
			if (collector != null) collector.cancel(player);
			return finish(player, TickResult.failed("AGENT_DEAD", "Agent player died while fighting " + targetType + kills(), progress(player)));
		}
		if (bailout != null) {
			TickResult result = bailout.tick(player, nowEpochMs);
			return result.state() == State.RUNNING ? result : finish(player, bailoutReport(player, result));
		}
		if (collector != null) {
			String hazardStop = hazard.observe(player);
			if (hazardStop != null) {
				collector.cancel(player);
				return finish(player, TickResult.failed(hazardStop, CombatMoveText.hazardStop(hazardStop, player, "fight_target")
						+ kills() + "; collecting drops stopped", 1.0D));
			}
			String blocker = clearReturn == null ? null : KillDropCollector.hostileNear(player);
			String collected = blocker != null ? "stopped, " + blocker : collector.tick(player, nowEpochMs);
			if (collected == null) return TickResult.running(0.99D);
			if (blocker != null) collector.cancel(player);
			collector = null;
			collectEnd = new TickResult(collectEnd.state(), collectEnd.reasonCode(), collectEnd.message() + "; collect: " + collected, collectEnd.progress());
			if (clearReturn == null) return finish(player, collectEnd);
			// A hostile coming near ends the trip, not the walk back to where the model put the body (often a shelter).
			if (blocker != null) clearBackUnderFire = true;
		}
		if (clearWalk != null) {
			if (KillDropCollector.hostileNear(player) != null) clearBackUnderFire = true;
			TickResult walked = clearWalk.tick(player, nowEpochMs);
			if (walked.state() == State.RUNNING) return TickResult.running(0.99D);
			clearWalk.cancel(player);
			clearWalk = null;
			return finish(player, new TickResult(collectEnd.state(), collectEnd.reasonCode(), collectEnd.message()
					+ (walked.state() == State.SUCCEEDED ? (clearBackUnderFire ? "; walked back under fire" : "; walked back") : "; walk back " + walked.reasonCode()), collectEnd.progress()));
		}
		if (clearReturn != null && collectEnd != null) {
			clearWalk = new ServerNavigationController(clearReturn, 0.4D, false, nowEpochMs, 10_000L, false);
			return TickResult.running(0.99D);
		}
		if (dropLookEnd != null) return tickDropLook(player, nowEpochMs);
		boolean blazeFight = target instanceof net.minecraft.world.entity.monster.Blaze;
		boolean blazeWait = blazeFight && (shield && !shieldBroke
				|| dev.agaminggod.mineagen.server.runtime.reflex.ReflexEngine.fightHoldsShield(player)
				|| HazardExits.fireResistant(player));
		// A planned one-block step up or down leaves the deck on purpose: the level hold would stop it at the lip. The hold
		// is let go only on a grounded tick that takes the step (below) and through the airborne ticks after it.
		if (blazeStepTo != null && (!blazeWait || player.onGround())) blazeStepTo = null;
		BrinkGuard.keepLevel(player, this, blazeFight && blazeStepTo == null, blazeWait && blazeStepTo == null);
		keepBlazeRouteLevel = blazeWait;
		String hazardCode = hazard.observe(player);
		if (blazeFight && HazardEntry.ON_FIRE.equals(hazardCode)) hazardCode = null;
		if (hazardCode != null) {
			return finish(player, TickResult.failed(hazardCode, CombatMoveText.hazardStop(hazardCode, player, "fight_target")
					+ kills() + remainingThreats(player), progress(player)));
		}
		if (!handoffChecked) inheritHandoff(player);
		for (UUID id : witnessedDrops) {
			var item = player.level().getEntity(id);
			if (item instanceof net.minecraft.world.entity.item.ItemEntity drop) dev.agaminggod.mineagen.server.perception.ObservedDrops.position(player, drop);
		}
		if (dev.agaminggod.mineagen.server.perception.ObservationVisibility.canSeeEntity(player, target)) lastVisibleTargetTick = player.level().getGameTime();
		boolean killed = target.isDeadOrDying();
		if (!killed && target.isAlive()) targetAliveTick = player.level().getGameTime();
		if (killed || !target.isAlive() || target.isRemoved() || target.level() != player.level()) {
			if (killed) {
				kills.merge(targetType, 1, Integer::sum);
				noteDrops(player, target);
			}
			String ended = killed ? "Killed " + targetType + " with " + hits + " hit(s)" : targetType + " is gone";
			// Follow-through only on the model's opt-in (continueWithAttackers or a targetPolicy); otherwise this fight is over.
			LivingEntity next = continueWithAttackers && !engineTargets ? nextAttacker(player) : null;
			if (next == null) {
				String reasonCode = killed || !kills.isEmpty() ? "TARGET_KILLED" : "TARGET_GONE";
				TickResult end = TickResult.succeeded(reasonCode, ended + kills() + remainingThreats(player));
				if (killed && witnessedDrops.isEmpty() && (collectFilter != null || clearFilter != null)) {
					BrinkGuard.keepLevel(player, this, false);
					input.release();
					dropLookAt = target.position().add(0.0D, target.getBbHeight() * 0.5D, 0.0D);
					dropLookKillTick = player.level().getGameTime();
					dropLookUntilTick = dropLookKillTick + DROP_LOOK_TICKS;
					dropLookEnd = end;
					return TickResult.running(0.99D);
				}
				return afterKill(player, end, nowEpochMs);
			}
			switchTo(next, "follow-through");
			clock.killed();
		}
		if (shield && !shieldBroke && !(player.getOffhandItem().getItem() instanceof net.minecraft.world.item.ShieldItem)) {
			// No shield at the start (it broke on fireballs in an earlier call): fight on unshielded, as after a mid-fight
			// break. Failing here left a caller that repeats shield:true standing idle among blazes (blaze spawner rooms:
			// 7 of 27 deaths on main).
			shieldMissing = !shieldChecked;
			shieldBroke = true;
		}
		shieldChecked = true;
		if (!engineTargets) applyTargetPolicy(player);
		if (blazeFight && !engineTargets) strikeAttackerInReach(player);
		ticksOnTarget++;
		if (strike instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragonPart dragonPart) {
			var phase = dragonPart.parentMob.getPhaseManager().getCurrentPhase();
			if (phase.isSitting()) dragonSat = true;
			// A fight started as it lifts off (it still looks perched for a moment) steps clear too.
			else if (dragonSat || phase.getPhase() == net.minecraft.world.entity.boss.enderdragon.phases.EnderDragonPhase.TAKEOFF) {
				BrinkGuard.keepLevel(player, this, false);
				input.release();
				bailout = CombatBailout.dragonTakeoff(player, dragonPart.parentMob, pursue, timeoutMs - elapsed, nowEpochMs);
				TickResult result = bailout.tick(player, nowEpochMs);
				return result.state() == State.RUNNING ? result : finish(player, bailoutReport(player, result));
			}
		}
		Float flee = lootFlee(player);
		if (CombatPlanning.shouldBailOut(player.getHealth(), flee)) {
			BrinkGuard.keepLevel(player, this, false);
			input.release();
			bailout = CombatBailout.start(player, target, flee, pursue, timeoutMs - elapsed, nowEpochMs);
			TickResult result = bailout.tick(player, nowEpochMs);
			return result.state() == State.RUNNING ? result : finish(player, bailoutReport(player, result));
		}
		if (pursue && !blazeWait && !repeatChecked) {
			repeatChecked = true;
			TickResult repeated = repeatedApproach(player);
			if (repeated != null) return finish(player, repeated);
		}
		double distance = player.distanceTo(strike);
		if (distance > MAX_CHASE_DISTANCE) {
			return finish(player, TickResult.failed("TARGET_ESCAPED", CombatMoveText.geometry(subject(), player, target) + "; beyond chase distance" + kills() + remainingThreats(player), progress(player)));
		}
		if (elapsed >= timeoutMs) {
			return finish(player, TickResult.timedOut("FIGHT_TIMED_OUT", CombatMoveText.geometry(subject(), player, target) + "; hits " + hits + (pursue ? "" : "; pursue=false: no movement input; target must enter clear melee reach")
					+ (holdingForReach ? "; NO_SEEN_ROUTE: held position awaiting melee reach; " + unseenRoute : "")
					+ approachFacts(player) + CombatMoveText.rangedContext(player, target) + kills() + remainingThreats(player), progress(player)));
		}
		Vec3 eye = player.getEyePosition();
		approachYaw = player.getYRot();
		AABB box = strike.getBoundingBox();
		// An enderman is hit in the legs, as players do: a view near its eyes inside 4 blocks is a stare, and vanilla
		// then teleports it away mid-fight. The swing still has to clear the real hitbox.
		AABB aimBox = McCompat.isEnderman(strike) ? box.setMaxY(box.minY + 1.2D) : box;
		var heldRange = player.getAttackRangeWith(player.getMainHandItem());
		boolean inReach = heldRange.isInRange(player, box, 0.0D);
		// Being near a box is not a clear swing. Short, bouncing bodies can expose only their top or near edge.
		double attackRange = inReach ? heldRange.effectiveMaxRange(player) : 0.0D;
		ServerLookController.Angles aim = inReach ? attackPoint(player, eye, aimBox, attackRange) : null;
		if (aim == null && inReach && aimBox != box) aim = attackPoint(player, eye, box, attackRange);
		boolean canHit = inReach && aim != null;
		var perchedDragon = DragonPerchSafety.perched(strike);
		perchZones = perchedDragon == null ? null : DragonPerchSafety.zones(player, perchedDragon);
		if (perchZones != null) {
			// A breath placed or begun moves the safe spots: search again.
			// Where the breath is, not only how many: a predicted cloud replaced by the live one moves the safe spots too.
			int breathKey = perchZones.breath().stream().mapToInt(c -> java.util.Objects.hash(Math.round(c.x()), Math.round(c.y()), Math.round(c.z()))).sum();
			if (breathKey != perchBreathSeen) { perchBreathSeen = breathKey; recheckRequested = true; lastReachTick = Long.MIN_VALUE / 2; }
			// Inside the head, neck, wings or breath (standing, or knocked up into them): no swing from here, walk to a safe spot.
			if (perchZones.unsafe(player.getX(), player.getY(), player.getZ())) {
				if (canHit && player.onGround()) { recheckRequested = true; lastReachTick = Long.MIN_VALUE / 2; }
				canHit = false;
				perchUnsafeTicks++;
			}
		}
		TickResult reachability = pursue ? advanceReach(player, canHit, distance) : null;
		if (reachability != null && !blazeWait) return finish(player, reachability);
		if (canHit) {
			holdingForReach = false;
			unseenRoute = null;
			clock.progressed();
		}
		if (pursue && !blazeWait && clock.observe(distance) >= SwimPlanning.unreachableTicks(
				SwimPlanning.floatJump(player.isInWater(), player.onGround(), player.isUnderWater()), UNREACHABLE_TICKS)) {
			// In water the approach is a swim, which is slower and bobs; it gets a fair (10 s) attempt first. Running out
			// of time proves no route is missing: only a finished check's UNREACHABLE says that.
			String waited = String.format(Locale.ROOT, "No hit or approach for %d seconds%s; ", clock.ticks() / 20,
					player.isInWater() ? " while swimming" : "");
			if (unseenRoute != null) return finish(player, TickResult.failed("NO_SEEN_ROUTE", waited
					+ CombatMoveText.geometry(subject(), player, target) + "; " + unseenRoute + approachFacts(player)
					+ CombatMoveText.rangedContext(player, target) + kills() + remainingThreats(player), progress(player)));
			else return finish(player, TickResult.failed("APPROACH_BLOCKED", waited + CombatMoveText.geometry(subject(), player, target)
					+ approachFacts(player) + CombatMoveText.rangedContext(player, target) + kills() + remainingThreats(player), progress(player)));
		}
		if (HotbarWeapons.needsReselection(weaponSlot,
				weaponSlot < 0 ? 0 : HotbarWeapons.rank(player.getInventory().getItem(weaponSlot)))) {
			// Also after the chosen weapon breaks mid-fight: its slot stays valid but now holds nothing.
			weaponSlot = CombatPlanning.bestWeaponSlot(HotbarWeapons.candidates(player), player.getInventory().getSelectedSlot());
		}

		PathNode waypoint = pursue && !canHit && backoffTicks == 0 ? routeWaypoint(player) : null;
		ServerLookController.Angles goal = (waypoint == null || blazeWait) && aim != null ? aim
				: ServerLookController.anglesTo(eye, waypoint == null || blazeWait ? aimBox.getCenter()
						: new Vec3(waypoint.position().x() + 0.5D, waypoint.position().y() + 1.0D, waypoint.position().z() + 0.5D));
		float yaw = AgentInputStates.turnYaw(player.getYRot(), goal.yaw());
		float pitch = AgentInputStates.turnPitch(player.getXRot(), goal.pitch());
		float yawError = AgentInputStates.shortestAngleDelta(yaw, goal.yaw());
		approachYaw = yaw;
		boolean weaponReady = player.getInventory().getSelectedSlot() == weaponSlot;
		float attackStrength = player.getAttackStrengthScale(0.5F);
		// Aim and collider checks only affect a swing, never movement during cooldown or backoff.
		boolean swingReady = weaponReady && backoffTicks == 0 && attackStrength >= CombatPlanning.READY_ATTACK_STRENGTH;
		// The goal ray was checked this tick; only identical float angles may reuse that result.
		boolean canSwing = swingReady && canHit && (yaw == goal.yaw() && pitch == goal.pitch()
				|| clearSwing(player, eye, yaw, pitch, box, attackRange));
		CombatPlanning.FightStep step = CombatPlanning.fightStep(new CombatPlanning.FightInput(
				distance, desiredRange,
				canHit,
				canSwing,
				canSwing,
				attackStrength,
				weaponReady,
				backoffTicks));
		backoffTicks = step.backoffTicks();
		// The route is the safety check on it (drops of at most three, no hazards) plus the knockback margin for the
		// next step; off it the two-cell probe holds.
		routeRefusal = null;
		boolean inWater = player.isInWater();
		int food = player.getFoodData().getFoodLevel();
		boolean shieldWanted = shield && !shieldBroke || dev.agaminggod.mineagen.server.runtime.reflex.ReflexEngine.fightHoldsShield(player)
				&& player.getOffhandItem().getItem() instanceof net.minecraft.world.item.ShieldItem;
		// By a perched dragon there is no footwork (its sprint hits and spacing walk under the neck): it swings from a safe spot.
		FightMotion.Move footwork = perchZones == null && pursue && (!blazeFight || !shieldWanted) && !holdingForReach && waypoint == null && !inWater && !player.onClimbable()
				&& distance <= heldRange.effectiveMaxRange(player) + FOOTWORK_RANGE
				? footwork(player, yaw, yawError, attackStrength, weaponReady && canHit, shieldWanted, food) : null;
		if (footwork != null) {
			// The footwork paces the swings (spacing, sprint hits, crits) in place of the fixed step back.
			backoffTicks = 0;
			step = new CombatPlanning.FightStep(footwork.forward(), footwork.sprint(), canSwing && footwork.swing(), 0);
		}
		float forward = !pursue || holdingForReach ? 0.0F : footwork != null ? CombatPlanning.alignedForward(footwork.forward(), yawError)
				: waypoint != null && step.forward() > 0.0F ? routeForward(player, waypoint, step.forward(), yawError)
				: safeForward(player, step.forward(), yaw, yawError);
		float strafe = footwork == null ? 0.0F : footwork.strafe();
		if (perchZones != null && forward != 0.0F && !perchZones.unsafe(player.getX(), player.getY(), player.getZ())) {
			// A step (forward, or the step back after a swing) that would carry a safe body into the head, neck, wings or
			// breath is not taken.
			double rad = Math.toRadians(yaw), way = Math.signum(forward) * 0.6D;
			if (perchZones.unsafe(player.getX() - Math.sin(rad) * way, player.getY(), player.getZ() + Math.cos(rad) * way)) forward = 0.0F;
		}
		if (blazeFight) {
			if (blazeWait) {
				// A hovering blaze sinks to the player's level but, seeing the player, never comes nearer (BlazeApproach):
				// walk to a seen spot in reach, this deck or one block up or down, never toward its height.
				backoffTicks = 0;
				if (waypoint != null) {
					// Walk the route sideways or backwards while the shield stays toward the blaze.
					double dx = waypoint.position().x() + 0.5D - player.getX();
					double dz = waypoint.position().z() + 0.5D - player.getZ();
					float moveYaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
					float[] keys = BrinkGuard.keysToward(yaw, dx, dz);
					int feetY = CombatMoveText.feet(player).y();
					boolean levelAhead = waypoint.position().y() == feetY && levelStep(player, moveYaw);
					boolean supported = BlazeApproach.takesStep(feetY, waypoint, levelAhead, blazeStepTo, player.onGround()) && routeForward(player, waypoint, 1.0F, 0.0F) > 0;
					forward = supported ? keys[0] : 0.0F;
					strafe = supported ? keys[1] : 0.0F;
					if (supported && BlazeApproach.levelChange(feetY, waypoint)) {
						blazeStepTo = waypoint.position().y();
						BrinkGuard.keepLevel(player, this, false);
					}
				}
				if ((shieldWanted || footwork == null) && waypoint == null) {
					forward = 0.0F;
					if (pursue && !canHit && CombatMoveText.horizontal(player.position(), strike.getX(), strike.getZ()) > 1.8D
							&& levelStep(player, yaw)) forward = CombatPlanning.alignedForward(1.0F, yawError);
				}
				if (!canHit && forward == 0.0F) {
					blazeWaitTicks++;
					if (pursue && CombatMoveText.horizontal(player.position(), strike.getX(), strike.getZ()) > 1.8D) pitch = AgentInputStates.turnPitch(player.getXRot(), 40.0F);
				}
			}
			if (pursue && !HazardExits.fireResistant(player) && HazardExits.contact(player) == HazardExits.Contact.FIRE) {
				Vec3 exit = fireExit(player);
				if (exit != null) {
					float[] keys = BrinkGuard.keysToward(yaw, exit.x - player.getX(), exit.z - player.getZ());
					forward = keys[0];
					strafe = keys[1];
				}
			} else fireExit = null;
		}
		if (blazeWait && !step.attack() && BrinkGuard.needsFooting(player)) pitch = AgentInputStates.turnPitch(player.getXRot(), 40.0F);
		// Swimming approach: stay afloat (or sink toward a target clearly below) and sprint-swim along the aim while
		// submerged, so the view pitch toward the target steers the swim up or down like a player's.
		boolean blazeStepJump = blazeWait && pursue && BlazeApproach.stepJump(CombatMoveText.feet(player).y(), waypoint,
				forward != 0.0F || strafe != 0.0F, waypoint == null ? Double.MAX_VALUE
						: CombatMoveText.horizontal(player.position(), waypoint.position().x() + 0.5D, waypoint.position().z() + 0.5D),
				player.onGround());
		boolean jump = blazeStepJump || pursue && (!blazeFight || !shieldWanted && footwork != null && footwork.jump()) && (SwimPlanning.fightJump(SwimPlanning.floatJump(inWater, player.onGround(), player.isUnderWater()),
				strike.getY() - player.getY())
				|| (footwork != null && footwork.jump())
				|| (forward > 0.0F && player.onGround() && player.horizontalCollision)
				|| (waypoint != null && forward > 0.0F && MeleeReach.jumpFor(waypoint.traversal(),
						CombatMoveText.horizontal(player.position(), waypoint.position().x() + 0.5D, waypoint.position().z() + 0.5D),
						player.onGround())));
		// By a perched dragon a jump lifts the body into its neck, head or wing boxes (they start about 2 above the
		// ground): only a route's step-up whose top stays clear of them.
		if (jump && perchZones != null && (footwork != null && footwork.jump() || waypoint == null
				|| perchZones.unsafe(player.getX(), player.getY() + DragonPerchSafety.JUMP_RISE, player.getZ()))) jump = false;
		// Sprint follows the movement actually applied: a vanilla client drops it without forward input.
		boolean sprint = (step.sprint() && forward > 0.0F && food > 6)
				|| SwimPlanning.swimSprint(inWater, player.isUnderWater(), forward, food);
		boolean nearTarget = blazeFight || !pursue || canHit
				|| Math.sqrt(box.distanceToSqr(eye)) <= heldRange.effectiveMaxRange(player) + SHIELD_RAISE_MARGIN;
		boolean shielding = shield && !shieldBroke && nearTarget || dev.agaminggod.mineagen.server.runtime.reflex.ReflexEngine.fightHoldsShield(player)
				&& player.getOffhandItem().getItem() instanceof net.minecraft.world.item.ShieldItem;
		Map<LivingEntity, Float> calm = step.attack() ? calmNeutralsBeside(player) : Map.of();
		// A sword sweep hurts calm piglins beside the target and turns the whole group on the body (three of three barter
		// room deaths beside a hoglin): hold the swing until none stands in the sweep, as a player does.
		// Vanilla sweeps only on a charged sword swing from the ground that is neither a sprint hit nor a crit. The sprint
		// counts only when the body is sprinting and this tick's input keeps it so: input that stops the sprint turns the
		// swing into a sweeping one (a barter-room death came that way).
		boolean sprintHit = player.isSprinting() && sprint && !sneak;
		boolean sweepLands = player.getMainHandItem().is(net.minecraft.tags.ItemTags.SWORDS) && player.getAttackStrengthScale(0.5F) > 0.9F
				&& player.onGround() && !sprintHit;
		long gameTime = player.level().getGameTime();
		boolean holdForSweep = holdSwingForSweep(sweepLands, calm.size(), sweepHoldStart < 0 ? 0L : gameTime - sweepHoldStart);
		if (holdForSweep) {
			if (sweepHoldStart < 0) sweepHoldStart = gameTime;
			sweepHolds++;
			// No swing happened, so no post-swing backoff: the next tick may swing as soon as the sweep is clear.
			backoffTicks = 0;
		} else if (step.attack()) sweepHoldStart = -1L;
		// A held swing keeps the shield up: lowering it for a hit that never comes leaves the body open.
		boolean crouch = BlazeApproach.sneakFor(sneak, blazeStepTo != null);
		input.apply(player, new AgentInputState(forward, strafe, jump, crouch, sprint && !crouch, false, shielding && (!step.attack() || holdForSweep),
				yaw, pitch, weaponSlot, shielding ? InteractionHand.OFF_HAND : InteractionHand.MAIN_HAND));
		// The swing is a direct server call, so it must also yield to an operator takeover (whose input lease wins).
		if (step.attack() && !holdForSweep && !player.isUsingItem() && !operatorControlled(player)) {
			if (footwork != null) noteStrike(player);
			player.attack(strike);
			noteNeutralHits(player, calm);
			ArmSwing.attack(player, InteractionHand.MAIN_HAND);
			hits++;
			totalHits++;
			clock.progressed();
			stallDetector.reset();
		}
		TickResult stalled = observeStall(player, pursue && !blazeWait && !holdingForReach && step.forward() > 0.0F && !canHit, yaw);
		if (stalled != null) return finish(player, stalled);
		return TickResult.running(progress(player));
	}

	/** A short step on this level, read only from seen/touched footing. BrinkGuard also catches coasting and shoves. */
	private boolean levelStep(ServerPlayer player, float yaw) {
		ObservedTerrain view = ObservedTerrain.of(player);
		int y = CombatMoveText.feet(player).y();
		double radians = Math.toRadians(yaw);
		for (double d : new double[]{0.25D, 0.5D, 0.75D, 1.0D}) {
			GridPosition at = new GridPosition(Mth.floor(player.getX() - Math.sin(radians) * d), y,
					Mth.floor(player.getZ() + Math.cos(radians) * d));
			if (!view.isStandable(at)) return false;
		}
		return true;
	}

	/** Leave a fire cell without dropping the target-facing shield or choosing a different floor. */
	private Vec3 fireExit(ServerPlayer player) {
		if (fireExit != null && player.position().distanceToSqr(fireExit) > 0.04D) return fireExit;
		fireExit = null;
		Vec3 nearest = null;
		ObservedTerrain view = ObservedTerrain.of(player);
		for (HazardExits.Exit exit : HazardExits.scan(player)) {
			if (exit.up() == 0 && exit.gaps() == 0 && exit.lavaCells() == 0 && !exit.unseen()) {
				Vec3 candidate = new Vec3(exit.x() + 0.5D, exit.y(), exit.z() + 0.5D);
				if (nearest == null) nearest = candidate;
				if (FightingPosition.footingAround(view, candidate.x, candidate.z, exit.y(), 1.5D)) { fireExit = candidate; break; }
			}
		}
		if (fireExit == null) fireExit = nearest;
		return fireExit;
	}

	/**
	 * This tick's footwork (see {@link FightMotion}) from what the player sees and feels: its own recharge, the target's
	 * reach, the footing on each key's side (the flee probe with the knockback margin), a lethal drop behind within a
	 * hit's push and a projectile about to hit that the raised shield does not face.
	 */
	private FightMotion.Move footwork(ServerPlayer player, float yaw, float yawError, float strength, boolean canHit,
			boolean shielding, int food) {
		if (motion == null) motion = new FightMotion(player.getId() * 31 + target.getId());
		ObservedTerrain view = ObservedTerrain.of(player);
		GridPosition feet = CombatMoveText.feet(player);
		margin = CombatMoveText.knockbackMargin(player);
		AABB box = strike.getBoundingBox();
		Vec3 centre = box.getCenter();
		double distance = Math.hypot(centre.x - player.getX(), centre.z - player.getZ());
		double halfWidth = Math.max(0.0D, (box.getXsize() + box.getZsize()) / 4.0D);
		double ourReach = player.getAttackRangeWith(player.getMainHandItem()).effectiveMaxRange(player) + halfWidth;
		boolean part = strike instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragonPart;
		// The dragon's head and neck hurt on contact with their box grown by 1; a mob swings from its box grown by 0.83.
		// Shooters (a bow or crossbow in hand, blazes, ghasts) have no melee to keep out of.
		boolean shooter = target instanceof Mob mob && (mob.isHolding(stack -> stack.getItem() instanceof net.minecraft.world.item.ProjectileWeaponItem)
				|| mob instanceof net.minecraft.world.entity.monster.Blaze || mob instanceof net.minecraft.world.entity.monster.Ghast);
		double mobReach = part ? halfWidth + 1.0D + 0.3D : target instanceof Creeper ? 3.0D
				: target instanceof Mob && !shooter ? FightMotion.meleeReach(halfWidth) : 0.0D;
		float delay = player.getCurrentItemAttackStrengthDelay();
		int ticksToReady = (int) Math.ceil(Math.max(0.0F, FightMotion.READY - strength) * delay);
		float fleeLine = fleeAtHealth == null ? 0.0F : fleeAtHealth;
		boolean lowHealth = player.getHealth() <= Math.max(6.0F, fleeLine + 4.0F);
		boolean headroom = CombatPlanning.open(view, feet.above(2))
				&& FightingPosition.footingAround(view, player.getX(), player.getZ(), feet.y(), EDGE_JUMP_CLEARANCE);
		// Vanilla crits need a living target (a dragon part is not one; Player.canCriticalAttack). Against a mob that
		// closes to melee, the sprint hit's knockback is worth more than x1.5: a crit jump leaves it in contact (live
		// footwork check: three zombies cost 20-24 health with crit jumps, against 14.5-17 standing still). Crits are
		// for targets with no melee or that knockback barely moves.
		boolean critTarget = !part && strike instanceof LivingEntity living && (mobReach == 0.0D
				|| living.getAttributeValue(net.minecraft.world.entity.ai.attributes.Attributes.KNOCKBACK_RESISTANCE) >= 0.5D);
		boolean descending = !player.onGround() && player.fallDistance > 0.0D && player.getDeltaMovement().y < 0.0D;
		float back = yaw + 180.0F;
		boolean behind = FightingPosition.lethalPush(view, player.getX(), player.getZ(), feet.y(), back);
		boolean behindLeft = FightingPosition.lethalPush(view, player.getX(), player.getZ(), feet.y(), yaw - 135.0F);
		boolean behindRight = FightingPosition.lethalPush(view, player.getX(), player.getZ(), feet.y(), yaw + 135.0F);
		int brink = behindLeft && !behindRight ? -1 : behindRight && !behindLeft ? 1 : behind || behindLeft ? 2 : 0;
		int dodge = 0;
		net.minecraft.world.entity.projectile.Projectile shot =
				dev.agaminggod.mineagen.server.runtime.reflex.ReflexSensors.incomingProjectile(player, DODGE_SECONDS);
		if (shot != null) {
			Vec3 velocity = shot.getDeltaMovement();
			Vec3 from = shot.position().subtract(player.position());
			double facing = Math.toDegrees(Math.atan2(-from.x, from.z));
			boolean shieldFaces = shielding && player.isBlocking() && Math.abs(Mth.wrapDegrees(facing - player.getYRot())) <= 60.0D;
			if (!shieldFaces) {
				double length = velocity.horizontalDistance();
				double ux = length < 1.0E-4D ? 0.0D : velocity.x / length, uz = length < 1.0E-4D ? 0.0D : velocity.z / length;
				double rx = -from.x, rz = -from.z, along = rx * ux + rz * uz;
				dodge = FightMotion.dodgeSide(rx - along * ux, rz - along * uz, velocity.x, velocity.z, yaw);
				if (dodge != 0 && !dodgingShots.contains(shot.getId())) {
					dodgingShots.add(shot.getId());
					dodges++;
				}
			}
		}
		boolean canSprint = food > 6 && !sneak && !shielding;
		FightMotion.Move move = motion.step(new FightMotion.Sense(distance, ourReach, mobReach, strength, ticksToReady, canHit,
				player.onGround(), descending, critTarget, headroom, lowHealth, !part && !sneak,
				safeStep(view, player, feet, yaw), safeStep(view, player, feet, back),
				safeStep(view, player, feet, yaw - 90.0F), safeStep(view, player, feet, yaw + 90.0F),
				brink, dodge, canSprint));
		if (brink != 0) brinkTicks++;
		// Within reach of a lip (footing missing or unseen that near): step inland first, as a player under fire does
		// (live footwork check: a body 0.4 from the blaze yard's unseen edge was knocked off by a fireball).
		double[] inland = FightingPosition.inlandFrom(view, player.getX(), player.getZ(), feet.y(), LIP_REACH);
		if (inland != null) {
			float[] keys = BrinkGuard.keysToward(yaw, inland[0], inland[1]);
			double[] heading = BrinkGuard.worldHeading(yaw, keys[0], keys[1]);
			float headingYaw = (float) Math.toDegrees(Math.atan2(-heading[0], heading[1]));
			if (CombatPlanning.canStep(view, feet, headingYaw, CombatPlanning.Margin.NONE)
					|| FightingPosition.footingAhead(view, player.getX(), player.getZ(), feet.y(), headingYaw)) {
				lipTicks++;
				return new FightMotion.Move(keys[0], keys[1], false, false, move.swing(), "stepping off the lip");
			}
		}
		return move;
	}

	/** The flee probe with the knockback margin, plus footing ahead of the body's actual position. */
	private boolean safeStep(ObservedTerrain view, ServerPlayer player, GridPosition feet, float heading) {
		return CombatPlanning.canStep(view, feet, heading, margin)
				&& FightingPosition.footingAhead(view, player.getX(), player.getZ(), feet.y(), heading);
	}

	/** Counts the kind of swing about to land: a falling crit or a sprint hit (vanilla's own conditions). */
	private void noteStrike(ServerPlayer player) {
		if (strike instanceof LivingEntity && player.fallDistance > 0.0D && !player.onGround() && !player.isSprinting()
				&& player.getAttackStrengthScale(0.5F) > 0.9F) crits++;
		else if (player.isSprinting() && player.getAttackStrengthScale(0.5F) > 0.9F) sprintHits++;
	}

	private String footworkFacts() {
		if (crits == 0 && sprintHits == 0 && dodges == 0 && brinkTicks == 0 && lipTicks == 0) return "";
		StringBuilder text = new StringBuilder("; footwork: ");
		text.append(crits).append(" falling crit(s), ").append(sprintHits).append(" sprint hit(s), dodged ").append(dodges).append(" shot(s)");
		if (brinkTicks > 0) text.append(String.format(Locale.ROOT, ", %.1f s circling off a drop behind", brinkTicks / 20.0D));
		if (lipTicks > 0) text.append(String.format(Locale.ROOT, ", %.1f s stepping off a lip", lipTicks / 20.0D));
		return text.toString();
	}

	/**
	 * Approach and step-back only move while facing the target (forward scaled by the remaining turn) and only
	 * onto safe footing: the same two-cell probe flee uses, so a fight on a ravine edge or beside lava holds
	 * position instead of walking off or across it. With a mob within knockback range it also keeps a margin
	 * from lava and damaging drops beside the next cell and under the edge the body overhangs.
	 */
	private float safeForward(ServerPlayer player, float forward, float yaw, float yawError) {
		float aligned = CombatPlanning.alignedForward(forward, yawError);
		if (aligned == 0.0F) return 0.0F;
		float moveYaw = aligned > 0.0F ? yaw : yaw + 180.0F;
		margin = CombatMoveText.knockbackMargin(player);
		return CombatPlanning.canStep(ObservedTerrain.of(player), CombatMoveText.feet(player), moveYaw, margin)
				? aligned : 0.0F;
	}

	/**
	 * Forward along the planned route, held while a mob within knockback range makes the next step pass lava or a
	 * damaging drop (body overhang or beside the next cell). Legal gap jumps stay legal. A held step that stalls ends
	 * the fight as APPROACH_BLOCKED naming the refused cell, so the model decides how to take that risk.
	 */
	private float routeForward(ServerPlayer player, PathNode waypoint, float forward, float yawError) {
		float aligned = CombatPlanning.alignedForward(forward, yawError);
		margin = CombatMoveText.knockbackMargin(player);
		if (!margin.active()) return aligned;
		routeRefusal = CombatPlanning.routeMarginRefusal(ObservedTerrain.of(player), CombatMoveText.feet(player),
				waypoint.position(), waypoint.traversal(), margin);
		return routeRefusal == null ? aligned : 0.0F;
	}

	public ServerFightController strikingPart(net.minecraft.world.entity.boss.enderdragon.EnderDragonPart part) {
		if (part.parentMob != target) throw new IllegalArgumentException("part must belong to the fight target");
		this.strike = part;
		return this;
	}

	/**
	 * Starts, advances and reads the reachability check, all of it (the view, the reach cells, the search and checking
	 * the answer still holds) within the tick's one shared combat allowance. Returns a TARGET_UNREACHABLE or
	 * NO_SEEN_ROUTE result when the fight should end there, otherwise null.
	 */
	private TickResult advanceReach(ServerPlayer player, boolean inReach, double distance) {
		if (inReach) {
			// In reach now: a check still running was searched for where the target used to be.
			reachCheck = null;
			return null;
		}
		if (reachCheck != null && strike.position().distanceTo(reachCheck.targetPosition) > REPLAN_TARGET_MOVE) reachCheck = null;
		if (reachCheck == null && !reachDue(player)) return null;
		ServerPathPlanner.TickBudget budget = ServerPathPlanner.currentBudget();
		if (budget == null) {
			try (ServerPathPlanner.TickScope scope = ServerPathPlanner.beginServerTick()) {
				return checkReach(player, distance, scope.budget());
			}
		}
		return checkReach(player, distance, budget);
	}

	private TickResult checkReach(ServerPlayer player, double distance, ServerPathPlanner.TickBudget budget) {
		// Spent by fights earlier in this tick's (rotating) order: carry on next tick, where the order has moved on.
		if (budget.combatNanosLeft() <= 0L) return null;
		try (ServerPathPlanner.CombatSlice slice = budget.combatSlice()) {
			if (reachCheck == null && !startReachCheck(player, distance)) return null;
			ReachCheck check = reachCheck;
			try {
				return resumeReach(player, slice, budget);
			} finally {
				check.view.endSlice();
			}
		}
	}

	private boolean reachDue(ServerPlayer player) {
		boolean due = reachTargetPosition == null || recheckRequested
				|| (lastReach != null && lastReach.cells.reach() != player.getAttackRangeWith(player.getMainHandItem()).effectiveMaxRange(player))
				|| strike.position().distanceTo(reachTargetPosition) > REPLAN_TARGET_MOVE;
		if (!due || player.level().getGameTime() - lastReachTick < REACH_RECHECK_TICKS) return false;
		// Mid-jump or falling the feet cell is ambiguous; judge on landing.
		return player.onGround() || player.isInWater() || player.onClimbable();
	}

	private boolean startReachCheck(ServerPlayer player, double distance) {
		if (!dev.agaminggod.mineagen.server.perception.ObservationVisibility.canSeeEntity(player, strike)) return false;
		lastReachTick = player.level().getGameTime();
		reachTargetPosition = strike.position();
		recheckRequested = false;
		ObservedTerrain view = ObservedTerrain.forCheck(player).withContactCost(visibleWingCost(player));
		if (keepBlazeRouteLevel) view.onLevel(CombatMoveText.feet(player).y(), BlazeApproach.levelBand(holdDeck));
		GridPosition start = standingCell(view, player.position());
		if (start == null) return false;
		AABB box = strike.getBoundingBox();
		double range = player.getAttackRangeWith(player.getMainHandItem()).effectiveMaxRange(player);
		MeleeReach.ReachCells cells = reachCells(player, view, box, range, perchZones);
		reachCheck = new ReachCheck(view, cells, start, new GridPosition(Mth.floor(strike.getX()), Mth.floor(strike.getY()),
				Mth.floor(strike.getZ())), strike.position(), box, MeleeReach.searchRadius(distance),
				SwimPlanning.breathNodes(player.getAirSupply()));
		return true;
	}

	/** A route to a named dragon part goes round wings the player sees, instead of repeatedly being thrown away. */
	private java.util.function.ToIntFunction<GridPosition> visibleWingCost(ServerPlayer player) {
		if (!(strike instanceof net.minecraft.world.entity.boss.enderdragon.EnderDragonPart named)) return null;
		// Perched: every contact and breath zone, seen or not (it sits in plain view on the fountain).
		DragonPerchSafety.Zones perch = perchZones;
		if (perch != null) return cell -> perch.unsafeCell(cell) ? 200 : 0;
		List<AABB> contacts = new ArrayList<>();
		for (var part : named.parentMob.getSubEntities()) {
			if (!part.name.contains("wing") || !dev.agaminggod.mineagen.server.perception.ObservationVisibility.canSeeEntity(player, part)) continue;
			// Vanilla tests the wing box grown by 4 horizontally and 2 vertically, shifted down 2. Include our body.
			AABB box = part.getBoundingBox().inflate(4.0D, 2.0D, 4.0D).move(0.0D, -2.0D, 0.0D);
			contacts.add(new AABB(box.minX - 0.3D, box.minY - player.getBbHeight(), box.minZ - 0.3D,
					box.maxX + 0.3D, box.maxY, box.maxZ + 0.3D));
		}
		if (contacts.isEmpty()) return null;
		return cell -> {
			for (AABB box : contacts) if (box.contains(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D)) return 200;
			return 0;
		};
	}

	private static MeleeReach.ReachCells reachCells(ServerPlayer player, ObservedTerrain view, AABB box, double range,
			DragonPerchSafety.Zones perch) {
		AcquiredGeometry geometry = new AcquiredGeometry(player.level(), pos -> view.stateAt(new GridPosition(pos.getX(), pos.getY(), pos.getZ())));
		double minimum = player.getAttackRangeWith(player.getMainHandItem()).effectiveMinRange(player)
				- player.getAttackRangeWith(player.getMainHandItem()).hitboxMargin();
		return new MeleeReach.ReachCells(box.minX, box.minY, box.minZ, box.maxX, box.maxY, box.maxZ, range,
				// knownHit may be null (an unseen hit line): passed through as unknown, never unboxed.
				cell -> perch != null && perch.unsafeCell(cell) ? Boolean.FALSE : MeleeReach.knownHit(cell, box, Math.max(0, minimum), range, geometry));
	}

	private TickResult resumeReach(ServerPlayer player, ServerPathPlanner.CombatSlice slice, ServerPathPlanner.TickBudget budget) {
		ReachCheck check = reachCheck;
		// Cells not read yet are read through this tick's eyes; cells already read keep their value for this check.
		check.view.rebind(ObservedTerrain.known(player));
		check.view.beginSlice();
		if (check.search == null) {
			if (!check.cells.advance(check.view, () -> !slice.over() && budget.tryPrepare())) return null;
			Set<GridPosition> goals = check.cells.cells();
			if (goals.isEmpty()) {
				// No known spot in reach. A spot whose footing is unknown may still be one: that is not "unreachable".
				boolean unseen = check.cells.undetermined() > 0;
				return conclude(player, check, unseen ? MeleeReach.Verdict.UNSEEN : MeleeReach.Verdict.UNREACHABLE, null,
						unseen ? "no seen spot to stand within reach of it; the ground round it is out of sight"
								: "no spot to stand within reach of it");
			}
			check.search = planner.beginSearch(check.start, goals, check.destination, check.radius, Set.of(), check.breathNodes);
		}
		ServerPathPlanner.PlanningResult planning = planner.resume(check.search, check.view, slice::over);
		if (planning.deferred()) return null;
		boolean unseen = check.view.openUnknown();
		boolean edge = check.search.boundaryReached();
		MeleeReach.Verdict verdict = MeleeReach.verdict(planning.plan(), check.search.finished(), check.search.retainedNodes(),
				check.cells.cells(), edge, unseen);
		String why = verdict == MeleeReach.Verdict.UNREACHABLE
				? "no walkable route within " + check.radius + " blocks to a spot within reach"
				: "no route through seen terrain to a spot within reach; one may continue "
						+ (unseen ? "out of sight" : "") + (unseen && edge ? " or " : "")
						+ (edge ? "past " + check.radius + " blocks" : "");
		return conclude(player, check, verdict, planning.plan(), why);
	}

	private TickResult conclude(ServerPlayer player, ReachCheck check, MeleeReach.Verdict verdict, PathPlan plan, String why) {
		reachCheck = null;
		lastReach = check;
		check.verdict = verdict;
		check.plan = plan;
		reachFacts = describeReach(player, check, verdict, plan);
		switch (verdict) {
			case REACHABLE -> {
				List<PathNode> nodes = plan.nodes();
				route = nodes.size() > 1 ? nodes : null;
				routeFlows = route == null ? Set.of() : ServerNavigationController.lavaContacts(ObservedTerrain.of(player), route);
				routeIndex = 1;
				stallDetector.reset();
				unseenRoute = null;
				holdingForReach = false;
				clock.progressed();
				return null;
			}
			case UNKNOWN -> {
				route = null;
				unseenRoute = null;
				holdingForReach = false;
				clock.progressed();
				return null;
			}
			default -> {
			}
		}
		// A negative answer holds only for the target spot, terrain and standing area it was searched from.
		if (!stillHolds(player, check)) {
			recheckRequested = true;
			return null;
		}
		route = null;
		if (verdict == MeleeReach.Verdict.UNREACHABLE) return unreachable(player, why);
		unseenRoute = why;
		// The approach already stalled once and a fresh check still finds no seen route: that is the answer now.
		if (stalls > 0) holdingForReach = true;
		return null;
	}

	/**
	 * Target spot, standing area and what the player knows of the cells the check read are as they were: a negative
	 * answer still applies.
	 */
	private boolean stillHolds(ServerPlayer player, ReachCheck check) {
		if (strike.position().distanceTo(check.targetPosition) > STALE_TARGET_MOVE || !check.view.unchanged()) return false;
		GridPosition now = standingCell(check.view, player.position());
		return now != null && (now.equals(check.start) || (check.search != null && check.search.explored(now)));
	}

	private TickResult unreachable(ServerPlayer player, String why) {
		return TickResult.failed("TARGET_UNREACHABLE", CombatMoveText.geometry(subject(), player, target) + "; " + why
				+ " (fight_target walks, jumps 1, drops up to 3)" + CombatMoveText.rangedContext(player, target)
				+ kills() + remainingThreats(player), progress(player));
	}

	private static GridPosition standingCell(WalkabilityView world, Vec3 position) {
		GridPosition origin = new GridPosition(Mth.floor(position.x), Mth.floor(position.y + 0.2D), Mth.floor(position.z));
		int[][] offsets = {{0, 0, 0}, {0, -1, 0}, {0, 1, 0}, {1, 0, 0}, {-1, 0, 0}, {0, 0, 1}, {0, 0, -1}};
		for (int[] offset : offsets) {
			GridPosition candidate = origin.offset(offset[0], offset[1], offset[2]);
			if (world.isTraversable(candidate)) return candidate;
		}
		return null;
	}

	/**
	 * The next cell of the approach route, advancing past cells already reached (each one is progress). Drops the
	 * route and asks for a fresh check when the body left it, the cell stopped being walkable, or it ran out.
	 */
	private PathNode routeWaypoint(ServerPlayer player) {
		if (route == null) return null;
		if (player.onGround()) {
			int occupied = MeleeReach.occupiedNode(route, routeIndex, CombatMoveText.feet(player));
			if (occupied >= routeIndex) {
				routeIndex = occupied + 1;
				clock.progressed();
			}
		}
		if (ServerNavigationController.lavaReachesRouteAhead(ObservedTerrain.of(player), route, routeIndex, routeFlows)) {
			route = null;
			recheckRequested = true;
			lastReachTick = Long.MIN_VALUE / 2L;
			return null;
		}
		while (routeIndex < route.size()) {
			PathNode node = route.get(routeIndex);
			double horizontal = CombatMoveText.horizontal(player.position(), node.position().x() + 0.5D, node.position().z() + 0.5D);
			if (horizontal < ROUTE_CELL_REACHED && Math.abs(player.getY() - node.position().y()) < 1.0D) {
				routeIndex++;
				clock.progressed();
				continue;
			}
			if (horizontal > OFF_ROUTE_BLOCKS || !ObservedTerrain.of(player).isTraversable(node.position())) break;
			return node;
		}
		route = null;
		recheckRequested = true;
		return null;
	}

	/**
	 * Watches a wanted approach for net progress. The first stall since the last progress asks for a fresh
	 * reachability check (whose answer may be "unreachable", which ends the fight there); a second one ends it as
	 * APPROACH_BLOCKED with the refused step, the block in the way and the headroom.
	 */
	private TickResult observeStall(ServerPlayer player, boolean approaching, float yaw) {
		if (clock.ticks() == 0) stalls = 0;
		CombatStallDetector.Stall stall = stallDetector.observe(player.getX(), player.getY(), player.getZ(),
				player.onGround() || player.isInWater() || player.onClimbable(), approaching,
				player.horizontalCollision && player.onGround(), player.verticalCollision && !player.onGround());
		if (stall == null) return null;
		stallDetector.reset();
		// Held by the knockback margin on the route: rechecking finds the same route, so report the refusal now.
		if (++stalls == 1 && routeRefusal == null) {
			route = null;
			recheckRequested = true;
			lastReachTick = Long.MIN_VALUE / 2L;
			return null;
		}
		if (routeRefusal == null && unseenRoute != null) {
			return TickResult.failed("NO_SEEN_ROUTE", "Approach stalled; " + unseenRoute + approachFacts(player)
					+ CombatMoveText.rangedContext(player, target) + kills() + remainingThreats(player), progress(player));
		}
		return TickResult.failed("APPROACH_BLOCKED", "Approach stalled: "
				+ CombatMoveText.stall(player, ObservedTerrain.of(player), yaw, stall, margin, routeRefusal) + "; "

				+ CombatMoveText.geometry(subject(), player, target) + CombatMoveText.rangedContext(player, target)
				+ kills() + remainingThreats(player), progress(player));
	}

	/**
	 * Next attacker after the target dies: the nearest one (never a creeper), or under highest_risk the riskiest.
	 * Players count only while they are actively attacking the agent.
	 */
	private LivingEntity nextAttacker(ServerPlayer player) {
		List<LivingEntity> hostiles = nearbyHostiles(player);
		if (targetPolicy != CombatPlanning.TargetPolicy.NAMED) {
			int index = CombatPlanning.policyRetarget(targetPolicy, null, policyCandidates(player, hostiles), 0);
			return index < 0 ? null : hostiles.get(index);
		}
		List<CombatPlanning.AttackerCandidate> candidates = new ArrayList<>(hostiles.size());
		for (LivingEntity hostile : hostiles) {
			candidates.add(new CombatPlanning.AttackerCandidate(player.distanceTo(hostile), attacking(player, hostile),
					player.getLastHurtByMob() == hostile, hostile instanceof Creeper));
		}
		int index = CombatPlanning.nextAttacker(candidates);
		return index < 0 ? null : hostiles.get(index);
	}

	/** The model-chosen live policy: every half second, switch only to a clearly better attacker. */
	private void applyTargetPolicy(ServerPlayer player) {
		if (targetPolicy == CombatPlanning.TargetPolicy.NAMED || --policyCountdown > 0) return;
		policyCountdown = CombatPlanning.POLICY_INTERVAL_TICKS;
		List<LivingEntity> hostiles = nearbyHostiles(player);
		if (hostiles.isEmpty()) return;
		RiskAssessment.Assessment current = RiskAssessment.assess(player, target);
		int index = CombatPlanning.policyRetarget(targetPolicy, new CombatPlanning.PolicyCandidate(player.distanceTo(strike),
				current.risk(), true, target instanceof Creeper), policyCandidates(player, hostiles), ticksOnTarget);
		if (index < 0) return;
		policySwitches++;
		switchTo(hostiles.get(index), targetPolicy.wireName());
		// The fight-level clock keeps running: alternating between unreachable attackers must not restart it.
		clock.switched(player.distanceTo(strike));
	}

	/**
	 * A blaze fight holding the deck for a hovering target while another attacker hits from inside sword reach (live d41
	 * platform runs, batch 4: the named blaze hovered 3.6 blocks off while a second punched from 0.6 blocks until the body
	 * died): a player swings at the one in reach. The fight then names that attacker; its result says so.
	 */
	private void strikeAttackerInReach(ServerPlayer player) {
		if (strike != target) return;
		var range = player.getAttackRangeWith(player.getMainHandItem());
		if (range.isInRange(player, target.getBoundingBox(), 0.0D)) return;
		LivingEntity best = null;
		double bestDistance = Double.MAX_VALUE;
		for (LivingEntity hostile : nearbyHostiles(player)) {
			if (!attacking(player, hostile) || !range.isInRange(player, hostile.getBoundingBox(), 0.0D)) continue;
			if (!dev.agaminggod.mineagen.server.perception.ObservationVisibility.canSeeEntity(player, hostile)) continue;
			double distance = player.distanceToSqr(hostile);
			if (distance < bestDistance) { bestDistance = distance; best = hostile; }
		}
		if (best == null) return;
		switchTo(best, "in-reach attacker");
		clock.switched(player.distanceTo(strike));
	}

	private List<CombatPlanning.PolicyCandidate> policyCandidates(ServerPlayer player, List<LivingEntity> hostiles) {
		List<CombatPlanning.PolicyCandidate> candidates = new ArrayList<>(hostiles.size());
		for (LivingEntity hostile : hostiles) {
			candidates.add(new CombatPlanning.PolicyCandidate(player.distanceTo(hostile), RiskAssessment.assess(player, hostile).risk(),
					attacking(player, hostile), hostile instanceof Creeper));
		}
		return candidates;
	}

	private static boolean attacking(ServerPlayer player, LivingEntity hostile) {
		return (hostile instanceof Mob mob && mob.getTarget() == player) || player.getLastHurtByMob() == hostile
				|| RiskAssessment.attackedRecently(player, hostile);
	}

	/**
	 * Candidates for follow-through and policy switches: hostile mobs and creatures actively attacking the agent.
	 * Players only when the model opted in with includePlayers (never creative or spectator players).
	 */
	private List<LivingEntity> nearbyHostiles(ServerPlayer player) {
		return player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(CombatPlanning.THREAT_RANGE),
				entity -> entity != target && entity != player && switchable(entity, includePlayers)
						&& ThreatPerception.isActiveThreat(player, entity));
	}

	/** Pure gate: a player is only a follow-through or policy candidate when the model opted in. */
	static boolean switchable(LivingEntity entity, boolean includePlayers) {
		return CombatPlanning.switchableKind(entity instanceof net.minecraft.world.entity.player.Player, includePlayers);
	}

	private void inheritHandoff(ServerPlayer player) {
		handoffChecked = true;
		Handoff handoff;
		synchronized (HANDOFFS) {
			handoff = HANDOFFS.remove(player.getUUID());
		}
		long now = player.level().getGameTime();
		if (handoff == null || handoff.gameTime() > now || now - handoff.gameTime() > HANDOFF_TICKS) return;
		if (handoff.weaponSlot() >= 0 && HotbarWeapons.rank(player.getInventory().getItem(handoff.weaponSlot())) > 0) {
			weaponSlot = handoff.weaponSlot();
		}
		backoffTicks = handoff.backoffTicks();
	}

	private void switchTo(LivingEntity next, String reason) {
		target = next;
		lastVisibleTargetTick = Long.MIN_VALUE / 2L;
		targetAliveTick = Long.MIN_VALUE / 2L;
		strike = next;
		targetType = typeOf(next);
		switchedBy = reason;
		hits = 0;
		backoffTicks = 0;
		ticksOnTarget = 0;
		reachCheck = null;
		unseenRoute = null;
		holdingForReach = false;
		reachTargetPosition = null;
		lastReach = null;
		reachFacts = "; melee cells: not checked";
		route = null;
		stallDetector.reset();
		stalls = 0;
	}

	/** The target as results name it: one the model did not name itself carries its uuid and why it was chosen. */
	private String subject() {
		return switchedBy == null ? targetType : targetType + " " + target.getUUID() + " (" + switchedBy + ")";
	}

	/** "; kills: 2x minecraft:zombie (7 hits)" once anything died, so every result reports the whole fight. */
	/**
	 * Calm neutral mobs (zombified piglins, endermen, piglins...) where a sword sweep from this swing lands: within a block
	 * of the struck box and 3 of the player (Player.doSweepAttack). Health before the swing tells which the swing hurt.
	 */
	private Map<LivingEntity, Float> calmNeutralsBeside(ServerPlayer player) {
		Map<LivingEntity, Float> calm = new java.util.IdentityHashMap<>();
		for (LivingEntity mob : player.level().getEntitiesOfClass(LivingEntity.class, strike.getBoundingBox().inflate(1.0D, 0.25D, 1.0D),
				e -> e != target && e != strike && e.isAlive() && player.distanceToSqr(e) < 9.0D
						&& (e instanceof net.minecraft.world.entity.NeutralMob || e instanceof net.minecraft.world.entity.monster.piglin.AbstractPiglin)
						&& !(e instanceof Mob m && m.getTarget() == player))) {
			calm.put(mob, mob.getHealth());
		}
		return calm;
	}

	/**
	 * True when a sword swing now would sweep a calm neutral: the swing waits for it to step clear, for at most
	 * MAX_SWEEP_HOLD_TICKS in a row, so a fight in a crowd of calm mobs still lands its hits.
	 */
	public static boolean holdSwingForSweep(boolean sweepLands, int calmNeutralsInSweep, long heldTicks) {
		return sweepLands && calmNeutralsInSweep > 0 && heldTicks < MAX_SWEEP_HOLD_TICKS;
	}

	/** Names each calm neutral the swing hurt (its sweep): a hurt zombified piglin angers every one within 35 blocks. */
	private void noteNeutralHits(ServerPlayer player, Map<LivingEntity, Float> calm) {
		for (Map.Entry<LivingEntity, Float> entry : calm.entrySet()) {
			LivingEntity mob = entry.getKey();
			if (mob.getHealth() >= entry.getValue() || neutralHits.size() >= 4) continue;
			String text = typeOf(mob) + " " + mob.getUUID();
			if (!neutralHits.contains(text)) neutralHits.add(text);
		}
	}

	private String kills() {
		String extra = (blazeWaitTicks == 0 ? "" : String.format(Locale.ROOT, "; held deck awaiting blaze reach %.1f s", blazeWaitTicks / 20.0D)) + footworkFacts() + (shieldMissing ? "; no shield in the offhand (shield:true), fought unshielded" : shieldBroke ? "; offhand shield broke mid-fight, fought on unshielded" : "")
				+ (sweepHolds == 0 ? "" : String.format(Locale.ROOT, "; held the sword on %d ready swings while a calm neutral stood in its sweep", sweepHolds))
				+ (neutralHits.isEmpty() ? "" : "; your sword sweep also hit calm " + String.join(", ", neutralHits)
						+ " (now hostile; a hurt zombified piglin angers all within 35 blocks)");
		if (kills.isEmpty()) return extra;
		StringBuilder text = new StringBuilder("; kills: ");
		int written = 0;
		for (Map.Entry<String, Integer> entry : kills.entrySet()) {
			if (written++ > 0) text.append(", ");
			text.append(entry.getValue()).append("x ").append(entry.getKey());
		}
		text.append(" (").append(totalHits).append(" hits)");
		if (!drops.isEmpty()) text.append("; drops seen: ").append(String.join(", ", drops));
		return text.append(extra).toString();
	}

	/** The fight is over: walk to its witnessed drops as the model's collect choice says, or finish. */
	private TickResult afterKill(ServerPlayer player, TickResult end, long nowEpochMs) {
		if (collectFilter != null && !witnessedDrops.isEmpty()) {
			// collect:true: the fight is over; walk to what it dropped by pick_up_item's own route.
			BrinkGuard.keepLevel(player, this, false);
			input.release();
			collectEnd = end;
			collector = new KillDropCollector(witnessedDrops, collectFilter, nowEpochMs).crouched(sneak).makingRoom(mayDrop);
			return TickResult.running(0.99D);
		}
		if (collectFilter == null && clearFilter != null && !witnessedDrops.isEmpty()) {
			String blocker = KillDropCollector.hostileNear(player);
			if (blocker != null) return finish(player, new TickResult(end.state(), end.reasonCode(), end.message() + "; collect:false: left "
					+ witnessedDrops.size() + " seen drop(s), " + blocker + " (within " + (int) KillDropCollector.CLEAR_RANGE + ")", end.progress()));
			BrinkGuard.keepLevel(player, this, false);
			input.release();
			collectEnd = new TickResult(end.state(), end.reasonCode(), end.message() + "; collect:false: no hostile within "
					+ (int) KillDropCollector.CLEAR_RANGE + " blocks, walked out for the drops", end.progress());
			clearReturn = player.position();
			collector = new KillDropCollector(witnessedDrops, clearFilter, nowEpochMs).makingRoom(mayDrop);
			return TickResult.running(0.99D);
		}
		return finish(player, collectFilter == null ? end
				: new TickResult(end.state(), end.reasonCode(), end.message() + "; collect: no drop was seen to collect", end.progress()));
	}

	/**
	 * The drop look ({@link #dropLookAt}): turn toward where the target died, then down under it where its drop falls,
	 * for {@link #DROP_LOOK_TICKS}; a drop of the kill's age now seen there is witnessed and collected as one seen at the kill.
	 */
	private TickResult tickDropLook(ServerPlayer player, long nowEpochMs) {
		// Lava entered during the look (knockback off the deck after the kill) ends it, as in the fight itself.
		String hazardCode = hazard.observe(player);
		if (HazardEntry.IN_LAVA.equals(hazardCode)) {
			dropLookEnd = null;
			return finish(player, TickResult.failed(hazardCode, CombatMoveText.hazardStop(hazardCode, player, "fight_target") + kills(), progress(player)));
		}
		long tick = player.level().getGameTime();
		dev.agaminggod.mineagen.server.perception.ObservationVisibility.Frame sight =
				dev.agaminggod.mineagen.server.perception.ObservationVisibility.frame(player.level(), player);
		int maxAge = (int) Math.min(80L, DROP_AGE_TICKS + Math.max(0L, tick - dropLookKillTick));
		net.minecraft.world.phys.AABB area = new net.minecraft.world.phys.AABB(dropLookAt.x - DROP_LOOK_BLOCKS, dropLookAt.y - DROP_LOOK_BELOW,
				dropLookAt.z - DROP_LOOK_BLOCKS, dropLookAt.x + DROP_LOOK_BLOCKS, dropLookAt.y + 2.0D, dropLookAt.z + DROP_LOOK_BLOCKS);
		List<String> seen = new ArrayList<>();
		for (net.minecraft.world.entity.item.ItemEntity item : player.level().getEntitiesOfClass(net.minecraft.world.entity.item.ItemEntity.class, area,
				item -> item.isAlive() && !item.getItem().isEmpty() && item.getAge() <= maxAge)) {
			if (witnessedDrops.contains(item.getUUID()) || !sight.canSeeEntity(item)) continue;
			dev.agaminggod.mineagen.server.perception.ObservedDrops.remember(player, item, dev.agaminggod.mineagen.server.perception.ObservedDrops.Source.KILL);
			witnessedDrops.add(item.getUUID());
			net.minecraft.core.BlockPos at = item.blockPosition();
			seen.add(item.getItem().getCount() + "x " + BuiltInRegistries.ITEM.getKey(item.getItem().getItem()) + " at " + at.getX() + "," + at.getY() + "," + at.getZ()
					+ " uuid=" + item.getUUID() + burnsBelow(player, item.position()));
		}
		if (!seen.isEmpty() || tick >= dropLookUntilTick) {
			TickResult end = dropLookEnd;
			dropLookEnd = null;
			String note = seen.isEmpty() ? "; drop look: turned to where it died, saw no drop" : "; drop look: saw " + String.join(", ", seen);
			return afterKill(player, new TickResult(end.state(), end.reasonCode(), end.message() + note, end.progress()), nowEpochMs);
		}
		// First where it died, then the ground under it: a drop falls from there.
		double down = tick - dropLookKillTick < DROP_LOOK_TICKS / 2 ? 0.0D : 2.0D;
		ServerLookController.turnToward(player, dropLookAt.subtract(0.0D, down, 0.0D));
		return TickResult.running(0.99D);
	}

	/**
	 * What a kill dropped, as the player watching it sees it: the items that just appeared at the body, and whether
	 * one is falling into lava or fire, where it burns (a blaze shot down over a lava room loses its rod). Loot rolls
	 * can drop nothing (a blaze rod is 0-1 per player kill), which reads as "none from" the mob.
	 */
	private void noteDrops(ServerPlayer player, LivingEntity dead) {
		dev.agaminggod.mineagen.server.perception.ObservationVisibility.Frame sight =
				dev.agaminggod.mineagen.server.perception.ObservationVisibility.frame(player.level(), player);
		List<String> seen = new ArrayList<>();
		int maxAge = dropAgeLimit(player.level().getGameTime(), targetAliveTick);
		for (net.minecraft.world.entity.item.ItemEntity item : player.level().getEntitiesOfClass(net.minecraft.world.entity.item.ItemEntity.class,
				dead.getBoundingBox().inflate(DROP_SEARCH_BLOCKS), item -> item.isAlive() && !item.getItem().isEmpty() && item.getAge() <= maxAge)) {
			boolean witnessed = player.level().getGameTime() - lastVisibleTargetTick <= 2L && sight.hasLineOfSight(item);
			if (!sight.canSeeEntity(item) && !witnessed) continue;
			dev.agaminggod.mineagen.server.perception.ObservedDrops.remember(player, item, dev.agaminggod.mineagen.server.perception.ObservedDrops.Source.KILL);
			witnessedDrops.add(item.getUUID());
			net.minecraft.core.BlockPos at = item.blockPosition();
			seen.add(item.getItem().getCount() + "x " + BuiltInRegistries.ITEM.getKey(item.getItem().getItem())
					+ " at " + at.getX() + "," + at.getY() + "," + at.getZ() + " uuid=" + item.getUUID() + " (falling, last seen)" + burnsBelow(player, item.position()));
		}
		drops.add(seen.isEmpty() ? "none from " + typeOf(dead) : String.join(", ", seen));
	}

	/**
	 * How old a drop at the corpse may be and still be this kill's: {@link #DROP_AGE_TICKS}, plus the ticks since the
	 * fight last saw the target alive. A reflex pause (default-defend took the body while the target died) delays the
	 * fight's next look, and a fixed 5-tick age then dropped the kill's own loot as old (rounds 4-6: 8 "none from" in
	 * paused kills against 4.6 expected from loot rolls). Capped at 3 s, so a long pause does not pass off older items
	 * at the corpse (blast debris, thrown junk) as its loot; unknown (died before the first look) keeps 5.
	 */
	static int dropAgeLimit(long now, long aliveTick) {
		if (aliveTick < 0L || now < aliveTick) return DROP_AGE_TICKS;
		return (int) Math.min(60L, DROP_AGE_TICKS + (now - aliveTick));
	}

	/** " (over lava N below: burns)" when the drop falls into lava or fire before any solid footing; otherwise "". */
	static String burnsBelow(ServerPlayer player, Vec3 position) {
		net.minecraft.core.BlockPos.MutableBlockPos cell = net.minecraft.core.BlockPos.containing(position).mutable();
		int minY = player.level().getMinY();
		for (int depth = 0; depth <= DROP_FALL_SCAN && cell.getY() >= minY; depth++, cell.move(net.minecraft.core.Direction.DOWN)) {
			net.minecraft.world.level.block.state.BlockState state = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player).known(cell.getX(), cell.getY(), cell.getZ());
			if (state == null) return " (landing out of view)";
			boolean burning = state.getFluidState().is(net.minecraft.tags.FluidTags.LAVA) || state.is(net.minecraft.tags.BlockTags.FIRE);
			if (burning) return depth == 0 ? " (in " + (state.getFluidState().isEmpty() ? "fire" : "lava") + ": burns)"
					: " (over " + (state.getFluidState().isEmpty() ? "fire" : "lava") + " " + depth + " below: burns)";
			if (!state.getCollisionShape(player.level(), cell).isEmpty()) return "";
		}
		return "";
	}

	/** Sensed hostiles still around (creepers included), nearest first, so the model can choose what is next. */
	private String remainingThreats(ServerPlayer player) {
		String switches = policySwitches == 0 ? "" : "; " + targetPolicy.wireName() + " switched target " + policySwitches + "x";
		List<LivingEntity> remaining = new ArrayList<>();
		// Reported to the model even when they are not switch candidates: it can still choose to fight them.
		for (LivingEntity hostile : player.level().getEntitiesOfClass(LivingEntity.class,
				player.getBoundingBox().inflate(CombatPlanning.THREAT_RANGE),
				entity -> entity != target && entity != player && ThreatPerception.isActiveThreat(player, entity))) {
			if (ThreatPerception.isSensedThreat(player, hostile)) remaining.add(hostile);
		}
		if (remaining.isEmpty()) return switches + (continueWithAttackers ? "; no other attackers" : "");
		// Highest risk first, the same order as the threats observation, so the model can pick what is next.
		remaining.sort(Comparator.comparingDouble((LivingEntity hostile) -> RiskAssessment.assess(player, hostile).risk()).reversed());
		StringBuilder text = new StringBuilder(switches).append("; remaining threats: ");
		for (int index = 0; index < Math.min(4, remaining.size()); index++) {
			LivingEntity hostile = remaining.get(index);
			if (index > 0) text.append(", ");
			text.append(typeOf(hostile)).append(' ').append(hostile.getUUID())
					.append(String.format(Locale.ROOT, " at %.1f blocks, risk %.0f", player.distanceTo(hostile),
							RiskAssessment.assess(player, hostile).risk()));
			if (hostile instanceof Creeper creeper && creeper.getSwellDir() > 0) text.append(" (swelling)");
		}
		if (remaining.size() > 4) text.append(" and ").append(remaining.size() - 4).append(" more");
		return text.toString();
	}

	private static String typeOf(LivingEntity entity) {
		return BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
	}

	private static boolean operatorControlled(ServerPlayer player) {
		return AgentInputRuntime.findAgentId(player)
				.map(agentId -> AgentControlReservations.isReserved(player.level().getServer(), agentId))
				.orElse(false);
	}

	private String approachFacts(ServerPlayer player) {
		CombatPlanning.Refusal refusal = routeRefusal != null ? routeRefusal
				: CombatPlanning.refusal(ObservedTerrain.of(player), CombatMoveText.feet(player), approachYaw, margin);
		return (refusal == null ? "" : "; approach: " + CombatMoveText.refusal(player, refusal))
				+ "; headroom " + CombatMoveText.headroom(player, CombatMoveText.feet(player));
	}

	private RetryState retryState(ServerPlayer player) {
		return new RetryState(target.getUUID(), player.position(), strike.getBoundingBox(),
				player.getAttackRangeWith(player.getMainHandItem()).effectiveMaxRange(player), targetPolicy, continueWithAttackers, includePlayers, player.getYRot(), player.getXRot(), player.getAirSupply(), MinecraftNavigationWorld.magmaProtected(player));
	}

	private static List<net.minecraft.world.item.ItemStack> inventory(ServerPlayer player) {
		List<net.minecraft.world.item.ItemStack> items = new ArrayList<>();
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) items.add(player.getInventory().getItem(slot).copy());
		items.add(player.getMainHandItem().copy());
		items.add(player.getOffhandItem().copy());
		return items;
	}

	private TickResult repeatedApproach(ServerPlayer player) {
		FailedApproach previous = FAILED_APPROACHES.remove(player.getUUID());
		if (previous == null || previous.body != player
				|| !dev.agaminggod.mineagen.server.perception.ObservationVisibility.canSeeEntity(player, strike)) return null;
		previous.check.view.rebind(ObservedTerrain.known(player));
		previous.check.view.beginSlice();
		List<net.minecraft.world.item.ItemStack> items = inventory(player);
		boolean sameItems = items.size() == previous.inventory.size();
		for (int i = 0; sameItems && i < items.size(); i++) sameItems = net.minecraft.world.item.ItemStack.matches(items.get(i), previous.inventory.get(i));
		if (!previous.state.unchanged(retryState(player), previous.tick, player.level().getGameTime(), previous.check.view.unchanged(), sameItems)) return null;
		// Keep the original expiry: repeated calls cannot indefinitely extend a stale answer.
		FAILED_APPROACHES.put(player.getUUID(), previous);
		return TickResult.failed("NO_SEEN_ROUTE", "Unchanged unreachable approach (prior check "
				+ (player.level().getGameTime() - previous.tick) / 20.0D + "s ago): " + previous.why + previous.facts
				+ CombatMoveText.rangedContext(player, target), progress(player));
	}

	private boolean reachFactsCurrent(ServerPlayer player) {
		if (lastReach == null) return false;
		lastReach.view.rebind(ObservedTerrain.known(player));
		lastReach.view.beginSlice();
		return strike.getBoundingBox().equals(lastReach.targetBox)
				&& lastReach.cells.reach() == player.getAttackRangeWith(player.getMainHandItem()).effectiveMaxRange(player)
				&& stillHolds(player, lastReach);
	}

	private String currentReachFacts(ServerPlayer player) {
		if (lastReach == null) return reachFacts;
		if (!dev.agaminggod.mineagen.server.perception.ObservationVisibility.canSeeEntity(player, strike)) return "; melee cells: target out of view";
		if (reachFactsCurrent(player)) return lastReach.verdict == null ? reachFacts
				: describeReach(player, lastReach, lastReach.verdict, lastReach.plan);
		// A hovering target can move less than the approach's replan threshold. Refresh the small reach box once
		// at the stop so reported positions fit its current height, rather than repeating obsolete positions.
		ObservedTerrain view = ObservedTerrain.of(player);
		AABB box = strike.getBoundingBox();
		MeleeReach.ReachCells cells = reachCells(player, view, box,
				player.getAttackRangeWith(player.getMainHandItem()).effectiveMaxRange(player), perchZones);
		cells.advance(view, () -> true);
		ReachCheck fresh = new ReachCheck(view, cells, CombatMoveText.feet(player), CombatMoveText.feet(player),
				strike.position(), box, 0, 0);
		return describeReach(player, fresh, MeleeReach.Verdict.UNKNOWN, null);
	}

	private String verticalFacts(ServerPlayer player) {
		if (!dev.agaminggod.mineagen.server.perception.ObservationVisibility.canSeeEntity(player, strike)) return "; target airborne/vertical reach unknown";
		double eye = player.getEyeY();
		AABB box = strike.getBoundingBox();
		double gap = Math.max(Math.max(box.minY - eye, 0), eye - box.maxY);
		double range = player.getAttackRangeWith(player.getMainHandItem()).effectiveMaxRange(player);
		return String.format(Locale.ROOT, "; target airborne=%s, verticalGap=%.1fm, outOfVerticalReach=%s", !strike.onGround(), gap, gap > range);
	}

	private String describeReach(ServerPlayer player, ReachCheck check, MeleeReach.Verdict verdict, PathPlan plan) {
		StringBuilder text = new StringBuilder("; observed melee cells (clear hit line; remembered terrain; paths from " + FightFacts.location(check.start) + "): ");
		var nearest = check.cells.cells().stream().filter(check.view::isStandable)
				.sorted(Comparator.<GridPosition>comparingDouble(cell -> FightFacts.distance(player.position(), cell)).thenComparingInt(GridPosition::x)
						.thenComparingInt(GridPosition::y).thenComparingInt(GridPosition::z)).limit(3).toList();
		if (nearest.isEmpty()) return text.append("none; uncertain cells=").append(check.cells.undetermined()).toString();
		for (GridPosition cell : nearest) {
			boolean onPath = plan != null && plan.nodes().stream().anyMatch(node -> node.position().equals(cell));
			String path = onPath || cell.equals(check.start) ? "available" : verdict == MeleeReach.Verdict.UNREACHABLE
					? "no_route" : verdict == MeleeReach.Verdict.UNSEEN ? "no_seen_route" : "unknown";
			text.append(String.format(Locale.ROOT, "%s %.1fm path=%s; ", FightFacts.location(cell), FightFacts.distance(player.position(), cell), path));
		}
		text.setLength(text.length() - 2);
		return text.toString();
	}

	private static ServerLookController.Angles attackPoint(ServerPlayer player, Vec3 eye, AABB box, double range) {
		Vec3 point = dev.agaminggod.mineagen.server.runtime.TargetSightline.entity(player.level(), CollisionContext.of(player), eye, box, range);
		return point == null ? null : ServerLookController.anglesTo(eye, point);
	}

	private static boolean clearSwing(ServerPlayer player, Vec3 eye, float yaw, float pitch, AABB box, double range) {
		return EntityHitboxSight.clearRay(player.level(), CollisionContext.of(player), eye, yaw, pitch, box, range);
	}

	/** True when the eased view intersects the real hitbox within the held weapon's vanilla reach. */
	static boolean aimed(Vec3 eye, float yaw, float pitch, AABB box, double range) {
		Vec3 look = Vec3.directionFromRotation(pitch, yaw);
		return box.contains(eye) || box.clip(eye, eye.add(look.scale(range))).isPresent();
	}

	private double progress(ServerPlayer player) {
		return observedProgress.update(target.getUUID(), target.getHealth(), () -> {
			if (!dev.agaminggod.mineagen.server.perception.ObservationVisibility.canSeeEntity(player, strike)) return Double.NaN;
			float max = target.getMaxHealth();
			return max > 0.0F ? 1.0D - target.getHealth() / max : 0.0D;
		});
	}

	/** Damage progress retains the last visible sample; hidden health changes cannot alter the result. */
	static final class ObservedProgress {
		private UUID targetId;
		private float sampledHealth = Float.NaN;
		private double value;

		double update(UUID id, float health, java.util.function.DoubleSupplier visibleValue) {
			if (!id.equals(targetId)) {
				targetId = id;
				sampledHealth = Float.NaN;
				value = 0.0D;
			}
			if (health != sampledHealth) {
				sampledHealth = health;
				double seen = visibleValue.getAsDouble();
				if (Double.isFinite(seen)) value = Math.max(0.0D, Math.min(0.99D, seen));
			}
			return value;
		}
	}

	private TickResult bailoutReport(ServerPlayer player, TickResult result) {
		Float flee = lootFlee(player);
		String raised = flee != null && !flee.equals(fleeAtHealth)
				? String.format(java.util.Locale.ROOT, "; backed out at half health (fleeAtHealth %.1f raised to %.1f while holding a blaze rod; 0 fights on)", fleeAtHealth, flee) : "";
		return new TickResult(result.state(), result.reasonCode(), result.message() + raised + kills() + remainingThreats(player), progress(player));
	}

	private TickResult finish(ServerPlayer player, TickResult result) {
		if (bailout != null) bailout.cancel(player);
		String currentCells = currentReachFacts(player);
		if (totalHits == 0 && lastReach != null && reachFactsCurrent(player)
				&& (result.reasonCode().equals("NO_SEEN_ROUTE") || result.reasonCode().equals("TARGET_UNREACHABLE")
						|| (result.state() == State.TIMED_OUT && unseenRoute != null))) {
			FAILED_APPROACHES.put(player.getUUID(), new FailedApproach(player, retryState(player), player.level().getGameTime(),
					lastReach, inventory(player), currentCells, unseenRoute == null ? "TARGET_UNREACHABLE" : unseenRoute));
		}
		BrinkGuard.keepLevel(player, this, false);
		input.release();
		String cells = result.message().contains("Unchanged unreachable approach") ? "" : currentCells;
		return new TickResult(result.state(), result.reasonCode(), (bailout == null ? "body idle; no retreat performed" : "body idle; bailout phase ended") + CombatMoveText.supportFacts(player)
				+ "; " + result.message() + witnessedDrops.stream().map(id -> "; drop: " + dev.agaminggod.mineagen.server.perception.ObservedDrops.describe(player, id)).collect(java.util.stream.Collectors.joining()) + cells + bodyAfterStop(player), result.progress());
	}

	/** The model's collect:true: after the kill, walk to its witnessed drops (null filter: leave them). */
	public ServerFightController collectDrops(java.util.function.BiPredicate<ServerPlayer, net.minecraft.world.entity.Entity> mayTake) {
		this.collectFilter = mayTake;
		return this;
	}

	/** Who may Q-drop junk so a drop fits (1b); null leaves a drop the inventory has no room for. */
	public ServerFightController makingRoom(java.util.function.Predicate<ServerPlayer> mayDrop) {
		this.mayDrop = mayDrop;
		return this;
	}

	/** collect:false or unset: the same walk, only once no hostile is within 16 blocks, then back to where it stood. */
	public ServerFightController collectWhenClear(java.util.function.BiPredicate<ServerPlayer, net.minecraft.world.entity.Entity> mayTake) {
		this.clearFilter = mayTake;
		return this;
	}

	/** The count engine owns retargeting (see {@link #engineTargets}): no in-reach, follow-through or policy switch here. */
	public ServerFightController engineTargets() {
		this.engineTargets = true;
		return this;
	}

	/** Called after cancellation releases input, as well as for normal terminal fight receipts. */
	public String stoppedBodyFacts(ServerPlayer player) {
		return CombatMoveText.supportFacts(player) + bodyAfterStop(player);
	}

	private String bodyAfterStop(ServerPlayer player) {
		return verticalFacts(player) + FightFacts.stop(player);
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (bailout != null) bailout.cancel(player);
		if (collector != null) collector.cancel(player);
		if (clearWalk != null) clearWalk.cancel(player);
		BrinkGuard.keepLevel(player, this, false);
		input.release();
		// Remember the stance for a replacement fight_target the model may start right after (a retarget).
		synchronized (HANDOFFS) {
			HANDOFFS.put(player.getUUID(), new Handoff(weaponSlot, backoffTicks, player.level().getGameTime()));
		}
	}

	/**
	 * Blaze rods are only kept by a body that lives: holding one against a blaze, a fight with a flee line under half health
	 * backs out at half health instead. No flee line (a cornered stand's fight) or 0 (the model's "fight on") stays as given.
	 */
	static final float ROD_FLEE_HEALTH = 10.0F;

	/** The caller answers low health itself (the spawner hold's defend): its flee line stays as given with rods in hand. */
	private boolean keepFleeLine;

	public ServerFightController keepFleeLine() {
		keepFleeLine = true;
		return this;
	}

	/** The spawner hold's defend: a blaze approach keeps the cell's deck instead of stepping a block up or down. */
	public ServerFightController holdDeck() {
		holdDeck = true;
		return this;
	}

	private Float lootFlee(ServerPlayer player) {
		if (keepFleeLine || !(target instanceof net.minecraft.world.entity.monster.Blaze) || fleeAtHealth == null || fleeAtHealth <= 0.0F || fleeAtHealth >= ROD_FLEE_HEALTH) return fleeAtHealth;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++)
			if (player.getInventory().getItem(slot).is(net.minecraft.world.item.Items.BLAZE_ROD)) return ROD_FLEE_HEALTH;
		return fleeAtHealth;
	}

}
