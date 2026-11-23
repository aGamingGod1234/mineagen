package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.server.runtime.reflex.EscapeMoves;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Map;
import java.util.Set;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.state.BlockState;

/**
 * "Get me out of here safely": one body job for the moments the model used to answer with raw keys (jump pulses, single
 * placements, single breaks). Each time it has nothing running it looks at where the body is and picks the move a
 * player would make, then looks again once that move ends:
 * <ul>
 * <li>eyes under water with little air, or no dry footing in reach: swim to the nearest seen air (the swim-up reflex's move);</li>
 * <li>in water with dry footing in reach: travel_to the nearest bank cell (travel swims, breathes and steps out); after
 * two failed tries at one bank, dig a sealed staircase up to it (a flooded staircase re-cut dry);</li>
 * <li>in a confined flooded shaft with no bank (a shaft into a flooded cave): fill the water column under the body from
 * the bottom up with carried blocks, then climb out of the dry shaft that is left;</li>
 * <li>on the floor of a hole whose walls need climbing: pillar up to the rim with carried blocks when the sky over it is
 * open, else dig stairs up to it, then step out onto the rim;</li>
 * <li>a shooter in sight on open ground: walk into cover, the shield blocking shots on the way (the cover reflex's move).</li>
 * </ul>
 * It hands back once the body has stood safe for a second (footing, eyes in air, no hole to climb, no shooter in sight),
 * and at once when it has no way out, naming what is missing. Sub-second reactions stay with the reflexes, which pause
 * this job and hand the body back to it; it then looks again.
 */
public final class ServerEscapeController implements ServerController {
	public interface Environment {
		/** travel_to the cell (feet), building steps where needed. */
		ServerController travel(ServerPlayer body, BlockPos to, long timeoutMs);
		/** build pillar: {@code size} blocks up under the feet. */
		ServerController pillar(ServerPlayer body, int size, long timeoutMs);
		/** dig_to stairs_up to feet level {@code y}, heading {@code heading}, sealing fluids it opens. */
		ServerController stairsUp(ServerPlayer body, int y, Direction heading, long timeoutMs);
		/** Where to look to place {@code itemId} into cell {@code at} against the block on its {@code face} side's opposite. */
		net.minecraft.world.phys.Vec3 aim(ServerPlayer body, BlockPos at, Direction face, String itemId);
		/** Places it with the ordinary placement gates; null when placed, else why not. */
		String place(ServerPlayer body, BlockPos at, Direction face, String itemId);
	}

	public static final long DEFAULT_TIMEOUT_MS = 60_000L;
	public static final long MAX_TIMEOUT_MS = 180_000L;
	/** How far a bank cell is looked for around the body, and how far above and below its feet. */
	static final int SHORE_RADIUS = 16;
	static final int SHORE_BELOW = 3;
	static final int SHORE_ABOVE = 12;
	/** Air (ticks of 300) under which the body swims to air before anything else: about 7.5 s. */
	static final int SWIM_FIRST_AIR = 150;
	/** Steps a walk out of a hole is searched; reaching this far, or this far from the start, is out of the hole. */
	static final int PIT_STEPS = 8;
	static final int PIT_OPEN = 5;
	static final int PIT_CELLS = 256;
	/** The highest rim a climb out of a hole looks for. */
	static final int RIM_SEARCH = 24;
	/** A shooter this near and in sight keeps the body from counting as safe. */
	static final double SHOOTER_RANGE = 16.0D;
	static final int COVER_WITHIN = 8;
	/** How far a run from a shooter goes: past the 16 blocks it counts as a threat from. */
	static final double RUN_BLOCKS = 20.0D;
	/** Ticks the body must stay safe before the job hands back. */
	static final int SAFE_TICKS = 20;
	static final int MAX_TRIES = 3;
	static final long CHILD_MS = 45_000L;

	enum Situation { WATER, PIT, SHOOTERS, LAVA, AIRBORNE, SAFE }

	private final Environment environment;
	private final long startedAt;
	private final long deadline;
	private final CombatInputLease input = new CombatInputLease();
	private final List<String> log = new ArrayList<>();
	private ServerController child;
	private String childLabel;
	private EscapeMoves.Move move;
	private String moveLabel;
	private int safeTicks;
	private int swims;
	/** Pushes onto a bank from the body's own column, and across one open water column: each kind has its own tries. */
	private int climbs, farClimbs;
	/** Gives back the running move's attempt when a reflex interrupts it (see {@link #resumed}). */
	private Runnable refund;
	private int fills, steps, wades;
	private int covers;
	/** Runs out of a shooter's range when no cover is in reach. */
	private int runs;
	private boolean runInterrupted;
	private int pits;
	private final Map<BlockPos, Integer> bankTries = new java.util.HashMap<>();
	private final Set<BlockPos> stairedBanks = new HashSet<>();
	private BlockPos travelBank;

	public ServerEscapeController(long timeoutMs, long now, Environment environment) {
		if (timeoutMs <= 0L) throw new IllegalArgumentException("escape needs a positive timeout");
		this.environment = environment;
		this.startedAt = now;
		this.deadline = now + Math.min(timeoutMs, MAX_TIMEOUT_MS);
	}

	@Override
	public TickResult tick(ServerPlayer player, long now) {
		if (!player.isAlive()) return finish(player, TickResult.failed("AGENT_DEAD", "Body died while getting out" + done() + facts(player), 0.0D));
		if (now >= deadline) return finish(player, TickResult.timedOut("ESCAPE_TIMEOUT", "timeoutMs ran out before the body was safe" + done() + facts(player), 0.5D));
		if (stand != null) return standTick(player, now);
		if (child != null) return childTick(player, now);
		if (move != null) return moveTick(player);
		Situation situation = situation(player);
		if (situation != Situation.SHOOTERS) runInterrupted = false;
		if (situation != Situation.SAFE) safeTicks = 0;
		return switch (situation) {
			case SAFE -> {
				input.release();
				if (++safeTicks < SAFE_TICKS) yield TickResult.running(0.9D);
				yield finish(player, TickResult.succeeded("ESCAPED", (log.isEmpty() ? "Already safe: footing, eyes in air, no hole to climb, no shooter in sight"
						: "Safe: footing, eyes in air, no hole to climb, no shooter in sight") + done() + facts(player)));
			}
			// Lava belongs to the lava reflex, which outranks this job; the job waits for the body back.
			case LAVA -> { input.release(); yield TickResult.running(0.1D); }
			// Mid-jump or falling: no footing to call safe yet, and nothing to choose until it lands.
			case AIRBORNE -> { input.release(); yield TickResult.running(0.5D); }
			case WATER -> water(player, now);
			case PIT -> pit(player, now);
			case SHOOTERS -> shooters(player);
		};
	}

	static Situation situation(ServerPlayer player) {
		if (player.isInLava()) return Situation.LAVA;
		// Feet in water count too (a wet stair, a shallow edge): safe means dry footing.
		if (player.isUnderWater() || player.isInWater()) return Situation.WATER;
		if (player.onGround() && trapped(player) != null) return Situation.PIT;
		if (shooterNear(player) != null) return Situation.SHOOTERS;
		return player.onGround() || player.onClimbable() ? Situation.SAFE : Situation.AIRBORNE;
	}

