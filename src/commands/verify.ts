// `vf verify` synchronous CLI gates. Kept separate from async server reporting
// so sandbox execution can grow here without pushing tools-detect.ts over its cap.

import { checkReviewEvidence, defaultGit } from "../hooks/review-evidence.js";
import {
  type SandboxRequest,
  type SandboxRuntime,
  buildDockerGateCommand,
  defaultSandboxRuntime,
  prepareDockerSandbox,
} from "../sandbox.js";
import {
  evaluateVerifyCore,
  gateResult,
  persistImplementationFingerprints,
} from "../verify/core.js";
import { CAPABILITY_DESIGN_PATH } from "../verify/normative-matrix-source.js";
import { checkNormativeMatrix } from "../verify/normative-matrix.js";
import { type NormativeProofRunV2, runNormativeProofs } from "../verify/normative-proof-run.js";
import { VERIFY_RUNTIME_AUTHORITY } from "../verify/runtime-authority.js";
import {
  appendJournal,
  c,
  cwd,
  e2eEvaluateDynamicImportWarning,
  e2eUnicodeSelectorWarning,
  existsSync,
  join,
  out,
  readState,
  spawnSync,
  verifyLockGate,
} from "./_shared.js";
import { detectToolchain, stampLastVerify } from "./tools-detect.js";
import { autoCrystallizeAndReport, printVerifyReport } from "./verify-report.js";
import { runWaiverGate } from "./waiver-gate.js";

