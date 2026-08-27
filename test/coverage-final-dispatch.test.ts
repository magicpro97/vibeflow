import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import * as fs from "node:fs";
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { aiGenerate } from "../src/adapters/context-builders.js";
import { coord } from "../src/commands/coord.js";
import { runLLMReview } from "../src/commands/dispatch-reviewer-llm.js";
import { run } from "../src/commands/run.js";
import { BRIEF_PATH, BRIEF_SECTIONS } from "../src/commands/state.js";
import { writeState } from "../src/core.js";
import { conversationEnvPolicy } from "../src/dispatch/env-filter.js";
import {
  createDockerRuntimeInspector,
  createIsolationLease,
  releaseIsolationLease,
} from "../src/dispatch/isolation.js";
import { markOwnedRuntimeSpawner } from "../src/dispatch/owned-process-launch-runtime.js";
import type { OwnedProcessPlatform } from "../src/dispatch/owned-process-platform.js";
import { OwnedProcessRecordStore } from "../src/dispatch/owned-process-runtime.js";
import { prepareSessionLaunch } from "../src/dispatch/session-launch-prep.js";
import { reapOwnedSessionRootExit } from "../src/dispatch/session-owned-runtime.js";
import {
  COPILOT_ARG_PROMPT_FILE_THRESHOLD_BYTES,
  materializeCopilotSessionPrompt,
} from "../src/dispatch/session-prompt-file.js";
import { observeSessionTerminal } from "../src/dispatch/session-terminal.js";
import { createSpawnOptionsProjection } from "../src/dispatch/session-types.js";
import type {
  EngineProcess,
  EngineProcessSpawner,
  SpawnOptionsProjection,
} from "../src/dispatch/session-types.js";
import { createEngineSessionAdapter } from "../src/dispatch/session.js";

const temporaryPaths: string[] = [];
const originalCwd = process.cwd();

afterEach(() => {
  process.chdir(originalCwd);
  mock.restore();
  for (const path of temporaryPaths.splice(0)) rmSync(path, { recursive: true, force: true });
});

function tempRoot(prefix: string): string {
  const path = mkdtempSync(join(tmpdir(), prefix));
  temporaryPaths.push(path);
  return path;
}

function restoreEnv(name: string, value: string | undefined): void {
  if (value === undefined) Reflect.deleteProperty(process.env, name);
  else process.env[name] = value;
}

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

function completedProcess(stdout: string[]): EngineProcess {
  return {
    pid: 4242,
    stdin: { write: () => undefined, end: () => undefined },
    stdout: stream(...stdout),
    stderr: stream(),
    exited: Promise.resolve(0),
    kill: () => undefined,
  };
}

const OWNED_RUNTIME_FIXTURE_PID = Object.freeze({
  SUPERVISOR: 4241,
  CLI: 4242,
} as const);

const OWNED_RUNTIME_FIXTURE_IDENTITY = Object.freeze({
  OWNER: "freebsd:fixture-owner",
  SUPERVISOR: "freebsd:fixture-supervisor",
  CLI: "freebsd:fixture-cli",
} as const);

function ownedRuntimeFixturePlatform(): OwnedProcessPlatform {
  return {
    strategy: "posix-session",
    platform: "freebsd",
    observe: (pid) => {
      if (pid === process.pid)
        return { pid, identity: OWNED_RUNTIME_FIXTURE_IDENTITY.OWNER, pgid: pid, sid: null };
      if (pid === OWNED_RUNTIME_FIXTURE_PID.SUPERVISOR)
        return {
          pid,
          identity: OWNED_RUNTIME_FIXTURE_IDENTITY.SUPERVISOR,
          pgid: OWNED_RUNTIME_FIXTURE_PID.SUPERVISOR,
          sid: null,
        };
      if (pid === OWNED_RUNTIME_FIXTURE_PID.CLI)
        return {
          pid,
          identity: OWNED_RUNTIME_FIXTURE_IDENTITY.CLI,
          pgid: OWNED_RUNTIME_FIXTURE_PID.SUPERVISOR,
          sid: null,
        };
      return null;
    },
    terminateExactTree: () => undefined,
    proveQuiescent: () => true,
  };
}

