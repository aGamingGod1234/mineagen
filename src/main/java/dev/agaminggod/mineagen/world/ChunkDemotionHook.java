package dev.agaminggod.mineagen.world;

/**
 * Marks a chunk holder whose drops below full status are reported to far sight (ChunkHolderDemotionMixin), so far
 * sight can tell a running server, which reports them, from a verification double, which does not.
 */
public interface ChunkDemotionHook {
}
