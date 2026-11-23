package dev.agaminggod.mineagen.server.runtime.reflex;

import dev.agaminggod.mineagen.server.perception.LastBreath;
import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import dev.agaminggod.mineagen.server.runtime.controller.SwimPlanning;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import java.util.List;
import java.util.function.Consumer;
import net.minecraft.core.BlockPos;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Mob;

/**
 * The reflex moves the escape body job runs as its own steps: swimming to the nearest seen air, and walking into cover
 * from shooters with the shield answering shots on the way. The same code the swim-up and cover reflexes fire, so the
 * job and the reflexes never disagree about where air or cover is.
 */
public final class EscapeMoves {
	private EscapeMoves() {
	}

	public enum Status { RUNNING, DONE, FAILED }

	public record Result(Status status, String detail) { }

	/** One move: applies this tick's input through {@code input} (at most once) and reports how it stands. */
	public interface Move {
		Result tick(ServerPlayer player, Consumer<AgentInputState> input);
	}

	/**
	 * Swim to the nearest breathable cell the player has seen; with none, back the way it swam to where it last breathed
	 * when the breath left covers it (LastBreath: a sealed pocket at the end of a flooded tunnel, past the seen-air
	 * search's reach); under a seen ceiling with neither, duck out beside it (the reflex's duck-out, travel's PEEK); else
	 * rise holding jump with the view tilted up.
	 */
	public static Move swimUp() {
		Move swim = adapt(new ReflexActions.SwimUp(), null);
		// The reflex's blind rise (no seen air) holds jump with no progress check; under a roof it would hold until the air
		// ran out. Here the eyes must rise or move across half a block in every 2 s (ducking out from under a ledge moves
		// across, not up), or the move hands the choice back.
		double[] mark = {Double.NaN, 0.0D, 0.0D};
		int[] ticks = {0};
		// Swimming back to the last breath can lead down: there a sink counts as way made too.
		boolean[] backing = {false};
		return (player, input) -> {
			double eye = player.getEyeY();
			if (Double.isNaN(mark[0])) { mark[0] = eye; mark[1] = player.getX(); mark[2] = player.getZ(); }
			if (++ticks[0] % BLIND_WINDOW_TICKS == 0) {
				if (!madeWay(backing[0] ? Math.abs(eye - mark[0]) : eye - mark[0], Math.hypot(player.getX() - mark[1], player.getZ() - mark[2])) && ReflexActions.airRoute(player) == null) {
					return new Result(Status.FAILED, "not getting toward air (no seen air route, under 0.5 blocks up or across in 2 s)");
				}
				mark[0] = eye; mark[1] = player.getX(); mark[2] = player.getZ();
			}
			// Back where it breathed (the breath cell can be on dry ground): done, not handed to the rising swim that never ran.
			if (backing[0] && !player.isUnderWater()) return new Result(Status.DONE, "back where it last breathed");
			// Once on its way back with no air seen, it keeps going: the breath estimate shrinks as fast as the planned swim
			// goes, so a slow turn would otherwise drop it to the blind rise into the tunnel's roof halfway.
			var back = wayBack(player, false, backing[0]);
			backing[0] = back != null;
			if (back != null) {
				input.accept(swimBack(player, back.path().get(1)));
				return new Result(Status.RUNNING, "swimming back to where it last breathed at " + back.x() + "," + back.openY() + "," + back.z()
						+ ", " + back.path().size() + " cells");
			}
			return swim.tick(player, input);
		};
	}

