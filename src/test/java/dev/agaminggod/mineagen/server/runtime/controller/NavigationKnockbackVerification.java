package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.PathNode;
import dev.agaminggod.mineagen.client.navigation.TraversalType;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import java.lang.reflect.Field;
import java.lang.reflect.Method;
import java.util.Set;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.phys.Vec3;

/**
 * The knockback margin in non-combat walks (issue 2, K9), without a server: a walk that would step beside lava or a
 * damaging drop with a mob within knockback range waits, briefly, unless it already stands on such an edge.
 */
public final class NavigationKnockbackVerification {
	private static final GridPosition FEET = new GridPosition(0, 64, 0);
	private static final CombatPlanning.Margin NEAR = new CombatPlanning.Margin(true, Set.of());
	/** Lava along z 1 from x 1 to 9, one block below the walking level: the rim the fight's margin test uses. */
	private static final WalkabilityView RIM = position -> {
		if (position.z() == 1 && position.x() >= 1 && position.x() <= 9 && position.y() == 63) return WalkabilityView.Cell.HAZARD;
		return position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
	};
	private static int assertions;

	private NavigationKnockbackVerification() {
	}

	public static void main(String[] args) throws Exception {
		System.out.println("PASS: " + verify() + " navigation knockback assertions");
	}

	public static int verify() throws Exception {
		assertions = 0;
		holdsShortOfTheLavaRim();
		walksOnWithNoMobNear();
		holdIsBounded();
		walksOnOffAnEdgeItStandsOn();
		walksOnOutOfAHazard();
		holdsOnlyBeforeAWalkingStep();
		holdsShortOfADamagingDrop();
		walksOnBesideWater();
		onlyPickUpItemsOwnWalkOptsIn();
		holdsAreSharedAcrossAnActionsWalks();
		pickupCreditStaysWithinTheTimeout();
		onlyTravelsForwardLegsOptIn();
		return assertions;
	}

	private static void holdsShortOfTheLavaRim() {
		CombatPlanning.Refusal refusal = ServerNavigationController.knockbackRefusal(RIM, FEET, walk(1, 64, 0), NEAR);
		check(refusal != null && refusal.kind() == CombatPlanning.RefusalKind.HAZARD && refusal.at().equals(new GridPosition(1, 63, 1)),
				"with a mob within 3 blocks the step onto the lava rim waits and names the lava: " + refusal);
		check(ServerNavigationController.knockbackRefusal(RIM, FEET, walk(-1, 64, 0), NEAR) == null, "a step away from the lava goes on");
	}

	private static void walksOnWithNoMobNear() {
		check(ServerNavigationController.knockbackRefusal(RIM, FEET, walk(1, 64, 0), CombatPlanning.Margin.NONE) == null,
				"with no mob near, the route walks the rim as before");
	}

	private static void holdIsBounded() {
		KnockbackHolds approach = new KnockbackHolds();
		int held = 0;
		for (int tick = 0; tick < 200; tick++) if (approach.observe(true, true)) held++;
		check(held == KnockbackHolds.APPROACH_TICKS && held == 40, "one mob that stays near holds 2 s, then the hold ends: " + held);
		check(approach.holds() == 1, "that is one hold");
		KnockbackHolds hovering = new KnockbackHolds();
		held = 0;
		for (int round = 0; round < 20; round++) {
			for (int tick = 0; tick < 30; tick++) if (hovering.observe(true, true)) held++;
			hovering.observe(false, false);
		}
		check(held == KnockbackHolds.WALK_TICKS && hovering.heldTicks() == 100, "a mob stepping in and out of range holds one action 5 s in all: " + held);
		check(KnockbackHolds.WALK_TICKS < TravelStallWatch.WINDOW_TICKS, "the action's total stays under travel's stall window ("
				+ TravelStallWatch.WINDOW_TICKS + " ticks)");
		KnockbackHolds idle = new KnockbackHolds();
		check(!idle.observe(true, false) && !idle.observe(false, true) && idle.holds() == 0, "no refusal or no mob, no hold");
	}

	private static void walksOnOffAnEdgeItStandsOn() {
		GridPosition onRim = new GridPosition(2, 64, 0);
		check(ServerNavigationController.exposedBeside(RIM, onRim), "beside the lava at x 2 the body already stands on the edge");
		check(ServerNavigationController.knockbackRefusal(RIM, onRim, walk(3, 64, 0), NEAR) == null,
				"standing on the edge, the walk goes on along it rather than waiting there");
		check(!ServerNavigationController.exposedBeside(RIM, FEET), "at x 0 nothing is beside the feet");
	}

