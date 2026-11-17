package dev.agaminggod.mineagen.server.runtime;

import dev.agaminggod.mineagen.agent.AgentDomainException;
import dev.agaminggod.mineagen.server.perception.ThreatPerception;
import dev.agaminggod.mineagen.server.runtime.controller.ServerController;
import dev.agaminggod.mineagen.server.runtime.controller.ServerLookController;
import dev.agaminggod.mineagen.server.runtime.controller.ServerNavigationController;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputRuntime;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputState;
import dev.agaminggod.mineagen.server.runtime.input.AgentInputStates;
import dev.agaminggod.mineagen.server.runtime.input.InputLease;
import dev.agaminggod.mineagen.server.runtime.input.InputOwner;
import dev.agaminggod.mineagen.server.runtime.input.LeasedServerInputController;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.HashSet;
import java.util.List;
import java.util.Locale;
import java.util.Set;
import java.util.function.BiPredicate;
import java.util.function.Function;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.resources.ResourceKey;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.InteractionHand;
import net.minecraft.world.InteractionResult;
import net.minecraft.world.entity.Mob;
import net.minecraft.world.item.BlockItem;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.tags.FluidTags;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.EmptyBlockGetter;
import net.minecraft.world.level.Level;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.EntityBlock;
import net.minecraft.world.level.block.FallingBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.level.material.FluidState;
import net.minecraft.world.level.material.Fluids;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.BlockHitResult;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/**
 * cast_obsidian: obsidian made in place with buckets, as a player does it. Count mode pours a water bucket at the edge of a
 * seen lava pool so the flow runs over the lava sources (vanilla turns a lava source with water above or beside it into
 * obsidian), waits for the flow, then scoops the water back. Frame mode builds a 4x5 Nether portal frame cell by cell:
 * water poured into a cell beside the frame cell, lava from the pool poured into the frame cell (cast at once by the water
 * beside it), the water scooped back. Every click is a vanilla item use along the body's eased look, within vanilla reach,
 * at a face the eye can see; every lava pour passes the same LAVA_POUR_AT_BODY check use_item applies. Every judgement of
 * the terrain (frame cells done, blocked or still to cast, water and mould cells, standing spots, the result text) reads
 * what the body has seen or remembers ({@link dev.agaminggod.mineagen.server.perception.SeenTerrain}, plus the frame
 * cells it has seen during this call); a frame cell it has not seen is looked at first, walked to if still hidden, and
 * reported as unknown, never read from the live world.
 */
public final class ServerCastObsidianController implements ServerController {
	static final double HOSTILE_RANGE = 12.0D;
	static final float LOW_HEALTH = 8.0F;
	/** Flowing water crosses its 7 cells at 5 ticks a cell. */
	static final int WATER_FLOW_TICKS = 40;
	/** Ticks between two clicks: a hotbar swap and a click. */
	static final int ACT_PAUSE_TICKS = 2;
	static final int MAX_TURN_TICKS = 30;
	static final int MAX_WALKS = 12;
	static final int SEARCH = 6;
	static final int LAVA_SEARCH = 16;
	/** How far from the model's x,y,z a frame site may move: the model names the area, the body picks the clear plane. */
	static final int SITE_SEARCH = 6;
	/** Mining ticks a frame dig accepts per block with the best carried tool (deepslate: 15 with an iron pickaxe). */
	static final int MAX_MINE_TICKS = 100;
	static final int MAX_REDIGS = 6;
	static final double LAVA_FIRST_MARGIN_S = 3.0D;
	static final int DRAIN_TICKS = 60;
	/** Ticks the body looks toward an unseen frame cell before walking to see it. */
	static final int LOOK_TICKS = 15;
	private boolean siteChosen;
	private int siteLooks;
	private Vec3 siteAim;
	private static final Direction[] COOLING = { Direction.UP, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST };

	enum Kind { FILL_LAVA, POUR_WATER, POUR_LAVA, SCOOP_WATER, PLACE_MOULD }

	/** One click: the item it needs, the aim, and the block/face (or fluid cell) its ray must meet. */
	record Step(Kind kind, Item item, BlockPos clicked, Direction face, BlockPos cell, Vec3 aim) { }

	private final BlockPos requested;
	private BlockPos site;
	/** Cells the chosen frame needs open that hold rock, mined with the carried pickaxe before (or during) the cast. */
	private final List<BlockPos> digs = new ArrayList<>();
	private BlockPos mining;
	private int miningTicks, aimTicks, mined, redigs, skips, drainTicks;
	private boolean finishWalked;
	private InputLease lease;
	private LeasedServerInputController input;
	private final Set<BlockPos> poolMemory = new HashSet<>();
	private Vec3 lookAim;
	private int lookSteps, looks;
	private String siteNote;
	/** A lava-first pour that has no water on it yet: a stop before the water click leaves it flowing. */
	private BlockPos pendingLava;
	private Direction.Axis askedAxis = Direction.Axis.X;
	/** Cells mined beside or above the top row for its casting water: never filled with a mould block. */
	private final Set<BlockPos> waterRoom = new HashSet<>();
	private static final boolean DEBUG_TRACE = Boolean.getBoolean("arena.castTrace");
	private final StringBuilder trace = new StringBuilder();
	private final boolean frame;
	private final boolean resume;
	private String siteRejection;
	private final int count;
	private final long timeoutMs;
	private final BiPredicate<ServerPlayer, BlockPos> mayModify;
	private final ElapsedTimeAccumulator elapsed;
	private Direction.Axis axis;
	private ResourceKey<Level> dimension;
	/** Cells the body has known as not obsidian during this call: only these can count as obsidian it made. */
	private final Set<BlockPos> knownOpen = new HashSet<>();
	private final java.util.Map<BlockPos, Integer> refusals = new java.util.HashMap<>();
	private final Set<BlockPos> refused = new HashSet<>();
	private String lastRefusal;
	private float lastHealth = Float.NaN;
	private Step step;
	private int turnTicks, pause;
	private BlockPos placedWater;
	private BlockPos waterFor;
	private final Set<BlockPos> waterFirst = new HashSet<>();
	private final Set<BlockPos> lavaFirst = new HashSet<>();
	private int waterTicks;
	private ServerNavigationController walk;
	private int walks;
	private final Set<BlockPos> triedSpots = new HashSet<>();
	private String lastWalkFailure;
	private int waterPours, lavaPours, scoops, fills, moulds;
	/** Frame cells as last seen during this call (a player remembers the frame being cast). */
	private final java.util.Map<BlockPos, BlockState> frameRecall = new java.util.HashMap<>();
	/** New obsidian the body has seen (count mode), and the frame as last read, for progress and the result. */
	private final Set<BlockPos> madeSeen = new HashSet<>();
	private FrameRead lastRead;
	private BlockPos lookCell;
	private int lookTicks;

	public ServerCastObsidianController(BlockPos site, String axis, boolean frame, int count, long timeoutMs, long startedAt,
			BiPredicate<ServerPlayer, BlockPos> mayModify) {
		this(site, axis, frame, false, count, timeoutMs, startedAt, mayModify);
	}

	public ServerCastObsidianController(BlockPos site, String axis, boolean frame, boolean resume, int count, long timeoutMs, long startedAt,
			BiPredicate<ServerPlayer, BlockPos> mayModify) {
		if (resume && (!frame || !("x".equals(axis) || "z".equals(axis))))
			throw new IllegalArgumentException("resume:true requires frame:true and explicit axis");
		this.resume = resume;
		this.requested = site.immutable();
		this.site = this.requested;
		this.axis = axis == null ? null : axis.equals("z") ? Direction.Axis.Z : Direction.Axis.X;
		this.frame = frame;
		this.count = Math.max(1, count);
		this.timeoutMs = timeoutMs;
		this.mayModify = mayModify;
		this.elapsed = new ElapsedTimeAccumulator(startedAt);
	}

	@Override
	public TickResult tick(ServerPlayer player, long nowEpochMs) {
		ServerLevel level = (ServerLevel) player.level();
		if (dimension == null) start(player, level);
		if (!player.level().dimension().equals(dimension)) return stop(player, "ACTION_DIMENSION_CHANGED", "The body changed dimension");
		if (elapsed.advance(nowEpochMs) >= timeoutMs) {
			release(player);
			return TickResult.timedOut("CAST_TIMED_OUT", summary(player, "timeoutMs ran out"), progress(level));
		}
		TickResult danger = danger(player);
		if (danger != null) return danger;
		if (frame && !siteChosen) return surveySite(player, level);
		if (resume && siteRejection != null) return stop(player, "FRAME_SITE_INVALID", "Requested resume plane " + xyz(requested) + " axis " + axisName() + " refused: " + siteRejection);
		if (placedWater != null) waterTicks++;
		if (walk != null) {
			TickResult moved = walk.tick(player, nowEpochMs);
			if (moved.state() == State.RUNNING) return TickResult.running(progress(level));
			walk.cancel(player);
			walk = null;
			// A walk that could not arrive leaves that spot tried; the next plan picks another (walks are capped).
			if (moved.state() != State.SUCCEEDED) lastWalkFailure = moved.reasonCode() + " " + moved.message();
		}
		if (pause > 0) { pause--; return TickResult.running(progress(level)); }
		if (step == null) {
			TickResult planned = frame ? planFrame(player, level, nowEpochMs) : planCount(player, level, nowEpochMs);
			if (planned != null) return planned;
			if (step == null) return TickResult.running(progress(level));
		}
		return perform(player, level);
	}

	@Override
	public void cancel(ServerPlayer player) {
		release(player);
	}

	private void release(ServerPlayer player) {
		releaseInput();
		if (walk != null) walk.cancel(player);
		walk = null;
		step = null;
	}

