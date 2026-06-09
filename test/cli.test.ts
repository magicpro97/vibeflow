import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { canonicalFiles, defaultContext, dispatchPrompt, engineFiles } from "../src/adapters.js";
import {
  applyIntake,
  detectRepo,
  detectToolchain,
  discover,
  doctor,
  ensureToolIndex,
  hooks,
  init,
  mutateUnits,
  resolveRepo,
  skillForFile,
  skills,
  tools,
  units,
} from "../src/commands.js";
import {
  CTX_DIR,
  ENGINES,
  type Engine,
  type WorkflowState,
  parseFlags,
  readState,
  recomputeTotals,
} from "../src/core.js";
import { policyGates } from "../src/gates.js";
import type { EngineReadiness } from "../src/preflight.js";
import { startServer } from "../src/server.js";
import {
  DEFAULT_FAILURE_PROTECTION,
  type VibeSettings,
  readSettings,
  writeSettings,
} from "../src/settings.js";

/** Injectable preflight stub: marks every requested engine ready (no real engine spawned). */
const allReady = (engines: Engine[]): EngineReadiness[] =>
  engines.map((engine) => ({
    engine,
    level: "ready",
    detail: "ready (test)",
    checkedAt: "",
  }));

/** Injectable preflight stub: marks every requested engine NOT ready (gate must refuse). */
const noneReady = (engines: Engine[]): EngineReadiness[] =>
  engines.map((engine) => ({
    engine,
    level: "no-binary",
    detail: `${engine} CLI not found`,
    checkedAt: "",
  }));

describe("core", () => {
  test("parseFlags splits positionals and flags", () => {
    const r = parseFlags(["show", "auth", "--engine", "claude", "--yes"]);
    expect(r.positionals).toEqual(["show", "auth"]);
    expect(r.flags).toEqual({ engine: "claude", yes: true });
  });

  test("recomputeTotals aggregates work units", () => {
    const s: WorkflowState = {
      task_id: "T",
      goal: "g",
      success_criteria: [],
      work_units: [
        {
          name: "a",
          status: "done",
          confidence: 1,
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
          resources: {
            agents: 1,
            tokens: 100,
            cost_usd: 0.5,
            wall_seconds: 10,
          },
        },
        {
          name: "b",
          status: "running",
          confidence: 1,
          gates: {
            build: "pass",
            lint: "pending",
            test: "pending",
            review: "pending",
          },
          resources: { agents: 1, tokens: 50, cost_usd: 0.25, wall_seconds: 5 },
        },
      ],
      totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    };
    recomputeTotals(s);
    expect(s.totals).toEqual({
      units: 2,
      done: 1,
      tokens: 150,
      cost_usd: 0.75,
      wall_seconds: 15,
    });
  });
});

describe("adapters", () => {
  test("canonical files use the .viteflow/ directory", () => {
    const files = canonicalFiles(defaultContext());
    expect(Object.keys(files).every((k) => k.startsWith(`${CTX_DIR}/`))).toBe(true);
    expect(files[`${CTX_DIR}/WORKFLOW_POLICY.md`]).toContain("No verification, no completion");
    expect(files[`${CTX_DIR}/WORKFLOW_POLICY.md`]).toContain("Tool Error & Execution Policy");
  });

  test("engine instruction files carry the Tool Error & Execution Policy", () => {
    const ctx = defaultContext();
    for (const engine of ["claude", "codex", "copilot"] as const) {
      const files = engineFiles(engine, ctx, false);
      const body = Object.values(files).join("\n");
      expect(body).toContain("Tool Error & Execution Policy");
      expect(body).toContain("retry the command up to 3 times");
    }
  });

  test("engine instruction files document VibeFlow's own commands", () => {
    const ctx = defaultContext();
    for (const engine of ["claude", "codex", "copilot"] as const) {
      const files = engineFiles(engine, ctx, false);
      const body = Object.values(files).join("\n");
      expect(body).toContain("VibeFlow commands");
      expect(body).toContain("vf verify");
      expect(body).toContain("vf units");
      expect(body).toContain("vf orchestrate");
      expect(body).toContain("vf doctor");
    }
  });

  test("engine instruction files teach the vf workflow, not just command names", () => {
    const ctx = defaultContext();
    for (const engine of ["claude", "codex", "copilot"] as const) {
      const files = engineFiles(engine, ctx, false);
      const body = Object.values(files).join("\n");
      // Workflow-narrative markers: the loop, the confidence gate, work units, dispatch.
      expect(body).toContain("Working with vf");
      expect(body).toContain("Confidence gate");
      expect(body).toContain("vf verify");
      expect(body).toContain("work unit");
      expect(body).toContain("vf orchestrate");
      // The narrative is injected once per file, not duplicated alongside the command list.
      for (const content of Object.values(files)) {
        expect(content.split("Working with vf").length - 1).toBe(1);
      }
    }
  });

  test("canonical WORKFLOW_POLICY documents VibeFlow's own commands", () => {
    const policy = canonicalFiles(defaultContext())[`${CTX_DIR}/WORKFLOW_POLICY.md`] as string;
    expect(policy).toContain("VibeFlow commands");
    expect(policy).toContain("vf verify");
    expect(policy).toContain("vf units");
    expect(policy).toContain("vf orchestrate");
  });

  test("canonical WORKFLOW_POLICY documents the knowledge write-back loop", () => {
    const policy = canonicalFiles(defaultContext())[`${CTX_DIR}/WORKFLOW_POLICY.md`] as string;
    expect(policy).toContain("log.md");
    expect(policy).toContain("index.md");
    expect(policy).toContain("append-only");
  });

  test("engine instruction files instruct knowledge write-back", () => {
    const ctx = defaultContext();
    for (const engine of ["claude", "codex", "copilot"] as const) {
      const files = engineFiles(engine, ctx, false);
      const body = Object.values(files).join("\n");
      expect(body).toContain("log.md");
      expect(body).toContain("index.md");
      expect(body).toContain("append");
    }
  });

  test("each engine produces its canonical instruction file", () => {
    const ctx = defaultContext();
    expect(Object.keys(engineFiles("claude", ctx))).toContain("CLAUDE.md");
    expect(Object.keys(engineFiles("codex", ctx))).toContain("AGENTS.md");
    const copilot = engineFiles("copilot", ctx);
    expect(Object.keys(copilot)).toContain(".github/copilot-instructions.md");
  });

  test("dispatch prompt names the engine and requests a JSON summary", () => {
    const p = dispatchPrompt("codex", defaultContext(), ["auth"]);
    expect(p).toContain("→ codex");
    expect(p).toContain("JSON summary");
  });
});

