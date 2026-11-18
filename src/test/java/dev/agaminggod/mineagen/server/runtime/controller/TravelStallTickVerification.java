package dev.agaminggod.mineagen.server.runtime.controller;

import java.lang.reflect.Field;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * travel_to's stall watchdog through the controller's own tick (issue #2 K4), with a stub body and level and no physics:
 * the window the trip feeds runs out on this tick, and the trip stops STALLED_IN_PLACE, naming why building cannot continue
 * when it cannot. A retreat from lava whose window runs out mid-leg is not a stall: the leg finishes into the watch,
 * with build on or off.
 */
public final class TravelStallTickVerification {
	private static final Vec3 HERE = new Vec3(0.5D, 64.0D, 0.5D);
	private static int assertions;
	private static sun.misc.Unsafe unsafe;

	private TravelStallTickVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		System.out.println("PASS: " + verify() + " travel stall tick assertions");
	}

	public static int verify() throws Exception {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		Field singleton = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
		singleton.setAccessible(true);
		unsafe = (sun.misc.Unsafe) singleton.get(null);

		ServerController.TickResult plain = stalledTick(false, null, null);
		check(plain.state() == ServerController.State.FAILED && "STALLED_IN_PLACE".equals(plain.reasonCode())
				&& plain.message().startsWith("Feet moved 0.0 blocks in 10 s with no block placed or mined"), "the trip's tick stops a body standing in place: " + plain);
		check(!plain.message().contains("building cannot continue"), "no refusal, none named");

		ServerController.TickResult refused = stalledTick(true, "OUT_OF_BLOCKS", "no plain block to bridge with");
		check("STALLED_IN_PLACE".equals(refused.reasonCode()) && refused.message().contains("; building cannot continue: no plain block to bridge with"),
				"a stall after building was refused says why building cannot continue: " + refused.message());

		for (boolean build : new boolean[] {false, true}) {
			ServerTravelController trip = trip(build);
			// A lava retreat leg is under way as the window runs out; its leg ends on this tick (timed out) without planning.
			set(trip, "retreatCode", "LAVA_INCOMING");
			set(trip, "retreatWhy", "Seen lava was flowing into 0,64,0");
			set(trip, "phase", phase("LEG"));
			set(trip, "legTarget", new dev.agaminggod.mineagen.client.navigation.GridPosition(-3, 64, 0));
			set(trip, "legFinal", true);
			set(trip, "leg", new ServerNavigationController(new Vec3(-2.5D, 64.0D, 0.5D), ServerTravelController.RETREAT_TOLERANCE, true, 0L, 1L, true));
			ServerController.TickResult retreating;
			try {
				retreating = trip.tick(player(), 10_000L);
			} catch (RuntimeException planned) {
				// Turned to planning toward the target on the stub level: the assertions below name what went wrong.
				retreating = null;
			}
			Object phase = get(trip, "phase");
			check(retreating != null && retreating.state() == ServerController.State.RUNNING && phase == phase("WATCH")
					&& get(trip, "stallBuildAt") == null,
					"build " + build + ": a retreat whose stall window ran out finishes its leg into the watch: " + retreating + ", phase " + phase
							+ ", stall turn at " + get(trip, "stallBuildAt"));
		}
		return assertions;
	}

	private static Object phase(String name) throws ReflectiveOperationException {
		for (Class<?> nested : ServerTravelController.class.getDeclaredClasses()) {
			if (nested.isEnum() && nested.getSimpleName().equals("Phase")) {
				for (Object constant : nested.getEnumConstants()) if (((Enum<?>) constant).name().equals(name)) return constant;
			}
		}
		throw new IllegalStateException("no phase " + name);
	}

	/** One tick of a trip whose stall window started 10 s ago at the body's spot. */
	private static ServerController.TickResult stalledTick(boolean build, String refusalCode, String refusal) throws Exception {
		StallPlayer player = player();
		ServerTravelController trip = trip(build);
		if (refusal != null) {
			set(trip, "buildRefusal", refusal);
			set(trip, "buildRefusalCode", refusalCode);
		}
		return trip.tick(player, 10_000L);
	}

	/** A trip toward 40 blocks east whose stall window started 10 s ago at the body's spot; the next tick is the 200th. */
	private static ServerTravelController trip(boolean build) throws Exception {
		ServerTravelController trip = new ServerTravelController(40.5D, Double.NaN, 0.5D, 3.0D, 600_000L, build, null, null, (body, at) -> true, 0L);
		set(trip, "start", HERE);
		set(trip, "lastPosition", HERE);
		set(trip, "dimension", Level.OVERWORLD);
		set(trip, "startLeft", 40.0D);
		set(trip, "lastHealth", 20.0F);
		set(trip, "startHealth", 20.0F);
		set(trip, "startFood", 20);
		// The tick about to run is the 200th: the trip's own tick count, which a reflex pause or server lag does not move.
		set(trip, "ticks", TravelStallWatch.WINDOW_TICKS - 1);
		((TravelStallWatch) get(trip, "stallWatch")).observe(0L, HERE.x, HERE.y, HERE.z, 0L);
		return trip;
	}

	private static StallPlayer player() throws Exception {
		StallPlayer player = (StallPlayer) unsafe.allocateInstance(StallPlayer.class);
		player.setId(1016); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
		player.fixtureLevel = (StallLevel) unsafe.allocateInstance(StallLevel.class);
		EntityEquipment equipment = new EntityEquipment();
		player.inventory = new Inventory(player, equipment);
		player.food = new FoodData();
		put(player, Entity.class, "level", player.fixtureLevel);
		put(player, Entity.class, "position", HERE);
		put(player, Entity.class, "bb", new AABB(HERE.x - 0.3D, HERE.y, HERE.z - 0.3D, HERE.x + 0.3D, HERE.y + 1.8D, HERE.z + 0.3D));
		Field grounded = Entity.class.getDeclaredField("onGround");
		grounded.setAccessible(true);
		grounded.setBoolean(player, true);
		return player;
	}

	private static void put(Object target, Class<?> owner, String name, Object value) throws Exception {
		unsafe.putObject(target, unsafe.objectFieldOffset(owner.getDeclaredField(name)), value);
	}

	private static Object get(Object target, String name) throws ReflectiveOperationException {
		Field field = target.getClass().getDeclaredField(name);
		field.setAccessible(true);
		return field.get(target);
	}

	private static void set(Object target, String name, Object value) throws ReflectiveOperationException {
		Field field = target.getClass().getDeclaredField(name);
		field.setAccessible(true);
		field.set(target, value);
	}

	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError("TravelStallTickVerification: " + message);
		assertions++;
	}

	private static final class StallPlayer extends dev.agaminggod.mineagen.compat.TestServerPlayerBase {
		StallLevel fixtureLevel;
		Inventory inventory;
		FoodData food;

		private StallPlayer() {
			super(null, null, null, null);
		}

		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public Inventory getInventory() { return inventory; }
		@Override public FoodData getFoodData() { return food; }
		@Override public float getHealth() { return 20.0F; }
		@Override public boolean isAlive() { return true; }
		@Override public boolean isFallFlying() { return false; }
		@Override public boolean isInWater() { return false; }
	}

	private static final class StallLevel extends ServerLevel {
		private StallLevel() {
			super(null, Runnable::run, null, null, Level.OVERWORLD, null, false, 0L, List.of(), false);
		}

		@Override public ResourceKey<Level> dimension() { return Level.OVERWORLD; }
		@Override public int getMinY() { return -64; }
		@Override public int getHeight() { return 384; }
		@Override public BlockState getBlockState(BlockPos position) {
			return position.getY() < 64 ? Blocks.STONE.defaultBlockState() : Blocks.AIR.defaultBlockState();
		}
		@Override public FluidState getFluidState(BlockPos position) { return Fluids.EMPTY.defaultFluidState(); }

		@Override
		public <T extends Entity> List<T> getEntitiesOfClass(Class<T> type, AABB bounds, java.util.function.Predicate<? super T> predicate) {
			return List.of();
		}
	}
}
