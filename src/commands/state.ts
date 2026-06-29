// src/commands/state.ts
//
// `vf state <sub>` cluster — the BRIEF SURFACE (issue #184, A0 of the
// orchestrator-first plan). The brief is the durable cross-session memory
// the coordinator consults before any non-trivial action (gh, git push,
// plan changes, merges). A0 ships the surface; A1 (`vf coord` shim) +
// A2-A14 build on it.
//
// size-waiver: #390 — merged from state-frontmatter.ts and state-gate.ts (400-line cap splinters)
// size-waiver: #392 — merged from atomic-write.ts (400-line cap splinter)
// File: .vibeflow/knowledge/coordinator-brief.md (the canonical example
// was authored by the coordinator on 2026-06-20 in the
// orchestrator-first session; see issue #184 for the upstream ACs).
//
// === SCHEMA (issue #184 AC #1) ===
//   The brief is plain Markdown with an OPTIONAL YAML frontmatter:
//     ---
//     last-consult: 2026-06-20T10:30:00Z
//     ---
//     # Coordinator Brief — <project>
//     ## 1. The user's verbatim ask
//     ## 2. Non-negotiables (re-read before any non-trivial action)
//     ## 3. Active plan
//     ## 4. State
//     ## 5. Next action
//     ## 6. Open questions
//   The frontmatter is optional: a brief without `last-consult` has no
//   consult timestamp; `vf state brief --consult` adds one. The 6
//   sections (§1-§6) are the canonical content — order matters for
//   the cross-check.
//
// === BEHAVIOR (issue #184 ACs #2, #3) ===
//   `vf state brief`           → read + print + "what changed since last
//                                 consult" diff (using the brief mtime
//                                 vs. the frontmatter last-consult).
//                                 Exits 1 if no brief file exists.
//   `vf state brief --consult` → same print, AND writes the new mtime
//                                 into the frontmatter so the next
//                                 consult can diff against it.
//   `vf state`                 → top-level usage hint (defers to help).
//
// === STALENESS CONTRACT (issue #184 AC #3) ===
//   The brief's `last-consult` mtime is the single source of truth for
//   "freshness." `vf init --coord` and `vf coord` both refuse when
//   `Date.now() - last-consult > 10 * 60 * 1000` (10 minutes). When
//   the field is missing, the brief is "never consulted" → stale
//   (the same gate applies). When the file is missing, callers see
//   a separate "no brief" message and exit 1.
//
// === TEST SEAMS ===
//   All filesystem reads (statSync / readFileSync / writeFileSync /
//   existsSync) accept an `inject` parameter so unit tests can drive
//   every branch without touching the real .vibeflow/ tree.

