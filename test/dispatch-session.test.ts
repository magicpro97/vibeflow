import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  AgentBinding,
  MaterializeAgentBindingOptions,
  MaterializedAgentBinding,
} from "../src/agents/binding.js";
import { runDispatchWithSessionRuntime } from "../src/commands/dispatch-session-runtime.js";
import { engineCommand, persistDispatch, runDispatch } from "../src/dispatch.js";
import { createProcessTerminator } from "../src/dispatch/attempt-handle.js";
import { conversationEnvPolicy, filterEnv } from "../src/dispatch/env-filter.js";
import {
  createDockerRuntimeInspector,
  createIsolationLease,
  isIsolationLeaseLive,
  releaseIsolationLease,
  validateIsolationLease,
} from "../src/dispatch/isolation.js";
import {
  buildPublicDispatchResult,
  readDispatchResumeBinding,
  sanitizePublicText,
} from "../src/dispatch/public-redaction.js";
import {
  MAX_SESSION_PROMPT_FILE_BYTES,
  MAX_SESSION_PROMPT_POINTER_BYTES,
  materializeCopilotSessionPrompt,
} from "../src/dispatch/session-prompt-file.js";
import type { AttemptHandle } from "../src/dispatch/session-types.js";
import type {
  EngineProcess,
  EngineProcessSpawner,
  EngineSessionRequest,
  SpawnOptionsProjection,
} from "../src/dispatch/session-types.js";
import { createSpawnOptionsProjection } from "../src/dispatch/session-types.js";
import { createEngineSessionAdapter } from "../src/dispatch/session.js";
import { makeAsyncSpawner, makeEngineProcessSpawner } from "../src/dispatch/spawners.js";
import {
  cleanupMarker,
  createMarker,
  listMarkers,
  readMarker,
  updateMarker,
} from "../src/orchestrator/marker.js";
import { orchestrateUnits } from "../src/orchestrator/run.js";

const temporaryPaths: string[] = [];
const CLAUDE_UUID = "50c1c208-9518-44e7-9fc5-d63b0bfcbec2";
const CODEX_UUID = "019f278f-d7ff-77d3-9c44-7459bbf08d19";

afterEach(() => {
  for (const path of temporaryPaths.splice(0)) rmSync(path, { force: true, recursive: true });
});

function stream(...chunks: string[]): ReadableStream<Uint8Array> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(new TextEncoder().encode(chunk));
      controller.close();
    },
  });
}

function completedProcess(
  stdout: string[] = ["done"],
  status = 0,
  onKill?: () => void,
): EngineProcess {
  return {
    pid: 4242,
    stdin: { write: () => {}, end: () => {} },
    stdout: stream(...stdout),
    stderr: stream(),
    exited: Promise.resolve(status),
    kill: () => onKill?.(),
  };
}

function initializeGitWorktree(path: string): void {
  mkdirSync(path, { recursive: true });
  execFileSync("git", ["init", "--quiet", path], { stdio: "ignore" });
}

function initializeLinkedGitWorktree(root: string): { repoRoot: string; cwd: string } {
  const repoRoot = join(root, "repo");
  const cwd = join(root, "unit");
  initializeGitWorktree(repoRoot);
  execFileSync("git", ["-C", repoRoot, "config", "user.email", "test@example.com"]);
  execFileSync("git", ["-C", repoRoot, "config", "user.name", "VibeFlow Test"]);
  writeFileSync(join(repoRoot, "README.md"), "fixture\n");
  execFileSync("git", ["-C", repoRoot, "add", "README.md"]);
  execFileSync("git", ["-C", repoRoot, "commit", "--quiet", "-m", "fixture"]);
  execFileSync("git", ["-C", repoRoot, "worktree", "add", "--quiet", "-b", "unit", cwd]);
  return { repoRoot, cwd };
}

function pendingProcess(): {
  process: EngineProcess;
  kills: () => number;
  exited: () => boolean;
} {
  let resolveExit!: (status: number) => void;
  let killCount = 0;
  let didExit = false;
  const exited = new Promise<number>((resolve) => {
    resolveExit = (status) => {
      didExit = true;
      resolve(status);
    };
  });
  return {
    process: {
      pid: 4243,
      stdin: { write: () => {}, end: () => {} },
      exited,
      kill: () => {
        killCount++;
        resolveExit(143);
      },
    },
    kills: () => killCount,
    exited: () => didExit,
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
    provenance: { roleSource: "builtin", roleHash: `role-${engine}`, skillHashes: ["skill"] },
    trace_metadata: {
      role_resolved_hash: `role-${engine}`,
      skill_resolved_hashes: ["skill"],
    },
    ...overrides,
  });
}

function request(
  engine: SpawnOptionsProjection["engine"],
  overrides: Partial<EngineSessionRequest> = {},
): EngineSessionRequest {
  return {
    attemptId: `attempt-${engine}`,
    spawn: spawnProjection(engine),
    signal: new AbortController().signal,
    ...overrides,
  };
}

function completedHandle(
  attemptId: string,
  engine: SpawnOptionsProjection["engine"],
  nativeSessionId?: string,
): AttemptHandle {
  return {
    attemptId,
    completion: Promise.resolve({
      attemptId,
      engine,
      ok: true,
      state: "completed",
      lifecycle: ["requested", "dispatched", "acknowledged", "completed"],
      output: '{"type":"result","summary":"ok"}',
      summary: { confidence: 1, files_changed: ["src/file.ts"] },
      evidenceStatus: "persisted",
      nativeSessionStatus: nativeSessionId ? "captured" : "unavailable",
    }),
    terminate: async () => {},
    readResumeBinding: () => (nativeSessionId ? { attemptId, engine, nativeSessionId } : undefined),
    readModelOutputBinding: () => undefined,
    readEvidenceBinding: () => ({ attemptId, internalRef: "internal/evidence" }),
  };
}

