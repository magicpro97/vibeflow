// src/memory/provider.ts
import type { MemoryMode } from "../settings.js";
import { BuiltinMemoryProvider } from "./builtin.js";
import { ClaudeMemProvider } from "./claude-mem.js";
import type { MemoryProvider } from "./types.js";

/** Resolve active memory provider from MemoryMode. false → null (off). */
export function resolveMemoryProvider(mode: MemoryMode, ctxDir: string): MemoryProvider | null {
  if (mode === "builtin") return new BuiltinMemoryProvider(ctxDir);
  if (mode === "claude-mem") return new ClaudeMemProvider();
  return null;
}
