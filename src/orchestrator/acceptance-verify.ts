// src/orchestrator/acceptance-verify.ts
//
// #522: run each structured acceptance criterion's `verification` through the
// shared GateRunner seam and classify the result. A failing MUST is a hard
// fail (the reviewer turns it into a review FAILURE); SHOULD/NICE/absent-
// priority failures warn only. Prose-only criteria (no `verification`) skip.
//
// The appended evidence line is shaped `<cmd> → "<tail>"` to match
// VERIFIABLE_EVIDENCE_PATTERNS[0] in gates.ts so the auto-recorded evidence
// PASSES the ADR-004 verifiable-evidence gate. When stdout is empty/tiny
// (silent-success commands like `test -f x`) the tail falls back to
// `exit <status>`, keeping the line ≥2 quoted chars so a passing unit is never
// failed on its own evidence.

import type { AcceptanceCriterion } from "../core/types.js";
import type { GateRunner } from "./scoped-gate.js";

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
    // evidence line stays ≥2 quoted chars (ADR-004 pattern[0]).
    const tail = snippet.length >= 2 ? snippet : `exit ${r.status}`;
    evidence.push(`${c.verification} → "${tail}"`);
    if (r.status === 0) continue;
    (c.priority === "MUST" ? hardFail : warn).push(`${c.id}: ${c.criterion}`);
  }
  return { hardFail, warn, evidence };
}
