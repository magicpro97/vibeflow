// src/memory/types.ts
//
// MemoryProvider seam types. Shared by builtin (bun:sqlite FTS5)
// and claude-mem providers. All types are pure — no logic here.

/** Recall output fidelity tier. Controls how much content is returned per hit. */
export type MemoryTier = "titles" | "compact" | "full";

/** One recalled memory entry (a past decision or fact). */
export interface MemoryHit {
  /** ADR-NNN or stable hash identifier. */
  id: string;
  /** Short title of the entry. */
  title: string;
  /** Body content (trimmed by tier). Empty string when tier="titles". */
  content: string;
  /** BM25 rank normalized to 0..1. Higher = better match. */
  score: number;
}

/** Recall past knowledge relevant to a task.
 *  Implementations must be best-effort: never throw, return [] on any error. */
export interface MemoryProvider {
  recall(query: string, opts?: { limit?: number; tier?: MemoryTier }): MemoryHit[];
}