describe("conversation env authority", () => {
  const source = {
    PATH: "/bin",
    HOME: "/home/test",
    ANTHROPIC_API_KEY: "anthropic-secret",
    OPENAI_API_KEY: "openai-secret",
    GH_TOKEN: "gh-secret",
    GITHUB_TOKEN: "github-secret",
    COPILOT_GITHUB_TOKEN: "copilot-secret",
    OPENCODE_API_KEY: "opencode-secret",
    GEMINI_API_KEY: "gemini-secret",
    AWS_SECRET_ACCESS_KEY: "aws-secret",
    VF_CONTROL_SECRET: "must-not-pass",
    VIBEFLOW_AI: "must-not-pass",
    RANDOM_VAR: "must-not-pass",
  };

  test.each([
    ["claude", ["ANTHROPIC_API_KEY"]],
    ["codex", ["OPENAI_API_KEY"]],
    ["copilot", ["GH_TOKEN", "GITHUB_TOKEN", "COPILOT_GITHUB_TOKEN"]],
    ["opencode", ["OPENCODE_API_KEY"]],
    ["antigravity", ["GEMINI_API_KEY"]],
  ] as const)("%s keeps only its provider auth and runtime essentials", (engine, keptAuth) => {
    const { env } = filterEnv(source, conversationEnvPolicy(engine));
    expect(env.PATH).toBe("/bin");
    expect(env.HOME).toBe("/home/test");
    expect(env.RANDOM_VAR).toBeUndefined();
    expect(env.VF_CONTROL_SECRET).toBeUndefined();
    expect(env.VIBEFLOW_AI).toBeUndefined();
    const presentAuth = Object.keys(source)
      .filter((key) => key.includes("TOKEN") || key.endsWith("API_KEY"))
      .filter((key) => env[key] !== undefined);
    expect(presentAuth).toEqual([...keptAuth]);
  });

  test("legacy/default filtering still preserves all canonical engine auth", () => {
    const { env } = filterEnv(source);
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-secret");
    expect(env.OPENAI_API_KEY).toBe("openai-secret");
    expect(env.GH_TOKEN).toBe("gh-secret");
    expect(env.GITHUB_TOKEN).toBe("github-secret");
    expect(env.GEMINI_API_KEY).toBe("gemini-secret");
    expect(env.OPENCODE_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
  });

  test("selected-engine auth and secret scrub cannot be widened by allow/deny globs", () => {
    const { env } = filterEnv(source, {
      ...conversationEnvPolicy("claude"),
      allow: ["*"],
      deny: ["ANTHROPIC_*"],
    });
    expect(env.ANTHROPIC_API_KEY).toBe("anthropic-secret");
    expect(env.OPENAI_API_KEY).toBeUndefined();
    expect(env.COPILOT_GITHUB_TOKEN).toBeUndefined();
    expect(env.AWS_SECRET_ACCESS_KEY).toBeUndefined();
    expect(env.RANDOM_VAR).toBeUndefined();
  });
});

describe("engine session execution projection", () => {
  const cases = [
    [
      "claude",
      "claude",
      [
        "--safe-mode",
        "-p",
        "--output-format",
        "json",
        "--tools",
        "Read,Grep",
        "--allowedTools",
        "Read,Grep",
        "--permission-mode",
        "plan",
        "--disallowedTools",
        "Write,Edit,Bash",
      ],
    ],
    ["codex", "codex", ["--sandbox", "read-only", "exec", "--json", "-"]],
    [
      "copilot",
      "copilot",
      [
        "-p",
        "prompt-copilot",
        "--model",
        "default",
        "--available-tools=Read,Grep",
        "--excluded-tools=Write,Edit,Bash",
      ],
    ],
    ["opencode", "opencode", ["run", "--format", "json", "--model", "default"]],
    ["antigravity", "agy", ["-p", "prompt-antigravity", "--model", "default"]],
  ] as const;

  test.each(cases)(
    "%s enforces argv, prompt, env, provenance, and trace metadata",
    async (engine, command, expectedArgs) => {
      let seenArgv: string[] = [];
      let seenOptions: Parameters<EngineProcessSpawner>[1] | undefined;
      const spawn: EngineProcessSpawner = (argv, options) => {
        seenArgv = [...argv];
        seenOptions = options;
        const protocolOutput =
          engine === "claude"
            ? `${JSON.stringify({ type: "result", session_id: CLAUDE_UUID })}\n`
            : engine === "codex"
              ? `${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`
              : engine === "opencode"
                ? '{"type":"step_start","sessionID":"opencode-session-safe"}\n'
                : "done";
        return completedProcess([protocolOutput]);
      };
      const adapter = createEngineSessionAdapter({
        spawn,
        sourceEnv: {
          PATH: "/bin",
          HOME: "/home/test",
          ANTHROPIC_API_KEY: "anthropic",
          OPENAI_API_KEY: "openai",
          GH_TOKEN: "gh",
          GITHUB_TOKEN: "github",
          OPENCODE_API_KEY: "opencode",
          GEMINI_API_KEY: "gemini",
        },
        writeEvidence: async (attemptId) => `evidence/${attemptId}.json`,
      });

      const projection = spawnProjection(engine, {
        model: engine === "claude" ? null : engine === "codex" ? null : "default",
        ...(engine === "opencode" || engine === "antigravity"
          ? { rendered_tools: [], sandbox: null }
          : {}),
      });
      const result = await adapter.start(request(engine, { spawn: projection })).completion;

      expect(seenArgv[0]).toBe(command);
      expect(seenArgv.slice(1)).toEqual([...expectedArgs]);
      expect(seenOptions?.stdinText).toBe(
        engine === "claude" || engine === "codex" || engine === "opencode"
          ? `prompt-${engine}`
          : "",
      );
      expect(seenOptions?.env.VF_ATTEMPT_ID).toBe(`attempt-${engine}`);
      expect(seenOptions?.env.VF_RENDERED_TOOLS).toBe(
        engine === "codex" || engine === "opencode" || engine === "antigravity" ? "" : "Read,Grep",
      );
      expect(seenOptions?.env.VF_ROLE_HASH).toBe(`role-${engine}`);
      expect(seenOptions?.env.VF_ROLE_RESOLVED_HASH).toBe(`role-${engine}`);
      expect(result.lifecycle).toEqual(["requested", "dispatched", "acknowledged", "completed"]);
    },
  );

  test("Claude read-only launch cannot carry a permissive permission flag", async () => {
    let argv: string[] = [];
    const adapter = createEngineSessionAdapter({
      spawn: (next) => {
        argv = [...next];
        return completedProcess();
      },
      writeEvidence: async () => "evidence/a.json",
    });
    await adapter.start(request("claude")).completion;
    expect(argv).toContain("--permission-mode");
    expect(argv).toContain("plan");
    expect(argv).not.toContain("--dangerously-skip-permissions");
    expect(argv.join(" ")).toContain("Write,Edit,Bash");
  });

  test("Claude rejects a flag-shaped exact native id before spawn", () => {
    let spawns = 0;
    const adapter = createEngineSessionAdapter({
      spawn: () => {
        spawns++;
        return completedProcess();
      },
      writeEvidence: async () => "internal/invalid-projection",
    });
    expect(() =>
      adapter.start(
        request("claude", {
          nativeSessionId: "--dangerously-skip-permissions",
          spawn: spawnProjection("claude", { sessionMode: "exact" }),
        }),
      ),
    ).toThrow(/invalid claude native session id/);
    expect(spawns).toBe(0);
  });

  test.each(["claude", "codex"] as const)(
    "%s exact mode accepts UUID identity only, never a name or prefix",
    (engine) => {
      const adapter = createEngineSessionAdapter({
        spawn: () => completedProcess(),
        writeEvidence: async () => "internal/invalid-native",
      });
      expect(() =>
        adapter.start(
          request(engine, {
            attemptId: `attempt-invalid-native-${engine}`,
            nativeSessionId: "safe-looking-session-name",
            spawn: spawnProjection(engine, {
              sessionMode: "exact",
              ...(engine === "codex" ? { rendered_tools: [] } : {}),
            }),
          }),
        ),
      ).toThrow(/invalid .* native session id/);
    },
  );

  test("legacy argv and capture seams reject unsafe engine-specific native ids", async () => {
    expect(() => engineCommand("claude", {}, false, "--dangerously-skip-permissions")).toThrow(
      /invalid claude native session id/,
    );
    const result = await runDispatch({
      engine: "claude",
      mode: "cli",
      prompt: "prompt",
      has: () => true,
      spawner: async () => ({
        status: 0,
        stdout: '{"type":"result","session_id":"--dangerously-skip-permissions"}',
      }),
    });
    expect("sessionId" in result).toBe(false);
    expect(readDispatchResumeBinding(result)).toBeUndefined();
  });

  test("Codex fails closed when rendered tool availability cannot be enforced", () => {
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess(),
      writeEvidence: async () => "internal/invalid-codex-tools",
    });
    expect(() =>
      adapter.start(
        request("codex", {
          spawn: spawnProjection("codex", { rendered_tools: ["Read", "Grep"] }),
        }),
      ),
    ).toThrow(/codex cannot enforce rendered tools/);
  });

  test("Claude read-only tool rules reject parameterized mutating tools", () => {
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess(),
      writeEvidence: async () => "internal/invalid-tool",
    });
    expect(() =>
      adapter.start(
        request("claude", {
          spawn: spawnProjection("claude", { rendered_tools: ["Read", "Bash(*)"] }),
        }),
      ),
    ).toThrow(/read-only sandbox denies mutating tools/);
  });

  test("a plain or cloned spawn projection has no execution authority", () => {
    let spawns = 0;
    const adapter = createEngineSessionAdapter({
      spawn: () => {
        spawns++;
        return completedProcess();
      },
      writeEvidence: async () => "internal/invalid-projection",
    });
    const canonical = spawnProjection("claude");
    const plain = { ...canonical };
    expect(() => adapter.start(request("claude", { spawn: plain }))).toThrow(
      /canonical spawn authority/,
    );
    expect(() =>
      adapter.start(request("claude", { attemptId: "attempt-cloned", spawn: { ...plain } })),
    ).toThrow(/canonical spawn authority/);
    expect(spawns).toBe(0);
  });

  test.each([
    "/tmp/private-model",
    "../private-model",
    "provider/sk-abcdefghijklmnopqrstuvwxyz1234567890",
    "model\u0000override",
  ])("canonical spawn rejects unsafe model authority %s", (model) => {
    const base = spawnProjection("claude");
    expect(() => createSpawnOptionsProjection({ ...base, model })).toThrow(
      /safe engine identifier/,
    );
  });

  test("the executable prompt exists only on spawn.rendered_prompt", async () => {
    let input = "";
    const adapter = createEngineSessionAdapter({
      spawn: (_argv, opts) => {
        input = opts.stdinText;
        return completedProcess();
      },
      writeEvidence: async () => "evidence/a.json",
    });
    const onlyPrompt = "THE-SINGLE-EXECUTABLE-PROMPT";
    await adapter.start(
      request("codex", {
        spawn: spawnProjection("codex", { rendered_prompt: onlyPrompt, rendered_tools: [] }),
      }),
    ).completion;
    expect(input).toBe(onlyPrompt);
    expect(Object.keys(request("codex"))).not.toContain("prompt");
    expect(Object.keys(request("codex"))).not.toContain("envPolicy");
  });

  test("large Copilot handoff uses a bounded private file and cleans it after process drain", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-copilot-session-prompt-"));
    temporaryPaths.push(root);
    const promptRoot = join(root, "conversation-prompts");
    const prompt = `COPILOT-LARGE-HANDOFF\n${"x".repeat(1024 * 1024)}`;
    let observedArgv: string[] = [];
    let pointerPrompt = "";
    const adapter = createEngineSessionAdapter({
      privatePromptFileRoot: promptRoot,
      spawn: (argv, options) => {
        observedArgv = [...argv];
        const path = join(realpathSync(promptRoot), "attempt-copilot.prompt.md");
        expect(options.stdinText).toBe("");
        pointerPrompt = `Read ${path.replace(/\\/g, "/")} and follow it`;
        expect(argv).toContain(pointerPrompt);
        expect(argv.join("\n")).not.toContain("COPILOT-LARGE-HANDOFF");
        expect(readFileSync(path, "utf8")).toBe(prompt);
        if (process.platform !== "win32") {
          expect(statSync(promptRoot).mode & 0o777).toBe(0o700);
          expect(statSync(path).mode & 0o777).toBe(0o600);
        }
        return completedProcess([`${pointerPrompt}\n`]);
      },
      writeEvidence: async () => "evidence/copilot-large.json",
    });
    const result = await adapter.start(
      request("copilot", {
        spawn: spawnProjection("copilot", { rendered_prompt: prompt }),
      }),
    ).completion;
    expect(result.ok).toBe(true);
    expect(result.output).not.toContain(pointerPrompt);
    expect(result.output).not.toContain(realpathSync(promptRoot));
    expect(Buffer.byteLength(observedArgv.join("\0"), "utf8")).toBeLessThan(
      MAX_SESSION_PROMPT_POINTER_BYTES,
    );
    expect(readdirSync(promptRoot)).toEqual([]);
  });

  test("large Copilot prompt file remains until stdout and stderr have drained", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-copilot-session-drain-"));
    temporaryPaths.push(root);
    const promptRoot = join(root, "conversation-prompts");
    let finishStdout!: () => void;
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("copilot acknowledged\n"));
        finishStdout = () => controller.close();
      },
    });
    const adapter = createEngineSessionAdapter({
      privatePromptFileRoot: promptRoot,
      spawn: () => ({
        pid: 4343,
        stdin: { write: () => {}, end: () => {} },
        stdout,
        stderr: stream(),
        exited: Promise.resolve(0),
        kill: () => {},
      }),
      writeEvidence: async () => "evidence/copilot-drain.json",
    });
    const handle = adapter.start(
      request("copilot", {
        spawn: spawnProjection("copilot", { rendered_prompt: "x".repeat(64 * 1024) }),
      }),
    );
    await new Promise((resolve) => setTimeout(resolve, 0));
    const path = join(realpathSync(promptRoot), "attempt-copilot.prompt.md");
    expect(existsSync(path)).toBe(true);
    finishStdout();
    await handle.completion;
    expect(existsSync(path)).toBe(false);
  });

  test("large Copilot prompt file is cleaned when process spawn fails", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-copilot-session-spawn-failure-"));
    temporaryPaths.push(root);
    const promptRoot = join(root, "conversation-prompts");
    const adapter = createEngineSessionAdapter({
      privatePromptFileRoot: promptRoot,
      spawn: () => {
        throw new Error("synthetic spawn failure");
      },
      writeEvidence: async () => "evidence/copilot-spawn-failure.json",
    });
    expect(() =>
      adapter.start(
        request("copilot", {
          spawn: spawnProjection("copilot", { rendered_prompt: "x".repeat(64 * 1024) }),
        }),
      ),
    ).toThrow(/synthetic spawn failure/);
    expect(readdirSync(promptRoot)).toEqual([]);
  });

  test.each(["claude", "codex", "opencode"] as const)(
    "%s keeps a large native prompt on stdin when Copilot file transport is configured",
    async (engine) => {
      const root = mkdtempSync(join(tmpdir(), `vf-${engine}-session-prompt-`));
      temporaryPaths.push(root);
      const promptRoot = join(root, "conversation-prompts");
      const prompt = `${engine}-stdin\n${"x".repeat(64 * 1024)}`;
      let observedInput = "";
      const adapter = createEngineSessionAdapter({
        privatePromptFileRoot: promptRoot,
        spawn: (_argv, options) => {
          observedInput = options.stdinText;
          return completedProcess([
            engine === "claude"
              ? `${JSON.stringify({ type: "result", session_id: CLAUDE_UUID })}\n`
              : engine === "codex"
                ? `${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`
                : '{"type":"step_start","sessionID":"opencode-session-safe"}\n',
          ]);
        },
        writeEvidence: async () => `evidence/${engine}-large-stdin.json`,
      });
      await adapter.start(
        request(engine, {
          spawn: spawnProjection(engine, {
            rendered_prompt: prompt,
            ...(engine === "opencode" ? { rendered_tools: [], sandbox: null } : {}),
          }),
        }),
      ).completion;
      expect(observedInput).toBe(prompt);
      expect(existsSync(promptRoot)).toBe(false);
    },
  );

  test("bridge and Antigravity keep their established large-prompt semantics", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-noncopilot-session-prompt-"));
    temporaryPaths.push(root);
    const promptRoot = join(root, "conversation-prompts");
    const prompt = "x".repeat(64 * 1024);
    let bridgeInput = "";
    const bridge = createEngineSessionAdapter({
      privatePromptFileRoot: promptRoot,
      protocol: "bridge",
      spawn: (_argv, options) => {
        bridgeInput = options.stdinText;
        return completedProcess(["bridge acknowledged\n"]);
      },
      writeEvidence: async () => "evidence/bridge-copilot.json",
    });
    await bridge.start(
      request("copilot", { spawn: spawnProjection("copilot", { rendered_prompt: prompt }) }),
    ).completion;
    expect(bridgeInput).toBe(prompt);
    expect(existsSync(promptRoot)).toBe(false);

    const antigravity = createEngineSessionAdapter({
      privatePromptFileRoot: promptRoot,
      spawn: () => completedProcess(),
      writeEvidence: async () => "evidence/antigravity-large.json",
    });
    expect(() =>
      antigravity.start(
        request("antigravity", {
          spawn: spawnProjection("antigravity", {
            rendered_prompt: prompt,
            rendered_tools: [],
            sandbox: null,
          }),
        }),
      ),
    ).toThrow(/Antigravity prompt too large/);
  });

  test("Copilot prompt files reuse byte-identical restart state and reject changed content", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-copilot-session-restart-"));
    temporaryPaths.push(root);
    const prompt = "r".repeat(64 * 1024);
    const first = materializeCopilotSessionPrompt({
      attemptId: "restart-attempt",
      engine: "copilot",
      prompt,
      root,
    });
    const resumed = materializeCopilotSessionPrompt({
      attemptId: "restart-attempt",
      engine: "copilot",
      prompt,
      root,
    });
    expect(resumed?.pointerPrompt).toBe(first?.pointerPrompt);
    expect(() =>
      materializeCopilotSessionPrompt({
        attemptId: "restart-attempt",
        engine: "copilot",
        prompt: `changed-${prompt}`,
        root,
      }),
    ).toThrow(/prompt-file authority/);
    first?.cleanup();
    resumed?.cleanup();
    expect(readdirSync(root)).toEqual([]);
  });

  test("Copilot prompt-file transport rejects content above its explicit bound", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-copilot-session-bound-"));
    temporaryPaths.push(root);
    expect(() =>
      materializeCopilotSessionPrompt({
        attemptId: "oversized-attempt",
        engine: "copilot",
        prompt: "x".repeat(MAX_SESSION_PROMPT_FILE_BYTES + 1),
        root,
      }),
    ).toThrow(/byte bound/);
    expect(readdirSync(root)).toEqual([]);
  });

  test.each([
    [
      "claude",
      CLAUDE_UUID,
      "sonnet",
      [
        "--safe-mode",
        "-p",
        "-r",
        CLAUDE_UUID,
        "--output-format",
        "json",
        "--model",
        "sonnet",
        "--tools",
        "Read,Grep",
        "--allowedTools",
        "Read,Grep",
        "--permission-mode",
        "plan",
        "--disallowedTools",
        "Write,Edit,Bash",
      ],
      { type: "result", session_id: CLAUDE_UUID },
    ],
    [
      "codex",
      CODEX_UUID,
      "gpt-5.4",
      ["--sandbox", "read-only", "--model", "gpt-5.4", "exec", "resume", CODEX_UUID, "--json", "-"],
      { type: "thread.started", thread_id: CODEX_UUID },
    ],
    [
      "opencode",
      "ses_fc311e3c9ffegocll2MayNGmaZ",
      "provider/model",
      [
        "run",
        "--session",
        "ses_fc311e3c9ffegocll2MayNGmaZ",
        "--format",
        "json",
        "--model",
        "provider/model",
      ],
      { type: "step_start", sessionID: "ses_fc311e3c9ffegocll2MayNGmaZ" },
    ],
  ] as const)(
    "%s exact mode consumes the exact native id and model override",
    async (engine, nativeSessionId, model, expectedArgs, acknowledgement) => {
      let argv: string[] = [];
      const adapter = createEngineSessionAdapter({
        spawn: (next) => {
          argv = [...next];
          return completedProcess([`${JSON.stringify(acknowledgement)}\n`]);
        },
        writeEvidence: async () => `evidence/${engine}-exact.json`,
      });
      const handle = adapter.start(
        request(engine, {
          nativeSessionId,
          spawn: spawnProjection(engine, {
            sessionMode: "exact",
            model,
            ...(engine === "codex"
              ? { rendered_tools: [] }
              : engine === "opencode"
                ? { rendered_tools: [], sandbox: null }
                : {}),
          }),
        }),
      );
      const result = await handle.completion;
      expect(argv.slice(1)).toEqual([...expectedArgs]);
      expect(result.state).toBe("completed");
      expect(handle.readResumeBinding()?.nativeSessionId).toBe(nativeSessionId);
      if (engine === "claude") expect(argv).toContain("--safe-mode");
      if (engine === "codex") {
        expect(argv.indexOf("--sandbox")).toBeLessThan(argv.indexOf("resume"));
        expect(argv.indexOf("--model")).toBeLessThan(argv.indexOf("resume"));
      }
      if (engine === "opencode") {
        expect(argv).not.toContain("--continue");
        expect(argv.filter((value) => value === nativeSessionId)).toHaveLength(1);
      }
    },
  );

  test.each([
    [
      "claude",
      "00000000-0000-4000-8000-000000000001",
      { type: "result", session_id: "00000000-0000-4000-8000-000000000002" },
    ],
    [
      "codex",
      "00000000-0000-4000-8000-000000000001",
      { type: "thread.started", thread_id: "00000000-0000-4000-8000-000000000002" },
    ],
    ["opencode", "opencode-session-001", { type: "step_start", sessionID: "opencode-session-002" }],
  ] as const)(
    "%s exact mode rejects a mismatched runtime session acknowledgement",
    async (engine, requestedId, acknowledgement) => {
      const adapter = createEngineSessionAdapter({
        spawn: () => completedProcess([`${JSON.stringify(acknowledgement)}\n`]),
        writeEvidence: async () => `evidence/${engine}-mismatched-resume.json`,
      });
      const handle = adapter.start(
        request(engine, {
          attemptId: `attempt-${engine}-mismatched-resume`,
          nativeSessionId: requestedId,
          spawn: spawnProjection(engine, {
            sessionMode: "exact",
            ...(engine === "opencode" ? { rendered_tools: [], sandbox: null } : {}),
          }),
        }),
      );
      const result = await handle.completion;

      expect(handle.readResumeBinding()).toBeUndefined();
      expect(handle.readModelOutputBinding()).toBeUndefined();
      expect(result.state).toBe("ambiguous");
      expect(result.lifecycle).not.toContain("acknowledged");
      expect(result.nativeSessionStatus).toBe("unavailable");
      expect(result.reason).toContain("exact native session acknowledgement mismatched");
      expect(JSON.stringify(result)).not.toContain(requestedId);
      expect(JSON.stringify(result)).not.toContain(Object.values(acknowledgement).at(-1));
    },
  );

  test("an exact mismatch remains rejected even if a later record echoes the requested id", async () => {
    const mismatchedId = "00000000-0000-4000-8000-000000000002";
    const adapter = createEngineSessionAdapter({
      spawn: () =>
        completedProcess([
          `${JSON.stringify({ type: "thread.started", thread_id: mismatchedId })}\n`,
          `${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`,
        ]),
      writeEvidence: async () => "evidence/codex-sticky-resume-rejection.json",
    });
    const handle = adapter.start(
      request("codex", {
        attemptId: "attempt-codex-sticky-resume-rejection",
        nativeSessionId: CODEX_UUID,
        spawn: spawnProjection("codex", { sessionMode: "exact" }),
      }),
    );
    const result = await handle.completion;

    expect(handle.readResumeBinding()).toBeUndefined();
    expect(handle.readModelOutputBinding()).toBeUndefined();
    expect(result.state).toBe("ambiguous");
    expect(result.lifecycle).not.toContain("acknowledged");
    expect(result.output).not.toContain(mismatchedId);
    expect(result.output).not.toContain(CODEX_UUID);
  });

  test("OpenCode redacts a later opaque mismatch from the same acknowledged chunk", async () => {
    const requestedId = "opencode-session-001";
    const mismatchedId = "opencode-session-002";
    const adapter = createEngineSessionAdapter({
      spawn: () =>
        completedProcess([
          `${JSON.stringify({ type: "step_start", sessionID: requestedId })}\n${JSON.stringify({ type: "step_start", sessionID: mismatchedId })} ordinary ${mismatchedId}\n`,
        ]),
      writeEvidence: async () => "evidence/opencode-late-resume-mismatch.json",
    });
    const handle = adapter.start(
      request("opencode", {
        attemptId: "attempt-opencode-late-resume-mismatch",
        nativeSessionId: requestedId,
        spawn: spawnProjection("opencode", {
          sessionMode: "exact",
          rendered_tools: [],
          sandbox: null,
        }),
      }),
    );
    const result = await handle.completion;

    expect(handle.readResumeBinding()).toBeUndefined();
    expect(handle.readModelOutputBinding()).toBeUndefined();
    expect(result.state).toBe("ambiguous");
    expect(result.output).not.toContain(requestedId);
    expect(result.output).not.toContain(mismatchedId);
  });

  test("Codex exact mode rejects turn.started without the requested thread identity", async () => {
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess([`${JSON.stringify({ type: "turn.started" })}\n`]),
      writeEvidence: async () => "evidence/codex-missing-resume-proof.json",
    });
    const handle = adapter.start(
      request("codex", {
        attemptId: "attempt-codex-missing-resume-proof",
        nativeSessionId: CODEX_UUID,
        spawn: spawnProjection("codex", { sessionMode: "exact" }),
      }),
    );
    const result = await handle.completion;

    expect(handle.readResumeBinding()).toBeUndefined();
    expect(result.state).toBe("ambiguous");
    expect(result.lifecycle).toEqual(["requested", "dispatched", "ambiguous"]);
    expect(result.nativeSessionStatus).toBe("unavailable");
  });

  test.each(["fresh", "replay"] as const)(
    "Claude %s mode never consumes a supplied native id",
    async (sessionMode) => {
      let argv: string[] = [];
      const adapter = createEngineSessionAdapter({
        spawn: (next) => {
          argv = [...next];
          return completedProcess();
        },
        writeEvidence: async () => `evidence/claude-${sessionMode}.json`,
      });
      await adapter.start(
        request("claude", {
          nativeSessionId: "must-not-resume",
          spawn: spawnProjection("claude", { sessionMode }),
        }),
      ).completion;
      expect(argv).not.toContain("must-not-resume");
      expect(argv).not.toContain("-r");
    },
  );

  test.each(["opencode", "antigravity"] as const)(
    "%s omits model argv when no override was resolved",
    async (engine) => {
      let argv: string[] = [];
      const adapter = createEngineSessionAdapter({
        spawn: (next) => {
          argv = [...next];
          return completedProcess();
        },
        writeEvidence: async () => `evidence/${engine}-default-model.json`,
      });
      await adapter.start(
        request(engine, {
          spawn: spawnProjection(engine, { model: null, rendered_tools: [], sandbox: null }),
        }),
      ).completion;
      expect(argv).not.toContain("--model");
      expect(argv).not.toContain("default");
    },
  );

  test("Antigravity rejects exact resume because no exact binding is evidenced", () => {
    let spawns = 0;
    const adapter = createEngineSessionAdapter({
      spawn: () => {
        spawns++;
        return completedProcess();
      },
      writeEvidence: async () => "internal/invalid-antigravity-native",
    });
    expect(() =>
      adapter.start(
        request("antigravity", {
          nativeSessionId: "--model",
          spawn: spawnProjection("antigravity", {
            sessionMode: "exact",
            rendered_tools: [],
            sandbox: null,
          }),
        }),
      ),
    ).toThrow(/exact resume is unavailable/);
    expect(spawns).toBe(0);
  });

  test.each(["--continue", "session id with spaces", "ses_safe\n--model"])(
    "OpenCode rejects an argv-shaped or non-opaque exact session id: %s",
    (nativeSessionId) => {
      let spawns = 0;
      const adapter = createEngineSessionAdapter({
        spawn: () => {
          spawns++;
          return completedProcess();
        },
        writeEvidence: async () => "internal/invalid-opencode-native",
      });
      expect(() =>
        adapter.start(
          request("opencode", {
            nativeSessionId,
            spawn: spawnProjection("opencode", {
              sessionMode: "exact",
              rendered_tools: [],
              sandbox: null,
            }),
          }),
        ),
      ).toThrow(/invalid opencode native session id/);
      expect(spawns).toBe(0);
    },
  );

  test.each(["copilot", "antigravity"] as const)(
    "%s exact mode fails closed because safe native resume is not admitted",
    (engine) => {
      const adapter = createEngineSessionAdapter({
        spawn: () => completedProcess(),
        writeEvidence: async () => "internal/unsupported-restriction",
      });
      expect(() =>
        adapter.start(
          request(engine, {
            nativeSessionId: "unsupported-native-id",
            spawn: spawnProjection(engine, {
              sessionMode: "exact",
              rendered_tools: [],
              sandbox: null,
            }),
          }),
        ),
      ).toThrow(/exact resume is unavailable/);
    },
  );

  test.each(["opencode", "antigravity"] as const)(
    "%s fails closed when a native sandbox/tool restriction cannot be enforced",
    (engine) => {
      const adapter = createEngineSessionAdapter({
        spawn: () => completedProcess(),
        writeEvidence: async () => "internal/unsupported-restriction",
      });
      expect(() => adapter.start(request(engine))).toThrow(
        /cannot enforce rendered tools or sandbox/,
      );
    },
  );
});