function spawnProjection(
  engine: SpawnOptionsProjection["engine"],
  overrides: Partial<SpawnOptionsProjection> = {},
): SpawnOptionsProjection {
  return createSpawnOptionsProjection({
    engine,
    model: null,
    sessionMode: "fresh",
    rendered_prompt: `prompt-${engine}`,
    rendered_tools: engine === "codex" ? [] : ["Read", "Grep"],
    sandbox: "read-only",
    env_policy: conversationEnvPolicy(engine),
    isolation: null,
    provenance: { roleSource: "builtin", roleHash: `role-${engine}`, skillHashes: [] },
    trace_metadata: { role_resolved_hash: `role-${engine}`, skill_resolved_hashes: [] },
    ...overrides,
  });
}

function largePrompt(): string {
  return "x".repeat(COPILOT_ARG_PROMPT_FILE_THRESHOLD_BYTES + 1);
}

describe("final command and context coverage", () => {
  test("AI context generation returns a trimmed bounded owned-route result", async () => {
    const previous = process.env.VIBEFLOW_AI;
    process.env.VIBEFLOW_AI = "owned-ai-bridge";
    let fallbackCalls = 0;
    try {
      const output = await aiGenerate(
        "claude",
        "context prompt",
        () => {
          fallbackCalls++;
          return "fallback";
        },
        {
          cwd: "/repo",
          ownedRoute: async (request) => {
            expect(request).toMatchObject({
              engine: "claude",
              command: "owned-ai-bridge",
              input: "context prompt",
              cwd: "/repo",
              shell: true,
            });
            return {
              attemptId: "context-owned-route",
              status: 0,
              stdout: `  ${"a".repeat(4_100)}  `,
              stderr: "",
              timedOut: false,
            };
          },
        },
      );
      expect(output).toBe("a".repeat(4_000));
      expect(fallbackCalls).toBe(0);
    } finally {
      restoreEnv("VIBEFLOW_AI", previous);
    }
  });

  test("review rejects an explicitly unsupported reviewer engine before invoking the judge", async () => {
    const previous = process.env.VF_REVIEW_ENGINE;
    process.env.VF_REVIEW_ENGINE = "unsupported-reviewer";
    let calls = 0;
    try {
      await expect(
        runLLMReview({
          goal: "goal",
          diff: "diff",
          llmFn: async () => {
            calls++;
            return "COVERED";
          },
        }),
      ).rejects.toThrow("unsupported reviewer engine: unsupported-reviewer");
      expect(calls).toBe(0);
    } finally {
      restoreEnv("VF_REVIEW_ENGINE", previous);
    }
  });

  test("coord's default spawner routes the exact engine through injected owned authority", async () => {
    const root = tempRoot("vf-final-coord-default-");
    mkdirSync(join(root, ".vibeflow", "knowledge"), { recursive: true });
    process.chdir(root);
    const headings = BRIEF_SECTIONS.flatMap((heading) => [heading, "fixture", ""]);
    writeFileSync(
      join(root, BRIEF_PATH),
      `---\nlast-consult: ${new Date().toISOString()}\n---\n\n# Coordinator Brief\n\n${headings.join("\n")}`,
    );
    let request: Record<string, unknown> | undefined;
    const code = await coord(
      ["codex", "exec", "-"],
      {},
      {
        now: () => Date.now(),
        ownedRoute: async (input) => {
          request = input as unknown as Record<string, unknown>;
          return {
            attemptId: "coord-default-route",
            status: 7,
            stdout: "",
            stderr: "",
            timedOut: false,
          };
        },
      },
    );
    expect(code).toBe(7);
    expect(request).toMatchObject({ engine: "codex", command: "codex", args: ["exec", "-"] });
  });

  test.if(process.platform !== "win32")(
    "run's default spawner captures real CLI stderr on the engine log channel",
    async () => {
      const root = tempRoot("vf-final-run-stderr-");
      const bin = join(root, "bin");
      mkdirSync(bin);
      const executable = join(bin, "claude");
      writeFileSync(
        executable,
        '#!/bin/sh\nprintf \'%s\\n\' \'run-default-stderr\' >&2\nprintf \'%s\\n\' \'{"type":"result","subtype":"success","session_id":"50c1c208-9518-44e7-9fc5-d63b0bfcbec2"}\'\n',
      );
      chmodSync(executable, 0o755);
      writeState(root, {
        task_id: "run-default-stderr",
        goal: "exercise the default stderr callback",
        success_criteria: [],
        work_units: [],
        totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
      });
      const previousPath = process.env.PATH;
      process.env.PATH = `${bin}:${previousPath ?? ""}`;
      try {
        const code = await run(
          "claude",
          { yes: true },
          {
            base: root,
            git: () => ({ status: 128, stdout: "", stderr: "not a repository" }),
            preflight: () => [
              { engine: "claude", level: "ready", detail: "fixture", checkedAt: "2026-08-26" },
            ],
            probe: { has: () => true, version: () => "1.0.0" },
          },
        );
        expect(code).toBe(0);
        await Bun.sleep(50);
        expect(readFileSync(join(root, ".vibeflow", "logs", "current.log"), "utf8")).toContain(
          '"channel":"engine-stderr"',
        );
        expect(readFileSync(join(root, ".vibeflow", "logs", "current.log"), "utf8")).toContain(
          "run-default-stderr",
        );
      } finally {
        restoreEnv("PATH", previousPath);
      }
    },
    15_000,
  );
});

