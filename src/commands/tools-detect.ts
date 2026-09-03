// `vf verify` + `detectToolchain` — engine/toolchain detection. Pure detection: no MCP, no installs.

import { spawnSync as _spawnSync } from "node:child_process";
import { ENGINES, type Engine } from "../core.js";
import { type OwnedAiRouteRunner, runOwnedAiRoute } from "../dispatch/owned-ai-route.js";
import { checkReviewEvidence, defaultGit } from "../hooks/review-evidence.js";
import {
  verifyLockMirrorCompleteness,
  verifyRegistryLockIntegrity,
} from "../skills/verify-lock.js";
import {
  type GoalEvaluation,
  type VerifyCoreReport,
  evaluateVerifyCore,
  gateResult,
  persistImplementationFingerprints,
} from "../verify/core.js";
import { CAPABILITY_DESIGN_PATH } from "../verify/normative-matrix-source.js";
import { checkNormativeMatrix } from "../verify/normative-matrix.js";
import {
  type NormativeAsyncSpawner,
  defaultNormativeAsyncSpawner,
  runNormativeProofsAsync,
} from "../verify/normative-proof-run-async.js";
import type { NormativeProofRunV2 } from "../verify/normative-proof-run.js";
import { VERIFY_RUNTIME_AUTHORITY } from "../verify/runtime-authority.js";
import {
  e2eEvaluateDynamicImportWarning,
  e2eUnicodeSelectorWarning,
  existsSync,
  hasCommand,
  join,
  readFileSync,
  readState,
  writeFileSafe,
} from "./_shared.js";
import { buildReviewerPrompt } from "./orchestrate-reviewer.js";
/** Current git HEAD sha for `base`, or "HEAD" when git unavailable. Used as diff base for Type-B drift detection. */
function readVerifiedSha(base: string): string {
  const r = _spawnSync("git", ["rev-parse", "HEAD"], { cwd: base, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : "HEAD";
}

/** #624 Task 3a: machine-readable marker the Stop-gate reads to know a full
 *  `vf verify` passed for the current commit. Written under .vibeflow/ (gitignored,
 *  so the read-only #154 invariant holds — git tree stays clean). */
const LAST_VERIFY_REL = join(".vibeflow", "last-verify.json");

export interface LastVerify {
  sha: string;
  passed: boolean;
  at: string;
}

/** Read the last-verify marker, or null when absent/garbage. */
export function readLastVerify(base: string): LastVerify | null {
  const p = join(base, LAST_VERIFY_REL);
  if (!existsSync(p)) return null;
  try {
    const o = JSON.parse(readFileSync(p, "utf8")) as Partial<LastVerify>;
    if (typeof o.sha === "string" && typeof o.passed === "boolean" && typeof o.at === "string") {
      return { sha: o.sha, passed: o.passed, at: o.at };
    }
  } catch {
    /* corrupt marker → treat as absent */
  }
  return null;
}

/** Stamp the last-verify marker. Best-effort: never fail verify on IO. */
export function stampLastVerify(base: string, passed: boolean): boolean {
  try {
    const marker: LastVerify = {
      sha: readVerifiedSha(base),
      passed,
      at: new Date().toISOString(),
    };
    writeFileSafe(join(base, LAST_VERIFY_REL), JSON.stringify(marker, null, 2));
    return true;
  } catch {
    /* marker is advisory bookkeeping — never block verify on it */
    return false;
  }
}

/** #545: parse a reviewer-declared calibrated score (`SCORE: 0.NN`, P(goal met))
 *  from the judge output. The contract is a TRAILING `SCORE:` line, so LAST wins
 *  (earlier prose mentioning "score:" must not shadow the verdict). The tail is
 *  anchored so trailing junk (e.g. `5e-1`) REJECTS rather than truncating to `5`
 *  and inflating to 1.0. Clamps to [0,1]; returns undefined when absent or
 *  malformed so the signal FAILS OPEN (never hardens a green path). */
export function parseGoalScore(raw: string): number | undefined {
  const matches = [...raw.matchAll(/^\s*score:\s*(-?(?:\d+(?:\.\d+)?|\.\d+))\s*$/gim)];
  const m = matches.at(-1);
  if (!m || m[1] === undefined) return undefined;
  const n = Number(m[1]);
  if (!Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
}

/** ADR-003 phase 2: real LLM eval via VIBEFLOW_AI bridge. Fail-open when bridge not set. */
export async function defaultGoalEvalFn(
  goal: string,
  inject: {
    gitSpawn?: typeof _spawnSync;
    ownedRoute?: OwnedAiRouteRunner;
    engine?: Engine;
    cwd?: string;
  } = {},
): Promise<{ covered: boolean; uncovered: string[]; score?: number }> {
  const gitSpawn = inject.gitSpawn ?? _spawnSync;
  const cwd = inject.cwd ?? process.cwd();
  const diff = (() => {
    try {
      const r = gitSpawn("git", ["diff", "HEAD~1", "HEAD", "--stat"], {
        encoding: "utf8",
        cwd,
      });
      return (r.stdout ?? "").slice(0, 3000);
    } catch {
      return "";
    }
  })();
  const prompt = buildReviewerPrompt({ goal, diff: diff || "(no diff available)" });
  const bridge = process.env.VIBEFLOW_AI;
  if (!bridge) return { covered: true, uncovered: [] };
  try {
    const configured = process.env.VF_REVIEW_ENGINE;
    const engine =
      inject.engine ??
      ((configured && (ENGINES as readonly string[]).includes(configured)
        ? configured
        : ENGINES[0]) as Engine);
    const r = await (inject.ownedRoute ?? runOwnedAiRoute)({
      engine,
      command: bridge,
      input: prompt,
      cwd,
      shell: true,
      timeoutMs: 30_000,
    });
    if (r.status !== 0) return { covered: true, uncovered: [] };
    const raw = r.stdout.trim();
    const covered = /^COVERED/i.test(raw);
    return { covered, uncovered: covered ? [] : [raw.slice(0, 500)], score: parseGoalScore(raw) };
  } catch {
    return { covered: true, uncovered: [] };
  }
}

/** Plan which toolchain gates `vf verify` should run, by detecting the project's build system.
 * Pure + injectable (exists/readScripts) so it's testable without a real filesystem. */
export type ToolchainPlan =
  | { kind: "npm"; runner: string; gates: string[] }
  | { kind: "gradle"; cmd: string }
  | { kind: "flutter"; cmd: string; gates: string[] }
  | { kind: "monorepo"; runner: string; dir: string; gates: string[] }
  | { kind: "none" };

export function detectToolchain(
  base: string,
  opts: {
    exists?: (p: string) => boolean;
    readScripts?: (p: string) => string[];
    runner?: string;
  } = {},
): ToolchainPlan {
  const exists = opts.exists ?? existsSync;
  const runner = opts.runner ?? (hasCommand("bun") ? "bun" : "npm");
  const readScripts =
    opts.readScripts ??
    ((p: string) =>
      Object.keys(
        (JSON.parse(readFileSync(p, "utf8")) as { scripts?: Record<string, string> }).scripts ?? {},
      ));
  const root = join(base, "package.json");
  if (exists(root)) {
    const gates = readScripts(root).filter((s) => ["typecheck", "lint", "test"].includes(s));
    return { kind: "npm", runner, gates };
  }
  if (
    ["build.gradle.kts", "build.gradle", "settings.gradle.kts"].some((f) => exists(join(base, f)))
  ) {
    return { kind: "gradle", cmd: exists(join(base, "gradlew")) ? "./gradlew" : "gradle" };
  }
  if (exists(join(base, "pubspec.yaml"))) {
    return { kind: "flutter", cmd: "flutter", gates: ["test"] };
  }
  for (const d of ["web", "app", "frontend"]) {
    const p = join(base, d, "package.json");
    if (exists(p)) {
      const gates = readScripts(p).filter((s) =>
        ["typecheck", "lint", "test", "build"].includes(s),
      );
      return { kind: "monorepo", runner, dir: join(base, d), gates };
    }
  }
  return { kind: "none" };
}

/** Full authoritative report. The legacy toolchain/policy fields remain as compatibility views. */
export type VerifyReport = VerifyCoreReport;

/** Async helper: runs toolchain + policy gates and returns a structured report.
 * REQUIRED by POST /api/verify — the sync spawnSync version freezes Bun.serve (the whole
 * server, incl. SSE + /state, hangs ~60s while typecheck/lint/test run, then can die on
 * idleTimeout=0). This awaits each gate via async spawn so other requests keep flowing.
 * Injectable async spawner for tests. */
export async function collectVerifyReportAsync(
  base: string,
  inject: {
    spawner?: NormativeAsyncSpawner;
    coverage?: boolean;
    goal?: string; // ADR-003
    goalEvalFn?: (
      goal: string,
    ) => Promise<{ covered: boolean; uncovered: string[]; score?: number }>; // ADR-003
    allowUnverifiedEvidence?: boolean; // ADR-004 escape hatch
    requireReviewEvidence?: boolean;
    reviewBase?: string; // #748: pushed-range fallback base
    catalogDir?: string;
    normativeProofRun?: NormativeProofRunV2;
  } = {},
): Promise<VerifyReport> {
  const toolchain: { label: string; pass: boolean }[] = [];
  const run: NormativeAsyncSpawner = inject.spawner ?? defaultNormativeAsyncSpawner;

  const runGate = async (label: string, cmd: string, args: string[], dir = base) => {
    const r = await run(cmd, args, {
      stdio: "ignore",
      cwd: dir,
      timeout: VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs,
    });
    const result = { label, pass: r.status === 0 };
    toolchain.push(result);
    return result;
  };

  const plan = detectToolchain(base);
  if (plan.kind === "npm") {
    for (const gate of plan.gates)
      await runGate(`${plan.runner} run ${gate}`, plan.runner, ["run", gate]);
  } else if (plan.kind === "gradle") {
    await runGate(`${plan.cmd} check`, plan.cmd, ["check"]);
  } else if (plan.kind === "flutter") {
    for (const gate of plan.gates) await runGate(`${plan.cmd} ${gate}`, plan.cmd, [gate]);
  } else if (plan.kind === "monorepo") {
    const label = plan.dir.split(/[/\\]/).pop() ?? plan.dir;
    for (const gate of plan.gates)
      await runGate(`(${label}) ${plan.runner} run ${gate}`, plan.runner, ["run", gate], plan.dir);
  }

  let coverageResult = gateResult("skipped", "coverage gate not requested");
  let legacyCoverage: { label: string; pass: boolean } | undefined;
  if (inject.coverage) {
    const lcovPath = join(base, "coverage", "lcov.info");
    if (existsSync(lcovPath)) {
      legacyCoverage = await runGate("coverage:gate", "node", ["scripts/coverage-gate.cjs"]);
      toolchain.pop();
      coverageResult = gateResult(
        legacyCoverage.pass ? "pass" : "fail",
        legacyCoverage.pass ? "coverage gate passed" : "coverage gate failed",
      );
    } else coverageResult = gateResult("fail", "coverage/lcov.info not found");
  }

  const rawState = readState(base);
  let goalEval: GoalEvaluation | undefined;
  if (
    inject.goal &&
    inject.goalEvalFn &&
    toolchain.every((gate) => gate.pass) &&
    coverageResult.status !== "fail"
  ) {
    const result = await inject.goalEvalFn(inject.goal);
    goalEval = { pass: result.covered, uncovered: result.uncovered, score: result.score };
  }
  let waiverResult = gateResult("skipped", "waiver-policy.cjs not found");
  if (existsSync(join(base, "scripts", "waiver-policy.cjs"))) {
    const result = await run("node", ["scripts/waiver-policy.cjs"], {
      stdio: "ignore",
      cwd: base,
      timeout: VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs,
    });
    waiverResult = gateResult(
      result.status === 0 ? "pass" : "fail",
      result.status === 0 ? "waiver policy passed" : "waiver policy failed",
    );
  }
  const lock = verifyRegistryLockIntegrity(base);
  const mirror = verifyLockMirrorCompleteness(base, { catalogDir: inject.catalogDir });
  const registryFailures = [...lock.errors, ...mirror.errors];
  const registryWarnings = [...lock.warnings, ...mirror.warnings];
  const registryResult = registryFailures.length
    ? gateResult("fail", registryFailures.join("\n"))
    : registryWarnings.length
      ? gateResult("warn", registryWarnings.join("\n"))
      : gateResult("pass", "registry lock integrity and mirror completeness passed");
  const review = checkReviewEvidence(
    base,
    inject.requireReviewEvidence !== false,
    defaultGit,
    inject.reviewBase,
  );
  const reviewResult = gateResult(
    review.ok ? (review.reason.includes("(warn)") ? "warn" : "pass") : "fail",
    review.reason,
  );
  let normativeProofRun = inject.normativeProofRun;
  if (!normativeProofRun && existsSync(join(base, CAPABILITY_DESIGN_PATH))) {
    normativeProofRun = await runNormativeProofsAsync(base, { spawner: run });
  }
  const normative = checkNormativeMatrix(base, { proofRun: normativeProofRun });
  const e2eWarnings = [
    ...e2eUnicodeSelectorWarning(base),
    ...e2eEvaluateDynamicImportWarning(base),
  ];
  const report = evaluateVerifyCore({
    base,
    state: rawState,
    toolchain,
    allowUnverifiedEvidence: inject.allowUnverifiedEvidence,
    coverage: coverageResult,
    waiver: waiverResult,
    registryLock: registryResult,
    reviewEvidence: reviewResult,
    normativeMatrix: gateResult(
      !normative.applicable ? "skipped" : normative.ok ? "pass" : "fail",
      normative.details,
      normative.evidence_refs,
    ),
    advisoryE2e: e2eWarnings.length
      ? gateResult("warn", e2eWarnings.join("\n"))
      : gateResult("pass", "advisory E2E scan passed"),
    ...(goalEval ? { goalEval } : {}),
  });
  persistImplementationFingerprints(base, rawState, report);
  if (legacyCoverage) report.toolchain.push(legacyCoverage);
  return report;
}
