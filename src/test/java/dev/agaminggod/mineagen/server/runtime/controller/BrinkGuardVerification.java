package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

public final class BrinkGuardVerification {
	private BrinkGuardVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " brink guard assertions");
	}

	public static int verify() {
		int assertions = 0;
		// A netherrack ledge (floor top y 64) for z <= 0. South of it (z >= 1) the ground drops: a lava sea at y 51 below
		// x >= 0, a stone floor at y 60 (a 4-block fall) below x == -1, a floor at y 54 (a 10-block fall) below x == -2,
		// and nothing at all below x == -3 (the void). Cells nobody has seen are at x == -4. A body centred at x + 0.5 is
		// over column x alone.
		WalkabilityView world = position -> {
			int x = position.x(), y = position.y(), z = position.z();
			if (x == -4 && z >= 1) return WalkabilityView.Cell.UNLOADED;
			if (z <= 0) return y <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			if (x >= 0) return y <= 51 ? WalkabilityView.Cell.HAZARD : WalkabilityView.Cell.CLEAR;
			if (x == -1) return y <= 59 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			if (x == -2) return y <= 53 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			return WalkabilityView.Cell.CLEAR;
		};
		BrinkGuard.VoidProbe voids = (x, y, z) -> x == -3 && z >= 1;
		BrinkGuard.Fall lava = BrinkGuard.fall(world, body(0.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(lava != null && lava.below().equals("lava") && lava.drop() == 12, "a body over the lava sea falls 12 blocks into lava");
		assertions++;
		check(BrinkGuard.fall(world, body(0.0D, 1.5D), -64, voids, 0.0D, 20.0D) == null,
				"a box half over the 4-block floor lands there first: the lava beside it is below the landing");
		assertions++;
		check(BrinkGuard.fall(world, body(-0.5D, 1.5D), -64, voids, 0.0D, 20.0D) == null, "a 4-block fall is no reason to refuse a step");
		assertions++;
		check(BrinkGuard.fall(world, body(-1.5D, 1.5D), -64, voids, 0.0D, 20.0D) == null, "a 10-block fall at full health is survivable");
		assertions++;
		BrinkGuard.Fall deep = BrinkGuard.fall(world, body(-1.5D, 1.5D), -64, voids, 0.0D, 6.0D);
		check(deep != null && deep.below().equals("drop") && deep.drop() == 10, "a 10-block fall (7 damage) kills a body with 6 health");
		assertions++;
		check(BrinkGuard.fall(world, body(-1.5D, 1.5D), -64, voids, 2.0D, 8.0D) != null, "a fall already under way adds to the landing's damage");
		assertions++;
		BrinkGuard.Fall nothing = BrinkGuard.fall(world, body(-2.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(nothing != null && nothing.below().equals("void"), "an empty column to the world's bottom is the void");
		assertions++;
		BrinkGuard.Fall unseen = BrinkGuard.fall(world, body(-3.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(unseen != null && unseen.unknown(), "a column nobody has seen is a drop of unknown depth, not a known lethal one");
		assertions++;
		check(BrinkGuard.fall(world, body(0.5D, -0.5D), -64, voids, 0.0D, 20.0D) == null, "standing on the ledge falls nowhere");
		assertions++;
		WalkabilityView vines = position -> position.z() >= 1 && position.y() >= 68 && position.y() <= 70
				? WalkabilityView.Cell.CLIMBABLE : world.cellAt(position);
		BrinkGuard.Fall underVines = BrinkGuard.fall(vines, body(0.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(underVines != null && underVines.below().equals("lava"),
				"hanging vines above lava are not a supported landing when the walking body releases its keys");
		assertions++;
		// Fire on a floor two blocks down burns as lava does; a hot floor (magma) does not count.
		WalkabilityView fire = position -> position.y() <= 61 ? WalkabilityView.Cell.SAFE_SUPPORT
				: position.y() == 62 && position.z() >= 1 ? WalkabilityView.Cell.HAZARD : position.z() <= 0 && position.y() <= 63
				? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		BrinkGuard.Fall burning = BrinkGuard.fall(fire, body(0.5D, 1.5D), -64, voids, 0.0D, 20.0D);
		check(burning != null && burning.drop() == 1, "an unknown hazard state below is counted as burning");
		assertions++;

		check(BrinkGuard.levelFooting(world, 0.5D, 64.0D, -0.5D, new double[]{0, -1}), "a brace can lean inward on known level floor");
		check(!BrinkGuard.levelFooting(world, -0.5D, 64.0D, -0.5D, new double[]{0, 1}), "a brace refuses even a survivable drop off this level");
		check(!BrinkGuard.levelFooting(world, -3.5D, 64.0D, -0.5D, new double[]{0, 1}), "a brace cannot lean onto unseen footing");
		assertions += 3;

		// A jump's reach: a sprint jump from a standstill covers about 3 to 4 blocks, a walking one about 2, a standing
		// one with no keys none (a pillar jump), so the landing judged is where the body would come down.
		double[] east = {1.0D, 0.0D}, still = {0.0D, 0.0D};
		double sprintJump = BrinkGuard.jumpDisplacement(0.0D, 0.0D, east, true, BrinkGuard.JUMP_AIR_TICKS)[0];
		double walkJump = BrinkGuard.jumpDisplacement(0.0D, 0.0D, east, false, BrinkGuard.JUMP_AIR_TICKS)[0];
		check(sprintJump > 3.0D && sprintJump < 4.5D, "a standing sprint jump lands 3 to 4.5 blocks on: " + sprintJump);
		check(walkJump > 1.5D && walkJump < sprintJump, "a walking jump lands short of a sprint jump: " + walkJump);
		double[] up = BrinkGuard.jumpDisplacement(0.0D, 0.0D, still, false, BrinkGuard.JUMP_AIR_TICKS);
		check(up[0] == 0.0D && up[1] == 0.0D, "a jump with no keys and no motion comes down where it took off");
		// A hit's hop (vanilla knockback 0.4 out, 0.36 up after the first tick) carries a keyless body 2 to 3 blocks: the
		// landing the shove walk-back judges.
		double hop = BrinkGuard.shoveDisplacement(0.4D, 0.36D, 0.0D, 0.0D)[0];
		check(hop > 2.0D && hop < 3.2D, "a knockback hop lands 2 to 3.2 blocks out: " + hop);
		assertions += 4;

		var inward = BrinkGuard.bracePoint(world, 0.5D, 64, -0.5D);
		check(inward != null && inward.z < -0.5D && inward.y == 64, "a brace gains room on its deck before a shove");
		assertions++;

		for (float yaw : new float[]{0.0F, 90.0F, -135.0F, 180.0F, 33.0F}) {
			for (int index = 0; index < 8; index++) {
				double angle = Math.PI / 4.0D * index, dx = Math.cos(angle), dz = Math.sin(angle);
				float[] keys = BrinkGuard.keysToward(yaw, dx, dz);
				check(Math.abs(keys[0]) <= 1.0F && Math.abs(keys[1]) <= 1.0F && (keys[0] != 0.0F || keys[1] != 0.0F), "keys are keyboard keys");
				double[] heading = BrinkGuard.worldHeading(yaw, keys[0], keys[1]);
				check(heading[0] * dx + heading[1] * dz > Math.cos(Math.toRadians(23.0D)), "keys move within 22.5 degrees of the wanted heading");
				assertions += 2;
			}
		}
		double[] south = BrinkGuard.worldHeading(0.0F, 1.0F, 0.0F);
		check(Math.abs(south[0]) < 1.0E-9D && south[1] > 0.99D, "yaw 0 forward walks south (+z)");
		assertions++;
		double[] left = BrinkGuard.worldHeading(0.0F, 0.0F, 1.0F);
		check(left[0] > 0.99D, "yaw 0 strafe left walks east (+x), as vanilla's xxa");
		assertions++;
		return assertions + verifyWallInFooting() + verifyIdleHandoff() + verifyHandoffGuardComposition()
				+ dev.agaminggod.mineagen.server.runtime.input.BrinkGuardIngressVerification.verify();
	}

	private static int verifyIdleHandoff() {
		int assertions = 0;
		Object level = new Object();
		// Both the observed fast source and an already low-speed crouched source must seed the same handoff.
		for (double source : new double[]{0.054709971435436947D, 0.030708240645276552D, 0.01D, 0.0D}) {
			BrinkGuard.IdleHandoff handoff = new BrinkGuard.IdleHandoff();
			check(!handoff.hold(BrinkGuard.InputPresence.CONTROL, level, 100, true, false, source, 0),
					"a leased frame never receives inherited crouch");
			handoff.applied(BrinkGuard.InputPresence.CONTROL, true, true);
			int tick = 101;
			for (double speed : new double[]{0.02507D, 0.019D, 0.003D, 0.0001D, 1.0E-12D}) {
				check(handoff.hold(BrinkGuard.InputPresence.NONE, level, tick++, true, true, 0, -speed),
						"no winner retains crouch through residual motion, including below SETTLED_SPEED");
				handoff.applied(BrinkGuard.InputPresence.NONE, true, true);
				assertions++;
			}
			check(!handoff.hold(BrinkGuard.InputPresence.NONE, level, tick++, true, true, 0, -0.0D),
					"vanilla-zeroed horizontal motion ends the handoff");
			handoff.applied(BrinkGuard.InputPresence.NONE, true, true);
			check(!handoff.hold(BrinkGuard.InputPresence.NONE, level, tick, true, true, 0.01D, 0),
					"idle guard crouch after settling does not rearm a completed handoff");
			assertions += 3;
		}
		for (BrinkGuard.InputPresence intent : new BrinkGuard.InputPresence[]{BrinkGuard.InputPresence.CONTROL, BrinkGuard.InputPresence.ACTION}) {
			BrinkGuard.IdleHandoff handoff = armedHandoff(level);
			check(!handoff.hold(intent, level, 101, true, true, 0.02507D, 0),
					"authored idle/no-sneak, a jump or a click supersedes the previous crouch");
			handoff.applied(intent, true, false);
			check(!handoff.hold(BrinkGuard.InputPresence.NONE, level, 102, true, true, 0.01D, 0),
					"releasing new upright intent never revives the old crouch");
			assertions += 2;
		}
		for (int condition = 0; condition < 7; condition++) {
			BrinkGuard.IdleHandoff handoff = armedHandoff(level);
			boolean held = switch (condition) {
				case 0 -> handoff.hold(BrinkGuard.InputPresence.NONE, level, 101, false, true, .01D, 0);
				case 1 -> handoff.hold(BrinkGuard.InputPresence.NONE, level, 101, true, false, .01D, 0);
				case 2 -> handoff.hold(BrinkGuard.InputPresence.NONE, level, 103, true, true, .01D, 0);
				case 3 -> handoff.hold(BrinkGuard.InputPresence.NONE, new Object(), 101, true, true, .01D, 0);
				case 4 -> handoff.hold(BrinkGuard.InputPresence.NONE, level, 101, true, true, Double.NaN, 0);
				case 5 -> handoff.hold(BrinkGuard.InputPresence.NONE, level, 101, true, true, 0, Double.POSITIVE_INFINITY);
				default -> {
					handoff.clear(); // operator takeover or a new binding before the next tick
					yield handoff.hold(BrinkGuard.InputPresence.NONE, level, 101, true, true, .01D, 0);
				}
			};
			check(!held, "lifecycle, ineligible footing, deliberate keys and invalid motion clear the handoff: " + condition);
			check(!handoff.hold(BrinkGuard.InputPresence.NONE, level, 104, true, true, .01D, 0),
					"an interrupted handoff stays cleared");
			assertions += 2;
		}
		for (BrinkGuard.InputPresence input : BrinkGuard.InputPresence.values()) {
			BrinkGuard.IdleHandoff handoff = new BrinkGuard.IdleHandoff();
			handoff.hold(input, level, 100, true, true, .01D, 0);
			handoff.applied(input, true, false);
			check(!handoff.hold(BrinkGuard.InputPresence.NONE, level, 101, true, true, .01D, 0),
					"an upright frame never seeds a handoff");
			assertions++;
		}
		BrinkGuard.IdleHandoff mining = new BrinkGuard.IdleHandoff();
		mining.hold(BrinkGuard.InputPresence.ACTION, level, 100, true, true, .02507D, 0);
		mining.applied(BrinkGuard.InputPresence.ACTION, true, true);
		check(mining.hold(BrinkGuard.InputPresence.NONE, level, 101, true, true, .02507D, 0),
				"review R2: final attack-bearing crouched construction frame seeds later idle coast");
		assertions++;
		BrinkGuard.IdleHandoff airborne = new BrinkGuard.IdleHandoff();
		airborne.hold(BrinkGuard.InputPresence.CONTROL, level, 100, false, false, .01D, 0);
		airborne.applied(BrinkGuard.InputPresence.CONTROL, false, true);
		check(!airborne.hold(BrinkGuard.InputPresence.NONE, level, 101, true, true, .01D, 0),
				"an ineligible or airborne source cannot seed a grounded handoff");
		BrinkGuard.IdleHandoff observed = armedHandoff(level);
		check(observed.hold(BrinkGuard.InputPresence.NONE, level, 101, true, true,
				0.000342001153298715D, -0.02507453419288768D), "the retained observation's two-component velocity keeps crouch");
		check(observed.hold(BrinkGuard.InputPresence.NONE, level, 102, true, true, 1.0E-12D, 0),
				"zero on one axis alone does not end the coast");
		return assertions + 3;
	}

	private static int verifyHandoffGuardComposition() {
		BrinkGuard.Keys idle = new BrinkGuard.Keys(0, 0, false, false);
		check(BrinkGuard.handoffKeys(idle, false) == idle, "no handoff preserves the guard result");
		check(BrinkGuard.handoffKeys(idle, true).sneak(), "idle coast gains only sneak");
		BrinkGuard.Keys[] defensive = {
				new BrinkGuard.Keys(-1, 0, false, true),
				new BrinkGuard.Keys(0, 1, false, true),
				new BrinkGuard.Keys(0, 0, false, true, false, true),
				new BrinkGuard.Keys(0, 0, false, true, true, false),
				new BrinkGuard.Keys(0, 0, true, true)
		};
		for (BrinkGuard.Keys keys : defensive) check(BrinkGuard.handoffKeys(keys, true) == keys,
				"parent finding: inherited crouch never replaces shove steering, shield lowering or jump refusal");
		return 2 + defensive.length;
	}

	private static BrinkGuard.IdleHandoff armedHandoff(Object level) {
		BrinkGuard.IdleHandoff handoff = new BrinkGuard.IdleHandoff();
		handoff.hold(BrinkGuard.InputPresence.CONTROL, level, 100, true, false, .01D, 0);
		handoff.applied(BrinkGuard.InputPresence.CONTROL, true, true);
		return handoff;
	}

	/**
	 * NE-LAVA-1: defend's wall-in stands still under a blaze's fire. A fortress bridge three wide (z -1..1, floor top y 64)
	 * over a 40-block drop into the lava sea refuses its edge columns and allows its middle; a one-wide bridge refuses
	 * everywhere; the same floor between walls (a corridor) allows every column. The inland stand from an edge column is
	 * the bridge's middle, and a one-wide bridge has none.
	 */
	private static int verifyWallInFooting() {
		WalkabilityView bridge = deck(1, false), narrow = deck(0, false), corridor = deck(1, true);
		BrinkGuard.VoidProbe noVoid = (x, y, z) -> false;
		check(brink(bridge, noVoid, 0.5D, 1.5D) != null, "a 3-wide bridge's edge column has the lava sea within a shove");
		BrinkGuard.Fall edge = brink(bridge, noVoid, 0.5D, -0.5D);
		check(edge != null && !edge.unknown(), "the other edge column too, and the drop is a known lethal one: " + edge);
		check(brink(bridge, noVoid, 0.5D, 0.5D) == null, "the middle of a 3-wide bridge is 1.2 blocks from either lip: no brink in a shove");
		check(brink(narrow, noVoid, 0.5D, 0.5D) != null, "a 1-wide bridge has the drop on both sides");
		for (double z : new double[]{-0.5D, 0.5D, 1.5D}) check(brink(corridor, noVoid, 0.5D, z) == null, "a corridor floor column " + z + " is walled: no brink");
		WalkabilityView unseen = position -> position.y() < 63 ? WalkabilityView.Cell.UNLOADED : bridge.cellAt(position);
		BrinkGuard.Fall blind = brink(unseen, noVoid, 0.5D, 1.5D);
		check(blind != null && blind.unknown(), "an edge whose bottom was never seen counts as a brink too");
		Vec3 inland = BrinkGuard.inlandStand(bridge, 0.5D, 64.0D, 1.5D, 3, at -> brink(bridge, noVoid, at.x, at.z) == null);
		check(inland != null && Math.abs(inland.z - 0.5D) < 1.0E-6D && Math.abs(inland.x - 0.5D) < 1.0E-6D,
				"from an edge column the inland stand is the bridge's middle, the nearest cell: " + inland);
		check(BrinkGuard.inlandStand(narrow, 0.5D, 64.0D, 0.5D, 3, at -> brink(narrow, noVoid, at.x, at.z) == null) == null,
				"a 1-wide bridge has no stand off its brink: the body braces in place");
		return 9;
	}

	/** A deck at floor top y 64 for |z| <= half, a lava sea at y 24 and below; with walls, solid at |z| == half + 1 up to y 66. */
	private static WalkabilityView deck(int half, boolean walls) {
		return position -> {
			int y = position.y(), z = Math.abs(position.z());
			if (z <= half && y == 63) return WalkabilityView.Cell.SAFE_SUPPORT;
			if (walls && z == half + 1 && y >= 63 && y <= 66) return WalkabilityView.Cell.SAFE_SUPPORT;
			if (y <= 23) return WalkabilityView.Cell.HAZARD;
			return WalkabilityView.Cell.CLEAR;
		};
	}

	private static BrinkGuard.Fall brink(WalkabilityView world, BrinkGuard.VoidProbe voids, double x, double z) {
		java.util.function.Predicate<AABB> blocked = box -> !columns(box).stream().allMatch(c ->
				CombatPlanning.open(world, new GridPosition(c[0], 64, c[1])) && CombatPlanning.open(world, new GridPosition(c[0], 65, c[1])));
		java.util.function.Predicate<AABB> unsupported = box -> columns(box).stream().noneMatch(c -> {
			WalkabilityView.Cell below = world.cellAt(new GridPosition(c[0], 63, c[1]));
			return below == WalkabilityView.Cell.SAFE_SUPPORT || below == WalkabilityView.Cell.BLOCKED;
		});
		return BrinkGuard.brinkWithin(body(x, z), BrinkGuard.BRACE_STEPS, blocked, unsupported,
				box -> BrinkGuard.fall(world, box, -64, voids, 0.0D, 20.0D));
	}

	private static java.util.List<int[]> columns(AABB box) {
		java.util.List<int[]> columns = new java.util.ArrayList<>();
		for (int x = (int) Math.floor(box.minX + 1.0E-7D); x <= (int) Math.floor(box.maxX - 1.0E-7D); x++)
			for (int z = (int) Math.floor(box.minZ + 1.0E-7D); z <= (int) Math.floor(box.maxZ - 1.0E-7D); z++) columns.add(new int[]{x, z});
		return columns;
	}

	private static AABB body(double x, double z) {
		return new AABB(x - 0.3D, 64.0D, z - 0.3D, x + 0.3D, 65.8D, z + 0.3D);
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
	}
}
