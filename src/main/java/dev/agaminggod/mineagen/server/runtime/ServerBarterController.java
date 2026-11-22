package dev.agaminggod.mineagen.server.runtime;

import dev.agaminggod.mineagen.compat.McCompat;

import dev.agaminggod.mineagen.server.perception.ObservationVisibility;
import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import dev.agaminggod.mineagen.server.runtime.controller.ServerController;
import dev.agaminggod.mineagen.server.runtime.controller.ServerItemPickupController;
import dev.agaminggod.mineagen.server.runtime.controller.ServerLookController;
import dev.agaminggod.mineagen.server.runtime.controller.ServerNavigationController;
import java.util.Comparator;
import java.util.HashMap;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.TreeMap;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.EntityType;
import dev.agaminggod.mineagen.compat.McEntityTypes;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.entity.monster.piglin.AbstractPiglin;
import net.minecraft.world.entity.monster.piglin.Piglin;
import net.minecraft.world.entity.monster.piglin.PiglinAi;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.phys.Vec3;

/**
 * barter_until: the player's bartering loop, chosen by the model. It first puts on a gold armour piece it carries when
 * none is worn (a right-click, as a player equips armour). Then it walks to the nearest calm adult piglin it can see
 * within SEEK_RANGE that is not already examining an item, throws one gold ingot toward its feet (a vanilla Q drop the
 * piglin picks up), turns to the next free piglin, and walks over the items the piglins throw back (vanilla contact
 * pickup). When the ingots run out it crafts the gold it carries into more, as a player does between throws: gold
 * blocks in the inventory grid, nuggets at a crafting table within reach or one it carries and places. It counts the
 * asked item by the inventory change since the call started, and the ingots traded by the gold actually gone.
 */
public final class ServerBarterController implements ServerController {
	/** The body's hands for the gold it converts: a craft (inventory grid when table is null) and a block placement. */
	public interface Environment {
		ServerController craft(ServerPlayer body, String recipeId, int count, BlockPos table, long timeoutMs);
		/** Null when placed, else why not. */
		String place(ServerPlayer body, BlockPos at, Direction face, String itemId);
	}

	static final double PIGLIN_RANGE = 16.0D;
	/** How far the body walks to a calm piglin it sees: a group across a bastion bridge or a crimson clearing. */
	static final double SEEK_RANGE = 32.0D;
	static final double TABLE_REACH = 4.5D;
	/** A piglin with a seen hoglin, zoglin or brute this close is passed over: walking up to it walks into that mob. */
	static final double DANGER_NEAR_PIGLIN = 8.0D;
	/**
	 * Barter returns a player leaves on the ground: building rubble that fills the bags (20 barter-room runs picked up
	 * stacks of gravel and blackstone until the gold blocks could no longer be crafted into ingots).
	 */
	static final Set<String> JUNK = Set.of("minecraft:gravel", "minecraft:blackstone", "minecraft:soul_sand", "minecraft:nether_brick", "minecraft:netherrack");
	static final long CRAFT_TIMEOUT_MS = 20_000L;
	static final double THROW_RANGE = 2.6D;
	static final double DROP_RANGE = 8.0D;
	static final double HOSTILE_RANGE = 12.0D;
	static final float LOW_HEALTH = 8.0F;
	/** A thrown ingot the piglin has not taken in this time frees it for another throw. */
	static final long THROW_WAIT_MS = 4_000L;
	/** A piglin examines an ingot about 6 s before it throws its return. */
	static final long RETURN_WAIT_MS = 9_000L;

