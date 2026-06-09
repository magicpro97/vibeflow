import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyIntake, mutateUnits, orchestrate, run, workflow } from "../src/commands.js";
import { CTX_DIR, type WorkflowState, readState } from "../src/core.js";
import type { AsyncSpawner } from "../src/dispatch.js";
import type { GitRunner } from "../src/safety/checkpoint.js";
import { writeSettings } from "../src/settings.js";

/** Capture stdout/stderr so we can assert on what a command rendered. */
function captureConsole(): { out: string[]; restore: () => void } {
  const out: string[] = [];
  const origLog = console.log;
  const origErr = console.error;
  console.log = (...a: unknown[]) => out.push(a.join(" "));
  console.error = (...a: unknown[]) => out.push(a.join(" "));
  return {
    out,
    restore: () => {
      console.log = origLog;
      console.error = origErr;
    },
  };
}

/** A fully-configurable fake git seam — no real git ever runs in these tests. */
function fakeGit(
  opts: {
    isRepo?: boolean;
    hasCommits?: boolean;
    dirty?: boolean;
    ignored?: string[];
  } = {},
): { runner: GitRunner; calls: string[][] } {
  const { isRepo = true, hasCommits = true, dirty = false, ignored = [] } = opts;
  const calls: string[][] = [];
  const ok = (stdout = "") => ({ status: 0, stdout, stderr: "" });
  const fail = () => ({ status: 1, stdout: "", stderr: "" });
  const runner: GitRunner = (args) => {
    calls.push(args);
    const key = args.join(" ");
    if (key === "rev-parse --is-inside-work-tree") return isRepo ? ok("true") : fail();
    if (key === "rev-parse --verify HEAD") return hasCommits ? ok("basesha000000") : fail();
    if (key === "status --porcelain") return ok(dirty ? " M file.ts\n" : "");
    if (key === "ls-files --others --exclude-standard") return ok(dirty ? "new.ts\n" : "");
    if (key === "ls-files --others --ignored --exclude-standard") return ok(ignored.join("\n"));
    if (key === "rev-parse HEAD") return ok("wipsha1111111");
    return ok();
  };
  return { runner, calls };
}

/** A spawner that always returns a confident success (confidence 1.0). */
const okSpawner: AsyncSpawner = async () => ({
  status: 0,
  stdout: JSON.stringify({ result: '```json\n{ "confidence": 1.0 }\n```' }),
});

function freshRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "vf-int-"));
  applyIntake({ goal: "g", engines: ["claude"] }, { useAi: false, base: dir });
  return dir;
}

