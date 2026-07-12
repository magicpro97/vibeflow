import type { WorkUnit } from "../core/types.js";

const HANDOFF_CAP = 500; // bytes; keep the downstream prompt bounded

// Control-char class (0x00-0x1f + 0x7f) built from char codes so no literal
// control character appears in this source file (which would break the parse).
const CTRL_RE = new RegExp(
  `[${String.fromCharCode(0)}-${String.fromCharCode(31)}${String.fromCharCode(127)}]+`,
  "g",
);

/** Derive a bounded, sanitized one-line handoff summary from a completed unit's
 *  own outcome fields. Pure — no I/O. Strips control chars, caps at HANDOFF_CAP. */
export function deriveHandoff(unit: Pick<WorkUnit, "name" | "status" | "evidence">): string {
  const evCount = unit.evidence?.length ?? 0;
  const raw = `${unit.name}: ${unit.status}, ${evCount} evidence item(s)`;
  // sanitize: collapse control chars/newlines to spaces, then hard-cap.
  const clean = raw.replace(CTRL_RE, " ").trim();
  return clean.length > HANDOFF_CAP ? `${clean.slice(0, HANDOFF_CAP - 1)}…` : clean;
}