import {
  closeSync,
  existsSync,
  fsyncSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { CTX_DIR, type Channel, c, cwd, out } from "./_shared.js";

// ponytail: inlined from state-frontmatter.ts (#390)
/** Parsed brief frontmatter: the body after `--- ... ---` is stripped,
 *  plus the optional `last-consult` timestamp. */
export interface ParsedFrontmatter {
  body: string;
  lastConsult: string | null;
}
export function parseFrontmatter(raw: string): ParsedFrontmatter {
  if (!raw.startsWith("---")) return { body: raw, lastConsult: null };
  const end = raw.indexOf("\n---", 3);
  if (end === -1) return { body: raw, lastConsult: null };
  const header = raw.slice(3, end).trim();
  const rest = raw.slice(end + 4).replace(/^[\r\n]+/, "");
  let lastConsult: string | null = null;
  for (const line of header.split(/\r?\n/)) {
    const m = line.match(/^\s*last-consult:\s*(.+?)\s*$/);
    if (m) lastConsult = m[1] ?? null;
  }
  return { body: rest, lastConsult };
}
export function upsertFrontmatter(raw: string, kv: Record<string, string>): string {
  const entries = Object.entries(kv)
    .map(([k, v]) => `${k}: ${v}`)
    .join("\n");
  if (raw.startsWith("---")) {
    const end = raw.indexOf("\n---", 3);
    if (end === -1) return `---\n${entries}\n---\n${raw}`;
    const header = raw.slice(3, end);
    const rest = raw.slice(end + 4);
    const updated = _upsertKeys(header, kv);
    return `---\n${updated}\n---${rest}`;
  }
  return `---\n${entries}\n---\n\n${raw}`;
}
function _upsertKeys(header: string, kv: Record<string, string>): string {
  const lines = header.split(/\r?\n/);
  for (const [k, v] of Object.entries(kv)) {
    let found = false;
    for (let i = 0; i < lines.length; i++) {
      if ((lines[i] ?? "").match(new RegExp(`^\\s*${k}:\\s*`))) {
        lines[i] = `${k}: ${v}`;
        found = true;
        break;
      }
    }
    if (!found) lines.push(`${k}: ${v}`);
  }
  return lines.filter((l, i, arr) => !(l.trim() === "" && i === arr.length - 1)).join("\n");
}

/** Path to the brief file, relative to the project base. */
export const BRIEF_PATH = `${CTX_DIR}/knowledge/coordinator-brief.md`;

/** Staleness threshold: 10 minutes. Mirrors the AC for `vf init --coord`. */
export const BRIEF_FRESH_MS = 10 * 60 * 1000;

/** Brief file content + parsed frontmatter, as returned by `readBrief`. */
export interface Brief {
  /** Absolute path to the brief file. */
  readonly path: string;
  /** Raw file content (frontmatter + body, verbatim). */
  readonly raw: string;
  /** Body after the frontmatter is stripped (or the whole file if no frontmatter). */
  readonly body: string;
  /** `last-consult` ISO timestamp parsed from frontmatter, or `null` if absent. */
  readonly lastConsult: string | null;
  /** File mtime in ms, exposed so callers don't need a second stat call. */
  readonly mtimeMs: number;
}

/** Sink used by `formatBriefForHuman` for testability (default: `out`). */
export type OutFn = (channel: Channel, ...rawParts: unknown[]) => void;

/** F0 review #1: the 6 canonical brief sections. The order and titles
 *  are the contract — A2-A14 skills diff against them, gate non-trivial
 *  actions on §2, etc. A brief missing any of these is a contract
 *  violation, not a stylistic preference. */
export const BRIEF_SECTIONS = [
  "## 1. The user",
  "## 2. Non-negotiables",
  "## 3. Active plan",
  "## 4. State",
  "## 5. Next action",
  "## 6. Open questions",
] as const;

/** F0 review #1: validate the brief's body has all 6 canonical sections.
 *  Returns the list of missing section titles (empty array = OK).
 *  Cheap: a single pass over the body, no allocation beyond the array. */
export function validateBriefShape(raw: string): { ok: boolean; missing: readonly string[] } {
  const body = raw.startsWith("---")
    ? // strip frontmatter (down to and including the second `---`)
      raw.replace(/^---\n[\s\S]*?\n---\n?/, "")
    : raw;
  const missing: string[] = [];
  for (const heading of BRIEF_SECTIONS) {
    if (!body.includes(heading)) missing.push(heading);
  }
  return { ok: missing.length === 0, missing };
}

/** F0 review #3: atomic write of the brief — see ./atomic-write.ts.
 *  Extracted to keep state.ts under the 400-line cap. Re-exported
 *  via the facade. */

/** Top-level `vf state` dispatcher. */
export function state(
  sub: string | undefined,
  rest: string[],
  flags: Record<string, string | boolean>,
): number {
  if (sub === "brief") {
    return brief(rest, flags);
  }
  out(
    "vf",
    `${c.bold("vf state")} ${c.dim("[brief] [--consult]")}
Read the coordinator brief at ${c.cyan(BRIEF_PATH)}.

${c.bold("Subcommands:")}
  ${c.cyan("brief")}          print the brief + 1-line "what changed since last consult"
  ${c.cyan("brief --consult")} same print + writes the new mtime to .last-consult

${c.bold("Options:")}
  --consult   update the brief's .last-consult mtime before printing

${c.bold("Examples:")}
  vf state brief
  vf state brief --consult`,
  );
  return 2;
}

/** `vf state brief` handler. Refuses on missing file, prints + optionally consults. */
export function brief(
  _args: string[],
  flags: Record<string, string | boolean>,
  inject: {
    existsSync?: (p: string) => boolean;
    statSync?: (p: string) => { mtimeMs: number };
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string) => void;
    now?: () => number;
  } = {},
): number {
  const _exists = inject.existsSync ?? existsSync;
  const _stat = inject.statSync ?? statSync;
  const _read = inject.readFileSync ?? readFileSync;
  const _now = inject.now ?? (() => Date.now());

  const base = cwd();
  const path = join(base, BRIEF_PATH);
  if (!_exists(path)) {
    out("vf", c.red(`no brief at ${BRIEF_PATH}. Run \`vf state brief write\` to create one.`), {
      level: "error",
    });
    return 1;
  }
  const stat = _stat(path);
  const raw = _read(path, "utf8");
  const parsed = parseFrontmatter(raw);
  let mtimeMs = stat.mtimeMs;
  let lastConsult = parsed.lastConsult;
  if (flags.consult) {
    const nowMs = _now();
    const nowIso = new Date(nowMs).toISOString();
    const updated = upsertFrontmatter(raw, { "last-consult": nowIso });
    // F0 review #1: enforce the shape on --consult. If the brief is
    // missing canonical sections, warn loudly (the consult still
    // writes the new mtime so the gate will pass next time, but the
    // operator is told the brief is incomplete).
    const shape = validateBriefShape(updated);
    if (!shape.ok) {
      out(
        "vf",
        c.yellow(
          `brief is missing ${shape.missing.length} canonical section(s): ${shape.missing.join(", ")}. \`vf state brief --consult\` wrote the new mtime but the brief is still incomplete.`,
        ),
      );
    }
    // F0 review #3: atomic write (temp + fsync + rename). A SIGKILL
    // mid-write leaves the OLD brief intact.
    atomicWriteFileSync(path, updated, {
      writeFileSync: inject.writeFileSync,
    });
    lastConsult = nowIso;
    // F0 review #4: re-stat after the write so the "what changed"
    // diff uses the post-write mtime, not the pre-write one.
    mtimeMs = _stat(path).mtimeMs;
  }
  const mtimeIso = new Date(mtimeMs).toISOString();
  const briefObj: Brief = {
    path,
    raw,
    body: parsed.body,
    lastConsult,
    mtimeMs,
  };
  formatBriefForHuman(briefObj, mtimeIso, _now());
  return 0;
}

