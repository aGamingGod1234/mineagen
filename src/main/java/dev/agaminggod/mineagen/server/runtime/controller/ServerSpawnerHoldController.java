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
	private ServerController fallback;
	/** The fight_target form's ordinary fight, run when no hold applies here (no spawner or no cell site). */
	private java.util.function.Supplier<ServerController> openFight;
	/** fight_target form: the model's open fight_target, its fleeAtHealth capped (or null for the model's own). */
	private java.util.function.Function<Float, ServerController> openTarget;
	private boolean resumeChecked;
	/** Ticks spent looking round for a cell site before the ordinary fight takes over. */
	private int siteLooks;
	private String fallbackWhy = "";
	/** fight_target on this blaze, held from the cell: the hold ends when it dies (or is gone), not at a rod count. */
	private LivingEntity target;
	/** The fight_target form's open fight while healthy (open fight on). */
	private ServerController openPart;
	/** fight_target form: the call's end held back until the walled-up doorway is open again (the next call must see out). */
	private TickResult pendingEnd;
	/** fight_target form: the tick the named blaze died with the hold fighting (not the open fight), for the rod's pickup. */
	private long killTick = -1L, openKillTick = -1L;
	private static final long KILL_COLLECT_TICKS = 60L, KILL_COLLECT_MAX_TICKS = 200L;
	private int emergencyFails;
	private static final int EMERGENCY_TRIES = 3;
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
	/** Health lost to hits (not burning) by game tick, for the rate the walk back is expected to cost: {tick, loss}. */
	private final java.util.ArrayDeque<float[]> recentHits = new java.util.ArrayDeque<>();
	/** Game tick the body last lost health (any source), for the open fight's lull bite. */
	private long lastLossTick = Long.MIN_VALUE / 2;
	/** A bite the open fight's lull started (fight_target form), and how many such meals were eaten. */
	private boolean lullBite;
	private int lullMeals;
	/** Ticks with nothing taking health before the open fight stops for a bite. */
	private static final long LULL_TICKS = 40L;
	/** Health missing (2 hearts) before the open fight stops for a bite. */
	private static final float LULL_MISSING_HEALTH = 4.0F;
	/** The margin ran out outside the cell: the heal starts on arrival whatever the health (up to TURTLE_DONE). */
	private boolean coverWanted;
	private int marginTurns;
	/** Health at each heal start, for the receipt: the heal began at 2.4-8.3 before the turn-back counted the walk back. */
	private final List<String> healStarts = new ArrayList<>();
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
	/** Floor rods a trip already went for: one the pickup could not reach (a gap, full bags) is not offered again each tick. */
	private final Set<UUID> floorTried = new java.util.HashSet<>();
	/** The rods of the floor trip under way: marked tried only once the trip ends by itself (an interrupted trip marks none). */
	private List<UUID> tripRods = List.of();
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
	/**
	 * Hurt before the cell stands (walking to the site or building under fire): the body walls itself in where it stands,
	 * as a player blocks themself in, and heals there; that spot becomes the cell. Blaze spawner rooms: the deaths came
	 * 6 s into the walk or build, 14 health lost to several blazes at once, before any cell stood.
	 */
	private ServerController emergency;
	private Direction emergencyOpening;
	private BlockPos emergencyCell;
	private long emergencyRetryTick;
	private int emergencies;
	/**
	 * Part of the doorway placed (the sill) but its window still open: the heal stays the shield heal and the wall-in is
	 * retried, and whatever stands is mined open after the heal. Only both blocks placed make the unshielded sealed heal.
	 */
	private boolean partlySealed;
	private long sealRetryTick;
	private int seals, reopens, reopenFails;
	private long reopenRetryTick;
	private static final int REOPEN_TRIES = 3;
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
		BlockPos now = inViewFortressSpawner(player);
		if (now != null) {
			NOTICED.put(player.getUUID(), new Noticed(now, player.level().getGameTime()));
			return now;
		}
		if (player.level().dimension() != Level.NETHER) return null;
		BlockPos feet = player.blockPosition();
		Held held = LAST_HOLD.get(player.getUUID());
		if (held != null && held.spawner().distSqr(feet) <= SpawnerHold.SCAN * SpawnerHold.SCAN
				&& player.level().getBlockState(held.spawner()).is(Blocks.SPAWNER)) return held.spawner();
		Noticed noticed = NOTICED.get(player.getUUID());
		if (noticed != null && player.level().getGameTime() - noticed.tick() <= NOTICE_TICKS
				&& noticed.spawner().distSqr(feet) <= SpawnerHold.SCAN * SpawnerHold.SCAN
				&& player.level().getBlockState(noticed.spawner()).is(Blocks.SPAWNER)) return noticed.spawner();
		return null;
	}

	/**
	 * A fortress spawner this body saw in the last NOTICE_TICKS (5 minutes): a player who built cover between it and the
	 * spawner still knows where the spawner is (blaze spawner cover room: the two cover blocks hid the spawner, the fight
	 * ran in the open and died 4 of 4). Kept fresh by {@link #notice} once a second from the reflex engine.
	 */
	private record Noticed(BlockPos spawner, long tick) {
	}
	private static final Map<UUID, Noticed> NOTICED = new java.util.concurrent.ConcurrentHashMap<>();
	private static final long NOTICE_TICKS = 6_000L;

	/** Remembers a fortress spawner in view now (the reflex engine calls this once a second in the Nether). */
	public static void notice(ServerPlayer player) {
		if (player.level().dimension() != Level.NETHER) return;
		BlockPos now = inViewFortressSpawner(player);
		if (now != null) NOTICED.put(player.getUUID(), new Noticed(now, player.level().getGameTime()));
	}

	private static BlockPos inViewFortressSpawner(ServerPlayer player) {
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

	/** The fight_target form: held from the cell until {@code target} dies; {@code openFight} runs when no hold applies. */
	public ServerSpawnerHoldController untilDead(LivingEntity target, java.util.function.Function<Float, ServerController> openFight) {
		this.target = target;
		this.openTarget = openFight;
		this.openFight = () -> openFight.apply(null);
		return this;
	}

	/** The ordinary fight with the time left ({@code elapsed} of the action spent), not a fresh timeout. */
	private ServerController ordinaryFight(ServerPlayer player, long now, long elapsed) {
		if (openFight != null) return openFight.get();
		JsonObject left = model.deepCopy();
		// roof is the hold's own option; the ordinary blaze fight refuses it.
		left.remove("roof");
		left.addProperty("timeoutMs", Math.max(1_000L, timeoutMs - elapsed));
		return new ServerFightUntilController(player, left, protection, now, "fight_until", null, roofing);
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
		if (pendingEnd != null) return closeOut(player, now);
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
		// The fight_target form ends at its own timeout with fight_target's code (the hold's own is FIGHT_UNTIL_TIMED_OUT).
		// A kill's drop look and pickup under way (the open fight's, or the hold's own) finish first, up to 10 s past it.
		// The open fight's own after-kill work (drop look, pickup) gets 10 s from the kill. With continueWithAttackers it may
		// instead fight on against another blaze: past that window that is an ordinary open fight again (wall-in, timeout).
		if (target != null && openPart != null && target.isDeadOrDying() && openKillTick < 0L) openKillTick = player.level().getGameTime();
		boolean afterOpenKill = openKillTick >= 0L && player.level().getGameTime() - openKillTick < KILL_COLLECT_MAX_TICKS;
		boolean pickingUp = target != null && target.isDeadOrDying() && (openPart != null && afterOpenKill || collector != null || ledge != null || returning);
		if (target != null && elapsed >= timeoutMs && !(pickingUp && elapsed < timeoutMs + KILL_COLLECT_MAX_TICKS * 50L))
			return endTarget(player, now, TickResult.timedOut("FIGHT_TIMED_OUT", String.format(Locale.ROOT, "%.0f s timeout reached; %s", timeoutMs / 1000.0D,
					summary(player, elapsed)), progress(player)));
		// fight_target form: below TURTLE_HEALTH the wall-in is the answer to low health while one is left (a hand-back at
		// fleeAtHealth 12 would leave the hurt body in the open with no step taken); with none left the open fight's own
		// floor and retreat apply: the open fight below runs then and owns that floor (its bailout retreats before it hands
		// back), so the hold does not hand back first. Its timeout is the check above.
		boolean openFightNext = SpawnerHold.OPEN_FIGHT && phase != Phase.HOLD && emergency == null;
		float floor = target != null && (wallInLeft(player) || openFightNext) ? -1.0F : fleeAtHealth;
		String code = SpawnerHold.handBack(new SpawnerHold.Sense(ServerFightUntilController.count(player, untilItem), untilCount, player.getHealth(),
				floor, player.getFoodData().getFoodLevel(), foodSlot(player) >= 0, elapsed, target != null ? Long.MAX_VALUE : timeoutMs, spawnerGone,
				phase == Phase.HOLD ? elapsed - lastBlazeMs : 0L, phase == Phase.HOLD || emergency != null, sitesFailed, noSiteLeft,
				phase == Phase.HOLD && SpawnerHold.breached(witherHits, player.level().getGameTime())));
		// The open fight_target reports its own kill (and collects the drop first).
		if (target != null && code == null && openPart == null) {
			long tick = player.level().getGameTime();
			if (target.isDeadOrDying() || killTick >= 0L) {
				// Killed by the hold's own fight (after a wall-in): a few seconds for the rod's pickup before the call ends.
				if (killTick < 0L) killTick = tick;
				boolean collecting = collector != null || ledge != null || returning;
				if (tick - killTick >= KILL_COLLECT_MAX_TICKS || tick - killTick >= KILL_COLLECT_TICKS && !collecting) code = "TARGET_KILLED";
			}
			else if (!target.isAlive() || target.isRemoved() || target.level() != player.level()) code = "TARGET_GONE";
		}
		if (code != null) return target != null ? endTarget(player, now, handBackResult(player, code, elapsed)) : stop(player, handBackResult(player, code, elapsed));
		// The look round for a spawner comes after the action-wide checks above (death, lava, rod count, health floor,
		// timeout), so a hurt or finished body never turns on the spot for 4 s.
		// fight_target form, open fight on: the model's own fight_target runs; once the margin is gone (the hold's own rule,
		// SpawnerHold.backToCell with no walk: health after the wall-in's 2 s of hits and the fire still burning under
		// TURTLE_HEALTH), the body walls in where it stands and heals (emergency), then fights on. No site walk: in the blaze spawner rooms the deaths came on
		// the walk to a cell site and while building it under fire.
		// A call that starts walled up in the last hold's cell heals on there and opens the doorway once healed (a blaze the
		// wall hides could not be fought from inside it).
		if (target != null && SpawnerHold.OPEN_FIGHT && !resumeChecked && phase != Phase.HOLD && openPart == null && emergency == null) {
			resumeChecked = true;
			if (resumeCell(player)) return TickResult.running(progress(player));
		}
		if (target != null && SpawnerHold.OPEN_FIGHT && phase != Phase.HOLD && emergency == null
				&& (!marginGone(player, 0.0D) || !canWallIn(player) || openPart != null && target.isDeadOrDying() && afterOpenKill)) {
			// A lull in the open fight with hunger under 18: health cannot regrow, and the default eat waits for no hostile
			// within 8 blocks, which a spawner room never has (blaze spawner rooms: bodies sat at 10 health for minutes, then
			// died to the next crowd). A player eats then: no blaze in reach, nothing hit for 2 s, no volley charging.
			if (lullBite) {
				if (eatTicks >= 0) return eat(player);
				lullBite = false;
			}
			int lullFood = foodSlot(player);
			// Hunger in these fights stays at 18-20, so the bite waits only for missing health: a meal that fills hunger to 20
			// starts vanilla's fast saturation heal.
			if (!(openPart != null && target.isDeadOrDying()) && lullFood >= 0 && player.getHealth() <= player.getMaxHealth() - LULL_MISSING_HEALTH
					&& player.getFoodData().getFoodLevel() < 20 && player.level().getGameTime() - lastLossTick > LULL_TICKS
					&& biteSafe(player) && !blazeNear(player)) {
				if (openPart != null) { openPart.cancel(player); openPart = null; }
				lullBite = true;
				lullMeals++;
				startEat(player, lullFood);
				return eat(player);
			}
			if (openPart == null) {
				try {
					// While a wall-in is left the open fight's floor stays under TURTLE_HEALTH: the wall-in answers low health.
					openPart = openTarget.apply(wallInLeft(player) ? SpawnerHold.TURTLE_HEALTH - 1.0F : null);
				} catch (dev.agaminggod.mineagen.agent.AgentDomainException lost) {
					// The named blaze went out of sight while the body healed walled in: the call ends as fight_target does for
					// a target it cannot see (the model picks the next blaze), not with an exception.
					HOLDING.remove(player.getUUID());
					return stop(player, TickResult.failed(lost.code(), lost.getMessage() + "; " + summary(player, elapsed), progress(player)));
				}
			}
			// (A kill's drop look and pickup in the open fight finish before any wall-in: the blaze is dead, the rod is near.)
			// The hold keeps the body while it can still wall in: the wall-in is its answer to low health, and a back-off reflex
			// started first walks the hurt body away under fire (review-fix jar, freeing them for the whole open fight: alive in
			// 3 of 15 blaze spawner rooms against 19 of 30). With no blocks to wall in, the open fight is the model's ordinary
			// fight and the back-off and cover reflexes are free for it.
			if (wallInLeft(player)) HOLDING.add(player.getUUID());
			else HOLDING.remove(player.getUUID());
			TickResult fought = openPart.tick(player, now);
			if (fought.state() == State.RUNNING) return fought;
			openPart.cancel(player);
			openPart = null;
			HOLDING.remove(player.getUUID());
			finished = fought;
			return fought;
		}
		if (target != null && SpawnerHold.OPEN_FIGHT && openPart != null) { openPart.cancel(player); openPart = null; }
		if (lullBite) { lullBite = false; eatTicks = -1; eatInput.release(); }
		TickResult walling = emergency(player, now, elapsed);
		if (walling != null) return walling;
		// fight_target form: no cell site walk (the open fight or the wall-in where the body stands only).
		if (target != null && SpawnerHold.OPEN_FIGHT && phase != Phase.HOLD) return TickResult.running(progress(player));
		// A melee attacker in reach is fought first, also while looking round for a spawner.
		if (!inCell || defend != null) {
			TickResult defending = defend(player, now);
			if (defending != null) return defending;
		}
		if (phase == Phase.SCAN) {
			TickResult scanning = scan(player, now, elapsed);
			if (scanning != null) return scanning;
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
			fallback = ordinaryFight(player, now, elapsed);
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
			// The open-fight engine and the look round's keys are put down too: left unticked through the defend their input
			// leases would lapse.
			stopEngine(player);
			shieldInput.release();
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
			resume(player, held);
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
		if (bestCell == null && sitesFailed == 0 && builds == 0 && siteLooks < SCAN_TICKS) {
			// Nothing seen to build on yet: look round (level, then down at the deck) and weigh the seen cells again.
			siteLooks++;
			float yaw = player.getYRot() + 360.0F / (SCAN_TICKS / 2.0F);
			float pitch = siteLooks <= SCAN_TICKS / 2 ? 20.0F : 45.0F;
			shieldInput.apply(player, new AgentInputState(0.0F, 0.0F, false, false, false, false, false, yaw, pitch,
					player.getInventory().getSelectedSlot(), InteractionHand.MAIN_HAND));
			return TickResult.running(progress(player));
		}
		if (siteLooks > 0) shieldInput.release();
		if (bestCell == null) {
			if (sitesFailed == 0 && builds == 0) {
				// No cell to build here at all: the ordinary fight runs instead of a hand-back (real fortress room: the
				// hand-back left the body standing in the open by the spawner, where it died).
				note("no seen cell 6-12 blocks from the spawner: the ordinary fight runs");
				HOLDING.remove(player.getUUID());
				cancelParts(player);
				fallbackWhy = "no seen cell 6-12 blocks from the spawner";
				fallback = ordinaryFight(player, now, lastElapsed);
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
		// A shelter that already stands needs no blocks: the body walks in and holds without any placing.
		if (needed > 0 && (blockItem == null || carried < needed))
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
		if (work == null && blockItem == null) {
			// No blocks carried and nothing to place (chooseSite): the shelter stands; no lintel without blocks either.
			lintelTicks = 0;
			skipLintel = true;
			phase = Phase.LINTEL;
			note("the shelter already stands: no blocks placed");
			return TickResult.running(progress(player));
		}
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

	private void resume(ServerPlayer player, Held held) {
		cell = held.cell();
		opening = held.opening();
		triedSites.add(cell);
		blockItem = roofing.blockItem(player);
		if (doorwayClosed(player, cell, opening, false)) {
			// Both doorway blocks: the walled-in heal; only the sill: the shield heal, the wall-in retried, opened after.
			sealed = doorwayClosed(player, cell, opening, true);
			partlySealed = !sealed;
			// Walled in and still hurt: heal on before opening (the last call ended mid-heal).
			if (player.getHealth() < SpawnerHold.TURTLE_DONE) turtleSinceMs = Math.max(0L, lastElapsed);
			else reopening = true;
		}
		note("resumed the hold in its cell " + cell.toShortString() + (sealed || partlySealed ? ", doorway walled up" : ""));
	}

	/** fight_target form: the body stands walled up in the last hold's cell; it heals on there (true) or fights (false). */
	private boolean resumeCell(ServerPlayer player) {
		Held held = LAST_HOLD.get(player.getUUID());
		if (held == null || spawner == null || !held.spawner().equals(spawner) || !player.blockPosition().equals(held.cell())
				|| !doorwayClosed(player, held.cell(), held.opening(), false)) return false;
		resume(player, held);
		enterHold(player);
		return true;
	}

	/** The doorway of {@code at} facing {@code door}: any block in it ({@code both} false), or both its blocks. */
	private static boolean doorwayClosed(ServerPlayer player, BlockPos at, Direction door, boolean both) {
		BlockPos low = at.relative(door), high = low.above();
		boolean sill = !player.level().getBlockState(low).getCollisionShape(player.level(), low).isEmpty();
		boolean window = !player.level().getBlockState(high).getCollisionShape(player.level(), high).isEmpty();
		return both ? sill && window : sill || window;
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
		if (collector != null && marginGone(player, toCell(player))) {
			collector.cancel(player);
			collector = null;
			returning = true;
			turnBack(player, "a rod trip");
		}
		if (ledge != null && collectHeldBack(player)) {
			ledge.cancel(player);
			ledge = null;
			returning = true;
			note("collect:false and a hostile near: back from the ledge to the cell");
		}
		if (ledge != null && marginGone(player, toCell(player))) {
			ledge.cancel(player);
			ledge = null;
			returning = true;
			turnBack(player, "a ledge trip");
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
			// fight_target form: the doorway is open and the open fight takes over next tick (it would drop a rod trip).
			if (target != null && phase != Phase.HOLD) return TickResult.running(progress(player));
		}
		boolean shot = ReflexSensors.blockableShot(player, 1.5D) != null;
		boolean turtling = sealed ? SpawnerHold.sealedHeal(player.getHealth(), turtleSinceMs, elapsed)
				: SpawnerHold.turtle(inCell, player.getHealth(), coverWanted || inCell && marginGone(player, 0.0D), turtleSinceMs, elapsed);
		if (inCell && !turtling) coverWanted = false;
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
				coverWanted = false;
				healStarts.add(String.format(Locale.ROOT, "%.1f", player.getHealth()));
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
				// A wall-in that failed after placing part of the doorway (the sill) is mined open after the heal, but the
				// heal stays the shield heal and the wall-in is retried while the window is open.
				BlockPos doorway = cell.relative(opening);
				boolean partly = !player.level().getBlockState(doorway).getCollisionShape(player.level(), doorway).isEmpty()
						|| !player.level().getBlockState(doorway.above()).getCollisionShape(player.level(), doorway.above()).isEmpty();
				sealed = built.state() == State.SUCCEEDED;
				partlySealed = !sealed && partly;
				note(built.state() == State.SUCCEEDED ? "walled the doorway up to heal" : "walling the doorway up failed: " + built.reasonCode() + (partly ? " (part placed)" : ""));
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
			if (sealWork != null) { sealWork.cancel(player); sealWork = null; partlySealed = true; }
			if (sealed || partlySealed) {
				partlySealed = false;
				reopening = true;
				TickResult opening = reopen(player, now);
				if (opening != null) return opening;
				if (target != null && phase != Phase.HOLD) return TickResult.running(progress(player));
			}
		}
		boolean blazeInReach = blazeNear(player);
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
				tripRods = rods;
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
		boolean marginOut = !inCell && marginGone(player, toCell(player));
		if (!SpawnerHold.OPEN_FIGHT && outOfCellTicks > OUT_OF_CELL_TICKS || marginOut) {
			if (marginOut) turnBack(player, "the open fight");
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
		// The fight_target form's timeout is its own (the check at the top of tick), not the engine's code.
		if (target != null && "FIGHT_UNTIL_TIMED_OUT".equals(stop)) return TickResult.running(progress(player));
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
		// The hold answers low health itself (the walled-in heal below TURTLE_HEALTH): the engine's own bailout stays under
		// it, or with fleeAtHealth 12+ the engine would retreat out of the cell first, then restart and repeat.
		float flee = model.has("fleeAtHealth") ? model.get("fleeAtHealth").getAsFloat() : ServerFightUntilController.DEFAULT_FLEE_AT_HEALTH;
		args.addProperty("fleeAtHealth", Math.min(flee, SpawnerHold.TURTLE_HEALTH - 1.0F));
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
			// The rods the finished trip went for: one it could not reach is not offered again (picked-up ones are gone).
			floorTried.addAll(tripRods);
			tripRods = List.of();
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

	/** A wall-in is still possible this call (blocks and tries left), whatever the footing this tick. */
	private boolean wallInLeft(ServerPlayer player) {
		if (spawner == null || emergencyFails >= EMERGENCY_TRIES) return false;
		String item = roofing.blockItem(player);
		return item != null && ServerFightUntilController.count(player, BuiltInRegistries.ITEM.getValue(Identifier.parse(item))) >= 10;
	}

	private boolean canWallIn(ServerPlayer player) {
		if (spawner == null || emergencyFails >= EMERGENCY_TRIES || !player.onGround() || player.level().getGameTime() < emergencyRetryTick) return false;
		String item = roofing.blockItem(player);
		return item != null && ServerFightUntilController.count(player, BuiltInRegistries.ITEM.getValue(Identifier.parse(item))) >= 10;
	}

	private TickResult emergency(ServerPlayer player, long now, long elapsed) {
		if (emergency == null) {
			// fight_target form (no cell walk): the same margin rule as the hold's turn-back, with the cell where the body
			// stands (round 2220d78: a fixed "below 12" began heals at 2.4-8.3 under blaze volleys and fire; the margin began
			// them at a median 16.1). fight_until form, walking to or building its planned cell: only below TURTLE_HEALTH,
			// since the margin there fired at 14-19 health on the spawner deck and the wall-in at a brink killed it (real
			// fortress room, 9fd4736: deaths 3 -> 6 of 10).
			boolean wallInNow = target != null ? marginGone(player, 0.0D) : player.getHealth() < SpawnerHold.TURTLE_HEALTH;
			if (phase == Phase.HOLD || phase == Phase.SCAN || !wallInNow || !canWallIn(player)) return null;
			String item = roofing.blockItem(player);
			cancelParts(player);
			blockItem = item;
			emergencyCell = player.blockPosition();
			emergencyOpening = SpawnerHold.facing(spawner.getX() - emergencyCell.getX(), spawner.getZ() - emergencyCell.getZ());
			emergency = roofing.seal(emergencyCell, emergencyOpening, blockItem, SEAL_MS + 4_000L, now);
			emergencies++;
			if (player.getHealth() >= SpawnerHold.TURTLE_HEALTH) marginTurns++;
			healStarts.add(String.format(Locale.ROOT, "%.1f", player.getHealth()));
			int fire = HazardExits.fireResistant(player) ? 0 : player.getRemainingFireTicks();
			note(String.format(Locale.ROOT, "health %.1f (%.1f expected once walled in) before the cell stood: walling in at %s", player.getHealth(),
					SpawnerHold.healthAtCover(player.getHealth(), 0.0D, hitLossRecent(player), fire), emergencyCell.toShortString()));
		}
		TickResult built = emergency.tick(player, now);
		if (built.state() == State.RUNNING) return TickResult.running(progress(player));
		emergency.cancel(player);
		emergency = null;
		if (built.state() != State.SUCCEEDED) {
			emergencyFails++;
			note("walling in where it stood failed (" + emergencyFails + "): " + built.reasonCode());
			emergencyRetryTick = player.level().getGameTime() + 20L;
			if ((emergencyFails >= EMERGENCY_TRIES || !wallInLeft(player)) && doorwayClosed(player, emergencyCell, emergencyOpening, false)) {
				// No tries (or too few blocks for another) left and part of the doorway placed (a blaze hovering in the window): the body would fight on boxed
				// behind its own sill. It becomes the cell and is mined open first.
				cell = emergencyCell;
				opening = emergencyOpening;
				triedSites.add(cell);
				sealed = true;
				reopening = true;
				LAST_HOLD.put(player.getUUID(), new Held(spawner, cell, opening));
				phase = Phase.HOLD;
				note("walling in gave up with part of the doorway placed: mining it open");
				return TickResult.running(progress(player));
			}
			return null;
		}
		cell = emergencyCell;
		opening = emergencyOpening;
		triedSites.add(cell);
		phase = Phase.HOLD;
		sealed = true;
		turtleSinceMs = elapsed;
		turtles++;
		LAST_HOLD.put(player.getUUID(), new Held(spawner, cell, opening));
		note("walled in at " + cell.toShortString() + " to heal; it is the cell now, doorway " + opening.getSerializedName());
		return TickResult.running(progress(player));
	}

	/** fight_target form: end now, or first open a walled-up doorway so the next call can see out (death and lava end at once). */
	private TickResult endTarget(ServerPlayer player, long now, TickResult end) {
		if (!(sealed || partlySealed || sealWork != null || emergency != null) || cell == null && emergencyCell == null) return stop(player, end);
		// Still hurt: the call ends walled in and the body heals on behind the wall, also when the wall-in's last block
		// landed this tick (its result comes a tick later). Opening first exposed a hurt body at every 15 s call's end (blaze
		// spawner rooms, review-fix jar: alive in 3 of 15 against 19 of 30 before). The next blaze fight_target or
		// fight_until from this cell heals on there and opens the doorway once healed.
		if (player.getHealth() < SpawnerHold.TURTLE_DONE) {
			BlockPos at = emergency != null || cell == null ? emergencyCell : cell;
			Direction door = emergency != null || cell == null ? emergencyOpening : opening;
			if (sealWork != null) { sealWork.cancel(player); sealWork = null; }
			if (emergency != null) { emergency.cancel(player); emergency = null; }
			if (at != null && door != null && doorwayClosed(player, at, door, false)) {
				LAST_HOLD.put(player.getUUID(), new Held(spawner, at, door));
				return stop(player, new TickResult(end.state(), end.reasonCode(), end.message() + String.format(Locale.ROOT,
						"; still walled in at %s to heal (health %.1f), doorway %s: the next blaze fight from here heals on and opens it",
						at.toShortString(), player.getHealth(), at.relative(door).toShortString()), end.progress()));
			}
			// Nothing of the doorway placed: the body can walk out, so the call ends as it stands.
			if (cell == null || !doorwayClosed(player, cell, opening, false)) return stop(player, end);
		}
		if (sealWork != null) { sealWork.cancel(player); sealWork = null; }
		if (emergency != null) {
			emergency.cancel(player);
			emergency = null;
			cell = emergencyCell;
			opening = emergencyOpening;
		}
		sealed = true;
		reopening = true;
		pendingEnd = end;
		note("ending the call: opening the doorway first");
		return closeOut(player, now);
	}

	private TickResult closeOut(ServerPlayer player, long now) {
		TickResult opening = reopen(player, now);
		if (finished != null) return finished;
		if (opening != null && sealed) return opening;
		return stop(player, pendingEnd);
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
				partlySealed = false;
				reopening = false;
				reopens++;
				note("doorway open again");
				// fight_target form: back to the open fight from here.
				if (target != null && SpawnerHold.OPEN_FIGHT) phase = Phase.SITE;
				return null;
			}
			if (player.level().getGameTime() < reopenRetryTick) return TickResult.running(progress(player));
			try {
				reopenWork = roofing.clear(player, next, REOPEN_MS);
			} catch (dev.agaminggod.mineagen.agent.AgentDomainException refused) {
				// The break gate refuses (lava behind the doorway, protection): the same as a failed mine.
				return reopenFailed(player, refused.code(), refused.getMessage());
			}
			if (reopenWork == null) return reopenFailed(player, "SHELTER_BLOCKED", "no way to mine the doorway open");
		}
		TickResult result = reopenWork.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		reopenWork.cancel(player);
		reopenWork = null;
		if (result.state() != State.SUCCEEDED) return reopenFailed(player, result.reasonCode(), result.message());
		return TickResult.running(progress(player));
	}

	/**
	 * A doorway that could not be mined open is tried again 2 s later, three times; then the hold hands back walled in
	 * with the refusal's code and its summary, rather than sitting sealed with no heal and no fight.
	 */
	private TickResult reopenFailed(ServerPlayer player, String code, String why) {
		reopenFails++;
		note("mining the doorway open failed (" + reopenFails + "): " + code);
		if (reopenFails < REOPEN_TRIES) {
			reopenRetryTick = player.level().getGameTime() + 40L;
			return TickResult.running(progress(player));
		}
		return stop(player, TickResult.failed(code, "walled in at " + cell.toShortString() + ", the doorway " + cell.relative(opening).toShortString()
				+ " could not be mined open: " + why + "; mine it, or another wall, open; " + summary(player, lastElapsed), progress(player)));
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
			if (floorTried.contains(item.getUUID()) || !ObservationVisibility.canSeeEntity(player, item) || !ServerFightUntilController.dropReachable(player, item.position())) continue;
			// On a ledge above the feet the pickup leaves it (KillDropCollector): that is a ledge trip's (ledgeRods).
			if (aboveFeet(player, item)) continue;
			double blazeNear = Math.min(nearest(blazes, item.position()), nearest(blazes, player.position()));
			int blazesNearRod = (int) blazes.stream().filter(b -> b.position().distanceTo(item.position()) <= SpawnerHold.LEDGE_BLAZE_RANGE).count();
			if (marginGone(player, item.position().distanceTo(middle))) continue;
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
			if (marginGone(player, item.position().distanceTo(middle))) continue;
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

	/** A live blaze within {@link SpawnerHold#EAT_BLAZE_CLEAR} blocks of the body: no bite then. */
	private static boolean blazeNear(ServerPlayer player) {
		return !player.level().getEntitiesOfClass(LivingEntity.class, player.getBoundingBox().inflate(SpawnerHold.EAT_BLAZE_CLEAR),
				e -> e.getType() == McEntityTypes.BLAZE && e.isAlive()).isEmpty();
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
			lastLossTick = player.level().getGameTime();
			var source = player.getLastDamageSource();
			lost.merge((source == null ? "unknown" : source.getMsgId()) + where, lastHealth - health, Float::sum);
			String kind = source == null ? "" : source.getMsgId();
			if (!kind.equals("onFire") && !kind.equals("inFire") && !kind.equals("lava"))
				recentHits.addLast(new float[] {player.level().getGameTime(), lastHealth - health});
		}
		lastHealth = health;
		// A breach is a wither skeleton's own strike in the cell, not later damage (the wither effect) still blamed on it.
		var hitBy = player.getLastDamageSource();
		if (player.hurtTime > lastHurtTime && inCell && hitBy != null && hitBy.getEntity() != null && hitBy.getDirectEntity() == hitBy.getEntity()
				&& hitBy.getEntity().getType() == McEntityTypes.WITHER_SKELETON) {
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
		sealed = false;
		partlySealed = false;
		reopening = false;
		sealTried = false;
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
			case "TARGET_KILLED" -> TickResult.succeeded(code, "Killed " + BuiltInRegistries.ENTITY_TYPE.getKey(target.getType()) + " " + target.getUUID()
					+ " from the spawner hold's cell; " + text);
			case "TARGET_GONE" -> TickResult.succeeded(code, BuiltInRegistries.ENTITY_TYPE.getKey(target.getType()) + " " + target.getUUID() + " is gone; " + text);
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
		return String.format(Locale.ROOT, "spawner hold at %s: cell %s, %d site%s failed, %d build%s; %+d %s in %.0f s; %d engine run%s %s; %d rod trip%s (%d up a ledge, %d rods from them); %d meal%s (%d in open-fight lulls); %d defend%s; %d heal%s (%d walled in, %d reopened; shield up %d of %d ticks, asked %d, using %d %s, keys %s, %d bite%s stopped for a volley); %d fire%s punched out; hurts %s; health lost %s; %d margin turn-back%s; heals began at %s%s",
				spawner == null ? "none seen" : spawner.toShortString(), cell == null ? "none" : cell.toShortString(), sitesFailed, sitesFailed == 1 ? "" : "s", builds, builds == 1 ? "" : "s",
				held - Math.max(0, startHeld), untilItemId, elapsed / 1000.0D, engineRuns, engineRuns == 1 ? "" : "s", engineEnds, trips, trips == 1 ? "" : "s", ledgeTrips, ledgeRods,
				meals, meals == 1 ? "" : "s", lullMeals, defends, defends == 1 ? "" : "s", turtles, turtles == 1 ? "" : "s", seals, reopens, blockingTicks, turtleTicks, shieldAsks, usingTicks, usedInHeal, healWinners, bitesStopped, bitesStopped == 1 ? "" : "s", firesPunched, firesPunched == 1 ? "" : "s", hurts, lostText(), marginTurns, marginTurns == 1 ? "" : "s", healStarts.isEmpty() ? "none" : String.join(", ", healStarts), log.isEmpty() ? "" : "; log: " + String.join(" | ", log.subList(Math.max(0, log.size() - 6), log.size())));
	}

	private String lostText() {
		StringBuilder text = new StringBuilder("{");
		lost.forEach((key, value) -> text.append(text.length() > 1 ? ", " : "").append(key).append('=').append(String.format(Locale.ROOT, "%.1f", value)));
		return text.append('}').toString();
	}

	private float hitLossRecent(ServerPlayer player) {
		long now = player.level().getGameTime();
		while (!recentHits.isEmpty() && now - (long) recentHits.peekFirst()[0] > SpawnerHold.HIT_RATE_TICKS) recentHits.pollFirst();
		float sum = 0.0F;
		for (float[] hit : recentHits) sum += hit[1];
		return sum;
	}

	/** Whether the margin to the cell is gone with the body this far from it (0 in the cell): see {@link SpawnerHold#backToCell(float, double, float, int)}. */
	private boolean marginGone(ServerPlayer player, double toCell) {
		int fire = HazardExits.fireResistant(player) ? 0 : player.getRemainingFireTicks();
		return SpawnerHold.backToCell(player.getHealth(), toCell, hitLossRecent(player), fire);
	}

	private double toCell(ServerPlayer player) {
		return player.position().distanceTo(Vec3.atBottomCenterOf(cell));
	}

	private void turnBack(ServerPlayer player, String from) {
		coverWanted = true;
		marginTurns++;
		int fire = HazardExits.fireResistant(player) ? 0 : player.getRemainingFireTicks();
		note(String.format(Locale.ROOT, "health %.1f on %s, %.1f expected at the cell (%.0f blocks): back to the cell", player.getHealth(), from,
				SpawnerHold.healthAtCover(player.getHealth(), toCell(player), hitLossRecent(player), fire), toCell(player)));
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
		if (emergency != null) { emergency.cancel(player); emergency = null; }
		if (openPart != null) { openPart.cancel(player); openPart = null; }
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
