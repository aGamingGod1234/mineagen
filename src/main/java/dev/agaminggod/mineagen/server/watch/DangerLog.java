package dev.agaminggod.mineagen.server.watch;

import com.google.gson.JsonObject;
import dev.agaminggod.mineagen.server.runtime.reflex.ReflexScheduler;
import java.util.ArrayList;
import java.util.HashSet;
import java.util.Iterator;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Set;
import java.util.regex.Pattern;

/**
 * Rows of {@code arena-watch/<agentId>-danger.jsonl} for one agent, without a server: per-hit damage, onsets ({@code
 * targeted}, {@code aimed}, {@code hit}) with their first response and latency, a {@code clear} row when the last onset
 * closes (threat time), and one row per reflex scheduler event ({@code firing} for a real firing, {@code reflex_event} for
 * held-back, disabled and idle-expiry events). The Watcher feeds it; nothing here reaches the model.
 *
 * <p>Rules version {@link #RULES}; changing an onset, close or response rule moves the gate's denominator, so bump it.
 * Times are game time (ticks) plus epoch ms; scheduler ticks (server tick count) are converted with the offset the caller
 * read at the Watcher tick that saw them.
 */
public final class DangerLog {
	public static final int SCHEMA = 2;
	public static final String RULES = "onset-1";
	/** A response must start within this many ticks of the onset; after it the onset's response is {@code none}. */
	public static final long RESPONSE_WINDOW_TICKS = 200L;
	/** An onset closes once its source has not been seen active for this long (entity scans run every 2 ticks). */
	public static final long CLOSE_GRACE_TICKS = 40L;
	public static final int MAX_OPEN = 32;
	static final int MAX_STEMS = 256;
	/** Command kinds that never take the body, so they answer no onset. */
	static final Set<String> NOT_BODY = Set.of("chat", "complete_goal");
	private static final Pattern STEM_SUFFIX = Pattern.compile("(-leg\\d+|:\\d+)$");

	/** A command the bridge accepted for this agent; {@code issuer} is the coordinator's explicit field, or null from an older one. */
	public record Command(String actionId, String actionType, String programId, String sourceStepId, String issuer) {
	}

	/** The firing running now, its start converted to game time, and the condition types its rule fires on. */
	public record FiringNow(String ruleId, long startGameTime, Set<String> when) {
	}

	/**
	 * The body's guard just before a hit (ALLOW_DAMAGE): which hand holds a shield ({@code "main"}, {@code "off"} or null)
	 * and whether it is raised. It is read before the hit, because a hit that disables the shield lowers it before
	 * AFTER_DAMAGE and a death empties the hands before its event.
	 */
	public record Guard(String shieldHand, boolean blocking) {
	}

	/**
	 * Where a hit came from and how lit the body stood, read when it lands; null where unknown. {@code facingErrorDeg} is
	 * the horizontal angle between the look direction and the direction to the hit's source, {@code attackerDistance} the
	 * blocks to the attacker, {@code light} the block light at the body's feet.
	 */
	public record Exposure(Double facingErrorDeg, Double attackerDistance, Integer light) {
	}

	/**
	 * One hit: health and absorption before (ALLOW_DAMAGE) and after (AFTER_DAMAGE, or 0 health on a lethal hit), the
	 * action and firing running when it landed, and the guard (null when unpaired) and exposure (null when not read).
	 */
	public record Hit(String kind, String damageType, String attacker, String attackerId, String sourceKey, Float amount, Float taken,
			boolean blocked, Float healthBefore, Float absorptionBefore, float healthAfter, float absorptionAfter, boolean lethal,
			Command action, String firingRule, Guard guard, Exposure exposure) {
	}

	private static final class Onset {
		final String onset;
		final String key;
		final String kind;
		final String sourceType;
		final String entityId;
		final double distance;
		final long atTick;
		final long atMs;
		final Command active;
		long lastActiveTick;
		long lastActiveMs;
		boolean closed;
		String response;
		long responseTick = -1L;
		String responseActionId;
		String responseIssuer;

