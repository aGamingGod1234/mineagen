package dev.agaminggod.mineagen.server.runtime.reflex;

import com.google.gson.JsonParser;
import dev.agaminggod.mineagen.protocol.ActionType;
import java.util.List;
import net.minecraft.world.phys.Vec3;

/**
 * COMBAT-1: with no shield in hand the body stepped nowhere on a drawn bow and stood "facing the attacker" (no-shield
 * archers room: died 10 of 10, 35-39 HP taken). The dodge strafes across the shot line, alternates sides per draw,
 * refuses unsafe footing, sleeps with a shield in hand and stands aside for cover, escape, flight and fights.
 */
public final class ArrowDodgeVerification {
	private static int assertions;

	private ArrowDodgeVerification() {
	}

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " arrow dodge assertions");
	}

	public static int verify() {
		assertions = 0;
		headingIsSquareAcrossTheShotLine();
		sidesAlternatePerDraw();
		unsafeFootingIsRefused();
		sleepsWithAShieldInHand();
		defaultRuleIsAHold();
		standsAsideForWhatMovesTheBody();
		return assertions;
	}

	private static void headingIsSquareAcrossTheShotLine() {
		Vec3 body = Vec3.ZERO;
		// Shooter due south (+z): facing it is yaw 0; the steps across are due west (90) and due east (-90).
		check(near(ReflexActions.Dodge.sideYaw(body, new Vec3(0.0D, 0.0D, 10.0D), 1), 90.0F), "side +1 of a shooter to the south is west");
		check(near(ReflexActions.Dodge.sideYaw(body, new Vec3(0.0D, 0.0D, 10.0D), -1), -90.0F), "side -1 is east");
		for (double angle = 0.0D; angle < 360.0D; angle += 37.0D) {
			Vec3 shooter = new Vec3(Math.cos(Math.toRadians(angle)) * 10.0D, 0.0D, Math.sin(Math.toRadians(angle)) * 10.0D);
			for (int side : new int[]{1, -1}) {
				double yaw = Math.toRadians(ReflexActions.Dodge.sideYaw(body, shooter, side));
				Vec3 step = new Vec3(-Math.sin(yaw), 0.0D, Math.cos(yaw));
				check(Math.abs(step.dot(shooter.normalize())) < 1.0E-4D, "the step is perpendicular to the shooter line at " + angle);
			}
		}
	}

	private static void sidesAlternatePerDraw() {
		check(ReflexActions.Dodge.nextSide(0) == 1 && ReflexActions.Dodge.nextSide(1) == -1 && ReflexActions.Dodge.nextSide(-1) == 1,
				"each draw takes the other side");
		ReflexActions.Dodge.Answer first = ReflexActions.Dodge.answer(null, 7, 100L);
		check(first.side() == 1, "the first draw takes side +1");
		check(ReflexActions.Dodge.answer(first, 7, 100L) == first && ReflexActions.Dodge.answer(first, 7, 101L) == first,
				"the same draw keeps its side, however many dodges (the rule's, defend's) read it");
		ReflexActions.Dodge.Answer again = ReflexActions.Dodge.answer(first, 7, 160L);
		check(again.side() == -1, "the same skeleton drawing again is met on the other side");
		check(ReflexActions.Dodge.answer(again, 8, 162L).side() == 1, "a second skeleton's draw is a new draw too");
	}

	private static void unsafeFootingIsRefused() {
		check(ReflexActions.Dodge.chooseSide(1, side -> true) == 1, "both sides safe: the chosen one");
		check(ReflexActions.Dodge.chooseSide(1, side -> side == -1) == -1, "a drop or lava on the chosen side: the other side");
		check(ReflexActions.Dodge.chooseSide(-1, side -> false) == 0, "neither side safe: stand");
		check(ReflexActions.Dodge.chooseSide(1, side -> side == -1, side -> true) == -1,
				"a side that keeps the knockback margin beats one along a lava edge or drop");
		check(ReflexActions.Dodge.chooseSide(1, side -> false, side -> side == 1) == 1, "with no margin either way, plain safe footing");
		check(ReflexActions.Dodge.MAX_DROP == 1, "a dodge never steps down more than one block");
	}

	private static void sleepsWithAShieldInHand() {
		ReflexSpec.Rule dodge = rule("default-arrow-dodge");
		ReflexActions.Held shield = new ReflexActions.Held("minecraft:shield", false, false);
		ReflexActions.Held sword = new ReflexActions.Held("minecraft:iron_sword", false, false);
		java.util.function.IntFunction<ReflexActions.Held> empty = slot -> ReflexActions.Held.EMPTY;
		check(ReflexActions.lacks(dodge.action(), empty, 0, shield) != null && dodge.sleepsWithoutItem(ReflexActions.lacks(dodge.action(), empty, 0, shield)),
				"an offhand shield puts the dodge to sleep");
		check(ReflexActions.lacks(dodge.action(), slot -> slot == 0 ? shield : ReflexActions.Held.EMPTY, 0, ReflexActions.Held.EMPTY) != null,
				"a shield in the main hand puts it to sleep");
		check(ReflexActions.lacks(dodge.action(), slot -> sword, 0, ReflexActions.Held.EMPTY) == null, "no shield in either hand: it is armed");
		check(ReflexActions.lacks(rule("default-arrow").action(), slot -> sword, 0, ReflexActions.Held.EMPTY) != null,
				"and the arrow shield sleeps then, so exactly one of the two answers a draw");
	}

	private static void defaultRuleIsAHold() {
		ReflexSpec.Rule dodge = rule("default-arrow-dodge");
		ReflexSpec.Condition when = dodge.when().getFirst();
		check("incoming_projectile".equals(when.type()) && when.flag("drawn") && when.number("withinS", 0.0D) == 0.6D,
				"it answers the same drawn bow as the arrow shield");
		check(dodge.priority() == 7 && dodge.maxMs() == 10_000L, "priority 7 with a 10 s hold");
		ReflexActions.Dodge behaviour = new ReflexActions.Dodge();
		check(behaviour.holdsWhileTrue() && behaviour.doneAtMaxS(), "it holds through a volley and its maxS ends it done, not failed");
		check(!behaviour.settled(), "while answering a draw it keeps its priority: a lower rule (defend, eat) cannot take the body mid-draw");
		// Skeletons draw 20 ticks after a 20-40 tick interval: a 30-tick grace joins a volley into one firing, so two of them
		// fire it at most about once per 2 s, under the 40-a-minute limit that would switch it off.
		check(ReflexActions.Dodge.GRACE_TICKS >= 20L && 60.0D * 20.0D / (ReflexActions.Dodge.GRACE_TICKS + ReflexSensors.DRAW_RAISE_TICKS) < ReflexScheduler.MAX_FIRINGS_PER_MINUTE,
				"a volley cannot cross the firing-rate limit");
		// The draw holds the condition (and the strafe) to release at tick 20; the strafe then runs on through the arrow's
		// flight, about half a second at a skeleton's 10-15 blocks.
		check(ReflexActions.Dodge.MOVE_AFTER_TICKS >= 10, "the strafe runs past the release");
	}

	private static void standsAsideForWhatMovesTheBody() {
		ReflexSpec.Rule dodge = rule("default-arrow-dodge");
		ReflexSpec.Rule arrow = rule("default-arrow");
		for (ActionType fight : new ActionType[]{ActionType.FIGHT_TARGET, ActionType.FIGHT_UNTIL, ActionType.FLEE_FROM, ActionType.USE_RANGED}) {
			check(ReflexEngine.dodgeStandsAside(dodge, fight, false, false), "it stands aside for " + fight.wireName());
		}
		check(ReflexEngine.dodgeStandsAside(dodge, ActionType.ESCAPE, true, false), "for an escape walking to cover from a shooter");
		check(ReflexEngine.dodgeStandsAside(dodge, null, false, true), "for a firing that runs or hides");
		check(!ReflexEngine.dodgeStandsAside(dodge, null, false, false), "an idle body dodges");
		check(!ReflexEngine.dodgeStandsAside(arrow, ActionType.FIGHT_TARGET, true, true), "the gate is the dodge's alone");
		check(ReflexEngine.firingMovesBody(new ReflexActions.TakeCover(8, true)), "take_cover moves the body");
		check(ReflexEngine.firingMovesBody(new ReflexActions.SprintAway(8.0D)), "sprint_away moves the body");
		check(!ReflexEngine.firingMovesBody(new ReflexActions.Defend()), "a defend standing its ground does not");
		check(!ReflexEngine.firingMovesBody(null), "nothing running does not");
	}

	private static boolean near(float a, float b) {
		return Math.abs(net.minecraft.util.Mth.wrapDegrees(a - b)) < 1.0E-3F;
	}

	private static ReflexSpec.Rule rule(String id) {
		try {
			List<ReflexSpec.Rule> rules = ReflexSpec.parseRules(JsonParser.parseString(java.nio.file.Files.readString(
					java.nio.file.Path.of("src/test/resources/default-reflex-rules.json"))).getAsJsonArray());
			return rules.stream().filter(rule -> rule.id().equals(id)).findFirst().orElseThrow();
		} catch (java.io.IOException failure) {
			throw new java.io.UncheckedIOException(failure);
		}
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("ArrowDodgeVerification: " + message);
		assertions++;
	}
}
