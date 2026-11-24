package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import java.util.List;
import net.minecraft.world.phys.AABB;

public final class DragonPerchSafetyVerification {
	private DragonPerchSafetyVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " dragon perch safety assertions");
	}

	public static int verify() {
		int assertions = 0;
		// A perched head box (1x1x1 at y 63.3, as the perch probe read it) grown as zones() grows it: 1.3 across, 1 up and down.
		AABB head = new AABB(9.5D, 63.3D, -0.5D, 10.5D, 64.3D, 0.5D).inflate(1.0D + DragonPerchSafety.SIDE_MARGIN, 1.0D, 1.0D + DragonPerchSafety.SIDE_MARGIN);
		DragonPerchSafety.Zones contacts = new DragonPerchSafety.Zones(List.of(head), List.of());
		// The perch watch: under the head, feet on the fountain's ground (y 60) is clear; one block up (61) is hit.
		check(!contacts.unsafe(10.0D, 60.0D, 0.0D), "a body on the ground under the head is clear of it");
		assertions++;
		check(contacts.unsafe(10.0D, 61.0D, 0.0D), "a body one block up under the head meets it");
		assertions++;
		// The whole cell counts: a body centred 1.3 past the grown box is clear, but a cell whose near half reaches it is not.
		check(!contacts.unsafe(13.4D, 61.0D, 0.0D), "a centre point just past the grown box is clear");
		assertions++;
		check(contacts.unsafeCell(new GridPosition(12, 61, -1)), "a cell whose near side reaches the head box is unsafe");
		assertions++;
		check(!contacts.unsafeCell(new GridPosition(14, 61, -1)), "a cell a block further out is safe");
		assertions++;
		// Breath: a cloud on the ground (y 60) of radius 5; a body is in it from 1.8 below its y to half a block above.
		DragonPerchSafety.Zones breath = new DragonPerchSafety.Zones(List.of(), List.of(new DragonPerchSafety.Circle(0.0D, 60.0D, 0.0D, 5.0D)));
		check(breath.unsafe(5.2D, 60.0D, 0.0D), "a body within the cloud's radius plus its margin is in the breath");
		assertions++;
		check(!breath.unsafe(5.7D, 60.0D, 0.0D), "a body past the margin is out of it");
		assertions++;
		check(!breath.unsafe(0.0D, 60.5D, 0.0D), "a body standing half a block over the cloud is above it");
		assertions++;
		return assertions;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
