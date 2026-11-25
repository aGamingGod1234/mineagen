package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.LocalPathfinder;
import dev.agaminggod.mineagen.client.navigation.PathNode;
import dev.agaminggod.mineagen.client.navigation.PathOutcome;
import dev.agaminggod.mineagen.client.navigation.PathPlan;
import dev.agaminggod.mineagen.client.navigation.TraversalType;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;

/**
 * A shielded blaze fight walks to a seen spot in sword reach one block up or down, as a player does, instead of holding
 * its deck for a blaze that never comes nearer. The scenes are the fortress states where real games timed out with the
 * body idle beside seen hit spots, and the ones where holding is still right.
 */
public final class BlazeApproachVerification {
	private static int assertions;

	private BlazeApproachVerification() {
	}

	public static int verify() {
		assertions = 0;
		verifyStepDownToHitSpot();
		verifyStepUpToHitSpot();
		verifyStillHolds();
		verifyStepDecisions();
		return assertions;
	}

	/** Blocks by feet cell; anything not listed is open air over a deep drop. */
	private static final class Scene {
		final Map<GridPosition, WalkabilityView.Cell> cells = new HashMap<>();

		/** A floor cell: solid block under feet that are clear with headroom. */
		Scene floor(int x, int feetY, int z) {
			cells.put(new GridPosition(x, feetY - 1, z), WalkabilityView.Cell.SAFE_SUPPORT);
			return this;
		}

		Scene solid(int x, int y, int z) {
			cells.put(new GridPosition(x, y, z), WalkabilityView.Cell.SAFE_SUPPORT);
			return this;
		}

		Scene blocked(int x, int y, int z) {
			cells.put(new GridPosition(x, y, z), WalkabilityView.Cell.BLOCKED);
			return this;
		}

		ObservedTerrain view(int deckY, int band) {
			ObservedTerrain.Known known = p -> cells.getOrDefault(p, WalkabilityView.Cell.CLEAR);
			return new ObservedTerrain(known, null).onLevel(deckY, band);
		}
	}

	private static PathPlan plan(ObservedTerrain view, GridPosition start, Set<GridPosition> goals) {
		// Set.of iterates in a per-run order: aim the search at a fixed goal so every run plans the same route.
		GridPosition aim = goals.stream().min(java.util.Comparator.comparingInt(GridPosition::x)
				.thenComparingInt(GridPosition::y).thenComparingInt(GridPosition::z)).orElseThrow();
		LocalPathfinder.Search search = new LocalPathfinder().beginSearch(start, goals, aim, 8, Set.of());
		PathPlan plan = null;
		for (int slice = 0; slice < 50 && !search.finished(); slice++) {
			plan = search.advance(view, new LocalPathfinder.SearchBudget(4096, Long.MAX_VALUE / 4, () -> 0L));
		}
		return plan;
	}

	/** The route's only node off the deck's level that follows a node on it, or null; the route stays within one block. */
	private static PathNode levelStep(PathPlan plan, int deckY) {
		List<PathNode> nodes = plan.nodes();
		PathNode step = null;
		for (int i = 1; i < nodes.size(); i++) {
			int y = nodes.get(i).position().y();
			if (Math.abs(y - deckY) > BlazeApproach.LEVEL_BAND) return null;
			if (y != deckY && nodes.get(i - 1).position().y() == deckY) {
				if (step != null) return null;
				step = nodes.get(i);
			}
		}
		return step;
	}

	private static boolean found(PathPlan plan) {
		return plan != null && plan.outcome() == PathOutcome.FOUND;
	}

	/**
	 * Blaze 1.0 below and 3.6 blocks off, a blackstone block ahead on the deck, hit spots 1.5-2.3 blocks away one block
	 * down: the old fight held the deck 7.1 s with 0 hits.
	 */
	private static void verifyStepDownToHitSpot() {
		Scene scene = new Scene();
		for (int x = 219; x <= 222; x++) for (int z = 24; z <= 30; z++) scene.floor(x, 54, z);
		for (int x = 223; x <= 226; x++) for (int z = 24; z <= 30; z++) scene.floor(x, 53, z);
		scene.solid(222, 54, 26);
		GridPosition body = new GridPosition(222, 54, 27);
		Set<GridPosition> hitSpots = Set.of(new GridPosition(223, 53, 27), new GridPosition(223, 53, 26), new GridPosition(224, 53, 27));
		check(!found(plan(scene.view(54, 0), body, hitSpots)), "before: a deck-only approach finds no way to the hit spots one block down");
		PathPlan plan = plan(scene.view(54, BlazeApproach.LEVEL_BAND), body, hitSpots);
		check(found(plan), "the approach finds the hit spot one block down");
		PathNode next = levelStep(plan, 54);
		check(next != null && next.traversal() == TraversalType.DROP_DOWN && next.position().y() == 53,
				"its one level change is a one-block step down " + plan.nodes());
		check(BlazeApproach.takesStep(54, next, false), "the shielded body takes the planned step down");
		check(BlazeApproach.levelChange(54, next), "the step leaves the deck on purpose");
		check(!BlazeApproach.sneakFor(true, true) && BlazeApproach.sneakFor(true, false),
				"a call that sneaks walks the step upright, then crouches again (a crouched body never leaves the lip)");
	}

