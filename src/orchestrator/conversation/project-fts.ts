/**
 * bun:sqlite FTS5 index over project descriptors and recent project chat — the retrieval
 * tier of the project classifier. Zero new deps: `bun:sqlite` is built in.
 *
 * Scoring is IDF-weighted term coverage, not raw BM25. BM25 magnitudes drift with corpus size
 * and row length, so a threshold on them cannot mean the same thing for a 3-project registry
 * and a 300-project one. Coverage is normalized to 0–100 — "how much of the query's
 * information did this project account for" — which keeps `FTS_MIN_SCORE` meaningful at every
 * registry size, and makes `top − second` a real margin rather than a corpus artifact.
 * A descriptor row outranks a chat row for the same term: registry text is authored, chat is
 * incidental evidence.
 *
 * Every function is best-effort. A malformed `MATCH`, a closed handle, or an empty query
 * yields `[]` instead of throwing, so classification never fails a message turn.
 *
 * ponytail: the index is in-memory, rebuilt per process. Persist it (and reindex on registry
 * revision change) when classification latency over a large registry starts to matter.
 */
import type { Database } from "bun:sqlite";
import type { ClassifierProject } from "./project-classifier.js";

/** Lazy `require` keeps the Bun-only builtin out of the Node-targeted dist bundle. */
function loadSqlite(): { Database: new (path: string) => Database } {
  // Cast of a runtime-resolved builtin; its shape is the documented `bun:sqlite` module surface.
  return require("bun:sqlite") as { Database: new (path: string) => Database };
}

/** Chat rows kept per project; older turns stop influencing a classification. */
export const FTS_RECENT_CHAT_LIMIT = 20;
/** Query terms considered per classification, and the shortest term indexed. */
export const FTS_MAX_QUERY_TERMS = 32;
export const FTS_MIN_TERM_LENGTH = 2;

const KIND_DESCRIPTOR = "descriptor";
const KIND_CHAT = "chat";
/** Row weight by kind: a descriptor hit is authored evidence, a chat hit is incidental. */
const KIND_WEIGHT: Record<string, number> = { [KIND_DESCRIPTOR]: 1, [KIND_CHAT]: 0.6 };

export interface ProjectScore {
  readonly project_id: string;
  /** 0–100 IDF-weighted coverage of the query's terms. */
  readonly score: number;
}

/** Open (creating if needed) the FTS5 project index. `path` = a file path or `":memory:"`. */
export function openProjectIndex(path: string): Database {
  const { Database: Sqlite } = loadSqlite();
  const db = new Sqlite(path);
  db.run(`CREATE VIRTUAL TABLE IF NOT EXISTS project_fts USING fts5(
    project_id UNINDEXED, kind UNINDEXED, body,
    tokenize='porter unicode61 remove_diacritics 2'
  )`);
  return db;
}

/** Replace every project descriptor row. Descriptors are derived state — never appended. */
export function indexProjectDescriptors(
  db: Database,
  projects: readonly ClassifierProject[],
): void {
  const insert = db.query<never, [string, string, string]>(
    "INSERT INTO project_fts(project_id, kind, body) VALUES (?, ?, ?)",
  );
  const clear = db.query<never, [string]>("DELETE FROM project_fts WHERE kind = ?");
  const index = db.transaction((rows: readonly ClassifierProject[]) => {
    clear.run(KIND_DESCRIPTOR);
    for (const project of rows) {
      const parts = [project.name ?? project.id, project.goal, project.context].filter(
        (part): part is string => typeof part === "string" && part.trim() !== "",
      );
      insert.run(project.id, KIND_DESCRIPTOR, parts.join(" "));
    }
  });
  index(projects);
}

/**
 * Append one chat row for a project, evicting the oldest beyond {@link FTS_RECENT_CHAT_LIMIT}.
 * `rowid` is arrival order, so no timestamp column is needed.
 */
export function indexProjectChat(db: Database, projectId: string, text: string): void {
  const body = text.trim();
  if (body === "") return;
  db.query<never, [string, string, string]>(
    "INSERT INTO project_fts(project_id, kind, body) VALUES (?, ?, ?)",
  ).run(projectId, KIND_CHAT, body);
  db.query<never, [string, string, string, string]>(`DELETE FROM project_fts
     WHERE kind = ? AND project_id = ?
       AND rowid NOT IN (SELECT rowid FROM project_fts WHERE kind = ? AND project_id = ?
         ORDER BY rowid DESC LIMIT ${FTS_RECENT_CHAT_LIMIT})`).run(
    KIND_CHAT,
    projectId,
    KIND_CHAT,
    projectId,
  );
}

/**
 * Score every project against a message, best-first. `[]` when the message has no usable term,
 * the index is empty, or the query/index is unusable (best-effort — never throws).
 */
export function searchProjectScores(db: Database, query: string): ProjectScore[] {
  const terms: string[] = [];
  for (const raw of normalizeText(query).split(/[^\p{L}\p{N}]+/u)) {
    if (raw.length < FTS_MIN_TERM_LENGTH || terms.includes(raw)) continue;
    terms.push(raw);
    if (terms.length >= FTS_MAX_QUERY_TERMS) break;
  }
  if (terms.length === 0) return [];
  try {
    const counted = db
      .query<{ indexed: number }, []>("SELECT count(*) AS indexed FROM project_fts")
      .get();
    const total = counted?.indexed ?? 0;
    if (total === 0) return [];
    const select = db.query<{ project_id: string; kind: string }, [string]>(
      "SELECT project_id, kind FROM project_fts WHERE project_fts MATCH ?",
    );
    const strengths = new Map<string, number>();
    let idfTotal = 0;
    for (const term of terms) {
      const rows = select.all(`"${term}"`);
      const idf = Math.log(1 + total / Math.max(1, rows.length));
      idfTotal += idf;
      // A term counts once per project at its best row weight: a project holding both a
      // descriptor and a chat hit for one term is still one project that mentions it.
      const best = new Map<string, number>();
      for (const row of rows)
        best.set(
          row.project_id,
          Math.max(best.get(row.project_id) ?? 0, KIND_WEIGHT[row.kind] ?? 0),
        );
      for (const [projectId, weight] of best)
        strengths.set(projectId, (strengths.get(projectId) ?? 0) + idf * weight);
    }
    // No clamp: each term contributes at most its own idf (a term counts once per project, at
    // its best row weight ≤ 1), so the total can never exceed `idfTotal` and the score ≤ 100.
    return [...strengths]
      .map(([project_id, strength]) => ({
        project_id,
        score: (100 * strength) / idfTotal,
      }))
      .sort(
        (left, right) =>
          right.score - left.score || left.project_id.localeCompare(right.project_id),
      );
  } catch {
    return [];
  }
}

/** Lowercase + strip diacritics, mirroring the FTS5 tokenizer so a query term tokenizes to
 *  itself inside a quoted `MATCH` string. */
function normalizeText(value: string): string {
  return value
    .toLowerCase()
    .normalize("NFD")
    .replace(/\p{M}+/gu, "");
}
