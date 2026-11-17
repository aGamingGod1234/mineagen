package dev.agaminggod.mineagen.server.runtime.controller;

import com.mojang.authlib.GameProfile;
import java.lang.reflect.Field;
import java.util.HashMap;
import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.server.MinecraftServer;
import net.minecraft.server.level.ClientInformation;
import net.minecraft.server.level.ServerLevel;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.Entity;
import net.minecraft.world.level.block.Blocks;
import net.minecraft.world.level.block.state.BlockState;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Actual dig guard calls with real Minecraft bounds and block collision shapes; no physics simulation. */
public final class DigFootprintVerification {
    private DigFootprintVerification() {}

    public static void main(String[] args) {
        System.out.println("PASS: " + verify() + " dig footprint assertions");
    }

    public static int verify() {
        net.minecraft.SharedConstants.tryDetectVersion();
        net.minecraft.server.Bootstrap.bootStrap();
        try {
            Field unsafeField = sun.misc.Unsafe.class.getDeclaredField("theUnsafe");
            unsafeField.setAccessible(true);
            var allocator = (sun.misc.Unsafe) unsafeField.get(null);
            FixtureLevel level = (FixtureLevel) allocator.allocateInstance(FixtureLevel.class);
            level.blocks = new HashMap<>();
            FixturePlayer player = (FixturePlayer) allocator.allocateInstance(FixturePlayer.class);
            player.fixtureLevel = level;
            player.grounded = true;
            double x = -104.70050864134511D, z = -95.4363338590522D, half = 0.6F / 2.0D;
            bounds(player, new AABB(x - half, 72D, z - half, x + half, 73.8D, z + half));
            BlockPos support = new BlockPos(-106, 71, -96);
            level.blocks.put(support, Blocks.NETHER_BRICKS.defaultBlockState());
            check(ServerDigController.restsOnlyOn(player, support), "56d1e: a 0.509mm overlap is the sole support, so it must not be mined");
            check(support.above().equals(supportColumn(player)), "planning recentres onto the same thin supporting column");
            int assertions = 2;

            for (AABB box : List.of(new AABB(0, 72, 0, .6D, 73.8D, .6D),
                    new AABB(-.6D, 72, -.6D, 0, 73.8D, 0))) {
                bounds(player, box);
                level.blocks.clear();
                BlockPos outside = box.minX == 0 ? new BlockPos(-1, 71, 0) : new BlockPos(0, 71, -1);
                level.blocks.put(outside, Blocks.NETHER_BRICKS.defaultBlockState());
                check(!ServerDigController.restsOnlyOn(player, outside), "exact face contact has no positive footprint overlap");
                check(supportColumn(player) == null, "recentring ignores a neighbouring column touching only an exact face");
                assertions += 2;
            }
            for (boolean xAxis : List.of(true, false)) for (double direction : List.of(-1D, 1D)) {
                double center = direction * .7005D;
                AABB box = xAxis ? new AABB(center - .3D, 72, .2D, center + .3D, 73.8D, .8D)
                        : new AABB(.2D, 72, center - .3D, .8D, 73.8D, center + .3D);
                bounds(player, box);
                level.blocks.clear();
                int edge = direction < 0 ? -2 : 1;
                BlockPos only = xAxis ? new BlockPos(edge, 71, 0) : new BlockPos(0, 71, edge);
                level.blocks.put(only, Blocks.STONE.defaultBlockState());
                check(ServerDigController.restsOnlyOn(player, only), "thin sole support is protected across both axes and signs");
                check(only.above().equals(supportColumn(player)), "both guard callers agree about the supporting column");
                BlockPos other = new BlockPos(0, 71, 0);
                if (direction < 0) other = xAxis ? new BlockPos(-1, 71, 0) : new BlockPos(0, 71, -1);
                level.blocks.put(other, Blocks.STONE.defaultBlockState());
                check(!ServerDigController.restsOnlyOn(player, only), "another overlapping support leaves this cut available");
                assertions += 3;
            }
            bounds(player, new AABB(.4005D, 72D, .2D, 1.0005D, 73.8D, .8D));
            level.blocks.clear();
            BlockPos sole = new BlockPos(0, 71, 0), sliver = new BlockPos(1, 71, 0);
            level.blocks.put(sole, Blocks.STONE.defaultBlockState());
            level.blocks.put(sliver, Blocks.STONE_SLAB.defaultBlockState());
            check(ServerDigController.restsOnlyOn(player, sole), "review: bottom slab below the feet is not alternate support");
            level.blocks.remove(sole);
            check(supportColumn(player) == null, "planning does not recenter onto a bottom slab below the feet");
            check(!ServerDigController.restsOnlyOn(player, sliver), "a lower partial shape is not the block holding the feet");
            assertions += 3;
            level.blocks.put(sole, Blocks.STONE.defaultBlockState());
            level.blocks.put(sliver, Blocks.IRON_BARS.defaultBlockState());
            check(ServerDigController.restsOnlyOn(player, sole), "a shape within the column but outside the footprint is not alternate support");
            level.blocks.remove(sole);
            check(supportColumn(player) == null, "planning ignores a shape with no horizontal body contact");
            assertions += 2;
            level.blocks.put(sliver, Blocks.STONE_SLAB.defaultBlockState().setValue(
                    net.minecraft.world.level.block.state.properties.BlockStateProperties.SLAB_TYPE,
                    net.minecraft.world.level.block.state.properties.SlabType.TOP));
            check(ServerDigController.restsOnlyOn(player, sliver), "a top slab at foot height really holds the thin overlap");
            check(sliver.above().equals(supportColumn(player)), "planning can use actual top-slab support");
            level.blocks.put(sole, Blocks.STONE.defaultBlockState());
            check(!ServerDigController.restsOnlyOn(player, sole), "a top slab at foot height is valid alternate support");
            assertions += 3;
            bounds(player, new AABB(x - half, 72D, z - half, x + half, 73.8D, z + half));
            level.blocks.clear();
            level.blocks.put(support, Blocks.NETHER_BRICKS.defaultBlockState());
            check(ServerDigController.restsOnlyOn(player, support), "airborne control starts from a genuinely protected sole support");
            player.grounded = false;
            check(!ServerDigController.restsOnlyOn(player, support), "airborne bodies retain the existing guard semantics");
            return assertions + 2;
        } catch (ReflectiveOperationException failure) {
            throw new AssertionError("dig footprint fixture", failure);
        }
    }

