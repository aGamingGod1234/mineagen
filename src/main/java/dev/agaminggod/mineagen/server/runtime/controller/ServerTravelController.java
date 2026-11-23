package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.LocalPathfinder;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import dev.agaminggod.mineagen.server.perception.CastLava;
import dev.agaminggod.mineagen.server.perception.ObservationVisibility;
import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputStates;
import dev.agaminggod.mineagen.server.runtime.input.InputLease;
import dev.agaminggod.mineagen.server.runtime.input.InputOwner;
import dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Objects;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.util.Mth;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * travel_to: one model call for a whole trip toward a known place or heading, run at body speed. The body picks a
 * standing spot it has seen up to a leg ahead toward the target ({@link TravelCheckpoints}), sprints there with the
 * ordinary navigation (every navigate_to safety rule applies to each leg), and picks the next as new terrain comes into
 * view. Where no seen leg gets closer it builds its way on in a straight line toward the target ({@link TravelBuilder}):
 * bridges a gap or lava, pillars a ledge, tunnels a wall. It stops and hands back to the model on arrival, damage, a
 * hostile coming into range, low health or food, a needed block it does not have, no way on, or the chosen block
 * coming into view; the result says where and why. The model chooses when to travel and where; this never picks a goal.
 */
public final class ServerTravelController implements ServerController {
	private static final org.slf4j.Logger LOGGER = org.slf4j.LoggerFactory.getLogger(ServerTravelController.class);
	static final boolean DEBUG = Boolean.getBoolean("mineagen.travel.debug");
	/** Longest checkpoint leg, verified as connected by the bounded walking search. */
	static final double LEG_REACH = 48.0D;
	static final double LEG_TOLERANCE = 1.0D;
	/** How close to an intermediate checkpoint the next leg is picked, without stopping (blocks). */
	static final double LEG_HANDOFF = 3.0D;
	/** A leg that takes the body this much farther from the target than where it started is backtracking (blocks). */
	static final double BACKTRACK = 3.0D;
	static final long LEG_TIMEOUT_MS = 20_000L;
	/**
	 * A trip whose target is a seen portal ends by crossing it, as a player steps in: arrival within the tolerance is
	 * followed by a step into its nearest standing cell, then standing still there until vanilla moves the body (80 ticks
	 * for a Nether portal; the crossing ends the action with DIMENSION_TRANSITION). Scripted gate chain (cast-gate-5): travel_to the cell the lit build named stopped 3 blocks
	 * short, ARRIVED, and the body never crossed.
	 */
	static final double PORTAL_STEP_TOLERANCE = 0.3D;
	static final int PORTAL_WAIT_TICKS = 120;
	static final int PORTAL_NUDGE_TICKS = 30;
	/** Legs in a row that end no closer before the body builds its way on, and before it gives up. */
	static final int FAILED_LEGS_BEFORE_BUILD = 3;
	static final int MAX_FAILED_LEGS = 6;
	/** Progress that counts as getting closer (blocks). */
	static final double PROGRESS_STEP = 2.0D;
	/** An arrived leg that gains less than this toward the target counts as a failed one. */
	static final double NO_GAIN = 0.5D;
	/** No new closest approach for this long ends the trip as having no way on. */
	static final long STALL_MS = 60_000L;
	/** Cells marched in one straight build run before seen legs are tried again. */
	static final int BUILD_RUN = 10;
	static final double DEFAULT_TOLERANCE = 3.0D;
	public static final long DEFAULT_TIMEOUT_MS = 600_000L;
	static final float DEFAULT_MIN_HEALTH = 8.0F;
	/** Vanilla sprinting needs food above 6. */
	static final int SPRINT_FOOD = 6;
	static final double HOSTILE_RANGE = ThreatPerception.RANGE;
	/** A hostile already in range at the start stops the trip only once this close. */
	static final double HOSTILE_CLOSE = 6.0D;
	/** A mob targeting the body stops the trip from this far (a ghast aims from up to 64). */
	static final double TARGETING_RANGE = 48.0D;
	static final double SIGHT_RANGE = 96.0D;
	private static final int SIGHT_YAWS = 13, SIGHT_PITCHES = 7;
	private static final float SIGHT_YAW_SPAN = 120.0F, SIGHT_PITCH_SPAN = 60.0F;

	private enum Phase { PLAN, LOOK, LEG, BUILD, WATCH, FIGHT, DIG, SWIM }

	/** A dig_to staircase toward a target below: the executor's own dig controller (every dig_to stop applies). */
	public interface Descent {
		ServerController dig(int y, int x, int z, long timeoutMs);
	}

	/** Staircases a trip digs at most before it hands back. */
	static final int MAX_DIGS = 3;
	private Descent descent;
	private ServerController dig;
	private int digs;
	/** Where a staircase up ended under open sky: no staircase up starts again within a block and a half of it. */
	private Vec3 surfacedAt;

	private boolean surfacedHere(ServerPlayer player) {
		return surfacedAt != null && Math.hypot(player.getX() - surfacedAt.x, player.getZ() - surfacedAt.z) < 1.5D && Math.abs(player.getY() - surfacedAt.y) < 1.0D;
	}

	/** Longest single fight a fightThrough trip runs before the fight itself times out (the trip's own deadline still rules). */
	static final long FIGHT_TIMEOUT_MS = 30_000L;
	/**
	 * Fight results a trip may pass once (the mob got away or out of reach); every other failed ending (the model's
	 * health floor, death, lava, fire, a dimension change) hands the trip back at once with the fight's reason.
	 */
	static final Set<String> FIGHT_PASSABLE = Set.of("TARGET_ESCAPED", "TARGET_UNREACHABLE", "APPROACH_BLOCKED", "NO_SEEN_ROUTE", "FIGHT_TIMED_OUT");
	/** Failed fights (target escaped, unreachable, timed out) a trip passes before it hands back on the next one. */
	static final int MAX_FIGHT_FAILURES = 2;

	/** The model's fightThrough:true: a hostile that closes in or hits on the route is fought (fight_target rules), then the trip goes on. */
	private boolean fightThrough;
	private ServerFightController fight;
	private UUID fightTarget;
	private String fightLabel;
	private int fightFailures;
	private final java.util.List<String> fightLog = new java.util.ArrayList<>();
	private int reflexResumes;

	private final double targetX, targetZ, targetY;
	private boolean routeLeg;
	/** travel_to's own trip keeps the knockback margin on its forward legs (issue 2, K9); null on every other trip. */
	private KnockbackHolds knockbackHolds;
	private final double tolerance;
	private final long timeoutMs;
	private final boolean build;
	private final String stopWhenSeen;
	private final float minHealth;
	private final BiPredicate<ServerPlayer, BlockPos> mayModify;
	private final long startedAt;

	private Phase phase = Phase.PLAN;
	private ResourceKey<Level> dimension;
	private Vec3 start, lastPosition;
	private double startLeft, bestLeft = Double.POSITIVE_INFINITY, travelled;
	private long bestAt;
	private float lastHealth, startHealth;
	private int startFood;
	private final Set<UUID> knownHostiles = new HashSet<>();
	/** Each hostile's distance at its last sample, to tell one closing in from one falling behind. */
	private final java.util.Map<UUID, Double> hostileDistances = new java.util.HashMap<>();
	/** Hostiles in range that were passed because they were neither close nor coming for the body. */
	private final Set<UUID> passedHostiles = new HashSet<>();
	/** Terrain damage shrugged off on this trip (a berry bush, a cactus, a short drop), and how. */
	private float shrugged;
	private final java.util.List<String> shrugNotes = new java.util.ArrayList<>();
	private final Set<GridPosition> refused = new HashSet<>();
	private ServerNavigationController leg;
	/** The portal cells this trip's target names (null until arrival first checks; empty: no portal there). */
	private Set<GridPosition> portalCells;
	private GridPosition portalCell;
	private boolean portalLeg;
	/** The stall watchdog, and the count it reads as work: blocks placed and ticks spent mining. */
	private final TravelStallWatch stallWatch = new TravelStallWatch();
	private long work;
	/** Where the first stall turned the trip to building (one turn per spot), or null. */
	private Vec3 stallBuildAt;
	private int portalTicks;
	/** Ticks spent walking straight into the opening after the step in ended short of it. */
	private int portalNudge;
	private boolean portalStepped;
	private TravelCheckpoints.WalkingSearch checkpointSearch;
	private GridPosition legTarget;
	private double legStartLeft;
	private boolean legFinal;
	private int legTicks;
	private int failedLegs, legs, looks, bridged, pillared, tunnelled, ticks, dugDown;
	private double legAllowedBacktrack = BACKTRACK;
	private String lastLegFailure, buildRefusal, buildRefusalCode;
	private float lookYaw, lookPitch;
	private boolean glanced;
	/** Mined shaft headroom: ticks spent watching the cell above it before pillaring into it, or -1. */
	private int shaftSettle = -1;
	private int lookTicks;
	// Build moves.
	private TravelBuilder.Plan move;
	private Direction buildDirection;
	private int buildRun, moveTicks, moveStage, pillarDone;
	private BlockHitResult bridgeAttachment;
	private float bridgeViewYaw, bridgeViewPitch;
	private boolean centred, stepSneak;
	private int stepSpan = 1;
	private int tunnelWatch, tunnelReach;
	private final Set<GridPosition> tunnelDug = new HashSet<>();
	private GridPosition retreatFrom;
	/** The standing cells walked, oldest first, for backing out the way the body came (a march turns; a tunnel bends). */
	private final java.util.ArrayDeque<GridPosition> trail = new java.util.ArrayDeque<>();
	static final int TRAIL_CELLS = 48;
	private String retreatCode, retreatWhy;
	private int retreats, watchTicks;
	static final int MAX_RETREATS = 4, RETREAT_WATCH_TICKS = 60, RETREAT_CELLS = 8;
	static final double RETREAT_TOLERANCE = 0.5D;
	/** Ticks spent looking into a freshly opened tunnel cell before judging it (a Nether lava spread step is 10). */
	static final int TUNNEL_WATCH_TICKS = 12;
	private TravelBuilder.Kind lastKind;
	/** How close to the cell's middle the body stands before a build move (blocks). */
	static final double CENTRED = 0.12D;
	/** A level step starting within this of its line's centre walks without sneaking (blocks). */
	static final double STEP_LINE = 0.15D;
	private GridPosition moveFeet;
	private InputLease lease;
	private LeasedServerInputController input;
	/** Swimming out of water before a trip can plan from footing: when it began, the shore it heads for, how far it looked round. */
	/** The whole swim, afloat time included; time with the eyes under water is bounded by the air left (underWater). */
	static final long SWIM_TIMEOUT_MS = 30_000L;
	static final int SHORE_RADIUS = 10;
	private long swimStartedAt;
	private GridPosition shore;
	private float swimTurned;
	/** Ticks spent ducking out from under a ceiling this swim (SwimStep.PEEK), capped at PEEK_TICKS. */
	private int peekTicks;
	private static final int PEEK_TICKS = dev.agaminggod.mineagen.server.perception.WaterAirFacts.PEEK_TICKS;
	/** Banks it reached but could not climb onto (4 s within reach), never chosen again this trip. */
	private final Set<GridPosition> refusedShores = new HashSet<>();
	private long nearShoreSince;
	static final int MAX_CROSSINGS = 2;
	/**
	 * With build on, sideways walks round rock (a seen spot 5-8 blocks off the bearing, no closer, at most BACKTRACK
	 * farther) tried in a row before the body builds or tunnels; getting closer than where the walks began, or a build or
	 * dig, resets the count. A target this close horizontally is a way down or up, not round. 19 Nov round: travel dug
	 * 1,590 blocks, 75% of Nether pickaxe wear, because it built as soon as no seen spot was 2 blocks closer.
	 */
	static final int MAX_WALK_AROUNDS = 2;
	/**
	 * Off unless -Dmineagen.travel.walkAround=true or MINEAGEN_TRAVEL_WALK_AROUND=on. Practice rooms 21 Nov (Nether courses,
	 * 10 repeats per jar): pickaxe uses per 100 blocks gained 69.8 with it against 60.2 without (50 runs each), and 148.6
	 * against 141.8 (34 each); a 5-8 block sidestep does not get round a netherrack hill.
	 */
	static boolean walkAroundEnabled() {
		return dev.agaminggod.mineagen.server.Switches.get("travel.walkAround");
	}
	static final double WALK_AROUND_MIN_LEFT = 8.0D;
	private int walkArounds, walkedAround;
	/** How far from the target the body was when this run of walks round began: only getting past it resets the count. */
	private double aroundFromLeft = Double.NaN;
	static final long WADE_MS = 3_000L;
	static final long CROSS_TIMEOUT_MS = 60_000L;
	/** A far bank counts only when it leaves at least this much less of the trip than the bank swum from. */
	static final double CROSS_GAIN = 2.0D;
	static final int CROSS_REACH = 48;
	private int crossings;
	private boolean wading;
	private float wadeYaw;
	private double crossFromLeft = Double.NaN;
	private AgentInputStates.MotorState motor;

	public ServerTravelController(double targetX, double targetY, double targetZ, double tolerance, long timeoutMs,
			boolean build, String stopWhenSeen, Float minHealth, BiPredicate<ServerPlayer, BlockPos> mayModify, long startedAt) {
		if (!Double.isFinite(targetX) || !Double.isFinite(targetZ) || Double.isInfinite(targetY)) throw new IllegalArgumentException("travel target must be finite");
		if (!(tolerance >= 1.0D) || timeoutMs <= 0L) throw new IllegalArgumentException("invalid travel tolerance or timeout");
		this.targetX = targetX;
		this.targetY = targetY;
		this.targetZ = targetZ;
		this.tolerance = tolerance;
		this.timeoutMs = timeoutMs;
		this.build = build;
		this.stopWhenSeen = stopWhenSeen;
		this.minHealth = minHealth == null ? DEFAULT_MIN_HEALTH : minHealth;
		this.mayModify = Objects.requireNonNull(mayModify, "mayModify must not be null");
		this.startedAt = startedAt;
	}

	/** A remembered route leg needs its actual height, including a shaft's next standing level. */
 ServerTravelController routeLeg() { this.routeLeg=true; return this; }

	/** One set of knockback holds for the whole trip, spent only by its forward legs (see {@link #startForwardLeg}). */
	public ServerTravelController keepsKnockbackMargin() {
		this.knockbackHolds = new KnockbackHolds();
		return this;
	}

	/** Lets the trip dig a dig_to staircase when the target is below or above and no seen way there gets closer. */
	public ServerTravelController descend(Descent descent) {
		this.descent = descent;
		return this;
	}

	/**
	 * Whether a trip with nothing seen that gets closer digs down instead of building across: the target y lies more than
	 * the arrival band (plus a block) below the feet. A player with a pickaxe digs a staircase down to a cave or ore level
	 * rather than bridging or pillaring at the surface.
	 */
	/**
	 * The dig_to arguments of a trip's staircase toward a target's level: up or down from the body, carrying the trip's own
	 * continuation choices (throughCaves, discard, sealFluids) as the retrace shaft does, so an explicit opt-out holds.
	 */
	public static com.google.gson.JsonObject staircase(com.google.gson.JsonObject trip, int y, int x, int z, long timeoutMs, int feetY) {
		com.google.gson.JsonObject stairs = new com.google.gson.JsonObject();
		stairs.addProperty("pattern", y > feetY ? "stairs_up" : "stairs_down");
		stairs.addProperty("y", y);
		stairs.addProperty("x", x);
		stairs.addProperty("z", z);
		stairs.addProperty("timeoutMs", timeoutMs);
		for (String option : java.util.List.of("throughCaves", "discard", "sealFluids")) if (trip.has(option)) stairs.add(option, trip.get(option).deepCopy());
		return stairs;
	}

	/**
	 * Whether a target this far below the feet needs a staircase down: past the arrival band, plus a block for the loose
	 * band (3 or more) and for a remembered route leg (0.6), where a step down is walked. A trip aimed at a cell (band 1-2) digs once
	 * the target is past its own band, or a tolerance-1 trip to a target 2 below could neither arrive nor dig.
	 */
	static boolean digsDown(double feetY, double targetY, double heightTolerance) {
		return Double.isFinite(targetY) && feetY - targetY > heightTolerance + (heightTolerance >= 1.0D && heightTolerance < 3.0D ? 0.0D : 1.0D);
	}

	static boolean digsUp(double feetY, double targetY, double heightTolerance) {
		return Double.isFinite(targetY) && targetY - feetY > heightTolerance;
	}

	/** The model chose to fight hostiles on the route instead of stopping for them. */
	public ServerTravelController fightThrough(boolean enabled) {
		this.fightThrough = enabled;
		return this;
	}

	/** Instincts arm with fightThrough unset: a lone beatable melee mob ({@link TravelStops#beatable}) is fought, not a stop. */
	private boolean fightsBeatable;

	public ServerTravelController fightsBeatable(boolean enabled) {
		this.fightsBeatable = enabled;
		return this;
	}

