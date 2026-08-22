import { spawnSync } from "node:child_process";
import type { WorkflowState } from "../core.js";
import { writeState } from "../core.js";
import { type GateReport, computeConfidence, policyGates } from "../gates.js";
import { snapshotImpl } from "../spec-freshness.js";

export const VERIFY_GATE_ORDER = [
  "toolchain",
  "confidence",
  "goal",
  "evidence",
  "test_evidence",
  "scope",
  "skill",
  "canary",
  "implementation_drift",
  "coverage",
  "sandbox",
  "waiver",
  "registry_lock",
  "review_evidence",
  "advisory_e2e",
  "marker_result",
  "journal_result",
] as const;

export type VerifyGateName = (typeof VERIFY_GATE_ORDER)[number];
export type VerifyGateStatus = "pass" | "fail" | "warn" | "skipped";

export interface VerifyGateResult {
  status: VerifyGateStatus;
  details: string;
  evidence_refs: string[];
}

export type VerifyGateManifest = { [K in VerifyGateName]: VerifyGateResult };
export type PolicyVerifyReport = VerifyGateManifest;

export interface ToolchainGateResult {
  label: string;
  pass: boolean;
}

export interface GoalEvaluation {
  pass: boolean;
  uncovered: string[];
  score?: number;
}

export interface VerifyCoreInput {
  base: string;
  state: WorkflowState | null;
  toolchain: readonly ToolchainGateResult[];
  allowUnverifiedEvidence?: boolean;
  goalEval?: GoalEvaluation;
  coverage?: VerifyGateResult;
  sandbox?: VerifyGateResult;
  waiver?: VerifyGateResult;
  registryLock?: VerifyGateResult;
  reviewEvidence?: VerifyGateResult;
  advisoryE2e?: VerifyGateResult;
  markerResult?: VerifyGateResult;
  journalResult?: VerifyGateResult;
}

export interface VerifyCoreReport {
  ok: boolean;
  confidence: number;
  gates: VerifyGateManifest;
  toolchain: ToolchainGateResult[];
  policy: GateReport;
  goalEval?: GoalEvaluation;
}

export function gateResult(
  status: VerifyGateStatus,
  details: string,
  evidenceRefs: readonly string[] = [],
): VerifyGateResult {
  return { status, details, evidence_refs: [...evidenceRefs] };
}

function exactConfidence(state: WorkflowState | null): number {
  if (!state) return 0;
  if (state.work_units.length === 0) return 1;
  return state.work_units.reduce((minimum, unit) => {
    const value = computeConfidence(unit);
    return Math.min(minimum, Number.isFinite(value) ? value : 0);
  }, 1);
}

function clonePolicy(report: GateReport): GateReport {
  return {
    ok: report.ok,
    failures: [...report.failures],
    passed: [...report.passed],
    warnings: [...report.warnings],
  };
}

function addReviewEvidence(policy: GateReport, result: VerifyGateResult): void {
  if (result.status === "fail") policy.failures.push(result.details);
  else if (result.status === "warn") policy.warnings.push(result.details);
  else if (result.status === "pass") policy.passed.push(result.details);
  policy.ok = policy.failures.length === 0;
}

function policyResult(
  policy: GateReport,
  matches: (message: string) => boolean,
  fallback: VerifyGateResult,
  evidenceRefs: readonly string[] = [],
): VerifyGateResult {
  const failures = policy.failures.filter(matches);
  const warnings = policy.warnings.filter(matches);
  const passed = policy.passed.filter(matches);
  if (failures.length) return gateResult("fail", failures.join("\n"), evidenceRefs);
  if (warnings.length) return gateResult("warn", warnings.join("\n"), evidenceRefs);
  if (passed.length) return gateResult("pass", passed.join("\n"), evidenceRefs);
  return fallback;
}

const starts =
  (...prefixes: string[]) =>
  (message: string) =>
    prefixes.some((prefix) => message.startsWith(prefix));

function toolchainResult(results: readonly ToolchainGateResult[]): VerifyGateResult {
  if (!results.length) return gateResult("skipped", "no supported toolchain gates configured");
  const failed = results.filter((result) => !result.pass).map((result) => result.label);
  return failed.length
    ? gateResult("fail", `failed: ${failed.join(", ")}`)
    : gateResult("pass", "all configured toolchain gates passed");
}

