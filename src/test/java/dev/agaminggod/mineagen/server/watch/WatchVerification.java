package dev.agaminggod.mineagen.server.watch;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import java.io.IOException;
import java.io.UncheckedIOException;
import java.lang.reflect.Field;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.stream.Stream;

/** Watcher episode state machine, outcome rules, diagnosis precedence, schema and isolation, without a server. */
public final class WatchVerification {
	private static int assertions;
	private static final Set<String> VOCABULARY = Set.of("creeper_fusing", "hostile_near", "lava_near", "in_lava", "on_fire", "edge_near",
			"falling", "incoming_projectile", "air_below", "health_below");

	private WatchVerification() {
	}

	public static int verify() {
		assertions = 0;
		opensBelowThresholdAndMergesSameSource();
		closesAfterGrace();
		outcomes();
		damageAttribution();
		deathClosesEverything();
		diagnosisPrecedence();
		heardDragon();
		schema();
		isolation();
		harmUnderAnotherCommand();
		offUnlessOptedIn();
		dangerOnsetsOncePerSource();
		dangerResponses();
		dangerDamageRows();
		dangerClearAndDeath();
		dangerEventCursor();
		dangerGoldenRows();
		return assertions;
	}

	private static final String AGENT = "00000000-0000-0000-0000-000000000a01";

	private static Danger targeting(String key, String kind) {
		return new Danger(key, kind, "minecraft:skeleton", key, null, 2.0D, 10.0D, true);
	}

	private static DangerLog.Command command(String id, String program, String step, String issuer) {
		return new DangerLog.Command(id, "fight_target", program, step, issuer);
	}

	private static List<JsonObject> rows(List<JsonObject> rows, String type) {
		return rows.stream().filter(row -> type.equals(row.get("type").getAsString())).toList();
	}

	private static String text(JsonObject row, String field) {
		return row.get(field) == null || row.get(field).isJsonNull() ? null : row.get(field).getAsString();
	}

	/** One targeted onset per mob however often the scan sees it; a mob merely nearby (not targeting) has none. */
	private static void dangerOnsetsOncePerSource() {
		DangerLog log = new DangerLog(AGENT);
		Danger idle = new Danger("idle", "creeper", "minecraft:creeper", "idle", null, 1.0D, 5.0D, false);
		for (long tick = 0; tick <= 210; tick += 2) log.observe(List.of(targeting("m1", "ranged_mob"), targeting("m2", "mob"), idle), tick, tick * 50L, null, null);
		List<JsonObject> onsets = rows(log.take(), "onset");
		check(onsets.size() == 2 && onsets.stream().map(row -> text(row, "key")).distinct().count() == 2, "one targeted onset per mob, no duplicates: " + onsets);
		check(onsets.stream().allMatch(row -> "targeted".equals(text(row, "onset")) && "none".equals(text(row, "response")) && row.get("latencyTicks").isJsonNull()),
				"no response within 200 ticks is none");
		check("ranged_mob".equals(text(onsets.get(0), "kind")), "the onset keeps the scan kind");
		log.observe(List.of(new Danger("s1", "projectile", "minecraft:skeleton", "s1", null, 0.5D, 8.0D)), 300, 15_000L, null, null);
		log.observe(List.of(), 501, 25_050L, null, null);
		check(rows(log.take(), "onset").stream().anyMatch(row -> "aimed".equals(text(row, "onset")) && "s1".equals(text(row, "key"))), "a shot on course is an aimed onset");
	}

