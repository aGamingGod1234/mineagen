package dev.agaminggod.mineagen.server;

import dev.agaminggod.mineagen.compat.TestCompat;
import net.minecraft.commands.CommandSource;
import net.minecraft.network.chat.Component;
import net.minecraft.server.permissions.LevelBasedPermissionSet;
import net.minecraft.server.permissions.PermissionSet;
import net.minecraft.world.phys.Vec2;
import net.minecraft.world.phys.Vec3;

public final class GoalControlVerification {
	private GoalControlVerification() {
	}

	public static int verify() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		assertEquals(false, mayControl(PermissionSet.NO_PERMISSIONS), "a player without permissions cannot control agents");
		assertEquals(false, mayControl(LevelBasedPermissionSet.MODERATOR), "a moderator cannot control agents");
		assertEquals(true, mayControl(LevelBasedPermissionSet.GAMEMASTER), "a game master can control agents");
		assertEquals(true, mayControl(PermissionSet.ALL_PERMISSIONS), "the console can control agents");
		return 4;
	}

	private static boolean mayControl(PermissionSet permissions) {
		return GoalControl.mayControl(TestCompat.commandSource(CommandSource.NULL, Vec3.ZERO, Vec2.ZERO, null,
				permissions, Component.literal("Permission check")));
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}
}
