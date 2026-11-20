package dev.agaminggod.mineagen.server.runtime.controller;

import dev.agaminggod.mineagen.client.navigation.GridPosition;
import dev.agaminggod.mineagen.client.navigation.LocalPathfinder;
import dev.agaminggod.mineagen.client.navigation.PathNode;
import dev.agaminggod.mineagen.client.navigation.PathPlan;
import dev.agaminggod.mineagen.client.navigation.WalkabilityView;
import java.util.HashMap;
import java.util.Map;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.LiquidBlock;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;

/**
 * Nether lava safety. Lava killed 10 agents in 7 of 22 games, 6 with no mob near: same-level
 * walk-ins and floods. Pins the contract's lava rules: the step guard refuses a move whose coast to a stop would touch
 * lava at the body's own level and nothing else; the seal picks a face to place against; navigation routes go round
 * cells lava fills next (a body already in the flow may still walk out); a bridge over a lava sea still plans.
 */
public final class LavaStepVerification {
	private static int assertions;
	private static final BlockState AIR = Blocks.AIR.defaultBlockState();
	private static final BlockState STONE = Blocks.NETHERRACK.defaultBlockState();
	private static final BlockState LAVA = Blocks.LAVA.defaultBlockState();
	private static final double WALK = 0.216D;
	private static final double ACCELERATION = 0.13D;

	private LavaStepVerification() {
	}

	public static void main(String[] arguments) {
		System.out.println("PASS: " + verify() + " lava step assertions");
	}

	public static int verify() {
		assertions = 0;
		verifyStepGuard();
		verifySealFace();
		verifyRouteRefusal();
		verifyBridgeOverLavaSea();
		verifyHeldJump();
		verifySecondRefusal();
		verifyFrameRereadsLava();
		verifyFencePost();
		verifyBrakingKeys();
		verifySealPermission();
		verifyTunnelPlugBackOff();
		verifySealFaceOrder();
		verifyWideFlowEscape();
		verifyWallSlide();
		verifyJumpPath();
		verifyTunnelLavaScan();
		verifyPlacementGates();
		return assertions;
	}

	/** Floor of netherrack at y 63 everywhere, air above, with the cells set. */
	private static final class Room {
		final Map<Long, BlockState> blocks = new HashMap<>();

		Room set(int x, int y, int z, BlockState state) {
			blocks.put(BlockPos.asLong(x, y, z), state);
			return this;
		}

		BlockState at(int x, int y, int z) {
			BlockState state = blocks.get(BlockPos.asLong(x, y, z));
			if (state != null) return state;
			return y <= 63 ? STONE : AIR;
		}
	}

	/** The player's 0.6 x 1.8 box with its feet centred at (x, 64, z). */
	private static AABB body(double x, double z) {
		return new AABB(x - 0.3D, 64.0D, z - 0.3D, x + 0.3D, 65.8D, z + 0.3D);
	}

