package dev.agaminggod.mineagen.server.perception;

import com.google.gson.JsonArray;
import com.google.gson.JsonObject;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.function.Predicate;
import net.minecraft.core.BlockPos;
import net.minecraft.core.particles.ParticleTypes;
import net.minecraft.server.level.ServerPlayer;
import net.minecraft.world.entity.AreaEffectCloud;
import net.minecraft.world.phys.AABB;
import net.minecraft.world.phys.Vec3;

/** Visible cloud geometry and the body's own contact/effect cues, never hidden potion contents. */
public final class CloudDanger {
	private static final java.util.Map<ServerPlayer, java.util.Set<AreaEffectCloud>> KNOWN_HARM = new java.util.WeakHashMap<>();
	/**
	 * Harmful clouds this player has sensed (seen or touched): a player running from breath remembers where it is behind
	 * them. Without it the reflex lost the cloud the moment the body turned away, and a waiting command walked back in.
	 */
	private static final java.util.Map<ServerPlayer, java.util.Set<AreaEffectCloud>> SENSED = new java.util.WeakHashMap<>();
	private static final java.util.Map<ServerPlayer, Alerts> ALERTS = new java.util.WeakHashMap<>();
	private static final class Alerts {
		Object level;
		final java.util.Map<AreaEffectCloud, Boolean> clouds = new java.util.WeakHashMap<>();
	}
	private static final java.util.Map<ServerPlayer, Frame> FRAMES = new java.util.WeakHashMap<>();
	private static final class Frame {
		final long tick;
		final Object level;
		final List<Exposure> exposures;
		JsonArray rows;
		Frame(ServerPlayer player) {
			tick = player.level().getGameTime(); level = player.level(); exposures = readExposures(player);
		}
	}
	private static Frame frame(ServerPlayer player) {
		Frame frame = FRAMES.get(player);
		if (frame == null || frame.tick != player.level().getGameTime() || frame.level != player.level()) {
			frame = new Frame(player); FRAMES.put(player, frame);
		}
		return frame;
	}
	private CloudDanger() { }

	static void forget(ServerPlayer player) { FRAMES.remove(player); ALERTS.remove(player); KNOWN_HARM.remove(player); SENSED.remove(player); }
	static void clear() { FRAMES.clear(); ALERTS.clear(); KNOWN_HARM.clear(); SENSED.clear(); }

	private static boolean sensed(ServerPlayer player, AreaEffectCloud cloud) {
		var known = SENSED.get(player);
		return known != null && known.contains(cloud);
	}

	static boolean dragon(AreaEffectCloud cloud) { return cloud.getParticle().getType() == ParticleTypes.DRAGON_BREATH; }

	static boolean inside(Vec3 center, double radius, AABB bounds, Vec3 feet, AABB body) {
		return bounds.intersects(body) && Math.pow(feet.x - center.x, 2) + Math.pow(feet.z - center.z, 2) <= radius * radius;
	}

	static String contactSource(ServerPlayer player) {
		for (AreaEffectCloud cloud : player.level().getEntitiesOfClass(AreaEffectCloud.class, player.getBoundingBox(), AreaEffectCloud::isAlive)) {
			if (!inside(cloud.position(), cloud.getRadius(), cloud.getBoundingBox(), player.position(), player.getBoundingBox())) continue;
			if (cloud.isWaiting() || !magicDamage(player)) continue;
			var damage = player.getLastDamageSource();
			if (damage.getDirectEntity() != cloud) continue;
			return dragon(cloud) ? "minecraft:dragon_breath" : "minecraft:lingering_potion";
		}
		return null;
	}

	static boolean magicDamage(ServerPlayer player) {
		var source = player.getLastDamageSource();
		String type = source == null ? "" : source.typeHolder().unwrapKey().map(key -> key.identifier().getPath()).orElse(source.getMsgId());
		return type.equals("indirect_magic") || type.equals("indirectMagic") || type.equals("magic");
	}