describe("orchestrate source-protection gate", () => {
  let dir: string;
  let cap: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    dir = freshRepo();
    cap = captureConsole();
  });
  afterEach(() => {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("--require-git refuses a non-git repo and never dispatches", async () => {
    let dispatched = false;
    const spawner: AsyncSpawner = async () => {
      dispatched = true;
      return { status: 0, stdout: "" };
    };
    const { runner } = fakeGit({ isRepo: false });
    const code = await orchestrate({ engine: "claude", yes: true, "require-git": true }, dir, {
      spawner,
      git: runner,
    });
    expect(code).toBe(1);
    expect(dispatched).toBe(false);
    expect(cap.out.join("\n").toLowerCase()).toContain("not a git repository");
  });

  test("non-git WITHOUT --require-git warns and proceeds (no checkpoint)", async () => {
    const { runner } = fakeGit({ isRepo: false });
    const code = await orchestrate({ engine: "claude", yes: true }, dir, {
      spawner: okSpawner,
      git: runner,
    });
    expect(code).toBe(0);
    expect(cap.out.join("\n")).toContain("no git");
  });

  test("dirty tree WITHOUT --auto-wip refuses with a commit/stash message", async () => {
    let dispatched = false;
    const spawner: AsyncSpawner = async () => {
      dispatched = true;
      return { status: 0, stdout: "" };
    };
    const { runner } = fakeGit({ dirty: true });
    const code = await orchestrate({ engine: "claude", yes: true }, dir, { spawner, git: runner });
    expect(code).toBe(1);
    expect(dispatched).toBe(false);
    expect(cap.out.join("\n").toLowerCase()).toContain("--auto-wip");
  });

  test("dirty tree WITH --auto-wip makes a WIP snapshot and records checkpoint evidence", async () => {
    const { runner, calls } = fakeGit({ dirty: true });
    const code = await orchestrate({ engine: "claude", yes: true, "auto-wip": true }, dir, {
      spawner: okSpawner,
      git: runner,
    });
    expect(code).toBe(0);
    // a WIP commit was made
    expect(calls.some((a) => a[0] === "commit")).toBe(true);
    const after = readState(dir) as WorkflowState;
    const evidence = after.work_units[0]?.evidence ?? [];
    expect(evidence.some((e) => e.includes("checkpoint.json"))).toBe(true);
    const cp = JSON.parse(
      readFileSync(
        join(
          dir,
          CTX_DIR,
          "workunits",
          after.work_units[0]?.name ?? "",
          "evidence",
          "checkpoint.json",
        ),
        "utf8",
      ),
    ) as { wipSha: string | null; recovery: string };
    expect(cp.wipSha).toBe("wipsha1111111");
    expect(cp.recovery).toContain("git reset --hard");
  });

  test("clean repo takes a (no-WIP) checkpoint and dispatches", async () => {
    const { runner, calls } = fakeGit({ dirty: false });
    const code = await orchestrate({ engine: "claude", yes: true }, dir, {
      spawner: okSpawner,
      git: runner,
    });
    expect(code).toBe(0);
    // clean → no WIP commit
    expect(calls.some((a) => a[0] === "commit")).toBe(false);
    const after = readState(dir) as WorkflowState;
    expect((after.work_units[0]?.evidence ?? []).some((e) => e.includes("checkpoint.json"))).toBe(
      true,
    );
  });

  test("dry mode skips protection entirely (no git probe)", async () => {
    const { runner, calls } = fakeGit({ isRepo: false });
    const code = await orchestrate({ engine: "claude", dry: true }, dir, { git: runner });
    expect(code).toBe(0);
    expect(calls.length).toBe(0); // protection never engaged
  });
});

describe("orchestrate dry mode is read-only", () => {
  let dir: string;
  let cap: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    dir = freshRepo();
    mutateUnits(dir, "add", { name: "auth" });
    cap = captureConsole();
  });
  afterEach(() => {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a dry run leaves WORKFLOW_STATE.json byte-identical and writes no result evidence", async () => {
    const statePath = join(dir, CTX_DIR, "WORKFLOW_STATE.json");
    const before = readFileSync(statePath, "utf8");
    let dispatched = false;
    const spawner: AsyncSpawner = async () => {
      dispatched = true;
      return { status: 0, stdout: "" };
    };
    const code = await orchestrate({ engine: "claude", dry: true }, dir, { spawner });
    expect(code).toBe(0);
    // dry never launches the engine and never mutates the persisted ledger.
    expect(dispatched).toBe(false);
    expect(readFileSync(statePath, "utf8")).toBe(before);
    // no result JSON is written into the work unit on a dry run …
    expect(
      existsSync(join(dir, CTX_DIR, "workunits", "auth", "evidence", "claude.result.json")),
    ).toBe(false);
    // … but the CONTEXT.md prompt preview IS written (the one intended dry side-effect).
    expect(existsSync(join(dir, CTX_DIR, "workunits", "auth", "CONTEXT.md"))).toBe(true);
  });

  test("re-running a real dispatch does not accumulate duplicate evidence paths", async () => {
    const { runner } = fakeGit({ dirty: false });
    await orchestrate({ engine: "claude", yes: true }, dir, { spawner: okSpawner, git: runner });
    const { runner: runner2 } = fakeGit({ dirty: false });
    await orchestrate({ engine: "claude", yes: true }, dir, { spawner: okSpawner, git: runner2 });
    const evidence =
      (readState(dir) as WorkflowState).work_units.find((u) => u.name === "auth")?.evidence ?? [];
    // a real run STILL persists evidence (non-regression) …
    const resultPaths = evidence.filter((e) => e.includes("claude.result.json"));
    expect(resultPaths.length).toBe(1); // … but exactly once, no duplicates across re-runs.
  });
});