describe("cli help routing", () => {
  const runCli = (args: string[]): { code: number; stdout: string; stderr: string } => {
    const r = Bun.spawnSync(["bun", "run", "src/cli.ts", ...args], {
      cwd: process.cwd(),
      env: { ...process.env, NO_COLOR: "1" },
    });
    return {
      code: r.exitCode,
      stdout: new TextDecoder().decode(r.stdout),
      stderr: new TextDecoder().decode(r.stderr),
    };
  };

  test("`vf --help` prints help with no spurious Unknown command error", () => {
    const { code, stdout, stderr } = runCli(["--help"]);
    expect(code).toBe(0);
    expect(stdout).toContain("Usage:");
    expect(stderr).not.toContain("Unknown command");
  });

  test("`vf help` and `vf -h` also print help cleanly", () => {
    for (const arg of ["help", "-h"]) {
      const { code, stdout, stderr } = runCli([arg]);
      expect(code).toBe(0);
      expect(stdout).toContain("Usage:");
      expect(stderr).not.toContain("Unknown command");
    }
  });

  test("`vf <subcommand> --help` prints command-specific help, not the global help", () => {
    const global = runCli(["--help"]).stdout;
    const cases: Array<[string, string]> = [
      ["verify", "vf verify"],
      ["units", "vf units"],
      ["init", "vf init"],
      ["orchestrate", "vf orchestrate"],
      ["tools", "vf tools"],
    ];
    for (const [cmd, marker] of cases) {
      const { code, stdout, stderr } = runCli([cmd, "--help"]);
      expect(code).toBe(0);
      expect(stderr).not.toContain("Unknown command");
      // The per-command block names that command in its usage line…
      expect(stdout).toContain(marker);
      // …and is NOT just the global help text.
      expect(stdout).not.toBe(global);
    }
    // `-h` short flag routes the same way.
    const short = runCli(["verify", "-h"]);
    expect(short.code).toBe(0);
    expect(short.stdout).toContain("vf verify");
    expect(short.stdout).not.toBe(global);
  });
});

describe("commands.init", () => {
  let dir: string;
  const origCwd = process.cwd();
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-"));
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(origCwd);
    rmSync(dir, { recursive: true, force: true });
  });

  test("init writes canonical context and a valid ledger", () => {
    const code = init({ engine: "claude" }, { preflight: allReady });
    expect(code).toBe(0);
    const state = JSON.parse(readFileSync(join(dir, `${CTX_DIR}/WORKFLOW_STATE.json`), "utf8"));
    expect(state.totals.units).toBe(0);
    expect(readFileSync(join(dir, "CLAUDE.md"), "utf8").length).toBeGreaterThan(0);
  });

  test("units status returns 0 on an initialized ledger", () => {
    init({}, { preflight: allReady });
    expect(units("status", [])).toBe(0);
    expect(units("resources", [])).toBe(0);
  });
});

describe("commands.init preserves human-curated TASK_CONTEXT.md (data-loss P1)", () => {
  let dir: string;
  const taskPath = () => join(dir, `${CTX_DIR}/TASK_CONTEXT.md`);
  const projectPath = () => join(dir, `${CTX_DIR}/PROJECT_CONTEXT.md`);
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-task-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("first init writes TASK_CONTEXT.md with the template", () => {
    applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
    const body = readFileSync(taskPath(), "utf8");
    expect(body).toContain("# Task Context");
    expect(body).toContain("- Goal:");
  });

  test("re-init with NO explicit goal preserves a hand-edited TASK_CONTEXT.md", () => {
    applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
    writeFileSync(taskPath(), "# Task Context\n\n- Goal: MY CUSTOM GOAL\n");
    const result = applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
    const body = readFileSync(taskPath(), "utf8");
    expect(body).toContain("MY CUSTOM GOAL");
    expect(body).not.toContain("Describe the task in");
    // Honest reporting: skipped file is NOT claimed as written.
    expect(result.files).not.toContain(`${CTX_DIR}/TASK_CONTEXT.md`);
  });

  test("PROJECT_CONTEXT.md still regenerates on re-init (scanner-derived, not preserved)", () => {
    applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
    writeFileSync(projectPath(), "STALE PROJECT CONTEXT\n");
    applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
    const body = readFileSync(projectPath(), "utf8");
    expect(body).not.toContain("STALE PROJECT CONTEXT");
    expect(body).toContain("# Project Context");
  });

  test("re-init WITH an explicit goal does overwrite TASK_CONTEXT.md", () => {
    applyIntake({ engines: ["claude"] }, { useAi: false, base: dir });
    writeFileSync(taskPath(), "# Task Context\n\n- Goal: OLD GOAL\n");
    const result = applyIntake(
      { goal: "BRAND NEW EXPLICIT GOAL", engines: ["claude"] },
      { useAi: false, base: dir },
    );
    const body = readFileSync(taskPath(), "utf8");
    expect(body).toContain("BRAND NEW EXPLICIT GOAL");
    expect(body).not.toContain("OLD GOAL");
    expect(result.files).toContain(`${CTX_DIR}/TASK_CONTEXT.md`);
  });
});

describe("engines", () => {
  test("there are exactly three supported engines", () => {
    expect(ENGINES).toEqual(["claude", "codex", "copilot"]);
  });
});