		Onset(String onset, String key, String kind, String sourceType, String entityId, double distance, long atTick, long atMs, Command active) {
			this.onset = onset;
			this.key = key;
			this.kind = kind;
			this.sourceType = sourceType;
			this.entityId = entityId;
			this.distance = distance;
			this.atTick = atTick;
			this.atMs = atMs;
			this.active = active;
			this.lastActiveTick = atTick;
			this.lastActiveMs = atMs;
		}
	}

	private final String agentId;
	private final Map<String, Onset> open = new LinkedHashMap<>();
	private final List<Onset> unresolved = new ArrayList<>();
	private final Set<String> stems = new HashSet<>();
	private final List<JsonObject> rows = new ArrayList<>();
	private Command active;
	private String firingKey;
	private long spanStartTick = -1L;
	private long spanStartMs;
	private long spanEndTick;
	private long spanEndMs;
	private int spanOnsets;
	private final EventCursor eventCursor = new EventCursor();
	private long beforeTick = Long.MIN_VALUE;
	private float beforeHealth;
	private float beforeAbsorption;
	private float beforeAmount;
	private Guard beforeGuard;

	public DangerLog(String agentId) {
		this.agentId = agentId;
	}

	/** Rows written since the last call, in order. */
	public List<JsonObject> take() {
		List<JsonObject> taken = List.copyOf(rows);
		rows.clear();
		return taken;
	}

	public boolean threatOpen() {
		return !open.isEmpty();
	}

	/** One Watcher tick: dangers the scan found, the firing running now (or null) and the action running now (or null). */
	public void observe(List<Danger> dangers, long gameTime, long epochMs, FiringNow firing, Command running) {
		active = running;
		for (Danger danger : dangers) {
			if (danger.targeting()) seen("targeted", danger, gameTime, epochMs, firing);
			if (danger.kind().equals("projectile")) seen("aimed", danger, gameTime, epochMs, firing);
		}
		String key = firing == null ? null : firing.ruleId() + "@" + firing.startGameTime();
		if (key != null && !key.equals(firingKey)) {
			for (Onset onset : unresolved) {
				if (onset.response == null && firing.startGameTime() >= onset.atTick && covers(firing, onset.kind)) {
					resolve(onset, "instinct:" + firing.ruleId(), firing.startGameTime(), null, null);
				}
			}
		}
		firingKey = key;
		expire(gameTime, epochMs);
	}

	/**
	 * The bridge accepted a command. Only the first command of each step stem under a program is a response, and only a
	 * command that moves the body: a chat line or a goal report is routed beside the running action.
	 */
	public void command(Command command, long gameTime) {
		if (NOT_BODY.contains(command.actionType())) return;
		active = command;
		String stem = command.programId() + "\u0000" + STEM_SUFFIX.matcher(command.sourceStepId() == null ? "" : command.sourceStepId()).replaceFirst("");
		if (stems.size() >= MAX_STEMS) stems.clear();
		if (!stems.add(stem)) return;
		String path = path(command.issuer());
		for (Onset onset : unresolved) {
			if (onset.response == null && gameTime >= onset.atTick && gameTime - onset.atTick <= RESPONSE_WINDOW_TICKS) {
				resolve(onset, path, gameTime, command.actionId(), command.issuer());
			}
		}
	}

	static String path(String issuer) {
		if (issuer == null) return "command:unknown";
		return switch (issuer) {
			case "model", "skill_leg" -> "command:model";
			case "program", "standing_order", "guard" -> "command:program";
			default -> "command:unknown";
		};
	}

	/** ALLOW_DAMAGE: health and absorption before a hit, paired with the hit only within the same server tick. */
	public void beforeDamage(long serverTick, float health, float absorption, float amount) {
		beforeDamage(serverTick, health, absorption, amount, null);
	}

