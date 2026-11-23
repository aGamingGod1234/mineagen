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
		// The way back to the last breath (a sealed pocket past the seen-air search): taken while the breath left covers it.
		java.util.List<net.minecraft.core.BlockPos> back = new java.util.ArrayList<>();
		for (int x = 12; x >= 0; x--) back.add(new net.minecraft.core.BlockPos(x, 60, 0));
		for (int y = 61; y <= 64; y++) back.add(new net.minecraft.core.BlockPos(0, y, 0));
		var route = EscapeMoves.wayBack(back, 300);
		checks += check(route != null && route.x() == 0 && route.openY() == 64 && route.path().size() == 17, "full air, 16 cells back to the breath: swim back to it");
		checks += check(EscapeMoves.wayBack(back, 60) == null, "3 s of air left cannot cover 16 cells: no way back, the other moves");
		checks += check(EscapeMoves.wayBack(back.subList(0, 1), 300) == null, "no cell to swim to: no way back");
		checks += check(EscapeMoves.wayBack(back, 160) != null && EscapeMoves.wayBack(back, 159) == null,
				"16 cells back at 2 blocks/s with the reserve: taken from 160 ticks of air, not at 159");
		checks += check(EscapeMoves.wayBack(back, 20, true) != null, "already swimming back: it keeps going with little air left rather than turn to rise blind");
		checks += check(!EscapeMoves.rises(0.0D) && !EscapeMoves.sinks(0.0D), "a level next cell: neither jump nor sneak (jump floats the body off a tunnel's floor)");
		checks += check(EscapeMoves.rises(0.6D) && !EscapeMoves.sinks(0.6D), "a higher next cell: jump to rise to it");
		checks += check(EscapeMoves.sinks(-0.6D) && !EscapeMoves.rises(-0.6D), "a lower next cell: sneak to sink to it");
		return checks;
	}

	private static int check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		return 1;
	}
}
