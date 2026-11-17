package dev.agaminggod.mineagen.server.runtime.controller;

import static dev.agaminggod.mineagen.server.runtime.controller.ServerController.State;
import static dev.agaminggod.mineagen.server.runtime.controller.ServerController.TickResult;

/** Phase/lifecycle checks only; physical retreat efficacy needs the real body replay. */
public final class CombatBailoutVerification {
	private static int assertions;

	public static void main(String[] args) {
		System.out.println("PASS: " + verify() + " combat bailout assertions");
	}

	public static int verify() {
		assertions = 0;
		check(!CombatPlanning.shouldBailOut(8.2F, null), "no implicit threshold");
		check(CombatPlanning.shouldBailOut(8.2F, 10F), "g8a health crosses authored threshold");
		check(!CombatPlanning.shouldBailOut(8.2F, 8F), "lower authored threshold remains authoritative");
		check(CombatBailout.budget(30_000L) == 5_000L, "retreat bounded to five seconds");
		check(CombatBailout.budget(350L) == 350L, "retreat cannot extend original deadline");
		check(CombatBailout.budget(-1L) == 0L, "expired action has no retreat budget");
		for (String code : new String[] {"ESCAPED", "TARGET_LOST", "FLEE_BLOCKED", "FLEE_TIMED_OUT", "TARGET_GONE", "IN_LAVA"}) {
			TickResult childResult = code.equals("ESCAPED") || code.equals("TARGET_LOST")
					? TickResult.succeeded(code, "observed movement facts")
					: TickResult.failed(code, "observed movement facts", 0);
			Child child = new Child(childResult);
			CombatBailout phase = new CombatBailout(child, "Health 8.2 reached fleeAtHealth 10.0");
			check(phase.tick(null, 0L).state() == State.RUNNING, "running retreat keeps authored action open");
			TickResult result = phase.tick(null, 50L);
			check(result.state() == State.FAILED && result.reasonCode().equals("LOW_HEALTH_BAILOUT"), "escape is not a kill/count success");
			check(result.message().contains(code) && result.message().contains("observed movement facts"), "preserves actual retreat outcome and facts");
			check(child.cancels == 1, "terminal retreat releases its child");
			check(phase.tick(null, 100L) == result && child.ticks == 2, "terminal phase never resumes attacks or retreat");
		}
		Child cancelled = new Child(TickResult.running(0));
		CombatBailout phase = new CombatBailout(cancelled, "threshold");
		phase.tick(null, 0L);
		phase.cancel(null);
		check(cancelled.cancels == 1, "action cancellation reaches owned retreat");
		Child dead = new Child(TickResult.failed("AGENT_DEAD", "died fleeing", 0));
		phase = new CombatBailout(dead, "threshold");
		phase.tick(null, 0L);
		check(phase.tick(null, 50L).reasonCode().equals("AGENT_DEAD"), "death is never called escape");
		TickResult held = new CombatBailout(null, "hold-ground choice forbids movement; no retreat attempted").tick(null, 0L);
		check(held.reasonCode().equals("LOW_HEALTH_BAILOUT") && held.message().contains("no retreat attempted"), "hold-ground reports no attempt honestly");
		return assertions;
	}

	private static final class Child implements ServerController {
		private final TickResult end;
		private int ticks;
		private int cancels;
		Child(TickResult end) { this.end = end; }
		@Override public TickResult tick(net.minecraft.server.level.ServerPlayer player, long now) {
			return ++ticks == 1 ? TickResult.running(0) : end;
		}
		@Override public void cancel(net.minecraft.server.level.ServerPlayer player) { cancels++; }
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
