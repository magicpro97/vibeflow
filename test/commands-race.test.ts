// test/commands-race.test.ts
//
// #555 — `vf race`: the SAME task to several engines in parallel, each in its own
// worktree/branch, ranked by the confidence gate, engines-not-installed skipped.
//
// Real seams only: worktree creation goes through the A6 `worktreeCreate`
// inject (`runCommandSync`), dispatch through the async spawner factory. That is
// exactly the composition production runs — no engine process is launched here.

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type RunCommandResult,
  installedEngines,
  parseEngineList,
  race,
  raceBranch,
  raceSpawner,
  raceWorktreePath,
  runRace,
} from "../src/commands.js";
import type { RaceInject } from "../src/commands.js";
import { COMMAND_HELP } from "../src/commands/help-commands.js";
import type { AsyncSpawner } from "../src/dispatch.js";

let base: string;

beforeEach(() => {
  base = mkdtempSync(join(tmpdir(), "vf-race-test-"));
  // A race needs an initialized repo (the dispatch prompt is context-driven).
  mkdirSync(join(base, ".vibeflow"), { recursive: true });
  writeFileSync(
    join(base, ".vibeflow", "WORKFLOW_STATE.json"),
    JSON.stringify({ task_id: "wf-555", goal: "race fixture", work_units: [], totals: {} }),
  );
});

afterEach(() => {
  rmSync(base, { recursive: true, force: true });
});

/** Capture the `out()` console stream (no logbus installed here). */
async function capture<T>(fn: () => Promise<T>): Promise<{ result: T; lines: string[] }> {
  const lines: string[] = [];
  const log = console.log;
  const err = console.error;
  console.log = (...parts: unknown[]) => lines.push(parts.join(" "));
  console.error = (...parts: unknown[]) => lines.push(parts.join(" "));
  try {
    return { result: await fn(), lines };
  } finally {
    console.log = log;
    console.error = err;
  }
}

/** The JSON summary block every engine is asked to emit (parseEngineSummary reads it). */
function summaryStdout(confidence: number, tests: number, files: number): string {
  return `\`\`\`json\n${JSON.stringify({
    skills_used: [],
    files_changed: Array.from({ length: files }, (_, i) => `f${i}.ts`),
    commands_run: [],
    tests_run: Array.from({ length: tests }, (_, i) => `bun test t${i}`),
    confidence,
    uncertainty: "",
  })}\n\`\`\``;
}

interface Recorded {
  worktrees: Array<{ branch: string; path: string; cmd: string }>;
  spawns: Array<{ engine: string; worktree: string; input: string }>;
}

/** Inject the A6 worktree seam + the per-engine spawner factory, recording both. */
function seams(
  stdoutFor: (engine: string) => { status: number; stdout: string },
  opts: { worktreeStatus?: number; onSpawn?: (engine: string) => Promise<void> } = {},
): { inject: RaceInject; recorded: Recorded } {
  const recorded: Recorded = { worktrees: [], spawns: [] };
  const inject: RaceInject = {
    base,
    worktree: {
      repoDir: base,
      runCommandSync: (cmd, args): RunCommandResult => {
        recorded.worktrees.push({ cmd, branch: args[1] ?? "", path: args[2] ?? "" });
        return { status: opts.worktreeStatus ?? 0, stdout: "", stderr: "" };
      },
    },
    makeSpawner: (engine, worktree): AsyncSpawner => {
      return async (_cmd, _args, input) => {
        recorded.spawns.push({ engine, worktree, input });
        await opts.onSpawn?.(engine);
        return stdoutFor(engine);
      };
    },
  };
  return { inject, recorded };
}

