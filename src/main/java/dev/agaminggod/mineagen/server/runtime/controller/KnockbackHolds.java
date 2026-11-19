package dev.agaminggod.mineagen.server.runtime.controller;

/**
 * How long one action may stand still for the knockback margin (issue 2, K9): at most {@link #APPROACH_TICKS} for one
 * mob's approach, so the mob passes or default-defend takes the body and answers it, and at most {@link #WALK_TICKS} over
 * the whole action, so a mob hovering at the edge of knockback range cannot chain holds into a stall stop. One instance
 * spans every walk of the action (travel_to's legs, pick_up_item's walks after the drop moves), so a fresh walk does not
 * reset the bounds.
 */
public final class KnockbackHolds {
	/** Longest hold for one approach: a mob within knockback range, until none is. */
	static final int APPROACH_TICKS = 40;
	/** Longest total hold for one action: half of travel's 10 s stall window. */
	static final int WALK_TICKS = 100;
	private int approachTicks;
	private int walkTicks;
	private int holds;
	private CombatPlanning.Refusal lastRefusal;

	/** Whether the action may still hold now (both bounds have room). */
	boolean mayHold() {
		return approachTicks < APPROACH_TICKS && walkTicks < WALK_TICKS;
	}

	/**
	 * One tick: {@code mobNear} is a mob within knockback range, {@code refused} the margin refusing the next step.
	 * Returns whether the walk holds this tick.
	 */
	boolean observe(boolean mobNear, boolean refused) {
		if (!mobNear) {
			approachTicks = 0;
			return false;
		}
		if (!refused || !mayHold()) return false;
		if (approachTicks == 0) holds++;
		approachTicks++;
		walkTicks++;
		return true;
	}

	/** As {@link #observe(boolean, boolean)}, keeping the refused cell for the result text. */
	boolean observe(boolean mobNear, CombatPlanning.Refusal refusal) {
		if (!observe(mobNear, refusal != null)) return false;
		lastRefusal = refusal;
		return true;
	}

	/**
	 * One tick a held body spends in the air after a hit, still braking until it lands. It counts toward the reported
	 * hold time and the pickup credit, and toward the action's total so airborne time cannot stretch the bound; the
	 * landing decision itself is not limited by it.
	 */
	void heldAirborne() {
		walkTicks++;
	}

	int holds() {
		return holds;
	}

	int heldTicks() {
		return walkTicks;
	}

	long heldMs() {
		return walkTicks * 50L;
	}

	/** The cell the last hold was short of, or null before any hold. */
	CombatPlanning.Refusal lastRefusal() {
		return lastRefusal;
	}
}
