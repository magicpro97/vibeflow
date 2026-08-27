// src/commands/dispatch-reviewer.ts
//
// Per-unit independent reviewer. Extracted from
// src/commands/dispatch-runtime.ts (issue #503) to keep that file under the
// 400-line cap. dispatch-runtime.ts re-exports `makeReviewer` so the public
// surface (commands.ts, _shared.js, tests) keeps importing it unchanged.

import { ENGINES } from "../core/types.js";
import { GATE_STATE, PRE_REVIEW_WORK_UNIT_GATES } from "../core/workflow-contract.js";
import { DISPATCH_MODE, type DispatchMode } from "../dispatch/session-contract.js";
import { verifyAcceptance } from "../orchestrator/acceptance-verify.js";
import { type GateRunner, defaultRun } from "../orchestrator/scoped-gate.js";
import { out } from "./_shared.js";
import type { Engine, Reviewer } from "./_shared.js";
import { type DiffReader, analyzeDiff, defaultDiffReader } from "./dispatch-diff.js";
import { getUnitDiff, runLLMReview } from "./dispatch-reviewer-llm.js";

/**
 * Independent reviewer. Signature: `(unit, outcome) → { pass, reason }` — the first arg is the
 * dispatched unit (ignored), the second is its outcome (the reviewer inspects confidence +
 * evidence). A dry run is a PREVIEW, not a verdict — it passes review neutrally so the goal
 * lands `partial` (exit 0), not `blocked`. A real run only passes at confidence ≥ threshold
 * with evidence; anything less blocks (no completion on a guess). The `confidence < threshold`
 * branch returns a SPECIFIC reason ("investigated, still blocked") so the e2e suite can assert
 * the investigation loop ran end-to-end (i.e. the unit was investigated + blocked, not silently
 * closed).
 */
export function makeReviewer(
  mode: DispatchMode,
  threshold: number,
  inject?: {
    diffReader?: DiffReader;
    cwd?: string;
    goal?: string;
    llmReviewFn?: (prompt: string) => Promise<string>;
    /** Implementer engine — so the reviewer auto-routes to a DIFFERENT tool (ADR-001). */
    implementer?: Engine;
    /** #522: command runner for acceptance-criteria verification. Defaults to defaultRun. */
    runCmd?: GateRunner;
  },
): Reviewer {
  const readDiff = inject?.diffReader ?? defaultDiffReader;
  const cwd = inject?.cwd ?? process.cwd();
  // ADR-001: auto-wire llmFn only when VF_LLM_REVIEW=1 (opt-in) to avoid smoke/test interference.
  const llmReviewFn = inject?.llmReviewFn;
  const autoLlmReview =
    Boolean(inject?.goal) && process.env.VF_LLM_REVIEW === "1" && Boolean(process.env.VIBEFLOW_AI);

  return async (unit, outcome) => {
    if (mode === DISPATCH_MODE.DRY) {
      return { pass: true, reason: "dry preview — not evaluated (re-run with --yes)" };
    }
    const failedGate = outcome.gates
      ? PRE_REVIEW_WORK_UNIT_GATES.find((gate) => outcome.gates?.[gate] === GATE_STATE.FAIL)
      : undefined;
    if (failedGate) {
      return { pass: false, reason: `measured gate failed: ${failedGate}` };
    }
    // NOTE (cross-review P0 adjudication): this reviewer IS the `review` gate,
    // which is `pending` by definition while it runs — so computeConfidence
    // (which weights review) can't apply here without a chicken-and-egg deadlock.
    // The self-report threshold stays; the FULL computed-confidence gate runs at
    // the policyGates close gate (run.ts incomplete-check), where all gates incl.
    // review are settled. That is where the self-certification loop is closed.
    if (outcome.confidence < threshold) {
      return {
        pass: false,
        reason: `confidence ${outcome.confidence} < ${threshold} — investigated, still blocked`,
      };
    }
    if (!outcome.evidence?.length) return { pass: false, reason: "no recorded evidence" };

    // #522: run each structured acceptance criterion. A failing MUST is a review
    // FAILURE; SHOULD/NICE/absent-priority failures warn only. Prose-only skip.
    if (unit.acceptance_criteria?.length) {
      const runCmd = inject?.runCmd ?? defaultRun;
      const v = verifyAcceptance(unit.acceptance_criteria, runCmd, cwd);
      unit.evidence = [...(unit.evidence ?? []), ...v.evidence];
      for (const w of v.warn) out("vf", `acceptance(warn): ${w}`, { level: "warn" });
      if (v.hardFail.length)
        return { pass: false, reason: `MUST criteria unverified: ${v.hardFail.join("; ")}` };
    }

    // Read and analyze the unit's actual diff (cwd is the run dir, not the
    // process cwd — #359: whole-tree diff now sees ALL changed files, so it
    // must scope to the run dir or it catches the host repo's dirty files).
    const diff = readDiff(unit.scope ?? [], cwd);
    const analysis = analyzeDiff(diff, unit.scope ?? []);
    if (analysis.fail) return { pass: false, reason: `unit ${unit.name}: ${analysis.reason}` };

    const localResult = {
      pass: true,
      reason: `confidence ${outcome.confidence} ≥ ${threshold} with evidence, diff clean`,
    };

    // ADR-001 phase 2: LLM review after local gate passes.
    if (inject?.goal && (llmReviewFn || autoLlmReview)) {
      const llmDiff = getUnitDiff(cwd, unit.scope ?? []);
      const llmResult = await runLLMReview({
        goal: inject.goal,
        spec: unit.spec,
        diff: llmDiff,
        ...(llmReviewFn ? { llmFn: llmReviewFn } : {}),
        cwd,
        // ADR-001: route the reviewer to a DIFFERENT tool than the implementer.
        // ENGINES is the canonical candidate pool; pickReviewerEngine avoids the implementer.
        ...(inject?.implementer
          ? { implementer: inject.implementer, available: [...ENGINES] }
          : {}),
      });
      // Surface the same-tool warning to the audit trail — the Reviewer boundary
      // only carries { pass, reason }, so emit it here or it's silently dropped.
      if (llmResult.warning) out("vf", llmResult.warning, { level: "warn" });
      return {
        pass: llmResult.pass,
        reason: llmResult.reason,
        ...(llmResult.score !== undefined ? { score: llmResult.score } : {}),
      };
    }
    return localResult;
  };
}
