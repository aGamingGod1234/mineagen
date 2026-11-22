package dev.agaminggod.mineagen.server.runtime.reflex;

import dev.agaminggod.mineagen.server.perception.WaterAirFacts;

/**
 * Under a submerged ledge with no seen way up, the swim-up reflex and the escape job's swim (EscapeMoves.swimUp, the same
 * behaviour) duck out into the open water beside it, as travel's PEEK step does, instead of rising blind into the ceiling
 * until the air runs out; escape's 2 s progress guard counts the move across as progress.
 */
public final class SwimUnderLedgeVerification {
	private SwimUnderLedgeVerification() {
	}

	public static int verify() {
		int checks = 0;
		checks += check(ReflexActions.swimUpStep(true, true, 0) == ReflexActions.SwimUpStep.ROUTE, "a seen route to air comes first, even with a peek cell");
		checks += check(ReflexActions.swimUpStep(false, true, 0) == ReflexActions.SwimUpStep.DUCK_OUT,
				"capped head, no seen air, open water beside: duck out, never rise blind into the ledge");
		checks += check(ReflexActions.swimUpStep(false, true, WaterAirFacts.PEEK_TICKS - 1) == ReflexActions.SwimUpStep.DUCK_OUT, "the duck-out runs its full budget");
		checks += check(ReflexActions.swimUpStep(false, true, WaterAirFacts.PEEK_TICKS) == ReflexActions.SwimUpStep.BLIND, "past the budget the swim rises blind again");
		checks += check(ReflexActions.swimUpStep(false, false, 0) == ReflexActions.SwimUpStep.BLIND, "open overhead or nothing open beside: rise blind");
		checks += check(EscapeMoves.madeWay(0.0D, 0.9D), "ducking out across a block is progress for escape's 2 s guard");
		checks += check(EscapeMoves.madeWay(0.6D, 0.0D), "rising half a block is progress");
		checks += check(!EscapeMoves.madeWay(0.2D, 0.2D), "pressed against the ceiling, barely moving: no progress, the move hands back");
		checks += check(EscapeMoves.BLIND_WINDOW_TICKS > WaterAirFacts.PEEK_TICKS, "the duck-out finishes inside escape's first progress window");
		checks += check(dev.agaminggod.mineagen.server.runtime.controller.SwimPlanning.SURFACING_PITCH > WaterAirFacts.PEEK_PITCH,
				"ducking out looks nearly straight up, steeper than the surfacing pitch");
		return checks;
	}

	private static int check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		return 1;
	}
}
