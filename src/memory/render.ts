// src/memory/render.ts
import type { MemoryHit } from "./types.js";

/** Render recalled hits as a prompt block. Empty hits → "" (caller omits).
 *  Compact: title + first 200 chars of content per hit. */
export function renderMemoryBlock(hits: MemoryHit[]): string {
  if (!hits.length) return "";
  const lines = ["Relevant past decisions:"];
  for (const h of hits) {
    const body = h.content.replace(/\s+/g, " ").slice(0, 200).trim();
    lines.push(`- ${h.id} — ${h.title}${body ? `: ${body}` : ""}`);
  }
  lines.push("");
  return lines.join("\n");
}
