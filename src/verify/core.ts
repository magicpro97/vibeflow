import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join } from "node:path";
import type { WorkflowState } from "../core.js";
import { writeState } from "../core.js";
import { WORK_UNIT_STATUS } from "../core/workflow-contract.js";
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
  "normative_matrix",
  "advisory_e2e",
  "marker_result",
  "journal_result",
] as const;

export type VerifyGateName = (typeof VERIFY_GATE_ORDER)[number];
export type VerifyGateStatus = "pass" | "fail" | "warn" | "skipped";

export const VERIFY_NON_BLOCKING_GATES = [
  "skill",
  "advisory_e2e",
  "marker_result",
  "journal_result",
] as const satisfies readonly VerifyGateName[];

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
  normativeMatrix?: VerifyGateResult;
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

export function verifyGateManifestOk(gates: VerifyGateManifest): boolean {
  const nonBlocking = new Set<VerifyGateName>(VERIFY_NON_BLOCKING_GATES);
  const known = new Set<VerifyGateStatus>(["pass", "fail", "warn", "skipped"]);
  return VERIFY_GATE_ORDER.every((name) => {
    const status = gates?.[name]?.status;
    if (!status || !known.has(status)) return false;
    if (nonBlocking.has(name)) return true;
    return name === "review_evidence"
      ? status !== "fail" && status !== "skipped"
      : status !== "fail";
  });
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

function addPolicyResult(policy: GateReport, result: VerifyGateResult): void {
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
  const normativeMatrix =
    input.normativeMatrix ?? gateResult("fail", "normative matrix gate not evaluated");
  addPolicyResult(policy, normativeMatrix);
  const reviewEvidence =
    input.reviewEvidence ?? gateResult("fail", "review evidence not evaluated");
  addPolicyResult(policy, reviewEvidence);
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
    normative_matrix: normativeMatrix,
    advisory_e2e: external(input.advisoryE2e, "advisory E2E scan not evaluated"),
    marker_result: external(input.markerResult, "marker write not requested"),
    journal_result: external(input.journalResult, "journal write not requested"),
  };
  return {
    ok: policy.failures.length === 0 && verifyGateManifestOk(gates),
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

function cleanWorktree(base: string): boolean {
  const result = spawnSync("git", ["status", "--porcelain", "--untracked-files=all"], {
    cwd: base,
    encoding: "utf8",
  });
  return result.status === 0 && result.stdout.trim() === "";
}

type ScopePathAuthority = "tracked" | "ignored" | "absent" | "untracked" | "error";

function scopePathAuthority(base: string, rel: string): ScopePathAuthority {
  const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", rel], {
    cwd: base,
    encoding: "utf8",
  });
  if (tracked.status === 0) return "tracked";
  if (tracked.status !== 1) return "error";

  const ignored = spawnSync("git", ["check-ignore", "-q", "--", rel], {
    cwd: base,
    encoding: "utf8",
  });
  if (ignored.status === 0) return "ignored";
  if (ignored.status !== 1) return "error";
  return existsSync(join(base, rel)) ? "untracked" : "absent";
}

const DRIFT_CHECKPOINT_REQUIRED_PASSES = [
  "toolchain",
  "coverage",
  "waiver",
  "registry_lock",
  "review_evidence",
] as const satisfies readonly VerifyGateName[];

function isDriftOnlyCheckpoint(report: VerifyCoreReport): boolean {
  if (report.ok || report.confidence !== 1) return false;
  if (
    report.policy.failures.length === 0 ||
    !report.policy.failures.every((failure) => failure.startsWith("impl-drift:"))
  ) {
    return false;
  }
  if (report.gates.implementation_drift.status !== "fail") return false;
  if (DRIFT_CHECKPOINT_REQUIRED_PASSES.some((name) => report.gates[name].status !== "pass")) {
    return false;
  }
  if (report.gates.review_evidence.details !== "review-evidence(ok)") return false;
  const nonBlocking = new Set<VerifyGateName>(VERIFY_NON_BLOCKING_GATES);
  return VERIFY_GATE_ORDER.every(
    (name) =>
      name === "implementation_drift" ||
      nonBlocking.has(name) ||
      report.gates[name].status !== "fail",
  );
}

export function persistImplementationFingerprints(
  base: string,
  state: WorkflowState | null,
  report: VerifyCoreReport,
  inject: {
    headSha?: (base: string) => string;
    worktreeClean?: (base: string) => boolean;
    scopePathAuthority?: (base: string, rel: string) => ScopePathAuthority;
    snapshot?: (base: string, scope: string[]) => Record<string, string | null>;
    write?: (base: string, state: WorkflowState) => void;
  } = {},
): boolean {
  if (!state?.work_units.length) return false;
  try {
    const driftCheckpoint = isDriftOnlyCheckpoint(report);
    if (!report.ok && !driftCheckpoint) return false;
    const headSha = inject.headSha ?? currentHead;
    const sha = headSha(base);
    const worktreeClean = inject.worktreeClean ?? cleanWorktree;
    if (driftCheckpoint && (!/^[0-9a-f]{40}$/i.test(sha) || !worktreeClean(base))) return false;

    const snapshot = inject.snapshot ?? snapshotImpl;
    const pending: Array<{
      index: number;
      fingerprint: Record<string, string | null>;
    }> = [];
    for (const [index, unit] of state.work_units.entries()) {
      if (unit.status !== WORK_UNIT_STATUS.DONE || !unit.scope?.length) continue;
      pending.push({ index, fingerprint: snapshot(base, unit.scope) });
    }
    if (!pending.length) return false;

    const classify = inject.scopePathAuthority ?? scopePathAuthority;
    for (const update of pending) {
      const unit = state.work_units[update.index];
      if (!unit?.scope) return false;
      const reviewedFingerprint: Record<string, string | null> = {};
      for (const rel of unit.scope) {
        const authority = classify(base, rel);
        if (authority === "ignored") continue;
        if (driftCheckpoint && (authority === "untracked" || authority === "error")) return false;
        reviewedFingerprint[rel] = update.fingerprint[rel] ?? null;
      }
      update.fingerprint = reviewedFingerprint;
    }

    if (driftCheckpoint) {
      const finalSha = headSha(base);
      if (finalSha !== sha || !/^[0-9a-f]{40}$/i.test(finalSha) || !worktreeClean(base)) {
        return false;
      }
    }

    const nextState = structuredClone(state);
    for (const update of pending) {
      const unit = nextState.work_units[update.index];
      if (!unit) return false;
      unit.impl_fingerprint = update.fingerprint;
      unit.verified_sha = sha;
    }
    (inject.write ?? writeState)(base, nextState);
    for (const update of pending) {
      const unit = state.work_units[update.index];
      if (!unit) continue;
      unit.impl_fingerprint = update.fingerprint;
      unit.verified_sha = sha;
    }
    return true;
  } catch {
    return false;
  }
}
