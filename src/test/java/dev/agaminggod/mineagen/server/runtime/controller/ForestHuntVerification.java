package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.List;
import java.util.UUID;
import net.minecraft.world.phys.Vec3;

/** Forest mode of the enderman count fight (WarpedForestHunt, ForestRoof): its decisions, one rule each. */
public final class ForestHuntVerification {
	private static int assertions;

	private ForestHuntVerification() {
	}

	public static void main(String[] args) {
		System.out.println("ForestHuntVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		boolean savedEnabled = WarpedForestHunt.enabled;
		WarpedForestHunt.enabled = false;
		check(!WarpedForestHunt.applies(true, true, true, false, WarpedForestHunt.BIOME), "off by default: a forest pearl hunt is main's hunt unless -D" + WarpedForestHunt.PROPERTY + "=true");
		WarpedForestHunt.enabled = true;
		try {
			verifyAll();
		} finally {
			WarpedForestHunt.enabled = savedEnabled;
		}
		return assertions;
	}

	private static void verifyAll() {
		verifyAppliesOnlyToForestPearlHunts();
		verifyQuietRelocates();
		verifyRoofOnContact();
		verifyBlocksMissing();
		verifyHandBacks();
		verifyWalkEnds();
		verifyDestinations();
		verifyLavaNear();
		verifyWalkBackGoal();
		verifyDangerKept();
		verifyLavaShoreKept();
	}

	private static void verifyAppliesOnlyToForestPearlHunts() {
		check(WarpedForestHunt.applies(true, true, true, false, "minecraft:warped_forest"), "an enderman pearl hunt free to move in a warped forest is a forest hunt");
		check(!WarpedForestHunt.applies(true, true, true, false, "minecraft:basalt_deltas"), "a non-forest Nether hunt runs as on base");
		check(!WarpedForestHunt.applies(true, true, true, false, "minecraft:plains"), "an Overworld hunt runs as on base");
		check(!WarpedForestHunt.applies(true, true, true, false, "minecraft:the_end"), "an End hunt runs as on base");
		check(!WarpedForestHunt.applies(true, true, true, false, null), "an unknown biome is not a forest");
		check(!WarpedForestHunt.applies(true, false, true, false, "minecraft:warped_forest"), "an enderman fight counting something else than pearls runs as on base");
		check(!WarpedForestHunt.applies(false, true, true, false, "minecraft:warped_forest"), "other mobs keep the old hunt");
		check(!WarpedForestHunt.applies(true, true, false, false, "minecraft:warped_forest"), "pursue:false holds its place: no relocation");
		check(!WarpedForestHunt.applies(true, true, true, true, "minecraft:warped_forest"), "sneak:true holds its place: no relocation");
	}

	private static void verifyQuietRelocates() {
		check(WarpedForestHunt.quiet(11_999L, 0L, false, false) == WarpedForestHunt.Quiet.WAIT, "under 12 s quiet: keep looking where it stands");
		check(WarpedForestHunt.quiet(12_000L, 0L, false, false) == WarpedForestHunt.Quiet.RELOCATE, "12 s quiet: walk on (no 30 s hand-back)");
		check(WarpedForestHunt.quiet(1_000L, 0L, true, false) == WarpedForestHunt.Quiet.RELOCATE, "an area cleared after a look around walks on at once");
		check(WarpedForestHunt.quiet(29_999L, 0L, false, true) == WarpedForestHunt.Quiet.WAIT, "under a roof the body waits K11's 30 s");
		check(WarpedForestHunt.quiet(1_000L, 0L, true, true) == WarpedForestHunt.Quiet.WAIT, "under a roof an area cleared still waits the 30 s");
		check(WarpedForestHunt.quiet(30_000L, 0L, false, true) == WarpedForestHunt.Quiet.RELOCATE, "after 30 s under a roof: leave it and walk on");
	}

	private static void verifyRoofOnContact() {
		check(ForestRoof.build(true, false, false, 0, 8.0D, 1_000L, false), "roof wanted, a calm enderman 8 blocks off in view 1 s: build now");
		check(!ForestRoof.build(true, false, false, 0, 8.0D, 999L, false), "a glimpse under 1 s is no contact");
		check(!ForestRoof.build(true, false, false, 0, 12.5D, 5_000L, false), "an enderman beyond 12 blocks is no contact");
		check(!ForestRoof.build(true, false, false, 0, 8.0D, 5_000L, true), "an angry enderman is fought on open ground: no time to build");
		check(!ForestRoof.build(true, true, false, 0, 8.0D, 5_000L, false), "already roofed: no second shelter");
		check(!ForestRoof.build(true, false, true, 0, 8.0D, 5_000L, false), "a shelter under construction is not started again");
		check(!ForestRoof.build(false, false, false, 0, 8.0D, 5_000L, false), "roof not asked, or dropped: open ground only");
		check(ForestRoof.build(true, false, false, 2, 8.0D, 5_000L, false) && !ForestRoof.build(true, false, false, 3, 8.0D, 5_000L, false),
				"at most three shelters a call");
		check(ForestRoof.reuse(true, 15.0D) && !ForestRoof.reuse(false, 3.0D) && !ForestRoof.reuse(true, 17.0D),
				"a standing shelter within 16 blocks is walked back into instead of building another");
		ForestRoof contact = new ForestRoof();
		UUID a = UUID.randomUUID(), b = UUID.randomUUID();
		check(contact.observe(a, true, 1_000L) == 0L && contact.observe(a, true, 2_200L) == 1_200L, "the same calm enderman in range: time in view grows");
		check(contact.observe(b, true, 2_250L) == 0L, "another enderman starts its own time");
		check(contact.observe(b, false, 2_300L) == 0L && contact.observe(b, true, 2_350L) == 0L, "out of range or angry resets it");
	}

	private static void verifyBlocksMissing() {
		check(WarpedForestHunt.dropsRoof(true, "ROOF_BLOCKS_MISSING"), "forest mode: too few blocks drops the roof and hunts on");
		check(!WarpedForestHunt.dropsRoof(false, "ROOF_BLOCKS_MISSING"), "outside forest mode K11's stop stands");
		check(!ServerFightUntilController.roofFallback("ROOF_BLOCKS_MISSING", true, true), "K11's static decision is unchanged");
		check(ForestRoof.holdsStare(true, true, 0, false, 8.0D), "no armour, a shelter to come: no stare at a calm enderman in contact range");
		check(!ForestRoof.holdsStare(true, true, 0, true, 8.0D), "armoured: the stare goes on as before");
		check(!ForestRoof.holdsStare(true, true, 0, false, 20.0D), "beyond contact range the body walks in as before");
		check(!ForestRoof.holdsStare(true, false, 0, false, 8.0D), "no roof asked for: unchanged");
		check(!ForestRoof.holdsStare(true, true, ForestRoof.MAX_ROOFS, false, 8.0D), "no shelters left to build: unchanged");
		check(!ForestRoof.holdsStare(false, true, 0, false, 8.0D), "outside forest mode: unchanged");
		check(ForestRoof.blocksNeeded(17, true, 3) == 20 && ForestRoof.blocksNeeded(17, false, 3) == 17, "a forest shelter keeps the perch's blocks too");
	}

	private static void verifyHandBacks() {
		check(!WarpedForestHunt.unreachable(7, 7) && WarpedForestHunt.unreachable(8, 8), "FOREST_UNREACHABLE once all 8 headings from here failed");
		check(!WarpedForestHunt.unreachable(2, 15) && WarpedForestHunt.unreachable(2, 16), "or 16 walks of any kind in a row (seen floors can fail without end)");
		check(!WarpedForestHunt.searchedOut(2) && WarpedForestHunt.searchedOut(3), "FOREST_SEARCHED_OUT after 3 quiet spells with nothing new");
		check(WarpedForestHunt.retryNow(2) && !WarpedForestHunt.retryNow(3), "after three quick failures the body looks around a quiet spell first");
		check(WarpedForestHunt.QUIET_MS * (WarpedForestHunt.MAX_EMPTY_SCANS) >= ServerFightUntilController.NO_TARGET_MS,
				"searched out never hands back sooner than the old 30 s wait");
	}

	private static void verifyWalkEnds() {
		check(WarpedForestHunt.arrived(true, "ARRIVED", 0.0D, true), "got there: arrived");
		check(WarpedForestHunt.arrived(false, "NO_ROUTE", 9.0D, true), "an ordinary route failure that moved 8+ blocks: arrived where it stopped");
		check(!WarpedForestHunt.arrived(false, "NO_ROUTE", 3.0D, true), "a walk that got nowhere did not arrive");
		check(!WarpedForestHunt.arrived(false, "TRAVEL_DAMAGED", 20.0D, true), "a damage stop is never credited as ground gained");
		check(!WarpedForestHunt.arrived(false, "LAVA_AHEAD", 20.0D, true), "a lava stop is never credited as ground gained");
		check(!WarpedForestHunt.arrived(true, "ARRIVED", 20.0D, false), "a walk that left the forest does not count");
		check(WarpedForestHunt.safetyStop("HOSTILE_NEAR") && !WarpedForestHunt.safetyStop("NO_ROUTE"), "safety stops and route failures are told apart");
		check(WarpedForestHunt.refusesWay("HOSTILE_NEAR") && WarpedForestHunt.refusesWay("TRAVEL_DAMAGED") && WarpedForestHunt.refusesWay("LAVA_AHEAD"),
				"a hostile, a hit or lava that way: not walked again");
		check(!WarpedForestHunt.refusesWay("LOW_HEALTH") && !WarpedForestHunt.refusesWay("ACTION_CANCELLED") && !WarpedForestHunt.refusesWay(null),
				"low health or a cancel says nothing about that way");
	}

	private static void verifyDestinations() {
		Vec3 start = new Vec3(0.5D, 70.0D, 0.5D);
		List<Vec3> searched = List.of(start);
		Vec3 near = new Vec3(20.5D, 70.0D, 0.5D), far = new Vec3(0.5D, 70.0D, -28.5D), tooClose = new Vec3(8.5D, 70.0D, 0.5D);
		check(WarpedForestHunt.choose(start, start, searched, List.of(), null, List.of(near, far)) == far, "the candidate farthest from searched ground");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), null, List.of(tooClose)) == null, "a point under 16 blocks away is not new ground");
		Vec3 outside = new Vec3(40.5D, 70.0D, 10.5D);
		check(WarpedForestHunt.choose(start, start, searched, List.of(), outside, List.of(near)) == outside, "an enderman seen outside the area comes first");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), new Vec3(120.5D, 70.0D, 0.5D), List.of()) == null, "nothing beyond 96 blocks of the start");
		check(WarpedForestHunt.choose(start, start, searched, List.of(far), null, List.of(far)) == null, "a destination whose walk failed is not tried again");
		check(WarpedForestHunt.choose(start, start, List.of(start, far), List.of(), null, List.of(far)) == null, "searched ground is not new ground");
		Vec3 south = WarpedForestHunt.headingPoint(start, 0);
		check(Math.abs(south.z - 20.5D) < 1.0E-9 && Math.abs(south.x - 0.5D) < 1.0E-9, "heading 0 is 20 blocks south");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), null, List.of(south)) == south, "an untried heading is walked when no floor is in sight");
		Vec3 ledge = new Vec3(40.5D, 76.0D, 10.5D), below = new Vec3(40.5D, 63.0D, 10.5D), level = new Vec3(40.5D, 73.5D, 10.5D);
		check(WarpedForestHunt.choose(start, start, searched, List.of(), ledge, List.of(far)) == far, "an enderman seen 6 blocks above the feet is on a ledge: not walked to");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), below, List.of(far)) == far, "one seen 7 blocks below is across a drop: not walked to");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), level, List.of(far)) == level, "one 3.5 blocks up on open ground is walked to");
	}

	private static void verifyLavaShoreKept() {
		Vec3 shore = new Vec3(10.5D, 70.0D, 0.5D);
		check(WarpedForestHunt.nearAny(new Vec3(18.5D, 70.0D, 4.5D), List.of(shore), WarpedForestHunt.LAVA_KEEP), "a destination 9 blocks from a lava stop is skipped");
		check(!WarpedForestHunt.nearAny(new Vec3(30.5D, 70.0D, 0.5D), List.of(shore), WarpedForestHunt.LAVA_KEEP), "one 20 blocks off is not");
		check(!WarpedForestHunt.nearAny(shore, List.of(), WarpedForestHunt.LAVA_KEEP), "no lava stops, nothing skipped");
	}

	private static void verifyDangerKept() {
		Vec3 start = new Vec3(0.5D, 70.0D, 0.5D);
		List<Vec3> searched = List.of(start);
		Vec3 near = new Vec3(20.5D, 70.0D, 0.5D), other = new Vec3(-20.5D, 70.0D, 0.5D);
		Vec3 skeleton = WarpedForestHunt.dangerAt("minecraft:wither_skeleton 4d7a6510-608f-4496-8bf9-3d1741b0fe4f 10.0 blocks away at 26.5,70.9,8.1, targeting you; at 18.5,70.0,0.5", start);
		check(Math.abs(skeleton.x - 26.5D) < 1.0E-9 && Math.abs(skeleton.z - 8.1D) < 1.0E-9, "the hostile's place is read from the travel receipt: " + skeleton);
		check(WarpedForestHunt.dangerAt("Took 1.9 damage", start) == start, "a hit with no named mob marks where the body stood");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), List.of(skeleton), null, List.of(near, other)) == other,
				"a destination within 24 blocks of where a hostile stopped a walk is skipped for one elsewhere");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), List.of(skeleton), null, List.of(near)) == null, "with only that one, no walk");
		check(WarpedForestHunt.choose(start, start, searched, List.of(), List.of(skeleton), new Vec3(30.5D, 70.0D, 4.5D), List.of(other)) == other,
				"an enderman seen beside that hostile is not walked to either");
	}

	private static void verifyWalkBackGoal() {
		Vec3 footing = new Vec3(10.5D, 64.0D, 0.5D), body = new Vec3(12.5D, 64.0D, 0.5D);
		Vec3 goal = WarpedForestHunt.past(footing, body);
		check(Math.abs(goal.x - 6.5D) < 1.0E-9 && Math.abs(goal.z - 0.5D) < 1.0E-9, "the walk back aims 4 blocks past the footing, away from the body: " + goal);
		check(WarpedForestHunt.flat(goal, body) > WarpedForestHunt.ARRIVE, "so travel cannot call it arrived from where the body stands");
	}

	private static void verifyLavaNear() {
		net.minecraft.core.BlockPos feet = new net.minecraft.core.BlockPos(0, 64, 0);
		net.minecraft.world.level.block.state.BlockState lava = net.minecraft.world.level.block.Blocks.LAVA.defaultBlockState();
		check(!WarpedForestHunt.lavaNear((x, y, z) -> null, feet), "nothing seen: no lava near");
		check(WarpedForestHunt.lavaNear((x, y, z) -> x == 2 && y == 62 && z == -1 ? lava : null, feet), "lava two blocks out and two down is near");
		check(!WarpedForestHunt.lavaNear((x, y, z) -> x == 3 && y == 64 && z == 0 ? lava : null, feet), "lava three blocks out is not");
		check(!WarpedForestHunt.lavaNear((x, y, z) -> x == 0 && y == 61 && z == 0 ? lava : null, feet), "lava three below is not");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
