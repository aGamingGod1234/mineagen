package dev.agaminggod.mineagen.server.runtime.controller;

import carpet.fakes.ServerPlayerInterface;
import carpet.helpers.EntityPlayerActionPack;
import com.google.gson.JsonObject;
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
import java.io.IOException;
import java.lang.invoke.MethodHandles;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import java.util.Optional;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.network.protocol.Packet;
import net.minecraft.network.syncher.EntityDataAccessor;
import net.minecraft.network.syncher.SynchedEntityData;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.dedicated.DedicatedServer;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.server.network.ServerGamePacketListenerImpl;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Abilities;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;
import org.objectweb.asm.ClassReader;
import org.objectweb.asm.ClassVisitor;
import org.objectweb.asm.ClassWriter;
import org.objectweb.asm.MethodVisitor;
import org.objectweb.asm.Opcodes;

/**
 * The -Dmineagen.fight.skipUnreachable switch ({@link UnreachableTargets}): pure rules first, then the real
 * {@link ServerFightUntilController} ticked on an Unsafe-allocated level and Carpet-fake body (as the forest hunt tick
 * tests), with each sword engagement's ending scripted through {@link ServerFightUntilController#scriptedMelee}. Every
 * controller case runs with the switch off (today's behaviour, pinned) and on.
 */
public final class SkipUnreachableVerification {
	private static int assertions;
	private static final String UNREACHABLE = "NO_SEEN_ROUTE";