	/** ALLOW_DAMAGE with the body's guard, paired like health; a null guard is written as unknown. */
	public void beforeDamage(long serverTick, float health, float absorption, float amount, Guard guard) {
		beforeTick = serverTick;
		beforeHealth = health;
		beforeAbsorption = absorption;
		beforeAmount = amount;
		beforeGuard = guard;
	}

	/**
	 * AFTER_DAMAGE, or a lethal hit from the death event (which AFTER_DAMAGE never reports; {@code amount} is then null and
	 * comes from the paired ALLOW_DAMAGE). {@code amount} is before armour, {@code taken} after armour and shield.
	 */
	public void damage(long serverTick, String kind, String damageType, String attacker, String attackerId, String sourceKey, Float amount, Float taken,
			boolean blocked, float healthAfter, float absorptionAfter, boolean lethal, long gameTime, long epochMs, FiringNow firing) {
		damage(serverTick, kind, damageType, attacker, attackerId, sourceKey, amount, taken, blocked, healthAfter, absorptionAfter, lethal, gameTime,
				epochMs, firing, null);
	}

	/** {@link #damage} with the hit's exposure (null: not read, written as unknown). */
	public void damage(long serverTick, String kind, String damageType, String attacker, String attackerId, String sourceKey, Float amount, Float taken,
			boolean blocked, float healthAfter, float absorptionAfter, boolean lethal, long gameTime, long epochMs, FiringNow firing, Exposure exposure) {
		damage(serverTick, kind, damageType, attacker, attackerId, sourceKey, amount, taken, blocked, healthAfter, absorptionAfter, lethal, gameTime,
				epochMs, firing, exposure, false, null);
	}

	/**
	 * {@link #damage} with the action running when the hit landed, read by the caller at the hit ({@code actionRead}:
	 * null then means nothing ran). Without that read the row names the action this log last saw at a tick's end.
	 */
	public void damage(long serverTick, String kind, String damageType, String attacker, String attackerId, String sourceKey, Float amount, Float taken,
			boolean blocked, float healthAfter, float absorptionAfter, boolean lethal, long gameTime, long epochMs, FiringNow firing, Exposure exposure,
			boolean actionRead, Command actionAtHit) {
		boolean paired = beforeTick == serverTick;
		beforeTick = Long.MIN_VALUE;
		Float base = amount != null ? amount : paired ? Float.valueOf(beforeAmount) : null;
		Hit hit = new Hit(kind, damageType, attacker, attackerId, sourceKey, base, taken, blocked, paired ? beforeHealth : null,
				paired ? beforeAbsorption : null, lethal ? 0.0F : healthAfter, absorptionAfter, lethal, actionRead ? actionAtHit : active, firing == null ? null : firing.ruleId(),
				paired ? beforeGuard : null, exposure);
		beforeGuard = null;
		rows.add(damageRow(hit, gameTime, epochMs));
		String key = sourceKey != null ? sourceKey : kind;
		boolean known = false;
		for (Onset onset : open.values()) {
			if (!onset.key.equals(key)) continue;
			known = true;
			onset.lastActiveTick = gameTime;
			onset.lastActiveMs = epochMs;
		}
		if (!known) open(new Onset("hit", key, kind, attacker == null ? damageType : attacker, attackerId, 0.0D, gameTime, epochMs, active), firing);
	}

	/** A mob the agent killed (1b): whether the body saw it die, and the drops at the corpse it could and could not see. */
	public void kill(String entityType, boolean seen, int dropsSeen, int dropsUnseen, long gameTime, long epochMs) {
		rows.add(killRow(entityType, seen, dropsSeen, dropsUnseen, gameTime, epochMs));
	}

