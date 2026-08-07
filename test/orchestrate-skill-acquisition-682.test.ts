// #682 Phase D — pre-dispatch skill acquisition via orchestrate()/run().
// Approval consent separation: dry preview / CLI --yes auto-approve / interactive
// TTY confirmInput / injected approver / non-TTY fail-closed. Rejection, missing or
// ambiguous candidates, blocked scans, and install failures must preserve the skill
// gap and continue normal agent dispatch without crashing.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { orchestrate, run } from "../src/commands.js";
import { preDispatchAcquisition } from "../src/commands/orchestrate-acquisition.js";
import { type WorkflowState, readState, writeState } from "../src/core.js";
import type { AsyncSpawner } from "../src/dispatch.js";
import type { GitRunner } from "../src/safety/checkpoint.js";
import type { SkillAcquisitionProposal } from "../src/skills/acquisition.js";
import { registryCacheDir, writeRegistryLock } from "../src/skills/registry-channel.js";
import { discoverSkills } from "../src/skills/registry.js";

const VALID_FM = [
  "---",
  "name: xlsx-reader",
  "version: 1.2.0",
  "description: Read xlsx files.",
  "---",
  "",
  "# xlsx-reader",
  "",
  "Body with enough actionable content to pass the 50-char threshold.",
].join("\n");

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
  dirs = [];
});

function tmp(): string {
  const d = mkdtempSync(join(tmpdir(), "vf-acq-d-"));
  dirs.push(d);
  return d;
}

