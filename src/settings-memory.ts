/** Memory recall mode. false = off (default). "builtin" = bun:sqlite FTS5.
 *  "claude-mem" = opt-in external claude-mem CLI. Legacy boolean true → "builtin". */
export type MemoryMode = false | "builtin" | "claude-mem";

/** Coerce stored memory field to MemoryMode. Legacy boolean true→"builtin". */
export function coerceMemory(v: unknown): MemoryMode {
  if (v === true) return "builtin";
  if (v === "builtin" || v === "claude-mem") return v;
  return false;
}
