package dev.agaminggod.mineagen.server.runtime.controller;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;

public final class CountFightVerification {
	private static int assertions;

	private CountFightVerification() {
	}

	public static void main(String[] args) {
		System.out.println("CountFightVerification: " + verify() + " assertions passed");
	}

	public static int verify() {
		assertions = 0;
		verifyExplicitChoicesSurvive();
		verifyDefaultsUnchanged();
		verifyEngagementGates();
		verifyIdleWalk();
		verifyTerminalLeaseRelease();
		verifyTargetingChoicesSurvive();
		verifyStationaryStance();
		verifyRound3Gates();
		verifyRoofFallback();
		verifyRoofSite();
		return assertions;
	}

	/**
	 * roof:true with a model spot on a bank: the doorway faced the enderman over a drop, the body built the shelter and
	 * then could not walk out to place the lintel (6 of 6 in the full games). The site search now checks a model spot too.
	 */
	private static void verifyRoofSite() {
		net.minecraft.core.BlockPos spot = new net.minecraft.core.BlockPos(0, 64, 0);
		java.util.function.Predicate<net.minecraft.core.BlockPos> air = at -> at.getY() >= 64;
		// Floor at y 63 for x < 2; east of that the bank drops away.
		java.util.function.Predicate<net.minecraft.core.BlockPos> bank = at -> at.getY() < 63 || at.getY() == 63 && at.getX() < 2;
		ServerFightUntilController.Site site = ServerFightUntilController.siteFor(spot, net.minecraft.core.Direction.EAST, bank, air);
		check(site != null, "a bank spot with firm ground behind it has a site");
		for (int step = 0; step <= 2; step++)
			check(bank.test(site.center().relative(site.opening(), step).below()), "the interior, doorway and outside cell all stand on floor (" + step + ")");
		check(!(site.center().equals(spot) && site.opening() == net.minecraft.core.Direction.EAST), "the doorway no longer opens over the drop");
		java.util.function.Predicate<net.minecraft.core.BlockPos> flat = at -> at.getY() < 64;
		ServerFightUntilController.Site same = ServerFightUntilController.siteFor(spot, net.minecraft.core.Direction.EAST, flat, air);
		check(same != null && same.center().equals(spot) && same.opening() == net.minecraft.core.Direction.EAST, "firm ground keeps the model's spot and the doorway toward the enderman");
		check(ServerFightUntilController.siteFor(spot, net.minecraft.core.Direction.EAST, at -> false, air) == null, "no seen floor: no site, the spot stays as before");
		// A sill shelter already stands on the spot (walls west, north, south, the roof, the sill east): the roof reuses it
		// with its doorway east, since the roofed build now clears the sill.
		java.util.Set<net.minecraft.core.BlockPos> shelter = new java.util.HashSet<>();
		for (ServerShelterController.Cell cell : ServerShelterController.plan(spot, net.minecraft.core.Direction.EAST, true, true)) shelter.add(cell.at());
		java.util.function.Predicate<net.minecraft.core.BlockPos> built = at -> at.getY() < 64 || shelter.contains(at);
		java.util.function.Predicate<net.minecraft.core.BlockPos> clear = at -> at.getY() >= 64 && !shelter.contains(at);
		ServerFightUntilController.Site reuse = ServerFightUntilController.siteFor(spot, net.minecraft.core.Direction.NORTH, built, clear);
		check(reuse != null && reuse.center().equals(spot) && reuse.opening() == net.minecraft.core.Direction.EAST, "an earlier sill shelter is reused through its sill side");
	}

	/** K11: a failed roof falls back to the open-ground hunt; missing blocks, sneak failures and the spot walk-back still stop. */
	private static void verifyRoofFallback() {
		check(ServerFightUntilController.roofFallback("ROOF_NOT_BUILT", true), "a failed shelter or lintel falls back");
		check(ServerFightUntilController.roofFallback("SPOT_UNREACHABLE", true), "failed walks inside the roof site fall back");
		check(!ServerFightUntilController.roofFallback("SPOT_UNREACHABLE", false), "two failed walks back to a model spot still stop");
		check(!ServerFightUntilController.roofFallback("ROOF_BLOCKS_MISSING", true), "missing blocks still stop at once");
		check(!ServerFightUntilController.roofFallback("SNEAK_NOT_HELD", true), "a sneak failure still stops");
		check(ServerFightUntilController.roams(dev.agaminggod.mineagen.compat.McEntityTypes.ENDERMAN, false, null),
				"after the fallback an enderman hunt with no spot roams as the open-ground fight");
	}