describe("attempt lifecycle and cleanup", () => {
  test("zero grace hard-kills and resolves when SIGTERM is ignored", async () => {
    const signals: NodeJS.Signals[] = [];
    const child: EngineProcess = {
      pid: 4244,
      stdin: { write: () => {}, end: () => {} },
      exited: new Promise<number>(() => {}),
      kill: (signal = "SIGTERM") => {
        signals.push(signal);
      },
    };
    const terminator = createProcessTerminator({
      process: child,
      killProcessGroup: false,
      graceMs: 0,
      onReason: () => {},
    });

    const outcome = await Promise.race([
      terminator.terminate().then(() => "resolved" as const),
      Bun.sleep(20).then(() => "timed-out" as const),
    ]);

    expect(outcome).toBe("resolved");
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
  });

  test("default process launcher retains a child whose stdin write fails for adapter cleanup", () => {
    const spawn = makeEngineProcessSpawner(
      () =>
        ({
          stdin: {
            write: () => {
              throw new Error("EPIPE");
            },
            end: () => {},
          },
          exited: Promise.resolve(1),
          kill: () => {},
        }) as never,
    );
    const child = spawn(["fake-engine"], {
      env: {},
      stdinText: "prompt",
      detached: false,
    });
    expect(child.startupError?.message).toBe("EPIPE");
  });

  test("one process owns one handle and terminate is idempotent", async () => {
    const child = pendingProcess();
    let spawnCount = 0;
    const adapter = createEngineSessionAdapter({
      spawn: () => {
        spawnCount++;
        return child.process;
      },
      writeEvidence: async () => "evidence/a.json",
    });
    const handle = adapter.start(request("claude"));
    expect(spawnCount).toBe(1);
    await Promise.all([handle.terminate("stop"), handle.terminate("stop-again")]);
    await handle.completion;
    expect(child.kills()).toBe(1);
    expect(child.exited()).toBe(true);
  });

  test("a dispatched lifecycle callback failure is contained and awaits grace escalation", async () => {
    let resolveExit!: (status: number) => void;
    const signals: NodeJS.Signals[] = [];
    const child: EngineProcess = {
      pid: 4343,
      stdin: { write: () => {}, end: () => {} },
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      kill: (signal = "SIGTERM") => {
        signals.push(signal);
        if (signal === "SIGKILL") resolveExit(137);
      },
    };
    const adapter = createEngineSessionAdapter({
      spawn: () => child,
      graceMs: 1,
      writeEvidence: async () => "evidence/callback-error.json",
    });
    let handle: ReturnType<typeof adapter.start> | undefined;
    expect(() => {
      handle = adapter.start(
        request("claude", {
          attemptId: "attempt-callback-cleanup",
          onLifecycle: (state) => {
            if (state === "dispatched") throw new Error("callback exploded");
          },
        }),
      );
    }).not.toThrow();
    const result = await handle?.completion;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result?.reason).toContain("callback exploded");
    expect(result?.state).toBe("ambiguous");
  });

  test("stdin failure remains attached to the spawned process through hard cleanup", async () => {
    let resolveExit!: (status: number) => void;
    const signals: NodeJS.Signals[] = [];
    const process = {
      pid: 4444,
      stdin: {
        write: () => {
          throw new Error("EPIPE");
        },
        end: () => {},
      },
      stdout: stream(),
      stderr: stream(),
      exited: new Promise<number>((resolve) => {
        resolveExit = resolve;
      }),
      kill: (signal: NodeJS.Signals = "SIGTERM") => {
        signals.push(signal);
        if (signal === "SIGKILL") resolveExit(137);
      },
    };
    const adapter = createEngineSessionAdapter({
      spawn: makeEngineProcessSpawner(() => process as never),
      graceMs: 1,
      writeEvidence: async () => "evidence/stdin-error.json",
    });
    let handle: ReturnType<typeof adapter.start> | undefined;
    expect(() => {
      handle = adapter.start(request("claude", { attemptId: "attempt-stdin-cleanup" }));
    }).not.toThrow();
    const result = await handle?.completion;
    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(result?.reason).toContain("EPIPE");
  });

  test("pre-spawn failure leaves finalized non-empty evidence and consumes the attempt explicitly", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-pre-spawn-evidence-"));
    temporaryPaths.push(root);
    const adapter = createEngineSessionAdapter({
      evidenceRoot: root,
      spawn: () => {
        throw new Error("spawn exploded");
      },
    });
    const req = request("claude", { attemptId: "attempt-pre-spawn-failure" });
    expect(() => adapter.start(req)).toThrow(/spawn exploded/);
    const files = readdirSync(root);
    expect(files.sort()).toEqual(["attempt-pre-spawn-failure.json", "start-authority"]);
    expect(adapter.startAuthority?.read("attempt-pre-spawn-failure")).toMatchObject({
      attempt_id: "attempt-pre-spawn-failure",
      outcome: "unknown",
      process_quiescent: true,
    });
    expect(statSync(join(root, files[0] as string)).size).toBeGreaterThan(0);
    const evidence = JSON.parse(readFileSync(join(root, files[0] as string), "utf8")) as Record<
      string,
      unknown
    >;
    expect(evidence.reason).toBe("spawn exploded");
    expect(evidence.error_kind).toBe("engine_start");
    expect(evidence.state).toBe("engine_start");
    expect(evidence.lifecycle).toEqual(["requested"]);
    expect(JSON.stringify(evidence)).not.toContain("ambiguous");
    expect(() => adapter.start(req)).toThrow(/immutable attempt evidence already exists/);
  });

  test("requested observer failure releases its local lease and finalizes evidence", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-requested-callback-failure-"));
    temporaryPaths.push(root);
    const { repoRoot, cwd } = initializeLinkedGitWorktree(root);
    let released = 0;
    const lease = createIsolationLease({
      kind: "worktree",
      root,
      repoRoot,
      cwd,
      evidence_ref: "requested-callback-lease",
      release: () => {
        released++;
      },
    });
    const evidenceRoot = join(root, "evidence");
    const adapter = createEngineSessionAdapter({
      evidenceRoot,
      spawn: () => completedProcess(),
    });
    expect(() =>
      adapter.start(
        request("codex", {
          attemptId: "attempt-requested-callback",
          onLifecycle: (state) => {
            if (state === "requested") throw new Error("requested observer exploded");
          },
          spawn: spawnProjection("codex", {
            isolation: lease,
            provenance: { roleSource: "repo", roleHash: "repo-role", skillHashes: [] },
            trace_metadata: { role_resolved_hash: "repo-role", skill_resolved_hashes: [] },
          }),
        }),
      ),
    ).toThrow(/requested observer exploded/);
    expect(released).toBe(1);
    expect(statSync(join(evidenceRoot, "attempt-requested-callback.json")).size).toBeGreaterThan(0);
  });

  test("external abort linkage terminates once and leaves no orphan", async () => {
    const child = pendingProcess();
    const caller = new AbortController();
    let observeAcknowledged!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      observeAcknowledged = resolve;
    });
    const adapter = createEngineSessionAdapter({
      spawn: () => ({
        ...child.process,
        stdout: stream(`${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`),
        stderr: stream(),
      }),
      writeEvidence: async () => "evidence/a.json",
    });
    const handle = adapter.start(
      request("codex", {
        signal: caller.signal,
        onLifecycle: (state) => {
          if (state === "acknowledged") observeAcknowledged();
        },
      }),
    );
    await acknowledged;
    caller.abort("caller cancelled");
    caller.abort("duplicate");
    const result = await handle.completion;
    expect(child.kills()).toBe(1);
    expect(child.exited()).toBe(true);
    expect(result.lifecycle).toContain("acknowledged");
    expect(result.state).toBe("ambiguous");
    expect(result.reason).toBe("caller cancelled");
  });

  test.each([
    ["timeoutMs", { timeoutMs: 15 }],
    ["idleTimeoutMs", { idleTimeoutMs: 15 }],
  ] as const)("%s terminates the process and cleans up", async (_name, timing) => {
    const child = pendingProcess();
    const adapter = createEngineSessionAdapter({
      spawn: () => ({
        ...child.process,
        stdout: stream(`${JSON.stringify({ type: "result", session_id: CLAUDE_UUID })}\n`),
        stderr: stream(),
      }),
      graceMs: 0,
      ...timing,
      writeEvidence: async () => "evidence/a.json",
    });
    const result = await adapter.start(request("claude")).completion;
    expect(child.kills()).toBe(1);
    expect(child.exited()).toBe(true);
    expect(result.lifecycle).toContain("acknowledged");
    expect(result.state).toBe("ambiguous");
    expect(result.reason).toMatch(/timeout/);
  });

  test("startup I/O failure remains ambiguous even when protocol acknowledgement is readable", async () => {
    const child = pendingProcess();
    const adapter = createEngineSessionAdapter({
      spawn: () => ({
        ...child.process,
        stdout: stream(`${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`),
        stderr: stream(),
        startupError: new Error("EPIPE"),
      }),
      writeEvidence: async () => "evidence/startup-error.json",
    });
    const result = await adapter.start(
      request("codex", { attemptId: "attempt-startup-error-after-ack" }),
    ).completion;
    expect(result.lifecycle).toContain("acknowledged");
    expect(result.state).toBe("ambiguous");
    expect(result.reason).toContain("EPIPE");
  });

  test("explicit termination after acknowledgement remains ambiguous", async () => {
    const child = pendingProcess();
    let observeAcknowledged!: () => void;
    const acknowledged = new Promise<void>((resolve) => {
      observeAcknowledged = resolve;
    });
    const adapter = createEngineSessionAdapter({
      spawn: () => ({
        ...child.process,
        stdout: stream(`${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`),
        stderr: stream(),
      }),
      writeEvidence: async () => "evidence/forced-termination.json",
    });
    const handle = adapter.start(
      request("codex", {
        attemptId: "attempt-forced-termination-after-ack",
        onLifecycle: (state) => {
          if (state === "acknowledged") observeAcknowledged();
        },
      }),
    );
    await acknowledged;
    await handle.terminate("operator stopped");
    const result = await handle.completion;
    expect(result.lifecycle).toContain("acknowledged");
    expect(result.state).toBe("ambiguous");
    expect(result.reason).toBe("operator stopped");
  });

  test("crash after dispatch before acknowledgement is ambiguous and never auto-replayed", async () => {
    let spawnCount = 0;
    const adapter = createEngineSessionAdapter({
      spawn: () => {
        spawnCount++;
        return completedProcess([], 17);
      },
      writeEvidence: async () => "evidence/a.json",
    });
    const result = await adapter.start(request("codex")).completion;
    expect(result.state).toBe("ambiguous");
    expect(result.lifecycle).toEqual(["requested", "dispatched", "ambiguous"]);
    expect(spawnCount).toBe(1);
  });

  test.each([
    ["stderr", [], ["warning only\n"]],
    ["non-protocol stdout", ["warning only\n"], []],
  ] as const)("Codex %s cannot acknowledge a failed operation", async (_name, out, err) => {
    const adapter = createEngineSessionAdapter({
      spawn: () => ({
        ...completedProcess([...out], 17),
        stderr: stream(...err),
      }),
      writeEvidence: async () => "evidence/not-acknowledged.json",
    });
    const result = await adapter.start(request("codex")).completion;
    expect(result.state).toBe("ambiguous");
    expect(result.lifecycle).toEqual(["requested", "dispatched", "ambiguous"]);
  });

  test("Codex protocol evidence acknowledges before a nonzero terminal result", async () => {
    const adapter = createEngineSessionAdapter({
      spawn: () =>
        completedProcess(
          [`${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`],
          17,
        ),
      writeEvidence: async () => "evidence/acknowledged.json",
    });
    const result = await adapter.start(request("codex")).completion;
    expect(result.state).toBe("ambiguous");
    expect(result.lifecycle).toEqual(["requested", "dispatched", "acknowledged", "ambiguous"]);
  });

  test("exit zero without protocol acknowledgement remains ambiguous", async () => {
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess(["non-protocol output\n"], 0),
      writeEvidence: async () => "internal/evidence",
    });
    const result = await adapter.start(request("codex")).completion;
    expect(result.state).toBe("ambiguous");
    expect(result.lifecycle).toEqual(["requested", "dispatched", "ambiguous"]);
  });

  test("acknowledgement observer failure terminates instead of waiting for idle timeout", async () => {
    const child = pendingProcess();
    const adapter = createEngineSessionAdapter({
      spawn: () => ({
        ...child.process,
        stdout: stream(
          '{"type":"thread.started","thread_id":"019f278f-d7ff-77d3-9c44-7459bbf08d19"}\n',
        ),
      }),
      idleTimeoutMs: 100,
      graceMs: 0,
      writeEvidence: async () => "internal/evidence",
    });
    const result = await adapter.start(
      request("codex", {
        onLifecycle: (state) => {
          if (state === "acknowledged") throw new Error("ack observer exploded");
        },
      }),
    ).completion;
    expect(child.kills()).toBe(1);
    expect(result.state).toBe("ambiguous");
    expect(result.lifecycle.at(-1)).toBe("ambiguous");
    expect(result.reason).toContain("ack observer exploded");
  });

  test.each([
    ["stream", true],
    ["exit", false],
  ] as const)(
    "%s rejection after durable acknowledgement remains ambiguous",
    async (_kind, streamFails) => {
      let sentAcknowledgement = false;
      const acknowledgedThenFailed = new ReadableStream<Uint8Array>({
        pull(controller) {
          if (!sentAcknowledgement) {
            sentAcknowledgement = true;
            controller.enqueue(
              new TextEncoder().encode(
                `${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`,
              ),
            );
            if (!streamFails) controller.close();
            return;
          }
          throw new Error("stream observation failed");
        },
      });
      const adapter = createEngineSessionAdapter({
        spawn: () => ({
          pid: 5666,
          stdin: { write: () => {}, end: () => {} },
          stdout: acknowledgedThenFailed,
          stderr: stream(),
          exited: streamFails
            ? Promise.resolve(1)
            : Promise.reject(new Error("exit observation failed")),
          kill: () => {},
        }),
        graceMs: 1,
        writeEvidence: async () => "internal/evidence",
      });
      const result = await adapter.start(
        request("codex", { attemptId: `attempt-${_kind}-rejection-after-ack` }),
      ).completion;
      expect(result.lifecycle).toContain("acknowledged");
      expect(result.state).toBe("ambiguous");
      expect(result.lifecycle.at(-1)).toBe("ambiguous");
      expect(result.reason).toContain("observation failed");
    },
  );

  test.each([
    ["stream", true],
    ["exit", false],
  ] as const)("%s rejection resolves durable ambiguous evidence", async (_kind, streamFails) => {
    const root = mkdtempSync(join(tmpdir(), "vf-terminal-rejection-"));
    temporaryPaths.push(root);
    const failingStream = new ReadableStream<Uint8Array>({
      pull: () => {
        throw new Error("stream exploded");
      },
    });
    const adapter = createEngineSessionAdapter({
      evidenceRoot: root,
      spawn: () => ({
        pid: 5555,
        stdin: { write: () => {}, end: () => {} },
        stdout: streamFails ? failingStream : stream(),
        stderr: stream(),
        exited: streamFails ? Promise.resolve(1) : Promise.reject(new Error("exit exploded")),
        kill: () => {},
      }),
      graceMs: 1,
    });
    const result = await adapter.start(
      request("codex", { attemptId: `attempt-${_kind}-rejection` }),
    ).completion;
    expect(result.state).toBe("ambiguous");
    expect(result.reason).toContain("exploded");
    expect(readFileSync(join(root, `attempt-${_kind}-rejection.json`), "utf8")).toContain(
      "ambiguous",
    );
  });

  test("exit observation rejection waits for grace and hard-kills an unobserved child once", async () => {
    const signals: NodeJS.Signals[] = [];
    const signalTimes: number[] = [];
    const adapter = createEngineSessionAdapter({
      spawn: () => ({
        pid: 5777,
        stdin: { write: () => {}, end: () => {} },
        stdout: stream(),
        stderr: stream(),
        exited: Promise.reject(new Error("exit observer rejected")),
        kill: (signal = "SIGTERM") => {
          signals.push(signal);
          signalTimes.push(performance.now());
        },
      }),
      graceMs: 20,
      writeEvidence: async () => "internal/exit-observer-rejected",
    });

    const result = await Promise.race([
      adapter.start(request("codex", { attemptId: "attempt-exit-observer-cleanup" })).completion,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("exit-observer cleanup hung")), 500),
      ),
    ]);

    expect(signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect((signalTimes[1] ?? 0) - (signalTimes[0] ?? 0)).toBeGreaterThanOrEqual(15);
    expect(result.state).toBe("ambiguous");
    expect(result.reason).toContain("exit observer rejected");
  });
});