	private final Item wanted;
	private final String wantedId;
	private final int count;
	private final long timeoutMs;
	private final ElapsedTimeAccumulator elapsed;
	private final Environment environment;
	private ResourceKey<Level> dimension;
	private float lastHealth = Float.NaN;
	private int startWanted, startGold;
	private final Map<Item, Integer> startCounts = new HashMap<>();
	private final Set<UUID> ignoredDrops = new HashSet<>();
	private final Map<UUID, Long> busyUntil = new HashMap<>();
	private long lastThrowMs = Long.MIN_VALUE / 2;
	private Vec3 scanAim;
	private int scanSteps;
	private int thrown, crafted, armourTries, craftFailures, bartered;
	/** Adult piglins seen examining a gold ingot: each new one is one ingot really bartered (a baby keeps its ingot). */
	private final Set<UUID> admiring = new HashSet<>();
	/** Piglins the body could not walk to twice in this call (a ledge, a gap): passed over for the rest of it. */
	private final Map<UUID, Integer> walkFailures = new HashMap<>();
	private final Set<net.minecraft.world.entity.EquipmentSlot> refusedSlots = java.util.EnumSet.noneOf(net.minecraft.world.entity.EquipmentSlot.class);
	static final int WALK_FAILURES_TO_SKIP = 2;
	private ServerController craft;
	private int craftYield, ingotsBeforeCraft, pearlsLeft;
	private String wornNow;
	private ServerItemPickupController pickup;
	private UUID pickupId;
	private ServerNavigationController walk;
	private UUID walkTarget;
	private Vec3 walkGoal;
	private int pause, turnTicks;

