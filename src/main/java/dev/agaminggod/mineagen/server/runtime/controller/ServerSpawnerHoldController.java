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
 * the spawner, build a roofed one-cell shelter whose two-high doorway (a lintel over it) faces the spawner, and fight from
 * its middle with the ordinary fight engine in place (pursue:false: bow through the doorway, sword at what comes in,
 * shield toward shots and charged blazes, heal in place). Rods are walked to and back when no wither skeleton is near;
 * the body eats inside. Hand-backs and their codes are {@link SpawnerHold#handBack} and {@link SpawnerHold#engineEnd}.
 */
public final class ServerSpawnerHoldController implements ServerController {
	private enum Phase { SCAN, SITE, WALK, BUILD, LINTEL, HOLD }

	/**
	 * Where this body last held a spawner: the spawner, its cell and doorway. A player knows the spawner it just fought at
	 * after a hand-back (out of food, a time cap), also from inside a walled-up cell where it is out of sight; a fight_until
	 * reissued there resumes the hold in the same cell (round 3 live: a reissued call found no spawner in view from the
	 * walled-in cell and stood there for 6 minutes seeing no blaze).
	 */
	private record Held(BlockPos spawner, BlockPos cell, Direction opening) {
	}
	private static final Map<UUID, Held> LAST_HOLD = new java.util.concurrent.ConcurrentHashMap<>();
	/** No spawner in view when the fight starts: look round for one this long before the ordinary fight takes over. */
	private static final int SCAN_TICKS = 80;

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
	private BlockPos spawner;
	private int scanTicks;
	/** No spawner found by looking round: the ordinary fight_until runs instead, under this controller. */
	private ServerFightUntilController fallback;
	private String fallbackWhy = "";
	private final long startedAt;
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
	/** Health lost, by the last damage kind and where the body was: hit counts alone hid which hits cost health. */
	private final Map<String, Float> lost = new LinkedHashMap<>();
	private float lastHealth = -1.0F;
	private int turtleTicks, blockingTicks;
	private final CombatInputLease fireInput = new CombatInputLease();
	private int fireTicks, firesPunched;
	private static final int FIRE_TICKS = 60;
	private final List<String> log = new ArrayList<>();
	private final long[] witherHits = new long[SpawnerHold.BREACH_HITS];
	private Phase phase;
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
	/**
	 * A rod that landed on a ledge above the feet (the platform round a fortress spawner, over the cell's floor) is
	 * fetched by the count fight's ledge trip: up the steps, or a pillar beside the ledge, and back down to the cell.
	 * Live (real fortress spawner room): the pickup refused such rods on every tick, 1,977 trips that stopped the fight
	 * each time, 19 kills for 1 rod.
	 */
	private LedgeFetch ledge;
	private final Set<UUID> ledgeTried = new java.util.HashSet<>();
	private int ledgeTrips, ledgeRods, heldBeforeLedge;
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
	/** Game tick each blaze within SCAN was first seen charged (glowing) in its current charge. */
	private final Map<UUID, Long> chargedSince = new java.util.HashMap<>();
	private int bitesStopped;
	/** Heal ticks the shield was asked up, and ticks the body was using an item then (by hand and item): a heal that never blocked needs both. */
	private int shieldAsks, usingTicks;
	private final Map<String, Integer> usedInHeal = new LinkedHashMap<>();
	private final Map<String, Integer> healWinners = new LinkedHashMap<>();
	/**
	 * The heal walls the doorway up (sill and window, two blocks), as a player blocks themself in to heal: round 3 live,
	 * every heal death came after the shield had worn out on 36-45 blocked fireballs through the doorway, so "shield up"
	 * held an empty offhand and fireballs and fire took the last 11 health in the cell. Once healed, the two blocks are
	 * mined out and the fight goes on from the same cell.
	 */
	private ServerController sealWork, reopenWork;
	private boolean sealed, sealTried, reopening, skipLintel;
	private long sealRetryTick;
	private int seals, reopens;
	private static final long SEAL_MS = 8_000L, REOPEN_MS = 20_000L;
	private String cancelFacts;

	public ServerSpawnerHoldController(ServerPlayer player, JsonObject arguments, ServerProtectionPolicy protection, BlockPos spawner,
			ServerFightUntilController.Roofing roofing, long now) {
		this.protection = protection;
		this.model = arguments.deepCopy();
		this.roofing = roofing;
		this.spawner = spawner;
		this.phase = spawner == null ? Phase.SCAN : Phase.SITE;
		this.startedAt = now;
		this.untilItemId = arguments.get("untilItem").getAsString();
		this.untilItem = BuiltInRegistries.ITEM.getOptional(Identifier.parse(untilItemId))
				.orElseThrow(() -> new AgentDomainException("INVALID_FIELD", "untilItem: no item " + untilItemId));
		this.untilCount = arguments.get("untilCount").getAsInt();
		this.fleeAtHealth = arguments.has("fleeAtHealth") ? arguments.get("fleeAtHealth").getAsFloat() : ServerFightUntilController.DEFAULT_FLEE_AT_HEALTH;
		this.timeoutMs = Math.min(ServerFightUntilController.MAX_TIMEOUT_MS,
				arguments.has("timeoutMs") ? arguments.get("timeoutMs").getAsLong() : ServerFightUntilController.DEFAULT_TIMEOUT_MS);
		this.elapsedTime = new ElapsedTimeAccumulator(now);
		Arrays.fill(witherHits, Long.MIN_VALUE);
		// The hold owns the body from the moment it is the active action: reflexes run before its first tick, and a
		// retreat started then would walk the hurt body away instead of the wall-in.
		HOLDING.add(player.getUUID());
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
		if (best != null) return best;
		Held held = LAST_HOLD.get(player.getUUID());
		if (held != null && held.spawner().distSqr(feet) <= SpawnerHold.SCAN * SpawnerHold.SCAN
				&& player.level().getBlockState(held.spawner()).is(Blocks.SPAWNER)) return held.spawner();
		return null;
	}

	/** True while a spawner hold owns this body (its whole run, not only in the cell): back-off reflexes stand aside. */
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
		if (fallback != null) return fallback.tick(player, now);
		long elapsed = elapsedTime.advance(now);
		lastElapsed = elapsed;
		if (startHeld < 0) { startHeld = ServerFightUntilController.count(player, untilItem); lastBlazeMs = elapsed; lastHurtTime = player.hurtTime; }
		if (!player.isAlive()) return stop(player, TickResult.failed("AGENT_DEAD", "Agent player died during the spawner hold", progress(player)));
		if (!HazardExits.fireResistant(player) && HazardExits.contact(player) == HazardExits.Contact.LAVA)
			return stop(player, TickResult.failed("IN_LAVA", "Lava contact during the spawner hold", progress(player)));
		boolean inCell = cell != null && phase == Phase.HOLD && player.blockPosition().equals(cell);
		// The hold owns the body from its first tick to its hand-back: site walk, build, rod trips and the walk back
		// included. Round 1 lost 3 of 4 deaths to default take-cover pausing the hold outside the cell and walking off.
		HOLDING.add(player.getUUID());
		senseHits(player, inCell);
		senseCharges(player);
		// No spawner yet (looking round for one): nothing to centre the blaze sense on.
		if (spawner != null && blazeSeen(player)) lastBlazeMs = elapsed;
		var seenSpawner = spawner == null ? null : SeenTerrain.of(player).known(spawner.getX(), spawner.getY(), spawner.getZ());
		boolean spawnerGone = seenSpawner != null && !seenSpawner.is(Blocks.SPAWNER);
		String code = SpawnerHold.handBack(new SpawnerHold.Sense(ServerFightUntilController.count(player, untilItem), untilCount, player.getHealth(),
				fleeAtHealth, player.getFoodData().getFoodLevel(), foodSlot(player) >= 0, elapsed, timeoutMs, spawnerGone,
				phase == Phase.HOLD ? elapsed - lastBlazeMs : 0L, phase == Phase.HOLD, sitesFailed, noSiteLeft,
				phase == Phase.HOLD && SpawnerHold.breached(witherHits, player.level().getGameTime())));
		if (code != null) return stop(player, handBackResult(player, code, elapsed));
		// The look round for a spawner comes after the action-wide checks above (death, lava, rod count, health floor,
		// timeout), so a hurt or finished body never turns on the spot for 4 s.
		if (phase == Phase.SCAN) {
			TickResult scanning = scan(player, now, elapsed);
			if (scanning != null) return scanning;
		}
		if (!inCell || defend != null) {
			TickResult defending = defend(player, now);
			if (defending != null) return defending;
		}
		return switch (phase) {
			case SCAN, SITE -> chooseSite(player, now);
			case WALK -> walkToSite(player, now);
			case BUILD -> build(player, now);
			case LINTEL -> lintel(player, now);
			case HOLD -> hold(player, now, elapsed, inCell);
		};
	}

	/**
	 * No fortress spawner in view at the start: look round (a full turn level, then one looking down, where a spawner
	 * under a deck lies) and take the hold once one comes into view; otherwise the ordinary fight_until runs. Real games
	 * (22 Nov): a spawner the body never saw lay 5 and 12 blocks away while blaze fights there found no blaze. Null once
	 * a spawner is found (the hold goes on this tick).
	 */
	private TickResult scan(ServerPlayer player, long now, long elapsed) {
		if (scanTicks % 5 == 0) {
			BlockPos found = seenFortressSpawner(player);
			if (found != null) {
				spawner = found;
				phase = Phase.SITE;
				shieldInput.release();
				note(String.format(Locale.ROOT, "looked round %d ticks: spawner at %s", scanTicks, found.toShortString()));
				return null;
			}
		}
		if (++scanTicks > SCAN_TICKS || player.level().dimension() != Level.NETHER) {
			HOLDING.remove(player.getUUID());
			shieldInput.release();
			fallbackWhy = "no fortress spawner seen after looking round";
			// The ordinary fight gets the time left, not a fresh timeout.
			JsonObject left = model.deepCopy();
			// roof is the hold's own option; the ordinary blaze fight refuses it.
			left.remove("roof");
			left.addProperty("timeoutMs", Math.max(1_000L, timeoutMs - elapsed));
			fallback = new ServerFightUntilController(player, left, protection, now, "fight_until", null, roofing);
			return fallback.tick(player, now);
		}
		float yaw = player.getYRot() + 360.0F / (SCAN_TICKS / 2.0F);
		float pitch = scanTicks <= SCAN_TICKS / 2 ? 0.0F : 35.0F;
		shieldInput.apply(player, new AgentInputState(0.0F, 0.0F, false, false, false, false, false, yaw, pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
		return TickResult.running(0.0D);
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
			// The open-fight engine is put down too: left unticked through the defend its input leases would lapse.
			stopEngine(player);
			if (work != null) { work.cancel(player); work = null; }
			if (collector != null) { collector.cancel(player); collector = null; returning = true; }
			if (ledge != null) { ledge.cancel(player); ledge = null; returning = true; }
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
		Held held = LAST_HOLD.get(player.getUUID());
		if (held != null && held.spawner().equals(spawner) && player.blockPosition().equals(held.cell()) && triedSites.isEmpty()) {
			// Resumed where the last hold stood: the same cell, opened again first if it was walled up.
			cell = held.cell();
			opening = held.opening();
			triedSites.add(cell);
			blockItem = roofing.blockItem(player);
			BlockPos doorway = cell.relative(opening);
			if (!player.level().getBlockState(doorway).getCollisionShape(player.level(), doorway).isEmpty()
					|| !player.level().getBlockState(doorway.above()).getCollisionShape(player.level(), doorway.above()).isEmpty()) {
				sealed = true;
				// Walled in and still hurt: heal on before opening (the last call ended mid-heal).
				if (player.getHealth() < SpawnerHold.TURTLE_DONE) turtleSinceMs = Math.max(0L, lastElapsed);
				else reopening = true;
			}
			note("resumed the hold in its cell " + cell.toShortString() + (reopening ? ", doorway walled up" : ""));
			return enterHold(player);
		}
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
			Direction toward = SpawnerHold.facing(-dx, -dz);
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
			if (sitesFailed == 0 && builds == 0) {
				// No cell to build here at all: the ordinary fight runs instead of a hand-back (real fortress room: the
				// hand-back left the body standing in the open by the spawner, where it died).
				note("no seen cell 6-12 blocks from the spawner: the ordinary fight runs");
				HOLDING.remove(player.getUUID());
				cancelParts(player);
				fallbackWhy = "no seen cell 6-12 blocks from the spawner";
				JsonObject left = model.deepCopy();
				left.remove("roof");
				left.addProperty("timeoutMs", Math.max(1_000L, timeoutMs - lastElapsed));
				fallback = new ServerFightUntilController(player, left, protection, now, "fight_until", null, roofing);
				return fallback.tick(player, now);
			}
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
		// The lintel only keeps wither skeletons (2.4 tall) out, and placing it means a walk out of the cell under fire
		// (real fortress spawner room: 12.5 health lost to a blaze there before the hold began). None in view: no lintel.
		skipLintel = player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(SpawnerHold.SCAN),
				e -> e.getType() == McEntityTypes.WITHER_SKELETON && e.isAlive() && ObservationVisibility.canSeeEntity(player, e)).isEmpty();
		if (skipLintel) note("no wither skeleton in view: no lintel");
		return TickResult.running(progress(player));
	}

	/** The block over the doorway, placed from the open cell outside it (its face is in view from there). */
	private TickResult lintel(ServerPlayer player, long now) {
		BlockPos lintel = cell.relative(opening).above(2);
		var seen = SeenTerrain.of(player);
		if (skipLintel || solid(player, seen, lintel)) {
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
		LAST_HOLD.put(player.getUUID(), new Held(spawner, cell, opening));
		lastBlazeMs = lastElapsed;
		note("holding at " + cell.toShortString() + ", doorway " + opening.getSerializedName());
		return TickResult.running(progress(player));
	}

	private TickResult hold(ServerPlayer player, long now, long elapsed, boolean inCell) {
		if (collector != null && collectHeldBack(player)) {
			collector.cancel(player);
			collector = null;
			returning = true;
			note("collect:false and a hostile near: back to the cell");
		}
		if (collector != null && SpawnerHold.backToCell(player.getHealth())) {
			collector.cancel(player);
			collector = null;
			returning = true;
			note(String.format(Locale.ROOT, "health %.1f on a rod trip: back to the cell", player.getHealth()));
		}
		if (ledge != null && SpawnerHold.backToCell(player.getHealth())) {
			ledge.cancel(player);
			ledge = null;
			returning = true;
			note(String.format(Locale.ROOT, "health %.1f on a ledge trip: back to the cell", player.getHealth()));
		}
		if (ledge != null) {
			String done = ledge.tick(player, now);
			if (done == null) return TickResult.running(progress(player));
			ledge = null;
			ledgeRods += Math.max(0, ServerFightUntilController.count(player, untilItem) - heldBeforeLedge);
			note("ledge: " + done);
			returning = true;
		}
		if (collector != null || returning) return collect(player, now);
		if (inCell) {
			TickResult punching = punchOutFire(player);
			if (punching != null) return punching;
		}
		if (eatTicks >= 0) return eat(player);
		if (reopening) {
			TickResult opening = reopen(player, now);
			if (opening != null) return opening;
		}
		boolean shot = ReflexSensors.blockableShot(player, 1.5D) != null;
		boolean turtling = sealed ? SpawnerHold.sealedHeal(player.getHealth(), turtleSinceMs, elapsed)
				: SpawnerHold.turtle(inCell, player.getHealth(), turtleSinceMs, elapsed);
		if (turtling) {
			turtleTicks++;
			if (player.isBlocking()) blockingTicks++;
			if (player.isUsingItem()) {
				usingTicks++;
				usedInHeal.merge(player.getUsedItemHand().name().toLowerCase(Locale.ROOT) + " "
						+ BuiltInRegistries.ITEM.getKey(player.getUseItem().getItem()).getPath(), 1, Integer::sum);
			}
			if (turtleSinceMs < 0L) {
				stopEngine(player);
				turtleSinceMs = elapsed;
				turtles++;
				note(String.format(Locale.ROOT, "health %.1f: heal in the cell (offhand %s, main %s)", player.getHealth(),
						BuiltInRegistries.ITEM.getKey(player.getOffhandItem().getItem()).getPath(), BuiltInRegistries.ITEM.getKey(player.getMainHandItem().getItem()).getPath()));
				sealTried = false;
			}
			// Walled in or behind the shield, the body is not watching for blazes: the spawner is not quiet for that.
			lastBlazeMs = elapsed;
			if (!sealed && !sealTried && player.level().getGameTime() >= sealRetryTick) {
				sealTried = true;
				int carried = blockItem == null ? 0 : ServerFightUntilController.count(player, BuiltInRegistries.ITEM.getValue(Identifier.parse(blockItem)));
				if (carried >= 2) {
					shieldInput.release();
					sealWork = roofing.seal(cell, opening, blockItem, SEAL_MS, now);
					seals++;
				}
			}
			if (sealWork != null) {
				TickResult built = sealWork.tick(player, now);
				if (built.state() == State.RUNNING) return TickResult.running(progress(player));
				sealWork.cancel(player);
				sealWork = null;
				sealed = built.state() == State.SUCCEEDED;
				note(sealed ? "walled the doorway up to heal" : "walling the doorway up failed: " + built.reasonCode());
				// A blaze in the doorway blocks the wall: try again in a second (the shield heal holds meanwhile).
				if (!sealed) { sealTried = false; sealRetryTick = player.level().getGameTime() + 20L; }
			}
			int food = foodSlot(player);
			if (sealed ? food >= 0 && player.getFoodData().getFoodLevel() < 20
					: SpawnerHold.healBite(player.getFoodData().getFoodLevel(), biteSafe(player), food >= 0)) {
				shieldInput.release();
				startEat(player, food);
				return eat(player);
			}
			if (sealed) {
				shieldInput.release();
				return TickResult.running(progress(player));
			}
			shieldUp(player);
			// Who drives the body's keys in the heal, and whether the winning keys hold the shield (0 of 294 heal ticks blocked).
			var inputs = dev.agaminggod.mineagen.server.runtime.input.AgentInputRuntime.controller(player);
			var agentId = dev.agaminggod.mineagen.server.runtime.input.AgentInputRuntime.requireAgentId(player);
			String winner = inputs.currentWinner(agentId).map(l -> l.owner().name().toLowerCase(Locale.ROOT) + "/" + l.priority()).orElse("none");
			String keys = inputs.currentState(agentId).map(st -> st.use() ? "use " + st.hand().name().toLowerCase(Locale.ROOT) : "no use").orElse("no keys");
			healWinners.merge(winner + " " + keys, 1, Integer::sum);
			return TickResult.running(progress(player));
		}
		if (turtleSinceMs >= 0L) {
			note(String.format(Locale.ROOT, "healed to %.1f in %.0f s", player.getHealth(), (elapsed - turtleSinceMs) / 1000.0D));
			turtleSinceMs = -1L;
			shieldInput.release();
			// Healed while the wall-in was still being placed: stop it and open whatever of the doorway it already closed.
			if (sealWork != null) { sealWork.cancel(player); sealWork = null; sealed = true; }
			if (sealed) {
				reopening = true;
				TickResult opening = reopen(player, now);
				if (opening != null) return opening;
			}
		}
		boolean blazeInReach = !player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(SpawnerHold.EAT_BLAZE_CLEAR),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive()).isEmpty();
		int slot = foodSlot(player);
		if (inCell && SpawnerHold.shouldEat(player.getFoodData().getFoodLevel(), player.getHealth(), !shot && biteSafe(player), blazeInReach, slot >= 0)) {
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
			for (UUID id : ledgeRods(player)) {
				ledgeTried.add(id);
				LedgeFetch trip = LedgeFetch.plan(player, id, untilItem, Vec3.atBottomCenterOf(cell),
						(body, at) -> protection.mayModifyBlock(body, (net.minecraft.server.level.ServerLevel) body.level(), at),
						ServerFightUntilController.count(player, untilItem), now);
				if (trip == null) {
					if (LedgeFetch.waiting) ledgeTried.remove(id);
					else note("ledge: no trip for " + id + ": " + LedgeFetch.refusal);
					continue;
				}
				stopEngine(player);
				ledge = trip;
				ledgeTrips++;
				heldBeforeLedge = ServerFightUntilController.count(player, untilItem);
				return TickResult.running(progress(player));
			}
		}
		outOfCellTicks = inCell ? 0 : outOfCellTicks + 1;
		if (!SpawnerHold.OPEN_FIGHT && outOfCellTicks > OUT_OF_CELL_TICKS || !inCell && SpawnerHold.backToCell(player.getHealth())) {
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
		// Open fight (SpawnerHold.OPEN_FIGHT): the model's own fight while healthy; the cell is where the body heals.
		if (!SpawnerHold.OPEN_FIGHT) {
			args.addProperty("pursue", false);
			args.addProperty("collect", false);
		}
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

	/**
	 * Fire standing in the cell (a fireball that missed lights the floor) is punched out: a hit on its flame breaks it at
	 * once. The engine's own fire step is off under pursue:false, and the cell is where the body heals now, so without
	 * this it sat in the flames (round 2 live: two of three runs burned to death in the hold). Null when no fire is there.
	 */
	private TickResult punchOutFire(ServerPlayer player) {
		BlockPos flame = null;
		for (BlockPos at : new BlockPos[] {cell, cell.above()})
			if (TravelBuilder.fire(player.level().getBlockState(at)) && protection.mayModifyBlock(player, player.level(), at)) { flame = at; break; }
		if (flame == null) {
			fireTicks = 0;
			fireInput.release();
			return null;
		}
		if (fireTicks == 0) {
			stopEngine(player);
			shieldInput.release();
			eatTicks = -1;
			eatInput.release();
			firesPunched++;
		}
		if (++fireTicks > FIRE_TICKS) {
			if (fireTicks == FIRE_TICKS + 1) note("fire at " + flame.toShortString() + " not put out");
			fireInput.release();
			return null;
		}
		float[] look = TravelBuilder.lookAt(player.getEyePosition(), new Vec3(flame.getX() + 0.5D, flame.getY() + 0.03D, flame.getZ() + 0.5D));
		var hit = TravelBuilder.crosshair(player);
		boolean aimed = hit != null && hit.getBlockPos().equals(flame);
		fireInput.apply(player, new AgentInputState(0.0F, 0.0F, false, false, false, aimed && fireTicks % 2 == 0, false, look[0], look[1],
				player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
		return TickResult.running(progress(player));
	}

	/** The shield raised toward the nearest seen blaze, else out of the doorway at eye height. */
	private void shieldUp(ServerPlayer player) {
		shieldAsks++;
		Vec3 eye = player.getEyePosition();
		Vec3 toward = Vec3.atCenterOf(cell.relative(opening, 3)).add(0.0D, 0.6D, 0.0D);
		double best = Double.MAX_VALUE;
		boolean chargedFound = false;
		for (LivingEntity blaze : player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(SpawnerHold.SCAN),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive())) {
			// A charged blaze with a line to the body fires next: face it first, else the nearest one in view.
			boolean charged = chargedSince.containsKey(blaze.getUUID()) && blaze.hasLineOfSight(player);
			if (!charged && (chargedFound || !ObservationVisibility.canSeeEntity(player, blaze))) continue;
			double d = blaze.distanceToSqr(player);
			if (charged && !chargedFound) { chargedFound = true; best = Double.MAX_VALUE; }
			if (d < best) { best = d; toward = blaze.getEyePosition(); }
		}
		Vec3 delta = toward.subtract(eye);
		float yaw = (float) (Math.toDegrees(Math.atan2(delta.z, delta.x)) - 90.0D);
		float pitch = (float) -Math.toDegrees(Math.atan2(delta.y, Math.hypot(delta.x, delta.z)));
		shieldInput.apply(player, new AgentInputState(0.0F, 0.0F, false, false, false, false, true, yaw, pitch,
				player.getInventory().getSelectedSlot(), InteractionHand.OFF_HAND));
	}

	/** Mines the walled-up doorway open again (window first, then sill). Null once it is open or cannot be opened. */
	private TickResult reopen(ServerPlayer player, long now) {
		if (reopenWork == null) {
			BlockPos doorway = cell.relative(opening);
			BlockPos next = null;
			for (BlockPos at : new BlockPos[] {doorway.above(), doorway})
				if (!player.level().getBlockState(at).getCollisionShape(player.level(), at).isEmpty()) { next = at; break; }
			if (next == null) {
				sealed = false;
				reopening = false;
				reopens++;
				note("doorway open again");
				return null;
			}
			reopenWork = roofing.clear(player, next, REOPEN_MS);
			if (reopenWork == null) {
				reopening = false;
				note("no way to mine the doorway open: staying walled in");
				return null;
			}
		}
		TickResult result = reopenWork.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		reopenWork.cancel(player);
		reopenWork = null;
		if (result.state() != State.SUCCEEDED) {
			reopening = false;
			note("mining the doorway open failed: " + result.reasonCode());
			return null;
		}
		return TickResult.running(progress(player));
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
		boolean stop = !ate && SpawnerHold.stopBite(oldestCharge(player), ReflexSensors.blockableShot(player, 1.0D) != null);
		if (ate || ++eatTicks > EAT_TICKS || stop) {
			if (ate) meals++;
			if (stop) bitesStopped++;
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
	/** collect:false (the model's choice): no rod trip while a hostile is within 16 blocks, as the ordinary count fight. */
	private boolean collectHeldBack(ServerPlayer player) {
		return model.has("collect") && !model.get("collect").getAsBoolean() && KillDropCollector.hostileNear(player) != null;
	}

	private List<UUID> collectibleRods(ServerPlayer player) {
		Vec3 middle = Vec3.atBottomCenterOf(cell);
		List<UUID> ids = new ArrayList<>();
		if (collectHeldBack(player)) return ids;
		List<LivingEntity> withers = player.level().getEntitiesOfClass(LivingEntity.class, new AABB(middle, middle).inflate(SpawnerHold.COLLECT_RANGE + 12.0D),
				e -> e.getType() == McEntityTypes.WITHER_SKELETON && e.isAlive());
		List<LivingEntity> blazes = player.level().getEntitiesOfClass(LivingEntity.class, new AABB(middle, middle).inflate(SpawnerHold.COLLECT_RANGE + 8.0D),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive());
		double witherToBody = nearest(withers, player.position());
		for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, new AABB(middle, middle).inflate(SpawnerHold.COLLECT_RANGE),
				e -> e.isAlive() && e.getItem().is(untilItem))) {
			if (!ObservationVisibility.canSeeEntity(player, item) || !ServerFightUntilController.dropReachable(player, item.position())) continue;
			// On a ledge above the feet the pickup leaves it (KillDropCollector): that is a ledge trip's (ledgeRods).
			if (aboveFeet(player, item)) continue;
			double blazeNear = Math.min(nearest(blazes, item.position()), nearest(blazes, player.position()));
			int blazesNearRod = (int) blazes.stream().filter(b -> b.position().distanceTo(item.position()) <= SpawnerHold.LEDGE_BLAZE_RANGE).count();
			if (!SpawnerHold.mayCollect(player.getHealth(), witherToBody, nearest(withers, item.position()), blazeNear, item.getAge())
					&& !SpawnerHold.mayStepOut(player.getHealth(), witherToBody, nearest(withers, item.position()), item.position().distanceTo(middle), blazesNearRod)
					&& !SpawnerHold.mayFetchBold(player.getHealth(), witherToBody, nearest(withers, item.position()), nearest(blazes, item.position()), item.position().distanceTo(middle))) continue;
			ids.add(item.getUUID());
		}
		return ids;
	}

	private static boolean aboveFeet(ServerPlayer player, ItemEntity item) {
		return item.onGround() && item.getY() > player.getY() + 0.6D;
	}

	/** Seen rods on a ledge above the feet near the cell, not yet tried, that {@link SpawnerHold#mayCollect} allows a trip to now. */
	private List<UUID> ledgeRods(ServerPlayer player) {
		Vec3 middle = Vec3.atBottomCenterOf(cell);
		List<UUID> ids = new ArrayList<>();
		if (collectHeldBack(player)) return ids;
		List<LivingEntity> withers = player.level().getEntitiesOfClass(LivingEntity.class, new AABB(middle, middle).inflate(SpawnerHold.COLLECT_RANGE + 12.0D),
				e -> e.getType() == McEntityTypes.WITHER_SKELETON && e.isAlive());
		List<LivingEntity> blazes = player.level().getEntitiesOfClass(LivingEntity.class, new AABB(middle, middle).inflate(SpawnerHold.COLLECT_RANGE + 8.0D),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive());
		double witherToBody = nearest(withers, player.position());
		for (ItemEntity item : player.level().getEntitiesOfClass(ItemEntity.class, new AABB(middle, middle).inflate(SpawnerHold.COLLECT_RANGE),
				e -> e.isAlive() && e.getItem().is(untilItem))) {
			if (ledgeTried.contains(item.getUUID()) || !aboveFeet(player, item) || !ObservationVisibility.canSeeEntity(player, item)) continue;
			dev.agaminggod.mineagen.server.perception.ObservedDrops.remember(player, item);
			int blazesNear = (int) blazes.stream().filter(b -> b.position().distanceTo(item.position()) <= SpawnerHold.LEDGE_BLAZE_RANGE).count();
			if (!SpawnerHold.mayFetchLedge(player.getHealth(), witherToBody, nearest(withers, item.position()), blazesNear)) continue;
			ids.add(item.getUUID());
		}
		return ids;
	}

	private static double nearest(List<LivingEntity> entities, Vec3 at) {
		double best = Double.POSITIVE_INFINITY;
		for (LivingEntity entity : entities) best = Math.min(best, entity.position().distanceTo(at));
		return best;
	}

	private void senseCharges(ServerPlayer player) {
		long tick = player.level().getGameTime();
		Set<UUID> charged = new java.util.HashSet<>();
		Vec3 at = player.position();
		for (LivingEntity blaze : player.level().getEntitiesOfClass(LivingEntity.class, new AABB(at, at).inflate(SpawnerHold.SCAN),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive() && !e.isDeadOrDying() && e.isOnFire())) {
			charged.add(blaze.getUUID());
			chargedSince.putIfAbsent(blaze.getUUID(), tick);
		}
		chargedSince.keySet().retainAll(charged);
	}

	/** The longest charge, in ticks, of a blaze with a clear line to the body (it can shoot it), or -1. */
	private int oldestCharge(ServerPlayer player) {
		long tick = player.level().getGameTime();
		int oldest = -1;
		Vec3 at = player.position();
		for (LivingEntity blaze : player.level().getEntitiesOfClass(LivingEntity.class, new AABB(at, at).inflate(SpawnerHold.SCAN),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive() && chargedSince.containsKey(e.getUUID()))) {
			if (!blaze.hasLineOfSight(player)) continue;
			oldest = (int) Math.max(oldest, Math.min(Integer.MAX_VALUE, tick - chargedSince.get(blaze.getUUID())));
		}
		return oldest;
	}

	private boolean biteSafe(ServerPlayer player) {
		return SpawnerHold.biteSafe(oldestCharge(player), ReflexSensors.blockableShot(player, 1.0D) != null);
	}

	private boolean blazeSeen(ServerPlayer player) {
		Vec3 at = Vec3.atCenterOf(spawner);
		for (LivingEntity blaze : player.level().getEntitiesOfClass(LivingEntity.class, new AABB(at, at).inflate(SpawnerHold.SCAN),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive()))
			if (ObservationVisibility.canSeeEntity(player, blaze)) return true;
		return false;
	}

	private void senseHits(ServerPlayer player, boolean inCell) {
		String where = inCell ? " cell" : " " + phase.name().toLowerCase(Locale.ROOT) + (collector != null || returning ? " trip" : "");
		if (player.hurtTime > lastHurtTime) {
			var source = player.getLastDamageSource();
			hurts.merge((source == null ? "unknown" : source.getMsgId()) + where, 1, Integer::sum);
		}
		float health = player.getHealth();
		if (lastHealth >= 0.0F && health < lastHealth) {
			var source = player.getLastDamageSource();
			lost.merge((source == null ? "unknown" : source.getMsgId()) + where, lastHealth - health, Float::sum);
		}
		lastHealth = health;
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
			case "SPAWNER_GONE" -> "the spawner at " + (spawner == null ? "?" : spawner.toShortString()) + " is gone";
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
		return String.format(Locale.ROOT, "spawner hold at %s: cell %s, %d site%s failed, %d build%s; %+d %s in %.0f s; %d engine run%s %s; %d rod trip%s (%d up a ledge, %d rods from them); %d meal%s; %d defend%s; %d heal%s (%d walled in, %d reopened; shield up %d of %d ticks, asked %d, using %d %s, keys %s, %d bite%s stopped for a volley); %d fire%s punched out; hurts %s; health lost %s%s",
				spawner == null ? "none seen" : spawner.toShortString(), cell == null ? "none" : cell.toShortString(), sitesFailed, sitesFailed == 1 ? "" : "s", builds, builds == 1 ? "" : "s",
				held - Math.max(0, startHeld), untilItemId, elapsed / 1000.0D, engineRuns, engineRuns == 1 ? "" : "s", engineEnds, trips, trips == 1 ? "" : "s", ledgeTrips, ledgeRods,
				meals, meals == 1 ? "" : "s", defends, defends == 1 ? "" : "s", turtles, turtles == 1 ? "" : "s", seals, reopens, blockingTicks, turtleTicks, shieldAsks, usingTicks, usedInHeal, healWinners, bitesStopped, bitesStopped == 1 ? "" : "s", firesPunched, firesPunched == 1 ? "" : "s", hurts, lostText(), log.isEmpty() ? "" : "; log: " + String.join(" | ", log.subList(Math.max(0, log.size() - 6), log.size())));
	}

	private String lostText() {
		StringBuilder text = new StringBuilder("{");
		lost.forEach((key, value) -> text.append(text.length() > 1 ? ", " : "").append(key).append('=').append(String.format(Locale.ROOT, "%.1f", value)));
		return text.append('}').toString();
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
		if (defend != null) { defend.cancel(player); defend = null; }
		stopEngine(player);
		cancelWalk(player);
		if (work != null) { work.cancel(player); work = null; }
		if (collector != null) { collector.cancel(player); collector = null; }
		if (ledge != null) { ledge.cancel(player); ledge = null; }
		if (sealWork != null) { sealWork.cancel(player); sealWork = null; }
		if (reopenWork != null) { reopenWork.cancel(player); reopenWork = null; }
		returning = false;
		eatTicks = -1;
		eatInput.release();
		shieldInput.release();
		fireInput.release();
	}

	private TickResult stop(ServerPlayer player, TickResult result) {
		HOLDING.remove(player.getUUID());
		cancelParts(player);
		finished = result;
		return result;
	}

	/**
	 * The hold's receipt for a cancel: a death ends the action through the lifecycle cancel before the hold ticks again,
	 * and without this the phase, spot and health lost at death were known only from server death lines.
	 */
	public String stoppedBodyFacts(ServerPlayer player) {
		if (fallback != null) return "; the spawner hold handed over to the ordinary fight: " + fallbackWhy;
		return cancelFacts != null ? cancelFacts : facts(player);
	}

	/** Read before cancelParts, which clears the trip, defend and shield-heal state the receipt names. */
	private String facts(ServerPlayer player) {
		BlockPos at = player.blockPosition();
		return String.format(Locale.ROOT, "; spawner hold stopped in phase %s%s at %d,%d,%d (%s), health %.1f; %s", phase.name().toLowerCase(Locale.ROOT),
				collector != null || returning ? " trip" : defend != null ? " defend" : turtleSinceMs >= 0L ? " shield heal" : "",
				at.getX(), at.getY(), at.getZ(), cell == null ? "no cell" : at.equals(cell) ? "in the cell" : "cell " + cell.toShortString(),
				player.getHealth(), summary(player, lastElapsed));
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (fallback != null) { fallback.cancel(player); return; }
		HOLDING.remove(player.getUUID());
		if (cancelFacts == null) cancelFacts = facts(player);
		cancelParts(player);
	}
}