describe("native resume evidence and history reconciliation", () => {
  test("legacy workflow evidence strips raw native session identity", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-legacy-evidence-"));
    temporaryPaths.push(root);
    const nativeId = CLAUDE_UUID;
    const result = buildPublicDispatchResult(
      { engine: "claude", mode: "cli", prompt: "private workflow prompt" },
      {
        status: 0,
        stdout: JSON.stringify({ type: "result", session_id: nativeId }),
      },
      "legacy dispatch failed",
      undefined,
      "legacy-attempt-1",
    );
    expect(readDispatchResumeBinding(result)).toEqual({
      attemptId: "legacy-attempt-1",
      engine: "claude",
      nativeSessionId: nativeId,
    });
    result.raw = JSON.stringify({ type: "result", session_id: nativeId });
    result.summary = { files_changed: [nativeId], uncertainty: `resume ${nativeId}` };
    result.reason = `failed native ${nativeId}`;
    result.warning = `warning native ${nativeId}`;
    const rel = persistDispatch(root, result);
    const evidence = readFileSync(join(root, rel), "utf8");
    expect(evidence).not.toContain(nativeId);
    expect(evidence).not.toContain("sessionId");
    expect(evidence).toContain("nativeSessionStatus");
    expect(rel).toBe("evidence/attempts/legacy-attempt-1.json");
    expect(readFileSync(join(root, "evidence/claude.result.json"), "utf8")).not.toContain(nativeId);
    expect(
      readFileSync(join(root, "evidence/attempts/legacy-attempt-1.json"), "utf8"),
    ).not.toContain(nativeId);
    expect(() =>
      persistDispatch(root, {
        attemptId: "legacy-attempt-1",
        engine: "claude",
        mode: "cli",
        ok: true,
        raw: "duplicate",
      }),
    ).toThrow(/immutable attempt evidence already exists/);
  });

  test("legacy async chunks redact a split native session control record", async () => {
    const nativeId = CODEX_UUID;
    const chunks: string[] = [];
    const spawner = makeAsyncSpawner({
      onChunk: (chunk) => chunks.push(chunk),
      spawn: (() => ({
        pid: 4555,
        stdin: { write: () => {}, end: () => {} },
        stdout: stream('{"type":"thread.started","thread_', `id":"${nativeId}"}\n`),
        stderr: stream(),
        exited: Promise.resolve(0),
        kill: () => {},
      })) as never,
    });
    const result = await spawner("codex", ["exec", "--json", "-"], "prompt");
    expect(result.stdout).toContain(nativeId);
    expect(chunks.join("")).not.toContain(nativeId);
    expect(chunks.join("")).toContain("[opaque-native-session]");
  });

  test("onChunk is public-safe when a native id is split across process chunks", async () => {
    const nativeId = CODEX_UUID;
    const chunks: string[] = [];
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess(['{"type":"thread.started","thread_', `id":"${nativeId}"}\n`]),
      writeEvidence: async () => "evidence/safe-chunk.json",
    });
    await adapter.start(
      request("codex", {
        attemptId: "attempt-safe-chunk",
        onChunk: (chunk) => chunks.push(chunk.content),
      }),
    ).completion;
    expect(chunks.join("")).not.toContain(nativeId);
    expect(chunks.join("")).toContain("[opaque-native-session]");
  });

  test("a newly captured non-UUID native id redacts later text in the same frame", async () => {
    const nativeId = "opencode-session-safe";
    const chunks: string[] = [];
    const adapter = createEngineSessionAdapter({
      spawn: () =>
        completedProcess([
          `${JSON.stringify({ type: "step_start", sessionID: nativeId })} ordinary ${nativeId}\n`,
        ]),
      writeEvidence: async () => "evidence/opencode-same-frame.json",
    });
    const handle = adapter.start(
      request("opencode", {
        attemptId: "attempt-opencode-same-frame",
        onChunk: (chunk) => chunks.push(chunk.content),
        spawn: spawnProjection("opencode", { rendered_tools: [], sandbox: null }),
      }),
    );
    const result = await handle.completion;

    expect(handle.readResumeBinding()?.nativeSessionId).toBe(nativeId);
    expect(chunks.join("")).not.toContain(nativeId);
    expect(result.output).not.toContain(nativeId);
    expect(chunks.join("")).toContain("[opaque-native-session]");
  });

  test("a split OpenCode control record stays buffered until its native id can be redacted", async () => {
    const nativeId = "opencode-split-session";
    const chunks: string[] = [];
    const adapter = createEngineSessionAdapter({
      spawn: () =>
        completedProcess([
          '{"type":"step_start","session',
          `ID":"${nativeId}"} ordinary ${nativeId}\n`,
        ]),
      writeEvidence: async () => "evidence/opencode-split-frame.json",
    });
    const handle = adapter.start(
      request("opencode", {
        attemptId: "attempt-opencode-split-frame",
        onChunk: (chunk) => chunks.push(chunk.content),
        spawn: spawnProjection("opencode", { rendered_tools: [], sandbox: null }),
      }),
    );

    const result = await handle.completion;

    expect(handle.readResumeBinding()?.nativeSessionId).toBe(nativeId);
    expect(chunks.join("")).not.toContain(nativeId);
    expect(result.output).not.toContain(nativeId);
    expect(chunks.join("")).toContain("[opaque-native-session]");
  });

  test("OpenCode buffers earlier public frames until a future non-UUID session id is known", async () => {
    const nativeId = "opencode-future-session";
    const chunks: string[] = [];
    const adapter = createEngineSessionAdapter({
      spawn: () =>
        completedProcess([
          `ordinary output mentioned ${nativeId} before control\n`,
          `${JSON.stringify({ type: "step_start", sessionID: nativeId })}\n`,
        ]),
      writeEvidence: async () => "evidence/opencode-future-id.json",
    });
    const handle = adapter.start(
      request("opencode", {
        attemptId: "attempt-opencode-future-id",
        onChunk: (chunk) => chunks.push(chunk.content),
        spawn: spawnProjection("opencode", { rendered_tools: [], sandbox: null }),
      }),
    );

    const result = await handle.completion;

    expect(handle.readResumeBinding()?.nativeSessionId).toBe(nativeId);
    expect(chunks.join("")).not.toContain(nativeId);
    expect(result.output).not.toContain(nativeId);
    expect(chunks.join("")).toContain("[opaque-native-session]");
  });

  test("OpenCode buffers stderr until a future stdout session id can redact it", async () => {
    const nativeId = "opencode-future-stderr-session";
    let releaseStdout!: () => void;
    const stdoutReady = new Promise<void>((resolve) => {
      releaseStdout = resolve;
    });
    const chunks: Array<{ stream: "stdout" | "stderr"; content: string }> = [];
    const process = completedProcess();
    process.stdout = new ReadableStream({
      async start(controller) {
        await stdoutReady;
        controller.enqueue(
          new TextEncoder().encode(
            `${JSON.stringify({ type: "step_start", sessionID: nativeId })}\n`,
          ),
        );
        controller.close();
      },
    });
    process.stderr = new ReadableStream({
      pull(controller) {
        controller.enqueue(new TextEncoder().encode(`stderr mentioned ${nativeId}\n`));
        controller.close();
        setTimeout(releaseStdout, 0);
      },
    });
    const adapter = createEngineSessionAdapter({
      spawn: () => process,
      writeEvidence: async () => "evidence/opencode-future-stderr-id.json",
    });
    const handle = adapter.start(
      request("opencode", {
        attemptId: "attempt-opencode-future-stderr-id",
        onChunk: (chunk) => chunks.push(chunk),
        spawn: spawnProjection("opencode", { rendered_tools: [], sandbox: null }),
      }),
    );

    const result = await handle.completion;

    expect(handle.readResumeBinding()?.nativeSessionId).toBe(nativeId);
    expect(chunks.map((chunk) => chunk.content).join("")).not.toContain(nativeId);
    expect(result.output).not.toContain(nativeId);
    expect(chunks).toContainEqual({
      stream: "stderr",
      content: "stderr mentioned [opaque-native-session]\n",
    });
  });

  test("OpenCode releases both streams after close when no session id is captured", async () => {
    const chunks: Array<{ stream: "stdout" | "stderr"; content: string }> = [];
    const process = completedProcess(["stdout without a session id\n"]);
    process.stderr = stream("stderr without a session id\n");
    const adapter = createEngineSessionAdapter({
      spawn: () => process,
      writeEvidence: async () => "evidence/opencode-no-session-id.json",
    });
    const handle = adapter.start(
      request("opencode", {
        attemptId: "attempt-opencode-no-session-id",
        onChunk: (chunk) => chunks.push(chunk),
        spawn: spawnProjection("opencode", { rendered_tools: [], sandbox: null }),
      }),
    );

    const result = await handle.completion;

    expect(handle.readResumeBinding()).toBeUndefined();
    expect(result.nativeSessionStatus).toBe("unavailable");
    expect(result.output).toBe("stdout without a session id\n");
    expect(chunks).toContainEqual({ stream: "stdout", content: "stdout without a session id\n" });
    expect(chunks).toContainEqual({ stream: "stderr", content: "stderr without a session id\n" });
  });

  test.each([
    ["claude", CLAUDE_UUID, { type: "result", session_id: CLAUDE_UUID }],
    ["codex", CODEX_UUID, { type: "thread.started", thread_id: CODEX_UUID }],
  ] as const)(
    "%s never emits a future native UUID before its protocol capture",
    async (engine, nativeId, protocol) => {
      const chunks: string[] = [];
      const adapter = createEngineSessionAdapter({
        spawn: () =>
          completedProcess([
            `ordinary future identity ${nativeId}\n`,
            `${JSON.stringify(protocol)}\n`,
          ]),
        writeEvidence: async () => "evidence/future-native-id.json",
      });
      const handle = adapter.start(
        request(engine, {
          attemptId: `attempt-future-native-${engine}`,
          onChunk: (chunk) => chunks.push(chunk.content),
        }),
      );

      const result = await handle.completion;

      expect(handle.readResumeBinding()?.nativeSessionId).toBe(nativeId);
      expect(chunks.join("")).not.toContain(nativeId);
      expect(result.output).not.toContain(nativeId);
      expect(chunks.join("")).toContain("[opaque-native-session]");
    },
  );

  test.each([
    ["claude", CLAUDE_UUID],
    ["codex", CODEX_UUID],
  ] as const)(
    "%s redacts UUID-shaped native identity even when no protocol capture follows",
    async (engine, nativeId) => {
      const chunks: string[] = [];
      const adapter = createEngineSessionAdapter({
        spawn: () => completedProcess([`ordinary uncaptured identity ${nativeId}\n`]),
        writeEvidence: async () => "evidence/uncaptured-native-id.json",
      });

      const result = await adapter.start(
        request(engine, {
          attemptId: `attempt-uncaptured-native-${engine}`,
          onChunk: (chunk) => chunks.push(chunk.content),
        }),
      ).completion;

      expect(result.nativeSessionStatus).toBe("unavailable");
      expect(chunks.join("")).not.toContain(nativeId);
      expect(result.output).not.toContain(nativeId);
      expect(chunks.join("")).toContain("[opaque-native-session]");
      expect(result.output).toContain("[opaque-native-session]");
    },
  );

  test("oversized unterminated output fails closed without waiting for stream close", async () => {
    let closeStream!: () => void;
    const closeGate = new Promise<void>((resolve) => {
      closeStream = resolve;
    });
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new TextEncoder().encode("x".repeat(70 * 1024)));
        void closeGate.then(() => controller.close());
      },
    });
    let observeChunk!: (content: string) => void;
    const firstChunk = new Promise<string>((resolve) => {
      observeChunk = resolve;
    });
    const adapter = createEngineSessionAdapter({
      spawn: () => ({
        ...completedProcess(),
        stdout,
      }),
      writeEvidence: async () => "evidence/oversized-frame.json",
    });
    const handle = adapter.start(
      request("codex", {
        attemptId: "attempt-oversized-frame",
        onChunk: (chunk) => observeChunk(chunk.content),
      }),
    );

    const emittedBeforeClose = await Promise.race([
      firstChunk,
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("oversized frame remained buffered")), 50),
      ),
    ]);
    closeStream();
    await handle.completion;

    expect(emittedBeforeClose).toContain("[redacted-oversize]");
  });

  test("an oversized split Claude result still captures its bounded protocol identity", async () => {
    const envelope = `${JSON.stringify({
      type: "result",
      result: "x".repeat(70 * 1024),
      session_id: CLAUDE_UUID,
    })}\n`;
    const chunks: string[] = [];
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess([envelope.slice(0, 68 * 1024), envelope.slice(68 * 1024)]),
      writeEvidence: async () => "evidence/oversized-claude-protocol.json",
    });
    const handle = adapter.start(
      request("claude", {
        attemptId: "attempt-oversized-claude-protocol",
        onChunk: (chunk) => chunks.push(chunk.content),
      }),
    );

    const result = await handle.completion;

    expect(result.ok).toBe(true);
    expect(result.nativeSessionStatus).toBe("captured");
    expect(handle.readResumeBinding()?.nativeSessionId).toBe(CLAUDE_UUID);
    expect(chunks.join("")).not.toContain(CLAUDE_UUID);
    expect(result.output).toContain("[redacted-oversize]");
  });

  test("bounds retained stdout while delivering many public frames before stream close", async () => {
    const encoder = new TextEncoder();
    const fillerFrames = 384;
    const summaryLine = `${JSON.stringify({
      skills_used: [],
      files_changed: ["src/late-result.ts"],
      commands_run: [],
      tests_run: ["bounded stdout regression"],
      confidence: 0.97,
      uncertainty: "",
    })}\n`;
    let closeStdout!: () => void;
    let observeSummary!: () => void;
    const summaryDelivered = new Promise<void>((resolve) => {
      observeSummary = resolve;
    });
    const stdout = new ReadableStream<Uint8Array>({
      start(controller) {
        for (let index = 0; index < fillerFrames; index++) {
          const label =
            index === 0
              ? "early-retention-sentinel"
              : index === fillerFrames - 1
                ? "late-retention-sentinel"
                : `frame-${index}`;
          controller.enqueue(encoder.encode(`${label}:${"🙂".repeat(1_024)}\n`));
        }
        controller.enqueue(
          encoder.encode(`${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`),
        );
        controller.enqueue(encoder.encode(summaryLine));
        closeStdout = () => controller.close();
      },
    });
    let publicFrameCount = 0;
    const adapter = createEngineSessionAdapter({
      spawn: () => ({
        ...completedProcess(),
        stdout,
      }),
      writeEvidence: async () => "evidence/bounded-stdout.json",
    });
    const handle = adapter.start(
      request("codex", {
        attemptId: "attempt-bounded-stdout",
        onChunk: (chunk) => {
          publicFrameCount++;
          if (chunk.content.includes('"confidence":0.97')) observeSummary();
        },
      }),
    );

    await Promise.race([
      summaryDelivered,
      Bun.sleep(1_000).then(() => {
        throw new Error("public stdout stalled while the stream remained open");
      }),
    ]);
    expect(handle.readResumeBinding()?.nativeSessionId).toBe(CODEX_UUID);
    expect(publicFrameCount).toBe(fillerFrames + 2);

    closeStdout();
    const result = await handle.completion;
    expect(Buffer.byteLength(result.output, "utf8")).toBeLessThanOrEqual(64 * 1024);
    expect(result.output).toStartWith("[redacted-oversize]\n");
    expect(result.output).not.toContain("early-retention-sentinel");
    expect(result.output).toContain("late-retention-sentinel");
    expect(result.output).not.toContain("�");
    expect(result.summary?.confidence).toBe(0.97);
    expect(result.nativeSessionStatus).toBe("captured");
  });

  test("keeps Claude model output byte-exact on the authenticated private channel only", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-private-model-output-"));
    temporaryPaths.push(root);
    const modelOutput = JSON.stringify({
      schema_version: "1.0",
      scope: ["src/private-coordination.ts"],
      evidence_refs: ["artifact_private-coordination-proof"],
    });
    const envelope = JSON.stringify({
      type: "result",
      subtype: "success",
      is_error: false,
      session_id: CLAUDE_UUID,
      result: modelOutput,
    });
    const adapter = createEngineSessionAdapter({
      evidenceRoot: root,
      spawn: () => completedProcess([`${envelope}\n`]),
    });
    const handle = adapter.start(request("claude", { attemptId: "attempt-private-claude" }));

    const result = await handle.completion;
    expect(handle.readModelOutputBinding?.()).toEqual({
      attemptId: "attempt-private-claude",
      engine: "claude",
      nativeSessionId: CLAUDE_UUID,
      output: modelOutput,
    });
    expect(result.output).not.toContain("src/private-coordination.ts");
    expect(JSON.stringify(result)).not.toContain(modelOutput);
    expect(readFileSync(handle.readEvidenceBinding()?.internalRef as string, "utf8")).not.toContain(
      modelOutput,
    );
  });

  test("accepts only the last Codex agent message before one authenticated turn terminal", async () => {
    const modelOutput = JSON.stringify({ schema_version: "1.0", kind: "delegate_task" });
    const raw = [
      JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "reasoning", text: "untrusted reasoning decoy" },
      }),
      JSON.stringify({
        type: "item.completed",
        item: { type: "agent_message", text: modelOutput },
      }),
      JSON.stringify({ type: "turn.completed" }),
    ].join("\n");
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess([`${raw}\n`]),
      writeEvidence: async () => "evidence/private-codex.json",
    });
    const handle = adapter.start(request("codex", { attemptId: "attempt-private-codex" }));

    await handle.completion;
    expect(handle.readModelOutputBinding?.()).toEqual({
      attemptId: "attempt-private-codex",
      engine: "codex",
      nativeSessionId: CODEX_UUID,
      output: modelOutput,
    });
    expect(handle.readModelOutputBinding?.()?.output).not.toContain("reasoning decoy");
  });

  test.each([
    [
      "opencode",
      [
        JSON.stringify({ type: "step_start", sessionID: "opencode-private-session" }),
        JSON.stringify({ type: "text", part: { text: '{"kind":"complete"}' } }),
      ].join("\n"),
      "opencode-private-session",
    ],
    ["copilot", '{"kind":"complete"}', null],
    ["antigravity", '{"kind":"complete"}', null],
  ] as const)(
    "captures bounded native %s model output without public fallback",
    async (engine, raw, id) => {
      const adapter = createEngineSessionAdapter({
        spawn: () => completedProcess([`${raw}\n`]),
        writeEvidence: async () => `evidence/private-${engine}.json`,
      });
      const handle = adapter.start(
        request(engine, {
          attemptId: `attempt-private-${engine}`,
          spawn: spawnProjection(engine, {
            ...(engine === "opencode" || engine === "antigravity"
              ? { rendered_tools: [], sandbox: null }
              : {}),
          }),
        }),
      );

      await handle.completion;
      expect(handle.readModelOutputBinding()).toEqual({
        attemptId: `attempt-private-${engine}`,
        engine,
        nativeSessionId: id,
        output: engine === "opencode" ? '{"kind":"complete"}' : '{"kind":"complete"}\n',
      });
    },
  );

  test("never mints private model output for bridge protocol text", async () => {
    const adapter = createEngineSessionAdapter({
      protocol: "bridge",
      spawn: () => completedProcess(['{"kind":"complete"}\n']),
      writeEvidence: async () => "evidence/no-private-bridge.json",
    });
    const handle = adapter.start(request("copilot", { attemptId: "attempt-private-bridge" }));

    await handle.completion;
    expect(handle.readModelOutputBinding()).toBeUndefined();
  });

  test.each([
    [
      "missing Codex terminal",
      "codex",
      [
        JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: '{"kind":"complete"}' },
        }),
      ].join("\n"),
    ],
    [
      "duplicate Codex terminal",
      "codex",
      [
        JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID }),
        JSON.stringify({
          type: "item.completed",
          item: { type: "agent_message", text: '{"kind":"complete"}' },
        }),
        JSON.stringify({ type: "turn.completed" }),
        JSON.stringify({ type: "turn.completed" }),
      ].join("\n"),
    ],
    [
      "Claude error envelope",
      "claude",
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: true,
        session_id: CLAUDE_UUID,
        result: '{"kind":"complete"}',
      }),
    ],
    [
      "oversized Claude model output",
      "claude",
      JSON.stringify({
        type: "result",
        subtype: "success",
        is_error: false,
        session_id: CLAUDE_UUID,
        result: "x".repeat(70 * 1024),
      }),
    ],
  ] as const)("does not mint private model output for %s", async (_label, engine, raw) => {
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess([`${raw}\n`]),
      writeEvidence: async () => `evidence/no-private-${engine}.json`,
    });
    const handle = adapter.start(
      request(engine, { attemptId: `attempt-no-private-${engine}-${raw.length}` }),
    );

    await handle.completion;
    expect(handle.readModelOutputBinding?.()).toBeUndefined();
  });

  test("captures native identity internally but keeps status and immutable evidence opaque", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-attempt-evidence-"));
    temporaryPaths.push(root);
    const nativeId = CODEX_UUID;
    const adapter = createEngineSessionAdapter({
      evidenceRoot: root,
      spawn: () =>
        completedProcess([`${JSON.stringify({ type: "thread.started", thread_id: nativeId })}\n`]),
    });
    const handle = adapter.start(
      request("codex", {
        attemptId: "attempt-immutable-1",
        spawn: spawnProjection("codex", {
          provenance: { roleSource: "builtin", roleHash: nativeId, skillHashes: [nativeId] },
          trace_metadata: {
            role_resolved_hash: nativeId,
            skill_resolved_hashes: [nativeId],
          },
        }),
      }),
    );
    const result = await handle.completion;
    expect(handle.readResumeBinding()).toEqual({
      attemptId: "attempt-immutable-1",
      engine: "codex",
      nativeSessionId: nativeId,
    });
    expect(JSON.stringify(result)).not.toContain(nativeId);
    expect("evidenceRef" in result).toBe(false);
    const internalEvidence = handle.readEvidenceBinding();
    expect(internalEvidence?.internalRef).toEndWith("attempt-immutable-1.json");
    const evidence = readFileSync(internalEvidence?.internalRef as string, "utf8");
    expect(evidence).not.toContain(nativeId);
    expect(evidence).not.toContain("thread.started");
    expect(adapter.startAuthority?.read("attempt-immutable-1")).toMatchObject({
      attempt_id: "attempt-immutable-1",
      engine: "codex",
      outcome: "accepted",
      native_session_id: nativeId,
      evidence_ref: internalEvidence?.internalRef,
      process_quiescent: true,
    });
    expect(() => adapter.start(request("codex", { attemptId: "attempt-immutable-1" }))).toThrow(
      /immutable attempt evidence already exists/,
    );
  });

  test("the returned evidence ref remains attempt-specific when the engine alias advances", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-legacy-evidence-alias-"));
    temporaryPaths.push(root);
    const firstRef = persistDispatch(root, {
      attemptId: "legacy-attempt-first",
      engine: "claude",
      mode: "cli",
      ok: true,
      raw: "first result",
    });
    const secondRef = persistDispatch(root, {
      attemptId: "legacy-attempt-second",
      engine: "claude",
      mode: "cli",
      ok: true,
      raw: "second result",
    });
    expect(firstRef).toBe("evidence/attempts/legacy-attempt-first.json");
    expect(secondRef).toBe("evidence/attempts/legacy-attempt-second.json");
    expect(readFileSync(join(root, firstRef), "utf8")).toContain("legacy-attempt-first");
    expect(readFileSync(join(root, firstRef), "utf8")).not.toContain("legacy-attempt-second");
    expect(readFileSync(join(root, "evidence/claude.result.json"), "utf8")).toContain(
      "legacy-attempt-second",
    );
  });

  test("public chunks, result, summary and evidence redact prompt/env/token/path/raw refs", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-public-session-redaction-"));
    temporaryPaths.push(root);
    const prompt = "private prompt phrase";
    const token = "sk-abcdefghijklmnopqrstuvwxyz1234567890";
    const path = "/tmp/private/file.txt";
    const rawRef = "artifact://raw-private-reference";
    const chunks: string[] = [];
    const adapter = createEngineSessionAdapter({
      evidenceRoot: root,
      sourceEnv: { PATH: "/bin", HOME: "/home/private", OPENAI_API_KEY: token },
      spawn: () =>
        completedProcess([
          `${JSON.stringify({ type: "thread.started", thread_id: "019f278f-d7ff-77d3-9c44-7459bbf08d19" })}\n`,
          `${prompt} ${token} ${path} ${rawRef}\n`,
          `${JSON.stringify({ files_changed: [path], commands_run: [token], uncertainty: rawRef })}\n`,
        ]),
    });
    const result = await adapter.start(
      request("codex", {
        attemptId: "attempt-public-redaction",
        onChunk: (chunk) => chunks.push(chunk.content),
        spawn: spawnProjection("codex", {
          rendered_prompt: prompt,
          rendered_tools: [],
          isolation: null,
        }),
      }),
    ).completion;
    const publicJson = JSON.stringify({ chunks, result });
    for (const forbidden of [prompt, token, path, rawRef, "/home/private"]) {
      expect(publicJson).not.toContain(forbidden);
    }
    expect("evidenceRef" in result).toBe(false);
    const evidence = readFileSync(join(root, "attempt-public-redaction.json"), "utf8");
    for (const forbidden of [prompt, token, path, rawRef, "/home/private"]) {
      expect(evidence).not.toContain(forbidden);
    }
  });

  test("public streaming redacts each line of a multiline rendered prompt", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-public-multiline-prompt-redaction-"));
    temporaryPaths.push(root);
    const promptLines = [
      "oracular marigold instruction alpha",
      "tessellated moonstone instruction beta",
      "velvet compass instruction gamma",
    ];
    const prompt = promptLines.join("\n");
    const chunks: string[] = [];
    const adapter = createEngineSessionAdapter({
      evidenceRoot: root,
      sourceEnv: { PATH: "/bin" },
      spawn: () => completedProcess(promptLines.map((line) => `${line}\n`)),
    });

    const result = await adapter.start(
      request("codex", {
        attemptId: "attempt-public-multiline-prompt-redaction",
        onChunk: (chunk) => chunks.push(chunk.content),
        spawn: spawnProjection("codex", {
          rendered_prompt: prompt,
          rendered_tools: [],
          isolation: null,
        }),
      }),
    ).completion;

    const publicJson = JSON.stringify({ chunks, result });
    const evidence = readFileSync(
      join(root, "attempt-public-multiline-prompt-redaction.json"),
      "utf8",
    );
    for (const forbidden of promptLines) {
      expect(publicJson).not.toContain(forbidden);
      expect(evidence).not.toContain(forbidden);
    }
  });

  test("standalone public sanitizer removes bare credentials and local paths", () => {
    const value = sanitizePublicText(
      "sk-abcdefghijklmnopqrstuvwxyz1234567890 /tmp/private/file foo/bar.txt",
    );
    expect(value).not.toContain("sk-abcdefghijklmnopqrstuvwxyz1234567890");
    expect(value).not.toContain("/tmp/private/file");
    expect(value).not.toContain("foo/bar.txt");
  });

  test("public sanitizer fails closed when a private prompt has too many fragments", () => {
    const fragmentedPrompt = Array.from(
      { length: 513 },
      (_, index) => `private prompt fragment ${index}`,
    ).join("\n");
    expect(sanitizePublicText("truthful public output", [], [fragmentedPrompt])).toBe(
      "[redacted-oversize]",
    );
  });

  test("short private values redact standalone without corrupting ordinary embedded text", async () => {
    const credential = "provider-credential-private-value";
    const privateRef = "private-evidence-reference";
    const rawRef = "artifact://private-evidence-reference";
    const adapter = createEngineSessionAdapter({
      sourceEnv: { PATH: "1", HOME: "p", OPENAI_API_KEY: credential },
      spawn: () =>
        completedProcess([
          `${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`,
          `bridge-output confidence 1\np\nprefix${credential}suffix prefix${CODEX_UUID}suffix ${rawRef}\n`,
        ]),
      writeEvidence: async () => "evidence/short-private.json",
    });
    const result = await adapter.start(
      request("codex", {
        attemptId: "attempt-short-private",
        spawn: spawnProjection("codex", { rendered_prompt: "p", rendered_tools: [] }),
      }),
    ).completion;
    expect(result.output).toContain("bridge-output confidence 1");
    expect(result.output).not.toMatch(/\np\n/);
    expect(result.output).not.toContain(credential);
    expect(result.output).not.toContain(CODEX_UUID);
    expect(result.output).not.toContain(rawRef);
    expect(sanitizePublicText("p", [], ["p"])).toBe("[redacted-ref]");
    const embedded = sanitizePublicText(
      `bridge-output prefix${privateRef}suffix prefix${CODEX_UUID}suffix`,
      [CODEX_UUID],
      ["p", privateRef],
    );
    expect(embedded).toContain("bridge-output");
    expect(embedded).not.toContain(privateRef);
    expect(embedded).not.toContain(CODEX_UUID);
  });

  test("rejects an unsafe captured native id before internal resume storage", async () => {
    const adapter = createEngineSessionAdapter({
      spawn: () =>
        completedProcess(['{"type":"result","session_id":"--dangerously-skip-permissions"}\n']),
      writeEvidence: async () => "evidence/unsafe-captured-id.json",
    });
    const handle = adapter.start(request("claude", { attemptId: "attempt-unsafe-capture" }));
    const result = await handle.completion;
    expect(handle.readResumeBinding()).toBeUndefined();
    expect(result.nativeSessionStatus).toBe("unavailable");
    expect(result.output).not.toContain("--dangerously-skip-permissions");
  });

  test.each(["claude", "codex"] as const)(
    "%s reconciles supplied supported history",
    async (engine) => {
      const adapter = createEngineSessionAdapter({ spawn: () => completedProcess() });
      const nativeSessionId = engine === "claude" ? CLAUDE_UUID : CODEX_UUID;
      const result = await adapter.reconcileHistory({
        engine,
        nativeSessionId,
        history:
          engine === "claude"
            ? [
                {
                  type: "assistant",
                  sessionId: nativeSessionId,
                  message: { content: [{ type: "tool_use", name: "Read" }] },
                },
              ]
            : [
                { type: "session_meta", payload: { id: nativeSessionId } },
                {
                  type: "response_item",
                  payload: { type: "message", role: "assistant" },
                },
                {
                  type: "response_item",
                  payload: { type: "function_call", name: "shell" },
                },
              ],
      });
      expect(result).toEqual({
        status: "reconciled",
        imported_turn_count: 1,
        imported_tool_count: 1,
        native_history_continuity: "intact",
        completeness_reason: "supported native history supplied",
      });
      expect(JSON.stringify(result)).not.toContain(nativeSessionId);
    },
  );

  test("reconciles real Claude and Codex nested history record shapes", async () => {
    const adapter = createEngineSessionAdapter({ spawn: () => completedProcess() });
    const claude = await adapter.reconcileHistory({
      engine: "claude",
      nativeSessionId: CLAUDE_UUID,
      history: [
        {
          type: "assistant",
          sessionId: CLAUDE_UUID,
          message: { content: [{ type: "text" }, { type: "tool_use", name: "Read" }] },
        },
      ],
    });
    expect(claude.imported_turn_count).toBe(1);
    expect(claude.imported_tool_count).toBe(1);
    const codex = await adapter.reconcileHistory({
      engine: "codex",
      nativeSessionId: CODEX_UUID,
      history: [
        { type: "session_meta", payload: { id: CODEX_UUID } },
        { type: "response_item", payload: { type: "message", role: "assistant" } },
        { type: "response_item", payload: { type: "function_call", name: "shell" } },
      ],
    });
    expect(codex.imported_turn_count).toBe(1);
    expect(codex.imported_tool_count).toBe(1);
  });

  test.each([
    {
      engine: "claude" as const,
      nativeSessionId: CLAUDE_UUID,
      history: [
        { type: "assistant", sessionId: CLAUDE_UUID, message: { content: [] } },
        { type: "system", subtype: "compact_boundary", sessionId: CLAUDE_UUID },
      ],
    },
    {
      engine: "codex" as const,
      nativeSessionId: CODEX_UUID,
      history: [
        { type: "session_meta", payload: { id: CODEX_UUID } },
        { type: "compacted", payload: { replacement_history: [] } },
      ],
    },
  ])("$engine reports a native compaction boundary as partial continuity", async (request) => {
    const adapter = createEngineSessionAdapter({ spawn: () => completedProcess() });
    const result = await adapter.reconcileHistory(request);

    expect(result).toMatchObject({
      status: "partial",
      native_history_continuity: "compacted",
    });
    expect(result.completeness_reason).toContain("compaction boundary");
    expect(JSON.stringify(result)).not.toContain(request.nativeSessionId);
  });

  test.each(["claude", "codex"] as const)(
    "%s loads supported native JSONL history when records are not supplied",
    async (engine) => {
      const root = mkdtempSync(join(tmpdir(), `vf-${engine}-history-`));
      temporaryPaths.push(root);
      const nested = join(root, "2026", "08", "22");
      mkdirSync(nested, { recursive: true });
      const nativeSessionId = engine === "claude" ? CLAUDE_UUID : CODEX_UUID;
      const filename =
        engine === "claude"
          ? `${nativeSessionId}.jsonl`
          : `rollout-2026-08-22T12-00-00-${nativeSessionId}.jsonl`;
      const records =
        engine === "claude"
          ? [
              {
                type: "assistant",
                sessionId: nativeSessionId,
                message: { content: [{ type: "tool_use", name: "Read" }] },
              },
            ]
          : [
              { type: "session_meta", payload: { id: nativeSessionId } },
              {
                type: "response_item",
                payload: { type: "message", role: "assistant" },
              },
              {
                type: "response_item",
                payload: { type: "function_call", name: "shell" },
              },
            ];
      writeFileSync(
        join(nested, filename),
        `${records.map((record) => JSON.stringify(record)).join("\n")}\n`,
      );
      const adapter = createEngineSessionAdapter({
        spawn: () => completedProcess(),
        historyRoots: { [engine]: [root] },
      });
      expect(await adapter.reconcileHistory({ engine, nativeSessionId })).toEqual({
        status: "reconciled",
        imported_turn_count: 1,
        imported_tool_count: 1,
        native_history_continuity: "intact",
        completeness_reason: "supported native history loaded",
      });
    },
  );

  test("Codex ignores a decoy history filename that merely contains the native id", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-codex-history-decoy-"));
    temporaryPaths.push(root);
    const nativeSessionId = CODEX_UUID;
    writeFileSync(
      join(root, `decoy-${nativeSessionId}.jsonl`),
      `${JSON.stringify({ type: "session_meta", payload: { id: nativeSessionId } })}\n${JSON.stringify({ type: "response_item", payload: { type: "message", role: "assistant" } })}\n`,
    );
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess(),
      historyRoots: { codex: [root] },
    });
    expect(await adapter.reconcileHistory({ engine: "codex", nativeSessionId })).toEqual({
      status: "partial",
      imported_turn_count: 0,
      imported_tool_count: 0,
      native_history_continuity: "unproved",
      completeness_reason: "supported native history was not supplied",
    });
  });

  test("unrecognized native records cannot claim reconciled completeness", async () => {
    const adapter = createEngineSessionAdapter({ spawn: () => completedProcess() });
    const result = await adapter.reconcileHistory({
      engine: "codex",
      nativeSessionId: CODEX_UUID,
      history: [
        { type: "session_meta", payload: { id: CODEX_UUID } },
        { type: "invented_record", payload: {} },
      ],
    });
    expect(result.status).toBe("partial");
    expect(result.completeness_reason).toContain("unrecognized");
  });

  test.each(["copilot", "opencode", "antigravity"] as const)(
    "%s reports history unavailable instead of claiming completeness",
    async (engine) => {
      const adapter = createEngineSessionAdapter({ spawn: () => completedProcess() });
      expect(
        await adapter.reconcileHistory({ engine, nativeSessionId: "internal-id", history: [] }),
      ).toEqual({
        status: "unavailable",
        imported_turn_count: 0,
        imported_tool_count: 0,
        native_history_continuity: "unproved",
        completeness_reason: `${engine} native history completeness is not supported`,
      });
    },
  );
});

