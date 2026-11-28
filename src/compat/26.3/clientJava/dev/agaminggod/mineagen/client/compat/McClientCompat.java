package dev.agaminggod.mineagen.client.compat;

import com.mojang.blaze3d.platform.IconSet;
import com.mojang.blaze3d.platform.InputConstants;
import com.mojang.renderpearl.api.buffers.GpuBuffer;
import com.mojang.renderpearl.api.device.GpuDevice;
import com.mojang.renderpearl.api.textures.GpuTexture;
import java.io.IOException;
import java.io.InputStream;
import java.util.List;
import net.minecraft.client.Minecraft;
import net.minecraft.core.BlockPos;
import net.minecraft.network.protocol.game.ServerboundSignUpdatePacket;
import net.minecraft.server.packs.resources.IoSupplier;
import net.minecraft.world.entity.player.Player;
import net.minecraft.world.level.block.entity.SignTextSlot;

public final class McClientCompat {
	private McClientCompat() {
	}

	public static final InputConstants.Type KEYBOARD = InputConstants.Type.KEYBOARD;

	/** Ticks the HUD still blinks the hearts after a hit. */
	public static int damageBlinkTicks(Player player) {
		return player.damageCooldownTime;
	}

	public static void setDamageBlinkTicks(Player player, int ticks) {
		player.damageCooldownTime = ticks;
	}

	public static BlockPos signPosition(ServerboundSignUpdatePacket packet) {
		return packet.pos();
	}

	public static boolean signFrontText(ServerboundSignUpdatePacket packet) {
		return packet.slot() == SignTextSlot.FRONT;
	}

	public static List<String> signLines(ServerboundSignUpdatePacket packet) {
		return packet.lines();
	}

	/** Vanilla's window icons from the built-in resources. */
	public static List<IoSupplier<InputStream>> windowIcons() throws IOException {
		return IconSet.RELEASE.getStandardIcons(Minecraft.getInstance().getVanillaPackResources().fullResources());
	}

	public static final int TEXTURE_USAGE_COPY_SRC = GpuTexture.USAGE_COPY_SRC;

	public static GpuBuffer createReadbackBuffer(GpuDevice device, String label, long bytes) {
		return device.createBuffer(() -> label, GpuBuffer.USAGE_MAP_READ | GpuBuffer.USAGE_COPY_DST, bytes);
	}


	public static net.minecraft.client.gui.screens.Screen screen(net.minecraft.client.Minecraft client) {
		return client.gui.screen();
	}

	/** Opens chat as the chat key does, or as the command key does (a leading slash). */
	public static void openChat(net.minecraft.client.Minecraft client, boolean command) {
		client.gui.openChatScreen(command ? net.minecraft.client.gui.components.ChatComponent.ChatMethod.COMMAND : net.minecraft.client.gui.components.ChatComponent.ChatMethod.MESSAGE);
	}

	public static void setScreen(net.minecraft.client.Minecraft client, net.minecraft.client.gui.screens.Screen screen) {
		client.gui.setScreen(screen);
	}

	public static net.minecraft.client.gui.screens.Overlay overlay(net.minecraft.client.Minecraft client) {
		return client.gui.overlay();
	}

	public static void overlayMessage(net.minecraft.client.Minecraft client, net.minecraft.network.chat.Component message, boolean animate) {
		client.gui.hud.setOverlayMessage(message, animate);
	}

	public static net.minecraft.client.Camera mainCamera(net.minecraft.client.Minecraft client) {
		return client.gameRenderer.mainCamera();
	}

	public static net.minecraft.client.renderer.state.GameRenderState gameRenderState(net.minecraft.client.Minecraft client) {
		return client.gameRenderer.gameRenderState();
	}

	public static net.minecraft.client.renderer.RenderBuffers renderBuffers(net.minecraft.client.Minecraft client) {
		return client.gameRenderer.renderBuffers();
	}

	// Plan item icons: a private feature dispatcher and atlas, so the icon pass never consumes or draws game submissions.

	public static net.minecraft.client.renderer.feature.FeatureRenderDispatcher iconFeatures(net.minecraft.client.Minecraft client) {
		return new net.minecraft.client.renderer.feature.FeatureRenderDispatcher(renderBuffers(client), client.getModelManager(),
				client.getAtlasManager(), client.font, gameRenderState(client));
	}

	public static net.minecraft.client.gui.render.GuiItemAtlas iconAtlas(net.minecraft.client.Minecraft client,
			net.minecraft.client.renderer.feature.FeatureRenderDispatcher features, int textureSize, int slotSize) {
		return new net.minecraft.client.gui.render.GuiItemAtlas(features, textureSize, slotSize);
	}

	public static void readMapped(GpuBuffer buffer, java.util.function.Consumer<java.nio.ByteBuffer> reader) {
		try (var mapped = buffer.map(true, false)) {
			reader.accept(mapped.data());
		}
	}

	/** Draws {@code entity} inside the box, turned toward the mouse, the way the inventory screen draws the player, without its name tag. */
	public static void entityPreview(net.minecraft.client.gui.GuiGraphicsExtractor graphics, int left, int top, int right, int bottom,
			int size, float yOffset, float mouseX, float mouseY, net.minecraft.world.entity.LivingEntity entity) {
		// Another player's name tag is skipped while the HUD is hidden; hide it only for this draw.
		net.minecraft.client.gui.Hud hud = net.minecraft.client.Minecraft.getInstance().gui.hud;
		boolean hidden = hud.isHidden();
		if (!hidden) hud.toggle();
		try {
			net.minecraft.client.gui.screens.inventory.InventoryScreen.extractEntityInInventoryFollowsMouse(graphics, left, top, right, bottom,
					size, yOffset, mouseX, mouseY, entity);
		} finally {
			if (!hidden) hud.toggle();
		}
	}
}
