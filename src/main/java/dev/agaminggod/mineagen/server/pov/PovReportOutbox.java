package dev.agaminggod.mineagen.server.pov;

import com.mojang.serialization.Codec;
import com.mojang.serialization.codecs.RecordCodecBuilder;
import dev.agaminggod.mineagen.agent.AgentId;
import dev.agaminggod.mineagen.server.conversation.ConversationEvent;
import java.util.HashSet;
import java.util.LinkedHashMap;
import java.util.List;
import java.util.Map;
import java.util.Objects;
import java.util.UUID;
import java.util.function.BiConsumer;
import java.util.function.Predicate;
import net.minecraft.resources.Identifier;
import net.minecraft.server.MinecraftServer;
import net.minecraft.util.datafix.DataFixTypes;
import net.minecraft.world.level.saveddata.SavedData;
import net.minecraft.world.level.saveddata.SavedDataType;

/** Ordered, world-scoped takeover reports. Delivery means admission to the coordinator bridge. */
public final class PovReportOutbox extends SavedData {
	static final int MAX_REPORTS = 256;
	static final long RETRY_WINDOW_MS = 5L * 60L * 1000L;
	private static final Codec<UUID> UUID_CODEC = Codec.STRING.xmap(UUID::fromString, UUID::toString);
	static final Codec<Report> REPORT_CODEC = RecordCodecBuilder.create(instance -> instance.group(
			UUID_CODEC.fieldOf("delivery_id").forGetter(Report::deliveryId),
			UUID_CODEC.fieldOf("operator_id").forGetter(Report::operatorId),
			Codec.string(0, 128).fieldOf("operator_name").forGetter(Report::operatorName),
			Codec.STRING.xmap(AgentId::parse, AgentId::toString).fieldOf("agent_id").forGetter(Report::agentId),
			Codec.string(1, 128).fieldOf("dimension").forGetter(Report::dimension),
			Codec.string(1, ConversationEvent.MAX_TEXT_CODE_POINTS * 2).fieldOf("text").forGetter(Report::text),
			Codec.LONG.fieldOf("expires_at_ms").forGetter(Report::expiresAtEpochMs)
	).apply(instance, Report::new));
	private static final Codec<PovReportOutbox> CODEC = REPORT_CODEC.listOf(0, MAX_REPORTS)
			.optionalFieldOf("reports", List.of()).codec().xmap(PovReportOutbox::new, PovReportOutbox::reports);
	public static final SavedDataType<PovReportOutbox> TYPE = new SavedDataType<>(
			Identifier.fromNamespaceAndPath("mineagen", "pov_reports"), PovReportOutbox::new,
			CODEC, DataFixTypes.SAVED_DATA_COMMAND_STORAGE);

	public record Report(UUID deliveryId, UUID operatorId, String operatorName, AgentId agentId,
			String dimension, String text, long expiresAtEpochMs) {
		public Report {
			Objects.requireNonNull(deliveryId);
			Objects.requireNonNull(operatorId);
			Objects.requireNonNull(agentId);
			Objects.requireNonNull(operatorName);
			Objects.requireNonNull(dimension);
			Objects.requireNonNull(text);
			if (operatorName.length() > 128 || dimension.isBlank() || dimension.length() > 128
					|| text.isBlank() || text.codePointCount(0, text.length()) > ConversationEvent.MAX_TEXT_CODE_POINTS
					|| expiresAtEpochMs <= 0) throw new IllegalArgumentException("Invalid takeover report");
		}
	}

	enum Outcome { DELIVERED, RETRY, EXPIRED, AGENT_REMOVED, CAPACITY }
	private final Map<UUID, Report> pending = new LinkedHashMap<>();

	public PovReportOutbox() { }

	private PovReportOutbox(List<Report> reports) {
		for (Report report : reports) {
			if (pending.putIfAbsent(report.deliveryId(), report) != null) {
				throw new IllegalArgumentException("Duplicate takeover delivery id");
			}
		}
	}

	public static PovReportOutbox get(MinecraftServer server) {
		return server.overworld().getDataStorage().computeIfAbsent(TYPE);
	}

	List<Report> reports() { return List.copyOf(pending.values()); }
	boolean isEmpty() { return pending.isEmpty(); }

	void enqueue(Report report, BiConsumer<Report, Outcome> observer) {
		if (pending.containsKey(report.deliveryId())) return;
		if (pending.size() == MAX_REPORTS) {
			Report oldest = pending.remove(pending.keySet().iterator().next());
			observer.accept(oldest, Outcome.CAPACITY);
		}
		pending.put(report.deliveryId(), report);
		setDirty();
	}

	void removeAgent(AgentId agentId, BiConsumer<Report, Outcome> observer) {
		for (Report report : reports()) {
			if (report.agentId().equals(agentId)) remove(report, Outcome.AGENT_REMOVED, observer);
		}
	}

	/** A failed earlier report blocks only that agent, not other agents in the outbox. */
	void drain(long nowEpochMs, Predicate<AgentId> exists, Predicate<AgentId> reserved,
			Predicate<Report> sink, BiConsumer<Report, Outcome> observer) {
		var blocked = new HashSet<AgentId>();
		for (Report report : reports()) {
			if (!exists.test(report.agentId())) {
				remove(report, Outcome.AGENT_REMOVED, observer);
			} else if (nowEpochMs > report.expiresAtEpochMs()) {
				remove(report, Outcome.EXPIRED, observer);
			} else if (!blocked.contains(report.agentId()) && !reserved.test(report.agentId())) {
				if (sink.test(report)) remove(report, Outcome.DELIVERED, observer);
				else {
					blocked.add(report.agentId());
					observer.accept(report, Outcome.RETRY);
				}
			}
		}
	}

	private void remove(Report report, Outcome outcome, BiConsumer<Report, Outcome> observer) {
		pending.remove(report.deliveryId());
		setDirty();
		observer.accept(report, outcome);
	}
}
