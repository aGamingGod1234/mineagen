package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.PathNode;
import dev.agaminggod.mineagen.client.navigation.PathOutcome;
import dev.agaminggod.mineagen.client.navigation.PathPlan;
import dev.agaminggod.mineagen.client.navigation.TraversalType;
import java.lang.reflect.Field;
import java.util.ArrayList;
import java.util.List;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.EntityEquipment;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.player.Inventory;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.food.FoodData;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/**
 * pick_up_item's walk limit through the controller's own tick (issue #2 K3), with a stub body, level and drop and no
 * physics. The walk is handed a planned route and hands back at its first check, so the stub level never plans; what is
 * under test is the pickup's budget: a route longer than the straight line raises the walk limit, the walk keeps going
 * past the straight line's limit, and the timeout names the route it was given time for.
 */
public final class PickupRouteLimitTickVerification {
	private static final long TIMEOUT_MS = 30_000L;
	private static final Vec3 HERE = new Vec3(0.5D, 64.0D, 0.5D);
	private static final Vec3 LEDGE_DROP = new Vec3(8.5D, 67.0D, 0.5D);
	private static int assertions;
	private static sun.misc.Unsafe unsafe;

	private PickupRouteLimitTickVerification() {
	}

	public static void main(String[] arguments) throws Exception {
		System.out.println("PASS: " + verify() + " pickup route limit tick assertions");
	}

	public static int verify() throws Exception {
		assertions = 0;
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		Field singleton = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
		singleton.setAccessible(true);
		unsafe = (sun.misc.Unsafe) singleton.get(null);
		// The drop's stack needs its item's components; bind a stack size only when nothing else has, and put it back after.
		var holder = Items.COBBLESTONE.builtInRegistryHolder();
		Field components = net.minecraft.core.Holder.Reference.class.getDeclaredField("components");
		components.setAccessible(true);
		Object original = components.get(holder);
		if (!holder.areComponentsBound()) holder.bindComponents(net.minecraft.core.component.DataComponentMap.builder()
				.set(net.minecraft.core.component.DataComponents.MAX_STACK_SIZE, 64).build());
		try {
			verifyLedgeRoute();
			verifyStraightRoute();
		} finally {
			components.set(holder, original);
		}
		return assertions;
	}

	/** A drop on a ledge 8 blocks off whose only way up is a stair 12 blocks along and back (PickupBudgetVerification's ledge). */
	private static void verifyLedgeRoute() throws Exception {
		List<GridPosition> ledge = new ArrayList<>();
		for (int z = 1; z <= 12; z++) ledge.add(new GridPosition(0, 64, z));
		for (int x = 1; x <= 8; x++) ledge.add(new GridPosition(x, 64 + Math.min(x, 3), 12));
		for (int z = 11; z >= 0; z--) ledge.add(new GridPosition(8, 67, z));
		double straight = HERE.distanceTo(LEDGE_DROP);
		double blocks = PickupBudget.routeBlocks(HERE.x, HERE.y, HERE.z, ledge);
		long straightLimit = PickupBudget.walkLimitMs(straight, TIMEOUT_MS);
		long routeLimit = PickupBudget.walkLimitMs(blocks, TIMEOUT_MS);
		check(routeLimit > straightLimit + 5_000L && routeLimit + 1_000L < TIMEOUT_MS, "the fixture's route limit sits well between the straight line's and the call's");

		Fixture fixture = fixture(LEDGE_DROP, ledge);
		ServerController.TickResult first = fixture.pickup.tick(fixture.player, 50L);
		check("UNSUPPORTED_NAVIGATION_MODE".equals(first.reasonCode()), "the walk got its tick and handed back at its first check: " + first);
		long limit = (Long) get(fixture.pickup, "walkLimitMs");
		System.out.printf("K3 tick metric: ledge drop %.1f blocks off, %.1f blocks of planned route: controller walk limit %.1f s (straight line %.1f s)%n",
				straight, blocks, limit / 1000.0D, straightLimit / 1000.0D);
		check(limit == routeLimit, "the controller's walk limit follows the planned route once it is known: " + limit + " ms, route " + routeLimit
				+ " ms, straight line " + straightLimit + " ms");

		ServerController.TickResult between = fixture.pickup.tick(fixture.player, (straightLimit + routeLimit) / 2L);
		check(!"ITEM_PICKUP_TIMED_OUT".equals(between.reasonCode()) && "UNSUPPORTED_NAVIGATION_MODE".equals(between.reasonCode()),
				"past the straight line's limit but within the route's the walk still runs: " + between);

		ServerController.TickResult late = fixture.pickup.tick(fixture.player, routeLimit + 50L);
		String expected = String.format(java.util.Locale.ROOT, "%.1f blocks away by its %.1f-block planned route within the %.1f s pickup walk limit",
				straight, blocks, routeLimit / 1000.0D);
		check("ITEM_PICKUP_TIMED_OUT".equals(late.reasonCode()) && late.message().contains(expected),
				"past the route's limit the pickup times out naming the route it had time for: " + late.message());
	}