	JsonObject killRow(String entityType, boolean seen, int dropsSeen, int dropsUnseen, long gameTime, long epochMs) {
		JsonObject row = header("kill", gameTime, epochMs);
		for (var field : dev.agaminggod.mineagen.server.perception.KillSighting.row(entityType, seen, dropsSeen, dropsUnseen).entrySet())
			row.add(field.getKey(), field.getValue());
		return row;
	}

	/** The agent died: every onset closes and resolves now, marked truncated when its window had not run out. */
	public void death(long gameTime, long epochMs) {
		closeAll(gameTime, epochMs, "death");
	}

	/** The agent left or the server stops. */
	public void stop(long gameTime, long epochMs) {
		closeAll(gameTime, epochMs, "stop");
	}

	/**
	 * New events of the scheduler {@code generation} names (a replaced scheduler numbers from 1 again; see {@link
	 * EventCursor}). {@code tickOffset} is game time minus server tick.
	 */
	public void events(List<ReflexScheduler.Event> events, long generation, long tickOffset, long gameTime, long epochMs) {
		for (ReflexScheduler.Event event : eventCursor.fresh(generation, events))
			rows.add(event.firing() ? firingRow(event, tickOffset, gameTime, epochMs) : eventRow(event, gameTime, epochMs));
	}

	long eventCursor() {
		return eventCursor.sequence();
	}

	private void seen(String kind, Danger danger, long gameTime, long epochMs, FiringNow firing) {
		Onset onset = open.get(kind + ":" + danger.key());
		if (onset != null) {
			onset.lastActiveTick = gameTime;
			onset.lastActiveMs = epochMs;
			return;
		}
		open(new Onset(kind, danger.key(), danger.kind(), danger.sourceType(), danger.entityId(), danger.distance(), gameTime, epochMs, active), firing);
	}

	private void open(Onset onset, FiringNow firing) {
		if (open.size() >= MAX_OPEN) return;
		open.put(onset.onset + ":" + onset.key, onset);
		unresolved.add(onset);
		if (spanStartTick < 0L) {
			spanStartTick = onset.atTick;
			spanStartMs = onset.atMs;
			spanOnsets = 0;
		}
		spanOnsets++;
		// A firing already running whose rule covers this danger is the response, at latency 0.
		if (firing != null && covers(firing, onset.kind)) resolve(onset, "instinct:" + firing.ruleId(), onset.atTick, null, null);
	}

	private static boolean covers(FiringNow firing, String kind) {
		Set<String> covering = Diagnosis.COVERAGE.getOrDefault(kind, Set.of());
		for (String type : firing.when()) if (covering.contains(type)) return true;
		return false;
	}

	private void resolve(Onset onset, String response, long tick, String actionId, String issuer) {
		onset.response = response;
		onset.responseTick = tick;
		onset.responseActionId = actionId;
		onset.responseIssuer = issuer;
	}

	private void expire(long gameTime, long epochMs) {
		for (Iterator<Onset> iterator = unresolved.iterator(); iterator.hasNext(); ) {
			Onset onset = iterator.next();
			if (onset.response == null && gameTime - onset.atTick <= RESPONSE_WINDOW_TICKS) continue;
			if (onset.response == null) onset.response = "none";
			rows.add(onsetRow(onset, false));
			iterator.remove();
		}
		boolean closedAny = false;
		for (Iterator<Onset> iterator = open.values().iterator(); iterator.hasNext(); ) {
			Onset onset = iterator.next();
			if (gameTime - onset.lastActiveTick < CLOSE_GRACE_TICKS) continue;
			iterator.remove();
			close(onset);
			closedAny = true;
		}
		if (closedAny && open.isEmpty()) clear(gameTime, epochMs, "quiet");
	}

	private void close(Onset onset) {
		onset.closed = true;
		if (onset.lastActiveTick >= spanEndTick) {
			spanEndTick = onset.lastActiveTick;
			spanEndMs = onset.lastActiveMs;
		}
	}

