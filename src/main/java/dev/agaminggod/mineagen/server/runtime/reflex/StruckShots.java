package dev.agaminggod.mineagen.server.runtime.reflex;

import java.util.HashSet;
import java.util.Map;
import java.util.Set;
import java.util.UUID;
import java.util.WeakHashMap;
import net.fabricmc.fabric.api.entity.event.v1.ServerLivingEntityEvents;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.projectile.Projectile;

/**
 * Projectiles that have already struck a player's body or shield. A blocked arrow bounces off the shield at a tenth of
 * its speed and falls back past the head, so the flight estimate still reads it as about to land; turned to, the shield
 * faced back along the bounce line, away from the archer, and the archer's next draw came from out of view (live
 * drawn-bow room: 149 of 245 unblocked hits on main). A player knows the arrow already hit the shield.
 */
public final class StruckShots {
	private static final Map<Object, Set<UUID>> STRUCK = new WeakHashMap<>();
	private static boolean registered;

	private StruckShots() {
	}

	public static synchronized void register() {
		if (registered) return;
		registered = true;
		// Every hit reaches ALLOW_DAMAGE first, a blocked one and one in the hurt cooldown too.
		ServerLivingEntityEvents.ALLOW_DAMAGE.register((entity, source, amount) -> {
			if (entity instanceof ServerPlayer player && source.getDirectEntity() instanceof Projectile shot) record(shot, player.getUUID());
			return true;
		});
	}

	static synchronized void record(Object shot, UUID player) {
		STRUCK.computeIfAbsent(shot, key -> new HashSet<>()).add(player);
	}

	/** Whether {@code shot} already struck the player {@code player}. */
	static synchronized boolean struck(Object shot, UUID player) {
		Set<UUID> players = STRUCK.get(shot);
		return players != null && players.contains(player);
	}
}