	/**
	 * One tick along the way back toward eye cell {@code next}: forward toward it, jump to rise to it, sneak to sink to it
	 * (the way back can lead down, out of a pocket the body rose into, which the swim to seen air never does), and neither
	 * when it is level: jump held there floats the body up off a tunnel's floor and into the rock over its mouth
	 * (sealed-pocket room: stuck at the mouth for all 3 swims of the first escape).
	 */
	static AgentInputState swimBack(ServerPlayer player, BlockPos next) {
		var eye = player.getEyePosition();
		double dx = next.getX() + 0.5D - eye.x, dz = next.getZ() + 0.5D - eye.z, dy = next.getY() + 0.5D - eye.y;
		boolean across = dx * dx + dz * dz > 0.04D;
		float heading = across ? net.minecraft.util.Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz))) : player.getYRot();
		float yaw = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnYaw(player.getYRot(), heading);
		float pitch = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnPitch(player.getXRot(), dy > 0.3D ? SwimPlanning.SURFACING_PITCH : dy < -0.3D ? 30.0F : 0.0F);
		float forward = across ? dev.agaminggod.mineagen.server.runtime.controller.CombatPlanning.alignedForward(1.0F,
				dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.shortestAngleDelta(yaw, heading)) : 0.0F;
		return new AgentInputState(forward, 0.0F, rises(dy), sinks(dy), false, false, false, yaw, pitch,
				player.getInventory().getSelectedSlot(), net.minecraft.world.InteractionHand.MAIN_HAND);
	}

	/** Eyes under water, the seen-air search done with no route, and the way back to the last breath within the breath left. */
	public static boolean knowsWayBack(ServerPlayer player) {
		return wayBack(player, true, false) != null;
	}

	/**
	 * A way back within the breath is known but the seen-air search is still running (it restarts as the eyes cross into
	 * a new cell and each second): the escape waits for its answer before choosing, or a restart mid-search reads as
	 * "air seen" and sends it to a bank it cannot reach.
	 */
	public static boolean awaitsAirSearch(ServerPlayer player) {
		if (!player.isUnderWater() || wayBack(LastBreath.wayBack(player), player.getAirSupply(), false) == null) return false;
		return dev.agaminggod.mineagen.server.perception.WaterAirFacts.surface(player).searching();
	}

	/**
	 * {@code settled}: only once the seen-air search is done with no route (choosing the move: a near surface may come next
	 * tick). Inside the swim the way back is taken while the search still runs, since it leads to known air and a seen
	 * route takes over the tick it is found; rising blind first lengthens the way past the breath (sealed-pocket room: 22
	 * cells back, 2 to 3 more after the rise, over the 24 a full breath covers, so the first escape ended ESCAPE_NO_WAY).
	 */
	private static SwimPlanning.Surface wayBack(ServerPlayer player, boolean settled, boolean underway) {
		if (!player.isUnderWater()) return null;
		var lookup = dev.agaminggod.mineagen.server.perception.WaterAirFacts.surface(player);
		if (settled && lookup.searching() || lookup.surface() != null && lookup.surface().path().size() >= 2) return null;
		return wayBack(LastBreath.wayBack(player), player.getAirSupply(), underway);
	}

	/**
	 * The way back to the last breath as a swim route (eye cells, the breath cell last), when the breath left covers it
	 * with the reserve (the end is known air, an authored breathable target); else null.
	 */
	static SwimPlanning.Surface wayBack(List<BlockPos> back, int air) {
		return wayBack(back, air, false);
	}

	/** {@code underway}: already swimming back, so the way is taken whatever the breath left (turning back again is worse). */
	static SwimPlanning.Surface wayBack(List<BlockPos> back, int air, boolean underway) {
		if (back.size() < 2 || !underway && !SwimPlanning.breathCovers(air + SwimPlanning.AIR_RESERVE_TICKS, back.size() - 1)) return null;
		BlockPos breath = back.get(back.size() - 1);
		return new SwimPlanning.Surface(breath.getX(), breath.getY(), breath.getZ(), back.size() - 1, true, back);
	}

	/** Jump on the way back only to rise to the next cell, sneak only to sink to it, neither when it is level. */
	static boolean rises(double dy) {
		return dy > 0.3D;
	}

	static boolean sinks(double dy) {
		return dy < -0.3D;
	}

	/** A blind swim's 2 s window made way: the eyes rose, or the body moved across (out from under a ledge), half a block. */
	static boolean madeWay(double rise, double across) {
		return rise >= BLIND_MIN_RISE || across >= BLIND_MIN_RISE;
	}

	static final int BLIND_WINDOW_TICKS = 40;
	static final double BLIND_MIN_RISE = 0.5D;

	/** Walk to the nearest reachable cell that hides from every shooter in sight, blocking shots with a held shield. */
	public static Move takeCover(int within) {
		return adapt(new ReflexActions.TakeCover(within, false, true), null);
	}

	/** Sprint away from the shooter over safe footing for {@code blocks}: the retreat reflex's move. */
	public static Move sprintAway(double blocks, Mob shooter) {
		return adapt(new ReflexActions.SprintAway(blocks), shooter);
	}

	/** Hostile mobs with a ranged attack that see the player within {@link ReflexActions#WATCHER_RANGE}, nearest first. */
	public static List<Mob> shooters(ServerPlayer player) {
		return ReflexActions.watchers(player).stream().filter(ThreatPerception::isRanged).toList();
	}

	private static Move adapt(ReflexActions.Behaviour behaviour, Mob focus) {
		ReflexSensors.Memory memory = new ReflexSensors.Memory();
		return (player, input) -> {
			ReflexActions.Step step = behaviour.tick(new ReflexActions.Context(player, focus, false, memory), input);
			Status status = switch (step.status()) {
				case RUNNING -> Status.RUNNING;
				case DONE -> Status.DONE;
				default -> Status.FAILED;
			};
			if (status != Status.RUNNING) behaviour.end(player);
			return new Result(status, step.detail());
		};
	}
}