describe("final session runtime coverage", () => {
  test("owned root-exit outcome waits for termination before resolving", async () => {
    let terminations = 0;
    const outcome = { phase: "streams-drained" as const, exitCode: 0 };
    const observed = await reapOwnedSessionRootExit(
      { ...completedProcess([]), rootExited: Promise.resolve(outcome) },
      {
        terminate: async (graceMs: number) => {
          expect(graceMs).toBe(17);
          terminations++;
        },
      } as never,
      17,
    );
    expect(observed).toEqual(outcome);
    expect(terminations).toBe(1);
  });

  test("authenticated Claude terminal finalizes the owned runtime as released", async () => {
    const root = tempRoot("vf-final-authenticated-terminal-");
    const platform = ownedRuntimeFixturePlatform();
    const spawn = markOwnedRuntimeSpawner(((argv, options) => {
      expect(argv[0]).toContain("claude");
      expect(options.ownedRuntime).toBeDefined();
      options.ownedRuntime?.bindLaunch(
        OWNED_RUNTIME_FIXTURE_PID.SUPERVISOR,
        OWNED_RUNTIME_FIXTURE_PID.CLI,
      );
      return completedProcess([
        `${JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "50c1c208-9518-44e7-9fc5-d63b0bfcbec2",
        })}\n`,
      ]);
    }) as EngineProcessSpawner);
    const adapter = createEngineSessionAdapter({
      evidenceRoot: root,
      ownedProcessPlatform: platform,
      spawn,
      writeEvidence: async () => "evidence/authenticated-terminal.json",
    });
    const result = await adapter.start({
      attemptId: "authenticated-terminal",
      signal: new AbortController().signal,
      spawn: spawnProjection("claude"),
    }).completion;
    expect(result.state).toBe("completed");
    const persisted = new OwnedProcessRecordStore(root).read("authenticated-terminal");
    expect(persisted).toMatchObject({
      state: "released",
      terminal_kind: "claude-result-success",
      release_reason: "authenticated terminal release",
    });
  });

  test("terminal observer authenticates the full Claude success contract", () => {
    expect(
      observeSessionTerminal(
        "native",
        "claude",
        JSON.stringify({
          type: "result",
          subtype: "success",
          session_id: "50c1c208-9518-44e7-9fc5-d63b0bfcbec2",
        }),
      ),
    ).toEqual({ kind: "claude-result-success", authenticated: true });
  });

  test("container prompt mapping rejects a private root outside repository authority", () => {
    const root = tempRoot("vf-final-container-prompt-");
    const repoRoot = join(root, "repo");
    const promptRoot = join(root, "outside-prompts");
    mkdirSync(repoRoot);
    const inspector = createDockerRuntimeInspector({
      run: () => ({
        Id: "container-prompt",
        State: { Running: true },
        Mounts: [{ Source: repoRoot, Destination: "/workspace" }],
      }),
    });
    const lease = createIsolationLease({
      kind: "container",
      repoRoot,
      root: "/workspace",
      cwd: "/workspace",
      containerId: "container-prompt",
      runtimeInspector: inspector,
      evidence_ref: "container-prompt-evidence",
    });
    try {
      const adapter = createEngineSessionAdapter({
        privatePromptFileRoot: promptRoot,
        spawn: () => {
          throw new Error("spawn must not run");
        },
        writeEvidence: async () => "evidence/container-prompt.json",
      });
      expect(() =>
        adapter.start({
          attemptId: "container-prompt-outside",
          signal: new AbortController().signal,
          spawn: spawnProjection("copilot", { isolation: lease, rendered_prompt: largePrompt() }),
        }),
      ).toThrow("private Copilot prompt root is outside container repository authority");
    } finally {
      void releaseIsolationLease(lease);
    }
  });

  test("container prompt mapping projects an in-repository private root into the container", () => {
    const root = tempRoot("vf-final-container-visible-prompt-");
    const repoRoot = join(root, "repo");
    mkdirSync(repoRoot);
    const promptRoot = join(fs.realpathSync(repoRoot), "private-prompts");
    const inspector = createDockerRuntimeInspector({
      run: () => ({
        Id: "container-visible-prompt",
        State: { Running: true },
        Mounts: [{ Source: repoRoot, Destination: "/workspace" }],
      }),
    });
    const lease = createIsolationLease({
      kind: "container",
      repoRoot,
      root: "/workspace",
      cwd: "/workspace",
      containerId: "container-visible-prompt",
      runtimeInspector: inspector,
      evidence_ref: "container-visible-prompt-evidence",
    });
    try {
      const prepared = prepareSessionLaunch({
        attemptId: "container-visible-prompt",
        config: { privatePromptFileRoot: promptRoot },
        nativeSessionId: undefined,
        ownedRuntimePlatform: undefined,
        ownedRuntimeStore: undefined,
        sourceEnv: {},
        spawn: spawnProjection("copilot", { isolation: lease, rendered_prompt: largePrompt() }),
        transition: () => true,
      });
      expect(prepared.invocation.args.join(" ")).toContain(
        "/workspace/private-prompts/container-visible-prompt.prompt.md",
      );
      prepared.invocation.cleanup?.();
    } finally {
      void releaseIsolationLease(lease);
    }
  });

  test("non-authenticated owned exit uses the ordinary engine release reason", async () => {
    const root = tempRoot("vf-final-ordinary-owned-exit-");
    const platform = ownedRuntimeFixturePlatform();
    const spawn = markOwnedRuntimeSpawner(((_argv, options) => {
      options.ownedRuntime?.bindLaunch(
        OWNED_RUNTIME_FIXTURE_PID.SUPERVISOR,
        OWNED_RUNTIME_FIXTURE_PID.CLI,
      );
      return completedProcess([]);
    }) as EngineProcessSpawner);
    const result = await createEngineSessionAdapter({
      evidenceRoot: root,
      ownedProcessPlatform: platform,
      spawn,
      writeEvidence: async () => "evidence/ordinary-owned-exit.json",
    }).start({
      attemptId: "ordinary-owned-exit",
      signal: new AbortController().signal,
      spawn: spawnProjection("codex"),
    }).completion;
    expect(result.state).toBe("ambiguous");
    expect(new OwnedProcessRecordStore(root).read("ordinary-owned-exit")).toMatchObject({
      state: "released",
      terminal_kind: null,
      release_reason: "engine exit",
    });
  });
});

