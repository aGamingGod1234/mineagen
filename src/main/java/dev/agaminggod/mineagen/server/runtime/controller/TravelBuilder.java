package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.compat.McBlocks;

import dev.agaminggod.mineagen.server.runtime.ArmSwing;
import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.Block;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * One construction move of travel_to where seen ground ends: what a player does when walking can go no further toward
 * a place. A gap or lava below the next cell is bridged (sneaking backwards to the edge and clicking a held block on
 * the side of the block underfoot), a ledge two or three blocks up is pillared (jump, place under the feet), and a wall
 * is tunnelled (mine the head cell, then the feet cell, with the best carried tool). Every block is placed or mined
 * through the crosshair the body actually has, from where it actually stands. The move only reads acquired terrain to
 * decide; it never opens a cell beside seen lava.
 */
final class TravelBuilder {
	enum Kind { STEP, CROSS, BRIDGE, FILL, PILLAR, TUNNEL, CLEAR_UP, EXTINGUISH }

	/** What to do in one direction, or why nothing can be done there ({@code kind} null). */
	record Plan(Kind kind, Direction direction, int count, String refusal, String refusalCode) {
		static Plan refuse(Direction direction, String code, String why) { return new Plan(null, direction, 0, why, code); }
		boolean possible() { return kind != null; }
	}

	/** Mining one block may take at most this many ticks with the best carried tool (netherrack by hand takes 30). */
	static final int MAX_MINE_TICKS = 100;
	/** Blocks a bridge or pillar never spends: valuable, interactive, falling or harmful ones. */
	private static final Set<Block> KEPT_BLOCKS = Set.of(Blocks.OBSIDIAN, Blocks.CRYING_OBSIDIAN, Blocks.ANCIENT_DEBRIS,
			Blocks.GOLD_BLOCK, Blocks.IRON_BLOCK, Blocks.DIAMOND_BLOCK, Blocks.EMERALD_BLOCK, Blocks.NETHERITE_BLOCK,
			Blocks.LAPIS_BLOCK, Blocks.REDSTONE_BLOCK, Blocks.COAL_BLOCK, Blocks.RAW_IRON_BLOCK, Blocks.RAW_GOLD_BLOCK,
			Blocks.RAW_COPPER_BLOCK, McBlocks.COPPER_BLOCK, Blocks.MAGMA_BLOCK, Blocks.TNT, Blocks.GLOWSTONE, Blocks.SHROOMLIGHT,
			Blocks.CRAFTING_TABLE, Blocks.FURNACE, Blocks.BEACON, Blocks.BUDDING_AMETHYST, Blocks.RESPAWN_ANCHOR,
			Blocks.SLIME_BLOCK, Blocks.HONEY_BLOCK, Blocks.ICE, Blocks.PACKED_ICE, Blocks.BLUE_ICE, Blocks.SOUL_SAND);
	/** Blocks a tunnel never mines. */
	private static final Set<Block> UNMINED = Set.of(Blocks.BEDROCK, Blocks.OBSIDIAN, Blocks.CRYING_OBSIDIAN, Blocks.BARRIER,
			Blocks.END_PORTAL_FRAME, Blocks.REINFORCED_DEEPSLATE, Blocks.RESPAWN_ANCHOR, Blocks.ANCIENT_DEBRIS, Blocks.NETHER_PORTAL);

	private TravelBuilder() {
	}

