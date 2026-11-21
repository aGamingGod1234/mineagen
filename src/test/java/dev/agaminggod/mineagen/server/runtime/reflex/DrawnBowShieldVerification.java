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
		bouncedArrowIsNoShot();
		return assertions;
	}

	private static void defaultArrowSensesTheDraw() {
		ReflexSpec.Rule arrow = defaults().stream().filter(rule -> rule.id().equals("default-arrow")).findFirst().orElseThrow();
		ReflexSpec.Condition incoming = arrow.when().getFirst();
		check("incoming_projectile".equals(incoming.type()) && incoming.flag("drawn"), "default-arrow senses a drawn bow");
		check(incoming.number("withinS", 0.0D) == 0.6D && arrow.priority() == 7 && "shield".equals(arrow.action().type()),
				"its arrow window, priority and action are unchanged");
		check(arrow.maxMs() == 10_000L && arrow.maxMs() > ReflexSpec.DEFAULT_TRIGGER_MAX_MS,
				"two skeletons drawing in turn do not time the shield out four times in a row and switch it off");
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

	/**
	 * The live drawn-bow room, one tick after a block: the arrow bounced off the shield at a tenth of its speed and drops
	 * past the head, still inside the box an arrow hits from, so the flight estimate gives it 0 s to impact. Read as a shot,
	 * the shield turned to the line it bounced along, 8 blocks behind the body, and the archer's next draw came from behind.
	 */
	private static void bouncedArrowIsNoShot() {
		net.minecraft.world.phys.AABB body = new net.minecraft.world.phys.AABB(0.2D, 80.0D, 0.2D, 0.8D, 81.8D, 0.8D);
		Vec3 skeleton = new Vec3(9.6D, 80.0D, 6.5D);
		Vec3 bounced = new Vec3(0.927D, 81.573D, 0.364D), bouncedVelocity = new Vec3(0.126D, -0.083D, 0.079D);
		double eta = dev.agaminggod.mineagen.server.perception.ProjectilePerception.impactSeconds(bounced, bouncedVelocity, body, Vec3.ZERO, false,
				dev.agaminggod.mineagen.server.perception.ProjectilePerception.HIT_MARGIN);
		check(Double.isFinite(eta), "the flight estimate alone reads the bounced arrow as landing now");
		check(Double.isNaN(ReflexSensors.shotSeconds(body, bounced, bouncedVelocity, Vec3.ZERO, false, (from, to) -> true)),
				"an arrow already at the body has landed, so incoming_projectile and the shield's shot skip it");
		Vec3 incoming = new Vec3(1.348D, 81.678D, 0.626D), incomingVelocity = new Vec3(-1.286D, -0.167D, -0.803D);
		double next = ReflexSensors.shotSeconds(body, incoming, incomingVelocity, Vec3.ZERO, false, (from, to) -> true);
		check(Double.isFinite(next) && next <= 0.05D, "the arrow one tick before the hit is still a shot, landing this tick");
		Vec3 eye = new Vec3(0.5D, 81.62D, 0.5D);
		Vec3 toIncoming = incoming.subtract(incomingVelocity.normalize().scale(8.0D)).subtract(eye), toSkeleton = skeleton.subtract(eye);
		check(toIncoming.x * toSkeleton.x + toIncoming.z * toSkeleton.z > 0.0D, "the shot's line still points the shield at the archer");
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