	private static void verifyExplicitChoicesSurvive() {
		JsonObject call = JsonParser.parseString("{\"targetId\":\"b\",\"untilItem\":\"minecraft:blaze_rod\",\"untilCount\":6,"
				+ "\"pursue\":false,\"shield\":true,\"sneak\":true,\"desiredRange\":4.0}").getAsJsonObject();
		JsonObject until = new JsonObject();
		CountFightChoices.copy(call, until);
		for (String field : new String[] { "pursue", "shield", "sneak", "desiredRange" })
			check(until.has(field) && until.get(field).equals(call.get(field)), "count mode carries the model's " + field);
		CountFightChoices kept = CountFightChoices.from(until);
		check(!kept.mayMove() && !kept.meleePursue(false), "pursue:false fights in place (no closing in, backing off or ledge trips)");
		check(kept.meleeShield(true, false), "shield:true shields against every mob, not only blazes");
		check(kept.sneak() && kept.desiredRange() == 4.0D, "sneak and desiredRange reach every melee engagement");

		JsonObject down = new JsonObject();
		CountFightChoices.copy(JsonParser.parseString("{\"shield\":false}").getAsJsonObject(), down);
		CountFightChoices noShield = CountFightChoices.from(down);
		check(!noShield.meleeShield(true, true) && !noShield.guardShield(true), "shield:false keeps the shield down, blazes included");

		JsonObject bow = new JsonObject();
		CountFightChoices.copy(JsonParser.parseString("{\"drawDurationMs\":1500,\"trackTarget\":false}").getAsJsonObject(), bow);
		CountFightChoices volley = CountFightChoices.from(bow);
		check(volley.draw() == 1500 && !volley.track(), "use_ranged count mode keeps the model's draw and tracking");
	}

	private static void verifyDefaultsUnchanged() {
		CountFightChoices none = CountFightChoices.from(new JsonObject());
		check(none.mayMove() && none.meleePursue(false) && !none.meleePursue(true), "no pursue given: pursue outside a roof, in place under it");
		check(none.meleeShield(true, true) && !none.meleeShield(true, false) && !none.meleeShield(false, true), "no shield given: melee shield against blazes only, with one in the offhand");
		check(none.guardShield(true) && !none.guardShield(false), "no shield given: the shot guard runs with an offhand shield");
		check(!none.sneak() && none.desiredRange() == null && none.draw() == 1000 && none.track(), "engine defaults otherwise");
	}

	private static void verifyEngagementGates() {
		check(ServerFightUntilController.engageable(true, false, true), "a living target the policy allows is engaged");
		check(!ServerFightUntilController.engageable(true, false, false), "a target the protection policy denies is never engaged");
		check(!ServerFightUntilController.engageable(true, true, true), "creative or spectator players are never engaged");
		check(!ServerFightUntilController.engageable(false, false, true), "a dead target is never engaged");
	}

	private static void verifyIdleWalk() {
		long tick = 123_456L;
		// A short walk (recover, roof) can sit un-ticked while no target is seen: it is put down before the 40-tick lease expiry.
		check(!ServerFightUntilController.stepIdle(tick + 1L, tick), "a walk ticked last tick is kept");
		check(ServerFightUntilController.stepIdle(tick + 21L, tick), "a walk idle for over a second is put down");
		check(21L < dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController.LEASE_TIMEOUT_TICKS, "before its input lease expires");
	}

	private static void verifyTerminalLeaseRelease() {
		check(ServerFightUntilController.holdsGuardLease(false, true, false, false), "between ticks of backing off the raised shield's lease is kept");
		check(!ServerFightUntilController.holdsGuardLease(true, true, false, false), "a stop or cancel while backing off releases the combat input");
		check(!ServerFightUntilController.holdsGuardLease(true, false, true, true), "the call's end releases it in every state");
		check(!ServerFightUntilController.holdsGuardLease(false, false, false, false), "outside recovery it is released as before");
	}

