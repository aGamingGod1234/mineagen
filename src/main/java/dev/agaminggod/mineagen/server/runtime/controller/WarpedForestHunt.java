package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.server.perception.SeenTerrain;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * An enderman count fight that starts inside a warped forest keeps hunting there as a player does: it never hands back
 * for a quiet area. After {@link #QUIET_MS} with no enderman sensed (or a look around that found the area clear) it
 * walks on, first to an enderman last seen outside the area, else to warped-forest floor it has seen 16-32 blocks away on
 * ground not yet searched, and hunts there. It hands back only for the count, the time cap, danger, health, a cancel, or
 * when it cannot get anywhere ({@link #MAX_FAILED_WALKS} walks in a row that did not arrive, or no floor left to try):
 * FOREST_UNREACHABLE. roof:true is deferred to the first contact with a calm enderman (a shelter waits where endermen
 * are); after a quiet spell the body leaves that roof and may build another at the next contact.
 *
 * <p>Destinations come from the body's own seen terrain ({@link SeenTerrain}) and sightings, never from unseen world data.
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
	/** Every compass heading from one spot: a lava-sea shore blocks most of them (live round 4: 3 NO_ROUTE in 14 s). */
	static final int MAX_FAILED_WALKS = 8;
	/** Failed walks retried at once; after these the body looks around through a quiet spell first (more ground seen). */
	static final int QUICK_RETRIES = 3;
	/** Quiet spells in a row whose scan found no destination before the forest counts as used up (seen terrain fades in 10 s). */
	static final int MAX_EMPTY_SCANS = 3;
	/** Shelters one call may build: each costs a shelter's blocks and a build's time, so contacts after these fight in the open. */
	static final int MAX_ROOFS = 3;
	static final long WALK_MS = 30_000L;
	static final double ARRIVE = 3.0D;
	private static final int HEADINGS = 16;
	private static final int SCAN_UP = 6;
	private static final int SCAN_DOWN = 8;
	/** Heading walks: 8 compass headings this far out, ended where the body gets to (height unknown until it is there). */
	static final double HEADING_STEP = 20.0D;
	/** A walk that moved at least this far counts as arrived where it stopped. */
	static final double MOVED_ENOUGH = 8.0D;
	/** How often (game ticks) the body reads the rings in its view while it hunts. */
	static final long LOOK_TICKS = 10L;
	private static final int MAX_FLOORS = 256;

	/** What a quiet spell leads to. */
	enum Quiet { WAIT, RELOCATE }

	private final Vec3 start;
	private final List<Vec3> searched = new ArrayList<>();
	private final List<Vec3> refused = new ArrayList<>();
	/** Standing points seen while hunting (look), and their columns, for the call. */
	private final List<Vec3> floors = new ArrayList<>();
	private final java.util.Set<Long> floorColumns = new java.util.HashSet<>();
	/** Diagnostics: columns read in view, seen ground found, free cells above not seen, ground outside the forest. */
	private final int[] looked = new int[4];
	private int looks;
	private ServerController walk;
	private java.util.function.BiPredicate<ServerPlayer, BlockPos> mayModify;
	private Vec3 walkFrom;
	/** After a walk that ended outside the forest: the last searched spot inside it, walked to next. */
	private Vec3 backTo;
	private Vec3 walkGoal;
	private String walkVia;
	private long lastWalkTick;
	private int relocations;
	private int arrivals;
	private int failedInRow;
	private int emptyScans;
	private int roofsLeft;
	private String lastFailure;

	WarpedForestHunt(Vec3 start) {
		this.start = start;
		this.searched.add(start);
	}

	/** Forest mode: endermen, a body free to move, standing in a warped forest when the call starts. */
	static boolean applies(boolean enderman, boolean mayMove, boolean sneak, String biomeAtFeet) {
		return enderman && mayMove && !sneak && BIOME.equals(biomeAtFeet);
	}

	static String biomeAt(ServerPlayer player) {
		return biomeAt(player, player.blockPosition());
	}

	/** A quiet spell: no enderman sensed for QUIET_MS, or the area cleared after a look around. */
	static Quiet quiet(long elapsedMs, long lastTargetMs, boolean areaCleared) {
		return areaCleared || elapsedMs - lastTargetMs >= QUIET_MS ? Quiet.RELOCATE : Quiet.WAIT;
	}

	/**
	 * roof:true in forest mode: build the shelter only on contact with a calm enderman (an angry one is fought on open
	 * ground, there is no time to build), with the roof still wanted (blocks have not run out), and none built or building.
	 */
	static boolean roofOnContact(boolean roofWanted, boolean roofed, boolean building, boolean targetSensed, boolean targetAngry) {
		return roofWanted && !roofed && !building && targetSensed && !targetAngry;
	}

	/** In forest mode a shelter short of blocks drops the roof for the call; outside it K11's stop stands. */
	static boolean dropsRoof(boolean forest, String code) {
		return forest && "ROOF_BLOCKS_MISSING".equals(code);
	}

	/** After a failed walk: try the next destination now, or look around through a quiet spell first. */
	static boolean retryNow(int failedInRow) {
		return failedInRow < QUICK_RETRIES;
	}

	static boolean unreachable(int failedInRow) {
		return failedInRow >= MAX_FAILED_WALKS;
	}

	static boolean nowhereLeft(int emptyScans) {
		return emptyScans >= MAX_EMPTY_SCANS;
	}

	/** roof:true builds again on contact only while the call has built fewer than MAX_ROOFS. */
	static boolean mayBuildAgain(int roofBuilds) {
		return roofBuilds < MAX_ROOFS;
	}

	/**
	 * The next destination: an enderman seen outside the area when it is new ground within range, else the nearest seen
	 * floor 16-32 blocks away that is new ground within range, else null (nowhere left).
	 */
	static Vec3 choose(Vec3 from, Vec3 start, List<Vec3> searched, List<Vec3> refused, Vec3 outsideSighting, List<Vec3> floors) {
		if (outsideSighting != null && fresh(outsideSighting, start, searched, refused, ARRIVE)) return outsideSighting;
		Vec3 best = null;
		double bestDistance = Double.MAX_VALUE;
		for (Vec3 floor : floors) {
			double flat = flat(from, floor);
			if (flat < STEP_MIN - 0.5D || flat > STEP_MAX + 0.5D || !fresh(floor, start, searched, refused, NEW_GROUND)) continue;
			// Least walked first: the floor farthest from every searched centre (in 8-block bands), then the nearest.
			double away = Double.MAX_VALUE;
			for (Vec3 spot : searched) away = Math.min(away, flat(spot, floor));
			double score = -Math.floor(away / 8.0D) * 1_000.0D + flat;
			if (score < bestDistance) { bestDistance = score; best = floor; }
		}
		return best;
	}

	private static boolean fresh(Vec3 at, Vec3 start, List<Vec3> searched, List<Vec3> refused, double apart) {
		if (flat(at, start) > FOREST_RANGE) return false;
		for (Vec3 spot : searched) if (flat(spot, at) < apart) return false;
		for (Vec3 spot : refused) if (flat(spot, at) < NEW_GROUND / 2.0D) return false;
		return true;
	}

	private static double flat(Vec3 a, Vec3 b) {
		return Math.hypot(a.x - b.x, a.z - b.z);
	}

	/**
	 * What the eye sees now of standing points on rings 16, 24 and 32 blocks out, kept for the call: a seen block with a
	 * full top face in the warped forest (its teal nylium and fungi show it) and two seen free cells above. Seen terrain is
	 * remembered only for cells read while in view, so the body reads the rings in its view cone as it looks around
	 * (every LOOK_TICKS), not once when it decides.
	 */
	void look(ServerPlayer player) {
		looks++;
		var seen = SeenTerrain.of(player);
		BlockPos feet = player.blockPosition();
		Vec3 view = player.getViewVector(1.0F);
		double viewFlat = Math.hypot(view.x, view.z);
		for (double ring = STEP_MIN; ring <= STEP_MAX; ring += 8.0D) {
			for (int heading = 0; heading < HEADINGS; heading++) {
				double angle = heading * Math.PI * 2.0D / HEADINGS;
				double dx = -Math.sin(angle), dz = Math.cos(angle);
				// Only the columns in front of the eye can be seen now (ObservationVisibility's cone is wider than this).
				if (viewFlat > 1.0E-3D && (dx * view.x + dz * view.z) / viewFlat < 0.3D) continue;
				int x = feet.getX() + (int) Math.round(dx * ring), z = feet.getZ() + (int) Math.round(dz * ring);
				looked[0]++;
				long column = BlockPos.asLong(x, 0, z);
				if (floorColumns.contains(column)) continue;
				for (int y = feet.getY() + SCAN_UP; y >= feet.getY() - SCAN_DOWN; y--) {
					BlockPos at = new BlockPos(x, y, z);
					BlockState ground = seen.known(x, y, z);
					if (ground == null || ground.getCollisionShape(player.level(), at).isEmpty()) continue;
					looked[1]++;
					BlockState feetCell = seen.known(x, y + 1, z), headCell = seen.known(x, y + 2, z);
					if (feetCell == null || headCell == null) looked[2]++;
					else if (!BIOME.equals(biomeAt(player, at.above()))) looked[3]++;
					if (feetCell != null && headCell != null && ground.isFaceSturdy(player.level(), at, net.minecraft.core.Direction.UP)
							&& feetCell.getCollisionShape(player.level(), at.above()).isEmpty() && feetCell.getFluidState().isEmpty()
							&& headCell.getCollisionShape(player.level(), at.above(2)).isEmpty() && headCell.getFluidState().isEmpty()
							&& BIOME.equals(biomeAt(player, at.above()))) {
						floorColumns.add(column);
						floors.add(new Vec3(x + 0.5D, y + 1, z + 0.5D));
						if (floors.size() > MAX_FLOORS) floors.remove(0);
					}
					break;
				}
			}
		}
	}

	static String biomeAt(ServerPlayer player, BlockPos at) {
		return player.level().getBiome(at).unwrapKey().map(key -> key.identifier().toString()).orElse(null);
	}

	/** Starts a relocation walk toward the next destination; false when there is none (the forest is used up from here). */
	boolean startWalk(ServerPlayer player, Vec3 outsideSighting, long now) {
		Vec3 goal;
		if (backTo != null) {
			goal = backTo;
			backTo = null;
			walkVia = "back into the forest";
		} else {
			look(player);
			List<Vec3> candidates = new ArrayList<>(floors);
			candidates.addAll(headingPoints(player.position()));
			goal = choose(player.position(), start, searched, refused, outsideSighting, candidates);
			if (goal == null) { emptyScans++; return false; }
			walkVia = goal == outsideSighting ? "an enderman seen there" : floors.contains(goal) ? "seen forest floor" : "a heading not searched yet";
		}
		emptyScans = 0;
		cancel(player);
		walkGoal = goal;
		walkFrom = player.position();
		walk = travel(goal, now);
		relocations++;
		return true;
	}

	/** The 8 compass points HEADING_STEP out: where a player walks on in a forest when nothing is in sight. */
	static List<Vec3> headingPoints(Vec3 from) {
		List<Vec3> out = new ArrayList<>();
		for (int heading = 0; heading < 8; heading++) {
			double angle = heading * Math.PI / 4.0D;
			out.add(new Vec3(from.x - Math.sin(angle) * HEADING_STEP, from.y, from.z + Math.cos(angle) * HEADING_STEP));
		}
		return out;
	}

	void mayModify(java.util.function.BiPredicate<ServerPlayer, BlockPos> mayModify) {
		this.mayModify = mayModify;
	}

	/** Lava-aware travel to the point's column at whatever height the ground there is; no building. */
	private ServerController travel(Vec3 goal, long now) {
		return new ServerTravelController(goal.x, Double.NaN, goal.z, ARRIVE, WALK_MS, false, null, null,
				mayModify == null ? (body, at) -> false : mayModify, now);
	}

	/** A walk ends arrived when it got there or moved MOVED_ENOUGH; it counts only if the body is still in the forest. */
	static boolean arrived(boolean succeeded, double moved, boolean inForest) {
		return (succeeded || moved >= MOVED_ENOUGH) && inForest;
	}

	boolean walking() {
		return walk != null;
	}

	Vec3 goal() {
		return walkGoal;
	}

	private Vec3 arrivedAt;

	/** Where the last walk that arrived ended (the new centre of the area). */
	Vec3 arrivedAt() {
		return arrivedAt;
	}

	/**
	 * One tick of the relocation walk. RUNNING while it walks; SUCCEEDED on arrival (the caller moves the area there);
	 * FAILED when it did not arrive (the destination is not tried again).
	 */
	ServerController.State tick(ServerPlayer player, long now) {
		long gameTick = player.level().getGameTime();
		if (EndermanHuntLeads.walkLeftUnticked(lastWalkTick, gameTick)) {
			// Something else held the body (a collect or guard): plan the same walk afresh, as the lead walks do.
			walk.cancel(player);
			walk = travel(walkGoal, now);
		}
		lastWalkTick = gameTick;
		ServerController.TickResult result = walk.tick(player, now);
		if (result.state() == ServerController.State.RUNNING) return ServerController.State.RUNNING;
		walk.cancel(player);
		walk = null;
		Vec3 here = player.position();
		boolean inForest = BIOME.equals(biomeAt(player));
		if (arrived(result.state() == ServerController.State.SUCCEEDED, flat(walkFrom, here), inForest)) {
			arrivals++;
			failedInRow = 0;
			searched.add(here);
			arrivedAt = here;
			return ServerController.State.SUCCEEDED;
		}
		failedInRow++;
		refused.add(walkGoal);
		lastFailure = inForest ? result.reasonCode() : "left the forest at " + BlockPos.containing(here).toShortString();
		if (!inForest) backTo = searched.get(searched.size() - 1);
		return ServerController.State.FAILED;
	}

	/** Ends a walk the target interrupted (an enderman sensed on the way); the ground it reached counts as searched. */
	void interrupted(ServerPlayer player) {
		if (walk == null) return;
		cancel(player);
		searched.add(player.position());
	}

	void cancel(ServerPlayer player) {
		if (walk != null) { walk.cancel(player); walk = null; }
	}

	void leftRoof() {
		roofsLeft++;
	}

	/** What the looks so far read, for an empty scan's note. */
	String lookCounts() {
		return String.format(Locale.ROOT, "%d looks: %d columns in view, %d seen ground, %d with the cells above unseen, %d outside the forest, %d standing points kept",
				looks, looked[0], looked[1], looked[2], looked[3], floors.size());
	}

	int emptyScans() {
		return emptyScans;
	}

	String lastFailure() {
		return lastFailure;
	}

	int failedInRow() {
		return failedInRow;
	}

	String unreachableText(boolean nowhere) {
		return nowhere
				? String.format(Locale.ROOT, "No seen warped-forest floor left 16-32 blocks away on new ground within %.0f blocks of the start after %d looks around (%d relocations, %d arrived); the forest here is searched or out of sight",
						FOREST_RANGE, emptyScans, relocations, arrivals)
				: String.format(Locale.ROOT, "%d relocation walks in a row did not arrive (last %s; %d relocations, %d arrived)",
						failedInRow, lastFailure, relocations, arrivals);
	}

	/** The receipt's forest line. */
	String summary() {
		return String.format(Locale.ROOT, "forest: %d relocation%s (%d arrived)%s", relocations, relocations == 1 ? "" : "s", arrivals,
				roofsLeft > 0 ? ", left " + roofsLeft + " roof" + (roofsLeft == 1 ? "" : "s") : "");
	}

	String walkVia() {
		return walkVia;
	}
}