describe("canonical isolation leases", () => {
  test("a container mount for an unrelated host repo cannot authorize project material", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-container-repo-binding-"));
    temporaryPaths.push(root);
    const mountedRepo = join(root, "mounted-repo");
    const requestedRepo = join(root, "unrelated-repo");
    mkdirSync(mountedRepo);
    mkdirSync(requestedRepo);
    const inspector = createDockerRuntimeInspector({
      run: () => ({
        Id: "container-1",
        State: { Running: true },
        Mounts: [{ Source: mountedRepo, Destination: "/workspace" }],
      }),
    });
    expect(() =>
      createIsolationLease({
        kind: "container",
        repoRoot: requestedRepo,
        root: "/workspace",
        cwd: "/workspace",
        containerId: "container-1",
        runtimeInspector: inspector,
        evidence_ref: "unrelated-container-repo",
      }),
    ).toThrow(/associated canonical repository/);
  });

  test("a branded inspected container executes only for its associated host repo", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-container-positive-"));
    temporaryPaths.push(root);
    const repoRoot = join(root, "repo");
    mkdirSync(repoRoot);
    const inspectedArgv: readonly string[][] = [];
    const inspector = createDockerRuntimeInspector({
      run: (argv) => {
        (inspectedArgv as string[][]).push([...argv]);
        return {
          Id: "container-2",
          State: { Running: true },
          Mounts: [{ Source: repoRoot, Destination: "/workspace" }],
        };
      },
    });
    const lease = createIsolationLease({
      kind: "container",
      repoRoot,
      root: "/workspace",
      cwd: "/workspace",
      containerId: "container-2",
      runtimeInspector: inspector,
      evidence_ref: "container-positive",
    });
    expect(validateIsolationLease(lease).repoRoot).toBe(realpathSync(repoRoot));
    let launched: string[] = [];
    const adapter = createEngineSessionAdapter({
      spawn: (argv) => {
        launched = [...argv];
        return completedProcess([
          `${JSON.stringify({ type: "thread.started", thread_id: CODEX_UUID })}\n`,
        ]);
      },
      writeEvidence: async () => "internal/container-evidence",
    });
    await adapter.start(
      request("codex", {
        attemptId: "attempt-container-positive",
        spawn: spawnProjection("codex", {
          isolation: lease,
          provenance: { roleSource: "repo", roleHash: "container-role", skillHashes: [] },
          trace_metadata: {
            role_resolved_hash: "container-role",
            skill_resolved_hashes: [],
          },
        }),
      }),
    ).completion;
    expect(inspectedArgv[0]).toEqual([
      "docker",
      "inspect",
      "--type",
      "container",
      "--format",
      "{{json .}}",
      "container-2",
    ]);
    expect(launched.slice(0, 6)).toEqual(["docker", "exec", "-i", "-w", "/workspace", "--env"]);
    expect(launched).toContain("container-2");
  });

  test("a boolean callback cannot fabricate container runtime authority", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-container-callback-forgery-"));
    temporaryPaths.push(root);
    expect(() =>
      createIsolationLease({
        kind: "container",
        root,
        cwd: root,
        evidence_ref: "forged-container",
        runtimeAuthority: () => true,
      }),
    ).toThrow(/trusted container runtime authority/);
  });

  test("an unrelated standalone git repository is not VibeFlow worktree authority", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-standalone-repo-"));
    temporaryPaths.push(root);
    const cwd = join(root, "unrelated");
    initializeGitWorktree(cwd);
    expect(() =>
      createIsolationLease({
        kind: "worktree",
        root,
        cwd,
        repoRoot: cwd,
        evidence_ref: "standalone-repo",
      }),
    ).toThrow(/canonical VibeFlow repository/);
  });

  test("project-role launch uses the canonical real cwd and releases after completion", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-isolation-root-"));
    temporaryPaths.push(root);
    const { repoRoot, cwd } = initializeLinkedGitWorktree(root);
    let released = 0;
    const lease = createIsolationLease({
      kind: "worktree",
      root,
      cwd,
      repoRoot,
      evidence_ref: "isolation-evidence-1",
      release: () => {
        released++;
      },
    });
    let actualCwd: string | undefined;
    let actualPwd: string | undefined;
    const adapter = createEngineSessionAdapter({
      spawn: (_argv, opts) => {
        actualCwd = opts.cwd;
        actualPwd = opts.env.PWD;
        return completedProcess();
      },
      writeEvidence: async () => "evidence/a.json",
    });
    const projection = spawnProjection("codex", {
      isolation: lease,
      provenance: { roleSource: "repo", roleHash: "project-role", skillHashes: [] },
      trace_metadata: { role_resolved_hash: "project-role", skill_resolved_hashes: [] },
    });
    expect(isIsolationLeaseLive(lease)).toBe(true);
    await adapter.start(request("codex", { spawn: projection })).completion;
    expect(actualCwd).toBe(realpathSync(cwd));
    expect(actualPwd).toBe(realpathSync(cwd));
    expect(released).toBe(1);
    expect(isIsolationLeaseLive(lease)).toBe(false);
  });

  test("project-role launch rejects an absent or already released lease", async () => {
    const adapter = createEngineSessionAdapter({
      spawn: () => completedProcess(),
      writeEvidence: async () => "internal/project-rejection",
    });
    const project = spawnProjection("codex", {
      provenance: { roleSource: "repo", roleHash: "project-role", skillHashes: [] },
      trace_metadata: { role_resolved_hash: "project-role", skill_resolved_hashes: [] },
    });
    expect(() =>
      adapter.start(request("codex", { attemptId: "attempt-project-missing", spawn: project })),
    ).toThrow(/project role requires a live isolation lease/);

    const root = mkdtempSync(join(tmpdir(), "vf-released-root-"));
    temporaryPaths.push(root);
    const { repoRoot, cwd } = initializeLinkedGitWorktree(root);
    const lease = createIsolationLease({
      kind: "worktree",
      root,
      cwd,
      repoRoot,
      evidence_ref: "released-lease",
    });
    await releaseIsolationLease(lease);
    expect(() =>
      adapter.start(
        request("codex", {
          attemptId: "attempt-project-released",
          spawn: spawnProjection("codex", { ...project, isolation: lease }),
        }),
      ),
    ).toThrow(/project role requires a live isolation lease/);
  });

  test("a project source cannot bypass isolation with a builtin-looking prefix", () => {
    const base = spawnProjection("codex");
    expect(() =>
      createSpawnOptionsProjection({
        ...base,
        provenance: {
          roleSource: "builtin-evil-project" as never,
          roleHash: "role",
          skillHashes: [],
        },
        trace_metadata: { role_resolved_hash: "role", skill_resolved_hashes: [] },
      }),
    ).toThrow(/roleSource must be builtin or repo/);
  });

  test("a fabricated .git directory is not accepted as worktree authority", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-fabricated-worktree-"));
    temporaryPaths.push(root);
    const cwd = join(root, "unit");
    mkdirSync(join(cwd, ".git"), { recursive: true });
    expect(() =>
      createIsolationLease({
        kind: "worktree",
        root,
        cwd,
        repoRoot: root,
        evidence_ref: "fabricated-worktree",
      }),
    ).toThrow(/worktree authority/);
  });

  test("a nominal host directory is not accepted as container authority", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-fabricated-container-"));
    temporaryPaths.push(root);
    expect(() =>
      createIsolationLease({
        kind: "container",
        root,
        cwd: root,
        evidence_ref: "fabricated-container",
      }),
    ).toThrow(/canonical repository|container runtime authority/);
  });

  test("realpath validation rejects a lease that escapes its root through a symlink", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-isolation-safe-"));
    const outside = mkdtempSync(join(tmpdir(), "vf-isolation-outside-"));
    temporaryPaths.push(root, outside);
    const link = join(root, "escape");
    symlinkSync(outside, link);
    expect(() =>
      createIsolationLease({
        kind: "worktree",
        root,
        cwd: link,
        evidence_ref: "escape-lease",
      }),
    ).toThrow(/outside isolation root/);
  });

  test("post-start request mutation cannot change evidence or leak the locally claimed lease", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-isolation-mutation-"));
    temporaryPaths.push(root);
    const { repoRoot, cwd } = initializeLinkedGitWorktree(root);
    let released = 0;
    const lease = createIsolationLease({
      kind: "worktree",
      root,
      cwd,
      repoRoot,
      evidence_ref: "mutation-lease",
      release: () => {
        released++;
      },
    });
    const child = pendingProcess();
    let capturedEvidence: Readonly<Record<string, unknown>> | undefined;
    const adapter = createEngineSessionAdapter({
      spawn: () => child.process,
      writeEvidence: async (_attempt, evidence) => {
        capturedEvidence = evidence;
        return "internal/evidence";
      },
    });
    const originalSpawn = spawnProjection("codex", {
      isolation: lease,
      provenance: { roleSource: "repo", roleHash: "original-role", skillHashes: [] },
      trace_metadata: { role_resolved_hash: "original-role", skill_resolved_hashes: [] },
    });
    const mutableRequest = request("codex", { spawn: originalSpawn });
    const handle = adapter.start(mutableRequest);
    mutableRequest.spawn = spawnProjection("codex", {
      provenance: { roleSource: "builtin", roleHash: "mutated-role", skillHashes: [] },
      trace_metadata: { role_resolved_hash: "mutated-role", skill_resolved_hashes: [] },
    });
    await handle.terminate("done");
    await handle.completion;
    expect(released).toBe(1);
    expect(JSON.stringify(capturedEvidence)).toContain("original-role");
    expect(JSON.stringify(capturedEvidence)).not.toContain("mutated-role");
  });
});

