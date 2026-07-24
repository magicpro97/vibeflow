// `vf verify` + `detectToolchain` — engine/toolchain detection extracted from
// src/commands/tools.ts (issue #136, split-tools). Pure detection logic: no MCP
// config, no tool installs. All imports through `./_shared.js`.

import { spawnSync as _spawnSync } from "node:child_process";
import { writeState } from "../core.js";
import { snapshotImpl } from "../spec-freshness.js";
import {
  appendJournal,
  autoCrystallizeRun,
  c,
  cwd,
  e2eEvaluateDynamicImportWarning,
  e2eUnicodeSelectorWarning,
  existsSync,
  hasCommand,
  join,
  out,
  policyGates,
  readFileSync,
  readState,
  spawn,
  spawnSync,
  verifyLockGate,
  writeFileSafe,
} from "./_shared.js";
import { buildReviewerPrompt } from "./orchestrate-reviewer.js";

/** The current git HEAD sha for `base`, or "HEAD" when git is unavailable.
 *  Used as the diff base for Type-B drift detection at the next verify. */
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
function stampLastVerify(base: string, passed: boolean): void {
  try {
    const marker: LastVerify = {
      sha: readVerifiedSha(base),
      passed,
      at: new Date().toISOString(),
    };
    writeFileSafe(join(base, LAST_VERIFY_REL), JSON.stringify(marker, null, 2));
  } catch {
    /* marker is advisory bookkeeping — never block verify on it */
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
  _spawn = _spawnSync,
): Promise<{ covered: boolean; uncovered: string[]; score?: number }> {
  const diff = (() => {
    try {
      const r = _spawn("git", ["diff", "HEAD~1", "HEAD", "--stat"], {
        encoding: "utf8",
        cwd: process.cwd(),
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
    const parts = bridge.split(" ");
    const r = _spawn(parts[0] ?? "", [...parts.slice(1), prompt], {
      encoding: "utf8",
      timeout: 30000,
    });
    const raw = (r.stdout ?? "").trim();
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

/** Structured report shape returned by collectVerifyReportAsync.
 * Consumed by POST /api/verify (B1). The CLI verify() prints its own stdout
 * and does NOT consume this type. */
export interface VerifyReport {
  ok: boolean;
  toolchain: { label: string; pass: boolean }[];
  policy: { passed: string[]; warnings: string[]; failures: string[] };
  /** ADR-003: behavioral goal-eval result. Only present when goal + goalEvalFn provided AND toolchain passes. */
  goalEval?: { pass: boolean; uncovered: string[]; score?: number };
}

/** Async helper: runs toolchain + policy gates and returns a structured report.
 * REQUIRED by POST /api/verify — the sync spawnSync version freezes Bun.serve (the whole
 * server, incl. SSE + /state, hangs ~60s while typecheck/lint/test run, then can die on
 * idleTimeout=0). This awaits each gate via async spawn so other requests keep flowing.
 * Injectable async spawner for tests. */
export async function collectVerifyReportAsync(
  base: string,
  inject: {
    spawner?: (cmd: string, args: string[], opts: object) => Promise<{ status: number | null }>;
    coverage?: boolean;
    goal?: string; // ADR-003
    goalEvalFn?: (
      goal: string,
    ) => Promise<{ covered: boolean; uncovered: string[]; score?: number }>; // ADR-003
    allowUnverifiedEvidence?: boolean; // ADR-004 escape hatch
  } = {},
): Promise<VerifyReport> {
  const toolchain: { label: string; pass: boolean }[] = [];
  const run =
    inject.spawner ??
    ((cmd: string, args: string[], opts: object): Promise<{ status: number | null }> =>
      new Promise((resolve) => {
        const child = spawn(cmd, args, opts as object);
        child.on("close", (code: number | null) => resolve({ status: code }));
        child.on("error", () => resolve({ status: 1 }));
      }));

  const runGate = async (label: string, cmd: string, args: string[], dir = base) => {
    const r = await run(cmd, args, { stdio: "ignore", cwd: dir });
    toolchain.push({ label, pass: r.status === 0 });
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

  if (inject.coverage) {
    const lcovPath = join(base, "coverage", "lcov.info");
    if (existsSync(lcovPath)) {
      await runGate("coverage:gate", "node", ["scripts/coverage-gate.cjs"]);
    }
  }

  const rawState = readState(base);
  if (inject.allowUnverifiedEvidence && rawState) rawState._allowUnverifiedEvidence = true;
  const policy = policyGates(rawState, { base });
  const ok = toolchain.every((g) => g.pass) && policy.failures.length === 0;

  // Type B drift PRODUCER: when the toolchain gates are all green, fingerprint
  // each done unit's scoped files + record the verified git SHA, so a LATER
  // verify can detect an out-of-pipeline edit (impl drift). Without this write
  // the Type B gate stays silent (impl_fingerprint never set). Best-effort:
  // a snapshot/persist failure must never fail an otherwise-passing verify.
  if (ok && rawState?.work_units?.length) {
    try {
      const sha = readVerifiedSha(base);
      let changed = false;
      for (const u of rawState.work_units) {
        if (u.status !== "done" || !u.scope?.length) continue;
        u.impl_fingerprint = snapshotImpl(base, u.scope);
        u.verified_sha = sha;
        changed = true;
      }
      if (changed) writeState(base, rawState);
    } catch {
      // never block a green verify on the drift-snapshot bookkeeping.
    }
  }

  // ADR-003: behavioral goal-eval gate (stub — wire real LLM via --goal-eval flag in phase 2)
  if (inject.goal && inject.goalEvalFn && toolchain.every((g) => g.pass)) {
    const result = await inject.goalEvalFn(inject.goal);
    const goalEvalOk = result.covered;
    return {
      ok: ok && goalEvalOk,
      toolchain,
      policy,
      goalEval: { pass: result.covered, uncovered: result.uncovered, score: result.score },
    };
  }
  return { ok, toolchain, policy };
}

export function verify(
  inject: {
    spawner?: typeof spawnSync;
    journal?: boolean;
    coverage?: boolean;
    allowUnverifiedEvidence?: boolean;
  } = {},
): number {
  let failed = 0;
  const base = cwd();
  const writeJournal = inject.journal === true;
  const runGate = (label: string, cmd: string, args: string[], dir = base) => {
    out("vf", c.cyan(`▶ ${label}`));
    // Test seam: tests inject a fake spawner to avoid the 28s
    // gradle download on CI. Production callers fall through to
    // the real spawnSync.
    const r = (inject.spawner ?? spawnSync)(cmd, args, { stdio: "pipe", cwd: dir });
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
  const st = readState();
  if (inject.allowUnverifiedEvidence && st) st._allowUnverifiedEvidence = true;
  const report = policyGates(st);
  for (const ok of report.passed) out("vf", c.green(`✓ ${ok}`));
  for (const w of report.warnings) out("vf", c.yellow(`⚠ ${w}`));
  for (const f of report.failures) {
    failed++;
    out("vf", c.red(`✗ ${f}`));
  }

  if (inject.coverage) {
    const lcovPath = join(base, "coverage", "lcov.info");
    if (existsSync(lcovPath)) {
      const cov = spawnSync("node", ["scripts/coverage-gate.cjs"], { stdio: "pipe", cwd: base });
      if (cov.status !== 0) {
        failed++;
        out("vf", c.red("✗ coverage gate failed"));
      } else {
        out("vf", c.green("✓ coverage gate"));
      }
    } else {
      out("vf", c.yellow("⚠ coverage/lcov.info not found — run `bun run coverage` first"));
    }
  }

  // e2e advisory gates — non-fatal warnings only.
  for (const w of e2eUnicodeSelectorWarning(base)) out("vf", c.yellow(`⚠ ${w}`));
  for (const w of e2eEvaluateDynamicImportWarning(base)) out("vf", c.yellow(`⚠ ${w}`));

  // Registry lock integrity + mirror completeness (issue #654).
  // Normal repos without a lock file pass silently.
  failed += verifyLockGate(base).failed;

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
}

/** Auto-crystallize verify run patterns into a DRAFT skill */
function autoCrystallizeAndReport(base: string): void {
  const cz = autoCrystallizeRun(base, `verify-${new Date().toISOString().slice(0, 10)}`);
  if (cz.drafted) {
    out(
      "vf",
      c.green(
        `+ drafted skill ${cz.draftName} (${cz.patternCount} pattern(s)) — DRAFT, review before install`,
      ),
    );
  }
}