describe("final private prompt-file failure coverage", () => {
  test.if(process.platform !== "win32")(
    "rejects non-private roots and directory sync failures",
    () => {
      const badMode = tempRoot("vf-final-prompt-mode-");
      chmodSync(badMode, 0o755);
      expect(() =>
        materializeCopilotSessionPrompt({
          attemptId: "bad-mode",
          engine: "copilot",
          prompt: largePrompt(),
          root: badMode,
        }),
      ).toThrow("private Copilot prompt-file authority is unavailable");

      const syncFailure = tempRoot("vf-final-prompt-sync-");
      const canonicalSyncFailure = fs.realpathSync(syncFailure);
      const originalOpen = fs.openSync;
      const open = spyOn(fs, "openSync").mockImplementation(((path, flags, mode) => {
        if (
          String(path) === canonicalSyncFailure &&
          typeof flags === "number" &&
          (flags & fs.constants.O_DIRECTORY) !== 0
        ) {
          throw new Error("injected directory open failure");
        }
        return originalOpen(path, flags, mode);
      }) as typeof fs.openSync);
      expect(() =>
        materializeCopilotSessionPrompt({
          attemptId: "sync-failure",
          engine: "copilot",
          prompt: largePrompt(),
          root: syncFailure,
        }),
      ).toThrow("private Copilot prompt-file authority is unavailable");
      open.mockRestore();
    },
  );

  test("rejects a root whose pinned observation is not a directory", () => {
    const root = tempRoot("vf-final-prompt-not-directory-");
    const canonicalRoot = fs.realpathSync(root);
    const originalLstat = fs.lstatSync;
    const lstat = spyOn(fs, "lstatSync").mockImplementation(((path) => {
      const observed = originalLstat(path);
      if (String(path) !== canonicalRoot) return observed;
      return Object.assign(Object.create(observed), {
        isDirectory: () => false,
        isSymbolicLink: () => false,
      });
    }) as typeof fs.lstatSync);
    expect(() =>
      materializeCopilotSessionPrompt({
        attemptId: "not-directory",
        engine: "copilot",
        prompt: largePrompt(),
        root,
      }),
    ).toThrow("private Copilot prompt-file authority is unavailable");
    lstat.mockRestore();
  });

  test("small or non-Copilot prompts never mint private file authority", () => {
    const root = tempRoot("vf-final-prompt-ineligible-");
    expect(
      materializeCopilotSessionPrompt({
        attemptId: "small",
        engine: "copilot",
        prompt: "small",
        root,
      }),
    ).toBeUndefined();
    expect(
      materializeCopilotSessionPrompt({
        attemptId: "other-engine",
        engine: "claude",
        prompt: largePrompt(),
        root,
      }),
    ).toBeUndefined();
  });

  test.if(process.platform !== "win32")(
    "rejects reused prompt files with a hard-link or unreadable body",
    () => {
      const root = tempRoot("vf-final-prompt-reuse-");
      const prompt = largePrompt();
      const first = materializeCopilotSessionPrompt({
        attemptId: "reused",
        engine: "copilot",
        prompt,
        root,
      });
      if (!first) throw new Error("missing first prompt fixture");
      const path = join(root, "reused.prompt.md");
      const link = join(root, "linked.prompt.md");
      linkSync(path, link);
      expect(() =>
        materializeCopilotSessionPrompt({ attemptId: "reused", engine: "copilot", prompt, root }),
      ).toThrow("private Copilot prompt-file authority is unavailable");
      rmSync(link);

      const read = spyOn(fs, "readSync").mockImplementation(() => {
        throw new Error("injected read failure");
      });
      expect(() =>
        materializeCopilotSessionPrompt({ attemptId: "reused", engine: "copilot", prompt, root }),
      ).toThrow("private Copilot prompt-file authority is unavailable");
      read.mockRestore();
      first.cleanup();
    },
  );

  test.if(process.platform !== "win32")(
    "preserves file-creation authority when close and unlink cleanup also fail",
    () => {
      const root = tempRoot("vf-final-prompt-create-cleanup-");
      const originalClose = fs.closeSync;
      const originalUnlink = fs.unlinkSync;
      const write = spyOn(fs, "writeSync").mockImplementation(() => 0);
      const close = spyOn(fs, "closeSync").mockImplementation((fd) => {
        const isDirectory = fs.fstatSync(fd).isDirectory();
        originalClose(fd);
        if (!isDirectory) throw new Error("injected close failure");
      });
      const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => {
        originalUnlink(path);
        throw new Error("injected unlink failure");
      });
      expect(() =>
        materializeCopilotSessionPrompt({
          attemptId: "create-cleanup",
          engine: "copilot",
          prompt: largePrompt(),
          root,
        }),
      ).toThrow("private Copilot prompt-file authority is unavailable");
      write.mockRestore();
      close.mockRestore();
      unlink.mockRestore();
    },
  );

  test("oversized visible pointer removes the private file even when cleanup reports failure", () => {
    const root = tempRoot("vf-final-prompt-pointer-");
    const originalUnlink = fs.unlinkSync;
    const unlink = spyOn(fs, "unlinkSync").mockImplementation((path) => {
      originalUnlink(path);
      throw new Error("injected pointer cleanup failure");
    });
    expect(() =>
      materializeCopilotSessionPrompt({
        attemptId: "long-pointer",
        engine: "copilot",
        prompt: largePrompt(),
        root,
        visibleRoot: `/${"v".repeat(5_000)}`,
      }),
    ).toThrow("Copilot conversation prompt pointer exceeds its byte bound");
    unlink.mockRestore();
  });
});
