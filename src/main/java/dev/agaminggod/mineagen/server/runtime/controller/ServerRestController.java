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
 * digs a 1x2 hole beside the body and roofs it with what it dug, one block deeper (under its own feet) when the
 * blocks in hand cannot close it 2 deep. At morning it opens the walls (or digs stairs back up) and hands back.
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
	/** A break whose aim a reflex turn or a push took away is looked at again and tried this many more times. */
	static final int DIG_RETRIES = 2;
	private static final java.util.Set<String> AIM_LOST = java.util.Set.of("TARGET_NOT_VISIBLE", "TARGET_CHANGED", "AIM_NOT_REACHED");
	/** After the block under the feet breaks: time to land on the new floor and pick up the drop (pickup delay 10 ticks). */
	static final long LAND_MS = 1_500L;

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
		BlockPos table = tableInReach(player);
		if (table != null) return craftBed(player, recipe, table, now);
		boolean carriedTable = count(player, stack -> stack.is(Items.CRAFTING_TABLE)) > 0;
		if (!carriedTable && planks < 7) {
			log.add("wool for a bed but " + planks + " planks: no crafting table near and not enough planks for one (7)");
			return null;
		}
		Runnable placeTable = () -> {
			BlockPos spot = tableSpot(player);
			if (spot == null) { log.add("no free cell beside the body for a crafting table"); phase = Phase.PLAN; return; }
			startPlace(spot, "minecraft:crafting_table", null, () -> {
				log.add("placed a crafting table at " + spot.toShortString());
				TickResult crafting = craftBed(player, recipe, spot, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs());
				if (crafting.state() != State.RUNNING) phase = Phase.PLAN;
			});
		};
		if (carriedTable) {
			placeTable.run();
			return TickResult.running(0.05D);
		}
		return runChild(environment.craft(player, "minecraft:crafting_table", null, STEP_MS), result -> {
			if (result.state() != State.SUCCEEDED) { log.add("crafting a table failed: " + result.reasonCode()); return shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), null); }
			log.add("crafted a crafting table");
			placeTable.run();
			return TickResult.running(0.1D);
		});
	}

	private TickResult craftBed(ServerPlayer player, String recipe, BlockPos table, long now) {
		return runChild(environment.craft(player, recipe, table, STEP_MS), result -> {
			if (result.state() != State.SUCCEEDED) { log.add("crafting " + recipe + " failed: " + result.reasonCode()); return shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), null); }
			log.add("crafted " + recipe);
			String bedItem = carriedBed(player);
			return bedItem == null ? shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), null) : placeBed(player, bedItem);
		});
	}

	private TickResult placeBed(ServerPlayer player, String bedItem) {
		BlockPos feet = feet(player);
		Direction preferred = player.getDirection();
		for (int turn = 0; turn < 4; turn++) {
			Direction side = turn == 0 ? preferred : SIDES[(indexOf(preferred) + turn) % 4];
			BlockPos foot = feet.relative(side), head = foot.relative(side);
			if (!open(player, foot) || !open(player, head) || !solid(player, foot.below()) || !solid(player, head.below())) continue;
			bedFacing = side;
			startPlace(foot, bedItem, side, () -> {
				bed = foot;
				log.add("placed " + bedItem + " at " + foot.toShortString());
				phase = Phase.SLEEP;
				sleepTicks = 0;
			});
			return TickResult.running(0.3D);
		}
		log.add("no flat 2-cell spot beside the body for a bed");
		return shelterPlan(player, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), null);
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
		Vec3 top = Vec3.atCenterOf(bed).add(0.0D, 0.06D, 0.0D);
		if (!ServerLookController.turnToward(player, top)) return TickResult.running(0.4D);
		String why;
		try { why = environment.use(player, bed, Direction.UP); }
		catch (AgentDomainException refused) { why = refused.code() + ": " + refused.getMessage(); }
		if (why == null && player.isSleeping()) {
			laidDown = true;
			log.add("lay down in the bed (spawn set there)");
			phase = Phase.SLEEPING;
			return TickResult.running(0.5D);
		}
		if (sleepTicks < 60) return TickResult.running(0.4D);
		log.add("the bed refused sleep: " + (why == null ? "not sleeping after the click" : why));
		return shelterPlan(player, now, bedFacing);
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
			// Empty-handed, the roof is a block the dig gives back: ground that drops none by hand (snow, sand, stone) is
			// said before any digging, not found out in an open hole.
			BlockPos first = feet.relative(side).below();
			BlockState ground = SeenTerrain.of(player).known(first.getX(), first.getY(), first.getZ());
			if (item == null && ground != null && !dropsRoofBlock(player, first, ground)) {
				return stuck(player, "the ground here (" + BuiltInRegistries.BLOCK.getKey(ground.getBlock()) + " at " + first.toShortString()
						+ ") gives no block to roof a hole when dug with what is held; carry 1 plain block (dirt, cobblestone, planks) or rest on dirt or grass");
			}
			pit = true;
			log.add("digging a hole beside the body (" + blocks + " plain blocks carried)");
			return digHole(player, feet.relative(side), away);
		}
		if (item != null && blocks >= 4) return seal(player, feet, away, item, now);
		return stuck(player, "no shelter possible: " + blocks + " plain blocks carried (" + SEAL_BLOCKS + " wall in on open ground) and the ground below cannot be dug 2 deep");
	}

	private TickResult lookDown(ServerPlayer player, BlockPos feet, int index, java.util.function.Supplier<TickResult> then) {
		if (index >= SIDES.length) return then.get();
		return lookThen(feet.relative(SIDES[index]).below(), () -> lookDown(player, feet, index + 1, then));
	}

	private static Direction holeSide(ServerPlayer player, BlockPos feet, Direction away) {
		for (int turn = 0; turn < 4; turn++) {
			Direction side = SIDES[(indexOf(away) + turn) % 4];
			BlockPos cell = feet.relative(side);
			if (open(player, cell) && open(player, cell.above()) && diggableColumn(player, cell.below())) return side;
		}
		return null;
	}

	/** Whether breaking this ground with the held item drops a block that can roof the hole. */
	private static boolean dropsRoofBlock(ServerPlayer player, BlockPos at, BlockState state) {
		for (ItemStack drop : net.minecraft.world.level.block.Block.getDrops(state, player.level(), at, null, player, player.getMainHandItem()))
			if (roofBlock(drop.getItem())) return true;
		return false;
	}

	/** A plain full block that stays where it is placed (build_shelter's rule: nothing that falls or holds contents). */
	private static boolean roofBlock(net.minecraft.world.item.Item item) {
		return item instanceof net.minecraft.world.item.BlockItem blockItem && !(blockItem.getBlock() instanceof net.minecraft.world.level.block.FallingBlock)
				&& !(blockItem.getBlock() instanceof net.minecraft.world.level.block.EntityBlock)
				&& blockItem.getBlock().defaultBlockState().isCollisionShapeFullBlock(net.minecraft.world.level.EmptyBlockGetter.INSTANCE, BlockPos.ZERO)
				&& item != Items.OBSIDIAN && item != Items.CRYING_OBSIDIAN;
	}

	/** Breaks the cell; a break whose aim was taken away (a reflex turned the view, a mob pushed the body) is looked at again. */
	private TickResult clearThen(ServerPlayer player, BlockPos cell, int attempt, java.util.function.Supplier<TickResult> then) {
		return runChild(environment.clear(player, cell, STEP_MS), dug -> {
			if (dug.state() == State.SUCCEEDED) return then.get();
			if (attempt < DIG_RETRIES && AIM_LOST.contains(dug.reasonCode())) {
				log.add("looked again at " + cell.toShortString() + " after " + dug.reasonCode());
				return lookThen(cell, () -> clearThen(player, cell, attempt + 1, then));
			}
			return stuck(player, "could not dig the hole: " + dug.reasonCode() + " " + dug.message());
		});
	}

	/**
	 * Digs the column at {@code top}'s two blocks below, judging each from what the body sees, steps down into it, then
	 * deepens it by the block under its own feet (in view straight down) so the roof is one block over the head, set
	 * against the hole's own walls (2 deep, the roof sat at ground level and needed a scaffold block too).
	 */
	private TickResult digHole(ServerPlayer player, BlockPos top, Direction away) {
		BlockPos first = top.below(), second = top.below(2), floor = top.below(3);
		return clearThen(player, first, 0, () -> lookThen(second, () -> {
			String below = describeBelow(player, second);
			if (!diggableColumn(player, second)) return stuck(player, "under the dug cell " + first.toShortString() + " is " + below
					+ ": not digging toward a drop; wall in with 10 or more plain blocks, or rest somewhere with solid ground");
			return clearThen(player, second, 0, () -> lookThen(floor, () -> {
				// From beside a 1-wide hole the body's own block hides the hole's floor, so it is nearly always unseen
				// (from-scratch game 13: rest refused every night hole at 1.3 health with an empty inventory). A player
				// digs two down and steps in; only a floor known to be open or fluid is a drop.
				boolean unseen = SeenTerrain.of(player).known(floor.getX(), floor.getY(), floor.getZ()) == null;
				if (!unseen && !solid(player, floor)) return stuck(player, "under the hole at " + second.toShortString() + " is "
						+ describeBelow(player, floor) + ": not stepping into a drop; wall in with 10 or more plain blocks, or rest on solid ground");
				log.add("hole dug to " + second.toShortString() + (unseen ? " (its floor hidden from beside it)" : " over solid " + describeBelow(player, floor)));
				return runChild(new ServerNavigationController(Vec3.atBottomCenterOf(second), 0.35D, false, dev.agaminggod.mineagen.server.runtime.GameClock.nowMs(), STEP_MS, false),
						stepped -> stepped.state() == State.SUCCEEDED || feet(player).equals(second) ? lookWalls(player, feet(player), away, 0, () -> roofOrDeepen(player, away))
								: stuck(player, "could not step into the hole: " + stepped.reasonCode() + " " + stepped.message()));
			}));
		}));
	}

	/**
	 * In the 1x2 hole, walls looked at: roof it 2 deep when the blocks in hand cover every cell the sealed plan still needs
	 * (a scaffold and the roof on flat dug ground: exactly the 2 the dig gave back). Otherwise dig the block under the feet
	 * (in view straight down): one more block in hand, and 3 deep the roof sits against the hole's own walls, 1 block.
	 * The floor under it is unseen, so this is only done when the 2-deep roof cannot close.
	 */
	private TickResult roofOrDeepen(ServerPlayer player, Direction away) {
		BlockPos center = feet(player), under = center.below();
		String item = environment.blockItem(player);
		int held = item == null ? 0 : count(player, stack -> BuiltInRegistries.ITEM.getKey(stack.getItem()).toString().equals(item));
		int needs = roofNeeds(player, center, away);
		if (held >= needs) return roofHole(player, away);
		return lookThen(under, () -> {
			if (!diggableColumn(player, under)) {
				log.add("roof needs " + needs + " blocks, " + held + " in hand; kept the hole 2 deep over " + describeBelow(player, under));
				return roofHole(player, away);
			}
			log.add("roof needs " + needs + " blocks, " + held + " in hand: one deeper");
			return clearThen(player, under, 0, () -> runChild(landed(player, under), done -> {
				log.add("deepened to " + feet(player).toShortString());
				return lookWalls(player, feet(player), away, 0, () -> roofHole(player, away));
			}));
		});
	}

	/** Cells of the sealed roof plan round {@code center} not seen as full blocks: each needs a block. */
	private static int roofNeeds(ServerPlayer player, BlockPos center, Direction opening) {
		SeenTerrain.Reader<BlockState> seen = SeenTerrain.of(player);
		List<BlockPos> cells = new ArrayList<>();
		for (ServerShelterController.Cell cell : ServerShelterController.plan(center, opening, true)) cells.add(cell.at());
		cells.add(center.relative(opening).above());
		int needs = 0;
		for (BlockPos at : cells) {
			BlockState known = seen.known(at.getX(), at.getY(), at.getZ());
			if (known == null || !known.isCollisionShapeFullBlock(player.level(), at)) needs++;
		}
		return needs;
	}

	/** Waits until the body stands on the floor below the broken block (and its drop is picked up), at most LAND_MS. */
	private ServerController landed(ServerPlayer body, BlockPos under) {
		long until = dev.agaminggod.mineagen.server.runtime.GameClock.nowMs() + LAND_MS;
		String before = environment.blockItem(body);
		return (player, now) -> (feet(player).getY() <= under.getY() && player.onGround() && (before != null || environment.blockItem(player) != null)) || now >= until
				? TickResult.succeeded("LANDED", "") : TickResult.running(0.5D);
	}

	/** The cells build_shelter's sealed plan checks round the hole: each side at feet and head height, and the roof's support. */
	private TickResult lookWalls(ServerPlayer player, BlockPos center, Direction away, int index, java.util.function.Supplier<TickResult> then) {
		if (index >= SIDES.length * 2 + 1) return then.get();
		BlockPos cell = index < SIDES.length * 2 ? center.relative(SIDES[index / 2]).above(index % 2) : center.relative(away.getOpposite()).above(2);
		return lookThen(cell, () -> lookWalls(player, center, away, index + 1, then));
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
		return runChild(environment.seal(center, openingSide, item, STEP_MS, now), result -> {
			if (result.state() != State.SUCCEEDED) return stuck(player, "walling in failed: " + result.reasonCode() + " " + result.message());
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
			return runChild(environment.climb(player, surfaceY, STEP_MS), result -> rested(player, result));
		}
		BlockPos window = shelter.relative(opening).above(), sill = shelter.relative(opening);
		log.add("morning: opening the " + opening.getSerializedName() + " wall");
		return runChild(environment.clear(player, window, STEP_MS), first ->
				runChild(environment.clear(player, sill, STEP_MS), second -> rested(player, second)));
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


	private TickResult runChild(ServerController controller, Function<TickResult, TickResult> then) {
		child = controller;
		afterChild = then;
		phase = Phase.CHILD;
		return TickResult.running(0.1D);
	}

	private TickResult childTick(ServerPlayer player, long now) {
		TickResult result = child.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(progress(player));
		child.cancel(player);
		child = null;
		Function<TickResult, TickResult> then = afterChild;
		afterChild = null;
		phase = Phase.PLAN;
		return then.apply(result);
	}

	private void startPlace(BlockPos at, String item, Direction facing, Runnable then) {
		placeAt = at;
		placeFacing = facing;
		placeItem = item;
		afterPlace = then;
		placeTicks = 0;
		phase = Phase.PLACE;
	}

	/** Turns to the placement like a player (facing the bed's way for a bed), then one vanilla placement click. */
	private TickResult placeTick(ServerPlayer player) {
		if (++placeTicks > 80) return stuck(player, "could not place " + placeItem + " at " + placeAt.toShortString() + ": " + placeRefusal);
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

	/** An open cell with solid floor beside the body, not where a bed would go, for a crafting table. */
	private static BlockPos tableSpot(ServerPlayer player) {
		BlockPos feet = feet(player);
		Direction facing = player.getDirection();
		for (int turn = 2; turn < 6; turn++) {
			BlockPos at = feet.relative(SIDES[(indexOf(facing) + turn) % 4]);
			if (open(player, at) && solid(player, at.below())) return at;
		}
		return null;
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

	/**
	 * Ground the hole goes down through: a seen full block a player can dig out (no fluid, no block entity, not bedrock),
	 * sand and gravel included. Nothing rests on a cell of the hole's own
	 * column (the cell above is open or already dug), so a falling block there drops nothing in.
	 */
	private static boolean diggableColumn(ServerPlayer player, BlockPos at) {
		BlockState state = SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		return state != null && state.isCollisionShapeFullBlock(player.level(), at) && !state.hasBlockEntity() && !state.is(Blocks.BEDROCK)
				&& state.getDestroySpeed(player.level(), at) >= 0.0F;
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