	private void closeAll(long gameTime, long epochMs, String cause) {
		for (Onset onset : open.values()) close(onset);
		boolean any = !open.isEmpty();
		open.clear();
		for (Onset onset : unresolved) {
			boolean truncated = onset.response == null && gameTime - onset.atTick < RESPONSE_WINDOW_TICKS;
			if (onset.response == null) onset.response = "none";
			rows.add(onsetRow(onset, truncated));
		}
		unresolved.clear();
		if (any) {
			// A death or stop ends the threat at once.
			spanEndTick = Math.max(spanEndTick, gameTime);
			spanEndMs = Math.max(spanEndMs, epochMs);
			clear(gameTime, epochMs, cause);
		}
	}

	private void clear(long gameTime, long epochMs, String cause) {
		if (spanStartTick < 0L) return;
		JsonObject row = header("clear", gameTime, epochMs);
		row.addProperty("rules", RULES);
		row.addProperty("startAtMs", spanStartMs);
		row.addProperty("startGameTime", spanStartTick);
		row.addProperty("endAtMs", spanEndMs);
		row.addProperty("endGameTime", spanEndTick);
		row.addProperty("threatTicks", Math.max(0L, spanEndTick - spanStartTick));
		row.addProperty("onsets", spanOnsets);
		row.addProperty("cause", cause);
		rows.add(row);
		spanStartTick = -1L;
		spanEndTick = 0L;
		spanEndMs = 0L;
		spanOnsets = 0;
	}

	private JsonObject header(String type, long gameTime, long epochMs) {
		JsonObject row = new JsonObject();
		row.addProperty("type", type);
		row.addProperty("schema", SCHEMA);
		row.addProperty("agentId", agentId);
		row.addProperty("atMs", epochMs);
		row.addProperty("gameTime", gameTime);
		return row;
	}

	JsonObject onsetRow(Onset onset, boolean truncated) {
		JsonObject row = header("onset", onset.atTick, onset.atMs);
		row.addProperty("rules", RULES);
		row.addProperty("onset", onset.onset);
		row.addProperty("key", onset.key);
		row.addProperty("kind", onset.kind);
		row.addProperty("sourceType", onset.sourceType);
		row.addProperty("entityId", onset.entityId);
		row.addProperty("distance", round(onset.distance));
		row.addProperty("action", onset.active == null ? null : onset.active.actionType());
		row.addProperty("actionId", onset.active == null ? null : onset.active.actionId());
		row.addProperty("actionIssuer", onset.active == null ? null : onset.active.issuer());
		row.addProperty("response", onset.response);
		row.addProperty("latencyTicks", onset.responseTick < 0L ? null : Math.max(0L, onset.responseTick - onset.atTick));
		row.addProperty("responseActionId", onset.responseActionId);
		row.addProperty("responseIssuer", onset.responseIssuer);
		row.addProperty("truncated", truncated);
		return row;
	}