	private static void verifyStepGuard() {
		// A lava source at the feet two cells east of the body's cell, level with the walk.
		Room room = new Room().set(2, 64, 0, LAVA);
		LavaStep.Read read = room::at;
		double[] east = {1.0D, 0.0D}, north = {0.0D, -1.0D};
		check(LavaStep.touched(read, body(1.5D, 0.5D)) == null, "a body centred in the cell beside lava does not touch it");
		check(new BlockPos(2, 64, 0).equals(LavaStep.touched(read, body(1.75D, 0.5D))), "a box over the cell boundary touches the lava");
		check(new BlockPos(2, 64, 0).equals(LavaStep.refused(read, body(1.5D, 0.5D), WALK, 0.0D, east, ACCELERATION)),
				"walking east at speed from the cell beside it would coast into the lava: refused");
		check(LavaStep.refused(read, body(0.5D, 0.5D), 0.0D, 0.0D, east, ACCELERATION) == null,
				"a first step east from two cells away stops short of it: allowed");
		check(LavaStep.refused(read, body(1.5D, 0.5D), 0.0D, -WALK, north, ACCELERATION) == null,
				"walking along the lava, beside it, is allowed");
		check(LavaStep.refused(read, body(1.9D, 0.5D), WALK, 0.0D, east, ACCELERATION) == null,
				"a body already in the lava is not held: the hazard floor gets it out");
		// Lava at head height only (a flow over a low wall, a pour from above the step).
		Room head = new Room().set(2, 65, 0, LAVA).set(2, 64, 0, STONE);
		check(LavaStep.refused(head::at, body(1.5D, 0.5D), WALK, 0.0D, east, ACCELERATION) == null,
				"a step up blocked by a wall is no lava touch at the feet, and the head row is checked too");
		Room overhang = new Room().set(2, 65, 0, LAVA);
		check(new BlockPos(2, 65, 0).equals(LavaStep.refused(overhang::at, body(1.5D, 0.5D), WALK, 0.0D, east, ACCELERATION)),
				"lava at head height ahead is refused like lava at the feet");
		// A thin flow across the floor (level 7, a ninth of a block deep) still burns.
		Room thin = new Room().set(2, 64, 0, LAVA.setValue(LiquidBlock.LEVEL, 7));
		check(LavaStep.refused(thin::at, body(1.5D, 0.5D), WALK, 0.0D, east, ACCELERATION) != null,
				"a thin flowing edge on the floor is refused");
		// A sprint jump east from two cells short of a lava strip at the feet comes down in it: refused. A wall over the
		// way stops the jump first; a jump along the strip lands on the floor.
		Room strip = new Room();
		for (int x = 3; x <= 5; x++) for (int z = -3; z <= 3; z++) strip.set(x, 64, z, LAVA);
		check(new BlockPos(3, 64, 0).equals(jump(strip::at, body(0.5D, 0.5D), east, true)),
				"a sprint jump that comes down in same-level lava is refused");
		Room walled = new Room();
		for (int x = 3; x <= 5; x++) for (int z = -3; z <= 3; z++) walled.set(x, 64, z, LAVA);
		for (int z = -3; z <= 3; z++) { walled.set(2, 64, z, STONE); walled.set(2, 65, z, STONE); walled.set(2, 66, z, STONE); }
		check(jump(walled::at, body(0.5D, 0.5D), east, true) == null, "a wall in the way stops the jump before the lava");
		check(jump(strip::at, body(0.5D, -5.5D), new double[] {-1.0D, 0.0D}, true) == null,
				"a jump away from the lava lands on the floor");
		// Lava a block below the walk (a pool beside a ledge) is the drop check's (BrinkGuard.fall), not this one's.
		Room pool = new Room().set(2, 63, 0, LAVA);
		check(LavaStep.touched(pool::at, body(2.5D, 0.5D)) == null, "a box standing over a lava pool does not touch it at its feet");
	}

	/** The cell the brink guard's jump model meets, from standing (rising, falling and landing ticks). */
	private static BlockPos jump(LavaStep.Read read, AABB box, double[] heading, boolean sprint) {
		return LavaStep.jumpPath(read, box, BrinkGuard.jumpShifts(0.0D, 0.0D, heading, sprint), LavaStep.jumpHeights(BrinkGuard.JUMP_AIR_TICKS + 2));
	}

	private static void verifySealFace() {
		BlockPos lava = new BlockPos(2, 64, 0);
		Predicate<BlockPos> floor = pos -> pos.getY() <= 63;
		check(LavaStep.sealFace(lava, floor) == Direction.UP, "a flow on a floor is plugged on the floor's top face");
		Predicate<BlockPos> west = pos -> pos.equals(new BlockPos(1, 64, 0));
		check(LavaStep.sealFace(lava, west) == Direction.EAST, "with no floor, the block goes against a solid side (clicked from the west)");
		check(lava.relative(Direction.EAST.getOpposite()).equals(new BlockPos(1, 64, 0)), "the clicked support is the solid side");
		check(LavaStep.sealFace(lava, pos -> false) == null, "lava with nothing solid beside it cannot be plugged");
	}

	/** A flat floor at y 63 with feet cells at y 64; {@code fills} marks the cells lava fills next. */
	private static WalkabilityView flat(Predicate<GridPosition> fills, boolean refuses) {
		return new WalkabilityView() {
			@Override
			public Cell cellAt(GridPosition position) {
				if (Math.abs(position.x()) > 12 || Math.abs(position.z()) > 12) return Cell.BLOCKED;
				return position.y() <= 63 ? Cell.SAFE_SUPPORT : Cell.CLEAR;
			}

			@Override
			public boolean lavaFillsNext(GridPosition position) {
				return fills.test(position);
			}

			@Override
			public boolean refusesLavaFlowCells() {
				return refuses;
			}
		};
	}

