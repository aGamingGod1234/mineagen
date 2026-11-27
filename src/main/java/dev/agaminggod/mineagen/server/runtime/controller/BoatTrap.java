package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.server.runtime.controller.ServerController.State;
import dev.agaminggod.mineagen.server.runtime.controller.ServerController.TickResult;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.UUID;
import java.util.function.BiPredicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.entity.vehicle.boat.AbstractBoat;
import net.minecraft.world.item.BoatItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * The boat trap players use for ender pearls: a boat put down between the body and one calm enderman, a stare to anger
 * it, and it walks straight at the body into the boat, where vanilla seats it (a mob narrower than a boat that touches
 * one is put in it). A seated enderman cannot walk or teleport out, so the body hits it from where it stands, out of its
 * melee reach, and the pearl falls by the boat. The same boat catches the next one: the body walks round to the boat's
 * far side from it. When flat clear floor is not in line (fungi, roots, steps in a warped forest), a carried block goes
 * down at the feet' level first and the boat on top of it.
 *
 * <p>Wood: a hunt that starts with no boat but 13 planks of one boat wood (logs count 4; 8 stay for tools) crafts one first, at a seen
 * table, a carried one put down beside the body (picked up again after), or one made from 4 more planks. Crimson and
 * warped planks make no boat (vanilla). With no boat and no wood the hunt is main's.
 *
 * <p>Switch fight.boatTrap (MINEAGEN_FIGHT_BOAT_TRAP=false or -Dmineagen.fight.boatTrap=false turns it off).
 */
final class BoatTrap {
	/** Calm endermen this far off (horizontal) are trapped; nearer ones are fought as before, farther ones walked toward. */
	/** Pearls for the eye plan (12 eyes and spares): a hunt that ends holding these is over, and the boat is taken back. */
	static final int PEARLS_DONE = 12;
	/** Planks' worth of boat wood (logs count 4) never spent on boats. */
	static final int WOOD_RESERVE = 8;
	static final double MIN_RANGE = 4.5D;
	static final double MAX_RANGE = 28.0D;
	/**
	 * A boat goes down only toward a calm enderman this near: one angered more than 16 blocks off teleports toward the body
	 * instead of walking the line (26 Nov forest rooms: 4 boats laid 20-23 blocks off, 0 seated). Farther ones are walked
	 * toward (navigation keeps its eyes off theirs) until {@link #APPROACH_TO} first.
	 */
	static final double TRAP_RANGE = 12.0D;
	static final double APPROACH_TO = 10.0D;
	/** A walk toward one far enderman that has not brought it into trap range in this long gives it up to the fight. */
	static final long APPROACH_MS = 20_000L;
	/** An enderman more than this above or below the feet is across a step or a drop: no straight walk into a boat. */
	static final double MAX_DY = 2.5D;
	/** Where the boat goes: this far from the body toward the enderman (S1's room: 3 blocks, seated in 0.9 s, 0 damage). */
	static final double BOAT_AT = 2.8D;
	static final double BOAT_MIN = 1.9D;
	static final double BOAT_MAX = 3.6D;
	/** The body stands this far behind the boat's centre (from the enderman): outside a seated enderman's reach (1.43). */
	static final double STAND_BEHIND = 2.6D;
	/** A placed boat this near the body is walked round to for the next enderman instead of a new one. */
	static final double REUSE_RANGE = 20.0D;
	/** How long the body holds behind the boat for an angered enderman to come into it before it fights it in the open. */
	static final long WAIT_MS = 9_000L;
	/** An angered enderman this near the body that is not seated came round the boat: fought as before. */
	static final double TOO_CLOSE = 1.8D;
	/** A seated enderman this near (horizontal) can reach the body: it steps back to the standoff. */
	static final double STANDOFF_MIN = 1.75D;
	static final double STANDOFF = 2.35D;
	static final int MAX_PLACE_FAILS = 3;
	static final long STEP_MS = 30_000L;
	private static final double HALF = 0.6875D;
	private static final double HEIGHT = 0.5625D;

	static boolean enabled() {
		return dev.agaminggod.mineagen.server.Switches.get("fight.boatTrap");
	}

	/** An enderman pearl hunt that may move, outside the End (endermen there come in dozens, by the void). */
	static boolean applies(boolean enabled, boolean enderman, boolean pearls, boolean mayMove, boolean end) {
		return enabled && enderman && pearls && mayMove && !end;
	}