	private static void dangerResponses() {
		DangerLog.FiringNow defend = new DangerLog.FiringNow("defend", 0L, Set.of("hostile_near"));
		DangerLog running = new DangerLog(AGENT);
		running.observe(List.of(targeting("z", "mob")), 10, 500L, defend, null);
		JsonObject zero = rows(running.take(), "onset").getFirst();
		check("instinct:defend".equals(text(zero, "response")) && zero.get("latencyTicks").getAsLong() == 0L, "a covering firing already running is latency 0");

		DangerLog later = new DangerLog(AGENT);
		later.observe(List.of(targeting("z", "mob")), 10, 500L, null, null);
		later.observe(List.of(targeting("z", "mob")), 16, 800L, new DangerLog.FiringNow("defend", 16L, Set.of("hostile_near")), null);
		JsonObject instinct = rows(later.take(), "onset").getFirst();
		check("instinct:defend".equals(text(instinct, "response")) && instinct.get("latencyTicks").getAsLong() == 6L, "a covering firing after the onset responds");

		DangerLog uncovered = new DangerLog(AGENT);
		uncovered.observe(List.of(targeting("z", "mob")), 10, 500L, null, null);
		uncovered.observe(List.of(targeting("z", "mob")), 12, 600L, new DangerLog.FiringNow("eat", 12L, Set.of("hunger_below")), null);
		uncovered.observe(List.of(), 211, 10_550L, null, null);
		check("none".equals(text(rows(uncovered.take(), "onset").getFirst(), "response")), "a firing that does not cover the danger is no response");

		for (String[] issuer : new String[][] {{"model", "command:model"}, {"skill_leg", "command:model"}, {"program", "command:program"},
				{"standing_order", "command:program"}, {"guard", "command:program"}, {null, "command:unknown"}}) {
			DangerLog log = new DangerLog(AGENT);
			log.observe(List.of(targeting("z", "mob")), 10, 500L, null, null);
			log.command(command("act-1", "native-turn-1", "call-1", issuer[0]), 14);
			log.observe(List.of(targeting("z", "mob")), 14, 700L, null, null);
			JsonObject row = rows(log.take(), "onset").getFirst();
			check(issuer[1].equals(text(row, "response")) && row.get("latencyTicks").getAsLong() == 4L && "act-1".equals(text(row, "responseActionId")),
					"issuer " + issuer[0] + " is " + issuer[1]);
		}

		// A keepGoing leg or later sequence step of a command chosen before the onset continues it; it is not a response.
		DangerLog legs = new DangerLog(AGENT);
		legs.command(command("leg-1", "native-turn-2", "call-9-leg1", "skill_leg"), 5);
		legs.observe(List.of(targeting("z", "mob")), 10, 500L, null, null);
		legs.command(command("leg-2", "native-turn-2", "call-9-leg2", "skill_leg"), 12);
		legs.command(command("step-2", "native-turn-2", "call-9:2", "skill_leg"), 13);
		legs.observe(List.of(), 211, 10_550L, null, null);
		check("none".equals(text(rows(legs.take(), "onset").getFirst(), "response")), "a leg start is not a response");
		check(DangerLog.path("model").equals("command:model") && DangerLog.path("bogus").equals("command:unknown"), "unknown issuers stay unknown");

		// A model chat line is routed beside the running action; it does not answer the onset, the next body command does.
		DangerLog chat = new DangerLog(AGENT);
		chat.observe(List.of(targeting("z", "mob")), 10, 500L, null, null);
		chat.command(new DangerLog.Command("say-1", "chat", "native-turn-4", "call-1", "model"), 12);
		chat.command(new DangerLog.Command("act-2", "flee_from", "native-turn-4", "call-2", "model"), 16);
		chat.observe(List.of(), 211, 10_550L, null, null);
		JsonObject answered = rows(chat.take(), "onset").getFirst();
		check("act-2".equals(text(answered, "responseActionId")) && answered.get("latencyTicks").getAsLong() == 6L, "a chat line is not a response");

		DangerLog late = new DangerLog(AGENT);
		late.observe(List.of(targeting("z", "mob")), 10, 500L, null, null);
		late.command(command("act-late", "native-turn-3", "call-1", "model"), 211);
		late.observe(List.of(), 212, 10_600L, null, null);
		check("none".equals(text(rows(late.take(), "onset").getFirst(), "response")), "a command after 200 ticks is not a response");
	}

	private static void dangerDamageRows() {
		DangerLog log = new DangerLog(AGENT);
		log.beforeDamage(100L, 20.0F, 4.0F, 6.0F);
		log.damage(100L, "mob", "minecraft:mob_attack", "minecraft:zombie", "z1", "z1", 6.0F, 3.0F, false, 20.0F, 1.0F, false, 1000L, 50_000L, null);
		log.beforeDamage(200L, 20.0F, 0.0F, 5.0F);
		log.damage(200L, "projectile", "minecraft:arrow", "minecraft:skeleton", "s1", "s1", 5.0F, 0.0F, true, 20.0F, 0.0F, false, 1100L, 55_000L, null);
		log.beforeDamage(300L, 3.0F, 0.0F, 8.0F);
		log.damage(300L, "mob", "minecraft:mob_attack", "minecraft:zombie", "z1", "z1", null, null, false, 3.0F, 0.0F, true, 1200L, 60_000L, null);
		log.beforeDamage(400L, 20.0F, 0.0F, 2.0F);
		log.damage(401L, "fall", "minecraft:fall", null, null, null, 2.0F, 2.0F, false, 18.0F, 0.0F, false, 1301L, 65_050L, null);
		List<JsonObject> taken = log.take();
		List<JsonObject> hits = rows(taken, "damage");
		check(hits.size() == 4, "every hit is a row, blocked and lethal ones too");
		JsonObject absorbed = hits.get(0), blocked = hits.get(1), lethal = hits.get(2), unpaired = hits.get(3);
		check(absorbed.get("absorbed").getAsDouble() == 3.0D && absorbed.get("healthDrop").getAsDouble() == 0.0D, "absorbed HP is its own field");
		check(blocked.get("blocked").getAsBoolean() && blocked.get("taken").getAsDouble() == 0.0D && blocked.get("healthDrop").getAsDouble() == 0.0D,
				"a fully shield-blocked hit is kept");
		check(lethal.get("lethal").getAsBoolean() && lethal.get("healthAfter").getAsDouble() == 0.0D && lethal.get("healthDrop").getAsDouble() == 3.0D
				&& lethal.get("amount").getAsDouble() == 8.0D && lethal.get("taken").isJsonNull(), "the lethal hit is written with its paired amount");
		check(!unpaired.get("paired").getAsBoolean() && unpaired.get("healthDrop").isJsonNull(), "a hit without a same-tick before value is unpaired, not 0");
		List<JsonObject> onsets = rows(taken, "onset");
		log.observe(List.of(), 1600L, 80_000L, null, null);
		List<JsonObject> after = log.take();
		check(rows(after, "onset").stream().anyMatch(row -> "hit".equals(text(row, "onset")) && "fall".equals(text(row, "key"))) && onsets.isEmpty(),
				"an unforeseen hit opens a hit onset keyed by its source or kind");
		check(rows(after, "onset").stream().filter(row -> "hit".equals(text(row, "onset"))).count() == 3, "one hit onset per source: z1, s1, fall");
	}

