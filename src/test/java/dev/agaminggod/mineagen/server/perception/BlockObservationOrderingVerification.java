package dev.agaminggod.mineagen.server.perception;

import java.util.ArrayList;
import java.util.List;

public final class BlockObservationOrderingVerification {
	private BlockObservationOrderingVerification() {
	}

	public static int verify() {
		ArrayList<BlockObservationOrdering.Candidate> candidates = new ArrayList<>();
		for (int x = -4; x <= 4; x++) {
			candidates.add(candidate(x, -1, 0, "minecraft:grass_block"));
		}
		candidates.add(candidate(2, 0, 0, "minecraft:crafting_table"));
		candidates.add(candidate(4, 1, 0, "minecraft:oak_log"));
		candidates.add(candidate(-5, 0, 0, "minecraft:coal_ore"));

		List<BlockObservationOrdering.Candidate> selected =
				BlockObservationOrdering.select(candidates, 6, 2);

		assertEquals(5, selected.size(), "selection respects total and per-type limits");
		assertEquals(
				2L,
				selected.stream().filter(candidate -> candidate.blockId().equals("minecraft:grass_block")).count(),
				"repetitive terrain cannot consume the complete observation"
		);
		assertTrue(
				selected.stream().anyMatch(candidate -> candidate.blockId().equals("minecraft:oak_log")),
				"nearby tree remains observable after terrain de-duplication"
		);
		assertTrue(
				selected.stream().anyMatch(candidate -> candidate.blockId().equals("minecraft:coal_ore")),
				"nearby ore remains observable after terrain de-duplication"
		);
		assertEquals(
				candidate(0, -1, 0, "minecraft:grass_block"),
				selected.getFirst(),
				"selection is nearest-first"
		);
		assertEquals(
				selected,
				BlockObservationOrdering.select(candidates.reversed(), 6, 2),
				"selection is deterministic regardless of scan order"
		);
		// The local scan orders by a precomputed rank instead of a sort: same list for any subset of distinct cells.
		int[] ranks = BlockObservationOrdering.scanRanks(6, 3);
		java.util.Random random = new java.util.Random(7);
		String[] ids = {"minecraft:stone", "minecraft:dirt", "minecraft:oak_log", "minecraft:water"};
		for (int trial = 0; trial < 200; trial++) {
			ArrayList<BlockObservationOrdering.Candidate> scan = new ArrayList<>();
			for (int y = -3; y <= 3; y++) for (int x = -6; x <= 6; x++) for (int z = -6; z <= 6; z++) {
				if (random.nextInt(4) != 0) scan.add(candidate(x, y, z, ids[random.nextInt(ids.length)]));
			}
			if (!BlockObservationOrdering.ordered(scan).equals(BlockObservationOrdering.orderedByRank(scan, ranks, 6, 3))) {
				throw new AssertionError("ranked scan order matches the sorted order (trial " + trial + ")");
			}
		}
		// Two candidates in one cell, or one outside the box, fall back to the full sort.
		List<BlockObservationOrdering.Candidate> twice = List.of(candidate(1, 0, 0, "minecraft:stone"), candidate(1, 0, 0, "minecraft:dirt"), candidate(0, 0, 0, "minecraft:dirt"));
		assertEquals(BlockObservationOrdering.ordered(twice), BlockObservationOrdering.orderedByRank(twice, ranks, 6, 3), "a shared cell keeps both candidates in sorted order");
		List<BlockObservationOrdering.Candidate> outside = List.of(candidate(7, 0, 0, "minecraft:stone"), candidate(-6, 0, 1, "minecraft:dirt"), candidate(0, 4, 0, "minecraft:dirt"), candidate(0, 0, 0, "minecraft:dirt"));
		assertEquals(BlockObservationOrdering.ordered(outside), BlockObservationOrdering.orderedByRank(outside, ranks, 6, 3), "a cell outside the box gets the sorted order");
		return 9;
	}

	private static BlockObservationOrdering.Candidate candidate(int x, int y, int z, String blockId) {
		return new BlockObservationOrdering.Candidate(x, y, z, blockId);
	}

	private static void assertEquals(Object expected, Object actual, String label) {
		if (!expected.equals(actual)) {
			throw new AssertionError(label + ": expected <" + expected + "> but was <" + actual + ">");
		}
	}

	private static void assertTrue(boolean condition, String label) {
		if (!condition) {
			throw new AssertionError(label);
		}
	}
}
