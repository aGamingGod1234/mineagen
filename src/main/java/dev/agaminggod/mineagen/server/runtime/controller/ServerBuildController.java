package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.agent.AgentDomainException;
import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.server.perception.BucketReach;
import dev.agaminggod.mineagen.server.perception.CastLava;
import dev.agaminggod.mineagen.server.perception.SeenTerrain;
import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import dev.agaminggod.mineagen.server.runtime.TargetSightline;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputStates;
import dev.agaminggod.mineagen.server.runtime.input.InputLease;
import dev.agaminggod.mineagen.server.runtime.input.InputOwner;
import dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/**
 * build: one named structure from a small blueprint library, made with what the body carries, as a player makes it.
 * The model names what and roughly where; the body picks the ground, clears it, places in an order where every block
 * touches one already there, and hands back when built, when short of a material (how many of what), or on danger.
 * <ul>
 * <li>nether_portal: looks around, chooses flat dry ground (the frame's bottom row set into the ground, the side columns
 * standing on the ground corners), mines what is in the way, places the ten obsidian with a scaffold at a top corner and
 * one block to step up on (from carried blocks, else the dirt the bottom row gave), and lights it with flint and steel.
 * Without 10 obsidian, a water bucket and an empty bucket cast the frame in place beside a seen lava pool, as a player
 * without a diamond pickaxe does: a small mould of plain blocks behind the frame gives every pour a face to click, then for
 * each frame cell water goes in beside it first and lava second (vanilla casts a lava source that water touches the moment
 * it lands, so no lava ever stands or flows), and the water is scooped back; the empty bucket fetches the next lava from
 * the pool. Carried obsidian fills cells first.</li>
 * <li>pillar: jump and place under the feet, size times, with headroom seen first.</li>
 * <li>bridge: a 1-wide line toward x,z: walks seen ground and sneak-bridges each gap, with travel_to's own judgement
 * of the cell ahead ({@link TravelBuilder#decide}).</li>
 * <li>shelter: build_shelter around the body's cell, opening the way it faces.</li>
 * </ul>
 * Every judgement of terrain reads what the body has seen or remembers ({@link SeenTerrain}); every block is placed
 * through the ordinary placement gates.
 */
public final class ServerBuildController implements ServerController {
	private static final org.slf4j.Logger LOGGER = org.slf4j.LoggerFactory.getLogger(ServerBuildController.class);
	public enum Structure {
		NETHER_PORTAL, PILLAR, BRIDGE, SHELTER;

		public static Structure parse(String name) {
			return switch (name == null ? "" : name) {
				case "nether_portal" -> NETHER_PORTAL;
				case "pillar" -> PILLAR;
				case "bridge" -> BRIDGE;
				case "shelter" -> SHELTER;
				default -> throw new AgentDomainException("INVALID_BUILD_STRUCTURE", "structure must be nether_portal, pillar, bridge or shelter");
			};
		}

		String wire() { return name().toLowerCase(Locale.ROOT); }
	}

	/** The body's ordinary actions the build drives. Refusals are thrown as {@link AgentDomainException}. */
	public interface Environment {
		Vec3 aim(ServerPlayer body, BlockPos at, Direction face, String item);
		/** One placement; null when the block was placed, else why not. */
		String place(ServerPlayer body, BlockPos at, Direction face, String item);
		ServerController clear(ServerPlayer body, BlockPos at, long timeoutMs);
		/** {@link #clear}, except that lava under the block is no bar (lava never flows up); lava beside or above it still refuses. */
		ServerController uncover(ServerPlayer body, BlockPos at, long timeoutMs);
		ServerController shelter(ServerPlayer body, BlockPos center, Direction opening, String item, long timeoutMs);
		/** What the held kind of bucket's own ray meets aimed at {@code aim}: an empty one stops at fluid sources, a filled one passes fluids. */
		BlockHitResult bucketRay(ServerPlayer body, Vec3 aim, boolean empty);
		Vec3 scoopAim(ServerPlayer body, BlockPos source);
		/**
		 * One use of the held bucket along the current look, when its ray meets {@code clicked} (and {@code face}, for a
		 * filled bucket), through use_item's own lava pour guard; null when it acted, else why not.
		 */
		String useBucket(ServerPlayer body, BlockPos clicked, Direction face);

		/**
		 * {@link #useBucket(ServerPlayer, BlockPos, Direction)}, except that lava poured where no water touches it yet is
		 * refused only when its flow would reach the body within {@code lavaGraceSeconds}: the cast's water follows sooner.
		 */
		default String useBucket(ServerPlayer body, BlockPos clicked, Direction face, double lavaGraceSeconds) {
			return useBucket(body, clicked, face);
		}
	}

	/** Ticks a single block may take to mine with the best carried tool for a site to count it as clearable (dirt by hand: 15). */
	static final int MAX_CLEAR_TICKS = 40;
	static final int SITE_RADIUS = 7;
	static final int SURVEY_LOOKS = 12;
	static final int MAX_WALKS = 16;
	static final int CELL_TICKS = 80;
	static final double HOSTILE_RANGE = 10.0D;
	static final int DEFAULT_PILLAR = 4;
	static final int DEFAULT_BRIDGE = 32;
	static final int MAX_RELOCATIONS = 3;
	static final String CAST_HINT = " (or carry a water bucket, an empty bucket and about 13 plain blocks to cast the frame beside a seen lava pool)";
	/** How far from the body (or at) a seen lava pool may be for a cast frame; find's sightings reach this far. */
	static final int CAST_LAVA_RANGE = 64;
	/** How far the frame may stand from the pool's nearest source: each of the ten casts walks there and back. */
	static final double CAST_POOL_REACH = 16.0D;
	/**
	 * How far the frame's ground row may stand above (or below) the pool's sources. At 3 above, the body on the frame's floor
	 * has its eye about 4.7 over the sources' tops, past a bucket's reach, and a carved tunnel seldom has a lower shore: in
	 * full runs every cast from 3 above stopped short (7, 3 and 0 of 10 cells) and every lit portal stood 0-1 above.
	 */
	static final double CAST_RISE = 2.0D;
	static final int CAST_CLICK_TICKS = 60;
	/**
	 * Cells the poured water's run is followed for. A cast scoops its water 9-12 ticks after the pour, past the source's first
	 * spread at 5, and taking the source up does not stop the flow already out: the drying spreads back from the source one
	 * cell per 5 ticks, as fast as the front advances, so the front runs its whole vanilla course (7 cells on the flat,
	 * afresh below each drop). In one cave room it ran 10 cells down a sloping floor into the pool and crusted it to
	 * obsidian. The bound only ends the search; a run-off into the pool takes at most a few drops.
	 */
	static final int SPILL_CELLS = 32;
	/**
	 * Cells the water runs in the cast's own order (lava first, then water against it, scooped the next tick): vanilla
	 * casts a lava source to obsidian the moment water lands beside or above it (LiquidBlock's neighbour update), and a
	 * poured source first spreads at its 5-tick fluid tick, so water scooped before then never leaves its cell. One cell
	 * allows a scoop as late as tick 9: the ring a source puts out at tick 5 dries at tick 10 without spreading on.
	 */
	static final int QUICK_SPILL_CELLS = 1;
	/**
	 * The water's run a site is first chosen by (the bound before the quick scoop): a site whose 8-cell run meets no lava
	 * stays safe when a scoop comes late. Open sites the quick bound alone admits sit tighter by the pool: in two away rooms
	 * main always lit, they were taken over sites 3 blocks farther out, and 19 of 20 runs then had a frame cell no spot
	 * could see or reach (BUILD_BLOCKED, NO_STAND_SPOT).
	 */
	static final int SURE_SPILL_CELLS = 8;
	/** Added to a site's cost when only {@link #QUICK_SPILL_CELLS} admits it: any site {@link #SURE_SPILL_CELLS} admits comes first. */
	static final double LOOSE_SITE_COST = 1000.0D;
	/**
	 * Ticks lava poured first may stand in a frame cell waiting for the water before it is taken back: it first flows at
	 * its 30-tick fluid tick (the cast never runs where lava is fast, since water there boils away), and the turn back to
	 * the lava's own aim and the click take well under the other 18.
	 */
	static final int LAVA_HOLD_TICKS = 12;
	/** Long enough for a 7-block lava flow with no source to drain (30 ticks a level in the Overworld). */
	static final int DRAIN_TICKS = 300;
	/** Water left standing longer than this (its lava click not landing) is scooped back to pour the pair from another spot. */
	static final int WATER_STAND_TICKS = 25;
	static final int WIDE_RADIUS = 14;
	/**
	 * Cast sites one build may carve into the rock (frame plane and the row in front, 32 cells at most) when nothing seen by
	 * the lava is flat open floor: find stops at its first sighting, usually from its own 1-wide tunnel at the lava level.
	 */
	static final int MAX_CARVES = 2;
	static final int CARVE_RADIUS = 10;
	static final double CARVE_POOL_MARGIN = 6.0D;
	/**
	 * Open pool sources a cast wants in view before it starts: one bucket per frame cell and two spare. A pool met from the
	 * side or through one opened block shows one source (sight stops at the first lava), and a scooped source refills as
	 * flowing lava that hides the rest.
	 */
	static final int UNCOVER_TARGET = 12;
	static final int MAX_UNCOVERS = 24;


	/** A 4x5 portal frame: origin is its bottom-left corner, set in the ground row; the frame spans along {@code axis}. */
	public record Portal(BlockPos origin, Direction.Axis axis) {
		public BlockPos at(int i, int y) {
			return axis == Direction.Axis.Z ? origin.offset(0, y, i) : origin.offset(i, y, 0);
		}

		public List<BlockPos> frame() {
			List<BlockPos> cells = new ArrayList<>();
			cells.add(at(1, 0)); cells.add(at(2, 0));
			for (int y = 1; y <= 3; y++) { cells.add(at(0, y)); cells.add(at(3, y)); }
			cells.add(at(1, 4)); cells.add(at(2, 4));
			return cells;
		}

		public List<BlockPos> interior() {
			List<BlockPos> cells = new ArrayList<>();
			for (int y = 1; y <= 3; y++) for (int i = 1; i <= 2; i++) cells.add(at(i, y));
			return cells;
		}

		public List<BlockPos> corners() {
			return List.of(at(0, 0), at(3, 0), at(0, 4), at(3, 4));
		}

		public Direction normal() {
			return axis == Direction.Axis.Z ? Direction.EAST : Direction.SOUTH;
		}

		boolean reserved(BlockPos cell) {
			for (int i = 0; i <= 3; i++) for (int y = 0; y <= 4; y++) if (at(i, y).equals(cell)) return true;
			return false;
		}
	}

	public record Placement(BlockPos at, boolean scaffold) { }

	/**
	 * An order in which every cell touches a solid block or an earlier placement, lowest cells first, with scaffold
	 * placements (from {@code scaffoldSpots}, which need not be removed) where no remaining cell has support. Null when
	 * even scaffolds leave a cell with nothing to click against.
	 */
	public static List<Placement> order(List<BlockPos> cells, List<BlockPos> scaffoldSpots, Predicate<BlockPos> solid) {
		List<BlockPos> left = new ArrayList<>(cells);
		left.sort(Comparator.comparingInt(BlockPos::getY));
		Set<BlockPos> placed = new HashSet<>();
		List<Placement> order = new ArrayList<>();
		while (!left.isEmpty()) {
			BlockPos next = null;
			for (BlockPos cell : left) if (supported(cell, solid, placed)) { next = cell; break; }
			if (next != null) {
				order.add(new Placement(next, false));
				placed.add(next);
				left.remove(next);
				continue;
			}
			BlockPos scaffold = null;
			for (BlockPos spot : scaffoldSpots) {
				if (placed.contains(spot) || solid.test(spot) || !supported(spot, solid, placed)) continue;
				boolean helps = false;
				for (BlockPos cell : left) if (cell.distManhattan(spot) == 1) helps = true;
				if (helps) { scaffold = spot; break; }
			}
			if (scaffold == null) return null;
			order.add(new Placement(scaffold, true));
			placed.add(scaffold);
		}
		return order;
	}

	private static boolean supported(BlockPos cell, Predicate<BlockPos> solid, Set<BlockPos> placed) {
		for (Direction side : Direction.values()) {
			BlockPos next = cell.relative(side);
			if (placed.contains(next) || solid.test(next)) return true;
		}
		return false;
	}


	private enum Phase { START, APPROACH, UNCOVER, SURVEY, CLEAR, PLUG, COLLECT, PLACE, CAST, LIGHT, PILLAR, BRIDGE }
	private enum Pour { WATER, LAVA, SCOOP, FILL, TAKE }

	/** The next bucket click for a frame cell not yet cast, in the lava-first order. */
	enum CastStep { LAVA, WATER, SCOOP, TAKE_BACK }

	/**
	 * Lava first, water against it, the water scooped at once: {@code waterStanding} the cast's water still in its cell,
	 * {@code lavaInCell} lava in the frame cell, {@code ourLava} poured there by this cast {@code lavaAge} ticks ago,
	 * {@code waterLands} a water click from here would land beside it now. Lava the water cannot follow at once, or that
	 * has stood {@link #LAVA_HOLD_TICKS}, is taken back before it flows.
	 */
	static CastStep castStep(boolean waterStanding, boolean lavaInCell, boolean ourLava, long lavaAge, boolean waterLands) {
		if (waterStanding) return CastStep.SCOOP;
		if (!lavaInCell) return CastStep.LAVA;
		if (ourLava && (lavaAge > LAVA_HOLD_TICKS || !waterLands)) return CastStep.TAKE_BACK;
		return CastStep.WATER;
	}
	private enum Child { NONE, CLEAR, SHELTER, UNCOVER }

	private final Structure structure;
	private final BlockPos requested;
	private final String material;
	private final int size;
	private final long deadline;
	private final Environment environment;
	private Phase phase = Phase.START;
	private ResourceKey<Level> dimension;
	private float lastHealth = Float.NaN;
	private LeasedServerInputController input;
	private InputLease lease;
	private AgentInputStates.MotorState motor;
	private ServerController child;
	private Child childKind = Child.NONE;
	private ServerNavigationController walk;
	private int walks, pause;
	private final Set<BlockPos> triedSpots = new HashSet<>();
	private String lastWalkFailure, refusal, siteNote;

	private BlockPos center;
	private Portal portal;
	private int looks, wideLooks, relocations;
	private Vec3 lookAim;
	private final List<BlockPos> clears = new ArrayList<>();
	private List<Placement> order;
	private int index, cellTicks, lookTicks, placed, cleared, scaffolds, lightTries, lightWait, collectTries, collectSteps;
	private int spares;
	private BlockPos lookCell, stepAt;
	private boolean jumping;
	private final Set<java.util.UUID> skippedDrops = new HashSet<>();

	// portal cast from buckets: the mould wall behind the frame (on side back), then {frame cell, water cell} pairs in order
	private boolean casting;
	private Direction back;
	private BlockPos poolAt;
	/** Why the last survey found no site (the reject counts), kept for the hand-back after a walk to level ground. */
	private String siteRejects = "";
	private final Set<BlockPos> mould = new HashSet<>();
	/** Mould blocks this build placed or saw standing, and frame cells it saw cast: solid until it sees otherwise. */
	private final Set<BlockPos> madeSolid = new HashSet<>();
	private final List<BlockPos[]> castOrder = new ArrayList<>();
	private int castIndex, approaches, clickTicks, castWait, drainTicks, waterPours, lavaPours, scoops, fills, obsidianPlaced, mouldBlocks;
	private BlockPos pouredWater, lastFill, walkTarget;
	private int seekLooks, seekWalks, cellPours;
	private final Set<BlockPos> deadSupports = new HashSet<>();
	/** Every lava source this build has seen (sight memory fades): where to walk back to when none is in view. */
	private final Set<BlockPos> poolMemory = new HashSet<>();
	/** How far from the frame the body looks for the next lava: a big pool's open surface often lies past its near rim. */
	static final int CAST_FETCH_RANGE = 32;
	private final Set<BlockPos> triedSources = new HashSet<>();
	/** Cast sites given up before anything was built there (a clearing the break gates refused, such as lava heard behind). */
	private final Set<BlockPos> rejectedSites = new HashSet<>();
	private String rejectNote;
	private int standRetries;
	/** Walks observe() has sent to spots stood on for the cell it looks at now; after 3 it tries seen spots, then hands back. */
	private int stoodWalks;
	private boolean clearThenCast;
	/** A carved site is being dug: when its cells are gone the body looks round and chooses a site again from what it sees. */
	private boolean carving;
	private int carves;
	private final Set<BlockPos> uncovered = new HashSet<>();
	private final Set<BlockPos> uncoverDead = new HashSet<>();
	private int uncovers, uncoverWalks, walksBeforeUncover = -1;
	private BlockPos uncoverCell;
	private BlockPos carveStand;
	/** The site just carved and its mould side: chosen first when it passes the usual rules; its rock is looked at first. */
	private Portal carved;
	private Direction carvedBack;
	private final List<BlockPos> carveLooks = new ArrayList<>();
	private int uncoverLooks;
	private boolean carveLooked;
	private String carveNote, uncoverNote;
	/** Cells of this carve open to the air (dug, or open before): what water or lava met through the rock pours in by. */
	private final Set<BlockPos> carveOpened = new HashSet<>();
	/** Opened carve cells a seen fluid outside the dig touches, filled with a carried block before it pours in. */
	private final List<BlockPos> plugs = new ArrayList<>();
	/** Water and lava a carve met behind the rock: out of sight behind the plugs, still there for the next site's rules. */
	private final java.util.Map<BlockPos, BlockState> metFluid = new java.util.HashMap<>();
	/** Why the carve stopped to plug, and (when a plug could not go in) why the body stepped back before handing back. */
	private String plugWhy, stepBackWhy;
	private int plugged;
	/** Steps the body took during the cast, cell to cell (a drop of 2+ one way only): the way back it knows it can walk. */
	private final java.util.Map<BlockPos, Set<BlockPos>> stepsWalked = new java.util.HashMap<>();
	private BlockPos lastStood;
	/** Where scoops landed, latest last: dry spots in reach of the pool that the body has stood on. */
	private final List<BlockPos> scoopSpots = new ArrayList<>();
	/** Flowing lava a walk was refused at, with no source feeding it: it drains away in a few seconds. */
	private BlockPos drainAt;
	private int flowTicks, flowWaits;
	/** Bucket clicks that would not land, since the last that did; after one the body pours from another spot. */
	private int clickStalls;
	private boolean moveForClick;
	/** When the standing water was poured; with no spot that reaches both cells of a cast, water goes in from one that reaches its own. */
	private long waterTick;
	private boolean waterAlone, staleWater;
	/** Lava this cast poured first into a frame cell and when; the water then poured beside it is scooped the next tick. */
	private BlockPos pouredLava;
	private long lavaTick;
	private boolean quickScoop, lavaWatered;
	/**
	 * The cell's pair goes in the old order, water first (no spot reaches both cells), allowed only where the water's
	 * whole run ({@link #SPILL_CELLS}) meets no lava: water standing for the lava's turn runs its full course.
	 */
	private boolean waterFirst, runOffMeetsLava, sureRunOffMeetsLava;
	/** This cell has no spot whose water line misses the lava's cell: pour it from a spot where it crosses (main's way). */
	private boolean crossAllowed;
	private int lavaTakes, fetchRetries;
	private int staleScoops;
	private final java.util.ArrayDeque<BlockPos> wayBack = new java.util.ArrayDeque<>();

	private Direction line;
	private int startY = Integer.MIN_VALUE, pillarGoal = Integer.MIN_VALUE, moveStage, moveTicks, glances, cells, steps;
	private Phase pillarReturn;
	private GridPosition moveFeet, lineStart;
	private ServerNavigationController stepWalk;
	private boolean stepSneak;
	private long stepStartedAt;
	private TravelBuilder.Plan move;
	private boolean centred;
	private BlockHitResult bridgeAttachment;
	private float bridgeViewYaw, bridgeViewPitch;

	public ServerBuildController(Structure structure, BlockPos requested, String material, Integer size,
			long timeoutMs, long now, Environment environment) {
		this.structure = structure;
		this.requested = requested == null ? null : requested.immutable();
		this.material = structure == Structure.NETHER_PORTAL ? "minecraft:obsidian" : material;
		this.size = size == null ? structure == Structure.PILLAR ? DEFAULT_PILLAR : DEFAULT_BRIDGE : size;
		this.deadline = now + timeoutMs;
		this.environment = environment;
	}

	@Override
	public TickResult tick(ServerPlayer player, long now) {
		// Lava this cast poured first stands uncooled until the water lands beside it or it is taken back, a few ticks: a
		// build that stopped now would leave it to flow onto the working spot. The cell is finished first; only lava or
		// fire on the body stops it at once.
		boolean finishing = lavaStanding(player) && !player.isInLava() && !player.isOnFire();
		if (now >= deadline && !finishing) return end(player, TickResult.timedOut("BUILD_TIMEOUT", facts(player) + "; the time limit ran out", progress()));
		if (!player.isAlive()) return fail(player, "AGENT_DEAD", "The body died while building");
		if (dimension == null) { dimension = player.level().dimension(); lastHealth = player.getHealth(); }
		if (!player.level().dimension().equals(dimension)) return fail(player, "ACTION_DIMENSION_CHANGED", "The body changed dimension");
		TickResult danger = finishing ? null : danger(player);
		if (danger != null) return danger;
		if (child != null) return childTick(player, now);
		// From the first step of a cast build: the walks to open the pool cross the shore the fetches need later.
		if (casting && player.onGround()) recordStep(player.blockPosition());
		if (walk != null) {
			if (casting) walk.keepLavaFlowRoutes();
			TickResult moved = walk.tick(player, now);
			if (moved.state() == State.RUNNING) return running();
			walk.cancel(player);
			walk = null;
			if (moved.state() == State.SUCCEEDED && !wayBack.isEmpty()) { nextHop(now); return running(); }
			wayBack.clear();
			if (moved.state() != State.SUCCEEDED) {
				lastWalkFailure = moved.reasonCode() + " " + moved.message();
				LOGGER.info("[build] {} walk {} failed at {}: {}", player.getGameProfile().name(), walks, xyz(player.blockPosition()), lastWalkFailure);
				BlockPos flow = casting && "LAVA_FLOW".equals(moved.reasonCode()) ? lavaNamed(moved.message()) : null;
				if (flow != null && flowWaits < 3 && !fed(player, flow)) {
					// Lava running from a source the cast took (or one gone) is draining: wait for it, then walk there again.
					drainAt = flow;
					flowTicks = 0;
					flowWaits++;
					walks--;
					triedSpots.remove(walkTarget);
				} else if (casting && walkTarget != null) {
					// A cast's next spot is usually beside the one it could not reach (the same flow or ledge in the way): rule out its neighbours too.
					for (BlockPos near : BlockPos.betweenClosed(walkTarget.offset(-1, -1, -1), walkTarget.offset(1, 1, 1))) triedSpots.add(near.immutable());
				}
			}
			cellTicks = 0; jumping = false;
		}
		if (drainAt != null) {
			BlockState flowing = known(player, drainAt);
			if (flowing != null && !TravelBuilder.lava(flowing) || ++flowTicks > DRAIN_TICKS) drainAt = null;
			else { releaseInput(); ServerLookController.turnToward(player, Vec3.atCenterOf(drainAt)); return running(); }
		}
		if (pause > 0) { pause--; return running(); }
		return switch (phase) {
			case START -> start(player, now);
			case APPROACH -> approach(player, now);
			case UNCOVER -> uncoverTick(player, now);
			case SURVEY -> survey(player, now);
			case CLEAR -> clearTick(player, now);
			case PLUG -> plugTick(player, now);
			case COLLECT -> collectTick(player, now);
			case PLACE -> placeTick(player, now);
			case CAST -> castTick(player, now);
			case LIGHT -> lightTick(player, now);
			case PILLAR -> pillarTick(player, now);
			case BRIDGE -> bridgeTick(player, now);
		};
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (child != null) child.cancel(player);
		child = null;
		if (walk != null) walk.cancel(player);
		walk = null;
		if (stepWalk != null) stepWalk.cancel(player);
		stepWalk = null;
		releaseInput();
	}