/** Read + parse the brief file. Throws on missing (caller should pre-check with existsSync). */
export function readBrief(
  base: string,
  inject: {
    existsSync?: (p: string) => boolean;
    statSync?: (p: string) => { mtimeMs: number };
    readFileSync?: (p: string, enc: string) => string;
  } = {},
): Brief {
  const _exists = inject.existsSync ?? existsSync;
  const _stat = inject.statSync ?? statSync;
  const _read = inject.readFileSync ?? readFileSync;
  const path = join(base, BRIEF_PATH);
  if (!_exists(path)) throw new Error(`brief not found: ${path}`);
  const stat = _stat(path);
  const raw = _read(path, "utf8");
  const parsed = parseFrontmatter(raw);
  return {
    path,
    raw,
    body: parsed.body,
    lastConsult: parsed.lastConsult,
    mtimeMs: stat.mtimeMs,
  };
}

/** Print the brief + a 1-line "what changed since last consult" diff. */
export function formatBriefForHuman(
  brief: Brief,
  mtimeIso: string,
  nowMs: number,
  outFn: OutFn = out,
): void {
  outFn("vf", `${c.bold("Coordinator Brief")} ${c.dim(`· mtime ${mtimeIso}`)}`);
  if (brief.lastConsult) {
    const lastMs = Date.parse(brief.lastConsult);
    if (Number.isFinite(lastMs)) {
      const ageSec = Math.max(0, Math.round((nowMs - lastMs) / 1000));
      outFn("vf", c.dim(`last consulted ${ageSec}s ago (${brief.lastConsult})`));
    } else {
      outFn("vf", c.yellow(`last-consult unparseable: ${brief.lastConsult}`));
    }
  } else {
    outFn("vf", c.yellow("never consulted"));
  }
  outFn("vf", "");
  // Print the body verbatim so the coordinator sees the same content
  // they wrote. Skip the frontmatter (already surfaced above).
  for (const line of brief.body.split(/\r?\n/)) {
    outFn("vf", line);
  }
}

