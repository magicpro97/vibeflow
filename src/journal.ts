import { existsSync } from "node:fs";
import { appendFileSafe, indexPath, journalPath, writeFileSafe } from "./core.js";

export type JournalOp = "dispatch" | "verify" | "note";

/** Build one append-ready journal entry. Date is runtime (UTC YYYY-MM-DD), never hardcoded.
 *  Shape (greppable via `grep "^## \[" log.md`):
 *    \n## [YYYY-MM-DD] <op> | <title>\n
 *    <each line of `lines`>\n
 */
export function formatEntry(op: JournalOp, title: string, lines?: string[]): string {
  const date = new Date().toISOString().slice(0, 10);
  const safeTitle = title.replace(/[\r\n]+/g, " ").trim();
  const header = `## [${date}] ${op} | ${safeTitle}`;
  const body = lines && lines.length > 0 ? `${lines.join("\n")}\n` : "";
  return `\n${header}\n${body}`;
}

/** Append an entry to .viteflow/knowledge/log.md (creates file/dir if absent). */
export function appendJournal(
  base: string | undefined,
  op: JournalOp,
  title: string,
  lines?: string[],
): void {
  appendFileSafe(journalPath(base), formatEntry(op, title, lines));
}

/** Create .viteflow/knowledge/index.md with a minimal catalog header if absent. Idempotent —
 *  never overwrites existing content. Returns true if it created the file. */
export function ensureIndex(base?: string): boolean {
  const p = indexPath(base);
  if (existsSync(p)) return false;
  writeFileSafe(p, "# Knowledge Index\n\nCatalog of knowledge pages — one entry per line.\n");
  return true;
}
