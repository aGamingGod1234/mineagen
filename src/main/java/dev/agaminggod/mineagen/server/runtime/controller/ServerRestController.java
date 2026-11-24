package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.agent.AgentDomainException;
import dev.agaminggod.mineagen.compat.McCompat;
import dev.agaminggod.mineagen.server.perception.SeenTerrain;
import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.tags.ItemTags;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.Vec3;

/**
 * Model-chosen rest: gets through the night the way a player does. In a dimension with nights it sleeps in a bed when one
 * is carried or can be crafted from what is carried (3 wool of one colour and 3 planks, at a crafting table within reach,
 * a carried one, or one made from 4 more planks); sleeping also sets the spawn there. Without a bed, or when sleep is
 * refused, it walls itself in where it stands with carried blocks (build_shelter's sealed cell), or with too few blocks
 * digs a 1x2 hole and roofs it with what it dug. When neither works (no open cell beside it, a mob in the wall, a hole it
 * could not finish) it digs the two blocks under its feet, drops in and roofs over, as a player does on any diggable
 * ground. At morning it opens the walls (or digs stairs back up) and hands back.
 * Underground (more than 4 blocks of ground over its eyes) the night changes nothing, so it hands back at once and the work goes on.
 * It hands back too when stuck (no safe cell, no blocks, attacked inside) and at timeoutMs.
 */
public final class ServerRestController implements ServerController {
	public interface Environment {
		/** The carried plain full block held the most of, or null (as fight_until's roofing chooses). */
		String blockItem(ServerPlayer body);
		ServerController seal(BlockPos center, Direction opening, String itemId, long timeoutMs, long now);
		/** Breaks one block with the build_shelter clearing gates (tools, protection, lava behind). */
		ServerController clear(ServerPlayer body, BlockPos at, long timeoutMs);
		/** A crafting transaction: at the table when given, else in the inventory grid. */
		ServerController craft(ServerPlayer body, String recipeId, BlockPos table, long timeoutMs);
		Vec3 aim(ServerPlayer body, BlockPos at, Direction face, String itemId);
		/** Null when placed, else why not. */
		String place(ServerPlayer body, BlockPos at, Direction face, String itemId);
		/** A right click on the block (a bed: lie down); null when vanilla took it, else why not. */
		String use(ServerPlayer body, BlockPos at, Direction face);
		/** dig_to stairs_up to feet level {@code y}. */
		ServerController climb(ServerPlayer body, int y, long timeoutMs);
		/** travel_to the cell (feet); null when this body cannot walk. */
		default ServerController travel(ServerPlayer body, BlockPos to, long timeoutMs) { return null; }
	}

	/** Night as a player reads it: beds work (or the clock is past dusk). Morning: the clock rolled over and beds do not. */
	static final long DUSK = 12_000L;
	/** Past this the night is over even before the clock rolls to 0. */
	static final long DAWN = 18_000L;
	/** Plain blocks needed to wall in on open ground (3 sides and the sill twice over, roof scaffold, roof, window). */
	static final int SEAL_BLOCKS = 10;
	/** A hostile this near stops vanilla sleep ("monsters nearby"): the bed waits or the walls go up instead. */
	static final double MONSTER_REST_RANGE = 8.0D;
	static final long STEP_MS = 60_000L;
	/** More ground than this over the eyes is underground (a 1x2 night hole is not). */
	static final double UNDERGROUND_DEPTH = 4.0D;
	private static final Direction[] SIDES = {Direction.NORTH, Direction.EAST, Direction.SOUTH, Direction.WEST};

	private enum Phase { PLAN, LOOK, LOOK_AT, CHILD, PLACE, SLEEP, SLEEPING, WAIT, DONE }

	private final Environment environment;
	private final long deadline;
	private final long startedAt;
	private final List<String> log = new ArrayList<>();
	private final CombatInputLease input = new CombatInputLease();
	private Phase phase = Phase.PLAN;
	private ServerController child;
	private Function<TickResult, TickResult> afterChild;
	private BlockPos placeAt;
	private Direction placeFacing;
	private String placeItem;
	private Runnable afterPlace;
	private int placeTicks;
	private String placeRefusal = "";
	private BlockPos bed;
	private Direction bedFacing;
	private int sleepTicks;
	private int sleepClicks;
	private boolean bedTried;
	/** The walled cell, its opening side, and whether it is a dug hole (left by stairs) rather than walls on the ground. */
	private BlockPos shelter;
	private Direction opening;
	private boolean pit;
	/** Whether the body has looked down at the ground on each side of its feet for a hole (once per rest). */
	private boolean lookedDown;
	private int surfaceY;
	private float shelterHealth;
	private boolean slept;
	/** Health when sheltering began (building damage is reported) and when opening began (a hit there stops it). */
	private float buildHealth = Float.NaN;
	private float openHealth;
	private boolean openingUp;
	/** A hostile this near at morning keeps the walls shut and hands back. */
	static final double OPEN_CHECK = 8.0D;
	/** This action laid the body down; cancel and timeout get it up again. */
	private boolean laidDown;
	private int looked = -1;
	private Vec3 lookAt;
	private int lookTicks;
	private int lookWaited;
	private java.util.function.Supplier<TickResult> afterLook;
	/** Cells a bed or table placement was refused at (body in the way, a look that never lined up): never chosen again. */
	private final java.util.Set<BlockPos> refusedSpots = new java.util.HashSet<>();
	/** What to do when a placement is refused for {@code placeTicks}: plan another spot, or null to stop. */
	private java.util.function.Supplier<TickResult> placeRetry;
	/** The dig-down fallback runs at most once a rest. */
	private boolean dugDown;
	/** Bed and table spots are searched within this many cells of the feet (a bed this near is in vanilla sleep range). */
	static final int SPOT_RADIUS = 2;

	public ServerRestController(long timeoutMs, long now, Environment environment) {
		this.environment = environment;
		this.startedAt = now;
		this.deadline = now + timeoutMs;
	}

