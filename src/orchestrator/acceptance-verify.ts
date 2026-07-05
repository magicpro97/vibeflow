// src/orchestrator/acceptance-verify.ts
//
// #522: run each structured acceptance criterion's `verification` through the
// shared GateRunner seam and classify the result. A failing MUST is a hard
// fail (the reviewer turns it into a review FAILURE); SHOULD/NICE/absent-
// priority failures warn only. Prose-only criteria (no `verification`) skip.
//
// The appended evidence line is shaped `acceptance <id>: <cmd> → "<tail>"` to
// match VERIFIABLE_EVIDENCE_PATTERNS[0] in gates.ts (end-anchored on the quoted
// tail) so the auto-recorded evidence PASSES the ADR-004 verifiable-evidence
// gate. When stdout is empty/tiny (silent-success commands like `test -f x`)
// the tail falls back to `exit <status>` (or `exit signal` when the process was
// killed by a signal, `r.status === null`), keeping the line ≥2 quoted chars so
// a passing unit is never failed on its own evidence.

import type { AcceptanceCriterion } from "../core/types.js";
import type { GateRunner } from "./scoped-gate.js";

/** #533: normalize a persisted, hand-editable `priority` to the canonical enum.
 *  A case typo (`"must"`, `"Must"`) must NOT silently downgrade a MUST gate to
 *  warn-only, so uppercase-then-match. Returns `{ level, unknown? }`: an
 *  unrecognized value yields `{ level: "SHOULD", unknown: <raw> }` so the caller
 *  can warn on it AND fail open to SHOULD — an unrecognized priority never
 *  hardens a green gate. Absent ⇒ `{ level: "SHOULD" }` (the #522 default). */
function normalizePriority(raw: AcceptanceCriterion["priority"]): {
  level: "MUST" | "SHOULD" | "NICE";
  unknown?: string;
} {
  if (raw == null) return { level: "SHOULD" };
  const up = String(raw).trim().toUpperCase();
  if (up === "MUST" || up === "SHOULD" || up === "NICE") return { level: up };
  return { level: "SHOULD", unknown: String(raw) };
}

export function verifyAcceptance(
  criteria: AcceptanceCriterion[],
  runCmd: GateRunner,
  cwd: string,
): { hardFail: string[]; warn: string[]; evidence: string[] } {
  const hardFail: string[] = [];
  const warn: string[] = [];
  const evidence: string[] = [];
  for (const c of criteria) {
    if (!c.verification) continue; // prose-only ⇒ skip
    const r = runCmd(c.verification, cwd);
    const trimmed = r.stdout.trim();
    const nl = trimmed.lastIndexOf("\n");
    const snippet = (nl >= 0 ? trimmed.slice(nl + 1) : trimmed).slice(0, 120);
    // Fall back to the exit code when there is no printable output, so the
    // evidence line stays ≥2 quoted chars (ADR-004 pattern[0]). The `acceptance
    // <id>:` prefix also guarantees the whole line clears isVerifiableEvidence's
    // ≥10-char floor (gates.ts) even for a tiny cmd+tail like `ls → "ok"`.
    // #533: `status` is `number | null` — null means killed by a signal, so
    // render `exit signal` rather than the misleading `exit null`.
    const exitTail = r.status === null ? "exit signal" : `exit ${r.status}`;
    const tail = snippet.length >= 2 ? snippet : exitTail;
    evidence.push(`acceptance ${c.id}: ${c.verification} → "${tail}"`);
    // #533: warn (never silently) when a criterion carries an unrecognized
    // priority string, so a typo surfaces instead of quietly downgrading.
    const { level, unknown } = normalizePriority(c.priority);
    if (unknown !== undefined) {
      warn.push(`${c.id}: unknown priority "${unknown}" — treated as SHOULD (warn-only)`);
    }
    if (r.status === 0) continue;
    (level === "MUST" ? hardFail : warn).push(`${c.id}: ${c.criterion}`);
  }
  return { hardFail, warn, evidence };
}
