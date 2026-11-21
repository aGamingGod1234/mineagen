package dev.agaminggod.mineagen.server.runtime.controller;

import carpet.fakes.ServerPlayerInterface;
import carpet.helpers.EntityPlayerActionPack;
import com.google.gson.JsonObject;
import java.io.IOException;
import java.lang.invoke.MethodHandles;
import net.minecraft.network.protocol.Packet;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;
import com.mojang.authlib.GameProfile;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.agent.AgentRecord;
import dev.agaminggod.mineagen.compat.McEntityTypes;
import dev.agaminggod.mineagen.server.AgentManager;
import dev.agaminggod.mineagen.server.AgentSavedData;
import dev.agaminggod.mineagen.server.runtime.ServerProtectionPolicy;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import dev.agaminggod.mineagen.server.runtime.input.InputStateSink;
import dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * Ticks the real {@link ServerFightUntilController} in forest mode on an Unsafe-allocated Nether level and player (no live
 * server, as {@link FightWeaponBreakVerification}). The biome and the relocation walks go through WarpedForestHunt's test
 * seams: the forest is x < 200, and each walk is a scripted controller that moves the body and ends as told. Cases: quiet
 * spell, relocation and arrival with no 30 s hand-back; every heading failing; a walk leaving the forest and walking back;
 * a safety stop; a model spot; the count; new lava contact; the time cap; a model cancel; a pause and resume; a walk
 * interrupted by an enderman; and a failed perch backing off instead of handing back idle.
 */
public final class ForestHuntTickVerification {
	private static int assertions;
	private static final String FOREST = "minecraft:warped_forest";