	@Override
	public TickResult tick(ServerPlayer player, long now) {
		if (!player.isAlive()) return finish(player, TickResult.failed("AGENT_DEAD", "Body died while resting" + facts(player), 0.0D));
		// Hurt while opening the way out: stop at once and hand back (what is open and what hit it are in the result).
		if (openingUp && player.getHealth() < openHealth - 0.5F) {
			var hitter = player.getLastHurtByMob();
			return finish(player, TickResult.succeeded("RESTED", String.format(Locale.ROOT, "Morning; hurt while opening the way out (%.1f health lost%s), so stopped at %s",
					openHealth - player.getHealth(), hitter == null ? "" : " to " + type(hitter), shelter.toShortString())
					+ "; part of the wall may be open; the next move is your call" + facts(player)));
		}
		if (now >= deadline) return finish(player, TickResult.timedOut("REST_TIMEOUT", "timeoutMs ran out before morning" + facts(player), progress(player)));
		return switch (phase) {
			case PLAN -> plan(player, now);
			case LOOK -> look(player);
			case LOOK_AT -> lookAtTick(player);
			case CHILD -> childTick(player, now);
			case PLACE -> placeTick(player);
			case SLEEP -> sleep(player, now);
			case SLEEPING -> sleeping(player, now);
			case WAIT -> waitForMorning(player, now);
			case DONE -> TickResult.running(1.0D);
		};
	}

	private TickResult plan(ServerPlayer player, long now) {
		var level = player.level();
		var bedRule = level.environmentAttributes().getValue(net.minecraft.world.attribute.EnvironmentAttributes.BED_RULE, player.blockPosition());
		if (McCompat.bedExplodes(bedRule)) {
			return finish(player, TickResult.failed("REST_NOT_HERE", "Beds explode in this dimension and it has no night to wait out; rest in the overworld" + facts(player), 0.0D));
		}
		if (underground(player)) {
			return finish(player, TickResult.succeeded("UNDERGROUND", "The body is underground: the night changes nothing down here, so keep working"
					+ " (seal the way you came if mobs follow)" + facts(player)));
		}
		long time = timeOfDay(player);
		if (!night(player)) {
			return finish(player, TickResult.failed("REST_NOT_NIGHT", String.format(Locale.ROOT, "It is day (time %d); night begins at %d, about %d s from now",
					time, DUSK, (DUSK - time) / 20L) + facts(player), 0.0D));
		}
		if (looked < SIDES.length) {
			phase = Phase.LOOK;
			return look(player);
		}
		if (!bedTried) {
			bedTried = true;
			TickResult bedStep = bedPlan(player, now);
			if (bedStep != null) return bedStep;
		}
		return shelterPlan(player, now, null);
	}

	/**
	 * A glance down to each side first, as a player looks around before building: the bed spot, the table spot and the
	 * walls are judged only from terrain the body has seen.
	 */
	private TickResult look(ServerPlayer player) {
		if (looked < 0) looked = 0;
		if (looked >= SIDES.length) { phase = Phase.PLAN; return TickResult.running(0.05D); }
		BlockPos feet = feet(player);
		Vec3 at = Vec3.atCenterOf(feet.relative(SIDES[looked], 2).below());
		if (ServerLookController.turnToward(player, at)) looked++;
		return TickResult.running(0.02D);
	}