function goalResult(policy: GateReport, goalEval?: GoalEvaluation): VerifyGateResult {
  const ledger = policyResult(
    policy,
    starts("goal-eval"),
    gateResult("skipped", "goal evaluation not requested"),
  );
  if (!goalEval) return ledger;
  const details = goalEval.pass
    ? "behavioral goal evaluation passed"
    : `behavioral goal evaluation failed: ${goalEval.uncovered.join(", ") || "uncovered goal"}`;
  if (!goalEval.pass) return gateResult("fail", details);
  return ledger.status === "fail" ? ledger : gateResult("pass", details);
}

function external(result: VerifyGateResult | undefined, details: string): VerifyGateResult {
  return result ?? gateResult("skipped", details);
}

export function evaluateVerifyCore(input: VerifyCoreInput): VerifyCoreReport {
  const state =
    input.allowUnverifiedEvidence && input.state
      ? { ...input.state, _allowUnverifiedEvidence: true }
      : input.state;
  const policy = clonePolicy(policyGates(state, { base: input.base }));
  const reviewEvidence =
    input.reviewEvidence ?? gateResult("fail", "review evidence not evaluated");
  addReviewEvidence(policy, reviewEvidence);
  const confidence = exactConfidence(state);
  const confidencePolicy = policyResult(
    policy,
    starts("computed-confidence", "still-running", "no-workflow-state"),
    gateResult("pass", "all units meet their risk threshold"),
  );
  const gates: VerifyGateManifest = {
    toolchain: toolchainResult(input.toolchain),
    confidence: gateResult(
      confidencePolicy.status,
      `exact confidence ${confidence}; ${confidencePolicy.details}`,
    ),
    goal: goalResult(policy, input.goalEval),
    evidence: policyResult(
      policy,
      starts("no-evidence", "unverifiable-evidence", "evidence-stale", "evidence:"),
      gateResult("pass", "evidence policy passed"),
    ),
    test_evidence: policyResult(
      policy,
      starts("test-evidence"),
      gateResult("pass", "test evidence policy passed"),
    ),
    scope: policyResult(
      policy,
      starts("scope-overlap", "scope:"),
      gateResult("pass", "scope policy passed"),
    ),
    skill: policyResult(policy, starts("skills"), gateResult("pass", "skill policy passed")),
    canary: policyResult(policy, starts("canary"), gateResult("pass", "canary policy passed")),
    implementation_drift: policyResult(
      policy,
      starts("impl-drift"),
      gateResult("pass", "implementation drift policy passed"),
    ),
    coverage: external(input.coverage, "coverage gate not requested"),
    sandbox: external(input.sandbox, "sandbox gate not requested"),
    waiver: input.waiver ?? gateResult("fail", "waiver gate not evaluated"),
    registry_lock: input.registryLock ?? gateResult("fail", "registry lock not evaluated"),
    review_evidence: reviewEvidence,
    advisory_e2e: external(input.advisoryE2e, "advisory E2E scan not evaluated"),
    marker_result: external(input.markerResult, "marker write not requested"),
    journal_result: external(input.journalResult, "journal write not requested"),
  };
  const nonBlocking = new Set<VerifyGateName>([
    "skill",
    "advisory_e2e",
    "marker_result",
    "journal_result",
  ]);
  const blockingPassed = VERIFY_GATE_ORDER.every(
    (name) =>
      nonBlocking.has(name) ||
      (name === "review_evidence"
        ? gates[name].status !== "fail" && gates[name].status !== "skipped"
        : gates[name].status !== "fail"),
  );
  return {
    ok: policy.failures.length === 0 && blockingPassed,
    confidence,
    gates,
    toolchain: input.toolchain.map((gate) => ({ ...gate })),
    policy,
    ...(input.goalEval ? { goalEval: { ...input.goalEval } } : {}),
  };
}

function currentHead(base: string): string {
  const result = spawnSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" });
  return result.status === 0 ? result.stdout.trim() : "HEAD";
}

export function persistImplementationFingerprints(
  base: string,
  state: WorkflowState | null,
  report: VerifyCoreReport,
  inject: {
    headSha?: (base: string) => string;
    snapshot?: (base: string, scope: string[]) => Record<string, string | null>;
    write?: (base: string, state: WorkflowState) => void;
  } = {},
): boolean {
  if (!report.ok || !state?.work_units.length) return false;
  try {
    const sha = (inject.headSha ?? currentHead)(base);
    const snapshot = inject.snapshot ?? snapshotImpl;
    let changed = false;
    for (const unit of state.work_units) {
      if (unit.status !== "done" || !unit.scope?.length) continue;
      unit.impl_fingerprint = snapshot(base, unit.scope);
      unit.verified_sha = sha;
      changed = true;
    }
    if (changed) (inject.write ?? writeState)(base, state);
    return changed;
  } catch {
    return false;
  }
}
