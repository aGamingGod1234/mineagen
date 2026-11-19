package dev.agaminggod.mineagen.server.runtime.controller;

import com.google.gson.JsonObject;
import dev.agaminggod.mineagen.agent.AgentDomainException;
import dev.agaminggod.mineagen.compat.McEntityTypes;
import dev.agaminggod.mineagen.server.perception.ObservationVisibility;
import dev.agaminggod.mineagen.server.perception.SeenTerrain;
import dev.agaminggod.mineagen.server.runtime.ElapsedTimeAccumulator;
import dev.agaminggod.mineagen.server.runtime.ServerProtectionPolicy;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import dev.agaminggod.mineagen.server.runtime.reflex.ReflexSensors;
import java.util.ArrayList;
import java.util.Arrays;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.component.DataComponents;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.Identifier;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.item.ItemEntity;
import net.minecraft.world.food.FoodProperties;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;

/**
 * fight_until blaze at a seen fortress spawner, owned by the body (wall breaker "rods"): pick a seen cell 6-12 blocks from
 * the spawner, build a roofed one-cell shelter whose two-high doorway (a lintel over it) faces away from it, and fight from
 * its middle with the ordinary fight engine in place (pursue:false: bow through the doorway, sword at what comes in,
 * shield toward shots and charged blazes, heal in place). Rods are walked to and back when no wither skeleton is near;
 * the body eats inside. Hand-backs and their codes are {@link SpawnerHold#handBack} and {@link SpawnerHold#engineEnd}.
 */
public final class ServerSpawnerHoldController implements ServerController {
	private enum Phase { SITE, WALK, BUILD, LINTEL, HOLD }

	private static final Set<String> POOR_FOODS = Set.of("minecraft:rotten_flesh", "minecraft:spider_eye", "minecraft:poisonous_potato",
			"minecraft:pufferfish", "minecraft:suspicious_stew", "minecraft:chorus_fruit", "minecraft:chicken");
	/** Bodies in their hold cell now: the default back-off reflexes stand aside for them (ReflexEngine). */
	private static final Set<UUID> HOLDING = java.util.concurrent.ConcurrentHashMap.newKeySet();
	private static final long WALK_MS = 30_000L;
	private static final long BUILD_MS = 60_000L;
	private static final long COLLECT_MS = 20_000L;
	private static final int EAT_TICKS = 50;
	private static final int OUT_OF_CELL_TICKS = 20;

	private final ServerProtectionPolicy protection;
	private final JsonObject model;
	private final ServerFightUntilController.Roofing roofing;
	private final BlockPos spawner;
	private final Item untilItem;
	private final String untilItemId;
	private final int untilCount;
	private final float fleeAtHealth;
	private final long timeoutMs;
	private final ElapsedTimeAccumulator elapsedTime;
	private final CombatInputLease eatInput = new CombatInputLease();
	private final List<BlockPos> triedSites = new ArrayList<>();
	private final Map<String, Integer> engineEnds = new LinkedHashMap<>();
	/** Hits taken, by damage kind and where the body was (in the cell, or the phase and a rod trip). */
	private final Map<String, Integer> hurts = new LinkedHashMap<>();
	private final List<String> log = new ArrayList<>();
	private final long[] witherHits = new long[SpawnerHold.BREACH_HITS];
	private Phase phase = Phase.SITE;
	private BlockPos cell;
	private Direction opening;
	private String blockItem;
	private ServerController work;
	private ServerNavigationController walk;
	private ServerFightUntilController engine;
	/** Outside the finished cell (site walk, build, lintel, rod trips): an attacker in reach is fought before the work goes on. */
	private ServerFightController defend;
	private int defends;
	private KillDropCollector collector;
	private boolean returning;
	private int eatTicks = -1, eatSlot = -1, eatCount;
	private final CombatInputLease shieldInput = new CombatInputLease();
	private long turtleSinceMs = -1L;
	private int turtles;
	private String eatItem;
	private int sitesFailed, builds, engineRuns, trips, rodsPicked, meals, lintelTicks, outOfCellTicks;
	private boolean noSiteLeft;
	private int startHeld = -1;
	private long lastBlazeMs, lastElapsed;
	private int lastHurtTime;
	private TickResult finished;

