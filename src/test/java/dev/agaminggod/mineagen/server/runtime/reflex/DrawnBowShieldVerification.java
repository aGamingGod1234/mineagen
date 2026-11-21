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
		grazingArrowIsMetWhereItStrikes();
		strikeOnAMovingBodyIsWhereItLandsOnTheBody();
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
	 * The live drawn-bow room, after a block: the arrow bounced off the shield at a tenth of its speed and falls back past
	 * the head, inside the box an arrow hits from or popped just above it, so the flight estimate reads it as landing now.
	 * Read as a shot, the shield turned to the line it bounced along, away from the archer, whose next draw came from
	 * behind. An arrow that struck the body or shield is no shot; a fresh one a tick from its hit still is.
	 */
	private static void bouncedArrowIsNoShot() {
		net.minecraft.world.phys.AABB body = new net.minecraft.world.phys.AABB(0.2D, 80.0D, 0.2D, 0.8D, 81.8D, 0.8D);
		Vec3 skeleton = new Vec3(9.6D, 80.0D, 6.5D);
		java.util.function.BiPredicate<Vec3, Vec3> clear = (from, to) -> true;
		Vec3 bounced = new Vec3(0.927D, 81.573D, 0.364D), bouncedVelocity = new Vec3(0.126D, -0.083D, 0.079D);
		Vec3 popped = new Vec3(0.68D, 82.1D, 0.37D), poppedVelocity = new Vec3(0.14D, -0.038D, -0.02D);
		check(Double.isFinite(ReflexSensors.shotSeconds(false, body, bounced, bouncedVelocity, Vec3.ZERO, false, clear))
				&& Double.isFinite(ReflexSensors.shotSeconds(false, body, popped, poppedVelocity, Vec3.ZERO, false, clear)),
				"the flight estimate alone reads both bounces as landing now");
		check(Double.isNaN(ReflexSensors.shotSeconds(true, body, bounced, bouncedVelocity, Vec3.ZERO, false, clear))
				&& Double.isNaN(ReflexSensors.shotSeconds(true, body, popped, poppedVelocity, Vec3.ZERO, false, clear)),
				"an arrow that struck the body or shield is no shot for incoming_projectile or the shield");
		Object shot = new Object(), other = new Object();
		java.util.UUID player = java.util.UUID.randomUUID(), someoneElse = java.util.UUID.randomUUID();
		StruckShots.record(shot, player);
		check(StruckShots.struck(shot, player) && !StruckShots.struck(shot, someoneElse) && !StruckShots.struck(other, player),
				"struck is per projectile and per body: a bounce can still threaten another player");
		Vec3 incoming = new Vec3(1.348D, 81.678D, 0.626D), incomingVelocity = new Vec3(-1.286D, -0.167D, -0.803D);
		double next = ReflexSensors.shotSeconds(false, body, incoming, incomingVelocity, Vec3.ZERO, false, clear);
		check(Double.isFinite(next) && next <= 0.05D, "the arrow one tick before the hit is still a shot, landing this tick");
		Vec3 eye = new Vec3(0.5D, 81.62D, 0.5D);
		Vec3 toIncoming = incoming.subtract(incomingVelocity.normalize().scale(8.0D)).subtract(eye), toSkeleton = skeleton.subtract(eye);
		check(toIncoming.x * toSkeleton.x + toIncoming.z * toSkeleton.z > 0.0D, "the shot's line still points the shield at the archer");
	}

	/**
	 * The live drawn-bow room: a skeleton 9 blocks off shot half a block wide of a body facing it 3 degrees off. The arrow
	 * touched the body's side, 103 degrees from that facing, and vanilla let it through. From the arrow's first tick the
	 * strike point is the traced hit, and the shield faced toward it covers it.
	 */
	private static void grazingArrowIsMetWhereItStrikes() {
		net.minecraft.world.phys.AABB body = new net.minecraft.world.phys.AABB(0.2D, 80.0D, 0.2D, 0.8D, 81.8D, 0.8D);
		Vec3 feet = new Vec3(0.5D, 80.0D, 0.5D), eye = new Vec3(0.5D, 81.62D, 0.5D), skeleton = new Vec3(3.727D, 80.0D, 8.541D);
		Vec3 strike = ReflexSensors.strikePoint(body, new Vec3(3.779D, 81.64D, 8.594D), new Vec3(-0.514D, 0.161D, -1.561D), Vec3.ZERO, 0);
		check(strike != null && strike.distanceTo(new Vec3(1.0D, 81.886D, 0.152D)) < 0.02D, "the strike point is where vanilla hit the body");
		check(blockAngle(feet, skeleton.subtract(feet), strike) > 90.0D, "facing the skeleton leaves this hit outside the shield");
		Vec3 facing = ReflexSensors.facingPoint(feet, eye, strike, skeleton);
		check(blockAngle(feet, facing.subtract(eye), strike) < 1.0D, "facing the strike point puts it at the shield's centre");
		check(ReflexSensors.strikePoint(body, new Vec3(3.779D, 81.64D, 8.594D), new Vec3(0.514D, 0.161D, 1.561D), Vec3.ZERO, 0) == null,
				"an arrow flying away strikes nothing");
	}

	/**
	 * Codex review: a body walking behind its shield. The arrow flies straight in 1.3 blocks to the body's side and meets
	 * it only because the body walks under it (0.3 blocks a tick). The strike point is where it lands on the body as it
	 * stands now, not that world point seen from where the body was, which put it outside the body, off to the side.
	 */
	private static void strikeOnAMovingBodyIsWhereItLandsOnTheBody() {
		net.minecraft.world.phys.AABB body = new net.minecraft.world.phys.AABB(-0.3D, 0.0D, -0.3D, 0.3D, 1.8D, 0.3D);
		Vec3 strike = ReflexSensors.strikePoint(body, new Vec3(1.3D, 1.0D, 3.5D), new Vec3(0.0D, 0.0D, -1.0D), new Vec3(0.3D, 0.0D, 0.0D), 8);
		check(strike != null, "the walking body meets the arrow");
		check(body.inflate(0.31D).contains(strike), "the strike point is on the body as it stands now, not 0.9 blocks past it");
		check(strike.x > 0.0D && strike.z > 0.0D, "it lands on the front corner the body walks into");
		check(ReflexSensors.strikePoint(body, new Vec3(1.3D, 1.0D, 3.5D), new Vec3(0.0D, 0.0D, -1.0D), Vec3.ZERO, 8) == null, "a body standing still is missed");
	}

	/** Vanilla's shield test: degrees between a horizontal view and the hit point as seen from the feet. */
	private static double blockAngle(Vec3 feet, Vec3 view, Vec3 hit) {
		Vec3 look = new Vec3(view.x, 0.0D, view.z).normalize(), to = new Vec3(hit.x - feet.x, 0.0D, hit.z - feet.z).normalize();
		return Math.toDegrees(Math.acos(Math.max(-1.0D, Math.min(1.0D, look.dot(to)))));
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