	private static void dangerClearAndDeath() {
		DangerLog log = new DangerLog(AGENT);
		for (long tick = 0; tick <= 60; tick += 2) log.observe(List.of(targeting("m1", "mob")), tick, tick * 50L, null, null);
		for (long tick = 62; tick < 100; tick += 2) log.observe(List.of(), tick, tick * 50L, null, null);
		check(rows(log.take(), "clear").isEmpty(), "no clear inside the grace");
		log.observe(List.of(), 100, 5_000L, null, null);
		List<JsonObject> clears = rows(log.take(), "clear");
		check(clears.size() == 1 && clears.getFirst().get("threatTicks").getAsLong() == 60L && clears.getFirst().get("startGameTime").getAsLong() == 0L
				&& "quiet".equals(text(clears.getFirst(), "cause")), "clear after the last close, threat from first onset to last activity: " + clears);
		DangerLog dying = new DangerLog(AGENT);
		dying.observe(List.of(targeting("m1", "mob")), 10, 500L, null, null);
		dying.death(30, 1_500L);
		List<JsonObject> rows = dying.take();
		check(rows(rows, "onset").getFirst().get("truncated").getAsBoolean() && "death".equals(text(rows(rows, "clear").getFirst(), "cause")),
				"death resolves open onsets as truncated and clears the threat");
	}

	private static void dangerEventCursor() {
		dev.agaminggod.mineagen.server.runtime.reflex.ReflexScheduler.Event first = event(1, 5, 20, true);
		dev.agaminggod.mineagen.server.runtime.reflex.ReflexScheduler.Event second = event(2, 0, 30, false);
		DangerLog log = new DangerLog(AGENT);
		log.events(List.of(first, second), 1L, 1000L, 1030L, 1_000L);
		log.events(List.of(first, second), 1L, 1000L, 1031L, 1_050L);
		List<JsonObject> rows = log.take();
		check(rows.size() == 2 && "firing".equals(text(rows.get(0), "type")) && "held_back".equals(text(rows.get(1), "event")), "each event is one row");
		JsonObject firing = rows.getFirst();
		check(firing.get("startGameTime").getAsLong() == 1015L && firing.get("endGameTime").getAsLong() == 1020L
				&& firing.get("startGameTime").getAsLong() <= firing.get("endGameTime").getAsLong(), "firing ticks convert to game time, start before end");
		log.events(List.of(event(1, 3, 50, true)), 2L, 1000L, 1050L, 2_000L);
		check(rows(log.take(), "firing").size() == 1 && log.eventCursor() == 1L, "a replaced scheduler resets the cursor");
		// After clearAll the new scheduler can reach the old sequence before the next read: its events are still new.
		log.events(List.of(event(1, 2, 60, true), event(2, 0, 61, false), event(3, 2, 70, true)), 3L, 1000L, 1070L, 3_000L);
		check(log.take().size() == 3 && log.eventCursor() == 3L, "a new scheduler past the old cursor still has every event read");
		EventCursor cursor = new EventCursor();
		check(cursor.fresh(7L, List.of(first, second)).size() == 2 && cursor.fresh(7L, List.of(first, second)).isEmpty(), "the same scheduler's events are read once");
		check(cursor.fresh(8L, List.of(first, second)).size() == 2, "the Watcher's firing cursor follows the scheduler generation");
	}

	private static dev.agaminggod.mineagen.server.runtime.reflex.ReflexScheduler.Event event(long sequence, long duration, long end, boolean firing) {
		var outcome = firing ? dev.agaminggod.mineagen.server.runtime.reflex.ReflexScheduler.Outcome.DONE : dev.agaminggod.mineagen.server.runtime.reflex.ReflexScheduler.Outcome.YIELDED;
		return new dev.agaminggod.mineagen.server.runtime.reflex.ReflexScheduler.Event(sequence, "defend", outcome, duration, firing ? "" : "held back: short of air",
				false, end, firing);
	}

