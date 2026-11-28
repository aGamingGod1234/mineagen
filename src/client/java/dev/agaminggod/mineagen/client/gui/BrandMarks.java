package dev.agaminggod.mineagen.client.gui;

import java.util.Locale;
import java.util.Map;
import java.util.concurrent.ConcurrentHashMap;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.GuiGraphicsExtractor;
import net.minecraft.client.renderer.RenderPipelines;
import net.minecraft.resources.Identifier;

/**
 * Provider and boat logos, drawn from sprites baked per GUI scale ({@code console/brand/<mark>_h<height>_s<set>}) so
 * each texel lands on one screen pixel. A mark ships only with its owner's permission: until its sprite is in the
 * resources, {@link #width} is 0 and nothing is drawn, so layouts close the gap instead of showing a stand-in.
 */
public final class BrandMarks {
	public enum Mark {
		CLAUDE(1.0F), OPENAI(1.0F), BOAT(1.0F);

		/** Width over height of the artwork. */
		private final float aspect;

		Mark(float aspect) {
			this.aspect = aspect;
		}

		String id() {
			return name().toLowerCase(Locale.ROOT);
		}
	}

	/** Heights the sprites are baked at, in GUI pixels. */
	public static final int SMALL = 10;
	public static final int LARGE = 14;
	private static final int MAX_SET = 4;
	private static final Map<String, Boolean> PRESENT = new ConcurrentHashMap<>();

	private BrandMarks() {
	}

	/** The mark for a provider id ("codex" is OpenAI's tool), or null. */
	public static Mark forProvider(String provider) {
		if (provider == null) return null;
		return switch (provider.toLowerCase(Locale.ROOT)) {
			case "claude" -> Mark.CLAUDE;
			case "codex", "openai" -> Mark.OPENAI;
			case "boat" -> Mark.BOAT;
			default -> null;
		};
	}

	/** GUI width the mark takes at {@code height}; 0 when it is not shipped. */
	public static int width(Mark mark, int height) {
		if (mark == null || !shipped(mark, height)) return 0;
		return Math.max(1, Math.round(height * mark.aspect));
	}

	/** Draws the mark with its top-left at (x, y); returns its width, 0 when it is not shipped. */
	public static int draw(GuiGraphicsExtractor graphics, Mark mark, int x, int y, int height) {
		int width = width(mark, height);
		if (width == 0) return 0;
		int scale = ConsoleDraw.guiScale();
		int set = Math.min(scale, MAX_SET);
		graphics.pose().pushMatrix();
		graphics.pose().translate(x, y);
		float factor = (float) scale / set;
		graphics.pose().scale(factor / scale, factor / scale);
		graphics.blitSprite(RenderPipelines.GUI_TEXTURED, sprite(mark, height, set), 0, 0, width * set, height * set, 0xFFFFFFFF);
		graphics.pose().popMatrix();
		return width;
	}

	static Identifier sprite(Mark mark, int height, int set) {
		return Identifier.fromNamespaceAndPath("mineagen", "console/brand/" + mark.id() + "_h" + height + "_s" + set);
	}

	private static boolean shipped(Mark mark, int height) {
		return PRESENT.computeIfAbsent(mark.id() + height, key -> {
			Minecraft minecraft = Minecraft.getInstance();
			if (minecraft == null) return false;
			Identifier file = Identifier.fromNamespaceAndPath("mineagen",
					"textures/gui/sprites/console/brand/" + mark.id() + "_h" + height + "_s1.png");
			return minecraft.getResourceManager().getResource(file).isPresent();
		});
	}
}
