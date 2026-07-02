// src/memory/parse-decisions.ts
import type { RawEntry } from "./index-db.js";

const ENTRY_RE = /^## \[[^\]]+\] (ADR-\d{3}) \| (.+)$/;

export function parseDecisions(raw: string): RawEntry[] {
  const lines = raw.split(/\r?\n/);
  const entries: RawEntry[] = [];
  let cur: { id: string; title: string; body: string[] } | null = null;
  const flush = () => {
    if (cur) entries.push({ id: cur.id, title: cur.title, content: cur.body.join("\n").trim() });
  };
  for (const line of lines) {
    const m = line.match(ENTRY_RE);
    if (m) {
      flush();
      cur = { id: m[1] ?? "", title: (m[2] ?? "").trim(), body: [] };
    } else if (cur) cur.body.push(line);
  }
  flush();
  return entries;
}
