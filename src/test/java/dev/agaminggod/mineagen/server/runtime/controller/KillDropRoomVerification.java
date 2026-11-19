package dev.agaminggod.mineagen.server.runtime.controller;

/** 1b make room: which junk stack a collector throws away so a kill drop fits; and the kill's drop-age window. */
public final class KillDropRoomVerification {
	private KillDropRoomVerification() {
	}

	public static int verify() {
		int checks = 0;
		String bone = "minecraft:bone";
		checks += check(-1, slot(new String[] { "minecraft:diamond", "minecraft:iron_ingot" }, new int[] { 3, 9 }, bone), "no junk: nothing is thrown");
		checks += check(2, slot(new String[] { "minecraft:diamond", "minecraft:dirt", "minecraft:gravel" }, new int[] { 3, 40, 12 }, bone), "the smallest junk stack goes");
		checks += check(1, slot(new String[] { "minecraft:cobblestone", "minecraft:cobblestone" }, new int[] { 64, 10 }, bone), "cobble goes while 16 building blocks stay");
		checks += check(-1, slot(new String[] { "minecraft:cobblestone", "minecraft:cobbled_deepslate" }, new int[] { 12, 10 }, bone), "a stack that would leave under 16 cobble is kept");
		checks += check(-1, slot(new String[] { "minecraft:dirt", "minecraft:andesite" }, new int[] { 14, 10 }, bone), "the 16-block floor counts every junk kind (dirt and andesite are pillar blocks too)");
		checks += check(1, slot(new String[] { "minecraft:dirt", "minecraft:andesite" }, new int[] { 20, 10 }, bone), "a stack goes when 16 others stay");
		checks += check(-1, slot(new String[] { "minecraft:dirt" }, new int[] { 64 }, "minecraft:gravel"), "junk is never thrown to take junk");
		checks += check(-1, slot(new String[] { "minecraft:dirt" }, new int[] { 64 }, "minecraft:dirt"), "never the item being collected");
		String[] ids = new String[41];
		int[] counts = new int[41];
		ids[0] = "minecraft:dirt";
		counts[0] = 20;
		ids[38] = "minecraft:dirt";
		counts[38] = 4;
		checks += check(-1, KillDropCollector.junkSlot(ids, counts, bone), "armour and offhand slots are neither thrown nor counted toward the floor");
		checks += check(2, KillDropCollector.ROOM_STACKS, "two stacks a run at most");
		// The drop-age window after a reflex pause (1b diagnosis): the kill's own loot is not filtered as old.
		checks += check(ServerFightController.DROP_AGE_TICKS, ServerFightController.dropAgeLimit(100L, 100L), "a death seen at once keeps 5 ticks");
		checks += check(ServerFightController.DROP_AGE_TICKS + 30, ServerFightController.dropAgeLimit(130L, 100L), "a 30-tick pause widens the window by 30");
		checks += check(60, ServerFightController.dropAgeLimit(10_000L, 100L), "capped at 3 s");
		checks += check(ServerFightController.DROP_AGE_TICKS, ServerFightController.dropAgeLimit(100L, Long.MIN_VALUE / 2L), "unknown keeps 5 ticks");
		return checks;
	}

	private static int slot(String[] ids, int[] counts, String collecting) {
		return KillDropCollector.junkSlot(ids, counts, collecting);
	}

	private static int check(int expected, int actual, String message) {
		if (expected != actual) throw new AssertionError(message + ": expected " + expected + ", got " + actual);
		return 1;
	}
}