    private static BlockPos supportColumn(ServerPlayer player) throws ReflectiveOperationException {
        var method = ServerDigController.class.getDeclaredMethod("supportColumn", ServerPlayer.class);
        method.setAccessible(true);
        return (BlockPos) method.invoke(null, player);
    }

    private static void bounds(FixturePlayer player, AABB box) throws ReflectiveOperationException {
        Vec3 position = new Vec3((box.minX + box.maxX) / 2, box.minY, (box.minZ + box.maxZ) / 2);
        for (var value : Map.of("position", position, "blockPosition", BlockPos.containing(position), "bb", box).entrySet()) {
            Field field = Entity.class.getDeclaredField(value.getKey());
            field.setAccessible(true);
            field.set(player, value.getValue());
        }
    }

    private static void check(boolean condition, String label) {
        if (!condition) throw new AssertionError(label);
    }

    private static final class FixturePlayer extends ServerPlayer {
        FixtureLevel fixtureLevel;
        boolean grounded;
        private FixturePlayer(MinecraftServer server, ServerLevel level, GameProfile profile, ClientInformation client) { super(server, level, profile, client); }
        @Override public ServerLevel level() { return fixtureLevel; }
        @Override public boolean onGround() { return grounded; }
        @Override public boolean isDescending() { return false; }
        @Override public net.minecraft.world.item.ItemStack getMainHandItem() { return net.minecraft.world.item.ItemStack.EMPTY; }
    }

    private static final class FixtureLevel extends ServerLevel {
        Map<BlockPos, BlockState> blocks;
        private FixtureLevel() { super(null, null, null, null, null, null, false, 0, List.of(), false); }
        @Override public BlockState getBlockState(BlockPos position) { return blocks.getOrDefault(position, Blocks.AIR.defaultBlockState()); }
    }
}