/** Update the brief's `last-consult` field to now. Returns true on success. */
export function updateLastConsult(
  briefPath: string,
  nowMs: number,
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSync?: (p: string, data: string) => void;
  } = {},
): boolean {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  if (!_exists(briefPath)) return false;
  const raw = _read(briefPath, "utf8");
  const iso = new Date(nowMs).toISOString();
  // F0 review #3: atomic write so a SIGKILL mid-write leaves the
  // previous brief intact.
  atomicWriteFileSync(briefPath, upsertFrontmatter(raw, { "last-consult": iso }), {
    writeFileSync: inject.writeFileSync,
  });
  return true;
}

// === Frontmatter helpers (kept private; covered indirectly through brief/updateLastConsult tests) ===

// === Frontmatter helpers (extracted to state-frontmatter.ts to keep
//   state.ts under the 400-line cap) ===

// === Cross-module helpers: read the brief's last-consult mtime for
//   the `vf init --coord` and `vf coord` staleness gates. Kept here
//   (not in _shared) so all the frontmatter parsing stays in one
//   module. The two callers (init.ts + coord.ts) reach this via the
//   facade. ===

/** Read the brief's last-consult mtime (ms) for the staleness gate.
 *  Returns `null` if the brief or the field is missing. */
export function readBriefLastConsult(
  base: string,
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
  } = {},
): number | null {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  const path = join(base, BRIEF_PATH);
  if (!_exists(path)) return null;
  const raw = _read(path, "utf8");
  const parsed = parseFrontmatter(raw);
  if (!parsed.lastConsult) return null;
  const ms = Date.parse(parsed.lastConsult);
  return Number.isFinite(ms) ? ms : null;
}

/** Inject shape for `isBriefFresh` (shared with `readBriefLastConsult`). */
export type BriefInject = {
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string, enc: string) => string;
};

/** Print the "fresh" hint. Test seam so init can suppress the line
 *  when it wants to. */
export function printCoordGatePassed(): void {
  out("vf", c.dim("brief is fresh; --coord gate passed"));
}

/** Staleness gate used by `vf init --coord` and `vf coord`. Returns 0
 *  when the brief is fresh, 1 when stale or missing (and prints the
 *  refusal message). The `base` + `nowMs` are injected for testability;
 *  callers that want "now" pass `Date.now()`. */
export function assertCoordBriefFresh(
  base: string,
  nowMs: number,
  inject: BriefInject = {},
  outFn: OutFn = out,
): number {
  if (isBriefFresh(base, nowMs, inject)) {
    outFn("vf", c.dim("brief is fresh; --coord gate passed"));
    return 0;
  }
  const ageSec = Math.round(BRIEF_FRESH_MS / 1000);
  outFn(
    "vf",
    c.red(
      `brief is stale (or missing) at ${BRIEF_PATH}. ` +
        `Run \`vf state brief --consult\` first. (freshness window: ${ageSec}s)`,
    ),
    { level: "error" },
  );
  return 1;
}