	private static boolean found(PathPlan plan) {
		return plan.outcome() == dev.agaminggod.mineagen.client.navigation.PathOutcome.FOUND;
	}

	private static boolean crosses(PathPlan plan, Predicate<GridPosition> cells) {
		for (PathNode node : plan.nodes()) if (cells.test(node.position())) return true;
		return false;
	}

	private static void verifyRouteRefusal() {
		Predicate<GridPosition> wall = p -> p.y() == 64 && p.x() == 3 && Math.abs(p.z()) <= 1;
		GridPosition start = new GridPosition(0, 64, 0), end = new GridPosition(6, 64, 0);
		PathPlan round = new LocalPathfinder().findPath(flat(wall, true), start, end);
		check(found(round), "a route still exists round the flow: " + round.outcome());
		check(!crosses(round, wall), "the route goes round every cell lava fills next");
		PathPlan through = new LocalPathfinder().findPath(flat(wall, false), start, end);
		check(found(through) && crosses(through, wall), "a view that does not refuse (fight, flee) keeps its straight line");
		// Standing in the flow's way: the body walks out through flow cells to the first dry one.
		Predicate<GridPosition> lane = p -> p.y() == 64 && p.x() >= -1 && p.x() <= 1 && Math.abs(p.z()) <= 12;
		PathPlan out = new LocalPathfinder().findPath(flat(lane, true), start, new GridPosition(4, 64, 0));
		check(found(out), "a body in a flow's way may cross flow cells to get out: " + out.outcome());
	}

	private static void verifyBridgeOverLavaSea() {
		// A lava sea with its top at y 31; a bridge of placed netherrack at y 31 under feet at y 32.
		Map<Long, BlockState> sea = new HashMap<>();
		for (int x = -3; x <= 3; x++) for (int z = -3; z <= 3; z++) for (int y = 25; y <= 31; y++) sea.put(BlockPos.asLong(x, y, z), LAVA);
		for (int x = -3; x <= 3; x++) sea.put(BlockPos.asLong(x, 31, 0), STONE);
		MinecraftNavigationWorld.StateRead read = (x, y, z) -> sea.getOrDefault(BlockPos.asLong(x, y, z), y <= 24 ? STONE : AIR);
		check(!MinecraftNavigationWorld.lavaFills(read, 0, 32, 0), "a bridge cell over the sea is no cell lava fills next: the lava is below its support");
		check(!MinecraftNavigationWorld.lavaContact(read, 0, 32, 0), "nor does lava flow into it");
	}

	/** Council r1 item 1: a held jump's second grounded take-off is judged like the first. */
	private static void verifyHeldJump() {
		check(BrinkGuard.checksJumpLanding(true, false, true, false), "every grounded take-off with jump held is checked, a held jump's second hop too");
		check(!BrinkGuard.checksJumpLanding(true, false, false, false), "an airborne tick is no take-off");
		check(!BrinkGuard.checksJumpLanding(true, false, true, true), "a fire-resistant body is not held");
		check(!BrinkGuard.checksJumpLanding(false, false, true, false), "no jump, nothing to check");
		// The first hop landed safely two cells short of the strip; the second take-off from there comes down in it.
		Room strip = new Room();
		for (int x = 5; x <= 7; x++) for (int z = -3; z <= 3; z++) strip.set(x, 64, z, LAVA);
		double[] east = {1.0D, 0.0D};
		check(jump(strip::at, body(-1.5D, 0.5D), east, true) == null, "the first sprint hop lands on the floor");
		check(new BlockPos(5, 64, 0).equals(jump(strip::at, body(2.5D, 0.5D), east, true)),
				"the second take-off of the held jump toward the strip is refused");
	}