export function verify(
  inject: {
    spawner?: typeof spawnSync;
    journal?: boolean;
    coverage?: boolean;
    allowUnverifiedEvidence?: boolean;
    requireReviewEvidence?: boolean;
    reviewBase?: string; // #748
    projectDir?: string;
    catalogDir?: string;
    sandbox?: SandboxRequest;
    sandboxRuntime?: SandboxRuntime;
    normativeProofRun?: NormativeProofRunV2;
  } = {},
): number {
  const base = inject.projectDir ?? cwd();
  const sandboxRuntime = inject.sandboxRuntime ?? defaultSandboxRuntime();
  const sandbox = inject.sandbox
    ? prepareDockerSandbox(inject.sandbox, base, sandboxRuntime)
    : undefined;
  if (sandbox && !sandbox.ok) {
    out("vf", c.red(`✗ ${sandbox.message}`), { level: "error" });
    evaluateVerifyCore({
      base,
      state: readState(base),
      toolchain: [],
      sandbox: gateResult("fail", sandbox.message),
      reviewEvidence: gateResult("skipped", "verification stopped before review evidence"),
    });
    return 1;
  }
  const writeJournal = inject.journal === true;
  let cleaned = false;
  const cleanup = () => {
    if (cleaned || !sandbox?.ok) return;
    cleaned = true;
    sandbox.cleanup();
  };
  try {
    const toolchain: { label: string; pass: boolean }[] = [];
    const runGate = (label: string, cmd: string, args: string[], dir = base) => {
      out("vf", c.cyan(`▶ ${label}`));
      // Test seam: tests inject a fake spawner to avoid the 28s
      // gradle download on CI. Production callers fall through to
      // the real spawnSync.
      const wrapped = sandbox?.ok
        ? buildDockerGateCommand(cmd, args, sandbox.spec, base, dir)
        : { cmd, args };
      const r = (inject.spawner ?? spawnSync)(wrapped.cmd, wrapped.args, {
        stdio: "pipe",
        cwd: sandbox?.ok ? sandbox.spec.target : dir,
        timeout: VERIFY_RUNTIME_AUTHORITY.gateTimeoutMs,
      });
      if (sandbox?.ok && r.status === null)
        sandboxRuntime.run(["rm", "-f", sandbox.spec.containerName], base);
      if (r.status !== 0) {
        out("vf", c.red(`✗ ${label} failed`));
      } else {
        out("vf", c.green(`✓ ${label}`));
      }
      return r.status === 0;
    };

    // Toolchain gates — detect the project's build system instead of assuming npm.
    const plan = detectToolchain(base);
    if (plan.kind === "npm") {
      for (const gate of plan.gates) {
        const label = `${plan.runner} run ${gate}`;
        toolchain.push({ label, pass: runGate(label, plan.runner, ["run", gate]) });
      }
      if (plan.gates.length === 0)
        out("vf", c.dim("package.json has no typecheck/lint/test scripts."));
    } else if (plan.kind === "gradle") {
      const label = `${plan.cmd} check`;
      toolchain.push({ label, pass: runGate(label, plan.cmd, ["check"]) });
    } else if (plan.kind === "flutter") {
      for (const gate of plan.gates) {
        const label = `${plan.cmd} ${gate}`;
        toolchain.push({ label, pass: runGate(label, plan.cmd, [gate]) });
      }
    } else if (plan.kind === "monorepo") {
      const label = plan.dir.split(/[/\\]/).pop() ?? plan.dir;
      for (const gate of plan.gates) {
        const gateLabel = `(${label}) ${plan.runner} run ${gate}`;
        toolchain.push({
          label: gateLabel,
          pass: runGate(gateLabel, plan.runner, ["run", gate], plan.dir),
        });
      }
    } else {
      out(
        "vf",
        c.yellow(
          "⚠ no package.json or Gradle build found — skipping toolchain gates (unsupported build system)",
        ),
      );
    }

    const st = readState(base);
    let coverageResult = gateResult("skipped", "coverage gate not requested");
    if (inject.coverage) {
      const lcovPath = join(base, "coverage", "lcov.info");
      if (existsSync(lcovPath)) {
        const pass = runGate("coverage gate", "node", ["scripts/coverage-gate.cjs"]);
        coverageResult = gateResult(
          pass ? "pass" : "fail",
          `coverage gate ${pass ? "passed" : "failed"}`,
        );
      } else {
        coverageResult = gateResult("fail", "coverage/lcov.info not found");
        out("vf", c.red("✗ coverage/lcov.info not found — run `bun run coverage` first"));
      }
    }

    let waiverResult = gateResult("skipped", "waiver-policy.cjs not found");
    if (sandbox?.ok) {
      if (existsSync(join(base, "scripts", "waiver-policy.cjs"))) {
        const pass = runGate("waiver policy gate", "node", ["scripts/waiver-policy.cjs"]);
        waiverResult = gateResult(
          pass ? "pass" : "fail",
          `waiver policy ${pass ? "passed" : "failed"}`,
        );
      } else out("vf", c.dim("⚠ waiver-policy.cjs not found — skipping"));
    } else if (existsSync(join(base, "scripts", "waiver-policy.cjs"))) {
      const pass = runWaiverGate(base, { spawner: inject.spawner });
      waiverResult = gateResult(
        pass ? "pass" : "fail",
        `waiver policy ${pass ? "passed" : "failed"}`,
      );
    } else runWaiverGate(base, { spawner: inject.spawner });

    const e2eWarnings = [
      ...e2eUnicodeSelectorWarning(base),
      ...e2eEvaluateDynamicImportWarning(base),
    ];
    for (const warning of e2eWarnings) out("vf", c.yellow(`⚠ ${warning}`));

    const lock = verifyLockGate(base, { catalogDir: inject.catalogDir });
    const review = checkReviewEvidence(
      base,
      inject.requireReviewEvidence !== false,
      defaultGit,
      inject.reviewBase,
    );
    let normativeProofRun = inject.normativeProofRun;
    if (!normativeProofRun && existsSync(join(base, CAPABILITY_DESIGN_PATH))) {
      out("vf", c.cyan("▶ exact normative proof run"));
      normativeProofRun = runNormativeProofs(base, { spawner: inject.spawner });
      const proofPassed =
        normativeProofRun.errors.length === 0 &&
        normativeProofRun.proofs.length > 0 &&
        normativeProofRun.proofs.every((proof) => proof.executed && proof.status === "passed");
      out(
        "vf",
        proofPassed
          ? c.green("✓ exact normative proofs")
          : c.red("✗ exact normative proofs failed"),
      );
    }
    const normative = checkNormativeMatrix(base, { proofRun: normativeProofRun });
    const report = evaluateVerifyCore({
      base,
      state: st,
      toolchain,
      allowUnverifiedEvidence: inject.allowUnverifiedEvidence,
      coverage: coverageResult,
      sandbox: sandbox?.ok
        ? gateResult("pass", "sandbox prepared and gate commands isolated")
        : gateResult("skipped", "sandbox not requested"),
      waiver: waiverResult,
      registryLock: gateResult(
        lock.failed ? "fail" : "pass",
        lock.failed
          ? "registry lock integrity or mirror completeness failed"
          : "registry lock integrity and mirror completeness passed",
      ),
      reviewEvidence: gateResult(
        review.ok ? (review.reason.includes("(warn)") ? "warn" : "pass") : "fail",
        review.reason,
      ),
      normativeMatrix: gateResult(
        !normative.applicable ? "skipped" : normative.ok ? "pass" : "fail",
        normative.details,
        normative.evidence_refs,
      ),
      advisoryE2e: e2eWarnings.length
        ? gateResult("warn", e2eWarnings.join("\n"))
        : gateResult("pass", "advisory E2E scan passed"),
    });
    printVerifyReport(report.policy);
    out("vf", c.dim(`confidence: ${report.confidence}`));

    persistImplementationFingerprints(base, st, report);

    if (!report.ok) {
      out("vf");
      const failed = Object.values(report.gates).filter((gate) => gate.status === "fail").length;
      out("vf", c.red(`${failed} gate(s) failed.`), { level: "error" });
      report.gates.marker_result = gateResult(
        stampLastVerify(base, false) ? "pass" : "warn",
        "failure marker write attempted",
      );
      if (writeJournal) {
        appendJournal(base, "verify", "fail", [
          `${failed} gate(s) failed`,
          ...report.policy.failures.map((failure) => `- ${failure}`),
        ]);
        report.gates.journal_result = gateResult("pass", "failure journal appended");
        autoCrystallizeAndReport(base);
      }
      return 1;
    }
    out("vf");
    out("vf", c.green("All configured gates passed."));
    report.gates.marker_result = gateResult(
      stampLastVerify(base, true) ? "pass" : "warn",
      "passing marker write attempted",
    );
    if (writeJournal) {
      appendJournal(base, "verify", "pass", [
        `${report.policy.passed.length} gate(s) passed`,
        ...(report.policy.warnings.length ? [`${report.policy.warnings.length} warning(s)`] : []),
      ]);
      report.gates.journal_result = gateResult("pass", "passing journal appended");
      autoCrystallizeAndReport(base);
    }
    return 0;
  } finally {
    cleanup();
  }
}