	/** Standing in fire or on magma beside the rim's next step: walking on gets the body out, so the step is not held. */
	private static void walksOnOutOfAHazard() {
		WalkabilityView fireAtFeet = position -> position.equals(FEET) ? WalkabilityView.Cell.HAZARD : RIM.cellAt(position);
		WalkabilityView magmaUnderFeet = position -> position.equals(FEET.below()) ? WalkabilityView.Cell.HAZARD : RIM.cellAt(position);
		for (WalkabilityView world : new WalkabilityView[] {fireAtFeet, magmaUnderFeet}) {
			check(CombatPlanning.routeMarginRefusal(world, FEET, new GridPosition(1, 64, 0), TraversalType.WALK, NEAR) != null
					&& !ServerNavigationController.exposedBeside(world, FEET), "the fixture's margin refuses the step and nothing is beside the feet");
			check(ServerNavigationController.inHazardCell(world, FEET), "the feet cell or the block under it is a hazard");
			check(ServerNavigationController.knockbackRefusal(world, FEET, walk(1, 64, 0), NEAR) == null, "a body in or on a hazard walks on");
		}
		check(!ServerNavigationController.inHazardCell(RIM, FEET), "the rim's own feet cell is no hazard");
	}

	private static void holdsOnlyBeforeAWalkingStep() {
		for (TraversalType traversal : new TraversalType[] {TraversalType.JUMP_GAP, TraversalType.DROP_DOWN, TraversalType.JUMP_UP}) {
			check(ServerNavigationController.knockbackRefusal(RIM, FEET, new PathNode(new GridPosition(1, 64, 0), traversal), NEAR) == null,
					"a " + traversal + " is never held mid-way");
		}
	}