describe("orchestrate failure + rollback", () => {
  let dir: string;
  let cap: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    dir = freshRepo();
    cap = captureConsole();
  });
  afterEach(() => {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a failed unit prints the recovery hint but KEEPS edits by default", async () => {
    const { runner, calls } = fakeGit({ dirty: false });
    const failSpawner: AsyncSpawner = async () => ({ status: 1, stdout: "" });
    const code = await orchestrate({ engine: "claude", yes: true }, dir, {
      spawner: failSpawner,
      git: runner,
    });
    expect(code).toBe(1);
    expect(calls.some((a) => a[0] === "reset")).toBe(false); // no rollback by default
    expect(cap.out.join("\n")).toContain("git status");
  });

  test("--rollback-on-fail hard-resets to the base ref on a failed unit", async () => {
    // dirty + auto-wip so the checkpoint records a baseRef to reset back to.
    const { runner, calls } = fakeGit({ dirty: true });
    const failSpawner: AsyncSpawner = async () => ({ status: 1, stdout: "" });
    const code = await orchestrate(
      { engine: "claude", yes: true, "auto-wip": true, "rollback-on-fail": true },
      dir,
      { spawner: failSpawner, git: runner },
    );
    expect(code).toBe(1);
    const reset = calls.find((a) => a[0] === "reset");
    expect(reset).toEqual(["reset", "--hard", "basesha000000"]);
    expect(cap.out.join("\n").toLowerCase()).toContain("rolled back");
  });

  test("a timed-out dispatch blocks the unit with reason 'timeout' in evidence", async () => {
    const { runner } = fakeGit({ dirty: false });
    const timeoutSpawner: AsyncSpawner = async () => ({ status: 124, stdout: "", timedOut: true });
    const code = await orchestrate({ engine: "claude", yes: true }, dir, {
      spawner: timeoutSpawner,
      git: runner,
    });
    expect(code).toBe(1);
    const after = readState(dir) as WorkflowState;
    const unit = after.work_units[0];
    expect(unit?.status).toBe("blocked");
    const resultPath = join(
      dir,
      CTX_DIR,
      "workunits",
      unit?.name ?? "",
      "evidence",
      "claude.result.json",
    );
    const result = JSON.parse(readFileSync(resultPath, "utf8")) as { reason?: string };
    expect(result.reason).toBe("timeout");
  });
});

describe("orchestrate quota stop", () => {
  let dir: string;
  let cap: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    dir = freshRepo();
    // two disjoint-scope units so they run in parallel lanes
    mutateUnits(dir, "add", { name: "a", scope: ["src/a/"] });
    mutateUnits(dir, "add", { name: "b", scope: ["src/b/"] });
    cap = captureConsole();
  });
  afterEach(() => {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("a HIGH-confidence rate-limit signal stops not-yet-started units", async () => {
    const { runner } = fakeGit({ dirty: false });
    let n = 0;
    // First lane returns a typed 429 error envelope; later units must be skipped.
    const quotaSpawner: AsyncSpawner = async () => {
      n++;
      if (n === 1) {
        return { status: 1, stdout: JSON.stringify({ error: { type: "rate_limit_error" } }) };
      }
      // give the latch time: slow second call so the first result lands first
      await new Promise((r) => setTimeout(r, 5));
      return { status: 0, stdout: "" };
    };
    const code = await orchestrate({ engine: "claude", yes: true, concurrency: "1" }, dir, {
      spawner: quotaSpawner,
      git: runner,
    });
    expect(code).toBe(1);
    const after = readState(dir) as WorkflowState;
    const skipped = after.work_units.find((u) =>
      (u.evidence ?? []).some((e) => e.includes("upstream rate limit")),
    );
    expect(skipped).toBeDefined();
    expect(cap.out.join("\n")).toContain("stopping remaining units");
  });
});

