package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.List;
import net.minecraft.world.phys.Vec3;

/** Forest mode of the enderman count fight (WarpedForestHunt): when it applies, when it walks on, when it hands back. */
public final class ForestHuntVerification {
	private static int assertions;

	private ForestHuntVerification() {
	}

	public static void main(String[] args) {
		System.out.println("ForestHuntVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifyAppliesOnlyInForest();
		verifyQuietRelocates();
		verifyRoofOnContact();
		verifyBlocksMissing();
		verifyUnreachable();
		verifyDestinations();
		return assertions;
	}

	private static void verifyAppliesOnlyInForest() {
		check(WarpedForestHunt.applies(true, true, false, "minecraft:warped_forest"), "an enderman hunt free to move in a warped forest is a forest hunt");
		check(!WarpedForestHunt.applies(true, true, false, "minecraft:basalt_deltas"), "outside the forest the old hunt runs (NO_TARGET_SEEN after 30 s)");
		check(!WarpedForestHunt.applies(true, true, false, null), "an unknown biome is not a forest");
		check(!WarpedForestHunt.applies(false, true, false, "minecraft:warped_forest"), "blazes and other mobs keep the old hunt");
		check(!WarpedForestHunt.applies(true, false, false, "minecraft:warped_forest"), "pursue:false holds its place: no relocation");
		check(!WarpedForestHunt.applies(true, true, true, "minecraft:warped_forest"), "sneak:true holds its place: no relocation");
	}

	private static void verifyQuietRelocates() {
		check(WarpedForestHunt.quiet(11_999L, 0L, false) == WarpedForestHunt.Quiet.WAIT, "under 12 s quiet: keep looking where it stands");
		check(WarpedForestHunt.quiet(12_000L, 0L, false) == WarpedForestHunt.Quiet.RELOCATE, "12 s quiet: walk on (no 30 s hand-back)");
		check(WarpedForestHunt.QUIET_MS < ServerFightUntilController.NO_TARGET_MS, "the forest walks on before the old hand-back would have fired");
		check(WarpedForestHunt.quiet(1_000L, 0L, true) == WarpedForestHunt.Quiet.RELOCATE, "an area cleared after a look around walks on at once");
	}

	private static void verifyRoofOnContact() {
		check(WarpedForestHunt.roofOnContact(true, false, false, true, false), "roof wanted and a calm enderman sensed: build the shelter now");
		check(!WarpedForestHunt.roofOnContact(true, false, false, false, false), "no contact: no roof (open ground while it searches)");
		check(!WarpedForestHunt.roofOnContact(true, false, false, true, true), "an angry enderman is fought on open ground: no time to build");
		check(!WarpedForestHunt.roofOnContact(true, true, false, true, false), "already roofed: no second shelter");
		check(!WarpedForestHunt.roofOnContact(true, false, true, true, false), "a shelter under construction is not started again");
		check(!WarpedForestHunt.roofOnContact(false, false, false, true, false), "roof not asked, or dropped: open ground only");
		check(WarpedForestHunt.mayBuildAgain(2) && !WarpedForestHunt.mayBuildAgain(3), "at most three shelters a call; later contacts fight in the open");
	}

	private static void verifyBlocksMissing() {
		check(WarpedForestHunt.dropsRoof(true, "ROOF_BLOCKS_MISSING"), "forest mode: too few blocks drops the roof and hunts on");
		check(!WarpedForestHunt.dropsRoof(false, "ROOF_BLOCKS_MISSING"), "outside forest mode K11's stop stands");
		check(!ServerFightUntilController.roofFallback("ROOF_BLOCKS_MISSING", true), "K11's static decision is unchanged");
		check(!WarpedForestHunt.dropsRoof(true, "SNEAK_NOT_HELD"), "only the missing-blocks stop is dropped");
	}

	private static void verifyUnreachable() {
		check(!WarpedForestHunt.unreachable(2), "two failed relocation walks: try another destination");
		check(WarpedForestHunt.unreachable(3), "three failed relocation walks in a row: FOREST_UNREACHABLE");
		check(!WarpedForestHunt.nowhereLeft(2), "an empty scan looks around another quiet spell (no hand-back sooner than the old 30 s)");
		check(WarpedForestHunt.nowhereLeft(3), "three empty scans in a row: the forest here is used up, FOREST_UNREACHABLE");
		check(WarpedForestHunt.MAX_EMPTY_SCANS * WarpedForestHunt.QUIET_MS >= ServerFightUntilController.NO_TARGET_MS, "never hands back sooner than the old wait");
	}

	private static void verifyDestinations() {
		Vec3 start = new Vec3(0.5D, 70.0D, 0.5D);
		List<Vec3> searched = List.of(start);
		Vec3 near = new Vec3(20.5D, 70.0D, 0.5D), far = new Vec3(0.5D, 70.0D, -28.5D), tooClose = new Vec3(8.5D, 70.0D, 0.5D);
		check(WarpedForestHunt.choose(start, start, searched, List.of(), null, List.of(near, far)) == far,
				"of two seen floors, the one farthest from searched ground");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), null, List.of(tooClose)) == null, "a floor under 16 blocks away is not new ground");
		Vec3 outside = new Vec3(40.5D, 70.0D, 10.5D);
		check(WarpedForestHunt.choose(start, start, searched, List.of(), outside, List.of(near)) == outside,
				"an enderman seen outside the area comes first");
		Vec3 beyond = new Vec3(120.5D, 70.0D, 0.5D);
		check(WarpedForestHunt.choose(start, start, searched, List.of(), beyond, List.of()) == null, "nothing beyond 96 blocks of the start");
		check(WarpedForestHunt.choose(start, start, searched, List.of(far), null, List.of(far)) == null, "a destination whose walk failed is not tried again");
		check(WarpedForestHunt.choose(start, start, List.of(start, far), List.of(), null, List.of(far)) == null, "searched ground is not new ground");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), null, List.of()) == null, "no seen floor: nowhere left (FOREST_UNREACHABLE)");
		List<Vec3> headings = WarpedForestHunt.headingPoints(start);
		check(headings.size() == 8 && WarpedForestHunt.choose(start, start, searched, List.of(), null, headings) != null,
				"with no floor in sight a heading not searched yet is walked (a fungus forest hides its floor)");
		check(WarpedForestHunt.arrived(true, 0.0D, true) && WarpedForestHunt.arrived(false, 9.0D, true), "got there, or moved 8+ blocks: arrived");
		check(!WarpedForestHunt.arrived(false, 3.0D, true), "a walk that got nowhere did not arrive");
		check(!WarpedForestHunt.arrived(true, 20.0D, false), "a walk that left the forest does not count (it walks back in next)");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