	/** Council r1 item 2: refusal, replan, then a second refusal counts only after the new plan's own keys. */
	private static void verifySecondRefusal() {
		int first = 100;
		check(!ServerNavigationController.secondLavaRefusal(first + 1, -1), "the leased old keys refused on the next tick are no second refusal");
		check(!ServerNavigationController.secondLavaRefusal(first + 3, -1), "nor is a refusal of the slide before the new plan applied keys");
		int keys = first + 4;
		check(!ServerNavigationController.secondLavaRefusal(keys, keys), "a refusal on the tick the new keys were applied may be of the old input");
		check(ServerNavigationController.secondLavaRefusal(keys + 1, keys), "the new plan's keys refused at the same cell: the second refusal");
	}

	/** Council r1 item 3: the lava-fills cache is read again each frame (spread into a dry cell, then plugged). */
	private static void verifyFrameRereadsLava() {
		SeenNavigationVerification.World world = new SeenNavigationVerification.World();
		var memory = new dev.agaminggod.mineagen.server.perception.SeenTerrain.Memory<BlockState>();
		MinecraftNavigationWorld view = SeenNavigationVerification.view(world, memory, 1L);
		GridPosition cell = new GridPosition(1, 64, 0);
		check(!view.lavaFillsNext(cell), "a dry cell with no lava near is not filled next");
		world.states.put(new BlockPos(2, 64, 0), LAVA);
		view.nextFrame(new dev.agaminggod.mineagen.server.perception.SeenTerrain.Reader<>(memory, world, 2L, null));
		check(view.lavaFillsNext(cell), "lava that spread beside it since the last frame is seen on the next");
		world.states.put(new BlockPos(2, 64, 0), STONE);
		view.nextFrame(new dev.agaminggod.mineagen.server.perception.SeenTerrain.Reader<>(memory, world, 3L, null));
		check(!view.lavaFillsNext(cell), "a plugged source no longer marks the cell on the frame after");
	}

	/** Council r1 item 4: a fence post the box only clips the cell of is no wall in front of lava. */
	private static void verifyFencePost() {
		BlockState fence = Blocks.OAK_FENCE.defaultBlockState();
		Room room = new Room().set(2, 64, 0, fence).set(2, 64, 1, LAVA);
		double[] east = {1.0D, 0.0D};
		check(new BlockPos(2, 64, 1).equals(LavaStep.refused(room::at, body(1.5D, 1.0D), WALK, 0.0D, east, ACCELERATION)),
				"walking east past a post in the next lane's corner, into lava, is refused");
		Room behind = new Room().set(2, 64, 0, fence).set(3, 64, 0, LAVA);
		check(LavaStep.refused(behind::at, body(1.5D, 0.5D), WALK, 0.0D, east, ACCELERATION) == null,
				"a post straight ahead still stops the body before lava past it");
	}

	/** Council r1 item 5: keys that brake toward lava the slide reaches anyway are kept. */
	private static void verifyBrakingKeys() {
		Room room = new Room().set(2, 64, 0, LAVA);
		double fast = 0.4D;
		double[] east = {1.0D, 0.0D}, west = {-1.0D, 0.0D};
		check(LavaStep.refused(room::at, body(1.5D, 0.5D), fast, 0.0D, east, ACCELERATION) != null, "keys toward the lava at speed: refused");
		check(LavaStep.refused(room::at, body(1.5D, 0.5D), fast, 0.0D, west, ACCELERATION) == null,
				"keys braking away from the lava the slide reaches anyway are not zeroed");
		check(LavaStep.refused(room::at, body(1.5D, 0.5D), WALK, 0.0D, new double[] {0.0D, 1.0D}, ACCELERATION) != null,
				"a sideways key that does not brake is still refused");
	}

	/** Council r1 item 6: a walk places a seal only with its caller's permission; travel_to build:false never does. */
	private static void verifySealPermission() {
		java.util.function.BiPredicate<net.minecraft.server.level.ServerPlayer, BlockPos> any = (player, cell) -> true;
		java.util.function.BiPredicate<net.minecraft.server.level.ServerPlayer, BlockPos> none = (player, cell) -> false;
		BlockPos cell = new BlockPos(2, 64, 0);
		check(ServerTravelController.legSealPermission(false, any) == null, "travel_to build:false gives its legs no seal permission");
		check(ServerTravelController.legSealPermission(true, any) == any, "a building travel passes its own block policy to its legs");
		check(ServerNavigationController.sealPermissionRefusal(null, null, cell) != null, "a walk with no permission stops with LAVA_STEP instead of placing");
		check(ServerNavigationController.sealPermissionRefusal(none, null, cell) != null, "a protected cell is not sealed");
		check(ServerNavigationController.sealPermissionRefusal(any, null, cell) == null, "a permitted cell may be sealed");
	}

