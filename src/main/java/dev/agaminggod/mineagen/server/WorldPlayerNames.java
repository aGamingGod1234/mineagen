package dev.agaminggod.mineagen.server;

import com.mojang.serialization.Codec;
import java.util.HashMap;
import java.util.Locale;
import java.util.Map;
import java.util.UUID;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.world.level.saveddata.SavedData;
import net.minecraft.world.level.saveddata.SavedDataType;

public final class WorldPlayerNames extends SavedData {
	static final Codec<WorldPlayerNames> CODEC = Codec.unboundedMap(Codec.STRING,
			Codec.STRING.xmap(UUID::fromString, UUID::toString)).xmap(WorldPlayerNames::new, data -> Map.copyOf(data.names));
	private static final SavedDataType<WorldPlayerNames> TYPE = new SavedDataType<>(
			Identifier.fromNamespaceAndPath("mineagen", "player_names"), WorldPlayerNames::new, CODEC, DataFixTypes.SAVED_DATA_COMMAND_STORAGE);
	private final Map<String, UUID> names = new HashMap<>();

	public WorldPlayerNames() {}
	private WorldPlayerNames(Map<String, UUID> names) { names.forEach(this::remember); }
	static WorldPlayerNames get(MinecraftServer server) { return server.overworld().getDataStorage().computeIfAbsent(TYPE); }
	boolean contains(String name) { return names.containsKey(name.toLowerCase(Locale.ROOT)); }
	void remember(String name, UUID id) {
		if (names.putIfAbsent(name.toLowerCase(Locale.ROOT), id) == null) setDirty();
	}
}