	JsonObject damageRow(Hit hit, long gameTime, long epochMs) {
		JsonObject row = header("damage", gameTime, epochMs);
		row.addProperty("kind", hit.kind());
		row.addProperty("damageType", hit.damageType());
		row.addProperty("attacker", hit.attacker());
		row.addProperty("attackerId", hit.attackerId());
		row.addProperty("amount", hit.amount() == null ? null : round(hit.amount()));
		row.addProperty("taken", hit.taken() == null ? null : round(hit.taken()));
		row.addProperty("blocked", hit.blocked());
		boolean paired = hit.healthBefore() != null && hit.absorptionBefore() != null;
		row.addProperty("paired", paired);
		row.addProperty("healthBefore", paired ? round(hit.healthBefore()) : null);
		row.addProperty("absorptionBefore", paired ? round(hit.absorptionBefore()) : null);
		row.addProperty("healthAfter", round(hit.healthAfter()));
		row.addProperty("absorptionAfter", round(hit.absorptionAfter()));
		row.addProperty("absorbed", paired ? round(Math.max(0.0D, hit.absorptionBefore() - hit.absorptionAfter())) : null);
		row.addProperty("healthDrop", paired ? round(Math.max(0.0D, hit.healthBefore() - hit.healthAfter())) : null);
		row.addProperty("lethal", hit.lethal());
		// Schema 2: what the body was doing and how it stood when hit. The action is the one running when the hit landed (or,
		// without that read, the last one this log saw); a null action means none ran. Null guard and exposure fields are
		// unknown, never "none".
		Command action = hit.action();
		row.addProperty("action", action == null ? null : action.actionType());
		row.addProperty("actionId", action == null ? null : action.actionId());
		row.addProperty("actionIssuer", action == null ? null : action.issuer());
		row.addProperty("firingRule", hit.firingRule());
		Guard guard = hit.guard();
		row.addProperty("shieldHand", guard == null ? null : guard.shieldHand());
		row.addProperty("blocking", guard == null ? null : Boolean.valueOf(guard.blocking()));
		Exposure exposure = hit.exposure();
		Double facing = exposure == null ? null : exposure.facingErrorDeg();
		Double distance = exposure == null ? null : exposure.attackerDistance();
		row.addProperty("facingErrorDeg", facing == null ? null : Double.valueOf(round(facing)));
		row.addProperty("attackerDistance", distance == null ? null : Double.valueOf(round(distance)));
		row.addProperty("light", exposure == null ? null : exposure.light());
		return row;
	}

	/**
	 * Horizontal angle in degrees (0 to 180) between a look direction and the offset to a hit's source, the plane a
	 * shield's block check uses ({@code ProjectilePerception.shieldBlocks}: a raised shield stops a hit under 90). The
	 * Watcher passes the look direction from the body's yaw. Null when either has no horizontal length (a source straight
	 * above or below).
	 */
	static Double facingErrorDeg(double lookX, double lookZ, double offsetX, double offsetZ) {
		double look = Math.hypot(lookX, lookZ), offset = Math.hypot(offsetX, offsetZ);
		if (look < 1.0E-6D || offset < 1.0E-6D) return null;
		double cos = (lookX * offsetX + lookZ * offsetZ) / (look * offset);
		return Math.toDegrees(Math.acos(Math.max(-1.0D, Math.min(1.0D, cos))));
	}

	JsonObject firingRow(ReflexScheduler.Event event, long tickOffset, long gameTime, long epochMs) {
		JsonObject row = header("firing", gameTime, epochMs);
		row.addProperty("rule", event.ruleId());
		row.addProperty("seq", event.sequence());
		row.addProperty("outcome", event.outcome().wire());
		row.addProperty("detail", event.detail());
		long start = event.endTick() - event.durationTicks();
		row.addProperty("startTick", start);
		row.addProperty("endTick", event.endTick());
		row.addProperty("startGameTime", start + tickOffset);
		row.addProperty("endGameTime", event.endTick() + tickOffset);
		row.addProperty("durationTicks", event.durationTicks());
		return row;
	}

	JsonObject eventRow(ReflexScheduler.Event event, long gameTime, long epochMs) {
		JsonObject row = header("reflex_event", gameTime, epochMs);
		String kind = switch (event.outcome()) {
			case DISABLED -> "disabled";
			case EXPIRED -> "expired";
			case YIELDED -> event.detail().startsWith("held back") ? "held_back" : "yielded";
			default -> event.outcome().wire();
		};
		row.addProperty("event", kind);
		row.addProperty("rule", event.ruleId());
		row.addProperty("seq", event.sequence());
		row.addProperty("outcome", event.outcome().wire());
		row.addProperty("detail", event.detail());
		row.addProperty("endTick", event.endTick());
		return row;
	}

	private static double round(double value) {
		return Math.round(value * 100.0D) / 100.0D;
	}
}
