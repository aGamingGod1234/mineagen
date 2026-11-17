package dev.agaminggod.mineagen.server;

import java.nio.file.Files;
import java.nio.file.Path;
import java.util.List;
import java.util.Optional;
import net.minecraft.core.RegistryAccess;
import net.minecraft.nbt.CompoundTag;
import net.minecraft.nbt.NbtIo;
import net.minecraft.util.datafix.DataFixers;
import net.minecraft.world.level.storage.SavedDataStorage;

/** Retired SavedData files must not prevent the retained agent registry from loading. */
public final class RemovedWorldDataVerification {
	private RemovedWorldDataVerification() {
	}

	public static int verify() throws Exception {
		Path world = Files.createTempDirectory("arena-retired-world-data-");
		Path oldGroups = net.minecraft.resources.Identifier.fromNamespaceAndPath("mineagen", "agent_groups.dat").resolveAgainst(world);
		Files.createDirectories(oldGroups.getParent());
		CompoundTag retired = new CompoundTag();
		CompoundTag data = new CompoundTag();
		data.putString("payload", "{\"schemaVersion\":1,\"groups\":[{\"name\":\"Builders\",\"memberIds\":[{\"value\":\"00000000-0000-0000-0000-000000000001\"}]}]}");
		retired.put("data", data);
		retired.putInt("DataVersion", net.minecraft.SharedConstants.getCurrentVersion().dataVersion().version());
		NbtIo.writeCompressed(retired, oldGroups);
		byte[] before = Files.readAllBytes(oldGroups);

		Path oldSkit = net.minecraft.resources.Identifier.fromNamespaceAndPath("mineagen", "skit_mode.dat").resolveAgainst(world);
		CompoundTag oldScene = new CompoundTag();
		oldScene.putBoolean("enabled", true);
		var cast = new net.minecraft.nbt.ListTag();
		CompoundTag actor = new CompoundTag();
		actor.putString("id", "00000000-0000-0000-0000-000000000001");
		actor.putString("name", "Retired actor");
		actor.putString("appearance", "codex");
		actor.putBoolean("dead", false);
		cast.add(actor);
		oldScene.put("actors", cast);
		CompoundTag retiredScene = new CompoundTag();
		retiredScene.put("data", oldScene);
		retiredScene.putInt("DataVersion", net.minecraft.SharedConstants.getCurrentVersion().dataVersion().version());
		NbtIo.writeCompressed(retiredScene, oldSkit);
		byte[] sceneBefore = Files.readAllBytes(oldSkit);

		dev.agaminggod.mineagen.agent.AgentRecord agent;
		try (var storage = new SavedDataStorage(world, DataFixers.getDataFixer(), RegistryAccess.EMPTY)) {
			var saved = storage.computeIfAbsent(AgentSavedData.TYPE);
			agent = saved.registry().create("codex", "gpt-6.1-sol", "low", Optional.of("Builder"), 1_000L);
			storage.saveAndJoin();
		}
		try (var storage = new SavedDataStorage(world, DataFixers.getDataFixer(), RegistryAccess.EMPTY)) {
			var loaded = storage.get(AgentSavedData.TYPE);
			if (loaded == null || !List.of(agent).equals(loaded.registry().records())) {
				throw new AssertionError("world with retired group and skit data preserves the ordinary agent registry");
			}
			if (!java.util.Arrays.equals(before, Files.readAllBytes(oldGroups))) {
				throw new AssertionError("retired group storage is left unread and untouched");
			}
			if (!java.util.Arrays.equals(sceneBefore, Files.readAllBytes(oldSkit))) {
				throw new AssertionError("retired skit storage is left unread and untouched");
			}
		}
		System.out.println("Retired world data fixture: " + world);
		return 3;
	}
}
