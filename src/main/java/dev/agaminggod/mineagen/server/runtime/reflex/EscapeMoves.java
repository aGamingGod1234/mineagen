package dev.agaminggod.mineagen.server.runtime.reflex;

import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import java.util.List;
import java.util.function.Consumer;
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
	 * Swim to the nearest breathable cell the player has seen; under a seen ceiling with none, duck out beside it (the
	 * reflex's duck-out, travel's PEEK); with neither, rise holding jump with the view tilted up.
	 */
	public static Move swimUp() {
		Move swim = adapt(new ReflexActions.SwimUp(), null);
		// The reflex's blind rise (no seen air) holds jump with no progress check; under a roof it would hold until the air
		// ran out. Here the eyes must rise or move across half a block in every 2 s (ducking out from under a ledge moves
		// across, not up), or the move hands the choice back.
		double[] mark = {Double.NaN, 0.0D, 0.0D};
		int[] ticks = {0};
		return (player, input) -> {
			double eye = player.getEyeY();
			if (Double.isNaN(mark[0])) { mark[0] = eye; mark[1] = player.getX(); mark[2] = player.getZ(); }
			if (++ticks[0] % BLIND_WINDOW_TICKS == 0) {
				if (!madeWay(eye - mark[0], Math.hypot(player.getX() - mark[1], player.getZ() - mark[2])) && ReflexActions.airRoute(player) == null) {
					return new Result(Status.FAILED, "not getting toward air (no seen air route, under 0.5 blocks up or across in 2 s)");
				}
				mark[0] = eye; mark[1] = player.getX(); mark[2] = player.getZ();
			}
			return swim.tick(player, input);
		};
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