	/** A route no longer than the straight line leaves the straight line's limit and its message as they were. */
	private static void verifyStraightRoute() throws Exception {
		Vec3 drop = new Vec3(8.5D, 64.0D, 0.5D);
		List<GridPosition> straight = new ArrayList<>();
		for (int x = 1; x <= 8; x++) straight.add(new GridPosition(x, 64, 0));
		long straightLimit = PickupBudget.walkLimitMs(8.0D, TIMEOUT_MS);
		Fixture fixture = fixture(drop, straight);
		fixture.pickup.tick(fixture.player, 50L);
		check((Long) get(fixture.pickup, "walkLimitMs") == straightLimit, "a straight route keeps the straight line's limit");
		ServerController.TickResult late = fixture.pickup.tick(fixture.player, straightLimit + 50L);
		check("ITEM_PICKUP_TIMED_OUT".equals(late.reasonCode())
				&& late.message().endsWith("dropped item 8.0 blocks away within the 8.8 s pickup walk limit"),
				"the straight line's timeout names only the distance: " + late.message());
	}

	private record Fixture(PickupPlayer player, ServerItemPickupController pickup) {
	}

	/** A pickup whose walk already has this route planned toward the drop. */
	private static Fixture fixture(Vec3 dropAt, List<GridPosition> route) throws Exception {
		PickupPlayer player = player();
		Drop drop = (Drop) unsafe.allocateInstance(Drop.class);
		drop.fixtureLevel = player.fixtureLevel;
		drop.stack = new ItemStack(Items.COBBLESTONE);
		put(drop, Entity.class, "uuid", UUID.randomUUID());
		put(drop, Entity.class, "position", dropAt);
		put(drop, Entity.class, "bb", new AABB(dropAt.x - 0.125D, dropAt.y, dropAt.z - 0.125D, dropAt.x + 0.125D, dropAt.y + 0.25D, dropAt.z + 0.125D));
		dev.agaminggod.mineagen.server.perception.ObservedDrops.remember(player, drop);
		ServerItemPickupController pickup = new ServerItemPickupController(player, drop, 0L, TIMEOUT_MS);

		ServerNavigationController walk = ServerItemPickupController.walk(dropAt, new AABB(dropAt, dropAt).inflate(1.0D), 0L, TIMEOUT_MS, 0, false,
				false, HERE.y);
		// A found plan starts at the body's own cell, as the planner's do; it adds nothing to the route's length.
		List<PathNode> nodes = new ArrayList<>();
		GridPosition previous = new GridPosition(0, 64, 0);
		nodes.add(new PathNode(previous, TraversalType.START));
		for (GridPosition cell : route) {
			nodes.add(new PathNode(cell, cell.y() > previous.y() ? TraversalType.JUMP_UP : TraversalType.WALK));
			previous = cell;
		}
		set(walk, "plan", new PathPlan(nodes, PathOutcome.FOUND, nodes.size()));
		set(pickup, "navigation", walk);
		set(pickup, "navigationTarget", dropAt);
		return new Fixture(player, pickup);
	}

	private static PickupPlayer player() throws Exception {
		PickupPlayer player = (PickupPlayer) unsafe.allocateInstance(PickupPlayer.class);
		player.setId(1017); // 26.3 assigns entity IDs in the constructor, which Unsafe allocation skips.
		player.fixtureLevel = (PickupLevel) unsafe.allocateInstance(PickupLevel.class);
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
		if (!condition) throw new AssertionError("PickupRouteLimitTickVerification: " + message);
		assertions++;
	}

	private static final class PickupPlayer extends dev.agaminggod.mineagen.compat.TestServerPlayerBase {
		PickupLevel fixtureLevel;
		Inventory inventory;
		FoodData food;

		private PickupPlayer() {
			super(null, null, null, null);
		}

		@Override public ServerLevel level() { return fixtureLevel; }
		@Override public Inventory getInventory() { return inventory; }
		@Override public FoodData getFoodData() { return food; }
		@Override public float getHealth() { return 20.0F; }
		@Override public boolean isAlive() { return true; }
		/** The walk's first check hands a gliding body back before any planning, so the stub level is never searched. */
		@Override public boolean isFallFlying() { return true; }
		@Override public boolean isInWater() { return false; }
	}

	/** A landed cobblestone drop, with its synched data (stack, gravity, invisibility) answered directly. */
	private static final class Drop extends ItemEntity {
		PickupLevel fixtureLevel;
		ItemStack stack;

		private Drop() {
			super(null, null);
		}

		@Override public Level level() { return fixtureLevel; }
		@Override public ItemStack getItem() { return stack; }
		@Override public boolean isAlive() { return true; }
		@Override public boolean onGround() { return true; }
		@Override public boolean isNoGravity() { return false; }
		@Override public boolean isInWater() { return false; }
		@Override public boolean isInLava() { return false; }
		@Override public boolean isInvisibleTo(Player observer) { return false; }
	}

	private static final class PickupLevel extends ServerLevel {
		private PickupLevel() {
			super(null, Runnable::run, null, null, Level.OVERWORLD, null, false, 0L, List.of(), false);
		}

		@Override public ResourceKey<Level> dimension() { return Level.OVERWORLD; }
		@Override public long getGameTime() { return 0L; }
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
