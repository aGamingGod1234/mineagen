package dev.agaminggod.mineagen.server.runtime;

import java.util.List;
import java.util.Map;
import net.minecraft.core.BlockPos;
import net.minecraft.core.Holder;
import net.minecraft.core.HolderSet;
import net.minecraft.core.component.DataComponentMap;
import net.minecraft.core.component.DataComponents;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.Item;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.item.Items;
import net.minecraft.world.item.component.Tool;
import net.minecraft.world.level.block.Blocks;

public final class OreHarvestFactsVerification {
	public static int verify() {
		int checks = 0;
		var bindings = new java.util.LinkedHashMap<Holder.Reference<Item>, DataComponentMap>();
		try {
			var bad = stack(Items.STONE_PICKAXE, List.of(), bindings);
			var good = stack(Items.IRON_PICKAXE, List.of(Tool.Rule.minesAndDrops(HolderSet.direct(Blocks.DEEPSLATE_DIAMOND_ORE.builtInRegistryHolder()), 6.0F)), bindings);
			for (var block : List.of(Blocks.DIAMOND_ORE, Blocks.DEEPSLATE_DIAMOND_ORE, Blocks.IRON_ORE, Blocks.GOLD_ORE,
					Blocks.REDSTONE_ORE, Blocks.LAPIS_ORE, Blocks.EMERALD_ORE, Blocks.ANCIENT_DEBRIS, Blocks.COAL_ORE, Blocks.NETHER_QUARTZ_ORE)) {
				if (!OreHarvestFacts.needsChoice(block.defaultBlockState(), bad)) throw new AssertionError("wrong-tool ore must hand back: " + block);
				checks++;
			}
			if (OreHarvestFacts.needsChoice(Blocks.DEEPSLATE_DIAMOND_ORE.defaultBlockState(), good)) throw new AssertionError("selected harvest-capable tool must proceed"); checks++;
			if (OreHarvestFacts.needsChoice(Blocks.STONE.defaultBlockState(), bad)) throw new AssertionError("ordinary excavation stays unchanged"); checks++;
			var access = sun.misc.Unsafe.class.getDeclaredField("theUnsafe"); access.setAccessible(true);
			var unsafe = (sun.misc.Unsafe) access.get(null);
			var player = (ServerPlayer) unsafe.allocateInstance(ServerPlayer.class); player.setId(1041);
			var equipment = new net.minecraft.world.entity.EntityEquipment();
			var equipmentField = net.minecraft.world.entity.LivingEntity.class.getDeclaredField("equipment"); equipmentField.setAccessible(true); equipmentField.set(player, equipment);
			equipment.set(net.minecraft.world.entity.EquipmentSlot.MAINHAND, bad);
			var inventory = new net.minecraft.world.entity.player.Inventory(player, equipment);
			var field = net.minecraft.world.entity.player.Player.class.getDeclaredField("inventory"); field.setAccessible(true); field.set(player, inventory);
			inventory.setItem(0, bad); inventory.setItem(17, good);
			String stop = OreHarvestFacts.stopReason(player, Blocks.DEEPSLATE_DIAMOND_ORE.defaultBlockState(), new BlockPos(-61, -51, 144));
			if (stop == null || !stop.contains("not broken") || !stop.contains("iron_pickaxe slot 17") || !stop.contains("would yield no block drops")) throw new AssertionError("handoff must name the ore and carried tool: " + stop); checks++;
			if (inventory.getSelectedSlot() != 0) throw new AssertionError("the guard must not switch tools"); checks++;
			inventory.setItem(17, ItemStack.EMPTY);
			if (!OreHarvestFacts.carried(player, Blocks.DEEPSLATE_DIAMOND_ORE.defaultBlockState()).contains("no carried tool")) throw new AssertionError("missing tool stays missing"); checks++;
		} catch (ReflectiveOperationException error) { throw new AssertionError(error); }
		finally {
			for (var entry : bindings.entrySet()) try {
				var field = Holder.Reference.class.getDeclaredField("components"); field.setAccessible(true); field.set(entry.getKey(), entry.getValue());
			} catch (ReflectiveOperationException error) { throw new AssertionError(error); }
		}
		return checks;
	}

	private static ItemStack stack(Item item, List<Tool.Rule> rules, Map<Holder.Reference<Item>, DataComponentMap> bindings) {
		var holder = item.builtInRegistryHolder(); bindings.put(holder, holder.areComponentsBound() ? holder.components() : null);
		holder.bindComponents(DataComponentMap.builder().set(DataComponents.MAX_STACK_SIZE, 1).set(DataComponents.MAX_DAMAGE, 250)
				.set(DataComponents.DAMAGE, 0).set(DataComponents.TOOL, new Tool(rules, 1.0F, 1, true)).build());
		return new ItemStack(item);
	}
}
