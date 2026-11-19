package dev.agaminggod.mineagen.server.runtime.reflex;

import com.google.gson.JsonParser;
import java.util.List;
import net.minecraft.world.phys.Vec3;

/**
 * The arrow reflex raises the shield on a bow drawn at the body, not only on the arrow (CP2r: with a shield in hand, 28
 * of 36 skeleton hits landed while the reflex had started 2 ticks before impact), without a server.
 */
public final class DrawnBowShieldVerification {
	private static int assertions;

	private DrawnBowShieldVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " drawn bow shield assertions");
	}

	public static int verify() {
		assertions = 0;
		defaultArrowSensesTheDraw();
		modelRulesKeepTheArrowOnly();
		raiseLeavesTimeBeforeTheRelease();
		headFacingIsHorizontal();
		return assertions;
	}

	private static void defaultArrowSensesTheDraw() {
		ReflexSpec.Rule arrow = defaults().stream().filter(rule -> rule.id().equals("default-arrow")).findFirst().orElseThrow();
		ReflexSpec.Condition incoming = arrow.when().getFirst();
		check("incoming_projectile".equals(incoming.type()) && incoming.flag("drawn"), "default-arrow senses a drawn bow");
		check(incoming.number("withinS", 0.0D) == 0.6D && arrow.priority() == 7 && "shield".equals(arrow.action().type()),
				"its arrow window, priority and action are unchanged");
	}

	private static void modelRulesKeepTheArrowOnly() {
		ReflexSpec.Rule own = ReflexSpec.parseRules(JsonParser.parseString(
				"[{\"id\":\"shots\",\"when\":{\"type\":\"incoming_projectile\",\"withinS\":1},\"do\":{\"type\":\"shield\"}}]").getAsJsonArray()).getFirst();
		check(!own.when().getFirst().flag("drawn"), "a rule without drawn still waits for the arrow");
	}

	private static void raiseLeavesTimeBeforeTheRelease() {
		// Vanilla bow mobs release at 20 ticks of draw; a shield blocks 5 ticks after it rises and turns 180 degrees in about 5.
		check(ReflexSensors.DRAW_RAISE_TICKS + 5 + 5 <= 20, "the shield is up and turned before the release");
		check(ReflexSensors.DRAW_RAISE_TICKS >= 5, "a draw a skeleton drops at once does not raise it");
	}

	private static void headFacingIsHorizontal() {
		Vec3 at = new Vec3(0.0D, 64.0D, 0.0D);
		// Minecraft yaw 0 faces +Z, 90 faces -X.
		check(ReflexSensors.headTurnedTo(0.0F, at, new Vec3(0.0D, 64.0D, 10.0D), 30.0D), "yaw 0 faces +Z");
		check(ReflexSensors.headTurnedTo(90.0F, at, new Vec3(-10.0D, 70.0D, 0.0D), 30.0D), "yaw 90 faces -X, height ignored");
		check(!ReflexSensors.headTurnedTo(0.0F, at, new Vec3(0.0D, 64.0D, -10.0D), 30.0D), "a head turned away is not aimed");
		check(ReflexSensors.headTurnedTo(-170.0F, at, new Vec3(1.0D, 64.0D, -10.0D), 30.0D), "angles wrap at 180");
		check(!ReflexSensors.headTurnedTo(0.0F, at, new Vec3(10.0D, 64.0D, 10.0D), 30.0D), "45 degrees off is not aimed");
	}

	private static List<ReflexSpec.Rule> defaults() {
		try {
			return ReflexSpec.parseRules(JsonParser.parseString(java.nio.file.Files.readString(
					java.nio.file.Path.of("src/test/resources/default-reflex-rules.json"))).getAsJsonArray());
		} catch (java.io.IOException failure) {
			throw new java.io.UncheckedIOException(failure);
		}
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("DrawnBowShieldVerification: " + message);
		assertions++;
	}
}