	private boolean beatableNow(ServerPlayer player, Mob mob, List<Mob> seen) {
		int others = (int) seen.stream().filter(other -> other != mob && other.distanceTo(player) <= TravelStops.LONE_RANGE).count();
		boolean weapon = false;
		for (int slot = 0; slot < 9 && !weapon; slot++) {
			String id = BuiltInRegistries.ITEM.getKey(player.getInventory().getItem(slot).getItem()).getPath();
			weapon = id.endsWith("_sword") || id.endsWith("_axe");
		}
		double hit = dev.agaminggod.mineagen.server.perception.ThreatDamage.expectedHit(mob, player).damage();
		return TravelStops.beatable(BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString(), others, weapon,
				player.getHealth() + player.getAbsorptionAmount(), minHealth, hit);
	}
 private double heightTolerance() {return heightTolerance(routeLeg, tolerance);}

	/**
	 * How far off the target y a trip may end: a remembered route leg 0.6; a caller aiming at a cell (tolerance 2 or less)
	 * its own tolerance, at least a block (beside, on or just under the block); a looser trip 3 or its tolerance. Lane 3's
	 * smoke logs, 22 Nov: with the 3-block band for every trip, 17 of 19 tolerance-1 arrivals ended 1-3 blocks off height
	 * and a walk to a seen ore "arrived" 3 above it, so the pick-up after found no route.
	 */
	static double heightTolerance(boolean routeLeg, double tolerance) {
		if (routeLeg) return 0.6D;
		return tolerance <= 2.0D ? Math.max(1.0D, tolerance) : Math.max(3.0D, tolerance);
	}

 /** The target for a heading: {@code distance} blocks along {@code yaw} (Minecraft degrees) from the body. */
	public static double[] headingTarget(Vec3 from, double yaw, double distance) {
		double radians = Math.toRadians(yaw);
		return new double[] {from.x - Math.sin(radians) * distance, from.z + Math.cos(radians) * distance};
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		if (start == null) begin(player, nowEpochMs);
		ticks++;
		if (!player.isAlive()) return fail(player, "AGENT_DEAD", "Agent player died");
		if (!ServerNavigationController.remainsInDimension(dimension, player.level().dimension())) return fail(player, "ACTION_DIMENSION_CHANGED", "Agent player changed dimension during travel");
		if (player.isPassenger() || player.isFallFlying()) return fail(player, "UNSUPPORTED_NAVIGATION_MODE", "Mounted travel and gliding require player control inputs");
		Vec3 position = player.position();
		travelled += Math.hypot(position.x - lastPosition.x, position.z - lastPosition.z);
		lastPosition = position;
		if (player.onGround() && retreatCode == null) {
			GridPosition at = feet(player);
			if (!at.equals(trail.peekLast())) {
				trail.addLast(at);
				if (trail.size() > TRAIL_CELLS) trail.removeFirst();
			}
		}
		// A fight, the retreat watch and the portal wait stand still on purpose, and a dig_to staircase has its own
		// DIG_STUCK stops; each has its own limit. A retreat (its leg or step has its own limit, then the watch) is never
		// read as stalled forward travel: building on toward the target would send the body back at the hazard.
		boolean standsOnPurpose = retreatCode != null || phase == Phase.FIGHT || phase == Phase.WATCH || phase == Phase.DIG || portalLeg;
		if (standsOnPurpose) stallWatch.reset();
		else if (leg != null && leg.heldForKnockback()) stallWatch.excuse(1);
		TravelStallWatch.Verdict still = standsOnPurpose ? null : stallWatch.observe(ticks, position.x, position.y, position.z, work);
		if (phase == Phase.FIGHT) return fightTick(player, nowEpochMs);
		double left = left(position);
		if (left < bestLeft - PROGRESS_STEP || bestLeft == Double.POSITIVE_INFINITY) { bestLeft = left; bestAt = nowEpochMs; }
		if (portalLeg || arrived(player)) {
			TickResult entering = enterPortal(player, nowEpochMs);
			if (entering != null) return entering;
			if (!portalLeg) return finish(player, ServerController.State.SUCCEEDED, "ARRIVED", "Arrived within " + format(tolerance) + " blocks of the target");
		}
		TickResult stop = stopOrTimeout(player, nowEpochMs);
		if (stop != null) return stop;
		if (nowEpochMs - bestAt >= STALL_MS) return fail(player, buildRefusal == null ? "NO_ROUTE" : buildRefusalCode, "No closer to the target for " + STALL_MS / 1000 + " s"
				+ (buildRefusal == null ? "" : "; building cannot continue: " + buildRefusal) + lastFailureText());
		if (still == TravelStallWatch.Verdict.STALLED) {
			if (TravelStallWatch.buildFirst(build, buildRefusal != null, failedLegs >= FAILED_LEGS_BEFORE_BUILD,
					phase == Phase.PLAN || phase == Phase.LEG || phase == Phase.LOOK, stallBuildAt == null ? Double.POSITIVE_INFINITY : stallBuildAt.distanceTo(position))) {
				// Legs and looks going nowhere before the failed legs that start building ran out: build on from here now.
				stallBuildAt = position;
				if (leg != null) leg.cancel(player);
				leg = null;
				releaseInput();
				failedLegs = FAILED_LEGS_BEFORE_BUILD;
				phase = Phase.PLAN;
				stallWatch.reset();
			} else return fail(player, "STALLED_IN_PLACE", String.format(Locale.ROOT,
					"Feet moved %.1f blocks in %.0f s with no block placed or mined", stallWatch.moved(position.x, position.y, position.z),
					TravelStallWatch.WINDOW_TICKS / 20.0D) + (buildRefusal == null ? "" : "; building cannot continue: " + buildRefusal) + lastFailureText());
		}
		// The staircase has its own lava, water and cave rules; the walking lava guard would fight its keys.
		if (phase == Phase.DIG) return digTick(player, nowEpochMs);
		TickResult lava = lavaGuard(player, nowEpochMs);
		if (lava != null) return lava;
		return switch (phase) {
			case PLAN -> plan(player, nowEpochMs);
			case LOOK -> look(player, nowEpochMs);
			case LEG -> leg(player, nowEpochMs);
			case BUILD -> buildTick(player, nowEpochMs);
			case WATCH -> watchTick(player, nowEpochMs);
			case FIGHT -> fightTick(player, nowEpochMs);
			case DIG -> digTick(player, nowEpochMs);
			case SWIM -> swimTick(player, nowEpochMs);
		};
	}

	private void begin(ServerPlayer player, long nowEpochMs) {
		start = player.position();
		lastPosition = start;
		dimension = player.level().dimension();
		startLeft = Math.max(1.0E-3D, left(start));
		bestAt = nowEpochMs;
		lastHealth = startHealth = player.getHealth();
		startFood = player.getFoodData().getFoodLevel();
		for (Mob mob : hostiles(player)) knownHostiles.add(mob.getUUID());
	}

	/**
	 * Distance still to go: horizontal, plus the height past the arrival band when a y was given, so a target below the
	 * body (a cave floor, lava seen down a cave) counts the descent toward it as progress.
	 */
	private double left(Vec3 position) {
		return TravelCheckpoints.left(position.x, position.y, position.z, targetX, targetY, targetZ, heightTolerance());
	}

	/**
	 * Whether a body this near a lit portal walks the last step in itself: within 2 blocks across, from at most 1 below its
	 * floor cell to 2 above it, as a player steps or drops into the opening. lava-gate-1: the body stood 1.2 above the
	 * floor on the ground cleared beside a cast frame, 1 block from the opening, and the trip failed PORTAL_NOT_REACHED
	 * in 3 s (2 of 3 runs that lit the portal).
	 */
	static boolean nudgesIntoPortal(double horizontalSquared, double aboveFloor) {
		return horizontalSquared <= 4.0D && aboveFloor >= -1.0D && aboveFloor <= 2.0D;
	}

	/** Whether a body this far below a lit portal's floor, beside it, pillars one block before the step in. */
	static boolean stepsUpToPortal(double horizontalSquared, double aboveFloor) {
		return horizontalSquared <= 6.25D && aboveFloor < -1.0D && aboveFloor >= -2.6D;
	}

