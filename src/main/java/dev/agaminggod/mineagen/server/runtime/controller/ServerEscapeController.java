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
		/** Breaks one block with the best carried tool and the clearing gates (protection, lava behind). */
		ServerController clear(ServerPlayer body, BlockPos at, long timeoutMs);
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
	private int climbs;
	private int fills;
	private int steps;
	private BlockPos stepSite;
	private int covers;
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
		if (child != null) return childTick(player, now);
		if (move != null) return moveTick(player);
		Situation situation = situation(player);
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
		if (player.isUnderWater() || player.isInWater() && !player.onGround()) return Situation.WATER;
		if (player.onGround() && trapped(player) != null) return Situation.PIT;
		if (shooterNear(player) != null) return Situation.SHOOTERS;
		return player.onGround() || player.onClimbable() || player.isInWater() ? Situation.SAFE : Situation.AIRBORNE;
	}

	/** The way out of water: swim to air, travel to a bank, cut stairs up to it, or stop with no way / no shore. */
	enum WaterMove { SWIM, TRAVEL, STAIRS, FILL, STEP, NO_WAY, NO_SHORE }

	/**
	 * {@code tries} counts this pick of the bank too. Little air, or no bank in reach, swims first (at most
	 * {@link #MAX_TRIES} swims); a bank tried twice and above the floor the body stands on, breathing, gets stairs once.
	 */
	static WaterMove waterMove(boolean underwater, int air, boolean bank, int tries, boolean onGround, boolean bankAbove, boolean staired, int swims) {
		return waterMove(underwater, air, bank, tries, onGround, bankAbove, staired, swims, false, false);
	}

	static WaterMove waterMove(boolean underwater, int air, boolean bank, int tries, boolean onGround, boolean bankAbove, boolean staired, int swims, boolean canFill) {
		return waterMove(underwater, air, bank, tries, onGround, bankAbove, staired, swims, canFill, false);
	}

	/**
	 * {@code canFill}: no bank, a small enclosed pool (a flooded shaft) and plain blocks carried. A player there fills the
	 * water under them from the bottom up until standing dry, and then climbs out of the hole that is left.
	 * {@code canStep}: no bank, afloat under a ceiling (a shaft that broke into a flooded cave): place a block into the
	 * water beside the body against the ceiling's underside, break the ceiling over it, and climb onto it.
	 */
	static WaterMove waterMove(boolean underwater, int air, boolean bank, int tries, boolean onGround, boolean bankAbove, boolean staired, int swims, boolean canFill, boolean canStep) {
		if (underwater && (!bank || air < SWIM_FIRST_AIR) && swims < MAX_TRIES && !(canFill && air >= SWIM_FIRST_AIR)) return WaterMove.SWIM;
		if (!bank) return canFill ? WaterMove.FILL : canStep && !underwater ? WaterMove.STEP : underwater ? WaterMove.NO_WAY : WaterMove.NO_SHORE;
		// dig_to stops at once with the eyes under water (WATER_AHEAD), so the stairs start only from breathable footing.
		if (tries > 2 && onGround && !underwater && bankAbove && !staired) return WaterMove.STAIRS;
		if (tries > MAX_TRIES + 1) return WaterMove.NO_WAY;
		return WaterMove.TRAVEL;
	}

	private TickResult water(ServerPlayer player, long now) {
		// A step being cut beside the body: break the ceiling over the placed block, then the bank search finds it.
		if (stepSite != null) {
			Level level = player.level();
			if (solid(level, stepSite)) {
				for (BlockPos over : List.of(stepSite.above(), stepSite.above(2))) {
					if (solid(level, over)) return startChild(player, environment.clear(player, over, childMs(now)), "break the ceiling at " + over.toShortString() + " over the step");
				}
			}
			stepSite = null;
		}
		BlockPos bank = bank(player, bankTries);
		// travel_to counts a stop within a block of the bank as arrived, often still treading water at its edge: a player
		// holds forward and jump against the bank there.
		if (bank != null && !player.isUnderWater() && besideBank(player, bank) && climbs < MAX_TRIES) {
			climbs++;
			return startMove(player, climbOut(bank), "climb out onto the bank at " + bank.toShortString());
		}
		int tries = bank == null ? 0 : bankTries.merge(bank, 1, Integer::sum);
		boolean bankAbove = bank != null && bank.getY() > player.getBlockY();
		String block = plainBlock(player);
		Column column = bank == null && block != null && fills < MAX_TRIES ? fillColumn(player.level(), player.blockPosition()) : null;
		boolean canFill = column != null && ServerBuildController.carried(player, block) >= column.depth();
		BlockPos step = bank == null && !canFill && block != null && steps < MAX_TRIES ? stepSite(player) : null;
		WaterMove next = waterMove(player.isUnderWater(), player.getAirSupply(), bank != null, tries, player.onGround(), bankAbove,
				bank != null && stairedBanks.contains(bank), swims, canFill, step != null);
		return switch (next) {
			case SWIM -> {
				if (bank != null) bankTries.merge(bank, -1, Integer::sum);
				swims++;
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
			case STEP -> {
				steps++;
				stepSite = step.immutable();
				yield startMove(player, placeInto(step, Direction.DOWN, block), "place a step at " + step.toShortString() + " against the ceiling");
			}
			case FILL -> {
				fills++;
				yield startMove(player, fillUnder(block, column.top().getX(), column.top().getZ()), "fill the " + column.depth() + " water cells under the body with " + block.replace("minecraft:", ""));
			}
			case TRAVEL -> {
				travelBank = bank.immutable();
				yield startChild(player, environment.travel(player, bank, childMs(now)), "out of the water to the bank at " + bank.toShortString());
			}
		};
	}

	/** Within a block and a half of the bank, not more than a block below its floor: one push of forward and jump. */
	static boolean besideBank(ServerPlayer player, BlockPos bank) {
		double dx = bank.getX() + 0.5D - player.getX(), dz = bank.getZ() + 0.5D - player.getZ();
		return dx * dx + dz * dz <= 2.25D && bank.getY() - player.getY() <= 1.3D;
	}

	/** Face the bank and hold forward and jump, as a player climbs out of water; done on dry footing, failed after 3 s. */
	static EscapeMoves.Move climbOut(BlockPos bank) {
		int[] ticks = {0};
		return (player, input) -> {
			if (player.onGround() && !player.isInWater()) return new EscapeMoves.Result(EscapeMoves.Status.DONE, "on the bank at " + player.blockPosition().toShortString());
			if (++ticks[0] > 60) return new EscapeMoves.Result(EscapeMoves.Status.FAILED, "still in the water after 3 s pushing onto the bank");
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
	 * A water cell beside the body's feet with a breakable solid block over it (the ceiling of a flooded cave the body
	 * floats up against) and the body's head in air: a block placed there against the ceiling's underside, with the two
	 * ceiling blocks over it broken, is a dry step out of the water. Null when no side offers one.
	 */
	static BlockPos stepSite(ServerPlayer player) {
		Level level = player.level();
		BlockPos body = player.blockPosition();
		// Afloat, the feet are in the lake's top cell or just above it in the shaft: the step goes at the lake's top level.
		BlockPos feet = level.getFluidState(body).is(net.minecraft.tags.FluidTags.WATER) && !level.getFluidState(body.above()).is(net.minecraft.tags.FluidTags.WATER) ? body
				: level.getFluidState(body.below()).is(net.minecraft.tags.FluidTags.WATER) ? body.below() : null;
		if (feet == null || !clear(level, feet.above())) return null;
		BlockPos best = null;
		for (Direction side : Direction.Plane.HORIZONTAL) {
			BlockPos site = feet.relative(side);
			if (!level.getFluidState(site).is(net.minecraft.tags.FluidTags.WATER) || !level.getBlockState(site).canBeReplaced()) continue;
			if (!breakable(player, site.above()) || !level.getBlockState(site.above()).isFaceSturdy(level, site.above(), Direction.DOWN)) continue;
			BlockPos head = site.above(2);
			if (solid(level, head) ? !breakable(player, head) : !clear(level, head)) continue;
			if (!level.getFluidState(head.above()).isEmpty()) continue;
			if (best == null) best = site;
		}
		return best;
	}

	/** A solid block the body can break: by hand when soft, else with a carried tool that harvests it; never bedrock. */
	private static boolean breakable(ServerPlayer player, BlockPos cell) {
		BlockState state = player.level().getBlockState(cell);
		if (state.isAir() || !state.getFluidState().isEmpty()) return false;
		float hardness = state.getDestroySpeed(player.level(), cell);
		if (hardness < 0.0F) return false;
		return !state.requiresCorrectToolForDrops() && hardness <= 1.0F || ServerDigController.toolSlot(player, state) >= 0;
	}

	/** Look at the face and place one block into cell {@code at}, afloat with jump in water; done once the cell is solid. */
	EscapeMoves.Move placeInto(BlockPos at, Direction face, String item) {
		int[] ticks = {0};
		return (player, input) -> {
			if (solid(player.level(), at)) return new EscapeMoves.Result(EscapeMoves.Status.DONE, "placed " + item.replace("minecraft:", "") + " at " + at.toShortString());
			if (++ticks[0] > 100) return new EscapeMoves.Result(EscapeMoves.Status.FAILED, "could not place into " + at.toShortString());
			net.minecraft.world.phys.Vec3 aim;
			try { aim = environment.aim(player, at, face, item); }
			catch (RuntimeException refused) { aim = net.minecraft.world.phys.Vec3.atCenterOf(at).add(-face.getStepX() * 0.499D, -face.getStepY() * 0.499D, -face.getStepZ() * 0.499D); }
			// A face that points down (a roof's underside) is seen only from below it: afloat with the eyes above it, sink
			// (sneak) until they are under it, then hold there; any other face keeps the body afloat with jump.
			double eye = player.getEyeY(), faceY = at.getY() + 1.0D;
			boolean below = face != Direction.DOWN || eye < faceY - 0.15D;
			boolean sneak = player.isInWater() && !below;
			boolean jump = player.isInWater() && (face != Direction.DOWN || eye < faceY - 0.9D);
			var look = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.lookingAt(player, aim, 0, 0, jump, sneak, false, false, false, net.minecraft.world.InteractionHand.MAIN_HAND);
			float yaw = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnYaw(player.getYRot(), look.yaw());
			float pitch = dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.turnPitch(player.getXRot(), look.pitch());
			input.accept(new dev.agaminggod.mineagen.server.runtime.input.AgentInputState(0.0F, 0.0F, jump, sneak, false, false, false, yaw, pitch,
					player.getInventory().getSelectedSlot(), net.minecraft.world.InteractionHand.MAIN_HAND));
			if (!below) return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "sinking under the roof to see " + at.toShortString() + "'s top");
			if (Math.abs(dev.agaminggod.mineagen.server.runtime.input.AgentInputStates.shortestAngleDelta(yaw, look.yaw())) > 1.0F || Math.abs(pitch - look.pitch()) > 1.0F)
				return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "looking at " + at.toShortString());
			try { environment.place(player, at, face, item); } catch (RuntimeException refused) { /* not ready; try again next tick */ }
			return new EscapeMoves.Result(EscapeMoves.Status.RUNNING, "placing at " + at.toShortString());
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
			if (ServerBuildController.carried(player, item) == 0) return new EscapeMoves.Result(EscapeMoves.Status.FAILED, "ran out of " + item + " after filling " + ticks[2] + " cells");
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
		if (covers >= MAX_TRIES) return finish(player, TickResult.failed("ESCAPE_EXPOSED", "Still in sight of " + type(shooterNear(player))
				+ " after " + covers + " cover moves" + done() + facts(player), 0.5D));
		covers++;
		return startMove(player, EscapeMoves.takeCover(COVER_WITHIN), "cover from " + type(shooterNear(player)));
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
		// A cover move that found no cover and had no blocks to build one hands the choice back now.
		if (result.status() == EscapeMoves.Status.FAILED && moveLabel.startsWith("cover") && situation(player) == Situation.SHOOTERS) {
			return finish(player, TickResult.failed("ESCAPE_EXPOSED", "No cover from " + type(shooterNear(player)) + " here: " + result.detail() + done() + facts(player), 0.5D));
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
		if (result.state() != State.SUCCEEDED) {
			try { child.cancel(player); } catch (RuntimeException ignored) { /* the child is done either way */ }
		}
		note(childLabel + (result.state() == State.SUCCEEDED ? ": " : " (" + result.reasonCode() + "): ") + shortMessage(result.message()));
		// travel stopping to breathe is progress, not a missed bank: the swim to air comes next and the walk goes on.
		if (travelBank != null && ("AIR_RESERVE_REACHED".equals(result.reasonCode()) || "BREATH_NOT_COVERED".equals(result.reasonCode()))) bankTries.merge(travelBank, -1, Integer::sum);
		travelBank = null;
		child = null;
		return TickResult.running(0.5D);
	}

	private long childMs(long now) {
		return Math.max(1_000L, Math.min(CHILD_MS, deadline - now));
	}

	@Override
	public void cancel(ServerPlayer player) {
		if (child != null) child.cancel(player);
		child = null;
		move = null;
		input.release();
	}

	@Override
	public void resumed(ServerPlayer player) {
		// A reflex held the body (a raised shield, a swim up): the old move's picture is stale, so look again.
		if (child != null) child.resumed(player);
		move = null;
		safeTicks = 0;
		input.release();
	}

	private TickResult finish(ServerPlayer player, TickResult result) {
		if (child != null) child.cancel(player);
		child = null;
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
		dev.agaminggod.mineagen.client.navigation.WalkabilityView dry = cell -> {
			var kind = seen.cellAt(cell);
			return kind == dev.agaminggod.mineagen.client.navigation.WalkabilityView.Cell.WATER ? dev.agaminggod.mineagen.client.navigation.WalkabilityView.Cell.BLOCKED : kind;
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
				if (!pool.contains(next) && level.isLoaded(next) && level.getFluidState(next).is(net.minecraft.tags.FluidTags.WATER)) {
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
