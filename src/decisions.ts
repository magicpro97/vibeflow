// src/decisions.ts
//
// ADR-lite decision log (issue #335). Durable architecture/process decisions
// live in `.vibeflow/knowledge/decisions.md`, SEPARATE from the noisy
// append-only work journal (`knowledge/log.md`). Mirrors `journal.ts` shape.

import { existsSync, readFileSync } from "node:fs";
import { appendFileSafe, ctxPath, ctxPathIn, writeFileSafe } from "./core.js";

const HEADER = "# Decisions (ADR-lite)\n\nDurable architecture/process decisions. Append-only.\n";

/** Path to the append-only decision log (knowledge/decisions.md). */
export function decisionsPath(base?: string): string {
  return base ? ctxPathIn(base, "knowledge", "decisions.md") : ctxPath("knowledge", "decisions.md");
}

/** Format one ADR-lite entry. Greppable header: `## [YYYY-MM-DD] ADR-NNN | <title>`. */
export function formatDecision(
  seq: number,
  title: string,
  context: string,
  decision: string,
  consequences?: string,
): string {
  const date = new Date().toISOString().slice(0, 10);
  const id = `ADR-${String(seq).padStart(3, "0")}`;
  const safeTitle = title.replace(/[\r\n]+/g, " ").trim();
  const lines = [
    "",
    `## [${date}] ${id} | ${safeTitle}`,
    `**Context:** ${context.trim()}`,
    `**Decision:** ${decision.trim()}`,
  ];
  if (consequences?.trim()) lines.push(`**Consequences:** ${consequences.trim()}`);
  lines.push("");
  return lines.join("\n");
}

/** Next ADR sequence number by counting existing `## [..] ADR-NNN` headers. */
export function nextDecisionSeq(existing: string): number {
  const matches = existing.match(/^## \[[^\]]+\] ADR-\d+/gm);
  return (matches?.length ?? 0) + 1;
}

/**
 * Append a decision to knowledge/decisions.md, seeding the file header on
 * first write. Returns the ADR sequence number assigned. FS is injectable
 * for tests.
 */
export function appendDecision(
  base: string | undefined,
  title: string,
  context: string,
  decision: string,
  consequences?: string,
  inject: {
    existsSync?: (p: string) => boolean;
    readFileSync?: (p: string, enc: string) => string;
    writeFileSafe?: (p: string, c: string) => void;
    appendFileSafe?: (p: string, c: string) => void;
  } = {},
): number {
  const _existsSync = inject.existsSync ?? existsSync;
  const _readFileSync = inject.readFileSync ?? readFileSync;
  const _writeFileSafe = inject.writeFileSafe ?? writeFileSafe;
  const _appendFileSafe = inject.appendFileSafe ?? appendFileSafe;

  const path = decisionsPath(base);
  const exists = _existsSync(path);
  const prior = exists ? _readFileSync(path, "utf8") : HEADER;
  const seq = nextDecisionSeq(prior);
  if (!exists) _writeFileSafe(path, prior); // seed header once
  _appendFileSafe(path, formatDecision(seq, title, context, decision, consequences));
  return seq;
}