	/** One golden line per row kind; coordinator/test/quality-reflex-report.test.mjs reads the same file. */
	private static void dangerGoldenRows() {
		DangerLog log = new DangerLog(AGENT);
		log.observe(List.of(targeting("z1", "mob")), 1000L, 1_700_000_000_000L, null, null);
		log.command(command("act-1", "native-turn-1", "call-1", "model"), 1006L);
		log.beforeDamage(77L, 20.0F, 4.0F, 6.0F);
		log.damage(77L, "mob", "minecraft:mob_attack", "minecraft:zombie", "z1", "z1", 6.0F, 5.0F, false, 18.0F, 1.0F, false, 1010L, 1_700_000_000_500L, null);
		log.observe(List.of(), 1012L, 1_700_000_000_600L, null, null);
		log.events(List.of(event(1, 4, 60, true), event(2, 0, 61, false)), 1L, 1000L, 1061L, 1_700_000_003_050L);
		log.observe(List.of(), 1050L, 1_700_000_002_500L, null, null);
		StringBuilder generated = new StringBuilder();
		for (JsonObject row : log.take()) generated.append(WatchJson.line(row)).append('\n');
		Path fixture = Path.of("coordinator/test/fixtures/reflex-danger-rows.jsonl");
		try {
			String expected = Files.readString(fixture).replace("\r\n", "\n");
			check(expected.equals(generated.toString()), "danger rows match " + fixture + "; generated:\n" + generated);
		} catch (IOException failure) {
			throw new AssertionError("WatchVerification: missing " + fixture + "; generated:\n" + generated, failure);
		}
	}

	/**
	 * A player's server pays nothing for the Watcher: without {@code -Dmineagen.watch=true} it registers no tick,
	 * damage, death or bridge handler. The harness launchers whose reports read arena-watch files opt in explicitly.
	 */
	private static void offUnlessOptedIn() {
		String previous = System.getProperty(Watcher.ENABLE_PROPERTY);
		try {
			System.clearProperty(Watcher.ENABLE_PROPERTY);
			check(!Watcher.enabled(), "the Watcher is off when nothing opts in");
			for (String off : List.of("false", "", "1", "yes", "on")) {
				System.setProperty(Watcher.ENABLE_PROPERTY, off);
				check(!Watcher.enabled(), "only true opts in, not '" + off + "'");
			}
			for (String on : List.of("true", "TRUE", " true ")) {
				System.setProperty(Watcher.ENABLE_PROPERTY, on);
				check(Watcher.enabled(), "'" + on + "' opts in");
			}
			System.clearProperty(Watcher.ENABLE_PROPERTY);
			Field registered = Watcher.class.getDeclaredField("registered");
			registered.setAccessible(true);
			boolean before = registered.getBoolean(null);
			Watcher.register();
			check(registered.getBoolean(null) == before, "registering without the opt-in adds no handlers");
		} catch (ReflectiveOperationException failure) {
			throw new AssertionError("WatchVerification: Watcher registration state is unreadable", failure);
		} finally {
			if (previous == null) System.clearProperty(Watcher.ENABLE_PROPERTY);
			else System.setProperty(Watcher.ENABLE_PROPERTY, previous);
		}
		Map<String, Integer> launchers = Map.of("scripts/run-headless-provider-matrix.mjs", 1,
				"scripts/run-headless-provider-matrix.ps1", 2, "scripts/quality/test-progress-live.mjs", 1);
		launchers.forEach((file, servers) -> {
			try {
				String text = Files.readString(Path.of(file));
				check(text.split("-Dmineagen\\.watch=true", -1).length - 1 == servers,
						file + " opts each server it starts into the Watcher its reports read");
			} catch (IOException failure) {
				throw new UncheckedIOException(failure);
			}
		});
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("WatchVerification: " + message);
		assertions++;
	}

	private static Danger mob(String uuid, double eta) {
		return new Danger(uuid, "mob", "minecraft:zombie", uuid, null, eta, 3.0D);
	}

	private static void opensBelowThresholdAndMergesSameSource() {
		EpisodeTracker tracker = new EpisodeTracker("a");
		tracker.observe(List.of(mob("z1", 5.0D)), 0L, 0L, 20.0F, false);
		check(!tracker.hasOpen(), "a danger 5 s away opens nothing");
		tracker.observe(List.of(mob("z1", 2.5D)), 1L, 50L, 20.0F, false);
		check(tracker.hasOpen(), "a danger under 3 s opens an episode");
		check(tracker.takeOpened().size() == 1, "one episode opened");
		tracker.observe(List.of(mob("z1", 1.5D), new Danger("z1", "projectile", "minecraft:skeleton", "z1", null, 0.4D, 9.0D)), 2L, 100L, 20.0F, false);
		check(tracker.takeOpened().isEmpty(), "the same source keeps its episode");
		Episode episode = tracker.open().iterator().next();
		check(episode.minEtaS == 0.4D, "the minimum time-to-harm is kept");
		tracker.observe(List.of(mob("z2", 1.0D)), 3L, 150L, 20.0F, false);
		check(tracker.takeOpened().size() == 1, "another source opens its own episode");
	}

