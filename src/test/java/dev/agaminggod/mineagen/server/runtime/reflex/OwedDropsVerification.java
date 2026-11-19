package dev.agaminggod.mineagen.server.runtime.reflex;

import dev.agaminggod.mineagen.server.perception.ObservedDrops;
import net.minecraft.world.phys.Vec3;

/** Issue #2, 1b: the owed-drops habit's rule, its shelter gate, and its rule shape. */
public final class OwedDropsVerification {
	private OwedDropsVerification() {
	}

	public static int verify() {
		int checks = 0;
		String overworld = "minecraft:overworld";
		var kill = drop(ObservedDrops.Source.KILL, overworld);
		checks += check(true, ObservedDrops.owed(kill, false, overworld, 9.0D, 16.0D), "a kill's drop in reach is owed");
		checks += check(false, ObservedDrops.owed(kill, true, overworld, 9.0D, 16.0D), "a drop already tried is never tried again");
		checks += check(false, ObservedDrops.owed(kill, false, overworld, 16.5D, 16.0D), "a drop last seen past within is not owed");
		checks += check(false, ObservedDrops.owed(kill, false, "minecraft:the_nether", 1.0D, 16.0D), "another dimension's drop is not owed");
		checks += check(false, ObservedDrops.owed(drop(ObservedDrops.Source.BREAK, overworld), false, overworld, 1.0D, 16.0D), "a break drop is never owed");
		checks += check(false, ObservedDrops.owed(drop(ObservedDrops.Source.OTHER, overworld), false, overworld, 1.0D, 16.0D), "thrown junk or a plain sighting is never owed");
		checks += check(false, ObservedDrops.owed(null, false, overworld, 1.0D, 16.0D), "an expired sighting is not owed");

		checks += check(true, ReflexSensors.placedOnPurpose(true, 3, 0), "under a roof walled on three sides: sheltered");
		checks += check(false, ReflexSensors.placedOnPurpose(true, 2, 0), "a roof with an open side is not a shelter");
		checks += check(false, ReflexSensors.placedOnPurpose(false, 4, 0), "walls without a roof (a trench) are not a shelter");
		checks += check(true, ReflexSensors.placedOnPurpose(false, 0, 3), "no floor beside three sides: a pillar");
		checks += check(false, ReflexSensors.placedOnPurpose(false, 0, 2), "a ledge open on two sides is walked off normally");

		checks += check(true, ReflexSpec.conditionTypes().contains("drops_owed"), "drops_owed is a condition");
		checks += check(true, ReflexSpec.actionTypes().contains("collect_drops"), "collect_drops is an action");
		checks += check(true, ReflexSpec.MAX_RULES >= 27, "the full set (12 model rules and 15 defaults) fits");
		checks += check(true, ReflexActions.CollectDrops.COLLECT_MS + ReflexActions.CollectDrops.BACK_MS <= 20_000L,
				"collect and walk back fit the rule's 20 s limit");
		checks += check(true, ReflexSensors.OWED_IDLE_TICKS >= 138, "the pass waits out the p90 wait for the next command (6.9 s)");
		checks += check(true, ReflexActions.CollectDrops.tally("picked up 1x minecraft:bone uuid=a; made room: dropped 9x minecraft:dirt; left 2x minecraft:arrow uuid=b: INVENTORY_FULL")
				.equals("picked up 1, left 1, made room (INVENTORY_FULL)"), "the done detail keeps counts within the 160-character cut");
		// Review finding: owed-drop collection starting the tick another firing ends must not inherit that firing's reflex
		// lease, which would outrank the collector's navigation leases until the pass timed out.
		checks += check(false, ReflexEngine.handsOverLease(ReflexActions.create(rule("collect_drops").action())),
				"a firing that ends into owed-drop collection releases its reflex lease");
		checks += check(true, ReflexEngine.handsOverLease(ReflexActions.create(rule("shield").action())),
				"a firing that ends into a shield keeps its lease, so the raised shield does not drop for a tick");
		checks += check(false, ReflexEngine.handsOverLease(null), "a firing that ends with nothing after it releases its lease");
		checks += check(true, ReflexActions.CollectDrops.tally("no drop was seen to collect").equals("no drop was seen to collect"), "a plain line passes through");
		return checks;
	}

	private static ReflexSpec.Rule rule(String action) {
		return ReflexSpec.parseRules(com.google.gson.JsonParser.parseString("[{\"id\":\"r\",\"when\":{\"type\":\"on_fire\"},\"do\":{\"type\":\""
				+ action + "\"}}]").getAsJsonArray()).getFirst();
	}

	private static ObservedDrops.Drop drop(ObservedDrops.Source source, String dimension) {
		return new ObservedDrops.Drop(Vec3.ZERO, dimension, 0L, "minecraft:rotten_flesh", 1, true, source);
	}

	private static int check(boolean expected, boolean actual, String message) {
		if (expected != actual) throw new AssertionError(message);
		return 1;
	}
}
