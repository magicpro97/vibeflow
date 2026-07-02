import type { Database } from "bun:sqlite";
// src/memory/builtin.ts
import { existsSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { openMemoryDb, searchEntries, upsertEntries } from "./index-db.js";
import { parseDecisions } from "./parse-decisions.js";
import type { MemoryHit, MemoryProvider, MemoryTier } from "./types.js";

export interface BuiltinInject {
  readDecisions?: () => string | null;
  mtime?: () => number | null;
  dbPath?: string;
}

const DECISIONS_REL = "knowledge/decisions.md";

export class BuiltinMemoryProvider implements MemoryProvider {
  private db: Database | null = null;
  private indexedMtime: number | null = null;
  private readDecisions: () => string | null;
  private mtime: () => number | null;
  private dbPath: string;

  constructor(ctxDir: string, inject: BuiltinInject = {}) {
    const path = join(ctxDir, DECISIONS_REL);
    this.readDecisions =
      inject.readDecisions ?? (() => (existsSync(path) ? readFileSync(path, "utf8") : null));
    this.mtime = inject.mtime ?? (() => (existsSync(path) ? statSync(path).mtimeMs : null));
    this.dbPath = inject.dbPath ?? join(ctxDir, "knowledge", "memory.db");
  }

  private ensureIndexed(): boolean {
    const mt = this.mtime();
    if (mt === null) return false;
    if (this.db && this.indexedMtime === mt) return true;
    const raw = this.readDecisions();
    if (raw === null) return false;
    try {
      if (!this.db) this.db = openMemoryDb(this.dbPath);
      else this.db.run("DELETE FROM mem");
      upsertEntries(this.db, parseDecisions(raw));
      this.indexedMtime = mt;
      return true;
    } catch {
      return false;
    }
  }

  recall(query: string, opts?: { limit?: number; tier?: MemoryTier }): MemoryHit[] {
    if (!this.ensureIndexed() || !this.db) return [];
    const hits = searchEntries(this.db, query, opts?.limit ?? 3);
    return opts?.tier === "titles" ? hits.map((h) => ({ ...h, content: "" })) : hits;
  }
}