	private static void closesAfterGrace() {
		EpisodeTracker tracker = new EpisodeTracker("a");
		tracker.observe(List.of(mob("z1", 2.0D)), 0L, 0L, 20.0F, false);
		// Still present but no longer active (6 s away): only the grace period keeps it.
		check(tracker.observe(List.of(mob("z1", 6.0D)), EpisodeTracker.GRACE_TICKS - 1L, 1_000L, 20.0F, false).isEmpty(),
				"inside the grace period the episode stays open");
		tracker.observe(List.of(mob("z1", 2.0D)), EpisodeTracker.GRACE_TICKS - 1L, 1_000L, 20.0F, false);
		check(tracker.observe(List.of(), EpisodeTracker.GRACE_TICKS * 2L - 2L, 2_000L, 20.0F, false).isEmpty(), "renewed activity resets the grace");
		List<Episode> closed = tracker.observe(List.of(), EpisodeTracker.GRACE_TICKS * 2L, 3_000L, 20.0F, false);
		check(closed.size() == 1 && closed.get(0).closed(), "the episode closes once the grace has passed");
		check(closed.get(0).outcome().equals("avoided"), "2 s away at best and no harm is avoided");
		check(!tracker.hasOpen(), "nothing left open");
	}

	private static String outcomeOf(double minEta, float minHealth, boolean burning, float damage, boolean died) {
		Episode episode = new Episode("e", "a", mob("z", minEta), 0L, 0L);
		episode.minEtaS = minEta;
		episode.minHealth = minHealth;
		episode.burnedOrInLava = burning;
		episode.damage = damage;
		episode.died = died;
		return EpisodeTracker.outcome(episode);
	}

	private static void outcomes() {
		check(outcomeOf(0.0D, 0.0F, true, 5.0F, true).equals("death"), "death wins");
		check(outcomeOf(0.0D, 10.0F, false, 2.0F, false).equals("damage"), "damage without death");
		check(outcomeOf(0.8D, 20.0F, false, 0.0F, false).equals("close_call"), "under a second is a close call");
		check(outcomeOf(2.0D, 6.0F, false, 0.0F, false).equals("close_call"), "health at 6 is a close call");
		check(outcomeOf(2.0D, 20.0F, true, 0.0F, false).equals("close_call"), "burning or in lava is a close call");
		check(outcomeOf(1.0D, 6.5F, false, 0.0F, false).equals("avoided"), "a second away and healthy is avoided");
	}

	private static void damageAttribution() {
		EpisodeTracker tracker = new EpisodeTracker("a");
		tracker.observe(List.of(mob("skel", 1.2D), new Danger("lava", "lava", "minecraft:lava", null, new int[] {1, 2, 3}, 0.5D, 0.4D)),
				0L, 0L, 20.0F, false);
		tracker.takeOpened();
		Episode shot = tracker.damage("skel", "projectile", "minecraft:skeleton", "skel", null, 3.0F, 17.0F, 1L, 50L);
		check(shot.key().equals("skel") && shot.damage() == 3.0F, "a shooter's arrow joins the shooter's episode");
		Episode burn = tracker.damage(null, "burning", "minecraft:on_fire", null, null, 1.0F, 16.0F, 2L, 100L);
		check(burn.kind().equals("lava"), "fire damage joins the open lava episode");
		check(tracker.takeOpened().isEmpty(), "attributed damage opens nothing");
		Episode fall = tracker.damage(null, "fall", "minecraft:fall", null, new int[] {0, 60, 0}, 4.0F, 12.0F, 3L, 150L);
		check(fall.kind().equals("fall") && tracker.takeOpened().size() == 1, "unforeseen damage opens its own episode");
		check(fall.firstHarmEpochMs() == 150L && fall.minEtaS() == 0.0D, "harm sets the first-harm time and contact");
	}

	private static void deathClosesEverything() {
		EpisodeTracker tracker = new EpisodeTracker("a");
		tracker.observe(List.of(mob("z1", 1.0D), mob("z2", 2.5D)), 0L, 0L, 20.0F, false);
		List<Episode> closed = tracker.death("z1", "mob", "minecraft:zombie", "z1", null, "a was slain by Zombie", 5L, 250L);
		check(closed.size() == 2 && !tracker.hasOpen(), "death closes every open episode");
		Episode killer = closed.stream().filter(episode -> episode.key().equals("z1")).findFirst().orElseThrow();
		Episode other = closed.stream().filter(episode -> episode.key().equals("z2")).findFirst().orElseThrow();
		check(killer.outcome().equals("death") && "a was slain by Zombie".equals(killer.deathMessage), "the killer's episode records the death");
		check(other.outcome().equals("avoided"), "the bystander's episode keeps its own outcome");
	}

	private static Episode harmed(String kind, String entityId) {
		Episode episode = new Episode("e", "a", new Danger("k", kind, "minecraft:x", entityId, null, 0.0D, 0.0D), 0L, 1_000L);
		episode.damage = 4.0F;
		episode.firstHarmEpochMs = 2_000L;
		episode.closedEpochMs = 3_000L;
		episode.outcome = "damage";
		episode.perceivable = true;
		episode.inObservation = true;
		episode.inThreatFacts = true;
		return episode;
	}