	private static void holdsShortOfADamagingDrop() {
		WalkabilityView ravine = position -> {
			if (position.z() == 1 && position.x() >= 1) return position.y() <= 50 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
			return position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		CombatPlanning.Refusal refusal = ServerNavigationController.knockbackRefusal(ravine, FEET, walk(1, 64, 0), NEAR);
		check(refusal != null && refusal.kind() == CombatPlanning.RefusalKind.DROP, "the step along a ravine lip waits: " + refusal);
	}

	private static void walksOnBesideWater() {
		WalkabilityView pond = position -> {
			if (position.z() == 1 && position.x() >= 1 && position.y() >= 55 && position.y() <= 63) return WalkabilityView.Cell.WATER;
			return position.y() <= 63 ? WalkabilityView.Cell.SAFE_SUPPORT : WalkabilityView.Cell.CLEAR;
		};
		check(ServerNavigationController.knockbackRefusal(pond, FEET, walk(1, 64, 0), NEAR) == null, "a knock into water does no harm, so the walk goes on");
	}

	/** A fight's or barter's drop pickup walks through the same factory; only pick_up_item's own walk keeps the margin. */
	private static void onlyPickUpItemsOwnWalkOptsIn() throws Exception {
		check(holdsOf(pickupWalk(null)) == null, "the shared pickup walk does not hold");
		KnockbackHolds holds = new KnockbackHolds();
		check(holdsOf(pickupWalk(holds)) == holds, "pick_up_item's own walk holds on the pickup's holds");
		check(holdsOf(new ServerNavigationController(new Vec3(4.5D, 64.0D, 0.5D), 0.3D, false, 0L, 10_000L, false)) == null,
				"a walk that does not opt in never holds");
	}

	/** The drop moved, so pick_up_item planned a second walk: it spends what the first walk left, not a fresh 5 s. */
	private static void holdsAreSharedAcrossAnActionsWalks() throws Exception {
		KnockbackHolds holds = new KnockbackHolds();
		check(holdsOf(pickupWalk(holds)) == holds && holdsOf(pickupWalk(holds)) == holds, "both walks of one pickup hold on the same holds");
		int held = 0;
		for (int approach = 0; approach < 4; approach++) {
			for (int tick = 0; tick < KnockbackHolds.APPROACH_TICKS; tick++) if (holds.observe(true, true)) held++;
			holds.observe(false, false);
		}
		check(held == KnockbackHolds.WALK_TICKS && holds.heldMs() == 5_000L, "four approaches on the shared holds hold 5 s in all: " + held);
		check(!holds.mayHold() && !holds.observe(true, true), "after that no walk of the action holds again");
	}

	/** Held time is credited to pick_up_item's walk limit only up to its timeout, so the pickup's own timeout still fires first. */
	private static void pickupCreditStaysWithinTheTimeout() {
		check(PickupBudget.heldCreditMs(2_000L, 10_000L, 30_000L) == 2_000L, "with room under the timeout all held time is credited");
		check(PickupBudget.heldCreditMs(5_000L, 28_000L, 30_000L) == 2_000L, "the credit stops at the timeout");
		check(PickupBudget.heldCreditMs(5_000L, 30_000L, 30_000L) == 0L, "a walk limit at the timeout gets no credit");
		check(PickupBudget.heldCreditMs(0L, 10_000L, 30_000L) == 0L, "no hold, no credit");
	}

	/**
	 * travel_to opts its trip in; only legs toward a picked checkpoint or detour hold, on the trip's one set of holds. Lava
	 * retreat and drop legs start through startLeg, and a trip another controller builds (drop collection, ledge fetch,
	 * retrace) never opts in.
	 */
	private static void onlyTravelsForwardLegsOptIn() throws Exception {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		check(field(trip(), "knockbackHolds") == null, "a trip that does not opt in has no knockback holds");
		ServerTravelController trip = trip().keepsKnockbackMargin();
		KnockbackHolds holds = (KnockbackHolds) field(trip, "knockbackHolds");
		check(holds != null, "travel_to's trip has knockback holds");
		ServerPlayer body = body();
		GridPosition ahead = new GridPosition(5, 64, 0);
		Method forward = ServerTravelController.class.getDeclaredMethod("startForwardLeg", ServerPlayer.class, GridPosition.class, long.class);
		Method leg = ServerTravelController.class.getDeclaredMethod("startLeg", ServerPlayer.class, GridPosition.class, long.class);
		Method retreat = ServerTravelController.class.getDeclaredMethod("startLeg", ServerPlayer.class, GridPosition.class, long.class, double.class);
		for (Method method : new Method[] {forward, leg, retreat}) method.setAccessible(true);
		forward.invoke(trip, body, ahead, 0L);
		check(holdsOf((ServerNavigationController) field(trip, "leg")) == holds, "a forward leg holds on the trip's holds");
		forward.invoke(trip, body, ahead, 50L);
		check(holdsOf((ServerNavigationController) field(trip, "leg")) == holds, "the next forward leg holds on the same holds");
		leg.invoke(trip, body, ahead, 100L);
		check(holdsOf((ServerNavigationController) field(trip, "leg")) == null, "a leg started through startLeg (drop legs) has no holds");
		retreat.invoke(trip, body, ahead, 150L, ServerTravelController.RETREAT_TOLERANCE);
		check(holdsOf((ServerNavigationController) field(trip, "leg")) == null, "a leg started through startLeg with the retreat tolerance has no holds");
	}

	private static ServerTravelController trip() {
		return new ServerTravelController(20.5D, 64.0D, 0.5D, 3.0D, 60_000L, false, null, null, (player, cell) -> false, 0L);
	}

	/** A body with only a position: startLeg reads nothing else. */
	private static ServerPlayer body() throws Exception {
		Field singleton = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
		singleton.setAccessible(true);
		sun.misc.Unsafe unsafe = (sun.misc.Unsafe) singleton.get(null);
		LegPlayer body = (LegPlayer) unsafe.allocateInstance(LegPlayer.class);
		unsafe.putObject(body, unsafe.objectFieldOffset(Entity.class.getDeclaredField("position")), new Vec3(0.5D, 64.0D, 0.5D));
		return body;
	}

	private static final class LegPlayer extends dev.agaminggod.mineagen.compat.TestServerPlayerBase {
		private LegPlayer() {
			super(null, null, null, null);
		}
	}

	private static ServerNavigationController pickupWalk(KnockbackHolds holds) {
		return ServerItemPickupController.walk(new Vec3(4.5D, 64.0D, 0.5D), new net.minecraft.world.phys.AABB(3, 64, 0, 5, 65, 1), 0L, 30_000L, 0,
				false, false, 64.0D, holds);
	}

	private static KnockbackHolds holdsOf(ServerNavigationController walk) throws ReflectiveOperationException {
		return (KnockbackHolds) field(walk, "knockbackHolds");
	}

	private static Object field(Object target, String name) throws ReflectiveOperationException {
		Field field = target.getClass().getDeclaredField(name);
		field.setAccessible(true);
		return field.get(target);
	}

	private static PathNode walk(int x, int y, int z) {
		return new PathNode(new GridPosition(x, y, z), TraversalType.WALK);
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("NavigationKnockbackVerification: " + message);
		assertions++;
	}
}
