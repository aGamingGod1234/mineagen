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
	static final int MAX_FAILED_WALKS = 3;
	static final long WALK_MS = 30_000L;
	static final double ARRIVE = 3.0D;
	private static final int HEADINGS = 16;
	private static final int SCAN_UP = 6;
	private static final int SCAN_DOWN = 8;

	/** What a quiet spell leads to. */
	enum Quiet { WAIT, RELOCATE }

	private final Vec3 start;
	private final List<Vec3> searched = new ArrayList<>();
	private final List<Vec3> refused = new ArrayList<>();
	private ServerNavigationController walk;
	private Vec3 walkGoal;
	private String walkVia;
	private long lastWalkTick;
	private int relocations;
	private int arrivals;
	private int failedInRow;
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
		return player.level().getBiome(player.blockPosition()).unwrapKey().map(key -> key.identifier().toString()).orElse(null);
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

	static boolean unreachable(int failedInRow) {
		return failedInRow >= MAX_FAILED_WALKS;
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

	/** Seen warped nylium with two seen free cells above it, on rings 16, 24 and 32 blocks out, as standing points. */
	static List<Vec3> seenFloors(ServerPlayer player) {
		List<Vec3> out = new ArrayList<>();
		var seen = SeenTerrain.of(player);
		BlockPos feet = player.blockPosition();
		for (double ring = STEP_MIN; ring <= STEP_MAX; ring += 8.0D) {
			for (int heading = 0; heading < HEADINGS; heading++) {
				double angle = heading * Math.PI * 2.0D / HEADINGS;
				int x = feet.getX() + (int) Math.round(-Math.sin(angle) * ring), z = feet.getZ() + (int) Math.round(Math.cos(angle) * ring);
				for (int y = feet.getY() + SCAN_UP; y >= feet.getY() - SCAN_DOWN; y--) {
					BlockState ground = seen.known(x, y, z);
					if (ground == null || !"minecraft:warped_nylium".equals(BuiltInRegistries.BLOCK.getKey(ground.getBlock()).toString())) continue;
					BlockState feetCell = seen.known(x, y + 1, z), headCell = seen.known(x, y + 2, z);
					if (feetCell != null && headCell != null && feetCell.getCollisionShape(player.level(), new BlockPos(x, y + 1, z)).isEmpty()
							&& headCell.getCollisionShape(player.level(), new BlockPos(x, y + 2, z)).isEmpty() && feetCell.getFluidState().isEmpty())
						out.add(new Vec3(x + 0.5D, y + 1, z + 0.5D));
					break;
				}
			}
		}
		return out;
	}

	/** Starts a relocation walk toward the next destination; false when there is none (the forest is used up from here). */
	boolean startWalk(ServerPlayer player, Vec3 outsideSighting, long now) {
		Vec3 goal = choose(player.position(), start, searched, refused, outsideSighting, seenFloors(player));
		if (goal == null) return false;
		cancel(player);
		walkGoal = goal;
		walkVia = goal == outsideSighting ? "an enderman seen there" : "seen forest floor";
		walk = new ServerNavigationController(goal, ARRIVE, false, now, WALK_MS, true);
		relocations++;
		return true;
	}

	boolean walking() {
		return walk != null;
	}

	Vec3 goal() {
		return walkGoal;
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
			walk = new ServerNavigationController(walkGoal, ARRIVE, false, now, WALK_MS, true);
		}
		lastWalkTick = gameTick;
		ServerController.TickResult result = walk.tick(player, now);
		if (result.state() == ServerController.State.RUNNING) return ServerController.State.RUNNING;
		walk.cancel(player);
		walk = null;
		if (result.state() == ServerController.State.SUCCEEDED) {
			arrivals++;
			failedInRow = 0;
			searched.add(walkGoal);
			return ServerController.State.SUCCEEDED;
		}
		failedInRow++;
		refused.add(walkGoal);
		lastFailure = result.reasonCode();
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

	int failedInRow() {
		return failedInRow;
	}

	String unreachableText(boolean nowhere) {
		return nowhere
				? String.format(Locale.ROOT, "No seen warped-forest floor left 16-32 blocks away on new ground within %.0f blocks of the start (%d relocations, %d arrived); the forest here is searched or out of sight",
						FOREST_RANGE, relocations, arrivals)
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