	private static boolean harmCue(ServerPlayer player, AreaEffectCloud cloud) {
		var known = KNOWN_HARM.get(player);
		if (known != null && known.contains(cloud)) return true;
		var source = player.getLastDamageSource();
		boolean received = player.hurtTime > 0 && magicDamage(player) && source.getDirectEntity() == cloud;
		if (received) KNOWN_HARM.computeIfAbsent(player, ignored -> java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>())).add(cloud);
		return received;
	}

	/** How far above the head or below the feet a cloud can be and still be stepped into. */
	static final double CLOUD_STEP_REACH = 1.0D;

	/**
	 * The nearest harmful cloud (dragon breath, or one whose magic already hurt this player) that the player is in or
	 * whose edge lies within {@code within} blocks, seen or touched. A reflex runs from it.
	 */
	public static AreaEffectCloud nearestHarmful(ServerPlayer player, double within) {
		AreaEffectCloud nearest = null;
		double best = Double.POSITIVE_INFINITY;
		Vec3 feet = player.position();
		AABB reach = player.getBoundingBox().inflate(within, CLOUD_STEP_REACH, within);
		ObservationVisibility.Frame visibility = null;
		for (AreaEffectCloud cloud : player.level().getEntitiesOfClass(AreaEffectCloud.class, player.getBoundingBox().inflate(within + 8.0D),
				AreaEffectCloud::isAlive)) {
			if (!cloud.getBoundingBox().intersects(reach)) continue;
			double edge = Math.hypot(feet.x - cloud.getX(), feet.z - cloud.getZ()) - cloud.getRadius();
			if (edge > within || edge >= best) continue;
			boolean contact = inside(cloud.position(), cloud.getRadius(), cloud.getBoundingBox(), feet, player.getBoundingBox());
			var known = KNOWN_HARM.get(player);
			if (!dragon(cloud) && !(known != null && known.contains(cloud)) && !(contact && harmCue(player, cloud))) continue;
			if (!contact && !sensed(player, cloud)) {
				if (visibility == null) visibility = ObservationVisibility.frame(player.level(), player);
				if (!visibility.canSeeAppearance(cloud)) continue;
			}
			best = edge;
			nearest = cloud;
		}
		if (nearest != null) SENSED.computeIfAbsent(player, ignored -> java.util.Collections.newSetFromMap(new java.util.WeakHashMap<>())).add(nearest);
		return nearest;
	}

	/**
	 * A harmful cloud (dragon breath, or one whose magic hurt this player) the body is in now: its feet inside the radius
	 * and its body box through the cloud's box, the contact vanilla's cloud tick applies its effect to. Null when none.
	 */
	public static AreaEffectCloud touching(ServerPlayer player) {
		var known = KNOWN_HARM.get(player);
		for (AreaEffectCloud cloud : player.level().getEntitiesOfClass(AreaEffectCloud.class, player.getBoundingBox().inflate(1.0D), AreaEffectCloud::isAlive)) {
			if (!dragon(cloud) && !(known != null && known.contains(cloud))) continue;
			if (inside(cloud.position(), cloud.getRadius(), cloud.getBoundingBox(), player.position(), player.getBoundingBox())) return cloud;
		}
		return null;
	}

	/**
	 * A harmful cloud right under the feet: inside its radius (with the growth a moment brings), its box top at or below the
	 * feet and less than a block under them, so a step down or off a placed block puts the body back in it. A cloud's box is
	 * half a block high (vanilla AreaEffectCloud dimensions), so a body standing one block over its base is out of reach.
	 */
	public static AreaEffectCloud beneath(ServerPlayer player) {
		var known = KNOWN_HARM.get(player);
		Vec3 feet = player.position();
		for (AreaEffectCloud cloud : player.level().getEntitiesOfClass(AreaEffectCloud.class, player.getBoundingBox().inflate(8.0D, 2.0D, 8.0D), AreaEffectCloud::isAlive)) {
			if (!dragon(cloud) && !(known != null && known.contains(cloud))) continue;
			double top = cloud.getBoundingBox().maxY, radius = cloud.getRadius() + Math.max(0.0D, cloud.getRadiusPerTick()) * 20.0D + 0.3D;
			if (top > feet.y + 1.0E-3D || feet.y - top >= 1.0D) continue;
			if (Math.pow(feet.x - cloud.getX(), 2) + Math.pow(feet.z - cloud.getZ(), 2) <= radius * radius) return cloud;
		}
		return null;
	}

	/** Ticks of growth a reflex run allows for: the run itself and a moment after it. */
	static final int RUN_LEAD_TICKS = 60;

	public static boolean newHarmAt(ServerPlayer player, Vec3 feet) {
		return harmAt(player, feet, true);
	}

	/** As {@link #newHarmAt}, counting a cloud the player already stands in too: where a step back must not go. */
	public static boolean harmAt(ServerPlayer player, Vec3 feet) {
		return harmAt(player, feet, false);
	}

	private static boolean harmAt(ServerPlayer player, Vec3 feet, boolean onlyNew) {
		Vec3 here = player.position();
		ObservationVisibility.Frame visibility = null;
		var known = KNOWN_HARM.get(player);
		for (AreaEffectCloud cloud : player.level().getEntitiesOfClass(AreaEffectCloud.class, player.getBoundingBox().inflate(16.0D),
				AreaEffectCloud::isAlive)) {
			if (!dragon(cloud) && !(known != null && known.contains(cloud))) continue;
			double radius = cloud.getRadius() + Math.max(0.0D, cloud.getRadiusPerTick()) * RUN_LEAD_TICKS;
			AABB bounds = cloud.getBoundingBox().inflate(radius - cloud.getRadius(), 0.0D, radius - cloud.getRadius());
			AABB body = new AABB(feet.x - 0.3D, feet.y, feet.z - 0.3D, feet.x + 0.3D, feet.y + 1.8D, feet.z + 0.3D);
			if (!inside(cloud.position(), radius, bounds.inflate(0.0D, 1.0D, 0.0D), feet, body)) continue;
			if (onlyNew && inside(cloud.position(), cloud.getRadius(), cloud.getBoundingBox(), here, player.getBoundingBox())) continue;
			if (sensed(player, cloud)) return true;
			if (visibility == null) visibility = ObservationVisibility.frame(player.level(), player);
			if (visibility.canSeeAppearance(cloud)) return true;
		}
		return false;
	}

	record Exposure(AreaEffectCloud cloud, boolean contact, boolean entering, boolean harmful) { }

	static List<Exposure> exposures(ServerPlayer player) { return frame(player).exposures; }

	private static List<Exposure> readExposures(ServerPlayer player) {
		var clouds = player.level().getEntitiesOfClass(AreaEffectCloud.class, player.getBoundingBox().inflate(2), AreaEffectCloud::isAlive);
		if (clouds.isEmpty()) return List.of();
		var visibility = ObservationVisibility.frame(player.level(), player);
		var motion = player.getDeltaMovement();
		AABB nextBody = player.getBoundingBox().move(motion);
		List<Exposure> result = new ArrayList<>();
		for (AreaEffectCloud cloud : clouds) {
			boolean contact = inside(cloud.position(), cloud.getRadius(), cloud.getBoundingBox(), player.position(), player.getBoundingBox());
			boolean entering = inside(cloud.position(), cloud.getRadius(), cloud.getBoundingBox(), player.position().add(motion), nextBody);
			if (!contact && !visibility.canSeeAppearance(cloud)) continue;
			result.add(new Exposure(cloud, contact, !contact && entering, !cloud.isWaiting() && (dragon(cloud) || contact && harmCue(player, cloud))));
		}
		return result;
	}

	static java.util.Set<String> signalKeys(ServerPlayer player) {
		Alerts alerts = ALERTS.computeIfAbsent(player, ignored -> new Alerts());
		if (alerts.level != player.level()) { alerts.clouds.clear(); alerts.level = player.level(); }
		for (Exposure exposure : exposures(player)) alerts.clouds.merge(exposure.cloud(), exposure.contact(), (before, now) -> before || now);
		// Keep the two edges latched for this cloud's lifetime, including after leaving and re-entering it.
		alerts.clouds.keySet().removeIf(cloud -> !cloud.isAlive());
		java.util.Set<String> result = new java.util.HashSet<>();
		alerts.clouds.forEach((cloud, contacted) -> {
			String uuid = cloud.getUUID().toString();
			result.add(key(uuid, false));
			if (contacted) result.add(key(uuid, true));
		});
		return result;
	}

	static String key(String uuid, boolean contact) { return uuid + (contact ? ":contact" : ":seen"); }

	static JsonArray sample(ServerPlayer player) {
		return sample(player, () -> DropAhead.cells(SeenTerrain.of(player), player.level()));
	}

	static JsonArray sample(ServerPlayer player, java.util.function.Supplier<DropAhead.Cells> terrain) {
		Frame frame = frame(player);
		if (frame.rows != null) return frame.rows.deepCopy();
		JsonArray rows = new JsonArray();
		List<Exposure> exposures = frame.exposures;
		DropAhead.Cells cells = exposures.isEmpty() ? null : terrain.get();
		for (Exposure exposure : exposures) {
			AreaEffectCloud cloud = exposure.cloud();
			JsonObject row = new JsonObject();
			row.addProperty("uuid", cloud.getUUID().toString());
			row.addProperty("source", dragon(cloud) ? "dragon_breath" : "lingering_potion");
			if (cloud.isWaiting()) row.addProperty("arming", true);
			else if (exposure.harmful()) row.addProperty("harmful", true);
			else row.addProperty("harmUnknown", true);
			row.addProperty("contact", exposure.contact());
			row.addProperty("entering", exposure.entering());
			row.add("bounds", bounds(cloud.getBoundingBox()));
			row.addProperty("radius", cloud.getRadius());
			if (cloud.getRadiusPerTick() > 0.0F) {
				row.addProperty("growing", true);
				if (!exposure.contact()) {
					// Seconds until the spreading edge reaches the feet if the body stays put (seen growth, not a hidden timer).
					double gap = Math.hypot(player.getX() - cloud.getX(), player.getZ() - cloud.getZ()) - cloud.getRadius();
					double seconds = gap / (cloud.getRadiusPerTick() * 20.0D);
					if (gap > 0.0D && seconds <= 30.0D) row.addProperty("reachesYouInS", Math.round(seconds * 10.0D) / 10.0D);
				}
			}
			Vec3 exit = nearestExit(player.position(), cloud.position(), exitRadius(cloud), candidate -> knownStanding(cells, candidate)
					&& exposures.stream().noneMatch(other -> inside(other.cloud().position(), other.cloud().getRadius(), other.cloud().getBoundingBox(), candidate,
							new AABB(candidate.x - 0.3, candidate.y, candidate.z - 0.3, candidate.x + 0.3, candidate.y + 1.8, candidate.z + 0.3))));
			if (exit != null) {
				row.add("nearestExit", cell(BlockPos.containing(exit)));
				row.addProperty("exitRoute", "unverified");
			} else row.addProperty("exitKnown", false);
			rows.add(row);
			if (rows.size() == 4) break;
		}
		frame.rows = rows;
		return rows.deepCopy();
	}

	/** About one model turn: an exit must still be outside when the reply's move arrives. */
	static final int EXIT_LEAD_TICKS = 200;

	static double exitRadius(double radius, double radiusPerTick) {
		return radius + Math.max(0.0D, radiusPerTick) * EXIT_LEAD_TICKS;
	}

	private static double exitRadius(AreaEffectCloud cloud) {
		return exitRadius(cloud.getRadius(), cloud.getRadiusPerTick());
	}

	static Vec3 nearestExit(Vec3 feet, Vec3 center, double radius, Predicate<Vec3> knownStanding) {
		List<Vec3> candidates = new ArrayList<>();
		BlockPos origin = BlockPos.containing(feet);
		int range = (int) Math.ceil(radius * 2) + 2;
		for (int x = -range; x <= range; x++) for (int z = -range; z <= range; z++) for (int y = -1; y <= 1; y++) {
			Vec3 candidate = Vec3.atBottomCenterOf(origin.offset(x, y, z));
			if (Math.hypot(candidate.x - center.x, candidate.z - center.z) > radius + 0.31D) candidates.add(candidate);
		}
		candidates.sort(Comparator.comparingDouble(feet::distanceToSqr));
		return candidates.stream().filter(knownStanding).findFirst().orElse(null);
	}

	private static boolean knownStanding(DropAhead.Cells cells, Vec3 feet) {
		BlockPos pos = BlockPos.containing(feet);
		return cells.at(pos.getX(), pos.getY(), pos.getZ()).kind() == DropAhead.Kind.OPEN
				&& cells.at(pos.getX(), pos.getY() + 1, pos.getZ()).kind() == DropAhead.Kind.OPEN
				&& cells.at(pos.getX(), pos.getY() - 1, pos.getZ()).kind() == DropAhead.Kind.SOLID
				&& cells.at(pos.getX(), pos.getY() - 1, pos.getZ()).top() == 1.0D;
	}

	private static JsonObject bounds(AABB box) {
		JsonObject value = new JsonObject();
		value.addProperty("minX", box.minX); value.addProperty("minY", box.minY); value.addProperty("minZ", box.minZ);
		value.addProperty("maxX", box.maxX); value.addProperty("maxY", box.maxY); value.addProperty("maxZ", box.maxZ);
		return value;
	}
	private static JsonObject cell(BlockPos pos) {
		JsonObject value = new JsonObject();
		value.addProperty("x", pos.getX()); value.addProperty("y", pos.getY()); value.addProperty("z", pos.getZ());
		return value;
	}
}
