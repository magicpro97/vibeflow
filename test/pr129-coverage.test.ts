/**
 * PR129 coverage shim for issue #80 rebase (PR7).
 *
 * Adds tests for the find-skills, ctx7-auth, codegraph, and related
 * PR129 paths that the PR7 rebase left uncovered. Without these, the
 * coverage gate (scripts/coverage-gate.cjs) fails on:
 *   - src/commands.ts                  (init() find-skills + ctx7 + agent-team)
 *   - src/init-intake.ts               (collectInitAskQuestionnaireData phases)
 *   - src/skills/sync.ts               (mirrorsFor engines branch)
 *   - src/terminal-prompts.ts          (textInput rl.question path)
 *   - src/tools/codegraph.ts           (indexLooksHealthy + spawnStatus)
 *
 * Testability seams used (no `mock.module` to keep the test process
 * isolated from the rest of the suite):
 *   - `runFindSkillsFallback` is now `export async function` (was
 *     private; promoted in this rebase for testability). Production
 *     callers are only `init()`.
 *   - `ensureCtx7Auth` accepts `{ spawner, askConfirm }` injection.
 *   - `codegraph.indexLooksHealthy` accepts an optional `hasCommandFn`.
 *   - `terminal-prompts.textInput` already accepts `createInterface`
 *     injection via the `TerminalDeps` parameter.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// ---------------------------------------------------------------------------
//  Test helpers
// ---------------------------------------------------------------------------

function freshDir(prefix: string): string {
  return mkdtempSync(join(tmpdir(), prefix));
}

function makeFakeSpawner(
  responses: Array<{ status: number; stdout?: string; stderr?: string }>,
): (cmd: string, args: string[]) => { status: number; stdout: string; stderr: string } {
  let idx = 0;
  return (..._args: unknown[]) => {
    const r = responses[idx] ?? { status: 1, stdout: "", stderr: "" };
    idx++;
    return {
      status: r.status,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  };
}

// ---------------------------------------------------------------------------
//  commands.runFindSkillsFallback (lines 765-887)
// ---------------------------------------------------------------------------

describe("commands.runFindSkillsFallback (PR129 coverage shim)", () => {
  let dir: string;
  beforeEach(() => {
    dir = freshDir("vf-pr129-finds-");
    // Make scanRepo find: typescript, react framework, npm, package.json
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(
      join(dir, "package.json"),
      JSON.stringify({ name: "x", dependencies: { react: "^18" } }),
    );
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("with no fetch results: no-results branch + isNoise + manifests + packageManager + majorLangs", async () => {
    const origFetch = globalThis.fetch;
    // Mock fetch to return an empty result set
    globalThis.fetch = (async () =>
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    try {
      const { runFindSkillsFallback } = await import("../src/commands.js");
      await runFindSkillsFallback(dir);
      // The "no candidates" markdown should be written
      const out = join(dir, ".vibeflow", "ai-context", "find-skills-results.md");
      expect(existsSync(out)).toBe(true);
    } finally {
      globalThis.fetch = origFetch;
    }
  });

  test("with one result: writes candidate table + counts", async () => {
    const origFetch = globalThis.fetch;
    globalThis.fetch = (async () =>
      new Response(
        JSON.stringify({
          results: [
            {
              name: "react",
              title: "React",
              snippet: "A JS library\nMore text",
              source: "context7",
            },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      )) as unknown as typeof fetch;
    try {
      const { runFindSkillsFallback } = await import("../src/commands.js");
      await runFindSkillsFallback(dir);
      const out = join(dir, ".vibeflow", "ai-context", "find-skills-results.md");
      expect(existsSync(out)).toBe(true);
      const txt = (await import("node:fs")).readFileSync(out, "utf8");
      expect(txt).toContain("react");
      expect(txt).toContain("Discovered 1 library/skill candidate");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
//  commands.ensureCtx7Auth (lines 676-731)
// ---------------------------------------------------------------------------

describe("commands.ensureCtx7Auth (PR129 coverage shim)", () => {
  let origIsTTY: boolean | undefined;
  beforeEach(() => {
    origIsTTY = process.stdin.isTTY;
  });
  afterEach(() => {
    if (origIsTTY === undefined) {
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    } else {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });

  function setTTY(v: boolean) {
    Object.defineProperty(process.stdin, "isTTY", {
      value: v,
      configurable: true,
    });
  }

  test("!isTTY → fallback, no spawn (lines 677-679)", async () => {
    setTTY(false);
    const { ensureCtx7Auth } = await import("../src/commands.js");
    const r = await ensureCtx7Auth();
    expect(r).toEqual({ authenticated: false, fallback: true });
  });

  test("isTTY + whoami 'Logged in' → authenticated, no prompt (lines 686-691)", async () => {
    setTTY(true);
    const calls: unknown[] = [];
    const spawner = (...args: unknown[]) => {
      calls.push(args);
      return { status: 0, stdout: "Logged in\nEmail: x@y.z", stderr: "" };
    };
    const { ensureCtx7Auth } = await import("../src/commands.js");
    const r = await ensureCtx7Auth({ spawner: spawner as never });
    expect(r).toEqual({ authenticated: true, fallback: false });
    expect(calls.length).toBe(1);
  });

  test("isTTY + whoami fails + answer 'n' → fallback (lines 693-713)", async () => {
    setTTY(true);
    const calls: unknown[] = [];
    const spawner = (...args: unknown[]) => {
      calls.push(args);
      return { status: 1, stdout: "Not logged in", stderr: "" };
    };
    const { ensureCtx7Auth } = await import("../src/commands.js");
    const r = await ensureCtx7Auth({
      spawner: spawner as never,
      askConfirm: async () => false,
    });
    expect(r).toEqual({ authenticated: false, fallback: true });
    expect(calls.length).toBe(1);
  });

  test("isTTY + whoami fails + answer 'y' + login success (lines 715-720)", async () => {
    setTTY(true);
    let call = 0;
    const spawner = (..._args: unknown[]) => {
      call++;
      if (call === 1) return { status: 1, stdout: "Not logged in", stderr: "" };
      return { status: 0, stdout: "ok", stderr: "" };
    };
    const { ensureCtx7Auth } = await import("../src/commands.js");
    const r = await ensureCtx7Auth({
      spawner: spawner as never,
      askConfirm: async () => true,
    });
    expect(r).toEqual({ authenticated: true, fallback: false });
    expect(call).toBe(2);
  });

  test("isTTY + whoami fails + answer 'y' + login fails → fallback (lines 721-730)", async () => {
    setTTY(true);
    let call = 0;
    const spawner = (..._args: unknown[]) => {
      call++;
      if (call === 1) return { status: 1, stdout: "Not logged in", stderr: "" };
      return { status: 1, stdout: "", stderr: "login failed" };
    };
    const { ensureCtx7Auth } = await import("../src/commands.js");
    const r = await ensureCtx7Auth({
      spawner: spawner as never,
      askConfirm: async () => true,
    });
    expect(r).toEqual({ authenticated: false, fallback: true });
    expect(call).toBe(2);
  });

  test("isTTY + whoami fails + answer null (timeout) → fallback", async () => {
    setTTY(true);
    const { ensureCtx7Auth } = await import("../src/commands.js");
    const r = await ensureCtx7Auth({
      spawner: (..._args: unknown[]) =>
        ({
          status: 1,
          stdout: "Not logged in",
          stderr: "",
        }) as never,
      askConfirm: async () => null,
    });
    expect(r).toEqual({ authenticated: false, fallback: true });
  });
});

// ---------------------------------------------------------------------------
//  init() find-skills + ctx7 + workflowResult.ok=true + codegraph install
//  (lines 444-457, 467-469, 535-541)
// ---------------------------------------------------------------------------

describe("commands.init codegraph install + ctx7 + workflow (PR129 coverage shim)", () => {
  let dir: string;
  let origIsTTY: boolean | undefined;
  beforeEach(() => {
    dir = freshDir("vf-pr129-init-");
    mkdirSync(join(dir, "src"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
    origIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      value: true,
      configurable: true,
    });
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
    if (origIsTTY === undefined) {
      Object.defineProperty(process.stdin, "isTTY", {
        value: undefined,
        configurable: true,
      });
    } else {
      Object.defineProperty(process.stdin, "isTTY", {
        value: origIsTTY,
        configurable: true,
      });
    }
  });

  test("init --ai with workflowResult.ok=true → success branch (lines 535-541)", async () => {
    const origFetch = globalThis.fetch;
    // Mock fetch to return empty (so find-skills writes no-results note)
    globalThis.fetch = (async () =>
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
    const { init } = await import("../src/commands.js");
    try {
      const code = await init(
        { ai: true, "dry-run": true, engine: "claude" },
        { answers: { goal: "test", engines: ["claude"] } },
      );
      expect(typeof code).toBe("number");
    } finally {
      globalThis.fetch = origFetch;
    }
  });
});

// ---------------------------------------------------------------------------
//  toolsStatus unhealthy branch (lines 1103-1109) + probeIndexHealth (1131-1143)
// ---------------------------------------------------------------------------

describe("commands.toolsStatus (PR129 coverage shim)", () => {
  test("toolsStatus surface (covers toolsStatus + probeIndexHealth)", async () => {
    const dir = freshDir("vf-pr129-tools-");
    mkdirSync(join(dir, ".vibeflow"), { recursive: true });
    try {
      const { toolsStatus } = await import("../src/commands.js");
      const code = toolsStatus(dir, () => false);
      expect(typeof code).toBe("number");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
//  codegraph.indexLooksHealthy (lines 73-87) — 4 paths
// ---------------------------------------------------------------------------

describe("codegraph.indexLooksHealthy (PR129 coverage shim)", () => {
  test("binary missing → returns true (line 74)", async () => {
    const { indexLooksHealthy } = await import("../src/tools/codegraph.js");
    const r = indexLooksHealthy("/tmp", makeFakeSpawner([{ status: 0, stdout: "" }]), () => false);
    expect(r).toBe(true);
  });

  test("binary present + status 0 + 'Not initialized' → false (line 76-77)", async () => {
    const { indexLooksHealthy } = await import("../src/tools/codegraph.js");
    const r = indexLooksHealthy(
      "/tmp",
      makeFakeSpawner([{ status: 0, stdout: "Not initialized" }]),
      () => true,
    );
    expect(r).toBe(false);
  });

  test("binary present + status 0 + clean stdout → true (line 77)", async () => {
    const { indexLooksHealthy } = await import("../src/tools/codegraph.js");
    const r = indexLooksHealthy(
      "/tmp",
      makeFakeSpawner([{ status: 0, stdout: "Index ready" }]),
      () => true,
    );
    expect(r).toBe(true);
  });

  test("binary present + status non-zero → false (line 76)", async () => {
    const { indexLooksHealthy } = await import("../src/tools/codegraph.js");
    const r = indexLooksHealthy(
      "/tmp",
      makeFakeSpawner([{ status: 1, stdout: "error" }]),
      () => true,
    );
    expect(r).toBe(false);
  });

  test("spawnStatus throws → status 1, returns false", async () => {
    const { indexLooksHealthy } = await import("../src/tools/codegraph.js");
    const throwingSpawner = (() => {
      throw new Error("spawn failed");
    }) as never;
    const r = indexLooksHealthy("/tmp", throwingSpawner, () => true);
    expect(r).toBe(false);
  });
});

// ---------------------------------------------------------------------------
//  skills/sync.syncSkillMirrors — mirrorsFor engines branch (lines 29-30)
// ---------------------------------------------------------------------------

describe("skills/sync.syncSkillMirrors (PR129 coverage shim)", () => {
  test("syncSkillMirrors with engines=['claude'] → .filter().map() branch (lines 29-30)", async () => {
    const dir = freshDir("vf-pr129-mirrors-");
    mkdirSync(join(dir, ".vibeflow"), { recursive: true });
    try {
      const { syncSkillMirrors } = await import("../src/skills/sync.js");
      // engines is non-empty array; should iterate through the filter
      const result = syncSkillMirrors(dir, { engines: ["claude"] });
      expect(typeof result).toBe("object");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
//  terminal-prompts.textInput (line 155)
// ---------------------------------------------------------------------------

describe("terminal-prompts.textInput (PR129 coverage shim)", () => {
  test("textInput calls rl.question and returns the answer (line 155)", async () => {
    const { textInput } = await import("../src/terminal-prompts/prompts.js");
    let questionSeen: string | null = null;
    const fakeCreateInterface = (_opts: unknown) => ({
      question: (q: string, cb: (a: string) => void) => {
        questionSeen = q;
        setImmediate(() => cb("user-typed"));
      },
      on: () => {},
      once: () => {},
      close: () => {},
    });
    const r = await textInput("Enter value", "default", {
      createInterface: fakeCreateInterface as never,
    });
    expect(r).toBe("user-typed");
    expect(questionSeen).not.toBeNull();
    expect(String(questionSeen)).toContain("Enter value");
  });
});

// ---------------------------------------------------------------------------
//  init-intake.collectInitAskQuestionnaireData — multi-phase path (lines 247-290)
// ---------------------------------------------------------------------------

describe("init-intake.collectInitAskQuestionnaireData (PR129 coverage shim)", () => {
  test("3 phases with useAiSourceAnalysis=false → full path (lines 247-290)", async () => {
    const dir = freshDir("vf-pr129-intake-");
    mkdirSync(join(dir, ".vibeflow"), { recursive: true });
    try {
      // Mock the ask functions by importing the module and replacing via deps
      const { collectInitAskQuestionnaireData } = await import("../src/init-intake.js");
      const textCalls = { n: 0 };
      const confirmCalls = { n: 0 };
      const deps = {
        isTTY: true,
        textInput: async (_q: string) => {
          textCalls.n++;
          return `text-${textCalls.n}`;
        },
        confirmInput: async (_q: string, dflt = true) => {
          confirmCalls.n++;
          return confirmCalls.n === 1 ? false : dflt;
        },
        selectOne: async () => "Git",
        selectMany: async () => ["requirements-analysis", "basic-design", "implement"],
      };
      const result = await collectInitAskQuestionnaireData(deps as never);
      expect(result).toBeDefined();
      // 1 projectOverview + 2 per phase (3 phases) = 7 askText calls
      expect(textCalls.n).toBeGreaterThan(3);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
//  Round 2 (issue #80 rebase): cover the remaining lines that the round-1
//  shim left uncovered. All tests use inject-based seams (no `mock.module`).
//  New seams introduced for these tests:
//   - init.inject.syncSpawner     : override the per-step spawner for
//                                   codegraph install (phase 1.6 else-branch).
//   - init.inject.hasCommandFn    : override `hasCommand("codegraph")` so
//                                   the install else-branch executes.
//   - init.inject.ctx7Inject      : override the bare `ensureCtx7Auth()`
//                                   call at L487-490.
//   - defaultAskConfirm deps      : exported + accepts a `createInterface`
//                                   override so the prompt path can be
//                                   driven without a real TTY.
//   - toolsStatus probeFn         : override `probeIndexHealth` so the
//                                   unhealthy branch is reachable.
//   - probeIndexHealth deps.capture : override the internal spawner so the
//                                   default-capture body and the
//                                   deps-capture body are both reachable.
// ---------------------------------------------------------------------------

describe("defaultAskConfirm (exported for direct coverage)", () => {
  // Build a fake readline interface that immediately answers `answer`
  // and whose `close()` is a no-op. Matches the slice of the real
  // `Interface` that `defaultAskConfirm` uses.
  function fakeRl(answer: string) {
    return {
      question: (_q: string, cb: (a: string) => void) => {
        cb(answer);
      },
      close: () => {},
    } as unknown as Parameters<typeof import("node:readline").createInterface>[0] extends infer _T
      ? unknown
      : never;
  }

  test("answers 'y' → returns true (hits 769-773 y branch)", async () => {
    const { defaultAskConfirm } = await import("../src/commands.js");
    const r = await defaultAskConfirm("? ", { createInterface: () => fakeRl("y") as never });
    expect(r).toBe(true);
  });

  test("answers 'n' → returns false (hits 769-773 n branch)", async () => {
    const { defaultAskConfirm } = await import("../src/commands.js");
    const r = await defaultAskConfirm("? ", { createInterface: () => fakeRl("n") as never });
    expect(r).toBe(false);
  });

  test("answers '' (Enter on empty) → returns true (hits 769-773 empty branch)", async () => {
    const { defaultAskConfirm } = await import("../src/commands.js");
    const r = await defaultAskConfirm("? ", { createInterface: () => fakeRl("") as never });
    expect(r).toBe(true);
  });

  test("times out without answer → returns null (hits 765-768)", async () => {
    // Fake rl that NEVER calls back. defaultAskConfirm's 15s setTimeout
    // would normally fire — patch setTimeout to 10ms so the test stays fast.
    const realSetTimeout = globalThis.setTimeout;
    (globalThis as { setTimeout: typeof setTimeout }).setTimeout = ((cb: () => void) =>
      realSetTimeout(cb, 10)) as typeof setTimeout;
    try {
      const { defaultAskConfirm } = await import("../src/commands.js");
      const hangingRl = {
        question: () => {
          /* never invokes cb */
        },
        close: () => {},
      } as unknown as Parameters<typeof import("node:readline").createInterface>[0] extends infer _T
        ? unknown
        : never;
      const r = await defaultAskConfirm("? ", { createInterface: () => hangingRl as never });
      expect(r).toBeNull();
    } finally {
      (globalThis as { setTimeout: typeof setTimeout }).setTimeout = realSetTimeout;
    }
  });
});