	/**
	 * Blaze 2.0 above and 5.1 blocks off, hit spots 2.2-3.0 blocks away one block up: the old fight held the deck 16 s
	 * with 0 hits.
	 */
	private static void verifyStepUpToHitSpot() {
		Scene scene = new Scene();
		for (int x = 248; x <= 253; x++) for (int z = -19; z <= -16; z++) scene.floor(x, 58, z);
		for (int x = 248; x <= 253; x++) for (int z = -24; z <= -20; z++) scene.floor(x, 59, z);
		GridPosition body = new GridPosition(250, 58, -19);
		Set<GridPosition> hitSpots = Set.of(new GridPosition(250, 59, -21), new GridPosition(251, 59, -21));
		check(!found(plan(scene.view(58, 0), body, Set.of(new GridPosition(250, 59, -21), new GridPosition(251, 59, -21)))),
				"before: a deck-only approach finds no way up to the hit spots");
		PathPlan plan = plan(scene.view(58, BlazeApproach.LEVEL_BAND), body, hitSpots);
		check(found(plan), "the approach finds the hit spot one block up");
		PathNode next = levelStep(plan, 58);
		check(next != null && next.traversal() == TraversalType.JUMP_UP && next.position().y() == 59,
				"its one level change is a one-block step up " + plan.nodes());
		check(BlazeApproach.takesStep(58, next, false), "the shielded body takes the planned step up");
		check(BlazeApproach.stepJump(58, next, true, 0.6D, true), "it jumps onto the step with the shield up");
		check(!BlazeApproach.stepJump(58, next, false, 0.6D, true), "no jump while the keys hold it still");
		check(!BlazeApproach.stepJump(58, next, true, 0.6D, false), "no jump from the air");
	}

	/** Where no seen walk of at most one block up or down reaches a hit spot, the body still holds its deck. */
	private static void verifyStillHolds() {
		// A hit spot two blocks down: a drop of two is a chase, not a step.
		Scene twoDown = new Scene();
		for (int z = 0; z <= 6; z++) twoDown.floor(0, 64, z);
		for (int z = 0; z <= 6; z++) twoDown.floor(1, 62, z);
		check(!found(plan(twoDown.view(64, BlazeApproach.LEVEL_BAND), new GridPosition(0, 64, 3), Set.of(new GridPosition(1, 62, 3)))),
				"no step down two blocks toward a blaze");
		// A pillar: a hit spot two blocks up.
		Scene pillar = new Scene();
		for (int z = 0; z <= 6; z++) pillar.floor(0, 64, z);
		pillar.solid(1, 64, 3).solid(1, 65, 3);
		check(!found(plan(pillar.view(64, BlazeApproach.LEVEL_BAND), new GridPosition(0, 64, 3), Set.of(new GridPosition(1, 66, 3)))),
				"no climb two blocks toward its height");
		// A one-wide bridge over a deep drop, the hit spot across a one-block gap: no jumping gaps to reach a blaze.
		Scene bridge = new Scene();
		for (int z = 0; z <= 4; z++) bridge.floor(0, 55, z);
		for (int z = 6; z <= 9; z++) bridge.floor(0, 55, z);
		check(!found(plan(bridge.view(55, BlazeApproach.LEVEL_BAND), new GridPosition(0, 55, 4), Set.of(new GridPosition(0, 55, 6)))),
				"no gap jump on an open bridge toward a blaze");
		// A fence line between the body and every hit spot.
		Scene fence = new Scene();
		for (int x = 0; x <= 6; x++) for (int z = 0; z <= 6; z++) fence.floor(x, 70, z);
		for (int z = 0; z <= 6; z++) fence.blocked(3, 70, z).blocked(3, 71, z);
		check(!found(plan(fence.view(70, BlazeApproach.LEVEL_BAND), new GridPosition(1, 70, 3), Set.of(new GridPosition(5, 70, 3)))),
				"a fence with no way round still holds");
		// The spawner hold's defend keeps its cell's deck.
		check(BlazeApproach.levelBand(true) == 0 && BlazeApproach.levelBand(false) == BlazeApproach.LEVEL_BAND,
				"the spawner hold keeps its deck; every other blaze fight may step one block");
	}

	private static void verifyStepDecisions() {
		GridPosition at = new GridPosition(0, 64, 1);
		PathNode level = new PathNode(at, TraversalType.WALK);
		check(BlazeApproach.takesStep(64, level, true) && !BlazeApproach.takesStep(64, level, false),
				"a step on the deck still needs seen footing ahead");
		check(!BlazeApproach.levelChange(64, level), "a deck step keeps the level hold");
		check(!BlazeApproach.takesStep(64, new PathNode(new GridPosition(0, 62, 1), TraversalType.DROP_DOWN), true),
				"a planned drop of two is not taken");
		check(!BlazeApproach.takesStep(64, new PathNode(new GridPosition(0, 65, 1), TraversalType.WALK), true),
				"a level change the route did not plan as a step is not taken");
		check(!BlazeApproach.takesStep(64, null, true), "no route, no step");
		PathNode upper = new PathNode(new GridPosition(0, 65, 1), TraversalType.JUMP_UP);
		check(BlazeApproach.takesStep(65, upper, false, 65, false), "mid-jump, feet at the upper level over the takeoff cell, the step stays taken");
		check(!BlazeApproach.takesStep(65, upper, false, 65, true), "landed, the level check decides again");
		check(!BlazeApproach.takesStep(65, upper, false, null, false), "airborne without a planned step, no step");
	}

	private static void check(boolean passed, String label) {
		assertions++;
		if (!passed) throw new AssertionError(label);
	}
}