describe("workflow resume compatibility", () => {
  test("public marker listing hides raw native session ids", () => {
    const unit = `session-public-${process.pid}-${Date.now()}`;
    const nativeId = CLAUDE_UUID;
    createMarker(unit, "claude");
    updateMarker(unit, {
      status: "running",
      engineSessionId: nativeId,
      engineSessionEngine: "claude",
      evidence: [`safe-evidence-${nativeId}`],
    });
    try {
      expect(readMarker(unit)?.engineSessionId).toBe(nativeId);
      const publicMarker = listMarkers().find((marker) => marker.unit === unit);
      expect(publicMarker?.nativeSessionStatus).toBe("captured");
      expect(JSON.stringify(publicMarker)).not.toContain(nativeId);
      expect(JSON.stringify(publicMarker)).not.toContain("engineSessionId");
      expect(JSON.stringify(publicMarker)).not.toContain("resumeStatus");
      expect(JSON.stringify(publicMarker)).not.toContain("engineSessionEngine");
      expect(JSON.stringify(publicMarker)).not.toContain("safe-evidence-");
    } finally {
      cleanupMarker(unit);
    }
  });

  test("marker storage rejects a flag-shaped native session id", () => {
    const unit = `session-marker-unsafe-${process.pid}-${Date.now()}`;
    createMarker(unit, "claude");
    try {
      expect(() =>
        updateMarker(unit, { engineSessionId: "--dangerously-skip-permissions" }),
      ).toThrow(/invalid claude native session id/);
      expect(readMarker(unit)?.engineSessionId).toBeUndefined();
    } finally {
      cleanupMarker(unit);
    }
  });

  test("orchestrator reads the old exact resume binding before writing a fresh marker", async () => {
    const unit = `session-resume-${process.pid}-${Date.now()}`;
    createMarker(unit, "claude");
    updateMarker(unit, {
      status: "running",
      engineSessionId: CLAUDE_UUID,
      engineSessionEngine: "claude",
    });
    let observed: string | undefined;
    try {
      await orchestrateUnits({
        units: [
          {
            name: unit,
            status: "pending",
            confidence: 0,
            gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
            resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
          },
        ],
        concurrency: 1,
        dispatcher: async () => {
          observed = readMarker(unit)?.engineSessionId;
          expect(readMarker(unit)?.resumeStatus).toBe("running");
          return { status: "verifying", confidence: 1, evidence: ["focused-test"] };
        },
        reviewer: () => ({ pass: true, reason: "ok" }),
      });
      expect(observed).toBe(CLAUDE_UUID);
    } finally {
      cleanupMarker(unit);
    }
  });

  test.each(["done", "pending"] as const)(
    "a prior %s marker never becomes resumable after the new run turns running",
    async (priorStatus) => {
      const unit = `session-no-resume-${priorStatus}-${process.pid}-${Date.now()}`;
      createMarker(unit, "claude");
      updateMarker(unit, {
        status: priorStatus,
        engineSessionId: CLAUDE_UUID,
        engineSessionEngine: "claude",
      });
      let observedId: string | undefined;
      let observedResumeStatus: string | undefined;
      try {
        await orchestrateUnits({
          units: [
            {
              name: unit,
              status: "pending",
              confidence: 0,
              gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
              resources: { agents: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
            },
          ],
          concurrency: 1,
          dispatcher: async () => {
            const marker = readMarker(unit);
            observedId = marker?.engineSessionId;
            observedResumeStatus = marker?.resumeStatus;
            return { status: "verifying", confidence: 1, evidence: ["focused-test"] };
          },
          reviewer: () => ({ pass: true, reason: "ok" }),
        });
        expect(observedId).toBeUndefined();
        expect(observedResumeStatus).toBe(priorStatus);
        expect(JSON.stringify(listMarkers().find((marker) => marker.unit === unit))).not.toContain(
          "resumeStatus",
        );
      } finally {
        cleanupMarker(unit);
      }
    },
  );
});

describe("dispatch session runtime integration", () => {
  test("workflow dispatch runs at base without isolation and at the claimed cwd with isolation", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-dispatch-runtime-cwd-"));
    temporaryPaths.push(root);
    const { repoRoot, cwd } = initializeLinkedGitWorktree(root);
    const observed: string[] = [];
    const run = (wtPath?: string) =>
      runDispatchWithSessionRuntime({
        engine: "claude",
        prompt: "cwd prompt",
        mode: "cli",
        unit: wtPath ? "isolated" : "base",
        base: repoRoot,
        ...(wtPath ? { wtPath } : {}),
        skillNames: [],
        processSpawner: (_argv, options) => {
          observed.push(options.cwd ?? "<missing>");
          return completedProcess([
            `${JSON.stringify({ type: "result", session_id: CLAUDE_UUID, result: "ok" })}\n`,
          ]);
        },
      });
    expect((await run()).ok).toBe(true);
    expect((await run(cwd)).ok).toBe(true);
    expect(observed).toEqual([realpathSync(repoRoot), realpathSync(cwd)]);
  });

  test.each(["opencode", "antigravity"] as const)(
    "canonical workflow adapter retains %s execution compatibility",
    async (engine) => {
      const root = mkdtempSync(join(tmpdir(), `vf-dispatch-runtime-${engine}-`));
      temporaryPaths.push(root);
      initializeGitWorktree(root);
      const prompt = `workflow prompt ${engine}`;
      let observedArgv: string[] = [];
      let observedInput = "";
      const result = await runDispatchWithSessionRuntime({
        engine,
        prompt,
        mode: "cli",
        unit: engine,
        base: root,
        skillNames: [],
        processSpawner: (argv, options) => {
          observedArgv = argv;
          observedInput = options.stdinText;
          expect(options.cwd).toBe(realpathSync(root));
          const output =
            engine === "opencode"
              ? `${JSON.stringify({ type: "step_start", sessionID: "opencode-session-safe" })}\n`
              : "antigravity acknowledged\n";
          return completedProcess([output]);
        },
      });
      expect(result.ok).toBe(true);
      expect(observedArgv[0]).toBe(engine === "opencode" ? "opencode" : "agy");
      expect(engine === "opencode" ? observedInput : observedArgv.join(" ")).toContain(prompt);
    },
  );

  test("the original workflow prompt is private from the first public chunk through the result", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-dispatch-runtime-private-prompt-"));
    temporaryPaths.push(root);
    initializeGitWorktree(root);
    const prompt = "ORIGINAL WORKFLOW PROMPT MUST STAY PRIVATE";
    const chunks: string[] = [];
    const result = await runDispatchWithSessionRuntime({
      engine: "claude",
      prompt,
      mode: "cli",
      unit: "private-prompt",
      base: root,
      skillNames: [],
      onStdoutChunk: (chunk) => chunks.push(chunk),
      processSpawner: () =>
        completedProcess([
          `${prompt}\n`,
          `${JSON.stringify({ type: "result", session_id: CLAUDE_UUID, result: prompt })}\n`,
        ]),
    });
    expect(chunks.length).toBeGreaterThan(0);
    expect(chunks[0]).not.toContain(prompt);
    expect(chunks.join("")).not.toContain(prompt);
    expect(result.raw).not.toContain(prompt);
    expect(JSON.stringify(result.summary ?? {})).not.toContain(prompt);
  });

  test("binding failure sanitizes the exact resume id as a private native identity", async () => {
    const result = await runDispatchWithSessionRuntime({
      engine: "claude",
      prompt: "private prompt",
      mode: "cli",
      unit: "resume-failure",
      base: process.cwd(),
      skillNames: [],
      resumeSessionId: CLAUDE_UUID,
      materializeBinding: () => {
        throw new Error(`binding failed for ${CLAUDE_UUID}`);
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain(CLAUDE_UUID);
    expect(result.reason).toContain("[opaque-native-session]");
    expect(JSON.stringify(result)).not.toContain(CLAUDE_UUID);
  });

  test("adapter-start failures redact the materialized wrapper as private prompt authority", async () => {
    const wrapper = "PRIVATE_ROLE_INSTRUCTIONS";
    const result = await runDispatchWithSessionRuntime({
      engine: "claude",
      prompt: "private assigned topic",
      mode: "cli",
      unit: "wrapped-adapter-failure",
      base: process.cwd(),
      skillNames: [],
      materializeBinding: (_binding, options) =>
        ({
          resolved: {} as never,
          spawn: spawnProjection("claude", {
            rendered_prompt: `${wrapper}\n${options.taskText}`,
          }),
        }) as MaterializedAgentBinding,
      sessionAdapter: {
        start() {
          throw new Error(`adapter rejected ${wrapper}`);
        },
        async reconcileHistory() {
          throw new Error("unused");
        },
      },
    });

    expect(result.ok).toBe(false);
    expect(result.reason).not.toContain(wrapper);
    expect(result.reason).toBe("claude session dispatch failed");
  });

  test("dispatch runtime passes the caller-owned abort signal to the session adapter", async () => {
    const caller = new AbortController();
    let observedSignal: AbortSignal | undefined;
    const runtimeOptions = {
      engine: "claude",
      prompt: "cancellable workflow",
      mode: "cli",
      unit: "caller-signal",
      base: process.cwd(),
      skillNames: [],
      signal: caller.signal,
      materializeBinding: (_binding: AgentBinding, options: MaterializeAgentBindingOptions) =>
        ({
          resolved: {} as never,
          spawn: spawnProjection("claude", { rendered_prompt: options.taskText }),
        }) as MaterializedAgentBinding,
      sessionAdapter: {
        start(request) {
          observedSignal = request.signal;
          return completedHandle(request.attemptId, "claude", CLAUDE_UUID);
        },
        async reconcileHistory() {
          throw new Error("unused");
        },
      },
    } as Parameters<typeof runDispatchWithSessionRuntime>[0];

    await runDispatchWithSessionRuntime(runtimeOptions);
    caller.abort("caller cancelled");

    expect(observedSignal).toBe(caller.signal);
    expect(observedSignal?.aborted).toBe(true);
  });

  test("adapter timeout owns and kills the underlying workflow process", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-dispatch-runtime-timeout-"));
    temporaryPaths.push(root);
    initializeGitWorktree(root);
    const child = pendingProcess();
    const result = await runDispatchWithSessionRuntime({
      engine: "claude",
      prompt: "timeout prompt",
      mode: "cli",
      unit: "timeout",
      base: root,
      skillNames: [],
      adapterOptions: { timeoutMs: 10, graceMs: 0 },
      processSpawner: () => child.process,
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/timeout/i);
    expect(child.kills()).toBe(1);
    expect(child.exited()).toBe(true);
  });

  test.each(["claude", "copilot", "antigravity"] as const)(
    "bridge execution for %s writes the canonical prompt to stdin through the owned adapter",
    async (engine) => {
      const root = mkdtempSync(join(tmpdir(), `vf-dispatch-runtime-bridge-${engine}-`));
      temporaryPaths.push(root);
      initializeGitWorktree(root);
      const prompt = `bridge workflow prompt ${engine}`;
      let observedArgv: string[] = [];
      const result = await runDispatchWithSessionRuntime({
        engine,
        prompt,
        mode: "bridge",
        bridgeCommand: "bridge-tool --json",
        unit: `bridge-${engine}`,
        base: root,
        skillNames: [],
        processSpawner: (argv, options) => {
          observedArgv = argv;
          expect(options.cwd).toBe(realpathSync(root));
          expect(options.stdinText).toBe(prompt);
          return completedProcess(['```json\n{"confidence":1}\n```\n']);
        },
      });
      expect(observedArgv).toEqual(
        process.platform === "win32"
          ? ["cmd.exe", "/c", "bridge-tool --json"]
          : ["/bin/sh", "-c", "bridge-tool --json"],
      );
      expect(result.mode).toBe("bridge");
      expect(result.ok).toBe(true);
      expect(result.summary?.confidence).toBe(1);
      expect(
        statSync(join(root, ".vibeflow", "attempts", `${result.attemptId}.json`)).size,
      ).toBeGreaterThan(0);
    },
  );

  test("bridge sends a large Antigravity prompt through stdin without native argv materialization", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-dispatch-runtime-bridge-large-"));
    temporaryPaths.push(root);
    initializeGitWorktree(root);
    const prompt = "large bridge prompt ".repeat(2_048);
    let observedInput = "";
    const result = await runDispatchWithSessionRuntime({
      engine: "antigravity",
      prompt,
      mode: "bridge",
      bridgeCommand: "bridge-tool --json",
      unit: "bridge-large-antigravity",
      base: root,
      skillNames: [],
      processSpawner: (_argv, options) => {
        observedInput = options.stdinText ?? "";
        return completedProcess(['```json\n{"confidence":1}\n```\n']);
      },
    });
    expect(result.ok).toBe(true);
    expect(observedInput).toContain(prompt);
  });

  test("production CLI path materializes the dispatch-runner binding and maps adapter output", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-dispatch-runtime-"));
    temporaryPaths.push(root);
    const { repoRoot, cwd } = initializeLinkedGitWorktree(root);
    let capturedBinding: AgentBinding | undefined;
    let capturedOptions:
      | (MaterializeAgentBindingOptions & { isolation?: SpawnOptionsProjection["isolation"] })
      | undefined;
    let capturedIsolation: SpawnOptionsProjection["isolation"] | undefined;
    let adapterStarts = 0;
    const result = await runDispatchWithSessionRuntime({
      engine: "claude",
      prompt: "ORIGINAL DISPATCH PROMPT",
      mode: "cli",
      unit: "u1",
      base: repoRoot,
      wtPath: cwd,
      skillNames: ["dispatch-runner", "vf"],
      materializeBinding: (binding, options) => {
        capturedBinding = binding;
        capturedOptions = options;
        capturedIsolation = options.isolation;
        return {
          resolved: {
            role: {
              spec: { name: "dispatch-runner" } as never,
              source: "builtin",
              resolved_hash: "role",
              metadata: {},
            },
            skills: [],
            engine: "claude",
            model: "sonnet",
            sessionMode: "fresh",
            tool_intents: ["read", "write"],
            sandbox: "workspace-write",
            env_policy: conversationEnvPolicy("claude"),
            isolation: options.isolation ?? null,
            provenance: { roleSource: "builtin", roleHash: "role", skillHashes: ["vf"] },
            trace_metadata: { role_resolved_hash: "role", skill_resolved_hashes: ["vf"] },
          },
          spawn: spawnProjection("claude", {
            rendered_prompt: `dispatch-wrapper\n${options.taskText}`,
            sandbox: "workspace-write",
            isolation: options.isolation ?? null,
            provenance: { roleSource: "builtin", roleHash: "role", skillHashes: ["vf"] },
            trace_metadata: { role_resolved_hash: "role", skill_resolved_hashes: ["vf"] },
          }),
        } as MaterializedAgentBinding;
      },
      sessionAdapter: {
        start(request) {
          adapterStarts++;
          expect(request.spawn.rendered_prompt).toContain("ORIGINAL DISPATCH PROMPT");
          return completedHandle(request.attemptId, "claude", CLAUDE_UUID);
        },
        reconcileHistory: async () => ({
          status: "unavailable",
          imported_turn_count: 0,
          imported_tool_count: 0,
          completeness_reason: "n/a",
        }),
      },
    });
    expect(adapterStarts).toBe(1);
    expect(capturedBinding).toEqual({
      roleRef: "dispatch-runner",
      engine: "claude",
      sessionMode: "fresh",
      additionalSkillRefs: ["dispatch-runner", "vf"],
    });
    expect(capturedOptions?.repoRoot).toBe(repoRoot);
    expect(capturedOptions?.phase).toBe(2);
    expect(capturedOptions?.taskText).toBe("ORIGINAL DISPATCH PROMPT");
    expect(capturedIsolation && isIsolationLeaseLive(capturedIsolation)).toBe(false);
    expect("sessionId" in result).toBe(false);
    const resumeBinding =
      readDispatchResumeBinding(result) ??
      (() => {
        throw new Error("expected a captured resume binding");
      })();
    const attemptId =
      result.attemptId ??
      (() => {
        throw new Error("expected an attempt id");
      })();
    expect(resumeBinding).toEqual({
      attemptId,
      engine: "claude",
      nativeSessionId: CLAUDE_UUID,
    });
  });

  test("an injected process spawner stays inside the session adapter path and roots evidence at base", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-dispatch-runtime-process-seam-"));
    temporaryPaths.push(root);
    const { repoRoot, cwd } = initializeLinkedGitWorktree(root);
    let processSpawnerCalls = 0;
    const result = await runDispatchWithSessionRuntime({
      engine: "claude",
      prompt: "legacy prompt",
      mode: "cli",
      unit: "u1",
      base: repoRoot,
      wtPath: cwd,
      skillNames: ["vf"],
      materializeBinding: (_binding, options) =>
        ({
          resolved: {
            role: {
              spec: { name: "dispatch-runner" } as never,
              source: "builtin",
              resolved_hash: "role",
              metadata: {},
            },
            skills: [],
            engine: "claude",
            model: "sonnet",
            sessionMode: "fresh",
            tool_intents: ["read", "write"],
            sandbox: "workspace-write",
            env_policy: conversationEnvPolicy("claude"),
            isolation: options.isolation ?? null,
            provenance: { roleSource: "builtin", roleHash: "role", skillHashes: ["vf"] },
            trace_metadata: { role_resolved_hash: "role", skill_resolved_hashes: ["vf"] },
          },
          spawn: spawnProjection("claude", {
            rendered_prompt: options.taskText,
            sandbox: "workspace-write",
            isolation: options.isolation ?? null,
            provenance: { roleSource: "builtin", roleHash: "role", skillHashes: ["vf"] },
            trace_metadata: { role_resolved_hash: "role", skill_resolved_hashes: ["vf"] },
          }),
        }) as MaterializedAgentBinding,
      processSpawner: (_argv, options) => {
        processSpawnerCalls++;
        expect(options.cwd).toBe(realpathSync(cwd));
        return completedProcess([JSON.stringify({ type: "result", session_id: CLAUDE_UUID })]);
      },
    });
    expect(processSpawnerCalls).toBe(1);
    expect(result.ok).toBe(true);
    expect(
      statSync(join(repoRoot, ".vibeflow", "attempts", `${result.attemptId}.json`)).size,
    ).toBeGreaterThan(0);
    expect(readDispatchResumeBinding(result)?.nativeSessionId).toBe(CLAUDE_UUID);
  });

  test("adapter path accepts a process-spawn seam without falling back to the legacy dispatcher", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-dispatch-runtime-process-"));
    temporaryPaths.push(root);
    const { repoRoot, cwd } = initializeLinkedGitWorktree(root);
    const legacySpawnerCalls = 0;
    let processSpawns = 0;
    const result = await runDispatchWithSessionRuntime({
      engine: "claude",
      prompt: "adapter prompt",
      mode: "cli",
      unit: "u1",
      base: repoRoot,
      wtPath: cwd,
      skillNames: ["vf"],
      materializeBinding: (_binding, options) =>
        ({
          resolved: {
            role: {
              spec: { name: "dispatch-runner" } as never,
              source: "builtin",
              resolved_hash: "role",
              metadata: {},
            },
            skills: [],
            engine: "claude",
            model: "sonnet",
            sessionMode: "fresh",
            tool_intents: ["read", "write"],
            sandbox: "workspace-write",
            env_policy: conversationEnvPolicy("claude"),
            isolation: options.isolation ?? null,
            provenance: { roleSource: "builtin", roleHash: "role", skillHashes: ["vf"] },
            trace_metadata: { role_resolved_hash: "role", skill_resolved_hashes: ["vf"] },
          },
          spawn: spawnProjection("claude", {
            rendered_prompt: options.taskText,
            sandbox: "workspace-write",
            isolation: options.isolation ?? null,
            provenance: { roleSource: "builtin", roleHash: "role", skillHashes: ["vf"] },
            trace_metadata: { role_resolved_hash: "role", skill_resolved_hashes: ["vf"] },
          }),
        }) as MaterializedAgentBinding,
      processSpawner: (argv, options) => {
        processSpawns++;
        expect(argv[0]).toBe("claude");
        expect(options.cwd).toBe(realpathSync(cwd));
        expect(options.stdinText).toContain("adapter prompt");
        return completedProcess([JSON.stringify({ type: "result", session_id: CLAUDE_UUID })]);
      },
    });
    expect(processSpawns).toBe(1);
    expect(legacySpawnerCalls).toBe(0);
    expect(result.ok).toBe(true);
    expect(
      statSync(join(repoRoot, ".vibeflow", "attempts", `${result.attemptId}.json`)).size,
    ).toBeGreaterThan(0);
  });

  test("binding admission failures fail closed without exposing a structural session id", async () => {
    const result = await runDispatchWithSessionRuntime({
      engine: "claude",
      prompt: "sensitive prompt",
      mode: "cli",
      unit: "u1",
      base: process.cwd(),
      skillNames: ["repo-skill"],
      materializeBinding: () => {
        throw new Error("project role requires a live canonical isolation lease");
      },
    });
    expect(result.ok).toBe(false);
    expect(result.reason).toMatch(/live canonical isolation lease/i);
    expect("sessionId" in result).toBe(false);
    expect(readDispatchResumeBinding(result)).toBeUndefined();
  });
});