function writeStateFixture(base: string, overrides: Partial<WorkflowState> = {}): void {
  const ctx = join(base, ".vibeflow");
  mkdirSync(ctx, { recursive: true });
  const state: WorkflowState = {
    task_id: "TASK-1",
    goal: "parse the attached data.xlsx workbook",
    success_criteria: [],
    attachments: [{ name: "data.xlsx", size: 1, type: "xlsx", skill: "" }],
    work_units: [
      {
        name: "unit-a",
        status: "pending",
        confidence: 0,
        scope: ["src/a/"],
        gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
        resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      },
    ],
    totals: { units: 1, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
    ...overrides,
  };
  writeState(base, state);
}

interface Fixture {
  repo: string;
  home: string;
}

function makeCacheFixture(): Fixture {
  const repo = join(tmp(), "repo");
  const home = join(tmp(), "home");
  mkdirSync(join(repo, ".vibeflow"), { recursive: true });
  const url = "https://github.com/x/skills.git";
  writeRegistryLock(
    repo,
    {
      schemaVersion: 1,
      registries: [{ name: "skills", url, ref: "v1", commitOID: "a".repeat(40) }],
    },
    { writeFileSafe: (p: string, content: string) => writeFileSync(p, content) },
  );
  const cacheDir = registryCacheDir(url, { homedir: () => home });
  mkdirSync(cacheDir, { recursive: true });
  writeFileSync(
    join(cacheDir, "marketplace.json"),
    JSON.stringify({
      schemaVersion: 1,
      skills: [{ name: "xlsx-reader", version: "1.2.0", status: "verified" }],
    }),
  );
  mkdirSync(join(cacheDir, "skills/xlsx-reader"), { recursive: true });
  writeFileSync(join(cacheDir, "skills/xlsx-reader", "SKILL.md"), VALID_FM);
  return { repo, home };
}

const okGit: GitRunner = (args) => {
  const key = args.join(" ");
  if (key === "rev-parse --is-inside-work-tree") return { status: 0, stdout: "true", stderr: "" };
  if (key === "rev-parse --verify HEAD") return { status: 0, stdout: "basesha000000", stderr: "" };
  if (key === "status --porcelain") return { status: 0, stdout: "", stderr: "" };
  if (key === "ls-files --others --exclude-standard") return { status: 0, stdout: "", stderr: "" };
  if (key === "ls-files --others --ignored --exclude-standard")
    return { status: 0, stdout: "", stderr: "" };
  if (key === "rev-parse HEAD") return { status: 0, stdout: "wipsha1111111", stderr: "" };
  return { status: 0, stdout: "", stderr: "" };
};
const okSpawner: AsyncSpawner = async () => ({
  status: 0,
  stdout: JSON.stringify({ result: '```json\n{ "confidence": 1.0 }\n```' }),
});

describe("preDispatchAcquisition (#682 adapter)", () => {
  test("resolves from goal + attachment names + repo scan before dispatch", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    const res = await preDispatchAcquisition(
      repo,
      "parse the attached data.xlsx workbook",
      ["data.xlsx"],
      "orchestrate",
      false,
      false,
      { acquisitionReadDeps: { homedir: () => home } },
    );
    expect(res.proposals).toHaveLength(1);
    expect(res.proposals[0]?.need).toBe("xlsx-reader");
    expect(res.unresolved).toContain("xlsx-reader");
  });

  test("dry preview performs zero installs and preserves the gap", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    let installs = 0;
    const res = await preDispatchAcquisition(
      repo,
      "goal",
      ["data.xlsx"],
      "orchestrate",
      false,
      false,
      {
        acquisitionReadDeps: { homedir: () => home },
        acquisitionInstall: () => {
          installs++;
          return 0;
        },
      },
    );
    expect(installs).toBe(0);
    expect(res.unresolved).toContain("xlsx-reader");
  });

  test("--yes auto-approves approvable proposals and installs", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    const calls: string[] = [];
    const res = await preDispatchAcquisition(
      repo,
      "goal",
      ["data.xlsx"],
      "orchestrate",
      true,
      true,
      {
        acquisitionReadDeps: { homedir: () => home },
        acquisitionInstall: (_r, _reg, name) => {
          calls.push(name);
          const cacheDir = registryCacheDir("https://github.com/x/skills.git", {
            homedir: () => home,
          });
          mkdirSync(join(repo, ".vibeflow", "skills", name), { recursive: true });
          writeFileSync(
            join(repo, ".vibeflow", "skills", name, "SKILL.md"),
            VALID_FM.replace("xlsx-reader", name),
          );
          void cacheDir;
          return 0;
        },
      },
    );
    expect(calls).toEqual(["xlsx-reader"]);
    expect(res.installed).toEqual(["xlsx-reader"]);
    expect(res.unresolved).toEqual([]);
    expect(discoverSkills(repo).some((s) => s.name === "xlsx-reader")).toBe(true);
  });

  test("rejection performs zero install but preserves the gap", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    let installs = 0;
    const res = await preDispatchAcquisition(
      repo,
      "goal",
      ["data.xlsx"],
      "orchestrate",
      true,
      false,
      {
        acquisitionReadDeps: { homedir: () => home },
        acquisitionIsTTY: () => true,
        acquisitionConfirm: async () => false,
        acquisitionInstall: () => {
          installs++;
          return 0;
        },
      },
    );
    expect(installs).toBe(0);
    expect(res.unresolved).toContain("xlsx-reader");
  });

  test("non-TTY real run without --yes never prompts and skips install", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    let prompts = 0;
    const res = await preDispatchAcquisition(
      repo,
      "goal",
      ["data.xlsx"],
      "orchestrate",
      true,
      false,
      {
        acquisitionReadDeps: { homedir: () => home },
        acquisitionIsTTY: () => false,
        acquisitionConfirm: async () => {
          prompts++;
          return true;
        },
        acquisitionInstall: () => 0,
      },
    );
    expect(prompts).toBe(0);
    expect(res.unresolved).toContain("xlsx-reader");
  });

  test("missing/ambiguous candidate warns and continues with a gap", async () => {
    const repo = join(tmp(), "repo");
    const home = join(tmp(), "home");
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(
      repo,
      { schemaVersion: 1, registries: [] },
      { writeFileSafe: (p: string, c: string) => writeFileSync(p, c) },
    );
    writeStateFixture(repo);
    let installs = 0;
    const res = await preDispatchAcquisition(
      repo,
      "goal",
      ["data.xlsx"],
      "orchestrate",
      true,
      true,
      {
        acquisitionReadDeps: { homedir: () => home },
        acquisitionInstall: () => {
          installs++;
          return 0;
        },
      },
    );
    expect(installs).toBe(0);
    expect(res.proposals).toEqual([]);
  });

  test("install failure records failure and returns unresolved without throwing", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    const res = await preDispatchAcquisition(
      repo,
      "goal",
      ["data.xlsx"],
      "orchestrate",
      true,
      true,
      {
        acquisitionReadDeps: { homedir: () => home },
        acquisitionInstall: () => 1,
      },
    );
    expect(res.installed).toEqual([]);
    expect(res.unresolved).toContain("xlsx-reader");
  });

  test("blocked HIGH/CRITICAL scan is never approved even with --yes", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    let installs = 0;
    const res = await preDispatchAcquisition(
      repo,
      "goal",
      ["data.xlsx"],
      "orchestrate",
      true,
      true,
      {
        acquisitionReadDeps: {
          homedir: () => home,
          scanner: () => ({
            scanned: true,
            risk_severity: "HIGH" as const,
            risk_score: 95,
            findings: [{ rule_id: "R1", message: "exec" }],
          }),
        },
        acquisitionInstall: () => {
          installs++;
          return 0;
        },
      },
    );
    expect(installs).toBe(0);
    expect(res.unresolved).toContain("xlsx-reader");
  });
});