	private static String label(Episode episode) {
		Diagnosis.diagnose(episode, VOCABULARY);
		check(episode.evidence() != null && !episode.evidence().isEmpty(), "every label carries evidence");
		return episode.diagnosis();
	}

	private static void diagnosisPrecedence() {
		Episode all = harmed("lava", null);
		all.causedByAction = true;
		all.action = "navigate_to";
		all.fired.add(new Episode.Firing("lava", 1_500L, "failed"));
		all.perceivable = false;
		check(label(all).equals("BODY_CAUSED"), "body walking into it outranks everything");
		Episode nearMiss = harmed("drop", null);
		nearMiss.damage = 0.0F;
		nearMiss.firstHarmEpochMs = -1L;
		nearMiss.outcome = "close_call";
		nearMiss.causedByAction = true;
		nearMiss.action = "navigate_to";
		check(!label(nearMiss).equals("BODY_CAUSED"), "a body action that only came near is not blamed");

		Episode failed = harmed("lava", null);
		failed.fired.add(new Episode.Firing("lava", 1_500L, "failed: no exit"));
		failed.perceivable = false;
		check(label(failed).equals("REFLEX_FAILED"), "a covering reflex that fired before the harm failed");

		Episode slow = harmed("mob", "z");
		slow.fired.add(new Episode.Firing("flee", 2_400L, "done"));
		slow.armed.add("flee:hostile_near");
		check(label(slow).equals("REFLEX_SLOW"), "a covering reflex that fired after the harm was slow");
		Episode late = harmed("mob", "z");
		late.fired.add(new Episode.Firing("flee", 10_000L, "done"));
		check(label(late).equals("MODEL_CHOICE") && late.evidence().contains("armed later"),
				"a covering rule armed only after the harm began was missing, not slow: " + late.evidence());

		Episode hidden = harmed("lava_hidden", null);
		hidden.perceivable = false;
		hidden.inObservation = false;
		check(label(hidden).equals("UNPERCEIVABLE"), "nothing a player could perceive");

		Episode gap = harmed("creeper", "c");
		gap.inObservation = false;
		check(label(gap).equals("PERCEPTION_GAP"), "perceivable but missing from the observation");

		Episode noPrimitive = harmed("dragon_breath", "cloud");
		check(label(noPrimitive).equals("NO_PRIMITIVE"), "no vocabulary covers the kind (cloud_near absent here)");

		Episode fact = harmed("mob", "z");
		fact.inThreatFacts = false;
		check(label(fact).equals("FACT_GAP"), "seen but not described as a threat");

		Episode choice = harmed("mob", "z");
		check(label(choice).equals("MODEL_CHOICE"), "everything was there: the model's choice");

		Episode escaped = harmed("mob", "z");
		escaped.damage = 0.0F;
		escaped.firstHarmEpochMs = -1L;
		escaped.outcome = "avoided";
		escaped.fired.add(new Episode.Firing("flee", 1_200L, "done"));
		check(label(escaped).equals("MODEL_CHOICE"), "a reflex that worked is not a reflex failure");

		check(Diagnosis.RULES.get(0).label().equals("BODY_CAUSED") && Diagnosis.RULES.get(Diagnosis.RULES.size() - 1).label().equals("MODEL_CHOICE"),
				"the rule table is ordered by precedence with MODEL_CHOICE last");
		check(Diagnosis.RULES.size() == 8, "exactly eight labels");
	}