	private TickResult start(ServerPlayer player, long now) {
		switch (structure) {
			case SHELTER -> {
				String item = material != null ? material : plainBlock(player, false);
				if (item == null) return short_(player, "a shelter needs 9 plain full blocks (dirt, cobblestone...) and none is carried");
				int carried = carried(player, item);
				if (carried < 7) return short_(player, "a shelter needs about 9 " + item + " (7 at least), " + carried + " carried; " + (9 - carried) + " more");
				BlockPos at = requested != null ? requested : player.blockPosition();
				Direction opening = player.getDirection().getAxis().isHorizontal() ? player.getDirection() : Direction.NORTH;
				return startChild(player, Child.SHELTER, environment.shelter(player, at, opening, item, Math.max(1L, deadline - now)));
			}
			case PILLAR -> {
				if (material != null && materialRefusal(material) != null) return badMaterial(player);
				String item = material != null ? material : plainBlock(player, false);
				int carried = item == null ? 0 : carried(player, item);
				if (carried < size) return short_(player, "a " + size + "-block pillar needs " + size + " plain full blocks, " + carried
						+ (item == null ? "" : " " + item) + " carried; " + (size - carried) + " more");
				startY = ServerTravelController.feet(player).y();
				pillarGoal = startY + size;
				phase = Phase.PILLAR;
				return running();
			}
			case BRIDGE -> {
				if (requested == null) return fail(player, "BUILD_NO_SITE", "A bridge needs at: the far side to bridge toward");
				double dx = requested.getX() + 0.5D - player.getX(), dz = requested.getZ() + 0.5D - player.getZ();
				if (material != null && materialRefusal(material) != null) return badMaterial(player);
				line = Math.abs(dx) >= Math.abs(dz) ? (dx >= 0 ? Direction.EAST : Direction.WEST) : (dz >= 0 ? Direction.SOUTH : Direction.NORTH);
				String item = material != null ? material : plainBlock(player, false);
				if (item == null || carried(player, item) == 0) return short_(player, "a bridge needs plain full blocks (1 per gap cell) and none is carried");
				phase = Phase.BRIDGE;
				return running();
			}
			case NETHER_PORTAL -> {
				if (lighter(player) == null) return short_(player, "lighting the portal needs 1 flint_and_steel (or a fire_charge), none carried");
				int obsidian = carried(player, "minecraft:obsidian");
				casting = obsidian < 10 && carried(player, "minecraft:water_bucket") > 0
						&& carried(player, "minecraft:bucket") + carried(player, "minecraft:lava_bucket") > 0;
				if (obsidian == 0 && !casting) return short_(player, "the frame needs 10 obsidian, none carried" + CAST_HINT
						+ "; carried water_bucket " + carried(player, "minecraft:water_bucket") + ", bucket " + carried(player, "minecraft:bucket"));
				center = requested != null ? requested : player.blockPosition();
				if (casting && clearTicks(player, (ServerLevel) player.level(), BlockPos.ZERO, Blocks.STONE.defaultBlockState()) > MAX_CLEAR_TICKS)
					return fail(player, "NO_TOOL", "Casting the frame digs (opening the pool, carving a site, clearing the frame) and no carried pickaxe mines stone in time; make one, then build again");
				if (casting) {
					if (looks == 0 && lookAim == null) {
						PoolNote note = LAST_POOL.get(player.getUUID());
						lastFrame = note != null && note.dimension().equals(player.level().dimension()) && player.level().getGameTime() - note.tick() <= POOL_NOTE_TICKS ? note.frame() : null;
					}
					List<BlockPos> pool = lavaSources(player, center, CAST_LAVA_RANGE);
					if (pool.isEmpty() && looks < 16) {
						if (lookAim == null) {
							double yaw = Math.toRadians(looks * 45.0D + (looks >= 8 ? 22.5D : 0.0D));
							double out = looks < 8 ? 8.0D : 5.0D;
							lookAim = player.getEyePosition().add(-Math.sin(yaw) * out, looks >= 8 ? -5.0D : looks % 2 == 0 ? -3.0D : -1.0D, Math.cos(yaw) * out);
						}
						releaseInput();
						if (ServerLookController.turnToward(player, lookAim)) { lookAim = null; looks++; pause = 4; }
						return running();
					}
					looks = 0;
					lookAim = null;
					// The pool an earlier build here saw (out of sight now: the body is in its own carve, or a mob stopped that build):
					// a player remembers where it was. Lava since seen gone is dropped.
					if (pool.isEmpty()) pool = rememberedPool(player, center);
					if (pool.isEmpty()) return fail(player, "BUILD_NO_SITE", "Casting the frame needs a lava pool seen within " + CAST_LAVA_RANGE + " blocks of "
							+ xyz(center) + " and none is after a look around; find lava first (find block minecraft:lava), then build here again");
					// The nearest pool that feeds the whole cast, by the rule find stops on (CastLava): a pocket is no cast site.
					int need = CastLava.needed(player);
					poolAt = pool.stream().filter(at -> CastLava.sources(player.level()::getBlockState, at, need) >= need).findFirst().orElse(null);
					if (poolAt == null) return fail(player, "BUILD_NO_SITE", "The lava seen near " + xyz(center) + " is a pocket of "
							+ CastLava.sources(player.level()::getBlockState, pool.get(0), need) + " source(s) a bucket takes, and the cast needs " + need
							+ " (one per frame cell not carried as obsidian); find lava (find block minecraft:lava) for a bigger pool, then build there");
					if (requested == null) center = castCenter(player, poolAt);
					phase = Phase.APPROACH;
					return running();
				}
				phase = Phase.APPROACH;
				return running();
			}
		}
		return running();
	}


	private TickResult startChild(ServerPlayer player, Child kind, ServerController next) {
		releaseInput();
		child = next;
		childKind = kind;
		return running();
	}

	private TickResult childTick(ServerPlayer player, long now) {
		TickResult result = child.tick(player, now);
		if (result.state() == State.RUNNING) return running();
		child.cancel(player);
		Child kind = childKind;
		child = null;
		childKind = Child.NONE;
		switch (kind) {
			case SHELTER -> { return end(player, result); }
			case UNCOVER -> {
				if (result.state() == State.SUCCEEDED) { uncovers++; uncovered.add(uncoverCell); } else uncoverDead.add(uncoverCell);
				pause = 4;
				return running();
			}
			case CLEAR -> {
				if (result.state() == State.SUCCEEDED) {
					cleared++;
					if (!clears.isEmpty()) { BlockPos opened = clears.remove(0); if (carving) carveOpened.add(opened); }
					cellTicks = 0;
					// The break may have opened onto water or lava hidden in the rock: plugged before it pours in.
					TickResult plug = carving ? plugInlets(player, "the dig opened onto it") : null;
					return plug != null ? plug : running();
				}
				if (carving) { TickResult plug = plugInlets(player, result.reasonCode() + " " + result.message()); if (plug != null) return plug; }
				if (casting && index == 0 && castIndex == 0 && rejectedSites.size() < 3) return chooseAgain(player, now, result.reasonCode() + " " + result.message());
				return fail(player, result.reasonCode(), "Clearing the site: " + result.message());
			}
			default -> { return running(); }
		}
	}


	private TickResult survey(ServerPlayer player, long now) {
		if (looks == 0 && lookAim == null && relocations > 0) center = player.blockPosition();
		if (lookAim == null) {
			double yaw = Math.toRadians((looks % 6) * 60.0D + (looks >= 12 ? 30.0D : 0.0D));
			// A cast site is often a cave floor: a third ring looks farther out and lower, between the first two.
			double reach = looks >= 12 ? 9.0D : 6.0D;
			lookAim = player.getEyePosition().add(-Math.sin(yaw) * reach, looks < 6 ? -3.0D : looks < 12 ? 1.0D : -4.0D, Math.cos(yaw) * reach);
		}
		releaseInput();
		if (!ServerLookController.turnToward(player, lookAim)) return running();
		var seen = SeenTerrain.of(player);
		for (BlockPos at : BlockPos.betweenClosed(center.offset(-SITE_RADIUS, -4, -SITE_RADIUS), center.offset(SITE_RADIUS, 5, SITE_RADIUS)))
			seen.known(at.getX(), at.getY(), at.getZ());
		lookAim = null;
		if (++looks < (casting ? SURVEY_LOOKS + 6 : SURVEY_LOOKS)) return running();
		return chooseSite(player, now);
	}

	private TickResult chooseSite(ServerPlayer player, long now) {
		ServerLevel level = (ServerLevel) player.level();
		int[] rejects = new int[11];
		rejects[10] = Integer.MAX_VALUE;
		Portal best = null;
		Direction bestBack = null;
		double bestCost = Double.MAX_VALUE;
		boolean bestSure = true;
		List<BlockPos> pool = casting ? castPool(player, center, SITE_RADIUS + (int) CAST_POOL_REACH) : List.of();
		int plain = casting ? plainCount(player) : 0;
		for (Direction.Axis axis : new Direction.Axis[] { Direction.Axis.X, Direction.Axis.Z })
			for (BlockPos origin : BlockPos.betweenClosed(center.offset(-SITE_RADIUS, -3, -SITE_RADIUS), center.offset(SITE_RADIUS - 3, 2, SITE_RADIUS - 3))) {
				Portal candidate = new Portal(origin.immutable(), axis);
				if (rejectedSites.contains(origin)) continue;
				double cost = siteCost(player, level, candidate, rejects);
				if (cost == Double.MAX_VALUE) continue;
				Direction side = null;
				boolean sure = true;
				if (casting) {
					double castCost = Double.MAX_VALUE;
					for (Direction wall : new Direction[] { candidate.normal(), candidate.normal().getOpposite() }) {
						double c = castCost(player, level, candidate, wall, pool, plain, rejects);
						boolean wallSure = c != Double.MAX_VALUE && !spillMeetsLava(cell -> known(player, cell), candidate, wall, SURE_SPILL_CELLS);
						if (c != Double.MAX_VALUE && !wallSure) c += LOOSE_SITE_COST;
						if (c < castCost) { castCost = c; side = wall; sure = wallSure; }
					}
					if (side == null) continue;
					cost += castCost;
				}
				cost += 0.3D * Math.sqrt(origin.distSqr(center));
				// The site carved for this cast, when it passes: the rock was dug for it, and any other plane by it leaves dug air
				// for the mould and a roof too low for the step up.
				if (candidate.equals(carved) && side == carvedBack) cost -= 100.0D;
				if (lastFrame != null && candidate.equals(lastFrame.origin()) && side == lastFrame.back()) cost -= 80.0D;
				if (cost < bestCost) { bestCost = cost; best = candidate; bestBack = side; bestSure = sure; }
			}
		// A site fit for the cast but for the blocks carried: more blocks, not another spot, is what it takes.
		if (best == null && rejects[9] > 0) return short_(player, String.format(Locale.ROOT, "casting the frame needs %d plain blocks for the mould behind it at the best site by the lava near %s, "
				+ "%d carried; %d more (cobblestone or dirt), then build here again", rejects[10], xyz(center), plain, rejects[10] - plain));
		if (best == null) siteRejects = String.format(Locale.ROOT, "%d had no flat solid ground row, "
				+ "%d had water or lava in or beside the footprint, %d had a block too slow to clear or unseen cells, %d had no standing spot in front, "
				+ "%d had unseen ground, %d were checked%s", rejects[0], rejects[1], rejects[2], rejects[3],
				rejects[5], rejects[0] + rejects[1] + rejects[2] + rejects[3] + rejects[4] + rejects[5],
				casting ? String.format(Locale.ROOT, "; for casting, %d had no seen open or solid cells behind for the mould or before the frame, %d stood over %.0f blocks from, or %.0f above or below, the %d lava sources seen, %d would let the poured water run into the lava",
						rejects[6], rejects[7], CAST_POOL_REACH, CAST_RISE, pool.size(), rejects[8]) : "");
		// After a carve, an open site only the quick bound admits is the dug rock beside the refused carve (away-pair-1: 10
		// of 10 runs lost the way to its spots mid-cast, where main carved a second site and lit it 10 of 10): the next carve first.
		boolean loose = best != null && !bestSure && !(best.equals(carved) && bestBack == carvedBack);
		if (loose && casting && carves > 0 && carves < MAX_CARVES && !pool.isEmpty()) {
			Portal kept = best;
			best = null;
			if (carved != null) {
				carveNote += "; the carved site was refused after the dig (" + refusal(player, level, carved, carvedBack, pool, plain) + ")";
				rejectedSites.add(carved.origin());
				carved = null;
			}
			if (carve(player, pool, plain)) return running();
			best = kept;
		}
		if (best == null && carved != null) {
			carveNote += "; the carved site was refused after the dig (" + refusal(player, level, carved, carvedBack, pool, plain) + ")";
			rejectedSites.add(carved.origin());
			carved = null;
		}
		// Nothing seen by the lava is open floor (find's own tunnel, a closed cave): dig a site into the rock beside a spot
		// the body can stand on, as a player does, before walking off to look for level ground.
		if (best == null && casting && carves < MAX_CARVES && !pool.isEmpty() && carve(player, pool, plain)) return running();
		if (best == null && relocations < MAX_RELOCATIONS && requested == null) return relocate(player, now);
		if (best == null)
			return fail(player, "BUILD_NO_SITE", "No flat, dry 4-wide site within " + SITE_RADIUS + " blocks of " + xyz(center) + ": " + siteRejects + nextSite());
		if (carved != null && !(best.equals(carved) && bestBack == carvedBack)) carveNote += "; the carved site was refused after the dig (" + refusal(player, level, carved, carvedBack, pool, plain) + ")";
		carved = null;
		portal = best;
		back = bestBack;
		for (int y = 4; y >= 0; y--) for (int i = 0; i <= 3; i++) {
			BlockPos cell = portal.at(i, y);
			BlockState state = known(player, cell);
			if (y == 0 && (i == 0 || i == 3)) continue;
			if (state == null || state.isAir()) continue;
			if (portal.frame().contains(cell) && state.is(Blocks.OBSIDIAN)) continue;
			clears.add(cell);
		}
		int need = 0;
		for (BlockPos cell : portal.frame()) { BlockState state = known(player, cell); if (state == null || !state.is(Blocks.OBSIDIAN)) need++; }
		int obsidian = carried(player, "minecraft:obsidian");
		LOGGER.info("[build] {} site {} axis {} mould {} (cost {}, {} pool sources known)", player.getGameProfile().name(), xyz(portal.origin()), axisName(), back, String.format(Locale.ROOT, "%.1f", bestCost), pool.size());
		if (casting) return planCast(player);
		if (obsidian < need) return short_(player, "the frame needs " + need + " obsidian, " + obsidian + " carried; " + (need - obsidian) + " more" + CAST_HINT);
		Set<BlockPos> clearing = new HashSet<>(clears);
		List<BlockPos> todo = new ArrayList<>();
		for (BlockPos cell : portal.frame()) { BlockState state = known(player, cell); if (state == null || !state.is(Blocks.OBSIDIAN)) todo.add(cell); }
		order = order(todo, portal.corners(), cell -> !clearing.contains(cell) && full(player, cell));
		if (order == null) return fail(player, "BUILD_NO_SITE", "No placement order reaches every frame cell at " + xyz(portal.origin()));
		for (Placement p : order) if (p.scaffold()) scaffolds++;
		// Spares: each corner scaffold, and one block to step up on, since a body on the ground never sees the top faces
		// the top row is placed against (eye 2.6 blocks up, 3.9 at the top of a jump; the column tops are 4 up).
		spares = scaffolds + 1;
		siteNote = (relocations > 0 ? "walked to level ground; " : "") + "site " + xyz(portal.origin()) + " axis " + axisName() + (portal.origin().equals(center) ? "" : " (asked near " + xyz(center) + ")")
				+ ", " + clears.size() + " cells to clear, " + scaffolds + " corner scaffold" + (scaffolds == 1 ? "" : "s");
		phase = Phase.CLEAR;
		return running();
	}

	/**
	 * No site here (a peak, a slope): look out wider, then walk to the flattest seen ground 6-14 blocks away (the most
	 * standable cells level with it in a 5x5) and survey again, as a player walks off a hill to build.
	 */
	/**
	 * What to do after BUILD_NO_SITE. A cast is tied to its pool: find stops at its first sighting of lava, often down its
	 * own 1-wide tunnel, where nothing round the body is flat open floor (kit chain, gate seeds 1 and 6: both sightings
	 * ended here, and "another spot on open ground" named no place). The answer names the pool and how near the site
	 * must be.
	 */
	private String nextSite() {
		if (!casting || poolAt == null) return "; try another spot (at) on open ground";
		return String.format(Locale.ROOT, "; the cast needs flat open floor 4 wide within %.0f blocks of the lava at %s and at most %.0f blocks above or below it, "
				+ "and a tunnel or closed cave has none: travel_to open floor near that lava (a wider part of the cave) and build nether_portal there (at), "
				+ "or find block minecraft:lava from somewhere else for a pool in an open cave", CAST_POOL_REACH, xyz(poolAt), CAST_RISE);
	}