	private static void verifyTargetingChoicesSurvive() {
		JsonObject call = JsonParser.parseString("{\"targetId\":\"b\",\"untilItem\":\"minecraft:blaze_rod\",\"untilCount\":6,"
				+ "\"targetPolicy\":\"highest_risk\",\"continueWithAttackers\":true,\"includePlayers\":true}").getAsJsonObject();
		JsonObject until = new JsonObject();
		CountFightChoices.copy(call, until);
		for (String field : new String[] { "targetPolicy", "continueWithAttackers", "includePlayers" })
			check(until.has(field) && until.get(field).equals(call.get(field)), "count promotion carries the model's " + field);
		CountFightChoices kept = CountFightChoices.from(until);
		check(kept.targetPolicy() == CombatPlanning.TargetPolicy.HIGHEST_RISK, "targetPolicy reaches the engine");
		check(kept.followThrough() && kept.candidate(false, true, false), "continueWithAttackers:true: another kind attacking the body is a candidate");
		check(!kept.candidate(false, false, false), "but never one that is not attacking (a policy never starts a new fight)");
		check(kept.candidate(false, true, true) && kept.candidate(true, false, true), "includePlayers:true: players are candidates");

		CountFightChoices none = CountFightChoices.from(new JsonObject());
		check(none.targetPolicy() == CombatPlanning.TargetPolicy.NAMED && !none.followThrough(), "defaults: named target first, no follow-through");
		check(none.candidate(true, false, false) && !none.candidate(false, true, false), "defaults: the mob type only (unchanged)");
		check(!none.candidate(true, true, true) && !none.candidate(false, true, true), "defaults: never a player, attacking or not");
		check(none.reachTurn(true) && none.reachTurn(false), "defaults: the bow is put down for any attacker in sword reach (unchanged)");

		CountFightChoices policyOnly = CountFightChoices.from(JsonParser.parseString("{\"targetPolicy\":\"nearest_attacker\"}").getAsJsonObject());
		check(policyOnly.followThrough() && policyOnly.candidate(false, true, false), "a targetPolicy alone opts into follow-through, as in fight_target");
		CountFightChoices noFollow = CountFightChoices.from(JsonParser.parseString("{\"targetPolicy\":\"nearest_attacker\",\"continueWithAttackers\":false}").getAsJsonObject());
		check(!noFollow.followThrough() && !noFollow.candidate(false, true, false), "an explicit continueWithAttackers:false wins over the policy");
		check(noFollow.reachTurn(true) && !noFollow.reachTurn(false), "continueWithAttackers:false: the bow is put down only for the target's kind");
		try {
			CountFightChoices.from(JsonParser.parseString("{\"targetPolicy\":\"weakest\"}").getAsJsonObject());
			check(false, "an unknown targetPolicy is refused");
		} catch (dev.agaminggod.mineagen.agent.AgentDomainException refused) {
			check("INVALID_FIELD".equals(refused.code()), "an unknown targetPolicy is refused with INVALID_FIELD before the run starts");
		}
		java.util.List<String> fields = java.util.List.of(CountFightChoices.FIELDS);
		check(fields.containsAll(java.util.List.of("targetPolicy", "continueWithAttackers", "includePlayers")), "the executor's copy list names the targeting fields");
	}

	private static void verifyStationaryStance() {
		CountFightChoices still = CountFightChoices.from(JsonParser.parseString("{\"pursue\":false,\"sneak\":true}").getAsJsonObject());
		check(!still.mayMove(), "pursue:false: no fire-exit step, no pillar (the engine hands back ON_FIRE / LOW_HEALTH_BAILOUT instead)");
		check(!still.mayReposition(), "pursue:false: no backing-off walk");
		check(!still.collectByDefault(), "pursue:false: drops are not walked to unless the model said collect:true");
		check(still.sneak(), "sneak:true reaches the guard, recovery and perch inputs");
		CountFightChoices crouched = CountFightChoices.from(JsonParser.parseString("{\"sneak\":true}").getAsJsonObject());
		check(crouched.mayMove() && !crouched.mayReposition(), "sneak:true: fire steps stay (crouched), upright navigation walks do not");
		CountFightChoices none = CountFightChoices.from(new JsonObject());
		check(none.mayMove() && none.mayReposition() && none.collectByDefault() && !none.sneak(), "defaults unchanged");
	}

	private static void verifyRound3Gates() {
		check(ServerFightUntilController.followable(true, true), "a count fight the model aimed at creepers fights creepers");
		check(!ServerFightUntilController.followable(false, true), "another kind's creeper is never a follow-through, sword-turn or fallback target");
		check(ServerFightUntilController.followable(false, false), "other attacking kinds stay followable on the model's opt-in");
		check(ServerFightUntilController.STANCE_PRIORITY < 100 && 100 < CombatInputLease.PRIORITY,
				"the sneak:true stance lease is below navigation (100) and combat (200): it fills only ticks nobody drives");
		check(ServerFightUntilController.STILL_REACH_MS < ServerFightUntilController.DEFAULT_TIMEOUT_MS,
				"pursue:false hands back an out-of-reach target before the call's timeout");
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