	public ServerSpawnerHoldController(ServerPlayer player, JsonObject arguments, ServerProtectionPolicy protection, BlockPos spawner,
			ServerFightUntilController.Roofing roofing, long now) {
		this.protection = protection;
		this.model = arguments.deepCopy();
		this.roofing = roofing;
		this.spawner = spawner;
		this.untilItemId = arguments.get("untilItem").getAsString();
		this.untilItem = BuiltInRegistries.ITEM.getOptional(Identifier.parse(untilItemId))
				.orElseThrow(() -> new AgentDomainException("INVALID_FIELD", "untilItem: no item " + untilItemId));
		this.untilCount = arguments.get("untilCount").getAsInt();
		this.fleeAtHealth = arguments.has("fleeAtHealth") ? arguments.get("fleeAtHealth").getAsFloat() : ServerFightUntilController.DEFAULT_FLEE_AT_HEALTH;
		this.timeoutMs = Math.min(ServerFightUntilController.MAX_TIMEOUT_MS,
				arguments.has("timeoutMs") ? arguments.get("timeoutMs").getAsLong() : ServerFightUntilController.DEFAULT_TIMEOUT_MS);
		this.elapsedTime = new ElapsedTimeAccumulator(now);
		Arrays.fill(witherHits, Long.MIN_VALUE);
	}

	/**
	 * The nearest fortress spawner (nether bricks beside it) within {@link SpawnerHold#SCAN} blocks that the body has
	 * seen, or null. The world is scanned for spawner blocks; only one the body's own terrain view knows counts.
	 */
	public static BlockPos seenFortressSpawner(ServerPlayer player) {
		if (player.level().dimension() != Level.NETHER) return null;
		var seen = SeenTerrain.of(player);
		BlockPos feet = player.blockPosition();
		int r = (int) SpawnerHold.SCAN;
		BlockPos best = null;
		double bestDistance = Double.MAX_VALUE;
		BlockPos.MutableBlockPos at = new BlockPos.MutableBlockPos();
		for (int dx = -r; dx <= r; dx++) for (int dy = -12; dy <= 12; dy++) for (int dz = -r; dz <= r; dz++) {
			at.set(feet.getX() + dx, feet.getY() + dy, feet.getZ() + dz);
			if (!player.level().getBlockState(at).is(Blocks.SPAWNER)) continue;
			double distance = at.distSqr(feet);
			if (distance > SpawnerHold.SCAN * SpawnerHold.SCAN || distance >= bestDistance) continue;
			BlockState known = seen.known(at.getX(), at.getY(), at.getZ());
			if (known == null || !known.is(Blocks.SPAWNER) || !fortress(player.level(), at)) continue;
			bestDistance = distance;
			best = at.immutable();
		}
		return best;
	}

	/** True while this body fights from its finished hold cell. */
	public static boolean holding(ServerPlayer player) {
		return HOLDING.contains(player.getUUID());
	}

	private static boolean fortress(Level level, BlockPos spawner) {
		for (BlockPos near : BlockPos.betweenClosed(spawner.offset(-2, -2, -2), spawner.offset(2, 1, 2)))
			if (level.getBlockState(near).is(Blocks.NETHER_BRICKS)) return true;
		return false;
	}

	@Override
	public TickResult tick(ServerPlayer player, long now) {
		if (finished != null) return finished;
		long elapsed = elapsedTime.advance(now);
		lastElapsed = elapsed;
		if (startHeld < 0) { startHeld = ServerFightUntilController.count(player, untilItem); lastBlazeMs = elapsed; lastHurtTime = player.hurtTime; }
		if (!player.isAlive()) return stop(player, TickResult.failed("AGENT_DEAD", "Agent player died during the spawner hold", progress(player)));
		if (!HazardExits.fireResistant(player) && HazardExits.contact(player) == HazardExits.Contact.LAVA)
			return stop(player, TickResult.failed("IN_LAVA", "Lava contact during the spawner hold", progress(player)));
		boolean inCell = cell != null && phase == Phase.HOLD && player.blockPosition().equals(cell);
		if (inCell && collector == null && !returning) HOLDING.add(player.getUUID());
		else HOLDING.remove(player.getUUID());
		senseHits(player, inCell);
		if (blazeSeen(player)) lastBlazeMs = elapsed;
		var seenSpawner = SeenTerrain.of(player).known(spawner.getX(), spawner.getY(), spawner.getZ());
		boolean spawnerGone = seenSpawner != null && !seenSpawner.is(Blocks.SPAWNER);
		String code = SpawnerHold.handBack(new SpawnerHold.Sense(ServerFightUntilController.count(player, untilItem), untilCount, player.getHealth(),
				fleeAtHealth, player.getFoodData().getFoodLevel(), foodSlot(player) >= 0, elapsed, timeoutMs, spawnerGone,
				phase == Phase.HOLD ? elapsed - lastBlazeMs : 0L, phase == Phase.HOLD, sitesFailed, noSiteLeft,
				phase == Phase.HOLD && SpawnerHold.breached(witherHits, player.level().getGameTime())));
		if (code != null) return stop(player, handBackResult(player, code, elapsed));
		if (!inCell || defend != null) {
			TickResult defending = defend(player, now);
			if (defending != null) return defending;
		}
		return switch (phase) {
			case SITE -> chooseSite(player, now);
			case WALK -> walkToSite(player, now);
			case BUILD -> build(player, now);
			case LINTEL -> lintel(player, now);
			case HOLD -> hold(player, now, elapsed, inCell);
		};
	}