	/** The body's hands: placement and clearing (fight_until's roofing) and the craft transaction. */
	private final ServerFightUntilController.Roofing hands;
	private final BiPredicate<ServerPlayer, BlockPos> mayModify;
	private AbstractBoat boat;
	private UUID armedFor;
	private long armedAtMs = -1L;
	private final Set<UUID> seatedIds = new HashSet<>();
	private final Set<UUID> skipped = new HashSet<>();
	private final List<String> notes = new ArrayList<>();
	private int placed;
	private int blocksUnder;
	private int crafted;
	private int placeFails;
	private int walksRound;
	private int roundedNoSeat;
	private int brokenBack;
	private int trapKills;
	private int approaches;
	private UUID approachFor;
	private long approachSinceMs;
	/** The walk-in goal and where its enderman stood when it was set: kept until the enderman moves, so the walk is not restarted each tick. */
	private Vec3 approachGoal;
	private Vec3 approachSeen;
	private ServerNavigationController step;
	/** The block going down under a boat (multi-tick: the body turns to it first), and since when (ticks). */
	private BlockPos blockAt;
	/** The block this trap laid last for the current enderman: the boat goes on it first. */
	private BlockPos laid;
	private UUID laidFor;
	private String blockItem;
	private int blockTicks;
	private UUID blockFor;
	private Vec3 stepGoal;
	private long stepTick;
	// Supply (craft a boat at the start).
	private enum Supply { TODO, PLANKS, TABLE_ITEM, TABLE_PLACE, CRAFT, CLEAR_TABLE, PICK_TABLE, DONE }
	private Supply supply = Supply.TODO;
	private ServerController child;
	private String species;
	private BlockPos table;
	private boolean tableOurs;
	private int supplyTicks;
	private int boatsWanted;

	BoatTrap(ServerFightUntilController.Roofing hands, BiPredicate<ServerPlayer, BlockPos> mayModify) {
		this.hands = hands;
		this.mayModify = mayModify;
	}

	// ---- supply ----------------------------------------------------------------------------------------------------

	static boolean isBoat(ItemStack stack) {
		return stack != null && !stack.isEmpty() && stack.getItem() instanceof BoatItem;
	}

