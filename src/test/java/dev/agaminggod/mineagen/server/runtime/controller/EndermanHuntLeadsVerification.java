package dev.agaminggod.mineagen.server.runtime.controller;

import java.util.UUID;
import net.minecraft.world.phys.Vec3;

public final class EndermanHuntLeadsVerification {
	private EndermanHuntLeadsVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " enderman hunt lead assertions");
	}

	public static int verify() {
		int assertions = 0;
		Vec3 center = new Vec3(0.0D, 64.0D, 0.0D);
		UUID blocked = new UUID(0L, 1L);
		UUID far = new UUID(0L, 2L);
		UUID reachable = new UUID(0L, 3L);

		// A hunt walk ticked every game tick keeps its lease; one held back for a tick or more is planned afresh.
		check(!EndermanHuntLeads.walkLeftUnticked(100L, 101L), "a walk ticked on the next game tick is kept");
		assertions++;
		check(EndermanHuntLeads.walkLeftUnticked(100L, 141L), "a walk left unticked past its 40-tick lease is replanned");
		assertions++;
		EndermanHuntLeads leads = new EndermanHuntLeads(center, 24.0D, 120_000L);
		leads.saw(blocked, new Vec3(10.0D, 64.0D, 0.0D), 0L);
		EndermanHuntLeads.Lead lead = leads.next(center, 0L, 3.0D, id -> false);
		check(lead != null && lead.id().equals(blocked), "the seen enderman in the area is walked to");
		assertions++;
		leads.walkEnded(blocked, false, "NO_SEEN_ROUTE");
		for (long ms = 250L; ms < 60_000L; ms += 250L) leads.saw(blocked, new Vec3(10.0D, 64.0D, 0.0D), ms);
		check(leads.next(center, 60_000L, 3.0D, id -> false) == null, "an enderman with no seen route is not walked to again");
		assertions++;
		check(leads.left(blocked) && leads.tried() == 1 && leads.noRoute() == 1, "it counts as one enderman tried, one with no route");
		assertions++;

		// The area stays anchored at the model's center: a sighting outside the radius is a fact, not a walk.
		leads.saw(far, new Vec3(60.0D, 64.0D, 0.0D), 61_000L);
		check(leads.next(new Vec3(30.0D, 64.0D, 0.0D), 61_000L, 3.0D, id -> false) == null,
				"a sighting outside the area is not walked to, even when the body has moved toward it");
		assertions++;
		Vec3 outside = leads.nearestOutside(center, 61_000L);
		check(outside != null && outside.x == 60.0D, "the sighting outside the area is reported");
		assertions++;

		leads.saw(reachable, new Vec3(-12.0D, 64.0D, 5.0D), 62_000L);
		lead = leads.next(center, 62_000L, 3.0D, id -> false);
		check(lead != null && lead.id().equals(reachable), "a reachable sighting in the area is walked to");
		assertions++;
		leads.walkEnded(reachable, true, "ARRIVED");
		check(leads.next(center, 62_100L, 3.0D, id -> false) == null, "a reached sighting is spent");
		assertions++;
		leads.saw(reachable, new Vec3(-14.0D, 64.0D, 5.0D), 63_000L);
		check(leads.next(center, 63_000L, 3.0D, id -> false) != null, "seen again elsewhere, it is walked to a second time");
		assertions++;
		leads.walkEnded(reachable, false, "TIMEOUT");
		leads.saw(reachable, new Vec3(-14.0D, 64.0D, 5.0D), 64_000L);
		check(leads.next(center, 64_000L, 3.0D, id -> false) == null && leads.left(reachable), "two walks without a fight leave it");
		assertions++;

		EndermanHuntLeads fresh = new EndermanHuntLeads(center, 24.0D, 120_000L);
		fresh.saw(blocked, new Vec3(1.0D, 64.0D, 1.0D), 0L);
		check(fresh.next(center, 1_000L, 3.0D, id -> false) == null && fresh.tried() == 0, "a sighting where the body stands is no walk");
		assertions++;
		fresh.saw(far, new Vec3(15.0D, 64.0D, 0.0D), 0L);
		check(fresh.next(center, 1_000L, 3.0D, id -> id.equals(far)) == null, "a skipped enderman is not walked to");
		assertions++;
		check(fresh.next(center, 130_000L, 3.0D, id -> false) == null, "a sighting older than its lifetime is forgotten");
		assertions++;
		return assertions;
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
	}
}