	private ForestHuntTickVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		System.out.println("PASS: " + verify() + " forest hunt tick assertions");
	}

	public static int verify() throws Exception {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		Map<ServerPlayer, Object> seenPlayers = seenTerrainPlayers();
		Field sweptAtField = dev.agaminggod.mineagen.server.perception.SeenTerrain.class.getDeclaredField("sweptAt");
		sweptAtField.setAccessible(true);
		Map<ServerPlayer, Object> savedPlayers = new java.util.IdentityHashMap<>(seenPlayers);
		long savedSweptAt = sweptAtField.getLong(null);
		WarpedForestHunt.Probe savedProbe = WarpedForestHunt.probe;
		WarpedForestHunt.Walks savedWalks = WarpedForestHunt.walks;
		ServerFightUntilController.DrawWalks savedDraw = ServerFightUntilController.drawWalks;
		seenPlayers.clear();
		try {
			// The back-off from an angry enderman out of reach ends at once (no terrain to walk in the fixture level).
			ServerFightUntilController.drawWalks = (goal, now) -> new ServerController() {
				@Override public TickResult tick(ServerPlayer body, long nowEpochMs) { return TickResult.failed("NO_ROUTE", "fixture: no terrain", 0.0D); }
				@Override public void cancel(ServerPlayer body) { }
			};
			WarpedForestHunt.probe = (player, at) -> at.getX() < 200 ? FOREST : "minecraft:basalt_deltas";
			verifyRelocatesAndArrives();
			verifyEveryHeadingFails();
			verifyLeavesForestAndWalksBack();
			verifySafetyStop();
			verifySpot();
			verifyCount();
			verifyLava();
			verifyCancel();
			verifyPauseResume();
			verifyInterruptedByEnderman();
			verifyUnreachablePassedOver();
			verifyFailedPerchBacksOff();
			verifyNotForest();
		} finally {
			WarpedForestHunt.probe = savedProbe;
			WarpedForestHunt.walks = savedWalks;
			ServerFightUntilController.drawWalks = savedDraw;
			seenPlayers.clear();
			seenPlayers.putAll(savedPlayers);
			sweptAtField.setLong(null, savedSweptAt);
		}
		return assertions;
	}

	/** Quiet 12 s, a heading walk that arrives 20 blocks on, the area moves there; no NO_TARGET_SEEN at 30 s; the time cap ends it. */
	private static void verifyRelocatesAndArrives() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			List<Vec3> goals = new ArrayList<>();
			WarpedForestHunt.walks = (goal, mayModify, now) -> { goals.add(goal); return fixture.walk(5, ServerController.State.SUCCEEDED, "ARRIVED", goal); };
			ServerFightUntilController hunt = fixture.hunt(hunt(60_000L), null);
			ServerController.TickResult end = fixture.run(hunt, 1_400);
			check(!goals.isEmpty(), "a quiet spell starts a relocation walk");
			check(fixture.firstWalkTick >= 240 && fixture.firstWalkTick < 260, "the first walk starts after the 12 s quiet spell, tick " + fixture.firstWalkTick);
			check(end.state() == ServerController.State.TIMED_OUT && "FIGHT_UNTIL_TIMED_OUT".equals(end.reasonCode()),
					"no NO_TARGET_SEEN at 30 s: the hunt runs to its time cap: " + end.reasonCode());
			check(end.message().contains("forest: ") && end.message().contains("arrived") && !end.message().contains("(0 arrived"),
					"the receipt names the relocations that arrived: " + end.message());
			check(goals.size() >= 3, "it keeps walking on after each quiet spell: " + goals.size());
		}
	}

	/** Every walk NO_ROUTE: FOREST_UNREACHABLE after all headings or 16 walks, never sooner than the old 30 s. */
	private static void verifyEveryHeadingFails() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			List<Vec3> goals = new ArrayList<>();
			WarpedForestHunt.walks = (goal, mayModify, now) -> { goals.add(goal); return fixture.walk(2, ServerController.State.FAILED, "NO_ROUTE", null); };
			ServerFightUntilController hunt = fixture.hunt(hunt(300_000L), null);
			ServerController.TickResult end = fixture.run(hunt, 6_000);
			check("FOREST_UNREACHABLE".equals(end.reasonCode()), "all headings failing hands back FOREST_UNREACHABLE: " + end.reasonCode() + " " + end.message());
			check(goals.size() >= 8 && goals.size() <= WarpedForestHunt.MAX_FAILED_WALKS, "8 to 16 walks were tried, never without end: " + goals.size());
			check(fixture.ticks * 50L >= ServerFightUntilController.NO_TARGET_MS, "not sooner than the old 30 s: " + fixture.ticks + " ticks");
		}
	}

	/** A walk that crosses out of the forest ends that tick; the next walk goes back to the last forest footing. */
	private static void verifyLeavesForestAndWalksBack() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			List<Vec3> goals = new ArrayList<>();
			WarpedForestHunt.walks = (goal, mayModify, now) -> {
				goals.add(goal);
				// The first walk carries the body out of the forest (x 250) and keeps running; later ones arrive.
				return goals.size() == 1 ? fixture.walk(1_000, ServerController.State.RUNNING, "", new Vec3(250.5D, 64.0D, 0.5D))
						: fixture.walk(3, ServerController.State.SUCCEEDED, "ARRIVED", goal);
			};
			ServerFightUntilController hunt = fixture.hunt(hunt(40_000L), null);
			fixture.run(hunt, 300);
			check(fixture.cancelledWalks >= 1, "the walk that left the forest was ended that tick");
			check(goals.size() >= 2 && Math.abs(WarpedForestHunt.flat(goals.get(1), new Vec3(0.5D, 64.0D, 0.5D)) - WarpedForestHunt.BACK_PAST) < 1.0E-6
					&& goals.get(1).x < 0.5D, "the next walk goes back past the last forest footing, deeper into the forest: " + goals);
			check(fixture.player.getX() < 200.0D, "the walk back runs from outside the forest and brings the body back in: x " + fixture.player.getX());
		}
	}

	/** A walk stopped for damage after 20 blocks is not credited as arrival. */
	private static void verifySafetyStop() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			WarpedForestHunt.walks = (goal, mayModify, now) -> fixture.walk(3, ServerController.State.FAILED, "TRAVEL_DAMAGED", goal);
			ServerFightUntilController hunt = fixture.hunt(hunt(20_000L), null);
			ServerController.TickResult end = fixture.run(hunt, 1_000);
			check(end.message().contains("(0 arrived, ") && end.message().contains("stopped for safety"), "a damage stop is never an arrival: " + end.message());
		}
	}

	/** A model spot with roof:false still waits the quiet spell and walks on; no AREA_CLEARED, no NO_TARGET_SEEN. */
	private static void verifySpot() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			List<Vec3> goals = new ArrayList<>();
			WarpedForestHunt.walks = (goal, mayModify, now) -> { goals.add(goal); return fixture.walk(3, ServerController.State.SUCCEEDED, "ARRIVED", goal); };
			JsonObject args = hunt(40_000L);
			args.addProperty("x", 0.5D);
			args.addProperty("y", 64.0D);
			args.addProperty("z", 0.5D);
			ServerController.TickResult end = fixture.run(fixture.hunt(args, null), 1_000);
			check(!goals.isEmpty() && fixture.firstWalkTick >= 240, "with a model spot the body still waits 12 s and walks on");
			check("FIGHT_UNTIL_TIMED_OUT".equals(end.reasonCode()), "no early hand-back with a spot: " + end.reasonCode());
		}
	}

	private static void verifyCount() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			fixture.player.getInventory().setItem(5, new ItemStack(Items.ENDER_PEARL, 2));
			JsonObject args = hunt(40_000L);
			args.addProperty("untilCount", 2);
			ServerController.TickResult end = fixture.run(fixture.hunt(args, null), 10);
			check("UNTIL_COUNT_REACHED".equals(end.reasonCode()), "the count hands back first: " + end.reasonCode());
		}
	}

	/** New lava contact hands back IN_LAVA, before the walk or anything else that tick. */
	private static void verifyLava() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			WarpedForestHunt.walks = (goal, mayModify, now) -> fixture.walk(1_000, ServerController.State.RUNNING, "", null);
			ServerFightUntilController hunt = fixture.hunt(hunt(60_000L), null);
			fixture.run(hunt, 260);
			check(fixture.walksMade == 1, "a walk is under way");
			fixture.body.lava(true);
			ServerController.TickResult end = fixture.run(hunt, 5);
			check("IN_LAVA".equals(end.reasonCode()), "new lava contact hands back: " + end.reasonCode());
			check(fixture.cancelledWalks >= 1, "the walk was put down");
		}
	}

	/** A model cancel (or a reflex taking the body) puts the relocation walk down. */
	private static void verifyCancel() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			WarpedForestHunt.walks = (goal, mayModify, now) -> fixture.walk(1_000, ServerController.State.RUNNING, "", null);
			ServerFightUntilController hunt = fixture.hunt(hunt(60_000L), null);
			fixture.run(hunt, 260);
			hunt.cancel(fixture.player);
			check(fixture.cancelledWalks == 1, "cancel puts the relocation walk down");
		}
	}

	/** Paused by a model-armed reflex (issue #2: the action is not ticked) and resumed: the same walk is planned afresh. */
	private static void verifyPauseResume() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			List<Vec3> goals = new ArrayList<>();
			WarpedForestHunt.walks = (goal, mayModify, now) -> { goals.add(goal); return fixture.walk(1_000, ServerController.State.RUNNING, "", null); };
			ServerFightUntilController hunt = fixture.hunt(hunt(120_000L), null);
			fixture.run(hunt, 260);
			check(goals.size() == 1, "one walk under way before the pause");
			fixture.level.time += 60;
			fixture.now += 60 * 50L;
			hunt.resumed(fixture.player);
			ServerController.TickResult after = fixture.run(hunt, 2);
			check(after.state() == ServerController.State.RUNNING, "the hunt goes on after the pause");
			check(goals.size() == 2 && goals.get(1).equals(goals.get(0)), "the same walk is planned afresh after the pause: " + goals);
		}
	}

	/** An enderman met on the way ends the walk and the hunt goes on from there (its area moves). */
	private static void verifyInterruptedByEnderman() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			WarpedForestHunt.walks = (goal, mayModify, now) -> fixture.walk(1_000, ServerController.State.RUNNING, "", new Vec3(20.5D, 64.0D, 0.5D));
			ServerFightUntilController hunt = fixture.hunt(hunt(60_000L), null);
			fixture.run(hunt, 260);
			check(fixture.walksMade == 1, "a walk is under way");
			FixtureEnderman enderman = fixture.enderman(new Vec3(20.5D, 64.0D, 4.5D), null);
			fixture.player.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, enderman.getEyePosition());
			fixture.run(hunt, 3);
			check(fixture.cancelledWalks >= 1, "the enderman in view ended the walk");
		}
	}

	/**
	 * The default pass-over (UnreachableTargets, no property set) in a forest pearl hunt: an angry enderman the sword
	 * cannot reach (NO_SEEN_ROUTE) is tried once, its being in view no longer holds off the quiet spell, the relocation
	 * walk starts, and the passed-over enderman does not cut that walk short.
	 */
	private static void verifyUnreachablePassedOver() throws Exception {
		String saved = System.getProperty(UnreachableTargets.PROPERTY);
		System.clearProperty(UnreachableTargets.PROPERTY);
		List<LivingEntity> engaged = new ArrayList<>();
		try (Fixture fixture = Fixture.create()) {
			int[] failedAt = {-1};
			ServerFightUntilController.scriptedMelee = target -> {
				engaged.add(target);
				return new ServerController() {
					@Override public TickResult tick(ServerPlayer body, long nowEpochMs) {
						if (failedAt[0] < 0) failedAt[0] = fixture.ticks;
						return TickResult.failed("NO_SEEN_ROUTE", "scripted: no route through seen terrain to a spot within reach", 0.0D);
					}
					@Override public void cancel(ServerPlayer body) { }
				};
			};
			WarpedForestHunt.walks = (goal, mayModify, now) -> fixture.walk(1_000, ServerController.State.RUNNING, "", null);
			FixtureEnderman ledge = fixture.enderman(new Vec3(2.5D, 68.0D, 4.5D), fixture.player);
			fixture.player.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, ledge.getEyePosition());
			ServerFightUntilController hunt = fixture.hunt(hunt(120_000L), null);
			// The angry one is awaited and approached first (about 8 s); the body then backs off from it up to
			// MAX_DRAW_OVERS times, holding DRAW_HOLD_MS each (it never teleports here), then one 12 s quiet spell.
			ServerController.TickResult end = fixture.run(hunt, 1_600);
			check(end.state() == ServerController.State.RUNNING, "the hunt goes on: " + end.reasonCode());
			check(engaged.size() == 1, "the enderman out of reach is tried once, not every tick: " + engaged.size());
			check(fixture.walksMade == 1, "with only it in view, the quiet spell starts a relocation walk: " + fixture.walksMade + " (failed at tick " + failedAt[0] + "; "
					+ end.message() + ")");
			long afterHolds = ServerFightUntilController.MAX_DRAW_OVERS * ServerFightUntilController.DRAW_HOLD_MS / 50L;
			check(fixture.firstWalkTick - failedAt[0] >= WarpedForestHunt.QUIET_MS / 50L - 2L
					&& fixture.firstWalkTick - failedAt[0] <= afterHolds + WarpedForestHunt.QUIET_MS / 50L + 80L,
					"the walk starts one quiet spell after the back-offs end: " + (fixture.firstWalkTick - failedAt[0]) + " ticks");
			check(fixture.cancelledWalks == 0, "the passed-over enderman does not end the walk");
		} finally {
			ServerFightUntilController.scriptedMelee = null;
			if (saved != null) System.setProperty(UnreachableTargets.PROPERTY, saved);
		}
	}

	/** Low health beside an angry enderman, a pillar that does not rise: the body backs off (CombatBailout), not idle. */
	private static void verifyFailedPerchBacksOff() throws Exception {
		try (Fixture fixture = Fixture.create()) {
			WarpedForestHunt.walks = (goal, mayModify, now) -> fixture.walk(1_000, ServerController.State.RUNNING, "", null);
			fixture.player.getInventory().setItem(3, new ItemStack(Items.COBBLESTONE, 16));
			fixture.enderman(new Vec3(3.5D, 64.0D, 0.5D), fixture.player);
			fixture.body.health(5.0F);
			ServerFightUntilController hunt = fixture.hunt(hunt(60_000L), null);
			ServerController.TickResult end = fixture.run(hunt, 400);
			check(end.message().contains("; backing off") && end.message().contains("retreat attempted"),
					"a failed pillar starts the bailout's retreat instead of handing back idle: " + end.message());
			check(!end.message().startsWith("Health 5.0 reached fleeAtHealth 8.0; pillar out of reach"), "not the old idle pillar hand-back");
		}
	}

	/** Outside a warped forest the hunt is the old one: NO_TARGET_SEEN after 30 s, no relocation walk. */
	private static void verifyNotForest() throws Exception {
		WarpedForestHunt.Probe forest = WarpedForestHunt.probe;
		WarpedForestHunt.probe = (player, at) -> "minecraft:basalt_deltas";
		try (Fixture fixture = Fixture.create()) {
			WarpedForestHunt.walks = (goal, mayModify, now) -> fixture.walk(3, ServerController.State.SUCCEEDED, "ARRIVED", goal);
			ServerController.TickResult end = fixture.run(fixture.hunt(hunt(120_000L), null), 1_000);
			check("NO_TARGET_SEEN".equals(end.reasonCode()) && fixture.walksMade == 0, "a non-forest hunt runs as on base: " + end.reasonCode());
		} finally {
			WarpedForestHunt.probe = forest;
		}
	}

	private static JsonObject hunt(long timeoutMs) {
		JsonObject args = new JsonObject();
		args.addProperty("mob", "minecraft:enderman");
		args.addProperty("untilItem", "minecraft:ender_pearl");
		args.addProperty("untilCount", 4);
		args.addProperty("fleeAtHealth", 8);
		args.addProperty("timeoutMs", timeoutMs);
		return args;
	}

	@SuppressWarnings("unchecked")
	private static Map<ServerPlayer, Object> seenTerrainPlayers() throws Exception {
		Field field = dev.agaminggod.mineagen.server.perception.SeenTerrain.class.getDeclaredField("PLAYERS");
		field.setAccessible(true);
		return (Map<ServerPlayer, Object>) field.get(null);
	}

	private static final class Fixture implements AutoCloseable {
		final sun.misc.Unsafe unsafe;
		final MinecraftServer server;
		final ForestLevel level;
		final ServerPlayer player;
		final ForestBody body;
		long now = 1_000L;
		int ticks;
		int walksMade;
		int cancelledWalks;
		int firstWalkTick = -1;

		private Fixture(sun.misc.Unsafe unsafe, MinecraftServer server, ForestLevel level, ServerPlayer player) {
			this.unsafe = unsafe;
			this.server = server;
			this.level = level;
			this.player = player;
			this.body = (ForestBody) player;
		}

		static Fixture create() throws Exception {
			Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			unsafeField.setAccessible(true);
			sun.misc.Unsafe unsafe = (sun.misc.Unsafe) unsafeField.get(null);
			MinecraftServer server = (MinecraftServer) unsafe.allocateInstance(DedicatedServer.class);
			ForestLevel level = (ForestLevel) unsafe.allocateInstance(ForestLevel.class);
			level.server = server;
			level.entities = new ArrayList<>();
			var registries = new net.minecraft.core.MappedRegistry<net.minecraft.core.Registry<?>>(
					net.minecraft.resources.ResourceKey.createRegistryKey(net.minecraft.core.registries.BuiltInRegistries.REGISTRY.key().identifier()),
					com.mojang.serialization.Lifecycle.stable());
			var enchantments = new net.minecraft.core.MappedRegistry<net.minecraft.world.item.enchantment.Enchantment>(
					net.minecraft.core.registries.Registries.ENCHANTMENT, com.mojang.serialization.Lifecycle.stable());
			enchantments.freeze();
			net.minecraft.core.Registry.register(registries, net.minecraft.core.registries.Registries.ENCHANTMENT.identifier(), enchantments);
			registries.freeze();
			level.registries = net.minecraft.core.RegistryAccess.fromRegistryOfRegistries(registries);
			set(unsafe, level, Level.class, "dimension", Level.NETHER);

			AgentManager manager = (AgentManager) unsafe.allocateInstance(AgentManager.class);
			set(unsafe, manager, AgentManager.class, "server", server);
			set(unsafe, manager, AgentManager.class, "savedData", new AgentSavedData());
			AgentRecord record = manager.registry().create("gpt-5.6-sol", "high", Optional.of("Hunter"), 1_000L);
			UUID playerId = UUID.randomUUID();
			manager.registry().attachEntity(record.agentId(), playerId, 1_000L);
			instances().put(server, manager);
			Fixture[] holder = new Fixture[1];
			controllers().put(server, new LeasedServerInputController(new InputStateSink() {
				@Override public void apply(AgentId agent, AgentInputState previous, AgentInputState state) {
					if (state != null) holder[0].player.getInventory().setSelectedSlot(state.selectedSlot());
				}
				@Override public void clear(AgentId agent, AgentInputState previous) { }
			}));

			// The look and the walk keys go through Carpet's action pack, so the body is a Carpet fake (as RangedTargetContractVerification).
			ServerPlayer player = (ServerPlayer) unsafe.allocateInstance(fakeType());
			player.setId(2013);
			ForestBody forestBody = (ForestBody) player;
			forestBody.setup(level, new EntityPlayerActionPack(player) { @Override public void setSlot(int slot) { } });
			forestBody.health(20.0F);
			set(unsafe, player, ServerPlayer.class, "connection", unsafe.allocateInstance(FixtureConnection.class));
			set(unsafe, player, Entity.class, "uuid", playerId);
			set(unsafe, player, Player.class, "gameProfile", new GameProfile(playerId, "Hunter"));
			set(unsafe, player, Entity.class, "type", McEntityTypes.PLAYER);
			set(unsafe, player, Entity.class, "level", level);
			EntityEquipment equipment = new EntityEquipment();
			set(unsafe, player, LivingEntity.class, "equipment", equipment);
			set(unsafe, player, Player.class, "inventory", new Inventory(player, equipment));
			set(unsafe, player, Player.class, "abilities", new Abilities());
			set(unsafe, player, Player.class, "foodData", new FoodData());
			set(unsafe, player, LivingEntity.class, "activeEffects", new HashMap<>());
			set(unsafe, player, LivingEntity.class, "attributes", new net.minecraft.world.entity.ai.attributes.AttributeMap(Player.createAttributes().build()));
			place(unsafe, player, new Vec3(0.5D, 64.0D, 0.5D), 0.6D, 1.8D);
			unsafe.putFloat(player, unsafe.objectFieldOffset(Entity.class.getDeclaredField("eyeHeight")), 1.62F);
			health(unsafe, player, 20.0F);
			player.getInventory().setItem(0, new ItemStack(Items.IRON_SWORD));
			level.entities.add(player);
			Fixture fixture = new Fixture(unsafe, server, level, player);
			holder[0] = fixture;
			return fixture;
		}

		ServerFightUntilController hunt(JsonObject args, ServerFightUntilController.Roofing roofing) {
			return new ServerFightUntilController(player, args, ServerProtectionPolicy.TRUSTED_LOCAL_OPERATOR, now, "fight_until", null, roofing);
		}

		/** Ticks until the hunt ends or ticks run out; the last result. */
		ServerController.TickResult run(ServerFightUntilController hunt, int maxTicks) {
			ServerController.TickResult result = null;
			for (int tick = 0; tick < maxTicks; tick++) {
				level.time++;
				now += 50L;
				ticks++;
				result = hunt.tick(player, now);
				if (result.state() != ServerController.State.RUNNING) return result;
			}
			return result;
		}

		/** A scripted walk: after ticks it ends as told, the body moved to moveTo (null: stays); RUNNING never ends. */
		ServerController walk(int length, ServerController.State end, String code, Vec3 moveTo) {
			walksMade++;
			if (firstWalkTick < 0) firstWalkTick = ticks;
			Fixture self = this;
			return new ServerController() {
				int ticked;
				@Override public TickResult tick(ServerPlayer body, long nowEpochMs) {
					ticked++;
					if (moveTo != null && end == State.RUNNING && ticked == 1) self.move(moveTo);
					if (end == State.RUNNING || ticked < length) return TickResult.running(0.0D);
					if (moveTo != null) self.move(moveTo);
					return new TickResult(end, code, code, 0.0D);
				}
				@Override public void cancel(ServerPlayer body) { cancelledWalks++; }
			};
		}

		void move(Vec3 to) {
			try {
				place(unsafe, player, to, 0.6D, 1.8D);
			} catch (Exception exception) {
				throw new AssertionError(exception);
			}
		}

		FixtureEnderman enderman(Vec3 at, Player target) throws Exception {
			FixtureEnderman enderman = (FixtureEnderman) unsafe.allocateInstance(FixtureEnderman.class);
			enderman.setId(3000 + level.entities.size());
			enderman.fixtureLevel = level;
			set(unsafe, enderman, Entity.class, "uuid", UUID.randomUUID());
			set(unsafe, enderman, Entity.class, "type", McEntityTypes.ENDERMAN);
			set(unsafe, enderman, Entity.class, "level", level);
			set(unsafe, enderman, LivingEntity.class, "activeEffects", new HashMap<>());
			set(unsafe, enderman, LivingEntity.class, "equipment", new EntityEquipment());
			set(unsafe, enderman, LivingEntity.class, "attributes", new net.minecraft.world.entity.ai.attributes.AttributeMap(dev.agaminggod.mineagen.compat.TestEndermanBase.endermanAttributes().build()));
			place(unsafe, enderman, at, 0.6D, 2.9D);
			unsafe.putFloat(enderman, unsafe.objectFieldOffset(Entity.class.getDeclaredField("eyeHeight")), 2.55F);
			health(unsafe, enderman, 40.0F);
			enderman.fixtureTarget = target;
			level.entities.add(enderman);
			return enderman;
		}

		@Override
		public void close() throws Exception {
			instances().remove(server);
			controllers().remove(server);
		}
	}

	@SuppressWarnings("unchecked")
	private static Map<MinecraftServer, AgentManager> instances() throws Exception {
		Field field = AgentManager.class.getDeclaredField("INSTANCES");
		field.setAccessible(true);
		return (Map<MinecraftServer, AgentManager>) field.get(null);
	}

	@SuppressWarnings("unchecked")
	private static Map<MinecraftServer, LeasedServerInputController> controllers() throws Exception {
		Field field = AgentInputRuntime.class.getDeclaredField("CONTROLLERS");
		field.setAccessible(true);
		return (Map<MinecraftServer, LeasedServerInputController>) field.get(null);
	}

	private static void place(sun.misc.Unsafe unsafe, Entity entity, Vec3 position, double width, double height) throws Exception {
		set(unsafe, entity, Entity.class, "position", position);
		set(unsafe, entity, Entity.class, "blockPosition", BlockPos.containing(position));
		set(unsafe, entity, Entity.class, "deltaMovement", Vec3.ZERO);
		set(unsafe, entity, Entity.class, "bb", new AABB(position.x - width / 2.0D, position.y, position.z - width / 2.0D,
				position.x + width / 2.0D, position.y + height, position.z + width / 2.0D));
	}

	@SuppressWarnings("unchecked")
	private static void health(sun.misc.Unsafe unsafe, LivingEntity entity, float health) throws Exception {
		Field healthField = LivingEntity.class.getDeclaredField("DATA_HEALTH_ID");
		healthField.setAccessible(true);
		EntityDataAccessor<Float> accessor = (EntityDataAccessor<Float>) healthField.get(null);
		Field flagsField = Entity.class.getDeclaredField("DATA_SHARED_FLAGS_ID");
		flagsField.setAccessible(true);
		EntityDataAccessor<Byte> flags = (EntityDataAccessor<Byte>) flagsField.get(null);
		var items = new SynchedEntityData.DataItem<?>[Math.max(accessor.id(), flags.id()) + 1];
		items[accessor.id()] = new SynchedEntityData.DataItem<>(accessor, health);
		items[flags.id()] = new SynchedEntityData.DataItem<>(flags, (byte) 0);
		var constructor = SynchedEntityData.class.getDeclaredConstructor(net.minecraft.network.syncher.SyncedDataHolder.class, SynchedEntityData.DataItem[].class);
		constructor.setAccessible(true);
		set(unsafe, entity, Entity.class, "entityData", constructor.newInstance(entity, items));
	}

	private static void set(sun.misc.Unsafe unsafe, Object target, Class<?> owner, String name, Object value) throws Exception {
		unsafe.putObject(target, unsafe.objectFieldOffset(owner.getDeclaredField(name)), value);
	}

	private static void check(boolean condition, String label) {
		if (!condition) throw new AssertionError(label);
		assertions++;
	}

	private static final class ForestLevel extends ServerLevel {
		private int fixtureEntityIds = 200_000;
		public int getNextEntityId() { return ++fixtureEntityIds; }
		private MinecraftServer server;
		private net.minecraft.core.RegistryAccess registries;
		private List<Entity> entities;
		private long time = 1_000L;

		private ForestLevel() {
			super(null, Runnable::run, null, null, Level.NETHER, null, false, 0L, List.of(), false);
		}

		@Override public MinecraftServer getServer() { return server; }
		@Override public long getGameTime() { return time; }
		@Override public boolean hasChunkAt(BlockPos position) { return true; }
		@Override public int getHeight() { return 384; }
		@Override public net.minecraft.core.RegistryAccess registryAccess() { return registries; }
		@Override public boolean hasChunk(int x, int z) { return true; }
		@Override public <T extends Entity> List<T> getEntitiesOfClass(Class<T> type, AABB bounds, java.util.function.Predicate<? super T> predicate) {
			return entities.stream().filter(type::isInstance).map(type::cast).filter(entity -> entity.getBoundingBox().intersects(bounds)).filter(predicate).toList();
		}
		@Override public int getMinY() { return -64; }
		@Override public int getMaxY() { return 320; }
		@Override public net.minecraft.world.level.material.FluidState getFluidState(BlockPos position) {
			return net.minecraft.world.level.material.Fluids.EMPTY.defaultFluidState();
		}
		@Override public BlockState getBlockState(BlockPos position) {
			return position.getY() < 64 ? Blocks.WARPED_NYLIUM.defaultBlockState() : Blocks.AIR.defaultBlockState();
		}
	}

	/** What the test sets on its body (the hidden Carpet-fake copy of ForestPlayer keeps this interface). */
	interface ForestBody {
		void setup(ForestLevel level, EntityPlayerActionPack pack);
		void health(float health);
		void lava(boolean lava);
	}

	private static Class<?> fakeType() throws IOException, IllegalAccessException {
		try (var input = ForestHuntTickVerification.class.getResourceAsStream("ForestHuntTickVerification$ForestPlayer.class")) {
			if (input == null) throw new AssertionError("forest fake template is missing");
			var writer = new ClassWriter(0);
			new ClassReader(input).accept(new ClassVisitor(Opcodes.ASM9, writer) {
				@Override public void visit(int version, int access, String name, String signature, String parent, String[] interfaces) {
					super.visit(version, access, name, signature, "carpet/patches/EntityPlayerMPFake", interfaces);
				}
				@Override public MethodVisitor visitMethod(int access, String name, String descriptor, String signature, String[] exceptions) {
					return name.equals("<init>") ? null : super.visitMethod(access, name, descriptor, signature, exceptions);
				}
			}, 0);
			return MethodHandles.lookup().defineHiddenClass(writer.toByteArray(), true, MethodHandles.Lookup.ClassOption.NESTMATE).lookupClass();
		}
	}

	private static final class ForestPlayer extends ServerPlayer implements ServerPlayerInterface, ForestBody {
		private ForestLevel fixtureLevel;
		private EntityPlayerActionPack pack;
		private float health;
		private boolean lava;

		private ForestPlayer() {
			super(null, null, null, null);
		}

		@Override public void setup(ForestLevel level, EntityPlayerActionPack pack) { this.fixtureLevel = level; this.pack = pack; }
		@Override public void health(float health) { this.health = health; }
		@Override public void lava(boolean lava) { this.lava = lava; }
		@Override public EntityPlayerActionPack getActionPack() { return pack; }
		@Override public void invalidateEntityObjectReference() { }
		@Override public boolean isInvalidEntityObject() { return false; }
		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public boolean isAlive() { return true; }
		@Override public boolean isUsingItem() { return false; }
		@Override public boolean isSpectator() { return false; }
		@Override public boolean isCreative() { return false; }
		@Override public boolean onGround() { return true; }
		@Override public boolean isInWater() { return false; }
		@Override public boolean isUnderWater() { return false; }
		@Override public boolean isInLava() { return lava; }
		@Override public boolean onClimbable() { return false; }
		@Override public float getHealth() { return health; }
		@Override public int getAirSupply() { return 300; }
		@Override public float getAttackStrengthScale(float partialTick) { return 1.0F; }
		@Override public double entityInteractionRange() { return 3.0D; }
		@Override public void attack(Entity target) { }
		@Override public void setShiftKeyDown(boolean value) { }
		@Override public void setSprinting(boolean value) { }
		@Override public boolean isShiftKeyDown() { return false; }
		@Override public boolean isEyeInFluid(net.minecraft.tags.TagKey<net.minecraft.world.level.material.Fluid> fluid) { return false; }
	}

	private static final class FixtureConnection extends ServerGamePacketListenerImpl {
		private FixtureConnection() { super(null, null, null, null); }
		@Override public void send(Packet<?> packet) { }
	}

	private static final class FixtureEnderman extends dev.agaminggod.mineagen.compat.TestEndermanBase {
		private ForestLevel fixtureLevel;
		private Player fixtureTarget;

		private FixtureEnderman() {
		}

		@Override public Level level() { return fixtureLevel; }
		@Override public boolean isAlive() { return true; }
		@Override public float getHealth() { return 40.0F; }
		@Override public boolean isInvisibleTo(Player observer) { return false; }
		@Override public LivingEntity getTarget() { return fixtureTarget; }
	}
}
