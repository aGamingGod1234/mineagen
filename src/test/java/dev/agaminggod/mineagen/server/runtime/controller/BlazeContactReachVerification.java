package dev.agaminggod.mineagen.server.runtime.controller;

import com.mojang.authlib.GameProfile;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.agent.AgentRecord;
import dev.agaminggod.mineagen.server.AgentSavedData;
import dev.agaminggod.mineagen.server.AgentManager;
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
import net.minecraft.world.entity.EntityType;
import dev.agaminggod.mineagen.compat.McEntityTypes;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.monster.zombie.Zombie;
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
 * Blaze spawner deaths (wave 6 batch t1): a blaze touching the body at 0.6 blocks got no swing for 14.7 s while the
 * fight held its deck for the named blaze, which stood 2 blocks off behind the spawner and a wall: in sword range, but
 * with no clear line to hit. The fight's in-reach switch asked only "in range", so it never turned to the one hitting
 * the body. Drives the real {@link ServerFightController#tick} on Unsafe-allocated fixtures (no live server), as
 * {@link FightWeaponBreakVerification}: the touching blaze must take a swing within 1 s (20 ticks), and a cornered body
 * whose low-health retreat is blocked keeps swinging at it instead of going idle.
 */
public final class BlazeContactReachVerification {
	private static int assertions;

	private BlazeContactReachVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		System.out.println("PASS: " + verify() + " blaze contact reach assertions");
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
		seenPlayers.clear();
		try (ItemBindings bindings = new ItemBindings()) {
			bindings.bind(Items.IRON_SWORD, 250, net.minecraft.tags.ItemTags.SWORDS);
			for (boolean cornered : new boolean[]{false, true}) {
				Fixture fixture = Fixture.create(cornered);
				try {
					fixture.run();
					if (cornered) fixture.verifyStandEnds();
				} finally {
					fixture.close();
					seenPlayers.clear();
				}
			}
			// The named blaze itself hovering half a block up, its box round the body's eye (0.2 blocks off).
			{
				Fixture fixture = Fixture.create(false);
				try {
					fixture.verifyNamedInContact();
				} finally {
					fixture.close();
					seenPlayers.clear();
				}
			}
		} finally {
			seenPlayers.clear();
			seenPlayers.putAll(savedPlayers);
			sweptAtField.setLong(null, savedSweptAt);
		}
		return assertions;
	}

	@SuppressWarnings("unchecked")
	private static Map<ServerPlayer, Object> seenTerrainPlayers() throws Exception {
		Field field = dev.agaminggod.mineagen.server.perception.SeenTerrain.class.getDeclaredField("PLAYERS");
		field.setAccessible(true);
		return (Map<ServerPlayer, Object>) field.get(null);
	}

	private static final class Fixture {
		final MinecraftServer server;
		final FightPlayer player;
		final FightBlaze walled;
		final FightBlaze touching;
		final boolean cornered;
		sun.misc.Unsafe unsafe;
		ServerFightController fight;
		long now;

		private Fixture(MinecraftServer server, FightPlayer player, FightBlaze walled, FightBlaze touching, boolean cornered) {
			this.server = server;
			this.player = player;
			this.walled = walled;
			this.touching = touching;
			this.cornered = cornered;
		}

		static Fixture create(boolean cornered) throws Exception {
			Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
			unsafeField.setAccessible(true);
			sun.misc.Unsafe unsafe = (sun.misc.Unsafe) unsafeField.get(null);
			MinecraftServer server = (MinecraftServer) unsafe.allocateInstance(DedicatedServer.class);
			FightLevel level = (FightLevel) unsafe.allocateInstance(FightLevel.class);
			level.server = server;
			level.cornered = cornered;
			var registries = new net.minecraft.core.MappedRegistry<net.minecraft.core.Registry<?>>(
					net.minecraft.resources.ResourceKey.createRegistryKey(
							net.minecraft.core.registries.BuiltInRegistries.REGISTRY.key().identifier()),
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
			AgentRecord record = manager.registry().create("gpt-5.6-sol", "high", Optional.of("Fighter"), 1_000L);
			UUID playerId = UUID.fromString("00000000-0000-4000-8000-00000000b001");
			manager.registry().attachEntity(record.agentId(), playerId, 1_000L);
			instances().put(server, manager);
			controllers().put(server, new LeasedServerInputController(new InputStateSink() {
				@Override public void apply(AgentId agent, AgentInputState previous, AgentInputState state) { }
				@Override public void clear(AgentId agent, AgentInputState previous) { }
			}));

			FightPlayer player = (FightPlayer) unsafe.allocateInstance(FightPlayer.class);
			player.setId(2013);
			player.fixtureLevel = level;
			player.attacks = new ArrayList<>();
			player.health = cornered ? 4.0F : 20.0F;
			set(unsafe, player, Entity.class, "uuid", playerId);
			set(unsafe, player, Player.class, "gameProfile", new GameProfile(playerId, "Fighter"));
			set(unsafe, player, Entity.class, "type", McEntityTypes.PLAYER);
			set(unsafe, player, Entity.class, "level", level);
			EntityEquipment equipment = new EntityEquipment();
			set(unsafe, player, LivingEntity.class, "equipment", equipment);
			set(unsafe, player, Player.class, "inventory", new Inventory(player, equipment));
			set(unsafe, player, Player.class, "abilities", new Abilities());
			set(unsafe, player, Player.class, "foodData", new FoodData());
			set(unsafe, player, LivingEntity.class, "activeEffects", new HashMap<>());
			set(unsafe, player, LivingEntity.class, "attributes",
					new net.minecraft.world.entity.ai.attributes.AttributeMap(Player.createAttributes().build()));
			place(unsafe, player, new Vec3(0.5D, 64.0D, 0.5D), 0.6D, 1.8D);
			set(unsafe, player, Entity.class, "deltaMovement", Vec3.ZERO);
			unsafe.putFloat(player, unsafe.objectFieldOffset(Entity.class.getDeclaredField("eyeHeight")), 1.62F);
			health(unsafe, player, player.health);

			// The named blaze: 2 blocks south, in sword range, behind a two-high wall at z 1 (the spawner and cobble in c323).
			FightBlaze walled = blaze(unsafe, level, player, 2014, "00000000-0000-4000-8000-00000000b0a1", new Vec3(0.5D, 64.0D, 2.5D));
			// The blaze touching the body: 0.6 blocks east, same floor, targeting it.
			FightBlaze touching = blaze(unsafe, level, player, 2015, "00000000-0000-4000-8000-00000000b0a2", new Vec3(1.1D, 64.0D, 0.5D));
			level.entities = List.of(player, walled, touching);
			Fixture fixture = new Fixture(server, player, walled, touching, cornered);
			fixture.unsafe = unsafe;
			return fixture;
		}

		static FightBlaze blaze(sun.misc.Unsafe unsafe, FightLevel level, Player player, int id, String uuid, Vec3 at) throws Exception {
			FightBlaze blaze = (FightBlaze) unsafe.allocateInstance(FightBlaze.class);
			blaze.setId(id);
			blaze.fixtureLevel = level;
			blaze.victim = player;
			set(unsafe, blaze, Entity.class, "uuid", UUID.fromString(uuid));
			set(unsafe, blaze, Entity.class, "type", McEntityTypes.BLAZE);
			set(unsafe, blaze, Entity.class, "level", level);
			set(unsafe, blaze, LivingEntity.class, "activeEffects", new HashMap<>());
			set(unsafe, blaze, LivingEntity.class, "equipment", new EntityEquipment());
			set(unsafe, blaze, LivingEntity.class, "attributes",
					new net.minecraft.world.entity.ai.attributes.AttributeMap(net.minecraft.world.entity.monster.Blaze.createAttributes().build()));
			place(unsafe, blaze, at, 0.6D, 1.8D);
			set(unsafe, blaze, Entity.class, "dimensions", net.minecraft.world.entity.EntityDimensions.scalable(0.6F, 1.8F));
			set(unsafe, blaze, Entity.class, "deltaMovement", Vec3.ZERO);
			unsafe.putFloat(blaze, unsafe.objectFieldOffset(Entity.class.getDeclaredField("eyeHeight")), 1.53F);
			health(unsafe, blaze, 20.0F);
			return blaze;
		}

		void run() {
			Inventory inventory = player.getInventory();
			inventory.setItem(0, new ItemStack(Items.IRON_SWORD));
			inventory.setSelectedSlot(0);
			player.charge = 1.0F;
			// As the stand-in agent calls it at the spawner: named blaze, pursue, shield, follow-through, flee at 6.
			fight = new ServerFightController(walled, null, 6.0F, true,
					CombatPlanning.TargetPolicy.NAMED, false, true, false, true, 15_000L, 0L);
			int firstSwing = -1;
			ServerController.TickResult last = null;
			for (int tick = 1; tick <= 20 && firstSwing < 0; tick++) {
				last = fight.tick(player, now += 50L);
				if (player.attacks.contains(touching)) firstSwing = tick;
				if (last.state() != ServerController.State.RUNNING) break;
			}
			String scene = cornered ? "cornered at 4 health, retreat blocked: " : "full health: ";
			check(firstSwing > 0, scene + "the blaze touching the body at 0.6 blocks gets a swing within 1 s; last " + last);
			check(!player.attacks.contains(walled), scene + "no swing goes through the wall at the named blaze");
			if (cornered) {
				check(last.state() == ServerController.State.RUNNING, "cornered: the fight goes on rather than ending idle: " + last);
			}
		}

		/** The cornered stand lasts only while an attacker can be hit: with the blaze gone from reach, the bailout stands. */
		void verifyStandEnds() throws Exception {
			place(unsafe, touching, new Vec3(1.1D, 64.0D, 6.5D), 0.6D, 1.8D);
			ServerController.TickResult last = null;
			for (int tick = 0; tick < 10; tick++) {
				last = fight.tick(player, now += 50L);
				if (last.state() != ServerController.State.RUNNING) break;
			}
			check(last.state() == ServerController.State.FAILED && "LOW_HEALTH_BAILOUT".equals(last.reasonCode()),
					"cornered: once no attacker is in reach the fight hands back the low-health bailout: " + last);
			check(last.message().contains("cornered at low health"), "the bailout says it stood and fought while cornered: " + last.message());
		}

		void verifyNamedInContact() throws Exception {
			place(unsafe, touching, new Vec3(0.7D, 64.5D, 0.5D), 0.6D, 1.8D);
			check(touching.getBoundingBox().contains(player.getEyePosition()), "the hovering blaze's box holds the body's eye");
			Inventory inventory = player.getInventory();
			inventory.setItem(0, new ItemStack(Items.IRON_SWORD));
			inventory.setSelectedSlot(0);
			player.charge = 1.0F;
			fight = new ServerFightController(touching, null, 6.0F, true,
					CombatPlanning.TargetPolicy.NAMED, false, true, false, true, 15_000L, 0L);
			int firstSwing = -1;
			for (int tick = 1; tick <= 20 && firstSwing < 0; tick++) {
				fight.tick(player, now += 50L);
				if (player.attacks.contains(touching)) firstSwing = tick;
			}
			check(firstSwing > 0, "the named blaze hovering round the body's eye gets a swing within 1 s");
		}

		void close() throws Exception {
			instances().remove(server);
			controllers().remove(server);
		}
	}

	private static final class ItemBindings implements AutoCloseable {
		private final List<Runnable> restores = new ArrayList<>();

		void bind(net.minecraft.world.item.Item item, int maxDamage, net.minecraft.tags.TagKey<net.minecraft.world.item.Item> tag)
				throws Exception {
			var holder = item.builtInRegistryHolder();
			var originalComponents = holder.areComponentsBound() ? holder.components() : null;
			var originalTags = holder.tags().toList();
			holder.bindComponents(net.minecraft.core.component.DataComponentMap.builder()
					.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 1)
					.set(net.minecraft.core.component.DataComponents.MAX_DAMAGE, maxDamage)
					.set(net.minecraft.core.component.DataComponents.DAMAGE, 0).build());
			var bindTags = net.minecraft.core.Holder.Reference.class.getDeclaredMethod("bindTags", java.util.Collection.class);
			bindTags.setAccessible(true);
			List<net.minecraft.tags.TagKey<net.minecraft.world.item.Item>> tags = new ArrayList<>(originalTags);
			tags.add(tag);
			bindTags.invoke(holder, tags);
			restores.add(() -> {
				try {
					bindTags.invoke(holder, originalTags);
					Field components = net.minecraft.core.Holder.Reference.class.getDeclaredField("components");
					components.setAccessible(true);
					if (originalComponents == null) components.set(holder, null);
					else holder.bindComponents(originalComponents);
				} catch (ReflectiveOperationException exception) {
					throw new AssertionError("could not restore item bindings", exception);
				}
			});
		}

		@Override
		public void close() {
			for (Runnable restore : restores.reversed()) restore.run();
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
		var constructor = SynchedEntityData.class.getDeclaredConstructor(
				net.minecraft.network.syncher.SyncedDataHolder.class, SynchedEntityData.DataItem[].class);
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

	private static final class FightLevel extends ServerLevel {
		private int fixtureEntityIds = 100_000;
		public int getNextEntityId() { return ++fixtureEntityIds; }
		private MinecraftServer server;
		private net.minecraft.core.RegistryAccess registries;
		private List<Entity> entities;
		private boolean cornered;

		private FightLevel() {
			super(null, Runnable::run, null, null, Level.OVERWORLD, null, false, 0L, List.of(), false);
		}

		@Override public MinecraftServer getServer() { return server; }
		@Override public long getGameTime() { return 1_000L; }
		@Override public boolean hasChunkAt(BlockPos position) { return true; }
		@Override public int getHeight() { return 384; }
		@Override public net.minecraft.core.RegistryAccess registryAccess() { return registries; }
		@Override public boolean hasChunk(int x, int z) { return true; }
		@Override public <T extends Entity> List<T> getEntitiesOfClass(Class<T> type, AABB bounds,
				java.util.function.Predicate<? super T> predicate) {
			return entities.stream().filter(type::isInstance).map(type::cast)
					.filter(entity -> entity.getBoundingBox().intersects(bounds)).filter(predicate).toList();
		}
		@Override public int getMinY() { return -64; }
		@Override public int getMaxY() { return 320; }
		@Override public net.minecraft.world.level.material.FluidState getFluidState(BlockPos position) {
			return net.minecraft.world.level.material.Fluids.EMPTY.defaultFluidState();
		}
		@Override public BlockState getBlockState(BlockPos position) {
			if (position.getY() < 64) return Blocks.NETHER_BRICKS.defaultBlockState();
			if (position.getY() > 65) return Blocks.AIR.defaultBlockState();
			int x = position.getX(), z = position.getZ();
			// The wall between the body and the named blaze.
			if (z == 1 && x >= -1 && x <= 1) return Blocks.COBBLESTONE.defaultBlockState();
			// Cornered: a one-block cell, walls on the other sides too (the east cell is the touching blaze's).
			if (cornered && (z == -1 && x >= -1 && x <= 2 || x == -1 && z == 0 || x == 2 && z >= -1 && z <= 1)) return Blocks.COBBLESTONE.defaultBlockState();
			return Blocks.AIR.defaultBlockState();
		}
	}

	private static final class FightPlayer extends dev.agaminggod.mineagen.compat.TestServerPlayerBase {
		private FightLevel fixtureLevel;
		private float charge;
		private float health;
		private List<Entity> attacks;

		private FightPlayer() {
			super(null, null, null, null);
		}

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
		@Override public float getHealth() { return health; }
		@Override public int getAirSupply() { return 300; }
		@Override public float getAttackStrengthScale(float partialTick) { return charge; }
		@Override public double entityInteractionRange() { return 3.0D; }
		@Override protected boolean testSwing(net.minecraft.world.InteractionHand hand, boolean toSelf) { return true; }

		@Override
		public void attack(Entity target) {
			if (attacks == null) attacks = new ArrayList<>();
			attacks.add(target);
		}
	}

	private static final class FightBlaze extends net.minecraft.world.entity.monster.Blaze {
		private FightLevel fixtureLevel;
		private Player victim;

		private FightBlaze() {
			super(McEntityTypes.BLAZE, null);
		}

		@Override public Level level() { return fixtureLevel; }
		@Override public boolean isAlive() { return true; }
		@Override public boolean isUsingItem() { return false; }
		@Override public float getHealth() { return 20.0F; }
		@Override public boolean isInvisibleTo(Player observer) { return false; }
		@Override public LivingEntity getTarget() { return victim; }
		private net.minecraft.world.entity.ai.sensing.Sensing fixtureSensing;
		@Override public net.minecraft.world.entity.ai.sensing.Sensing getSensing() {
			if (fixtureSensing == null) fixtureSensing = new net.minecraft.world.entity.ai.sensing.Sensing(this);
			return fixtureSensing;
		}
	}
}