describe("run() source-protection + prompt delivery", () => {
  let dir: string;
  let cap: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    dir = freshRepo();
    cap = captureConsole();
  });
  afterEach(() => {
    cap.restore();
    rmSync(dir, { recursive: true, force: true });
  });

  test("dirty repo with --yes refuses and NEVER launches the engine", async () => {
    let dispatched = false;
    const spawner: AsyncSpawner = async () => {
      dispatched = true;
      return { status: 0, stdout: "" };
    };
    const { runner } = fakeGit({ dirty: true });
    const code = await run("claude", { yes: true }, { base: dir, git: runner, spawner });
    expect(code).toBe(1);
    expect(dispatched).toBe(false);
    expect(cap.out.join("\n").toLowerCase()).toContain("--auto-wip");
  });

  test("clean repo with --yes checkpoints and DELIVERS the prompt to the engine", async () => {
    let delivered = "";
    const spawner: AsyncSpawner = async (_cmd, _args, input) => {
      delivered = input;
      return { status: 0, stdout: JSON.stringify({ result: "done" }) };
    };
    const { runner, calls } = fakeGit({ dirty: false });
    const code = await run("claude", { yes: true }, { base: dir, git: runner, spawner });
    expect(code).toBe(0);
    // clean → a (no-WIP) checkpoint, no WIP commit
    expect(calls.some((a) => a[0] === "commit")).toBe(false);
    expect(calls.some((a) => a.join(" ") === "status --porcelain")).toBe(true);
    // BUG 2: the dispatch prompt actually reached the engine on stdin.
    expect(delivered).toContain("VibeFlow dispatch → claude");
  });

  test("dry run (no --yes) never gates git and never launches — exit 0", async () => {
    let dispatched = false;
    const spawner: AsyncSpawner = async () => {
      dispatched = true;
      return { status: 0, stdout: "" };
    };
    const { runner, calls } = fakeGit({ dirty: true });
    const code = await run("claude", {}, { base: dir, git: runner, spawner });
    expect(code).toBe(0);
    expect(dispatched).toBe(false);
    expect(calls.length).toBe(0); // protection never engaged on a dry run
  });

  test("non-git + --require-git refuses; without it warns and proceeds", async () => {
    const { runner } = fakeGit({ isRepo: false });
    const refused = await run(
      "claude",
      { yes: true, "require-git": true },
      { base: dir, git: runner, spawner: okSpawner },
    );
    expect(refused).toBe(1);
    expect(cap.out.join("\n").toLowerCase()).toContain("not a git repository");

    const { runner: runner2 } = fakeGit({ isRepo: false });
    const ok = await run("claude", { yes: true }, { base: dir, git: runner2, spawner: okSpawner });
    expect(ok).toBe(0);
    expect(cap.out.join("\n")).toContain("no git");
  });

  test("a failed engine prints the recovery hint (and keeps edits by default)", async () => {
    const { runner, calls } = fakeGit({ dirty: false });
    const failSpawner: AsyncSpawner = async () => ({ status: 1, stdout: "" });
    const code = await run(
      "claude",
      { yes: true },
      { base: dir, git: runner, spawner: failSpawner },
    );
    expect(code).toBe(1);
    expect(calls.some((a) => a[0] === "reset")).toBe(false); // no rollback by default
    expect(cap.out.join("\n")).toContain("git status");
  });
});