describe("server", () => {
  test("serves the intake console and state endpoints on loopback", async () => {
    const { server, url } = await startServer(0);
    expect(url).toContain("127.0.0.1");
    const html = await fetch(url).then((r) => r.text());
    expect(html).toContain("VibeFlow");
    expect(html).toContain("New workflow"); // interactive intake wizard
    expect(html).toContain('id="intakeForm"');
    const state = await fetch(`${url}/state`);
    expect(state.status).toBe(200);
    server.close();
  });

  test("POST /api/init generates a workflow and rejects a missing CSRF token", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-srv-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const { server, url } = await startServer(0);
      const html = await fetch(url).then((r) => r.text());
      const token = (html.match(/name="csrf" content="([^"]+)"/) || [])[1];
      expect(token).toBeTruthy();

      const ok = await fetch(`${url}/api/init`, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          "x-vibeflow-token": token as string,
        },
        body: JSON.stringify({ goal: "Ship dark mode", engines: ["claude"] }),
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as {
        state: WorkflowState;
        files: string[];
      };
      expect(body.state.goal).toBe("Ship dark mode");
      expect(body.files).toContain(`${CTX_DIR}/WORKFLOW_STATE.json`);

      const forbidden = await fetch(`${url}/api/init`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: "{}",
      });
      expect(forbidden.status).toBe(403);
      server.close();
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("commands.repo", () => {
  test("detectToolchain: npm project → typecheck/lint/test gates", () => {
    const plan = detectToolchain("/proj", {
      exists: (p) => p === "/proj/package.json",
      readScripts: () => ["typecheck", "lint", "test", "build"],
      runner: "bun",
    });
    expect(plan.kind).toBe("npm");
    if (plan.kind === "npm") expect(plan.gates).toEqual(["typecheck", "lint", "test"]);
  });

  test("detectToolchain: Gradle/KMP project → gradlew check (the dogfood bug)", () => {
    const plan = detectToolchain("/kmp", {
      exists: (p) => p === "/kmp/build.gradle.kts" || p === "/kmp/gradlew",
      readScripts: () => [],
    });
    expect(plan).toEqual({ kind: "gradle", cmd: "./gradlew" });
  });

  test("detectToolchain: monorepo with web/package.json → runs in subdir", () => {
    const plan = detectToolchain("/mono", {
      exists: (p) => p === "/mono/web/package.json",
      readScripts: () => ["build", "lint"],
      runner: "npm",
    });
    expect(plan.kind).toBe("monorepo");
    if (plan.kind === "monorepo") {
      expect(plan.dir).toBe("/mono/web");
      expect(plan.gates).toEqual(["build", "lint"]);
    }
  });

  test("detectToolchain: unknown build system → none (warn, not silent pass)", () => {
    const plan = detectToolchain("/x", { exists: () => false });
    expect(plan).toEqual({ kind: "none" });
  });

  test("skillForFile maps extensions to reader skills", () => {
    expect(skillForFile("BRD.docx")).toBe("docx-reader");
    expect(skillForFile("data.xlsx")).toBe("xlsx-reader");
    expect(skillForFile("notes.md")).toBe("markdown-reader");
    expect(skillForFile("diagram.png")).toBe("image-ocr");
    expect(skillForFile("weird.unknownext")).toBe("generic-file-reader");
  });

  test("resolveRepo falls back to cwd for invalid paths", () => {
    expect(resolveRepo("/no/such/dir/anywhere")).toBe(process.cwd());
  });

  test("detectRepo reports engine markers present in a repo", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-det-"));
    try {
      const prev = process.cwd();
      process.chdir(dir);
      applyIntake({ engines: ["claude", "copilot"] }, { useAi: false, base: dir });
      process.chdir(prev);
      const det = detectRepo(dir);
      expect(det.engines.claude).toBe(true); // CLAUDE.md written
      expect(det.engines.copilot).toBe(true); // .github/copilot-instructions.md written
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("commands.units CRUD", () => {
  test("add, update, then delete a work unit and recompute totals", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-crud-"));
    try {
      applyIntake({ goal: "g", engines: ["claude"] }, { useAi: false, base: dir });

      let s = mutateUnits(dir, "add", {
        name: "auth",
        status: "running",
        confidence: 0.5,
      });
      expect(s?.work_units.length).toBe(1);
      expect(s?.totals.units).toBe(1);

      // duplicate name rejected
      expect(mutateUnits(dir, "add", { name: "auth" })).toBeNull();

      s = mutateUnits(dir, "update", { name: "auth", status: "done" });
      expect(s?.work_units[0]?.status).toBe("done");
      expect(s?.totals.done).toBe(1);

      s = mutateUnits(dir, "delete", { name: "auth" });
      expect(s?.work_units.length).toBe(0);

      // deleting a missing unit returns null
      expect(mutateUnits(dir, "delete", { name: "ghost" })).toBeNull();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`vf units add/update/delete` subcommands mutate the ledger", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-unitscmd-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      applyIntake({ goal: "g", engines: ["claude"] }, { useAi: false, base: dir });

      expect(units("add", ["auth"])).toBe(0);
      expect(readState(dir)?.work_units.map((u) => u.name)).toEqual(["auth"]);

      // duplicate name errors clearly
      expect(units("add", ["auth"])).toBe(1);

      // update status + confidence
      expect(units("update", ["auth"], { status: "done", confidence: "1" })).toBe(0);
      const updated = readState(dir)?.work_units.find((u) => u.name === "auth");
      expect(updated?.status).toBe("done");
      expect(updated?.confidence).toBe(1);

      // updating an unknown name errors clearly
      expect(units("update", ["ghost"], { status: "done" })).toBe(1);

      // delete removes it
      expect(units("delete", ["auth"])).toBe(0);
      expect(readState(dir)?.work_units.length).toBe(0);

      // deleting a missing unit errors clearly
      expect(units("delete", ["ghost"])).toBe(1);

      // add with no name errors clearly
      expect(units("add", [])).toBe(2);

      // show / evidence with no name print usage (exit 2), not "No such work unit: undefined"
      expect(units("show", [])).toBe(2);
      expect(units("evidence", [])).toBe(2);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("`vf units evidence <name> --add` appends evidence and satisfies the policy gate", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-unitsev-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      applyIntake({ goal: "g", engines: ["claude"] }, { useAi: false, base: dir });
      expect(units("add", ["nav"])).toBe(0);

      // (1) --add appends an evidence string and persists it
      expect(units("evidence", ["nav"], { add: "compiled green: BUILD SUCCESSFUL" })).toBe(0);
      let nav = readState(dir)?.work_units.find((u) => u.name === "nav");
      expect(nav?.evidence).toContain("compiled green: BUILD SUCCESSFUL");

      // (2) a second --add APPENDS, it does not replace
      expect(units("evidence", ["nav"], { add: "tests: 12 pass" })).toBe(0);
      nav = readState(dir)?.work_units.find((u) => u.name === "nav");
      expect(nav?.evidence?.length).toBe(2);
      expect(nav?.evidence).toContain("compiled green: BUILD SUCCESSFUL");
      expect(nav?.evidence).toContain("tests: 12 pass");

      // (3) no --add still lists (exit 0)
      expect(units("evidence", ["nav"])).toBe(0);

      // (4) bare --add (boolean true) prints usage and returns 2
      expect(units("evidence", ["nav"], { add: true })).toBe(2);

      // unknown unit with --add still errors clearly
      expect(units("evidence", ["ghost"], { add: "x" })).toBe(1);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("evidence-add resolves the no-evidence policy gate dead-end", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-unitsgate-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      applyIntake({ goal: "g", engines: ["claude"] }, { useAi: false, base: dir });
      expect(units("add", ["nav"])).toBe(0);
      expect(units("update", ["nav"], { status: "done", confidence: "1" })).toBe(0);

      // done with no evidence → policy gate fails
      const before = policyGates(readState(dir));
      expect(before.ok).toBe(false);
      expect(before.failures.some((f) => f.startsWith("no-evidence:"))).toBe(true);

      // attach evidence via the new path
      expect(units("evidence", ["nav"], { add: "BUILD SUCCESSFUL" })).toBe(0);

      // gate now passes
      const after = policyGates(readState(dir));
      expect(after.ok).toBe(true);
      expect(after.failures.some((f) => f.startsWith("no-evidence:"))).toBe(false);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
describe("doctor --probe surfaces probe failures", () => {
  test("a probe-failed engine downgrades the summary to exit 1", async () => {
    const readiness: EngineReadiness[] = [
      { engine: "claude", level: "ready", detail: "ready", checkedAt: "" },
      {
        engine: "codex",
        level: "no-binary",
        detail: "not installed",
        checkedAt: "",
      },
      {
        engine: "copilot",
        level: "probe-failed",
        detail: "probe failed",
        checkedAt: "",
      },
    ];
    expect(await doctor({ probe: true }, { readiness })).toBe(1);
  });

  test("all-ready (or merely-not-installed optional engines) stays exit 0", async () => {
    const readiness: EngineReadiness[] = [
      { engine: "claude", level: "ready", detail: "ready", checkedAt: "" },
      {
        engine: "codex",
        level: "no-binary",
        detail: "not installed",
        checkedAt: "",
      },
      { engine: "copilot", level: "ready", detail: "ready", checkedAt: "" },
    ];
    expect(await doctor({ probe: true }, { readiness })).toBe(0);
  });
});

// --- BUG 2: `vf hooks emit` is dry-run by default; only --yes writes files ---
describe("hooks emit is non-destructive by default (bug 2)", () => {
  const EMITTED = [
    ".claude/settings.json",
    ".codex/hooks.json",
    ".github/copilot-hooks.json",
    ".githooks/pre-commit",
  ];

  test("emit without --yes writes NO files (dry-run)", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-hooks-emit-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      expect(hooks("emit", {})).toBe(0);
      for (const rel of EMITTED) expect(existsSync(join(dir, rel))).toBe(false);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("emit --dry-run also writes NO files", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-hooks-dry-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      expect(hooks("emit", { "dry-run": true })).toBe(0);
      for (const rel of EMITTED) expect(existsSync(join(dir, rel))).toBe(false);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("emit --yes writes the per-engine hook config files", () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-hooks-yes-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      expect(hooks("emit", { yes: true })).toBe(0);
      for (const rel of EMITTED) expect(existsSync(join(dir, rel))).toBe(true);
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server write endpoints", () => {
  const tokenOf = (html: string) =>
    (html.match(/name="csrf" content="([^"]+)"/) || [])[1] as string;

  test("detect, units CRUD, and guarded uploads with filename sanitization", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-ep-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const { server, url } = await startServer(0);
      const token = tokenOf(await fetch(url).then((r) => r.text()));
      const hdr = {
        "content-type": "application/json",
        "x-vibeflow-token": token,
      };

      // detect points the active repo at dir
      const det = await fetch(`${url}/api/detect`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ path: dir }),
      });
      expect(det.status).toBe(200);
      expect(((await det.json()) as { repo: string }).repo).toBe(dir);

      // init then add a unit via /api/units
      await fetch(`${url}/api/init`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ goal: "g", engines: ["claude"] }),
      });
      const add = await fetch(`${url}/api/units`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({
          action: "add",
          unit: { name: "u1", status: "running" },
        }),
      });
      expect(add.status).toBe(200);
      expect(((await add.json()) as { state: WorkflowState }).state.work_units.length).toBe(1);

      // upload a file (raw body) then confirm it landed and a skill was mapped
      const up = await fetch(`${url}/api/upload?name=spec.md`, {
        method: "POST",
        headers: { "x-vibeflow-token": token },
        body: "# hello",
      });
      expect(up.status).toBe(200);
      const upJson = (await up.json()) as { attachment: { skill: string } };
      expect(upJson.attachment.skill).toBe("markdown-reader");
      expect(existsSync(join(dir, CTX_DIR, "attachments", "spec.md"))).toBe(true);

      // path-traversal filename is neutralized to its basename — it cannot escape the
      // attachments dir (saved as escape.txt INSIDE attachments, never at the repo root)
      const evil = await fetch(`${url}/api/upload?name=${encodeURIComponent("../escape.txt")}`, {
        method: "POST",
        headers: { "x-vibeflow-token": token },
        body: "x",
      });
      expect(evil.status).toBe(200);
      expect(existsSync(join(dir, "escape.txt"))).toBe(false); // did NOT escape
      expect(existsSync(join(dir, CTX_DIR, "attachments", "escape.txt"))).toBe(true);

      // a separator/dotfile-only name is rejected outright
      const bad = await fetch(`${url}/api/upload?name=${encodeURIComponent("../../")}`, {
        method: "POST",
        headers: { "x-vibeflow-token": token },
        body: "x",
      });
      expect(bad.status).toBe(400);

      // upload without token is forbidden
      const noTok = await fetch(`${url}/api/upload?name=x.md`, {
        method: "POST",
        body: "x",
      });
      expect(noTok.status).toBe(403);

      // attachments mirrored into the saved ledger
      expect(readState(dir)?.attachments?.some((a) => a.name === "spec.md")).toBe(true);

      server.close();
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("commands.discover (wired HTTP path)", () => {
  /** Minimal Response-like object so the wired command path never touches the network. */
  const jsonResponse = (body: unknown, init: { ok?: boolean; status?: number } = {}): Response =>
    ({
      ok: init.ok ?? true,
      status: init.status ?? 200,
      json: async () => body,
    }) as unknown as Response;

  // Capture stdout/stderr so we can assert what the command rendered.
  let out: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;
  beforeEach(() => {
    out = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    console.error = (...a: unknown[]) => out.push(a.join(" "));
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
  });

  test("approved docs discovery actually calls the HTTP layer and renders experimental results", async () => {
    let calledUrl = "";
    const fetchFn = (async (url: string) => {
      calledUrl = url;
      return jsonResponse({
        results: [{ name: "pdf-reader", description: "reads pdf files" }],
      });
    }) as unknown as typeof fetch;

    const code = await discover("skills", ["pdf"], { yes: true }, { fetchFn });

    // Proves the command reached the wired HTTP function (would be "" under notWired()).
    expect(calledUrl.startsWith("https://context7.com/api/v2/libs/search")).toBe(true);
    expect(calledUrl).toContain("query=pdf");
    expect(code).toBe(0);
    // Discovery results are forced experimental and rendered.
    expect(out.join("\n")).toContain("experimental");
    expect(out.join("\n")).toContain("pdf-reader");
  });

  test("without --yes the network is never touched (approval gate)", async () => {
    let called = false;
    const fetchFn = (async () => {
      called = true;
      return jsonResponse({});
    }) as unknown as typeof fetch;

    const code = await discover("docs", ["react"], {}, { fetchFn });
    expect(called).toBe(false);
    expect(code).toBe(0);
    expect(out.join("\n").toLowerCase()).toContain("approve");
  });

  test("offline / thrown fetch is handled gracefully (no crash, exit 1)", async () => {
    const fetchFn = (async () => {
      throw new Error("getaddrinfo ENOTFOUND context7.com");
    }) as unknown as typeof fetch;

    const code = await discover("docs", ["react"], { yes: true }, { fetchFn });
    expect(code).toBe(1);
    expect(out.join("\n")).toContain("context7");
  });

  test("a malicious skill name is sanitized away by the wired command", async () => {
    const fetchFn = (async () =>
      jsonResponse({
        results: [
          { name: "../../etc/passwd", description: "evil" },
          { name: "good-reader", description: "fine" },
        ],
      })) as unknown as typeof fetch;
    const code = await discover("skills", ["x"], { yes: true }, { fetchFn });
    expect(code).toBe(0);
    const text = out.join("\n");
    // The path-safe slug is surfaced; the unsafe one never appears as a usable name.
    expect(text).toContain("name: good-reader");
    expect(text).not.toContain("name: ../../etc/passwd");
  });
});

describe("server orchestration endpoints", () => {
  const tokenOf = (html: string) =>
    (html.match(/name="csrf" content="([^"]+)"/) || [])[1] as string;

  test("skills, discover approval gate, and dry orchestrate over HTTP", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-orch-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const { server, url } = await startServer(0);
      const token = tokenOf(await fetch(url).then((r) => r.text()));
      const hdr = {
        "content-type": "application/json",
        "x-vibeflow-token": token,
      };

      await fetch(`${url}/api/detect`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ path: dir }),
      });
      await fetch(`${url}/api/init`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ goal: "ship feature", engines: ["claude"] }),
      });

      // /api/skills returns discovered skills + demand-driven needs
      const sk = (await fetch(`${url}/api/skills`).then((r) => r.json())) as {
        skills: unknown[];
        needs: unknown[];
      };
      expect(Array.isArray(sk.skills)).toBe(true);
      expect(Array.isArray(sk.needs)).toBe(true);

      // discovery requires approval unless approved=true
      const gated = (await fetch(`${url}/api/discover`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ kind: "docs", query: "react" }),
      }).then((r) => r.json())) as { approvalRequired?: boolean };
      expect(gated.approvalRequired).toBe(true);

      // dry orchestrate is READ-ONLY: it returns the (unmutated) state and persists nothing.
      const statePath = join(dir, CTX_DIR, "WORKFLOW_STATE.json");
      const stateBefore = readFileSync(statePath, "utf8");
      const orch = await fetch(`${url}/api/orchestrate`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ engine: "claude" }),
      });
      expect(orch.status).toBe(200);
      const orchJson = (await orch.json()) as {
        ok: boolean;
        state: WorkflowState;
      };
      expect(orchJson.ok).toBe(true);
      expect(Array.isArray(orchJson.state.work_units)).toBe(true);
      expect(readFileSync(statePath, "utf8")).toBe(stateBefore); // ledger byte-identical

      server.close();
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("server preflight + settings endpoints", () => {
  const tokenOf = (html: string) =>
    (html.match(/name="csrf" content="([^"]+)"/) || [])[1] as string;

  test("POST /api/preflight returns a readiness array + anyReady, CSRF-guarded", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-pre-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const { server, url } = await startServer(0);
      const token = tokenOf(await fetch(url).then((r) => r.text()));
      const hdr = {
        "content-type": "application/json",
        "x-vibeflow-token": token,
      };

      // no-token request is forbidden (privileged: it spawns engines)
      const noTok = await fetch(`${url}/api/preflight`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ engines: ["claude"] }),
      });
      expect(noTok.status).toBe(403);

      // probe:false keeps the test deterministic (presence-only, no engine spawn)
      const res = await fetch(`${url}/api/preflight`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ engines: ["claude", "codex"], probe: false }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        ok: boolean;
        readiness: EngineReadiness[];
        anyReady: boolean;
      };
      expect(body.ok).toBe(true);
      expect(Array.isArray(body.readiness)).toBe(true);
      expect(typeof body.anyReady).toBe("boolean");
      for (const r of body.readiness) {
        expect(ENGINES).toContain(r.engine);
        expect(typeof r.level).toBe("string");
        expect(typeof r.detail).toBe("string");
      }
      server.close();
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("GET /api/settings returns defaults; POST toggles and persists", async () => {
    const dir = mkdtempSync(join(tmpdir(), "vf-set-"));
    const orig = process.cwd();
    process.chdir(dir);
    try {
      const { server, url } = await startServer(0);
      const token = tokenOf(await fetch(url).then((r) => r.text()));
      const hdr = {
        "content-type": "application/json",
        "x-vibeflow-token": token,
      };

      // point the active repo at dir so reads/writes hit the temp workspace
      await fetch(`${url}/api/detect`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ path: dir }),
      });

      const initial = (await fetch(`${url}/api/settings`).then((r) => r.json())) as {
        settings: VibeSettings;
        tools: { name: string; installed: boolean; plan: string[] }[];
      };
      expect(initial.settings.tools.codegraph).toBe(false);
      expect(initial.settings.tools.lsp).toBe(false);
      expect(Array.isArray(initial.tools)).toBe(true);
      expect(initial.tools.length).toBe(2);

      // toggle codegraph on without token → forbidden
      const noTok = await fetch(`${url}/api/settings`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ tools: { codegraph: true } }),
      });
      expect(noTok.status).toBe(403);

      const toggled = await fetch(`${url}/api/settings`, {
        method: "POST",
        headers: hdr,
        body: JSON.stringify({ tools: { codegraph: true } }),
      });
      expect(toggled.status).toBe(200);
      const tBody = (await toggled.json()) as {
        ok: boolean;
        settings: VibeSettings;
      };
      expect(tBody.settings.tools.codegraph).toBe(true);

      // round-trip: the change persisted to SETTINGS.json on disk
      expect(readSettings(dir).tools.codegraph).toBe(true);
      server.close();
    } finally {
      process.chdir(orig);
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("the served HTML carries the engine-status panel and the options section", async () => {
    const { server, url } = await startServer(0);
    const html = await fetch(url).then((r) => r.text());
    expect(html).toContain('id="engineStatus"');
    expect(html).toContain('id="checkEnginesBtn"');
    expect(html).toContain('id="toolOptions"');
    server.close();
  });
});