	/** The way out of water: swim to air, travel to a bank, cut stairs up to it, or stop with no way / no shore. */
	enum WaterMove { SWIM, TRAVEL, STAIRS, FILL, STEP, NO_WAY, NO_SHORE }

	/**
	 * {@code tries} counts this pick of the bank too. Little air, or no bank in reach, swims first (at most
	 * {@link #MAX_TRIES} swims); a bank tried twice and above the floor the body stands on, breathing, gets stairs once.
	 */
	static WaterMove waterMove(boolean underwater, int air, boolean bank, int tries, boolean onGround, boolean bankAbove, boolean staired, int swims) {
		return waterMove(underwater, air, bank, tries, onGround, bankAbove, staired, swims, false);
	}

	/**
	 * {@code canFill}: no bank, a confined flooded shaft (fillColumn) and enough plain blocks carried. A player there fills the
	 * water under them from the bottom up until standing dry, and then climbs out of the hole that is left.
	 */
	static WaterMove waterMove(boolean underwater, int air, boolean bank, int tries, boolean onGround, boolean bankAbove, boolean staired, int swims, boolean canFill) {
		return waterMove(underwater, air, bank, tries, onGround, bankAbove, staired, swims, canFill, false);
	}

	/**
	 * {@code canStep}: no bank and no confined shaft to fill, but a water cell beside the body has solid ground under it and
	 * two open cells over it (stepCell), and a plain block is carried. One block placed there is a bank, as a player in
	 * a flooded hole whose rim is out of reach puts a block down beside them and climbs onto it.
	 */
	static WaterMove waterMove(boolean underwater, int air, boolean bank, int tries, boolean onGround, boolean bankAbove, boolean staired, int swims,
			boolean canFill, boolean canStep) {
		if (underwater && (!bank || air < SWIM_FIRST_AIR) && swims < MAX_TRIES && !(canFill && air >= SWIM_FIRST_AIR) && !(canStep && air >= SWIM_FIRST_AIR)) return WaterMove.SWIM;
		if (!bank) return canFill ? WaterMove.FILL : canStep ? WaterMove.STEP : underwater ? WaterMove.NO_WAY : WaterMove.NO_SHORE;
		// dig_to stops at once with the eyes under water (WATER_AHEAD), so the stairs start only from breathable footing.
		if (tries > 2 && onGround && !underwater && bankAbove && !staired) return WaterMove.STAIRS;
		if (tries > MAX_TRIES + 1) return WaterMove.NO_WAY;
		return WaterMove.TRAVEL;
	}

	/**
	 * Push onto a bank in reach before anything else, also with the eyes under water, unless the air is low: then the
	 * swim to air comes first, as for every other move.
	 */
	static boolean climbFirst(boolean besideBank, int climbs, boolean underwater, int air) {
		return besideBank && climbs < MAX_TRIES && (!underwater || air >= SWIM_FIRST_AIR);
	}

	private TickResult water(ServerPlayer player, long now) {
		BlockPos bank = bank(player, bankTries);
		// travel_to counts a stop within a block of the bank as arrived, often still treading water at its edge: a player
		// holds forward and jump against the bank there. Whether it is in reach is the bank's height against the water
		// (SwimPlanning.climbsOut), not where the eyes are: a body with its eyes under, beside a bank at or below its feet,
		// rises and climbs out the same way (a travel there only arrives again, still in the water).
		boolean beside = bank != null && besideBank(player, bank);
		// Failed pushes across a water column never spend the tries of a push from the body's own column, nor the reverse.
		boolean adjacent = bank != null && adjacentBank(player, bank);
		int pushes = adjacent ? climbs : farClimbs;
		if (climbFirst(beside, pushes, player.isUnderWater(), player.getAirSupply())) {
			if (adjacent) { climbs++; refund = () -> climbs--; }
			else { farClimbs++; refund = () -> farClimbs--; }
			return startMove(player, climbOut(bank, adjacent ? 60 : 100), "climb out onto the bank at " + bank.toShortString());
		}
		// No bank within one push, but a flooded step beside the body whose floor is within the climb from where it floats
		// (a flooded stair): a player wades up onto it, as each step up brings the next one, and the bank, in reach. A
		// block placed there instead raises the ledge out of reach of a body afloat (6006/0: 4 of 4 climbs failed).
		BlockPos ledge = !climbFirst(beside, pushes, player.isUnderWater(), player.getAirSupply()) && wades < WADE_LIMIT && (!player.isUnderWater() || player.getAirSupply() >= SWIM_FIRST_AIR)
				? wadeCell(player.level(), player, connectedWater(player.level(), player.blockPosition())) : null;
		if (ledge != null) {
			wades++;
			refund = () -> wades--;
			return startMove(player, wadeUp(ledge.immutable()), "wade up onto the flooded step at " + ledge.toShortString());
		}
		// Eyes under water with no seen air, and the way it swam from its last breath known and within the breath left (a
		// sealed pocket past the air search's reach): a player swims back the way they came. A bank seen from there is no
		// way out (travel stops BREATH_NOT_COVERED with no seen way up: sealed-pocket room, every try until the timeout).
		if (player.isUnderWater() && swims < MAX_TRIES && EscapeMoves.knowsWayBack(player)) {
			swims++;
			refund = () -> swims--;
			return startMove(player, EscapeMoves.swimUp(), "swim back to where it last breathed");
		}
		int tries = bank == null ? 0 : bankTries.merge(bank, 1, Integer::sum);
		boolean bankAbove = bank != null && bank.getY() > player.getBlockY();
		String block = plainBlock(player);
		Column column = bank == null && block != null && fills < MAX_TRIES ? fillColumn(player.level(), player.blockPosition()) : null;
		boolean canFill = column != null && ServerBuildController.carried(player, block) >= column.depth();
		BlockPos step = bank == null && !canFill && block != null && steps < MAX_TRIES
				? stepCell(player.level(), player.blockPosition(), connectedWater(player.level(), player.blockPosition()), waterTopAt(player.level(), player.blockPosition())) : null;
		WaterMove next = waterMove(player.isUnderWater(), player.getAirSupply(), bank != null, tries, player.onGround(), bankAbove,
				bank != null && stairedBanks.contains(bank), swims, canFill, step != null);
		return switch (next) {
			case SWIM -> {
				if (bank != null) bankTries.merge(bank, -1, Integer::sum);
				swims++;
				refund = () -> swims--;
				yield startMove(player, EscapeMoves.swimUp(), "swim to air");
			}
			// Afloat and breathing with nowhere dry in reach: a safe stop, the way on is the model's choice.
			case NO_SHORE -> finish(player, TickResult.failed("ESCAPE_NO_SHORE", "Afloat with air, but no dry footing within " + SHORE_RADIUS
					+ " blocks; choose a direction or build (released input sinks)" + done() + facts(player), 0.4D));
			case NO_WAY -> finish(player, TickResult.failed("ESCAPE_NO_WAY", (bank == null
					? "Under water with no breathable air reached after " + swims + " swims and no dry footing within " + SHORE_RADIUS + " blocks"
					: "Could not reach the bank at " + bank.toShortString() + " after " + (tries - 1) + " tries") + done() + facts(player), 0.3D));
			// Two failed walks to one bank (a current, a flooded stair the swim cannot climb): cut a sealed staircase up to it.
			case STAIRS -> {
				stairedBanks.add(bank.immutable());
				Direction heading = toward(player, bank);
				yield startChild(player, environment.stairsUp(player, bank.getY(), heading, childMs(now)),
						"re-cut the flooded way up as dry stairs to y" + bank.getY() + " heading " + heading.getName());
			}
			case FILL -> {
				fills++;
				refund = () -> fills--;
				yield startMove(player, fillUnder(block, column.top().getX(), column.top().getZ()), "fill the " + column.depth() + " water cells under the body with " + block.replace("minecraft:", ""));
			}
			case STEP -> {
				steps++;
				refund = () -> steps--;
				yield startMove(player, placeStep(block, step.immutable()), "place a step block at " + step.toShortString() + " to climb out onto");
			}
			case TRAVEL -> {
				travelBank = bank.immutable();
				yield startChild(player, environment.travel(player, bank, childMs(now)), "out of the water to the bank at " + bank.toShortString());
			}
		};
	}