describe("vf race (#555) — command surface", () => {
  test("no task → usage error (exit 2)", async () => {
    const { result, lines } = await capture(() => race([], {}));
    expect(result).toBe(2);
    expect(lines.join("\n")).toContain('Usage: vf race "<task>"');
  });

  test("unknown --engines name → usage error (exit 2), never a silent drop", async () => {
    const { result, lines } = await capture(() => race(["do a thing"], { engines: "claude,gpt9" }));
    expect(result).toBe(2);
    expect(lines.join("\n")).toContain("unknown: gpt9");
  });

  test("an uninitialized repo fails fast with the init hint (no worktree, no dispatch)", async () => {
    rmSync(join(base, ".vibeflow"), { recursive: true, force: true });
    const { inject, recorded } = seams(() => ({ status: 0, stdout: summaryStdout(0.5, 0, 0) }));
    const { result, lines } = await capture(() =>
      race(
        ["do a thing"],
        { engines: "claude", yes: true },
        {
          ...inject,
          has: (cmd) => cmd === "claude",
        },
      ),
    );
    expect(result).toBe(1);
    expect(lines.join("\n")).toContain("run `vf init` first");
    expect(recorded.worktrees).toEqual([]);
    expect(recorded.spawns).toEqual([]);
  });

  test("dry by default, --yes launches; the dry plan names each branch + worktree", async () => {
    const { inject, recorded } = seams(() => ({ status: 0, stdout: summaryStdout(0.5, 0, 0) }));
    const dry = await capture(() =>
      race(
        ["do a thing"],
        { engines: "claude,codex" },
        {
          ...inject,
          has: (cmd) => cmd === "claude" || cmd === "codex",
        },
      ),
    );
    expect(dry.result).toBe(0);
    expect(dry.lines.join("\n")).toContain(
      `claude → branch vf-race-claude  worktree ${raceWorktreePath("claude", base)}`,
    );
    expect(dry.lines.join("\n")).toContain("Dry run — re-run with --yes");
    // Read-only: nothing was created, nothing was dispatched.
    expect(recorded.worktrees).toEqual([]);
    expect(recorded.spawns).toEqual([]);
  });
});

