package dev.agaminggod.mineagen.server.runtime.controller;

import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;

/**
 * The blaze spawner hold (wall breaker "rods"), server-free: one check per hand-back rule of the safety contract (H1-H10),
 * the site, collect and eat gates, and the size fact the shelter rests on (a 2.4-tall wither skeleton is kept out by a
 * two-high doorway, a 1.8-tall blaze is not).
 */
public final class SpawnerHoldVerification {
	private static int assertions;

	private SpawnerHoldVerification() {
	}

	public static void main(String[] args) {
		System.out.println("SpawnerHoldVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifySizes();
		verifyApplies();
		verifyHandBacks();
		verifyEngineEnds();
		verifySite();
		verifyCollect();
		verifyEat();
		verifyBreach();
		verifyTurtle();
		return assertions;
	}

	private static void verifySizes() {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		float wither = dev.agaminggod.mineagen.compat.McEntityTypes.WITHER_SKELETON.getDimensions().height();
		float blaze = dev.agaminggod.mineagen.compat.McEntityTypes.BLAZE.getDimensions().height();
		check(SpawnerHold.doorway(83, 92, 84, 92, true, d -> true) == net.minecraft.core.Direction.SOUTH
				&& SpawnerHold.doorway(83, 92, 84, 92, true, d -> d == net.minecraft.core.Direction.NORTH) == net.minecraft.core.Direction.NORTH
				&& SpawnerHold.doorway(84, 91, 84, 92, true, d -> d == net.minecraft.core.Direction.NORTH) == net.minecraft.core.Direction.NORTH
				&& SpawnerHold.doorway(80, 92, 84, 92, true, d -> true) == net.minecraft.core.Direction.EAST
				&& SpawnerHold.doorway(83, 92, 84, 92, false, d -> true) == net.minecraft.core.Direction.EAST
				&& SpawnerHold.spawnerInDoorway(72, 73) && SpawnerHold.spawnerInDoorway(73, 73) && !SpawnerHold.spawnerInDoorway(74, 73),
				"a cell right beside the spawner opens to the side, never onto the spawner; farther off it faces the spawner");
		check(Math.abs(wither - 2.4F) < 1.0E-4F, "a wither skeleton is 2.4 blocks tall, was " + wither);
		check(Math.abs(blaze - 1.8F) < 1.0E-4F, "a blaze is 1.8 blocks tall, was " + blaze);
		check(SpawnerHold.keptOut(wither, 2), "a two-high doorway keeps a wither skeleton out");
		check(!SpawnerHold.keptOut(blaze, 2), "a blaze fits a two-high doorway (it can be fought there)");
	}

	private static void verifyApplies() {
		check(SpawnerHold.applies(true, true, null, true), "fight_until blaze in the Nether with a seen fortress spawner holds");
		check(SpawnerHold.applies(true, true, true, true), "roof:true asks for it too");
		check(!SpawnerHold.applies(true, true, false, true), "roof:false keeps the open-ground fight");
		check(!SpawnerHold.applies(true, true, null, false), "no seen spawner: the open-ground fight");
		check(!SpawnerHold.applies(true, false, null, true), "another mob: the open-ground fight");
		check(!SpawnerHold.applies(false, true, null, true), "outside the Nether: the open-ground fight");
	}

	private static SpawnerHold.Sense sense(int held, float health, int hunger, boolean food, long elapsed, boolean gone, long quiet, boolean inCell,
			int sitesFailed, boolean noSite, boolean breached) {
		return new SpawnerHold.Sense(held, 7, health, 6.0F, hunger, food, elapsed, 600_000L, gone, quiet, inCell, sitesFailed, noSite, breached);
	}

	private static SpawnerHold.Sense calm() {
		return sense(2, 20.0F, 20, true, 60_000L, false, 0L, true, 0, false, false);
	}

	private static void verifyHandBacks() {
		check(SpawnerHold.handBack(calm()) == null, "a calm hold holds on");
		check("UNTIL_COUNT_REACHED".equals(SpawnerHold.handBack(sense(7, 20.0F, 20, true, 60_000L, false, 0L, true, 0, false, false))), "H1 rod count reached");
		check("UNTIL_COUNT_REACHED".equals(SpawnerHold.handBack(sense(7, 3.0F, 2, false, 700_000L, true, 999_999L, true, 3, true, true))), "H1 wins over every stop");
		check("LOW_HEALTH_BAILOUT".equals(SpawnerHold.handBack(sense(2, 6.0F, 20, true, 60_000L, false, 0L, false, 0, false, false))), "H2 health floor before the cell stands");
		check(SpawnerHold.handBack(sense(2, 6.5F, 20, true, 60_000L, false, 0L, false, 0, false, false)) == null, "H2 only at or below the floor");
		check(SpawnerHold.handBack(sense(2, 3.0F, 20, true, 60_000L, false, 0L, true, 0, false, false)) == null, "H2 once the cell stands the body heals in it, no hand-back");
		check(SpawnerHold.turtle(true, 5.0F, 0L, SpawnerHold.TURTLE_MS * 3), "below the turtle health the shield heal does not stop for time");
		check(!SpawnerHold.turtle(true, 15.0F, 0L, SpawnerHold.TURTLE_MS), "above it the shield heal stops at its time cap");
		check(SpawnerHold.mayStepOut(12.0F, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 4.0D, 1), "a rod 4 blocks from the cell is stepped out for with one blaze near it");
		check(!SpawnerHold.mayStepOut(12.0F, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 6.0D, 0), "not one 6 blocks off");
		check(!SpawnerHold.mayStepOut(12.0F, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 2.0D, 2), "not with two blazes near it");
		check(SpawnerHold.mayFetchBold(16.0F, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 4.5D, 12.0D), "a bold trip at 16 health, no blaze within 4 of a rod 12 from the cell");
		check(!SpawnerHold.mayFetchBold(16.0F, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 3.5D, 6.0D), "not with a blaze within 4 of the rod");
		check(!SpawnerHold.mayFetchBold(15.5F, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 9.0D, 6.0D), "not below 16 health");
		check(SpawnerHold.mayFetchLedge(16.0F, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 1), "a ledge trip goes at 16 health with one blaze near the rod");
		check(!SpawnerHold.mayFetchLedge(16.0F, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 2), "not with two blazes near the rod");
		check(!SpawnerHold.mayFetchLedge(15.0F, Double.POSITIVE_INFINITY, Double.POSITIVE_INFINITY, 0), "not below 16 health");
		check(!SpawnerHold.mayFetchLedge(20.0F, 5.0D, Double.POSITIVE_INFINITY, 0), "not with a wither skeleton near the body");
		check(SpawnerHold.sealedHeal(15.0F, 0L, SpawnerHold.TURTLE_MS * 2), "walled in, the heal goes on past the shield heal's time cap below TURTLE_DONE");
		check(!SpawnerHold.sealedHeal(SpawnerHold.TURTLE_DONE, 0L, 1_000L), "walled in, the heal ends at TURTLE_DONE");
		check(!SpawnerHold.sealedHeal(5.0F, 0L, SpawnerHold.SEALED_MS), "walled in, the heal ends at SEALED_MS");
		check(SpawnerHold.backToCell(11.0F) && !SpawnerHold.backToCell(12.0F), "a rod trip turns back to the cell below 12 health");
		check(!SpawnerHold.backToCell(14.0F, 10.0D, 0.0F, 0), "unhurt lately and not burning: 14 health 10 blocks out fights on");
		check(SpawnerHold.backToCell(16.0F, 10.0D, 5.0F, 0), "one fireball in the last 5 s at 10 blocks out: 16 health turns back (5 s walk and wall-in at 1 a second)");
		check(!SpawnerHold.backToCell(16.0F, 0.0D, 5.0F, 0), "the same hit in the cell: 16 health still has its margin (only the wall-in to cover)");
		check(SpawnerHold.backToCell(15.0F, 2.0D, 0.0F, 100), "burning for 5 s more: 15 health turns back even by the cell");
		check(SpawnerHold.backToCell(11.0F, 0.0D, 0.0F, 0), "below 12 always: the old floor stays");
		check(Math.abs(SpawnerHold.healthAtCover(20.0F, 8.0D, 10.0F, 40) - 10.0F) < 1e-4F, "20 health, 2 health a second of hits over a 4 s walk and wall-in, 2 s of fire: 10 at the cell");
		check(SpawnerHold.turtle(true, 15.0F, true, -1L, 0L), "the margin ran out: the heal starts on arrival at 15");
		check(!SpawnerHold.turtle(true, 18.0F, true, -1L, 0L), "not at 18 (nothing to heal)");
		check(!SpawnerHold.turtle(true, 15.0F, false, -1L, 0L), "at 15 with the margin held: fight on");
		check("OUT_OF_FOOD".equals(SpawnerHold.handBack(sense(2, 12.0F, 10, false, 60_000L, false, 0L, true, 0, false, false))), "H3 hurt, hungry, no food");
		check(SpawnerHold.handBack(sense(2, 12.0F, 10, true, 60_000L, false, 0L, true, 0, false, false)) == null, "H3 not with food left (the hold eats)");
		check(SpawnerHold.handBack(sense(2, 20.0F, 10, false, 60_000L, false, 0L, true, 0, false, false)) == null, "H3 not at full health");
		check("FIGHT_UNTIL_TIMED_OUT".equals(SpawnerHold.handBack(sense(2, 20.0F, 20, true, 600_000L, false, 0L, true, 0, false, false))), "H4 time cap");
		check("SPAWNER_GONE".equals(SpawnerHold.handBack(sense(2, 20.0F, 20, true, 60_000L, true, 0L, true, 0, false, false))), "H5 spawner gone");
		check("SPAWNER_UNREACHABLE".equals(SpawnerHold.handBack(sense(2, 20.0F, 20, true, 60_000L, false, 0L, false, SpawnerHold.MAX_SITES, false, false))), "H6 three sites failed");
		check("SPAWNER_UNREACHABLE".equals(SpawnerHold.handBack(sense(2, 20.0F, 20, true, 60_000L, false, 0L, false, 0, true, false))), "H6 no site at all");
		check(SpawnerHold.handBack(sense(2, 20.0F, 20, true, 60_000L, false, 0L, false, SpawnerHold.MAX_SITES - 1, false, false)) == null, "H6 two failed sites still try a third");
		check("SPAWNER_QUIET".equals(SpawnerHold.handBack(sense(2, 20.0F, 20, true, 200_000L, false, SpawnerHold.QUIET_MS, true, 0, false, false))), "H7 no blaze for 90 s in the cell");
		check(SpawnerHold.handBack(sense(2, 20.0F, 20, true, 200_000L, false, SpawnerHold.QUIET_MS, false, 0, false, false)) == null, "H7 only counts in the cell (not while walking or building)");
		check(SpawnerHold.QUIET_MS > 40_000L + ServerFightUntilController.NO_TARGET_MS, "H7 outlasts a vanilla spawner's longest delay (40 s) plus the engine's no-target wait");
		check("HOLD_BREACHED".equals(SpawnerHold.handBack(sense(2, 20.0F, 20, true, 60_000L, false, 0L, true, 0, false, true))), "H10 wither hits inside the cell");
		check("LOW_HEALTH_BAILOUT".equals(SpawnerHold.handBack(sense(2, 5.0F, 20, true, 60_000L, true, 0L, false, 0, false, true))), "the body's floor comes before the spawner and the breach");
		check("HOLD_BREACHED".equals(SpawnerHold.handBack(sense(2, 5.0F, 20, true, 60_000L, true, 0L, true, 0, false, true))), "in the cell a breach still hands back at low health");
	}

	private static void verifyEngineEnds() {
		for (String stop : new String[] {"UNTIL_COUNT_REACHED", "AGENT_DEAD", "IN_LAVA", "FIGHT_UNTIL_TIMED_OUT"})
			check(stop.equals(SpawnerHold.engineEnd(stop)), "H9 the engine's " + stop + " hands the hold back");
		for (String restart : new String[] {"NO_TARGET_SEEN", "AREA_CLEARED", "TARGET_OUT_OF_REACH", "TARGET_NOT_VISIBLE", "PATH_BLOCKED", "LOW_HEALTH_BAILOUT"})
			check(SpawnerHold.engineEnd(restart) == null, "the engine's " + restart + " restarts it in the cell");
	}

	private static void verifySite() {
		check(SpawnerHold.siteInRange(6.0D, 0) && SpawnerHold.siteInRange(12.0D, -3) && SpawnerHold.siteInRange(8.0D, 1), "6-12 blocks, feet 3 below to 1 above");
		check(!SpawnerHold.siteInRange(5.9D, 0) && !SpawnerHold.siteInRange(12.1D, 0), "not nearer than 6 (blazes spawn within 4) nor past 12 (the spawner needs a player within 16)");
		check(!SpawnerHold.siteInRange(8.0D, -4) && !SpawnerHold.siteInRange(8.0D, 2), "not far below or above the spawner");
		check(SpawnerHold.siteScore(8.0D, 10.0D, 0) < SpawnerHold.siteScore(8.0D, 10.0D, 10), "a standing shelter (no blocks to place) is preferred");
		check(SpawnerHold.siteScore(8.0D, 10.0D, 10) < SpawnerHold.siteScore(11.0D, 10.0D, 10), "near the ideal 8 blocks");
		check(SpawnerHold.facing(5, 1) == Direction.EAST && SpawnerHold.facing(-5, 2) == Direction.WEST
				&& SpawnerHold.facing(1, 5) == Direction.SOUTH && SpawnerHold.facing(-2, -5) == Direction.NORTH, "the doorway faces the spawner along the larger axis");
		var cells = ServerSpawnerHoldController.shelterCells(BlockPos.ZERO, Direction.EAST);
		check(cells.contains(new BlockPos(1, 2, 0)), "the lintel over the doorway is part of the shelter");
		check(!cells.contains(new BlockPos(1, 0, 0)) && !cells.contains(new BlockPos(1, 1, 0)), "the doorway itself stays open two high");
		check(cells.contains(BlockPos.ZERO.above(2)), "the cell is roofed");
	}

	private static void verifyCollect() {
		double none = Double.POSITIVE_INFINITY;
		check(SpawnerHold.mayCollect(20.0F, none, none, none, 0L), "no wither skeleton, no blaze near: walk out");
		check(SpawnerHold.mayCollect(12.0F, 10.5D, 11.0D, 10.5D, 0L), "blazes past 10 blocks do not hold a trip back");
		check(!SpawnerHold.mayCollect(11.5F, none, none, none, 0L), "not below 12 health");
		check(!SpawnerHold.mayCollect(20.0F, 9.0D, none, none, 0L), "not with a wither skeleton within 10 of the body");
		check(!SpawnerHold.mayCollect(20.0F, none, 8.0D, none, 0L), "not with a wither skeleton within 10 of the rod");
		check(!SpawnerHold.mayCollect(20.0F, none, none, 9.0D, 0L), "not mid-wave: a blaze within 10 of the body or the rod");
		check(SpawnerHold.mayCollect(16.0F, none, none, 3.0D, SpawnerHold.LATE_ROD_TICKS), "a rod near despawn is fetched at 16+ health with blazes about");
		check(!SpawnerHold.mayCollect(15.0F, none, none, 3.0D, SpawnerHold.LATE_ROD_TICKS), "but not below 16");
		check(!SpawnerHold.mayCollect(20.0F, 5.0D, none, none, SpawnerHold.LATE_ROD_TICKS), "never with a wither skeleton near, however old the rod");
		check(SpawnerHold.LATE_ROD_TICKS < 6_000L, "the late fetch comes before the 5-minute despawn");
		check(!SpawnerHold.defendAgainst(true) && SpawnerHold.defendAgainst(false), "outside the cell blazes are not chased; other attackers are fought");
	}

	private static void verifyEat() {
		check(SpawnerHold.shouldEat(17, 20.0F, true, false, true), "eat below 18 hunger (health stops regrowing)");
		check(SpawnerHold.shouldEat(19, 13.0F, true, false, true), "eat when hurt with room to eat");
		check(!SpawnerHold.shouldEat(20, 13.0F, true, false, true), "not when full");
		check(!SpawnerHold.shouldEat(10, 10.0F, false, false, true), "not when a bite is unsafe (a shot or a volley due: the shield comes first)");
		check(SpawnerHold.biteSafe(-1, false), "a bite with no charged blaze and no shot is safe");
		check(!SpawnerHold.biteSafe(-1, true), "not with a shot inbound");
		check(SpawnerHold.biteSafe(17, false), "a charge 17 ticks old leaves the bite and the shield's raise before its volley");
		check(!SpawnerHold.biteSafe(18, false), "a charge 18 ticks old does not");
		check(!SpawnerHold.stopBite(49, false) && SpawnerHold.stopBite(50, false) && SpawnerHold.stopBite(-1, true), "a bite stops 10 ticks before a volley, or for a shot");
		check(!SpawnerHold.stopBite(17 + SpawnerHold.BITE_TICKS, false), "a bite started when safe is never stopped by that same charge");
		check(SpawnerHold.healBite(19, true, true), "the heal bites at any hunger below full when it is safe");
		check(!SpawnerHold.healBite(10, false, true), "the heal keeps the shield up when a bite is unsafe, however hungry");
		check(!SpawnerHold.healBite(20, true, true) && !SpawnerHold.healBite(10, true, false), "not when full or without food");
		check(!SpawnerHold.shouldEat(10, 10.0F, true, true, true), "not with a blaze within reach");
		check(!SpawnerHold.shouldEat(10, 10.0F, true, false, false), "not without food");
	}

	private static void verifyBreach() {
		long none = Long.MIN_VALUE;
		check(!SpawnerHold.breached(new long[] {none, none}, 1_000L), "no hits: holds");
		check(!SpawnerHold.breached(new long[] {900L, none}, 1_000L), "one hit: holds");
		check(SpawnerHold.breached(new long[] {900L, 850L}, 1_000L), "two hits within 10 s: breached");
		check(!SpawnerHold.breached(new long[] {900L, 700L}, 1_000L), "two hits 15 s apart: holds");
	}

	private static void verifyTurtle() {
		check(SpawnerHold.turtle(true, 11.5F, -1L, 0L), "below 12 in the cell: shield up and heal");
		check(!SpawnerHold.turtle(true, 12.0F, -1L, 0L), "at 12: fight on");
		check(!SpawnerHold.turtle(false, 5.0F, -1L, 0L), "only in the cell (outside, the health floor and defend apply)");
		check(SpawnerHold.turtle(true, 17.5F, 1_000L, 30_000L), "keeps healing until 18");
		check(!SpawnerHold.turtle(true, 18.0F, 1_000L, 30_000L), "back to the fight at 18");
		check(!SpawnerHold.turtle(true, 14.0F, 1_000L, 1_000L + SpawnerHold.TURTLE_MS), "and after 45 s whatever the health (blazes do not wait)");
		check(SpawnerHold.TURTLE_HEALTH > 6.0F + 5.0F, "the shield goes up more than one fireball (5) above the default 6-health hand-back");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
