package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.control.AgentControlAgent;
import java.util.ArrayList;
import java.util.List;
import java.util.Locale;
import net.minecraft.client.Minecraft;
import net.minecraft.world.entity.EquipmentSlot;
import net.minecraft.world.entity.LivingEntity;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.item.ItemStack;

/**
 * What the control center can see of an agent's body, read for display only. The world hosted on this PC gives
 * everything (food, hotbar, level); on another server only what the client is sent about a player it can see
 * (health, armour, held items, position). {@code entity} is the client-side body for the 3D preview, null when the
 * agent is outside render range.
 */
public record AgentBody(
		LivingEntity entity,
		float health,
		float maxHealth,
		float absorption,
		int food,
		int armor,
		int x,
		int y,
		int z,
		String dimension,
		List<ItemStack> equipment,
		List<ItemStack> hotbar,
		int selectedSlot,
		int level
) {
	/** Head, chest, legs, feet, then main and off hand. */
	static final List<EquipmentSlot> SLOTS = List.of(EquipmentSlot.HEAD, EquipmentSlot.CHEST, EquipmentSlot.LEGS,
			EquipmentSlot.FEET, EquipmentSlot.MAINHAND, EquipmentSlot.OFFHAND);

	public boolean knowsFood() {
		return food >= 0;
	}

	public boolean knowsHotbar() {
		return hotbar.size() == 9;
	}

	public boolean hasEquipment() {
		return equipment.stream().anyMatch(stack -> !stack.isEmpty());
	}

	/** "Overworld", "Nether", "End", or the dimension path in title case for a modded one. */
	public String dimensionLabel() {
		return dimensionLabel(dimension);
	}

	static String dimensionLabel(String id) {
		if (id == null || id.isBlank()) return "";
		String path = id.contains(":") ? id.substring(id.indexOf(':') + 1) : id;
		return switch (path) {
			case "overworld" -> "Overworld";
			case "the_nether" -> "Nether";
			case "the_end" -> "End";
			default -> {
				String spaced = path.replace('_', ' ').replace('/', ' ');
				yield spaced.isEmpty() ? "" : spaced.substring(0, 1).toUpperCase(Locale.ROOT) + spaced.substring(1);
			}
		};
	}

	/** Null when the agent has no body this client can see or read. */
	public static AgentBody read(Minecraft minecraft, AgentControlAgent agent) {
		if (minecraft == null || agent == null) return null;
		try {
			Player visible = null;
			if (minecraft.level != null) {
				for (Player player : minecraft.level.players()) {
					if (player.getName().getString().equals(agent.playerName())) {
						visible = player;
						break;
					}
				}
			}
			Player hosted = null;
			var server = minecraft.getSingleplayerServer();
			if (server != null) hosted = server.getPlayerList().getPlayerByName(agent.playerName());
			Player source = hosted != null ? hosted : visible;
			if (source == null) return null;
			List<ItemStack> equipment = new ArrayList<>(SLOTS.size());
			for (EquipmentSlot slot : SLOTS) equipment.add(source.getItemBySlot(slot).copy());
			List<ItemStack> hotbar = new ArrayList<>(9);
			int selected = -1, level = -1, food = -1;
			if (hosted != null) {
				for (int index = 0; index < 9; index++) hotbar.add(hosted.getInventory().getItem(index).copy());
				selected = hosted.getInventory().getSelectedSlot();
				level = hosted.experienceLevel;
				food = hosted.getFoodData().getFoodLevel();
			}
			var position = source.blockPosition();
			return new AgentBody(visible, source.getHealth(), source.getMaxHealth(), source.getAbsorptionAmount(), food,
					source.getArmorValue(), position.getX(), position.getY(), position.getZ(),
					source.level().dimension().identifier().toString(), List.copyOf(equipment), List.copyOf(hotbar), selected, level);
		} catch (RuntimeException unavailable) {
			// read off the server thread for display only; a body changing under us just skips this refresh
			return null;
		}
	}
}