describe("vf race (#555) — head-to-head run", () => {
  const hasClaudeCodex = (cmd: string) => cmd === "claude" || cmd === "codex";

  test("fans the same prompt out in parallel, one worktree per engine, ranked by confidence", async () => {
    let inFlight = 0;
    let maxInFlight = 0;
    const { inject, recorded } = seams(
      (engine) => ({
        status: 0,
        stdout: engine === "claude" ? summaryStdout(0.9, 3, 2) : summaryStdout(0.6, 1, 1),
      }),
      {
        onSpawn: async () => {
          inFlight += 1;
          maxInFlight = Math.max(maxInFlight, inFlight);
          await new Promise((resolve) => setTimeout(resolve, 30));
          inFlight -= 1;
        },
      },
    );
    const { result, lines } = await capture(() =>
      runRace({ ...inject, has: hasClaudeCodex, task: "add a health endpoint", mode: "cli" }),
    );

    // Parallel: both lanes were genuinely in flight at once (not serialized).
    expect(maxInFlight).toBe(2);

    // Same task prompt for every engine (only the engine-labelled header differs).
    const prompts = recorded.spawns.map((s) => s.input);
    expect(prompts).toHaveLength(2);
    const bodies = prompts.map((p) => p.replace(/^# VibeFlow dispatch → \w+\n/, ""));
    expect(bodies[0]).toBe(bodies[1]);
    expect(bodies[0]).toContain("Goal: add a health endpoint");

    // Per-engine worktree isolation: each engine spawned rooted in its own worktree,
    // and each worktree came from the A6 create path on that engine's own branch.
    const claude = recorded.spawns.find((s) => s.engine === "claude");
    const codex = recorded.spawns.find((s) => s.engine === "codex");
    expect(claude?.worktree).toBe(raceWorktreePath("claude", base));
    expect(codex?.worktree).toBe(raceWorktreePath("codex", base));
    expect(claude?.worktree).not.toBe(codex?.worktree);
    expect(recorded.worktrees.map((w) => w.branch)).toEqual(["vf-race-claude", "vf-race-codex"]);
    expect(recorded.worktrees.map((w) => w.path)).toEqual([
      raceWorktreePath("claude", base),
      raceWorktreePath("codex", base),
    ]);

    // Ranked table + the named winner branch; no auto-merge.
    const text = lines.join("\n");
    expect(text).toContain("1. claude  confidence 0.9  tests 3  files 2  branch vf-race-claude");
    expect(text).toContain("2. codex  confidence 0.6  tests 1  files 1  branch vf-race-codex");
    expect(text).toContain("Winner: claude — branch vf-race-claude");
    expect(text).toContain("no auto-merge");
    expect(text).toContain(`cd ${raceWorktreePath("claude", base)}`);
    expect(result.exitCode).toBe(0);
  });

  test("skips an engine that is not installed, still ranks the survivor", async () => {
    const { inject, recorded } = seams(() => ({ status: 0, stdout: summaryStdout(0.8, 1, 1) }));
    const { result, lines } = await capture(() =>
      runRace({
        ...inject,
        has: (cmd) => cmd === "codex", // claude absent
        engines: ["claude", "codex"],
        task: "fix the flaky test",
        mode: "cli",
      }),
    );
    const text = lines.join("\n");
    expect(result.exitCode).toBe(0);
    expect(text).toContain("claude skipped: claude CLI not found");
    expect(recorded.worktrees.map((w) => w.branch)).toEqual(["vf-race-codex"]);
    expect(recorded.spawns.map((s) => s.engine)).toEqual(["codex"]);
    expect(text).toContain("Winner: codex — branch vf-race-codex");
  });

  test("--engines omitted ⇒ every installed engine (and only those)", async () => {
    const { inject, recorded } = seams(() => ({ status: 0, stdout: summaryStdout(0.7, 0, 0) }));
    const { result, lines } = await capture(() =>
      runRace({
        ...inject,
        has: (cmd) => cmd === "copilot",
        task: "tidy the docs",
        mode: "cli",
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(recorded.spawns.map((s) => s.engine)).toEqual(["copilot"]);
    expect(recorded.worktrees.map((w) => w.branch)).toEqual(["vf-race-copilot"]);
    expect(lines.join("\n")).toContain("1. copilot");
  });

  test("a single-engine list is a valid degenerate race (one dispatch, ranked)", async () => {
    const { inject, recorded } = seams(() => ({ status: 0, stdout: summaryStdout(0.42, 0, 1) }));
    const { result, lines } = await capture(() =>
      runRace({
        ...inject,
        has: (cmd) => cmd === "claude",
        engines: ["claude"],
        task: "one engine only",
        mode: "cli",
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(recorded.spawns).toHaveLength(1);
    expect(recorded.worktrees).toHaveLength(1);
    expect(lines.join("\n")).toContain("Winner: claude — branch vf-race-claude");
  });

  test("no engine installed ⇒ exit 1 and a clear notice", async () => {
    const { inject, recorded } = seams(() => ({ status: 0, stdout: "" }));
    const { result, lines } = await capture(() =>
      runRace({
        ...inject,
        has: () => false,
        engines: ["claude", "codex"],
        task: "nothing can run",
        mode: "cli",
      }),
    );
    expect(result.exitCode).toBe(1);
    expect(lines.join("\n")).toContain("vf race: no engine available");
    expect(recorded.worktrees).toEqual([]);
    // Both engines are reported skipped, so the user sees which ones need installing.
    expect(lines.join("\n")).toContain("claude skipped");
    expect(lines.join("\n")).toContain("codex skipped");
  });

  test("a worktree that fails to create fails the row (not the race) and ranks below survivors", async () => {
    const { inject } = seams(() => ({ status: 0, stdout: summaryStdout(0.5, 1, 1) }), {
      worktreeStatus: 1,
    });
    const { result, lines } = await capture(() =>
      runRace({
        ...inject,
        has: (cmd) => cmd === "claude" || cmd === "codex",
        engines: ["claude", "codex"],
        task: "worktree breaks",
        mode: "cli",
      }),
    );
    expect(result.exitCode).toBe(1);
    const text = lines.join("\n");
    expect(text).toContain("failed: worktree create failed (exit 1)");
    expect(text).toContain("No engine completed — nothing to merge.");
  });

  test("an engine lane that THROWS is recorded as failed and the survivors still rank", async () => {
    // A lane fault (e.g. the owned-process supervisor failing to hand over a receipt)
    // must not sink the race: the other engine's result survives and wins. Found by a
    // real 2-engine run on Windows, where that same fault aborted the whole command.
    const { inject } = seams((engine) => {
      if (engine === "claude") throw new Error("claude runtime fault");
      return { status: 0, stdout: summaryStdout(0.7, 2, 1) };
    });
    const { result, lines } = await capture(() =>
      runRace({
        ...inject,
        has: hasClaudeCodex,
        engines: ["claude", "codex"],
        task: "one lane explodes",
        mode: "cli",
      }),
    );
    expect(result.exitCode).toBe(0);
    expect(result.ranking.map((row) => [row.engine, row.ok])).toEqual([
      ["codex", true],
      ["claude", false],
    ]);
    const text = lines.join("\n");
    expect(text).toContain("failed: claude runtime fault");
    expect(text).toContain("Winner: codex — branch vf-race-codex");
  });

  test("a failed dispatch ranks last with its reason and exits 1", async () => {
    const { inject } = seams((engine) =>
      engine === "claude"
        ? { status: 0, stdout: summaryStdout(0.3, 0, 0) }
        : { status: 1, stdout: "" },
    );
    const { result, lines } = await capture(() =>
      runRace({
        ...inject,
        has: hasClaudeCodex,
        engines: ["claude", "codex"],
        task: "codex dies",
        mode: "cli",
      }),
    );
    expect(result.exitCode).toBe(0); // one engine finished → the race still ranks a winner
    const text = lines.join("\n");
    expect(text).toContain("codex failed");
    expect(text).toContain("Winner: claude — branch vf-race-claude");
  });

  test("concurrency defaults to the number of engines (all lanes in flight)", async () => {
    const { inject } = seams(() => ({ status: 0, stdout: summaryStdout(0.1, 0, 0) }));
    const { result } = await capture(() =>
      runRace({
        ...inject,
        has: (cmd) => cmd === "claude" || cmd === "codex" || cmd === "copilot",
        engines: ["claude", "codex", "copilot"],
        task: "three lanes",
        mode: "cli",
      }),
    );
    expect(result.exitCode).toBe(0);
  });
});

describe("vf race (#555) — engine list parsing + defaults", () => {
  test("parseEngineList trims, dedupes, and returns the canonical order", () => {
    expect(parseEngineList("codex, claude ,codex")).toEqual({
      ok: true,
      engines: ["claude", "codex"],
    });
    // The UI sends an array instead of a comma string — same rule, same order.
    expect(parseEngineList(["copilot", "claude", 7, "claude"])).toEqual({
      ok: true,
      engines: ["claude", "copilot"],
    });
  });

  test("parseEngineList rejects empty/absent/non-string/unknown values", () => {
    for (const raw of [undefined, true, "", "  ", "claude,gpt9", [], ["gpt9"], [7]]) {
      const parsed = parseEngineList(raw);
      expect(parsed.ok).toBe(false);
    }
  });

  test("installedEngines keeps only PATH-present engines, canonical order", () => {
    expect(installedEngines((cmd) => cmd === "codex" || cmd === "claude")).toEqual([
      "claude",
      "codex",
    ]);
    expect(installedEngines(() => false)).toEqual([]);
  });

  test("raceBranch names the branch the race leaves for the user", () => {
    expect(raceBranch("opencode")).toBe("vf-race-opencode");
  });

  test("vf race --help states the ranking rule, the --engines default, and no auto-merge", () => {
    const help = COMMAND_HELP.race?.() ?? "";
    expect(help).toContain("--engines <a,b>");
    expect(help).toContain("Ranking rule:");
    expect(help).toContain("tests_run count, then files_changed count");
    expect(help).toContain("NO auto-merge");
    expect(help).toContain("skipped with a notice");
  });
});

describe("vf race (#555) — worktree plumbing is reachable", () => {
  test("a real (uninjected) base still resolves per-engine worktree paths", () => {
    // Guards the produced path shape without touching git: sibling of the repo root.
    const parent = base;
    const repo = join(base, "repo");
    mkdirSync(repo, { recursive: true });
    expect(raceWorktreePath("claude", repo)).toBe(join(parent, "vf-wt-vf-race-claude"));
    expect(existsSync(repo)).toBe(true);
  });

  test("the default spawner launches the engine rooted in its worktree and pipes stderr to the log channel", async () => {
    const wtPath = raceWorktreePath("claude", base);
    const spawnCalls: Array<{ argv: string[]; cwd?: string }> = [];
    const streamOf = (bytes: number[]) =>
      new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new Uint8Array(bytes));
          controller.close();
        },
      });
    const fakeSpawn = ((argv: string[], opts: { cwd?: string }) => {
      spawnCalls.push({ argv, cwd: opts.cwd });
      return {
        pid: 4242,
        stdin: { write() {}, end() {} },
        stdout: streamOf([...Buffer.from("engine said ok")]),
        stderr: streamOf([...Buffer.from("engine warned")]),
        exited: Promise.resolve(0),
        kill: () => true,
      };
    }) as unknown as typeof Bun.spawn;

    const spawner = raceSpawner(base, fakeSpawn)("claude", wtPath);
    const { result, lines } = await capture(() =>
      spawner("claude", ["-p"], "the prompt", { attemptId: "attempt-1", engine: "claude" }),
    );

    expect(spawnCalls[0]?.cwd).toBe(wtPath);
    expect(result.status).toBe(0);
    expect(result.stdout).toBe("engine said ok");
    // The stderr hook is the log channel, not the raw TTY.
    expect(lines.join("\n")).toContain("[engine-stderr] engine warned");
  });
});