	private void start(ServerPlayer player, ServerLevel level) {
		dimension = level.dimension();
		lastHealth = player.getHealth();
		if (frame && axis == null) axis = inferAxis(player, level);
		// The baseline is what the body knows at the start: a cell it has not seen stays unknown, not "not obsidian".
		trackObsidian(obsidianCells(), obsidianView(player, level), knownOpen, madeSeen);
	}

	/** Observe the named area before ranking it: turning acquires terrain, never a hidden-world baseline. */
	private TickResult surveySite(ServerPlayer player, ServerLevel level) {
		if (siteAim == null) {
			double yaw = Math.toRadians((siteLooks % 6) * 60.0D);
			siteAim = player.getEyePosition().add(-Math.sin(yaw) * 6.0D, siteLooks < 6 ? -3.0D : 2.0D, Math.cos(yaw) * 6.0D);
		}
		if (ServerLookController.turnToward(player, siteAim)) {
			var seen = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player);
			for (BlockPos at : BlockPos.betweenClosed(requested.offset(-SITE_SEARCH, -4, -SITE_SEARCH), requested.offset(SITE_SEARCH + 3, 6, SITE_SEARCH + 3)))
				seen.known(at.getX(), at.getY(), at.getZ());
			siteAim = null;
			if (++siteLooks >= 12) {
				chooseSite(player, level);
				siteChosen = true;
				trackObsidian(obsidianCells(), obsidianView(player, level), knownOpen, madeSeen);
			}
		}
		return TickResult.running(progress(level));
	}

	/** The cell as the body knows it: seen or touched now, else remembered (frame cells: as seen during this call), else null. */
	private BlockState known(ServerPlayer player, BlockPos at) {
		BlockState seen = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player).known(at.getX(), at.getY(), at.getZ());
		boolean frameCell = frame && axis != null && frameCells().contains(at);
		if (seen != null) { if (frameCell) frameRecall.put(at.immutable(), seen); return seen; }
		return frameCell ? frameRecall.get(at) : null;
	}

	private boolean knownLava(ServerPlayer player, BlockPos at) {
		BlockState state = known(player, at);
		return state != null && state.getFluidState().isSource() && state.getFluidState().getType().isSame(Fluids.LAVA);
	}

	private Function<BlockPos, BlockState> knownView(ServerPlayer player) {
		return at -> known(player, at);
	}

	/**
	 * What the body knows of the frame: the cells known cast, the cells known not cast, the cells it has not seen, and
	 * the next cell to work (bottom row first: an unseen cell, or one known not cast that was not given up).
	 */
	record FrameRead(BlockPos next, List<BlockPos> missing, List<BlockPos> unknown, int done) {
		boolean complete() { return missing.isEmpty() && unknown.isEmpty(); }
	}

	static FrameRead readFrame(List<BlockPos> cells, Set<BlockPos> refused, Function<BlockPos, BlockState> known) {
		BlockPos next = null;
		List<BlockPos> missing = new ArrayList<>(), unknown = new ArrayList<>();
		int done = 0;
		for (BlockPos c : cells) {
			BlockState state = known.apply(c);
			if (state == null) { unknown.add(c); if (next == null) next = c; }
			else if (state.is(Blocks.OBSIDIAN)) done++;
			else { missing.add(c); if (next == null && !refused.contains(c)) next = c; }
		}
		return new FrameRead(next, missing, unknown, done);
	}

	private boolean knownObsidian(ServerPlayer player, BlockPos at) {
		BlockState state = known(player, at);
		return state != null && state.is(Blocks.OBSIDIAN);
	}

	private Direction.Axis inferAxis(ServerPlayer player, ServerLevel level) {
		for (int i = 1; i <= 3; i++) {
			if (knownObsidian(player, site.offset(i, 0, 0)) || knownObsidian(player, site.offset(i, 1, 0))) return Direction.Axis.X;
			if (knownObsidian(player, site.offset(0, 0, i)) || knownObsidian(player, site.offset(0, 1, i))) return Direction.Axis.Z;
		}
		Vec3 d = Vec3.atCenterOf(site).subtract(player.position());
		return Math.abs(d.x) > Math.abs(d.z) ? Direction.Axis.Z : Direction.Axis.X;
	}


	/**
	 * The model's x,y,z is "a frame near here": the site within {@link #SITE_SEARCH} blocks whose ten frame cells and six
	 * opening cells are open, castable or already obsidian with the fewest blocks to mine, the given site and axis winning
	 * ties. A site is refused when a cell to mine holds a block entity, needs more than {@link #MAX_MINE_TICKS} with the
	 * carried tools, has a loose block above it or has seen lava beside it.
	 */
	private void chooseSite(ServerPlayer player, ServerLevel level) {
		Direction.Axis asked = axis == null ? inferAxis(player, level) : axis;
		var seen = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player);
		chooseSite(asked, (o, a, need) -> siteCost(player, level, seen, o, a, need), player.getEyePosition());
	}

	@FunctionalInterface
	interface SiteCost { double evaluate(BlockPos origin, Direction.Axis axis, List<BlockPos> need); }

	/** Both modes use the same evaluator; resume changes only the candidate set. */
	void chooseSite(Direction.Axis asked, SiteCost evaluate, Vec3 eye) {
		askedAxis = asked;
		Direction.Axis other = asked == Direction.Axis.X ? Direction.Axis.Z : Direction.Axis.X;
		BlockPos bestOrigin = null;
		Direction.Axis bestAxis = asked;
		List<BlockPos> bestDigs = List.of();
		double best = Double.MAX_VALUE;
		for (Direction.Axis a : resume ? new Direction.Axis[] { asked } : new Direction.Axis[] { asked, other })
			for (BlockPos o : resume ? List.of(requested) : BlockPos.betweenClosed(requested.offset(-SITE_SEARCH, -3, -SITE_SEARCH), requested.offset(SITE_SEARCH, 2, SITE_SEARCH))) {
				List<BlockPos> need = new ArrayList<>();
				double cost = evaluate.evaluate(o.immutable(), a, need);
				if (cost == Double.MAX_VALUE) continue;
				cost += 0.25D * Math.sqrt(o.distSqr(requested)) + (a == asked ? 0.0D : 1.0D);
				if (cost < best) { best = cost; bestOrigin = o.immutable(); bestAxis = a; bestDigs = need; }
			}
		axis = asked;
		if (bestOrigin == null) {
			if (resume) {
				if (siteRejection == null) siteRejection = "site validation failed";
			} else siteNote = "no clear or minable frame site within " + SITE_SEARCH + " blocks of " + xyz(requested);
			return;
		}
		site = bestOrigin;
		axis = bestAxis;
		digs.addAll(bestDigs);
		for (BlockPos d : bestDigs) if (!frameCells().contains(d) && !interior(d)) waterRoom.add(d);
		if (resume) siteRejection = null;
		digs.sort(Comparator.comparingDouble(c -> Vec3.atCenterOf(c).distanceToSqr(eye)));
		if (!site.equals(requested) || !digs.isEmpty())
			siteNote = "frame site " + xyz(site) + " axis " + axisName() + " (asked " + xyz(requested) + "), " + digs.size() + " blocks to mine";
	}

	private static BlockPos at(BlockPos o, Direction.Axis a, int i, int y) {
		return a == Direction.Axis.Z ? o.offset(0, y, i) : o.offset(i, y, 0);
	}

	/** Seen site costs only: unknown cells add uncertainty and are observed before any mining or placement. */
	private double siteCost(ServerPlayer player, ServerLevel level, dev.agaminggod.mineagen.server.perception.SeenTerrain.Reader<BlockState> seen,
			BlockPos o, Direction.Axis a, List<BlockPos> need) {
		return siteCost(level, knownView(player), (p, state) -> clearance(player, level, p, state),
				p -> mayModify.test(player, p), p -> seen.known(p.getX(), p.getY(), p.getZ()), o, a, need,
				reason -> siteRejection = reason);
	}

	static double siteCost(net.minecraft.world.level.BlockGetter level, Function<BlockPos, BlockState> known,
			java.util.function.ToIntBiFunction<BlockPos, BlockState> clearance, java.util.function.Predicate<BlockPos> mayModify,
			Function<BlockPos, BlockState> seen, BlockPos o, Direction.Axis a, List<BlockPos> need, java.util.function.Consumer<String> reject) {
		double cost = 0.0D;
		int[][] cells = { {1, 0}, {2, 0}, {0, 1}, {3, 1}, {0, 2}, {3, 2}, {0, 3}, {3, 3}, {1, 4}, {2, 4} };
		Set<BlockPos> plane = new HashSet<>();
		for (int[] c : cells) plane.add(at(o, a, c[0], c[1]));
		for (int i = 1; i <= 2; i++) for (int y = 1; y <= 3; y++) plane.add(at(o, a, i, y));
		for (int[] c : cells) {
			BlockPos p = at(o, a, c[0], c[1]);
			BlockState s = known.apply(p);
			if (s == null) { cost += 2.0D; need.add(p); continue; }
			if (s.is(Blocks.OBSIDIAN)) { cost -= 2.0D; continue; }
			if (sourceLava(known, p)) continue;
			int r = clearance.applyAsInt(p, s);
			if (r < 0) return rejectSite(reject, "cell " + xyz(p) + " is not clear or safely minable");
			if (r == 1) need.add(p);
		}
		for (int i = 1; i <= 2; i++) for (int y = 1; y <= 3; y++) {
			BlockPos p = at(o, a, i, y);
			BlockState s = known.apply(p);
			if (s == null) { cost += 2.0D; need.add(p); continue; }
			if (s.is(Blocks.OBSIDIAN) || s.getFluidState().is(FluidTags.LAVA) || s.getFluidState().isSource()) return rejectSite(reject, "opening cell " + xyz(p) + " holds obsidian or source fluid/lava");
			int r = clearance.applyAsInt(p, s);
			if (r < 0) return rejectSite(reject, "cell " + xyz(p) + " is not clear or safely minable");
			if (r == 1) need.add(p);
		}
		Direction normal = a == Direction.Axis.Z ? Direction.EAST : Direction.SOUTH;
		Direction side = null;
		for (int i = 0; i <= 3 && side == null; i++) for (int k : new int[] { 1, -1, 2, -2 }) {
			for (int dy = -1; dy <= 1; dy++) if (standable(known, level, at(o, a, i, dy).relative(normal, k))) { side = k > 0 ? normal : normal.getOpposite(); break; }
			if (side != null) break;
		}
		if (side == null) return rejectSite(reject, "no known safe standing spot beside this plane");
		// The opening needs a way in: the two cells in front of its lower half on one side, open or mined on the body's side.
		BlockPos low = at(o, a, 1, 1), high = at(o, a, 1, 2);
		boolean wayIn = false;
		for (Direction d : new Direction[] { side, side.getOpposite() })
			if (clearance.applyAsInt(low.relative(d), known.apply(low.relative(d))) == 0
					&& clearance.applyAsInt(high.relative(d), known.apply(high.relative(d))) == 0) { wayIn = true; break; }
		if (!wayIn) for (BlockPos f : new BlockPos[] { low.relative(side), high.relative(side) }) {
			BlockState state = known.apply(f);
			if (state == null) { cost += 2.0D; need.add(f); continue; }
			int r = clearance.applyAsInt(f, state);
			if (r < 0) return rejectSite(reject, "cell " + xyz(f) + " is not clear or safely minable");
			if (r == 1) need.add(f);
		}
		// Each top-row cell needs a cell beside it out of the plane to take the casting water: the eye below sees a face
		// there, where a cell above the frame shows one only through the top cell itself. Mined on the body's side.
		for (int i = 1; i <= 2; i++) {
			BlockPos top = at(o, a, i, 4);
			if (openKnown(known, top.relative(normal)) || openKnown(known, top.relative(normal.getOpposite()))) continue;
			BlockPos notch = top.relative(side);
			if (known.apply(notch) == null || clearance.applyAsInt(notch, known.apply(notch)) == 1) { need.add(notch); continue; }
			if (openKnown(known, top.above())) continue;
			BlockPos up = top.above();
			if (clearance.applyAsInt(up, known.apply(up)) != 1) return rejectSite(reject, "no known safe water clearance at " + xyz(top));
			need.add(up);
		}
		for (int i = 1; i <= 2; i++) {
			BlockPos below = at(o, a, i, -1);
			BlockState floor = known.apply(below);
			if (floor == null) { cost += 2.0D; continue; }
			if (floor.getFluidState().is(FluidTags.LAVA)) return rejectSite(reject, "seen lava below frame at " + xyz(below));
			if (!floor.isFaceSturdy(level, below, Direction.UP)) cost += 2.0D;
		}
		for (BlockPos p : need) {
			if (!mayModify.test(p)) return rejectSite(reject, "modification protected at " + xyz(p));
			BlockPos up = p.above();
			BlockState cap = known.apply(up);
			if (!need.contains(up) && cap != null && cap.getBlock() instanceof FallingBlock) return rejectSite(reject, "falling block above " + xyz(p));
			for (Direction d : Direction.values()) {
				BlockPos n = p.relative(d);
				BlockState neighbor = seen.apply(n);
				if (neighbor != null && neighbor.getFluidState().is(FluidTags.LAVA) && !(plane.contains(n) && sourceLava(known, n))) return rejectSite(reject, "seen lava beside preparation cell " + xyz(p));
			}
		}
		return cost + need.size();
	}

	private static double rejectSite(java.util.function.Consumer<String> reject, String reason) {
		reject.accept(reason);
		return Double.MAX_VALUE;
	}

	private static boolean openKnown(Function<BlockPos, BlockState> known, BlockPos p) {
		BlockState s = known.apply(p);
		return s != null && (s.isAir() || s.canBeReplaced() && s.getFluidState().isEmpty());
	}

	private static boolean sourceLava(Function<BlockPos, BlockState> known, BlockPos p) {
		BlockState s = known.apply(p);
		return s != null && s.getFluidState().isSource() && s.getFluidState().getType().isSame(Fluids.LAVA);
	}

	private BlockPos frontSpot(ServerPlayer player, ServerLevel level) {
		Direction normal = axis == Direction.Axis.Z ? Direction.EAST : Direction.SOUTH;
		BlockPos best = null;
		double bestCost = Double.MAX_VALUE;
		BlockPos light = along(1, 0);
		// Two steps out in front of the cell the light hint names walk straight in; one or three steps out are fallbacks.
		// The spot's eye must see the light cell's up face (pool 20261024: a spot on higher ground had it hidden).
		for (int k : new int[] { 2, -2, 1, -1, 3, -3 }) for (int dy = 0; dy <= 1; dy++) {
			BlockPos at = light.relative(normal, k).above(dy);
			if (!standable(knownView(player), level, at)) continue;
			Vec3 eye = Vec3.atBottomCenterOf(at).add(0.0D, player.getEyeHeight(), 0.0D);
			if (lightFace(player, level, eye) == null) continue;
			double cost = Vec3.atBottomCenterOf(at).distanceTo(player.position()) + (Math.abs(k) == 1 ? 100.0D : Math.abs(k) == 3 ? 50.0D : 0.0D);
			if (cost < bestCost) { bestCost = cost; best = at.immutable(); }
		}
		return best;
	}

	private record LightFace(BlockPos cell, Direction face) { }

	private LightFace lightFace(ServerPlayer player, ServerLevel level, Vec3 eye) {
		Direction forward = axis == Direction.Axis.Z ? Direction.SOUTH : Direction.EAST;
		List<LightFace> faces = new ArrayList<>();
		for (int i = 1; i <= 2; i++) faces.add(new LightFace(along(i, 0), Direction.UP));
		for (int i = 1; i <= 2; i++) faces.add(new LightFace(along(i, 4), Direction.DOWN));
		for (int y = 1; y <= 3; y++) {
			faces.add(new LightFace(along(0, y), forward));
			faces.add(new LightFace(along(3, y), forward.getOpposite()));
		}
		for (LightFace f : faces)
			if (TargetSightline.block(level, CollisionContext.of(player), eye, f.cell(), player.blockInteractionRange(), f.face()) != null) return f;
		return null;
	}

	private boolean drainingAtFrame(ServerPlayer player, ServerLevel level) {
		Direction normal = axis == Direction.Axis.Z ? Direction.EAST : Direction.SOUTH;
		for (int i = -1; i <= 4; i++) for (int y = -1; y <= 5; y++) for (int k = -2; k <= 2; k++)
			{ BlockState state = known(player, along(i, y).relative(normal, k)); if (state != null && state.getFluidState().is(FluidTags.WATER)) return true; }
		return false;
	}

	private boolean open(ServerPlayer player, ServerLevel level, BlockPos at) {
		BlockState s = known(player, at);
		return s != null && (s.isAir() || s.canBeReplaced() && s.getFluidState().isEmpty());
	}

	/** 0: the cell is open; 1: it holds a block the carried tools mine in time; -1: neither. */
	private static int clearance(ServerPlayer player, ServerLevel level, BlockPos at, BlockState s) {
		if (s == null) return -1;
		if (s.isAir() || s.canBeReplaced() && s.getFluidState().isEmpty()) return 0;
		if (!s.getFluidState().isEmpty()) return s.getFluidState().is(FluidTags.WATER) && !s.getFluidState().isSource() ? 0 : -1;
		if (s == null || s.is(Blocks.OBSIDIAN) || s.is(Blocks.CRYING_OBSIDIAN) || s.getBlock() instanceof EntityBlock) return -1;
		if (s.getDestroySpeed(level, at) < 0.0F) return -1;
		return toolSlot(player, s) < 0 ? -1 : 1;
	}

	private static int toolSlot(ServerPlayer player, BlockState state) {
		float hardness = state.getDestroySpeed(EmptyBlockGetter.INSTANCE, BlockPos.ZERO);
		int selected = player.getInventory().getSelectedSlot(), best = -1;
		double bestTicks = MAX_MINE_TICKS + 1;
		for (int slot = 0; slot < 36; slot++) {
			ItemStack item = player.getInventory().getItem(slot);
			if (item.isDamageableItem() && item.getMaxDamage() - item.getDamageValue() <= 1) continue;
			double ticks = mineTicks(item, state, hardness);
			if (ticks < bestTicks || ticks == bestTicks && slot == selected) { best = slot; bestTicks = ticks; }
		}
		return best;
	}

	/** Vanilla's mining time without enchantments or effects: speed over hardness, over 30 when harvestable, 100 when not. */
	static double mineTicks(ItemStack item, BlockState state, float hardness) {
		if (hardness <= 0.0F) return hardness == 0.0F ? 1.0D : Double.POSITIVE_INFINITY;
		boolean harvests = !state.requiresCorrectToolForDrops() || item.isCorrectToolForDrops(state);
		double perTick = item.getDestroySpeed(state) / hardness / (harvests ? 30.0D : 100.0D);
		return perTick <= 0.0D ? Double.POSITIVE_INFINITY : Math.ceil(1.0D / perTick);
	}

	/** Mines the next blocking cell as a player does: walk into reach, turn onto it, hold attack until it breaks. */
	private TickResult digNext(ServerPlayer player, ServerLevel level, long now) {
		BlockPos cell = digs.get(0);
		BlockState state = known(player, cell);
		if (state == null) return observe(player, level, cell, now);
		int clear = clearance(player, level, cell, state);
		if (clear < 0 && !(frameCells().contains(cell) && state.is(Blocks.OBSIDIAN)))
			return stop(player, "FRAME_CELL_BLOCKED", "Site cell " + xyz(cell) + " now seen as " + BuiltInRegistries.BLOCK.getKey(state.getBlock()) + (resume ? "; inspect this resume plane before retrying" : "; choose another site"));
		if (clear != 1) {
			if (mining != null && mining.equals(cell)) mined++;
			mining = null;
			miningTicks = aimTicks = 0;
			digs.remove(0);
			releaseInput();
			walks = 0;
			triedSpots.clear();
			// Only rock is mined, so lava in the opened cell ran in from behind it.
			if (state.getFluidState().is(FluidTags.LAVA))
				return stop(player, "LAVA_AHEAD", "Lava ran into " + xyz(cell) + " when it was mined");
			return TickResult.running(progress(level));
		}
		Vec3 eye = player.getEyePosition();
		Vec3 aim = TargetSightline.block(level, CollisionContext.of(player), eye, cell, player.blockInteractionRange(), null);
		boolean under = cell.equals(player.blockPosition().below());
		if (aim == null || under) {
			if (mining == null) for (int i = 1; i < digs.size(); i++) {
				BlockPos other = digs.get(i);
				if (!other.equals(player.blockPosition().below())
						&& TargetSightline.block(level, CollisionContext.of(player), eye, other, player.blockInteractionRange(), null) != null) {
					java.util.Collections.swap(digs, 0, i);
					return TickResult.running(progress(level));
				}
			}
			releaseInput();
			mining = null;
			return walkNear(player, level, cell, now, "no face of " + BuiltInRegistries.BLOCK.getKey(state.getBlock()) + " at " + xyz(cell) + " to mine is in reach");
		}
		int slot = toolSlot(player, state);
		if (slot < 0) return stop(player, "NO_TOOL", "No carried tool mines " + BuiltInRegistries.BLOCK.getKey(state.getBlock()) + " at " + xyz(cell) + " in time");
		if (slot >= 9) {
			releaseInput();
			var swap = AdvancedInteractionService.swapIntoHotbar(player, slot, player.getInventory().getSelectedSlot());
			if (swap != null) return stop(player, swap.reasonCode(), swap.message());
			pause = 1;
			return TickResult.running(progress(level));
		}
		if (!cell.equals(mining)) { mining = cell; miningTicks = 0; aimTicks = 0; }
		AgentInputState look = AgentInputStates.lookingAt(player, aim, 0.0F, 0.0F, false, false, false, false, false, InteractionHand.MAIN_HAND);
		float yaw = AgentInputStates.turnYaw(player.getYRot(), look.yaw());
		float pitch = AgentInputStates.turnPitch(player.getXRot(), look.pitch());
		HitResult crosshair = player.pick(player.blockInteractionRange(), 1.0F, false);
		boolean onTarget = crosshair instanceof BlockHitResult hit && hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(cell);
		if (!onTarget && ++aimTicks > MAX_TURN_TICKS * 2) {
			releaseInput();
			digs.add(digs.remove(0));
			mining = null;
			if (++skips > 16) return stop(player, "DIG_STUCK", "The view did not settle on " + xyz(cell));
			return TickResult.running(progress(level));
		}
		if (onTarget && ++miningTicks > MAX_MINE_TICKS * 3) return stop(player, "DIG_STUCK", BuiltInRegistries.BLOCK.getKey(state.getBlock()) + " at " + xyz(cell) + " did not break");
		applyInput(player, onTarget, yaw, pitch, slot);
		return TickResult.running(progress(level));
	}

	private void applyInput(ServerPlayer player, boolean attack, float yaw, float pitch, int slot) {
		if (lease == null) {
			input = AgentInputRuntime.controller(player);
			lease = input.acquire(AgentInputRuntime.requireAgentId(player), InputOwner.NAVIGATION, 100);
		}
		input.apply(lease, new AgentInputState(0.0F, 0.0F, false, false, false, attack, false, yaw, pitch, slot, InteractionHand.MAIN_HAND));
	}

	private void releaseInput() {
		if (lease == null) return;
		try {
			input.release(lease);
		} catch (LeasedServerInputController.StaleInputLeaseException ignored) {
			// A lifecycle clear may already have invalidated every lease.
		}
		lease = null;
		input = null;
	}

	/**
	 * No lava source in view or memory: look where the pool was last seen, then turn on the spot in 60 degree steps with
	 * the eyes lowered, as a player looks around, before giving up.
	 */
	private TickResult lookForLava(ServerPlayer player, ServerLevel level, String why) {
		if (lookSteps >= 7) {
			lookSteps = 0;
			lookAim = null;
			return stop(player, "NO_LAVA_IN_REACH", why + " after a full look around");
		}
		if (lookAim == null) {
			Vec3 eye = player.getEyePosition();
			BlockPos remembered = lookSteps == 0 ? poolMemory.stream().min(Comparator.comparingDouble(c -> Vec3.atCenterOf(c).distanceToSqr(eye))).orElse(null) : null;
			if (remembered != null) lookAim = Vec3.atCenterOf(remembered);
			else {
				double yaw = Math.toRadians(player.getYRot() + 60.0F);
				lookAim = eye.add(-Math.sin(yaw) * 6.0D, -2.5D, Math.cos(yaw) * 6.0D);
			}
		}
		if (ServerLookController.turnToward(player, lookAim)) {
			lookAim = null;
			lookSteps++;
			looks++;
			pause = 4;
		}
		return TickResult.running(progress(level));
	}

	private List<BlockPos> seenLava(ServerPlayer player, ServerLevel level) {
		List<BlockPos> lava = seenLavaSources(player, level, LAVA_SEARCH);
		if (!lava.isEmpty()) {
			lookSteps = 0;
			if (poolMemory.size() < 64) poolMemory.addAll(lava.subList(0, Math.min(lava.size(), 16)));
		}
		return lava;
	}


	private TickResult danger(ServerPlayer player) {
		float health = player.getHealth();
		if (health < lastHealth - 0.01F) {
			String source = player.getLastDamageSource() == null ? "unknown" : player.getLastDamageSource().getMsgId();
			return stop(player, "DAMAGE_TAKEN", String.format(Locale.ROOT, "Took %.1f damage (%s); health %.1f", lastHealth - health, source, health));
		}
		lastHealth = health;
		if (player.isInLava()) return stop(player, "IN_LAVA", "The body is in lava");
		if (player.isOnFire()) return stop(player, "ON_FIRE", "The body is burning");
		// Its own poured water may wash over the eyes for a moment; a stop comes once the breath runs down.
		if (player.isUnderWater() && player.getAirSupply() < player.getMaxAirSupply() - 60)
			return stop(player, "WATER_AHEAD", "The body's eyes are under water (air " + player.getAirSupply() + "/" + player.getMaxAirSupply() + ")");
		if (health <= LOW_HEALTH) return stop(player, "LOW_HEALTH", String.format(Locale.ROOT, "Health %.1f is at or below %.0f", health, LOW_HEALTH));
		if (player.tickCount % 5 == 0) {
			List<Mob> threats = player.level().getEntitiesOfClass(Mob.class, player.getBoundingBox().inflate(HOSTILE_RANGE),
					mob -> player.distanceTo(mob) <= HOSTILE_RANGE && ThreatPerception.isSensedThreat(player, mob));
			if (!threats.isEmpty()) {
				Mob nearest = threats.stream().min(Comparator.comparingDouble(player::distanceTo)).orElseThrow();
				return stop(player, "HOSTILE_NEAR", String.format(Locale.ROOT, "%s %s %.1f blocks away",
						BuiltInRegistries.ENTITY_TYPE.getKey(nearest.getType()), nearest.getUUID(), player.distanceTo(nearest)));
			}
		}
		return null;
	}

	private TickResult stop(ServerPlayer player, String reason, String why) {
		release(player);
		return TickResult.failed(reason, summary(player, why), progress((ServerLevel) player.level()));
	}

	private TickResult done(ServerPlayer player, String reason, String why) {
		release(player);
		return TickResult.succeeded(reason, summary(player, why));
	}


	private TickResult planCount(ServerPlayer player, ServerLevel level, long now) {
		int made = newObsidian(player, level);
		if (placedWater != null) {
			if (knownGone(player, placedWater)) { placedWater = null; return null; }
			if (made < count && waterTicks < WATER_FLOW_TICKS) return null;
			Step scoop = scoopStep(player, level, placedWater);
			if (scoop == null) return stop(player, "TARGET_OBSTRUCTED", "The water source at " + xyz(placedWater) + " is out of the bucket's reach or sight");
			step = scoop;
			return null;
		}
		if (made >= count) return done(player, "CAST_COUNT_REACHED", made + " new obsidian (asked " + count + ")");
		if (find(player, Items.WATER_BUCKET) < 0) return stop(player, "NO_WATER_BUCKET", "No water bucket carried");
		List<BlockPos> lava = seenLava(player, level);
		if (lava.isEmpty()) return lookForLava(player, level, "No lava source seen within " + LAVA_SEARCH + " blocks; " + made + " new obsidian");
		Step best = null;
		int bestScore = 0;
		BlockPos feet = player.blockPosition();
		var terrain = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player);
		for (BlockPos w : BlockPos.betweenClosed(feet.offset(-SEARCH, -3, -SEARCH), feet.offset(SEARCH, 2, SEARCH))) {
			// Skips only cells that cannot be known as air (neither remembered nor air now); the choice reads known().
			if (occupied(player, w) || terrain.recalled(w.getX(), w.getY(), w.getZ()) == null && !level.getBlockState(w).isAir()) continue;
			BlockState seen = known(player, w);
			if (seen == null || !seen.isAir()) continue;
			int score = 0;
			for (BlockPos l : lava) {
				int dx = Math.abs(l.getX() - w.getX()), dz = Math.abs(l.getZ() - w.getZ());
				if ((l.getY() == w.getY() - 1 || l.getY() == w.getY()) && dx + dz <= 4 && dx + dz >= 1) score++;
			}
			if (score <= bestScore) continue;
			Step pour = clickInto(player, level, w.immutable(), Kind.POUR_WATER, Items.WATER_BUCKET, null);
			if (pour != null && waterPickupAim(knownView(player), player.getEyePosition(), player.blockInteractionRange(), w, null, CollisionContext.of(player)) != null) { best = pour; bestScore = score; }
		}
		if (best != null) { step = best; return null; }
		return walkNear(player, level, lava.get(0), now, "no cell in reach where poured water runs onto the lava");
	}


	/** The ten frame cells a portal needs (no corners), bottom row first. */
	List<BlockPos> frameCells() {
		List<BlockPos> cells = new ArrayList<>();
		cells.add(along(1, 0)); cells.add(along(2, 0));
		for (int y = 1; y <= 3; y++) { cells.add(along(0, y)); cells.add(along(3, y)); }
		cells.add(along(1, 4)); cells.add(along(2, 4));
		return cells;
	}

	private BlockPos along(int i, int y) {
		return axis == Direction.Axis.Z ? site.offset(0, y, i) : site.offset(i, y, 0);
	}

	private boolean interior(BlockPos at) {
		for (int i = 1; i <= 2; i++) for (int y = 1; y <= 3; y++) if (along(i, y).equals(at)) return true;
		return false;
	}

	private boolean corner(BlockPos at) {
		return at.equals(along(0, 0)) || at.equals(along(3, 0)) || at.equals(along(0, 4)) || at.equals(along(3, 4));
	}

	private TickResult planFrame(ServerPlayer player, ServerLevel level, long now) {
		FrameRead read = readFrame(frameCells(), refused, knownView(player));
		lastRead = read;
		// Every plan, as in count mode: a cell seen open now and cast later counts as obsidian the body made.
		newObsidian(player, level);
		BlockPos cell = read.next();
		if (placedWater != null && knownGone(player, placedWater)) placedWater = null;
		// The water's job ends when the cell it cooled is obsidian (or the frame is done): scoop it back first.
		if (mustRecoverWater(placedWater, waterFor, cell, !digs.isEmpty(), read.unknown().contains(cell),
				find(player, Items.LAVA_BUCKET) >= 0, cell != null && knownLava(player, cell))) {
			Step scoop = scoopStep(player, level, placedWater);
			if (scoop != null) { step = scoop; return null; }
			return walkNear(player, level, placedWater, now, "the water poured at " + xyz(placedWater) + " is out of the bucket's reach");
		}
		if (!digs.isEmpty()) return digNext(player, level, now);
		if (cell == null) {
			for (BlockPos c : read.missing())
				return stop(player, "LAVA_POUR_AT_BODY", "Frame cell " + xyz(c) + " was not poured: " + lastRefusal);
			// Scooped water still drains down the frame's faces for a moment; the step into the opening waits for it.
			if (drainTicks++ < DRAIN_TICKS && drainingAtFrame(player, level)) return TickResult.running(progress(level));
			// End squarely in front of the opening: move_to stalls on the step up into it from a body pressed against the
			// frame's side (half-frame trials: 0/7 entered from beside it or one step out, 1/1 from two steps out).
			if (!finishWalked) {
				finishWalked = true;
				BlockPos front = frontSpot(player, level);
				if (front != null && !front.equals(player.blockPosition())) return walkTo(player, level, front, now);
			}
			// A moved site leads the text: a model lighting origin+1 of its own x,y,z would miss the frame.
			// The named face is one this eye sees: fire on any inner face of the frame lands in the opening and lights it.
			LightFace light = lightFace(player, level, player.getEyePosition());
			String face = light == null ? "up face of " + xyz(along(1, 0))
					: light.face().getName() + " face of " + xyz(light.cell());
			BlockPos askedLight = at(requested, askedAxis, 1, 0);
			if (!askedLight.equals(along(1, 0)))
				return done(player, "FRAME_COMPLETE", "FRAME BUILT ELSEWHERE: the complete 4x5 frame is at " + xyz(site) + " axis " + axisName()
						+ ", not at your " + xyz(requested) + "; light it with flint_and_steel on the " + face + " (not the up face of "
						+ xyz(askedLight) + "), then step into the opening at " + xyz(along(1, 1)) + " and wait 4 s");
			return done(player, "FRAME_COMPLETE", "the 4x5 frame at " + xyz(site) + " (axis " + axisName() + ") is complete; to light it use "
					+ "flint_and_steel on the " + face + ", then step into the opening at " + xyz(along(1, 1)) + " and wait 4 s");
		}
		if (read.unknown().contains(cell)) return observe(player, level, cell, now);
		lookCell = null;
		lookTicks = 0;
		BlockState there = known(player, cell);
		if (!there.isAir() && there.getFluidState().isEmpty() && !there.canBeReplaced()) {
			// A block that came into the cell after the site was chosen (a fall, a mould): mine it like the first ones.
			if (redigs < MAX_REDIGS && clearance(player, level, cell, there) == 1) {
				redigs++;
				digs.add(cell);
				return TickResult.running(progress(level));
			}
			return stop(player, "FRAME_CELL_BLOCKED", "Frame cell " + xyz(cell) + " holds " + BuiltInRegistries.BLOCK.getKey(there.getBlock()) + "; break it, then call again");
		}
		if (knownLava(player, cell)) {
			// Lava already in the cell: water beside it casts it.
			return pourWaterFor(player, level, cell, now);
		}
		boolean cooled = cooledKnown(knownView(player), cell);
		boolean hasLava = find(player, Items.LAVA_BUCKET) >= 0;
		if (!hasLava) {
			if (find(player, Items.BUCKET) < 0) {
				if (placedWater != null) { Step scoop = scoopStep(player, level, placedWater); if (scoop != null) { step = scoop; return null; } }
				return stop(player, "NO_EMPTY_BUCKET", "No empty bucket to take lava with");
			}
			List<BlockPos> lava = seenLava(player, level);
			lava.removeIf(l -> frameCells().contains(l) || interior(l));
			for (BlockPos l : lava) {
				Step fill = scoopLike(player, level, l, Kind.FILL_LAVA);
				if (fill != null) { step = fill; return null; }
			}
			if (lava.isEmpty()) return lookForLava(player, level, "No lava source seen within " + LAVA_SEARCH + " blocks to fill the bucket");
			// The nearest seen source may have no spot to stand within reach (cast over, walled off): try the next ones.
			for (int i = 0; i < Math.min(lava.size(), 8); i++) {
				BlockPos spot = standSpot(player, level, lava.get(i));
				if (spot != null) return walkTo(player, level, spot, now);
			}
			return walkNear(player, level, lava.get(0), now, "no seen lava source within " + LAVA_SEARCH + " blocks has a standing spot in reach");
		}
		// The lava's face comes first: water poured before it would flow with nowhere to cast.
		Step pour = clickInto(player, level, cell, Kind.POUR_LAVA, Items.LAVA_BUCKET, null);
		if (pour == null) {
			if (placedWater != null) { Step scoop = scoopStep(player, level, placedWater); if (scoop != null) { step = scoop; return null; } }
			Step mould = mouldChain(player, level, cell, Set.of(cell));
			if (mould != null) { step = mould; return null; }
			return walkNear(player, level, cell, now, "no face beside frame cell " + xyz(cell) + " is in reach for the lava");
		}
		if (!cooled) {
			// Lava first when a water click is ready from here: the water then casts the cell at once and is scooped a few
			// ticks later. Lava waits 30 ticks before it flows, longer than the swap and turn take.
			if (!waterFirst.contains(cell) && find(player, Items.WATER_BUCKET) >= 0 && waterStep(player, level, cell) != null) {
				lavaFirst.add(cell);
				step = pour;
				return null;
			}
			return pourWaterFor(player, level, cell, now);
		}
		step = pour;
		return null;
	}

	static boolean mustRecoverWater(BlockPos water, BlockPos waterFor, BlockPos cell,
			boolean needsDig, boolean unknown, boolean hasLava, boolean lavaThere) {
		return water != null && (needsDig || unknown || cell == null || !cell.equals(waterFor)
				|| !touches(water, cell) || !hasLava && !lavaThere);
	}

	/**
	 * A frame cell the body has not seen: it turns to look at it first; still hidden (behind a wall, or out of view from
	 * here), it walks to a spot in reach of it; with no spot left it hands back naming the cell as unknown.
	 */
	private TickResult observe(ServerPlayer player, ServerLevel level, BlockPos cell, long now) {
		if (!cell.equals(lookCell)) { lookCell = cell.immutable(); lookTicks = 0; }
		if (lookTicks++ < LOOK_TICKS) {
			ServerLookController.turnToward(player, Vec3.atCenterOf(cell));
			return TickResult.running(progress(level));
		}
		lookTicks = 0;
		BlockPos spot = walks < MAX_WALKS ? standSpot(player, level, cell) : null;
		if (spot != null) return walkTo(player, level, spot, now);
		return stop(player, "FRAME_CELL_UNSEEN", "Frame cell " + xyz(cell) + " is not in view (unknown: looked at it and found no seen spot to see it from); move where you can see it, then call again");
	}

	/** Whether a cell beside {@code cell} is known to hold water (vanilla casts lava that touches water). */
	static boolean cooledKnown(Function<BlockPos, BlockState> known, BlockPos cell) {
		for (Direction side : COOLING) {
			BlockState state = known.apply(cell.relative(side));
			if (state != null && state.getFluidState().getType().isSame(Fluids.WATER)) return true;
		}
		return false;
	}

	/** The body's poured water is known gone (it remembers pouring it until it sees otherwise). */
	private boolean knownGone(ServerPlayer player, BlockPos water) {
		return sourceGone(dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player), water);
	}

	static boolean sourceGone(dev.agaminggod.mineagen.server.perception.SeenTerrain.Reader<BlockState> terrain, BlockPos water) {
		// Recalled air may predate our own pour. Only new sight/contact can contradict the action we just performed.
		if (!terrain.seesNow(water.getX(), water.getY(), water.getZ())) return false;
		BlockState state = terrain.known(water.getX(), water.getY(), water.getZ());
		return state != null && !(state.getFluidState().isSource() && state.getFluidState().getType().isSame(Fluids.WATER));
	}

	private TickResult pourWaterFor(ServerPlayer player, ServerLevel level, BlockPos cell, long now) {
		if (find(player, Items.WATER_BUCKET) < 0) {
			if (placedWater != null) { Step scoop = scoopStep(player, level, placedWater); if (scoop != null) { step = scoop; return null; } }
			return stop(player, "NO_WATER_BUCKET", "No water bucket carried");
		}
		Step water = waterStep(player, level, cell);
		if (water != null) { step = water; waterFor = cell; return null; }
		for (BlockPos w : waterOptions(player, level, cell)) {
			if (known(player, w) == null || !known(player, w).isAir() || occupied(player, w) || fallsOnBody(player, w)) continue;
			Step mould = mouldChain(player, level, w, Set.of(cell, w));
			if (mould != null) { step = mould; return null; }
		}
		return walkNear(player, level, cell, now, "no cell beside frame cell " + xyz(cell) + " takes water from here");
	}

	private Step waterStep(ServerPlayer player, ServerLevel level, BlockPos cell) {
		List<BlockPos> options = waterOptions(player, level, cell);
		// First a cell whose flow stays off the pool until it is scooped, then any (a cast pool loses the sources the
		// next cells need: lava-pool trials cast 24 pool sources for 5 frame cells).
		for (int pass = 0; pass < 2; pass++) for (BlockPos w : options) {
			BlockState state = known(player, w);
			if (state == null || frameCells().contains(w) && state.is(Blocks.OBSIDIAN)) continue;
			if (!(state.isAir() || (!state.getFluidState().isEmpty() && !state.getFluidState().isSource())) || occupied(player, w) || fallsOnBody(player, w)) continue;
			if (pass == 0 && spills(player, level, w)) continue;
			Step pour = clickInto(player, level, w, Kind.POUR_WATER, Items.WATER_BUCKET, null);
			if (pour != null && waterPickupAim(knownView(player), player.getEyePosition(), player.blockInteractionRange(), w, cell, CollisionContext.of(player)) != null) return pour;
		}
		return null;
	}

	/** Flow steps (5 ticks each) poured water gets before it is scooped back, with the turn and the swap. */
	static final int SPILL_STEPS = 3;

	private boolean spills(ServerPlayer player, ServerLevel level, BlockPos w) {
		java.util.Map<BlockPos, Integer> reached = new java.util.HashMap<>();
		java.util.ArrayDeque<BlockPos> frontier = new java.util.ArrayDeque<>();
		reached.put(w, 0);
		frontier.add(w);
		Set<BlockPos> cells = new HashSet<>(frameCells());
		while (!frontier.isEmpty()) {
			BlockPos c = frontier.poll();
			int d = reached.get(c);
			for (Direction side : new Direction[] { Direction.DOWN, Direction.NORTH, Direction.SOUTH, Direction.EAST, Direction.WEST }) {
				BlockPos n = c.relative(side);
				BlockState state = known(player, n);
				if (!cells.contains(n) && (state == null || state.getFluidState().is(FluidTags.LAVA))) return true;
			}
			BlockPos below = c.below();
			// Water falls before it spreads: a drop carries it down at once, an open floor lets it run sideways.
			BlockState belowState = known(player, below);
			if (open(player, level, below) || belowState != null && belowState.getFluidState().is(FluidTags.WATER) && !belowState.getFluidState().isSource()) {
				if (reached.putIfAbsent(below.immutable(), d) == null && reached.size() < 64) frontier.add(below.immutable());
				continue;
			}
			if (d >= SPILL_STEPS) continue;
			for (Direction side : Direction.Plane.HORIZONTAL) {
				BlockPos n = c.relative(side);
				if ((open(player, level, n) || known(player, n) != null && known(player, n).getFluidState().is(FluidTags.WATER) && !known(player, n).getFluidState().isSource())
						&& reached.putIfAbsent(n.immutable(), d + 1) == null && reached.size() < 64) frontier.add(n.immutable());
			}
		}
		return false;
	}

	private List<BlockPos> waterOptions(ServerPlayer player, ServerLevel level, BlockPos cell) {
		List<BlockPos> options = new ArrayList<>();
		Direction normal = axis == Direction.Axis.Z ? Direction.EAST : Direction.SOUTH;
		// Above first (water there falls onto the cell), then out of the frame's plane, then along it.
		options.add(cell.above());
		options.add(cell.relative(normal)); options.add(cell.relative(normal.getOpposite()));
		for (Direction d : COOLING) if (!options.contains(cell.relative(d))) options.add(cell.relative(d));
		// Water flows about a block every 5 ticks until it is scooped: the cell farthest from the pool keeps its sources
		// from being cast over (half-frame trials stalled at 8/10 cells with the reachable sources cast away).
		List<BlockPos> pool = seenLavaSources(player, level, 10);
		pool.removeIf(l -> frameCells().contains(l));
		options.sort(Comparator.comparingInt(w -> -Math.min(5, pool.stream().mapToInt(l -> l.distManhattan(w)).min().orElse(5))));
		return options;
	}

	/**
	 * The next carried block to place so {@code target} gets a face the eye can click: a chain of at most 3 blocks, each
	 * clicked onto a face the eye sees from where it stands. Never in the frame's interior or its plane (corners
	 * excepted), never in {@code keepOpen}.
	 */
	private Step mouldChain(ServerPlayer player, ServerLevel level, BlockPos target, Set<BlockPos> keepOpen) {
		Item block = mouldItem(player);
		if (block == null) return null;
		List<BlockPos> frontier = List.of(target);
		Set<BlockPos> visited = new HashSet<>(keepOpen);
		visited.add(target);
		for (int depth = 1; depth <= 3; depth++) {
			List<BlockPos> next = new ArrayList<>();
			for (BlockPos needs : frontier) for (Direction d : Direction.values()) {
				BlockPos m = needs.relative(d);
				if (!visited.add(m) || !mouldAllowed(player, level, m)) continue;
				// m, once placed, offers its face toward the cell that needs it: the eye must see that face.
				if (!faceSeen(player, level, m, d.getOpposite())) continue;
				Step place = clickInto(player, level, m, Kind.PLACE_MOULD, block, null);
				if (place != null) return place;
				next.add(m);
			}
			frontier = next;
		}
		return null;
	}

	private boolean mouldAllowed(ServerPlayer player, ServerLevel level, BlockPos m) {
		BlockState state = known(player, m);
		if (state == null || !state.isAir() || occupied(player, m) || !mayModify.test(player, m)) return false;
		if (!frame) return true;
		if (interior(m) || frameCells().contains(m) || waterRoom.contains(m)) return false;
		boolean inPlane = axis == Direction.Axis.Z ? m.getX() == site.getX() : m.getZ() == site.getZ();
		return !inPlane || corner(m);
	}

	private static boolean faceSeen(ServerPlayer player, ServerLevel level, BlockPos at, Direction face) {
		Vec3 eye = player.getEyePosition();
		Vec3 center = Vec3.atCenterOf(at).add(face.getStepX() * 0.5D, face.getStepY() * 0.5D, face.getStepZ() * 0.5D);
		for (Vec3 point : facePoints(center, face)) {
			Vec3 toEye = eye.subtract(point);
			if (toEye.x * face.getStepX() + toEye.y * face.getStepY() + toEye.z * face.getStepZ() < 0.05D) continue;
			if (eye.distanceTo(point) > player.blockInteractionRange() - 0.05D) continue;
			BlockHitResult hit = level.clip(new ClipContext(eye, point, ClipContext.Block.OUTLINE, ClipContext.Fluid.NONE, player));
			if (hit.getType() == HitResult.Type.MISS || hit.getLocation().distanceTo(eye) >= eye.distanceTo(point) - 0.02D) return true;
		}
		return false;
	}

	private static Item mouldItem(ServerPlayer player) {
		for (Item item : new Item[] { Items.COBBLESTONE, Items.COBBLED_DEEPSLATE, Items.NETHERRACK, Items.STONE, Items.DIRT, Items.BLACKSTONE, Items.ANDESITE, Items.DIORITE, Items.GRANITE, Items.TUFF })
			if (find(player, item) >= 0) return item;
		return null;
	}


	private Step clickInto(ServerPlayer player, ServerLevel level, BlockPos cell, Kind kind, Item item, BlockPos avoid) {
		if (!mayModify.test(player, cell)) return null;
		Vec3 eye = player.getEyePosition();
		double reach = player.blockInteractionRange();
		List<Direction> sides = new ArrayList<>(List.of(Direction.values()));
		sides.sort(Comparator.comparingDouble(d -> Vec3.atCenterOf(cell.relative(d)).distanceToSqr(eye)));
		for (Direction toward : sides) {
			BlockPos support = cell.relative(toward);
			if (support.equals(avoid)) continue;
			BlockState state = known(player, support);
			Direction face = toward.getOpposite();
			if (state == null || state.isAir() || !state.getFluidState().isEmpty() && state.getCollisionShape(level, support).isEmpty()) continue;
			if (!state.isFaceSturdy(level, support, face)) continue;
			Vec3 center = Vec3.atCenterOf(support).add(face.getStepX() * 0.5D, face.getStepY() * 0.5D, face.getStepZ() * 0.5D);
			for (Vec3 aim : facePoints(center, face)) {
				if (eye.distanceTo(aim) > reach - 0.05D) continue;
				BlockHitResult hit = VanillaItemRay.atAim(player, aim, ClipContext.Fluid.NONE);
				if (hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(support) && hit.getDirection() == face)
					return new Step(kind, item, support, face, cell, aim);
			}
		}
		return null;
	}

	private static List<Vec3> facePoints(Vec3 center, Direction face) {
		List<Vec3> points = new ArrayList<>();
		points.add(center);
		double[] offsets = { -0.3D, 0.3D };
		for (double a : offsets) for (double b : offsets) {
			Vec3 p = switch (face.getAxis()) {
				case X -> center.add(0, a, b);
				case Y -> center.add(a, 0, b);
				case Z -> center.add(a, b, 0);
			};
			points.add(p);
		}
		return points;
	}

	/** Predict our source and its immediate cooling; unknown terrain still blocks the pickup ray. */
	static Vec3 waterPickupAim(Function<BlockPos, BlockState> known, Vec3 eye, double reach,
			BlockPos water, BlockPos cast, CollisionContext context) {
		int radius = (int) Math.ceil(reach) + 1;
		var after = new BreakSightline.SeenWorld(water.getY() - radius, radius * 2 + 1) {
			@Override BlockState knownState(BlockPos at) {
				if (at.equals(water)) return Blocks.WATER.defaultBlockState();
				if (at.equals(cast)) return Blocks.OBSIDIAN.defaultBlockState();
				BlockState state = known.apply(at);
				if (state != null && state.getFluidState().getType().isSame(Fluids.LAVA)) {
					boolean source = state.getFluidState().isSource();
					// Lava touching water beside or above it hardens immediately, including flow into cobblestone.
					boolean cooled = at.equals(water.below()) || at.getY() == water.getY()
							&& Math.abs(at.getX() - water.getX()) + Math.abs(at.getZ() - water.getZ()) == 1;
					// Count mode also retains the conservative preview of sources reached by later water flow.
					if (cooled || cast == null && source) return (source ? Blocks.OBSIDIAN : Blocks.COBBLESTONE).defaultBlockState();
				}
				return state;
			}
		};
		Function<Vec3, BlockHitResult> ray = aim -> {
			Vec3 delta = aim.subtract(eye);
			float yaw = (float) Math.toDegrees(Math.atan2(-delta.x, delta.z));
			float pitch = (float) -Math.toDegrees(Math.atan2(delta.y, Math.sqrt(delta.x * delta.x + delta.z * delta.z)));
			return after.clip(new ClipContext(eye, eye.add(Vec3.directionFromRotation(pitch, yaw).scale(reach)),
					ClipContext.Block.OUTLINE, ClipContext.Fluid.SOURCE_ONLY, context));
		};
		for (Direction face : Direction.values()) {
			Vec3 aim = BreakSightline.visibleFluidPoint(after, eye, water, reach, face, ray);
			if (aim != null) return aim;
		}
		return null;
	}

	private Step scoopStep(ServerPlayer player, ServerLevel level, BlockPos water) {
		if (find(player, Items.BUCKET) < 0) return null;
		return scoopLike(player, level, water, Kind.SCOOP_WATER);
	}

	/** An empty bucket aimed at a seen fluid source: the bucket's own ray (sources only) must meet it first. */
	private Step scoopLike(ServerPlayer player, ServerLevel level, BlockPos source, Kind kind) {
		if (Vec3.atCenterOf(source).distanceTo(player.getEyePosition()) > player.blockInteractionRange() + 0.9D) return null;
		try {
			Vec3 aim = BucketUse.aim(player, Items.BUCKET, Vec3.atCenterOf(source));
			BlockHitResult hit = VanillaItemRay.atAim(player, aim, ClipContext.Fluid.SOURCE_ONLY);
			if (hit.getType() != HitResult.Type.BLOCK || !hit.getBlockPos().equals(source)) return null;
			return new Step(kind, Items.BUCKET, source, hit.getDirection(), source, aim);
		} catch (AgentDomainException unreachable) {
			return null;
		}
	}

	private TickResult perform(ServerPlayer player, ServerLevel level) {
		int slot = find(player, step.item());
		if (slot < 0) { step = null; return TickResult.running(progress(level)); }
		if (player.getInventory().getSelectedSlot() != slot) {
			if (slot >= 9) {
				int hotbar = player.getInventory().getSelectedSlot();
				var swap = AdvancedInteractionService.swapIntoHotbar(player, slot, hotbar);
				if (swap != null) return stop(player, swap.reasonCode(), swap.message());
			} else {
				player.getInventory().setSelectedSlot(slot);
			}
			pause = 1;
			return TickResult.running(progress(level));
		}
		if (!ServerLookController.turnToward(player, step.aim())) {
			if (++turnTicks > MAX_TURN_TICKS) { step = null; turnTicks = 0; }
			return TickResult.running(progress(level));
		}
		turnTicks = 0;
		Step now = step;
		step = null;
		pause = ACT_PAUSE_TICKS;
		ItemStack held = player.getMainHandItem();
		boolean empty = held.is(Items.BUCKET);
		BlockHitResult hit = VanillaItemRay.hit(player, empty ? ClipContext.Fluid.SOURCE_ONLY : ClipContext.Fluid.NONE);
		boolean meets = hit.getType() == HitResult.Type.BLOCK && hit.getBlockPos().equals(now.clicked())
				&& (empty || hit.getDirection() == now.face());
		if (!meets) return TickResult.running(progress(level));
		if (now.kind() == Kind.POUR_LAVA) {
			String guard = BucketUse.lavaPourAtBody(player, held);
			// Lava first with the water click checked ready from this spot: the water casts it within half a second, long
			// before its flow (30 ticks a step) could reach the body.
			if (guard != null && lavaFirst.contains(now.cell()) && BucketUse.lavaReachSecondsAtLook(player) >= LAVA_FIRST_MARGIN_S) guard = null;
			if (guard != null) {
				// Lava first was refused (its flow could reach the body before water casts it): this cell gets water first.
				if (!BucketUse.cooled(level, now.cell()) && waterFirst.add(now.cell())) return TickResult.running(progress(level));
				// A pour the guard refuses is never made; three refusals of one cell give it up.
				if (refusals.merge(now.cell(), 1, Integer::sum) >= 3) refused.add(now.cell());
				lastRefusal = guard;
				return TickResult.running(progress(level));
			}
		}
		if (now.kind() == Kind.POUR_WATER && waterPickupAim(knownView(player), player.getEyePosition(),
				player.blockInteractionRange(), now.cell(), frame ? waterFor : null, CollisionContext.of(player)) == null)
			return TickResult.running(progress(level));
		InteractionResult result = InteractionResult.PASS;
		if (!empty && held.getItem() instanceof BlockItem) {
			result = player.gameMode.useItemOn(player, level, held, InteractionHand.MAIN_HAND, hit);
		} else {
			result = player.gameMode.useItemOn(player, level, held, InteractionHand.MAIN_HAND, hit);
			if (!result.consumesAction() && !(result instanceof InteractionResult.Fail)) result = player.gameMode.useItem(player, level, held, InteractionHand.MAIN_HAND);
		}
		if (!result.consumesAction()) return TickResult.running(progress(level));
		ArmSwing.use(player, InteractionHand.MAIN_HAND);
		triedSpots.clear();
		walks = 0;
		if (DEBUG_TRACE) trace.append(now.kind().name().charAt(0)).append(now.kind().name().charAt(5 < now.kind().name().length() ? 5 : 0))
				.append(xyz(now.cell())).append('@').append(player.tickCount).append(' ');
		switch (now.kind()) {
			case POUR_WATER -> { waterPours++; placedWater = now.cell(); waterTicks = 0; if (pendingLava != null && touches(now.cell(), pendingLava)) pendingLava = null; }
			case SCOOP_WATER -> { scoops++; if (now.cell().equals(placedWater)) placedWater = null; }
			case POUR_LAVA -> { lavaPours++; if (lavaFirst.contains(now.cell()) && !BucketUse.cooled(level, now.cell())) pendingLava = now.cell(); }
			case FILL_LAVA -> fills++;
			case PLACE_MOULD -> moulds++;
		}
		return TickResult.running(progress(level));
	}


	private TickResult walkNear(ServerPlayer player, ServerLevel level, BlockPos target, long now, String why) {
		if (placedWater != null && !target.equals(placedWater)) {
			Step scoop = scoopStep(player, level, placedWater);
			if (scoop != null) { step = scoop; return TickResult.running(progress(level)); }
			return walkNear(player, level, placedWater, now, "recover the owned cooling water before moving on");
		}
		if (walks >= MAX_WALKS) return stop(player, "NO_STAND_SPOT", why + "; " + MAX_WALKS + " walks did not bring it into reach");
		BlockPos best = standSpot(player, level, target);
		if (best == null) return stop(player, "NO_STAND_SPOT", why + "; no standing spot within reach of " + xyz(target)
				+ (lastWalkFailure == null ? "" : "; last walk: " + lastWalkFailure));
		return walkTo(player, level, best, now);
	}

	private TickResult walkTo(ServerPlayer player, ServerLevel level, BlockPos best, long now) {
		if (DEBUG_TRACE) trace.append("w").append(xyz(best)).append('@').append(player.tickCount).append(' ');
		walks++;
		triedSpots.add(best);
		walk = new ServerNavigationController(new Vec3(best.getX() + 0.5D, best.getY(), best.getZ() + 0.5D), 0.4D, false, now, 20_000L);
		return TickResult.running(progress(level));
	}

	/** A standing spot not yet tried from which the eye reaches {@code target}, nearest the body (a step out of a frame's plane preferred). */
	private BlockPos standSpot(ServerPlayer player, ServerLevel level, BlockPos target) {
		BlockPos feet = player.blockPosition();
		triedSpots.add(feet.immutable());
		BlockPos best = null;
		double bestCost = Double.MAX_VALUE;
		for (BlockPos at : BlockPos.betweenClosed(target.offset(-4, -4, -4), target.offset(4, 3, 4))) {
			if (triedSpots.contains(at)) continue;
			if (!standable(knownView(player), level, at) || (frame && (frameCells().contains(at) || interior(at) || interior(at.above())))) continue;
			Vec3 eye = new Vec3(at.getX() + 0.5D, at.getY() + player.getEyeHeight(), at.getZ() + 0.5D);
			double reach = eye.distanceTo(Vec3.atCenterOf(target));
			if (reach > player.blockInteractionRange() - 0.6D) continue;
			double cost = Vec3.atCenterOf(at).distanceTo(player.position());
			if (frame) {
				// Facing the frame from a step or two out of its plane sees the faces a cast needs.
				int off = Math.abs(axis == Direction.Axis.Z ? at.getX() - site.getX() : at.getZ() - site.getZ());
				if (off == 0) cost += 6.0D; else if (off == 1) cost += 1.5D;
			}
			if (cost < bestCost) { bestCost = cost; best = at.immutable(); }
		}
		return best;
	}

	/**
	 * A spot the body knows it can stand in: seen sturdy ground under it, seen open cells for the body, no seen lava
	 * beside it. A cell it has not seen is not a standing spot. {@code shapes} only gives a known state its shape.
	 */
	static boolean standable(Function<BlockPos, BlockState> known, net.minecraft.world.level.BlockGetter shapes, BlockPos at) {
		BlockState below = known.apply(at.below());
		if (below == null || !below.isFaceSturdy(shapes, at.below(), Direction.UP) || !below.getFluidState().isEmpty()) return false;
		for (BlockPos body : new BlockPos[] { at, at.above() }) {
			BlockState s = known.apply(body);
			FluidState fluid = s == null ? null : s.getFluidState();
			if (s == null || !s.getCollisionShape(shapes, body).isEmpty() || !fluid.isEmpty() && (fluid.isSource() || !fluid.getType().isSame(Fluids.WATER))) return false;
		}
		for (Direction d : Direction.Plane.HORIZONTAL) {
			BlockState side = known.apply(at.relative(d));
			if (side != null && side.getFluidState().getType().isSame(Fluids.LAVA)) return false;
		}
		return true;
	}


	/**
	 * Lava sources the body knows of (seen now, else remembered) within {@code radius}, nearest first. The cell's known
	 * state must be a lava source: remembered water or flowing lava is not one, whatever the cell holds now.
	 */
	private List<BlockPos> seenLavaSources(ServerPlayer player, ServerLevel level, int radius) {
		var seen = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player);
		BlockPos feet = player.blockPosition();
		List<BlockPos> out = knownLavaSources(BlockPos.betweenClosed(feet.offset(-radius, -6, -radius), feet.offset(radius, 4, radius)),
				lavaView(at -> seen.recalled(at.getX(), at.getY(), at.getZ()), level::getBlockState, at -> seen.known(at.getX(), at.getY(), at.getZ())));
		knownOpen.addAll(out);
		Vec3 eye = player.getEyePosition();
		out.sort(Comparator.comparingDouble(at -> Vec3.atCenterOf(at).distanceToSqr(eye)));
		return out;
	}

	static boolean knownLavaSource(BlockState known) {
		return known != null && known.getFluidState().isSource() && known.getFluidState().getType().isSame(Fluids.LAVA);
	}

	/**
	 * {@code known} for the cells that could be known as a lava source (remembered as one, or one now), null for the
	 * rest. The live state only decides which cells skip the sight ray; the answer is always the known state.
	 */
	static Function<BlockPos, BlockState> lavaView(Function<BlockPos, BlockState> recalled, Function<BlockPos, BlockState> live,
			Function<BlockPos, BlockState> known) {
		return at -> knownLavaSource(recalled.apply(at)) || knownLavaSource(live.apply(at)) ? known.apply(at) : null;
	}

	/** The cells whose known state is a lava source; an unknown cell (null) is not one. */
	static List<BlockPos> knownLavaSources(Iterable<BlockPos> cells, Function<BlockPos, BlockState> known) {
		List<BlockPos> out = new ArrayList<>();
		for (BlockPos at : cells) if (knownLavaSource(known.apply(at))) out.add(at.immutable());
		return out;
	}

	private Iterable<BlockPos> obsidianCells() {
		return BlockPos.betweenClosed(site.offset(-8, -4, -8), site.offset(8, 6, 8));
	}

	/** {@link #known}, skipping the sight ray for cells that are neither remembered nor obsidian or fluid now. */
	private Function<BlockPos, BlockState> obsidianView(ServerPlayer player, ServerLevel level) {
		var seen = dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player);
		return at -> {
			if (seen.recalled(at.getX(), at.getY(), at.getZ()) == null) {
				BlockState live = level.getBlockState(at);
				if (!live.is(Blocks.OBSIDIAN) && live.getFluidState().isEmpty()) return null;
			}
			return known(player, at);
		};
	}

	/**
	 * Folds what the body knows of {@code cells} into {@code knownOpen} (known not obsidian) and {@code made} (known
	 * obsidian after being known not obsidian in this call). An unknown cell changes neither: obsidian the body never
	 * saw as anything else is not counted as made, and a made cell stays counted until it is seen otherwise.
	 */
	static void trackObsidian(Iterable<BlockPos> cells, Function<BlockPos, BlockState> known, Set<BlockPos> knownOpen, Set<BlockPos> made) {
		for (BlockPos at : cells) {
			BlockState state = known.apply(at);
			if (state == null) continue;
			if (state.is(Blocks.OBSIDIAN)) {
				if (knownOpen.contains(at)) made.add(at.immutable());
			} else {
				BlockPos cell = at.immutable();
				knownOpen.add(cell);
				made.remove(cell);
			}
		}
	}

	/** New obsidian the body has seen made (known obsidian now, known as something else earlier in this call). */
	private int newObsidian(ServerPlayer player, ServerLevel level) {
		trackObsidian(obsidianCells(), obsidianView(player, level), knownOpen, madeSeen);
		return madeSeen.size();
	}

	private static boolean touches(BlockPos water, BlockPos cell) {
		for (Direction d : COOLING) if (cell.relative(d).equals(water)) return true;
		return false;
	}

	private static boolean fallsOnBody(ServerPlayer player, BlockPos at) {
		AABB body = player.getBoundingBox().inflate(0.4D, 0.0D, 0.4D);
		return at.getY() >= Math.floor(body.minY) && body.intersects(new AABB(at.getX(), body.minY, at.getZ(), at.getX() + 1, at.getY() + 1, at.getZ() + 1));
	}

	private static boolean occupied(ServerPlayer player, BlockPos at) {
		AABB body = player.getBoundingBox().inflate(0.05D);
		return body.intersects(new AABB(at));
	}

	static int find(ServerPlayer player, Item item) {
		int selected = player.getInventory().getSelectedSlot();
		if (player.getInventory().getItem(selected).is(item)) return selected;
		for (int slot = 0; slot < 36; slot++) if (player.getInventory().getItem(slot).is(item)) return slot;
		return -1;
	}

	private double progress(ServerLevel level) {
		if (frame && axis != null) return Math.min(0.99D, (lastRead == null ? 0 : lastRead.done()) / 10.0D);
		return Math.min(0.99D, madeSeen.size() / (double) count);
	}

	private String axisName() {
		return axis == Direction.Axis.Z ? "z" : "x";
	}

	private String summary(ServerPlayer player, String why) {
		ServerLevel level = (ServerLevel) player.level();
		StringBuilder text = new StringBuilder(why);
		if (siteNote != null) text.append("; ").append(siteNote).append(", mined ").append(mined);
		if (DEBUG_TRACE) text.append("; TRACE ").append(trace);
		if (looks > 0) text.append("; looked around ").append(looks).append(" times for lava");
		text.append(". New obsidian seen: ").append(newObsidian(player, level));
		if (frame && axis != null) {
			FrameRead read = readFrame(frameCells(), Set.of(), knownView(player));
			text.append("; frame at ").append(xyz(site)).append(" axis ").append(axisName()).append(": ")
					.append(read.done()).append("/10 cells seen cast");
			if (!read.missing().isEmpty()) text.append(" (missing ").append(String.join(" ", read.missing().stream().map(ServerCastObsidianController::xyz).toList())).append(')');
			if (!read.unknown().isEmpty()) text.append(" (unknown, not seen: ").append(String.join(" ", read.unknown().stream().map(ServerCastObsidianController::xyz).toList())).append(')');
		}
		text.append(String.format(Locale.ROOT, "; clicks: water poured %d, lava poured %d, water scooped %d, lava taken %d, blocks placed %d",
				waterPours, lavaPours, scoops, fills, moulds));
		if (placedWater != null && !knownGone(player, placedWater)) text.append("; water source left at ").append(xyz(placedWater));
		if (lastRefusal != null) text.append("; a lava pour was refused (LAVA_POUR_AT_BODY): ").append(lastRefusal);
		if (pendingLava != null && knownLava(player, pendingLava)) {
			double reach = BucketUse.lavaReachSeconds(dev.agaminggod.mineagen.server.perception.SeenTerrain.of(player)::known, player.getBoundingBox(), pendingLava, Fluids.LAVA.getTickDelay(level));
			text.append("; LAVA FLOWING: a lava source was poured at ").append(xyz(pendingLava)).append(" and stopped before its water")
					.append(reach < 0.0D ? "" : String.format(Locale.ROOT, "; its flow reaches your body in about %.1f s", reach));
		}
		text.append(String.format(Locale.ROOT, "; lava sources seen within %d: %d; carried water_bucket %d, lava_bucket %d, bucket %d",
				LAVA_SEARCH, seenLavaSources(player, level, LAVA_SEARCH).size(), carried(player, Items.WATER_BUCKET), carried(player, Items.LAVA_BUCKET), carried(player, Items.BUCKET)));
		return text.length() > (DEBUG_TRACE ? 6000 : 1900) ? text.substring(0, DEBUG_TRACE ? 6000 : 1900) : text.toString();
	}

	private static int carried(ServerPlayer player, Item item) {
		int n = 0;
		for (int slot = 0; slot < player.getInventory().getContainerSize(); slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (stack.is(item)) n += stack.getCount();
		}
		return n;
	}

	private static String xyz(BlockPos at) {
		return at.getX() + "," + at.getY() + "," + at.getZ();
	}
}
