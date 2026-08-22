import { describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, unlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseAgentRoleStrict } from "../src/agents/role-loader.js";
import { ask, captureSpawnAsync, streamSpawnAsync } from "../src/commands/ask.js";
import { brainstorm } from "../src/commands/brainstorm.js";
import { chat } from "../src/commands/chat.js";
import {
  CONVERSATION_EXIT,
  classifyConversationResult,
  parseMaxRounds,
  productionLibraries,
} from "../src/commands/conversation-args.js";
import { executeConversationWorkflow } from "../src/commands/conversation-workflow.js";
import { runDispatchWithSessionRuntime } from "../src/commands/dispatch-session-runtime.js";
import type { WorkUnit, WorkflowState } from "../src/core.js";
import {
  createAttemptHandle,
  createProcessTerminator,
  reserveAttemptEvidence,
} from "../src/dispatch/attempt-handle.js";
import { conversationEnvPolicy } from "../src/dispatch/env-filter.js";
import {
  createDockerRuntimeInspector,
  createIsolationLease,
  releaseIsolationLease,
} from "../src/dispatch/isolation.js";
import {
  loadNativeHistory,
  parseSessionId,
  reconcileNativeHistory,
} from "../src/dispatch/prompt.js";
import {
  persistPublicDispatchEvidence,
  registerDispatchResumeBinding,
  requireSafeEngineSessionId,
} from "../src/dispatch/public-redaction.js";
import {
  assertSelectedConversationEngine,
  assertSpawnProjection,
  sessionInvocation,
} from "../src/dispatch/session-argv.js";
import { createSpawnOptionsProjection } from "../src/dispatch/session-types.js";
import type { EngineProcess, SpawnOptionsProjection } from "../src/dispatch/session-types.js";
import { createEngineSessionAdapter } from "../src/dispatch/session.js";
import {
  debateBlindEvaluatorPrompt,
  debateFullEvaluatorPrompt,
  debateParticipantPrompt,
  parseDebateEvaluatorOutput,
  parseDebateParticipantOutput,
  reviewDebatePrompt,
  unitDebatePrompt,
} from "../src/orchestrator/debate.js";
import { maybePublishPrs, publishReviewedUnits } from "../src/orchestrator/publish-unit.js";

const quiet = async <T>(run: () => Promise<T>): Promise<T> => {
  const write = process.stdout.write;
  process.stdout.write = (() => true) as typeof process.stdout.write;
  try {
    return await run();
  } finally {
    process.stdout.write = write;
  }
};

const unit = (name: string, dependsOn?: string[]): WorkUnit => ({
  name,
  status: "pending",
  confidence: 0,
  riskClass: "feature",
  scope: [`src/${name}.ts`],
  ...(dependsOn ? { depends_on: dependsOn } : {}),
  gates: { build: "pending", lint: "pending", test: "pending", review: "pending" },
  resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  evidence: [],
});

const workflow = (workUnits: WorkUnit[]): WorkflowState => ({
  task_id: "coverage-final",
  goal: "cover the production wave dispatcher",
  success_criteria: [],
  work_units: workUnits,
  totals: { units: workUnits.length, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
});

const spawnProjection = (
  engine: SpawnOptionsProjection["engine"],
  sandbox: SpawnOptionsProjection["sandbox"] = "read-only",
  overrides: Partial<Parameters<typeof createSpawnOptionsProjection>[0]> = {},
): SpawnOptionsProjection =>
  createSpawnOptionsProjection({
    engine,
    model: null,
    sessionMode: "fresh",
    rendered_prompt: `prompt-${engine}`,
    rendered_tools: engine === "codex" ? [] : ["Read"],
    sandbox,
    env_policy: conversationEnvPolicy(engine),
    isolation: null,
    provenance: { roleSource: "builtin", roleHash: `role-${engine}`, skillHashes: [] },
    trace_metadata: { role_resolved_hash: `role-${engine}`, skill_resolved_hashes: [] },
    ...overrides,
  });

const byteStream = (content = ""): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start(controller) {
      if (content) controller.enqueue(new TextEncoder().encode(content));
      controller.close();
    },
  });