	/** Council r1 item 7: a tunnel plug of lava beside the body backs off when no click lands within 8 ticks. */
	private static void verifyTunnelPlugBackOff() {
		int limit = ServerTravelController.PLUG_BESIDE_TICKS;
		check(!ServerTravelController.plugGivesUp(true, limit, false), "lava beside the body: a few ticks to turn and click");
		check(ServerTravelController.plugGivesUp(true, limit + 1, false), "no click by then: back off instead of standing in the flow's way");
		check(!ServerTravelController.plugGivesUp(true, limit + 1, true), "a click landed: wait for it to take");
		check(!ServerTravelController.plugGivesUp(false, limit + 1, false), "lava farther down the tunnel keeps the 2 s plug");
	}

	/** Council r1 item 8: every usable face in preference order (floor top, sides, ceiling). */
	private static void verifySealFaceOrder() {
		BlockPos lava = new BlockPos(2, 64, 0);
		Predicate<BlockPos> floorAndWest = pos -> pos.getY() <= 63 || pos.equals(new BlockPos(1, 64, 0)) || pos.equals(new BlockPos(2, 65, 0));
		java.util.List<Direction> faces = LavaStep.sealFaces(lava, floorAndWest);
		check(faces.equals(java.util.List.of(Direction.UP, Direction.EAST, Direction.DOWN)), "faces in order: floor top, the side, the ceiling: " + faces);
	}

	/** Council r1 item 9: the exemption is the flow region the body stands in; a wide flow still lets it walk out. */
	private static void verifyWideFlowEscape() {
		Predicate<GridPosition> wide = p -> p.y() == 64 && Math.abs(p.x()) <= 3 && Math.abs(p.z()) <= 12;
		GridPosition start = new GridPosition(0, 64, 0);
		PathPlan out = new LocalPathfinder().findPath(flat(wide, true), start, new GridPosition(6, 64, 0));
		check(found(out), "a body three cells deep in a flow's way walks out: " + out.outcome());
		Predicate<GridPosition> band = p -> p.y() == 64 && p.x() == 3 && Math.abs(p.z()) <= 12;
		Predicate<GridPosition> beyond = p -> p.y() == 64 && p.x() == 3;
		PathPlan dry = new LocalPathfinder().findPath(flat(band, true), start, new GridPosition(6, 64, 0));
		check(!found(dry) || !crosses(dry, beyond), "a body on dry ground never enters the flow: " + dry.outcome());
	}

	/** Council r2 item 4: a body sliding along a wall keeps its other component and is refused lava beside the wall. */
	private static void verifyWallSlide() {
		Room room = new Room().set(1, 64, 1, LAVA);
		for (int z = -3; z <= 3; z++) { room.set(2, 64, z, STONE); room.set(2, 65, z, STONE); }
		double[] southEast = {Math.sqrt(0.5D), Math.sqrt(0.5D)};
		check(new BlockPos(1, 64, 1).equals(LavaStep.refused(room::at, body(1.5D, 0.5D), WALK, WALK, southEast, ACCELERATION)),
				"diagonal into an east wall slides south along it into lava: refused");
		Room dry = new Room();
		for (int z = -3; z <= 3; z++) { dry.set(2, 64, z, STONE); dry.set(2, 65, z, STONE); }
		check(LavaStep.refused(dry::at, body(1.5D, 0.5D), WALK, WALK, southEast, ACCELERATION) == null, "the same slide on dry floor is allowed");
	}

