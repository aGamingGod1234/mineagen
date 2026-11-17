package dev.agaminggod.mineagen.server.runtime;

import java.util.ArrayList;
import java.util.List;
import net.minecraft.core.BlockPos;
import net.minecraft.core.registries.BuiltInRegistries;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.item.ItemStack;
import net.minecraft.world.level.block.state.BlockState;

/** Vanilla harvest rules and carried tools, reported before a mining body destroys an ore. */
public final class OreHarvestFacts {
	private OreHarvestFacts() {}

	public static boolean ore(BlockState state) {
		String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
		return id.endsWith("_ore") || id.equals("minecraft:ancient_debris");
	}

	public static String seenLine(ServerPlayer player, java.util.Map<String, BlockPos> seen, java.util.Set<BlockPos> mined) {
		List<String> lines = new ArrayList<>();
		var ids = new java.util.LinkedHashSet<String>();
		for (String key : seen.keySet()) ids.add(key.substring(0, key.lastIndexOf('@')));
		for (String id : ids) {
			if (!id.matches("minecraft:(deepslate_)?(diamond|iron|gold|redstone|lapis|emerald)_ore|minecraft:(ancient_debris|nether_gold_ore)")) continue;
			var cells = seen.entrySet().stream().filter(e -> e.getKey().startsWith(id + "@") && !mined.contains(e.getValue()))
					.map(java.util.Map.Entry::getValue).sorted(java.util.Comparator.comparingDouble(p -> p.distToCenterSqr(player.getEyePosition()))).toList();
			if (cells.isEmpty()) continue;
			BlockPos near = cells.getFirst();
			BlockState state = BuiltInRegistries.BLOCK.getValue(net.minecraft.resources.Identifier.parse(id)).defaultBlockState();
			lines.add(id.replace("minecraft:", "") + " x" + cells.size() + ", nearest " + near.getX() + "," + near.getY() + "," + near.getZ()
					+ " (" + Math.round(Math.sqrt(near.distToCenterSqr(player.getEyePosition()))) + " blocks); needs " + requirement(state) + "; " + carried(player, state));
			if (lines.size() == 3) break;
		}
		return lines.isEmpty() ? "" : "Ores seen this dig, not mined (positions remembered): " + String.join(" | ", lines);
	}

	public static boolean needsChoice(BlockState state, ItemStack selected) {
		return ore(state) && state.requiresCorrectToolForDrops() && !selected.isCorrectToolForDrops(state);
	}

	public static String carried(ServerPlayer player, BlockState state) {
		List<String> tools = new ArrayList<>();
		for (int slot = 0; slot < 36 && tools.size() < 3; slot++) {
			ItemStack stack = player.getInventory().getItem(slot);
			if (!stack.isEmpty() && stack.isCorrectToolForDrops(state)) tools.add(BreakOutcomeEvidence.itemId(stack) + " slot " + slot);
		}
		return tools.isEmpty() ? "no carried tool can harvest it" : "carried: " + String.join(", ", tools);
	}

	public static String requirement(BlockState state) {
		String required = BreakOutcomeEvidence.requiredTool(state);
		return required == null ? "a tool that can harvest it" : required;
	}

	/** Call only after the target's sight line is established. Never switches tools or chooses a route. */
	public static String stopReason(ServerPlayer player, BlockState state, BlockPos at) {
		if (!needsChoice(state, player.getMainHandItem())) return null;
		String id = BuiltInRegistries.BLOCK.getKey(state.getBlock()).toString();
		return id + " at " + at.getX() + "," + at.getY() + "," + at.getZ() + " not broken: selected "
				+ (player.getMainHandItem().isEmpty() ? "hand" : BreakOutcomeEvidence.itemId(player.getMainHandItem()))
				+ " would yield no block drops; needs " + requirement(state) + "; " + carried(player, state)
				+ "; choose a tool with select_tool/select_item before continuing, or choose another route";
	}
}
