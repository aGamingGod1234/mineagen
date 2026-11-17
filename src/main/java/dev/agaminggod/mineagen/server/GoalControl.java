package dev.agaminggod.mineagen.server;

import java.util.Objects;
import net.minecraft.commands.CommandSourceStack;
import net.minecraft.commands.Commands;

public final class GoalControl {
	private GoalControl() {
	}

	public static boolean mayControl(CommandSourceStack source) {
		Objects.requireNonNull(source, "source must not be null");
		return Commands.LEVEL_GAMEMASTERS.check(source.permissions());
	}
}