	public ServerBarterController(String itemId, int count, long timeoutMs, long startedAt, Environment environment) {
		this.environment = environment;
		this.wantedId = itemId.contains(":") ? itemId : "minecraft:" + itemId;
		this.wanted = BuiltInRegistries.ITEM.getOptional(net.minecraft.resources.Identifier.parse(wantedId)).orElse(Items.AIR);
		this.count = Math.max(1, count);
		this.timeoutMs = timeoutMs;
		this.elapsed = new ElapsedTimeAccumulator(startedAt);
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		if (dimension == null) {
			if (wanted == Items.AIR) return TickResult.failed("INVALID_ITEM", "Unknown item " + wantedId, 0.0D);
			dimension = player.level().dimension();
			lastHealth = player.getHealth();
			startWanted = carried(player, wanted);
			startGold = carried(player, Items.GOLD_INGOT);
			for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
				ItemStack stack = player.getInventory().getItem(slot);
				if (!stack.isEmpty()) startCounts.merge(stack.getItem(), stack.getCount(), Integer::sum);
			}
			for (ItemEntity drop : player.level().getEntitiesOfClass(ItemEntity.class, player.getBoundingBox().inflate(PIGLIN_RANGE)))
				ignoredDrops.add(drop.getUUID());
		}
		if (!PiglinAi.isWearingSafeArmor(player)) {
			TickResult worn = wearGold(player);
			if (worn != null) return worn;
		}
		if (!player.level().dimension().equals(dimension)) return stop(player, "ACTION_DIMENSION_CHANGED", "The body changed dimension");
		if (elapsed.advance(nowEpochMs) >= timeoutMs) {
			release(player);
			return TickResult.timedOut("BARTER_TIMED_OUT", summary(player, "timeoutMs ran out"), progress(player));
		}
		TickResult danger = danger(player);
		if (danger != null) return danger;
		if (gained(player) >= count) return done(player, "BARTER_COUNT_REACHED", gained(player) + " " + wantedId + " gained (asked " + count + ")");
		noteBarters(player);
		// A running conversion finishes before anything else: it holds the body's input while it crafts, and a pickup
		// started meanwhile could not move and would leave the craft's input lease expired.
		if (craft != null) {
			TickResult r = craft.tick(player, nowEpochMs);
			if (r.state() == State.RUNNING) return TickResult.running(progress(player));
			craft = null;
			// A craft can succeed partly (CRAFT_PARTIAL: trimmed to inventory room or its pacing budget), so count what
			// it made: nothing else moves ingots while it runs.
			int made = Math.max(0, carried(player, Items.GOLD_INGOT) - ingotsBeforeCraft);
			crafted += made;
			if (r.state() != State.SUCCEEDED || made == 0) craftFailures++;
			craftYield = 0;
		}
		if (pickup != null) {
			TickResult r = pickup.tick(player, nowEpochMs);
			if (r.state() == State.RUNNING) return TickResult.running(progress(player));
			pickup.cancel(player);
			ignoredDrops.add(pickupId);
			pickup = null;
		}
		if (pause > 0) { pause--; return TickResult.running(progress(player)); }
		ItemEntity drop = nearestDrop(player);
		// No room for a pearl: drop barter rubble first; with none to drop, leave the pearl and report it.
		if (drop != null && drop.getItem().is(wanted) && !dev.agaminggod.mineagen.server.runtime.InventoryRoom.canTake(player, drop.getItem()) && !dropJunk(player)) {
			ignoredDrops.add(drop.getUUID());
			pearlsLeft += drop.getItem().getCount();
			drop = null;
		}
		if (drop != null) {
			stopWalk(player);
			pickupId = drop.getUUID();
			pickup = new ServerItemPickupController(player, drop, nowEpochMs, 10_000L);
			return TickResult.running(progress(player));
		}
		boolean waiting = nowEpochMs - lastThrowMs < RETURN_WAIT_MS || anyAdmiring(player);
		if (carried(player, Items.GOLD_INGOT) == 0) {
			stopWalk(player);
			if (craftFailures < 3 && startConversion(player, nowEpochMs)) return TickResult.running(progress(player));
			if (waiting) return TickResult.running(progress(player));
			return stop(player, "OUT_OF_GOLD", "No gold ingot left" + leftoverGold(player));
		}
		Piglin target = freePiglin(player, nowEpochMs);
		if (target == null) {
			stopWalk(player);
			// None free in view: turn on the spot in 60 degree steps, as a player looks around, to find piglins and returns.
			if (scanAim == null) {
				double yaw = Math.toRadians(player.getYRot() + 60.0F);
				scanAim = player.getEyePosition().add(-Math.sin(yaw) * 6.0D, -1.2D, Math.cos(yaw) * 6.0D);
			}
			if (ServerLookController.turnToward(player, scanAim)) {
				scanAim = null;
				// Count every look round without a piglin to throw to: one seen but out of reach or beside a hoglin does
				// not reset it, so the call ends NO_PIGLIN instead of turning until it times out.
				scanSteps++;
				pause = 6;
			}
			if (scanSteps >= 6 && !waiting) return stop(player, "NO_PIGLIN", "No calm adult piglin in sight within " + (int) SEEK_RANGE + " blocks after a full look around");
			return TickResult.running(progress(player));
		}
		scanSteps = 0;
		scanAim = null;
		double distance = player.distanceTo(target);
		if (distance > THROW_RANGE) {
			Vec3 goal = target.position();
			if (walk == null || !target.getUUID().equals(walkTarget) || walkGoal.distanceToSqr(goal) > 2.25D) {
				stopWalk(player);
				walk = new ServerNavigationController(goal, 1.8D, false, nowEpochMs, distance > PIGLIN_RANGE ? 30_000L : 15_000L, true);
				walkTarget = target.getUUID();
				walkGoal = goal;
			}
			TickResult moved = walk.tick(player, nowEpochMs);
			if (moved.state() == State.RUNNING) return TickResult.running(progress(player));
			stopWalk(player);
			if (moved.state() != State.SUCCEEDED) {
				busyUntil.put(target.getUUID(), nowEpochMs + THROW_WAIT_MS);
				walkFailures.merge(target.getUUID(), 1, Integer::sum);
			}
			return TickResult.running(progress(player));
		}
		stopWalk(player);
		int slot = ServerCastObsidianController.find(player, Items.GOLD_INGOT);
		if (player.getInventory().getSelectedSlot() != slot) {
			if (slot >= 9) {
				var swap = AdvancedInteractionService.swapIntoHotbar(player, slot, player.getInventory().getSelectedSlot());
				if (swap != null) return stop(player, swap.reasonCode(), swap.message());
			} else {
				player.getInventory().setSelectedSlot(slot);
			}
			pause = 1;
			return TickResult.running(progress(player));
		}
		// Thrown toward its feet: a Q drop flies about a block and a half ahead of a slightly lowered look.
		Vec3 feet = target.position().add(0.0D, 0.1D, 0.0D);
		if (!ServerLookController.turnToward(player, feet)) {
			if (++turnTicks > 30) { turnTicks = 0; busyUntil.put(target.getUUID(), nowEpochMs + THROW_WAIT_MS); }
			return TickResult.running(progress(player));
		}
		turnTicks = 0;
		int selected = player.getInventory().getSelectedSlot();
		ItemStack one = player.getInventory().removeItem(selected, 1);
		if (one.isEmpty() || McCompat.drop(player, one, true, true) == null) return stop(player, "ITEM_DROP_REJECTED", "The gold ingot could not be thrown");
		ArmSwing.use(player, InteractionHand.MAIN_HAND);
		thrown++;
		lastThrowMs = nowEpochMs;
		busyUntil.put(target.getUUID(), nowEpochMs + THROW_WAIT_MS);
		pause = 6;
		return TickResult.running(progress(player));
	}

	@Override
	public void cancel(ServerPlayer player) {
		release(player);
	}

	private void release(ServerPlayer player) {
		stopWalk(player);
		if (craft != null) craft.cancel(player);
		craft = null;
		if (pickup != null) pickup.cancel(player);
		pickup = null;
	}

	private void stopWalk(ServerPlayer player) {
		if (walk != null) walk.cancel(player);
		walk = null;
		walkTarget = null;
		walkGoal = null;
	}

	private TickResult danger(ServerPlayer player) {
		for (AbstractPiglin piglin : player.level().getEntitiesOfClass(AbstractPiglin.class, player.getBoundingBox().inflate(PIGLIN_RANGE))) {
			if (!perceivedAngry(ObservationVisibility.canSeeEntity(player, piglin), piglin.getTarget() == player)) continue;
			return stop(player, "PIGLIN_ANGRY", String.format(Locale.ROOT, "a seen %s %s goes for the body, %.1f blocks away",
					BuiltInRegistries.ENTITY_TYPE.getKey(piglin.getType()), piglin.getUUID(), player.distanceTo(piglin)));
		}
		float health = player.getHealth();
		if (health < lastHealth - 0.01F) {
			String source = player.getLastDamageSource() == null ? "unknown" : player.getLastDamageSource().getMsgId();
			return stop(player, "DAMAGE_TAKEN", String.format(Locale.ROOT, "Took %.1f damage (%s); health %.1f", lastHealth - health, source, health));
		}
		lastHealth = health;
		if (player.isInLava()) return stop(player, "IN_LAVA", "The body is in lava");
		if (player.isOnFire()) return stop(player, "ON_FIRE", "The body is burning");
		if (health <= LOW_HEALTH) return stop(player, "LOW_HEALTH", String.format(Locale.ROOT, "Health %.1f is at or below %.0f", health, LOW_HEALTH));
		if (player.tickCount % 5 == 0) {
			List<Mob> threats = player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(HOSTILE_RANGE),
					mob -> !(mob instanceof AbstractPiglin) && player.distanceTo(mob) <= HOSTILE_RANGE && ThreatPerception.isSensedThreat(player, mob));
			if (!threats.isEmpty()) {
				Mob nearest = threats.stream().min(Comparator.comparingDouble(player::distanceTo)).orElseThrow();
				return stop(player, "HOSTILE_NEAR", String.format(Locale.ROOT, "%s %s %.1f blocks away",
						BuiltInRegistries.ENTITY_TYPE.getKey(nearest.getType()), nearest.getUUID(), player.distanceTo(nearest)));
			}
		}
		return null;
	}

	/**
	 * No gold piece is worn: put on one the body carries, a right-click with it in hand as a player equips armour. Null
	 * while it is being done; a stop when there is none to wear.
	 */
	private TickResult wearGold(ServerPlayer player) {
		// The piece that costs least to put on: one for an empty armour slot first, else the one replacing the weakest worn
		// piece, so a diamond helmet stays while the boots slot is empty.
		int slot = -1, bestCost = Integer.MAX_VALUE;
		for (int i = 0; i < 36; i++) {
			ItemStack stack = player.getInventory().getItem(i);
			if (!isGoldArmour(stack) || refusedSlots.contains(goldSlot(stack))) continue;
			ItemStack worn = player.getItemBySlot(goldSlot(stack));
			int cost = armourTier(worn.isEmpty() ? null : BuiltInRegistries.ITEM.getKey(worn.getItem()).toString());
			if (cost < bestCost) { slot = i; bestCost = cost; }
		}
		if (slot < 0 || armourTries >= 6) {
			int ingots = carried(player, Items.GOLD_INGOT) + carried(player, Items.GOLD_BLOCK) * 9 + carried(player, Items.GOLD_NUGGET) / 9;
			return stop(player, "NO_GOLD_ARMOUR", "No gold armour piece is worn" + (slot < 0 ? " or carried" : " (putting it on failed)")
					+ "; piglins attack a player without one. A golden helmet is 5 gold ingots at a crafting table" + (ingots >= 5 ? " (enough gold held)" : ""));
		}
		if (player.getInventory().getSelectedSlot() != slot) {
			if (slot >= 9) {
				var swap = AdvancedInteractionService.swapIntoHotbar(player, slot, player.getInventory().getSelectedSlot());
				if (swap != null) return stop(player, swap.reasonCode(), swap.message());
			} else {
				player.getInventory().setSelectedSlot(slot);
			}
			pause = 1;
			return TickResult.running(progress(player));
		}
		armourTries++;
		ItemStack held = player.getMainHandItem();
		String id = BuiltInRegistries.ITEM.getKey(held.getItem()).toString();
		var target = goldSlot(held);
		player.gameMode.useItem(player, player.level(), held, InteractionHand.MAIN_HAND);
		ArmSwing.use(player, InteractionHand.MAIN_HAND);
		if (PiglinAi.isWearingSafeArmor(player)) wornNow = id;
		// The worn piece would not come off (Curse of Binding): try a gold piece for another slot next.
		else refusedSlots.add(target);
		pause = 4;
		return TickResult.running(progress(player));
	}

	private static net.minecraft.world.entity.EquipmentSlot goldSlot(ItemStack stack) {
		if (stack.is(Items.GOLDEN_HELMET)) return net.minecraft.world.entity.EquipmentSlot.HEAD;
		if (stack.is(Items.GOLDEN_CHESTPLATE)) return net.minecraft.world.entity.EquipmentSlot.CHEST;
		if (stack.is(Items.GOLDEN_LEGGINGS)) return net.minecraft.world.entity.EquipmentSlot.LEGS;
		return net.minecraft.world.entity.EquipmentSlot.FEET;
	}

	/** A worn piece's rough strength by material, 0 for an empty slot: what putting gold over it gives up. */
	static int armourTier(String wornItemId) {
		if (wornItemId == null) return 0;
		String id = wornItemId.replace("minecraft:", "");
		if (id.startsWith("leather_")) return 1;
		if (id.startsWith("golden_") || id.startsWith("copper_")) return 2;
		if (id.startsWith("chainmail_") || id.startsWith("turtle_")) return 3;
		if (id.startsWith("iron_")) return 4;
		if (id.startsWith("diamond_")) return 5;
		if (id.startsWith("netherite_")) return 6;
		return 3;
	}

	static boolean isGoldArmour(ItemStack stack) {
		return stack.is(Items.GOLDEN_HELMET) || stack.is(Items.GOLDEN_CHESTPLATE) || stack.is(Items.GOLDEN_LEGGINGS) || stack.is(Items.GOLDEN_BOOTS);
	}

	/**
	 * Out of ingots: start crafting the gold the body carries into more. Gold blocks craft in the inventory grid (9 each);
	 * nuggets need a crafting table, one in reach or a carried one placed beside the feet. False when there is nothing to
	 * convert or no table to convert it at.
	 */
	private boolean startConversion(ServerPlayer player, long now) {
		if (environment == null) return false;
		int blocks = carried(player, Items.GOLD_BLOCK), nuggets = carried(player, Items.GOLD_NUGGET);
		BlockPos table = blocks > 0 || nuggets < 9 ? null : tableInReach(player);
		boolean tableHeld = carried(player, Items.CRAFTING_TABLE) > 0;
		Conversion plan = conversion(blocks, nuggets, table != null, tableHeld);
		if (plan == null) return false;
		// Full bags: drop a stack of barter rubble first, as a player clears them. With none to drop the craft still
		// runs: a block or nine nuggets leave their slot for the grid, and the craft checks the room for its output.
		if (player.getInventory().getFreeSlot() < 0) dropJunk(player);
		if (plan.table() && table == null) table = placeTable(player);
		if (plan.table() && table == null) return false;
		craftYield = plan.ingots();
		ingotsBeforeCraft = carried(player, Items.GOLD_INGOT);
		craft = environment.craft(player, plan.recipeId(), plan.ingots(), plan.table() ? table : null, CRAFT_TIMEOUT_MS);
		return true;
	}

	private static BlockPos tableInReach(ServerPlayer player) {
		BlockPos feet = player.blockPosition();
		BlockPos best = null;
		double bestDistance = Double.MAX_VALUE;
		for (BlockPos at : BlockPos.betweenClosed(feet.offset(-4, -2, -4), feet.offset(4, 3, 4))) {
			if (!player.level().getBlockState(at).is(Blocks.CRAFTING_TABLE)) continue;
			// A table behind a wall cannot be used: the craft would fail on its sightline, so pass it over.
			if (TargetSightline.block(player.level(), net.minecraft.world.phys.shapes.CollisionContext.of(player), player.getEyePosition(), at,
					player.blockInteractionRange(), null) == null) continue;
			double d = player.getEyePosition().distanceTo(Vec3.atCenterOf(at));
			if (d <= TABLE_REACH && d < bestDistance) { best = at.immutable(); bestDistance = d; }
		}
		return best;
	}

	/** The carried crafting table set on the floor beside the feet, as a player puts one down to craft. */
	private BlockPos placeTable(ServerPlayer player) {
		BlockPos feet = player.blockPosition();
		for (Direction side : Direction.Plane.HORIZONTAL) {
			BlockPos at = feet.relative(side);
			if (!player.level().getBlockState(at).canBeReplaced() || player.level().getBlockState(at.below()).isAir()) continue;
			if (environment.place(player, at, Direction.UP, "minecraft:crafting_table") == null
					&& player.level().getBlockState(at).is(Blocks.CRAFTING_TABLE)) return at;
		}
		return null;
	}

	/**
	 * Q-drops barter rubble this call picked up, from its largest stack; never more of an item than the barter added,
	 * so blocks the body brought (netherrack for bridging) stay. False when there is none (the asked item never counts).
	 */
	private boolean dropJunk(ServerPlayer player) {
		int best = -1, bestDrop = 0;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.isEmpty() || stack.is(wanted) || !JUNK.contains(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString())) continue;
			int drop = droppableJunk(stack.getCount(), carried(player, stack.getItem()), startCounts.getOrDefault(stack.getItem(), 0));
			// Only a whole stack frees a slot; part of an old stack would leave the bags as full as before.
			if (drop == stack.getCount() && drop > bestDrop) { best = slot; bestDrop = drop; }
		}
		if (best < 0) return false;
		ItemStack stack = player.getInventory().removeItem(best, bestDrop);
		ItemEntity dropped = McCompat.drop(player, stack, true, true);
		if (dropped != null) ignoredDrops.add(dropped.getUUID());
		return dropped != null;
	}

	/** Counts each adult piglin that starts examining a gold ingot: one real barter. */
	private void noteBarters(ServerPlayer player) {
		for (Piglin piglin : player.level().getEntitiesOfClass(Piglin.class, player.getBoundingBox().inflate(SEEK_RANGE + 8.0D),
				p -> p.isAlive() && p.getType() == McEntityTypes.PIGLIN)) {
			if (startsBarter(piglin.isBaby(), piglin.getOffhandItem().is(Items.GOLD_INGOT), admiring.contains(piglin.getUUID()))) bartered++;
			if (!piglin.isBaby() && piglin.getOffhandItem().is(Items.GOLD_INGOT)) admiring.add(piglin.getUUID());
			else admiring.remove(piglin.getUUID());
		}
	}

	static boolean startsBarter(boolean baby, boolean goldInOffhand, boolean alreadyExamining) {
		return !baby && goldInOffhand && !alreadyExamining;
	}

	/** How much of one rubble stack may go: at most what the barter added of that item since the call started. */
	static int droppableJunk(int stackCount, int carriedNow, int carriedAtStart) {
		return Math.max(0, Math.min(stackCount, carriedNow - carriedAtStart));
	}

	/** What gold is still carried but could not be turned into ingots here, for the model's next choice. */
	private static String leftoverGold(ServerPlayer player) {
		int nuggets = carried(player, Items.GOLD_NUGGET), blocks = carried(player, Items.GOLD_BLOCK);
		if (blocks == 0 && nuggets < 9) return "";
		return String.format(Locale.ROOT, " (still carried: %d gold blocks, %d nuggets; nuggets need a crafting table)", blocks, nuggets);
	}

	/** A crafting step that turns carried gold into ingots: the recipe, the ingots it yields, and whether it needs a table. */
	record Conversion(String recipeId, int ingots, boolean table) {}

	/**
	 * What to craft when the ingots run out: gold blocks first (inventory grid, up to 7 blocks, 63 ingots), else 9 or more
	 * nuggets at a table in reach or a carried one; null when nothing can be converted here.
	 */
	static Conversion conversion(int blocks, int nuggets, boolean tableInReach, boolean tableCarried) {
		if (blocks > 0) return new Conversion("minecraft:gold_ingot_from_gold_block", Math.min(blocks, 7) * 9, false);
		if (nuggets >= 9 && (tableInReach || tableCarried)) return new Conversion("minecraft:gold_ingot_from_nuggets", Math.min(64, nuggets / 9), true);
		return null;
	}

	/** Ingots that went to piglins: what was held plus what was crafted, less what is held now. Throws overcount it. */
	static int tradedIngots(int startIngots, int crafted, int heldNow) {
		return Math.max(0, startIngots + crafted - heldNow);
	}

	/** Mobs that attack a gold-wearing player beside a piglin group: hoglins, zoglins and piglin brutes. */
	static boolean isPiglinSideDanger(String entityId) {
		return "minecraft:hoglin".equals(entityId) || "minecraft:zoglin".equals(entityId) || "minecraft:piglin_brute".equals(entityId);
	}

	static boolean nearDanger(Vec3 piglin, List<Vec3> dangers, double radius) {
		for (Vec3 danger : dangers) if (danger.distanceTo(piglin) <= radius) return true;
		return false;
	}

	private static boolean nearDanger(Vec3 piglin, List<Vec3> dangers) {
		return nearDanger(piglin, dangers, DANGER_NEAR_PIGLIN);
	}

	/**
	 * A piglin's anger as a player perceives it: a piglin the eye sees going for the body (its target is the body, so it
	 * charges or aims at it). Its brain's ANGRY_AT memory is never read, and a piglin out of sight (behind a wall) is not
	 * reported; one that hits the body ends the call as DAMAGE_TAKEN.
	 */
	static boolean perceivedAngry(boolean seen, boolean targetsBody) {
		return seen && targetsBody;
	}

	private List<Piglin> visiblePiglins(ServerPlayer player) {
		return player.level().getEntitiesOfClass(Piglin.class, player.getBoundingBox().inflate(SEEK_RANGE),
				p -> p.isAlive() && p.getType() == McEntityTypes.PIGLIN && !p.isBaby() && player.distanceTo(p) <= SEEK_RANGE
						&& ObservationVisibility.canSeeEntity(player, p));
	}

	private boolean anyAdmiring(ServerPlayer player) {
		return visiblePiglins(player).stream().anyMatch(p -> !p.getOffhandItem().isEmpty());
	}

	/** The nearest seen calm adult piglin with an empty offhand (not examining an item) that has no ingot pending. */
	private Piglin freePiglin(ServerPlayer player, long now) {
		List<Vec3> dangers = player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(SEEK_RANGE + DANGER_NEAR_PIGLIN),
						mob -> mob.isAlive() && isPiglinSideDanger(BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).toString())
								&& ObservationVisibility.canSeeEntity(player, mob))
				.stream().map(Mob::position).toList();
		// Usable: reachable so far and not beside a hoglin or brute. Only these count as near or get an ingot.
		List<Piglin> seen = visiblePiglins(player).stream()
				.filter(p -> walkFailures.getOrDefault(p.getUUID(), 0) < WALK_FAILURES_TO_SKIP && !nearDanger(p.position(), dangers)).toList();
		// Walk beyond 16 blocks only when no usable piglin is that near: a busy one close by is waited for, not left
		// for one 30 blocks off (chasing far piglins halved the throws in the held room).
		boolean anyNear = seen.stream().anyMatch(p -> player.distanceTo(p) <= PIGLIN_RANGE);
		return seen.stream()
				.filter(p -> (!anyNear || player.distanceTo(p) <= PIGLIN_RANGE) && p.getOffhandItem().isEmpty()
						&& busyUntil.getOrDefault(p.getUUID(), 0L) <= now)
				.min(Comparator.comparingDouble(player::distanceTo)).orElse(null);
	}

	/** A seen item on the ground within reach of a short walk that appeared after the call started: a barter return. */
	private ItemEntity nearestDrop(ServerPlayer player) {
		return player.level().getEntitiesOfClass(ItemEntity.class, player.getBoundingBox().inflate(DROP_RANGE),
						e -> e.isAlive() && !ignoredDrops.contains(e.getUUID()) && !e.getItem().is(Items.GOLD_INGOT)
								&& (e.getItem().is(wanted) || !JUNK.contains(BuiltInRegistries.ITEM.getKey(e.getItem().getItem()).toString()))
								&& e.onGround() && player.distanceTo(e) <= DROP_RANGE && ObservationVisibility.canSeeEntity(player, e)
								&& (e.getItem().is(wanted) || dev.agaminggod.mineagen.server.runtime.InventoryRoom.canTake(player, e.getItem())))
				// The asked item first (a pearl before gravel), then the nearest.
				.stream().min(Comparator.<ItemEntity>comparingInt(e -> e.getItem().is(wanted) ? 0 : 1).thenComparingDouble(player::distanceTo)).orElse(null);
	}

	private int gained(ServerPlayer player) {
		return Math.max(0, carried(player, wanted) - startWanted);
	}

	private double progress(ServerPlayer player) {
		return Math.min(0.99D, gained(player) / (double) count);
	}

	private TickResult stop(ServerPlayer player, String reason, String why) {
		release(player);
		return TickResult.failed(reason, summary(player, why), progress(player));
	}

	private TickResult done(ServerPlayer player, String reason, String why) {
		release(player);
		return TickResult.succeeded(reason, summary(player, why));
	}

	private String summary(ServerPlayer player, String why) {
		Map<String, Integer> gainedItems = new TreeMap<>();
		Map<Item, Integer> now = new HashMap<>();
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty()) now.merge(stack.getItem(), stack.getCount(), Integer::sum);
		}
		now.forEach((item, n) -> {
			int delta = n - startCounts.getOrDefault(item, 0);
			if (delta > 0) gainedItems.put(BuiltInRegistries.ITEM.getKey(item).toString(), delta);
		});
		int gold = carried(player, Items.GOLD_INGOT);
		// Ingots a piglin left on the ground come back by contact pickup and are thrown again, so throws overcount.
		int traded = tradedIngots(startGold, crafted, gold);
		return String.format(Locale.ROOT, "%s. %s gained: %d of %d (now held %d); gold ingots bartered %d (taken by adult piglins), gone %d (%d throws), crafted %d, held %d (started with %d)%s%s; all items gained: %s",
				why, wantedId, gained(player), count, carried(player, wanted), bartered, traded, thrown, crafted, gold, startGold,
				wornNow == null ? "" : "; put on " + wornNow, pearlsLeft == 0 ? "" : "; left " + pearlsLeft + " " + wantedId + " on the ground: no room and no barter rubble to drop",
				gainedItems.isEmpty() ? "none" : gainedItems.toString());
	}

	private static int carried(ServerPlayer player, Item item) {
		int n = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.is(item)) n += stack.getCount();
		}
		return n;
	}
}
