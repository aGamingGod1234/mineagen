package dev.agaminggod.arenaagents.server.runtime;

import java.util.HashMap;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Direction;
import net.minecraft.world.level.ClipContext;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.HitResult;
import net.minecraft.world.phys.Vec3;
import net.minecraft.world.phys.shapes.CollisionContext;

/** Constructed geometry diagnostic, not a replay or proof of recovery in the recorded world. */
public final class CoolingWaterRecoveryVerification {
	private static int assertions;
	public static void main(String[] args) {
		net.minecraft.SharedConstants.tryDetectVersion();
		net.minecraft.server.Bootstrap.bootStrap();
		System.out.println("CoolingWaterRecoveryVerification and bucket/perception contracts: "
				+ (BucketUseVerification.verify() + PerceptionGateVerification.verify()) + " assertions passed");
	}
	public static int verify() {
		assertions = 0;
		BlockPos water = new BlockPos(0, 1, 0), cast = new BlockPos(1, 1, 0);
		Map<BlockPos, BlockState> states = new HashMap<>();
		for (int x = -2; x <= 8; x++) for (int y = 0; y <= 4; y++) for (int z = -2; z <= 3; z++)
			states.put(new BlockPos(x, y, z), Blocks.AIR.defaultBlockState());
		BlockPos support = water.south();
		states.put(support, Blocks.STONE.defaultBlockState());
		Vec3 eye = new Vec3(2.5D, 1.62D, 0.5D), pourAim = new Vec3(0.5D, 1.5D, 1.0D);
		var before = new BreakSightline.SeenWorld(-64, 384) {
			@Override BlockState knownState(BlockPos at) { return states.get(at); }
		};
		var pour = VanillaFluidRayFixture.hit(before, eye, pourAim, 4.5D, ClipContext.Fluid.NONE);
		check(pour.getType() == HitResult.Type.BLOCK && pour.getBlockPos().equals(support)
				&& pour.getDirection() == Direction.NORTH, "baseline pour-only test accepts the far-side support face");
		check(ServerCastObsidianController.waterPickupAim(states::get, eye, 4.5D, water, cast, CollisionContext.empty()) == null,
				"reject source hidden by the obsidian this pour will make");
		states.put(water, Blocks.WATER.defaultBlockState());
		states.put(cast, Blocks.OBSIDIAN.defaultBlockState());
		try {
			BucketUse.aim(VanillaFluidRayFixture.player(before, eye, 4.5D), net.minecraft.world.item.Items.BUCKET, Vec3.atCenterOf(water));
			check(false, "vanilla bucket cannot recover the hidden source");
		} catch (dev.agaminggod.arenaagents.agent.AgentDomainException expected) {
			check(expected.code().equals("TARGET_OBSTRUCTED"), "vanilla pickup confirms the physical obstruction");
		}
		Vec3 clearEye = new Vec3(-1.5D, 2.62D, 0.5D);
		Vec3 aim = ServerCastObsidianController.waterPickupAim(states::get, clearEye, 4.5D, water, cast, CollisionContext.empty());
		check(aim != null, "keep water visible from the near side");
		var pickup = VanillaFluidRayFixture.hit(before, clearEye, aim, 4.5D, ClipContext.Fluid.SOURCE_ONLY);
		check(pickup.getType() == HitResult.Type.BLOCK && pickup.getBlockPos().equals(water), "accepted aim meets source using vanilla item ray");
		check(ServerCastObsidianController.waterPickupAim(states::get, new Vec3(-7, 2.62D, 0.5D), 4.5D, water, cast, CollisionContext.empty()) == null,
				"do not extend hand reach");
		check(ServerCastObsidianController.waterPickupAim(at -> null, clearEye, 4.5D, water, cast, CollisionContext.empty()) == null,
				"unseen terrain cannot supply a recovery ray");
		states.put(cast, Blocks.LAVA.defaultBlockState());
		check(ServerCastObsidianController.waterPickupAim(states::get, eye, 4.5D, water, null, CollisionContext.empty()) == null,
				"count mode anticipates solidified lava too");
		check(ServerCastObsidianController.mustRecoverWater(water, cast, cast, false, false, false, false),
				"recover water before looking or walking for another lava bucket");
		check(!ServerCastObsidianController.mustRecoverWater(water, cast, cast, false, false, true, false),
				"keep coolant while the carried lava is ready to cast");
		check(!ServerCastObsidianController.mustRecoverWater(water, cast, cast, false, false, false, true),
				"keep coolant while the poured lava cell is still awaiting observation");
		check(ServerCastObsidianController.mustRecoverWater(water, cast, cast, true, false, true, false),
				"recover before mining may move or hide water");
		check(ServerCastObsidianController.mustRecoverWater(water, cast, cast, false, true, true, false),
				"recover before observing an unknown cell may walk away");
		check(!ServerCastObsidianController.mustRecoverWater(null, cast, cast, true, true, false, false),
				"no invented ownership of unplaced water");
		// The pour ray ignores flow, but the same pour makes it a solid pickup obstruction.
		BlockPos flowCast = water.north();
		states.put(water, Blocks.AIR.defaultBlockState());
		states.put(cast, Blocks.LAVA.defaultBlockState().setValue(net.minecraft.world.level.block.LiquidBlock.LEVEL, 2));
		states.put(flowCast, Blocks.LAVA.defaultBlockState());
		var throughFlow = VanillaFluidRayFixture.hit(before, eye, pourAim, 4.5D, ClipContext.Fluid.NONE);
		check(throughFlow.getType() == HitResult.Type.BLOCK && throughFlow.getBlockPos().equals(support),
				"a filled bucket can pour through the flow to the support");
		for (BlockPos mode : new BlockPos[] { flowCast, null }) {
			check(ServerCastObsidianController.waterPickupAim(states::get, eye, 4.5D, water, mode, CollisionContext.empty()) == null,
					"frame and count previews reject flow that cools into blocking cobblestone");
			check(ServerCastObsidianController.waterPickupAim(states::get, clearEye, 4.5D, water, mode, CollisionContext.empty()) != null,
					"immediate cooling leaves the clear-side pickup available");
		}
		states.put(water, Blocks.WATER.defaultBlockState());
		states.put(flowCast, Blocks.OBSIDIAN.defaultBlockState());
		states.put(cast, Blocks.COBBLESTONE.defaultBlockState());
		try {
			BucketUse.aim(VanillaFluidRayFixture.player(before, eye, 4.5D), net.minecraft.world.item.Items.BUCKET, Vec3.atCenterOf(water));
			check(false, "cooled flow must obstruct actual vanilla pickup");
		} catch (dev.agaminggod.arenaagents.agent.AgentDomainException expected) {
			check(expected.code().equals("TARGET_OBSTRUCTED"), "vanilla pickup confirms the cobblestone obstruction");
		}
		return assertions;
	}
	private static void check(boolean condition, String message) {
		if (!condition) throw new AssertionError(message);
		assertions++;
	}
}