/** Convenience: is the brief fresh? `true` when the last-consult
 *  mtime is within `BRIEF_FRESH_MS` of `nowMs` AND not in the future.
 *  A future timestamp (clock skew, hand-edited brief, NTP jump) is
 *  treated as STALE — the gate refuses rather than bypasses. */
export function isBriefFresh(base: string, nowMs: number, inject: BriefInject = {}): boolean {
  const last = readBriefLastConsult(base, inject);
  if (last === null) return false;
  if (last > nowMs) return false; // F0 review #2: future timestamps are stale, not fresh
  return nowMs - last <= BRIEF_FRESH_MS;
}

// ponytail: inlined from state-gate.ts (#390) — A1 FU #199 shared gate (shape + freshness)
export function assertCoordBriefReady(
  base: string,
  nowMs: number,
  inject: BriefInject = {},
  outFn: OutFn = out,
): number {
  const _exists = inject.existsSync ?? existsSync;
  const _read = inject.readFileSync ?? readFileSync;
  const path = join(base, BRIEF_PATH);
  if (!_exists(path)) {
    outFn("vf", c.red(`no brief at ${BRIEF_PATH}. Run \`vf state brief write\` to create one.`), {
      level: "error",
    });
    return 1;
  }
  const raw = _read(path, "utf8");
  const shape = validateBriefShape(raw);
  if (!shape.ok) {
    outFn(
      "vf",
      c.red(
        `brief is missing ${shape.missing.length} canonical section(s): ${shape.missing.join(", ")}. Run \`vf state brief write\` to repair, then \`vf state brief --consult\`.`,
      ),
      { level: "error" },
    );
    return 1;
  }
  if (!isBriefFresh(base, nowMs, inject)) {
    outFn(
      "vf",
      c.red(
        `brief is stale (or missing) at ${BRIEF_PATH}. Run \`vf state brief --consult\` first. (freshness window: ${Math.round(BRIEF_FRESH_MS / 1000)}s)`,
      ),
      { level: "error" },
    );
    return 1;
  }
  outFn("vf", c.dim("brief is ready; --coord gate passed"));
  return 0;
}

// ponytail: inlined from atomic-write.ts (#392)
/** Atomic write of a file. Writes to a temp file, fsyncs, then
 *  renames over the destination. POSIX rename is atomic; a SIGKILL
 *  between truncate and the new bytes leaves the OLD file intact.
 *  Pure stdlib (`node:fs`), no new deps. */
export function atomicWriteFileSync(
  path: string,
  data: string,
  inject: {
    openSync?: typeof openSync;
    writeSync?: (fd: number, data: string) => number;
    closeSync?: typeof closeSync;
    fsyncSync?: typeof fsyncSync;
    renameSync?: typeof renameSync;
    unlinkSync?: typeof unlinkSync;
    writeFileSync?: (p: string, data: string, opts?: { mode?: number }) => void;
    pid?: number;
  } = {},
): void {
  const _open = inject.openSync ?? openSync;
  const _writeFile = inject.writeFileSync ?? writeFileSync;
  const _writeFd = inject.writeSync;
  const _close = inject.closeSync ?? closeSync;
  const _fsync = inject.fsyncSync ?? fsyncSync;
  const _rename = inject.renameSync ?? renameSync;
  const _unlink = inject.unlinkSync ?? unlinkSync;
  const pid = inject.pid ?? process.pid;
  const tmp = `${path}.tmp.${pid}`;
  try {
    _writeFile(tmp, data, { mode: 0o600 });
    if (_writeFd) {
      const fd = _open(tmp, "a");
      _writeFd(fd, data);
      _fsync(fd);
      _close(fd);
    } else {
      const fd = _open(tmp, "r+");
      _fsync(fd);
      _close(fd);
    }
    _rename(tmp, path);
  } catch (err) {
    try {
      _unlink(tmp);
    } catch {
      /* best-effort cleanup */
    }
    throw err;
  }
}