	private static void schema() {
		Episode episode = harmed("creeper", "c-1");
		episode.dim = "minecraft:overworld";
		episode.armed.add("boom:creeper_fusing");
		episode.lastReplyAgoS = 4.25D;
		Diagnosis.diagnose(episode, VOCABULARY);
		JsonObject row = JsonParser.parseString(WatchJson.line(WatchJson.episode(episode))).getAsJsonObject();
		for (String key : List.of("v", "type", "id", "agentId", "dim", "pos", "kind", "source", "openedAt", "closedAt", "minEtaS", "minHealth",
				"outcome", "damage", "deathMessage", "perceived", "cover", "body", "model", "forecastId", "diagnosis", "evidence")) {
			check(row.has(key), "episode line has " + key);
		}
		check(row.keySet().size() == 22, "episode line has no extra fields");
		check(row.get("v").getAsInt() == 1 && row.get("type").getAsString().equals("episode"), "schema v1 episode");
		check(row.getAsJsonObject("source").get("block").isJsonNull() && row.getAsJsonObject("source").get("entityId").getAsString().equals("c-1"),
				"entity source has an id and a null block");
		check(row.getAsJsonObject("source").has("pos") && row.getAsJsonObject("body").get("action").isJsonNull(),
				"source.pos and a null body.action are present");
		episode.action = "navigate_to";
		episode.actionArguments = JsonParser.parseString("{\"x\":1,\"y\":64,\"z\":2}").getAsJsonObject();
		episode.sourcePos = new double[] {1.0D, 2.0D, 3.0D};
		JsonObject withAction = WatchJson.episode(episode);
		check(withAction.getAsJsonObject("body").getAsJsonObject("action").get("actionType").getAsString().equals("navigate_to")
				&& withAction.getAsJsonObject("body").getAsJsonObject("action").getAsJsonObject("arguments").get("y").getAsInt() == 64,
				"body.action is {actionType, arguments}");
		check(withAction.getAsJsonObject("source").getAsJsonObject("pos").get("z").getAsDouble() == 3.0D, "source.pos carries the position");
		check(row.get("deathMessage").isJsonNull() && row.get("forecastId").isJsonNull(), "unfilled fields are written as null");
		JsonObject forecast = JsonParser.parseString(WatchJson.line(WatchJson.forecast(new WatchJson.Forecast("f1", "a", 5L, "navigate_to", "lava",
				new int[] {1, 2, 3}, 4.5D, "route crosses lava")))).getAsJsonObject();
		check(forecast.keySet().equals(Set.of("v", "type", "id", "agentId", "atMs", "action", "hazard", "detail")), "forecast line fields");
		check(forecast.getAsJsonObject("hazard").keySet().equals(Set.of("kind", "block", "distance")), "forecast hazard fields");
		check(Forecasts.matches("lava", new int[] {1, 2, 3}, "lava", new int[] {2, 2, 4}), "an episode next to a forecast hazard links");
		check(!Forecasts.matches("lava", new int[] {1, 2, 3}, "lava", new int[] {9, 2, 9}), "a distant one does not");
	}

	/** A dragon sound reaches the agent without a uuid; the dragon is one per fight, so it counts as heard while fresh. */
	private static void heardDragon() {
		JsonObject delivery = JsonParser.parseString("{\"perception\":{\"events\":["
				+ "{\"type\":\"sound\",\"soundId\":\"minecraft:entity.ender_dragon.ambient\",\"observedAtEpochMs\":1000},"
				+ "{\"type\":\"sound\",\"soundId\":\"minecraft:entity.ender_dragon.ambient\",\"observedAtEpochMs\":4000},"
				+ "{\"type\":\"sound\",\"soundId\":\"minecraft:entity.zombie.ambient\",\"observedAtEpochMs\":4000},"
				+ "{\"type\":\"sound\",\"soundId\":\"minecraft:block.lava.pop\",\"observedAtEpochMs\":4000}]}}").getAsJsonObject();
		java.util.Map<String, Long> heard = Watcher.heardTypes(delivery);
		check(heard.get("minecraft:ender_dragon") == 4000L && heard.get("minecraft:zombie") == 4000L && heard.size() == 2,
				"entity sounds are keyed by type with their latest time");
		Watcher.Delivered delivered = new Watcher.Delivered(Set.of(), Set.of(), false, false, 4000L, heard);
		check(Watcher.heardFresh(delivered, "minecraft:ender_dragon", 9000L), "a dragon heard 5 s ago is still placed");
		check(!Watcher.heardFresh(delivered, "minecraft:ender_dragon", 9001L), "an older dragon sound is not");
		check(!Watcher.heardFresh(delivered, "minecraft:zombie", 4500L), "a zombie sound names no particular zombie");
		Episode heardOnly = new Episode("h", "a", new Danger("d", "dragon", "minecraft:ender_dragon", "d", null, 0.3D, 12.0D), 0L, 0L);
		heardOnly.perceivable = true;
		heardOnly.inObservation = true;
		Diagnosis.diagnose(heardOnly, Set.of("hostile_near"));
		check(heardOnly.diagnosis().equals("FACT_GAP") && heardOnly.evidence().contains("only heard"), "a dragon only heard has no facts");
		heardOnly.inThreatFacts = true;
		heardOnly.seenRow = true;
		Diagnosis.diagnose(heardOnly, Set.of("hostile_near"));
		check(heardOnly.diagnosis().equals("MODEL_CHOICE"), "a dragon row reaching the model carries its fight facts");
		Episode pearl = new Episode("p", "a", new Danger("pearl", "ender_pearl", "minecraft:ender_pearl", null, new int[] {0, 64, 0}, 0.0D, 0.0D), 0L, 0L);
		pearl.perceivable = true;
		pearl.inObservation = true;
		pearl.inThreatFacts = true;
		pearl.damage = 5.0F;
		Diagnosis.diagnose(pearl, VOCABULARY);
		check(pearl.diagnosis().equals("MODEL_CHOICE"), "the model's own pearl throw is its choice, not a missing reflex");
		// Client-only sounds (wing flaps) reach the agent only as heard rows; their age is the delivery time less secondsAgo.
		JsonObject rows = JsonParser.parseString("{\"observedAtEpochMs\":20000,\"heard\":["
				+ "{\"sound\":\"entity.ender_dragon.flap\",\"direction\":\"back\",\"elevation\":\"above\",\"distance\":15,\"count\":4},"
				+ "{\"sound\":\"entity.wither.ambient\",\"direction\":\"left\",\"elevation\":\"level\",\"distance\":30,\"secondsAgo\":7},"
				+ "{\"sound\":\"block.lava.pop\",\"direction\":\"front\",\"elevation\":\"below\",\"distance\":6}]}").getAsJsonObject();
		java.util.Map<String, Long> fromRows = Watcher.heardTypes(rows);
		check(fromRows.get("minecraft:ender_dragon") == 20000L && fromRows.get("minecraft:wither") == 13000L && fromRows.size() == 2,
				"heard rows name their entity type, aged by secondsAgo");
		// The lava check reads the delivered observation's top-level heard rows, the field the collector writes.
		dev.agaminggod.mineagen.agent.AgentId agent = dev.agaminggod.mineagen.agent.AgentId.parse("00000000-0000-0000-0000-00000000d190");
		Watcher.delivered(agent, rows, 20000L);
		check(Watcher.deliveredTo(agent).heardLava() && Watcher.heardFresh(Watcher.deliveredTo(agent), "minecraft:ender_dragon", 24000L),
				"a delivery with a heard lava pop and a heard flap counts both");
		Watcher.delivered(agent, JsonParser.parseString("{\"observedAtEpochMs\":21000}").getAsJsonObject(), 21000L);
		check(!Watcher.deliveredTo(agent).heardLava(), "silence is not heard lava");
	}