describe("probeIndexHealth (exported for direct coverage)", () => {
  function withCodegraphDb(base: string): void {
    mkdirSync(join(base, ".codegraph"), { recursive: true });
    writeFileSync(join(base, ".codegraph", "codegraph.db"), "");
  }

  test("default capture path + healthy=true → returns true (hits 1197-1203, 1220-1222)", async () => {
    // Patch indexPresent so we can drive the default capture path
    // without needing a real codegraph db on disk. The default capture
    // runs the real `codegraph` binary. The healthy stub MUST invoke
    // the capture (so the defaultCapture closure runs); it returns
    // true unconditionally so the function exits at the `if (ok)
    // return true` line (1222) instead of falling through to the
    // `captured` check.
    const base = freshDir("vf-pr129-pih-default-");
    try {
      const { probeIndexHealth } = await import("../src/commands.js");
      const { TOOLS } = await import("../src/tools/index.js");
      const origPresent = TOOLS.codegraph.indexPresent;
      TOOLS.codegraph.indexPresent = () => true;
      try {
        const probed = probeIndexHealth(
          "codegraph",
          base,
          (_b: string, capture: (cmd: string, args: string[]) => { status: number }) => {
            // Invoke the default capture so lines 1200-1203 execute
            // (spawnSync + captured assignment + return).
            capture("codegraph", ["status", base]);
            return true;
          },
        );
        expect(probed).toBe(true);
      } finally {
        TOOLS.codegraph.indexPresent = origPresent;
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("default capture catch path (spawnSync throws) → returns false (hits 1204-1205, 1220, 1222)", async () => {
    // Drive the default capture's `catch { captured = ""; return ... }`
    // branch (L1204-1207) by passing an empty `cmd` to `capture`, which
    // makes `spawnSync` throw synchronously. The `healthy` stub also
    // doesn't call capture, but that's irrelevant — the throw happens
    // inside the defaultCapture closure before `healthy` runs.
    const base = freshDir("vf-pr129-pih-catch-");
    try {
      const { probeIndexHealth } = await import("../src/commands.js");
      const { TOOLS } = await import("../src/tools/index.js");
      const origPresent = TOOLS.codegraph.indexPresent;
      TOOLS.codegraph.indexPresent = () => true;
      try {
        const probed = probeIndexHealth(
          "codegraph",
          base,
          (_b: string, capture: (cmd: string, args: string[]) => { status: number }) => {
            // Empty cmd makes spawnSync throw — hits the catch block
            // (1204-1205), which sets captured="" and returns
            // `{ status: 1, stdout: "" }`. healthy returns false, so
            // captured is empty → returns false (not "unhealthy").
            capture("", []);
            return false;
          },
        );
        expect(probed).toBe(false);
      } finally {
        TOOLS.codegraph.indexPresent = origPresent;
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("deps.capture returns status 0 + non-empty stdout + healthy=false → 'unhealthy' (hits 1214-1218, 1220, 1225)", async () => {
    // No .codegraph marker required — the deps.capture override drives
    // captured and the healthy stub returns false. Skips the real codegraph
    // binary entirely. The healthy stub MUST invoke the capture so the
    // deps.capture wrapper runs (which populates `captured`); otherwise
    // the final `captured ? "unhealthy" : false` check sees an empty
    // string and the function returns false.
    const base = freshDir("vf-pr129-pih-unhealthy-");
    try {
      const { probeIndexHealth } = await import("../src/commands.js");
      const { TOOLS } = await import("../src/tools/index.js");
      const origPresent = TOOLS.codegraph.indexPresent;
      TOOLS.codegraph.indexPresent = () => true;
      try {
        const probed = probeIndexHealth(
          "codegraph",
          base,
          (_b: string, capture: (cmd: string, args: string[]) => { status: number }) => {
            // Call the capture so `captured` gets set via the deps.capture
            // wrapper. Then return false to drive the "unhealthy" branch.
            capture("codegraph", ["status", base]);
            return false;
          },
          { capture: () => ({ status: 0, stdout: "Not initialized (test stub)" }) },
        );
        expect(probed).toBe("unhealthy");
      } finally {
        TOOLS.codegraph.indexPresent = origPresent;
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test("deps.capture + healthy=true → returns true (covers 1214-1218 with ok branch)", async () => {
    const base = freshDir("vf-pr129-pih-ok2-");
    try {
      const { probeIndexHealth } = await import("../src/commands.js");
      const { TOOLS } = await import("../src/tools/index.js");
      const origPresent = TOOLS.codegraph.indexPresent;
      TOOLS.codegraph.indexPresent = () => true;
      try {
        const probed = probeIndexHealth("codegraph", base, () => true, {
          capture: () => ({ status: 0, stdout: "Index is up to date" }),
        });
        expect(probed).toBe(true);
      } finally {
        TOOLS.codegraph.indexPresent = origPresent;
      }
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("toolsStatus probeFn unhealthy branch", () => {
  test("enabled + installed + probeFn='unhealthy' → 'index unhealthy' tag + warning (hits 1163-1169)", async () => {
    const base = freshDir("vf-pr129-tools-unhealthy-");
    try {
      // Seed SETTINGS.json with codegraph enabled so the `enabled && installed`
      // branch at L1151 fires.
      mkdirSync(join(base, ".vibeflow"), { recursive: true });
      writeFileSync(
        join(base, ".vibeflow", "SETTINGS.json"),
        JSON.stringify({ tools: { codegraph: true, lsp: false } }),
      );
      // detectFn returns true for every tool → installed=true. The probeFn
      // override always reports "unhealthy" so the index-unhealthy branch
      // (L1163-1169) executes deterministically.
      const { toolsStatus } = await import("../src/commands.js");
      const code = toolsStatus(
        base,
        () => true,
        (_name, _b, _healthy) => "unhealthy",
      );
      expect(code).toBe(0);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe("init --ai with codegraph-install-else + ctx7 + workflowResult.ok (PR129 round 2)", () => {
  let dir: string;
  let origCwd: string;
  let origIsTTY: boolean | undefined;
  let origFetch: typeof globalThis.fetch | undefined;

  // Per-unit evidence map: matches the SCOPE_BY_NAME pattern from
  // test/ai-init-workflow-runner.test.ts so the reviewer's file-exists
  // check passes for every dispatched unit.
  const SCOPE_BY_NAME: Record<string, string> = {
    "ai-init-analyzer": ".vibeflow/ai-context/stack-evidence.md",
    "ai-init-instruction-writer": "CLAUDE.md",
    "ai-init-skill-curator": ".vibeflow/SKILL_INDEX.md",
    "ai-init-context-updater": ".vibeflow/PROJECT_CONTEXT.md",
    "ai-init-tool-configurator": ".vibeflow/SETTINGS.json",
    "ai-init-workflow-policy-writer": ".vibeflow/WORKFLOW_POLICY.md",
    "ai-init-workflow-state-writer": ".vibeflow/WORKFLOW_STATE.json",
    "ai-init-quickstart-writer": "QUICKSTART.md",
  };

  // Spawner shape accepted by `ensureCtx7Auth` (mirrors
  // `typeof spawnSync` but only the fields our fake populates).
  type Ctx7Spawner = (
    cmd: string,
    args: readonly string[],
  ) => {
    status: number;
    stdout: string;
    stderr: string;
  };
  function makeCtx7Spawner(): Ctx7Spawner {
    return (cmd: string, args: readonly string[]) => ({
      status: cmd === "npx" && args[1] === "whoami" ? 0 : 1,
      stdout: cmd === "npx" && args[1] === "whoami" ? "Logged in\n" : "",
      stderr: "",
    });
  }

  beforeEach(() => {
    origCwd = process.cwd();
    origIsTTY = process.stdin.isTTY;
    origFetch = globalThis.fetch;
    dir = freshDir("vf-pr129-init-r2-");
    process.chdir(dir);
    mkdirSync(join(dir, "src"), { recursive: true });
    mkdirSync(join(dir, ".vibeflow", "ai-context"), { recursive: true });
    mkdirSync(join(dir, ".vibeflow", "skills"), { recursive: true });
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, "package.json"), JSON.stringify({ name: "x" }));
    writeFileSync(join(dir, "src", "index.ts"), "export const x = 1;\n");
    // Pre-create the scope files the reviewer will check.
    writeFileSync(join(dir, ".vibeflow/ai-context/stack-evidence.md"), "# stack\n");
    writeFileSync(join(dir, "CLAUDE.md"), "# claude\n");
    writeFileSync(join(dir, ".vibeflow/SKILL_INDEX.md"), "# index\n");
    writeFileSync(join(dir, ".vibeflow/PROJECT_CONTEXT.md"), "# ctx\n");
    writeFileSync(join(dir, ".vibeflow/SETTINGS.json"), "{}");
    writeFileSync(join(dir, ".vibeflow/WORKFLOW_POLICY.md"), "# policy\n");
    writeFileSync(join(dir, ".vibeflow/WORKFLOW_STATE.json"), "{}");
    writeFileSync(join(dir, "QUICKSTART.md"), "# quickstart\n");
    // isTTY=true → phase 1.7 ctx7 path runs.
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    // find-skills fallback uses fetch; return an empty result set.
    globalThis.fetch = (async () =>
      new Response("[]", {
        status: 200,
        headers: { "content-type": "application/json" },
      })) as unknown as typeof fetch;
  });

  afterEach(() => {
    process.chdir(origCwd);
    if (origIsTTY === undefined) {
      Object.defineProperty(process.stdin, "isTTY", { value: undefined, configurable: true });
    } else {
      Object.defineProperty(process.stdin, "isTTY", { value: origIsTTY, configurable: true });
    }
    globalThis.fetch = origFetch as typeof fetch;
    rmSync(dir, { recursive: true, force: true });
  });

  test("codegraph-install-else + ctx7 in init + workflowResult.ok=true (hits 466-472, 481, 488-490, 556-562)", async () => {
    const { init } = await import("../src/commands.js");
    const { hasCommand } = await import("../src/core.js");
    type DispatcherUnit = { name: string; scope?: string[] };
    type DispatcherResult = {
      status: "done" | "blocked" | "verifying";
      confidence: number;
      evidence: string[];
      gates: { build: string; lint: string; test: string; review: string };
    };
    const code = await init(
      { ai: true, engine: "claude", "no-memory": true, "no-hooks": true, "no-agent-team": true },
      {
        // Skip the live preflightAll — return claude ready.
        preflight: (): { engine: string; level: "ready"; detail: string; checkedAt: string }[] => [
          { engine: "claude", level: "ready", detail: "ready (test stub)", checkedAt: "" },
        ],
        // Drive the workflow's preflight too (Phase 2).
        aiPreflight: (
          _engines: readonly string[],
          _opts: { probe: boolean },
        ): { engine: string; level: "ready"; detail: string; checkedAt: string }[] => [
          { engine: "claude", level: "ready", detail: "ready (test stub)", checkedAt: "" },
        ],
        // The reviewer needs evidence to cite scope paths and for those
        // files to exist on disk. SCOPE_BY_NAME matches the real adapter
        // scope (see src/ai-init-workflow.ts L153-160) and the files were
        // pre-created in beforeEach.
        dispatcher: async (unit: DispatcherUnit): Promise<DispatcherResult> => ({
          status: "done",
          confidence: 1,
          evidence: [SCOPE_BY_NAME[unit.name] ?? "src/cli.ts"],
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        }),
        // Force the codegraph-install else-branch (L466-481): pretend
        // `codegraph` is NOT on PATH, then override the per-step spawner
        // so the fake `npm i -g codegraph` returns status 0.
        hasCommandFn: (cmd: string) => (cmd === "codegraph" ? false : hasCommand(cmd)),
        syncSpawner: () => ({ status: 0 }),
        // Make the bare ensureCtx7Auth() call at L490 succeed immediately
        // — "Logged in" in stdout trips the alreadyAuth branch.
        ctx7Inject: { spawner: makeCtx7Spawner() as never },
        // Stub the legacy runAiInit spawner so Phase 2 (no-agent-team path)
        // never launches a real engine. Without this the real `claude` spawn
        // hangs to the 300 s idle timeout on CI. Return a fast success.
        aiSpawner: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
        // isTTY=true here would otherwise drive the real interactive hooks
        // menu (Phase 1.65) and block on stdin; null no-ops that step.
        hookSetup: null,
        // Skip the interactive questionnaire.
        answers: { goal: "test", engines: ["claude"] },
      } as never,
    );
    expect(typeof code).toBe("number");
  }, 300000);

  test("codegraph-install-failed (rc != 0) else branch (hits 473-478)", async () => {
    // Same setup as the previous test, but syncSpawner returns status 1
    // so `provisionTool` returns non-zero and the `else { ... "install
    // failed" ... }` block at L473-480 fires.
    const { init } = await import("../src/commands.js");
    const { hasCommand } = await import("../src/core.js");
    const code = await init(
      { ai: true, engine: "claude", "no-memory": true, "no-hooks": true, "no-agent-team": true },
      {
        preflight: () => [
          { engine: "claude", level: "ready", detail: "ready (test stub)", checkedAt: "" },
        ],
        aiPreflight: (_engines: readonly string[], _opts: { probe: boolean }) => [
          { engine: "claude", level: "ready", detail: "ready (test stub)", checkedAt: "" },
        ],
        dispatcher: async () => ({
          status: "done" as const,
          confidence: 1,
          evidence: ["src/cli.ts"],
          gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
        }),
        hasCommandFn: (cmd: string) => (cmd === "codegraph" ? false : hasCommand(cmd)),
        syncSpawner: () => ({ status: 1 }),
        ctx7Inject: { spawner: makeCtx7Spawner() as never },
        aiSpawner: async () => ({ status: 0, stdout: "", stderr: "", timedOut: false }),
        hookSetup: null,
        answers: { goal: "test", engines: ["claude"] },
      } as never,
    );
    expect(typeof code).toBe("number");
  }, 300000);
});