describe("adapters settings integration", () => {
  test("canonicalFiles no longer owns SETTINGS.json (applyIntake creates it once)", () => {
    // SETTINGS.json must not be a clobbered canonical file; applyIntake seeds it only when
    // absent so re-init never resets the user's tool choices.
    const files = canonicalFiles(defaultContext());
    expect(files[`${CTX_DIR}/SETTINGS.json`]).toBeUndefined();
  });

  test("engineBody omits the navigation block when no tool is enabled", () => {
    const body = Object.values(engineFiles("claude", defaultContext(), false)).join("\n");
    expect(body).not.toContain("For code navigation");
  });

  test("engineBody adds the navigation block and reflects priority order when tools enabled", () => {
    const ctx = {
      ...defaultContext(),
      settings: {
        tools: { codegraph: true, lsp: true },
        toolPriority: ["lsp", "codegraph", "native"],
        failureProtection: { ...DEFAULT_FAILURE_PROTECTION },
        updatedAt: "",
      } satisfies VibeSettings,
    };
    const body = Object.values(engineFiles("claude", { ...ctx }, false)).join("\n");
    expect(body).toContain("For code navigation");
    // priority puts lsp first, so its label must precede codegraph's in the sentence.
    const lspAt = body.indexOf("language-server (LSP)");
    const cgAt = body.indexOf("codegraph_* MCP tools");
    expect(lspAt).toBeGreaterThan(-1);
    expect(cgAt).toBeGreaterThan(lspAt);
    // native is always the final fallback.
    expect(body).toContain("grep/find/read");
  });

  test("canonicalFiles WORKFLOW_POLICY carries the navigation block when a tool is enabled", () => {
    const ctx = {
      ...defaultContext(),
      settings: {
        tools: { codegraph: true, lsp: false },
        toolPriority: ["codegraph", "lsp", "native"],
        failureProtection: { ...DEFAULT_FAILURE_PROTECTION },
        updatedAt: "",
      } satisfies VibeSettings,
    };
    const policy = canonicalFiles(ctx)[`${CTX_DIR}/WORKFLOW_POLICY.md`] as string;
    expect(policy).toContain("Code Navigation Priority");
    expect(policy).toContain("codegraph_* MCP tools");
  });
});