	static int boats(ServerPlayer player) {
		int total = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++)
			if (isBoat(player.getInventory().getItem(slot))) total += player.getInventory().getItem(slot).getCount();
		return total;
	}

	/** The boat item a plank species makes, or null (crimson and warped make none). */
	static Item boatFor(String species) {
		String id = "bamboo".equals(species) ? "minecraft:bamboo_raft" : "minecraft:" + species + "_boat";
		return BuiltInRegistries.ITEM.getOptional(Identifier.parse(id)).filter(item -> item instanceof BoatItem).orElse(null);
	}

	private static Item item(String id) {
		return BuiltInRegistries.ITEM.getOptional(Identifier.parse(id)).orElse(Items.AIR);
	}

	static int count(ServerPlayer player, Item item) {
		return ServerFightUntilController.count(player, item);
	}

	/** Planks of the species plus 4 per log of it. */
	private static int wood(ServerPlayer player, String species) {
		Item log = item("minecraft:" + species + ("bamboo".equals(species) ? "_block" : "_log"));
		return count(player, item("minecraft:" + species + "_planks")) + (log == Items.AIR ? 0 : 4 * count(player, log));
	}

	/** The carried boat wood with the most wood, at least 5 planks' worth (logs count 4), or null. */
	static String boatWood(ServerPlayer player) {
		Set<String> kinds = new HashSet<>();
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.isEmpty()) continue;
			String path = BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
			if (path.endsWith("_planks")) kinds.add(path.substring(0, path.length() - "_planks".length()));
			else if (path.endsWith("_log") && !path.startsWith("stripped_")) kinds.add(path.substring(0, path.length() - "_log".length()));
		}
		String best = null;
		int most = 4;
		for (String kind : kinds) {
			if (boatFor(kind) == null) continue;
			int wood = wood(player, kind);
			if (wood > most) { most = wood; best = kind; }
		}
		return best;
	}

	/** Danger near: a mob hunting the body within 12 blocks (no crafting with one coming). */
	private static boolean threatened(ServerPlayer player) {
		return !player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(12.0D), mob -> mob.isAlive() && mob.getTarget() == player).isEmpty();
	}

	/**
	 * At the hunt's start: craft a boat when none is carried and the wood is. Running while it works; null once done or
	 * not wanted (then never again this call).
	 */
	TickResult tickSupply(ServerPlayer player, long now) {
		if (supply == Supply.DONE && child == null) return null;
		if (supply == Supply.TODO) {
			if (boats(player) > 0 || hands == null || threatened(player)) { supply = Supply.DONE; return null; }
			species = boatWood(player);
			if (species == null) { supply = Supply.DONE; note("no boat and no 5 planks of one boat wood: hunting without a trap"); return null; }
			int wood = wood(player, species);
			// Boats left standing are not taken along: keep two logs' worth for tools and a table later.
			if (wood < 5 + WOOD_RESERVE) { supply = Supply.DONE; note("only " + wood + " planks of wood, kept for tools: hunting without a trap"); return null; }
			boatsWanted = wood >= 10 + WOOD_RESERVE ? 2 : 1;
			supply = Supply.PLANKS;
		}
		if (++supplyTicks > 20 * 45) return endSupply(player, "boat craft took over 45 s");
		if (threatened(player)) return endSupply(player, "a mob came at the body while crafting");
		if (child != null) {
			TickResult result;
			try { result = child.tick(player, now); }
			catch (dev.agaminggod.mineagen.agent.AgentDomainException refused) { result = TickResult.failed(refused.code(), refused.getMessage(), 0.0D); }
			if (result.state() == State.RUNNING) return TickResult.running(0.0D);
			child.cancel(player);
			child = null;
			if (result.state() != State.SUCCEEDED) {
				if (supply == Supply.CLEAR_TABLE || supply == Supply.PICK_TABLE || supply == Supply.DONE) {
					supply = Supply.DONE;
					if (count(player, Items.CRAFTING_TABLE) == 0) note("table left near " + table.toShortString() + ": " + result.reasonCode());
					return null;
				}
				return endSupply(player, supply.name().toLowerCase(Locale.ROOT) + " failed: " + result.reasonCode() + " " + trim(result.message()));
			}
			advance(player);
			return TickResult.running(0.0D);
		}
		switch (supply) {
			case PLANKS -> {
				Item planks = item("minecraft:" + species + "_planks");
				int needed = 5 * boatsWanted + (tableNear(player) == null && count(player, Items.CRAFTING_TABLE) == 0 ? 4 : 0);
				int have = count(player, planks);
				if (have >= needed) { supply = Supply.TABLE_ITEM; return TickResult.running(0.0D); }
				int crafts = (needed - have + 3) / 4;
				child = start(() -> hands.craft(player, "minecraft:" + species + "_planks", crafts, null, 10_000L));
				if (child == null) return endSupply(player, "no crafting hands here");
				return TickResult.running(0.0D);
			}
			case TABLE_ITEM -> {
				table = tableNear(player);
				if (table != null) { tableOurs = false; supply = Supply.CRAFT; return TickResult.running(0.0D); }
				if (count(player, Items.CRAFTING_TABLE) > 0) { supply = Supply.TABLE_PLACE; return TickResult.running(0.0D); }
				child = start(() -> hands.craft(player, "minecraft:crafting_table", 1, null, 10_000L));
				if (child == null) return endSupply(player, "no crafting hands here");
				return TickResult.running(0.0D);
			}
			case TABLE_PLACE -> {
				if (table == null) table = tableSpot(player);
				if (table == null) return endSupply(player, "no free floor cell beside the body for a crafting table");
				Vec3 aim;
				try { aim = hands.aim(player, table, Direction.UP, "minecraft:crafting_table"); }
				catch (dev.agaminggod.mineagen.agent.AgentDomainException refused) { aim = Vec3.atCenterOf(table.below()).add(0.0D, 0.5D, 0.0D); }
				if (!ServerLookController.turnToward(player, aim)) return TickResult.running(0.0D);
				String why;
				try { why = hands.place(player, table, Direction.UP, "minecraft:crafting_table"); }
				catch (dev.agaminggod.mineagen.agent.AgentDomainException refused) { why = refused.code() + ": " + refused.getMessage(); }
				if (why != null) {
					if (supplyTicks > 20 * 8) return endSupply(player, "the crafting table would not go down at " + table.toShortString() + ": " + trim(why));
					return TickResult.running(0.0D);
				}
				tableOurs = true;
				supply = Supply.CRAFT;
				return TickResult.running(0.0D);
			}
			case CRAFT -> {
				Item boatItem = boatFor(species);
				String recipe = BuiltInRegistries.ITEM.getKey(boatItem).toString();
				child = start(() -> hands.craft(player, recipe, boatsWanted, table, 15_000L));
				if (child == null) return endSupply(player, "no crafting hands here");
				return TickResult.running(0.0D);
			}
			case CLEAR_TABLE -> {
				child = start(() -> hands.clear(player, table, 10_000L));
				if (child == null) { supply = Supply.DONE; return null; }
				return TickResult.running(0.0D);
			}
			case PICK_TABLE -> {
				if (count(player, Items.CRAFTING_TABLE) > 0 || supplyTicks > 20 * 40) { supply = Supply.DONE; return null; }
				// The broken table's drop: walked onto, as a player picks it up.
				var drop = player.level().getEntitiesOfClass(net.minecraft.world.entity.item.ItemEntity.class, new AABB(table).inflate(3.0D),
						item -> item.isAlive() && item.getItem().is(Items.CRAFTING_TABLE)).stream().findFirst().orElse(null);
				if (drop == null) { supply = Supply.DONE; return null; }
				child = new ServerNavigationController(drop.position(), 0.8D, false, now, 4_000L, false);
				supply = Supply.DONE;
				return TickResult.running(0.0D);
			}
			default -> { return null; }
		}
	}

	private void advance(ServerPlayer player) {
		switch (supply) {
			case PLANKS -> supply = Supply.TABLE_ITEM;
			case TABLE_ITEM -> supply = Supply.TABLE_PLACE;
			case CRAFT -> {
				crafted = boats(player);
				note("crafted " + crafted + " " + species + " boat" + (crafted == 1 ? "" : "s") + " for the trap");
				supply = tableOurs ? Supply.CLEAR_TABLE : Supply.DONE;
			}
			case CLEAR_TABLE -> supply = Supply.PICK_TABLE;
			default -> supply = Supply.DONE;
		}
	}

	private static ServerController start(java.util.function.Supplier<ServerController> make) {
		try { return make.get(); }
		catch (dev.agaminggod.mineagen.agent.AgentDomainException refused) {
			TickResult failed = TickResult.failed(refused.code(), refused.getMessage(), 0.0D);
			return (player, now) -> failed;
		}
	}

	private TickResult endSupply(ServerPlayer player, String why) {
		if (child != null) { child.cancel(player); child = null; }
		note("no boat crafted: " + why);
		supply = tableOurs && table != null && player.level().getBlockState(table).is(net.minecraft.world.level.block.Blocks.CRAFTING_TABLE) ? Supply.CLEAR_TABLE : Supply.DONE;
		return supply == Supply.DONE ? null : TickResult.running(0.0D);
	}

	/** A crafting table within reach of the eyes. */
	private static BlockPos tableNear(ServerPlayer player) {
		BlockPos eye = BlockPos.containing(player.getEyePosition());
		BlockPos best = null;
		double nearest = Double.POSITIVE_INFINITY;
		for (BlockPos at : BlockPos.betweenClosed(eye.offset(-4, -4, -4), eye.offset(4, 3, 4))) {
			if (!player.level().getBlockState(at).is(net.minecraft.world.level.block.Blocks.CRAFTING_TABLE) || !player.isWithinBlockInteractionRange(at, 0.0D)) continue;
			double distance = at.distToCenterSqr(player.getEyePosition());
			if (distance < nearest) { nearest = distance; best = at.immutable(); }
		}
		return best;
	}

	/** A free cell beside the feet on sturdy floor, open above, with no body in it. */
	private BlockPos tableSpot(ServerPlayer player) {
		Level level = player.level();
		BlockPos feet = player.blockPosition();
		BlockPos best = null;
		int score = Integer.MAX_VALUE;
		for (int dx = -2; dx <= 2; dx++) for (int dz = -2; dz <= 2; dz++) for (int dy = -1; dy <= 0; dy++) {
			if (dx == 0 && dz == 0) continue;
			BlockPos at = feet.offset(dx, dy, dz);
			BlockState state = level.getBlockState(at);
			if (!state.canBeReplaced() || !state.getFluidState().isEmpty() || !level.getBlockState(at.below()).isFaceSturdy(level, at.below(), Direction.UP)) continue;
			if (!level.getEntitiesOfClass(LivingEntity.class, new AABB(at)).isEmpty() || !mayModify.test(player, at)) continue;
			if (!player.isWithinBlockInteractionRange(at, 0.0D)) continue;
			int s = (dx * dx + dz * dz) * 4 - dy;
			if (s < score) { score = s; best = at.immutable(); }
		}
		return best;
	}

	// ---- the trap ----------------------------------------------------------------------------------------------------

	/** The enderman sits in a boat (any boat: it cannot get out). */
	static boolean seated(LivingEntity target) {
		return target != null && target.getVehicle() instanceof AbstractBoat;
	}

	private boolean boatUsable() {
		return boat != null && boat.isAlive() && !boat.isRemoved();
	}

	private static Vec3 flat(Vec3 v) {
		return new Vec3(v.x, 0.0D, v.z);
	}

	/**
	 * One tick for the target the fight chose. Null hands the tick to the fight as before (stare, the open fight, a
	 * seated enderman's swing from reach); a result means the trap moved, placed or held the body this tick.
	 */
	TickResult tick(ServerPlayer player, LivingEntity target, boolean provoked, boolean attacking, long elapsed, long now) {
		// A boat put down earlier (this call or one before) still stands near: it is the trap.
		if (!boatUsable()) boat = nearestBoat(player);
		if (blockAt != null && !target.getUUID().equals(blockFor)) blockAt = null;
		if (seated(target)) {
			cancelStep(player);
			if (seatedIds.add(target.getUUID())) note(String.format(Locale.ROOT, "%s sat in the boat %.1f blocks away", target.getUUID(), player.distanceTo(target)));
			// Out of its reach, in the body's: the swing from where it stands (pursue:false).
			double h = flat(target.position().subtract(player.position())).length();
			boolean inReach = player.getAttackRangeWith(player.getMainHandItem()).isInRange(player, target.getBoundingBox(), 0.0D);
			if (h >= STANDOFF_MIN && inReach) return null;
			Vec3 away = flat(player.position().subtract(target.position()));
			if (away.lengthSqr() < 1.0E-4D) away = new Vec3(1.0D, 0.0D, 0.0D);
			Vec3 goal = new Vec3(target.getX(), player.getY(), target.getZ()).add(away.normalize().scale(STANDOFF));
			return walk(player, goal, now) ? null : TickResult.running(0.0D);
		}
		if (skipped.contains(target.getUUID())) return null;
		if (provoked) {
			// Angry and coming: hold behind the boat, eyes on its legs (a stare inside 4 blocks makes it teleport).
			if (!target.getUUID().equals(armedFor) || !boatUsable() || !attacking) return null;
			if (elapsed - armedAtMs > WAIT_MS || player.distanceTo(target) < TOO_CLOSE) {
				roundedNoSeat++;
				note(String.format(Locale.ROOT, "%s did not sit in the boat in %.0f s (%.1f blocks away): fought in the open", target.getUUID(),
						(elapsed - armedAtMs) / 1000.0D, player.distanceTo(target)));
				skipped.add(target.getUUID());
				armedFor = null;
				return null;
			}
			cancelStep(player);
			ServerLookController.turnToward(player, new Vec3(target.getX(), target.getY() + 0.6D, target.getZ()));
			return TickResult.running(0.0D);
		}
		double h = flat(target.position().subtract(player.position())).length();
		if (h < MIN_RANGE || h > MAX_RANGE || Math.abs(target.getY() - player.getY()) > MAX_DY) return null;
		if (h > TRAP_RANGE) {
			// Too far to trap: walk in to APPROACH_TO before any stare, or the fight as before with no boat to lay.
			if (boats(player) == 0 && !boatUsable()) return null;
			if (!target.getUUID().equals(approachFor)) { approachFor = target.getUUID(); approachSinceMs = elapsed; approaches++; approachGoal = null; }
			if (elapsed - approachSinceMs > APPROACH_MS) {
				note(String.format(Locale.ROOT, "%s stayed %.1f blocks off after %.0f s of walking in: fought as before", target.getUUID(), h, APPROACH_MS / 1000.0D));
				skipped.add(target.getUUID());
				cancelStep(player);
				return null;
			}
			if (approachGoal == null || approachSeen.distanceTo(target.position()) > 1.5D) {
				Vec3 toward = flat(player.position().subtract(target.position()));
				approachGoal = new Vec3(target.getX(), player.getY(), target.getZ()).add(toward.normalize().scale(APPROACH_TO));
				approachSeen = target.position();
			}
			// Arrived (or no route) while still out of range: aim again from here next tick.
			if (walk(player, approachGoal, now)) approachGoal = null;
			return TickResult.running(0.0D);
		}
		// The boat already stands between: let the fight stare it angry from here.
		if (boatUsable() && between(player, target)) {
			if (!target.getUUID().equals(armedFor)) { armedFor = target.getUUID(); }
			armedAtMs = elapsed;
			cancelStep(player);
			return null;
		}
		// The boat in use is near: walk round to its far side from this enderman.
		if (boatUsable() && boat.getPassengers().isEmpty() && boat.distanceTo(player) <= REUSE_RANGE) {
			Vec3 stand = standBehind(player, boat.position(), target);
			if (stand != null) {
				if (stepGoal == null || !stand.equals(stepGoal)) walksRound++;
				if (!walk(player, stand, now)) return TickResult.running(0.0D);
				if (between(player, target)) { armedFor = target.getUUID(); armedAtMs = elapsed; return null; }
			}
		}
		if (boats(player) == 0) return null;
		// A new boat toward it (a block under it first, turned to over a few ticks, when no flat floor is in line).
		if (blockAt != null) {
			TickResult laying = layBlock(player);
			if (laying != null) return laying;
		}
		String where = place(player, target);
		if (PENDING.equals(where)) return TickResult.running(0.0D);
		if (where != null) {
			armedFor = target.getUUID();
			armedAtMs = elapsed;
			note("boat down at " + where + " toward " + target.getUUID() + String.format(Locale.ROOT, " (%.1f blocks away)", h));
			return TickResult.running(0.0D);
		}
		if (++placeFails >= MAX_PLACE_FAILS) note("no floor for a boat toward " + target.getUUID() + " (" + placeFails + " tries): fought as before");
		skipped.add(target.getUUID());
		return null;
	}

	private static AbstractBoat nearestBoat(ServerPlayer player) {
		return player.level().getEntitiesOfClass(AbstractBoat.class, player.getBoundingBox().inflate(REUSE_RANGE),
				b -> b.isAlive() && b.getPassengers().isEmpty() && b.distanceTo(player) <= REUSE_RANGE)
				.stream().min(Comparator.comparingDouble(b -> b.distanceToSqr(player))).orElse(null);
	}

	/** The boat lies on the line from the body to the enderman, near the body (it walks straight at the body). */
	private boolean between(ServerPlayer player, LivingEntity target) {
		Vec3 toTarget = flat(target.position().subtract(player.position()));
		Vec3 toBoat = flat(boat.position().subtract(player.position()));
		double along = toBoat.dot(toTarget.normalize());
		if (along < BOAT_MIN - 0.4D || along > BOAT_MAX + 0.6D || along > toTarget.length() - 1.0D) return false;
		double off = Math.sqrt(Math.max(0.0D, toBoat.lengthSqr() - along * along));
		return off <= 0.8D && Math.abs(boat.getY() - player.getY()) <= 1.2D;
	}

	/** The standing point behind the boat from the enderman: sturdy floor, two open cells, no lava under. */
	private Vec3 standBehind(ServerPlayer player, Vec3 boatAt, LivingEntity target) {
		Vec3 away = flat(boatAt.subtract(target.position()));
		if (away.lengthSqr() < 1.0E-4D) return null;
		Vec3 ideal = boatAt.add(away.normalize().scale(STAND_BEHIND));
		Level level = player.level();
		for (int dy : new int[] {0, 1, -1}) {
			BlockPos feet = BlockPos.containing(ideal.x, Math.floor(boatAt.y) + dy, ideal.z);
			if (!standable(level, feet)) continue;
			return new Vec3(feet.getX() + 0.5D, feet.getY(), feet.getZ() + 0.5D);
		}
		return null;
	}

	private static boolean standable(Level level, BlockPos feet) {
		BlockState under = level.getBlockState(feet.below());
		return under.isFaceSturdy(level, feet.below(), Direction.UP) && under.getFluidState().isEmpty()
				&& level.getBlockState(feet).getCollisionShape(level, feet).isEmpty() && level.getBlockState(feet).getFluidState().isEmpty()
				&& level.getBlockState(feet.above()).getCollisionShape(level, feet.above()).isEmpty() && level.getBlockState(feet.above()).getFluidState().isEmpty();
	}

	/** A short walk; true once there. */
	private boolean walk(ServerPlayer player, Vec3 goal, long now) {
		if (flat(player.position().subtract(goal)).length() <= 0.4D && player.onGround()) { cancelStep(player); return true; }
		if (step == null || !goal.equals(stepGoal) || player.level().getGameTime() - stepTick > 20L) {
			if (step != null) step.cancel(player);
			step = new ServerNavigationController(goal, 0.3D, false, now, 6_000L, false);
			stepGoal = goal;
		}
		stepTick = player.level().getGameTime();
		TickResult result = step.tick(player, now);
		if (result.state() == State.RUNNING) return false;
		step.cancel(player);
		step = null;
		// A failed walk (no route round) leaves the body where it is: the trap is tried from here.
		return true;
	}

	private void cancelStep(ServerPlayer player) {
		if (step != null) { step.cancel(player); step = null; }
		stepGoal = null;
	}

	/** Why a boat with its base centred here would be refused (vanilla checks blocks and bodies in its box), or null. */
	static String problem(ServerPlayer player, Vec3 at) {
		ServerLevel level = player.level();
		AABB box = new AABB(at.x - HALF, at.y, at.z - HALF, at.x + HALF, at.y + HEIGHT, at.z + HALF);
		if (!level.noCollision(box.deflate(1.0E-3D))) return "a block in its footprint";
		if (!level.getEntities((Entity) null, box, entity -> entity.isAlive() && !entity.isSpectator() && entity.isPushable()).isEmpty()) return "a body in its footprint";
		return null;
	}

	/** Floor faces in reach in line with the enderman where a boat fits and the eyes see the top. */
	private List<Vec3> faces(ServerPlayer player, Vec3 dir) {
		ServerLevel level = player.level();
		Vec3 eye = player.getEyePosition();
		BlockPos feet = player.blockPosition();
		List<Vec3> faces = new ArrayList<>();
		for (int dx = -4; dx <= 4; dx++) for (int dz = -4; dz <= 4; dz++) for (int dy = -2; dy <= 0; dy++) {
			BlockPos pos = feet.offset(dx, dy, dz);
			if (!level.hasChunkAt(pos) || !player.isWithinBlockInteractionRange(pos, 0.0D)) continue;
			Vec3 top = new Vec3(pos.getX() + 0.5D, pos.getY() + 1.0D, pos.getZ() + 0.5D);
			Vec3 off = flat(top.subtract(player.position()));
			double along = off.dot(dir);
			if (along < BOAT_MIN || along > BOAT_MAX || Math.sqrt(Math.max(0.0D, off.lengthSqr() - along * along)) > 0.75D) continue;
			if (Math.abs(top.y - player.getY()) > 1.05D) continue;
			BlockState state = level.getBlockState(pos);
			if (!state.isFaceSturdy(level, pos, Direction.UP) || level.getBlockEntity(pos) != null || state.getMenuProvider(level, pos) != null) continue;
			if (!state.getFluidState().isEmpty() || state.is(net.minecraft.world.level.block.Blocks.MAGMA_BLOCK)) continue;
			if (problem(player, top) != null) continue;
			BlockHitResult hit = level.clip(new ClipContext(eye, top.add(top.subtract(eye).normalize().scale(0.01D)), ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
			if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(pos) || hit.getDirection() != Direction.UP) continue;
			faces.add(top);
		}
		Vec3 laidTop = null;
		if (laid != null) {
			Vec3 top = new Vec3(laid.getX() + 0.5D, laid.getY() + 1.0D, laid.getZ() + 0.5D);
			faces.removeIf(face -> face.distanceToSqr(top) < 1.0E-6D);
			if (level.getBlockState(laid).isFaceSturdy(level, laid, Direction.UP) && problem(player, top) == null
					&& player.isWithinBlockInteractionRange(laid, 0.0D)) laidTop = top;
		}
		Vec3 ideal = player.position().add(dir.scale(BOAT_AT));
		// A boat a block up first: one on the floor is lower than an enderman's 1-block step, so it can walk over it.
		faces.sort(Comparator.comparingDouble(top -> flat(top.subtract(ideal)).lengthSqr() + (top.y - player.getY() > 0.5D ? 0.0D : 1.5D)));
		// The block laid for this enderman first, wherever it ended up.
		if (laidTop != null) faces.add(0, laidTop);
		return faces;
	}

	/** Puts a carried boat down toward the enderman (on a placed block when no flat floor is in line); where, or null. */
	private String place(ServerPlayer player, LivingEntity target) {
		Vec3 dir = flat(target.position().subtract(player.position())).normalize();
		if (laid != null && !target.getUUID().equals(laidFor)) laid = null;
		List<Vec3> faces = faces(player, dir);
		boolean raised = faces.stream().anyMatch(top -> top.y - player.getY() > 0.5D);
		if (!raised && hands != null && !blockTried.contains(target.getUUID())) {
			// As players do it: a block at the feet' level in line, and the boat on top of it. The enderman cannot step
			// over a boat that high; it walks into it or round the block, and either way touches the boat and sits.
			blockTried.add(target.getUUID());
			String block = hands.blockItem(player);
			if (block != null) {
				// Cells whose centre lies in line, nearest the ideal spot first.
				Vec3 feetAt = player.position();
				BlockPos feetCell = BlockPos.containing(feetAt.x, feetAt.y + 0.01D, feetAt.z);
				Vec3 idealCell = feetAt.add(dir.scale(BOAT_AT));
				List<BlockPos> cells = new ArrayList<>();
				for (int dx = -4; dx <= 4; dx++) for (int dz = -4; dz <= 4; dz++) {
					BlockPos cell = feetCell.offset(dx, 0, dz);
					Vec3 off = new Vec3(cell.getX() + 0.5D - feetAt.x, 0.0D, cell.getZ() + 0.5D - feetAt.z);
					double along = off.dot(dir);
					if (along < BOAT_MIN || along > BOAT_MAX || Math.sqrt(Math.max(0.0D, off.lengthSqr() - along * along)) > 0.75D) continue;
					cells.add(cell);
				}
				cells.sort(Comparator.comparingDouble(c -> flat(Vec3.atBottomCenterOf(c).subtract(idealCell)).lengthSqr()));
				for (BlockPos cell : cells) {
					Level level = player.level();
					if (!level.getBlockState(cell).canBeReplaced() || !level.getBlockState(cell).getFluidState().isEmpty() || !mayModify.test(player, cell)) continue;
					if (!level.getBlockState(cell.below()).isFaceSturdy(level, cell.below(), Direction.UP)) continue;
					if (!level.getBlockState(cell.above()).getCollisionShape(level, cell.above()).isEmpty()) continue;
					if (!level.getEntitiesOfClass(LivingEntity.class, new AABB(cell)).isEmpty()) continue;
					// The boat on top must fit: its footprint reaches into the cells round the block.
					if (problem(player, new Vec3(cell.getX() + 0.5D, cell.getY() + 1.0D, cell.getZ() + 0.5D)) != null) continue;
					blockAt = cell.immutable();
					blockItem = block;
					blockTicks = 0;
					blockFor = target.getUUID();
					return PENDING;
				}
			}
		}
		if (faces.isEmpty()) {
			note(laid != null ? "no room for a boat on the block at " + laid.toShortString() : "no floor in line for a boat toward " + target.getUUID());
			return null;
		}
		int slot = boatSlot(player);
		if (slot < 0) return null;
		var inventory = player.getInventory();
		int before = inventory.getSelectedSlot();
		if (slot > 8) {
			ItemStack moving = inventory.getItem(slot);
			inventory.setItem(slot, inventory.getItem(before));
			inventory.setItem(before, moving);
			slot = before;
		}
		inventory.setSelectedSlot(slot);
		ItemStack held = player.getMainHandItem();
		int count = held.getCount();
		ServerLevel level = player.level();
		for (Vec3 top : faces.subList(0, Math.min(6, faces.size()))) {
			player.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, top);
			InteractionResult result = player.gameMode.useItem(player, level, held, InteractionHand.MAIN_HAND);
			ItemStack now = player.getMainHandItem();
			if (result.consumesAction() || now.isEmpty() || now.getCount() < count) {
				dev.agaminggod.mineagen.server.runtime.ArmSwing.use(player, InteractionHand.MAIN_HAND);
				boat = level.getEntitiesOfClass(AbstractBoat.class, new AABB(top, top).inflate(1.5D), b -> b.isAlive() && b.getPassengers().isEmpty())
						.stream().min(Comparator.comparingDouble(b -> b.distanceToSqr(top))).orElse(null);
				inventory.setSelectedSlot(before);
				placed++;
				return String.format(Locale.ROOT, "%.1f %.1f %.1f%s", top.x, top.y, top.z, top.y - player.getY() > 0.5D ? " a block up" : "");
			}
		}
		inventory.setSelectedSlot(before);
		note("the boat would not go down on " + faces.size() + " spot(s) toward " + target.getUUID());
		return null;
	}

	private static final String PENDING = "pending";
	private final Set<UUID> blockTried = new HashSet<>();

	/** Turns to the block's spot and places it; running until placed, null once placed or given up. */
	private TickResult layBlock(ServerPlayer player) {
		if (++blockTicks > 30) { note("the block under a boat would not go down at " + blockAt.toShortString()); blockAt = null; return null; }
		Vec3 aim;
		try { aim = hands.aim(player, blockAt, Direction.UP, blockItem); }
		catch (dev.agaminggod.mineagen.agent.AgentDomainException refused) { aim = Vec3.atCenterOf(blockAt.below()).add(0.0D, 0.5D, 0.0D); }
		if (!ServerLookController.turnToward(player, aim)) return TickResult.running(0.0D);
		String why;
		try { why = hands.place(player, blockAt, Direction.UP, blockItem); }
		catch (dev.agaminggod.mineagen.agent.AgentDomainException refused) { why = refused.code() + ": " + refused.getMessage(); }
		if (why != null) return TickResult.running(0.0D);
		blocksUnder++;
		laid = blockAt;
		laidFor = blockFor;
		blockAt = null;
		return null;
	}

	private static int boatSlot(ServerPlayer player) {
		var inventory = player.getInventory();
		for (int slot = 0; slot < 36; slot++) if (isBoat(inventory.getItem(slot))) return slot;
		return -1;
	}

	/** The kill of a seated enderman (counted by the fight). */
	void killed(LivingEntity target) {
		if (target != null && seatedIds.contains(target.getUUID())) trapKills++;
		if (target != null && target.getUUID().equals(armedFor)) armedFor = null;
	}

	/** At the hunt's end: the boat in reach is broken (it drops as an item by the body, as a player takes it back). */
	void packUp(ServerPlayer player, boolean done) {
		cancelStep(player);
		if (child != null) { child.cancel(player); child = null; }
		if (!done || !boatUsable() || !boat.getPassengers().isEmpty()) return;
		double reach = player.entityInteractionRange();
		if (boat.getBoundingBox().distanceToSqr(player.getEyePosition()) > reach * reach) {
			note("boat left at " + String.format(Locale.ROOT, "%.0f %.0f %.0f", boat.getX(), boat.getY(), boat.getZ()));
			return;
		}
		player.lookAt(net.minecraft.commands.arguments.EntityAnchorArgument.Anchor.EYES, boat.position().add(0.0D, 0.3D, 0.0D));
		for (int hit = 0; hit < 5 && boat.isAlive(); hit++) {
			player.attack(boat);
			player.resetAttackStrengthTicker();
		}
		dev.agaminggod.mineagen.server.runtime.ArmSwing.attack(player, InteractionHand.MAIN_HAND);
		if (!boat.isAlive()) brokenBack++;
	}

	boolean active() {
		return supply != Supply.DONE && supply != Supply.TODO || child != null;
	}

	private void note(String text) {
		if (notes.size() < 16) notes.add(text);
	}

	private static String trim(String text) {
		if (text == null) return "";
		return text.length() > 120 ? text.substring(0, 120) + "..." : text;
	}

	/** The receipt clause. */
	String report() {
		return String.format(Locale.ROOT, "; boat trap: %d crafted, %d walks in, %d placed (%d on a block), %d walks round, %d seated, %d trap kill%s, %d came round it, %d broken back%s",
				crafted, approaches, placed, blocksUnder, walksRound, seatedIds.size(), trapKills, trapKills == 1 ? "" : "s", roundedNoSeat, brokenBack,
				notes.isEmpty() ? "" : " (" + String.join("; ", notes) + ")");
	}

	int seatedCount() { return seatedIds.size(); }
	int placedCount() { return placed; }
}
