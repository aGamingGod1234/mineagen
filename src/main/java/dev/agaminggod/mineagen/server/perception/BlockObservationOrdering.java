package dev.agaminggod.mineagen.server.perception;

import it.unimi.dsi.fastutil.objects.Object2IntOpenHashMap;
import java.util.ArrayList;
import java.util.Comparator;
import java.util.List;
import java.util.Objects;
import java.util.function.Predicate;

public final class BlockObservationOrdering {
	private static final Comparator<Candidate> ORDER = Comparator
			.comparingLong(Candidate::distanceSquared)
			.thenComparingInt(candidate -> Math.abs(candidate.y()))
			.thenComparingInt(Candidate::y)
			.thenComparingInt(Candidate::x)
			.thenComparingInt(Candidate::z)
			.thenComparing(Candidate::blockId);

	private BlockObservationOrdering() {
	}

	public static List<Candidate> select(List<Candidate> candidates, int maximumEntries, int maximumPerBlockType) {
		return select(candidates, maximumEntries, maximumPerBlockType, candidate -> true);
	}

	public static List<Candidate> select(
			List<Candidate> candidates,
			int maximumEntries,
			int maximumPerBlockType,
			Predicate<Candidate> admissible
	) {
		return selectOrdered(ordered(candidates), maximumEntries, maximumPerBlockType, admissible);
	}

	static List<Candidate> selectOrdered(
			List<Candidate> ordered,
			int maximumEntries,
			int maximumPerBlockType,
			Predicate<Candidate> admissible
	) {
		return selectOrderedWithVisibilityBudget(
				ordered, maximumEntries, maximumPerBlockType,
				Integer.MAX_VALUE, Integer.MAX_VALUE, admissible);
	}

	static List<Candidate> selectOrderedWithVisibilityBudget(
			List<Candidate> ordered,
			int maximumEntries,
			int maximumPerBlockType,
			int maximumVisibilityChecks,
			int maximumVisibilityChecksPerBlockType,
			Predicate<Candidate> admissible
	) {
		return selectOrderedWithVisibilityBudget(
				ordered, maximumEntries, maximumPerBlockType,
				maximumVisibilityChecks, maximumVisibilityChecksPerBlockType,
				candidate -> true, admissible);
	}

	static List<Candidate> selectOrderedWithVisibilityBudget(
			List<Candidate> ordered,
			int maximumEntries,
			int maximumPerBlockType,
			int maximumVisibilityChecks,
			int maximumVisibilityChecksPerBlockType,
			Predicate<Candidate> eligibleWithoutVisibilityCheck,
			Predicate<Candidate> admissible
	) {
		Objects.requireNonNull(ordered, "ordered must not be null");
		Objects.requireNonNull(eligibleWithoutVisibilityCheck, "eligibleWithoutVisibilityCheck must not be null");
		Objects.requireNonNull(admissible, "admissible must not be null");
		if (maximumEntries <= 0 || maximumPerBlockType <= 0
				|| maximumVisibilityChecks <= 0 || maximumVisibilityChecksPerBlockType <= 0) {
			throw new IllegalArgumentException("observation limits must be positive");
		}
		ArrayList<Candidate> selected = new ArrayList<>(Math.min(maximumEntries, ordered.size()));
		// Point lookups only, never iterated; an absent key reads 0 (the default return value), as getOrDefault(key, 0) did.
		Object2IntOpenHashMap<String> counts = new Object2IntOpenHashMap<>();
		Object2IntOpenHashMap<String> visibilityChecksByType = new Object2IntOpenHashMap<>();
		int visibilityChecks = 0;
		for (Candidate candidate : ordered) {
			int count = counts.getInt(candidate.blockId());
			if (count >= maximumPerBlockType) continue;
			if (!eligibleWithoutVisibilityCheck.test(candidate)) continue;
			if (visibilityChecks >= maximumVisibilityChecks) break;
			int typeChecks = visibilityChecksByType.getInt(candidate.blockId());
			if (typeChecks >= maximumVisibilityChecksPerBlockType) continue;
			visibilityChecks++;
			visibilityChecksByType.put(candidate.blockId(), typeChecks + 1);
			if (!admissible.test(candidate)) continue;
			selected.add(candidate);
			counts.put(candidate.blockId(), count + 1);
			if (selected.size() >= maximumEntries) break;
		}
		return List.copyOf(selected);
	}

	/**
	 * For every cell within {@code radius} horizontally and {@code verticalRadius} vertically, at index
	 * {@code ((y + verticalRadius) * width + (x + radius)) * width + (z + radius)} with {@code width = 2 * radius + 1},
	 * its position in the order {@link #ordered} applies. Cells are distinct, so that order never reaches the block id.
	 */
	static int[] scanRanks(int radius, int verticalRadius) {
		int width = 2 * radius + 1;
		ArrayList<Candidate> cells = new ArrayList<>();
		for (int y = -verticalRadius; y <= verticalRadius; y++) {
			for (int x = -radius; x <= radius; x++) {
				for (int z = -radius; z <= radius; z++) cells.add(new Candidate(x, y, z, "minecraft:air"));
			}
		}
		cells.sort(ORDER);
		int[] ranks = new int[cells.size()];
		for (int rank = 0; rank < cells.size(); rank++) {
			Candidate cell = cells.get(rank);
			ranks[((cell.y() + verticalRadius) * width + (cell.x() + radius)) * width + (cell.z() + radius)] = rank;
		}
		return ranks;
	}

	/**
	 * The list {@link #ordered} returns, without a sort, for candidates at distinct cells inside the box
	 * {@code ranks} was built for by {@link #scanRanks}.
	 */
	static List<Candidate> orderedByRank(List<Candidate> candidates, int[] ranks, int radius, int verticalRadius) {
		int width = 2 * radius + 1;
		Candidate[] slots = new Candidate[ranks.length];
		for (Candidate candidate : candidates) {
			// The rank table covers one candidate per cell of the box; anything else gets the full sort.
			if (Math.abs(candidate.x()) > radius || Math.abs(candidate.y()) > verticalRadius || Math.abs(candidate.z()) > radius) return ordered(candidates);
			int slot = ranks[((candidate.y() + verticalRadius) * width + (candidate.x() + radius)) * width + (candidate.z() + radius)];
			if (slots[slot] != null) return ordered(candidates);
			slots[slot] = candidate;
		}
		ArrayList<Candidate> ordered = new ArrayList<>(candidates.size());
		for (Candidate candidate : slots) if (candidate != null) ordered.add(candidate);
		return List.copyOf(ordered);
	}

	public static List<Candidate> ordered(List<Candidate> candidates) {
		Objects.requireNonNull(candidates, "candidates must not be null");
		ArrayList<Candidate> ordered = new ArrayList<>(candidates);
		ordered.sort(ORDER);
		return List.copyOf(ordered);
	}

	public record Candidate(int x, int y, int z, String blockId) {
		public Candidate {
			blockId = Objects.requireNonNull(blockId, "blockId must not be null");
			if (blockId.isBlank()) throw new IllegalArgumentException("blockId must not be blank");
		}

		private long distanceSquared() {
			long dx = x;
			long dy = y;
			long dz = z;
			return dx * dx + dy * dy + dz * dz;
		}
	}
}