	/** Starts the bed route (place a carried bed, or craft one first), or returns null when no bed can be had. */
	private TickResult bedPlan(ServerPlayer player, long now) {
		String carried = carriedBed(player);
		if (carried != null) return placeBed(player, carried);
		String color = woolColor(player);
		int planks = count(player, stack -> stack.is(ItemTags.PLANKS));
		if (color == null || planks < 3) {
			log.add(color == null ? "no bed and no 3 wool of one colour" : "3 " + color + " wool but only " + planks + " planks");
			return null;
		}
		String recipe = "minecraft:" + color + "_bed";
		// A bed needs a flat 2-cell spot within reach: with none, the planks are better kept as wall blocks than spent on a
		// table and a bed that cannot go down.
		if (bedSpot(player) == null) {
			TickResult walk = walkToBedGround(player, now, () -> {
				// Still no spot (or no table and too few planks) after the walk: walls, as before it.
				long after = dev.agaminggod.mineagen.server.runtime.GameClock.nowMs();
				TickResult bed = bedPlan(player, after);
				return bed != null ? bed : shelterPlan(player, after, null);
			});
			if (walk != null) return walk;
			TickResult notch = digBedNotch(player, () -> {
				long after = dev.agaminggod.mineagen.server.runtime.GameClock.nowMs();
				TickResult bed = bedPlan(player, after);
				return bed != null ? bed : shelterPlan(player, after, null);
			});
			if (notch != null) return notch;
			log.add("no flat 2-cell spot within " + SPOT_RADIUS + " blocks for a bed");
			return null;
		}
		BlockPos table = tableInReach(player);
		if (table != null) return craftBed(player, recipe, table, now);
		boolean carriedTable = count(player, stack -> stack.is(Items.CRAFTING_TABLE)) > 0;
		if (!carriedTable && planks < 7) {
			log.add("wool for a bed but " + planks + " planks: no crafting table near and not enough planks for one (7)");
			return null;
		}
		if (carriedTable) return placeTable(player, recipe);
		return runChild(() -> environment.craft(player, "minecraft:crafting_table", null, STEP_MS), result -> {
			if (result.state() != State.SUCCEEDED) { log.add("crafting a table failed: " + result.reasonCode()); return shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), null); }
			log.add("crafted a crafting table");
			return placeTable(player, recipe);
		});
	}

	/** Places the carried table on a free cell within reach that the bed spot does not need, then crafts the bed there. */
	private TickResult placeTable(ServerPlayer player, String recipe) {
		BlockPos spot = tableSpot(player, bedSpot(player));
		if (spot == null) {
			log.add("no free cell within " + SPOT_RADIUS + " blocks for a crafting table");
			return shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), null);
		}
		startPlace(spot, "minecraft:crafting_table", null, () -> {
			log.add("placed a crafting table at " + spot.toShortString());
			TickResult crafting = craftBed(player, recipe, spot, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs());
			if (crafting.state() != State.RUNNING) phase = Phase.PLAN;
		}, () -> placeTable(player, recipe));
		return TickResult.running(0.05D);
	}

	private TickResult craftBed(ServerPlayer player, String recipe, BlockPos table, long now) {
		return runChild(() -> environment.craft(player, recipe, table, STEP_MS), result -> {
			if (result.state() != State.SUCCEEDED) { log.add("crafting " + recipe + " failed: " + result.reasonCode()); return shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), null); }
			log.add("crafted " + recipe);
			String bedItem = carriedBed(player);
			return bedItem == null ? shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), null) : placeBed(player, bedItem);
		});
	}

	private TickResult placeBed(ServerPlayer player, String bedItem) {
		BedSpot spot = bedSpot(player);
		if (spot == null) {
			TickResult walk = walkToBedGround(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), () -> placeBed(player, bedItem));
			if (walk != null) return walk;
			log.add("no flat 2-cell spot within " + SPOT_RADIUS + " blocks for a bed");
			return shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), null);
		}
		bedFacing = spot.facing();
		startPlace(spot.foot(), bedItem, spot.facing(), () -> {
			bed = spot.foot();
			log.add("placed " + bedItem + " at " + spot.foot().toShortString());
			phase = Phase.SLEEP;
			sleepTicks = 0;
			sleepClicks = 0;
		}, () -> placeBed(player, bedItem));
		return TickResult.running(0.3D);
	}

	/** The notch for a bed is dug once a rest. */
	private boolean dugNotch;

	/**
	 * No bed spot near and no flat ground to walk to (a gully on a lake shore, rest-wool-3 24 Nov: 2 of 60 nights walled in
	 * or dug a hole for want of one): a player digs a two-block notch into the slope at their feet and puts the bed in it.
	 * Picks the side with ground under the first cell where the two cells at feet level and the two over them are open or
	 * diggable, the fewest digs first, digs them, then {@code then}; null when no side has one or it was dug already.
	 */
	private TickResult digBedNotch(ServerPlayer player, java.util.function.Supplier<TickResult> then) {
		if (dugNotch) return null;
		BlockPos feet = feet(player);
		List<BlockPos> best = null;
		for (Direction side : SIDES) {
			BlockPos foot = feet.relative(side), head = foot.relative(side);
			if (!solid(player, foot.below()) || refusedSpots.contains(foot) || refusedSpots.contains(head)) continue;
			List<BlockPos> digs = new ArrayList<>();
			boolean fits = true;
			for (BlockPos cell : List.of(head.above(), foot.above(), head, foot)) {
				if (open(player, cell)) continue;
				if (!diggable(player, cell)) { fits = false; break; }
				digs.add(cell);
			}
			if (fits && !digs.isEmpty() && (best == null || digs.size() < best.size())) best = digs;
		}
		if (best == null) return null;
		dugNotch = true;
		log.add("no flat 2-cell spot within " + SPOT_RADIUS + " blocks: digging a bed notch of " + best.size() + " block(s) into the slope");
		return digCells(player, best, 0, then);
	}

	private TickResult digCells(ServerPlayer player, List<BlockPos> cells, int index, java.util.function.Supplier<TickResult> then) {
		if (index >= cells.size()) return then.get();
		BlockPos cell = cells.get(index);
		return runChild(() -> environment.clear(player, cell, STEP_MS), dug -> {
			if (dug.state() != State.SUCCEEDED) {
				log.add("digging the bed notch at " + cell.toShortString() + " failed: " + dug.reasonCode());
				long after = dev.agaminggod.mineagen.server.runtime.GameClock.nowMs();
				TickResult bed = bedPlan(player, after);
				return bed != null ? bed : shelterPlan(player, after, null);
			}
			return digCells(player, cells, index + 1, then);
		});
	}

	/** How far the body walks for flat ground to put a bed on when none is beside it. */
	static final int WALK_RADIUS = 8;
	static final long WALK_MS = 20_000L;
	/** The walk to bed ground happens once a rest. */
	private boolean walkedForBed;

	/**
	 * No flat 2-cell spot beside the body (it stands on a slope, a shore, in shallow water): a player walks a few blocks to
	 * flat dry ground and puts the bed down there rather than walling in where they stand. Starts the walk to the nearest
	 * seen dry cell within {@link #WALK_RADIUS} with a flat 2-cell spot running off it, then {@code then}; null when there
	 * is none, the walk was made already, or this body cannot walk. Rest rooms on seed 20261107: 4 of 20 starts by a lake
	 * had no spot within 2 blocks, and the walls the plan fell back to ran out of planks or hit water (REST_STUCK).
	 */
	private TickResult walkToBedGround(ServerPlayer player, long now, java.util.function.Supplier<TickResult> then) {
		if (walkedForBed) return null;
		BlockPos stand = bedGround(player);
		if (stand == null) return null;
		ServerController walk = environment.travel(player, stand, Math.min(WALK_MS, Math.max(1_000L, deadline - now)));
		if (walk == null) return null;
		walkedForBed = true;
		return runChild(() -> walk, result -> {
			log.add((result.state() == State.SUCCEEDED ? "walked to flat ground at " : "walk to flat ground at ") + stand.toShortString()
					+ (result.state() == State.SUCCEEDED ? "" : " failed: " + result.reasonCode()));
			return then.get();
		});
	}

	/** The nearest seen dry standing cell within {@link #WALK_RADIUS} with a flat 2-cell bed spot beside it, or null. */
	private BlockPos bedGround(ServerPlayer player) {
		BlockPos feet = feet(player);
		BlockPos best = null;
		int bestScore = Integer.MAX_VALUE;
		for (int dx = -WALK_RADIUS; dx <= WALK_RADIUS; dx++) {
			for (int dz = -WALK_RADIUS; dz <= WALK_RADIUS; dz++) {
				for (int dy = -2; dy <= 2; dy++) {
					int score = (dx * dx + dz * dz) * 4 + Math.abs(dy) * 2;
					if (score >= bestScore || dx * dx + dz * dz > WALK_RADIUS * WALK_RADIUS) continue;
					BlockPos stand = feet.offset(dx, dy, dz);
					if (!open(player, stand) || !open(player, stand.above()) || !solid(player, stand.below())) continue;
					for (Direction side : SIDES) {
						BlockPos foot = stand.relative(side), head = foot.relative(side);
						if (bedFits(player, new BedSpot(foot, side), false)) {
							bestScore = score;
							best = stand;
							break;
						}
					}
				}
			}
		}
		return best;
	}

	/** A bed's foot cell and the way its head points (the body's facing when it clicks the foot cell). */
	record BedSpot(BlockPos foot, Direction facing) {
		BlockPos head() { return foot.relative(facing); }
	}

	/**
	 * Foot offsets (dx, dz) within {@link #SPOT_RADIUS} whose direction from the body is clearly one side, nearest first: the
	 * body faces that side when it clicks the foot cell, so the head goes one further that way (vanilla bed placement).
	 */
	static List<int[]> bedOffsets() {
		List<int[]> offsets = new ArrayList<>();
		for (int dx = -SPOT_RADIUS; dx <= SPOT_RADIUS; dx++)
			for (int dz = -SPOT_RADIUS; dz <= SPOT_RADIUS; dz++)
				if (Math.abs(dx) != Math.abs(dz)) offsets.add(new int[] {dx, dz});
		offsets.sort((a, b) -> Integer.compare(a[0] * a[0] + a[1] * a[1], b[0] * b[0] + b[1] * b[1]));
		return offsets;
	}

	/** The side an offset lies on (its larger axis), for an offset whose axes differ in size. */
	static Direction sideOf(int dx, int dz) {
		return Math.abs(dx) > Math.abs(dz) ? (dx > 0 ? Direction.EAST : Direction.WEST) : (dz > 0 ? Direction.SOUTH : Direction.NORTH);
	}

	/**
	 * The nearest flat 2-cell spot the body has seen within {@link #SPOT_RADIUS} (feet level or one step up or down), clear of
	 * its own body and of refused cells, or null. Only the cells right beside the feet were tried before, so a flower, a
	 * slope or a trunk on each side left the body without a bed on open ground (rest rooms 23 Nov).
	 */
	private BedSpot bedSpot(ServerPlayer player) {
		BlockPos feet = feet(player);
		Direction preferred = player.getDirection();
		BedSpot best = null;
		int bestScore = Integer.MAX_VALUE;
		for (int[] offset : bedOffsets()) {
			Direction facing = sideOf(offset[0], offset[1]);
			for (int dy : new int[] {0, -1, 1}) {
				BedSpot spot = new BedSpot(feet.offset(offset[0], dy, offset[1]), facing);
				if (!bedFits(player, spot, true)) continue;
				// Nearest first; at equal distance, level ground and the way the body already faces.
				int score = (offset[0] * offset[0] + offset[1] * offset[1]) * 4 + Math.abs(dy) * 2 + (facing == preferred ? 0 : 1);
				if (score < bestScore) { bestScore = score; best = spot; }
			}
		}
		return best;
	}

	/**
	 * Whether a bed fits at {@code spot} as vanilla takes one: the foot on seen solid ground (the placement click lands on
	 * its top), the head an open cell that needs nothing under it, and no suffocating block over either half, which vanilla
	 * refuses as obstructed before it sets the spawn. Rest rooms 24 Nov: of 60 rest-wool-3 nights, 3 beds went down and
	 * refused sleep with the spawn unchanged, and 2 found no spot with ground under both halves on slopes and shores.
	 * {@code clearOfBody}: the body's own cells are refused (it stands beside the bed it places).
	 */
	private boolean bedFits(ServerPlayer player, BedSpot spot, boolean clearOfBody) {
		BlockPos foot = spot.foot(), head = spot.head();
		if (refusedSpots.contains(foot) || refusedSpots.contains(head)) return false;
		if (clearOfBody ? !freeSpot(player, foot) : !(open(player, foot) && solid(player, foot.below()))) return false;
		if (!open(player, head) || clearOfBody && player.getBoundingBox().inflate(0.1D).intersects(new net.minecraft.world.phys.AABB(head))) return false;
		return headroom(player, foot.above()) && headroom(player, head.above());
	}

	/** No seen suffocating block in {@code at} (vanilla's free-above test for a bed); an unseen cell is not held against it. */
	private static boolean headroom(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		return state == null || !state.isSuffocating(player.level(), at);
	}

	/** An open, seen cell on solid seen ground, clear of the body and not refused before. */
	private boolean freeSpot(ServerPlayer player, BlockPos at) {
		return !refusedSpots.contains(at) && open(player, at) && solid(player, at.below())
				&& !player.getBoundingBox().inflate(0.1D).intersects(new net.minecraft.world.phys.AABB(at));
	}

	private TickResult sleep(ServerPlayer player, long now) {
		sleepTicks++;
		Mob monster = monsterNear(player, bed);
		if (monster != null) {
			// Vanilla refuses sleep with a monster this near; give it a few seconds to pass, then wall in beside the bed.
			if (sleepTicks < 100) return TickResult.running(0.4D);
			log.add("could not sleep: " + type(monster) + " within " + (int) MONSTER_REST_RANGE + " blocks");
			return shelterPlan(player, now, bedFacing);
		}
		// A click that does not lay the body down is tried again on the other half and on the side facing the body, as a
		// player clicks another part of a bed that did not answer (rest-wool-3: a top face out of the eye's sight).
		BlockPos[] cells = {bed, bed.relative(bedFacing)};
		BlockPos cell = cells[sleepClicks / 2 % 2];
		Direction face = sleepClicks % 2 == 0 ? Direction.UP : Direction.getApproximateNearest(
				player.getEyePosition().x - (cell.getX() + 0.5D), 0.0D, player.getEyePosition().z - (cell.getZ() + 0.5D));
		Vec3 target = face == Direction.UP ? Vec3.atCenterOf(cell).add(0.0D, 0.06D, 0.0D)
				: Vec3.atCenterOf(cell).add(face.getStepX() * 0.5D, -0.2D, face.getStepZ() * 0.5D);
		if (!ServerLookController.turnToward(player, target)) return TickResult.running(0.4D);
		String why;
		try { why = environment.use(player, cell, face); }
		catch (AgentDomainException refused) { why = refused.code() + ": " + refused.getMessage(); }
		sleepClicks++;
		if (why == null && player.isSleeping()) {
			laidDown = true;
			log.add("lay down in the bed (spawn set there)");
			phase = Phase.SLEEPING;
			return TickResult.running(0.5D);
		}
		if (sleepTicks < 60) return TickResult.running(0.4D);
		log.add("the bed refused sleep: " + (why == null ? "not sleeping after the click" : why) + bedCheck(player));
		return shelterPlan(player, now, bedFacing);
	}

	/** Vanilla's two checks before the spawn is set, as the body would read them: the bed in reach, and room over it. */
	private String bedCheck(ServerPlayer player) {
		BlockPos head = bed.relative(bedFacing);
		boolean reach = inBedReach(player, bed) || inBedReach(player, head);
		boolean room = headroom(player, bed.above()) && headroom(player, head.above());
		return " (" + (reach ? "in reach" : "out of reach") + ", " + (room ? "room over it" : "a block over it") + ")";
	}

	private static boolean inBedReach(ServerPlayer player, BlockPos at) {
		Vec3 bottom = Vec3.atBottomCenterOf(at);
		return Math.abs(player.getX() - bottom.x) <= 3.0D && Math.abs(player.getY() - bottom.y) <= 2.0D && Math.abs(player.getZ() - bottom.z) <= 3.0D;
	}

	private TickResult sleeping(ServerPlayer player, long now) {
		if (player.isSleeping()) return TickResult.running(progress(player));
		if (morning(player)) {
			slept = true;
			return finish(player, TickResult.succeeded("RESTED", "Slept through the night in the bed at " + bed.toShortString()
					+ "; the spawn point is set there" + facts(player)));
		}
		log.add("woke before morning (health " + String.format(Locale.ROOT, "%.1f", player.getHealth()) + ")");
		return shelterPlan(player, now, bedFacing);
	}


	private TickResult shelterPlan(ServerPlayer player, long now, Direction avoid) {
		if (Float.isNaN(buildHealth)) buildHealth = player.getHealth();
		BlockPos feet = feet(player);
		surfaceY = feet.getY();
		String item = environment.blockItem(player);
		int blocks = item == null ? 0 : count(player, stack -> BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(item));
		// The plan builds the side opposite its opening first: open away from the nearest hostile so its side goes up first
		// (rest fixture: 3 damage from zombies and a skeleton 12-14 blocks off while the far side went up first).
		Mob nearest = nearestHostile(player);
		Direction away = avoid != null ? avoid : nearest != null
				? Direction.getApproximateNearest(player.getX() - nearest.getX(), 0.0D, player.getZ() - nearest.getZ())
				: player.getDirection().getOpposite();
		if (avoid == null && blocks >= SEAL_BLOCKS) return seal(player, feet, away, item, now);
		Direction side = holeSide(player, feet, away);
		// Looking ahead, the ground beside the feet is below the view (about 58 degrees down), so it is unseen and no side
		// can be judged (night rooms 22 Nov: "no shelter possible" with an empty inventory on dirt). A player glances
		// down first: look at each side's ground once, then plan again.
		if (side == null && !lookedDown) {
			lookedDown = true;
			Direction last = avoid;
			return lookDown(player, feet, 0, () -> shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), last));
		}
		if (side != null) {
			pit = true;
			log.add("digging a 1x2 hole beside the body (" + blocks + " plain blocks carried)");
			return digHole(player, feet.relative(side), away);
		}
		if (item != null && blocks >= 4) return seal(player, feet, away, item, now);
		return digDown(player, away, "no open cell beside the body to dig a hole in and " + blocks + " plain blocks carried (" + SEAL_BLOCKS + " wall in on open ground)");
	}

	/**
	 * The shelter a player always has on diggable ground: dig the block under the feet, drop in, dig the next, drop in,
	 * and roof over with what was dug. It needs only the ground the body stands on, which it touches, so nothing beside
	 * it (flowers, a slope, a mob in a wall cell) can block it. Runs once a rest; {@code why} says what failed before it.
	 */
	private TickResult digDown(ServerPlayer player, Direction away, String why) {
		if (dugDown) return stuck(player, why);
		dugDown = true;
		BlockPos start = feet(player);
		surfaceY = start.getY();
		log.add(why + "; digging down 2 where it stands");
		// Off the middle of its cell the 0.6-wide body still rests on the next block and never drops into the dug one.
		if (Math.abs(start.getX() + 0.5D - player.getX()) <= 0.15D && Math.abs(start.getZ() + 0.5D - player.getZ()) <= 0.15D) return digDownStep(player, start, 1, away);
		return runChild(() -> new ServerNavigationController(Vec3.atBottomCenterOf(start), 0.15D, false, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), 3_000L, false),
				centred -> digDownStep(player, start, 1, away));
	}

	private TickResult digDownStep(ServerPlayer player, BlockPos start, int depth, Direction away) {
		BlockPos target = start.below(depth);
		if (!diggable(player, target)) return stuck(player, "could not dig down: under the body is " + describeBelow(player, target));
		// Never dig a block over an open or fluid cell the body knows of (a cave roof one block thick).
		BlockPos floor = target.below();
		if (SeenTerrain.of(player).known(floor.getX(), floor.getY(), floor.getZ()) != null && !solid(player, floor)) {
			return stuck(player, "could not dig down: under " + target.toShortString() + " is " + describeBelow(player, floor));
		}
		return runChild(() -> environment.clear(player, target, STEP_MS), dug -> {
			if (dug.state() != State.SUCCEEDED) return stuck(player, "could not dig down: " + dug.reasonCode() + " " + dug.message());
			return runChild(() -> dropInto(target), dropped -> {
				if (dropped.state() != State.SUCCEEDED) return stuck(player, "dug " + target.toShortString() + " but did not drop into it: " + dropped.message());
				if (depth < 2) return digDownStep(player, start, depth + 1, away);
				pit = true;
				log.add("dug down to " + target.toShortString());
				return roofHole(player, away);
			});
		});
	}

	/** Succeeds once the feet stand in {@code cell} on the ground, fails at once below it (a hidden drop) or after 2 s. */
	private static ServerController dropInto(BlockPos cell) {
		int[] ticks = {0};
		return (player, now) -> {
			if (feet(player).getY() < cell.getY()) return TickResult.failed("FELL_THROUGH", "fell below the dug cell into a hidden drop", 0.0D);
			if (player.onGround() && feet(player).equals(cell)) return TickResult.succeeded("DROPPED", "in the hole");
			return ++ticks[0] > 40 ? TickResult.failed("NOT_DROPPED", "still above the hole", 0.0D) : TickResult.running(0.1D);
		};
	}

	private TickResult lookDown(ServerPlayer player, BlockPos feet, int index, java.util.function.Supplier<TickResult> then) {
		if (index >= SIDES.length) return then.get();
		return lookThen(feet.relative(SIDES[index]).below(), () -> lookDown(player, feet, index + 1, then));
	}

	private static Direction holeSide(ServerPlayer player, BlockPos feet, Direction away) {
		for (int turn = 0; turn < 4; turn++) {
			Direction side = SIDES[(indexOf(away) + turn) % 4];
			BlockPos cell = feet.relative(side);
			if (open(player, cell) && open(player, cell.above()) && diggable(player, cell.below())) return side;
		}
		return null;
	}

	/** Digs the column at {@code top}'s two blocks below, judging each from what the body sees, then steps down into it. */
	private TickResult digHole(ServerPlayer player, BlockPos top, Direction away) {
		BlockPos first = top.below(), second = top.below(2), floor = top.below(3);
		return runChild(() -> environment.clear(player, first, STEP_MS), dug -> {
			if (dug.state() != State.SUCCEEDED) return holeFailed(player, away, dug);
			return lookThen(second, () -> {
				String below = describeBelow(player, second);
				if (!diggable(player, second)) return stuck(player, "under the dug cell " + first.toShortString() + " is " + below
						+ ": not digging toward a drop; wall in with 10 or more plain blocks, or rest somewhere with solid ground");
				return runChild(() -> environment.clear(player, second, STEP_MS), dug2 -> {
					if (dug2.state() != State.SUCCEEDED) return holeFailed(player, away, dug2);
					return lookThen(floor, () -> {
						// From beside a 1-wide hole the body's own block hides the hole's floor, so it is nearly always unseen
						// (from-scratch game 13: rest refused every night hole at 1.3 health with an empty inventory). A player
						// digs two down and steps in; only a floor known to be open or fluid is a drop.
						boolean unseen = SeenTerrain.of(player).known(floor.getX(), floor.getY(), floor.getZ()) == null;
						if (!unseen && !solid(player, floor)) return stuck(player, "under the hole at " + second.toShortString() + " is "
								+ describeBelow(player, floor) + ": not stepping into a drop; wall in with 10 or more plain blocks, or rest on solid ground");
						log.add("hole dug to " + second.toShortString() + (unseen ? " (its floor hidden from beside it)" : " over solid " + describeBelow(player, floor)));
						return runChild(() -> new ServerNavigationController(Vec3.atBottomCenterOf(second), 0.35D, false, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), STEP_MS, false),
								stepped -> stepped.state() == State.SUCCEEDED || feet(player).equals(second) ? roofHole(player, away)
										: digDown(player, away, "could not step into the hole: " + stepped.reasonCode() + " " + stepped.message()));
					});
				});
			});
		});
	}

	/**
	 * A refused side-hole dig falls back to digging down where the body stands, except for lava seen behind the cell: the
	 * body's own column is beside that lava, and from inside a 1-wide hole the eye no longer sees it.
	 */
	private TickResult holeFailed(ServerPlayer player, Direction away, TickResult dug) {
		String why = "could not dig the hole: " + dug.reasonCode() + " " + dug.message();
		if ("LAVA_BEHIND".equals(dug.reasonCode())) return stuck(player, why + "; not digging down beside lava");
		return digDown(player, away, why);
	}

	/** What the body knows of a cell: its block, "an open drop", a fluid, or "unseen". */
	private static String describeBelow(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		if (state == null) return "unseen ground at " + at.toShortString();
		if (!state.getFluidState().isEmpty()) return BuiltInRegistries.BLOCK.getKey(state.getBlock()) + " at " + at.toShortString();
		if (state.canBeReplaced()) return "an open drop at " + at.toShortString();
		return BuiltInRegistries.BLOCK.getKey(state.getBlock()) + " at " + at.toShortString();
	}

	/** Turns to look at the top of {@code at} (so the body sees it), then continues. */
	private TickResult lookThen(BlockPos at, java.util.function.Supplier<TickResult> then) {
		lookAt = Vec3.atCenterOf(at).add(0.0D, 0.5D, 0.0D);
		lookTicks = 0;
		lookWaited = 0;
		afterLook = then;
		phase = Phase.LOOK_AT;
		return TickResult.running(0.2D);
	}

	private TickResult lookAtTick(ServerPlayer player) {
		boolean aligned = ServerLookController.turnToward(player, lookAt);
		// Once on it, hold the view 3 ticks so the cell is registered as seen; give up turning after 2 s.
		if ((aligned && ++lookTicks >= 3) || ++lookWaited > 40) {
			lookWaited = 0;
			phase = Phase.PLAN;
			var then = afterLook;
			afterLook = null;
			return then.get();
		}
		return TickResult.running(0.2D);
	}

	private TickResult roofHole(ServerPlayer player, Direction away) {
		String dug = environment.blockItem(player);
		if (dug == null) return stuck(player, "no block to roof the hole with");
		return seal(player, feet(player), away, dug, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs());
	}

	private TickResult seal(ServerPlayer player, BlockPos center, Direction openingSide, String item, long now) {
		shelter = center;
		opening = openingSide;
		log.add((pit ? "roofing the hole at " : "walling in at ") + center.toShortString() + " with " + item);
		return runChild(() -> environment.seal(center, openingSide, item, STEP_MS, now), result -> {
			if (result.state() != State.SUCCEEDED) {
				String why = "walling in failed: " + result.reasonCode() + " " + result.message();
				// Walls on open ground can be blocked (a mob in a wall cell, no standing spot); the ground under the feet is still there.
				return pit ? stuck(player, why) : digDown(player, openingSide, why);
			}
			shelterHealth = player.getHealth();
			if (buildHealth - shelterHealth >= 0.5F) log.add(String.format(Locale.ROOT, "lost %.1f health while building", buildHealth - shelterHealth));
			phase = Phase.WAIT;
			return TickResult.running(progress(player));
		});
	}

	private TickResult waitForMorning(ServerPlayer player, long now) {
		if (player.getHealth() < shelterHealth - 1.0F && player.getLastHurtByMob() != null
				&& player.tickCount - player.getLastHurtByMobTimestamp() < 40) {
			return stuck(player, "attacked inside the shelter by " + type(player.getLastHurtByMob()));
		}
		shelterHealth = Math.max(shelterHealth, player.getHealth());
		if (!morning(player)) return TickResult.running(progress(player));
		input.release();
		// Opening onto a waiting mob, or at low health, is the model's call: say what is outside and hand back closed.
		String outside = hostilesOutside(player);
		if (outside != null || player.getHealth() < CorneredStand.LOW_HEALTH) {
			return finish(player, TickResult.succeeded("RESTED", "Morning; still " + (pit ? "in the roofed hole" : "walled in") + " at "
					+ shelter.toShortString() + ", not opened: " + (outside != null ? outside : "no hostile near")
					+ String.format(Locale.ROOT, "; health %.1f", player.getHealth()) + (player.getHealth() < CorneredStand.LOW_HEALTH ? " (low)" : "")
					+ "; opening is your call" + facts(player)));
		}
		openingUp = true;
		openHealth = player.getHealth();
		if (pit) {
			log.add("morning: digging stairs back up to y " + surfaceY);
			return runChild(() -> environment.climb(player, surfaceY, STEP_MS), result -> rested(player, result));
		}
		BlockPos window = shelter.relative(opening).above(), sill = shelter.relative(opening);
		log.add("morning: opening the " + opening.getSerializedName() + " wall");
		return runChild(() -> environment.clear(player, window, STEP_MS), first ->
				runChild(() -> environment.clear(player, sill, STEP_MS), second -> rested(player, second)));
	}

	/** Hostile mobs within {@link #OPEN_CHECK} blocks of the body, nearest first, as "zombie 3.2 blocks N", or null. */
	private static String hostilesOutside(ServerPlayer player) {
		List<Mob> near = new ArrayList<>(player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(OPEN_CHECK),
				mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player) && player.distanceTo(mob) <= OPEN_CHECK));
		if (near.isEmpty()) return null;
		near.sort((a, b) -> Double.compare(player.distanceTo(a), player.distanceTo(b)));
		List<String> rows = new ArrayList<>();
		for (Mob mob : near) rows.add(String.format(Locale.ROOT, "%s %.1f blocks %s", type(mob), player.distanceTo(mob),
				Direction.getApproximateNearest(mob.getX() - player.getX(), 0.0D, mob.getZ() - player.getZ()).getSerializedName()));
		return String.join(", ", rows);
	}

	private TickResult rested(ServerPlayer player, TickResult opened) {
		String how = opened.state() == State.SUCCEEDED ? "opened the way out" : "could not open the way out (" + opened.reasonCode() + "); dig out yourself";
		return finish(player, TickResult.succeeded("RESTED", "Waited out the night " + (pit ? "in a roofed hole" : "walled in") + " at "
				+ shelter.toShortString() + "; " + how + facts(player)));
	}


	/**
	 * Starts a step and continues with its result. A step refused at its start or on a tick (a target hidden by leaves,
	 * a protected plant) is a failed result for the plan to answer, not the end of the rest (rest rooms 23 Nov: a table
	 * hidden from an eye inside a dark oak canopy ended the rest with TARGET_NOT_VISIBLE and nothing built).
	 */
	private TickResult runChild(java.util.function.Supplier<ServerController> start, Function<TickResult, TickResult> then) {
		ServerController controller;
		try { controller = start.get(); }
		catch (AgentDomainException refused) { TickResult failed = TickResult.failed(refused.code(), refused.getMessage(), 0.0D); controller = (player, now) -> failed; }
		child = controller;
		afterChild = then;
		phase = Phase.CHILD;
		return TickResult.running(0.1D);
	}

	private TickResult childTick(ServerPlayer player, long now) {
		TickResult result;
		try { result = child.tick(player, now); }
		catch (AgentDomainException refused) { result = TickResult.failed(refused.code(), refused.getMessage(), 0.0D); }
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		child.cancel(player);
		child = null;
		Function<TickResult, TickResult> then = afterChild;
		afterChild = null;
		phase = Phase.PLAN;
		return then.apply(result);
	}

	private void startPlace(BlockPos at, String item, Direction facing, Runnable then, java.util.function.Supplier<TickResult> retry) {
		placeRetry = retry;
		placeAt = at;
		placeFacing = facing;
		placeItem = item;
		afterPlace = then;
		placeTicks = 0;
		phase = Phase.PLACE;
	}

	/** Turns to the placement like a player (facing the bed's way for a bed), then one vanilla placement click. */
	private TickResult placeTick(ServerPlayer player) {
		if (++placeTicks > 80) {
			String why = "could not place " + placeItem + " at " + placeAt.toShortString() + ": " + placeRefusal;
			// One refused cell (the body drifted into it, a look that never lined up) is not the end: try the next spot.
			if (placeRetry == null || refusedSpots.size() >= 4) return stuck(player, why);
			refusedSpots.add(placeAt);
			log.add(why + "; trying another spot");
			var retry = placeRetry;
			placeRetry = null;
			phase = Phase.PLAN;
			return retry.get();
		}
		Vec3 aim;
		try { aim = environment.aim(player, placeAt, Direction.UP, placeItem); }
		catch (AgentDomainException refused) { placeRefusal = refused.code() + ": " + refused.getMessage(); aim = Vec3.atCenterOf(placeAt.below()).add(0.0D, 0.5D, 0.0D); }
		if (!ServerLookController.turnToward(player, aim)) return TickResult.running(0.3D);
		if (placeFacing != null && player.getDirection() != placeFacing) return TickResult.running(0.3D);
		try {
			String why = environment.place(player, placeAt, Direction.UP, placeItem);
			if (why != null) { placeRefusal = why; return TickResult.running(0.3D); }
		} catch (AgentDomainException refused) {
			placeRefusal = refused.code() + ": " + refused.getMessage();
			return TickResult.running(0.3D);
		}
		phase = Phase.PLAN;
		Runnable then = afterPlace;
		afterPlace = null;
		then.run();
		return TickResult.running(0.4D);
	}

	private TickResult stuck(ServerPlayer player, String why) {
		return finish(player, TickResult.failed("REST_STUCK", why + facts(player), progress(player)));
	}

	private TickResult finish(ServerPlayer player, TickResult result) {
		cancel(player);
		phase = Phase.DONE;
		return result;
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (child != null) child.cancel(player);
		child = null;
		input.release();
		// A cancelled or timed-out rest must not leave the body asleep in a bed it lay down in (as a player gets up).
		if (laidDown && player.isSleeping()) player.stopSleepInBed(false, true);
		laidDown = false;
	}


	private String facts(ServerPlayer player) {
		return String.format(Locale.ROOT, "; time %d; health %.1f; %s; %.0f s", timeOfDay(player), player.getHealth(),
				log.isEmpty() ? "nothing done" : String.join("; ", log), (dev.agaminggod.mineagen.server.runtime.GameClock.nowMs() - startedAt) / 1000.0D);
	}

	private double progress(ServerPlayer player) {
		long time = timeOfDay(player);
		return time >= DUSK ? Math.min(0.99D, (time - DUSK) / 12_000.0D) : 0.99D;
	}

	static boolean underground(ServerPlayer player) {
		int surface = player.level().getHeight(net.minecraft.world.level.levelgen.Heightmap.Types.MOTION_BLOCKING_NO_LEAVES,
				net.minecraft.util.Mth.floor(player.getX()), net.minecraft.util.Mth.floor(player.getZ()));
		return surface - player.getEyeY() > UNDERGROUND_DEPTH;
	}

	static long timeOfDay(ServerPlayer player) {
		return Math.floorMod(player.level().getDefaultClockTime(), 24_000L);
	}

	private static boolean canSleep(ServerPlayer player) {
		var level = player.level();
		return level.environmentAttributes().getValue(net.minecraft.world.attribute.EnvironmentAttributes.BED_RULE, player.blockPosition()).canSleep(level);
	}

	static boolean night(ServerPlayer player) {
		return canSleep(player) || timeOfDay(player) >= DUSK;
	}

	static boolean morning(ServerPlayer player) {
		long time = timeOfDay(player);
		return !canSleep(player) && (time < DUSK || time >= DAWN);
	}

	private static BlockPos feet(ServerPlayer player) {
		return BlockPos.containing(player.getX(), player.getY() + 0.2D, player.getZ());
	}

	private static String carriedBed(ServerPlayer player) {
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.is(ItemTags.BEDS)) return BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
		}
		return null;
	}

	/** The colour of 3 or more wool blocks of one colour, or null (a bed takes 3 of the same colour). */
	private static String woolColor(ServerPlayer player) {
		java.util.Map<String, Integer> wool = new java.util.HashMap<>();
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.is(ItemTags.WOOL)) continue;
			String path = BuiltInRegistries.ITEM.getKey(stack.getItem()).getPath();
			if (path.endsWith("_wool")) wool.merge(path.substring(0, path.length() - "_wool".length()), stack.getCount(), Integer::sum);
		}
		return wool.entrySet().stream().filter(entry -> entry.getValue() >= 3).max(java.util.Map.Entry.comparingByValue()).map(java.util.Map.Entry::getKey).orElse(null);
	}

	private static int count(ServerPlayer player, java.util.function.Predicate<ItemStack> wanted) {
		int total = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && wanted.test(stack)) total += stack.getCount();
		}
		return total;
	}

	/** A crafting table the body has seen within reach of its eyes, or null. */
	private static BlockPos tableInReach(ServerPlayer player) {
		BlockPos eye = BlockPos.containing(player.getEyePosition());
		var seen = SeenTerrain.of(player);
		BlockPos best = null;
		double nearest = Double.POSITIVE_INFINITY;
		for (BlockPos at : BlockPos.betweenClosed(eye.offset(-4, -4, -4), eye.offset(4, 3, 4))) {
			BlockState state = seen.known(at.getX(), at.getY(), at.getZ());
			if (state == null || !state.is(Blocks.CRAFTING_TABLE) || !player.isWithinBlockInteractionRange(at, 0.0D)) continue;
			double distance = at.distToCenterSqr(player.getEyePosition());
			if (distance < nearest) { nearest = distance; best = at.immutable(); }
		}
		return best;
	}

	/** The nearest free cell within {@link #SPOT_RADIUS} for a crafting table, not one the bed spot needs, or null. */
	private BlockPos tableSpot(ServerPlayer player, BedSpot bedSpot) {
		BlockPos feet = feet(player);
		BlockPos best = null;
		int bestScore = Integer.MAX_VALUE;
		for (int dx = -SPOT_RADIUS; dx <= SPOT_RADIUS; dx++)
			for (int dz = -SPOT_RADIUS; dz <= SPOT_RADIUS; dz++)
				for (int dy : new int[] {0, -1, 1}) {
					if (dx == 0 && dz == 0) continue;
					BlockPos at = feet.offset(dx, dy, dz);
					if (bedSpot != null && (at.equals(bedSpot.foot()) || at.equals(bedSpot.head()))) continue;
					if (!freeSpot(player, at)) continue;
					int score = (dx * dx + dz * dz) * 4 + Math.abs(dy);
					if (score < bestScore) { bestScore = score; best = at; }
				}
		return best;
	}

	private static int indexOf(Direction side) {
		for (int index = 0; index < SIDES.length; index++) if (SIDES[index] == side) return index;
		return 0;
	}

	private static boolean open(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		return state != null && state.canBeReplaced() && state.getFluidState().isEmpty()
				&& player.level().getEntitiesOfClass(net.minecraft.world.entity.LivingEntity.class, new net.minecraft.world.phys.AABB(at)).isEmpty();
	}

	private static boolean solid(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		return state != null && state.isCollisionShapeFullBlock(player.level(), at);
	}

	/** A seen full block a player can dig out to stand in: no fluid, no block entity, not bedrock or leaves, nothing that falls. */
	private static boolean diggable(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		return state != null && state.isCollisionShapeFullBlock(player.level(), at) && !state.hasBlockEntity() && !state.is(Blocks.BEDROCK)
				&& !state.is(net.minecraft.tags.BlockTags.LEAVES)
				&& !(state.getBlock() instanceof net.minecraft.world.level.block.FallingBlock) && state.getDestroySpeed(player.level(), at) >= 0.0F;
	}

	private static Mob nearestHostile(ServerPlayer player) {
		Mob best = null;
		double nearest = Double.POSITIVE_INFINITY;
		for (Mob mob : player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(24.0D),
				mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player) && ThreatPerception.isSensedThreat(player, mob))) {
			double distance = player.distanceTo(mob);
			if (distance < nearest) { nearest = distance; best = mob; }
		}
		return best;
	}

	private static Mob monsterNear(ServerPlayer player, BlockPos at) {
		for (Mob mob : player.level().getEntitiesOfClass(Mob.class, new net.minecraft.world.phys.AABB(at).inflate(MONSTER_REST_RANGE, 5.0D, MONSTER_REST_RANGE),
				mob -> mob.isAlive() && ThreatPerception.isHostileTo(mob, player))) return mob;
		return null;
	}

	private static String type(net.minecraft.world.entity.Entity entity) {
		return entity == null ? "something" : BuiltInRegistries.ENTITY_TYPE.getKey(entity.getType()).toString();
	}
}