	private TickResult relocate(ServerPlayer player, long now) {
		ServerLevel level = (ServerLevel) player.level();
		if (wideLooks < 6) {
			if (lookAim == null) {
				double yaw = Math.toRadians(wideLooks * 60.0D + 30.0D);
				lookAim = player.getEyePosition().add(-Math.sin(yaw) * 10.0D, wideLooks % 2 == 0 ? -4.0D : 2.0D, Math.cos(yaw) * 10.0D);
			}
			releaseInput();
			if (!ServerLookController.turnToward(player, lookAim)) return running();
			var seen = SeenTerrain.of(player);
			for (BlockPos at : BlockPos.betweenClosed(center.offset(-WIDE_RADIUS, -10, -WIDE_RADIUS), center.offset(WIDE_RADIUS, 8, WIDE_RADIUS)))
				seen.known(at.getX(), at.getY(), at.getZ());
			lookAim = null;
			wideLooks++;
			return running();
		}
		BlockPos best = null;
		double bestScore = 0.0D;
		for (BlockPos at : BlockPos.betweenClosed(center.offset(-WIDE_RADIUS, -10, -WIDE_RADIUS), center.offset(WIDE_RADIUS, 8, WIDE_RADIUS))) {
			double distance = Math.sqrt(at.distSqr(center));
			if (distance < 6.0D || distance > WIDE_RADIUS + 2 || !standable(player, level, at)) continue;
			int level0 = 0;
			for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++)
				for (int dy = -1; dy <= 1; dy++) if (standable(player, level, at.offset(dx, dy, dz))) { level0++; break; }
			double score = level0 - 0.2D * distance - 0.1D * Math.abs(at.getY() - center.getY());
			if (level0 >= 12 && score > bestScore) { bestScore = score; best = at.immutable(); }
		}
		relocations++;
		wideLooks = 0;
		if (best == null) return fail(player, "BUILD_NO_SITE", "No flat, dry 4-wide site within " + SITE_RADIUS + " blocks of " + xyz(center)
				+ " (" + siteRejects + "), and no level seen ground within " + WIDE_RADIUS + " to walk to" + nextSite());
		siteNote = "no site at " + xyz(center) + ", walked toward level ground at " + xyz(best);
		center = best;
		looks = 0;
		phase = Phase.SURVEY;
		releaseInput();
		walks++;
		walk = new ServerNavigationController(Vec3.atBottomCenterOf(best), 1.0D, false, now, 30_000L);
		return running();
	}

	/** Why one cast site fails the usual rules, in words: the first reject count it raises. */
	private String refusal(ServerPlayer player, ServerLevel level, Portal p, Direction wall, List<BlockPos> pool, int plain) {
		int[] rejects = new int[11];
		rejects[10] = Integer.MAX_VALUE;
		if (siteCost(player, level, p, rejects) != Double.MAX_VALUE) castCost(player, level, p, wall, pool, plain, rejects);
		String[] why = { "no flat solid ground row", "water or lava in or beside the footprint", "a block too slow to clear or unseen cells",
				"no standing spot in front", "other", "unseen ground", "unseen or open cells behind for the mould or before the frame",
				"too far from, or above or below, the lava", "poured water would run into the lava", "short of plain blocks", "" };
		for (int k = 0; k < 10; k++) if (rejects[k] > 0) return why[k];
		return "passed, but another site cost less";
	}

	/** The site's cost, or MAX_VALUE with the reason counted: 0 ground, 1 fluid, 2 clearing, 3 standing, 4 other. */
	private double siteCost(ServerPlayer player, ServerLevel level, Portal p, int[] rejects) {
		double cost = 0.0D;
		Direction n = p.normal();
		for (int i = 0; i <= 3; i++) {
			BlockPos ground = p.at(i, 0);
			BlockState state = known(player, ground);
			if (state == null) { rejects[5]++; return Double.MAX_VALUE; }
			if (!state.isCollisionShapeFullBlock(level, ground) || !state.getFluidState().isEmpty() || state.getBlock() instanceof EntityBlock) { rejects[0]++; return Double.MAX_VALUE; }
			if (i == 1 || i == 2) {
				// Buried under the ground row, so usually unseen: only a seen hole, water or lava rules it out.
				BlockState below = known(player, ground.below());
				if (below != null && (!below.isCollisionShapeFullBlock(level, ground.below()) || !below.getFluidState().isEmpty())) { rejects[0]++; return Double.MAX_VALUE; }
				if (!state.is(Blocks.OBSIDIAN)) {
					double ticks = clearTicks(player, level, ground, state);
					if (ticks > MAX_CLEAR_TICKS) { rejects[2]++; return Double.MAX_VALUE; }
					cost += 0.5D + ticks / 20.0D;
				}
			}
		}
		for (int i = 0; i <= 3; i++) for (int y = 1; y <= 4; y++) {
			BlockPos cell = p.at(i, y);
			BlockState state = known(player, cell);
			if (state == null) { rejects[2]++; return Double.MAX_VALUE; }
			if (!state.getFluidState().isEmpty()) { rejects[1]++; return Double.MAX_VALUE; }
			if (state.isAir()) continue;
			if (state.is(Blocks.OBSIDIAN) && p.frame().contains(cell)) { cost -= 0.5D; continue; }
			double ticks = clearTicks(player, level, cell, state);
			if (ticks > MAX_CLEAR_TICKS) { rejects[2]++; return Double.MAX_VALUE; }
			cost += (state.canBeReplaced() ? 0.2D : 1.0D) + ticks / 20.0D;
		}
		// Water or lava in or beside the footprint, or lava a little further out: never build there.
		for (int i = -2; i <= 5; i++) for (int y = -1; y <= 5; y++) for (int k = -2; k <= 2; k++) {
			BlockState state = known(player, p.at(i, y).relative(n, k));
			if (state == null || state.getFluidState().isEmpty()) continue;
			boolean lava = TravelBuilder.lava(state);
			if (lava || (i >= -1 && i <= 4 && k >= -1 && k <= 1)) { rejects[1]++; return Double.MAX_VALUE; }
		}
		boolean stand = false;
		for (int dy : new int[] { 0, 1, -1 }) for (int k : new int[] { 2, -2, 3, -3 }) for (int i = 1; i <= 2 && !stand; i++)
			if (standable(player, level, p.at(i, 1 + dy).relative(n, k))) { stand = true; cost += (Math.abs(k) == 2 ? 0.0D : 1.0D) + Math.abs(dy); }
		if (!stand) { rejects[3]++; return Double.MAX_VALUE; }
		return cost;
	}

	/** Ticks to clear this block with the best carried tool: 0 for air and plants, MAX_VALUE for what is never mined. */
	private static double clearTicks(ServerPlayer player, ServerLevel level, BlockPos at, BlockState state) {
		if (state.isAir()) return 0.0D;
		if (state.canBeReplaced() && state.getFluidState().isEmpty()) return 1.0D;
		if (TravelBuilder.unmineable(state) != null || state.is(Blocks.OBSIDIAN)) return Double.MAX_VALUE;
		float hardness = state.getDestroySpeed(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
		double best = Double.POSITIVE_INFINITY;
		for (int slot = 0; slot < 36; slot++) best = Math.min(best, TravelBuilder.mineTicks(player.getInventory().getItem(slot), state, hardness));
		return Double.isFinite(best) ? best : Double.MAX_VALUE;
	}


	private TickResult clearTick(ServerPlayer player, long now) {
		// Water or lava a carve broke into (seen only once the cell beside it opened): the openings are plugged first.
		if (carving) { TickResult plug = plugInlets(player, "the dig opened onto it"); if (plug != null) return plug; }
		// Off the footprint first: never mine the ground the body stands on or the cells it stands in.
		if (inFootprint(player.blockPosition()) || inFootprint(player.blockPosition().below())) {
			BlockPos spot = standFor(player, eye -> true);
			if (spot == null) return fail(player, "NO_STAND_SPOT", "No seen standing spot beside the site " + xyz(portal.origin()));
			return walkTo(player, spot, now);
		}
		if (clears.isEmpty()) {
			if (carving) {
				// The rock left behind the dig (the mould) and under it (the ground row) is judged from sight: look at each first.
				if (!carveLooked) {
					carveLooked = true;
					carveLooks.addAll(wallCells(portal, back));
					for (int i = 0; i <= 3; i++) carveLooks.add(portal.at(i, 0));
				}
				while (!carveLooks.isEmpty() && known(player, carveLooks.get(0)) != null) carveLooks.remove(0);
				if (!carveLooks.isEmpty()) {
					BlockPos cell = carveLooks.get(0);
					if (!cell.equals(lookCell)) { lookCell = cell.immutable(); cellTicks = 0; }
					if (cellTicks++ < 10) { releaseInput(); ServerLookController.turnToward(player, Vec3.atCenterOf(cell)); return running(); }
					carveLooks.remove(0);
					return running();
				}
				// Chosen at once: sight memory lasts 10 s, and a full look round outlasts it, forgetting the rock just looked at.
				carveLooked = false;
				carving = false; center = carveStand; portal = null; lookAim = null; phase = Phase.SURVEY;
				return chooseSite(player, now);
			}
			if (clearThenCast) { clearThenCast = false; phase = Phase.CAST; return running(); }
			if (spareCount(player) < spares) { phase = Phase.COLLECT; return running(); }
			phase = Phase.PLACE;
			return running();
		}
		// A carve digs into rock no eye has seen: the next cell the dig has opened to view goes first.
		if (carving && known(player, clears.get(0)) == null) for (int k = 1; k < clears.size(); k++) if (known(player, clears.get(k)) != null) {
			clears.add(0, clears.remove(k));
			break;
		}
		BlockPos cell = clears.get(0);
		BlockState state = known(player, cell);
		if (state == null) return observe(player, cell, now);
		if (state.isAir()) { BlockPos open = clears.remove(0); if (carving) carveOpened.add(open); return running(); }
		if (!state.getFluidState().isEmpty() && carving && rejectedSites.size() < 3) return chooseAgain(player, now, "water or lava at " + xyz(cell));
		if (!state.getFluidState().isEmpty()) return fail(player, "BUILD_BLOCKED", "Water or lava flowed into the site at " + xyz(cell));
		Vec3 eye = player.getEyePosition();
		if (TargetSightline.block(player.level(), CollisionContext.of(player), eye, cell, player.blockInteractionRange(), null) == null) {
			BlockPos spot = standFor(player, e -> TargetSightline.block(player.level(), CollisionContext.of(player), e, cell, player.blockInteractionRange() - 0.3D, null) != null);
			if (spot == null) return fail(player, "NO_STAND_SPOT", "No seen standing spot reaches " + describe(state) + " at " + xyz(cell) + lastWalk());
			return walkTo(player, spot, now);
		}
		releaseInput();
		try {
			return startChild(player, Child.CLEAR, environment.clear(player, cell, Math.min(20_000L, Math.max(1L, deadline - now))));
		} catch (AgentDomainException refused) {
			if ("TARGET_NOT_VISIBLE".equals(refused.code()) && cellTicks++ < 20) return running();
			if (carving) { TickResult plug = plugInlets(player, refused.code() + " at " + xyz(cell)); if (plug != null) return plug; }
			if (casting && index == 0 && castIndex == 0 && rejectedSites.size() < 3) return chooseAgain(player, now, refused.code() + " at " + xyz(cell));
			return fail(player, refused.code(), "Clearing " + describe(state) + " at " + xyz(cell) + ": " + refused.getMessage());
		}
	}

	/** Blocks dropped by the clearing (the dirt of the bottom row) become the spares when too few are carried. */
	private TickResult collectTick(ServerPlayer player, long now) {
		if (spareCount(player) >= spares) { phase = Phase.PLACE; return running(); }
		if (collectTries++ < 8) {
			AABB around = new AABB(Vec3.atCenterOf(portal.at(1, 0)), Vec3.atCenterOf(portal.at(2, 0))).inflate(5.0D);
			ItemEntity drop = player.level().getEntitiesOfClass(ItemEntity.class, around, item -> item.isAlive() && scaffoldBlock(item.getItem()) && !skippedDrops.contains(item.getUUID()))
					.stream().min(Comparator.comparingDouble(player::distanceToSqr)).orElse(null);
			if (drop != null) {
				// Vanilla picks a drop up on contact: the body walks into its cell (the dug ground row lies a step down).
				if (player.getBoundingBox().inflate(1.0D, 0.5D, 1.0D).intersects(drop.getBoundingBox())) { releaseInput(); pause = 10; return running(); }
				BlockPos hole = drop.blockPosition();
				BlockPos lip = holeLip(player, hole);
				if (lip != null) {
					GridPosition feet = ServerTravelController.feet(player);
					if (feet.x() != lip.getX() || feet.y() != lip.getY() || feet.z() != lip.getZ()) {
						if (walks >= MAX_WALKS) return short_(player, "the dug blocks lie in a hole the body could not reach the rim of" + lastWalk());
						releaseInput();
						walks++;
						walk = new ServerNavigationController(Vec3.atBottomCenterOf(lip), 0.3D, false, now, 8_000L);
						return running();
					}
					if (known(player, hole.below()) == null && lookTicks++ < 15) {
						releaseInput();
						ServerLookController.turnToward(player, Vec3.atCenterOf(hole.below()).add(0.0D, 0.5D, 0.0D));
						collectTries--;
						return running();
					}
					lookTicks = 0;
					if (!safeHoleLanding(cell -> known(player, cell), player.level(), feet, hole)) { skippedDrops.add(drop.getUUID()); return running(); }
					double dx = hole.getX() + 0.5D - player.getX(), dz = hole.getZ() + 0.5D - player.getZ();
					if (collectSteps++ < 40) {
						// Toward the middle of the hole, so the whole body fits over it and steps down (pathfinding will not
						// enter a one-wide hole, and pickup reaches only half a block below the feet).
						collectTries--;
						apply(player, new AgentInputStates.MotorTarget(player.getYRot(), 30.0F, true, false, false, (float) Math.toDegrees(Math.atan2(-dx, dz))), false, now);
						return running();
					}
					skippedDrops.add(drop.getUUID());
					return running();
				}
				releaseInput();
				walks++;
				walk = new ServerNavigationController(drop.position(), 0.3D, false, now, 8_000L);
				return running();
			}
		}
		int have = spareCount(player);
		// One spare short still builds when the ground offers a higher spot; none at all cannot reach the top row.
		if (have >= (casting ? mouldBlocks : Math.max(1, scaffolds))) { phase = Phase.PLACE; return running(); }
		if (casting) return short_(player, "the cast's mould needs " + mouldBlocks + " plain blocks (dirt, cobblestone...) and 1 to step up on; "
				+ have + " carried and no dropped block nearby; " + (spares - have) + " more" + lastWalk());
		return short_(player, "the top row needs " + spares + " plain blocks (dirt, cobblestone...): " + scaffolds + " as a corner scaffold and 1 to step up on; "
				+ have + " carried and no dropped block nearby; " + (spares - have) + " more" + lastWalk());
	}

	/**
	 * Whether a body standing in {@code feet} may step down into {@code hole} to pick up a drop: the hole is the cell one
	 * below the feet level, it and the cell over it are seen open and dry, and its floor is a seen sturdy dry block. An
	 * unseen floor, a deeper drop or any fluid says no.
	 */
	public static boolean safeHoleLanding(java.util.function.Function<BlockPos, BlockState> known, net.minecraft.world.level.BlockGetter shapes,
			GridPosition feet, BlockPos hole) {
		if (hole.getY() != feet.y() - 1) return false;
		for (BlockPos open : new BlockPos[] { hole, hole.above() }) {
			BlockState state = known.apply(open);
			if (state == null || !state.getCollisionShape(shapes, open).isEmpty() || !state.getFluidState().isEmpty() || TravelBuilder.fire(state)) return false;
		}
		BlockState floor = known.apply(hole.below());
		return floor != null && floor.isFaceSturdy(shapes, hole.below(), Direction.UP) && floor.getFluidState().isEmpty()
				&& !floor.is(Blocks.MAGMA_BLOCK) && !TravelBuilder.lava(floor);
	}

	/**
	 * The rim of a hole holding a drop: a seen standing cell beside it, level with the cell over it (one block above the
	 * hole), nearest the body; null when the drop does not lie in a hole (no such rim, or the cell over it is not open).
	 */
	private BlockPos holeLip(ServerPlayer player, BlockPos hole) {
		BlockState over = known(player, hole.above());
		if (over == null || !over.getCollisionShape(player.level(), hole.above()).isEmpty()) return null;
		BlockState inside = known(player, hole);
		if (inside != null && !inside.getCollisionShape(player.level(), hole).isEmpty()) return null;
		BlockPos best = null;
		for (Direction side : Direction.Plane.HORIZONTAL) {
			BlockPos rim = hole.relative(side).above();
			if (!standable(player, (ServerLevel) player.level(), rim)) continue;
			if (best == null || rim.distSqr(player.blockPosition()) < best.distSqr(player.blockPosition())) best = rim.immutable();
		}
		return best;
	}

	/** Spare blocks for scaffolds and steps: plain blocks, then obsidian beyond what the frame still needs. */
	private int spareCount(ServerPlayer player) {
		int plain = 0;
		Set<String> seen = new HashSet<>();
		for (int slot = 0; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!scaffoldBlock(stack)) continue;
			String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			if (seen.add(id)) plain += carried(player, id);
		}
		return plain + Math.max(0, carried(player, "minecraft:obsidian") - frameLeft(player));
	}

	private String spareItem(ServerPlayer player) {
		String plain = plainBlock(player, true);
		if (plain != null) return plain;
		return carried(player, "minecraft:obsidian") > frameLeft(player) ? "minecraft:obsidian" : null;
	}

	private int frameLeft(ServerPlayer player) {
		if (portal == null) return 0;
		int left = 0;
		for (BlockPos cell : portal.frame()) { BlockState state = known(player, cell); if (state == null || !state.is(Blocks.OBSIDIAN)) left++; }
		return left;
	}

	private TickResult placeTick(ServerPlayer player, long now) {
		if (index >= order.size()) {
			releaseInput();
			if (casting) for (BlockPos cell : mould) if (full(player, cell)) madeSolid.add(cell);
			phase = casting ? Phase.CAST : Phase.LIGHT;
			return running();
		}
		Placement p = order.get(index);
		BlockState state = known(player, p.at());
		if (state != null && (p.scaffold() || casting ? full(player, p.at()) : state.is(Blocks.OBSIDIAN))) { index++; cellTicks = 0; jumping = false; return running(); }
		if (state != null && !state.canBeReplaced()) { clears.add(0, p.at()); phase = Phase.CLEAR; return running(); }
		String item = casting ? mouldItem(player) : p.scaffold() ? spareItem(player) : material;
		if (item == null || carried(player, item) == 0)
			return short_(player, casting ? "the mould at " + xyz(p.at()) + " needs 1 plain block (dirt, cobblestone...), none left"
					: p.scaffold() ? "the corner scaffold at " + xyz(p.at()) + " needs 1 plain block (dirt, cobblestone...), none left"
					: "ran out of obsidian at " + xyz(p.at()) + " (" + frameLeft(player) + " frame cells left)");
		if (stepAt != null) {
			BlockPos at = stepAt;
			stepAt = null;
			if (player.blockPosition().equals(at) && player.onGround()) {
				String spare = spareItem(player);
				if (spare == null) return short_(player, "reaching " + xyz(p.at()) + " needs 1 plain block to step up on, none left");
				steps++;
				startY = at.getY();
				pillarGoal = at.getY() + 1;
				pillarReturn = Phase.PLACE;
				moveStage = 0;
				phase = Phase.PILLAR;
				return running();
			}
		}
		if (player.getBoundingBox().intersects(new AABB(p.at()))) {
			BlockPos spot = standFor(player, eye -> sees(player, eye, p.at()) || sees(player, eye.add(0.0D, 1.0D, 0.0D), p.at()));
			if (spot == null) return fail(player, "NO_STAND_SPOT", "The body stands in frame cell " + xyz(p.at()) + " and no spot reaches it");
			return walkTo(player, spot, now);
		}
		Vec3 aim = null;
		try { aim = environment.aim(player, p.at(), Direction.UP, item); }
		catch (AgentDomainException blocked) { refusal = blocked.code() + ": " + blocked.getMessage(); }
		if (aim == null && !jumping) {
			if (!player.onGround()) return running();
			if (cellTicks < CELL_TICKS && sees(player, player.getEyePosition().add(0.0D, 1.0D, 0.0D), p.at())) jumping = true;
			else return reposition(player, p, now);
		}
		if (++cellTicks > CELL_TICKS * 2) {
			jumping = false;
			cellTicks = 0;
			triedSpots.add(player.blockPosition().immutable());
			return reposition(player, p, now);
		}
		Vec3 target = aim != null ? aim : supportPoint(player, p.at());
		if (!turn(player, target, jumping && player.onGround()) || aim == null) return running();
		if (!jumping && !player.onGround()) return running();
		String why = place(player, p.at(), item);
		if (why == null) {
			placed++;
			index++;
			cellTicks = 0;
			jumping = false;
			pause = 2;
		} else refusal = why;
		return running();
	}

	private TickResult reposition(ServerPlayer player, Placement p, long now) {
		BlockPos spot = standFor(player, eye -> sees(player, eye, p.at()) || sees(player, eye.add(0.0D, 1.0D, 0.0D), p.at()));
		if (spot != null) return walkTo(player, spot, now);
		if (steps >= 3) return fail(player, "NO_STAND_SPOT", "No spot reaches a face to place " + xyz(p.at()) + " against after " + steps + " steps up; " + refusal + lastWalk());
		BlockPos raised = raisedSpot(player);
		if (raised == null) return fail(player, "NO_STAND_SPOT", "No seen spot, even one block up, reaches a face to place " + xyz(p.at()) + " against; " + refusal + lastWalk());
		if (spareItem(player) == null) return short_(player, "reaching " + xyz(p.at()) + " needs 1 plain block to step up on (dirt, cobblestone...), none carried");
		stepAt = raised;
		if (raised.equals(player.blockPosition())) return running();
		return walkTo(player, raised, now);
	}

	/**
	 * A seen spot with headroom for one block more, chosen by how many of the placements left an eye one block up
	 * could make, standing or at the top of a jump (each needing a support face it sits outside of, within reach).
	 */
	private BlockPos raisedSpot(ServerPlayer player) {
		ServerLevel level = (ServerLevel) player.level();
		BlockPos around = portal.at(1, 1);
		BlockPos best = null;
		double bestScore = 0.0D;
		Set<BlockPos> solidLater = new HashSet<>();
		for (int i = 0; i < index; i++) solidLater.add(order.get(i).at());
		for (BlockPos at : BlockPos.betweenClosed(around.offset(-4, -2, -4), around.offset(4, 2, 4))) {
			if (blocked(at) || blocked(at.above()) || blocked(at.above(2)) || !standable(player, level, at)) continue;
			BlockState head = known(player, at.above(2));
			if (head == null || !head.getCollisionShape(level, at.above(2)).isEmpty() || !head.getFluidState().isEmpty()) continue;
			Vec3 eye = Vec3.atBottomCenterOf(at).add(0.0D, player.getEyeHeight() + 1.0D, 0.0D);
			Set<BlockPos> solid = new HashSet<>(solidLater);
			int reached = 0;
			for (int i = index; i < order.size(); i++) {
				BlockPos cell = order.get(i).at();
				if (outsideFace(player, eye, cell, solid) || outsideFace(player, eye.add(0.0D, 1.0D, 0.0D), cell, solid)) reached++;
				else break;
				solid.add(cell);
			}
			double score = reached - 0.05D * Vec3.atBottomCenterOf(at).distanceTo(player.position());
			if (reached > 0 && score > bestScore) { bestScore = score; best = at.immutable(); }
		}
		return best;
	}

	/** Geometry only: the eye sits outside a support face toward the cell (a seen solid neighbour or a planned one) within reach. */
	private boolean outsideFace(ServerPlayer player, Vec3 eye, BlockPos cell, Set<BlockPos> planned) {
		for (Direction side : Direction.values()) {
			BlockPos support = cell.relative(side);
			if (!planned.contains(support) && !full(player, support)) continue;
			Direction face = side.getOpposite();
			Vec3 center = Vec3.atCenterOf(support).add(face.getStepX() * 0.5D, face.getStepY() * 0.5D, face.getStepZ() * 0.5D);
			double outside = (eye.x - center.x) * face.getStepX() + (eye.y - center.y) * face.getStepY() + (eye.z - center.z) * face.getStepZ();
			if (outside > 0.05D && eye.distanceTo(center) <= player.blockInteractionRange() - 0.3D) return true;
		}
		return false;
	}

	private boolean sees(ServerPlayer player, Vec3 eye, BlockPos cell) {
		double reach = player.blockInteractionRange() - 0.3D;
		for (Direction side : Direction.values()) {
			BlockPos support = cell.relative(side);
			if (!full(player, support)) continue;
			if (TargetSightline.block(player.level(), CollisionContext.of(player), eye, support, reach, side.getOpposite()) != null) return true;
		}
		return false;
	}

	/** The centre of a solid neighbour's face toward the cell, for a turn before a jump brings it into sight. */
	private Vec3 supportPoint(ServerPlayer player, BlockPos cell) {
		for (Direction side : new Direction[] { Direction.DOWN, Direction.WEST, Direction.EAST, Direction.NORTH, Direction.SOUTH, Direction.UP }) {
			BlockPos support = cell.relative(side);
			if (full(player, support)) return Vec3.atCenterOf(cell).add(side.getStepX() * 0.499D, side.getStepY() * 0.499D, side.getStepZ() * 0.499D);
		}
		return Vec3.atCenterOf(cell);
	}


	private TickResult lightTick(ServerPlayer player, long now) {
		for (BlockPos cell : portal.interior()) {
			BlockState state = known(player, cell);
			if (state != null && state.is(Blocks.NETHER_PORTAL)) {
				releaseInput();
				Vec3 step = Vec3.atBottomCenterOf(portal.at(1, 1));
				return end(player, TickResult.succeeded("PORTAL_LIT", facts(player) + "; the portal at " + xyz(portal.origin()) + " axis " + axisName()
						+ " is lit; step into the opening at " + xyz(portal.at(1, 1)) + String.format(Locale.ROOT, " (%.1f, %.1f, %.1f)", step.x, step.y, step.z) + " and wait 4 s to cross"));
			}
		}
		for (BlockPos cell : portal.frame()) {
			BlockState state = known(player, cell);
			if (state == null) return observe(player, cell, now);
			if (!state.is(Blocks.OBSIDIAN)) return fail(player, "BUILD_BLOCKED", "Frame cell " + xyz(cell) + " holds " + describe(state) + ", not obsidian");
		}
		if (lightWait > 0) {
			if (++lightWait > 20) {
				lightWait = 0;
				for (BlockPos cell : portal.interior()) {
					BlockState state = known(player, cell);
					if (state != null && TravelBuilder.fire(state)) { clears.add(cell); }
				}
				if (!clears.isEmpty()) { phase = Phase.CLEAR; return running(); }
			}
			return running();
		}
		for (BlockPos cell : portal.interior()) {
			BlockState state = known(player, cell);
			if (state == null) return observe(player, cell, now);
			// Cast water still draining down the opening: it goes on its own within a few seconds.
			if (!state.getFluidState().isEmpty() && !TravelBuilder.lava(state)) {
				if (drainTicks++ < 200) { releaseInput(); ServerLookController.turnToward(player, Vec3.atCenterOf(cell)); return running(); }
				return fail(player, "BUILD_BLOCKED", "Water stays in the opening at " + xyz(cell) + (pouredWater == null ? "" : "; a poured source is at " + xyz(pouredWater)));
			}
			if (!state.isAir() && !TravelBuilder.fire(state)) { clears.add(cell); phase = Phase.CLEAR; return running(); }
		}
		if (lightTries >= 3) return fail(player, "PORTAL_NOT_LIT", "Three lights left the frame unlit");
		String lighter = lighter(player);
		if (lighter == null) return short_(player, "lighting the portal needs 1 flint_and_steel (or a fire_charge), none left");
		BlockHitResult face = lightFace(player, player.getEyePosition());
		if (face == null || inFootprint(player.blockPosition())) {
			BlockPos spot = standFor(player, eye -> lightFace(player, eye) != null);
			if (spot == null) return fail(player, "NO_STAND_SPOT", "No seen standing spot sees an inner face of the frame" + lastWalk());
			return walkTo(player, spot, now);
		}
		int slot = slot(player, lighter);
		if (slot >= 9) {
			releaseInput();
			var swap = dev.agaminggod.mineagen.server.runtime.AdvancedInteractionService.swapIntoHotbar(player, slot, player.getInventory().getSelectedSlot());
			if (swap != null) return fail(player, swap.reasonCode(), swap.message());
			pause = 1;
			return running();
		}
		if (player.getInventory().getSelectedSlot() != slot) { player.getInventory().setSelectedSlot(slot); pause = 1; return running(); }
		if (!turn(player, face.getLocation(), false)) return running();
		BlockHitResult hit = TravelBuilder.crosshair(player);
		if (hit == null || !hit.getBlockPos().equals(face.getBlockPos()) || hit.getDirection() != face.getDirection()) {
			if (++cellTicks > CELL_TICKS) { cellTicks = 0; triedSpots.add(player.blockPosition()); BlockPos spot = standFor(player, eye -> lightFace(player, eye) != null); if (spot != null) return walkTo(player, spot, now); }
			return running();
		}
		TravelBuilder.click(player, hit);
		lightTries++;
		lightWait = 1;
		cellTicks = 0;
		return running();
	}

	private BlockHitResult lightFace(ServerPlayer player, Vec3 eye) {
		Direction forward = portal.axis() == Direction.Axis.Z ? Direction.SOUTH : Direction.EAST;
		List<BlockHitResult> faces = new ArrayList<>();
		for (int i = 1; i <= 2; i++) faces.add(new BlockHitResult(Vec3.ZERO, Direction.UP, portal.at(i, 0), false));
		for (int y = 1; y <= 3; y++) {
			faces.add(new BlockHitResult(Vec3.ZERO, forward, portal.at(0, y), false));
			faces.add(new BlockHitResult(Vec3.ZERO, forward.getOpposite(), portal.at(3, y), false));
		}
		for (int i = 1; i <= 2; i++) faces.add(new BlockHitResult(Vec3.ZERO, Direction.DOWN, portal.at(i, 4), false));
		for (BlockHitResult f : faces) {
			Vec3 aim = TargetSightline.block(player.level(), CollisionContext.of(player), eye, f.getBlockPos(), player.blockInteractionRange() - 0.2D, f.getDirection());
			if (aim != null) return new BlockHitResult(aim, f.getDirection(), f.getBlockPos(), false);
		}
		return null;
	}


	/**
	 * Opens the pool's surface as a player does before a cast: while fewer than {@link #UNCOVER_TARGET} open sources are in
	 * view, mine the next block lying on the pool (on a seen source, or beside a block already opened over lava), from a
	 * standing spot off it; lava under a block never flows up, and the break refuses one with lava seen or heard beside or
	 * above it. Each opened block shows the source under it. Then the site survey.
	 */
	private TickResult uncoverTick(ServerPlayer player, long now) {
		if (walksBeforeUncover < 0) walksBeforeUncover = walks;
		// Eyes on the pool first: a walk here turned them away, and sight of it fades in 10 s.
		if (uncoverLooks < 12 && poolAt != null) { uncoverLooks++; releaseInput(); ServerLookController.turnToward(player, Vec3.atCenterOf(poolAt)); return running(); }
		int open = openSources(player);
		BlockPos cell = open >= UNCOVER_TARGET || uncovers >= MAX_UNCOVERS ? null : nextUncover(player);
		if (cell == null) {
			// Walks over the pool do not count against the build's own walks.
			walks = walksBeforeUncover + Math.min(uncoverWalks, 2);
			uncoverNote = String.format(Locale.ROOT, "%d open lava source(s) in view after opening %d block(s) over the pool", open, uncovers);
			phase = Phase.SURVEY;
			return running();
		}
		ServerLevel level = (ServerLevel) player.level();
		if (known(player, cell) == null) {
			if (!cell.equals(lookCell)) { lookCell = cell.immutable(); lookTicks = 0; }
			if (lookTicks++ < 15) { releaseInput(); ServerLookController.turnToward(player, Vec3.atCenterOf(cell)); return running(); }
			uncoverDead.add(cell);
			return running();
		}
		BlockState state = known(player, cell);
		if (state.isAir() || !state.getFluidState().isEmpty()) { uncoverDead.add(cell); return running(); }
		if (TargetSightline.block(level, CollisionContext.of(player), player.getEyePosition(), cell, player.blockInteractionRange() - 0.3D, null) == null) {
			BlockPos spot = uncoverWalks < 6 ? standFor(player, eye -> TargetSightline.block(level, CollisionContext.of(player), eye, cell, player.blockInteractionRange() - 0.3D, null) != null) : null;
			if (spot == null) { uncoverDead.add(cell); return running(); }
			uncoverWalks++;
			return walkTo(player, spot, now);
		}
		uncoverCell = cell;
		releaseInput();
		try {
			return startChild(player, Child.UNCOVER, environment.uncover(player, cell, Math.min(15_000L, Math.max(1L, deadline - now))));
		} catch (AgentDomainException refused) {
			uncoverDead.add(cell);
			return running();
		}
	}

	private int openSources(ServerPlayer player) {
		int open = 0;
		for (BlockPos source : lavaSources(player, player.blockPosition(), (int) CAST_POOL_REACH)) {
			BlockState over = known(player, source.above());
			if (over != null && (over.isAir() || TravelBuilder.lava(over) && !over.getFluidState().isSource())) open++;
		}
		return open;
	}

	/**
	 * The next block to open over the pool, nearest the eye first: a seen solid block on a seen source, or one beside an
	 * open cell over a source (the pool goes on under it); never the body's own cells or the ground under it, and
	 * nothing with fluid seen beside or above it. Null when none is left.
	 */
	private BlockPos nextUncover(ServerPlayer player) {
		ServerLevel level = (ServerLevel) player.level();
		Set<BlockPos> candidates = new HashSet<>();
		// Open over lava: what this build opened, and any seen source with air on it (the block find opened, a cave's pool).
		Set<BlockPos> openOver = new HashSet<>();
		for (BlockPos opened : uncovered) if (lavaSource(known(player, opened.below()))) openOver.add(opened);
		for (BlockPos source : castPool(player, player.blockPosition(), 8)) {
			BlockState over = known(player, source.above());
			if (over != null && over.isAir()) openOver.add(source.above()); else candidates.add(source.above());
		}
		for (BlockPos opened : openOver) for (Direction side : Direction.Plane.HORIZONTAL) candidates.add(opened.relative(side));
		BlockPos feet = player.blockPosition();
		Vec3 eye = player.getEyePosition();
		BlockPos best = null;
		double bestCost = Double.MAX_VALUE;
		for (BlockPos cell : candidates) {
			if (uncovered.contains(cell) || uncoverDead.contains(cell) || cell.equals(feet) || cell.equals(feet.above()) || cell.equals(feet.below())) continue;
			BlockState state = known(player, cell);
			// Unseen is looked at when its turn comes.
			if (state != null && (state.isAir() || !state.getFluidState().isEmpty() || clearTicks(player, level, cell, state) > MAX_CLEAR_TICKS)) continue;
			if (Vec3.atCenterOf(cell).distanceTo(eye) > player.blockInteractionRange() + 3.0D) continue;
			boolean wet = false;
			for (Direction side : Direction.values()) {
				if (side == Direction.DOWN) continue;
				BlockState next = known(player, cell.relative(side));
				if (next != null && !next.getFluidState().isEmpty()) wet = true;
			}
			if (wet) continue;
			// Next to blocks already opened first: one window, not holes all round the body.
			double cost = Vec3.atCenterOf(cell).distanceTo(eye) - (lavaSource(known(player, cell.below())) ? 2.0D : 0.0D);
			if (cost < bestCost) { bestCost = cost; best = cell.immutable(); }
		}
		return best;
	}

	/** Walks to the cast center first when the pool was seen from afar (find stops at the first sighting). */
	private TickResult approach(ServerPlayer player, long now) {
		// Lava beside the body first (a search that stopped at the pool may have opened a cell it runs through): step back.
		if (lavaWithin(player, player.blockPosition(), 2) && approaches < 3) {
			approaches++;
			BlockPos away = null;
			double best = Double.MAX_VALUE;
			ServerLevel level = (ServerLevel) player.level();
			for (BlockPos at : BlockPos.betweenClosed(player.blockPosition().offset(-6, -2, -6), player.blockPosition().offset(6, 2, 6))) {
				if (!standable(player, level, at) || lavaWithin(player, at, 3)) continue;
				double cost = Math.sqrt(at.distSqr(player.blockPosition()));
				if (cost < best) { best = cost; away = at.immutable(); }
			}
			if (away != null) { releaseInput(); walks++; walk = new ServerNavigationController(Vec3.atBottomCenterOf(away), 0.5D, false, now, 15_000L); return running(); }
		}
		double dx = center.getX() + 0.5D - player.getX(), dz = center.getZ() + 0.5D - player.getZ();
		boolean level = Math.abs(center.getY() - player.blockPosition().getY()) <= 3;
		if (!casting || Math.sqrt(dx * dx + dz * dz) <= 6.0D && level || approaches >= 3) { phase = casting ? Phase.UNCOVER : Phase.SURVEY; return running(); }
		approaches++;
		releaseInput();
		walks++;
		walk = new ServerNavigationController(Vec3.atBottomCenterOf(center), 3.0D, false, now, 45_000L);
		return running();
	}

	private boolean lavaWithin(ServerPlayer player, BlockPos feet, int r) {
		for (BlockPos at : BlockPos.betweenClosed(feet.offset(-r, -1, -r), feet.offset(r, 2, r)))
			if (TravelBuilder.lava(known(player, at))) return true;
		return false;
	}

	/** Where to look for a site: about 5 blocks from the pool toward the body, on seen standing ground when there is some. */
	private BlockPos castCenter(ServerPlayer player, BlockPos pool) {
		double dx = player.getX() - (pool.getX() + 0.5D), dz = player.getZ() - (pool.getZ() + 0.5D);
		double length = Math.sqrt(dx * dx + dz * dz);
		if (length < 6.0D && Math.abs(player.blockPosition().getY() - pool.getY() - 1) <= 3) return player.blockPosition();
		if (length < 1.0D) { dx = 1.0D; length = 1.0D; }
		BlockPos guess = BlockPos.containing(pool.getX() + 0.5D + dx / length * 5.0D, pool.getY() + 1, pool.getZ() + 0.5D + dz / length * 5.0D);
		ServerLevel level = (ServerLevel) player.level();
		BlockPos best = null;
		double bestCost = Double.MAX_VALUE;
		// Seen ground near the pool's own level: the ten trips are walked between the frame and the shore.
		for (BlockPos at : BlockPos.betweenClosed(guess.offset(-6, -6, -6), guess.offset(6, 6, 6))) {
			if (!standable(player, level, at)) continue;
			double cost = Math.sqrt(at.distSqr(guess)) + 2.0D * Math.max(0, Math.abs(at.getY() - pool.getY() - 1) - 1);
			if (cost < bestCost) { bestCost = cost; best = at.immutable(); }
		}
		return best != null ? best : guess;
	}

	private List<BlockPos> lavaSources(ServerPlayer player, BlockPos around, int radius) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		Level level = player.level();
		List<BlockPos> out = new ArrayList<>();
		Vec3 eye = player.getEyePosition();
		for (BlockPos at : BlockPos.betweenClosed(around.offset(-radius, -16, -radius), around.offset(radius, 8, radius))) {
			if (!lavaSource(level.getBlockState(at)) && !lavaSource(seen.recalled(at.getX(), at.getY(), at.getZ()))) continue;
			if (lavaSource(seen.known(at.getX(), at.getY(), at.getZ()))) out.add(at.immutable());
			// Seen only as its spill: the empty bucket reaches it through the flow, so it is kept as the pool a bucket can take.
			else if (BucketReach.throughFlow(level, CollisionContext.of(player), eye, player.blockInteractionRange(), at)) {
				out.add(at.immutable());
				if (poolMemory.size() < 4096) poolMemory.add(at.immutable());
			}
		}
		out.sort(Comparator.comparingDouble(at -> Vec3.atCenterOf(at).distanceToSqr(eye)));
		// Remember the pool's surface (open-topped, or under flowing lava), the sources a bucket can reach.
		for (BlockPos at : out) {
			if (poolMemory.size() >= 4096) break;
			BlockState over = seen.known(at.getX(), at.getY() + 1, at.getZ());
			if (over != null && (over.isAir() || TravelBuilder.lava(over) && !over.getFluidState().isSource())) poolMemory.add(at);
		}
		return out;
	}

	/**
	 * The pool a site is judged against: sources seen now, and the pool surface this build saw that is out of sight now and
	 * not seen gone (sight memory fades in 10 s, and a carve or a walk turns the eyes away from the lava).
	 */
	private List<BlockPos> castPool(ServerPlayer player, BlockPos around, int radius) {
		List<BlockPos> pool = new ArrayList<>(lavaSources(player, around, radius));
		Set<BlockPos> listed = new HashSet<>(pool);
		for (BlockPos at : poolMemory) {
			if (listed.contains(at) || Math.abs(at.getX() - around.getX()) > radius || Math.abs(at.getZ() - around.getZ()) > radius) continue;
			BlockState state = known(player, at);
			if (state == null || lavaSource(state)) pool.add(at);
		}
		return pool;
	}

	private static boolean lavaSource(BlockState state) {
		return state != null && state.getFluidState().isSource() && state.getFluidState().getType().isSame(Fluids.LAVA);
	}

	/**
	 * The mould behind a cast frame on side {@code wall}: behind the opening's two columns, rows 1-4 (the water there casts
	 * the side columns and lava there casts the top row), and behind the side columns' top two rows (their lava, and the
	 * top corners' water). The bottom row and the lower side cells take their lava on the block below.
	 */
	static List<BlockPos> wallCells(Portal p, Direction wall) {
		List<BlockPos> cells = new ArrayList<>();
		for (int y = 1; y <= 4; y++) for (int i = 1; i <= 2; i++) cells.add(p.at(i, y).relative(wall));
		for (int y = 3; y <= 4; y++) for (int i : new int[] { 0, 3 }) cells.add(p.at(i, y).relative(wall));
		return cells;
	}

	/**
	 * The frame cells in casting order, each with the open cell its water goes into: above a bottom cell, beside a side
	 * cell in the opening, in the top corner beside a top cell (water below a lava source does not cast it).
	 */
	static List<BlockPos[]> castPairs(Portal p) {
		List<BlockPos[]> pairs = new ArrayList<>();
		pairs.add(new BlockPos[] { p.at(1, 0), p.at(1, 1) });
		pairs.add(new BlockPos[] { p.at(2, 0), p.at(2, 1) });
		for (int y = 1; y <= 3; y++) {
			pairs.add(new BlockPos[] { p.at(0, y), p.at(1, y) });
			pairs.add(new BlockPos[] { p.at(3, y), p.at(2, y) });
		}
		pairs.add(new BlockPos[] { p.at(1, 4), p.at(0, 4) });
		pairs.add(new BlockPos[] { p.at(2, 4), p.at(3, 4) });
		return pairs;
	}

	static int castBlocks(int mouldCells) {
		return Math.max(0, mouldCells + 1 - 2);
	}

	/**
	 * A cast site's added cost with the mould on side {@code wall}, or MAX_VALUE: 6 the mould cells, 7 too far from the lava,
	 * 8 the water's run, 9 a site fit in every way but the plain blocks carried, with 10 the fewest such a site needs.
	 */
	private double castCost(ServerPlayer player, ServerLevel level, Portal p, Direction wall, List<BlockPos> pool, int plain, int[] rejects) {
		int blocks = 0;
		for (BlockPos cell : wallCells(p, wall)) {
			BlockState state = known(player, cell);
			if (state == null || !state.getFluidState().isEmpty()) { rejects[6]++; return Double.MAX_VALUE; }
			if (state.isCollisionShapeFullBlock(level, cell)) continue;
			if (!state.isAir() && !state.canBeReplaced()) { rejects[6]++; return Double.MAX_VALUE; }
			blocks++;
		}
		// The mould's first row stands on the ground behind the frame; a step up and the dug bottom row even out. Where that
		// row is rock already (a carved site's wall) nothing is placed there, and the ground under it is buried and unseen.
		for (int i = 1; i <= 2; i++)
			if (!full(player, p.at(i, 1).relative(wall)) && !full(player, p.at(i, 0).relative(wall))) { rejects[6]++; return Double.MAX_VALUE; }
		Direction front = wall.getOpposite();
		// The cells just in front of the frame carry every pour's sight line to the mould: open, or mined first.
		double clearing = 0.0D;
		for (int i = 0; i <= 3; i++) for (int y = 1; y <= 4; y++) {
			BlockPos cell = p.at(i, y).relative(front);
			BlockState state = known(player, cell);
			if (state == null || !state.getFluidState().isEmpty()) { rejects[6]++; return Double.MAX_VALUE; }
			if (state.isAir()) continue;
			double ticks = clearTicks(player, level, cell, state);
			if (ticks > MAX_CLEAR_TICKS) { rejects[6]++; return Double.MAX_VALUE; }
			clearing += 0.5D + ticks / 20.0D;
		}
		boolean stand = false;
		for (int dy : new int[] { 0, 1, -1 }) for (int k : new int[] { 2, 3 }) for (int i = 0; i <= 3 && !stand; i++)
			if (standable(player, level, p.at(i, 1 + dy).relative(front, k))) stand = true;
		if (!stand) { rejects[3]++; return Double.MAX_VALUE; }
		Vec3 mid = Vec3.atCenterOf(p.at(1, 1));
		double near = Double.MAX_VALUE, rise = 0.0D;
		BlockPos nearest = null;
		for (BlockPos source : pool) {
			double d = Vec3.atCenterOf(source).distanceTo(mid);
			if (d < near) { near = d; rise = Math.abs(p.at(1, 1).getY() - 1 - source.getY()); nearest = source; }
		}
		// Ten trips there and back: a pool far below or above the frame's ground is a climb travel may not make each time.
		if (near > CAST_POOL_REACH || rise > CAST_RISE) { rejects[7]++; return Double.MAX_VALUE; }
		// The poured water must not run into the pool: lava it meets is cast where it lies, out of a bucket's use. Scooped
		// the tick after it lands, it stays in its cell.
		if (spillMeetsLava(cell -> known(player, cell), p, wall, QUICK_SPILL_CELLS)) { rejects[8]++; return Double.MAX_VALUE; }
		// Last, so a site refused here lacks only blocks.
		int need = castBlocks(blocks);
		if (need > plain) { rejects[9]++; rejects[10] = Math.min(rejects[10], need); return Double.MAX_VALUE; }
		// The pours are made from in front: with the mould between the frame and the pool, each of the ten trips goes round
		// the frame, and the frame's growing columns hide the way.
		double round = nearest != null && Vec3.atCenterOf(nearest).distanceTo(Vec3.atCenterOf(p.at(1, 1).relative(wall, 2)))
				< Vec3.atCenterOf(nearest).distanceTo(Vec3.atCenterOf(p.at(1, 1).relative(front, 2))) ? 3.0D : 0.0D;
		return 0.6D * blocks + 0.4D * near + 0.8D * rise + clearing + round;
	}

	/**
	 * Whether water poured for the cast could run into a lava source: from each pour's water cell it falls where nothing
	 * holds it up and spreads where something does (vanilla flow, 7 blocks on the flat and afresh below each drop), its
	 * whole course even though the source is scooped (see {@link #SPILL_CELLS}), through cells seen open; the frame, opening
	 * and the cells in front count as open (dug or cleared), the mould and the cells cast before as solid, unseen cells as rock.
	 */
	static boolean spillMeetsLava(java.util.function.Function<BlockPos, BlockState> world, Portal p, Direction wall) {
		return spillMeetsLava(world, p, wall, SPILL_CELLS);
	}

	/** {@link #spillMeetsLava(java.util.function.Function, Portal, Direction)} with the water's run cut at {@code cells}. */
	static boolean spillMeetsLava(java.util.function.Function<BlockPos, BlockState> world, Portal p, Direction wall, int cells) {
		// Every pour's run reads the same cells: read each once.
		java.util.Map<BlockPos, java.util.Optional<BlockState>> read = new java.util.HashMap<>();
		java.util.function.Function<BlockPos, BlockState> known = cell -> read.computeIfAbsent(cell, at -> java.util.Optional.ofNullable(world.apply(at))).orElse(null);
		Set<BlockPos> mould = new HashSet<>(wallCells(p, wall)), cleared = new HashSet<>(p.frame());
		// Everything in the frame's plane above the ground corners is dug or cleared, and the cells in front of it.
		for (int i = 0; i <= 3; i++) for (int y = 1; y <= 4; y++) { cleared.add(p.at(i, y)); cleared.add(p.at(i, y).relative(wall.getOpposite())); }
		Predicate<BlockPos> open = cell -> {
			if (mould.contains(cell)) return false;
			if (cleared.contains(cell)) return true;
			BlockState state = known.apply(cell);
			return state != null && (state.getFluidState().isEmpty() ? state.isAir() || state.canBeReplaced() : state.getFluidState().getType().isSame(Fluids.WATER));
		};
		Set<BlockPos> cast = new HashSet<>();
		for (BlockPos[] pair : castPairs(p)) {
			Predicate<BlockPos> flows = cell -> !cell.equals(pair[0]) && !cast.contains(cell) && open.test(cell);
			// cell -> {strength, cells run}; breadth first, so each cell is reached by its shortest run.
			java.util.Map<BlockPos, int[]> reach = new java.util.HashMap<>();
			java.util.ArrayDeque<BlockPos> queue = new java.util.ArrayDeque<>(List.of(pair[1]));
			reach.put(pair[1], new int[] { 8, 0 });
			while (!queue.isEmpty()) {
				BlockPos at = queue.poll();
				int[] here = reach.get(at);
				for (Direction side : Direction.values()) if (!at.relative(side).equals(pair[0]) && lavaSource(known.apply(at.relative(side)))) return true;
				if (here[1] >= cells) continue;
				if (flows.test(at.below())) { if (reach.putIfAbsent(at.below(), new int[] { 8, here[1] + 1 }) == null) queue.add(at.below()); continue; }
				if (here[0] <= 1) continue;
				for (Direction side : Direction.Plane.HORIZONTAL) {
					BlockPos cell = at.relative(side);
					if (flows.test(cell) && reach.putIfAbsent(cell, new int[] { here[0] - 1, here[1] + 1 }) == null) queue.add(cell);
				}
			}
			cast.add(pair[0]);
		}
		return false;
	}

	/** Plugs a carve may place before it gives the fluid up as more than a few openings and steps back from it. */
	static final int MAX_PLUGS = 8;

	private List<BlockPos> inlets(ServerPlayer player) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		List<BlockPos> out = new ArrayList<>();
		Set<BlockPos> sourced = new HashSet<>();
		for (BlockPos cell : carveOpened) {
			if (full(player, cell)) continue;
			for (Direction side : Direction.values()) {
				BlockPos beside = cell.relative(side);
				// The world read only skips the sight ray where no fluid is; what counts is what the eye sees.
				if (carveOpened.contains(beside) || player.level().getFluidState(beside).isEmpty() || !seen.seesNow(beside.getX(), beside.getY(), beside.getZ())) continue;
				BlockState state = seen.known(beside.getX(), beside.getY(), beside.getZ());
				if (state == null || state.getFluidState().isEmpty()) continue;
				if (metFluid.size() < 4096) metFluid.put(beside.immutable(), state);
				if (!out.contains(cell)) out.add(cell);
				if (state.getFluidState().isSource()) sourced.add(cell);
			}
		}
		out.sort(Comparator.comparing(cell -> !sourced.contains(cell)));
		return out;
	}

	/** Water or lava against the carve's openings: plug them (phase PLUG), then give the site up; null when there is none. */
	private TickResult plugInlets(ServerPlayer player, String why) {
		List<BlockPos> found = inlets(player);
		if (found.isEmpty()) return null;
		BlockPos cell = found.get(0);
		BlockPos fluid = null;
		for (Direction side : Direction.values()) if (metFluid.containsKey(cell.relative(side)) && !carveOpened.contains(cell.relative(side))) { fluid = cell.relative(side); break; }
		BlockState state = fluid == null ? null : metFluid.get(fluid);
		plugWhy = (state != null && TravelBuilder.lava(state) ? "lava" : "water") + " met through the rock at " + (fluid == null ? "?" : xyz(fluid))
				+ " beside the dug cell " + xyz(cell) + " (" + why + ")";
		plugs.clear();
		plugs.addAll(found);
		cellTicks = 0;
		releaseInput();
		phase = Phase.PLUG;
		return running();
	}

	/**
	 * Fills each opening a fluid met through the rock can pour in by with a carried block, as the dig plugs a cell it
	 * opened beside lava, then gives the carved site up. With no block, no face in reach, or the body in the opening, it
	 * steps back from the opening and hands back.
	 */
	private TickResult plugTick(ServerPlayer player, long now) {
		if (stepBackWhy != null) return fail(player, "BUILD_BLOCKED", stepBackWhy);
		while (!plugs.isEmpty() && full(player, plugs.get(0))) { plugs.remove(0); cellTicks = 0; }
		if (plugs.isEmpty()) {
			// Fluid shown only once the first plugs went in (the eye on another face) is plugged too.
			List<BlockPos> more = inlets(player);
			if (!more.isEmpty() && plugged < MAX_PLUGS) { plugs.addAll(more); return running(); }
			if (!more.isEmpty()) return stepBack(player, now, more.get(0), MAX_PLUGS + " plugs placed and more openings show fluid");
			String why = plugWhy + "; plugged " + plugged + " opened cell" + (plugged == 1 ? "" : "s");
			carveNote = (carveNote == null ? "" : carveNote + "; ") + why;
			if (rejectedSites.size() < 3) return chooseAgain(player, now, why);
			return fail(player, "BUILD_BLOCKED", why);
		}
		BlockPos cell = plugs.get(0);
		if (plugged >= MAX_PLUGS) return stepBack(player, now, cell, MAX_PLUGS + " plugs placed and more openings show fluid");
		String item = spareItem(player);
		if (item == null) return stepBack(player, now, cell, "no plain block carried to plug it");
		if (player.getBoundingBox().intersects(new AABB(cell))) return stepBack(player, now, cell, "the body stands in the opening");
		Vec3 aim = null;
		try { aim = environment.aim(player, cell, Direction.UP, item); }
		catch (AgentDomainException blocked) { refusal = blocked.code() + ": " + blocked.getMessage(); }
		if (aim == null) return stepBack(player, now, cell, "no face in reach to place against" + (refusal == null ? "" : ": " + refusal));
		if (++cellTicks > CELL_TICKS) return stepBack(player, now, cell, "the plug did not go in" + (refusal == null ? "" : ": " + refusal));
		if (!turn(player, aim, false)) return running();
		String why = place(player, cell, item);
		if (why == null) { plugged++; placed++; plugs.remove(0); cellTicks = 0; pause = 2; }
		else refusal = why;
		return running();
	}

	/** An opening the body cannot plug: walk to a seen spot 4 blocks or more from it, then hand back (plugTick). */
	private TickResult stepBack(ServerPlayer player, long now, BlockPos opening, String why) {
		stepBackWhy = plugWhy + "; could not plug " + xyz(opening) + " (" + why + ")";
		Vec3 at = Vec3.atCenterOf(opening);
		BlockPos spot = standFor(player, eye -> eye.distanceTo(at) >= 4.0D);
		if (spot == null) return fail(player, "BUILD_BLOCKED", stepBackWhy + "; no seen spot 4 blocks from it to step back to");
		stepBackWhy += "; stepped back to " + xyz(spot);
		return walkTo(player, spot, now);
	}

	/** Whether lava a carve met behind the rock lies within the pool margin of {@code mid}: the pool goes on there. */
	private boolean nearMetLava(Vec3 mid) {
		for (var met : metFluid.entrySet())
			if (TravelBuilder.lava(met.getValue()) && Vec3.atCenterOf(met.getKey()).distanceTo(mid) < CARVE_POOL_MARGIN) return true;
		return false;
	}

	/** A cast site whose clearing was refused before anything was built: forget it and choose again from what was seen. */
	private TickResult chooseAgain(ServerPlayer player, long now, String why) {
		rejectedSites.add(portal.origin().immutable());
		rejectNote = "gave up the " + (carving ? "carved " : "") + "site at " + xyz(portal.origin()) + " (" + why + ")";
		carving = false;
		portal = null;
		clears.clear();
		mould.clear();
		order = null;
		castOrder.clear();
		releaseInput();
		// A walk to level ground (relocate) runs over the next ticks through the survey phase, never the clearing one.
		phase = Phase.SURVEY;
		return chooseSite(player, now);
	}

	/**
	 * The cells a carved cast site digs out, in digging order: the row in front of the frame, then the frame's plane, each
	 * 4 wide and rows 1-4 above the ground row, bottom row first. Each cell is open to the one dug before it, so the eye
	 * sees it when its turn comes. The ground row, the mould cells behind and the rock round it stay.
	 */
	static List<BlockPos> carveCells(Portal p, Direction wall) {
		Direction front = wall.getOpposite();
		List<BlockPos> cells = new ArrayList<>();
		for (int k = 1; k >= 0; k--) for (int y = 1; y <= 4; y++) for (int i = 0; i <= 3; i++) cells.add(p.at(i, y).relative(front, k));
		return cells;
	}

	/**
	 * Cells to dig for a cast site carved at {@code p} with its mould on side {@code wall}, judged from what is seen with
	 * every unseen cell taken as rock; -1 when the seen terrain rules it out: a seen ground row or mould floor cell that is
	 * not rock ({@code rock}), a fluid in the dig, the mould or against any of them, a block too slow to clear
	 * ({@code clearable}), lava within two blocks of the footprint or water against it (the rule an open site has), or
	 * poured water able to run into lava. After the dig the site is chosen again by the ordinary rules from what is seen.
	 */
	static int carveDig(java.util.function.Function<BlockPos, BlockState> known, java.util.function.BiPredicate<BlockPos, BlockState> rock,
			java.util.function.BiPredicate<BlockPos, BlockState> clearable, Portal p, Direction wall) {
		Set<BlockPos> dig = new HashSet<>(carveCells(p, wall));
		List<BlockPos> ground = List.of(p.at(0, 0), p.at(1, 0), p.at(2, 0), p.at(3, 0), p.at(1, 0).relative(wall), p.at(2, 0).relative(wall));
		for (BlockPos cell : ground) {
			BlockState state = known.apply(cell);
			if (state != null && !rock.test(cell, state)) return -1;
		}
		List<BlockPos> kept = new ArrayList<>(ground);
		for (BlockPos cell : wallCells(p, wall)) {
			BlockState state = known.apply(cell);
			if (state != null && !state.getFluidState().isEmpty()) return -1;
			kept.add(cell);
		}
		int cells = 0;
		for (BlockPos cell : dig) {
			BlockState state = known.apply(cell);
			if (state == null) { cells++; continue; }
			if (!state.getFluidState().isEmpty()) return -1;
			if (state.isAir()) continue;
			if (!clearable.test(cell, state)) return -1;
			cells++;
		}
		// Opening the rock lets in any fluid against the dig, and the ground row and mould must hold the cast's water.
		kept.addAll(dig);
		for (BlockPos cell : kept) for (Direction side : Direction.values()) {
			BlockState state = known.apply(cell.relative(side));
			if (state != null && !state.getFluidState().isEmpty()) return -1;
		}
		Direction n = p.normal();
		for (int i = -2; i <= 5; i++) for (int y = -1; y <= 5; y++) for (int k = -2; k <= 2; k++) {
			BlockState state = known.apply(p.at(i, y).relative(n, k));
			if (state == null || state.getFluidState().isEmpty()) continue;
			if (TravelBuilder.lava(state) || (i >= -1 && i <= 4 && k >= -1 && k <= 1)) return -1;
		}
		if (spillMeetsLava(known, p, wall, QUICK_SPILL_CELLS)) return -1;
		return cells;
	}

	/**
	 * No open site by the lava: choose one to carve beside a seen standing spot within {@link #CARVE_RADIUS} of the cast
	 * center, the frame two cells from the spot (the row between dug too), within reach of the pool, fewest cells to dig
	 * and nearest first. True when the dig starts; false (with the reasons added to the site rejects) when none fits.
	 */
	private boolean carve(ServerPlayer player, List<BlockPos> pool, int plain) {
		ServerLevel level = (ServerLevel) player.level();
		java.util.function.BiPredicate<BlockPos, BlockState> rock = (cell, state) -> state.isCollisionShapeFullBlock(level, cell)
				&& state.getFluidState().isEmpty() && !(state.getBlock() instanceof EntityBlock);
		java.util.function.BiPredicate<BlockPos, BlockState> clearable = (cell, state) -> clearTicks(player, level, cell, state) <= MAX_CLEAR_TICKS;
		BlockPos from = player.blockPosition();
		Portal best = null;
		Direction bestWall = null;
		BlockPos bestStand = null;
		double bestCost = Double.MAX_VALUE;
		int stands = 0, far = 0, ruled = 0, blocks = 0, bestDig = 0;
		for (BlockPos at : BlockPos.betweenClosed(center.offset(-CARVE_RADIUS, -3, -CARVE_RADIUS), center.offset(CARVE_RADIUS, 3, CARVE_RADIUS))) {
			if (!standable(player, level, at)) continue;
			BlockPos stand = at.immutable();
			stands++;
			for (Direction wall : Direction.Plane.HORIZONTAL) {
				Direction.Axis axis = wall.getAxis() == Direction.Axis.X ? Direction.Axis.Z : Direction.Axis.X;
				BlockPos frameGround = stand.relative(wall, 2).below();
				for (int i = 1; i <= 2; i++) {
					Portal p = new Portal(axis == Direction.Axis.Z ? frameGround.offset(0, 0, -i) : frameGround.offset(-i, 0, 0), axis);
					if (rejectedSites.contains(p.origin())) continue;
					Vec3 mid = Vec3.atCenterOf(p.at(1, 1));
					double near = Double.MAX_VALUE, rise = 0.0D;
					for (BlockPos source : pool) {
						double d = Vec3.atCenterOf(source).distanceTo(mid);
						if (d < near) { near = d; rise = Math.abs(p.at(1, 1).getY() - 1 - source.getY()); }
					}
					if (near > CAST_POOL_REACH || rise > CAST_RISE || near < CARVE_POOL_MARGIN || nearMetLava(mid)) { far++; continue; }
					int dig = carveDig(cell -> known(player, cell), rock, clearable, p, wall);
					if (dig < 0) { ruled++; continue; }
					int open = 0;
					for (BlockPos cell : wallCells(p, wall)) { BlockState state = known(player, cell); if (state != null && !rock.test(cell, state)) open++; }
					if (castBlocks(open) > plain) { blocks++; continue; }
					double cost = 0.5D * dig + 0.6D * open + 0.4D * near + 0.8D * rise + 0.3D * Math.sqrt(stand.distSqr(from));
					if (spillMeetsLava(cell -> known(player, cell), p, wall, SURE_SPILL_CELLS)) cost += LOOSE_SITE_COST;
					if (cost < bestCost) { bestCost = cost; best = p; bestWall = wall; bestStand = stand; bestDig = dig; }
				}
			}
		}
		if (best == null) {
			siteRejects += String.format(Locale.ROOT, "; no site to carve either (%d seen standing spots within %d blocks: %d sites over %.0f blocks from, "
					+ "or %.0f above or below, or within %.0f of, the lava, %d with water or lava seen in or beside the dig or the ground not rock, %d short of plain blocks for the mould)",
					stands, CARVE_RADIUS, far, CAST_POOL_REACH, CAST_RISE, CARVE_POOL_MARGIN, ruled, blocks);
			return false;
		}
		carves++;
		carving = true;
		portal = best;
		back = bestWall;
		carved = best;
		carvedBack = bestWall;
		carveStand = bestStand;
		clears.clear();
		carveOpened.clear();
		for (BlockPos cell : carveCells(best, bestWall)) { BlockState state = known(player, cell); if (state == null || !state.isAir()) clears.add(cell); else carveOpened.add(cell); }
		carveNote = (carveNote == null ? "" : carveNote + "; then ") + String.format(Locale.ROOT, "%s a cast site at %s axis %s from the spot %s (%d cells dug)",
				carves == 1 ? "no open floor by the lava, so carved" : "carved", xyz(best.origin()), axisName(), xyz(bestStand), bestDig);
		releaseInput();
		phase = Phase.CLEAR;
		return true;
	}

	private TickResult planCast(ServerPlayer player) {
		Direction front = back.getOpposite();
		for (int y = 4; y >= 1; y--) for (int i = 0; i <= 3; i++) {
			BlockPos cell = portal.at(i, y).relative(front);
			BlockState state = known(player, cell);
			if (state != null && !state.isAir() && state.getFluidState().isEmpty()) clears.add(cell);
		}
		mould.clear();
		List<BlockPos> todo = new ArrayList<>();
		for (BlockPos cell : wallCells(portal, back)) { mould.add(cell); if (!full(player, cell)) todo.add(cell); }
		Set<BlockPos> clearing = new HashSet<>(clears);
		order = order(todo, List.of(), cell -> !clearing.contains(cell) && full(player, cell));
		if (order == null) return fail(player, "BUILD_NO_SITE", "No placement order reaches every mould cell behind the frame at " + xyz(portal.origin()));
		mouldBlocks = todo.size();
		castOrder.clear();
		castOrder.addAll(castPairs(portal));
		spares = mouldBlocks + 1;
		runOffMeetsLava = spillMeetsLava(cell -> known(player, cell), portal, back, SPILL_CELLS);
		sureRunOffMeetsLava = spillMeetsLava(cell -> known(player, cell), portal, back, SURE_SPILL_CELLS);
		pouredLava = null;
		quickScoop = waterFirst = crossAllowed = false;
		BlockPos source = lavaSources(player, portal.at(1, 1), (int) CAST_POOL_REACH + 4).stream().findFirst().orElse(poolAt);
		siteNote = (relocations > 0 ? "walked to level ground; " : "") + (uncoverNote == null ? "" : uncoverNote + "; ") + (carveNote == null ? "" : carveNote + "; ") + (rejectNote == null ? "" : rejectNote + "; ") + "cast site " + xyz(portal.origin()) + " axis " + axisName() + ", mould " + mouldBlocks
				+ " blocks on its " + back.getSerializedName() + " side, " + clears.size() + " cells to clear, lava source " + xyz(source)
				+ String.format(Locale.ROOT, " %.0f blocks away", Math.sqrt(source.distSqr(portal.at(1, 1))));
		phase = Phase.CLEAR;
		return running();
	}

	private TickResult castTick(ServerPlayer player, long now) {
		if (castIndex >= castOrder.size()) {
			if (pouredWater != null) return pour(player, now, Pour.SCOOP, pouredWater, null);
			releaseInput();
			phase = Phase.LIGHT;
			return running();
		}
		BlockPos cell = castOrder.get(castIndex)[0], water = castOrder.get(castIndex)[1];
		// The water poured against the lava cast it as it landed: take it up before its first spread, whatever the eye
		// has caught up with.
		if (castStep(quickScoop && pouredWater != null, false, false, 0, false) == CastStep.SCOOP) return pour(player, now, Pour.SCOOP, pouredWater, null);
		BlockState state = known(player, cell);
		// Water standing while the lava does not follow (the body gone to look or walk) runs out over the cave and into
		// the pool: take it back before anything else.
		if (pouredWater != null && player.level().getGameTime() - waterTick > WATER_STAND_TICKS && (known(player, pouredWater) == null || waterSource(player, pouredWater)) && (state == null || !state.is(Blocks.OBSIDIAN) && !TravelBuilder.lava(state))) {
			// A spot counts once its stale water is taken back, not on each tick of the turn and clicks that scoop it.
			if (!staleWater && staleScoops >= 4) return fail(player, "BUILD_BLOCKED", "Lava would not follow the water into frame cell " + xyz(cell) + " from " + (staleScoops + 1) + " spots" + (refusal == null ? "" : ": " + refusal));
			staleWater = true;
			return pour(player, now, Pour.SCOOP, pouredWater, null);
		}
		if (state == null) return observe(player, cell, now);
		if (state.is(Blocks.OBSIDIAN)) {
			madeSolid.add(cell);
			cellPours = 0;
			if (pouredWater != null) return pour(player, now, Pour.SCOOP, pouredWater, null);
			castIndex++;
			pouredLava = null;
			lavaWatered = waterFirst = crossAllowed = false;
			castWait = 0;
			clickTicks = 0;
			staleScoops = 0;
			return running();
		}
		boolean lava = TravelBuilder.lava(state);
		if (!state.isAir() && state.getFluidState().isEmpty() && !state.canBeReplaced()) {
			clears.add(0, cell);
			clearThenCast = true;
			phase = Phase.CLEAR;
			return running();
		}
		if (pouredWater == null) {
			if (!lava && carried(player, "minecraft:obsidian") > 0) return placeObsidian(player, cell, now);
			if (!lava && carried(player, "minecraft:lava_bucket") == 0) return fetchLava(player, now);
			if (carried(player, "minecraft:water_bucket") == 0) {
				if (waterSource(player, water)) { pouredWater = water; return running(); }
				BlockPos stray = null;
				for (BlockPos at : BlockPos.betweenClosed(portal.at(1, 1).offset(-5, -3, -5), portal.at(1, 1).offset(5, 5, 5)))
					if (waterSource(player, at) && (stray == null || at.distSqr(water) < stray.distSqr(water))) stray = at.immutable();
				if (stray != null && carried(player, "minecraft:bucket") > 0) { pouredWater = stray; return pour(player, now, Pour.SCOOP, stray, null); }
				return short_(player, "casting needs a water bucket and none is carried (" + castIndex + " of 10 cells done)");
			}
			// No spot reaches both cells and the water's whole run meets no lava: water first, the lava poured beside it after.
			if (waterFirst && !lava) return pour(player, now, Pour.WATER, water, cell);
			// Lava first, then water against it from the same spot, which casts it as it lands, then the water scooped the
			// next tick, before it spreads: the cast's water never runs out over the cave into the pool.
			boolean ours = cell.equals(pouredLava);
			long age = ours ? player.level().getGameTime() - lavaTick : 0L;
			if (ours && lavaWatered && player.level().getGameTime() - waterTick <= 20) {
				// Water landed beside it, which vanilla casts at once; the eye has not caught up yet: wait to see the obsidian.
				releaseInput();
				ServerLookController.turnToward(player, Vec3.atCenterOf(cell));
				return running();
			}
			lavaWatered = false;
			boolean lands = ours && !moveForClick && pourClick(player, player.getEyePosition(), water, true, crossAllowed ? null : cell) != null;
			return switch (castStep(false, lava, ours, age, lands)) {
				case LAVA -> pour(player, now, Pour.LAVA, cell, water);
				case TAKE_BACK -> pour(player, now, Pour.TAKE, cell, null);
				default -> pour(player, now, Pour.WATER, water, null);
			};
		}
		if (!waterSource(player, pouredWater)) {
			if (castWait++ < 20) { releaseInput(); ServerLookController.turnToward(player, Vec3.atCenterOf(pouredWater)); return running(); }
			castWait = 0;
			// The body remembers its own pour until it sees otherwise: out of sight (the flow pushed it), go back and take
			// it up again, then cast the cell afresh.
			if (!SeenTerrain.of(player).seesNow(pouredWater.getX(), pouredWater.getY(), pouredWater.getZ())) return pour(player, now, Pour.SCOOP, pouredWater, null);
			pouredWater = null;
			return running();
		}
		castWait = 0;
		if (lava) {
			// Lava beside the water casts at vanilla's next neighbour update: wait to see it.
			if (clickTicks++ < 40) return running();
			return fail(player, "BUILD_BLOCKED", "Lava in frame cell " + xyz(cell) + " did not cast beside the water at " + xyz(pouredWater));
		}
		if (carried(player, "minecraft:lava_bucket") == 0) return pour(player, now, Pour.SCOOP, pouredWater, null);
		return pour(player, now, Pour.LAVA, cell, pouredWater);
	}

	private boolean waterSource(ServerPlayer player, BlockPos at) {
		BlockState state = known(player, at);
		return state != null && state.getFluidState().isSource() && state.getFluidState().getType().isSame(Fluids.WATER);
	}

	/**
	 * One bucket click: water or lava poured into {@code target} against a seen face beside it, or a source scooped. From a
	 * spot that cannot reach it the body walks to one that reaches it (and {@code partner}, the other cell of the cast).
	 */
	private TickResult pour(ServerPlayer player, long now, Pour kind, BlockPos target, BlockPos partner) {
		String item = switch (kind) { case WATER -> "minecraft:water_bucket"; case LAVA -> "minecraft:lava_bucket"; default -> "minecraft:bucket"; };
		boolean scoop = kind == Pour.SCOOP || kind == Pour.FILL || kind == Pour.TAKE;
		// Water against lava poured first comes in by a line clear of the lava's cell (see crosses).
		BlockPos avoid = kind == Pour.WATER && partner == null && pouredLava != null && !waterFirst && !crossAllowed ? pouredLava : null;
		BlockHitResult click = moveForClick ? null : scoop ? scoopClick(player, target) : pourClick(player, player.getEyePosition(), target, true, avoid);
		// The water just poured against the lava is in the look's own line (it came in through the face it was poured
		// against): scoop it along that look, with no turn, before its first spread.
		BlockHitResult onLook = kind == Pour.SCOOP && quickScoop ? lookScoop(player, target) : null;
		if (onLook != null) click = onLook;
		// Water goes in only where the lava can follow from the same spot at once, and lava only where the water can.
		if (click != null && kind == Pour.WATER && partner != null && !waterAlone && pourClick(player, player.getEyePosition(), partner, false) == null) click = null;
		// Lava poured first (no water standing yet) never stands without the water following: a lava-only spot is no spot for it.
		boolean paired = kind == Pour.LAVA && partner != null && pouredWater == null && !waterFirst;
		if (click != null && paired && pourClick(player, player.getEyePosition(), partner, false, crossAllowed ? null : target) == null) click = null;
		if (click == null) {
			if (kind == Pour.FILL) { triedSources.add(target); return running(); }
			releaseInput();
			if (stepAt != null && player.blockPosition().equals(stepAt) && player.onGround()) {
				stepAt = null;
				moveForClick = false;
				if (spareItem(player) == null) return short_(player, "reaching " + xyz(target) + " needs 1 plain block to step up on, none left");
				steps++;
				startY = player.blockPosition().getY();
				pillarGoal = startY + 1;
				pillarReturn = Phase.CAST;
				moveStage = 0;
				phase = Phase.PILLAR;
				return running();
			}
			Predicate<Vec3> reaches = kind == Pour.SCOOP || kind == Pour.TAKE ? eye -> scoopReaches(player, eye, target) : eye -> pourClick(player, eye, target, false, avoid) != null;
			BlockPos partnerAvoid = paired && !crossAllowed ? target : null;
			BlockPos spot = partner == null ? null : standFor(player, eye -> reaches.test(eye) && pourClick(player, eye, partner, false, partnerAvoid) != null);
			// Water poured across the lava's cell stands behind the obsidian it casts, out of the scoop's reach until the body
			// walks round (one stood 211 ticks): only where its 8-cell run meets no lava, so it cannot crust the pool.
			if (spot == null && paired && !crossAllowed && !sureRunOffMeetsLava && standFor(player, eye -> pourClick(player, eye, target, false) != null && pourClick(player, eye, partner, false) != null) != null) {
				// No spot's water line misses the lava's cell (a frame's top cell under a low roof, cast-obi-1: 9 of 10 runs
				// pillared into the rock over the head): pour this cell from a spot whose line crosses it, as main did.
				crossAllowed = true;
				return running();
			}
			if (spot == null && kind == Pour.WATER) waterAlone = true;
			if (spot == null && paired && !runOffMeetsLava) {
				// No spot pours both: the old order, water first, whose standing water runs its whole course and meets no lava here.
				waterFirst = true;
				return running();
			}
			if (spot == null && !paired) spot = standFor(player, reaches);
			if (spot == null && steps < 3) {
				// From the ground no eye sees a face for it: a spot whose eye, one block up, does.
				BlockPos raised = standFor(player, eye -> reaches.test(eye.add(0.0D, 1.0D, 0.0D))
						&& (partner == null || pourClick(player, eye.add(0.0D, 1.0D, 0.0D), partner, false, partnerAvoid) != null));
				if (raised == null && !paired) raised = standFor(player, eye -> reaches.test(eye.add(0.0D, 1.0D, 0.0D)));
				if (raised != null) {
					BlockState head = known(player, raised.above(2));
					if (head != null && head.getCollisionShape(player.level(), raised.above(2)).isEmpty() && head.getFluidState().isEmpty()) {
						stepAt = raised;
						if (raised.equals(player.blockPosition())) return running();
						return walkTo(player, raised, now);
					}
				}
			}
			if (spot == null && standRetries < 4) {
				// Back from the pool by another way: walk to the ground in front of the frame and plan the spot from there.
				standRetries++;
				triedSpots.clear();
				BlockPos before = nearestStand(player, portal.at(1, 1).relative(back.getOpposite(), 2).below(), 4);
				if (before != null && before.distSqr(player.blockPosition()) > 2) return walkTo(player, before, now);
				return running();
			}
			if (spot == null) {
				int supports = 0;
				for (Direction side : Direction.values()) if (full(player, target.relative(side)) || madeSolid.contains(target.relative(side))) supports++;
				// Nothing known to pour against from here (the frame out of sight since the pool): go and look at it first.
				if (supports == 0 && standRetries++ < 6) return observe(player, target, now);
				return fail(player, "NO_STAND_SPOT", "No seen spot reaches " + (scoop ? "the water source at " : "a face to pour " + kind.name().toLowerCase(Locale.ROOT) + " into ")
						+ xyz(target) + " (" + supports + " solid sides known, " + steps + " steps up)" + lastWalk());
			}
			return walkTo(player, spot, now);
		}
		// The held bucket first: the water bucket just poured is the empty one that scoops it back.
		int slot = carriedHere(player, item) ? player.getInventory().getSelectedSlot() : slot(player, item);
		if (slot < 0) return short_(player, "the cast needs a " + item.substring(10) + " and none is carried");
		if (slot >= 9) {
			releaseInput();
			var swap = dev.agaminggod.mineagen.server.runtime.AdvancedInteractionService.swapIntoHotbar(player, slot, player.getInventory().getSelectedSlot());
			if (swap != null) return fail(player, swap.reasonCode(), swap.message());
			pause = 1;
			return running();
		}
		if (player.getInventory().getSelectedSlot() != slot) { player.getInventory().setSelectedSlot(slot); pause = 1; return running(); }
		if (onLook == null && !turn(player, click.getLocation(), false)) return clickStall(player, now);
		// The limit is checked before the click: a fourth pour checked after it would leave its lava standing uncooled in the frame.
		if (kind == Pour.LAVA && cellPours >= 3)
			return fail(player, "BUILD_BLOCKED", "Lava poured into frame cell " + xyz(target) + " " + cellPours + " times without casting it" + (refusal == null ? "" : "; " + refusal));
		int held = carried(player, item);
		// Lava poured first stands uncooled for the few ticks until the water lands beside it, or is taken back: refused
		// only where its flow would meet the body before its first flow tick.
		String why = paired
				? environment.useBucket(player, click.getBlockPos(), click.getDirection(), Fluids.LAVA.getTickDelay(player.level()) / 20.0D)
				: environment.useBucket(player, click.getBlockPos(), click.getDirection());
		// A click counts only when the bucket changed (filled or emptied); one that reports success and leaves it as it
		// was is a refused click, never a pour (gate-5: 3508 "pours" in 9 minutes cast nothing).
		if (why == null && carried(player, item) == held) {
			// A block that answers the click itself (redstone ore lights up) takes it before the bucket: pour against another face.
			why = "the click on " + describe(known(player, click.getBlockPos())) + " at " + xyz(click.getBlockPos()) + " left the " + item.substring(10) + " as it was";
			if (!scoop) deadSupports.add(click.getBlockPos().immutable());
		}
		if (why != null) { refusal = why; return clickStall(player, now); }
		if (kind == Pour.LAVA) cellPours++;
		clickTicks = 0;
		clickStalls = 0;
		waterAlone = false;
		pause = 2;
		long tick = player.level().getGameTime();
		standRetries = 0;
		LOGGER.info("[build] {} {} at {} from {} (cell {} of 10)", player.getGameProfile().name(), kind, xyz(target), xyz(player.blockPosition()), castIndex + 1);
		walks = 0;
		triedSpots.clear();
		switch (kind) {
			case WATER -> {
				pouredWater = target.immutable();
				waterTick = tick;
				waterPours++;
				// Against lava poured first: the lava cast as the water landed; scoop the water the very next tick.
				if (pouredLava != null && !waterFirst) { quickScoop = true; lavaWatered = true; pause = 0; }
			}
			case LAVA -> {
				lavaPours++;
				if (paired) { pouredLava = target.immutable(); lavaTick = tick; lavaWatered = false; }
			}
			case TAKE -> {
				// Taken back before it flowed: pour the pair again from a spot whose water click lands.
				LOGGER.info("[build] {} took the lava back from {} after {} ticks", player.getGameProfile().name(), xyz(target), tick - lavaTick);
				pouredLava = null;
				lavaTakes++;
				moveForClick = true;
				triedSpots.add(player.blockPosition().immutable());
			}
			case SCOOP -> {
				if (quickScoop) LOGGER.info("[build] {} water at {} stood {} ticks", player.getGameProfile().name(), xyz(target), tick - waterTick);
				quickScoop = false;
				pouredWater = null;
				scoops++;
				// Taken back because the lava did not follow from here: pour the pair from another spot.
				if (staleWater) { staleWater = false; staleScoops++; moveForClick = true; triedSpots.add(player.blockPosition().immutable()); }
			}
			case FILL -> { scoopSpots.remove(player.blockPosition()); scoopSpots.add(player.blockPosition().immutable()); fills++; triedSources.clear(); lastFill = target.immutable(); poolMemory.remove(lastFill); seekWalks = 0; }
		}
		return running();
	}

	private TickResult clickStall(ServerPlayer player, long now) {
		if (++clickTicks <= CAST_CLICK_TICKS) return running();
		clickTicks = 0;
		// From here the click does not land (the lava pour guard, a face the ray misses): pour from another spot.
		moveForClick = true;
		triedSpots.add(player.blockPosition().immutable());
		if (++clickStalls > 4) return fail(player, "BUILD_BLOCKED", "A bucket click would not land after 4 spots" + (refusal == null ? "" : ": " + refusal));
		return running();
	}

	/** Whether an empty bucket aimed from {@code eye} meets the fluid source at {@code source} within reach (vanilla's SOURCE_ONLY line). */
	private boolean scoopReaches(ServerPlayer player, Vec3 eye, BlockPos source) {
		double reach = player.blockInteractionRange() - 0.2D;
		Vec3 center = Vec3.atCenterOf(source);
		if (center.distanceTo(eye) > reach + 0.9D) return false;
		List<Vec3> aims = new ArrayList<>(List.of(center));
		for (Direction face : Direction.values()) {
			Vec3 point = center.add(face.getStepX() * 0.45D, face.getStepY() * 0.3D, face.getStepZ() * 0.45D);
			if (point.subtract(center).dot(eye.subtract(center)) > 0.0D) aims.add(point);
		}
		for (Vec3 aim : aims) {
			Vec3 end = eye.add(aim.subtract(eye).normalize().scale(reach));
			BlockHitResult hit = player.level().clip(new net.minecraft.world.level.ClipContext(eye, end, net.minecraft.world.level.ClipContext.Block.OUTLINE,
					net.minecraft.world.level.ClipContext.Fluid.SOURCE_ONLY, CollisionContext.of(player)));
			if (hit.getType() == net.minecraft.world.phys.HitResult.Type.BLOCK && hit.getBlockPos().equals(source)) return true;
		}
		return false;
	}

	/** Ticks past {@link #LAVA_HOLD_TICKS} a cell's standing lava may hold off a stop while its take-back walks into reach. */
	static final int LAVA_FINISH_TICKS = 40;

	/**
	 * A cast cell half done: lava this cast poured first, not yet cooled by the water or taken back and still there, or
	 * the water poured against it not yet scooped back (stood, it runs out over the cave into the pool).
	 */
	private boolean lavaStanding(ServerPlayer player) {
		if (!casting || phase != Phase.CAST) return false;
		long time = player.level().getGameTime();
		if (quickScoop && pouredWater != null) return time - waterTick <= LAVA_FINISH_TICKS;
		if (pouredLava == null || lavaWatered) return false;
		if (time - lavaTick > LAVA_HOLD_TICKS + LAVA_FINISH_TICKS) return false;
		return TravelBuilder.lava(known(player, pouredLava));
	}

	/** The empty bucket's own ray along the current look, when it meets the water source at {@code source}; else null. */
	private BlockHitResult lookScoop(ServerPlayer player, BlockPos source) {
		Vec3 eye = player.getEyePosition();
		BlockHitResult hit = environment.bucketRay(player, eye.add(player.getLookAngle().scale(player.blockInteractionRange())), true);
		if (hit == null || hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(source)) return null;
		return new BlockHitResult(hit.getLocation(), hit.getDirection(), source.immutable(), false);
	}

	private static boolean carriedHere(ServerPlayer player, String itemId) {
		Item item = BuiltInRegistries.ITEM.getValue(net.minecraft.resources.Identifier.parse(itemId));
		return item != Items.AIR && player.getMainHandItem().is(item);
	}

	private BlockHitResult scoopClick(ServerPlayer player, BlockPos source) {
		Vec3 aim = environment.scoopAim(player, source);
		if (aim == null) return null;
		BlockHitResult hit = environment.bucketRay(player, aim, true);
		return new BlockHitResult(aim, hit.getDirection(), source.immutable(), false);
	}

	/**
	 * A filled bucket's click that empties into {@code target}: a seen full block beside it whose face toward it the eye
	 * sees within reach. {@code verify} checks it with the bucket's own ray from the body's eye now.
	 */
	private BlockHitResult pourClick(ServerPlayer player, Vec3 eye, BlockPos target, boolean verify) {
		return pourClick(player, eye, target, verify, null);
	}

	/**
	 * Whether the line from {@code eye} to {@code point} passes through {@code cell}. The water poured against lava poured
	 * first must not come in through the lava's cell: the lava casts as the water lands, and the obsidian then stands
	 * between the eye and the water, so it cannot be scooped before it spreads (in one cave room, water poured along the
	 * frame's plane through the cell it cast stood 211 ticks while the body walked round, and ran out of the frame).
	 */
	static boolean crosses(Vec3 eye, Vec3 point, BlockPos cell) {
		return cell != null && new AABB(cell).deflate(0.01D).clip(eye, point).isPresent();
	}

	/** {@link #pourClick(ServerPlayer, Vec3, BlockPos, boolean)} whose line does not pass through {@code avoid}. */
	private BlockHitResult pourClick(ServerPlayer player, Vec3 eye, BlockPos target, boolean verify, BlockPos avoid) {
		List<Direction> sides = new ArrayList<>(List.of(Direction.values()));
		sides.sort(Comparator.comparingDouble(d -> Vec3.atCenterOf(target.relative(d)).distanceToSqr(eye)));
		for (Direction side : sides) {
			BlockPos support = target.relative(side);
			if (!full(player, support) && !madeSolid.contains(support) || deadSupports.contains(support)) continue;
			Direction face = side.getOpposite();
			Vec3 point = TargetSightline.block(player.level(), CollisionContext.of(player), eye, support, player.blockInteractionRange() - 0.2D, face);
			if (point == null || crosses(eye, point, avoid)) continue;
			if (verify) {
				BlockHitResult hit = environment.bucketRay(player, point, false);
				if (hit == null || hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(support) || hit.getDirection() != face) continue;
			}
			return new BlockHitResult(point, face, support, false);
		}
		return null;
	}

	/**
	 * Lava for the next cell: the empty bucket at the nearest seen pool source it reaches, walking beside the pool first.
	 * Each scoop takes a source (the hole fills with flowing lava) and much of a cave pool lies out of sight behind its rim,
	 * so with nothing seen in reach the body looks round with the eyes lowered, then walks along the shore from where the
	 * last lava came from (four ways round it) and looks again, as a player does, before handing back.
	 */
	private TickResult fetchLava(ServerPlayer player, long now) {
		List<BlockPos> sources = new ArrayList<>(lavaSources(player, portal.at(1, 1), CAST_FETCH_RANGE));
		// Sight memory fades in 10 s, so the pool is forgotten while the body works at the frame: lava this build saw and
		// has not since seen gone or taken is still where it was.
		Set<BlockPos> listed = new HashSet<>(sources);
		Vec3 here = player.getEyePosition();
		List<BlockPos> recalled = new ArrayList<>();
		for (BlockPos at : poolMemory) {
			if (listed.contains(at) || Math.sqrt(at.distSqr(portal.at(1, 1))) > CAST_FETCH_RANGE) continue;
			BlockState state = known(player, at);
			if (state == null || lavaSource(state)) recalled.add(at);
		}
		recalled.sort(Comparator.comparingDouble(at -> Vec3.atCenterOf(at).distanceToSqr(here)));
		sources.addAll(recalled);
		sources.removeAll(triedSources);
		if (!sources.isEmpty()) {
			for (BlockPos source : sources.subList(0, Math.min(12, sources.size())))
				if (scoopClick(player, source) != null) { seekLooks = 0; return pour(player, now, Pour.FILL, source, null); }
			// Back to where a scoop last landed while lava it reaches is left: a dry spot it has stood on, by the way it
			// walked (sight of the shore fades while the body works at the frame, and the frame hides it).
			for (int k = scoopSpots.size() - 1; k >= 0 && walks < MAX_WALKS - 1; k--) {
				BlockPos spot = scoopSpots.get(k);
				if (spot.equals(player.blockPosition()) || triedSpots.contains(spot)) continue;
				Vec3 eye = Vec3.atBottomCenterOf(spot).add(0.0D, player.getEyeHeight(), 0.0D);
				for (BlockPos source : sources)
					if (surface(player, source) && eye.distanceTo(Vec3.atCenterOf(source).add(0.0D, 0.4D, 0.0D)) <= player.blockInteractionRange() - 0.3D) {
						seekLooks = 0;
						return walkTo(player, spot, now);
					}
			}
			BlockPos spot = poolSpot(player, sources);
			if (spot != null && walks < MAX_WALKS - 1) { seekLooks = 0; return walkTo(player, spot, now); }
		}
		if (seekLooks < 8) {
			if (lookAim == null) {
				double yaw = Math.toRadians(seekLooks * 45.0D);
				lookAim = player.getEyePosition().add(-Math.sin(yaw) * 7.0D, seekLooks % 2 == 0 ? -3.0D : -1.5D, Math.cos(yaw) * 7.0D);
			}
			releaseInput();
			if (ServerLookController.turnToward(player, lookAim)) { lookAim = null; seekLooks++; pause = 3; }
			return running();
		}
		BlockPos around = lastFill != null ? lastFill : poolAt;
		// Remembered sources not taken and not seen gone, nearest the frame first: walk back where the pool was seen.
		List<BlockPos> remembered = new ArrayList<>();
		Vec3 frame = Vec3.atCenterOf(portal.at(1, 1));
		for (BlockPos at : poolMemory) {
			BlockState state = known(player, at);
			if (state == null || lavaSource(state)) remembered.add(at);
		}
		remembered.removeAll(triedSources);
		remembered.sort(Comparator.comparingDouble(at -> Vec3.atCenterOf(at).distanceToSqr(frame)));
		while (seekWalks < 8) {
			int k = seekWalks++;
			BlockPos toward = k < remembered.size() && k % 2 == 1 ? remembered.get(k) : k == 0 ? around : around.relative(Direction.from2DDataValue(k), 7);
			BlockPos spot = nearestStand(player, toward, 5);
			if (spot != null) { seekLooks = 0; triedSources.clear(); return walkTo(player, spot, now); }
		}
		// One walk that failed rules out the spots round its target (see the walk's failure), which on a narrow shore is
		// every dry spot by the pool (away-pair-7: 8 sources in view, BUILD_SHORT after one failed walk in 4 of 10 runs on
		// main, 10 of 10 on this branch): with lava still seen, forget them once and try the shore again.
		if (!sources.isEmpty() && !triedSpots.isEmpty() && fetchRetries < 2 && walks < MAX_WALKS - 1) {
			fetchRetries++;
			triedSpots.clear();
			triedSources.clear();
			seekLooks = 0;
			seekWalks = 0;
			return running();
		}
		return fail(player, "BUILD_SHORT", "Short of material: no lava source in reach after " + castIndex + " of 10 cells (" + sources.size() + " seen within "
				+ CAST_FETCH_RANGE + " blocks of the frame, none with a dry spot beside it) after looking round and walking the shore near " + xyz(around)
				+ "; find more lava and build again" + lastWalk());
	}

	/**
	 * A seen dry standing spot within bucket reach of an open-topped source (the pool's surface, not a source under
	 * another), nearest the body and the frame, off the frame and mould.
	 */
	private BlockPos poolSpot(ServerPlayer player, List<BlockPos> sources) {
		ServerLevel level = (ServerLevel) player.level();
		triedSpots.add(player.blockPosition().immutable());
		Vec3 frame = Vec3.atCenterOf(portal.at(1, 1));
		List<BlockPos> surface = new ArrayList<>();
		for (BlockPos source : sources) if (surface(player, source)) surface.add(source);
		surface.sort(Comparator.comparingDouble(at -> Vec3.atCenterOf(at).distanceToSqr(frame)));
		BlockPos best = null;
		double bestCost = Double.MAX_VALUE;
		// Scoops take the shore's sources first (the hole fills with flowing lava): the reachable ones move along the shore.
		for (BlockPos source : surface.subList(0, Math.min(96, surface.size()))) {
			Vec3 top = Vec3.atCenterOf(source).add(0.0D, 0.4D, 0.0D);
			for (BlockPos at : BlockPos.betweenClosed(source.offset(-4, -1, -4), source.offset(4, 3, 4))) {
				if (triedSpots.contains(at) || blocked(at) || blocked(at.above()) || !standable(player, level, at) && !stoodOn(player, at)) continue;
				Vec3 eye = Vec3.atBottomCenterOf(at).add(0.0D, player.getEyeHeight(), 0.0D);
				if (eye.distanceTo(top) > player.blockInteractionRange() - 0.3D) continue;
				double cost = Vec3.atBottomCenterOf(at).distanceTo(player.position()) + 0.5D * Math.sqrt(at.distSqr(portal.at(1, 1)));
				// Flowing lava from earlier scoops beside the spot: travel refuses routes into its way, so prefer drier shore.
				for (BlockPos near : BlockPos.betweenClosed(at.offset(-2, -1, -2), at.offset(2, 0, 2))) {
					BlockState state = known(player, near);
					if (TravelBuilder.lava(state) && !state.getFluidState().isSource()) cost += 3.0D;
				}
				if (cost < bestCost) { bestCost = cost; best = at.immutable(); }
			}
		}
		return best;
	}

	/**
	 * A source a bucket can take from above: open-topped, or under the flowing lava that runs into a scooped hole (a bucket's
	 * ray passes flowing lava); a remembered source's top is as it was when seen.
	 */
	private boolean surface(ServerPlayer player, BlockPos source) {
		BlockState over = known(player, source.above());
		return over == null ? poolMemory.contains(source) : over.isAir() || TravelBuilder.lava(over) && !over.getFluidState().isSource();
	}

	/** The seen standing spot nearest {@code target} within {@code radius}, off the frame and mould, not yet tried. */
	private BlockPos nearestStand(ServerPlayer player, BlockPos target, int radius) {
		ServerLevel level = (ServerLevel) player.level();
		BlockPos best = null;
		double bestCost = Double.MAX_VALUE;
		for (BlockPos at : BlockPos.betweenClosed(target.offset(-radius, -3, -radius), target.offset(radius, 4, radius))) {
			if (triedSpots.contains(at) || blocked(at) || blocked(at.above()) || !standable(player, level, at) && !stoodOn(player, at)) continue;
			double cost = Math.sqrt(at.distSqr(target));
			if (cost < bestCost) { bestCost = cost; best = at.immutable(); }
		}
		return best;
	}

	/** One placement through use_item's gates; a refusal they throw (a cell not in sight yet) is a reason, as a returned one is. */
	private String place(ServerPlayer player, BlockPos at, String item) {
		try {
			return environment.place(player, at, Direction.UP, item);
		} catch (AgentDomainException refused) {
			return refused.code() + ": " + refused.getMessage();
		}
	}

	private TickResult placeObsidian(ServerPlayer player, BlockPos cell, long now) {
		Vec3 aim = null;
		try { aim = environment.aim(player, cell, Direction.UP, "minecraft:obsidian"); }
		catch (AgentDomainException blocked) { refusal = blocked.code() + ": " + blocked.getMessage(); }
		if (aim == null) {
			BlockPos spot = standFor(player, eye -> sees(player, eye, cell));
			if (spot == null) return fail(player, "NO_STAND_SPOT", "No seen spot reaches a face to place obsidian at " + xyz(cell) + lastWalk());
			return walkTo(player, spot, now);
		}
		if (!turn(player, aim, false)) return clickStall(player, now);
		String why = place(player, cell, "minecraft:obsidian");
		if (why != null) { refusal = why; return clickStall(player, now); }
		obsidianPlaced++;
		placed++;
		clickTicks = 0;
		pause = 2;
		return running();
	}

	/** A cell the body must not stand in: the frame's plane or the mould behind it. */
	private boolean blocked(BlockPos at) {
		return portal != null && (portal.reserved(at) || mould.contains(at));
	}

	private static int plainCount(ServerPlayer player) {
		int plain = 0;
		Set<String> seen = new HashSet<>();
		for (int slot = 0; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!scaffoldBlock(stack)) continue;
			String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			if (seen.add(id)) plain += carried(player, id);
		}
		return plain;
	}

	/** The mould's block: a plain full block that does not fall, else any scaffold block. */
	private static String mouldItem(ServerPlayer player) {
		String plain = plainBlock(player, false);
		return plain != null ? plain : plainBlock(player, true);
	}


	private TickResult pillarTick(ServerPlayer player, long now) {
		GridPosition current = ServerTravelController.feet(player);
		if (player.onGround() && current.y() >= pillarGoal) {
			if (moveStage == 1) placed++;
			releaseInput();
			if (pillarReturn != null) { phase = pillarReturn; pillarReturn = null; moveStage = 0; cellTicks = 0; return running(); }
			return end(player, TickResult.succeeded("PILLAR_BUILT", facts(player) + "; stood up " + (current.y() - startY) + " blocks on a pillar at "
					+ current.x() + "," + current.y() + "," + current.z()));
		}
		BlockPos head = new BlockPos(current.x(), current.y() + 2, current.z());
		BlockState above = known(player, head);
		if (above == null) {
			if (lookTicks++ < 15) { apply(player, new AgentInputStates.MotorTarget(player.getYRot(), -90.0F, false, false, false), false, now); return running(); }
			return fail(player, "BUILD_BLOCKED", "The cell over the head at " + xyz(head) + " is unseen; the pillar stopped at " + (current.y() - startY) + " blocks");
		}
		lookTicks = 0;
		if (!above.getCollisionShape(player.level(), head).isEmpty() || !above.getFluidState().isEmpty())
			return fail(player, "BUILD_BLOCKED", describe(above) + " over the head at " + xyz(head) + " stops the pillar at " + (current.y() - startY) + " of " + size + " blocks");
		if (moveStage == 0) {
			String item = pillarReturn != null ? spareItem(player) : material != null ? material : plainBlock(player, false);
			if (item == null || carried(player, item) == 0) return short_(player, pillarReturn != null ? "stepping up needs 1 plain block, none left"
					: "the pillar ran out of plain blocks at " + (current.y() - startY) + " of " + size + "; " + (size - (current.y() - startY)) + " more");
			int slot = select(player, slot(player, item), now);
			if (slot >= 0 && player.getInventory().getSelectedSlot() == slot && player.onGround()) { moveStage = 1; moveFeet = current; moveTicks = 0; }
			return running();
		}
		if (++moveTicks > 60) {
			BlockHitResult seen = TravelBuilder.crosshair(player);
			return fail(player, "BUILD_BLOCKED", "Could not pillar up at " + current.x() + "," + current.y() + "," + current.z() + String.format(Locale.ROOT,
					" (feet y %.2f, pitch %.0f, %s, holding %s, crosshair %s)", player.getY(), player.getXRot(), player.onGround() ? "on the ground" : "in the air",
					BuiltInRegistries.ITEM.getKey(player.getMainHandItem().getItem()), seen == null ? "none" : xyz(seen.getBlockPos()) + " " + seen.getDirection().getSerializedName()));
		}
		BlockPos cellBelow = new BlockPos(moveFeet.x(), moveFeet.y(), moveFeet.z());
		if (solid(player, cellBelow) && player.onGround() && current.y() > moveFeet.y()) { placed++; moveStage = 0; return running(); }
		if (player.onGround() && current.y() == moveFeet.y()) {
			BlockPos under = BlockPos.containing(player.getX(), moveFeet.y() - 1, player.getZ());
			if (player.level().getBlockState(under).getCollisionShape(player.level(), under).isEmpty()) {
				double dx = moveFeet.x() + 0.5D - player.getX(), dz = moveFeet.z() + 0.5D - player.getZ();
				apply(player, new AgentInputStates.MotorTarget(player.getYRot(), 90.0F, true, false, false, (float) Math.toDegrees(Math.atan2(-dx, dz))), true, now);
				return running();
			}
		}
		boolean high = player.getY() >= moveFeet.y() + 1.0D + 1.0E-3D;
		BlockHitResult hit = TravelBuilder.crosshair(player);
		// A snow layer or plant in the feet cell takes the click itself: vanilla replaces it with the placed block.
		boolean replaceable = hit != null && hit.getBlockPos().equals(cellBelow) && player.level().getBlockState(cellBelow).canBeReplaced();
		if (high && hit != null && hit.getDirection() == Direction.UP && (hit.getBlockPos().equals(cellBelow.below()) || replaceable)) TravelBuilder.click(player, hit);
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), 90.0F, false, player.onGround() && player.getXRot() > 85.0F, false), true, now);
		return running();
	}


	/** A 1-wide line toward x,z: travel_to's judgement of the cell ahead, its sneak-bridge for a gap, a plain step otherwise. */
	private TickResult bridgeTick(ServerPlayer player, long now) {
		if (move != null) return moveTick(player, now);
		GridPosition feet = ServerTravelController.feet(player);
		if (lineStart == null) lineStart = feet;
		if (player.onGround()) cells = Math.max(cells, lineCells(lineStart, feet, line));
		// Between moves the body stands still and crouched: a step's walking keys never carry it on, and on magma one
		// upright tick burns.
		if (lease != null || BrinkGuard.onMagma(player)) apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, now);
		double dx = requested.getX() + 0.5D - player.getX(), dz = requested.getZ() + 0.5D - player.getZ();
		double along = dx * line.getStepX() + dz * line.getStepZ();
		if (along <= 0.7D && player.onGround()) {
			releaseInput();
			return end(player, TickResult.succeeded("BRIDGE_BUILT", facts(player) + "; reached " + feet.x() + "," + feet.y() + "," + feet.z()
					+ " along " + line.getSerializedName() + " toward " + xyz(requested)));
		}
		if (cells >= size) {
			releaseInput();
			return end(player, TickResult.succeeded("BRIDGE_BUILT", facts(player) + "; covered " + cells + " cells along " + line.getSerializedName()
					+ " (size limit), " + String.format(Locale.ROOT, "%.0f", along) + " blocks short of " + xyz(requested)));
		}
		MinecraftNavigationWorld world = new MinecraftNavigationWorld((ServerLevel) player.level(), player);
		String item = material != null ? material : plainBlock(player, false);
		TravelBuilder.Plan plan = TravelBuilder.decide(world, cell -> world.stateAt(new BlockPos(cell.x(), cell.y(), cell.z())), feet, line,
				item != null && carried(player, item) > 0, 0);
		if (!plan.possible() && "unseen".equals(plan.refusalCode()) && glances++ < 3) {
			lookAim = player.getEyePosition().add(line.getStepX() * 2.0D, -2.0D, line.getStepZ() * 2.0D);
			lookTicks = 0;
		}
		if (lookAim != null) {
			releaseInput();
			if (!ServerLookController.turnToward(player, lookAim) && lookTicks++ < 20) return running();
			lookAim = null;
			return running();
		}
		if (!plan.possible()) {
			if ("out-of-blocks".equals(plan.refusalCode())) return short_(player, "the bridge ran out of plain blocks after " + placed + "; " + plan.refusal());
			return fail(player, "BUILD_BLOCKED", "The bridge line " + line.getSerializedName() + " stops at " + feet.x() + "," + feet.y() + "," + feet.z() + ": " + plan.refusal());
		}
		glances = 0;
		switch (plan.kind()) {
			case STEP, CROSS, BRIDGE, FILL -> {
				if ((plan.kind() == TravelBuilder.Kind.BRIDGE || plan.kind() == TravelBuilder.Kind.FILL) && item == null)
					return short_(player, "the bridge needs plain full blocks, none carried");
				move = plan;
				moveFeet = feet;
				moveStage = 0;
				moveTicks = 0;
				centred = false;
				return running();
			}
			default -> {
				return fail(player, "BUILD_BLOCKED", "The bridge line " + line.getSerializedName() + " at " + feet.x() + "," + feet.y() + "," + feet.z()
						+ " needs a " + plan.kind().name().toLowerCase(Locale.ROOT).replace('_', ' ') + ", not a bridge; travel_to with build:true goes over or through it");
			}
		}
	}

	private TickResult moveTick(ServerPlayer player, long now) {
		moveTicks++;
		boolean placing = move.kind() == TravelBuilder.Kind.BRIDGE || move.kind() == TravelBuilder.Kind.FILL;
		if (placing && moveStage == 0 && !centred) {
			double dx = moveFeet.x() + 0.5D - player.getX(), dz = moveFeet.z() + 0.5D - player.getZ();
			if (dx * dx + dz * dz <= ServerTravelController.CENTRED * ServerTravelController.CENTRED && player.onGround() || moveTicks > 40) { centred = true; moveTicks = 0; }
			else {
				apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), true, false, false, (float) Math.toDegrees(Math.atan2(-dx, dz))), true, now);
				return running();
			}
		}
		return switch (move.kind()) {
			case FILL -> fillTick(player, now);
			case STEP, CROSS -> stepMove(player, now);
			default -> bridgeMove(player, now);
		};
	}

	/**
	 * Whether a bridge step is walked crouched (travel_to's step rule): over magma, on a level step, and whenever the cell
	 * past the goal is no ground to stand on (not standable and no wall to stop against) or holds a hazard, so a jump up
	 * a ledge with a drop behind it lands crouched and vanilla holds the body at the lip.
	 */
	static boolean stepCrouch(TravelBuilder.Kind kind, int rise, boolean pastStandable, boolean wallRunout, boolean pastExposed) {
		return kind == TravelBuilder.Kind.CROSS || rise == 0 || !pastStandable && !wallRunout || pastExposed;
	}

	static int lineCells(GridPosition start, GridPosition feet, Direction line) {
		return Math.max(0, (feet.x() - start.x()) * line.getStepX() + (feet.z() - start.z()) * line.getStepZ());
	}

	private void moveDone() {
		move = null;
		moveStage = 0;
		stepWalk = null;
	}

	/**
	 * travel_to's step: one cell along the line, crouched over magma (vanilla magma never burns a sneaking body), on a
	 * level step, and whenever the cell past the goal is no ground to stand on (travel's runout rule: a jump up a ledge
	 * with a drop behind it lands crouched and stays on it); a step down goes through navigation, which owns the guarded
	 * drop. The goal is stamped as the commanded destination every tick, so the brink guard judges a jump's landing before
	 * take-off and refuses one over a lethal or unseen-bottom drop. A step that does not arrive hands back to the model
	 * with why, instead of being counted and retried.
	 */
	private TickResult stepMove(ServerPlayer player, long now) {
		Direction direction = move.direction();
		GridPosition goal = moveFeet.offset(direction.getStepX(), move.count(), direction.getStepZ());
		String cell = goal.x() + "," + goal.y() + "," + goal.z();
		if (move.count() < 0) {
			if (stepWalk == null) { releaseInput(); stepWalk = new ServerNavigationController(new Vec3(goal.x() + 0.5D, goal.y(), goal.z() + 0.5D), 0.3D, false, now, 8_000L); }
			TickResult walked = stepWalk.tick(player, now);
			if (walked.state() == State.RUNNING) return running();
			stepWalk.cancel(player);
			if (walked.state() != State.SUCCEEDED) return fail(player, "BUILD_BLOCKED", "The step down to " + cell + " failed: " + walked.reasonCode() + " " + walked.message());
			moveDone();
			return running();
		}
		if (ServerTravelController.stepArrived(player.position(), ServerTravelController.feet(player), goal, player.onGround())) { moveDone(); return running(); }
		if (moveTicks > 80) return fail(player, "BUILD_BLOCKED", "Could not step onto " + cell + (move.kind() == TravelBuilder.Kind.CROSS ? " (magma, crouched)" : "")
				+ (BrinkGuard.savedSince(player, stepStartedAt) == null ? "" : "; " + BrinkGuard.savedSince(player, stepStartedAt)));
		if (moveTicks == 1) {
			stepStartedAt = player.level().getGameTime();
			MinecraftNavigationWorld world = new MinecraftNavigationWorld((ServerLevel) player.level(), player);
			GridPosition past = goal.offset(direction.getStepX(), 0, direction.getStepZ());
			boolean wallRunout = world.cellAt(past) == dev.agaminggod.mineagen.client.navigation.WalkabilityView.Cell.SAFE_SUPPORT
					|| world.cellAt(past.offset(0, 1, 0)) == dev.agaminggod.mineagen.client.navigation.WalkabilityView.Cell.SAFE_SUPPORT;
			stepSneak = stepCrouch(move.kind(), move.count(), world.isStandable(past), wallRunout, world.exposureCost(past) > 0);
		}
		boolean sneak = stepSneak;
		BrinkGuard.commandedDestination(player, new Vec3(goal.x() + 0.5D, goal.y(), goal.z() + 0.5D));
		double dx = goal.x() + 0.5D - player.getX(), dz = goal.z() + 0.5D - player.getZ();
		boolean jump = goal.y() > moveFeet.y() && player.onGround() && dx * dx + dz * dz < 1.44D && ServerTravelController.feet(player).y() < goal.y();
		apply(player, new AgentInputStates.MotorTarget((float) Math.toDegrees(Math.atan2(-dx, dz)), 30.0F, true, jump, false), sneak, now);
		return running();
	}

	private TickResult bridgeMove(ServerPlayer player, long now) {
		Direction direction = move.direction();
		BlockPos support = new BlockPos(moveFeet.x(), moveFeet.y() - 1, moveFeet.z());
		BlockPos target = support.relative(direction);
		if (moveStage == 0) {
			int slot = select(player, slot(player, material != null ? material : plainBlock(player, false)), now);
			if (slot >= 0 && player.getInventory().getSelectedSlot() == slot) {
				moveStage = 1;
				bridgeAttachment = bridgeAttachment(player, target);
				float[] view = bridgeAttachment == null ? new float[] { TravelBuilder.yaw(direction.getOpposite()), 81.0F }
						: TravelBuilder.lookAt(player.getEyePosition(), bridgeAttachment.getLocation());
				bridgeViewYaw = view[0];
				bridgeViewPitch = view[1];
			}
			return running();
		}
		float back = TravelBuilder.yaw(direction.getOpposite());
		if (moveStage == 1) {
			if (solid(player, target)) { moveStage = 2; return running(); }
			if (moveTicks > 120) return fail(player, "BUILD_BLOCKED", "Could not reach a view of the side of " + xyz(support) + " to bridge " + xyz(target));
			BlockHitResult hit = TravelBuilder.crosshair(player);
			if (bridgeAttachment != null) {
				boolean onFace = hit != null && hit.getBlockPos().equals(bridgeAttachment.getBlockPos()) && hit.getDirection() == bridgeAttachment.getDirection();
				if (onFace && player.onGround() && !player.getBoundingBox().intersects(new AABB(target))) {
					TravelBuilder.click(player, hit);
					if (solid(player, target)) { placed++; moveStage = 2; }
				}
				apply(player, new AgentInputStates.MotorTarget(bridgeViewYaw, bridgeViewPitch, false, false, false), true, now);
				return running();
			}
			boolean onFace = hit != null && hit.getBlockPos().equals(support) && hit.getDirection() == direction;
			if (onFace && player.onGround() && !player.getBoundingBox().intersects(new AABB(target))) {
				TravelBuilder.click(player, hit);
				if (solid(player, target)) { placed++; moveStage = 2; }
				apply(player, new AgentInputStates.MotorTarget(back, 81.0F, false, false, false), true, now);
				return running();
			}
			double gx = moveFeet.x() + 0.5D + direction.getStepX() - player.getX(), gz = moveFeet.z() + 0.5D + direction.getStepZ() - player.getZ();
			double alongSupport = (player.getX() - moveFeet.x() - 0.5D) * direction.getStepX() + (player.getZ() - moveFeet.z() - 0.5D) * direction.getStepZ();
			apply(player, new AgentInputStates.MotorTarget(back, 81.0F, true, false, false, (float) Math.toDegrees(Math.atan2(-gx, gz))), alongSupport >= 0.25D, now);
			return running();
		}
		GridPosition onto = moveFeet.offset(direction.getStepX(), 0, direction.getStepZ());
		double dx = onto.x() + 0.5D - player.getX(), dz = onto.z() + 0.5D - player.getZ();
		double along = -(dx * direction.getStepX() + dz * direction.getStepZ());
		if (along > -0.15D && player.onGround() && ServerTravelController.feet(player).equals(onto)) { moveDone(); return running(); }
		if (moveTicks > 200) return fail(player, "BUILD_BLOCKED", "Could not step onto the bridge block at " + xyz(target));
		apply(player, new AgentInputStates.MotorTarget(bridgeViewYaw, bridgeViewPitch, true, false, false, (float) Math.toDegrees(Math.atan2(-dx, dz))), along > 0.0D, now);
		return running();
	}

	private BlockHitResult bridgeAttachment(ServerPlayer player, BlockPos target) {
		MinecraftNavigationWorld seen = new MinecraftNavigationWorld((ServerLevel) player.level(), player);
		Vec3 eye = player.getEyePosition();
		BlockHitResult best = null;
		double bestTurn = Double.POSITIVE_INFINITY;
		for (Direction side : Direction.Plane.HORIZONTAL) {
			BlockPos anchor = target.relative(side);
			BlockState state = seen.stateAt(anchor);
			if (state == null || !state.isCollisionShapeFullBlock(player.level(), anchor)) continue;
			Direction face = side.getOpposite();
			Vec3 normal = new Vec3(face.getStepX(), face.getStepY(), face.getStepZ());
			Vec3 point = Vec3.atCenterOf(anchor).add(normal.scale(0.5D));
			if (eye.distanceTo(point) > player.blockInteractionRange()) continue;
			BlockHitResult hit = player.level().clip(new net.minecraft.world.level.ClipContext(eye, point.subtract(normal.scale(0.01D)),
					net.minecraft.world.level.ClipContext.Block.OUTLINE, net.minecraft.world.level.ClipContext.Fluid.NONE, player));
			if (hit.getType() != net.minecraft.world.phys.HitResult.Type.BLOCK || !hit.getBlockPos().equals(anchor) || hit.getDirection() != face) continue;
			float[] look = TravelBuilder.lookAt(eye, point);
			double turn = Math.abs(AgentInputStates.shortestAngleDelta(player.getYRot(), look[0])) + Math.abs(player.getXRot() - look[1]);
			if (turn < bestTurn) { best = hit; bestTurn = turn; }
		}
		return best;
	}

	private TickResult fillTick(ServerPlayer player, long now) {
		Direction direction = move.direction();
		BlockPos hole = new BlockPos(moveFeet.x() + direction.getStepX(), moveFeet.y() - 1, moveFeet.z() + direction.getStepZ());
		if (moveStage == 0) {
			int slot = select(player, slot(player, material != null ? material : plainBlock(player, false)), now);
			if (slot >= 0 && player.getInventory().getSelectedSlot() == slot) moveStage = 1;
			return running();
		}
		if (moveStage == 1) {
			if (solid(player, hole)) { moveStage = 2; return running(); }
			if (moveTicks > 100) return fail(player, "BUILD_BLOCKED", "Could not place a block into the hole at " + xyz(hole));
			float[] look = TravelBuilder.lookAt(player.getEyePosition(), new Vec3(hole.getX() + 0.5D, hole.getY() + 0.02D, hole.getZ() + 0.5D));
			boolean overlaps = player.getBoundingBox().intersects(new AABB(hole));
			BlockHitResult hit = TravelBuilder.crosshair(player);
			if (!overlaps && hit != null && hit.getBlockPos().equals(hole.below()) && hit.getDirection() == Direction.UP && player.onGround()) {
				TravelBuilder.click(player, hit);
				if (solid(player, hole)) { placed++; moveStage = 2; }
			}
			apply(player, new AgentInputStates.MotorTarget(look[0], look[1], overlaps, false, false, overlaps ? TravelBuilder.yaw(direction.getOpposite()) : Float.NaN), true, now);
			return running();
		}
		releaseInput();
		moveDone();
		return running();
	}


	private TickResult walkTo(ServerPlayer player, BlockPos spot, long now) {
		if (walks >= MAX_WALKS) return fail(player, "NO_STAND_SPOT", MAX_WALKS + " walks did not bring the work into reach" + lastWalk());
		releaseInput();
		walks++;
		triedSpots.add(spot);
		walkTarget = spot;
		moveForClick = false;
		// Any phase of a cast (clearing, casting, lighting): the frame and mould hide the way round from travel's planner.
		// Not a step back from an inflow or a walk to open the pool: those go the short way travel finds.
		List<BlockPos> way = casting && phase != Phase.PLUG && phase != Phase.UNCOVER ? wayWalked(player, spot) : null;
		LOGGER.info("[build] {} walk {} to {} in {} ({})", player.getGameProfile().name(), walks, xyz(spot), phase, way != null && way.size() > 3 ? way.size() + " steps walked before" : "travel");
		if (way != null && way.size() > 3) {
			// Cell by cell along steps it took: travel plans only through what is in sight, and a way round the frame is not.
			wayBack.addAll(way.subList(1, way.size()));
			nextHop(now);
			return running();
		}
		walk = new ServerNavigationController(Vec3.atBottomCenterOf(spot), 0.35D, false, now, 20_000L);
		return running();
	}

	static BlockPos lavaNamed(String message) {
		java.util.regex.Matcher m = java.util.regex.Pattern.compile("lava at (-?\\d+),\\s*(-?\\d+),\\s*(-?\\d+)").matcher(String.valueOf(message));
		return m.find() ? new BlockPos(Integer.parseInt(m.group(1)), Integer.parseInt(m.group(2)), Integer.parseInt(m.group(3))) : null;
	}

	/** Whether the seen lava joined to {@code at} holds a source (a flow that stays), else it drains. */
	private boolean fed(ServerPlayer player, BlockPos at) {
		Set<BlockPos> seen = new HashSet<>(List.of(at));
		java.util.ArrayDeque<BlockPos> queue = new java.util.ArrayDeque<>(List.of(at));
		while (!queue.isEmpty() && seen.size() < 256) {
			BlockPos cell = queue.poll();
			BlockState state = known(player, cell);
			if (lavaSource(state)) return true;
			if (!TravelBuilder.lava(state)) continue;
			for (Direction side : Direction.values()) if (seen.add(cell.relative(side).immutable())) queue.add(cell.relative(side).immutable());
		}
		return false;
	}

	private void recordStep(BlockPos at) {
		if (lastStood != null && !at.equals(lastStood) && stepsWalked.size() < 4096 && Math.abs(at.getX() - lastStood.getX()) <= 1 && Math.abs(at.getZ() - lastStood.getZ()) <= 1
				&& at.getY() - lastStood.getY() <= 1 && lastStood.getY() - at.getY() <= 3) {
			stepsWalked.computeIfAbsent(lastStood.immutable(), k -> new HashSet<>()).add(at.immutable());
			if (lastStood.getY() - at.getY() <= 1) stepsWalked.computeIfAbsent(at.immutable(), k -> new HashSet<>()).add(lastStood.immutable());
		}
		lastStood = at.immutable();
	}

	private List<BlockPos> wayWalked(ServerPlayer player, BlockPos target) {
		BlockPos from = player.blockPosition();
		if (!stepsWalked.containsKey(from) || !stepsWalked.containsKey(target)) return null;
		java.util.Map<BlockPos, BlockPos> parent = new java.util.HashMap<>();
		java.util.ArrayDeque<BlockPos> queue = new java.util.ArrayDeque<>(List.of(from));
		parent.put(from, from);
		while (!queue.isEmpty()) {
			BlockPos at = queue.poll();
			if (at.equals(target)) break;
			for (BlockPos next : stepsWalked.getOrDefault(at, Set.of())) {
				if (parent.containsKey(next) || blocked(next) || blocked(next.above())) continue;
				// A cell since filled (a cast block, a placed one) is no longer a step.
				BlockState feet = known(player, next), head = known(player, next.above());
				if (feet != null && !feet.getCollisionShape(player.level(), next).isEmpty() || head != null && !head.getCollisionShape(player.level(), next.above()).isEmpty()) continue;
				parent.put(next, at);
				queue.add(next);
			}
		}
		if (!parent.containsKey(target)) return null;
		List<BlockPos> way = new ArrayList<>();
		for (BlockPos at = target; !at.equals(from); at = parent.get(at)) way.add(at);
		way.add(from);
		java.util.Collections.reverse(way);
		return way;
	}

	private void nextHop(long now) {
		BlockPos hop = wayBack.poll();
		if (!wayBack.isEmpty()) hop = wayBack.poll();
		walk = new ServerNavigationController(Vec3.atBottomCenterOf(hop), wayBack.isEmpty() ? 0.35D : 0.6D, false, now, 10_000L);
	}

	/** The nearest seen standing spot near the site, not yet tried and off the blueprint, from which {@code sees} holds. */
	private BlockPos standFor(ServerPlayer player, Predicate<Vec3> sees) {
		ServerLevel level = (ServerLevel) player.level();
		BlockPos around = portal != null ? portal.at(1, 1) : player.blockPosition();
		triedSpots.add(player.blockPosition().immutable());
		BlockPos best = null;
		double bestCost = Double.MAX_VALUE;
		for (BlockPos at : BlockPos.betweenClosed(around.offset(-5, -2, -5), around.offset(5, 3, 5))) {
			if (triedSpots.contains(at)) continue;
			if (blocked(at) || blocked(at.above())) continue;
			if (!standable(player, level, at) && !stoodOn(player, at)) continue;
			Vec3 eye = Vec3.atBottomCenterOf(at).add(0.0D, player.getEyeHeight(), 0.0D);
			if (!sees.test(eye)) continue;
			double cost = Vec3.atBottomCenterOf(at).distanceTo(player.position());
			if (portal != null && Math.abs(portal.axis() == Direction.Axis.Z ? at.getX() - portal.origin().getX() : at.getZ() - portal.origin().getZ()) <= 1) cost += 2.0D;
			if (cost < bestCost) { bestCost = cost; best = at.immutable(); }
		}
		return best;
	}

	private boolean inFootprint(BlockPos at) {
		return portal != null && portal.reserved(at);
	}

	private boolean standable(ServerPlayer player, ServerLevel level, BlockPos at) {
		BlockState below = known(player, at.below());
		if (below == null || !below.isFaceSturdy(level, at.below(), Direction.UP) || !below.getFluidState().isEmpty()) return false;
		for (BlockPos body : new BlockPos[] { at, at.above() }) {
			BlockState state = known(player, body);
			if (state == null || !state.getCollisionShape(level, body).isEmpty() || TravelBuilder.fire(state)) return false;
			// A cast's own poured water runs out over the working ground for a moment: flowing water there is no bar.
			if (!state.getFluidState().isEmpty() && !(casting && !state.getFluidState().isSource() && state.getFluidState().getType().isSame(Fluids.WATER))) return false;
		}
		for (Direction side : Direction.Plane.HORIZONTAL) if (TravelBuilder.lava(known(player, at.relative(side)))) return false;
		return true;
	}

	/** A cell not seen yet: look at it, then walk somewhere it can be seen from; with no spot left, hand back. */
	private TickResult observe(ServerPlayer player, BlockPos cell, long now) {
		if (!cell.equals(lookCell)) { lookCell = cell.immutable(); lookTicks = 0; stoodWalks = 0; }
		if (lookTicks++ < 20) { releaseInput(); ServerLookController.turnToward(player, Vec3.atCenterOf(cell)); return running(); }
		lookTicks = 0;
		BlockPos stood = stoodWalks < 3 ? stoodSpotFor(player, cell) : null;
		if (stood != null) stoodWalks++;
		BlockPos spot = stood != null ? stood : standFor(player, eye -> eye.distanceTo(Vec3.atCenterOf(cell)) < player.blockInteractionRange() - 0.5D);
		LOGGER.info("[build] {} unseen cell {}: walk to {} ({})", player.getGameProfile().name(), xyz(cell), spot == null ? "none" : xyz(spot), stood != null ? "a spot stood on" : "a seen spot");
		if (spot == null) return fail(player, "BUILD_BLOCKED", "Cell " + xyz(cell) + " stays unseen" + lastWalk());
		return walkTo(player, spot, now);
	}

	/**
	 * The nearest cell this build stood on, reached from here by steps it took, whose eye is within reach of {@code cell}
	 * and which lies off the mould's side of the frame (the mould hides the frame from behind); null when none.
	 */
	private BlockPos stoodSpotFor(ServerPlayer player, BlockPos cell) {
		BlockPos from = player.blockPosition();
		if (!stepsWalked.containsKey(from)) return null;
		Set<BlockPos> reached = new HashSet<>(List.of(from));
		java.util.ArrayDeque<BlockPos> queue = new java.util.ArrayDeque<>(List.of(from));
		BlockPos best = null;
		double bestCost = Double.MAX_VALUE;
		Vec3 target = Vec3.atCenterOf(cell);
		while (!queue.isEmpty()) {
			BlockPos at = queue.poll();
			int side = sideOfFrame(at);
			// A step it took (wayWalked routes only between those), still dry and on ground that holds.
			if (!at.equals(from) && side <= 0 && stepsWalked.containsKey(at) && !triedSpots.contains(at) && !TravelBuilder.lava(known(player, at))
					&& !TravelBuilder.lava(known(player, at.above())) && !hollow(player, at.below())) {
				double reach = Vec3.atBottomCenterOf(at).add(0.0D, player.getEyeHeight(), 0.0D).distanceTo(target);
				if (reach < player.blockInteractionRange() - 0.5D) {
					// In the frame's own plane beside it, the side columns hide the cells: the front first, as standFor does.
					double cost = reach + 0.25D * Math.sqrt(at.distSqr(from)) + (side == 0 ? 2.0D : 0.0D);
					if (cost < bestCost) { bestCost = cost; best = at; }
				}
			}
			for (BlockPos next : stepsWalked.getOrDefault(at, Set.of())) {
				if (reached.contains(next) || blocked(next) || blocked(next.above()) || solidNow(player, next) || solidNow(player, next.above())
						|| TravelBuilder.lava(known(player, next))) continue;
				reached.add(next);
				queue.add(next);
			}
		}
		return best;
	}

	private boolean stoodOn(ServerPlayer player, BlockPos at) {
		return stepsWalked.containsKey(at) && !solidNow(player, at) && !solidNow(player, at.above()) && !TravelBuilder.lava(known(player, at))
				&& !TravelBuilder.lava(known(player, at.above())) && !hollow(player, at.below());
	}

	private boolean solidNow(ServerPlayer player, BlockPos at) {
		BlockState state = known(player, at);
		return state != null && !state.getCollisionShape(player.level(), at).isEmpty();
	}

	/** Known open with nothing to stand on (a cell a carve dug out under a spot stood on before). */
	private boolean hollow(ServerPlayer player, BlockPos at) {
		BlockState state = known(player, at);
		return state != null && state.getCollisionShape(player.level(), at).isEmpty();
	}

	/** Blocks from the frame plane toward the mould (positive: behind it, where the mould hides the frame), 0 in the plane. */
	private int sideOfFrame(BlockPos at) {
		if (portal == null || back == null) return -1;
		BlockPos d = at.subtract(portal.origin());
		return d.getX() * back.getStepX() + d.getZ() * back.getStepZ();
	}

	/** One eased view step toward {@code point} (jumping when asked); true once the view is on it. */
	private boolean turn(ServerPlayer player, Vec3 point, boolean jump) {
		boolean on = ServerLookController.turnToward(player, point);
		// The jump key rides on the view the turn just set, so the input never pulls the view back.
		if (jump || lease != null) applyRaw(player, new AgentInputState(0, 0, jump, false, false, false, false, player.getYRot(), player.getXRot(),
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
		return on;
	}


	private int selectedSlot = -1;

	private int select(ServerPlayer player, int slot, long now) {
		if (slot < 0) return -1;
		if (slot >= 9) {
			int hotbar = player.getInventory().getSelectedSlot();
			if (dev.agaminggod.mineagen.server.runtime.AdvancedInteractionService.swapIntoHotbar(player, slot, hotbar) != null) return -1;
			slot = hotbar;
		}
		selectedSlot = slot;
		apply(player, new AgentInputStates.MotorTarget(player.getYRot(), player.getXRot(), false, false, false), true, now);
		return slot;
	}

	private void apply(ServerPlayer player, AgentInputStates.MotorTarget target, boolean sneak, long now) {
		if (motor == null) motor = AgentInputStates.MotorState.initial(player.getYRot(), player.getXRot());
		AgentInputStates.MotorStep step = AgentInputStates.stepMotor(motor, target, now);
		motor = step.state();
		int slot = selectedSlot >= 0 ? selectedSlot : player.getInventory().getSelectedSlot();
		applyRaw(player, new AgentInputState(step.forward(), step.strafe(), step.jump(), sneak, false, false, false,
				step.state().yaw(), step.state().pitch(), slot, InteractionHand.MAIN_HAND));
	}

	private void applyRaw(ServerPlayer player, AgentInputState state) {
		if (lease == null) {
			input = AgentInputRuntime.controller(player);
			lease = input.acquire(AgentInputRuntime.requireAgentId(player), InputOwner.NAVIGATION, 100);
		}
		input.apply(lease, state);
	}

	private void releaseInput() {
		motor = null;
		selectedSlot = -1;
		if (lease == null) return;
		try {
			input.release(lease);
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// A lifecycle clear may already have invalidated every lease.
		}
		lease = null;
		input = null;
	}


	private TickResult danger(ServerPlayer player) {
		float health = player.getHealth();
		if (health < lastHealth - 0.01F) {
			String source = player.getLastDamageSource() == null ? "unknown" : player.getLastDamageSource().getMsgId();
			return fail(player, "DAMAGE_TAKEN", String.format(Locale.ROOT, "Took %.1f damage (%s); health %.1f", lastHealth - health, source, health));
		}
		lastHealth = health;
		if (player.isInLava()) return fail(player, "IN_LAVA", "The body is in lava");
		if (player.isOnFire()) return fail(player, "ON_FIRE", "The body is burning");
		if (player.tickCount % 5 == 0) {
			List<Mob> threats = player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(HOSTILE_RANGE),
					mob -> player.distanceTo(mob) <= HOSTILE_RANGE && ThreatPerception.isSensedThreat(player, mob));
			if (!threats.isEmpty()) {
				Mob nearest = threats.stream().min(Comparator.comparingDouble(player::distanceTo)).orElseThrow();
				return fail(player, "HOSTILE_NEAR", String.format(Locale.ROOT, "%s %s %.1f blocks away", BuiltInRegistries.ENTITY_TYPE.getKey(nearest.getType()),
						nearest.getUUID(), player.distanceTo(nearest)));
			}
		}
		return null;
	}

	/**
	 * Why an explicitly named material may not build a pillar or bridge, or null: the same rule travel_to applies to its
	 * own bridge and pillar blocks ({@link TravelBuilder#buildingBlock}). Sand under a bridge falls away once walked on;
	 * planks over lava catch fire under the body.
	 */
	public static String materialRefusal(String itemId) {
		Item item = BuiltInRegistries.ITEM.getValue(net.minecraft.resources.Identifier.parse(itemId));
		if (item == Items.AIR || !(item instanceof BlockItem blockItem)) return itemId + " is not a block";
		net.minecraft.world.level.block.Block block = blockItem.getBlock();
		if (block instanceof net.minecraft.world.level.block.FallingBlock) return itemId + " falls when nothing holds it up";
		if (block.defaultBlockState().ignitedByLava()) return itemId + " catches fire beside lava or fire";
		if (!TravelBuilder.buildingBlock(block)) return itemId + " is not a plain full block to spend (valuable, harmful, holding contents or not solid)";
		return null;
	}

	private TickResult badMaterial(ServerPlayer player) {
		return fail(player, "INVALID_BUILD_MATERIAL", "materials " + material + " cannot build a " + structure.wire() + ": " + materialRefusal(material)
				+ "; name a plain full block such as cobblestone or dirt, or leave materials out to use the plain block carried most. Nothing was placed");
	}

	private TickResult short_(ServerPlayer player, String what) {
		return fail(player, "BUILD_SHORT", "Short of material: " + what);
	}

	private TickResult fail(ServerPlayer player, String code, String why) {
		if (casting && List.of("BUILD_NO_SITE", "BUILD_BLOCKED", "NO_STAND_SPOT").contains(code) && clearTicks(player, (ServerLevel) player.level(), BlockPos.ZERO, Blocks.STONE.defaultBlockState()) > MAX_CLEAR_TICKS) {
			why = "No pickaxe left that mines stone in time (the build's digging and clearing stall); make one, then build again. The build had stopped with "
					+ code + ": " + why;
			code = "NO_TOOL";
		}
		LOGGER.info("[build] {} {} in {}: {}", player.getGameProfile().name(), code, phase, why);
		return end(player, TickResult.failed(code, facts(player) + "; " + why, progress()));
	}

	private TickResult end(ServerPlayer player, TickResult result) {
		if (casting && !poolMemory.isEmpty()) LAST_POOL.put(player.getUUID(), new PoolNote(player.level().dimension(), player.level().getGameTime(), Set.copyOf(poolMemory),
				portal != null && back != null && castIndex > 0 && result.state() != State.SUCCEEDED ? new FrameNote(portal.origin(), back) : null));
		cancel(player);
		return result;
	}

	/** The lava sources a body's last cast build saw, for the next build call (one per body; 10 min). */
	private record PoolNote(ResourceKey<Level> dimension, long tick, Set<BlockPos> sources, FrameNote frame) { }
	private record FrameNote(BlockPos origin, Direction back) { }
	/** The part-cast frame of this body's last build (from {@link #LAST_POOL}), preferred as the site when it still fits. */
	private FrameNote lastFrame;
	private static final java.util.Map<java.util.UUID, PoolNote> LAST_POOL = new java.util.concurrent.ConcurrentHashMap<>();
	static final long POOL_NOTE_TICKS = 12_000L;

	/** Sources the last build saw within range of {@code around}, not since seen as anything but a lava source, nearest first. */
	private List<BlockPos> rememberedPool(ServerPlayer player, BlockPos around) {
		PoolNote note = LAST_POOL.get(player.getUUID());
		if (note == null || !note.dimension().equals(player.level().dimension()) || player.level().getGameTime() - note.tick() > POOL_NOTE_TICKS) return List.of();
		var seen = SeenTerrain.of(player);
		List<BlockPos> out = new ArrayList<>();
		for (BlockPos at : note.sources()) {
			if (Math.abs(at.getX() - around.getX()) > CAST_LAVA_RANGE || Math.abs(at.getZ() - around.getZ()) > CAST_LAVA_RANGE) continue;
			BlockState now = seen.known(at.getX(), at.getY(), at.getZ());
			if (now != null && !lavaSource(now)) continue;
			out.add(at);
			if (poolMemory.size() < 4096) poolMemory.add(at);
		}
		Vec3 eye = player.getEyePosition();
		out.sort(Comparator.comparingDouble(at -> Vec3.atCenterOf(at).distanceToSqr(eye)));
		return out;
	}

	private TickResult running() {
		return TickResult.running(progress());
	}

	private double progress() {
		if (structure == Structure.PILLAR) return Math.min(0.99D, placed / (double) Math.max(1, size));
		if (casting && order != null) return Math.min(0.99D, (index + 2.0D * castIndex) / (order.size() + 2.0D * castOrder.size() + 1.0D));
		if (order == null || order.isEmpty()) return 0.0D;
		return Math.min(0.99D, index / (double) order.size());
	}

	private String facts(ServerPlayer player) {
		StringBuilder text = new StringBuilder("build ").append(structure.wire());
		if (siteNote != null) text.append("; ").append(siteNote);
		// What was opened over the lava, carved and given up, so a hand-back says how far it got.
		for (String note : new String[] { uncoverNote, carveNote, rejectNote })
			if (note != null && (siteNote == null || !siteNote.contains(note))) text.append("; ").append(note);
		text.append("; placed ").append(placed).append(", cleared ").append(cleared);
		if (walks > 0) text.append(", walks ").append(walks);
		if (structure == Structure.NETHER_PORTAL) text.append("; carried obsidian ").append(carried(player, "minecraft:obsidian"));
		if (casting) text.append(String.format(Locale.ROOT, "; cast %d of 10 frame cells: water poured %d, lava poured %d, water scooped %d, lava taken %d, obsidian placed %d",
				Math.min(castIndex, 10), waterPours, lavaPours, scoops, fills, obsidianPlaced)).append(pouredWater == null ? "" : "; water source left at " + xyz(pouredWater));
		return text.toString();
	}


	private BlockState known(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		// Pool lava this build saw stays lava out of sight: a site is never judged next to it as unseen rock.
		if (state != null) return state;
		// So does water or lava a carve met behind the rock and plugged.
		if (poolMemory.contains(at)) return Blocks.LAVA.defaultBlockState();
		if (metFluid.containsKey(at)) return metFluid.get(at);
		return carveOpened.contains(at) && mould.isEmpty() ? Blocks.AIR.defaultBlockState() : null;
	}

	private boolean full(ServerPlayer player, BlockPos at) {
		BlockState state = known(player, at);
		return state != null && state.isCollisionShapeFullBlock(player.level(), at) && state.getFluidState().isEmpty();
	}

	private static boolean solid(ServerPlayer player, BlockPos cell) {
		return !player.level().getBlockState(cell).getCollisionShape(player.level(), cell).isEmpty();
	}

	private static String lighter(ServerPlayer player) {
		if (carried(player, "minecraft:flint_and_steel") > 0) return "minecraft:flint_and_steel";
		if (carried(player, "minecraft:fire_charge") > 0) return "minecraft:fire_charge";
		return null;
	}

	/** The most plentiful carried plain block (travel_to's bridge blocks); {@code scaffold} also takes a full falling block. */
	private static String plainBlock(ServerPlayer player, boolean scaffold) {
		String best = null;
		int bestCount = 0;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!(scaffold ? scaffoldBlock(stack) : TravelBuilder.buildingBlock(stack))) continue;
			String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			int count = carried(player, id);
			if (count > bestCount) { best = id; bestCount = count; }
		}
		return best;
	}

	/** A corner scaffold rests on the column below it: any plain full block, a falling one too. */
	static boolean scaffoldBlock(ItemStack stack) {
		if (TravelBuilder.buildingBlock(stack)) return true;
		return !stack.isEmpty() && stack.getItem() instanceof BlockItem item && item.getBlock() instanceof net.minecraft.world.level.block.FallingBlock
				&& item.getBlock().defaultBlockState().isCollisionShapeFullBlock(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
	}

	static int carried(ServerPlayer player, String itemId) {
		if (itemId == null) return 0;
		Item item = BuiltInRegistries.ITEM.getValue(net.minecraft.resources.Identifier.parse(itemId));
		if (item == Items.AIR) return 0;
		int count = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.is(item)) count += stack.getCount();
		}
		return count;
	}

	private static int slot(ServerPlayer player, String itemId) {
		if (itemId == null) return -1;
		Item item = BuiltInRegistries.ITEM.getValue(net.minecraft.resources.Identifier.parse(itemId));
		int selected = player.getInventory().getSelectedSlot();
		if (player.getInventory().getItem(selected).is(item)) return selected;
		for (int slot = 0; slot < 36; slot++) if (player.getInventory().getItem(slot).is(item)) return slot;
		return -1;
	}

	private String lastWalk() {
		return lastWalkFailure == null ? "" : "; last walk: " + lastWalkFailure;
	}

	private String axisName() {
		return portal == null ? "?" : portal.axis() == Direction.Axis.Z ? "z" : "x";
	}

	private static String describe(BlockState state) {
		return state == null ? "an unseen cell" : BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
	}

	private static String xyz(BlockPos at) {
		return at.getX() + "," + at.getY() + "," + at.getZ();
	}
}
