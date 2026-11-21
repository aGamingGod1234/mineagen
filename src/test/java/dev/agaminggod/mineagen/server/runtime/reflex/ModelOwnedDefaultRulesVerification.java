package dev.agaminggod.mineagen.server.runtime.reflex;

import com.google.gson.JsonObject;
import com.google.gson.JsonParser;
import dev.agaminggod.mineagen.protocol.ActionType;
import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Map;

/** Ownership crosses the real coordinator payload/parser and the gate used by the engine before scheduler failure reporting. */
public final class ModelOwnedDefaultRulesVerification {
	private static int assertions;

	public static void main(String[] args) throws Exception {
		System.out.println("PASS: " + verify(args.length == 0 ? null : args[0]) + " model-owned default assertions");
	}

	public static int verify() throws Exception {
		return verify(null);
	}

	private static int verify(String payloadPath) throws Exception {
		assertions = 0;
		List<ReflexSpec.Rule> defaults = ReflexSpec.parseRules(JsonParser.parseString(Files.readString(
				Path.of("src/test/resources/default-reflex-rules.json"))).getAsJsonArray());
		for (ReflexSpec.Rule rule : defaults) check(rule.coordinatorDefault(), "fixture carries actual ownership");
		incomingLavaDefersToCasting(defaults);
		java.util.Set<String> heldBack = new java.util.TreeSet<>();
		for (ReflexSpec.Rule rule : defaults) if (ReflexEngine.backsOffWhenWeaker(rule)) heldBack.add(rule.id());
		check(heldBack.equals(new java.util.TreeSet<>(List.of("default-blaze-cover", "default-cover", "default-retreat"))), "a stand holds back exactly default-retreat, default-cover and default-blaze-cover: " + heldBack);
		ReflexSpec.Rule modelRetreat = rule("""
				{"id":"run","kind":"trigger","priority":7,"when":[{"type":"health_below","value":7},{"type":"hostile_near","within":6}],"do":{"type":"sprint_away","blocks":10}}
				""");
		check(!ReflexEngine.backsOffWhenWeaker(modelRetreat), "a model-authored retreat still fires during a stand");
		ReflexScheduler chase = new ReflexScheduler();
		chase.replace(defaults, 0);
		for (ReflexSpec.Rule rule : defaults) {
			boolean waits = heldBack.contains(rule.id()) || rule.id().equals("default-eat");
			check(ReflexEngine.chaseGate(chase, rule, true, true) != waits, "a melee chase holds back only cover, retreat and eating: " + rule.id());
			check(ReflexEngine.chaseGate(chase, rule, true, false), "the default can fire once the chase ends: " + rule.id());
		}
		check(ReflexEngine.chaseGate(chase, modelRetreat, true, true), "a melee chase does not block the model's own rule");
		for (String id : List.of("default-fire", "default-custom", "model-fire")) {
			ReflexSpec.Rule model = rule("""
					{"id":"%s","when":{"type":"in_fire"},"do":{"type":"place","item":"water_bucket","where":"below"},"wake":true}
					""".formatted(id));
			failsWithRequestedWake(model);
		}
		ReflexSpec.Rule arrow = defaults.stream().filter(rule -> rule.id().equals("default-arrow")).findFirst().orElseThrow();
		ReflexSpec.Rule eat = defaults.stream().filter(rule -> rule.id().equals("default-eat")).findFirst().orElseThrow();
		for (ReflexSpec.Rule owned : List.of(arrow, eat)) {
			String lacks = missing(owned);
			check(lacks != null, "default lacks its item");
			check(owned.sleepsWithoutItem(lacks), "actual default sleeps");
			ReflexScheduler scheduler = new ReflexScheduler();
			scheduler.replace(List.of(owned), 0);
			check(scheduler.step(1, Map.of(owned.id(), new ReflexScheduler.Sense(false, false)),
					ReflexScheduler.ActionStatus.RUNNING, "", false).started() == null, "sleeping default does not fire");
			check(scheduler.events().isEmpty(), "sleeping default has no failure event");
			check(!owned.sleepsWithoutItem(null), "item availability wakes default");
			check(owned.id().equals(scheduler.step(2, Map.of(owned.id(), new ReflexScheduler.Sense(true, false)),
					ReflexScheduler.ActionStatus.RUNNING, "", false).started()), "default fires when its item returns");
		}
		// Even an identical model-authored replacement belongs to the model and must report missing items.
		JsonObject identical = JsonParser.parseString(Files.readString(Path.of("src/test/resources/default-reflex-rules.json")))
				.getAsJsonArray().asList().stream().map(value -> value.getAsJsonObject())
				.filter(value -> value.get("id").getAsString().equals("default-arrow")).findFirst().orElseThrow().deepCopy();
		identical.remove("coordinatorDefault");
		failsWithRequestedWake(ReflexSpec.parseRule(identical, "replacement"));
		identical.addProperty("coordinatorDefault", false);
		failsWithRequestedWake(ReflexSpec.parseRule(identical, "explicit-model"));
		identical.addProperty("coordinatorDefault", "true");
		try {
			ReflexSpec.parseRule(identical, "invalid-owner");
			throw new AssertionError("ownership must be boolean");
		} catch (ReflexSpec.InvalidRuleException expected) {
			check(expected.getMessage().contains("coordinatorDefault"), "ownership type validation");
		}
		if (payloadPath != null) {
			List<ReflexSpec.Rule> wire = ReflexSpec.parseRules(JsonParser.parseString(Files.readString(Path.of(payloadPath))).getAsJsonArray());
			for (ReflexSpec.Rule model : wire) {
				if (List.of("default-fire", "default-custom", "default-arrow").contains(model.id())) failsWithRequestedWake(model);
				else check(model.coordinatorDefault(), "untouched wire default keeps ownership");
			}
		}
		return assertions;
	}

