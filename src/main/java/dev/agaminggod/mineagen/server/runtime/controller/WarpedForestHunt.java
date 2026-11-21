package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.server.perception.SeenTerrain;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.BiPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * An enderman pearl hunt that starts inside a warped forest keeps hunting there as a player does: it never hands back for
 * a quiet area. After {@link #QUIET_MS} with no enderman sensed (30 s while under a roof, as K11) it walks on: to an
 * enderman last seen outside the area, else to a standing point it saw in the forest, else 20 blocks along a compass
 * heading not tried yet from here. It hands back only for the count, the time cap, danger, health, a cancel, or when
 * it cannot get on: every heading from here failed (FOREST_UNREACHABLE) or nothing new is left to walk to
 * (FOREST_SEARCHED_OUT). A walk ends the tick the body leaves the forest, and a safety stop of the walk (damage, lava,
 * a hostile) is never counted as ground gained. roof:true is deferred to contact with a calm enderman (ForestRoof).
 *
 * <p>Destinations come from the body's own seen terrain ({@link SeenTerrain}) and sightings, and compass headings; the
 * biome is read only where the body stands or at a seen cell (its teal nylium and fungi show it).
 */
final class WarpedForestHunt {
	static final String BIOME = "minecraft:warped_forest";
	static final long QUIET_MS = 12_000L;
	static final double STEP_MIN = 16.0D;
	static final double STEP_MAX = 32.0D;
	/** A destination at least this far from every centre already searched. */
	static final double NEW_GROUND = 16.0D;
	/** Destinations stay within this many blocks of where the call started. */
	static final double FOREST_RANGE = 96.0D;
	static final int HEADING_COUNT = 8;
	/** Failed walks retried at once; after these the body looks around through a quiet spell first (more ground seen). */
	static final int QUICK_RETRIES = 3;
	/** Quiet spells in a row with nothing new to walk to before the forest here counts as searched out. */
	static final int MAX_EMPTY_SCANS = 3;
	static final long WALK_MS = 30_000L;
	static final double ARRIVE = 3.0D;
	/** Heading walks: compass headings this far out, ended where the body gets to (height unknown until it is there). */
	static final double HEADING_STEP = 20.0D;
	/**
	 * An enderman seen farther than this above or below the feet stands on a ledge or across a drop: a player picks one
	 * on open ground instead. Smoke rooms, seed 987654321: walks to ones seen 6 and 12 blocks off the feet led down into
	 * a lava basin in 3 of 3 runs.
	 */
	static final double LEDGE_DY = 4.0D;
	/** Seen lava this close to the body (blocks, each axis) ends a walk: that way is lava, as a player steps back from it. */
	static final int LAVA_NEAR = 2;
	/** A route failure that still moved at least this far counts as arrived where it stopped. */
	static final double MOVED_ENOUGH = 8.0D;
	private static final int RINGS_HEADINGS = 16;
	private static final int SCAN_UP = 6;
	private static final int SCAN_DOWN = 8;
	private static final int MAX_FLOORS = 256;
	/** A walk's own stops that are the body's safety, not the route: never credited as ground gained. */
	static final Set<String> SAFETY_STOPS = Set.of("TRAVEL_DAMAGED", "NAVIGATION_DAMAGED", "DAMAGE_TAKEN", "LOW_HEALTH", "LOW_HEALTH_BAILOUT",
			"HOSTILE_NEAR", "IN_LAVA", "LAVA_AHEAD", "LAVA_BEHIND", "LAVA_INCOMING", "LAVA_FLOW", "LAVA_OPENED", "ON_FIRE", "BURNING",
			"FALLING_BLOCKS", "VOID_EDGE", "AIR_RESERVE_REACHED", "AGENT_DEAD", "ACTION_CANCELLED");
	/** Of those, the ones that say the ground that way is lava: the heading is blocked. */
	static final Set<String> LAVA_STOPS = Set.of("IN_LAVA", "LAVA_AHEAD", "LAVA_BEHIND", "LAVA_INCOMING", "LAVA_FLOW", "LAVA_OPENED");

	/** Test seam: the biome id at a cell (the level's biome by default). */
	interface Probe { String biome(ServerPlayer player, BlockPos at); }

	/** Test seam: the relocation walk (lava-aware travel to the column, any height, no building, by default). */
	interface Walks { ServerController walk(Vec3 goal, BiPredicate<ServerPlayer, BlockPos> mayModify, long now); }

	static Probe probe = (player, at) -> player.level().getBiome(at).unwrapKey().map(key -> key.identifier().toString()).orElse(null);
	static Walks walks = (goal, mayModify, now) -> new ServerTravelController(goal.x, Double.NaN, goal.z, ARRIVE, WALK_MS, false, null, null, mayModify, now);

	/** What a quiet spell leads to. */
	enum Quiet { WAIT, RELOCATE }

	/** A relocation walk's tick. */
	enum Walk { RUNNING, ARRIVED, FAILED, STOPPED }

	private enum Kind { SIGHTING, FLOOR, HEADING, BACK }

	private final Vec3 start;
	private final List<Vec3> searched = new ArrayList<>();
	private final List<Vec3> refused = new ArrayList<>();
	/** Standing points seen in the forest at decision time, and their columns, for the call. */
	private final List<Vec3> floors = new ArrayList<>();
	private final Set<Long> floorColumns = new HashSet<>();
	/** Compass headings whose walk failed from the current centre (reset on arrival). */
	private final Set<Integer> headingsFailed = new HashSet<>();
	private final List<Vec3> backFailed = new ArrayList<>();
	private ServerController walk;
	private BiPredicate<ServerPlayer, BlockPos> mayModify = (body, at) -> false;
	private Vec3 walkFrom;
	private Vec3 walkGoal;
	private Kind walkKind;
	private int walkHeading = -1;
	private String walkVia;
	private long lastWalkTick = Long.MIN_VALUE;
	/** The last footing the body stood on in the forest: where a walk that left the forest returns to. */
	private Vec3 lastInForest;
	private Vec3 backTo;
	private Vec3 arrivedAt;
	private int relocations;
	private int arrivals;
	private int stops;
	private int failedInRow;
	private int emptyScans;
	private int roofsLeft;
	private String lastFailure;

	WarpedForestHunt(Vec3 start) {
		this.start = start;
		this.searched.add(start);
		this.lastInForest = start;
	}

	/** Forest mode: an enderman pearl hunt, a body free to move, standing in a warped forest when the call starts. */
	static boolean applies(boolean enderman, boolean pearls, boolean mayMove, boolean sneak, String biomeAtFeet) {
		return enderman && pearls && mayMove && !sneak && BIOME.equals(biomeAtFeet);
	}

	static String biomeAt(ServerPlayer player) {
		return probe.biome(player, player.blockPosition());
	}

	static boolean inForest(ServerPlayer player) {
		return BIOME.equals(biomeAt(player));
	}

	/** A quiet spell: no enderman sensed for QUIET_MS (K11's 30 s while roofed), or the area cleared after a look around. */
	static Quiet quiet(long elapsedMs, long lastTargetMs, boolean areaCleared, boolean roofed) {
		if (areaCleared && !roofed) return Quiet.RELOCATE;
		return elapsedMs - lastTargetMs >= (roofed ? ServerFightUntilController.NO_TARGET_MS : QUIET_MS) ? Quiet.RELOCATE : Quiet.WAIT;
	}

	/** In forest mode a shelter short of blocks drops the roof for the call; outside it K11's stop stands. */
	static boolean dropsRoof(boolean forest, String code) {
		return forest && "ROOF_BLOCKS_MISSING".equals(code);
	}

	/** After a failed walk: try the next destination now, or look around through a quiet spell first. */
	static boolean retryNow(int failedInRow) {
		return failedInRow < QUICK_RETRIES;
	}

	/** Walks of any kind (headings, seen floors, sightings, returns) that may fail in a row before the hunt hands back. */
	static final int MAX_FAILED_WALKS = 2 * HEADING_COUNT;

	/** Every compass heading from the current centre failed, or MAX_FAILED_WALKS walks in a row did: FOREST_UNREACHABLE. */
	static boolean unreachable(int headingsFailed, int failedInRow) {
		return headingsFailed >= HEADING_COUNT || failedInRow >= MAX_FAILED_WALKS;
	}

	/** Nothing new to walk to through MAX_EMPTY_SCANS quiet spells: FOREST_SEARCHED_OUT. */
	static boolean searchedOut(int emptyScans) {
		return emptyScans >= MAX_EMPTY_SCANS;
	}

	static boolean safetyStop(String code) {
		return code != null && SAFETY_STOPS.contains(code);
	}

	/** A walk's end counts as arrival when it got there, or (an ordinary route failure only) moved MOVED_ENOUGH, in the forest. */
	static boolean arrived(boolean succeeded, String code, double moved, boolean inForest) {
		if (!inForest || safetyStop(code)) return false;
		return succeeded || moved >= MOVED_ENOUGH;
	}

	/**
	 * The next destination: an enderman seen outside the area when it is new ground within range, else the best of the
	 * seen floors and untried heading points 16-32 blocks away on new ground within range (farthest from searched ground
	 * in 8-block bands, then nearest), else null.
	 */
	static Vec3 choose(Vec3 from, Vec3 start, List<Vec3> searched, List<Vec3> refused, Vec3 outsideSighting, List<Vec3> candidates) {
		if (outsideSighting != null && Math.abs(outsideSighting.y - from.y) <= LEDGE_DY && fresh(outsideSighting, start, searched, refused, ARRIVE))
			return outsideSighting;
		Vec3 best = null;
		double bestScore = Double.MAX_VALUE;
		for (Vec3 floor : candidates) {
			double flat = flat(from, floor);
			if (flat < STEP_MIN - 0.5D || flat > STEP_MAX + 0.5D || !fresh(floor, start, searched, refused, NEW_GROUND)) continue;
			double away = Double.MAX_VALUE;
			for (Vec3 spot : searched) away = Math.min(away, flat(spot, floor));
			double score = -Math.floor(away / 8.0D) * 1_000.0D + flat;
			if (score < bestScore) { bestScore = score; best = floor; }
		}
		return best;
	}

	/** Seen lava within LAVA_NEAR blocks of the feet (each axis, from two below the feet to two above the head's foot). */
	static boolean lavaNear(MinecraftNavigationWorld.StateRead seen, BlockPos feet) {
		for (int dx = -LAVA_NEAR; dx <= LAVA_NEAR; dx++)
			for (int dz = -LAVA_NEAR; dz <= LAVA_NEAR; dz++)
				for (int dy = -LAVA_NEAR; dy <= LAVA_NEAR; dy++)
					if (TravelBuilder.lava(seen.at(feet.getX() + dx, feet.getY() + dy, feet.getZ() + dz))) return true;
		return false;
	}

	private static boolean fresh(Vec3 at, Vec3 start, List<Vec3> searched, List<Vec3> refused, double apart) {
		if (flat(at, start) > FOREST_RANGE) return false;
		for (Vec3 spot : searched) if (flat(spot, at) < apart) return false;
		for (Vec3 spot : refused) if (flat(spot, at) < NEW_GROUND / 2.0D) return false;
		return true;
	}

	static double flat(Vec3 a, Vec3 b) {
		return Math.hypot(a.x - b.x, a.z - b.z);
	}

	/** The compass point HEADING_STEP out on heading index (0 south, clockwise in 45-degree steps). */
	static Vec3 headingPoint(Vec3 from, int heading) {
		double angle = heading * Math.PI * 2.0D / HEADING_COUNT;
		return new Vec3(from.x - Math.sin(angle) * HEADING_STEP, from.y, from.z + Math.cos(angle) * HEADING_STEP);
	}

	/**
	 * Standing points the eye sees now on rings 16, 24 and 32 blocks out, kept for the call: a seen block with a sturdy
	 * top in the warped forest and two seen free cells above. Read once at each decision, in the view cone the body has
	 * then; a fungus forest hides most of its floor, so heading walks carry the relocation when none is seen.
	 */
	void look(ServerPlayer player) {
		var seen = SeenTerrain.of(player);
		BlockPos feet = player.blockPosition();
		Vec3 view = player.getViewVector(1.0F);
		double viewFlat = Math.hypot(view.x, view.z);
		for (double ring = STEP_MIN; ring <= STEP_MAX; ring += 8.0D) {
			for (int heading = 0; heading < RINGS_HEADINGS; heading++) {
				double angle = heading * Math.PI * 2.0D / RINGS_HEADINGS;
				double dx = -Math.sin(angle), dz = Math.cos(angle);
				if (viewFlat > 1.0E-3D && (dx * view.x + dz * view.z) / viewFlat < 0.3D) continue;
				int x = feet.getX() + (int) Math.round(dx * ring), z = feet.getZ() + (int) Math.round(dz * ring);
				long column = BlockPos.asLong(x, 0, z);
				if (floorColumns.contains(column)) continue;
				for (int y = feet.getY() + SCAN_UP; y >= feet.getY() - SCAN_DOWN; y--) {
					BlockPos at = new BlockPos(x, y, z);
					BlockState ground = seen.known(x, y, z);
					if (ground == null || ground.getCollisionShape(player.level(), at).isEmpty()) continue;
					BlockState feetCell = seen.known(x, y + 1, z), headCell = seen.known(x, y + 2, z);
					if (feetCell != null && headCell != null && ground.isFaceSturdy(player.level(), at, net.minecraft.core.Direction.UP)
							&& feetCell.getCollisionShape(player.level(), at.above()).isEmpty() && feetCell.getFluidState().isEmpty()
							&& headCell.getCollisionShape(player.level(), at.above(2)).isEmpty() && headCell.getFluidState().isEmpty()
							&& BIOME.equals(probe.biome(player, at.above()))) {
						floorColumns.add(column);
						floors.add(new Vec3(x + 0.5D, y + 1, z + 0.5D));
						if (floors.size() > MAX_FLOORS) floors.remove(0);
					}
					break;
				}
			}
		}
	}

	void mayModify(BiPredicate<ServerPlayer, BlockPos> mayModify) {
		this.mayModify = mayModify;
	}

	/** Remembers the body's footing while it stands in the forest (the return point for a walk that leaves it). */
	void standing(ServerPlayer player) {
		if (player.onGround() && inForest(player)) lastInForest = player.position();
	}

	/** Starts a relocation walk toward the next destination; false when there is none (an empty scan). */
	boolean startWalk(ServerPlayer player, Vec3 outsideSighting, long now) {
		Vec3 goal;
		Kind kind;
		int heading = -1;
		if (backTo != null) {
			goal = backTo;
			backTo = null;
			kind = Kind.BACK;
		} else {
			look(player);
			List<Vec3> candidates = new ArrayList<>(floors);
			Vec3 here = player.position();
			List<Vec3> headings = new ArrayList<>();
			for (int index = 0; index < HEADING_COUNT; index++) headings.add(headingsFailed.contains(index) ? null : headingPoint(here, index));
			for (Vec3 point : headings) if (point != null) candidates.add(point);
			goal = choose(here, start, searched, refused, outsideSighting, candidates);
			if (goal == null) { emptyScans++; return false; }
			heading = headings.indexOf(goal);
			kind = goal == outsideSighting ? Kind.SIGHTING : heading >= 0 ? Kind.HEADING : Kind.FLOOR;
		}
		emptyScans = 0;
		cancel(player);
		walkGoal = goal;
		walkKind = kind;
		walkHeading = heading;
		walkVia = switch (kind) {
			case SIGHTING -> "an enderman seen there";
			case FLOOR -> "seen forest floor";
			case HEADING -> "a heading not tried yet";
			case BACK -> "back into the forest";
		};
		walkFrom = player.position();
		walk = walks.walk(goal, mayModify, now);
		lastWalkTick = Long.MIN_VALUE;
		relocations++;
		return true;
	}

	boolean walking() {
		return walk != null;
	}

	Vec3 goal() {
		return walkGoal;
	}

	/** Where the last walk that arrived ended (the new centre of the area). */
	Vec3 arrivedAt() {
		return arrivedAt;
	}

	/**
	 * One tick of the relocation walk. A body that has left the forest ends the walk that tick (FAILED, and the next walk
	 * goes back to its last forest footing). ARRIVED moves the area; STOPPED is a safety stop of the walk (the engine and
	 * the hazard checks take it from there); FAILED is a route that did not get there (that destination is not tried again).
	 */
	Walk tick(ServerPlayer player, long now) {
		if (!inForest(player)) {
			cancel(player);
			return leftForest(player);
		}
		standing(player);
		long gameTick = player.level().getGameTime();
		if (lastWalkTick != Long.MIN_VALUE && EndermanHuntLeads.walkLeftUnticked(lastWalkTick, gameTick)) {
			// Something else held the body (a collect or guard): plan the same walk afresh, as the lead walks do.
			walk.cancel(player);
			walk = walks.walk(walkGoal, mayModify, now);
		}
		lastWalkTick = gameTick;
		if (flat(walkFrom, player.position()) > LAVA_NEAR) {
			var seen = SeenTerrain.of(player);
			if (lavaNear(seen::known, player.blockPosition())) {
				// Lava beside the way: the walk stops before travel's own lava guard has to pull the body back out of a flow.
				cancel(player);
				lastFailure = "LAVA_NEAR at " + player.blockPosition().toShortString();
				stops++;
				refuse();
				return Walk.STOPPED;
			}
		}
		ServerController.TickResult result = walk.tick(player, now);
		if (result.state() == ServerController.State.RUNNING) return Walk.RUNNING;
		walk.cancel(player);
		walk = null;
		Vec3 here = player.position();
		String code = result.reasonCode();
		if (arrived(result.state() == ServerController.State.SUCCEEDED, code, flat(walkFrom, here), true)) {
			arrivals++;
			failedInRow = 0;
			headingsFailed.clear();
			searched.add(here);
			arrivedAt = here;
			return Walk.ARRIVED;
		}
		lastFailure = code;
		if (safetyStop(code)) {
			stops++;
			// Lava that way: the heading is blocked. Damage or a hostile says nothing about the ground.
			if (LAVA_STOPS.contains(code)) refuse();
			return Walk.STOPPED;
		}
		refuse();
		return Walk.FAILED;
	}

	private void refuse() {
		failedInRow++;
		refused.add(walkGoal);
		if (walkKind == Kind.HEADING && walkHeading >= 0) headingsFailed.add(walkHeading);
		if (walkKind == Kind.BACK) backFailed.add(walkGoal);
	}

	private Walk leftForest(ServerPlayer player) {
		lastFailure = "left the forest at " + BlockPos.containing(player.position()).toShortString();
		refuse();
		boolean triedBack = false;
		for (Vec3 spot : backFailed) if (flat(spot, lastInForest) < 2.0D) triedBack = true;
		backTo = triedBack ? null : lastInForest;
		return Walk.FAILED;
	}

	/**
	 * An enderman sensed on the way ends the walk; the ground reached is the new area (in the forest), or the walk back
	 * is next (outside it). Returns the new centre, or null when the body stands outside the forest.
	 */
	Vec3 interrupted(ServerPlayer player) {
		if (walk == null) return null;
		cancel(player);
		if (!inForest(player)) {
			backTo = lastInForest;
			return null;
		}
		Vec3 here = player.position();
		searched.add(here);
		headingsFailed.clear();
		return here;
	}

	void cancel(ServerPlayer player) {
		if (walk != null) { walk.cancel(player); walk = null; }
	}

	void leftRoof() {
		roofsLeft++;
	}

	int emptyScans() {
		return emptyScans;
	}

	int headingsFailed() {
		return headingsFailed.size();
	}

	String lastFailure() {
		return lastFailure;
	}

	int failedInRow() {
		return failedInRow;
	}

	String unreachableText() {
		return String.format(Locale.ROOT, "%d walks in a row did not arrive, %d of %d headings from %s (last %s; %d relocations, %d arrived)", failedInRow,
				headingsFailed.size(), HEADING_COUNT, BlockPos.containing(searched.get(searched.size() - 1)).toShortString(), lastFailure, relocations, arrivals);
	}

	String searchedOutText() {
		return String.format(Locale.ROOT, "nothing new to walk to within %.0f blocks of the start through %d quiet spells (%d relocations, %d arrived, %d spots searched)",
				FOREST_RANGE, emptyScans, relocations, arrivals, searched.size());
	}

	/** The receipt's forest line. */
	String summary() {
		return String.format(Locale.ROOT, "forest: %d relocation%s (%d arrived, %d stopped for safety)%s", relocations, relocations == 1 ? "" : "s", arrivals, stops,
				roofsLeft > 0 ? ", left " + roofsLeft + " roof" + (roofsLeft == 1 ? "" : "s") : "");
	}

	String walkVia() {
		return walkVia;
	}
}