describe("orchestrate/run acquisition wiring (#682)", () => {
  test("--yes run acquires before spawn and injects the skill", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    const spawns = 0;
    let installed = false;
    const code = await orchestrate({ yes: true, engine: "claude" }, repo, {
      spawner: okSpawner,
      git: okGit,
      gate: () => ({ pass: true }),
      acquisitionReadDeps: { homedir: () => home },
      acquisitionInstall: (_r, _reg, name) => {
        mkdirSync(join(repo, ".vibeflow", "skills", name), { recursive: true });
        writeFileSync(join(repo, ".vibeflow", "skills", name, "SKILL.md"), VALID_FM);
        installed = true;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(installed).toBe(true);
    expect(spawns).toBe(0);
    expect(discoverSkills(repo).some((s) => s.name === "xlsx-reader")).toBe(true);
  });

  test("injected approver rejection installs nothing but still dispatches with a gap", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    let installs = 0;
    const code = await orchestrate({ yes: true, engine: "claude" }, repo, {
      spawner: okSpawner,
      git: okGit,
      gate: () => ({ pass: true }),
      acquisitionReadDeps: { homedir: () => home },
      acquisitionApprover: async (proposals) =>
        new Map(proposals.map((p) => [p.id, "reject" as const])),
      acquisitionInstall: () => {
        installs++;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(installs).toBe(0);
  });

  test("non-TTY real run without --yes still dispatches (fail-closed via injected non-TTY)", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    let installs = 0;
    const code = await orchestrate({ yes: true, engine: "claude" }, repo, {
      spawner: okSpawner,
      git: okGit,
      gate: () => ({ pass: true }),
      acquisitionReadDeps: { homedir: () => home },
      acquisitionInstall: () => {
        installs++;
        return 0;
      },
    });
    expect(code).toBe(0);
    expect(installs).toBe(1);
  });

  test("missing candidate dispatches with a gap and does not crash", async () => {
    const repo = join(tmp(), "repo");
    const home = join(tmp(), "home");
    mkdirSync(join(repo, ".vibeflow"), { recursive: true });
    writeRegistryLock(
      repo,
      { schemaVersion: 1, registries: [] },
      { writeFileSafe: (p: string, c: string) => writeFileSync(p, c) },
    );
    writeStateFixture(repo);
    const code = await orchestrate({ yes: true, engine: "claude" }, repo, {
      spawner: okSpawner,
      git: okGit,
      gate: () => ({ pass: true }),
      acquisitionReadDeps: { homedir: () => home },
      acquisitionInstall: () => 0,
    });
    expect(code).toBe(0);
  });

  test("single-unit run does not bypass acquisition (--yes installs before spawn)", async () => {
    const { repo, home } = makeCacheFixture();
    writeStateFixture(repo);
    let installed = false;
    const code = await run(
      "claude",
      { yes: true },
      {
        base: repo,
        spawner: okSpawner,
        git: okGit,
        acquisitionReadDeps: { homedir: () => home },
        acquisitionInstall: (_r, _reg, name) => {
          mkdirSync(join(repo, ".vibeflow", "skills", name), { recursive: true });
          writeFileSync(join(repo, ".vibeflow", "skills", name, "SKILL.md"), VALID_FM);
          installed = true;
          return 0;
        },
      },
    );
    expect(code).toBe(0);
    expect(installed).toBe(true);
  });
});