	/** At most this many wades up flooded steps in one escape: a flooded stair is climbed one step per wade. */
	static final int WADE_LIMIT = 16;
	/**
	 * A water cell beside the body, in its own water, over a sturdy dry floor higher than the floor under the body and
	 * within the climb from where it is ({@link SwimPlanning#climbsOut}), with room for the
	 * body over it (water or air, nothing solid): the highest such step, or null.
	 */
	static BlockPos wadeCell(Level level, ServerPlayer player, Set<BlockPos> pool) {
		BlockPos feet = player.blockPosition();
		int waterTop = waterTopAt(level, feet);
		// The top of the floor under the body: the first solid cell down through its water (at most 4 down).
		int ownFloorTop = Integer.MIN_VALUE;
		for (int down = 0; down <= 4; down++) {
			BlockPos below = feet.below(down);
			if (!level.getBlockState(below).getCollisionShape(level, below).isEmpty()) { ownFloorTop = below.getY() + 1; break; }
		}
		BlockPos best = null;
		double bestLedge = -0.5D;
		for (int dy = 0; dy <= 1; dy++) {
			for (Direction side : Direction.Plane.HORIZONTAL) {
				BlockPos cell = feet.above(dy).relative(side);
				if (!pool.contains(cell)) continue;
				BlockPos under = cell.below();
				if (!level.getFluidState(under).isEmpty() || !level.getBlockState(under).isFaceSturdy(level, under, Direction.UP)
						|| level.getBlockState(under).is(net.minecraft.world.level.block.Blocks.MAGMA_BLOCK)) continue;
				if (!roomOver(level, cell) || !roomOver(level, cell.above())) continue;
				net.minecraft.world.phys.AABB box = player.getBoundingBox();
				if (!takeoffClear(box.minX, box.maxX, box.minZ, box.maxZ, box.maxY, cell.getY(),
						at -> !level.getBlockState(at).getCollisionShape(level, at).isEmpty())) continue;
				double ledge = cell.getY() - player.getY();
				if (cell.getY() > ownFloorTop && ledge > bestLedge && SwimPlanning.climbsOut(cell.getY(), waterTop)) { bestLedge = ledge; best = cell; }
			}
		}
		return best;
	}

	/** A standing player's height: the body has to fit it over the step before it is on it. */
	static final double STANDING_HEIGHT = 1.8D;

	/**
	 * Whether the body can rise in its own column until its feet are level with a step's top at {@code stepTop}: every
	 * cell over the columns its box covers, from its head ({@code boxTop}) up to the step top plus a standing height, is
	 * free. A ceiling lower than that (a flooded passage two high with a step up beside it) blocks the jump however long
	 * the body pushes, so the step is no way out from here.
	 */
	static boolean takeoffClear(double minX, double maxX, double minZ, double maxZ, double boxTop, int stepTop,
			java.util.function.Predicate<BlockPos> solid) {
		double top = stepTop + STANDING_HEIGHT;
		if (top <= boxTop) return true;
		int x0 = net.minecraft.util.Mth.floor(minX), x1 = net.minecraft.util.Mth.floor(maxX - 1.0E-7D);
		int z0 = net.minecraft.util.Mth.floor(minZ), z1 = net.minecraft.util.Mth.floor(maxZ - 1.0E-7D);
		int y0 = net.minecraft.util.Mth.floor(boxTop), y1 = net.minecraft.util.Mth.floor(top - 1.0E-7D);
		for (int x = x0; x <= x1; x++)
			for (int z = z0; z <= z1; z++)
				for (int y = y0; y <= y1; y++)
					if (solid.test(new BlockPos(x, y, z))) return false;
		return true;
	}

	/** A cell the body fits in over a step: air or water, nothing solid, no hazard. */
	private static boolean roomOver(Level level, BlockPos cell) {
		BlockState state = level.getBlockState(cell);
		return (state.getFluidState().isEmpty() || state.getFluidState().is(net.minecraft.tags.FluidTags.WATER))
				&& state.getCollisionShape(level, cell).isEmpty() && !hazard(state);
	}