	/**
	 * At a target that is a seen portal: step into its nearest standing cell, then stand there until the crossing. Null
	 * when the target is no portal, or while the step in runs (the leg phase ticks it).
	 */
	private TickResult enterPortal(ServerPlayer player, long nowEpochMs) {
		if (portalCells == null) {
			portalCells = Double.isFinite(targetY) ? new MinecraftNavigationWorld(player.level(), player).targetedPortal(new Vec3(targetX, targetY, targetZ)) : Set.of();
			portalCell = portalCells.stream().min(java.util.Comparator.comparingDouble(cell -> Math.hypot(cell.x() + 0.5D - targetX, cell.z() + 0.5D - targetZ)
					+ Math.abs(cell.y() - targetY))).orElse(null);
		}
		if (portalCell == null) return null;
		if (insidePortal(player)) {
			if (leg != null) { leg.cancel(player); leg = null; }
			releaseInput();
			// Standing in the portal is still the trip: a hit, low health or a hostile closing in hands it back as on every
			// other tick. Without this a zombie behind the body or the burn from a pour had the 4 s of vanilla's wait.
			TickResult stop = stopOrTimeout(player, nowEpochMs);
			if (stop != null) return stop;
			if (++portalTicks > PORTAL_WAIT_TICKS) return fail(player, "PORTAL_NOT_CROSSED", "Stood in the portal at " + cell(portalCell) + " for " + PORTAL_WAIT_TICKS / 20 + " s and it did not take the body");
			return TickResult.running(progress(player));
		}
		if (portalLeg && !(phase == Phase.LEG && leg != null)) {
			// The step block under the feet is being placed: the build phase ticks it.
			if (phase == Phase.BUILD && move != null) return null;
			double dx = portalCell.x() + 0.5D - player.getX(), dz = portalCell.z() + 0.5D - player.getZ();
			double above = player.getY() - portalCell.y();
			if (portalNudge++ < PORTAL_NUDGE_TICKS && nudgesIntoPortal(dx * dx + dz * dz, above)) {
				TickResult stop = stopOrTimeout(player, nowEpochMs);
				if (stop != null) return stop;
				// A jump where the frame's bottom row stands a block over the feet, as a player hops into the opening.
				apply(player, new AgentInputStates.MotorTarget(Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz))), 0.0F, true, player.horizontalCollision, false), false, false, false, nowEpochMs);
				return TickResult.running(progress(player));
			}
			// The frame stands on a ledge 2 over the ground in front (lava-gate-1: 8 of 9 lit portals not entered): one
			// carried block under the feet, then the step in from a block below the floor. Never on a build:false walk,
			// which promises to place and mine nothing.
			if (build && !portalStepped && stepsUpToPortal(dx * dx + dz * dz, above) && player.onGround() && TravelBuilder.blockSlot(player) >= 0) {
				portalStepped = true;
				portalNudge = 0;
				releaseInput();
				move = new TravelBuilder.Plan(TravelBuilder.Kind.PILLAR, Direction.NORTH, 1, null, null);
				buildDirection = Direction.NORTH;
				buildRun = BUILD_RUN;
				moveFeet = feet(player);
				moveTicks = 0;
				moveStage = 0;
				pillarDone = 0;
				centred = false;
				phase = Phase.BUILD;
				return null;
			}
		}
		if (portalLeg) return phase == Phase.LEG && leg != null ? null : fail(player, "PORTAL_NOT_REACHED", "Could not step into the portal at " + cell(portalCell) + lastFailureText());
		portalLeg = true;
		releaseInput();
		legTarget = portalCell;
		legTicks = 0;
		legStartLeft = left(player.position());
		legFinal = true;
		leg = new ServerNavigationController(new Vec3(portalCell.x() + 0.5D, portalCell.y(), portalCell.z() + 0.5D), PORTAL_STEP_TOLERANCE, false, nowEpochMs, LEG_TIMEOUT_MS, true);
		phase = Phase.LEG;
		return TickResult.running(progress(player));
	}

	private static boolean insidePortal(ServerPlayer player) {
		var box = player.getBoundingBox().deflate(1.0E-5D);
		for (BlockPos at : BlockPos.betweenClosed(BlockPos.containing(box.minX, box.minY, box.minZ), BlockPos.containing(box.maxX, box.maxY, box.maxZ))) {
			BlockState state = player.level().getBlockState(at);
			if (state.is(Blocks.NETHER_PORTAL) || state.is(Blocks.END_PORTAL)) return true;
		}
		return false;
	}

	private boolean arrived(ServerPlayer player) {
		if (left(player.position()) > tolerance) return false;
		if (Double.isFinite(targetY) && Math.abs(player.getY() - targetY) > heightTolerance()) return false;
		return player.onGround() || player.isInWater();
	}

	/** The stops of {@link #stopCheck}, then the trip's own timeout. */
	private TickResult stopOrTimeout(ServerPlayer player, long nowEpochMs) {
		TickResult stop = stopCheck(player, nowEpochMs);
		if (stop != null) return stop;
		if (nowEpochMs - startedAt >= timeoutMs) return finish(player, ServerController.State.TIMED_OUT, "TRAVEL_TIMEOUT", withLavaStep("The trip's timeoutMs ran out before arrival", lavaStepDetail));
		return null;
	}

	/** Everything that hands the trip back to the model before arrival. */
	private TickResult stopCheck(ServerPlayer player, long nowEpochMs) {
		float health = player.getHealth();
		if (health < lastHealth - 1.0E-3F) {
			var source = player.getLastDamageSource();
			String cause = source == null ? "unknown" : source.getMsgId()
					+ (source.getEntity() == null ? "" : " from " + BuiltInRegistries.ENTITY_TYPE.getKey(source.getEntity().getType()));
			if (fightThrough && health > minHealth && source != null && source.getEntity() instanceof Mob attacker && attacker.isAlive()
					&& attacker.distanceTo(player) <= HOSTILE_RANGE) {
				return engage(player, attacker, String.format(Locale.ROOT, "hit you for %.1f (%s)", lastHealth - health, cause), nowEpochMs);
			}
			float lost = lastHealth - health;
			if (!TravelStops.shrugsOff(source == null ? null : source.getMsgId(), source != null && source.getEntity() != null, lost, shrugged, health, minHealth))
				return fail(player, "TRAVEL_DAMAGED", String.format(Locale.ROOT, "Took %.1f damage (%s); health %.1f", lost, cause, health));
			// A scratch from the terrain itself: a player keeps going.
			shrugged += lost;
			shrugNotes.add(String.format(Locale.ROOT, "%.1f (%s)", lost, cause));
		}
		lastHealth = health;
		if (health <= minHealth && startHealth > minHealth) return fail(player, "LOW_HEALTH", "Health fell to " + format(health) + " (minHealth " + format(minHealth) + ")");
		int food = player.getFoodData().getFoodLevel();
		if (food <= SPRINT_FOOD && startFood > SPRINT_FOOD) return fail(player, "LOW_FOOD", "Food fell to " + food + "; sprinting needs more than " + SPRINT_FOOD);
		// While the trip digs its own staircase, the staircase's mob rule decides (every dig_to stop applies): a climb out
		// goes on past a mob not yet within reach (#101), where this walking rule stopped it for a new archer targeting the
		// body at any range or any hostile within 6, halfway up the stair.
		if (ticks % 5 == 0 && phase != Phase.DIG) {
			List<Mob> seen = hostiles(player);
			for (Mob mob : seen) {
				double distance = mob.distanceTo(player);
				boolean targeting = mob.getTarget() == player;
				boolean known = knownHostiles.contains(mob.getUUID());
				Double previous = hostileDistances.put(mob.getUUID(), distance);
				// One the model already had in view when it chose to travel stops the trip only up close (or by a hit).
				if (known && distance > HOSTILE_CLOSE) continue;
				// A new one stops it only when it is coming for the body: close, targeting and closing in, or a ranged
				// mob targeting it. One that is not after the body, or falls behind the sprint, is passed.
				if (!fightThrough && !TravelStops.stopsFor(false, distance, previous, targeting,
						BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString())) {
					passedHostiles.add(mob.getUUID());
					continue;
				}
				if (fightThrough || fightsBeatable && beatableNow(player, mob, seen)) {
					// Fought once it closes in or hits; until then it is only in view, as for one seen at the start. One that
					// is only beatable is judged again each sample, so it still stops the trip once it is not (a pack).
					if (distance > HOSTILE_CLOSE) { if (fightThrough) knownHostiles.add(mob.getUUID()); continue; }
					return engage(player, mob, String.format(Locale.ROOT, "%.1f blocks away%s", distance, targeting ? ", targeting you" : ""), nowEpochMs);
				}
				return fail(player, "HOSTILE_NEAR", String.format(Locale.ROOT, "%s %s %.1f blocks away at %.1f,%.1f,%.1f%s",
						BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()), mob.getUUID(), distance, mob.getX(), mob.getY(), mob.getZ(),
						targeting ? ", targeting you" : ""));
			}
		}
		if (stopWhenSeen != null && ticks % 20 == 0) {
			BlockPos seen = sees(player, stopWhenSeen, bucketFluid(stopWhenSeen));
			if (seen != null) return finish(player, ServerController.State.SUCCEEDED, "TARGET_SEEN", String.format(Locale.ROOT,
					"%s seen at %d,%d,%d, %.0f blocks away", stopWhenSeen, seen.getX(), seen.getY(), seen.getZ(), Math.sqrt(seen.distToCenterSqr(player.getEyePosition()))));
		}
		return null;
	}

	/** Visible hostiles in range and mobs targeting the body from further (see {@link ThreatPerception#isHostileTo}). */
	private static java.util.List<Mob> hostiles(ServerPlayer player) {
		AABB box = player.getBoundingBox().inflate(TARGETING_RANGE);
		return player.level().getEntitiesOfClass(Mob.class, box, mob -> mob.isAlive()
				&& ThreatPerception.isHostileTo(mob, player)
				&& (mob.distanceTo(player) <= HOSTILE_RANGE || mob.getTarget() == player)
				&& ObservationVisibility.canSeeEntity(player, mob));
	}

	/**
	 * The open cells above the block tops the eye's sight lines land on, toward the target: what a player looking that
	 * way picks as the next spot. Only candidates; each still has to be a seen standing cell (the planner's own rule).
	 */
	List<GridPosition> sightedSpots(ServerPlayer player) {
		Vec3 eye = player.getEyePosition();
		float bearing = (float) Math.toDegrees(Math.atan2(-(targetX - player.getX()), targetZ - player.getZ()));
		java.util.LinkedHashSet<GridPosition> spots = new java.util.LinkedHashSet<>();
		for (float yaw = -SPOT_YAW_SPAN; yaw <= SPOT_YAW_SPAN; yaw += SPOT_YAW_STEP) {
			for (float pitch = -10.0F; pitch <= 60.0F; pitch += SPOT_PITCH_STEP) {
				Vec3 direction = Vec3.directionFromRotation(pitch, bearing + yaw);
				BlockHitResult hit = player.level().clip(new ClipContext(eye, eye.add(direction.scale(LEG_REACH + 4.0D)),
						ClipContext.Block.VISUAL, ClipContext.Fluid.ANY, player));
				if (hit.getType() != HitResult.Type.BLOCK || hit.getDirection() != Direction.UP) continue;
				BlockPos top = hit.getBlockPos().above();
				spots.add(new GridPosition(top.getX(), top.getY(), top.getZ()));
			}
		}
		return List.copyOf(spots);
	}

	static final float SPOT_YAW_SPAN = 66.0F, SPOT_YAW_STEP = 6.0F, SPOT_PITCH_STEP = 5.0F;

	/** A block of the named kind the eye sees now: a fan of sight lines across the view (lava stops them). */
	static BlockPos sees(ServerPlayer player, String blockId) {
		return sees(player, blockId, false);
	}

	static boolean bucketFluid(String blockId) {
		return "minecraft:lava".equals(blockId) || "minecraft:water".equals(blockId);
	}

	static BlockPos sees(ServerPlayer player, String blockId, boolean sourceOnly) {
		Vec3 eye = player.getEyePosition();
		net.minecraft.world.level.material.Fluid spill = null;
		for (int yawStep = 0; yawStep < SIGHT_YAWS; yawStep++) {
			float yaw = player.getYRot() - SIGHT_YAW_SPAN / 2.0F + SIGHT_YAW_SPAN * yawStep / (SIGHT_YAWS - 1);
			for (int pitchStep = 0; pitchStep < SIGHT_PITCHES; pitchStep++) {
				float pitch = net.minecraft.util.Mth.clamp(player.getXRot() - SIGHT_PITCH_SPAN / 2.0F + SIGHT_PITCH_SPAN * pitchStep / (SIGHT_PITCHES - 1), -90.0F, 90.0F);
				Vec3 direction = Vec3.directionFromRotation(pitch, yaw);
				BlockHitResult hit = player.level().clip(new ClipContext(eye, eye.add(direction.scale(SIGHT_RANGE)),
						ClipContext.Block.VISUAL, ClipContext.Fluid.ANY, player));
				if (hit.getType() != HitResult.Type.BLOCK) continue;
				BlockState state = player.level().getBlockState(hit.getBlockPos());
				if (!BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString().equals(blockId)) continue;
				// A lava search stops only at a pool that feeds a cast (CastLava): a pocket too small for the frame is passed.
				if (!sourceOnly || state.getFluidState().isSource()) { if (!sourceOnly || CastLava.usable(player, hit.getBlockPos())) return hit.getBlockPos(); continue; }
				if (!state.getFluidState().isEmpty()) spill = state.getFluidState().getType();
			}
		}
		// Only its flow in sight: a source an empty bucket reaches through that flow counts (BucketReach).
		BlockPos reached = spill == null ? null : dev.agaminggod.mineagen.server.perception.BucketReach.nearest(player.level(),
				net.minecraft.world.phys.shapes.CollisionContext.of(player), eye, player.blockInteractionRange(), spill);
		return reached != null && CastLava.usable(player, reached) ? reached : null;
	}

	/** Afloat or under water, with no footing where the feet are: no leg can start from here. */
	private static boolean inDeepWater(ServerPlayer player) {
		if (!player.isInWater()) return false;
		if (player.isUnderWater()) return true;
		return !new MinecraftNavigationWorld(player.level(), player).isStandable(feet(player));
	}

	/**
	 * Out of the water as a player gets out: rise to air along the seen route to the surface while the eyes are under,
	 * then swim to the nearest dry standing spot it has seen (a shore, a step), climbing out at the edge, and plan the
	 * trip from there. With no shore seen it looks round once, then swims toward the target. Before this a trip that
	 * started in water had no leg, no build and no dig from its feet and reported NO_ROUTE while the body sank.
	 */
	private TickResult swimTick(ServerPlayer player, long nowEpochMs) {
		boolean inWater = player.isInWater(), eyesUnder = player.isUnderWater();
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
		if (wading) {
			// Into the water along the bearing; the swim itself starts once afloat.
			if (inWater) wading = false;
			else if (nowEpochMs - swimStartedAt >= WADE_MS || dropAhead(world, player.getX(), Mth.floor(player.getY()), player.getZ(), wadeYaw)) {
				wading = false;
				crossFromLeft = Double.NaN;
				return fail(player, "NO_ROUTE", "No seen standing spot ahead gets closer, and the water toward the target could not be waded into" + lastFailureText());
			} else {
				apply(player, new AgentInputStates.MotorTarget(Mth.wrapDegrees(wadeYaw), 0.0F, true, player.horizontalCollision, false), false, false, false, nowEpochMs);
				return TickResult.running(progress(player));
			}
		}
		if (!inWater && player.onGround() || player.onGround() && !eyesUnder && (world.isStandable(feet(player)) || feet(player).equals(shore))) {
			releaseInput();
			phase = Phase.PLAN;
			crossFromLeft = Double.NaN;
			return TickResult.running(progress(player));
		}
		if (nowEpochMs - swimStartedAt >= (Double.isFinite(crossFromLeft) ? CROSS_TIMEOUT_MS : SWIM_TIMEOUT_MS)) {
			return fail(player, "NO_ROUTE", "Could not get out of the water in " + SWIM_TIMEOUT_MS / 1000 + " s"
					+ (shore == null ? "; no dry footing seen within " + SHORE_RADIUS + " blocks" : "; shore at " + cell(shore) + " not reached"));
		}
		if (shore == null || ticks % 10 == 0) shore = nearestShore(player, world);
		float yaw = player.getYRot(), pitch = 0.0F;
		boolean forward = false;
		var lookup = eyesUnder ? dev.agaminggod.mineagen.server.perception.WaterAirFacts.surface(player) : null;
		var surface = lookup == null ? null : lookup.surface();
		int air = player.getAirSupply();
		double shoreDistance = shore == null ? Double.NaN
				: Math.sqrt(player.distanceToSqr(shore.x() + 0.5D, shore.y(), shore.z() + 0.5D));
		// A route to the true surface in the body's own column, every cell open water or air: open water straight up.
		boolean straightUp = surface != null && !surface.breathOnly() && openColumnUp(surface.path(), Mth.floor(player.getX()), Mth.floor(player.getZ()),
				cell -> openWaterOrAir(player.level(), cell));
		BlockPos peek = eyesUnder && surface == null && peekTicks < PEEK_TICKS ? dev.agaminggod.mineagen.server.perception.WaterAirFacts.peekCell(player) : null;
		SwimStep under = eyesUnder ? underWater(air, lookup != null && lookup.searching(),
				surface == null ? Double.NaN : surface.distance(), straightUp, shoreDistance, swimTurned >= 360.0F, peek != null) : null;
		if (under == SwimStep.STOP) {
			return fail(player, air <= SwimPlanning.AIR_RESERVE_TICKS ? "AIR_RESERVE_REACHED" : "BREATH_NOT_COVERED", String.format(Locale.ROOT,
					"Under water with %.1f s of air: %s, %s; stopped before swimming farther than the air left",
					SwimPlanning.airSecondsLeft(air), surface == null ? "no seen way up to air" : String.format(Locale.ROOT, "air %.0f blocks away", surface.distance()),
					shore == null ? "no bank seen" : String.format(Locale.ROOT, "bank at %s %.0f blocks away", cell(shore), shoreDistance)));
		}
		if (under == SwimStep.AIR || under == SwimStep.WAIT) {
			// Up to air first, along the acquired route (straight up in open water, along the steps of a flooded stair);
			// while the route is still being found, rise where it is.
			var path = surface == null ? null : surface.path();
			if (path != null && path.size() > 1) {
				BlockPos next = path.get(1);
				double dx = next.getX() + 0.5D - player.getX(), dz = next.getZ() + 0.5D - player.getZ();
				forward = dx * dx + dz * dz > 0.04D;
				if (forward) yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
			}
			pitch = SwimPlanning.SURFACING_PITCH;
		} else if (under == SwimStep.PEEK) {
			// Under a seen ceiling with no way up known: swim out into the open cell beside it, looking up, so the column
			// above that cell comes into view and the route up is acquired there. Not sprinting: a sprint-swim follows the
			// view, which here points up into the ceiling.
			peekTicks++;
			yaw = dev.agaminggod.mineagen.server.perception.WaterAirFacts.peekYaw(player, peek);
			forward = true;
			pitch = PEEK_PITCH;
			boolean jump = SwimPlanning.floatJump(inWater, player.onGround(), eyesUnder);
			apply(player, new AgentInputStates.MotorTarget(net.minecraft.util.Mth.wrapDegrees(yaw), pitch, forward, jump, false), false, false, false, nowEpochMs);
			return TickResult.running(progress(player));
		} else if (under == SwimStep.LOOK) {
			// No way up and no bank seen yet: look round once while rising, as a player turns to find the way up.
			yaw = player.getYRot() + 9.0F;
			swimTurned += 9.0F;
			pitch = SwimPlanning.SURFACING_PITCH;
		} else if (shore != null) {
			double dx = shore.x() + 0.5D - player.getX(), dz = shore.z() + 0.5D - player.getZ();
			double off = Math.hypot(dx, dz);
			// Over the bank and still not out for 4 s: it cannot be climbed from here; choose another.
			if (off < 1.5D) {
				if (nearShoreSince == 0L) nearShoreSince = nowEpochMs;
				else if (nowEpochMs - nearShoreSince > 4_000L) { refusedShores.add(shore); shore = null; nearShoreSince = 0L; }
			} else nearShoreSince = 0L;
			if (off > 0.05D) yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
			forward = off > 0.35D;
			pitch = eyesUnder ? SwimPlanning.SURFACING_PITCH : 0.0F;
			// A bank whose way leads out of the water over a drop the walking code would not take is not swum to.
			if (forward && dropAhead(world, player.getX(), Mth.floor(player.getY()), player.getZ(), yaw)) {
				refusedShores.add(shore); shore = null; nearShoreSince = 0L; forward = false;
			}
		} else if (swimTurned < 360.0F) {
			// Nothing dry seen yet: look round once, afloat, as a player turns to find the bank.
			yaw = player.getYRot() + 9.0F;
			swimTurned += 9.0F;
			pitch = eyesUnder ? SwimPlanning.SURFACING_PITCH : 10.0F;
		} else {
			yaw = (float) Math.toDegrees(Math.atan2(-(targetX - player.getX()), targetZ - player.getZ()));
			// No bank seen: on toward the target, unless that leaves the water over a drop (a waterfall's edge, a gap).
			if (dropAhead(world, player.getX(), Mth.floor(player.getY()), player.getZ(), yaw)) {
				return fail(player, "NO_ROUTE", "In water with no bank seen within " + SHORE_RADIUS
						+ " blocks, and the way toward the target leaves the water over a drop of more than " + LocalPathfinder.MAX_DROP_BLOCKS + " blocks; stopped short of it");
			}
			forward = true;
			pitch = eyesUnder ? SwimPlanning.SURFACING_PITCH : 0.0F;
		}
		boolean jump = SwimPlanning.floatJump(inWater, player.onGround(), eyesUnder) || forward && player.horizontalCollision;
		boolean sprint = SwimPlanning.swimSprint(inWater, eyesUnder, forward ? 1.0F : 0.0F, player.getFoodData().getFoodLevel());
		apply(player, new AgentInputStates.MotorTarget(net.minecraft.util.Mth.wrapDegrees(yaw), pitch, forward, jump, sprint), false, false, false, nowEpochMs);
		return TickResult.running(progress(player));
	}

	/**
	 * Open water straight up: every cell of the route to air in the body's own column (no detour round an overhead block
	 * through a neighbouring column) and each one open water or air. Anything else goes through the breath-reserve rule.
	 */
	static boolean openColumnUp(List<BlockPos> path, int x, int z, java.util.function.Predicate<BlockPos> open) {
		if (path == null || path.isEmpty()) return false;
		for (BlockPos step : path) if (step.getX() != x || step.getZ() != z || !open.test(step)) return false;
		return true;
	}

	private static boolean openWaterOrAir(Level level, BlockPos cell) {
		BlockState state = level.getBlockState(cell);
		if (state.isAir()) return true;
		return state.getFluidState().getType().isSame(net.minecraft.world.level.material.Fluids.WATER) && state.getCollisionShape(level, cell).isEmpty();
	}

	/** What a swimmer whose eyes are under water does next. */
	enum SwimStep { AIR, SHORE, PEEK, WAIT, LOOK, STOP }

	/** The view while ducking out from under a ceiling (WaterAirFacts.PEEK_PITCH), shared with the swim-up reflex. */
	static final float PEEK_PITCH = dev.agaminggod.mineagen.server.perception.WaterAirFacts.PEEK_PITCH;

	/**
	 * Air first, as a player does: under water the body rises along the seen route to air whenever its breath covers the
	 * route (a breathable target may spend the reserve), and always when the route goes straight up its own column through
	 * open water (openColumnUp: no ceiling, so stopping there only drowns it). A bank is swum to under water only when no air route is taken and the
	 * bank is within the breath left with the reserve kept. With neither, above the reserve, it rises in place while the
	 * route to air is still being found, then looks round once (the way up may be out of sight); after that, or at the
	 * reserve, it stops with its air: it never swims under a ceiling farther than its air allows.
	 */
	static SwimStep underWater(int air, boolean searching, double airRoute, boolean straightUp, double shoreDistance, boolean lookedRound) {
		return underWater(air, searching, airRoute, straightUp, shoreDistance, lookedRound, false);
	}

	/**
	 * {@code peek}: the eye's own column is capped by a seen block and a seen open cell beside it may lead up
	 * (WaterAirFacts.peekCell). With no route to air known that comes before the reserve stop and the look-round: a stop
	 * under a ceiling only drowns the body before the model can answer, and turning in place never shows the column
	 * beside it. One block across costs well under a second of air.
	 */
	static SwimStep underWater(int air, boolean searching, double airRoute, boolean straightUp, double shoreDistance, boolean lookedRound,
			boolean peek) {
		if (Double.isFinite(airRoute) && (straightUp || airRoute <= SwimPlanning.navigationBreathNodes(air, true))) return SwimStep.AIR;
		if (Double.isFinite(shoreDistance) && shoreDistance <= SwimPlanning.breathNodes(air)) return SwimStep.SHORE;
		if (peek && !Double.isFinite(airRoute)) return SwimStep.PEEK;
		if (air <= SwimPlanning.AIR_RESERVE_TICKS) return SwimStep.STOP;
		if (searching) return SwimStep.WAIT;
		return lookedRound ? SwimStep.STOP : SwimStep.LOOK;
	}

	/**
	 * The walking code's floor and drop check on the way a swimmer goes: within two blocks along yaw, an open cell (or
	 * water spilling over an edge onto open air) with no floor or water within {@link LocalPathfinder#MAX_DROP_BLOCKS}
	 * below it, or an unseen or hazard cell, is a drop it does not swim off. Water ahead, a wall or a bank face is not,
	 * and, as for walking, water below breaks a fall: a waterfall's full column is a landing (live: a 25-block fall
	 * down one, 0 damage in 3 of 3).
	 */
	static boolean dropAhead(WalkabilityView world, double x, int feetY, double z, float yaw) {
		double dx = -Math.sin(Math.toRadians(yaw)), dz = Math.cos(Math.toRadians(yaw));
		for (double reach = 1.0D; reach <= 2.0D; reach += 1.0D) {
			GridPosition ahead = new GridPosition(Mth.floor(x + dx * reach), feetY, Mth.floor(z + dz * reach));
			WalkabilityView.Cell cell = world.cellAt(ahead);
			if (cell == WalkabilityView.Cell.HAZARD || cell == WalkabilityView.Cell.UNLOADED) return true;
			if (cell == WalkabilityView.Cell.BLOCKED || cell == WalkabilityView.Cell.SAFE_SUPPORT) return false;
			boolean spills = cell == WalkabilityView.Cell.WATER && world.isBodyClear(ahead.below());
			if (cell == WalkabilityView.Cell.WATER && !spills) continue;
			return world.gapExposureCost(ahead) > 0;
		}
		return false;
	}

	/**
	 * The seen dry standing cell a swimmer can climb out onto (bordersWater: within the water-exit climb of water beside
	 * it) that leaves the least trip, the swim itself counting half. A bank behind
	 * the body loses to one across the water toward the target when both are seen.
	 */
	private GridPosition nearestShore(ServerPlayer player, MinecraftNavigationWorld world) {
		GridPosition at = feet(player);
		GridPosition best = null;
		double bestScore = Double.POSITIVE_INFINITY;
		for (int dx = -SHORE_RADIUS; dx <= SHORE_RADIUS; dx++) for (int dz = -SHORE_RADIUS; dz <= SHORE_RADIUS; dz++) {
			double flat = Math.hypot(dx, dz);
			if (flat > SHORE_RADIUS) continue;
			for (int dy = -3; dy <= 5; dy++) {
				GridPosition cell = new GridPosition(at.x() + dx, at.y() + dy, at.z() + dz);
				if (refusedShores.contains(cell) || !world.isStandable(cell) || world.cellAt(cell) == WalkabilityView.Cell.WATER) continue;
				if (!bordersWater(world, cell)) continue;
				// Crossing: never back to the bank it swam from, nor one no nearer the target.
				if (!crossingGains(crossFromLeft, left(new Vec3(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D)))) continue;
				double score = left(new Vec3(cell.x() + 0.5D, cell.y(), cell.z() + 0.5D)) + 0.5D * flat + 0.7D * Math.abs(dy);
				if (score < bestScore) { bestScore = score; best = cell; }
			}
		}
		return best;
	}

	/** Whether a bank leaving {@code leftThere} of the trip is worth swimming to on a crossing begun with {@code fromLeft} left. */
	static boolean crossingGains(double fromLeft, double leftThere) {
		return !Double.isFinite(fromLeft) || leftThere <= fromLeft - CROSS_GAIN;
	}

	/**
	 * Water a walker can wade into along {@code yaw}: open water at the feet' level or one below within two blocks, with no
	 * drop the walking code would refuse on the way (dropAhead), and nothing solid in between.
	 */
	static boolean waterAhead(WalkabilityView world, double x, int feetY, double z, float yaw) {
		if (dropAhead(world, x, feetY, z, yaw)) return false;
		double dx = -Math.sin(Math.toRadians(yaw)), dz = Math.cos(Math.toRadians(yaw));
		for (double reach = 1.0D; reach <= 2.0D; reach += 1.0D) {
			GridPosition feet = new GridPosition(Mth.floor(x + dx * reach), feetY, Mth.floor(z + dz * reach));
			WalkabilityView.Cell here = world.cellAt(feet), below = world.cellAt(feet.below());
			if (here == WalkabilityView.Cell.WATER || here == WalkabilityView.Cell.CLEAR && below == WalkabilityView.Cell.WATER) return true;
			if (here != WalkabilityView.Cell.CLEAR) return false;
		}
		return false;
	}

	/**
	 * A dry bank across the water along {@code yaw} within {@code reach}: past at least one water column, a standable cell
	 * that is not water within three blocks of the feet' level. Unloaded terrain on the way ends the look.
	 */
	static boolean bankAcross(WalkabilityView world, double x, int feetY, double z, float yaw, int reach) {
		double dx = -Math.sin(Math.toRadians(yaw)), dz = Math.cos(Math.toRadians(yaw));
		boolean water = false;
		for (int distance = 1; distance <= reach; distance++) {
			int cx = Mth.floor(x + dx * distance), cz = Mth.floor(z + dz * distance);
			boolean wet = false, unloaded = true;
			for (int dy = -3; dy <= 3; dy++) {
				GridPosition cell = new GridPosition(cx, feetY + dy, cz);
				WalkabilityView.Cell kind = world.cellAt(cell);
				if (kind != WalkabilityView.Cell.UNLOADED) unloaded = false;
				if (kind == WalkabilityView.Cell.WATER) wet = true;
			}
			if (unloaded) return false;
			if (wet) { water = true; continue; }
			if (!water) continue;
			for (int dy = -2; dy <= 3; dy++) {
				GridPosition cell = new GridPosition(cx, feetY + dy, cz);
				if (world.cellAt(cell) != WalkabilityView.Cell.WATER && world.isStandable(cell)) return true;
			}
		}
		return false;
	}

	/**
	 * A bank a swimmer reaches: water beside it whose top is within the water-exit climb of the bank's floor
	 * (SwimPlanning.climbsOut, shared with escape). On whole blocks that is water at the bank's own level or one below.
	 */
	private static boolean bordersWater(MinecraftNavigationWorld world, GridPosition cell) {
		int[][] sides = {{1, 0}, {-1, 0}, {0, 1}, {0, -1}};
		for (int[] side : sides) for (int down = 0; down <= 2; down++) {
			// Water in the cell `down` below the bank's floor level tops out at least at that cell's top face.
			if (world.cellAt(new GridPosition(cell.x() + side[0], cell.y() - down, cell.z() + side[1])) == WalkabilityView.Cell.WATER
					&& SwimPlanning.climbsOut(cell.y(), cell.y() - down + 1)) return true;
		}
		return false;
	}

	private TickResult plan(ServerPlayer player, long nowEpochMs) {
		if (onMagma(player)) apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, false, false, nowEpochMs);
		else releaseInput();
		if (!player.onGround() && !player.isInWater()) return TickResult.running(progress(player));
		// Legs, building and digging all start from footing. A body afloat or under water swims out first.
		if (inDeepWater(player)) {
			phase = Phase.SWIM;
			swimStartedAt = nowEpochMs;
			shore = null;
			swimTurned = 0.0F;
			peekTicks = 0;
			nearShoreSince = 0L;
			return swimTick(player, nowEpochMs);
		}
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
		// Legs are walked by navigation, which opens wooden doors and gates: seen ground behind one is a leg's reach.
		MinecraftNavigationWorld legs = new MinecraftNavigationWorld(player.level(), player).opensDoors();
  // The ordinary checkpoint picker accepts a height band; it would keep choosing this shaft's own floor forever.
  if(routeLeg && Double.isFinite(targetY) && targetY>player.getY()+0.6D && Math.hypot(targetX-player.getX(),targetZ-player.getZ())<0.8D) {
   if(!build) return fail(player,"NO_ROUTE","This remembered shaft needs blocks to pillar up; build is false");
   return startBuild(player,world,nowEpochMs);
  }
  if (failedLegs >= MAX_FAILED_LEGS) return fail(player, buildRefusal == null ? "NO_ROUTE" : buildRefusalCode, "No seen leg gets closer"
				+ (buildRefusal == null ? "" : ", and building cannot continue: " + buildRefusal) + lastFailureText());
		boolean buildNow = build && failedLegs >= FAILED_LEGS_BEFORE_BUILD && buildRefusal == null;
		long pickStarted = System.nanoTime();
		TravelCheckpoints.Checkpoint next = null;
		if (buildNow || onMagma(player)) checkpointSearch = null;
		else {
			if (checkpointSearch != null && !checkpointSearch.origin.equals(feet(player))) checkpointSearch = null;
			if (checkpointSearch == null) checkpointSearch = TravelCheckpoints.beginWalkingPick(legs, player.getX(), player.getY(), player.getZ(),
					targetX, targetY, targetZ, LEG_REACH, this::isRefused, sightedSpots(player));
			if (checkpointSearch != null) {
				next = checkpointSearch.advance(legs);
				if (!checkpointSearch.finished()) return TickResult.running(progress(player));
				checkpointSearch = null;
			}
		}
		if (DEBUG) LOGGER.info("TRAVEL_PICK at={} left={} next={} failedLegs={} refused={} looks={} pickMs={}", cell(feet(player)),
				format(left(player.position())), next == null ? "-" : cell(next.feet()) + " left " + format(next.left()), failedLegs, refused.size(), looks,
				format((System.nanoTime() - pickStarted) / 1.0E6D) + " columns=" + java.util.Arrays.toString(TravelCheckpoints.LAST_PICK.get()));
		if (next != null) {
			legFinal = next.finalApproach();
			startForwardLeg(player, next.feet(), nowEpochMs);
			legAllowedBacktrack += next.backtrack();
			return leg(player, nowEpochMs);
		}
		// Nothing seen gets closer: look along the bearing and either side before building (a player glances round).
		float bearing = (float) Math.toDegrees(Math.atan2(-(targetX - player.getX()), targetZ - player.getZ()));
		if (looks < 3 && !buildNow) {
			lookYaw = bearing + (looks == 0 ? 0.0F : looks == 1 ? 50.0F : -50.0F);
			looks++;
			lookTicks = 0;
			phase = Phase.LOOK;
			return look(player, nowEpochMs);
		}
		if (!onMagma(player) && failedLegs < MAX_FAILED_LEGS && (buildRefusal != null || !build)) {
			GridPosition detour = TravelCheckpoints.detour(legs, player.getX(), player.getY(), player.getZ(), targetX, targetZ, this::isRefused);
			if (detour != null) {
				refused.add(detour);
				legFinal = false;
				startForwardLeg(player, detour, nowEpochMs);
				return leg(player, nowEpochMs);
			}
		}
		if ((!build || buildRefusal != null) && crossings < MAX_CROSSINGS && !onMagma(player)
				&& waterAhead(world, player.getX(), Mth.floor(player.getY()), player.getZ(), bearing)
				&& bankAcross(world, player.getX(), Mth.floor(player.getY()), player.getZ(), bearing, CROSS_REACH)) {
			crossings++;
			crossFromLeft = left(player.position());
			wading = true;
			wadeYaw = bearing;
			phase = Phase.SWIM;
			swimStartedAt = nowEpochMs;
			shore = null;
			swimTurned = 0.0F;
			peekTicks = 0;
			nearShoreSince = 0L;
			return swimTick(player, nowEpochMs);
		}
		if (build && walkAroundEnabled() && !buildNow && buildRefusal == null && !onMagma(player) && walkArounds < MAX_WALK_AROUNDS
				&& Math.hypot(targetX - player.getX(), targetZ - player.getZ()) > WALK_AROUND_MIN_LEFT) {
			GridPosition around = TravelCheckpoints.detour(legs, player.getX(), player.getY(), player.getZ(), targetX, targetZ, this::isRefused);
			if (around != null) {
				if (walkArounds == 0) aroundFromLeft = left(player.position());
				walkArounds++;
				walkedAround++;
				refused.add(around);
				// Never straight back: from the spot round the side, the cell it left can look closer again.
				refused.add(feet(player));
				legFinal = false;
				startForwardLeg(player, around, nowEpochMs);
				return leg(player, nowEpochMs);
			}
		}
		if (!build) return fail(player, "NO_ROUTE", "No seen standing spot ahead gets closer, and build is false" + lastFailureText());
		if (descent != null && digs < MAX_DIGS && (digsDown(player.getY(), targetY, heightTolerance()) || !surfacedHere(player) && digsUp(player.getY(), targetY, heightTolerance())))
			return startDig(player, nowEpochMs);
		if (buildRefusal != null) return fail(player, buildRefusalCode, "No seen way on toward the target, and building cannot continue: " + buildRefusal + lastFailureText());
		return startBuild(player, world, nowEpochMs);
	}

	/** Toward a target below or above: a stairs dig_to toward its x/z to its y, then walking legs again from there. */
	private TickResult startDig(ServerPlayer player, long nowEpochMs) {
		releaseInput();
		try {
			dig = descent.dig((int) Math.floor(targetY), (int) Math.floor(targetX), (int) Math.floor(targetZ), Math.max(1L, timeoutMs - (nowEpochMs - startedAt)));
		} catch (dev.agaminggod.mineagen.agent.AgentDomainException refused) {
			return fail(player, refused.code(), "No seen way " + (targetY > player.getY() ? "up" : "down") + " gets closer; digging there was refused: " + refused.getMessage());
		}
		digs++;
		phase = Phase.DIG;
		return digTick(player, nowEpochMs);
	}

	private TickResult digTick(ServerPlayer player, long nowEpochMs) {
		TickResult result = dig.tick(player, nowEpochMs);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		dig = null;
		dugDown++;
		// Out under open sky: walked or built on from here, never another staircase up started on this spot (it would end at
		// once); once the body has moved (to a wall or a slope) a staircase may dig up from there.
		if (ServerDigController.OPEN_SKY_REACHED.equals(result.reasonCode())) surfacedAt = player.position();
		if (result.state() != State.SUCCEEDED) return fail(player, result.reasonCode(), "Digging down toward y " + (int) Math.floor(targetY) + ": " + result.message());
		// At the target's level: walk or build the rest from here.
		failedLegs = 0;
		walkArounds = 0;
		looks = 0;
		refused.clear();
		bestAt = nowEpochMs;
		phase = Phase.PLAN;
		return TickResult.running(progress(player));
	}

	private TickResult look(ServerPlayer player, long nowEpochMs) {
		lookTicks++;
		// Check nearby uphill footing before committing to a tunnel through the slope.
		float pitch = glanced ? lookPitch : looks == 1 ? -20.0F : ServerNavigationController.WALKING_GAZE_PITCH + 5.0F;
		apply(player, new AgentInputStates.MotorTarget(lookYaw, pitch, false, false, false), true, false, false, nowEpochMs);
		boolean settled = Math.abs(AgentInputStates.shortestAngleDelta(player.getYRot(), lookYaw)) < 3.0F
				&& Math.abs(player.getXRot() - pitch) < 3.0F;
		if (settled || lookTicks > 20) {
			if (glanced) return startBuild(player, new MinecraftNavigationWorld(player.level(), player), nowEpochMs);
			phase = Phase.PLAN;
		}
		return TickResult.running(progress(player));
	}

	/**
	 * A leg toward a picked checkpoint or detour: the only legs that keep the trip's knockback margin. A lava retreat
	 * must not stand still with the flow coming, and a build step's drop leg is already at its lip.
	 */
	private void startForwardLeg(ServerPlayer player, GridPosition feet, long nowEpochMs) {
		startLeg(player, feet, nowEpochMs, LEG_TOLERANCE);
		if (knockbackHolds != null) leg.keepsKnockbackMargin(knockbackHolds);
	}

	private void startLeg(ServerPlayer player, GridPosition feet, long nowEpochMs) {
		startLeg(player, feet, nowEpochMs, LEG_TOLERANCE);
	}

	/** A leg may seal lava in its way only when this travel may build, and then only where it may modify blocks. */
	static BiPredicate<ServerPlayer, BlockPos> legSealPermission(boolean build, BiPredicate<ServerPlayer, BlockPos> mayModify) {
		return build ? mayModify : null;
	}

	private void startLeg(ServerPlayer player, GridPosition feet, long nowEpochMs, double tolerance) {
		releaseInput();
		legTarget = feet;
		legTicks = 0;
		legStartLeft = left(player.position());
		legAllowedBacktrack = BACKTRACK;
		leg = new ServerNavigationController(new Vec3(feet.x() + 0.5D, feet.y(), feet.z() + 0.5D), tolerance, true,
				nowEpochMs, LEG_TIMEOUT_MS, true);
		BiPredicate<ServerPlayer, BlockPos> seal = legSealPermission(build, mayModify);
		if (seal != null) leg.sealsLava(seal);
		phase = Phase.LEG;
	}

	private TickResult leg(ServerPlayer player, long nowEpochMs) {
		TickResult result = leg.tick(player, nowEpochMs);
		legTicks++;
		if (result.state() == ServerController.State.RUNNING) {
			// Near a checkpoint on the way, pick the next one while still running, as a player does: a leg's own arrival
			// stops the body and waits for it to stand still before the next leg could start.
			double dx = legTarget.x() + 0.5D - player.getX(), dz = legTarget.z() + 0.5D - player.getZ();
			if (!legFinal && legTicks >= 10 && player.onGround() && leg.walking() && dx * dx + dz * dz <= LEG_HANDOFF * LEG_HANDOFF
					&& Math.abs(player.getY() - legTarget.y()) <= 1.0D
					&& legStartLeft - left(player.position()) >= PROGRESS_STEP) {
				leg.cancel(player);
				leg = null;
				legs++;
				failedLegs = 0;
				if (walkArounds > 0 && left(player.position()) < aroundFromLeft - PROGRESS_STEP) walkArounds = 0;
				looks = 0;
				buildRefusal = null;
				phase = Phase.PLAN;
				if (DEBUG) LOGGER.info("TRAVEL_HANDOFF at={} near={}", cell(feet(player)), cell(legTarget));
				return plan(player, nowEpochMs);
			}
			if (retreatCode == null && legStartLeft - left(player.position()) < -legAllowedBacktrack && player.onGround()) {
				// A verified route may initially go around a cliff. Only cancel beyond its known maximum retreat
				// plus the normal margin; a fixed three-block cap repeatedly cancelled these valid routes.
				leg.cancel(player);
				leg = null;
				legs++;
				failedLegs++;
				refused.add(legTarget);
				lastLegFailure = "backtracking toward " + cell(legTarget);
				if (DEBUG) LOGGER.info("TRAVEL_BACKTRACK at={} to={}", cell(feet(player)), cell(legTarget));
				phase = Phase.PLAN;
				return TickResult.running(progress(player));
			}
			return TickResult.running(progress(player));
		}
		leg = null;
		legs++;
		if (retreatCode != null) return startWatch(player);
		String code = result.reasonCode();
		// The step into a portal: standing in it waits for the crossing (enterPortal). The crossing itself ends every
		// action with DIMENSION_TRANSITION (ServerActionExecutor), before this controller ticks again.
		if (portalLeg && !code.equals("AGENT_DEAD")) {
			lastLegFailure = "the step in: " + code + " " + firstClause(result.message());
			return TickResult.running(progress(player));
		}
		switch (code) {
			case "AGENT_DEAD", "ACTION_DIMENSION_CHANGED", "UNSUPPORTED_NAVIGATION_MODE" -> { return fail(player, code, result.message()); }
			case "DISPLACED", "NAVIGATION_DAMAGED", "BREATH_LOW", "SURFACE_NOT_FOUND" -> { return fail(player, code, "Leg to " + cell(legTarget) + " stopped: " + result.message()); }
			default -> { }
		}
		// A leg stopped at lava it could not plug: kept for the travel's own failure text until a later leg arrives, so a
		// travel that ends after it still names the lava cell (a replan round it is fine).
		if (code.equals("LAVA_STEP")) lavaStepDetail = firstClause(result.message());
		else if (result.state() == ServerController.State.SUCCEEDED) lavaStepDetail = null;
		double gained = legStartLeft - left(player.position());
		if (DEBUG) LOGGER.info("TRAVEL_LEG to={} result={} {} gained={} msg={}", cell(legTarget), result.state(), code, format(gained), firstClause(result.message()));
		boolean noGain = result.state() == ServerController.State.SUCCEEDED && gained < NO_GAIN;
		if (!noGain && (result.state() == ServerController.State.SUCCEEDED || gained >= PROGRESS_STEP)) {
			failedLegs = 0;
			if (walkArounds > 0 && left(player.position()) < aroundFromLeft - PROGRESS_STEP) walkArounds = 0;
			looks = 0;
			buildRefusal = null;
			if (result.state() != ServerController.State.SUCCEEDED) refused.add(legTarget);
		} else {
			failedLegs++;
			refused.add(legTarget);
			lastLegFailure = noGain ? "reached " + cell(legTarget) + " but got no closer to the target"
					: code + " toward " + cell(legTarget) + ": " + firstClause(result.message());
		}
		phase = Phase.PLAN;
		return TickResult.running(progress(player));
	}

	private boolean isRefused(GridPosition cell) {
		for (GridPosition refusal : refused) {
			if (Math.abs(refusal.x() - cell.x()) <= 1 && Math.abs(refusal.z() - cell.z()) <= 1 && Math.abs(refusal.y() - cell.y()) <= 2) return true;
		}
		return false;
	}


	private TickResult startBuild(ServerPlayer player, MinecraftNavigationWorld world, long nowEpochMs) {
		GridPosition feet = feet(player);
		boolean haveBlocks = TravelBuilder.blockSlot(player) >= 0;
		int climb = Double.isFinite(targetY) ? (int) Math.floor(targetY) - feet.y() : 0;
		TravelBuilder.Plan best = null, firstRefusal = null;
		TunnelRefusal toolRefusal = null;
		boolean shaft = routeLeg && climb>0 && Math.hypot(targetX-player.getX(),targetZ-player.getZ())<0.8D;
  if(shaft) {
   if(!glanced) {
    glanced=true;lookYaw=player.getYRot();lookPitch=-90;lookTicks=0;phase=Phase.LOOK;
    return look(player,nowEpochMs);
   }
   if(failedLegs>=MAX_FAILED_LEGS) return fail(player,"NO_ROUTE","Remembered shaft could not be climbed"+(buildRefusal==null?"":": "+buildRefusal));
   // Blocked headroom under the route's own way up (a later tunnel under the stair's step, a drop it fell) is mined
   // out first when nothing seen can pour or fall in, as a player digs up into the passage it came down.
   TravelBuilder.Plan headroom=TravelBuilder.shaftHeadroom(world,states(world),feet);
   if(headroom!=null && !headroom.possible()) return fail(player,"NO_ROUTE","Remembered shaft has blocked or unseen headroom above: "+headroom.refusal()+"; no new tunnel chosen");
   if(!haveBlocks) return fail(player,"OUT_OF_BLOCKS","Remembered shaft needs a plain carried block per level to pillar up"+offHotbarText(player));
   if(headroom!=null) {
    BlockPos over=new BlockPos(feet.x(),feet.y()+2,feet.z());
    BlockState known=world.stateAt(over);
    if(!mayModify.test(player,over)) return fail(player,"NO_ROUTE","Remembered shaft has protected headroom at "+cell(over));
    TravelBuilder.ToolRefusal tool=TravelBuilder.toolRefusal(player,known);
    if(tool!=null) return fail(player,tool.code(),"Remembered shaft headroom "+BuiltInRegistries.BLOCK.getKey(known.getBlock())+" at "+cell(over)+"; "+tool.facts());
   }
   best=headroom!=null?headroom:new TravelBuilder.Plan(TravelBuilder.Kind.PILLAR,Direction.NORTH,1,null,null);
  }
  for (Direction direction : shaft ? new Direction[0] : directionsToward(player)) {
			TravelBuilder.Plan plan = TravelBuilder.decide(world, states(world), feet, direction, haveBlocks, climb);
			if (plan.possible() && plan.kind() == TravelBuilder.Kind.TUNNEL) {
				TunnelRefusal why = tunnelRefusal(player, world, feet, direction);
				if (why != null) {
					plan = TravelBuilder.Plan.refuse(direction, why.code(), why.message());
					if (why.toolProblem()) toolRefusal = why;
				}
			}
			if (plan.possible()) { best = plan; break; }
			if (!plan.possible() && firstRefusal == null) firstRefusal = plan;
		}
		if (best == null && firstRefusal != null && "unseen".equals(firstRefusal.refusalCode()) && !glanced) {
			// Look down at the cells ahead before judging them, as a player glances at the ground before stepping on.
			glanced = true;
			lookYaw = TravelBuilder.yaw(firstRefusal.direction());
			lookPitch = 40.0F;
			lookTicks = 0;
			phase = Phase.LOOK;
			return look(player, nowEpochMs);
		}
		glanced = false;
		if (best == null) {
			// Both candidate headings were considered. This is a local tool stop, not global unreachability.
			if (toolRefusal != null) return fail(player, toolRefusal.code(), "A tunnel heading needs a usable tool: " + toolRefusal.message());
			// Building is blocked here: other seen legs may still lead on, so try those before stopping.
			buildRefusalCode = firstRefusal != null && "out-of-blocks".equals(firstRefusal.refusalCode()) ? "OUT_OF_BLOCKS" : "NO_ROUTE";
			buildRefusal = (firstRefusal == null ? "no direction toward the target can be walked or built" : firstRefusal.refusal())
					+ ("OUT_OF_BLOCKS".equals(buildRefusalCode) ? offHotbarText(player) : "");
			if (DEBUG) LOGGER.info("TRAVEL_BUILD_REFUSED at={} {}", cell(feet), buildRefusal);
			phase = Phase.PLAN;
			return TickResult.running(progress(player));
		}
		if (DEBUG) LOGGER.info("TRAVEL_BUILD at={} plan={} {} count={}", cell(feet), best.kind(), best.direction(), best.count());
		move = best;
		buildDirection = best.direction();
		moveFeet = feet;
		moveTicks = 0;
		shaftSettle = shaft && best.kind() == TravelBuilder.Kind.CLEAR_UP ? 0 : -1;
		moveStage = 0;
		pillarDone = 0;
		centred = false;
		phase = Phase.BUILD;
		return buildTick(player, nowEpochMs);
	}

	/** The two horizontal directions closest to the bearing to the target, nearest first (the second within 90 degrees). */
	private Direction[] directionsToward(ServerPlayer player) {
		double dx = targetX - player.getX(), dz = targetZ - player.getZ();
		Direction first = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? Direction.EAST : Direction.WEST) : (dz >= 0 ? Direction.SOUTH : Direction.NORTH);
		Direction second = Math.abs(dx) >= Math.abs(dz) ? (dz >= 0 ? Direction.SOUTH : Direction.NORTH) : (dx >= 0 ? Direction.EAST : Direction.WEST);
		return new Direction[] {first, second};
	}

	private record TunnelRefusal(String code, String message) {
		boolean toolProblem() { return "NO_TOOL".equals(code) || "TOOL_WORN".equals(code); }
	}

	private TunnelRefusal tunnelRefusal(ServerPlayer player, MinecraftNavigationWorld world, GridPosition feet, Direction direction) {
		BlockPos body = new BlockPos(feet.x() + direction.getStepX(), feet.y(), feet.z() + direction.getStepZ());
		for (BlockPos cell : new BlockPos[] {body.above(), body}) {
			BlockState state = player.level().getBlockState(cell);
			if (state.isAir() || state.getCollisionShape(player.level(), cell).isEmpty()) continue;
			BlockState known = world.stateAt(cell);
			if (known == null) return new TunnelRefusal("NO_ROUTE", "the wall at " + cell(cell) + " is unseen");
			String why = TravelBuilder.unmineable(known);
			if (why != null) return new TunnelRefusal("NO_ROUTE", "the wall at " + cell(cell) + " cannot be mined: " + why);
			if (TravelBuilder.seenLavaBeside(world, cell)) return new TunnelRefusal("NO_ROUTE", "seen lava is beside " + cell(cell) + ", so opening it lets the lava in");
			if (!mayModify.test(player, cell)) return new TunnelRefusal("NO_ROUTE", "the block at " + cell(cell) + " is protected");
			TravelBuilder.ToolRefusal tool = TravelBuilder.toolRefusal(player, known);
			if (tool != null) return new TunnelRefusal(tool.code(), BuiltInRegistries.BLOCK.getKey(known.getBlock())
					+ " at " + cell(cell) + "; " + tool.facts());
			double[] ticks = TravelBuilder.mineTicks(player, known, known.getDestroySpeed(player.level(), cell));
			if (ticks[1] > TravelBuilder.maximumTunnelMineTicks(known)) {
				return new TunnelRefusal("NO_ROUTE", String.format(Locale.ROOT, "%s at %s takes %.1f s per block with the inventory's best tool%s",
						BuiltInRegistries.BLOCK.getKey(known.getBlock()), cell(cell), ticks[1] / 20.0D,
						ticks[1] <= TravelBuilder.maximumTunnelMineTicks(known) ? "; a better tool is in the main inventory (select_tool moves it)" : ""));
			}
		}
		return null;
	}

	private TickResult buildTick(ServerPlayer player, long nowEpochMs) {
		moveTicks++;
		TravelBuilder.Plan plan = move;
		// Bridging, filling and pillaring stand in the middle first; mining and putting out fire aim from anywhere in reach.
		boolean needsCentre = plan.kind() == TravelBuilder.Kind.BRIDGE || plan.kind() == TravelBuilder.Kind.FILL || plan.kind() == TravelBuilder.Kind.PILLAR;
		if (needsCentre && moveStage == 0 && !centred) {
			double dx = moveFeet.x() + 0.5D - player.getX(), dz = moveFeet.z() + 0.5D - player.getZ();
			if (dx * dx + dz * dz <= CENTRED * CENTRED && player.onGround()) {
				centred = true;
				moveTicks = 0;
			} else if (moveTicks > 40) {
				centred = true;
				moveTicks = 0;
			} else {
				apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), true, false, false,
						(float) Math.toDegrees(Math.atan2(-dx, dz))), true, false, false, nowEpochMs);
				return TickResult.running(progress(player));
			}
		}
		TickResult result = switch (plan.kind()) {
			case STEP, CROSS -> stepTick(player, plan.direction(), nowEpochMs);
			case BRIDGE -> bridgeTick(player, plan.direction(), nowEpochMs);
			case FILL -> fillTick(player, plan.direction(), nowEpochMs);
			case PILLAR -> pillarTick(player, nowEpochMs);
			case TUNNEL -> tunnelTick(player, plan.direction(), nowEpochMs);
			case CLEAR_UP -> clearUpTick(player, nowEpochMs);
			case EXTINGUISH -> extinguishTick(player, plan.direction(), nowEpochMs);
		};
		if (result != null) return result;
		return TickResult.running(progress(player));
	}

	/** After a move: march on in the same line while the run lasts, then try seen legs again. */
	private TickResult moveDone(ServerPlayer player, long nowEpochMs) {
		if (retreatCode != null) return startWatch(player);
		// The keys stay held between chained moves: releasing them for a tick lifts the crouch at an edge.
		buildRun += marchedCells(moveFeet, feet(player));
		lastKind = move == null ? null : move.kind();
		move = null;
		// A run goes on only while its next cell is nearer the target: past the target's line it replans (playtest 22 Nov:
		// a run west toward iron 3 blocks away stepped and tunnelled on to 8 blocks past it before turning back).
		if (!routeLeg && buildRun < BUILD_RUN && buildDirection != null && left(player.position().add(buildDirection.getStepX(), 0.0D, buildDirection.getStepZ())) < left(player.position())) {
			MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
			TravelBuilder.Plan next = TravelBuilder.decide(world, states(world), feet(player), buildDirection, TravelBuilder.blockSlot(player) >= 0,
					Double.isFinite(targetY) ? (int) Math.floor(targetY) - feet(player).y() : 0);
			if (next.possible() && next.kind() == TravelBuilder.Kind.TUNNEL && tunnelRefusal(player, world, feet(player), buildDirection) != null) next = null;
			if (DEBUG) LOGGER.info("TRAVEL_BUILD_NEXT at={} plan={} {}", cell(feet(player)), next == null ? "-" : next.kind(), next == null ? "" : next.possible() ? next.direction() : next.refusal());
			if (next != null && !next.possible() && "unseen".equals(next.refusalCode()) && !glanced) {
				// Bridging faces backwards: look ahead along the line before judging the next cell.
				glanced = true;
				lookYaw = TravelBuilder.yaw(buildDirection);
				lookPitch = 40.0F;
				lookTicks = 0;
				phase = Phase.LOOK;
				return null;
			}
			if (next != null && next.possible()) {
				// A bridge chained on in the same line is already on its centreline.
				boolean chained = next.kind() == TravelBuilder.Kind.BRIDGE && move == null && lastKind == TravelBuilder.Kind.BRIDGE;
				move = next;
				moveFeet = feet(player);
				moveTicks = 0;
				moveStage = 0;
				pillarDone = 0;
				centred = chained;
				return null;
			}
		}
		// Replanning must keep crouch held while magma still touches the feet. Releasing it for even
		// one tick dealt hotFloor damage every tenth construction step and ended otherwise valid trips.
		if (onMagma(player)) apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, false, false, nowEpochMs);
		else releaseInput();
		buildRun = 0;
		buildDirection = null;
		failedLegs = 0;
		walkArounds = 0;
		// Looks are not repeated after a build run: where nothing seen got closer before, the march itself shows more.
		// Refused legs stay refused: a leg back to where the march began was picked again after every run.
		buildRefusal = null;
		phase = Phase.PLAN;
		return null;
	}

	private TickResult moveFailed(ServerPlayer player, String why) {
		releaseInput();
		if (DEBUG) LOGGER.info("TRAVEL_MOVE_FAILED {}", why);
		buildRefusalCode = "BUILD_FAILED";
		buildRefusal = why;
		failedLegs++;
		looks = 0;
		phase = Phase.PLAN;
		return TickResult.running(progress(player));
	}

	/**
	 * When seen lava will flow into the body's own cell next, step out of its way at once (the way the body came if
	 * that is clear) and hand the trip back; the navigation refuses to step into such a cell, but a body already standing
	 * still where a flow is arriving (a tunnel just opened into hidden lava) needs to leave it.
	 */
	private TickResult lavaGuard(ServerPlayer player, long nowEpochMs) {
		if (retreatCode != null && phase != Phase.WATCH || !player.onGround()) return null;
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
		GridPosition here = feet(player);
		if (!world.lavaFillsNext(here)) return null;
		if (leg != null) { leg.cancel(player); leg = null; }
		if (retreatCode != null) {
			// Still coming after a retreat: back off again, a few times at most.
			if (++retreats > MAX_RETREATS) return fail(player, retreatCode, retreatWhy + "; the lava kept coming after " + MAX_RETREATS + " retreats");
			return retreat(player, nowEpochMs, retreatCode, retreatWhy);
		}
		return retreat(player, nowEpochMs, "LAVA_INCOMING", "Seen lava was flowing into " + cell(here));
	}

	/** Stand crouched and watch for 3 s after backing away; the lava guard backs off again if the flow still comes. */
	private TickResult startWatch(ServerPlayer player) {
		releaseInput();
		watchTicks = 0;
		phase = Phase.WATCH;
		return TickResult.running(progress(player));
	}

	private TickResult watchTick(ServerPlayer player, long nowEpochMs) {
		if (++watchTicks >= RETREAT_WATCH_TICKS) return fail(player, retreatCode, retreatWhy + "; backed out to " + cell(feet(player)) + " and the flow stopped short of it");
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, false, false, nowEpochMs);
		return TickResult.running(progress(player));
	}

	/**
	 * Back away from lava coming at the body: up to eight cells back the way the march came (Nether lava runs seven blocks
	 * along a tunnel or bridge, about two a second, slower than a walk), else the clear neighbouring cell, through the
	 * ordinary navigation; then the trip ends with {@code code}, naming where the body backed out to.
	 */
	private TickResult retreat(ServerPlayer player, long nowEpochMs, String code, String why) {
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
		GridPosition here = feet(player);
		retreatCode = code;
		retreatWhy = why;
		GridPosition behind = trailBack(world, here);
		if (behind != null) {
			if (DEBUG) LOGGER.info("TRAVEL_LAVA_RETREAT from={} to={} (trail)", cell(here), cell(behind));
			releaseInput();
			startLeg(player, behind, nowEpochMs, RETREAT_TOLERANCE);
			legFinal = true;
			return leg(player, nowEpochMs);
		}
		Direction back = buildDirection != null ? buildDirection.getOpposite() : awayFromLava(world, here);
		if (back != null) {
			for (int distance = RETREAT_CELLS; distance >= 1; distance--) {
				GridPosition cell = here.offset(back.getStepX() * distance, 0, back.getStepZ() * distance);
				if (world.isStandable(cell) && !world.lavaFillsNext(cell) && world.exposureCost(cell) == 0) {
					if (DEBUG) LOGGER.info("TRAVEL_LAVA_RETREAT from={} to={}", cell(here), cell(cell));
					releaseInput();
					startLeg(player, cell, nowEpochMs, RETREAT_TOLERANCE);
					legFinal = true;
					return leg(player, nowEpochMs);
				}
			}
		}
		return retreatToNeighbour(player, world, here, nowEpochMs);
	}

	/**
	 * Prefer a dry standing cell up to {@link #RETREAT_CELLS} cells back; use older dry ground when that
	 * section borders lava. Return null when the trail offers none at least two cells back.
	 */
	private GridPosition trailBack(MinecraftNavigationWorld world, GridPosition here) {
		return retreatAlong(new java.util.ArrayList<>(trail), here,
				cell -> world.isStandable(cell) && !world.lavaFillsNext(cell) && world.exposureCost(cell) == 0);
	}

	/** Keep the normal eight-cell retreat, but continue back to older dry ground when those cells border lava. */
	static GridPosition retreatAlong(java.util.List<GridPosition> walked, GridPosition here,
			java.util.function.Predicate<GridPosition> safe) {
		int from = walked.lastIndexOf(here);
		if (from < 0) from = walked.size();
		int preferred = Math.max(0, from - RETREAT_CELLS);
		for (int index = preferred; index <= from - 2; index++) if (safe.test(walked.get(index))) return walked.get(index);
		for (int index = preferred - 1; index >= 0; index--) if (safe.test(walked.get(index))) return walked.get(index);
		return null;
	}

	/** The horizontal direction away from seen lava beside the feet or head (or one step down beside them), or null. */
	private static Direction awayFromLava(MinecraftNavigationWorld world, GridPosition here) {
		for (Direction side : Direction.Plane.HORIZONTAL) {
			for (int dy = -1; dy <= 1; dy++) {
				BlockState state = world.stateAt(new BlockPos(here.x() + side.getStepX(), here.y() + dy, here.z() + side.getStepZ()));
				if (TravelBuilder.lava(state)) return side.getOpposite();
			}
		}
		return null;
	}

	private TickResult retreatToNeighbour(ServerPlayer player, MinecraftNavigationWorld world, GridPosition here, long nowEpochMs) {
		GridPosition best = null;
		Direction bestDirection = null;
		int bestRise = 0;
		double bestScore = Double.POSITIVE_INFINITY;
		for (Direction side : Direction.Plane.HORIZONTAL) {
			for (int rise : new int[] {0, -1, 1}) {
				GridPosition next = here.offset(side.getStepX(), rise, side.getStepZ());
				if (!world.isStandable(next) || world.lavaFillsNext(next)) continue;
				if (rise == 1 && !world.isBodyClear(here.above(2))) continue;
				double score = (buildDirection != null && side == buildDirection.getOpposite() ? 0.0D : 1.0D) + world.exposureCost(next) / 100.0D + Math.abs(rise) * 0.5D;
				if (score < bestScore) { bestScore = score; best = next; bestDirection = side; bestRise = rise; }
				break;
			}
		}
		if (best == null) return fail(player, retreatCode, retreatWhy + "; no seen standing cell beside it is clear of the lava");
		if (DEBUG) LOGGER.info("TRAVEL_LAVA_RETREAT from={} to={}", cell(here), cell(best));
		retreatFrom = here;
		move = new TravelBuilder.Plan(TravelBuilder.Kind.STEP, bestDirection, bestRise, null, null);
		moveFeet = here;
		moveTicks = 0;
		moveStage = 0;
		phase = Phase.BUILD;
		return null;
	}

	/**
	 * Walk one cell along the line (a step up is jumped). A level step that starts off the line's centre beside a drop
	 * sneaks, so an edge never takes the body; one that starts on the centreline walks straight along the axis at full
	 * pace (sneaking every step of a one-wide bridge made a march 1.3 blocks/s instead of 4.3).
	 */
	private TickResult stepTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		if (moveTicks == 1) {
			stepSpan = 1;
			if (move.kind() == TravelBuilder.Kind.STEP && move.count() == 0) {
				MinecraftNavigationWorld seen = new MinecraftNavigationWorld(player.level(), player);
				for (int span = 1; span <= 10; span++) {
					GridPosition at = moveFeet.offset(direction.getStepX() * span, 0, direction.getStepZ() * span);
					if (!seen.isStandable(at) || seen.exposureCost(at) > 0 || edgeBeside(seen, at)) break;
					stepSpan = span;
				}
			}
		}
		GridPosition goal = moveFeet.offset(direction.getStepX() * stepSpan, move.count(), direction.getStepZ() * stepSpan);
		if (move.count() < 0) {
			// Sneaking at a down-step lip can never leave the old support. Ordinary navigation already owns
			// the guarded drop and its runout brake, so use it instead of repeatedly completing a false step.
			legFinal = true;
			startLeg(player, goal, nowEpochMs);
			return leg(player, nowEpochMs);
		}
		double dx = goal.x() + 0.5D - player.getX(), dz = goal.z() + 0.5D - player.getZ();
		// Done on the goal's column within a block of its height: soul sand, slabs or a stale cell can put the feet a level
		// off the plan, and waiting for the exact height left the step stuck; the next move is judged from where it stands.
		if (stepArrived(player.position(), feet(player), goal, player.onGround())) return moveDone(player, nowEpochMs);
		if (moveTicks > 80) return moveFailed(player, "Could not step onto " + cell(goal));
		if (moveTicks == 1) {
			MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
			double lateral = direction.getStepX() != 0 ? player.getZ() - (moveFeet.z() + 0.5D) : player.getX() - (moveFeet.x() + 0.5D);
			GridPosition past = goal.offset(direction.getStepX(), 0, direction.getStepZ());
			boolean wallRunout = world.cellAt(past) == WalkabilityView.Cell.SAFE_SUPPORT
					|| world.cellAt(past.offset(0, 1, 0)) == WalkabilityView.Cell.SAFE_SUPPORT;
			stepSneak = move.kind() == TravelBuilder.Kind.CROSS
					|| move.count() == 0 && Math.abs(lateral) > STEP_LINE && (edgeBeside(world, moveFeet) || edgeBeside(world, goal))
					|| !world.isStandable(past) && !wallRunout || world.exposureCost(past) > 0;
		}
		// Steer along the axis toward the goal's centre: a level step keeps to its line.
		float yaw = (float) Math.toDegrees(Math.atan2(-dx, dz));
		boolean jump = goal.y() > moveFeet.y() && player.onGround() && dx * dx + dz * dz < 1.44D && feet(player).y() < goal.y();
		apply(player, new AgentInputStates.MotorTarget(yaw, 30.0F, true, jump, stepSpan >= 4 && dx * dx + dz * dz > 4.0D && !stepSneak && player.getFoodData().getFoodLevel() > SPRINT_FOOD), stepSneak, false, false, nowEpochMs);
		return null;
	}

	/** A batched step spends its actual cells, while a stationary mining or fire-clearing move spends none. */
	static int marchedCells(GridPosition from, GridPosition to) {
		return Math.max(Math.abs(to.x() - from.x()), Math.max(Math.abs(to.y() - from.y()), Math.abs(to.z() - from.z())));
	}

	static boolean stepArrived(Vec3 position, GridPosition support, GridPosition goal, boolean onGround) {
		double dx = goal.x() + 0.5D - position.x, dz = goal.z() + 0.5D - position.z;
		return onGround && support.x() == goal.x() && support.z() == goal.z()
				&& Math.abs(support.y() - goal.y()) <= 1 && dx * dx + dz * dz < 0.09D;
	}

	/** Whether an open cell with no seen support (a drop, or unseen ground) is beside this standing cell. */
	static boolean edgeBeside(WalkabilityView world, GridPosition cell) {
		for (Direction side : Direction.Plane.HORIZONTAL) {
			GridPosition next = cell.offset(side.getStepX(), 0, side.getStepZ());
			if (world.isBodyClear(next) && world.cellAt(next.below()) != WalkabilityView.Cell.SAFE_SUPPORT) return true;
			if (world.cellAt(next) == WalkabilityView.Cell.UNLOADED) return true;
		}
		return false;
	}

	/**
	 * Sneak-bridging: face back along the bridge, back to the edge of the block underfoot (sneak stops the body at the
	 * lip), and click the held block on that block's outer side face once the crosshair is on it; then step back onto the
	 * new block. Stage 0 selects the block, 1 backs to the edge and places, 2 steps onto it.
	 */
	private TickResult bridgeTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		BlockPos support = new BlockPos(moveFeet.x(), moveFeet.y() - 1, moveFeet.z());
		BlockPos placed = support.relative(direction);
		if (moveStage == 0) {
			int slot = TravelBuilder.blockSlot(player);
			if (slot < 0) return fail(player, "OUT_OF_BLOCKS", "No plain block left on the hotbar to bridge " + cell(placed) + offHotbarText(player));
			if (!mayModify.test(player, placed)) return moveFailed(player, "Placing at " + cell(placed) + " is protected");
			slot = select(player, slot, nowEpochMs);
			if (player.getInventory().getSelectedSlot() == slot) {
				moveStage = 1;
				bridgeAttachment = bridgeAttachment(player, placed);
				float[] view = bridgeAttachment == null ? new float[] {TravelBuilder.yaw(direction.getOpposite()), bridgePitch()}
						: TravelBuilder.lookAt(player.getEyePosition(), bridgeAttachment.getLocation());
				bridgeViewYaw = view[0]; bridgeViewPitch = view[1];
			}
			return null;
		}
		float back = TravelBuilder.yaw(direction.getOpposite());
		if (moveStage == 1) {
			if (solid(player, placed)) { moveStage = 2; return null; }
			if (moveTicks > 120) return moveFailed(player, "Could not reach a view of the side of " + cell(support) + " to bridge " + cell(placed));
			BlockHitResult hit = TravelBuilder.crosshair(player);
			if (bridgeAttachment != null) {
				// A visible wall beside the gap takes the block without turning away from the tunnel just mined.
				boolean onFace = hit != null && hit.getBlockPos().equals(bridgeAttachment.getBlockPos())
						&& hit.getDirection() == bridgeAttachment.getDirection();
				if (onFace && player.onGround() && !player.getBoundingBox().intersects(new AABB(placed))) {
					click(player, hit);
					if (solid(player, placed)) { bridged++; moveStage = 2; }
				}
				apply(player, new AgentInputStates.MotorTarget(bridgeViewYaw, bridgeViewPitch, false, false, false), true, false, false, nowEpochMs);
				return null;
			}
			boolean onFace = hit != null && hit.getBlockPos().equals(support) && hit.getDirection() == direction;
			if (onFace && player.onGround() && !player.getBoundingBox().intersects(new AABB(placed))) {
				click(player, hit);
				if (solid(player, placed)) { bridged++; moveStage = 2; }
				apply(player, new AgentInputStates.MotorTarget(back, bridgePitch(), false, false, false), true, false, false, nowEpochMs);
				return null;
			}
			// Back toward the middle of the gap cell (which also corrects sideways drift), view down onto the edge;
			// sneak holds the body on the block.
			double gx = moveFeet.x() + 0.5D + direction.getStepX() - player.getX(), gz = moveFeet.z() + 0.5D + direction.getStepZ() - player.getZ();
			double alongSupport = (player.getX() - moveFeet.x() - 0.5D) * direction.getStepX()
					+ (player.getZ() - moveFeet.z() - 0.5D) * direction.getStepZ();
			// Walk the supported centre, then sneak before the lip; the brink guard still owns lethal edges.
			apply(player, new AgentInputStates.MotorTarget(back, bridgePitch(), true, false, false, (float) Math.toDegrees(Math.atan2(-gx, gz))), alongSupport >= 0.25D, false, false, nowEpochMs);
			return null;
		}
		// Stage 2 walks onto the placed block up to its centre. Only an overshoot needs sneak; the far edge is
		// still half a block away when this move hands off to the next placement (which sneaks before its lip).
		GridPosition onto = moveFeet.offset(direction.getStepX(), 0, direction.getStepZ());
		double dx = onto.x() + 0.5D - player.getX(), dz = onto.z() + 0.5D - player.getZ();
		double along = -(dx * direction.getStepX() + dz * direction.getStepZ());
		if (along > -0.15D && player.onGround() && feet(player).equals(onto)) return moveDone(player, nowEpochMs);
		if (moveTicks > 200) return moveFailed(player, "Could not step onto the bridge block at " + cell(placed));
		apply(player, new AgentInputStates.MotorTarget(bridgeViewYaw, bridgeViewPitch, true, false, false, (float) Math.toDegrees(Math.atan2(-dx, dz))), along > 0.0D, false, false, nowEpochMs);
		return null;
	}

	/** A remembered full face beside the gap, still directly visible and within vanilla placement reach. */
	private BlockHitResult bridgeAttachment(ServerPlayer player, BlockPos placed) {
		MinecraftNavigationWorld seen = new MinecraftNavigationWorld(player.level(), player);
		Vec3 eye = player.getEyePosition();
		BlockHitResult best = null;
		double bestTurn = Double.POSITIVE_INFINITY;
		for (Direction side : Direction.Plane.HORIZONTAL) {
			BlockPos anchor = placed.relative(side);
			BlockState state = seen.stateAt(anchor);
			if (state == null || !state.isCollisionShapeFullBlock(player.level(), anchor)) continue;
			Direction face = side.getOpposite();
			Vec3 normal = new Vec3(face.getStepX(), face.getStepY(), face.getStepZ());
			Vec3 point = Vec3.atCenterOf(anchor).add(normal.scale(0.5D));
			if (eye.distanceTo(point) > player.blockInteractionRange()) continue;
			BlockHitResult hit = player.level().clip(new ClipContext(eye, point.subtract(normal.scale(0.01D)),
					ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
			if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(anchor) || hit.getDirection() != face) continue;
			float[] look = TravelBuilder.lookAt(eye, point);
			double turn = Math.abs(AgentInputStates.shortestAngleDelta(player.getYRot(), look[0])) + Math.abs(player.getXRot() - look[1]);
			if (turn < bestTurn) { best = hit; bestTurn = turn; }
		}
		return best;
	}

	/**
	 * Fill a one-deep hole ahead: stand back from it (crouched), look down at its floor and click a block onto it, then
	 * step onto the filled cell. Stage 0 selects the block, 1 places, 2 steps on.
	 */
	private TickResult fillTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		BlockPos hole = new BlockPos(moveFeet.x() + direction.getStepX(), moveFeet.y() - 1, moveFeet.z() + direction.getStepZ());
		if (moveStage == 0) {
			int slot = TravelBuilder.blockSlot(player);
			if (slot < 0) return fail(player, "OUT_OF_BLOCKS", "No plain block left on the hotbar to fill " + cell(hole) + offHotbarText(player));
			if (!mayModify.test(player, hole)) return moveFailed(player, "Placing at " + cell(hole) + " is protected");
			slot = select(player, slot, nowEpochMs);
			if (player.getInventory().getSelectedSlot() == slot) moveStage = 1;
			return null;
		}
		if (moveStage == 1) {
			if (solid(player, hole)) { moveStage = 2; return null; }
			if (moveTicks > 100) return moveFailed(player, "Could not place a block into the hole at " + cell(hole));
			float[] look = TravelBuilder.lookAt(player.getEyePosition(), new Vec3(hole.getX() + 0.5D, hole.getY() + 0.02D, hole.getZ() + 0.5D));
			boolean overlaps = player.getBoundingBox().intersects(new AABB(hole));
			BlockHitResult hit = TravelBuilder.crosshair(player);
			if (!overlaps && hit != null && hit.getBlockPos().equals(hole.below()) && hit.getDirection() == Direction.UP && player.onGround()) {
				click(player, hit);
				if (solid(player, hole)) { bridged++; moveStage = 2; }
			}
			// Back off the hole's edge while the body still dips into it; otherwise hold still and aim.
			apply(player, new AgentInputStates.MotorTarget(look[0], look[1], overlaps, false, false,
					overlaps ? TravelBuilder.yaw(direction.getOpposite()) : Float.NaN), true, false, false, nowEpochMs);
			return null;
		}
		move = new TravelBuilder.Plan(TravelBuilder.Kind.STEP, direction, 0, null, null);
		moveTicks = 0;
		return null;
	}

	/** Steep enough that the view from past the edge meets the side face below the feet. */
	private static float bridgePitch() {
		return 81.0F;
	}

	/** Pillar up {@code count} blocks: look straight down, jump, and place under the feet at the top of the jump. */
	private TickResult pillarTick(ServerPlayer player, long nowEpochMs) {
		GridPosition current = feet(player);
		if (moveStage == 0) {
			int slot = TravelBuilder.blockSlot(player);
			if (slot < 0) return fail(player, "OUT_OF_BLOCKS", "No plain block left on the hotbar to pillar at " + cell(current) + offHotbarText(player));
			slot = select(player, slot, nowEpochMs);
			if (player.getInventory().getSelectedSlot() == slot && player.onGround()) {
				moveStage = 1;
				moveFeet = current;
				moveTicks = 0;
			}
			return null;
		}
		if (moveTicks > 60) return moveFailed(player, "Could not pillar up at " + cell(moveFeet));
		BlockPos cellBelow = new BlockPos(moveFeet.x(), moveFeet.y(), moveFeet.z());
		if (solid(player, cellBelow) && player.onGround() && current.y() > moveFeet.y()) {
			pillared++;
			// Done climbing once the ledge is a step up.
			if (++pillarDone >= move.count()) return moveDone(player, nowEpochMs);
			moveStage = 0;
			return null;
		}
		if (player.onGround() && current.y() == moveFeet.y()) {
			// Jump only with the centre over the block underfoot: the brink guard lets the body's own jump run, and a jump
			// from a lip lands on nothing.
			BlockPos under = BlockPos.containing(player.getX(), moveFeet.y() - 1, player.getZ());
			if (player.level().getBlockState(under).getCollisionShape(player.level(), under).isEmpty()) {
				double dx = moveFeet.x() + 0.5D - player.getX(), dz = moveFeet.z() + 0.5D - player.getZ();
				apply(player, new AgentInputStates.MotorTarget(player.getYRot(), 90.0F, true, false, false,
						(float) Math.toDegrees(Math.atan2(-dx, dz))), true, false, false, nowEpochMs);
				return null;
			}
		}
		boolean high = player.getY() >= moveFeet.y() + 1.0D + 1.0E-3D;
		BlockHitResult hit = TravelBuilder.crosshair(player);
		if (high && hit != null && hit.getDirection() == Direction.UP && hit.getBlockPos().equals(cellBelow.below())
				&& mayModify.test(player, cellBelow)) {
			click(player, hit);
		}
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), 90.0F, false, player.onGround() && player.getXRot() > 85.0F, false), true, false, false, nowEpochMs);
		return null;
	}

	/** Mine a short visible run within vanilla reach, then watch every opening before walking into the batch. */
	private TickResult tunnelTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		if (moveTicks == 1) { tunnelWatch = 0; tunnelReach = 1; tunnelDug.clear(); besideTicks = 0; }
		BlockPos body = new BlockPos(moveFeet.x() + direction.getStepX(), moveFeet.y(), moveFeet.z() + direction.getStepZ());
		BlockPos target = null;
		GridPosition diggingCell = moveFeet.offset(direction.getStepX(), 0, direction.getStepZ());
		MinecraftNavigationWorld world = new MinecraftNavigationWorld(player.level(), player);
		// Clear the head row first, then the feet row near to far: this keeps the crosshair near one height
		// instead of swinging between head and feet for every block. Each ray still stops at an occluding block.
		int headReach = 0;
		tunnelReach = 0;
		choose: for (int row : new int[] {1, 0}) {
			for (int distance = 1; distance <= (row == 1 ? 4 : headReach); distance++) {
				BlockPos nextBody = body.relative(direction, distance - 1), cell = nextBody.above(row);
				BlockState known = world.stateAt(cell);
				if (known == null) break;
				if (!player.level().getBlockState(cell).getFluidState().isEmpty()) {
					// Nether lava safety: lava pouring into the cut is plugged with a block, as a player does, before
					// backing off; two of six lava deaths with no mob near followed TUNNEL_FLOODED.
					if (LavaStep.lava(player.level().getBlockState(cell))) {
						// The nearest lava around the body or in the cut is plugged first; the travel ends plugged only when
						// every one of those cells is dry, otherwise it backs off.
						java.util.function.Predicate<BlockPos> isLava = at -> LavaStep.lava(player.level().getBlockState(at));
						BlockPos cutFeet = new BlockPos(moveFeet.x(), moveFeet.y(), moveFeet.z());
						BlockPos nearest = lavaToPlug(isLava, player.getBoundingBox(), cutFeet, direction);
						Boolean plugged = plugLava(player, nearest == null ? cell : nearest, nowEpochMs);
						if (plugged == null) return null;
						if (plugged && lavaToPlug(isLava, player.getBoundingBox(), cutFeet, direction) == null)
							return fail(player, "TUNNEL_LAVA_PLUGGED", "Lava flowed into the opened tunnel at " + cell(cell)
									+ "; plugged it with a block and did not go on this way");
					}
					return retreat(player, nowEpochMs, "TUNNEL_FLOODED", "Fluid flowed into the opened tunnel at " + cell(cell) + "; not entered");
				}
				if (!known.getCollisionShape(player.level(), cell).isEmpty()) {
					if (TravelBuilder.unmineable(known) != null || TravelBuilder.seenLavaBeside(world, cell)
							|| !mayModify.test(player, cell) || player.getEyePosition().distanceTo(Vec3.atCenterOf(cell)) > 4.5D
							|| TravelBuilder.mineTicks(player, known, known.getDestroySpeed(player.level(), cell))[1] > TravelBuilder.maximumTunnelMineTicks(known)) break;
					target = cell;
					diggingCell = moveFeet.offset(direction.getStepX() * distance, 0, direction.getStepZ() * distance);
					break choose;
				}
				if (row == 1) headReach = distance;
				else tunnelReach = distance;
			}
		}
		if (target == null) {
			// The full d35 observation window follows the LAST mining input in the batch. No freshly mined
			// cell is entered while this runs, including cells farther down the same visible opening.
			if (tunnelWatch++ < TUNNEL_WATCH_TICKS) {
				BlockPos end = body.relative(direction, Math.max(0, tunnelReach - 1));
				float[] into = TravelBuilder.lookAt(player.getEyePosition(), Vec3.atCenterOf(end).add(direction.getStepX() * 0.5D, 0, direction.getStepZ() * 0.5D));
				apply(player, new AgentInputStates.MotorTarget(into[0], into[1], false, false, false), true, false, false, nowEpochMs);
				return null;
			}
			tunnelWatch = 0;
			for (GridPosition dug : tunnelDug) {
				BlockState foot = world.stateAt(new BlockPos(dug.x(), dug.y(), dug.z()));
				if (foot != null && foot.isAir()) tunnelled++;
			}
			dev.agaminggod.mineagen.server.perception.RouteMemory.of(player).mark(player, "mined tunnel: pickaxe if obstructed on return");
			return moveDone(player, nowEpochMs);
		}
		tunnelWatch = 0;
		tunnelDug.add(diggingCell);
		BlockState state = player.level().getBlockState(target);
		if (dev.agaminggod.mineagen.server.runtime.TargetSightline.block(player.level(), net.minecraft.world.phys.shapes.CollisionContext.of(player),
				player.getEyePosition(), target, player.blockInteractionRange(), null) != null) {
			String harvestStop = dev.agaminggod.mineagen.server.runtime.OreHarvestFacts.stopReason(player, state, target);
			if (harvestStop != null) return fail(player, "ORE_TOOL_REQUIRED", harvestStop);
		}
		int slot = TravelBuilder.toolSlot(player, state);
		if (player.getInventory().getSelectedSlot() != slot) {
			select(player, slot, nowEpochMs);
			return null;
		}
		float perTick = state.getDestroyProgress(player, player.level(), target);
		if (perTick <= 0.0F || 1.0F / perTick > TravelBuilder.MAX_MINE_TICKS) {
			return moveFailed(player, "Mining " + BuiltInRegistries.BLOCK.getKey(state.getBlock()) + " at " + cell(target) + " would take over " + TravelBuilder.MAX_MINE_TICKS / 20 + " s with the inventory's best tool");
		}
		if (moveTicks > 400) return moveFailed(player, "Could not mine through " + cell(target));
		// Aim near eye height on the visible block face, rather than swinging to each block's centre.
		float[] look = TravelBuilder.lookAt(player.getEyePosition(), TravelBuilder.miningAim(player.getEyePosition(), target));
		BlockHitResult hit = TravelBuilder.crosshair(player);
		boolean aimed = hit != null && hit.getBlockPos().equals(target);
		if (aimed) work++;
		apply(player, new AgentInputStates.MotorTarget(look[0], look[1], false, false, false), true, aimed, false, nowEpochMs);
		return null;
	}

	private static final int SHAFT_SETTLE_TICKS = 40;

	/** Mine the block over the head (a low ceiling over feet-level lava ahead), then judge the line again. */
	private TickResult clearUpTick(ServerPlayer player, long nowEpochMs) {
		BlockPos over = new BlockPos(moveFeet.x(), moveFeet.y() + 2, moveFeet.z());
		BlockState state = player.level().getBlockState(over);
		if (shaftSettle >= 0 && (LavaStep.lava(state) || state.getCollisionShape(player.level(), over).isEmpty() && LavaStep.lava(player.level().getBlockState(over.above())))) {
			// Lava the mined shaft headroom let in, or showed right above the opening once mined: as the tunnel does, plug it with a
			// block (the opening first, once lava is in it) before ending; when it cannot be plugged, back out from under it.
			BlockPos lava = LavaStep.lava(state) ? over : over.above();
			Boolean plugged = plugLava(player, lava, nowEpochMs);
			if (plugged == null) return null;
			if (plugged && !LavaStep.lava(player.level().getBlockState(over))
					&& (!player.level().getBlockState(over).getCollisionShape(player.level(), over).isEmpty() || !LavaStep.lava(player.level().getBlockState(over.above()))))
				return fail(player, "TUNNEL_LAVA_PLUGGED", "Lava above the mined headroom at " + cell(lava) + "; plugged it with a block and did not climb this way");
			if (!plugged) return retreat(player, nowEpochMs, "TUNNEL_FLOODED", "Lava above the mined headroom at " + cell(lava) + "; backed out from under it");
			return null;
		}
		if (state.getCollisionShape(player.level(), over).isEmpty()) {
			if (!state.getFluidState().isEmpty()) return fail(player, "TUNNEL_FLOODED", "Fluid flowed in above the head at " + cell(over));
			if (shaftSettle >= 0) {
				// The mined shaft headroom hid the cell above it. Looking up through the opening, the body now sees that cell:
				// fluid or a falling block there refuses the climb, and it watches long enough (lava spreads every 30 ticks in
				// the Overworld, 10 in the Nether) for anything beside the opening to pour in before it pillars into it.
				BlockPos next = over.above();
				BlockState above = player.level().getBlockState(next);
				// Lava there is plugged above; water only wets the climb, which ends here.
				if (!above.getFluidState().isEmpty()) return fail(player, "TUNNEL_FLOODED", "Fluid above the mined headroom at " + cell(next));
				if (above.getBlock() instanceof net.minecraft.world.level.block.Fallable)
					return fail(player, "NO_ROUTE", "Remembered shaft has " + BuiltInRegistries.BLOCK.getKey(above.getBlock()).getPath() + " above the mined headroom at " + cell(next));
				if (++shaftSettle < SHAFT_SETTLE_TICKS) {
					apply(player, new AgentInputStates.MotorTarget(player.getYRot(), -90.0F, false, false, false), true, false, false, nowEpochMs);
					return null;
				}
				shaftSettle = -1;
			}
			return moveDone(player, nowEpochMs);
		}
		String why = TravelBuilder.unmineable(state);
		if (why != null || !mayModify.test(player, over)) return moveFailed(player, "Cannot mine the block over the head at " + cell(over) + (why == null ? ": protected" : ": " + why));
		if (dev.agaminggod.mineagen.server.runtime.TargetSightline.block(player.level(), net.minecraft.world.phys.shapes.CollisionContext.of(player),
				player.getEyePosition(), over, player.blockInteractionRange(), null) != null) {
			String harvestStop = dev.agaminggod.mineagen.server.runtime.OreHarvestFacts.stopReason(player, state, over);
			if (harvestStop != null) return fail(player, "ORE_TOOL_REQUIRED", harvestStop);
		}
		int slot = TravelBuilder.toolSlot(player, state);
		if (player.getInventory().getSelectedSlot() != slot) { select(player, slot, nowEpochMs); return null; }
		float perTick = state.getDestroyProgress(player, player.level(), over);
		if (perTick <= 0.0F || 1.0F / perTick > TravelBuilder.MAX_MINE_TICKS || moveTicks > 200) return moveFailed(player, "Could not mine the block over the head at " + cell(over));
		BlockHitResult hit = TravelBuilder.crosshair(player);
		boolean aimed = hit != null && hit.getBlockPos().equals(over);
		if (aimed) work++;
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), -90.0F, false, false, false), true, aimed, false, nowEpochMs);
		return null;
	}

	/** Punch out fire in the cell ahead (fire breaks at once to a hit on its flame), then step on. */
	private TickResult extinguishTick(ServerPlayer player, Direction direction, long nowEpochMs) {
		BlockPos flame = new BlockPos(moveFeet.x() + direction.getStepX(), moveFeet.y(), moveFeet.z() + direction.getStepZ());
		if (!TravelBuilder.fire(player.level().getBlockState(flame))) {
			return moveDone(player, nowEpochMs);
		}
		if (moveTicks > 60) return moveFailed(player, "Could not put out the fire at " + cell(flame));
		if (!mayModify.test(player, flame)) return moveFailed(player, "The fire at " + cell(flame) + " is protected");
		float[] look = TravelBuilder.lookAt(player.getEyePosition(), new Vec3(flame.getX() + 0.5D, flame.getY() + 0.03D, flame.getZ() + 0.5D));
		BlockHitResult hit = TravelBuilder.crosshair(player);
		boolean aimed = hit != null && hit.getBlockPos().equals(flame);
		if (aimed) work++;
		apply(player, new AgentInputStates.MotorTarget(look[0], look[1], false, false, false), true, aimed, false, nowEpochMs);
		return null;
	}

	private static java.util.function.Function<GridPosition, BlockState> states(MinecraftNavigationWorld world) {
		return cell -> world.stateAt(new BlockPos(cell.x(), cell.y(), cell.z()));
	}

	/** One placing click; a block that appears counts as work for the stall watchdog. */
	private boolean click(ServerPlayer player, BlockHitResult hit) {
		boolean placed = TravelBuilder.click(player, hit);
		if (placed) work++;
		return placed;
	}

	/**
	 * Place a hotbar building block into a lava cell the tunnel let in: null while turning, selecting and clicking, true
	 * once the cell holds a block, false when it cannot be done (no block on the hotbar, no solid face beside it in
	 * reach, protection, or 2 s spent).
	 */
	private Boolean plugLava(ServerPlayer player, BlockPos cell, long nowEpochMs) {
		if (!cell.equals(plugCell)) { plugCell = cell.immutable(); plugTicks = 0; plugClicked = false; }
		if (!LavaStep.lava(player.level().getBlockState(cell))) return true;
		if (++plugTicks > 40) return false;
		// Lava in any feet or head cell beside the body: standing still to aim is only worth it while a block lands soon.
		// The beside clock runs across plug targets, so retargeting never restarts it while lava stays beside the body.
		boolean beside = lavaBeside(at -> LavaStep.lava(player.level().getBlockState(at)), player.getBoundingBox());
		besideTicks = besideTicks(besideTicks, beside);
		if (plugGivesUp(beside, besideTicks, plugClicked)) return false;
		int slot = -1;
		for (int hotbar = 0; hotbar < 9 && slot < 0; hotbar++) if (TravelBuilder.buildingBlock(player.getInventory().getItem(hotbar))) slot = hotbar;
		if (slot < 0 || !mayModify.test(player, cell)) return false;
		var level = player.level();
		// The first face in preference order that is in reach.
		Direction face = null;
		Vec3 aim = null;
		for (Direction option : LavaStep.sealFaces(cell, at -> level.getBlockState(at).isCollisionShapeFullBlock(level, at))) {
			BlockPos at = cell.relative(option.getOpposite());
			Vec3 point = Vec3.atCenterOf(at).add(option.getStepX() * 0.499D, option.getStepY() * 0.499D, option.getStepZ() * 0.499D);
			if (point.distanceToSqr(player.getEyePosition()) <= LavaStep.SEAL_REACH_SQUARED) { face = option; aim = point; break; }
		}
		if (face == null) return false;
		BlockPos support = cell.relative(face.getOpposite());
		if (player.getInventory().getSelectedSlot() != slot) { select(player, slot, nowEpochMs); return null; }
		float[] look = TravelBuilder.lookAt(player.getEyePosition(), aim);
		apply(player, new AgentInputStates.MotorTarget(look[0], look[1], false, false, false), true, false, false, nowEpochMs);
		BlockHitResult hit = TravelBuilder.crosshair(player);
		if (hit != null && hit.getBlockPos().equals(support) && hit.getDirection() == face) {
			// The same gates as a normal placement, for the lava cell and its support, right before the click.
			if (LavaStep.placementDenied(player, cell, support, mayModify) != null) return false;
			if (click(player, hit)) plugClicked = true;
		}
		return LavaStep.lava(player.level().getBlockState(cell)) ? null : true;
	}

	/**
	 * The cells beside the body: every cell one block out from its hitbox, at every height the hitbox spans (a body on a
	 * slab reaches three rows), minus the cells the hitbox itself is in.
	 */
	private static java.util.List<BlockPos> besideCells(AABB body) {
		AABB box = body.deflate(1.0E-3D);
		java.util.List<BlockPos> cells = new java.util.ArrayList<>();
		for (int y = net.minecraft.util.Mth.floor(box.minY); y <= net.minecraft.util.Mth.floor(box.maxY); y++)
			for (int x = net.minecraft.util.Mth.floor(box.minX) - 1; x <= net.minecraft.util.Mth.floor(box.maxX) + 1; x++)
				for (int z = net.minecraft.util.Mth.floor(box.minZ) - 1; z <= net.minecraft.util.Mth.floor(box.maxZ) + 1; z++) {
					boolean inside = x >= net.minecraft.util.Mth.floor(box.minX) && x <= net.minecraft.util.Mth.floor(box.maxX)
							&& z >= net.minecraft.util.Mth.floor(box.minZ) && z <= net.minecraft.util.Mth.floor(box.maxZ);
					if (!inside) cells.add(new BlockPos(x, y, z));
				}
		return cells;
	}

	/** The lava cell nearest the body among the cells beside its hitbox and the cut ahead of {@code cutFeet}, or null. */
	static BlockPos lavaToPlug(java.util.function.Predicate<BlockPos> lava, AABB body, BlockPos cutFeet, Direction direction) {
		java.util.List<BlockPos> cells = besideCells(body);
		for (int row = 0; row <= 1; row++) for (int distance = 1; distance <= 4; distance++) cells.add(cutFeet.relative(direction, distance).above(row));
		BlockPos nearest = null;
		double best = Double.MAX_VALUE;
		Vec3 middle = body.getCenter();
		for (BlockPos cell : cells) {
			if (!lava.test(cell)) continue;
			double distance = Vec3.atCenterOf(cell).distanceToSqr(middle) + cell.getY() * 1.0E-6D;
			if (distance < best) { best = distance; nearest = cell; }
		}
		return nearest;
	}

	/** Whether lava is in any cell beside the body's hitbox. */
	static boolean lavaBeside(java.util.function.Predicate<BlockPos> lava, AABB body) {
		for (BlockPos cell : besideCells(body)) if (lava.test(cell)) return true;
		return false;
	}

	/** The beside clock: ticks in a row with lava beside the body, across plug targets; 0 once none is beside. */
	static int besideTicks(int previous, boolean beside) {
		return beside ? previous + 1 : 0;
	}

	private int besideTicks;

	/** Ticks a plug of lava beside the body may take before a click lands; past them the travel backs off instead. */
	static final int PLUG_BESIDE_TICKS = 8;

	/** Whether a tunnel plug gives up and backs off: lava beside the body and no block placed within {@link #PLUG_BESIDE_TICKS}. */
	static boolean plugGivesUp(boolean beside, int ticks, boolean clicked) {
		return beside && !clicked && ticks > PLUG_BESIDE_TICKS;
	}

	private boolean plugClicked;

	private BlockPos plugCell;
	private int plugTicks;

	private static boolean solid(ServerPlayer player, BlockPos cell) {
		return !player.level().getBlockState(cell).getCollisionShape(player.level(), cell).isEmpty();
	}

	private String offHotbarText(ServerPlayer player) {
		int off = TravelBuilder.blocksOffHotbar(player);
		return off > 0 ? "; " + off + " plain blocks are in the main inventory (select_tool moves them to the hotbar)" : "";
	}


	private int selectedSlot = -1;

	/** Selects a hotbar slot, crouched and still: every build move holds sneak so its pauses never slide off an edge. */
	private int select(ServerPlayer player, int slot, long nowEpochMs) {
		if (slot >= 9) {
			// Same vanilla number-key swap as select_tool; no empty hotbar slot is required.
			int hotbar = player.getInventory().getSelectedSlot();
			var refused = dev.agaminggod.mineagen.server.runtime.AdvancedInteractionService.swapIntoHotbar(player, slot, hotbar);
			if (refused != null) return -1;
			slot = hotbar;
		}
		selectedSlot = slot;
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, false, false, nowEpochMs);
		return slot;
	}

	private void apply(ServerPlayer player, AgentInputStates.MotorTarget target, boolean sneak, boolean attack, boolean use, long nowEpochMs) {
		if (lease == null) {
			input = AgentInputRuntime.controller(player);
			lease = input.acquire(AgentInputRuntime.requireAgentId(player), InputOwner.NAVIGATION, 100);
		}
		if (motor == null) motor = AgentInputStates.MotorState.initial(player.getYRot(), player.getXRot());
		AgentInputStates.MotorStep step = AgentInputStates.stepMotor(motor, target, nowEpochMs);
		motor = step.state();
		int slot = selectedSlot >= 0 ? selectedSlot : player.getInventory().getSelectedSlot();
		// Crouched on magma, as a player steps carefully across it: vanilla magma does not burn a sneaking body.
		boolean onMagma = onMagma(player);
		MinecraftNavigationWorld seen = new MinecraftNavigationWorld(player.level(), player);
		boolean brake = ServerNavigationController.fireAhead(seen, player.getBoundingBox(), player.getDeltaMovement())
				|| ServerNavigationController.fireAhead(seen, player.getBoundingBox(), ServerNavigationController.inputMotion(
						player.getDeltaMovement(), step.forward(), step.strafe(), step.state().yaw(), player.onGround()));
		float[] braking = brake ? ServerNavigationController.brakeInput(player.getDeltaMovement(), step.state().yaw()) : null;
		input.apply(lease, new AgentInputState(brake ? braking[0] : step.forward(), brake ? braking[1] : step.strafe(),
				step.jump(), sneak || onMagma, step.sprint() && !sneak && !onMagma && !brake, attack, use, step.state().yaw(), step.state().pitch(), slot, InteractionHand.MAIN_HAND));
	}

	private static boolean onMagma(ServerPlayer player) {
		return BrinkGuard.onMagma(player);
	}

	private void releaseInput() {
		motor = null;
		if (lease == null) return;
		try {
			input.release(lease);
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// A lifecycle clear may already have invalidated every lease.
		}
		lease = null;
		input = null;
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (leg != null) leg.cancel(player);
		leg = null;
		if (dig != null) dig.cancel(player);
		dig = null;
		if (fight != null) fight.cancel(player);
		fight = null;
		releaseInput();
	}

	/**
	 * A model-armed reflex held the body: health it lost and ground it was pushed over belong to that firing, so the trip
	 * takes the new health as its baseline and plans the next leg from where the body stands (a leg or build move
	 * half done before the firing no longer matches the body). A hostile still close stops it as before.
	 */
	@Override
	public void resumed(ServerPlayer player) {
		reflexResumes++;
		stallWatch.reset();
		lastHealth = player.getHealth();
		bestAt = dev.agaminggod.mineagen.server.runtime.GameClock.nowMs();
		if (phase == Phase.LEG || phase == Phase.BUILD || phase == Phase.LOOK) {
			if (leg != null) leg.cancel(player);
			leg = null;
			move = null;
			releaseInput();
			phase = Phase.PLAN;
		}
		if (fight != null) fight.resumed(player);
	}


	private TickResult engage(ServerPlayer player, Mob mob, String why, long nowEpochMs) {
		if (leg != null) leg.cancel(player);
		leg = null;
		move = null;
		releaseInput();
		long remaining = timeoutMs - (nowEpochMs - startedAt);
		fight = new ServerFightController(mob, null, minHealth,
				CombatPlanning.followThrough(null, CombatPlanning.TargetPolicy.NAMED), CombatPlanning.TargetPolicy.NAMED,
				false, true, false, false, Math.max(1_000L, Math.min(FIGHT_TIMEOUT_MS, remaining)), nowEpochMs);
		fightTarget = mob.getUUID();
		fightLabel = BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).getPath() + " (" + why + ")";
		phase = Phase.FIGHT;
		if (DEBUG) LOGGER.info("TRAVEL_FIGHT {} {}", mob.getUUID(), fightLabel);
		return TickResult.running(progress(player));
	}

	private TickResult fightTick(ServerPlayer player, long nowEpochMs) {
		if (nowEpochMs - startedAt >= timeoutMs) {
			return finish(player, ServerController.State.TIMED_OUT, "TRAVEL_TIMEOUT", withLavaStep("The trip's timeoutMs ran out while fighting " + fightLabel, lavaStepDetail));
		}
		TickResult result = fight.tick(player, nowEpochMs);
		if (result.state() == ServerController.State.RUNNING) return TickResult.running(progress(player));
		fight = null;
		String code = result.reasonCode();
		fightLog.add(fightLabel + ": " + code);
		if (result.state() != ServerController.State.SUCCEEDED) {
			fightFailures++;
			boolean passable = FIGHT_PASSABLE.contains(code);
			if (!passable || fightFailures >= MAX_FIGHT_FAILURES) {
				return fail(player, code, "Fighting through " + fightLabel + " stopped the trip"
						+ (passable ? " (failed fight " + fightFailures + ")" : "") + ": " + result.message());
			}
			// A first failed fight (escaped, out of reach) lets the trip go on; that mob stops or is fought again only up close.
			knownHostiles.add(fightTarget);
		}
		lastHealth = player.getHealth();
		bestAt = nowEpochMs;
		phase = Phase.PLAN;
		return TickResult.running(progress(player));
	}


	private double progress(ServerPlayer player) {
		return Math.max(0.0D, Math.min(1.0D, 1.0D - left(player.position()) / startLeft));
	}

	private TickResult fail(ServerPlayer player, String code, String message) {
		return finish(player, ServerController.State.FAILED, code, message);
	}

	private TickResult finish(ServerPlayer player, ServerController.State state, String code, String message) {
		cancel(player);
		String text = message + facts(player);
		return switch (state) {
			case SUCCEEDED -> TickResult.succeeded(code, text);
			case TIMED_OUT -> TickResult.timedOut(code, text, progress(player));
			default -> TickResult.failed(code, text, progress(player));
		};
	}

	private String facts(ServerPlayer player) {
		Vec3 at = player.position();
		double seconds = Math.max(0.05D, (dev.agaminggod.mineagen.server.runtime.GameClock.nowMs() - startedAt) / 1000.0D);
		double gained = startLeft - left(at);
		double bearing = Math.toDegrees(Math.atan2(-(targetX - at.x), targetZ - at.z));
		return String.format(Locale.ROOT, "; at %.1f,%.1f,%.1f; %.0f blocks left to the target (yaw %.0f)%s; covered %.0f blocks toward it in %.0f s (%.0f blocks/min, %.0f walked); %d legs, bridged %d, pillared %d, tunnelled %d; %d plain blocks carried",
				at.x, at.y, at.z, left(at), bearing, Double.isFinite(targetY) ? String.format(Locale.ROOT, ", %.0f above", targetY - at.y) : "",
				gained, seconds, gained / seconds * 60.0D, travelled, legs, bridged, pillared, tunnelled, TravelBuilder.blocksOnHotbar(player) + TravelBuilder.blocksOffHotbar(player))
				+ (fightLog.isEmpty() ? "" : "; fought through " + String.join(", ", fightLog))
				+ (reflexResumes == 0 ? "" : "; replanned after " + reflexResumes + " reflex firing(s)")
				+ (passedHostiles.isEmpty() ? "" : "; passed " + passedHostiles.size() + " hostile(s) not coming for you")
				+ (shrugNotes.isEmpty() ? "" : "; shrugged off " + String.join(", ", shrugNotes) + " damage")
				+ (dugDown == 0 ? "" : "; dug " + dugDown + " dig_to staircase(s) toward the target's level")
				+ (walkedAround == 0 ? "" : "; walked round " + walkedAround + " time(s) before building");
	}

	private String lastFailureText() {
		return (lastLegFailure == null ? "" : "; last leg: " + lastLegFailure)
				+ (lavaStepDetail == null || lastLegFailure != null && lastLegFailure.startsWith("LAVA_STEP") ? "" : "; LAVA_STEP earlier: " + lavaStepDetail);
	}

	private String lavaStepDetail;

	/** A timeout's text with the pending LAVA_STEP stop, so the model still sees which lava cell held the trip up. */
	static String withLavaStep(String message, String lavaStepDetail) {
		return lavaStepDetail == null ? message : message + "; LAVA_STEP earlier: " + lavaStepDetail;
	}

	private static String firstClause(String message) {
		if (message == null) return "";
		int cut = message.indexOf("; replans");
		return cut > 0 ? message.substring(0, cut) : message.length() > 200 ? message.substring(0, 200) : message;
	}

	/**
	 * The open cell the feet stand in, with its support below it: on soul sand (top 0.875) or a bottom slab (top 0.5)
	 * the feet are inside the support block's own cell, so rounding (not flooring) the height names the open cell.
	 */
	static GridPosition feet(ServerPlayer player) {
		GridPosition centre = new GridPosition((int) Math.floor(player.getX()), standingCellY(player.getY()), (int) Math.floor(player.getZ()));
		if (!player.onGround()) return centre;
		BlockPos under = new BlockPos(centre.x(), centre.y() - 1, centre.z());
		if (!player.level().getBlockState(under).getCollisionShape(player.level(), under).isEmpty()) return centre;
		BlockPos support = player.getOnPos();
		if (player.level().getBlockState(support).getCollisionShape(player.level(), support).isEmpty()) return centre;
		return new GridPosition(support.getX(), centre.y(), support.getZ());
	}

	static int standingCellY(double feetY) {
		return (int) Math.floor(feetY + 0.5D);
	}

	private static String cell(GridPosition position) {
		return position == null ? "?" : position.x() + "," + position.y() + "," + position.z();
	}

	private static String cell(BlockPos position) {
		return position.getX() + "," + position.getY() + "," + position.getZ();
	}

	private static String format(double value) {
		return String.format(Locale.ROOT, "%.1f", value);
	}
}