	private SkipUnreachableVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		System.out.println("PASS: " + verify() + " skip unreachable target assertions");
	}

	public static int verify() throws Exception {
		assertions = 0;
		verifyRules();
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		Map<ServerPlayer, Object> seenPlayers = seenTerrainPlayers();
		Field sweptAtField = dev.agaminggod.mineagen.server.perception.SeenTerrain.class.getDeclaredField("sweptAt");
		sweptAtField.setAccessible(true);
		Map<ServerPlayer, Object> savedPlayers = new java.util.IdentityHashMap<>(seenPlayers);
		long savedSweptAt = sweptAtField.getLong(null);
		String savedSwitch = System.getProperty(UnreachableTargets.PROPERTY);
		seenPlayers.clear();
		try {
			for (boolean on : new boolean[] {false, true}) {
				verifyPicksReachable(on);
				verifyQuietWithOnlyUnreachableInView(on);
				verifyAreaClearedPastUnreachable(on);
			}
			verifyEligibleAfterMoving();
		} finally {
			ServerFightUntilController.scriptedMelee = null;
			if (savedSwitch == null) System.clearProperty(UnreachableTargets.PROPERTY);
			else System.setProperty(UnreachableTargets.PROPERTY, savedSwitch);
			seenPlayers.clear();
			seenPlayers.putAll(savedPlayers);
			sweptAtField.setLong(null, savedSweptAt);
		}
		return assertions;
	}

	/** The class alone: what is marked, how long it stays passed over, and the switch off. */
	private static void verifyRules() {
		UUID id = new UUID(0L, 7L);
		Vec3 mob = new Vec3(0.5D, 68.0D, 5.5D);
		Vec3 body = new Vec3(0.5D, 64.0D, 0.5D);
		UnreachableTargets off = new UnreachableTargets(false);
		check(!off.failed(id, UNREACHABLE, true, false, mob, body, 10) && !off.passedOver(id, mob, body, Integer.MIN_VALUE) && !off.marked(id),
				"switch off: nothing is marked or passed over");
		check(System.getProperty(UnreachableTargets.PROPERTY) != null || !UnreachableTargets.fromProperty().enabled(), "the switch is off by default");

		UnreachableTargets on = new UnreachableTargets(true);
		check(!on.failed(id, "APPROACH_BLOCKED", true, false, mob, body, 10), "a blocked step is not an unreachable answer");
		check(!on.failed(id, "TARGET_ESCAPED", true, false, mob, body, 10), "an escape is not an unreachable answer");
		check(!on.failed(id, UNREACHABLE, false, false, mob, body, 10), "a bow volley is never marked");
		check(!on.failed(id, "TARGET_UNREACHABLE", true, true, mob, body, 10), "a blaze fight is never marked");
		check(on.failures() == 0 && !on.passedOver(id, mob, body, Integer.MIN_VALUE), "nothing marked so far");
		check(on.failed(id, "TARGET_UNREACHABLE", true, false, mob, body, 10) && on.passedOver(id, mob, body, Integer.MIN_VALUE),
				"a sword approach with no route marks the mob");
		check(on.passedOver(id, mob.add(2.9D, 0.0D, 0.0D), body.add(0.0D, 0.0D, 2.9D), 10), "under 3 blocks of movement it stays passed over");
		check(on.passedOver(id, mob, body, 9), "a hurt from before the failure does not let it back in");
		check(!on.passedOver(id, mob.add(0.0D, 0.0D, 3.0D), body, Integer.MIN_VALUE) && !on.marked(id) && on.readmitted() == 1,
				"the mob 3 blocks from where it failed is a target again");
		on.failed(id, UNREACHABLE, true, false, mob, body, 20);
		check(!on.passedOver(id, mob, body.add(3.0D, 0.0D, 0.0D), Integer.MIN_VALUE), "the body 3 blocks from where it failed lets it back in");
		on.failed(id, UNREACHABLE, true, false, mob, body, 30);
		check(on.marked(id) && !on.passedOver(id, mob, body, 31), "a hit on the body after the failure lets it back in");
		check(on.failures() == 3 && on.readmitted() == 3, "counts for the receipt");
	}

	/**
	 * An angry enderman on a pillar (nearer, so picked first) whose approach finds no route, and an angry one on open
	 * ground. Off: the pillar one is kept on as an attacker, engagement after engagement. On: the next engagement is
	 * the reachable one.
	 */
	private static void verifyPicksReachable(boolean on) throws Exception {
		try (Fixture fixture = Fixture.create(on)) {
			FixtureEnderman pillar = fixture.enderman(new Vec3(0.5D, 68.0D, 4.5D), fixture.player);
			FixtureEnderman ground = fixture.enderman(new Vec3(3.5D, 64.0D, 5.5D), fixture.player);
			fixture.script(pillar, 3, UNREACHABLE);
			ServerFightUntilController hunt = fixture.hunt(hunt(60_000L));
			fixture.run(hunt, 400);
			String label = on ? "on" : "off";
			check(!fixture.engaged.isEmpty() && fixture.engaged.get(0) == pillar, label + ": the nearer pillar enderman is tried first: " + fixture.names());
			if (on) {
				check(fixture.engaged.size() == 2 && fixture.engaged.get(1) == ground, "on: the reachable one is engaged next: " + fixture.names());
			} else {
				check(fixture.engaged.size() >= 20 && !fixture.engaged.contains(ground),
						"off (today): the unreachable attacker is re-engaged without end and the reachable one waits: " + fixture.engaged.size());
			}
		}
	}

	/**
	 * Two angry endermen on pillars, both unreachable, nothing else. Off: the hunt stays pinned on them to its time cap.
	 * On: the quiet spell starts once both failed and the hunt hands back NO_TARGET_SEEN about 30 s later (not
	 * NO_SEEN_ROUTE: out-of-reach attackers are not failures in a row).
	 */
	private static void verifyQuietWithOnlyUnreachableInView(boolean on) throws Exception {
		try (Fixture fixture = Fixture.create(on)) {
			FixtureEnderman left = fixture.enderman(new Vec3(-1.5D, 68.0D, 4.5D), fixture.player);
			FixtureEnderman right = fixture.enderman(new Vec3(2.5D, 68.0D, 4.5D), fixture.player);
			fixture.script(left, 3, UNREACHABLE);
			fixture.script(right, 3, UNREACHABLE);
			ServerFightUntilController hunt = fixture.hunt(hunt(60_000L));
			ServerController.TickResult end = fixture.run(hunt, 1_400);
			if (on) {
				check(end.state() != ServerController.State.RUNNING && "NO_TARGET_SEEN".equals(end.reasonCode()),
						"on: the quiet spell runs out with only unreachable endermen in view: " + end.reasonCode());
				long quietTicks = fixture.ticks - fixture.lastEngagedTick;
				check(quietTicks >= ServerFightUntilController.NO_TARGET_MS / 50L - 2L && quietTicks <= ServerFightUntilController.NO_TARGET_MS / 50L + 40L,
						"on: it hands back about 30 s after the last failed approach: " + quietTicks + " ticks");
				check(fixture.engaged.size() == 2, "on: each was tried once: " + fixture.engaged.size());
				check(end.message().contains("out of reach: passed over 2 times"), "on: the receipt names it: " + end.message());
			} else {
				check("FIGHT_UNTIL_TIMED_OUT".equals(end.reasonCode()), "off (today): pinned to the time cap: " + end.reasonCode());
				check(fixture.engaged.size() >= 100, "off (today): hundreds of failed approaches: " + fixture.engaged.size());
				check(!end.message().contains("out of reach: passed over"), "off: the receipt is as today");
			}
		}
	}

	/**
	 * Model spot (the cleared-area look applies after a kill): an angry enderman on open ground is killed, then a calm
	 * one on a pillar is stared at, walked in to and found unreachable. Off: it holds off the quiet spell while passed
	 * over (15 s), then is tried again and the call ends on two NO_SEEN_ROUTE in a row. On: the look around ends
	 * AREA_CLEARED a few seconds after its failure.
	 */
	private static void verifyAreaClearedPastUnreachable(boolean on) throws Exception {
		try (Fixture fixture = Fixture.create(on)) {
			FixtureEnderman ground = fixture.enderman(new Vec3(0.5D, 64.0D, 3.5D), fixture.player);
			FixtureEnderman pillar = fixture.enderman(new Vec3(2.5D, 68.0D, 6.5D), null);
			fixture.script(ground, 5, "KILL");
			fixture.script(pillar, 3, UNREACHABLE);
			JsonObject args = hunt(90_000L);
			args.addProperty("x", 0.5D);
			args.addProperty("y", 64.0D);
			args.addProperty("z", 0.5D);
			ServerController.TickResult end = fixture.run(fixture.hunt(args), 1_800);
			check(fixture.engaged.size() >= 2 && fixture.engaged.get(0) == ground && fixture.engaged.get(1) == pillar,
					(on ? "on" : "off") + ": killed the reachable one, then tried the pillar one: " + fixture.names());
			long afterFailure = fixture.ticks - fixture.lastEngagedTick;
			if (on) {
				check("AREA_CLEARED".equals(end.reasonCode()), "on: the area counts as cleared past the unreachable one: " + end.reasonCode() + " " + end.message());
				check(afterFailure <= AreaCleared.MAX_QUIET_MS / 50L + 20L, "on: within the look around after its failure: " + afterFailure + " ticks");
				check(fixture.engaged.size() == 2, "on: not tried again: " + fixture.engaged.size());
			} else {
				check("NO_SEEN_ROUTE".equals(end.reasonCode()) && fixture.engaged.size() == 3,
						"off (today): passed over 15 s, then tried again and two failures in a row end it: " + end.reasonCode() + " " + fixture.engaged.size());
			}
		}
	}

	/** On: the passed-over enderman is not tried while it shifts 2 blocks, and is tried again once it is 3 from where it failed. */
	private static void verifyEligibleAfterMoving() throws Exception {
		try (Fixture fixture = Fixture.create(true)) {
			Vec3 at = new Vec3(0.5D, 68.0D, 4.5D);
			FixtureEnderman pillar = fixture.enderman(at, fixture.player);
			fixture.script(pillar, 3, UNREACHABLE);
			ServerFightUntilController hunt = fixture.hunt(hunt(120_000L));
			fixture.run(hunt, 200);
			check(fixture.engaged.size() == 1, "tried once, then passed over: " + fixture.engaged.size());
			fixture.move(pillar, at.add(2.0D, 0.0D, 0.0D));
			fixture.run(hunt, 100);
			check(fixture.engaged.size() == 1, "2 blocks from where it failed it is still passed over: " + fixture.engaged.size());
			fixture.move(pillar, at.add(-1.0D, 0.0D, 0.0D));
			fixture.run(hunt, 100);
			check(fixture.engaged.size() == 1, "back within 3 blocks of where it failed it stays passed over: " + fixture.engaged.size());
			fixture.move(pillar, at.add(3.0D, 0.0D, 0.0D));
			fixture.run(hunt, 40);
			check(fixture.engaged.size() == 2 && fixture.engaged.get(1) == pillar, "3 blocks on it is tried again: " + fixture.engaged.size());
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

	private record Script(int ticks, String code) {}

	private static final class Fixture implements AutoCloseable {
		final sun.misc.Unsafe unsafe;
		final MinecraftServer server;
		final SkipLevel level;
		final ServerPlayer player;
		final Map<LivingEntity, Script> scripts = new HashMap<>();
		final List<LivingEntity> engaged = new ArrayList<>();
		long now = 1_000L;
		int ticks;
		int lastEngagedTick;

		private Fixture(sun.misc.Unsafe unsafe, MinecraftServer server, SkipLevel level, ServerPlayer player) {
			this.unsafe = unsafe;
			this.server = server;
			this.level = level;
			this.player = player;
		}

		static Fixture create(boolean on) throws Exception {
			if (on) System.setProperty(UnreachableTargets.PROPERTY, "true");
			else System.clearProperty(UnreachableTargets.PROPERTY);
			Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			unsafeField.setAccessible(true);
			sun.misc.Unsafe unsafe = (sun.misc.Unsafe) unsafeField.get(null);
			MinecraftServer server = (MinecraftServer) unsafe.allocateInstance(DedicatedServer.class);
			SkipLevel level = (SkipLevel) unsafe.allocateInstance(SkipLevel.class);
			level.server = server;
			level.entities = new ArrayList<>();
			level.time = 1_000L;
			var registries = new net.minecraft.core.MappedRegistry<net.minecraft.core.Registry<?>>(
					net.minecraft.resources.ResourceKey.createRegistryKey(net.minecraft.core.registries.BuiltInRegistries.REGISTRY.key().identifier()),
					com.mojang.serialization.Lifecycle.stable());
			var enchantments = new net.minecraft.core.MappedRegistry<net.minecraft.world.item.enchantment.Enchantment>(
					net.minecraft.core.registries.Registries.ENCHANTMENT, com.mojang.serialization.Lifecycle.stable());
			enchantments.freeze();
			net.minecraft.core.Registry.register(registries, net.minecraft.core.registries.Registries.ENCHANTMENT.identifier(), enchantments);
			registries.freeze();
			level.registries = net.minecraft.core.RegistryAccess.fromRegistryOfRegistries(registries);
			set(unsafe, level, Level.class, "dimension", Level.OVERWORLD);

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

			// The look and the walk keys go through Carpet's action pack, so the body is a Carpet fake.
			ServerPlayer player = (ServerPlayer) unsafe.allocateInstance(fakeType());
			player.setId(2014);
			((SkipBody) player).setup(level, new EntityPlayerActionPack(player) { @Override public void setSlot(int slot) { } });
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
			level.entities.add(player);
			Fixture fixture = new Fixture(unsafe, server, level, player);
			holder[0] = fixture;
			ServerFightUntilController.scriptedMelee = fixture::engagement;
			return fixture;
		}

		ServerFightUntilController hunt(JsonObject args) {
			return new ServerFightUntilController(player, args, ServerProtectionPolicy.TRUSTED_LOCAL_OPERATOR, now, "fight_until", null, null);
		}

		/** The engaged endermen by entity id, for labels (an entity's own toString needs a real level). */
		List<Integer> names() {
			return engaged.stream().map(Entity::getId).toList();
		}

		/** How each enderman's sword engagements end: after ticks, with code ("KILL" kills it); unscripted ones run on. */
		void script(LivingEntity enderman, int ticks, String code) {
			scripts.put(enderman, new Script(ticks, code));
		}

		ServerController engagement(LivingEntity target) {
			engaged.add(target);
			lastEngagedTick = ticks;
			Script script = scripts.get(target);
			return new ServerController() {
				int ticked;
				@Override public TickResult tick(ServerPlayer body, long nowEpochMs) {
					if (script == null || ++ticked < script.ticks()) return TickResult.running(0.0D);
					lastEngagedTick = ticks;
					if ("KILL".equals(script.code())) {
						((FixtureEnderman) target).dead = true;
						return TickResult.succeeded("TARGET_KILLED", "killed");
					}
					return TickResult.failed(script.code(), "scripted: no route through seen terrain to a spot within reach", 0.0D);
				}
				@Override public void cancel(ServerPlayer body) { }
			};
		}

		/** Ticks until the hunt ends or ticks run out; the last result. The body faces +z, toward the endermen. */
		ServerController.TickResult run(ServerFightUntilController hunt, int maxTicks) {
			ServerController.TickResult result = null;
			for (int tick = 0; tick < maxTicks; tick++) {
				level.time++;
				now += 50L;
				ticks++;
				player.setYRot(0.0F);
				player.setXRot(-20.0F);
				result = hunt.tick(player, now);
				if (result.state() != ServerController.State.RUNNING) return result;
			}
			return result;
		}

		void move(Entity entity, Vec3 to) {
			try {
				place(unsafe, entity, to, entity == player ? 0.6D : 0.6D, entity == player ? 1.8D : 2.9D);
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
			ServerFightUntilController.scriptedMelee = null;
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

	/** Flat ground: solid below y 64, air above. */
	private static final class SkipLevel extends ServerLevel {
		private int fixtureEntityIds = 300_000;
		public int getNextEntityId() { return ++fixtureEntityIds; }
		private MinecraftServer server;
		private net.minecraft.core.RegistryAccess registries;
		private List<Entity> entities;
		private long time;

		private SkipLevel() {
			super(null, Runnable::run, null, null, Level.OVERWORLD, null, false, 0L, List.of(), false);
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
			return position.getY() < 64 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
		}
	}

	/** What the test sets on its body (the hidden Carpet-fake copy of SkipPlayer keeps this interface). */
	interface SkipBody {
		void setup(SkipLevel level, EntityPlayerActionPack pack);
	}

	private static Class<?> fakeType() throws IOException, IllegalAccessException {
		try (var input = SkipUnreachableVerification.class.getResourceAsStream("SkipUnreachableVerification$SkipPlayer.class")) {
			if (input == null) throw new AssertionError("fake body template is missing");
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

	private static final class SkipPlayer extends ServerPlayer implements ServerPlayerInterface, SkipBody {
		private SkipLevel fixtureLevel;
		private EntityPlayerActionPack pack;

		private SkipPlayer() {
			super(null, null, null, null);
		}

		@Override public void setup(SkipLevel level, EntityPlayerActionPack pack) { this.fixtureLevel = level; this.pack = pack; }
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
		@Override public boolean isInLava() { return false; }
		@Override public boolean onClimbable() { return false; }
		@Override public float getHealth() { return 20.0F; }
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
		private SkipLevel fixtureLevel;
		private Player fixtureTarget;
		private boolean dead;

		private FixtureEnderman() {
		}

		@Override public Level level() { return fixtureLevel; }
		@Override public boolean isAlive() { return !dead; }
		@Override public float getHealth() { return dead ? 0.0F : 40.0F; }
		@Override public boolean isInvisibleTo(Player observer) { return false; }
		@Override public LivingEntity getTarget() { return dead ? null : fixtureTarget; }
	}
}
