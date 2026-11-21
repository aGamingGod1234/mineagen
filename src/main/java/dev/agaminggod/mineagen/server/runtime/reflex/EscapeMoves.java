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

	/** Swim to the nearest breathable cell the player has seen; with none, rise holding jump with the view tilted up. */
	public static Move swimUp() {
		Move swim = adapt(new ReflexActions.SwimUp(), null);
		// The reflex's blind rise (no seen air) holds jump with no progress check; under a roof it would hold until the air
		// ran out. Here the eyes must rise half a block in every 2 s, or the move hands the choice back.
		double[] mark = {Double.NaN};
		int[] ticks = {0};
		return (player, input) -> {
			double eye = player.getEyeY();
			if (Double.isNaN(mark[0])) mark[0] = eye;
			if (++ticks[0] % BLIND_WINDOW_TICKS == 0) {
				if (eye - mark[0] < BLIND_MIN_RISE && ReflexActions.airRoute(player) == null) return new Result(Status.FAILED, "not rising toward air (no seen air route, under 0.5 blocks in 2 s)");
				mark[0] = eye;
			}
			return swim.tick(player, input);
		};
	}

	static final int BLIND_WINDOW_TICKS = 40;
	static final double BLIND_MIN_RISE = 0.5D;

	/** Walk to the nearest reachable cell that hides from every shooter in sight, blocking shots with a held shield. */
	public static Move takeCover(int within) {
		return adapt(new ReflexActions.TakeCover(within, false), null);
	}

	/** Sprint away from the hostiles in sight over safe footing for {@code blocks}: the retreat reflex's move. */
	public static Move sprintAway(double blocks) {
		return adapt(new ReflexActions.SprintAway(blocks), null);
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
