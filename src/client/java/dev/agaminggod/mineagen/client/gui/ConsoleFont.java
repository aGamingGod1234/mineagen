package dev.agaminggod.mineagen.client.gui;

import dev.agaminggod.mineagen.client.mixin.FontManagerAccessor;
import dev.agaminggod.mineagen.client.mixin.MinecraftFontManagerAccessor;
import net.minecraft.client.Minecraft;
import net.minecraft.client.gui.Font;
import net.minecraft.client.gui.font.FontManager;
import net.minecraft.client.gui.font.FontSet;

/** Installs the Mineagen typeface only for Mineagen screens and widgets. */
public final class ConsoleFont {
	public static final net.minecraft.resources.Identifier ID =
			net.minecraft.resources.Identifier.fromNamespaceAndPath("mineagen", "console");
	private static FontSet cachedSet;
	private static Font cachedFont;

	private ConsoleFont() {
	}

	public static synchronized Font create(Minecraft minecraft) {
		FontManager manager = ((MinecraftFontManagerAccessor) minecraft).mineagen$fontManager();
		FontSet selected = ((FontManagerAccessor) manager).mineagen$fontSets().get(ID);
		if (selected == null) return minecraft.font;
		if (selected == cachedSet && cachedFont != null) return cachedFont;
		cachedSet = selected;
		cachedFont = new Font(new Font.Provider() {
			@Override
			public net.minecraft.client.gui.GlyphSource glyphs(net.minecraft.network.chat.FontDescription description) {
				return selected.source(false);
			}

			@Override
			public net.minecraft.client.gui.font.glyphs.EffectGlyph effect() {
				return selected.whiteGlyph();
			}
		});
		return cachedFont;
	}
}