	/**
	 * The defend reflex stands aside for fight_until, so outside the cell the hold defends itself: a mob that targets the
	 * body from within 3.5 blocks (a wither skeleton on the walkway, a blaze come close) is fought with the sword and the
	 * shield for up to 20 s; the interrupted walk, build or trip starts again after. Null when nothing needs fighting.
	 */
	private TickResult defend(ServerPlayer player, long now) {
		if (defend == null) {
			LivingEntity attacker = null;
			double best = SpawnerHold.DEFEND_RANGE * SpawnerHold.DEFEND_RANGE;
			for (LivingEntity mob : player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(SpawnerHold.DEFEND_RANGE),
					e -> e instanceof net.minecraft.world.entity.Mob m && m.getTarget() == player && e.isAlive() && !e.isDeadOrDying()
							&& SpawnerHold.defendAgainst(e.getType() == McEntityTypes.BLAZE))) {
				double distance = mob.distanceToSqr(player);
				if (distance <= best && ObservationVisibility.canSeeEntity(player, mob) && protection.mayInteractWithEntity(player, mob)) { best = distance; attacker = mob; }
			}
			if (attacker == null) return null;
			cancelWalk(player);
			if (work != null) { work.cancel(player); work = null; }
			if (collector != null) { collector.cancel(player); collector = null; returning = true; }
			defend = new ServerFightController(attacker, null, fleeAtHealth, true, CombatPlanning.TargetPolicy.NAMED, false, true, false,
					player.getOffhandItem().getItem() instanceof net.minecraft.world.item.ShieldItem, SpawnerHold.DEFEND_MS, now);
			defends++;
			note("defend against " + BuiltInRegistries.ENTITY_TYPE.getKey(attacker.getType()));
		}
		TickResult result = defend.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		defend.cancel(player);
		defend = null;
		note("defend " + result.reasonCode());
		return TickResult.running(progress(player));
	}

	private TickResult chooseSite(ServerPlayer player, long now) {
		var seen = SeenTerrain.of(player);
		BlockPos bestCell = null;
		Direction bestOpening = null;
		double best = Double.MAX_VALUE;
		int r = (int) SpawnerHold.SITE_MAX;
		for (int dx = -r; dx <= r; dx++) for (int dz = -r; dz <= r; dz++) for (int dy = -SpawnerHold.SITE_BELOW; dy <= SpawnerHold.SITE_ABOVE; dy++) {
			double horizontal = Math.hypot(dx, dz);
			if (!SpawnerHold.siteInRange(horizontal, dy)) continue;
			BlockPos center = spawner.offset(dx, dy, dz);
			if (triedSites.contains(center) || !standable(player, seen, center)) continue;
			Direction toward = SpawnerHold.doorway(-dx, -dz);
			int blocks = 0;
			boolean firm = true;
			for (BlockPos at : shelterCells(center, toward)) {
				if (solid(player, seen, at)) continue;
				blocks++;
				if (at.getY() == center.getY() && !solid(player, seen, at.below())) { firm = false; break; }
			}
			if (!firm || !standable(player, seen, center.relative(toward)) || !standable(player, seen, center.relative(toward, 2))) continue;
			if (!eyeLine(player, center)) continue;
			double score = SpawnerHold.siteScore(horizontal, Math.sqrt(center.distSqr(player.blockPosition())), blocks);
			if (score < best) { best = score; bestCell = center; bestOpening = toward; }
		}
		if (bestCell == null) {
			noSiteLeft = true;
			return TickResult.running(progress(player));
		}
		cell = bestCell;
		opening = bestOpening;
		triedSites.add(cell);
		blockItem = roofing.blockItem(player);
		int needed = 0;
		for (BlockPos at : shelterCells(cell, opening)) if (!solid(player, seen, at)) needed++;
		int carried = blockItem == null ? 0 : ServerFightUntilController.count(player, BuiltInRegistries.ITEM.getValue(Identifier.parse(blockItem)));
		if (blockItem == null || carried < needed)
			return stop(player, TickResult.failed("ROOF_BLOCKS_MISSING", String.format(Locale.ROOT,
					"spawner hold: the shelter at %s needs %d full solid blocks of one kind; carries %s. Fetch blocks, or roof:false fights in the open",
					cell.toShortString(), needed, blockItem == null ? "none" : carried + " " + blockItem), progress(player)));
		note(String.format(Locale.ROOT, "site %s, %.1f blocks from the spawner, doorway %s, %d blocks to place", cell.toShortString(),
				Math.sqrt(cell.distSqr(spawner)), opening.getSerializedName(), needed));
		phase = Phase.WALK;
		return walkToSite(player, now);
	}

	private TickResult walkToSite(ServerPlayer player, long now) {
		Vec3 goal = Vec3.atBottomCenterOf(cell);
		if (player.blockPosition().equals(cell) && player.onGround()) {
			cancelWalk(player);
			phase = Phase.BUILD;
			return TickResult.running(progress(player));
		}
		if (walk == null) walk = new ServerNavigationController(goal, 0.3D, false, now, WALK_MS, false);
		TickResult result = walk.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		cancelWalk(player);
		if (result.state() == State.SUCCEEDED) { phase = Phase.BUILD; return TickResult.running(progress(player)); }
		return siteFailed(player, "walk " + result.reasonCode());
	}

	private TickResult build(ServerPlayer player, long now) {
		if (work == null) work = roofing.shelter(cell, opening, blockItem, false, BUILD_MS, now);
		TickResult built = work.tick(player, now);
		if (built.state() == State.RUNNING) return TickResult.running(progress(player));
		work.cancel(player);
		work = null;
		if (built.state() != State.SUCCEEDED) return siteFailed(player, "build " + built.reasonCode() + ": " + built.message());
		builds++;
		lintelTicks = 0;
		phase = Phase.LINTEL;
		return TickResult.running(progress(player));
	}

	/** The block over the doorway, placed from the open cell outside it (its face is in view from there). */
	private TickResult lintel(ServerPlayer player, long now) {
		BlockPos lintel = cell.relative(opening).above(2);
		var seen = SeenTerrain.of(player);
		if (solid(player, seen, lintel)) {
			Vec3 middle = Vec3.atBottomCenterOf(cell);
			if (player.blockPosition().equals(cell) && player.onGround()) { cancelWalk(player); return enterHold(player); }
			return walkStep(player, middle, now, "into the cell");
		}
		Vec3 outside = Vec3.atBottomCenterOf(cell.relative(opening, 2));
		if (player.position().distanceTo(outside) > 0.6D) return walkStep(player, outside, now, "out to the lintel");
		cancelWalk(player);
		if (++lintelTicks > 80) return siteFailed(player, "lintel at " + lintel.toShortString() + " not placed");
		Vec3 aim;
		try { aim = roofing.aim(player, lintel, opening, blockItem); }
		catch (AgentDomainException refused) { aim = Vec3.atCenterOf(lintel); }
		if (!ServerLookController.turnToward(player, aim)) return TickResult.running(progress(player));
		try {
			String why = roofing.place(player, lintel, opening, blockItem);
			if (why != null && lintelTicks % 20 == 0) note("lintel: " + why);
		} catch (AgentDomainException refused) {
			if (lintelTicks % 20 == 0) note("lintel refused " + refused.code());
		}
		return TickResult.running(progress(player));
	}

	private TickResult enterHold(ServerPlayer player) {
		phase = Phase.HOLD;
		lastBlazeMs = lastElapsed;
		note("holding at " + cell.toShortString() + ", doorway " + opening.getSerializedName());
		return TickResult.running(progress(player));
	}

	private TickResult hold(ServerPlayer player, long now, long elapsed, boolean inCell) {
		if (collector != null || returning) return collect(player, now);
		if (eatTicks >= 0) return eat(player);
		boolean shot = ReflexSensors.blockableShot(player, 1.5D) != null;
		boolean turtling = SpawnerHold.turtle(inCell, player.getHealth(), turtleSinceMs, elapsed);
		if (turtling) {
			if (turtleSinceMs < 0L) {
				stopEngine(player);
				turtleSinceMs = elapsed;
				turtles++;
				note(String.format(Locale.ROOT, "health %.1f: shield up in the cell to heal", player.getHealth()));
			}
			int food = foodSlot(player);
			if (food >= 0 && player.getFoodData().getFoodLevel() < 20 && ReflexSensors.blockableShot(player, 1.0D) == null) {
				shieldInput.release();
				startEat(player, food);
				return eat(player);
			}
			shieldUp(player);
			return TickResult.running(progress(player));
		}
		if (turtleSinceMs >= 0L) {
			note(String.format(Locale.ROOT, "healed to %.1f in %.0f s", player.getHealth(), (elapsed - turtleSinceMs) / 1000.0D));
			turtleSinceMs = -1L;
			shieldInput.release();
		}
		boolean blazeInReach = !player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(SpawnerHold.EAT_BLAZE_CLEAR),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive()).isEmpty();
		int slot = foodSlot(player);
		if (inCell && SpawnerHold.shouldEat(player.getFoodData().getFoodLevel(), player.getHealth(), shot, blazeInReach, slot >= 0)) {
			stopEngine(player);
			startEat(player, slot);
			return eat(player);
		}
		if (inCell && !shot) {
			List<UUID> rods = collectibleRods(player);
			if (!rods.isEmpty()) {
				stopEngine(player);
				collector = new KillDropCollector(rods, protection::mayTakeEntity, now, COLLECT_MS).makingRoom(protection::mayDropItem);
				trips++;
				return collect(player, now);
			}
		}
		outOfCellTicks = inCell ? 0 : outOfCellTicks + 1;
		if (outOfCellTicks > OUT_OF_CELL_TICKS) {
			stopEngine(player);
			returning = true;
			return collect(player, now);
		}
		if (engine == null) {
			engine = new ServerFightUntilController(player, engineArguments(elapsed), protection, now, "fight_until", null, null);
			engineRuns++;
		}
		TickResult result = engine.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		engine.cancel(player);
		engine = null;
		engineEnds.merge(result.reasonCode(), 1, Integer::sum);
		note("engine " + result.reasonCode() + ": " + result.message().substring(0, Math.min(240, result.message().length())));
		String stop = SpawnerHold.engineEnd(result.reasonCode());
		if (stop != null) return stop(player, handBackResult(player, stop, elapsed));
		return TickResult.running(progress(player));
	}

	/** The engine in the cell: the model's choices, held in place (pursue:false), no walk-outs, attackers in reach fought. */
	private JsonObject engineArguments(long elapsed) {
		JsonObject args = model.deepCopy();
		args.remove("roof");
		args.addProperty("x", cell.getX() + 0.5D);
		args.addProperty("y", cell.getY());
		args.addProperty("z", cell.getZ() + 0.5D);
		args.addProperty("pursue", false);
		args.addProperty("collect", false);
		if (!args.has("continueWithAttackers")) args.addProperty("continueWithAttackers", true);
		if (!args.has("radius") || args.get("radius").getAsDouble() < SpawnerHold.SITE_MAX + 8.0D) args.addProperty("radius", SpawnerHold.SITE_MAX + 8.0D);
		args.addProperty("timeoutMs", Math.max(1_000L, timeoutMs - elapsed));
		return args;
	}

	private TickResult collect(ServerPlayer player, long now) {
		if (collector != null) {
			String done = collector.tick(player, now);
			if (done == null) return TickResult.running(progress(player));
			collector = null;
			note("collect: " + done);
			returning = true;
		}
		Vec3 middle = Vec3.atBottomCenterOf(cell);
		if (player.blockPosition().equals(cell) && player.onGround()) {
			cancelWalk(player);
			returning = false;
			outOfCellTicks = 0;
			return TickResult.running(progress(player));
		}
		if (walk == null) walk = new ServerNavigationController(middle, 0.3D, false, now, WALK_MS, false);
		TickResult result = walk.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		cancelWalk(player);
		if (result.state() != State.SUCCEEDED) note("walk back " + result.reasonCode());
		returning = false;
		if (!player.blockPosition().equals(cell)) {
			// The cell could not be walked back into: choose a new site (it counts toward SPAWNER_UNREACHABLE).
			return siteFailed(player, "walk back " + result.reasonCode());
		}
		return TickResult.running(progress(player));
	}

	/** The shield raised toward the nearest seen blaze, else out of the doorway at eye height. */
	private void shieldUp(ServerPlayer player) {
		Vec3 eye = player.getEyePosition();
		Vec3 toward = Vec3.atCenterOf(cell.relative(opening, 3)).add(0.0D, 0.6D, 0.0D);
		double best = Double.MAX_VALUE;
		for (LivingEntity blaze : player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(SpawnerHold.SCAN),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive())) {
			if (!ObservationVisibility.canSeeEntity(player, blaze)) continue;
			double d = blaze.distanceToSqr(player);
			if (d < best) { best = d; toward = blaze.getEyePosition(); }
		}
		Vec3 delta = toward.subtract(eye);
		float yaw = (float) (Math.toDegrees(Math.atan2(delta.z, delta.x)) - 90.0D);
		float pitch = (float) -Math.toDegrees(Math.atan2(delta.y, Math.hypot(delta.x, delta.z)));
		shieldInput.apply(player, new AgentInputState(0.0F, 0.0F, false, false, false, false, true, yaw, pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.OFF_HAND));
	}

	private void startEat(ServerPlayer player, int slot) {
		eatSlot = slot;
		ItemStack stack = player.getInventory().getItem(slot);
		eatItem = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
		eatCount = stack.getCount();
		eatTicks = 0;
	}

	private TickResult eat(ServerPlayer player) {
		ItemStack now = player.getInventory().getItem(eatSlot);
		boolean ate = now.isEmpty() || !eatItem.equals(BuiltInRegistries.ITEM.getKey(now.getItem()).toString()) || now.getCount() < eatCount;
		if (ate || ++eatTicks > EAT_TICKS || ReflexSensors.blockableShot(player, 1.0D) != null) {
			if (ate) meals++;
			eatTicks = -1;
			eatInput.release();
			return TickResult.running(progress(player));
		}
		eatInput.apply(player, new AgentInputState(0.0F, 0.0F, false, false, false, false, true, player.getYRot(), player.getXRot(), eatSlot, InteractionHand.MAIN_HAND));
		return TickResult.running(progress(player));
	}

	/** The hotbar slot of the most filling ordinary food the body can eat now, or -1. */
	private static int foodSlot(ServerPlayer player) {
		int best = -1;
		int bestNutrition = 0;
		for (int slot = 0; slot < 9; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			FoodProperties food = stack.isEmpty() ? null : stack.get(DataComponents.FOOD);
			if (food == null || POOR_FOODS.contains(BuiltInRegistries.ITEM.getKey(stack.getItem()).toString())) continue;
			if (food.nutrition() > bestNutrition) { bestNutrition = food.nutrition(); best = slot; }
		}
		return best;
	}

	/** Seen rods on walkable ground near the cell that {@link SpawnerHold#mayCollect} allows a trip to now. */
	private List<UUID> collectibleRods(ServerPlayer player) {
		Vec3 middle = Vec3.atBottomCenterOf(cell);
		List<UUID> ids = new ArrayList<>();
		List<LivingEntity> withers = player.level().getEntitiesOfClass(LivingEntity.class, new AABB(middle, middle).inflate(SpawnerHold.COLLECT_RANGE + 12.0D),
				e -> e.getType() == McEntityTypes.WITHER_SKELETON && e.isAlive());
		List<LivingEntity> blazes = player.level().getEntitiesOfClass(LivingEntity.class, new AABB(middle, middle).inflate(SpawnerHold.COLLECT_RANGE + 8.0D),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive());
		double witherToBody = nearest(withers, player.position());
		for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, new AABB(middle, middle).inflate(SpawnerHold.COLLECT_RANGE),
				e -> e.isAlive() && e.getItem().is(untilItem))) {
			if (!ObservationVisibility.canSeeEntity(player, item) || !ServerFightUntilController.dropReachable(player, item.position())) continue;
			double blazeNear = Math.min(nearest(blazes, item.position()), nearest(blazes, player.position()));
			if (!SpawnerHold.mayCollect(player.getHealth(), witherToBody, nearest(withers, item.position()), blazeNear, item.getAge())) continue;
			ids.add(item.getUUID());
		}
		return ids;
	}

	private static double nearest(List<LivingEntity> entities, Vec3 at) {
		double best = Double.POSITIVE_INFINITY;
		for (LivingEntity entity : entities) best = Math.min(best, entity.position().distanceTo(at));
		return best;
	}

	private boolean blazeSeen(ServerPlayer player) {
		Vec3 at = Vec3.atCenterOf(spawner);
		for (LivingEntity blaze : player.level().getEntitiesOfClass(LivingEntity.class, new AABB(at, at).inflate(SpawnerHold.SCAN),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive()))
			if (ObservationVisibility.canSeeEntity(player, blaze)) return true;
		return false;
	}

	private void senseHits(ServerPlayer player, boolean inCell) {
		if (player.hurtTime > lastHurtTime) {
			var source = player.getLastDamageSource();
			hurts.merge((source == null ? "unknown" : source.getMsgId()) + (inCell ? " cell" : " " + phase.name().toLowerCase(Locale.ROOT)
					+ (collector != null || returning ? " trip" : "")), 1, Integer::sum);
		}
		if (player.hurtTime > lastHurtTime && inCell && player.getLastHurtByMob() != null
				&& player.getLastHurtByMob().getType() == McEntityTypes.WITHER_SKELETON) {
			System.arraycopy(witherHits, 0, witherHits, 1, witherHits.length - 1);
			witherHits[0] = player.level().getGameTime();
		}
		lastHurtTime = player.hurtTime;
	}

	private TickResult siteFailed(ServerPlayer player, String why) {
		note("site " + (cell == null ? "-" : cell.toShortString()) + " failed: " + why);
		sitesFailed++;
		cancelParts(player);
		phase = Phase.SITE;
		cell = null;
		return TickResult.running(progress(player));
	}

	private TickResult walkStep(ServerPlayer player, Vec3 goal, long now, String what) {
		if (walk == null) walk = new ServerNavigationController(goal, 0.3D, false, now, 10_000L, false);
		TickResult result = walk.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		cancelWalk(player);
		if (result.state() != State.SUCCEEDED) {
			note("walk " + what + " " + result.reasonCode());
			if (++lintelTicks > 80) return siteFailed(player, "walk " + what + " " + result.reasonCode());
		}
		return TickResult.running(progress(player));
	}

	private boolean eyeLine(ServerPlayer player, BlockPos center) {
		Vec3 eye = Vec3.atBottomCenterOf(center).add(0.0D, 1.62D, 0.0D);
		Vec3 target = Vec3.atCenterOf(spawner);
		var hit = player.level().clip(new ClipContext(eye, target, ClipContext.Block.COLLIDER, ClipContext.Fluid.NONE, player));
		return hit.getType() == HitResult.Type.MISS || hit instanceof net.minecraft.world.phys.BlockHitResult block && block.getBlockPos().equals(spawner);
	}

	/** Shelter walls and roof (no sill) plus the lintel. */
	static List<BlockPos> shelterCells(BlockPos center, Direction opening) {
		List<BlockPos> cells = new ArrayList<>();
		for (ServerShelterController.Cell cell : ServerShelterController.plan(center, opening, true, false)) cells.add(cell.at());
		cells.add(center.relative(opening).above(2));
		return cells;
	}

	private static boolean solid(ServerPlayer player, SeenTerrain.Reader<BlockState> seen, BlockPos at) {
		BlockState state = seen.known(at.getX(), at.getY(), at.getZ());
		return state != null && state.isCollisionShapeFullBlock(player.level(), at);
	}

	private static boolean open(ServerPlayer player, SeenTerrain.Reader<BlockState> seen, BlockPos at) {
		BlockState state = seen.known(at.getX(), at.getY(), at.getZ());
		return state != null && state.getCollisionShape(player.level(), at).isEmpty() && state.getFluidState().isEmpty()
				&& !state.is(Blocks.FIRE) && !state.is(Blocks.SOUL_FIRE);
	}

	private static boolean standable(ServerPlayer player, SeenTerrain.Reader<BlockState> seen, BlockPos at) {
		return solid(player, seen, at.below()) && open(player, seen, at) && open(player, seen, at.above());
	}

	private TickResult handBackResult(ServerPlayer player, String code, long elapsed) {
		String text = summary(player, elapsed);
		return switch (code) {
			case "UNTIL_COUNT_REACHED" -> TickResult.succeeded(code, "Holds " + ServerFightUntilController.count(player, untilItem) + " " + untilItemId
					+ " (asked " + untilCount + "); " + text);
			case "FIGHT_UNTIL_TIMED_OUT" -> TickResult.timedOut(code, String.format(Locale.ROOT, "%.0f s timeout reached; %s", timeoutMs / 1000.0D, text), progress(player));
			default -> TickResult.failed(code, why(code) + "; " + text, progress(player));
		};
	}

	private String why(String code) {
		return switch (code) {
			case "LOW_HEALTH_BAILOUT" -> String.format(Locale.ROOT, "health at or below fleeAtHealth %.1f", fleeAtHealth);
			case "OUT_OF_FOOD" -> "hurt and hungry with no food in the hotbar: health cannot regrow";
			case "SPAWNER_GONE" -> "the spawner at " + spawner.toShortString() + " is gone";
			case "SPAWNER_UNREACHABLE" -> noSiteLeft ? "no seen cell 6-12 blocks from the spawner to build in" : sitesFailed + " hold sites failed";
			case "SPAWNER_QUIET" -> String.format(Locale.ROOT, "no blaze seen for %.0f s from the cell", SpawnerHold.QUIET_MS / 1000.0D);
			case "HOLD_BREACHED" -> "wither skeletons hit the body inside the cell";
			case "AGENT_DEAD" -> "the body died";
			case "IN_LAVA" -> "lava contact";
			default -> "the fight engine stopped on " + code;
		};
	}

	private String summary(ServerPlayer player, long elapsed) {
		int held = ServerFightUntilController.count(player, untilItem);
		return String.format(Locale.ROOT, "spawner hold at %s: cell %s, %d site%s failed, %d build%s; %+d %s in %.0f s; %d engine run%s %s; %d rod trip%s; %d meal%s; %d defend%s; %d shield heal%s; hurts %s%s",
				spawner.toShortString(), cell == null ? "none" : cell.toShortString(), sitesFailed, sitesFailed == 1 ? "" : "s", builds, builds == 1 ? "" : "s",
				held - Math.max(0, startHeld), untilItemId, elapsed / 1000.0D, engineRuns, engineRuns == 1 ? "" : "s", engineEnds, trips, trips == 1 ? "" : "s",
				meals, meals == 1 ? "" : "s", defends, defends == 1 ? "" : "s", turtles, turtles == 1 ? "" : "s", hurts, log.isEmpty() ? "" : "; log: " + String.join(" | ", log.subList(Math.max(0, log.size() - 6), log.size())));
	}

	private void note(String line) {
		log.add(line);
		if (log.size() > 40) log.remove(0);
	}

	private double progress(ServerPlayer player) {
		int held = ServerFightUntilController.count(player, untilItem);
		int base = Math.max(0, startHeld);
		int need = Math.max(1, untilCount - base);
		return Math.max(0.0D, Math.min(1.0D, (held - base) / (double) need));
	}

	private void stopEngine(ServerPlayer player) {
		if (engine != null) { engine.cancel(player); engine = null; }
	}

	private void cancelWalk(ServerPlayer player) {
		if (walk != null) { walk.cancel(player); walk = null; }
	}

	private void cancelParts(ServerPlayer player) {
		HOLDING.remove(player.getUUID());
		if (defend != null) { defend.cancel(player); defend = null; }
		stopEngine(player);
		cancelWalk(player);
		if (work != null) { work.cancel(player); work = null; }
		if (collector != null) { collector.cancel(player); collector = null; }
		returning = false;
		eatTicks = -1;
		eatInput.release();
		shieldInput.release();
	}

	private TickResult stop(ServerPlayer player, TickResult result) {
		cancelParts(player);
		finished = result;
		return result;
	}

	@Override
	public void cancel(ServerPlayer player) {
		cancelParts(player);
	}
}