describe("commands.applyIntake hard creation gate", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-gate-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("refuses creation and writes no engine files when no engine is ready", () => {
    const result = applyIntake(
      { goal: "g", engines: ["claude", "codex"] },
      { base: dir, preflight: noneReady },
    );
    expect(result.refused).toBe(true);
    expect(result.files).toEqual([]);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
    expect(existsSync(join(dir, `${CTX_DIR}/WORKFLOW_STATE.json`))).toBe(false);
  });

  test("generates only for ready engines when at least one is ready", () => {
    // claude ready, codex not — only CLAUDE.md should be written.
    const mixed = (engines: Engine[]) =>
      engines.map((engine) => ({
        engine,
        level: engine === "claude" ? ("ready" as const) : ("no-binary" as const),
        detail: "x",
        checkedAt: "",
      }));
    const result = applyIntake(
      { goal: "g", engines: ["claude", "codex"] },
      { base: dir, preflight: mixed },
    );
    expect(result.refused).toBe(false);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
    expect(existsSync(join(dir, "AGENTS.md"))).toBe(false);
  });

  test("dry run skips the gate so the offline preview works with no engine", () => {
    let probed = false;
    const result = applyIntake(
      { goal: "g", engines: ["claude"] },
      {
        base: dir,
        dry: true,
        preflight: (e) => {
          probed = true;
          return noneReady(e);
        },
      },
    );
    expect(probed).toBe(false);
    expect(result.refused).toBe(false);
    expect(result.files.length).toBeGreaterThan(0);
    // dry: nothing on disk.
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(false);
  });

  test("skipPreflight (web /api/init path) bypasses the gate entirely", () => {
    let probed = false;
    const result = applyIntake(
      { goal: "g", engines: ["claude"] },
      {
        base: dir,
        useAi: false,
        skipPreflight: true,
        preflight: (e) => {
          probed = true;
          return noneReady(e);
        },
      },
    );
    expect(probed).toBe(false);
    expect(result.refused).toBe(false);
    expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
  });
});