	/**
	 * The move toward {@code direction} from the feet cell, judged on acquired terrain. {@code climb} is how far the
	 * leg wants to rise (target height minus feet), so a tall wall is pillared only when the way on is up there.
	 */
	static Plan decide(WalkabilityView world, java.util.function.Function<GridPosition, BlockState> states, GridPosition feet,
			Direction direction, boolean haveBlocks, int climb) {
		GridPosition ahead = feet.offset(direction.getStepX(), 0, direction.getStepZ());
		WalkabilityView.Cell body = world.cellAt(ahead), head = world.cellAt(ahead.above()), floor = world.cellAt(ahead.below());
		if (body == WalkabilityView.Cell.UNLOADED || head == WalkabilityView.Cell.UNLOADED) {
			return Plan.refuse(direction, "unseen", "the " + (body == WalkabilityView.Cell.UNLOADED ? "feet" : "head") + " cell ahead at "
					+ cell(body == WalkabilityView.Cell.UNLOADED ? ahead : ahead.above()) + " is unseen");
		}
		BlockState bodyState = states.apply(ahead), headState = states.apply(ahead.above());
		if (fire(bodyState) && world.isBodyClear(ahead.above())) return new Plan(Kind.EXTINGUISH, direction, 1, null, null);
		if (lava(headState) || head == WalkabilityView.Cell.HAZARD && !fire(headState)) {
			return Plan.refuse(direction, "hazard", "lava or another hazard fills the head cell " + cell(ahead.above()));
		}
		if (lava(bodyState) || world.lavaFillsNext(ahead)) {
			// Lava level with the feet: climb one block, then bridge over it one level up (the bridge block replaces the lava).
			// Under a low ceiling the block over the head is mined first.
			if (world.isBodyClear(ahead.above()) && !world.isBodyClear(feet.above(2)) && world.cellAt(feet.above(2)) != WalkabilityView.Cell.UNLOADED
					&& !lava(states.apply(feet.above(3)))) return new Plan(Kind.CLEAR_UP, direction, 1, null, null);
			if (!world.isBodyClear(feet.above(2)) || !world.isBodyClear(ahead.above())) return Plan.refuse(direction, "hazard", "lava fills " + cell(ahead) + " with no headroom to bridge over it");
			if (!haveBlocks) return Plan.refuse(direction, "out-of-blocks", "lava at " + cell(ahead) + " needs blocks to bridge over and no plain block is on the hotbar");
			return new Plan(Kind.PILLAR, direction, 1, null, null);
		}
		if (body == WalkabilityView.Cell.HAZARD || head == WalkabilityView.Cell.HAZARD) {
			return Plan.refuse(direction, "hazard", "a hazard fills " + cell(ahead));
		}
		if (body == WalkabilityView.Cell.WATER || head == WalkabilityView.Cell.WATER) {
			return Plan.refuse(direction, "water", "water at " + cell(ahead));
		}
		if (world.isStandable(ahead)) {
			// Never walk the head or feet in beside lava: one jump or push puts the body in it (a course run walked down
			// to a lava fall's foot and stood with lava beside its head).
			if (world.lavaFlowsInto(ahead)) return Plan.refuse(direction, "lava-beside", "lava beside the feet or head at " + cell(ahead));
			return new Plan(Kind.STEP, direction, 0, null, null);
		}
		if (world.isStandable(ahead.above()) && world.isBodyClear(feet.above(2))) {
			if (world.exposureCost(ahead.above()) > 0) return Plan.refuse(direction, "lava-beside", "lava or fire beside the step up at " + cell(ahead.above()));
			return new Plan(Kind.STEP, direction, 1, null, null);
		}
		if (world.isBodyClear(ahead) && world.isBodyClear(ahead.above()) && world.isStandable(ahead.below())
				&& world.exposureCost(ahead.below()) == 0) return new Plan(Kind.STEP, direction, -1, null, null);
		boolean open = world.isBodyClear(ahead) && world.isBodyClear(ahead.above());
		if (open) {
			if (floor == WalkabilityView.Cell.BLOCKED) return Plan.refuse(direction, "no-bridge-face", "a partial block under " + cell(ahead) + " takes no bridge block");
			// Only an open floor cell takes a bridge block (air, lava, water or fire is replaced); magma or another solid
			// hazard is no gap, and walking onto it burns (a course run stood on magma and took hotFloor damage).
			BlockState floorState = states.apply(ahead.below());
			// Magma is crossed crouched, as a player does: vanilla magma never burns a sneaking body.
			if (floorState != null && floorState.is(Blocks.MAGMA_BLOCK) && !world.lavaFlowsInto(ahead)) return new Plan(Kind.CROSS, direction, 0, null, null);
			if (floor == WalkabilityView.Cell.HAZARD && !lava(floorState) && !fire(floorState)) {
				return Plan.refuse(direction, "hazard", "a hazard block (" + (floorState == null ? "unknown" : net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(floorState.getBlock())) + ") is the floor at " + cell(ahead.below()));
			}
			if (!haveBlocks) return Plan.refuse(direction, "out-of-blocks", "a gap at " + cell(ahead.below()) + " needs a block and no plain block is on the hotbar");
			// A one-deep hole is filled from behind it, placing on its floor; a deeper gap is sneak-bridged off the edge,
			// which a partial block underfoot (soul sand, a slab) forbids: the body then dips into the cell to fill.
			if (world.cellAt(ahead.below(2)) == WalkabilityView.Cell.SAFE_SUPPORT) return new Plan(Kind.FILL, direction, 1, null, null);
			BlockState underfoot = states.apply(feet.below());
			if (underfoot != null && underfoot.getCollisionShape(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO).isEmpty()) {
				return Plan.refuse(direction, "no-footing", "no block is under the feet at " + cell(feet.below()));
			}
			if (underfoot != null && !underfoot.isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO)) {
				// On soul sand or a slab a bridge block beside it would overlap the body: pillar one full block, bridge from that.
				if (world.isBodyClear(feet.above(2)) && world.isBodyClear(ahead.above())) return new Plan(Kind.PILLAR, direction, 1, null, null);
				return Plan.refuse(direction, "no-bridge-face", "standing on " + net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(underfoot.getBlock())
						+ ", a partial block, with no headroom to step up and bridge");
			}
			return new Plan(Kind.BRIDGE, direction, 1, null, null);
		}
		// A wall: a ledge up to three blocks high with the way on up there is climbed, anything else is tunnelled.
		int ledge = -1;
		for (int rise = 1; rise <= 3; rise++) {
			if (world.isStandable(ahead.above(rise))) { ledge = rise; break; }
		}
		boolean headroom = true;
		for (int rise = 2; ledge > 1 && rise <= ledge + 1; rise++) headroom &= world.isBodyClear(feet.above(rise));
		if (ledge > 1 && headroom && (climb >= ledge - 1 || ledge == 2)) {
			if (!haveBlocks) return Plan.refuse(direction, "out-of-blocks", "a " + ledge + "-block ledge at " + cell(ahead) + " needs blocks to pillar and no plain block is on the hotbar");
			return new Plan(Kind.PILLAR, direction, ledge - 1, null, null);
		}
		return new Plan(Kind.TUNNEL, direction, 1, null, null);
	}

	/**
	 * The headroom over a remembered shaft a retrace climbs back up: null when the body can pillar now; CLEAR_UP when the
	 * block over the head is seen, mineable and nothing seen above or beside it could pour or fall in once it is mined;
	 * otherwise the refusal. A retrace can stand under its own way up, as when a later tunnel passes under the step of
	 * the stair it came down: one mined block reopens the route.
	 */
	static Plan shaftHeadroom(WalkabilityView world, java.util.function.Function<GridPosition, BlockState> states, GridPosition feet) {
		GridPosition over = feet.above(2), next = feet.above(3);
		if (world.isBodyClear(over)) return null;
		BlockState overState = states.apply(over);
		if (world.cellAt(over) == WalkabilityView.Cell.UNLOADED || overState == null) return Plan.refuse(Direction.UP, "unseen", "the headroom at " + cell(over) + " is unseen");
		if (!overState.getFluidState().isEmpty() || world.cellAt(over) == WalkabilityView.Cell.HAZARD || world.cellAt(over) == WalkabilityView.Cell.WATER)
			return Plan.refuse(Direction.UP, "hazard", "fluid or a hazard fills the headroom at " + cell(over));
		String why = unmineable(overState);
		if (why != null) return Plan.refuse(Direction.UP, "unmineable", "the headroom at " + cell(over) + " cannot be mined: " + why);
		BlockState nextState = states.apply(next);
		if (nextState == null) return Plan.refuse(Direction.UP, "unseen", "the cell above the headroom at " + cell(next) + " is unseen, so mining up could let lava or water in");
		if (!nextState.getFluidState().isEmpty()) return Plan.refuse(Direction.UP, "hazard", "fluid at " + cell(next) + " would pour in once the headroom is mined");
		if (nextState.getBlock() instanceof FallingBlock) return Plan.refuse(Direction.UP, "falling", "the " + BuiltInRegistries.BLOCK.getKey(nextState.getBlock()).getPath()
				+ " at " + cell(next) + " would fall onto the head once the headroom is mined");
		for (Direction side : Direction.Plane.HORIZONTAL) {
			if (lava(states.apply(over.offset(side.getStepX(), 0, side.getStepZ()))))
				return Plan.refuse(Direction.UP, "hazard", "seen lava is beside the headroom at " + cell(over));
		}
		return new Plan(Kind.CLEAR_UP, Direction.NORTH, 1, null, null);
	}

	static boolean fire(BlockState state) {
		return state != null && (state.is(Blocks.FIRE) || state.is(Blocks.SOUL_FIRE));
	}

	static boolean lava(BlockState state) {
		return state != null && state.getFluidState().getType().isSame(net.minecraft.world.level.material.Fluids.LAVA);
	}

	private static String cell(GridPosition position) {
		return position.x() + "," + position.y() + "," + position.z();
	}

	/** The inventory slot holding a plain full block to build with, or -1. */
	static int blockSlot(ServerPlayer player) {
		int best = -1, bestCount = 0;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!buildingBlock(stack)) continue;
			if (slot == player.getInventory().getSelectedSlot()) return slot;
			if (stack.getCount() > bestCount) { best = slot; bestCount = stack.getCount(); }
		}
		return best;
	}

	/** Plain building blocks carried outside the hotbar (the model can swap them in with select_tool). */
	static int blocksOffHotbar(ServerPlayer player) {
		int count = 0;
		for (int slot = 9; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (buildingBlock(stack)) count += stack.getCount();
		}
		return count;
	}

	static int blocksOnHotbar(ServerPlayer player) {
		int count = 0;
		for (int slot = 0; slot < 9; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (buildingBlock(stack)) count += stack.getCount();
		}
		return count;
	}

	static boolean buildingBlock(ItemStack stack) {
		return !stack.isEmpty() && stack.getItem() instanceof BlockItem item && buildingBlock(item.getBlock());
	}

	static boolean buildingBlock(Block block) {
		if (block instanceof FallingBlock || block instanceof EntityBlock || KEPT_BLOCKS.contains(block)) return false;
		BlockState state = block.defaultBlockState();
		if (state.ignitedByLava()) return false;
		return state.getFluidState().isEmpty() && state.isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO)
				&& state.isRedstoneConductor(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
	}

	/** Whether a tunnel may mine this block: no bedrock or portal frames, nothing holding items, nothing too slow. */
	static String unmineable(BlockState state) {
		if (UNMINED.contains(state.getBlock())) return "it is " + net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock());
		// A player opens a door or gate rather than mining through it (and through someone's house).
		if (state.getBlock() instanceof net.minecraft.world.level.block.DoorBlock || state.getBlock() instanceof net.minecraft.world.level.block.FenceGateBlock
				|| state.getBlock() instanceof net.minecraft.world.level.block.TrapDoorBlock)
			return "it is a door or gate (" + net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock()) + "): open it rather than mine it";
		if (state.getBlock() instanceof EntityBlock) return "it holds a block entity (" + net.minecraft.core.registries.BuiltInRegistries.BLOCK.getKey(state.getBlock()) + ")";
		if (state.getDestroySpeed(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO) < 0) return "it is unbreakable";
		return null;
	}

	/** Mining ticks a tunnel accepts per block with the inventory's best tool (netherrack: 2 with an iron pickaxe, 40 by hand). */
	static final int TUNNEL_MINE_TICKS = 30;

	/** Brief hand clearing is useful even after picks wear out; wart blocks take 30 ticks without a hoe. */
	static int maximumTunnelMineTicks(BlockState state) {
		return state.requiresCorrectToolForDrops() ? TUNNEL_MINE_TICKS : 30;
	}

	/**
	 * Ticks to mine this state with that item, by vanilla's rule without enchantments or effects: speed over hardness, over
	 * 30 when the item may harvest it and 100 when not.
	 */
	static double mineTicks(ItemStack item, BlockState state, float hardness) {
		if (hardness <= 0.0F) return hardness == 0.0F ? 1.0D : Double.POSITIVE_INFINITY;
		boolean harvests = !state.requiresCorrectToolForDrops() || item.isCorrectToolForDrops(state);
		double perTick = item.getDestroySpeed(state) / hardness / (harvests ? 30.0D : 100.0D);
		return perTick <= 0.0D ? Double.POSITIVE_INFINITY : Math.ceil(1.0D / perTick);
	}

	static boolean usableForMining(ItemStack item) {
		return !item.isDamageableItem() || item.getMaxDamage() - item.getDamageValue() > 1;
	}

	/** Only a confirmed missing harvesting tool is typed; a slow but usable tool remains a route refusal. */
	static ToolRefusal toolRefusal(ServerPlayer player, BlockState state) {
		if (!state.requiresCorrectToolForDrops()) return null;
		String worn = null;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack item = player.getInventory().getItem(slot);
			if (item.isEmpty() || !item.isCorrectToolForDrops(state)) continue;
			if (usableForMining(item)) return null;
			worn = "slot=" + slot + " tool=" + BuiltInRegistries.ITEM.getKey(item.getItem())
					+ " damage=" + item.getDamageValue() + "/" + item.getMaxDamage()
					+ " remaining=" + (item.getMaxDamage() - item.getDamageValue());
		}
		return new ToolRefusal(worn == null ? "NO_TOOL" : "TOOL_WORN",
				worn == null ? "no harvesting tool in slots 0-35" : worn + "; no usable harvesting tool in slots 0-35");
	}

	static record ToolRefusal(String code, String facts) {}

	/** Mining ticks per block of this state with the best carried tool and with the best one anywhere in the inventory. */
	static double[] mineTicks(ServerPlayer player, BlockState state, float hardness) {
		double hotbar = Double.POSITIVE_INFINITY, anywhere = Double.POSITIVE_INFINITY;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack item = player.getInventory().getItem(slot);
			if (!usableForMining(item)) continue;
			double ticks = mineTicks(item, state, hardness);
			if (slot < 9) hotbar = Math.min(hotbar, ticks);
			anywhere = Math.min(anywhere, ticks);
		}
		return new double[] {hotbar, anywhere};
	}

	/** The carried slot that mines this state fastest, including harvest requirements; selected wins ties. */
	static int toolSlot(ServerPlayer player, BlockState state) {
		int best = player.getInventory().getSelectedSlot();
		float hardness = state.getDestroySpeed(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
		ItemStack selected = player.getInventory().getItem(best);
		double bestTicks = usableForMining(selected) ? mineTicks(selected, state, hardness) : Double.POSITIVE_INFINITY;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack item = player.getInventory().getItem(slot);
			if (!usableForMining(item)) continue;
			double ticks = mineTicks(item, state, hardness);
			if (ticks < bestTicks) { best = slot; bestTicks = ticks; }
		}
		return best;
	}

	/** Seen lava beside a cell a tunnel would open (the six faces; the one the body stands at is open air). */
	static boolean seenLavaBeside(MinecraftNavigationWorld world, BlockPos cell) {
		for (Direction side : Direction.values()) {
			BlockState state = world.stateAt(cell.relative(side));
			if (state != null && state.getFluidState().getType().isSame(net.minecraft.world.level.material.Fluids.LAVA)) return true;
		}
		return false;
	}

	/** The block hit by the body's crosshair now (vanilla block interaction range), or null. */
	static BlockHitResult crosshair(ServerPlayer player) {
		HitResult hit = player.pick(player.blockInteractionRange(), 1.0F, false);
		return hit instanceof BlockHitResult block && hit.getType() == HitResult.Type.BLOCK ? block : null;
	}

	/** One vanilla use click on the crosshair's block face with the selected item, as a right click sends it. */
	static boolean click(ServerPlayer player, BlockHitResult hit) {
		ServerLevel level = player.level();
		ItemStack stack = player.getMainHandItem();
		BlockPos placed = hit.getBlockPos().relative(hit.getDirection());
		BlockState before = level.getBlockState(placed);
		InteractionResult result = player.gameMode.useItemOn(player, level, stack, InteractionHand.MAIN_HAND, hit);
		if (result.consumesAction()) ArmSwing.use(player, InteractionHand.MAIN_HAND);
		return !level.getBlockState(placed).equals(before);
	}

	/** Yaw (degrees) that faces along a horizontal direction. */
	static float yaw(Direction direction) {
		return (float) Math.toDegrees(Math.atan2(-direction.getStepX(), direction.getStepZ()));
	}

	/** Yaw and pitch from the eye toward a point. */
	/** A point inside the target block at the nearest visible height, avoiding unnecessary head/feet pitch swings. */
	static Vec3 miningAim(Vec3 eye, BlockPos block) {
		return new Vec3(block.getX() + 0.5D,
				net.minecraft.util.Mth.clamp(eye.y, block.getY() + 0.02D, block.getY() + 0.98D), block.getZ() + 0.5D);
	}

	static float[] lookAt(Vec3 eye, Vec3 point) {
		Vec3 delta = point.subtract(eye);
		double flat = Math.sqrt(delta.x * delta.x + delta.z * delta.z);
		return new float[] {(float) Math.toDegrees(Math.atan2(-delta.x, delta.z)),
				(float) net.minecraft.util.Mth.clamp(-Math.toDegrees(Math.atan2(delta.y, flat)), -90.0D, 90.0D)};
	}
}