	/**
	 * Watcher data must never reach the model: outside its own package only the runtime's registration line names it,
	 * so no observation, perception, wake or tool-result code can read it; and the watch package never sends anything.
	 */
	private static void isolation() {
		Path root = Path.of("src/main/java/dev/agaminggod/mineagen");
		try (Stream<Path> files = Files.walk(root)) {
			for (Path file : files.filter(path -> path.toString().endsWith(".java")).toList()) {
				String text = Files.readString(file);
				boolean inWatch = file.toString().replace('\\', '/').contains("/server/watch/");
				if (inWatch) {
					for (String forbidden : List.of("BridgeTap.delivered", "BridgeTap.model", "sendObservation", "queueUrgentObservation",
							"publishOwned", ".send(", "enqueue", "ServerObservationCollector", "addProperty(\"watch")) {
						check(!text.contains(forbidden), file + " must not use " + forbidden);
					}
					continue;
				}
				if (!text.contains("mineagen.server.watch")) continue;
				check(file.getFileName().toString().equals("AgentServerRuntime.java"), file + " must not reference the watch package");
				check(text.split("mineagen\\.server\\.watch", -1).length == 2
						&& text.contains("dev.agaminggod.mineagen.server.watch.Watcher.register();"),
						"the runtime only registers the Watcher");
			}
		} catch (IOException failure) {
			throw new UncheckedIOException(failure);
		}
	}

	/**
	 * A move that approached the drop marks the body as the cause only while it still runs at the first harm: a later
	 * command that drops the body (breaking the log under the feet) is not "the move moved toward the drop".
	 */
	private static void harmUnderAnotherCommand() {
		dev.agaminggod.mineagen.agent.AgentId agent = dev.agaminggod.mineagen.agent.AgentId.parse("00000000-0000-0000-0000-000000000601");
		var provenance = new dev.agaminggod.mineagen.server.runtime.ActionProvenance("codex", "m", "low", "default", "tool", 1L, "step", 1L);
		var pickup = new dev.agaminggod.mineagen.server.runtime.ServerActionRequest(agent, 1L, "pick", dev.agaminggod.mineagen.protocol.ActionType.PICK_UP_ITEM,
				new com.google.gson.JsonObject(), provenance);
		var mine = new dev.agaminggod.mineagen.server.runtime.ServerActionRequest(agent, 1L, "mine", dev.agaminggod.mineagen.protocol.ActionType.BREAK_BLOCK,
				new com.google.gson.JsonObject(), provenance);
		Episode later = new Episode("e1", "a", mob("d", 0.3D), 0L, 0L);
		later.causedByAction = true;
		later.causedActionId = "pick";
		later.action = "pick_up_item";
		Watcher.harmedUnder(later, mine);
		check(!later.causedByAction && "break_block".equals(later.action), "harm under a later command is that command's");
		Episode same = new Episode("e2", "a", mob("d", 0.3D), 0L, 0L);
		same.causedByAction = true;
		same.causedActionId = "pick";
		same.action = "pick_up_item";
		Watcher.harmedUnder(same, pickup);
		check(same.causedByAction && "pick_up_item".equals(same.action), "harm while the move still runs stays the body's");
		Episode idle = new Episode("e3", "a", mob("d", 0.3D), 0L, 0L);
		idle.causedByAction = true;
		idle.causedActionId = "pick";
		Watcher.harmedUnder(idle, null);
		check(!idle.causedByAction, "harm after the move ended is not the move's");
	}
}
