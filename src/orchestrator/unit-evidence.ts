// src/orchestrator/unit-evidence.ts
//
// Neutral evidence/ledger writers for work units: checkpoint, investigation,
// quota persistence + the quota-skip outcome. Extracted from protection.ts so
// the DISPATCH layer can depend on these without depending on the source-
// protection POLICY layer (closes the TODO(#131) inversion).

import { join } from "node:path";
import { c, writeFileSafe } from "../core.js";
import { PENDING_REQUIRED_WORK_UNIT_GATES, WORK_UNIT_STATUS } from "../core/workflow-contract.js";
import type { DispatchResult } from "../dispatch.js";
import { out } from "../logbus.js";
import { recoveryHint, restoreIgnored } from "../safety/checkpoint.js";
import type { Checkpoint, GitRunner } from "../safety/checkpoint.js";
import { detectQuota } from "../safety/quota.js";
import type { QuotaSignal } from "../safety/quota.js";
import type { UnitInvestigationOutcome } from "./investigate.js";
import type { UnitOutcome } from "./run.js";

/** Minimal runtime interface — structurally compatible with ProtectionRuntime. */
interface UnitEvidenceRuntime {
  checkpoint: Checkpoint | null;
  fp: { rollbackOnFail: boolean };
  git: GitRunner;
  quota: { limited: boolean; signal?: QuotaSignal };
  rolledBack: boolean;
}

/** Persist the pre-dispatch checkpoint (+ recovery hint) as auditable unit evidence. */
export function persistCheckpoint(unitDir: string, cp: Checkpoint): string {
  const rel = "evidence/checkpoint.json";
  writeFileSafe(join(unitDir, rel), JSON.stringify({ ...cp, recovery: recoveryHint(cp) }, null, 2));
  return rel;
}

/** Persist a detected quota signal as unit evidence. */
export function persistQuota(unitDir: string, sig: QuotaSignal): string {
  const rel = "evidence/quota.json";
  writeFileSafe(join(unitDir, rel), JSON.stringify(sig, null, 2));
  return rel;
}

/**
 * Inspect a dispatch result for a quota/rate-limit signal. Records it as evidence and, on a
 * HIGH-confidence limit, latches the shared stop flag so not-yet-started units are skipped
 * rather than deepening the hole. LOW-confidence prose stays advisory (never auto-stops).
 */
export function recordQuota(
  prot: UnitEvidenceRuntime,
  unitRel: string,
  unitDir: string,
  result: DispatchResult,
  evidence: string[],
): void {
  const sig = detectQuota({ status: result.ok ? 0 : 1, stdout: result.raw, reason: result.reason });
  if (!sig.limited) return;
  evidence.push(`${unitRel}/${persistQuota(unitDir, sig)}`);
  if (sig.confidence === "high") {
    prot.quota.limited = true;
    prot.quota.signal = sig;
    out("vf", c.yellow(`! quota signal (${sig.kind}) — stopping remaining units: ${sig.evidence}`));
  }
}

/** Roll the tree back to the pre-dispatch state (once) and restore backed-up ignored files. */
function rollbackCheckpoint(base: string, prot: UnitEvidenceRuntime): void {
  const cp = prot.checkpoint;
  if (!cp || prot.rolledBack) return;
  prot.rolledBack = true;
  const target = cp.baseRef ?? cp.wipSha;
  if (target) prot.git(["reset", "--hard", target]);
  const restored = restoreIgnored(cp, base);
  const ref = (target ?? "HEAD").slice(0, 8);
  const extra = restored.length ? ` (+${restored.length} ignored file(s) restored)` : "";
  out("vf", c.yellow(`rolled back to ${ref}${extra}`));
}

/** On a blocked unit in cli mode: print the recovery hint, then roll back when configured. */
// Exported (not just internal) so the `run` subcommand
// (src/commands/run.ts, phase 6.5/14) can call it via the barrel
// (_shared.js). Without the export, the run path would
// re-implement the same hook.
export function handleUnitFailure(prot: UnitEvidenceRuntime, base: string): void {
  if (prot.checkpoint) out("vf", c.yellow(recoveryHint(prot.checkpoint)));
  if (prot.fp.rollbackOnFail) rollbackCheckpoint(base, prot);
}

/** Blocked outcome for a unit skipped because an upstream rate limit was already hit. */
export function skippedByQuota(): UnitOutcome {
  return {
    status: WORK_UNIT_STATUS.BLOCKED,
    confidence: 0,
    evidence: [],
    gates: { ...PENDING_REQUIRED_WORK_UNIT_GATES },
  };
}

export function persistInvestigation(unitDir: string, outcome: UnitInvestigationOutcome): string {
  const rel = "evidence/investigation.json";
  writeFileSafe(
    join(unitDir, rel),
    JSON.stringify(
      {
        proceed: outcome.proceed,
        finalConfidence: outcome.finalConfidence,
        threshold: outcome.threshold,
        stoppedBy: outcome.stoppedBy,
        recommendation: outcome.recommendation,
        rounds: outcome.rounds,
      },
      null,
      2,
    ),
  );
  return rel;
}
