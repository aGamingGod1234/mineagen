package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import java.util.ArrayList;
import java.util.List;
import net.minecraft.world.phys.AABB;

/**
 * The walk round a perched dragon to its head, on the four perched states where real End fights gave up (12 games from
 * one End save point): the body, the dragon's centre and its head, neck and wing boxes as the observation read them when
 * the fight ended NO_SEEN_ROUTE or TARGET_UNREACHABLE. Zones are built as DragonPerchSafety.zones builds them.
 */
public final class PerchRoundVerification {
	private static int assertions;

	private PerchRoundVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " perch walk-round assertions");
	}

	record PerchState(String name, double x, double feetY, double z, double centreX, double centreZ, AABB head, List<AABB> contacts) {
		DragonPerchSafety.Zones zones() { return new DragonPerchSafety.Zones(contacts, List.of()); }
		double headX() { return (head.minX + head.maxX) / 2.0D; }
		double headZ() { return (head.minZ + head.maxZ) / 2.0D; }
	}

	static PerchState state(String name, double x, double y, double z, double cx, double cz, double[]... boxes) {
		List<AABB> contacts = new ArrayList<>();
		AABB head = null;
		for (double[] b : boxes) {
			AABB box = new AABB(b[1], b[2], b[3], b[4], b[5], b[6]);
			if (b[0] == 2) contacts.add(box.inflate(4.0D, 2.0D, 4.0D).move(0.0D, -2.0D, 0.0D));
			else contacts.add(box.inflate(1.0D + DragonPerchSafety.SIDE_MARGIN, 1.0D, 1.0D + DragonPerchSafety.SIDE_MARGIN));
			if (b[0] == 0) head = box;
		}
		return new PerchState(name, x, y, z, cx, cz, head, contacts);
	}

	static final double HEAD = 0, NECK = 1, WING = 2;

	static double[] box(double kind, double... b) {
		return new double[] {kind, b[0], b[1], b[2], b[3], b[4], b[5]};
	}

	/** The bot stood behind the dragon; the model's fight aimed at the tail (3.9 above its eyes). */
	static final PerchState BEHIND = state("behind the tail", -20.45, 63.00, 1.31, 0.50, -0.27,
			box(WING, -1.62, 69.02, 2.23, 2.38, 71.02, 6.23), box(WING, -1.38, 69.02, -6.77, 2.62, 71.02, -2.77),
			box(NECK, 4.50, 66.02, -1.65, 7.50, 69.02, 1.35), box(HEAD, 6.50, 66.02, -0.63, 7.50, 67.02, 0.37));
	/** Far side of the fountain from the head: "no seen spot to stand within reach of it" after 5 s. */
	static final PerchState FAR_EAST = state("far side, east", 11.44, 64.00, 1.48, 1.26, 0.94,
			box(WING, 3.02, 69.43, 1.43, 7.02, 71.43, 5.43), box(NECK, -3.32, 66.43, 4.00, -0.32, 69.43, 7.00),
			box(HEAD, -2.88, 66.43, 5.83, -1.88, 67.43, 6.83), box(WING, -4.49, 69.43, -3.54, -0.49, 71.43, 0.46));
	static final PerchState FAR_SOUTHEAST = state("far side, south-east", 10.30, 63.00, -6.30, 1.27, 0.14,
			box(WING, 3.19, 69.44, -4.07, 7.19, 71.44, -0.07), box(NECK, -3.01, 66.44, -6.10, -0.01, 69.44, -3.10),
			box(HEAD, -2.51, 66.44, -5.97, -1.51, 67.44, -4.97), box(WING, -4.64, 69.44, 0.36, -0.64, 71.44, 4.36));
	static final PerchState SOUTH_LOW_HEAD = state("south, head low", 1.53, 64.00, -8.99, -0.09, 0.99,
			box(WING, 0.64, 68.89, -4.59, 4.64, 70.89, -0.59), box(NECK, 2.76, 65.89, 2.85, 5.76, 68.89, 5.85),
			box(HEAD, 4.55, 65.89, 4.47, 5.55, 66.89, 5.47), box(WING, -4.82, 68.89, 2.57, -0.82, 70.89, 6.57));

	public static int verify() {
		assertions = 0;
		for (PerchState state : List.of(BEHIND, FAR_EAST, FAR_SOUTHEAST, SOUTH_LOW_HEAD)) {
			walksRoundClear(state);
			walksRoundTickByTick(state);
		}
		// Once there, the head's ground has safe spots in reach (flat ground at the fountain's level, 63): the reach check
		// finds them as soon as it sees them. These are the two fights that ended "no seen spot ... out of sight".
		check(!safeReachCells(FAR_EAST, 63).isEmpty(), "far side, east: safe spots in reach of the head on its side");
		check(!safeReachCells(FAR_SOUTHEAST, 63).isEmpty(), "far side, south-east: safe spots in reach of the head on its side");
		// Known limit, pinned so a change to it is deliberate: with the head this low, the step margin over the standing body
		// leaves no safe spot in reach on flat ground; the walk round brings the body there and the check says unreachable.
		check(safeReachCells(BEHIND, 63).isEmpty(), "behind the tail: the head at 66.0 has no safe spot in reach under the step margin");
		check(safeReachCells(SOUTH_LOW_HEAD, 63).isEmpty(), "south, head low: no safe spot in reach under the step margin");
		alreadyOnTheHeadsSide();
		takesTheShortWay();
		noClearPointMeansNoWalk();
		aZoneOnTheWayDropsTheLeg();
		return assertions;
	}

	/** Each leg's point and chord clear every zone; the walk ends on the head's side within a few legs and 45 blocks. */
	static void walksRoundClear(PerchState s) {
		double x = s.x(), z = s.z(), walked = 0.0D;
		int legs = 0;
		DragonPerchSafety.Detour leg;
		while ((leg = DragonPerchSafety.roundToHead(s.zones(), x, s.feetY(), z, s.centreX(), s.centreZ(), s.headX(), s.headZ())) != null && legs < 20) {
			check(!s.zones().unsafe(leg.x(), s.feetY(), leg.z(), 0.3D) && DragonPerchSafety.clearChord(s.zones(), x, s.feetY(), z, leg.x(), leg.z()),
					s.name() + ": leg " + legs + " clears the head, neck and wings");
			walked += Math.hypot(leg.x() - x, leg.z() - z);
			x = leg.x();
			z = leg.z();
			legs++;
		}
		check(legs > 0, s.name() + ": the body starts away from the head's side and walks");
		check(gap(s, x, z) <= DragonPerchSafety.ROUND_ARRIVED + 1.0E-9, s.name() + ": the walk ends on the head's side (" + legs + " legs)");
		check(walked <= 45.0D, s.name() + ": the walk round is short (" + Math.round(walked) + " blocks)");
	}

	/** As the fight plays it: a quarter block a tick toward the held leg's point, asking again every tick. */
	static void walksRoundTickByTick(PerchState s) {
		double x = s.x(), z = s.z();
		DragonPerchSafety.Detour leg = null;
		int ticks = 0;
		boolean clear = true;
		for (; ticks < 800; ticks++) {
			leg = DragonPerchSafety.holdOrNext(leg, s.zones(), x, s.feetY(), z, s.centreX(), s.centreZ(), s.headX(), s.headZ());
			if (leg == null) break;
			double d = Math.hypot(leg.x() - x, leg.z() - z), step = Math.min(0.25D, d);
			x += (leg.x() - x) / d * step;
			z += (leg.z() - z) / d * step;
			clear &= !s.zones().unsafe(x, s.feetY(), z);
		}
		check(clear, s.name() + ": walked tick by tick, the body never stands in the head, neck or wings");
		check(gap(s, x, z) <= DragonPerchSafety.ROUND_ARRIVED + 1.0E-9, s.name() + ": tick by tick it still ends on the head's side (" + ticks + " ticks)");
	}

	static void alreadyOnTheHeadsSide() {
		PerchState s = FAR_EAST;
		double x = s.centreX() + (s.headX() - s.centreX()) * 2.0D, z = s.centreZ() + (s.headZ() - s.centreZ()) * 2.0D;
		check(DragonPerchSafety.roundToHead(s.zones(), x, s.feetY(), z, s.centreX(), s.centreZ(), s.headX(), s.headZ()) == null,
				"a body already out past the head does not walk round");
	}

	static void takesTheShortWay() {
		// Empty zones, head due north (+z) of the centre, body 60 degrees east of it: the next point turns west toward the head.
		DragonPerchSafety.Zones none = new DragonPerchSafety.Zones(List.of(), List.of());
		double a = Math.toRadians(60.0D);
		var leg = DragonPerchSafety.roundToHead(none, Math.sin(a) * 10.0D, 63.0D, Math.cos(a) * 10.0D, 0.0D, 0.0D, 0.0D, 7.0D);
		check(leg != null && Math.abs(Math.toDegrees(Math.atan2(leg.x(), leg.z())) - 35.0D) < 0.5D, "the walk turns 25 degrees the short way");
		check(Math.abs(Math.hypot(leg.x(), leg.z()) - (10.0D - DragonPerchSafety.ROUND_CLOSER)) < 1.0E-9, "with nothing in the way it closes in by its step");
		check(Math.abs(Math.toDegrees(leg.gap()) - 35.0D) < 0.5D, "the gap left is reported");
	}

	/** A breath landing across the held leg's path (not on its point) ends that leg at once. */
	static void aZoneOnTheWayDropsTheLeg() {
		DragonPerchSafety.Zones none = new DragonPerchSafety.Zones(List.of(), List.of());
		var held = DragonPerchSafety.roundToHead(none, 10.0D, 63.0D, 0.0D, 0.0D, 0.0D, 0.0D, 7.0D);
		double midX = (10.0D + held.x()) / 2.0D, midZ = held.z() / 2.0D;
		DragonPerchSafety.Zones breath = new DragonPerchSafety.Zones(List.of(), List.of(new DragonPerchSafety.Circle(midX, 63.0D, midZ, 1.0D)));
		check(!breath.unsafe(held.x(), 63.0D, held.z(), 0.3D), "the breath is clear of the leg's point");
		check(DragonPerchSafety.holdOrNext(held, breath, 10.0D, 63.0D, 0.0D, 0.0D, 0.0D, 0.0D, 7.0D) != held, "a breath across the way ends the held leg");
		check(DragonPerchSafety.holdOrNext(held, none, 10.0D, 63.0D, 0.0D, 0.0D, 0.0D, 0.0D, 7.0D) == held, "with the way clear the leg is held");
	}

	static void noClearPointMeansNoWalk() {
		DragonPerchSafety.Zones walled = new DragonPerchSafety.Zones(List.of(new AABB(-40, 60, -40, 40, 70, 40)), List.of());
		check(DragonPerchSafety.roundToHead(walled, 10.0D, 63.0D, 0.0D, 0.0D, 0.0D, -7.0D, 0.0D) == null, "no clear point: no walk");
	}

	static double gap(PerchState s, double x, double z) {
		double body = Math.atan2(x - s.centreX(), z - s.centreZ()), head = Math.atan2(s.headX() - s.centreX(), s.headZ() - s.centreZ());
		return Math.abs(Math.atan2(Math.sin(head - body), Math.cos(head - body)));
	}

	/** Cells (feet at {@code feetY}) outside the fountain's rim whose whole cell clears the zones and whose eyes reach the head box (3.0). */
	static List<GridPosition> safeReachCells(PerchState s, int feetY) {
		List<GridPosition> cells = new ArrayList<>();
		for (int x = -20; x <= 20; x++) {
			for (int z = -20; z <= 20; z++) {
				if (Math.hypot(x + 0.5D, z + 0.5D) < 4.0D) continue;
				GridPosition cell = new GridPosition(x, feetY, z);
				if (s.zones().unsafeCell(cell)) continue;
				net.minecraft.world.phys.Vec3 eye = new net.minecraft.world.phys.Vec3(x + 0.5D, feetY + MeleeReach.EYE_HEIGHT, z + 0.5D);
				if (Math.sqrt(s.head().distanceToSqr(eye)) <= 3.0D) cells.add(cell);
			}
		}
		return cells;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("PerchRoundVerification: " + message);
		assertions++;
	}
}