	private static void incomingLavaDefersToCasting(List<ReflexSpec.Rule> defaults) {
		ReflexSpec.Rule flow = defaults.stream().filter(rule -> rule.id().equals("default-lava-flow")).findFirst().orElseThrow();
		ReflexSpec.Rule contact = defaults.stream().filter(rule -> rule.id().equals("default-lava")).findFirst().orElseThrow();
		check(!ReflexEngine.deferFlowDuringCast(flow, null), "idle incoming-flow protection stays on");
		for (ActionType type : ActionType.values()) {
			check(ReflexEngine.deferFlowDuringCast(flow, type) == (type == ActionType.CAST_OBSIDIAN),
					"only the running cast owns its cooling: " + type);
		}
		for (ReflexSpec.Rule rule : defaults) {
			if (!rule.id().equals(flow.id())) check(!ReflexEngine.deferFlowDuringCast(rule, ActionType.CAST_OBSIDIAN),
					"casting keeps other protection: " + rule.id());
		}
		ReflexSpec.Rule authored = rule("""
				{"id":"default-lava-flow","priority":9,"when":{"type":"lava_flowing","withinS":4},"do":{"type":"leave_lava"}}
				""");
		check(!ReflexEngine.deferFlowDuringCast(authored, ActionType.CAST_OBSIDIAN), "the model's replacement still fires during casting");
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(contact, flow), 0);
		Map<String, ReflexScheduler.Sense> casting = Map.of(
				flow.id(), new ReflexScheduler.Sense(!ReflexEngine.deferFlowDuringCast(flow, ActionType.CAST_OBSIDIAN), false),
				contact.id(), new ReflexScheduler.Sense(false, false));
		check(scheduler.step(1, casting, ReflexScheduler.ActionStatus.RUNNING, "", false).started() == null,
				"the predicted pour does not pause its cast");
		check(contact.id().equals(scheduler.step(2, Map.of(
				flow.id(), new ReflexScheduler.Sense(false, false), contact.id(), new ReflexScheduler.Sense(true, false)),
				ReflexScheduler.ActionStatus.RUNNING, "", false).started()), "actual lava contact still interrupts casting");
		ReflexScheduler after = new ReflexScheduler();
		after.replace(List.of(flow), 0);
		after.step(1, Map.of(flow.id(), new ReflexScheduler.Sense(false, false)), ReflexScheduler.ActionStatus.RUNNING, "", false);
		check(flow.id().equals(after.step(2, Map.of(flow.id(), new ReflexScheduler.Sense(true, false)),
				ReflexScheduler.ActionStatus.RUNNING, "", false).started()), "the flow rule can fire as soon as casting ends");
		ReflexScheduler ongoing = new ReflexScheduler();
		ongoing.replace(List.of(flow), 0);
		ongoing.step(1, Map.of(flow.id(), new ReflexScheduler.Sense(true, false)), ReflexScheduler.ActionStatus.RUNNING, "", false);
		ongoing.discardPendingStart(flow.id());
		ongoing.step(2, Map.of(flow.id(), new ReflexScheduler.Sense(false, false)), ReflexScheduler.ActionStatus.RUNNING, "", false);
		check(ongoing.current() != null && ongoing.current().ruleId().equals(flow.id()),
				"starting a cast does not itself cancel an escape that was already running");
		ReflexScheduler oldGate = pendingFlowBehindContact(contact, flow);
		check(flow.id().equals(oldGate.step(2, Map.of(flow.id(), new ReflexScheduler.Sense(false, false)),
				ReflexScheduler.ActionStatus.RUNNING, "", false).started()), "baseline: false truth alone starts a queued flow during casting");
		ReflexScheduler pending = pendingFlowBehindContact(contact, flow);
		pending.discardPendingStart(flow.id());
		check(pending.step(2, Map.of(flow.id(), new ReflexScheduler.Sense(false, false)),
				ReflexScheduler.ActionStatus.RUNNING, "", false).started() == null, "a queued flow cannot start during casting");
		pending.resume(3, true);
		pending.replace(List.of(contact, flow), 3);
		check(pending.step(3, Map.of(flow.id(), new ReflexScheduler.Sense(false, false)),
				ReflexScheduler.ActionStatus.RUNNING, "", false).started() == null, "command resume and unchanged resend cannot revive the old edge");
		check(flow.id().equals(pending.step(25, Map.of(flow.id(), new ReflexScheduler.Sense(true, false)),
				ReflexScheduler.ActionStatus.RUNNING, "", false).started()), "a fresh post-cast flow still starts after the old pending window");
	}

	private static ReflexScheduler pendingFlowBehindContact(ReflexSpec.Rule contact, ReflexSpec.Rule flow) {
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(contact, flow), 0);
		check(contact.id().equals(scheduler.step(1, Map.of(contact.id(), new ReflexScheduler.Sense(true, false),
				flow.id(), new ReflexScheduler.Sense(true, false)), ReflexScheduler.ActionStatus.RUNNING, "", false).started()),
				"contact escape wins the tie while the incoming flow stays pending");
		// Out of the lava and only holding on (settled): the hazard floor lets the casting command take the body.
		scheduler.settled(true);
		check(scheduler.yield(2).endOutcome() == ReflexScheduler.Outcome.YIELDED, "the settled contact escape yields to the cast");
		scheduler.settled(false);
		scheduler.replace(List.of(contact, flow), 2);
		return scheduler;
	}

	private static ReflexSpec.Rule rule(String json) {
		return ReflexSpec.parseRule(JsonParser.parseString(json).getAsJsonObject(), "rule");
	}

	private static String missing(ReflexSpec.Rule rule) {
		// These are the existing action failure details; this pure scheduling test supplies the action result.
		return switch (rule.action().type()) {
			case "place" -> "no " + rule.action().text("item") + " in hotbar or offhand";
			case "shield" -> "no shield in either hand";
			case "eat" -> "no food in hotbar or offhand";
			default -> throw new AssertionError("unexpected fixture action");
		};
	}

	private static void failsWithRequestedWake(ReflexSpec.Rule model) {
		String lacks = missing(model);
		check(lacks != null, "model action lacks its required item");
		boolean truth = !model.sleepsWithoutItem(lacks);
		ReflexScheduler scheduler = new ReflexScheduler();
		scheduler.replace(List.of(model), 0);
		Map<String, ReflexScheduler.Sense> senses = Map.of(model.id(), new ReflexScheduler.Sense(truth, false));
		check(model.id().equals(scheduler.step(1, senses, ReflexScheduler.ActionStatus.RUNNING, "", false).started()),
				model.id() + " fires despite its missing item");
		// Supply the missing-item result the action returns; no Minecraft player/world is constructed.
		scheduler.step(2, senses, ReflexScheduler.ActionStatus.FAILED, lacks, false);
		check(scheduler.events().size() == 1, "one failure event");
		ReflexScheduler.Event event = scheduler.events().getFirst();
		check(event.outcome() == ReflexScheduler.Outcome.FAILED && event.wake() == model.wake() && event.detail().equals(lacks),
				"failure preserves detail and wake");
		System.out.println(model.id() + " " + event.outcome() + " wake=" + event.wake() + " detail=" + event.detail());
	}

	private static void check(boolean condition, String message) {
		assertions++;
		if (!condition) throw new AssertionError(message);
	}
}