describe("commands.applyIntake preserves SETTINGS.json", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-settings-"));
  });
  afterEach(() => rmSync(dir, { recursive: true, force: true }));

  test("first init on a fresh dir seeds SETTINGS.json with the off-by-default baseline", () => {
    expect(existsSync(join(dir, CTX_DIR, "SETTINGS.json"))).toBe(false);
    applyIntake(
      { goal: "g", engines: ["claude"] },
      { base: dir, skipPreflight: true, useAi: false },
    );
    const s = readSettings(dir);
    expect(s.tools.codegraph).toBe(false);
    expect(s.tools.lsp).toBe(false);
    expect(existsSync(join(dir, CTX_DIR, "SETTINGS.json"))).toBe(true);
  });

  test("re-init does NOT reset enabled tools back to defaults", () => {
    writeSettings(dir, { tools: { codegraph: true, lsp: true } });
    expect(readSettings(dir).tools.codegraph).toBe(true);
    expect(readSettings(dir).tools.lsp).toBe(true);

    applyIntake(
      { goal: "g", engines: ["claude"] },
      { base: dir, skipPreflight: true, useAi: false },
    );

    const s = readSettings(dir);
    expect(s.tools.codegraph).toBe(true);
    expect(s.tools.lsp).toBe(true);
  });

  test("with tools enabled, generated CLAUDE.md/AGENTS.md carry the nav block and it survives re-init", () => {
    writeSettings(dir, { tools: { codegraph: true, lsp: true } });
    applyIntake(
      { goal: "g", engines: ["claude", "codex"] },
      {
        base: dir,
        skipPreflight: true,
        useAi: false,
      },
    );
    const claude = readFileSync(join(dir, "CLAUDE.md"), "utf8");
    const agents = readFileSync(join(dir, "AGENTS.md"), "utf8");
    expect(claude).toContain("For code navigation");
    expect(claude).toContain("codegraph_* MCP tools");
    expect(agents).toContain("For code navigation");
    // WORKFLOW_POLICY.md also carries the block, proving it survives a settings-preserving init.
    const policy = readFileSync(join(dir, CTX_DIR, "WORKFLOW_POLICY.md"), "utf8");
    expect(policy).toContain("Code Navigation Priority");
    // settings still enabled after init
    expect(readSettings(dir).tools.codegraph).toBe(true);
  });
});

