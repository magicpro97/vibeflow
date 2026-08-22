import { describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { MaterializedAgentBinding } from "../src/agents/binding.js";
import { previewAgentBinding } from "../src/agents/binding.js";
import { conversationEnvPolicy } from "../src/dispatch/env-filter.js";
import {
  type EngineProcess,
  type EngineProcessSpawnOptions,
  createSpawnOptionsProjection,
} from "../src/dispatch/session-types.js";
import { createConversationBootstrap } from "../src/orchestrator/conversation/bootstrap.js";
import type {
  ConversationBootstrap,
  ConversationBootstrapOptions,
} from "../src/orchestrator/conversation/bootstrap.js";
import type { ConversationContext } from "../src/orchestrator/conversation/types.js";
import {
  cleanupMarker,
  createMarker,
  listMarkers,
  updateMarker,
} from "../src/orchestrator/marker.js";
import type { PublicStoredTraceEvent, PublicTraceEvent } from "../src/orchestrator/trace/types.js";
import {
  ConversationSessionAuthority,
  ConversationStreamTokenAuthority,
} from "../src/server/conversation-auth.js";
import {
  type ConversationHttpAuthority,
  handleConversationRoute,
} from "../src/server/conversation-route.js";
import { type PolicyVerifyReport, VERIFY_GATE_ORDER } from "../src/verify/core.js";

const NATIVE_SESSION_ID = "019f278f-d7ff-77d3-9c44-7459bbf08d19";
const PRIVATE_PROMPT = "private acceptance prompt: do not project";
const PRIVATE_TOOL_INPUT = "artifact://private/tool-input";
const PRIVATE_TOOL_OUTPUT = "artifact://private/tool-output";
const OPAQUE_ARTIFACT = /^artifact_[A-Za-z0-9_-]{43}$/;
const ALL_TRUE = {
  agreement: { value: true, evidence: "the proposals agree" },
  conflict_resolution: { value: true, evidence: "risks are resolved" },
  evidence_quality: { value: true, evidence: "evidence is sufficient" },
  convergence: { value: true, evidence: "the round converged" },
};

function completedProcess(stdout: string): EngineProcess {
  const bytes = new TextEncoder().encode(`${stdout}\n`);
  return {
    stdin: null,
    stdout: new ReadableStream({
      start(controller) {
        controller.enqueue(bytes);
        controller.close();
      },
    }),
    stderr: null,
    exited: Promise.resolve(0),
    kill: () => undefined,
  };
}

function materialized(roleName: string, prompt = PRIVATE_PROMPT): MaterializedAgentBinding {
  const roleHash = "a".repeat(64);
  const skillHash = "b".repeat(64);
  const envPolicy = conversationEnvPolicy("claude");
  const skills = [
    {
      ref: "runtime-portable-process-fixtures",
      source: "builtin" as const,
      version: "1.0.0",
      resolved_hash: skillHash,
      resolved_body: "Use deterministic process fixtures.",
      dependency_hashes: [],
    },
  ];
  const provenance = { roleSource: "builtin" as const, roleHash, skillHashes: [skillHash] };
  const traceMetadata = {
    role_resolved_hash: roleHash,
    skill_resolved_hashes: [skillHash],
  };
  const resolved = {
    role: {
      source: "builtin" as const,
      resolved_hash: roleHash,
      metadata: {},
      spec: {
        name: roleName,
        description: "Hermetic acceptance role",
        body: "Exercise only the injected process seam.",
        tools: ["read" as const],
        model: "sonnet" as const,
        sandbox: "read-only" as const,
      },
    },
    skills,
    engine: "claude" as const,
    model: "sonnet",
    sessionMode: "fresh" as const,
    tool_intents: ["read" as const],
    sandbox: "read-only" as const,
    env_policy: envPolicy,
    isolation: null,
    provenance,
    trace_metadata: traceMetadata,
  };
  return {
    resolved,
    spawn: createSpawnOptionsProjection({
      engine: "claude",
      model: "sonnet",
      sessionMode: "fresh",
      rendered_prompt: prompt,
      rendered_tools: ["Read"],
      sandbox: "read-only",
      env_policy: envPolicy,
      isolation: null,
      provenance,
      trace_metadata: traceMetadata,
    }),
  };
}

function bindingFactory() {
  return {
    materialize(input: { roleRef: string }) {
      return materialized(input.roleRef);
    },
    preview: previewAgentBinding,
  } as ConversationBootstrapOptions["bindingFactory"];
}

function passingVerifyReport(): PolicyVerifyReport {
  return Object.fromEntries(
    VERIFY_GATE_ORDER.map((name) => [
      name,
      { status: "pass", details: `${name} passed`, evidence_refs: [`evidence:${name}`] },
    ]),
  ) as PolicyVerifyReport;
}

function libraries(
  planCreate: (context: ConversationContext) => Promise<{ content: string }>,
): ConversationBootstrapOptions["libraries"] {
  return {
    plan: { create: ({ context }) => planCreate(context) },
    review: {
      review: async ({ head_sha }) => ({
        reviewed_head: head_sha,
        reviewer: "human:acceptance",
        outcome: "approved",
        evidence_refs: ["evidence:review-current-head"],
      }),
    },
    verify: { run: async () => passingVerifyReport() },
    orchestrate: {
      dryRun: async (context) => ({
        participants: context.participantIds.map((participantId, index) => ({
          participant_id: participantId,
          role_ref: context.bindings[index]?.role.spec.name ?? "",
          engine: context.bindings[index]?.engine ?? "claude",
          model: context.bindings[index]?.model ?? null,
          engine_available: true,
          model_valid: true,
        })),
        evaluator_auto_added: context.evaluatorAutoAdded,
        engines_available: ["claude"],
        models_valid: true,
      }),
      execute: async () => ({
        units: [
          {
            name: "acceptance-unit",
            status: "done",
            confidence: 1,
            scope: ["src/acceptance.ts"],
            gates: { build: "pass", lint: "pass", test: "pass", review: "pass" },
            resources: { agents: 1, tokens: 0, cost_usd: 0, wall_seconds: 0 },
            evidence: ["evidence:acceptance"],
          },
        ],
        reviews: [{ unit: "acceptance-unit", pass: true, reason: "current evidence passed" }],
      }),
    },
  };
}

function deterministicIds() {
  const counters = new Map<string, number>();
  return (kind: string) => {
    const value = (counters.get(kind) ?? 0) + 1;
    counters.set(kind, value);
    return `${kind}-acceptance-${value}`;
  };
}

function deterministicNow() {
  let tick = 0;
  return () => new Date(Date.UTC(2026, 7, 22, 12, 0, 0, tick++)).toISOString();
}

function httpAuthority(bootstrap: ConversationBootstrap) {
  let sessionByte = 1;
  let streamByte = 40;
  let streamNow = Date.parse("2026-08-22T12:00:00.000Z");
  const sessions = new ConversationSessionAuthority({
    loopback: true,
    randomBytes: () => Buffer.alloc(32, sessionByte++),
  });
  const cookie = sessions.issueCookie()?.split(";", 1)[0];
  if (!cookie) throw new Error("session cookie was not issued");
  const authority: ConversationHttpAuthority = {
    service: bootstrap.service,
    sessions,
    streamTokens: new ConversationStreamTokenAuthority({
      randomBytes: () => Buffer.alloc(32, streamByte++),
      now: () => streamNow,
    }),
    artifacts: {
      registry: bootstrap.authorities.artifactRegistry,
      store: bootstrap.authorities.artifactStore,
    },
    csrf: (request) => request.headers.get("x-vibeflow-token") === "acceptance-csrf",
    heartbeatMs: 0,
  };
  const request = (
    method: string,
    path: string,
    body?: unknown,
    headers: RequestInit["headers"] = {},
  ) => {
    const merged = new Headers(headers);
    merged.set("cookie", cookie);
    if (body !== undefined) merged.set("content-type", "application/json");
    if (method === "POST") merged.set("x-vibeflow-token", "acceptance-csrf");
    return new Request(`http://127.0.0.1${path}`, {
      method,
      headers: merged,
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  };
  const route = (request: Request) =>
    handleConversationRoute(authority, request, new URL(request.url));
  return {
    authority,
    cookie,
    request,
    route,
    advanceStreamClock(ms: number) {
      streamNow += ms;
    },
  };
}

async function waitForEvent(
  bootstrap: ConversationBootstrap,
  conversationId: string,
  type: PublicTraceEvent["type"],
): Promise<PublicStoredTraceEvent> {
  for (let index = 0; index < 200; index += 1) {
    const found = (await bootstrap.service.events(conversationId, 0))?.find(
      (record) => record.event.type === type,
    );
    if (found) return found;
    await Bun.sleep(2);
  }
  throw new Error(`conversation did not emit ${type}`);
}

async function artifactText(
  http: ReturnType<typeof httpAuthority>,
  conversationId: string,
  opaqueId: string,
): Promise<string> {
  const response = await http.route(
    http.request(
      "GET",
      `/api/conversations/${encodeURIComponent(conversationId)}/artifacts/${encodeURIComponent(opaqueId)}`,
    ),
  );
  expect(response.status).toBe(200);
  return response.text();
}

function eventTypes(events: readonly PublicStoredTraceEvent[]): PublicTraceEvent["type"][] {
  return events.map(({ event }) => event.type);
}

function expectSubsequence(actual: readonly string[], expected: readonly string[]): void {
  let cursor = -1;
  for (const value of expected) {
    const next = actual.indexOf(value, cursor + 1);
    expect(next).toBeGreaterThan(cursor);
    cursor = next;
  }
}

async function filesBelow(root: string): Promise<string[]> {
  const output: string[] = [];
  for (const name of await readdir(root, { withFileTypes: true })) {
    const path = join(root, name.name);
    if (name.isDirectory()) output.push(...(await filesBelow(path)));
    else output.push(path);
  }
  return output;
}

async function runHermeticAcceptanceSuite(file: string, pattern?: string): Promise<string> {
  const sandbox = await mkdtemp(join(tmpdir(), "vf-acceptance-suite-"));
  const home = join(sandbox, "home");
  const skills = join(sandbox, "skills");
  const temp = join(sandbox, "tmp");
  await mkdir(home, { recursive: true });
  await mkdir(skills, { recursive: true });
  await mkdir(temp, { recursive: true });
  const argv = ["test", file];
  if (pattern) argv.push("-t", pattern);
  const env: NodeJS.ProcessEnv = {
    HOME: home,
    NODE_ENV: "test",
    VF_SKILLS_HOME: skills,
    PATH: process.env.PATH ?? "/usr/bin:/bin",
    TMPDIR: temp,
    TMP: temp,
    TEMP: temp,
  };
  for (const name of ["LANG", "LC_ALL", "CI", "NO_COLOR"] as const) {
    const value = process.env[name];
    if (value !== undefined) env[name] = value;
  }
  try {
    const child = spawn(process.execPath, argv, {
      cwd: process.cwd(),
      env,
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    const exitCode = await new Promise<number>((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => {
        if (signal) {
          reject(new Error(`acceptance suite ${file} terminated by ${signal}`));
          return;
        }
        resolve(code ?? 1);
      });
    });
    const evidence = `${stdout}\n${stderr}`;
    expect(exitCode, evidence).toBe(0);
    return evidence;
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
}

describe("brainstorm Phase 3 acceptance", () => {
  test("production adapters, routing, and recovery suites remain executable acceptance evidence", async () => {
    const adapters = await runHermeticAcceptanceSuite(
      "test/dispatch-session.test.ts",
      [
        "keeps only its provider auth and runtime essentials",
        "enforces argv, prompt, env, provenance, and trace metadata",
        "exact mode consumes the exact native id and model override",
        "exact mode fails closed because safe native resume is not admitted",
        "reconciles supplied supported history",
        "reports history unavailable instead of claiming completeness",
        "workflow dispatch runs at base without isolation and at the claimed cwd with isolation",
        "fails closed when a native sandbox/tool restriction cannot be enforced",
        "crash after dispatch before acknowledgement is ambiguous and never auto-replayed",
        "public marker listing hides raw native session ids",
        "never emits a future native UUID before its protocol capture",
        "a newly captured non-UUID native id redacts later text in the same frame",
        "OpenCode releases both streams after close when no session id is captured",
      ].join("|"),
    );
    for (const engine of ["claude", "codex", "copilot", "opencode", "antigravity"]) {
      expect(adapters).toContain(`${engine} keeps only its provider auth and runtime essentials`);
      expect(adapters).toContain(
        `${engine} enforces argv, prompt, env, provenance, and trace metadata`,
      );
    }
    expect(adapters).toContain("claude exact mode consumes the exact native id and model override");
    expect(adapters).toContain("codex exact mode consumes the exact native id and model override");
    for (const engine of ["copilot", "opencode", "antigravity"]) {
      expect(adapters).toContain(`${engine} exact mode fails closed`);
      expect(adapters).toContain(`${engine} reports history unavailable`);
    }
    expect(adapters).toContain("workflow dispatch runs at base without isolation");
    expect(adapters).toContain("crash after dispatch before acknowledgement is ambiguous");
    expect(adapters).toContain("public marker listing hides raw native session ids");
    expect(adapters).toContain(
      "claude never emits a future native UUID before its protocol capture",
    );
    expect(adapters).toContain(
      "codex never emits a future native UUID before its protocol capture",
    );
    expect(adapters).toContain(
      "a newly captured non-UUID native id redacts later text in the same frame",
    );
    expect(adapters).toContain(
      "OpenCode releases both streams after close when no session id is captured",
    );

    const binding = await runHermeticAcceptanceSuite(
      "test/agent-binding.test.ts",
      [
        "Phase 1 admits only live-probed built-in read-only Claude/Codex bindings",
        "Phase 2 repo overlay requires verified engine and a live canonical isolation lease",
        "workflow admits a default repo skill without opt-in isolation while conversation stays strict",
      ].join("|"),
    );
    expect(binding).toContain(
      "Phase 1 admits only live-probed built-in read-only Claude/Codex bindings",
    );
    expect(binding).toContain(
      "Phase 2 repo overlay requires verified engine and a live canonical isolation lease",
    );
    expect(binding).toContain(
      "workflow admits a default repo skill without opt-in isolation while conversation stays strict",
    );

    const overlay = await runHermeticAcceptanceSuite(
      "test/role-overlay.test.ts",
      "repo overlay inherits a built-in and applies only declared overrides",
    );
    expect(overlay).toContain(
      "repo overlay inherits a built-in and applies only declared overrides",
    );

    const projection = await runHermeticAcceptanceSuite(
      "test/orchestrator/trace-contracts.test.ts",
      "stored-envelope projector preserves safe correlation and drops internal control fields",
    );
    expect(projection).toContain(
      "stored-envelope projector preserves safe correlation and drops internal control fields",
    );

    const routing = await runHermeticAcceptanceSuite(
      "test/orchestrator/conversation-router.test.ts",
    );
    expect(routing).toContain("uses frozen intent precedence for verify review plan compare");
    expect(routing).toContain("explicit policy wins every intent");
    expect(routing).toContain("explicit participants outrank natural intent");
    expect(routing).toContain(
      "applies explicit-policy error precedence before participant authority",
    );

    const recovery = await runHermeticAcceptanceSuite(
      "test/orchestrator/conversation-runtime.test.ts",
      [
        "fresh service restores the matching durable operation before cancellation without replay",
        "restart preserves the durable operation id for an unresolved approval",
        "two restored services converge on one durable terminal winner",
        "pause preserves attempts; restart resume rehydrates exact binding and never replays ambiguous work",
        "ACTIVE message injects; COMPLETED message creates one idempotent child revision",
        "runtime owns concurrent attempt correlation and resolves branded retry parents",
        "approval resolution is byte-idempotent and conflicting decisions return 409",
      ].join("|"),
    );
    for (const outcome of [
      "restores the matching durable operation before cancellation without replay",
      "restart preserves the durable operation id for an unresolved approval",
      "two restored services converge on one durable terminal winner",
      "restart resume rehydrates exact binding and never replays ambiguous work",
      "ACTIVE message injects; COMPLETED message creates one idempotent child revision",
      "runtime owns concurrent attempt correlation and resolves branded retry parents",
      "approval resolution is byte-idempotent and conflicting decisions return 409",
    ]) {
      expect(recovery).toContain(outcome);
    }

    const controls = await runHermeticAcceptanceSuite(
      "test/orchestrator/conversation-controls.test.ts",
      [
        "subscriber replay drains events synchronously enqueued by its listener",
        "operation cancellation is reserved, append-before-abort, and exactly once",
        "stop terminates remaining attempts once",
        "concurrent termination callers share one complete drain promise",
      ].join("|"),
    );
    expect(controls).toContain("subscriber replay drains events synchronously");
    expect(controls).toContain("operation cancellation is reserved, append-before-abort");
    expect(controls).toContain("stop terminates remaining attempts once");
    expect(controls).toContain("concurrent termination callers share one complete drain promise");

    const approvals = await runHermeticAcceptanceSuite(
      "test/orchestrator/conversation-continuation.test.ts",
      "fresh approvals queue behind an active continuation",
    );
    expect(approvals).toContain("FIFO order without duplicate runs");

    const chatCli = await runHermeticAcceptanceSuite(
      "test/commands-chat.test.ts",
      [
        "--json emits exactly one JSON document",
        "--resume rejects create-only flags before constructing the service",
        "--json reports a pending approval as accepted instead of failed",
      ].join("|"),
    );
    expect(chatCli).toContain("--json emits exactly one JSON document");
    expect(chatCli).toContain("--resume rejects create-only flags before constructing the service");
    expect(chatCli).toContain("pending approval as accepted instead of failed");

    const brainstormCli = await runHermeticAcceptanceSuite(
      "test/commands-brainstorm.test.ts",
      [
        "--resume rejects create-only flags before constructing the service",
        "--json emits the exact 1.0 executed contract and preserves success exits",
        "--json unknown exceptions normalize to transport without leaking details",
      ].join("|"),
    );
    expect(brainstormCli).toContain(
      "--resume rejects create-only flags before constructing the service",
    );
    expect(brainstormCli).toContain("--json emits the exact 1.0 executed contract");
    expect(brainstormCli).toContain("without leaking details");
  }, 30_000);

  test("production bootstrap, services, auth, routes, trace and artifacts stay hermetic", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-brainstorm-e2e-"));
    const repo = join(root, "repo");
    const home = join(root, "home");
    const previousHome = process.env.HOME;
    const markerUnit = `brainstorm-acceptance-${process.pid}-${Date.now()}`;
    await mkdir(repo, { recursive: true });
    await mkdir(home, { recursive: true });
    await writeFile(join(repo, "package.json"), '{"name":"acceptance-repo"}\n');
    process.env.HOME = home;
    const scheduled: Array<() => void> = [];
    const launches: Array<{ argv: string[]; options: EngineProcessSpawnOptions }> = [];
    const privateEnv = {
      PATH: process.env.PATH ?? "/usr/bin",
      ANTHROPIC_API_KEY: "anthropic-private-credential",
      OPENAI_API_KEY: "openai-private-credential",
      GITHUB_TOKEN: "github-private-credential",
    };
    try {
      const bootstrap = createConversationBootstrap({
        repoRoot: repo,
        stateDir: join(root, "state"),
        readiness: () => [{ engine: "claude", ready: true, admitted: true }],
        bindingFactory: bindingFactory(),
        session: {
          sourceEnv: privateEnv,
          spawn: (argv, options) => {
            launches.push({ argv: [...argv], options });
            return completedProcess(
              JSON.stringify({
                type: "result",
                session_id: NATIVE_SESSION_ID,
                result: "plan context inspected",
              }),
            );
          },
        },
        id: deterministicIds(),
        now: deterministicNow(),
        schedule: (task) => scheduled.push(task),
        reviewEvidenceAuthority: {
          currentHead: () => "a".repeat(40),
          checkCurrentHead: () => ({ ok: true, reason: "review-evidence(ok)" }),
          checkWorktree: () => ({
            ok: true,
            fingerprint: "clean-current-head",
            reason: "review worktree is clean",
          }),
        },
        libraries: libraries(async (context) => {
          const attempt = context.launchAttempt({
            participantId: context.participantIds[0] as string,
            bindingIndex: 0,
            purpose: "plan",
            promptInput: context.topic,
          });
          const result = await attempt.completion;
          expect(result).toMatchObject({ ok: true, state: "completed" });
          await attempt.emit({
            idempotency_key: "acceptance-plan:tool-action",
            event: {
              type: "tool_action",
              payload: {
                tool: "Read",
                action: "inspect public plan context",
                status: "completed",
                input_ref: PRIVATE_TOOL_INPUT,
                output_ref: PRIVATE_TOOL_OUTPUT,
              },
            },
          });
          return { content: "# Durable plan\n\nUse the traced runtime.\n" };
        }),
      });
      const http = httpAuthority(bootstrap);
      const preview = await bootstrap.service.dryRun({
        topic: "Plan the traced workflow",
        policy: "plan",
        participants: [{ role_ref: "direct", engine: "claude" }],
      });
      expect(preview).toEqual({
        participants: [
          {
            participant_id: "participant-1",
            role_ref: "direct",
            engine: "claude",
            model: "sonnet",
            engine_available: true,
            model_valid: true,
          },
        ],
        evaluator_auto_added: false,
        engines_available: ["claude"],
        models_valid: true,
      });

      const createResponse = await http.route(
        http.request("POST", "/api/conversations", {
          topic: "Plan the traced workflow",
          policy: "plan",
          participants: [{ role_ref: "direct", engine: "claude" }],
          max_rounds: 1,
        }),
      );
      expect(createResponse.status).toBe(202);
      const created = (await createResponse.json()) as {
        conversation_id: string;
        stream_token: string;
        stream_token_expires_at: string;
      };
      expect(Object.keys(created).sort()).toEqual([
        "conversation_id",
        "stream_token",
        "stream_token_expires_at",
      ]);

      const message = await http.route(
        http.request("POST", `/api/conversations/${created.conversation_id}/messages`, {
          content: "Include an explicit evidence chain",
          target_participants: ["participant-1"],
        }),
      );
      expect(message.status).toBe(202);
      expect(
        await (
          await http.route(
            http.request("POST", `/api/conversations/${created.conversation_id}/pause`, {}),
          )
        ).json(),
      ).toEqual({ paused: true, lifecycle: "PAUSED" });
      expect(
        await (
          await http.route(
            http.request("POST", `/api/conversations/${created.conversation_id}/resume`, {}),
          )
        ).json(),
      ).toEqual({ resumed: true, active_state: "ACTIVE" });

      expect(scheduled).toHaveLength(1);
      scheduled.shift()?.();
      const approval = await waitForEvent(bootstrap, created.conversation_id, "approval_requested");
      if (approval.event.type !== "approval_requested") throw new Error("approval unavailable");
      const decision = {
        ...approval.event.payload.token,
        outcome: "approve" as const,
        reason: null,
      };
      const resolved = await http.route(
        http.request(
          "POST",
          `/api/conversations/${created.conversation_id}/approvals/${decision.approval_id}/resolve`,
          decision,
        ),
      );
      expect(resolved.status).toBe(202);
      expect(await resolved.json()).toEqual({ ...decision, resolved: true });
      await waitForEvent(bootstrap, created.conversation_id, "conversation_terminal");

      const snapshotResponse = await http.route(
        http.request("GET", `/api/conversations/${created.conversation_id}/snapshot`),
      );
      expect(snapshotResponse.status).toBe(200);
      const snapshot = await snapshotResponse.json();
      expect(snapshot).toMatchObject({
        lifecycle: "COMPLETED",
        policy: "plan",
        last_seq: expect.any(Number),
      });
      const stop = await http.route(
        http.request("POST", `/api/conversations/${created.conversation_id}/stop`, {}),
      );
      expect(stop.status).toBe(409);
      expect(await stop.json()).toEqual({ code: "conversation_conflict" });

      const events = (await bootstrap.service.events(created.conversation_id, 0)) ?? [];
      expect(events.map(({ seq }) => seq)).toEqual(events.map((_, index) => index + 1));
      for (const record of events) {
        for (const field of [
          "workflow_id",
          "conversation_id",
          "revision_id",
          "run_id",
          "turn_id",
          "operation_id",
          "attempt_id",
        ] as const) {
          expect(record[field]).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
        }
        if (record.parent_attempt_id !== undefined) {
          expect(record.parent_attempt_id).toMatch(/^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
          expect(record.parent_attempt_id).not.toBe(record.attempt_id);
        }
      }
      expect(new Set(events.map(({ workflow_id }) => workflow_id))).toHaveLength(1);
      expect(new Set(events.map(({ revision_id }) => revision_id))).toHaveLength(1);
      expect(new Set(events.map(({ run_id }) => run_id))).toHaveLength(1);
      expectSubsequence(eventTypes(events), [
        "conversation_configured",
        "coordinator_decision",
        "participant_bound",
        "skill_injected",
        "state_change",
        "user_message",
        "operation_lifecycle",
        "tool_action",
        "artifact_created",
        "approval_requested",
        "approval_resolved",
        "conversation_terminal",
      ]);
      const tool = events.find(({ event }) => event.type === "tool_action");
      expect(tool).toMatchObject({
        role_resolved_hash: "a".repeat(64),
        skill_resolved_hashes: ["b".repeat(64)],
        participant_id: "participant-1",
        role_ref: "direct",
        engine: "claude",
        skill_refs: ["runtime-portable-process-fixtures"],
        evidence_refs: [expect.stringMatching(OPAQUE_ARTIFACT)],
        public_session_ref: expect.stringMatching(/^session_[A-Za-z0-9_-]{43}$/),
        event: {
          payload: {
            input_ref: expect.stringMatching(OPAQUE_ARTIFACT),
            output_ref: expect.stringMatching(OPAQUE_ARTIFACT),
          },
        },
      });
      const artifactEvent = events.find(
        ({ event }) => event.type === "artifact_created" && event.payload.artifact_type === "plan",
      );
      if (artifactEvent?.event.type !== "artifact_created")
        throw new Error("plan artifact missing");
      const planOpaqueId = String(artifactEvent.event.payload.ref);
      expect(planOpaqueId).toMatch(OPAQUE_ARTIFACT);
      expect(await artifactText(http, created.conversation_id, planOpaqueId)).toContain(
        "Use the traced runtime",
      );

      const missingSession = await http.route(
        new Request(`http://127.0.0.1/api/conversations/${created.conversation_id}/snapshot`),
      );
      expect(missingSession.status).toBe(401);
      const missingCsrf = await http.route(
        new Request(`http://127.0.0.1/api/conversations/${created.conversation_id}/stream-token`, {
          method: "POST",
          headers: { cookie: http.cookie, "content-type": "application/json" },
          body: "{}",
        }),
      );
      expect(missingCsrf.status).toBe(403);
      const cookieOnlySse = await http.route(
        new Request(
          `http://127.0.0.1/api/conversations/${created.conversation_id}/events?since=0`,
          { headers: { cookie: http.cookie } },
        ),
      );
      expect(cookieOnlySse.status).toBe(401);

      const stream = await http.route(
        http.request(
          "GET",
          `/api/conversations/${created.conversation_id}/events?stream_token=${encodeURIComponent(created.stream_token)}`,
        ),
      );
      expect(stream.status).toBe(200);
      const reader = stream.body?.getReader();
      if (!reader) throw new Error("SSE body is unavailable");
      let replay = "";
      for (let index = 0; index < 200 && !replay.includes("event: snapshot"); index += 1) {
        const chunk = await reader.read();
        if (chunk.done) break;
        replay += new TextDecoder().decode(chunk.value);
      }
      await reader.cancel();
      expect(replay).toContain("event: trace");
      expect(replay).toContain("event: snapshot");

      http.advanceStreamClock(15 * 60_000 + 1);
      const expired = await http.route(
        http.request(
          "GET",
          `/api/conversations/${created.conversation_id}/events?stream_token=${encodeURIComponent(created.stream_token)}`,
        ),
      );
      expect(expired.status).toBe(401);
      const renewedResponse = await http.route(
        http.request("POST", `/api/conversations/${created.conversation_id}/stream-token`, {}),
      );
      expect(renewedResponse.status).toBe(202);
      const renewed = (await renewedResponse.json()) as {
        stream_token: string;
        stream_token_expires_at: string;
      };
      expect(renewed.stream_token).not.toBe(created.stream_token);
      expect(Date.parse(renewed.stream_token_expires_at)).toBeGreaterThan(
        Date.parse(created.stream_token_expires_at),
      );
      const crossConversation = await http.route(
        http.request(
          "GET",
          `/api/conversations/not-${created.conversation_id}/events?stream_token=${encodeURIComponent(renewed.stream_token)}`,
        ),
      );
      expect(crossConversation.status).toBe(401);
      const renewedStream = await http.route(
        http.request(
          "GET",
          `/api/conversations/${created.conversation_id}/events?since=${events.at(-1)?.seq ?? 0}&stream_token=${encodeURIComponent(renewed.stream_token)}`,
        ),
      );
      expect(renewedStream.status).toBe(200);
      await renewedStream.body?.cancel();

      expect(launches).toHaveLength(1);
      expect(launches[0]?.argv).toEqual(
        expect.arrayContaining([
          "claude",
          "--safe-mode",
          "--permission-mode",
          "plan",
          "--disallowedTools",
          "Write,Edit,Bash",
        ]),
      );
      expect(launches[0]?.options.stdinText).toBe(PRIVATE_PROMPT);
      expect(launches[0]?.options.cwd).toBeUndefined();
      expect(launches[0]?.options.env.ANTHROPIC_API_KEY).toBe(privateEnv.ANTHROPIC_API_KEY);
      expect(launches[0]?.options.env.OPENAI_API_KEY).toBeUndefined();
      expect(launches[0]?.options.env.GITHUB_TOKEN).toBeUndefined();

      const privateRecord = bootstrap.authorities.artifactStore.readRecord(created.conversation_id);
      const internalRefs = privateRecord?.artifacts.map(({ ref }) => ref) ?? [];
      createMarker(markerUnit, "claude");
      updateMarker(markerUnit, {
        engineSessionId: NATIVE_SESSION_ID,
        engineSessionEngine: "claude",
        evidence: [PRIVATE_TOOL_INPUT, PRIVATE_TOOL_OUTPUT, root, ...internalRefs],
      });
      const marker = listMarkers().find(({ unit }) => unit === markerUnit);
      expect(marker).toMatchObject({
        unit: markerUnit,
        nativeSessionStatus: "captured",
        evidence: expect.arrayContaining(["[opaque-evidence]"]),
      });
      const publicSurface = JSON.stringify({
        api: { created, snapshot },
        marker,
        sse: replay,
        trace: events,
      });
      for (const forbidden of [
        NATIVE_SESSION_ID,
        PRIVATE_PROMPT,
        PRIVATE_TOOL_INPUT,
        PRIVATE_TOOL_OUTPUT,
        privateEnv.ANTHROPIC_API_KEY,
        privateEnv.OPENAI_API_KEY,
        privateEnv.GITHUB_TOKEN,
        root,
        ...internalRefs,
      ]) {
        expect(publicSurface).not.toContain(forbidden);
      }
      for (const key of [
        "native_session_id",
        "prompt_template",
        "raw_env",
        "idempotency_key",
        "internal_ref",
        "provider_prompt",
      ]) {
        expect(publicSurface).not.toContain(`\"${key}\"`);
      }
      const attemptFiles = (await filesBelow(join(root, "state", "attempts"))).filter((path) =>
        path.endsWith(".json"),
      );
      expect(attemptFiles).toHaveLength(1);
      const evidence = await readFile(attemptFiles[0] as string, "utf8");
      for (const forbidden of [
        NATIVE_SESSION_ID,
        PRIVATE_PROMPT,
        PRIVATE_TOOL_INPUT,
        PRIVATE_TOOL_OUTPUT,
        root,
        ...internalRefs,
        ...Object.values(privateEnv),
      ]) {
        expect(evidence).not.toContain(forbidden);
      }
      expect(JSON.parse(evidence)).toMatchObject({
        attempt_id: expect.stringMatching(/^attempt-/),
        engine: "claude",
        native_session_status: "captured",
      });
      for (const key of ["native_session_id", "prompt_template", "raw_env", "idempotency_key"]) {
        expect(evidence).not.toContain(`\"${key}\"`);
      }
    } finally {
      cleanupMarker(markerUnit);
      if (previousHome === undefined) Reflect.deleteProperty(process.env, "HOME");
      else process.env.HOME = previousHome;
      await rm(root, { recursive: true, force: true });
    }
  });

  test("debate reaches consensus with journal-derived matrix and baseline artifacts", async () => {
    const root = await mkdtemp(join(tmpdir(), "vf-debate-e2e-"));
    const repo = join(root, "repo");
    await mkdir(repo);
    await writeFile(join(repo, "package.json"), '{"name":"debate-acceptance"}\n');
    const outputs = [
      "Prefer durable trace",
      JSON.stringify({
        answer: "Durable trace",
        content: "The journal provides replayable evidence.",
        claim: "Prefer durable trace",
        evidence: ["ordered journal"],
      }),
      JSON.stringify({
        answer: "Durable trace",
        content: "Opaque projections keep the boundary safe.",
        claim: "Prefer durable trace",
        evidence: ["opaque artifacts"],
      }),
      JSON.stringify(ALL_TRUE),
      JSON.stringify(ALL_TRUE),
    ];
    try {
      const bootstrap = createConversationBootstrap({
        repoRoot: repo,
        stateDir: join(root, "state"),
        readiness: () => [{ engine: "claude", ready: true, admitted: true }],
        bindingFactory: bindingFactory(),
        session: {
          protocol: "bridge",
          sourceEnv: { PATH: process.env.PATH ?? "/usr/bin" },
          spawn: () => {
            const output = outputs.shift();
            if (output === undefined) throw new Error("unexpected debate process launch");
            return completedProcess(output);
          },
        },
        id: deterministicIds(),
        now: deterministicNow(),
        schedule: (task) => task(),
        reviewEvidenceAuthority: {
          currentHead: () => "a".repeat(40),
          checkCurrentHead: () => ({ ok: true, reason: "review-evidence(ok)" }),
          checkWorktree: () => ({ ok: true, fingerprint: "clean", reason: "clean" }),
        },
        libraries: libraries(async () => ({ content: "unused" })),
      });
      const request = {
        topic: "Choose the conversation source of truth",
        policy: "debate",
        participants: [
          { role_ref: "brainstorm-participant", engine: "claude" },
          { role_ref: "brainstorm-skeptic", engine: "claude" },
        ],
        max_rounds: 1,
      };
      const preview = await bootstrap.service.dryRun(request);
      expect(preview.participants.map(({ role_ref }) => role_ref)).toEqual([
        "brainstorm-participant",
        "brainstorm-skeptic",
        "brainstorm-evaluator",
      ]);
      expect(preview).toMatchObject({ evaluator_auto_added: true, models_valid: true });

      const created = await bootstrap.service.create(request);
      expect(created.result.status).toBe("completed");
      expect(created.result.artifact_refs).toHaveLength(4);
      expect(created.result.artifact_refs.every((ref) => /^[A-Za-z0-9_-]+$/.test(ref))).toBe(true);
      expect(outputs).toHaveLength(0);
      expect(await bootstrap.service.snapshot(created.conversation_id)).toMatchObject({
        lifecycle: "COMPLETED",
        consensus_score: 1,
        rounds: [{ complete: true, decision: { outcome: "consensus", score: 1 } }],
      });

      const events = (await bootstrap.service.events(created.conversation_id, 0)) ?? [];
      expectSubsequence(eventTypes(events), [
        "baseline_result",
        "round_boundary",
        "precommit",
        "evaluator_assessment",
        "agent_response_delta",
        "consensus_update",
        "round_boundary",
        "artifact_created",
        "synthesis_completed",
        "conversation_terminal",
      ]);
      const artifacts = events.filter(
        (
          record,
        ): record is PublicStoredTraceEvent & {
          event: Extract<PublicTraceEvent, { type: "artifact_created" }>;
        } => record.event.type === "artifact_created",
      );
      const http = httpAuthority(bootstrap);
      const matrix = JSON.parse(
        await artifactText(http, created.conversation_id, String(artifacts[0]?.event.payload.ref)),
      );
      const baseline = JSON.parse(
        await artifactText(http, created.conversation_id, String(artifacts[1]?.event.payload.ref)),
      );
      const transcript = artifacts.find(
        ({ event }) => event.payload.artifact_type === "transcript",
      );
      expect(transcript?.event.payload.ref).toMatch(OPAQUE_ARTIFACT);
      expect(
        await artifactText(http, created.conversation_id, String(transcript?.event.payload.ref)),
      ).toContain("The journal provides replayable evidence.");
      expect(matrix).toEqual({
        rows: [
          {
            option: "Prefer durable trace",
            scores: {
              responses: 1,
              evidence: 1,
              agreement: 1,
              conflict_resolution: 1,
              evidence_quality: 1,
              convergence: 1,
            },
            aggregate: 1,
            rank: 1,
          },
        ],
        method: "weighted_sum",
        generated_at: expect.any(String),
      });
      expect(baseline).toEqual({
        status: "success",
        baseline_answer: "Prefer durable trace\n",
        debate_answer: "Prefer durable trace",
        divergence: 0,
        skip_reason: null,
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});
