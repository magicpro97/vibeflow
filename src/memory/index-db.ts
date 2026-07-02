// src/memory/index-db.ts
//
// bun:sqlite FTS5 index for memory recall. Zero new deps — bun:sqlite is built-in.
// All functions are best-effort: callers catch externally; these never throw.

import { Database } from "bun:sqlite";

// ponytail: import from ./types.js after Task 2 merges
export interface MemoryHit {
  id: string;
  title: string;
  content: string;
  score: number;
}

export interface RawEntry {
  id: string;
  title: string;
  content: string;
}

/** Open + migrate the FTS5-backed memory DB. `path` = file path or ":memory:". */
export function openMemoryDb(path: string): Database {
  const db = new Database(path);
  db.run("PRAGMA journal_mode = WAL");
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS mem USING fts5(
    id UNINDEXED, title, content,
    tokenize='porter unicode61 remove_diacritics 2'
  )`);
  return db;
}

/** Upsert entries by id: delete-then-insert (FTS5 has no UNIQUE — keep simple+correct). */
export function upsertEntries(db: Database, entries: RawEntry[]): void {
  const del = db.query("DELETE FROM mem WHERE id = ?");
  const ins = db.query("INSERT INTO mem(id, title, content) VALUES (?, ?, ?)");
  const tx = db.transaction((es: RawEntry[]) => {
    for (const e of es) {
      del.run(e.id);
      ins.run(e.id, e.title, e.content);
    }
  });
  tx(entries);
}

/** BM25 search. Returns hits sorted best-first (rank most-negative = best).
 *  score normalized to 0..1 via 1/(1+|rank|). Empty/whitespace → [].
 *  Malformed MATCH query → [] (best-effort). */
export function searchEntries(db: Database, query: string, limit: number): MemoryHit[] {
  const q = query.trim();
  if (!q) return [];
  // Quote each term to avoid FTS5 syntax errors on special chars.
  const safe = q
    .split(/\s+/)
    .map((t) => `"${t.replace(/"/g, "")}"`)
    .join(" OR ");
  try {
    const rows = db
      .query("SELECT id, title, content, rank FROM mem WHERE mem MATCH ? ORDER BY rank LIMIT ?")
      .all(safe, limit) as Array<{ id: string; title: string; content: string; rank: number }>;
    return rows.map((r) => ({
      id: r.id,
      title: r.title,
      content: r.content,
      score: 1 / (1 + Math.abs(r.rank)),
    }));
  } catch {
    return [];
  }
}
