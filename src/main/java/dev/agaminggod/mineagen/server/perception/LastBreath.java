package dev.agaminggod.mineagen.server.perception;

import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;

/**
 * Where the eyes last breathed and the eye cells the body has swum through under water since: a diver's way back to
 * air. The seen-air search reaches 8 blocks across and seen cells fade, so a body that swam further along a flooded
 * tunnel into a sealed pocket knows of no air at all, though it came from some; a player swims back the way they came.
 * The trail is the body's own movement, so it needs no sight: it starts again at each breath, cuts a loop when the
 * body swims back over its own track, and is dropped when the body jumps further than one tick's swim (a teleport),
 * dies, changes dimension, or has swum further than any breath lasts.
 */
public final class LastBreath {
	/** Eye cells kept since the breath: past this the way back is longer than a full breath and no help. */
	static final int MAX_TRAIL = 64;
	/** One tick's move between eye cells (a diagonal swim changes all three); more is a teleport, not a swim. */
	static final int MAX_STEP = 3;
	private static final Map<UUID, LastBreath> PLAYERS = new HashMap<>();
	private final List<BlockPos> trail = new ArrayList<>();
	private String dimension;

	LastBreath() {
	}

	public static void register() {
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerTickEvents.END_SERVER_TICK.register(server -> {
			for (ServerPlayer player : server.getPlayerList().getPlayers()) PLAYERS.computeIfAbsent(player.getUUID(), id -> new LastBreath()).observe(player);
		});
		net.fabricmc.fabric.api.event.lifecycle.v1.ServerLifecycleEvents.SERVER_STOPPING.register(server -> PLAYERS.clear());
	}

	/**
	 * The eye cells from the eye's own cell back to the cell it last breathed in (that cell last), or an empty list when
	 * the eyes are in air or the way back is not known.
	 */
	public static List<BlockPos> wayBack(ServerPlayer player) {
		LastBreath memory = PLAYERS.get(player.getUUID());
		if (memory == null || !player.isUnderWater()) return List.of();
		return memory.wayBack(BlockPos.containing(player.getEyePosition()), player.level().dimension().identifier().toString());
	}

	/**
	 * Drops the way back until the next breath: a swim back that stalled (gravel fell into the passage, a mob blocks it)
	 * would only be chosen again by the next firing, while the duck-out or the rise beside the ceiling is never tried.
	 */
	public static void forget(ServerPlayer player) {
		LastBreath memory = PLAYERS.get(player.getUUID());
		if (memory != null) memory.forget();
	}

	void forget() {
		trail.clear();
	}

	private void observe(ServerPlayer player) {
		if (!player.isAlive()) { trail.clear(); return; }
		step(BlockPos.containing(player.getEyePosition()), player.isUnderWater(), player.level().dimension().identifier().toString());
	}

	/** One tick's sample: the eye cell, whether the eyes are under water, and the dimension. */
	void step(BlockPos eye, boolean underWater, String dimensionId) {
		if (!dimensionId.equals(dimension)) { trail.clear(); dimension = dimensionId; }
		if (!underWater) { trail.clear(); trail.add(eye.immutable()); return; }
		if (trail.isEmpty()) return;
		BlockPos last = trail.get(trail.size() - 1);
		if (last.equals(eye)) return;
		if (last.distManhattan(eye) > MAX_STEP) { trail.clear(); return; }
		int earlier = trail.indexOf(eye);
		if (earlier >= 0) { trail.subList(earlier + 1, trail.size()).clear(); return; }
		trail.add(eye.immutable());
		if (trail.size() > MAX_TRAIL) trail.clear();
	}

	List<BlockPos> wayBack(BlockPos eye, String dimensionId) {
		if (trail.size() < 2 || !dimensionId.equals(dimension) || !trail.get(trail.size() - 1).equals(eye)) return List.of();
		List<BlockPos> back = new ArrayList<>(trail);
		java.util.Collections.reverse(back);
		return List.copyOf(back);
	}
}
