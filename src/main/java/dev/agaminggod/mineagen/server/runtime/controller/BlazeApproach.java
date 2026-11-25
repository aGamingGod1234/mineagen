package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.PathNode;
import dev.agaminggod.mineagen.client.navigation.TraversalType;

/**
 * How a shielded blaze fight closes on its blaze. Vanilla's blaze sinks toward the level of a player it can see, but
 * while it sees the player it only shoots: it never comes nearer (BlazeAttackGoal moves it only within 2 blocks or
 * after it loses sight). A body that holds its deck for the blaze to come into sword reach waits for good: in the real
 * fortress games every such fight timed out with the body idle and 0-1 hits, while seen hit spots stood 1.5-3 blocks
 * away one block up or down. A player walks there behind the raised shield. Still no chase up pillars, down drops of
 * two or more, across gaps or onto unseen ground.
 */
final class BlazeApproach {
	/** Blocks up or down from the body's deck the approach route may stand. */
	static final int LEVEL_BAND = 1;

	private BlazeApproach() {
	}

	/** The route's level band: the spawner hold's defend keeps its cell's deck, every other blaze fight may step. */
	static int levelBand(boolean holdDeck) {
		return holdDeck ? 0 : LEVEL_BAND;
	}

	/** A planned one-block step up or down onto the next route cell. */
	static boolean levelChange(int feetY, PathNode waypoint) {
		if (waypoint == null) return false;
		int rise = waypoint.position().y() - feetY;
		return rise == 1 && waypoint.traversal() == TraversalType.JUMP_UP
				|| rise == -1 && waypoint.traversal() == TraversalType.DROP_DOWN;
	}

	/**
	 * Whether the shielded body takes this tick's route step: on its own level only onto seen footing ahead
	 * ({@code levelAhead}); a planned one-block step up or down as the route planned it (its landing was seen standable).
	 */
	static boolean takesStep(int feetY, PathNode waypoint, boolean levelAhead) {
		if (waypoint == null) return false;
		if (waypoint.position().y() == feetY) return levelAhead;
		return levelChange(feetY, waypoint);
	}

	/**
	 * As above, and a step already under way stays taken until the body lands: mid-jump the feet reach the upper deck's
	 * level while still over the takeoff cell, where the level check sees only air and would stop the keys.
	 */
	static boolean takesStep(int feetY, PathNode waypoint, boolean levelAhead, Integer stepTo, boolean onGround) {
		if (waypoint != null && stepTo != null && !onGround && waypoint.position().y() == stepTo) return true;
		return takesStep(feetY, waypoint, levelAhead);
	}

	/** The jump onto a one-block step the route climbs, taken with the shield up while the keys move the body. */
	static boolean stepJump(int feetY, PathNode waypoint, boolean moving, double horizontal, boolean onGround) {
		return moving && waypoint != null && waypoint.position().y() == feetY + 1 && waypoint.traversal() == TraversalType.JUMP_UP
				&& MeleeReach.jumpFor(TraversalType.JUMP_UP, horizontal, onGround);
	}

	/** A crouched body never leaves a lip: a planned step down is walked upright, then the crouch the call asked for resumes. */
	static boolean sneakFor(boolean sneak, boolean stepping) {
		return sneak && !stepping;
	}
}
