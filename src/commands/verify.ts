// `vf verify` synchronous CLI gates. Kept separate from async server reporting
// so sandbox execution can grow here without pushing tools-detect.ts over its cap.

import { appendReviewEvidence } from "../hooks/review-evidence-gate.js";
import {
  type SandboxRequest,
  type SandboxRuntime,
  buildDockerGateCommand,
  defaultSandboxRuntime,
  prepareDockerSandbox,
} from "../sandbox.js";
import {
  appendJournal,
  c,
  cwd,
  e2eEvaluateDynamicImportWarning,
  e2eUnicodeSelectorWarning,
  existsSync,
  join,
  out,
  policyGates,
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
  } = {},
): number {
  let failed = 0;
  const base = inject.projectDir ?? cwd();
  const sandboxRuntime = inject.sandboxRuntime ?? defaultSandboxRuntime();
  const sandbox = inject.sandbox
    ? prepareDockerSandbox(inject.sandbox, base, sandboxRuntime)
    : undefined;
  if (sandbox && !sandbox.ok) {
    out("vf", c.red(`✗ ${sandbox.message}`), { level: "error" });
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
        timeout: 300000,
      });
      if (sandbox?.ok && r.status === null)
        sandboxRuntime.run(["rm", "-f", sandbox.spec.containerName], base);
      if (r.status !== 0) {
        failed++;
        out("vf", c.red(`✗ ${label} failed`));
      } else {
        out("vf", c.green(`✓ ${label}`));
      }
    };

    // Toolchain gates — detect the project's build system instead of assuming npm.
    const plan = detectToolchain(base);
    if (plan.kind === "npm") {
      for (const gate of plan.gates)
        runGate(`${plan.runner} run ${gate}`, plan.runner, ["run", gate]);
      if (plan.gates.length === 0)
        out("vf", c.dim("package.json has no typecheck/lint/test scripts."));
    } else if (plan.kind === "gradle") {
      runGate(`${plan.cmd} check`, plan.cmd, ["check"]);
    } else if (plan.kind === "flutter") {
      for (const gate of plan.gates) runGate(`${plan.cmd} ${gate}`, plan.cmd, [gate]);
    } else if (plan.kind === "monorepo") {
      const label = plan.dir.split(/[/\\]/).pop() ?? plan.dir;
      for (const gate of plan.gates)
        runGate(`(${label}) ${plan.runner} run ${gate}`, plan.runner, ["run", gate], plan.dir);
    } else {
      out(
        "vf",
        c.yellow(
          "⚠ no package.json or Gradle build found — skipping toolchain gates (unsupported build system)",
        ),
      );
    }

    // Policy gates (confidence / evidence / scope) over the workflow ledger.
    const st = readState(base);
    if (inject.allowUnverifiedEvidence && st) st._allowUnverifiedEvidence = true;
    const report = policyGates(st);
    // #764: hard by default; explicit false is an internal/test escape hatch.
    appendReviewEvidence(report, base, inject.requireReviewEvidence !== false, inject.reviewBase);
    printVerifyReport(report);
    failed += report.failures.length;

    if (inject.coverage) {
      const lcovPath = join(base, "coverage", "lcov.info");
      if (existsSync(lcovPath)) runGate("coverage gate", "node", ["scripts/coverage-gate.cjs"]);
      else out("vf", c.yellow("⚠ coverage/lcov.info not found — run `bun run coverage` first"));
    }

    // Waiver policy gate — validate declaration metadata and expiry (issue #679).
    if (sandbox?.ok) {
      if (existsSync(join(base, "scripts", "waiver-policy.cjs")))
        runGate("waiver policy gate", "node", ["scripts/waiver-policy.cjs"]);
      else out("vf", c.dim("⚠ waiver-policy.cjs not found — skipping"));
    } else if (!runWaiverGate(base, { spawner: inject.spawner })) failed++;

    // e2e advisory gates — non-fatal warnings only.
    for (const w of e2eUnicodeSelectorWarning(base)) out("vf", c.yellow(`⚠ ${w}`));
    for (const w of e2eEvaluateDynamicImportWarning(base)) out("vf", c.yellow(`⚠ ${w}`));

    // Registry lock integrity + mirror completeness (issue #654).
    // Normal repos without a lock file pass silently.
    failed += verifyLockGate(base, { catalogDir: inject.catalogDir }).failed;

    if (failed > 0) {
      out("vf");
      out("vf", c.red(`${failed} gate(s) failed.`), { level: "error" });
      stampLastVerify(base, false);
      if (writeJournal) {
        appendJournal(base, "verify", "fail", [
          `${failed} gate(s) failed`,
          ...report.failures.map((f) => `- ${f}`),
        ]);
        autoCrystallizeAndReport(base);
      }
      return 1;
    }
    out("vf");
    out("vf", c.green("All configured gates passed."));
    stampLastVerify(base, true);
    if (writeJournal) {
      appendJournal(base, "verify", "pass", [
        `${report.passed.length} gate(s) passed`,
        ...(report.warnings.length ? [`${report.warnings.length} warning(s)`] : []),
      ]);
      autoCrystallizeAndReport(base);
    }
    return 0;
  } finally {
    cleanup();
  }
}