describe("commands.tools", () => {
  let dir: string;
  let out: string[];
  let origLog: typeof console.log;
  let origErr: typeof console.error;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-tools-"));
    out = [];
    origLog = console.log;
    origErr = console.error;
    console.log = (...a: unknown[]) => out.push(a.join(" "));
    console.error = (...a: unknown[]) => out.push(a.join(" "));
  });
  afterEach(() => {
    console.log = origLog;
    console.error = origErr;
    rmSync(dir, { recursive: true, force: true });
  });

  test("enable then disable round-trips the codegraph flag in SETTINGS.json", () => {
    expect(readSettings(dir).tools.codegraph).toBe(false);
    expect(tools("enable", ["codegraph"], {}, { base: dir })).toBe(0);
    expect(readSettings(dir).tools.codegraph).toBe(true);
    expect(tools("disable", ["codegraph"], {}, { base: dir })).toBe(0);
    expect(readSettings(dir).tools.codegraph).toBe(false);
  });

  test("status reports settings and a priority ladder", () => {
    writeSettings(dir, { tools: { codegraph: true, lsp: false } });
    expect(tools("status", [], {}, { base: dir })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("CodeGraph");
    expect(text).toContain("priority");
  });

  test("install WITHOUT --yes prints the plan and never spawns", () => {
    let spawned = 0;
    const code = tools(
      "install",
      ["codegraph"],
      {},
      {
        base: dir,
        spawner: () => {
          spawned++;
          return { status: 0 };
        },
      },
    );
    expect(code).toBe(0);
    expect(spawned).toBe(0);
    expect(out.join("\n")).toContain("Install plan");
    expect(out.join("\n").toLowerCase()).toContain("re-run with --yes");
  });

  test("install WITH --yes runs every plan step via the injected spawner", () => {
    const ran: string[] = [];
    const code = tools(
      "install",
      ["codegraph"],
      { yes: true },
      {
        base: dir,
        spawner: (cmd, args) => {
          ran.push(`${cmd} ${args.join(" ")}`);
          return { status: 0 };
        },
      },
    );
    expect(code).toBe(0);
    expect(ran.length).toBeGreaterThan(0);
    expect(ran.some((s) => s.startsWith("npm i -g"))).toBe(true);
  });

  test("install aborts with nonzero when a step fails", () => {
    const code = tools(
      "install",
      ["codegraph"],
      { yes: true },
      { base: dir, spawner: () => ({ status: 1 }) },
    );
    expect(code).toBe(1);
  });

  test("unknown tool name is rejected with usage", () => {
    expect(tools("enable", ["bogus"], {}, { base: dir })).toBe(2);
  });

  test("enabling codegraph writes a codegraph server into .mcp.json (closes the wiring gap)", () => {
    expect(tools("enable", ["codegraph"], {}, { base: dir })).toBe(0);
    const mcpPath = join(dir, ".mcp.json");
    expect(existsSync(mcpPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string; args: string[]; env: Record<string, string> }>;
    };
    expect(parsed.mcpServers.codegraph).toEqual({
      command: "codegraph",
      args: ["serve", "--mcp"],
      env: {},
    });
  });

  test("enabling codegraph MERGES into .mcp.json and preserves unrelated servers", () => {
    const mcpPath = join(dir, ".mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { other: { command: "other-mcp", args: [] } } }, null, 2),
    );
    expect(tools("enable", ["codegraph"], {}, { base: dir })).toBe(0);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, { command: string }>;
    };
    expect(parsed.mcpServers.other?.command).toBe("other-mcp");
    expect(parsed.mcpServers.codegraph?.command).toBe("codegraph");
  });

  test("enabling codegraph leaves a corrupt .mcp.json untouched (no data loss)", () => {
    const mcpPath = join(dir, ".mcp.json");
    const corrupt = '{ "mcpServers": { "other": { broken json';
    writeFileSync(mcpPath, corrupt);
    expect(tools("enable", ["codegraph"], {}, { base: dir })).toBe(0);
    // The unparseable file is preserved verbatim rather than overwritten/reset.
    expect(readFileSync(mcpPath, "utf8")).toBe(corrupt);
  });

  test("disabling codegraph removes its .mcp.json server but keeps unrelated ones", () => {
    const mcpPath = join(dir, ".mcp.json");
    writeFileSync(
      mcpPath,
      JSON.stringify({ mcpServers: { other: { command: "other-mcp", args: [] } } }, null, 2),
    );
    expect(tools("enable", ["codegraph"], {}, { base: dir })).toBe(0);
    expect(tools("disable", ["codegraph"], {}, { base: dir })).toBe(0);
    const parsed = JSON.parse(readFileSync(mcpPath, "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    expect("codegraph" in parsed.mcpServers).toBe(false);
    expect("other" in parsed.mcpServers).toBe(true);
  });

  test("enabling lsp with detected languages writes one .mcp.json entry per language", () => {
    // A TS + Python repo so the scanner detects two supported languages.
    writeFileSync(join(dir, "index.ts"), "export const x = 1;\n");
    writeFileSync(join(dir, "main.py"), "x = 1\n");
    expect(tools("enable", ["lsp"], {}, { base: dir })).toBe(0);
    const parsed = JSON.parse(readFileSync(join(dir, ".mcp.json"), "utf8")) as {
      mcpServers: Record<string, unknown>;
    };
    const keys = Object.keys(parsed.mcpServers);
    expect(keys).toContain("lsp-typescript");
    expect(keys).toContain("lsp-python");
  });

  test("codex config.toml is written repo-local and disables LSP tools when codegraph is on", () => {
    writeFileSync(join(dir, "index.ts"), "export const x = 1;\n");
    writeSettings(dir, { tools: { codegraph: true, lsp: true } });
    // Re-enable to trigger the write with both tools on.
    expect(tools("enable", ["codegraph"], {}, { base: dir })).toBe(0);
    const tomlPath = join(dir, ".codex", "config.toml");
    expect(existsSync(tomlPath)).toBe(true);
    const toml = readFileSync(tomlPath, "utf8");
    expect(toml).toContain("[mcp_servers.codegraph]");
    expect(toml).toContain("[mcp_servers.lsp-typescript]");
    // Structural gating: the lower-priority LSP server's tools are disabled on codex.
    expect(toml).toContain("disabled_tools");
    expect(toml).toContain("lsp-typescript");
  });

  test("copilot wiring is PRINTED (never touches ~/.copilot)", () => {
    expect(tools("enable", ["codegraph"], {}, { base: dir })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("copilot mcp add");
    expect(text).toContain("codegraph");
    // We never read/print the secret-bearing user config.
    expect(text).not.toContain("mcp-config.json");
  });

  test("enabling a tool whose binary is missing warns 'not found on PATH' (no false success)", () => {
    // codegraph's binary is not installed in the test environment, so detect() is false.
    // The toggle must still succeed but warn loudly rather than report clean success for
    // .mcp.json that points at a binary that can't start (the orchestrate tool-blindness bug).
    expect(tools("enable", ["codegraph"], {}, { base: dir })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("binary not found on PATH");
    expect(text).toContain("vf tools install codegraph");
  });

  test("status flags an enabled-but-not-installed tool with an actionable warning", () => {
    writeSettings(dir, { tools: { codegraph: true, lsp: false } });
    expect(tools("status", [], {}, { base: dir })).toBe(0);
    const text = out.join("\n");
    expect(text).toContain("enabled but binary not on PATH");
  });

  test("enable codegraph --yes provisions (install + index) when the binary is missing", () => {
    // Binary absent in CI → enable --yes must RUN the install plan via the spawner,
    // not just warn. This is the "config-only enable" gap closing.
    const ran: string[] = [];
    const code = tools(
      "enable",
      ["codegraph"],
      { yes: true },
      {
        base: dir,
        spawner: (cmd, args) => {
          ran.push(`${cmd} ${args.join(" ")}`);
          return { status: 0 };
        },
      },
    );
    expect(code).toBe(0);
    // install plan ran: global npm install + the per-repo index build (codegraph init -i).
    expect(ran.some((s) => s.startsWith("npm i -g"))).toBe(true);
    expect(ran.some((s) => s.includes("init -i"))).toBe(true);
    const text = out.join("\n");
    expect(text).toContain("installed");
  });

  test("enable codegraph --yes returns nonzero when a provisioning step fails", () => {
    const code = tools(
      "enable",
      ["codegraph"],
      { yes: true },
      { base: dir, spawner: () => ({ status: 1 }) },
    );
    expect(code).toBe(1);
  });

  test("enable codegraph WITHOUT --yes stays config-only and never spawns", () => {
    let spawned = false;
    const code = tools(
      "enable",
      ["codegraph"],
      {},
      {
        base: dir,
        spawner: () => {
          spawned = true;
          return { status: 0 };
        },
      },
    );
    expect(code).toBe(0);
    expect(spawned).toBe(false);
    expect(out.join("\n")).toContain("binary not found on PATH");
  });

  test("ensureToolIndex skips the build when the .codegraph/ index already exists", () => {
    mkdirSync(join(dir, ".codegraph"), { recursive: true });
    let spawned = false;
    const code = ensureToolIndex(dir, "codegraph", () => {
      spawned = true;
      return { status: 0 };
    });
    expect(code).toBe(0);
    expect(spawned).toBe(false);
    expect(out.join("\n")).toContain("index present");
  });

  test("ensureToolIndex builds the index via the spawner when .codegraph/ is absent", () => {
    const ran: string[] = [];
    const code = ensureToolIndex(dir, "codegraph", (cmd, args) => {
      ran.push(`${cmd} ${args.join(" ")}`);
      return { status: 0 };
    });
    expect(code).toBe(0);
    expect(ran.some((s) => s.includes("init -i"))).toBe(true);
    expect(out.join("\n")).toContain("built");
  });

  test("ensureToolIndex returns nonzero when the index build fails", () => {
    const code = ensureToolIndex(dir, "codegraph", () => ({ status: 1 }));
    expect(code).toBe(1);
  });

  test("ensureToolIndex is a no-op for a tool with no per-repo index (lsp)", () => {
    let spawned = false;
    const code = ensureToolIndex(dir, "lsp", () => {
      spawned = true;
      return { status: 0 };
    });
    expect(code).toBe(0);
    expect(spawned).toBe(false);
  });
});

describe("commands.skills init", () => {
  let dir: string;
  let orig: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "vf-skills-init-"));
    orig = process.cwd();
    process.chdir(dir);
  });
  afterEach(() => {
    process.chdir(orig);
    rmSync(dir, { recursive: true, force: true });
  });

  test("scaffolds a parseable SKILL.md that discoverSkills + matchSkillsForTask can use", async () => {
    const { discoverSkills, matchSkillsForTask } = await import("../src/skills/registry.js");
    expect(skills("init", ["compose-screen-ux"])).toBe(0);
    const path = join(dir, ".viteflow", "skills", "compose-screen-ux", "SKILL.md");
    expect(existsSync(path)).toBe(true);

    // The scaffold must be a valid skill (parseSkill returns non-null → discoverSkills lists it).
    const found = discoverSkills(dir);
    const skill = found.find((s) => s.name === "compose-screen-ux");
    expect(skill).toBeDefined();
    expect(skill?.status).toBe("draft");

    // After editing a trigger to a real keyword, matchSkillsForTask finds it. Here we prove the
    // pipeline by matching on the placeholder trigger the template ships with.
    const matches = matchSkillsForTask(found, "do some trigger-keyword work");
    expect(matches.some((m) => m.skill.name === "compose-screen-ux")).toBe(true);
  });

  test("rejects a non-kebab name and refuses to overwrite an existing skill", () => {
    expect(skills("init", ["Bad_Name"])).toBe(2);
    expect(skills("init", ["good-skill"])).toBe(0);
    expect(skills("init", ["good-skill"])).toBe(1); // already exists
  });
});