	/** Council r2 item 5: the jump's whole path counts, under a low ceiling too, and ground ticks of a held jump are judged. */
	private static void verifyJumpPath() {
		double[] east = {1.0D, 0.0D};
		Room strip = new Room();
		for (int z = -3; z <= 3; z++) strip.set(2, 64, z, LAVA);
		check(new BlockPos(2, 64, 0).equals(jump(strip::at, body(1.5D, 0.5D), east, true)),
				"a 1-wide strip at the take-off edge burns on the rising ticks: refused");
		Room low = new Room();
		for (int x = 3; x <= 5; x++) for (int z = -3; z <= 3; z++) low.set(x, 64, z, LAVA);
		for (int x = -3; x <= 8; x++) for (int z = -3; z <= 3; z++) low.set(x, 66, z, STONE);
		check(jump(low::at, body(1.5D, 0.5D), east, true) != null,
				"a jump under a two-high ceiling toward feet-level lava is refused, not taken as stopped by the ceiling");
		check(BrinkGuard.stepCheckRuns(true, true, false, false), "a held jump's ground tick after a step-up gets the step check");
		check(!BrinkGuard.stepCheckRuns(true, true, false, true), "a take-off whose path the jump check passed is not judged twice");
		check(!BrinkGuard.stepCheckRuns(true, false, false, false), "airborne ticks are the jump's");
	}

	/** Council r2 items 1 and 2: plug the nearest lava cell first; end plugged only when every cell around is dry. */
	private static void verifyTunnelLavaScan() {
		BlockPos feet = new BlockPos(0, 64, 0);
		Direction east = Direction.EAST;
		java.util.Set<BlockPos> lava = new java.util.HashSet<>(java.util.List.of(new BlockPos(1, 65, 0), new BlockPos(1, 64, 0)));
		BlockPos first = ServerTravelController.lavaToPlug(lava::contains, feet, east);
		check(first != null && first.getX() == 1, "head d1 and feet d1: a cell beside the body is plugged first: " + first);
		lava.remove(first);
		check(ServerTravelController.lavaToPlug(lava::contains, feet, east) != null, "the other one is still lava: not plugged, back off");
		java.util.Set<BlockPos> far = new java.util.HashSet<>(java.util.List.of(new BlockPos(2, 65, 0), new BlockPos(1, 64, 0)));
		check(new BlockPos(1, 64, 0).equals(ServerTravelController.lavaToPlug(far::contains, feet, east)), "head d2 and feet d1: feet d1 first");
		far.remove(new BlockPos(1, 64, 0));
		check(new BlockPos(2, 65, 0).equals(ServerTravelController.lavaToPlug(far::contains, feet, east)), "then head d2, still lava: not done");
		check(ServerTravelController.lavaToPlug(cell -> false, feet, east) == null, "all dry: TUNNEL_LAVA_PLUGGED may end the travel");
		java.util.Set<BlockPos> side = java.util.Set.of(new BlockPos(0, 65, -1));
		check(ServerTravelController.lavaBeside(side::contains, feet), "lava in a head cell beside the body counts as beside it");
		check(!ServerTravelController.lavaBeside(java.util.Set.of(new BlockPos(3, 64, 0))::contains, feet), "lava three cells down the tunnel is not beside");
	}

	/** Council r2 item 3: a seal or plug clears the same gates as a normal placement, for the lava cell and the support. */
	private static void verifyPlacementGates() {
		BlockPos target = new BlockPos(2, 64, 0), support = new BlockPos(2, 63, 0);
		java.util.function.Predicate<BlockPos> yes = cell -> true, no = cell -> false;
		check(LavaStep.placementDenied(yes, no, yes, true, target, support) == null, "allowed, unprotected, interactable and in reach: placed");
		check(LavaStep.placementDenied(cell -> !cell.equals(support), no, yes, true, target, support) != null, "a protected support is refused");
		check(LavaStep.placementDenied(cell -> !cell.equals(target), no, yes, true, target, support) != null, "a protected lava cell is refused");
		check(LavaStep.placementDenied(yes, cell -> cell.equals(target), yes, true, target, support) != null, "spawn protection is refused");
		check(LavaStep.placementDenied(yes, no, cell -> !cell.equals(support), true, target, support) != null, "a support the body may not use is refused");
		check(LavaStep.placementDenied(yes, no, yes, false, target, support) != null, "a support out of interaction range is refused");
	}

	private static void check(boolean value, String reason) {
		if (!value) throw new AssertionError(reason);
		assertions++;
	}
}