	/**
	 * Face the flooded step and hold forward and jump: done standing in its column (not on its lip from the column below,
	 * where the next pick would measure the same lower floor again), failed after 3 s.
	 */
	static EscapeMoves.Move wadeUp(BlockPos cell) {
		int[] ticks = {0};
		return (player, input) -> {
			double dx = cell.getX() + 0.5D - player.getX(), dz = cell.getZ() + 0.5D - player.getZ();
			if (player.onGround() && player.getY() >= cell.getY() - 0.05D && player.getBlockX() == cell.getX() && player.getBlockZ() == cell.getZ())
				return new EscapeMoves.Result(EscapeMoves.Status.DONE, "on the flooded step at " + player.blockPosition().toShortString());
			if (++ticks[0] > 60) return new EscapeMoves.Result(EscapeMoves.Status.FAILED, "could not get onto the flooded step at " + cell.toShortString() + " in 3 s");
			float heading = net.minecraft.util.Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
			float yaw = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnYaw(player.getYRot(), heading);
			float pitch = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnPitch(player.getXRot(), 0.0F);
			input.accept(new dev.agaminggod.mineagen.server.runtime.input.AgentInputState(1.0F, 0.0F, true, false, false, false, false, yaw, pitch,
					player.getInventory().getSelectedSlot(), net.minecraft.world.InteractionHand.MAIN_HAND));
			return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "wading onto the flooded step");
		};
	}

	/** Within a block and a half of the bank: the push climbs from the body's own column. */
	static boolean adjacentBank(ServerPlayer player, BlockPos bank) {
		double dx = bank.getX() + 0.5D - player.getX(), dz = bank.getZ() + 0.5D - player.getZ();
		return dx * dx + dz * dz <= 2.25D;
	}

	/** How far over the feet a bank one swim column away may be: the body rises in that column before it climbs. */
	static final int REACH_RISE = 3;

	/**
	 * A bank one push of forward and jump gets the body onto, with the water-exit climb (SwimPlanning.climbsOut) from the
	 * column it climbs from and room to rise there:
	 * - beside it (within a block and a half), not more than a block below its floor, climbing from its own column; or
	 * - two cells off in a straight line over one open column of water (nothing solid from the feet up past the head and
	 *   past the bank's floor), climbing from that column: a body under a low ceiling swims into the open column beside it and climbs
	 *   from there, as a player does (floodlow: a travel there asked for a tunnel and never got out, 0/10).
	 */
	static boolean besideBank(ServerPlayer player, BlockPos bank) {
		Level level = player.level();
		java.util.function.Predicate<BlockPos> solidAt = at -> solid(level, at);
		if (adjacentBank(player, bank)) {
			net.minecraft.world.phys.AABB box = player.getBoundingBox();
			return bank.getY() - player.getY() <= 1.3D && SwimPlanning.climbsOut(bank.getY(), waterTopAt(level, player.blockPosition()))
					&& takeoffClear(box.minX, box.maxX, box.minZ, box.maxZ, box.maxY, bank.getY(), solidAt);
		}
		BlockPos feet = player.blockPosition();
		int ox = bank.getX() - feet.getX(), oz = bank.getZ() - feet.getZ();
		if (!(Math.abs(ox) == 2 && oz == 0 || Math.abs(oz) == 2 && ox == 0) || bank.getY() - feet.getY() > REACH_RISE) return false;
		BlockPos mid = feet.offset(ox / 2, 0, oz / 2);
		if (!level.getFluidState(mid).is(net.minecraft.tags.FluidTags.WATER)) return false;
		// Room for the body to pass at its own height and to rise to the bank's floor: from the feet up past the head and
		// past the bank's floor plus a standing height.
		int top = Math.max(bank.getY() + 1, net.minecraft.util.Mth.floor(player.getBoundingBox().maxY));
		for (int y = feet.getY(); y <= top; y++) if (solid(level, new BlockPos(mid.getX(), y, mid.getZ()))) return false;
		return SwimPlanning.climbsOut(bank.getY(), waterTopAt(level, mid));
	}

	/**
	 * The top face of the water the body is in: up its own column from the feet cell (or the cell under the feet, afloat
	 * with the feet just over that face). With no water there, the feet's block.
	 */
	static int waterTopAt(Level level, BlockPos feet) {
		java.util.function.IntPredicate water = y -> level.getFluidState(new BlockPos(feet.getX(), y, feet.getZ())).is(net.minecraft.tags.FluidTags.WATER);
		int top = SwimPlanning.waterTop(feet.getY(), water);
		if (top == Integer.MIN_VALUE) top = SwimPlanning.waterTop(feet.getY() - 1, water);
		return top == Integer.MIN_VALUE ? feet.getY() : top;
	}

	/** Face the bank and hold forward and jump, as a player climbs out of water; done on dry footing, failed after 3 s. */
	static EscapeMoves.Move climbOut(BlockPos bank, int limitTicks) {
		int[] ticks = {0};
		return (player, input) -> {
			if (player.onGround() && !player.isInWater()) return new EscapeMoves.Result(EscapeMoves.Status.DONE, "on the bank at " + player.blockPosition().toShortString());
			if (++ticks[0] > limitTicks) return new EscapeMoves.Result(EscapeMoves.Status.FAILED, "still in the water after " + limitTicks / 20 + " s pushing onto the bank");
			double dx = bank.getX() + 0.5D - player.getX(), dz = bank.getZ() + 0.5D - player.getZ();
			float heading = net.minecraft.util.Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
			float yaw = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnYaw(player.getYRot(), heading);
			float pitch = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnPitch(player.getXRot(), 0.0F);
			input.accept(new dev.agaminggod.mineagen.server.runtime.input.AgentInputState(1.0F, 0.0F, true, false, false, false, false, yaw, pitch,
					player.getInventory().getSelectedSlot(), net.minecraft.world.InteractionHand.MAIN_HAND));
			return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "pushing onto the bank");
		};
	}

	/**
	 * A water cell beside the body (at its feet or one above), connected to its water, with a sturdy block under it, two
	 * open cells over it (so the step tops out at the water's surface, never deep under it), and a top a swimmer in water
	 * topping at {@code waterTop} climbs onto
	 * (SwimPlanning.climbsOut): a block placed there is a step beside the body. The higher one comes first (when both are
	 * in reach the lower one's top is still under water). A step whose top is out of that climb only raises the way out
	 * (iron-kit seed 6006: a step whose top was a block over the water, 4 of 4 climbs failed). Null when none.
	 */
	static BlockPos stepCell(Level level, BlockPos feet, Set<BlockPos> pool, int waterTop) {
		for (int dy = 1; dy >= 0; dy--) {
			for (Direction side : Direction.Plane.HORIZONTAL) {
				BlockPos cell = feet.above(dy).relative(side);
				if (!pool.contains(cell) || !SwimPlanning.climbsOut(cell.getY() + 1, waterTop)) continue;
				BlockPos under = cell.below();
				if (!level.getBlockState(under).isFaceSturdy(level, under, Direction.UP)) continue;
				if (clear(level, cell.above()) && clear(level, cell.above(2))) return cell;
			}
		}
		return null;
	}

	/**
	 * Place one block into {@code cell} against the top of the block under it, afloat, then climb onto it (forward and
	 * jump toward it): done standing on it, or once it is placed if the body could not get onto it in 3 s, so the next
	 * pick starts from wherever the body is.
	 */
	EscapeMoves.Move placeStep(String item, BlockPos cell) {
		int[] ticks = {0};
		int[] climb = {0};
		return (player, input) -> {
			if (!player.level().getFluidState(cell).is(net.minecraft.tags.FluidTags.WATER) && !player.level().getBlockState(cell).isAir()) {
				if (player.onGround() && player.getY() >= cell.getY() + 0.9D)
					return new EscapeMoves.Result(EscapeMoves.Status.DONE, "placed a step at " + cell.toShortString() + " and stood on it");
				if (++climb[0] > 60) return new EscapeMoves.Result(EscapeMoves.Status.DONE, "placed a step at " + cell.toShortString() + "; could not climb onto it in 3 s");
				double dx = cell.getX() + 0.5D - player.getX(), dz = cell.getZ() + 0.5D - player.getZ();
				float heading = net.minecraft.util.Mth.wrapDegrees((float) Math.toDegrees(Math.atan2(-dx, dz)));
				float yaw = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnYaw(player.getYRot(), heading);
				float pitch = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnPitch(player.getXRot(), 0.0F);
				input.accept(new dev.agaminggod.mineagen.server.runtime.input.AgentInputState(1.0F, 0.0F, true, false, false, false, false, yaw, pitch,
						player.getInventory().getSelectedSlot(), net.minecraft.world.InteractionHand.MAIN_HAND));
				return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "climbing onto the step at " + cell.toShortString());
			}
			if (++ticks[0] > 100) return new EscapeMoves.Result(EscapeMoves.Status.FAILED, "could not place a step into " + cell.toShortString() + " in 5 s");
			net.minecraft.world.phys.Vec3 aim;
			try { aim = environment.aim(player, cell, Direction.UP, item); }
			catch (RuntimeException refused) { aim = net.minecraft.world.phys.Vec3.atCenterOf(cell).add(0.0D, -0.499D, 0.0D); }
			var look = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.lookingAt(player, aim, 0, 0, true, false, false, false, false, net.minecraft.world.InteractionHand.MAIN_HAND);
			float yaw = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnYaw(player.getYRot(), look.yaw());
			float pitch = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnPitch(player.getXRot(), look.pitch());
			input.accept(new dev.agaminggod.mineagen.server.runtime.input.AgentInputState(0.0F, 0.0F, true, false, false, false, false, yaw, pitch,
					player.getInventory().getSelectedSlot(), net.minecraft.world.InteractionHand.MAIN_HAND));
			if (Math.abs(dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.shortestAngleDelta(yaw, look.yaw())) > 1.0F || Math.abs(pitch - look.pitch()) > 1.0F)
				return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "looking at " + cell.toShortString());
			try { environment.place(player, cell, Direction.UP, item); } catch (RuntimeException refused) { /* not ready yet; next tick */ }
			return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "placing a step at " + cell.toShortString());
		};
	}

	/** How deep a water column under the body is filled at most. */
	static final int FILL_DEPTH = 10;

	/** The water cells under the body: the lowest one (resting on a block that holds a placement) and the top one. */
	record Column(BlockPos lowest, BlockPos top) {
		int depth() { return top.getY() - lowest.getY() + 1; }
	}

	/**
	 * The water column under the feet (or under the cell the feet float over) when filling it ends in air: the cell over
	 * its top is open, so standing on the fill is dry footing (a flooded shaft, or a shaft into a flooded cave whose water
	 * around the column cannot flow into placed blocks). Null when the column is deeper than {@link #FILL_DEPTH}, rests on
	 * nothing solid, or ends under a roof.
	 */
	static Column fillColumn(Level level, BlockPos feet) {
		BlockPos top = level.getFluidState(feet).is(net.minecraft.tags.FluidTags.WATER) ? feet
				: level.getFluidState(feet.below()).is(net.minecraft.tags.FluidTags.WATER) ? feet.below() : null;
		if (top == null) return null;
		while (level.getFluidState(top.above()).is(net.minecraft.tags.FluidTags.WATER)) top = top.above();
		if (!clear(level, top.above())) return null;
		// Only a confined shaft: walls round the air over the water, so the fill ends in a hole the body can climb out of,
		// never a post in an open lake that a bank-less body would build for nothing.
		for (Direction side : Direction.Plane.HORIZONTAL) if (!solid(level, top.above().relative(side))) return null;
		BlockPos lowest = top;
		for (int depth = 1; ; depth++) {
			BlockPos below = lowest.below();
			if (level.getFluidState(below).is(net.minecraft.tags.FluidTags.WATER)) {
				if (depth >= FILL_DEPTH) return null;
				lowest = below;
				continue;
			}
			return level.getBlockState(below).isFaceSturdy(level, below, Direction.UP) ? new Column(lowest.immutable(), top.immutable()) : null;
		}
	}

	/**
	 * Fill the water under the body from the bottom up, as a player in a flooded shaft does: look down at the top of the
	 * block under the lowest water cell and place a block there, staying afloat with jump while in reach and letting the
	 * body sink while the cell is too deep to reach. Done standing on the fill with the eyes in air; failed when no
	 * placement lands for 3 s, the blocks run out, or after 15 s.
	 */
	EscapeMoves.Move fillUnder(String item, int x, int z) {
		int[] ticks = {0, 0, 0};
		return (player, input) -> {
			ticks[0]++;
			Column column = fillColumn(player.level(), new BlockPos(x, player.getBlockY(), z));
			BlockPos target = column == null ? null : column.lowest();
			if (target == null) {
				if (!player.isUnderWater() && (player.onGround() || !player.isInWater())) return new EscapeMoves.Result(EscapeMoves.Status.DONE, "filled " + ticks[2] + " cells; standing dry at " + player.blockPosition().toShortString());
				return new EscapeMoves.Result(EscapeMoves.Status.FAILED, "no water cell under the body to fill (" + ticks[2] + " filled)");
			}
			if (ServerBuildController.carried(player, item) < column.depth()) return new EscapeMoves.Result(EscapeMoves.Status.FAILED, "too few " + item + " for the " + column.depth() + " cells left after filling " + ticks[2]);
			if (ticks[0] > 300 || ticks[1] > 60) return new EscapeMoves.Result(EscapeMoves.Status.FAILED, "could not place into " + target.toShortString() + " (" + ticks[2] + " filled)");
			net.minecraft.world.phys.Vec3 aim;
			try { aim = environment.aim(player, target, Direction.UP, item); }
			catch (RuntimeException refused) { aim = net.minecraft.world.phys.Vec3.atCenterOf(target).add(0.0D, -0.499D, 0.0D); }
			boolean inCell = player.getBoundingBox().intersects(new net.minecraft.world.phys.AABB(target));
			double reach = player.blockInteractionRange() - 0.25D;
			// Afloat (jump) while the cell is in reach or the body stands in it; sinking (no jump) toward a cell too deep.
			boolean jump = inCell || player.getEyePosition().distanceTo(aim) <= reach;
			// Stay over the column: in an open flooded cave the sinking body drifts, and the aim is the column's centre.
			double off = Math.hypot(x + 0.5D - player.getX(), z + 0.5D - player.getZ());
			float forward = off > 0.25D ? 0.3F : 0.0F;
			var look = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.lookingAt(player, aim, 0, 0, jump, false, false, false, false, net.minecraft.world.InteractionHand.MAIN_HAND);
			float yaw = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnYaw(player.getYRot(), look.yaw());
			float pitch = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnPitch(player.getXRot(), look.pitch());
			input.accept(new dev.agaminggod.mineagen.server.runtime.input.AgentInputState(forward, 0.0F, jump, false, false, false, false, yaw, pitch,
					player.getInventory().getSelectedSlot(), net.minecraft.world.InteractionHand.MAIN_HAND));
			ticks[1]++;
			if (inCell || !jump) return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, inCell ? "rising out of " + target.toShortString() : "sinking toward " + target.toShortString());
			// A click only straight over the column: drifted over a neighbour, the block would land in the wrong cell.
			if (off > 0.3D) return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "moving back over the column at " + x + "," + z);
			if (Math.abs(dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.shortestAngleDelta(yaw, look.yaw())) > 1.0F || Math.abs(pitch - look.pitch()) > 1.0F)
				return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "looking down at " + target.toShortString());
			try {
				if (environment.place(player, target, Direction.UP, item) == null) { ticks[2]++; ticks[1] = 0; }
			} catch (RuntimeException refused) { /* the look or the cell is not ready yet; try again next tick */ }
			return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "filling " + target.toShortString());
		};
	}

	/** The way out of a hole {@code climb} blocks deep: step out (level with the rim), pillar, dig stairs, or none. */
	enum PitMove { STEP_OUT, PILLAR, STAIRS, NO_WAY }

	/** A pillar needs the blocks and open cells over the head up to the rim; else stairs when the wall can be dug. */
	static PitMove pitMove(int climb, int blocks, boolean headroom, boolean canDig) {
		if (climb <= 0) return PitMove.STEP_OUT;
		if (blocks >= climb && headroom) return PitMove.PILLAR;
		return canDig ? PitMove.STAIRS : PitMove.NO_WAY;
	}

	private TickResult pit(ServerPlayer player, long now) {
		Rim rim = trapped(player);
		if (rim == null) return TickResult.running(0.5D);
		if (++pits > MAX_TRIES) return finish(player, TickResult.failed("ESCAPE_NO_WAY", "Still in the hole after " + (pits - 1)
				+ " climbs; the rim is at y" + rim.feet().getY() + done() + facts(player), 0.3D));
		int climb = rim.feet().getY() - ServerTravelController.feet(player).y();
		String block = plainBlock(player);
		int blocks = block == null ? 0 : ServerBuildController.carried(player, block);
		Direction heading = toward(player, rim.feet());
		return switch (pitMove(climb, blocks, headroom(player, rim.feet().getY() + 1), canDig(player, heading))) {
			// On top of a climb that ended level with the rim: step across onto it.
			case STEP_OUT -> startChild(player, environment.travel(player, rim.feet(), childMs(now)), "step out onto the rim at " + rim.feet().toShortString());
			case PILLAR -> startChild(player, environment.pillar(player, climb, childMs(now)), "pillar " + climb + " up to the rim at y" + rim.feet().getY());
			case STAIRS -> startChild(player, environment.stairsUp(player, rim.feet().getY(), heading, childMs(now)),
					"dig stairs " + climb + " up to the rim at y" + rim.feet().getY() + " heading " + heading.getName());
			case NO_WAY -> finish(player, TickResult.failed("ESCAPE_NO_WAY", "In a hole " + climb + " blocks deep: climbing out needs " + climb
					+ " plain blocks (" + blocks + " carried) or a tool for the walls" + done() + facts(player), 0.2D));
		};
	}

	private TickResult shooters(ServerPlayer player) {
		if (runInterrupted) return runFromShooter(player, shooterNear(player));
		if (covers >= MAX_TRIES) return finish(player, TickResult.failed("ESCAPE_EXPOSED", "Still in sight of " + type(shooterNear(player))
				+ " after " + covers + " cover moves" + done() + facts(player), 0.5D));
		covers++;
		refund = () -> covers--;
		return startMove(player, EscapeMoves.takeCover(COVER_WITHIN), "cover from " + type(shooterNear(player)));
	}

	private TickResult runFromShooter(ServerPlayer player, Mob shooter) {
		runInterrupted = false;
		runs++;
		refund = () -> {
			runs--;
			runInterrupted = true;
		};
		return startMove(player, EscapeMoves.sprintAway(RUN_BLOCKS, shooter), "run out of range of " + type(shooter));
	}

	private TickResult startMove(ServerPlayer player, EscapeMoves.Move next, String label) {
		move = next;
		moveLabel = label;
		return moveTick(player);
	}

	private TickResult moveTick(ServerPlayer player) {
		EscapeMoves.Result result = move.tick(player, state -> input.apply(player, state));
		if (result.status() == EscapeMoves.Status.RUNNING) return TickResult.running(0.5D);
		note(moveLabel + (result.status() == EscapeMoves.Status.DONE ? ": " : " failed: ") + result.detail());
		input.release();
		move = null;
		refund = null;
		// No cover in reach and no blocks to build it: a player runs out of bow range instead of standing in the open (a
		// practice room: standing exposed, the defend reflex traded hits with the skeleton until the body died). Only when
		// running did not help either does the choice go back.
		if (result.status() == EscapeMoves.Status.FAILED && moveLabel.startsWith("cover") && situation(player) == Situation.SHOOTERS) {
			Mob shooter = shooterNear(player);
			if (runs < MAX_TRIES) return runFromShooter(player, shooter);
			return finish(player, TickResult.failed("ESCAPE_EXPOSED", "No cover from " + type(shooter) + " here: " + result.detail() + done() + facts(player), 0.5D));
		}
		return TickResult.running(0.5D);
	}

	private TickResult startChild(ServerPlayer player, ServerController next, String label) {
		input.release();
		child = next;
		childLabel = label;
		return TickResult.running(0.5D);
	}

	private TickResult childTick(ServerPlayer player, long now) {
		TickResult result;
		try {
			result = child.tick(player, now);
		} catch (RuntimeException refused) {
			result = TickResult.failed("ESCAPE_STEP_REFUSED", String.valueOf(refused.getMessage()), 0.0D);
		}
		if (result.state() == State.RUNNING) return TickResult.running(0.5D);
		// A child that failed, timed out or threw may still hold keys under its own lease: release them before moving on.
		if (result.state() != State.SUCCEEDED) child.cancel(player);
		note(childLabel + (result.state() == State.SUCCEEDED ? ": " : " (" + result.reasonCode() + "): ") + shortMessage(result.message()));
		// A hostile stopped the step (a pillar or stairs refuses with a mob beside the body): it is the threat, not an
		// obstacle to climb past. Retrying left the body in a hole beside a skeleton for 3 refused pillars, the fighting
		// reflex yielded to this command throughout (playtest 22 Nov: shot point-blank at 7 health). The body goes back to
		// the agent's rules (CommandFollower hands an escape that ends on HOSTILE_NEAR to them), which answer the mob.
		if (result.state() != State.SUCCEEDED && "HOSTILE_NEAR".equals(result.reasonCode())) {
			child = null;
			travelBank = null;
			// A mob near enough to fight, with the way out refused because of it (a hole, a pillar beside a skeleton):
			// running is not open, so the body stands its ground as a cornered flee does, then goes on getting out.
			LivingEntity near = nearestHostile(player, STAND_RANGE);
			if (near != null && stands < MAX_TRIES) {
				stands++;
				// The climb did not fail on the way out, a mob stopped it: that attempt is given back, so a fight that
				// takes more than one bounded stand still leaves climbs to get out (bounded by MAX_TRIES stands).
				pits = climbsAfterStand(pits, childLabel);
				stand = new CorneredStand(near, null, player, now);
				standUntil = now + STAND_MS;
				standLabel = "stood its ground against " + type(near instanceof Mob mob ? mob : null);
				return standTick(player, now);
			}
			return finish(player, TickResult.failed("HOSTILE_NEAR", "Stopped getting out for a hostile: " + shortMessage(result.message())
					+ done() + facts(player), 0.2D));
		}
		// travel stopping to breathe is progress, not a missed bank: the swim to air comes next and the walk goes on.
		if (travelBank != null && ("AIR_RESERVE_REACHED".equals(result.reasonCode()) || "BREATH_NOT_COVERED".equals(result.reasonCode()))) bankTries.merge(travelBank, -1, Integer::sum);
		travelBank = null;
		child = null;
		return TickResult.running(0.5D);
	}

	/** A hostile this near when a step is refused for it is fought where the body stands, not climbed past. */
	static final double STAND_RANGE = 6.0D;
	private CorneredStand stand;
	private long standUntil;
	/** A stand inside an escape lasts at most this long before the escape goes back to getting out. */
	static final long STAND_MS = 10_000L;
	private String standLabel;
	private int stands;

	/** Climbs counted after a stand that a pit step's HOSTILE_NEAR started: that step's climb is not spent. */
	static int climbsAfterStand(int pits, String stoppedStep) {
		boolean pitStep = stoppedStep != null && (stoppedStep.startsWith("pillar") || stoppedStep.startsWith("dig stairs") || stoppedStep.startsWith("step out"));
		return pitStep ? Math.max(0, pits - 1) : pits;
	}

	private TickResult standTick(ServerPlayer player, long now) {
		// Bounded: a mob the stand cannot reach (on a rim above the hole) is guarded against, never fought, and would
		// otherwise hold the body there until the escape's deadline instead of climbing on.
		if (now >= standUntil) {
			stand.cancel(player);
			stand = null;
			note(standLabel + ": stood " + STAND_MS / 1000 + " s; climbing on");
			return TickResult.running(0.5D);
		}
		TickResult result = stand.tick(player, now);
		if (result.state() == State.RUNNING) return TickResult.running(0.5D);
		stand.cancel(player);
		stand = null;
		note(standLabel + " (" + result.reasonCode() + "): " + shortMessage(result.message()));
		if ("AGENT_DEAD".equals(result.reasonCode())) return finish(player, TickResult.failed("AGENT_DEAD", "Body died while getting out" + done() + facts(player), 0.0D));
		return TickResult.running(0.5D);
	}

	private static LivingEntity nearestHostile(ServerPlayer player, double within) {
		LivingEntity best = null;
		// A creeper is not stood against (the stand does not fight creepers): the creeper reflex and the agent's rules
		// answer it once the escape hands back.
		for (Mob mob : player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(within),
				mob -> mob.isAlive() && !(mob instanceof net.minecraft.world.entity.monster.Creeper)
						&& dev.agaminggod.mineagen.server.perception.ThreatPerception.isHostileTo(mob, player) && player.distanceTo(mob) <= within)) {
			if (best == null || player.distanceTo(mob) < player.distanceTo(best)) best = mob;
		}
		return best;
	}

	private long childMs(long now) {
		return Math.max(1_000L, Math.min(CHILD_MS, deadline - now));
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (child != null) child.cancel(player);
		child = null;
		if (stand != null) stand.cancel(player);
		stand = null;
		move = null;
		input.release();
	}

	@Override
	public void resumed(ServerPlayer player) {
		// A reflex held the body (a raised shield, a swim up): the old move's picture is stale, so look again. The move did
		// not fail, so its attempt is given back: steady arrow fire pausing cover for the shield must not use up the tries.
		if (child != null) child.resumed(player);
		if (move != null && refund != null) refund.run();
		refund = null;
		move = null;
		safeTicks = 0;
		input.release();
	}

	private TickResult finish(ServerPlayer player, TickResult result) {
		if (child != null) child.cancel(player);
		child = null;
		if (stand != null) stand.cancel(player);
		stand = null;
		move = null;
		input.release();
		return result;
	}

	/** The rim of the hole the body stands in, or null when it can walk out (or cannot tell yet). */
	record Rim(BlockPos feet) { }

	static Rim trapped(ServerPlayer player) {
		Level level = player.level();
		// Water is no way out of a hole: standing dry on a fill at the foot of a shaft into a flooded cave, the lake beside
		// the feet leads nowhere dry, so the shaft is still the hole to climb.
		ObservedTerrain seen = ObservedTerrain.of(player);
		dev.agaminggod.mineagen.client.navigation.WalkabilityView dry = new dev.agaminggod.mineagen.client.navigation.WalkabilityView() {
			public Cell cellAt(GridPosition cell) {
				Cell kind = seen.cellAt(cell);
				return kind == Cell.WATER ? Cell.BLOCKED : kind;
			}
			public boolean canJumpFrom(GridPosition position) { return seen.canJumpFrom(position); }
			public boolean canJumpUp(GridPosition from, GridPosition to) { return seen.canJumpUp(from, to); }
			public boolean canJumpGap(GridPosition from, GridPosition to) { return seen.canJumpGap(from, to); }
			public boolean requiresJump(GridPosition from, GridPosition to) { return seen.requiresJump(from, to); }
			public double movementSpeedMultiplier(GridPosition position) { return seen.movementSpeedMultiplier(position); }
		};
		BlockPos rim = rim(SafeStep.reachable(dry, SafeStep.standing(player), PIT_STEPS, PIT_CELLS), SafeStep.standing(player), new Cells() {
			public boolean solid(BlockPos cell) { return ServerEscapeController.solid(level, cell); }
			public boolean standable(BlockPos feet) { return ServerEscapeController.standable(level, feet); }
		});
		return rim == null ? null : new Rim(rim);
	}

	/** What the hole test reads of the world: a cell that blocks the body, and a cell a body can stand in. */
	interface Cells {
		boolean solid(BlockPos cell);
		boolean standable(BlockPos feet);
	}

	/**
	 * The lowest standable cell on top of the walls of a hole, or null when the walk out is open: a walk ({@code reach},
	 * from {@code start}) that gets {@link #PIT_OPEN} blocks away, fills {@link #PIT_CELLS}, or meets a side that is open
	 * (a drop, a ledge, a cell not yet seen) is out of the hole or cannot tell. Only walls two blocks high or more, all
	 * round, make a hole.
	 */
	static BlockPos rim(Map<GridPosition, GridPosition> reach, GridPosition start, Cells cells) {
		if (reach.size() >= PIT_CELLS) return null;
		Set<Long> walls = new HashSet<>();
		List<GridPosition> boundary = new ArrayList<>();
		for (GridPosition cell : reach.keySet()) {
			if (Math.abs(cell.x() - start.x()) >= PIT_OPEN || Math.abs(cell.z() - start.z()) >= PIT_OPEN) return null;
			for (Direction side : Direction.Plane.HORIZONTAL) {
				GridPosition next = new GridPosition(cell.x() + side.getStepX(), cell.y(), cell.z() + side.getStepZ());
				if (reach.containsKey(next) || reach.containsKey(next.above()) || reach.containsKey(next.below())) continue;
				BlockPos feet = new BlockPos(next.x(), next.y(), next.z());
				boolean head = cells.solid(feet.above());
				if (!head && !cells.solid(feet)) return null;
				// A one-block step the walk refused (a fluid or a low ceiling above it) is no wall to climb either.
				if (!head && !cells.solid(feet.above(2))) return null;
				if (walls.add(BlockPos.asLong(next.x(), 0, next.z()))) boundary.add(next);
			}
		}
		BlockPos best = null;
		double bestScore = Double.POSITIVE_INFINITY;
		for (GridPosition wall : boundary) {
			for (int y = start.y() + 1; y <= start.y() + RIM_SEARCH; y++) {
				BlockPos feet = new BlockPos(wall.x(), y, wall.z());
				if (!cells.standable(feet)) continue;
				double score = (y - start.y()) * 4.0D + Math.abs(wall.x() - start.x()) + Math.abs(wall.z() - start.z());
				if (score < bestScore) { bestScore = score; best = feet; }
				break;
			}
		}
		if (best == null) return null;
		// A hole is open over the body up to the rim: a roof there (a shelter, a cave room) makes it no pit to climb out of.
		for (int y = start.y() + 2; y <= best.getY() + 1; y++) if (cells.solid(new BlockPos(start.x(), y, start.z()))) return null;
		return best;
	}

	/** The nearest dry cell beside the water to stand on, skipping banks tried too often; null when none is in reach. */
	static BlockPos bank(ServerPlayer player, Map<BlockPos, Integer> tries) {
		Level level = player.level();
		BlockPos at = player.blockPosition();
		Set<BlockPos> pool = connectedWater(level, at);
		BlockPos best = null;
		double bestScore = Double.POSITIVE_INFINITY;
		for (int dy = -SHORE_BELOW; dy <= SHORE_ABOVE; dy++) {
			for (int dx = -SHORE_RADIUS; dx <= SHORE_RADIUS; dx++) {
				for (int dz = -SHORE_RADIUS; dz <= SHORE_RADIUS; dz++) {
					BlockPos feet = at.offset(dx, dy, dz);
					if (!standable(level, feet) || !besideWater(pool, feet)) continue;
					if (tries.getOrDefault(feet, 0) > MAX_TRIES + 1) continue;
					double score = Math.sqrt(dx * dx + dz * dz) + Math.max(0, dy) * 1.5D + Math.max(0, -dy);
					if (score < bestScore) { bestScore = score; best = feet; }
				}
			}
		}
		return best;
	}

	private static boolean standable(Level level, BlockPos feet) {
		if (!level.isLoaded(feet)) return false;
		BlockPos floor = feet.below();
		BlockState below = level.getBlockState(floor);
		if (!below.getFluidState().isEmpty() || !below.isFaceSturdy(level, floor, Direction.UP) || below.is(net.minecraft.world.level.block.Blocks.MAGMA_BLOCK)) return false;
		return clear(level, feet) && clear(level, feet.above());
	}

	private static boolean clear(Level level, BlockPos cell) {
		BlockState state = level.getBlockState(cell);
		return state.getFluidState().isEmpty() && state.getCollisionShape(level, cell).isEmpty() && !hazard(state);
	}

	private static boolean hazard(BlockState state) {
		return state.is(net.minecraft.tags.BlockTags.FIRE) || state.is(net.minecraft.world.level.block.Blocks.CACTUS)
				|| state.is(net.minecraft.world.level.block.Blocks.SWEET_BERRY_BUSH) || state.is(net.minecraft.world.level.block.Blocks.POWDER_SNOW)
				|| state.is(net.minecraft.world.level.block.Blocks.COBWEB);
	}

	private static boolean solid(Level level, BlockPos cell) {
		return !level.getBlockState(cell).getCollisionShape(level, cell).isEmpty();
	}

	/** A dry cell whose side touches the body's own water (at its feet or a block below): a bank that water leads to. */
	static boolean besideWater(Set<BlockPos> pool, BlockPos feet) {
		for (Direction side : Direction.Plane.HORIZONTAL) {
			for (int dy = -1; dy <= 0; dy++) if (pool.contains(feet.relative(side).above(dy))) return true;
		}
		return false;
	}

	static final int POOL_CELLS = 8192;

	/** The water the body is in, joined face to face within the bank search box: a pool across a wall is another one. */
	static Set<BlockPos> connectedWater(Level level, BlockPos at) {
		Set<BlockPos> pool = new HashSet<>();
		java.util.ArrayDeque<BlockPos> queue = new java.util.ArrayDeque<>();
		for (BlockPos seed : List.of(at, at.above(), at.below())) {
			if (level.getFluidState(seed).is(net.minecraft.tags.FluidTags.WATER) && pool.add(seed.immutable())) queue.add(seed.immutable());
		}
		while (!queue.isEmpty() && pool.size() < POOL_CELLS) {
			BlockPos cell = queue.removeFirst();
			for (Direction side : Direction.values()) {
				BlockPos next = cell.relative(side);
				if (Math.abs(next.getX() - at.getX()) > SHORE_RADIUS + 1 || Math.abs(next.getZ() - at.getZ()) > SHORE_RADIUS + 1
						|| next.getY() < at.getY() - SHORE_BELOW - 1 || next.getY() > at.getY() + SHORE_ABOVE + 1) continue;
				// Water the body can swim through: a waterlogged slab, stair or fence holds water but blocks the body.
				if (!pool.contains(next) && level.isLoaded(next) && level.getFluidState(next).is(net.minecraft.tags.FluidTags.WATER)
						&& level.getBlockState(next).getCollisionShape(level, next).isEmpty()) {
					pool.add(next);
					queue.add(next);
				}
			}
		}
		return pool;
	}

	/** Open cells over the head up to feet level {@code toY} + 1: a pillar there meets no ceiling. */
	private static boolean headroom(ServerPlayer player, int toY) {
		BlockPos feet = player.blockPosition();
		for (int y = feet.getY() + 2; y <= toY + 1; y++) {
			if (!clear(player.level(), new BlockPos(feet.getX(), y, feet.getZ()))) return false;
		}
		return true;
	}

	/** A carried tool digs the wall toward the rim, or the wall breaks by hand (dirt, sand, gravel). */
	private static boolean canDig(ServerPlayer player, Direction heading) {
		BlockPos wall = player.blockPosition().relative(heading).above();
		BlockState state = player.level().getBlockState(wall);
		if (state.isAir() || !state.requiresCorrectToolForDrops() && state.getDestroySpeed(player.level(), wall) >= 0.0F
				&& state.getDestroySpeed(player.level(), wall) <= 1.0F) return true;
		return ServerDigController.toolSlot(player, state) >= 0;
	}

	private static Direction toward(ServerPlayer player, BlockPos cell) {
		double dx = cell.getX() + 0.5D - player.getX(), dz = cell.getZ() + 0.5D - player.getZ();
		if (dx * dx + dz * dz < 0.01D) return player.getDirection().getAxis().isHorizontal() ? player.getDirection() : Direction.NORTH;
		return Math.abs(dx) >= Math.abs(dz) ? (dx > 0 ? Direction.EAST : Direction.WEST) : (dz > 0 ? Direction.SOUTH : Direction.NORTH);
	}

	private static String plainBlock(ServerPlayer player) {
		String best = null;
		int bestCount = 0;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!TravelBuilder.buildingBlock(stack)) continue;
			String id = BuiltInRegistries.ITEM.getKey(stack.getItem()).toString();
			int count = ServerBuildController.carried(player, id);
			if (count > bestCount) { best = id; bestCount = count; }
		}
		return best;
	}

	static Mob shooterNear(ServerPlayer player) {
		for (Mob mob : EscapeMoves.shooters(player)) if (player.distanceTo(mob) <= SHOOTER_RANGE) return mob;
		return null;
	}

	private void note(String line) {
		if (log.size() < 8) log.add(line);
	}

	private String done() {
		return log.isEmpty() ? "" : "; did: " + String.join("; ", log);
	}

	private static String shortMessage(String message) {
		String text = message == null ? "" : message;
		return text.length() <= 160 ? text : text.substring(0, 157) + "...";
	}

	private static String type(Mob mob) {
		return mob == null ? "the shooter" : BuiltInRegistries.ENTITY_TYPE.getKey(mob.getType()).getPath();
	}

	private String facts(ServerPlayer player) {
		return String.format(Locale.ROOT, "; now at %d,%d,%d, health %.1f, air %.1f s, %s, %.1f s",
				player.getBlockX(), player.getBlockY(), player.getBlockZ(), player.getHealth(),
				Math.max(0, player.getAirSupply()) / (double) SwimPlanning.AIR_TICKS_PER_SECOND,
				player.isUnderWater() ? "under water" : player.isInWater() ? "in water" : player.onGround() ? "on footing" : "in the air",
				(dev.agaminggod.mineagen.server.runtime.GameClock.nowMs() - startedAt) / 1000.0D);
	}
}