describe("final command and compatibility coverage", () => {
  test("runs the production workflow dispatcher in dependency waves", async () => {
    const state = workflow([unit("parent"), unit("child", ["parent"])]);
    const dispatched: WorkUnit[] = [];
    const result = await executeConversationWorkflow(
      process.cwd(),
      { bindings: [{ engine: "codex" }], signal: new AbortController().signal } as never,
      {
        readState: () => structuredClone(state),
        writeState: () => undefined,
        recomputeTotals: (next) => next,
        defaultContext: () => ({ repoRoot: process.cwd() }) as never,
        readSettings: () => ({}) as never,
        makeDispatcher: () => async (candidate) => {
          dispatched.push(structuredClone(candidate));
          return {
            status: "done",
            confidence: 1,
            evidence: [`${candidate.name}.txt:1`],
            gates: { build: "pass", lint: "pass", test: "pass" },
          };
        },
        makeReviewer: () => async () => ({ pass: true, reason: "covered" }),
      },
    );

    expect(result.units.map(({ name }) => name)).toEqual(["parent", "child"]);
    expect(dispatched[1]?.upstreamHandoffs?.[0]?.unit).toBe("parent");
  });

  test("covers plain-text chat validation and failure output", async () => {
    await quiet(async () => {
      expect(await chat(["--wat"])).toBe(CONVERSATION_EXIT.validation);
      expect(await chat([])).toBe(CONVERSATION_EXIT.validation);
      expect(await chat(["--json", "--wat"])).toBe(CONVERSATION_EXIT.validation);
      expect(await chat(["--json"])).toBe(CONVERSATION_EXIT.validation);
      expect(
        await chat(["topic"], {
          createService: () => {
            throw new Error("transport unavailable");
          },
        }),
      ).toBe(CONVERSATION_EXIT.failed);
    });
  });

  test("covers brainstorm validation, dry-run gates, and aborted resume", async () => {
    await quiet(async () => {
      expect(await brainstorm(["--wat"])).toBe(CONVERSATION_EXIT.validation);
      expect(await brainstorm([])).toBe(CONVERSATION_EXIT.validation);

      const participant = {
        participant_id: "participant-1",
        role_ref: "brainstorm-participant",
        engine: "codex",
        model: null,
        engine_available: true,
        model_valid: true,
      };
      expect(
        await brainstorm(["topic"], {
          createService: () =>
            ({
              dryRun: async () => ({
                participants: [participant],
                evaluator_auto_added: false,
                engines_available: ["codex"],
                models_valid: true,
              }),
            }) as never,
        }),
      ).toBe(CONVERSATION_EXIT.validation);
      expect(
        await brainstorm(["topic"], {
          createService: () =>
            ({
              dryRun: async () => ({
                participants: [participant, { ...participant, participant_id: "participant-2" }],
                evaluator_auto_added: false,
                engines_available: ["codex"],
                models_valid: true,
              }),
            }) as never,
        }),
      ).toBe(CONVERSATION_EXIT.transport);

      let snapshots = 0;
      expect(
        await brainstorm(["--resume", "conversation-1", "continue"], {
          createService: () =>
            ({
              snapshot: async () => {
                snapshots += 1;
                return snapshots === 1
                  ? { lifecycle: "RUNNING", last_seq: 0 }
                  : { lifecycle: "ABORTED", last_seq: 0 };
              },
              message: async () => ({ message_id: "message-1", accepted: true }),
              subscribe: () => () => undefined,
            }) as never,
        }),
      ).toBe(CONVERSATION_EXIT.aborted);

      let jsonSnapshots = 0;
      expect(
        await brainstorm(["--json", "--resume", "conversation-2", "continue"], {
          createService: () =>
            ({
              snapshot: async () => {
                jsonSnapshots += 1;
                return jsonSnapshots === 1
                  ? { lifecycle: "RUNNING", last_seq: 0 }
                  : {
                      lifecycle: "ABORTED",
                      last_seq: 0,
                      participants: [],
                      rounds: [],
                      consensus_score: null,
                    };
              },
              message: async () => ({ message_id: "message-2", accepted: true }),
              subscribe: () => () => undefined,
              events: async () => [],
            }) as never,
        }),
      ).toBe(CONVERSATION_EXIT.aborted);

      expect(
        await brainstorm(["--json", "--yes", "invalid terminal"], {
          createService: () =>
            ({
              dryRun: async () => ({
                participants: [
                  participant,
                  { ...participant, participant_id: "participant-2" },
                  {
                    ...participant,
                    participant_id: "evaluator",
                    role_ref: "brainstorm-evaluator",
                  },
                ],
                evaluator_auto_added: true,
                engines_available: ["codex"],
                models_valid: true,
              }),
              start: async () => ({
                conversation_id: "conversation-invalid-terminal",
                revision_id: "revision-invalid-terminal",
                operation_id: "operation-invalid-terminal",
                completion: Promise.resolve({
                  conversation_id: "conversation-invalid-terminal",
                  revision_id: "revision-invalid-terminal",
                  result: {
                    operation_id: "operation-invalid-terminal",
                    status: "unexpected",
                    artifact_refs: [],
                  },
                }),
              }),
              subscribe: () => () => undefined,
              snapshot: async () => ({ participants: [], rounds: [] }),
              events: async () => [],
            }) as never,
        }),
      ).toBe(CONVERSATION_EXIT.transport);
    });
  });

  test("covers command helper terminal branches", async () => {
    expect(parseMaxRounds("7")).toBe(7);
    expect(
      classifyConversationResult("failed", [
        { seq: 1, event: { type: "error", payload: { code: "transport_reset" } } },
      ] as never),
    ).toBe(CONVERSATION_EXIT.transport);
    expect(
      classifyConversationResult("failed", [
        { seq: 1, event: { type: "round_boundary", payload: {} } },
      ] as never),
    ).toBe(CONVERSATION_EXIT.failed);
    expect(await productionLibraries(process.cwd()).orchestrate.dryRun({} as never)).toEqual({
      participants: [],
      evaluator_auto_added: false,
      engines_available: [],
      models_valid: true,
    });
  });

  test("fails a bridge dispatch before constructing runtime authority", async () => {
    const prior = process.env.VIBEFLOW_AI;
    Reflect.deleteProperty(process.env, "VIBEFLOW_AI");
    try {
      const result = await runDispatchWithSessionRuntime({
        engine: "codex",
        prompt: "private prompt",
        mode: "bridge",
        unit: "coverage-final",
        base: process.cwd(),
        skillNames: [],
      });
      expect(result.ok).toBe(false);
      expect(result.reason).toBe("VIBEFLOW_AI is not set");
    } finally {
      if (prior === undefined) Reflect.deleteProperty(process.env, "VIBEFLOW_AI");
      else process.env.VIBEFLOW_AI = prior;
    }
  });

  test("routes an ask through an existing conversation", async () => {
    let snapshots = 0;
    const result = await quiet(() =>
      ask(
        ["fixture.ts:1", "why"],
        { conversation: "conversation-1" },
        {
          readiness: () =>
            [
              {
                engine: "claude",
                level: "ready",
                detail: "claude: ready",
                checkedAt: "now",
              },
            ] as never,
          readText: () => "const covered = true;",
          createService: () =>
            ({
              snapshot: async () => {
                snapshots += 1;
                return snapshots === 1
                  ? { lifecycle: "RUNNING", last_seq: 0 }
                  : { lifecycle: "COMPLETED", last_seq: 0 };
              },
              message: async () => ({ message_id: "message-1", accepted: true }),
              subscribe: (_id: string, listener: (event: unknown) => void) => {
                listener({
                  seq: 1,
                  event: {
                    type: "agent_response_delta",
                    payload: { content_delta: "covered" },
                  },
                });
                return () => undefined;
              },
            }) as never,
        },
      ),
    );
    expect(result).toBe(CONVERSATION_EXIT.ok);
  });

  test("covers strict role, spawn authority, and legacy debate prompts", () => {
    expect(() => parseAgentRoleStrict("---\nname: broken\n---\n")).toThrow();
    expect(() =>
      createSpawnOptionsProjection({
        engine: "codex",
        model: null,
        sessionMode: "fresh",
        rendered_prompt: "prompt",
        rendered_tools: [],
        sandbox: "read-only",
        env_policy: {} as never,
        isolation: null,
        provenance: { roleSource: "builtin", roleHash: "hash", skillHashes: [] },
        trace_metadata: { role_resolved_hash: "hash", skill_resolved_hashes: [] },
      }),
    ).toThrow("canonical conversation authority");
    expect(parseDebateParticipantOutput("{not-json").claim).toBe("{not-json");
    expect(parseDebateParticipantOutput('{"answer":"no claim"}').claim).toBe(
      '{"answer":"no claim"}',
    );
    expect(
      parseDebateParticipantOutput(
        '{"answer":"answer","content":"content","claim":"claim","evidence":["a","a"]}',
      ),
    ).toEqual({ answer: "answer", content: "content", claim: "claim", evidence: ["a"] });
    const assessment = {
      agreement: { value: true, evidence: "a" },
      conflict_resolution: { value: true, evidence: "b" },
      evidence_quality: { value: true, evidence: "c" },
      convergence: { value: true, evidence: "d" },
    };
    expect(parseDebateEvaluatorOutput(JSON.stringify(assessment), 1, 2)).toEqual(assessment);
    expect(
      debateParticipantPrompt("topic", 2, [{ claim: "claim", evidence: ["proof"] }]),
    ).toContain('"round":2');
    expect(debateBlindEvaluatorPrompt([{ answer: "answer", evidence: ["proof"] }])).toContain(
      "immutable precommits",
    );
    expect(
      debateFullEvaluatorPrompt(assessment, [{ claim: "claim", evidence: ["proof"] }]),
    ).toContain("option-1");
    expect(unitDebatePrompt({ ...unit("legacy"), spec: "spec", evidence: ["proof"] })).toContain(
      "### Current Evidence",
    );
    expect(reviewDebatePrompt("title", "description", "diff")).toContain("```diff");
  });

  test("publishes only eligible reviewed units and reports both outcomes", () => {
    const reports: string[] = [];
    publishReviewedUnits({
      units: [
        { name: "failed-review", scope: ["src/a.ts"], reviewPassed: false },
        { name: "empty", scope: [], reviewPassed: true },
        { name: "published", scope: ["src/b.ts"], reviewPassed: true },
        { name: "rejected", scope: ["src/c.ts"], reviewPassed: true },
      ],
      base: "main",
      worktreePath: (name) => `/tmp/${name}`,
      git: (args, cwd) =>
        cwd.endsWith("rejected") && args[0] === "push"
          ? { status: 1, stdout: "rejected" }
          : { status: 0, stdout: "" },
      gh: () => ({ status: 0, stdout: "https://example.test/pr/1" }),
      report: (line) => reports.push(line),
    });
    expect(reports).toHaveLength(2);
    expect(reports[0]).toContain("PR queued");
    expect(reports[1]).toContain("not published");

    maybePublishPrs({
      prRequested: false,
      isolated: false,
      units: [],
      base: "main",
      worktreePath: () => "/tmp/unused",
      git: () => ({ status: 0, stdout: "" }),
      gh: () => ({ status: 0, stdout: "" }),
      report: (line) => reports.push(line),
    });
    maybePublishPrs({
      prRequested: true,
      isolated: false,
      units: [],
      base: "main",
      worktreePath: () => "/tmp/unused",
      git: () => ({ status: 0, stdout: "" }),
      gh: () => ({ status: 0, stdout: "" }),
      report: (line) => reports.push(line),
    });
    maybePublishPrs({
      prRequested: true,
      isolated: true,
      units: [],
      base: "main",
      worktreePath: () => "/tmp/unused",
      git: () => ({ status: 0, stdout: "" }),
      gh: () => ({ status: 0, stdout: "" }),
      report: (line) => reports.push(line),
    });
    expect(reports.at(-1)).toContain("--pr requires --isolate");
  });

  test("covers injected async ask spawners", async () => {
    const invocation = { cmd: "claude", args: ["-p"], promptMode: "stdin" as const };
    expect(
      await captureSpawnAsync(invocation, "prompt", async (_cmd, _args, stdin) => ({
        status: 0,
        stdout: stdin,
        stderr: "",
      })),
    ).toEqual({ code: 0, text: "prompt" });
    expect(
      await streamSpawnAsync(
        invocation,
        "prompt",
        () => undefined,
        async () => ({
          status: 1,
          stdout: "",
          stderr: "failure",
        }),
      ),
    ).toEqual({ code: 1, text: "failure" });
  });

  test("covers attempt reservation cleanup and rejected completion", async () => {
    const killed: NodeJS.Signals[] = [];
    const processHandle = {
      pid: 2_147_483_647,
      stdin: { write: () => undefined, end: () => undefined },
      stdout: byteStream(),
      stderr: byteStream(),
      exited: Promise.resolve(0),
      kill: (signal: NodeJS.Signals) => {
        killed.push(signal);
        throw new Error("already exited");
      },
    } as EngineProcess;
    createProcessTerminator({
      process: processHandle,
      killProcessGroup: true,
      graceMs: 0,
      onReason: () => undefined,
    }).kill("SIGTERM");
    expect(killed).toEqual(["SIGTERM"]);

    const root = mkdtempSync(join(tmpdir(), "vf-attempt-final-"));
    try {
      const first = reserveAttemptEvidence(root, "duplicate");
      expect(() => reserveAttemptEvidence(root, "duplicate")).toThrow("already exists");
      first.finalize({ ok: true });

      const poisonPath = join(root, "poison.json");
      const poisonAttemptId = {
        [Symbol.toPrimitive]: () => "poison",
        toJSON: () => {
          unlinkSync(poisonPath);
          throw new Error("attempt serialization failed");
        },
      };
      expect(() => reserveAttemptEvidence(root, poisonAttemptId as unknown as string)).toThrow(
        "attempt serialization failed",
      );

      const failing = reserveAttemptEvidence(root, "finalize-failure");
      expect(() => failing.finalize({ impossible: 1n })).toThrow();
      failing.finalize({ recovered: true });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }

    const completion = Promise.reject(new Error("completion rejected"));
    const handle = createAttemptHandle({
      attemptId: "rejected",
      completion,
      signal: new AbortController().signal,
      terminate: () => undefined,
      readResumeBinding: () => undefined,
      readEvidenceBinding: () => undefined,
    });
    await expect(handle.completion).rejects.toThrow("completion rejected");
    await Promise.resolve();
  });

  test("covers deterministic container isolation validation and release failures", async () => {
    expect(() =>
      createIsolationLease({
        kind: "worktree",
        root: process.cwd(),
        cwd: process.cwd(),
        repoRoot: join(process.cwd(), "src"),
        evidence_ref: "primary-mismatch",
      }),
    ).toThrow("authority is unavailable");
    expect(() =>
      createIsolationLease({
        kind: "container",
        root: "relative",
        cwd: "/workspace",
        repoRoot: process.cwd(),
        containerId: "container",
        runtimeInspector: {} as never,
        evidence_ref: "relative-container",
      }),
    ).toThrow("absolute container path");
    expect(() =>
      createIsolationLease({
        kind: "container",
        root: "/workspace",
        cwd: "/workspace",
        repoRoot: process.cwd(),
        containerId: "container",
        runtimeInspector: { inspect: () => ({ id: "container", running: true, mounts: [] }) },
        evidence_ref: "untrusted-inspector",
      }),
    ).toThrow("trusted container runtime authority");

    const stopped = createDockerRuntimeInspector({
      run: () => ({ Id: "container", State: { Running: false }, Mounts: [] }),
    });
    expect(() =>
      createIsolationLease({
        kind: "container",
        root: "/workspace",
        cwd: "/workspace",
        repoRoot: process.cwd(),
        containerId: "container",
        runtimeInspector: stopped,
        evidence_ref: "stopped-container",
      }),
    ).toThrow("not live");

    const badMount = createDockerRuntimeInspector({
      run: () => ({
        Id: "container",
        State: { Running: true },
        Mounts: [{ Source: "/definitely/missing", Destination: "/workspace" }],
      }),
    });
    expect(() =>
      createIsolationLease({
        kind: "container",
        root: "/workspace",
        cwd: "/workspace",
        repoRoot: process.cwd(),
        containerId: "container",
        runtimeInspector: badMount,
        evidence_ref: "bad-mount",
      }),
    ).toThrow("lacks an associated");

    const malformed = createDockerRuntimeInspector({
      run: () => ({
        Id: "container",
        State: { Running: true },
        Mounts: [{ Source: 1, Destination: 2 }],
      }),
    });
    expect(malformed.inspect("container").mounts).toEqual([]);
    expect(() => malformed.inspect("bad/id")).toThrow("invalid container identity");

    const invalidDestination = createDockerRuntimeInspector({
      run: () => ({
        Id: "container",
        State: { Running: true },
        Mounts: [{ Source: process.cwd(), Destination: "relative" }],
      }),
    });
    expect(() => invalidDestination.inspect("container")).toThrow("absolute container path");

    const live = createDockerRuntimeInspector({
      run: () => ({
        Id: "container",
        State: { Running: true },
        Mounts: [{ Source: process.cwd(), Destination: "/workspace" }],
      }),
    });
    const lease = createIsolationLease({
      kind: "container",
      root: "/workspace",
      cwd: "/workspace",
      repoRoot: process.cwd(),
      containerId: "container",
      runtimeInspector: live,
      evidence_ref: "release-failure",
      release: () => {
        throw new Error("release failed");
      },
    });
    await expect(releaseIsolationLease(lease)).rejects.toThrow("release failed");

    let containerIdReads = 0;
    expect(() =>
      createIsolationLease({
        kind: "container",
        root: "/workspace",
        cwd: "/workspace",
        repoRoot: process.cwd(),
        get containerId() {
          containerIdReads += 1;
          return containerIdReads < 3 ? "container" : undefined;
        },
        runtimeInspector: live,
        evidence_ref: "volatile-container-id",
      }),
    ).toThrow("trusted container runtime authority");
  });

  test("rejects mismatched and unregistered linked worktree authority", () => {
    const root = mkdtempSync(join(tmpdir(), "vf-isolation-git-final-"));
    const primaryA = join(root, "primary-a");
    const primaryB = join(root, "primary-b");
    const registeredA = join(root, "registered-a");
    const worktreeB = join(root, "worktree-b");
    const unregisteredA = join(root, "unregistered-a");
    const git = (cwd: string, args: string[]) =>
      execFileSync("git", ["-C", cwd, ...args], { stdio: "ignore" });
    try {
      execFileSync("git", ["init", "--quiet", primaryA], { stdio: "ignore" });
      execFileSync("git", ["init", "--quiet", primaryB], { stdio: "ignore" });
      for (const primary of [primaryA, primaryB]) {
        git(primary, [
          "-c",
          "user.name=VibeFlow Coverage",
          "-c",
          "user.email=coverage@example.test",
          "commit",
          "--quiet",
          "--allow-empty",
          "-m",
          "fixture",
        ]);
      }
      git(primaryA, ["worktree", "add", "--quiet", "--detach", registeredA]);
      git(primaryB, ["worktree", "add", "--quiet", "--detach", worktreeB]);
      expect(() =>
        createIsolationLease({
          kind: "worktree",
          root: worktreeB,
          cwd: worktreeB,
          repoRoot: primaryA,
          evidence_ref: "common-mismatch",
        }),
      ).toThrow("authority is unavailable");

      mkdirSync(unregisteredA);
      writeFileSync(join(unregisteredA, ".git"), readFileSync(join(registeredA, ".git"), "utf8"));
      expect(() =>
        createIsolationLease({
          kind: "worktree",
          root: unregisteredA,
          cwd: unregisteredA,
          repoRoot: primaryA,
          evidence_ref: "unregistered-worktree",
        }),
      ).toThrow("authority is unavailable");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("uses the production Docker argument-array runner", () => {
    expect(() => createDockerRuntimeInspector().inspect("a".repeat(128))).toThrow();
  });

  test("covers native-history parse failures and non-object reconciliation", () => {
    expect(parseSessionId("{broken-json}")).toBeUndefined();
    expect(
      loadNativeHistory({ engine: "claude", nativeSessionId: "vf-coverage-absent" }),
    ).toBeUndefined();
    expect(
      loadNativeHistory({ engine: "claude", nativeSessionId: "vf-coverage-missing" }, [
        "/definitely/missing/vf-history",
      ]),
    ).toBeUndefined();

    const root = mkdtempSync(join(tmpdir(), "vf-history-final-"));
    try {
      mkdirSync(join(root, "a"));
      mkdirSync(join(root, "b"));
      writeFileSync(join(root, "vf-history.jsonl"), '{"type":"assistant"}\n{broken}\n');
      expect(
        loadNativeHistory({ engine: "claude", nativeSessionId: "vf-history" }, [root]),
      ).toEqual({ records: [{ type: "assistant" }], complete: false });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
    expect(
      reconcileNativeHistory({
        engine: "claude",
        nativeSessionId: "native-id",
        history: [null],
      }).status,
    ).toBe("partial");
  });

  test("covers danger-full-access argv projections for admitted engines", () => {
    expect(sessionInvocation(spawnProjection("claude", "danger-full-access")).args).toContain(
      "--dangerously-skip-permissions",
    );
    expect(sessionInvocation(spawnProjection("codex", "danger-full-access")).args).toContain(
      "danger-full-access",
    );
    expect(sessionInvocation(spawnProjection("copilot", "danger-full-access")).args).toContain(
      "--allow-all",
    );
    expect(sessionInvocation(spawnProjection("claude", "workspace-write")).args).toContain(
      "acceptEdits",
    );
    expect(sessionInvocation(spawnProjection("codex", "workspace-write")).args).toContain(
      "workspace-write",
    );
  });

  test("fails closed for forged and incoherent spawn projections", () => {
    const canonical = spawnProjection("claude");
    expect(() => assertSpawnProjection({ ...canonical })).toThrow("canonical spawn authority");
    expect(() =>
      assertSpawnProjection(
        spawnProjection("claude", "read-only", {
          provenance: { roleSource: "builtin", roleHash: "", skillHashes: [] },
          trace_metadata: { role_resolved_hash: "", skill_resolved_hashes: [] },
        }),
      ),
    ).toThrow("provenance is incomplete");
    expect(() =>
      assertSpawnProjection(
        spawnProjection("claude", "read-only", {
          provenance: { roleSource: "builtin", roleHash: "role-a", skillHashes: [] },
          trace_metadata: { role_resolved_hash: "role-b", skill_resolved_hashes: [] },
        }),
      ),
    ).toThrow("role provenance");
    expect(() =>
      assertSpawnProjection(
        spawnProjection("claude", "read-only", {
          provenance: { roleSource: "builtin", roleHash: "role", skillHashes: ["skill-a"] },
          trace_metadata: {
            role_resolved_hash: "role",
            skill_resolved_hashes: ["skill-b"],
          },
        }),
      ),
    ).toThrow("skill provenance");
    expect(() =>
      assertSelectedConversationEngine({
        engine: "claude",
        env_policy: { selectedEngine: "codex" },
      }),
    ).toThrow("must select the launched conversation engine");
  });

  test("covers terminal callback failure downgrade in the session adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-session-final-"));
    try {
      const adapter = createEngineSessionAdapter({
        protocol: "bridge",
        evidenceRoot: root,
        graceMs: 0,
        spawn: () =>
          ({
            pid: 424_242,
            stdin: { write: () => undefined, end: () => undefined },
            stdout: byteStream(),
            stderr: byteStream(),
            exited: Promise.resolve(0),
            kill: () => undefined,
          }) as EngineProcess,
      });
      const result = await adapter.start({
        attemptId: "terminal-callback",
        spawn: spawnProjection("claude"),
        signal: new AbortController().signal,
        onLifecycle: (state) => {
          if (state === "completed") throw new Error("terminal observer failed");
        },
      }).completion;
      expect(result.state).toBe("ambiguous");
      expect(result.reason).toContain("terminal observer failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("rejects an unsafe adapter attempt identity before reservation", () => {
    const adapter = createEngineSessionAdapter();
    expect(() =>
      adapter.start({
        attemptId: "bad/id",
        spawn: spawnProjection("claude"),
        signal: new AbortController().signal,
      }),
    ).toThrow("safe opaque identifier");
  });

  test("contains thrown public chunk callbacks inside the session adapter", async () => {
    const root = mkdtempSync(join(tmpdir(), "vf-session-chunk-final-"));
    try {
      const adapter = createEngineSessionAdapter({
        protocol: "bridge",
        evidenceRoot: root,
        graceMs: 0,
        spawn: () =>
          ({
            pid: 424_243,
            stdin: { write: () => undefined, end: () => undefined },
            stdout: byteStream("public output\n"),
            stderr: byteStream(),
            exited: Promise.resolve(0),
            kill: () => undefined,
          }) as EngineProcess,
      });
      const result = await adapter.start({
        attemptId: "chunk-callback",
        spawn: spawnProjection("claude"),
        signal: new AbortController().signal,
        onChunk: () => {
          throw new Error("chunk observer failed");
        },
      }).completion;
      expect(result.state).toBe("ambiguous");
      expect(result.reason).toContain("chunk observer failed");
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("covers public resume and evidence fail-closed guards", () => {
    expect(() => requireSafeEngineSessionId(undefined, "bad/id")).toThrow("invalid engine");
    const result = {
      attemptId: "attempt-a",
      engine: "claude" as const,
      mode: "cli" as const,
      ok: true,
      raw: "",
    };
    expect(() =>
      registerDispatchResumeBinding(result, {
        attemptId: "attempt-b",
        engine: "claude",
        nativeSessionId: "123e4567-e89b-42d3-a456-426614174000",
      }),
    ).toThrow("must match");
    expect(() => persistPublicDispatchEvidence("/tmp", { ...result, attemptId: "bad/id" })).toThrow(
      "safe opaque identifier",
    );
  });
});