describe("workflow command", () => {
  let cap: ReturnType<typeof captureConsole>;
  beforeEach(() => {
    cap = captureConsole();
  });
  afterEach(() => cap.restore());

  test("delete is dry by default — prints the plan and removes nothing", () => {
    const dir = freshRepo();
    try {
      const code = workflow("delete", [], { repo: dir });
      expect(code).toBe(0);
      expect(existsSync(join(dir, CTX_DIR))).toBe(true); // still there
      const text = cap.out.join("\n");
      expect(text).toContain("Would remove");
      expect(text.toLowerCase()).toContain("--yes");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("delete --yes removes the .viteflow dir but preserves engine files", () => {
    const dir = freshRepo();
    try {
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true);
      const code = workflow("delete", [], { repo: dir, yes: true });
      expect(code).toBe(0);
      expect(existsSync(join(dir, CTX_DIR))).toBe(false);
      expect(existsSync(join(dir, "CLAUDE.md"))).toBe(true); // preserved without --all
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("delete-unit removes a named unit and lists names when missing", () => {
    const dir = freshRepo();
    try {
      mutateUnits(dir, "add", { name: "auth" });
      expect(workflow("delete-unit", ["auth"], { repo: dir })).toBe(0);
      expect(readState(dir)?.work_units.length).toBe(0);
      // missing unit → exit 1 + lists availability
      expect(workflow("delete-unit", ["ghost"], { repo: dir })).toBe(1);
      expect(cap.out.join("\n").toLowerCase()).toContain("no such unit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("import is dry by default and persists only with --yes", () => {
    const dest = freshRepo();
    const src = freshRepo();
    try {
      mutateUnits(src, "add", { name: "imported" });
      // dry: prints plan, dest unchanged
      expect(workflow("import", [src], { repo: dest })).toBe(0);
      expect(readState(dest)?.work_units.length).toBe(0);
      expect(cap.out.join("\n")).toContain("Import plan");
      // --yes: merged unit lands (reset to pending)
      expect(workflow("import", [src], { repo: dest, yes: true })).toBe(0);
      const merged = readState(dest) as WorkflowState;
      expect(merged.work_units.some((u) => u.name === "imported")).toBe(true);
    } finally {
      rmSync(dest, { recursive: true, force: true });
      rmSync(src, { recursive: true, force: true });
    }
  });

  test("import returns 1 with a clear message when the source has no workflow", () => {
    const dest = freshRepo();
    const emptySrc = mkdtempSync(join(tmpdir(), "vf-empty-"));
    try {
      expect(workflow("import", [emptySrc], { repo: dest })).toBe(1);
      expect(cap.out.join("\n").toLowerCase()).toContain("must exist");
    } finally {
      rmSync(dest, { recursive: true, force: true });
      rmSync(emptySrc, { recursive: true, force: true });
    }
  });

  test("unknown subcommand prints usage and exits 2", () => {
    expect(workflow("bogus", [], {})).toBe(2);
  });

  test("toggling failureProtection settings is honored by the gate (requireGit refuses non-git)", async () => {
    const dir = freshRepo();
    const cap2 = captureConsole();
    try {
      writeSettings(dir, {
        failureProtection: {
          timeoutSeconds: 600,
          autoWip: false,
          rollbackOnFail: false,
          requireGit: true,
        },
      });
      const { runner } = fakeGit({ isRepo: false });
      const code = await orchestrate({ engine: "claude", yes: true }, dir, {
        spawner: okSpawner,
        git: runner,
      });
      expect(code).toBe(1);
      expect(cap2.out.join("\n").toLowerCase()).toContain("not a git repository");
    } finally {
      cap2.restore();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("normalizeUnit round-trips skills-first fields (anti-regression)", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshRepo();
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("an update through mutateUnits→normalizeUnit preserves all five new fields", () => {
    mutateUnits(dir, "add", { name: "auth" });
    mutateUnits(dir, "update", {
      name: "auth",
      knowledge_heavy: true,
      knowledge_heavy_source: "risk",
      skills_injected: ["a", "b"],
      skills_required: ["a"],
      skill_waiver: { reason: "no verified skill yet", at: "2026-06-09", by: "linh" },
    });
    const u = (readState(dir) as WorkflowState).work_units.find((x) => x.name === "auth");
    expect(u?.knowledge_heavy).toBe(true);
    expect(u?.knowledge_heavy_source).toBe("risk");
    expect(u?.skills_injected).toEqual(["a", "b"]);
    expect(u?.skills_required).toEqual(["a"]);
    expect(u?.skill_waiver).toEqual({
      reason: "no verified skill yet",
      at: "2026-06-09",
      by: "linh",
    });
  });

  test("normalizeUnit rejects malformed field values", () => {
    mutateUnits(dir, "add", { name: "auth" });
    mutateUnits(dir, "update", {
      name: "auth",
      // intentionally malformed inputs that the whitelist must drop
      knowledge_heavy_source: "bogus" as never,
      skills_injected: "notarray" as never,
      skill_waiver: { at: "2026-06-09" } as never, // missing string `reason`
    });
    const u = (readState(dir) as WorkflowState).work_units.find((x) => x.name === "auth");
    expect(u?.knowledge_heavy_source).toBeUndefined();
    expect(u?.skills_injected).toBeUndefined();
    expect(u?.skill_waiver).toBeUndefined();
  });
});
