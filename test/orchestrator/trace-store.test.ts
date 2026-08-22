import { expect, spyOn, test } from "bun:test";
import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import * as fs from "node:fs";
import {
  chmodSync,
  existsSync,
  linkSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import lockfile from "proper-lockfile";
import { type LogEvent, Logbus } from "../../src/logbus.js";
import {
  type ArtifactRegistry,
  DurableArtifactRegistry,
  type RebuildableArtifactRegistry,
} from "../../src/orchestrator/trace/artifacts.js";
import { projectPublicStoredTrace } from "../../src/orchestrator/trace/project.js";
import {
  TraceIdempotencyConflictError,
  TraceStore,
  traceJournalPath,
} from "../../src/orchestrator/trace/store.js";
import type {
  OpaqueArtifactId,
  OpaqueSessionRef,
  StoredTraceEvent,
  TraceEvent,
} from "../../src/orchestrator/trace/types.js";
import { decodeRecord, isValidParticipantModel } from "../../src/orchestrator/trace/validation.js";

const correlation = {
  workflow_id: "w",
  conversation_id: "safe",
  revision_id: "r",
  run_id: "run",
  turn_id: "t",
  operation_id: "o",
  attempt_id: "a",
  engine: "codex" as const,
  skill_refs: ["s"],
};
const event = (content = "x"): TraceEvent => ({
  type: "user_message",
  payload: { content, target_participants: ["p"] },
});
const input = (key = "k", content = "x") => ({ idempotency_key: key, event: event(content) });
const options = (dir: string) => ({
  dir,
  eventId: (() => {
    let n = 0;
    return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
  })(),
  now: () => "2026-01-01T00:00:00.000Z",
});
const samples: TraceEvent[] = [
  {
    type: "conversation_configured",
    payload: {
      topic: "x",
      participants: [{ participant_id: "p", role_ref: "r", engine: "codex", model: "gpt-5.4" }],
      policy: "p",
      max_rounds: 1,
    },
  },
  { type: "coordinator_decision", payload: { selected_policy: "p", reason: "r" } },
  {
    type: "participant_bound",
    payload: {
      participant_id: "p",
      engine: "codex",
      model: null,
      prompt_hash: "h",
      tools: ["read"],
      sandbox: "read-only",
    },
  },
  {
    type: "skill_injected",
    payload: { skill_refs: ["s"], resolved_hashes: ["h"], source: "repo" },
  },
  {
    type: "precommit",
    payload: { round_id: "r", participant_id: "p", answer: "a", evidence: ["e"] },
  },
  {
    type: "agent_response_delta",
    payload: {
      round_id: "r",
      participant_id: "p",
      content_delta: "d",
      final_claim: null,
      final_evidence: ["e"],
      completes_response: true,
    },
  },
  {
    type: "tool_action",
    payload: { tool: "t", action: "a", status: "started", input_ref: null, output_ref: "o" },
  },
  {
    type: "evaluator_assessment",
    payload: {
      round_id: "r",
      stage: "blind",
      assessment: {
        agreement: { value: true, evidence: "e" },
        conflict_resolution: { value: false, evidence: "e" },
        evidence_quality: { value: true, evidence: "e" },
        convergence: { value: "not_applicable", evidence: "e" },
      },
    },
  },
  { type: "user_message", payload: { content: "c", target_participants: "all" } },
  {
    type: "consensus_update",
    payload: { round_id: "r", decision: { outcome: "continue", score: 0.5 } },
  },
  { type: "round_boundary", payload: { round_id: "r", phase: "start" } },
  {
    type: "state_change",
    payload: { lifecycle: "ACTIVE", health: "healthy", terminal: false, reason: null },
  },
  {
    type: "baseline_result",
    payload: { status: "success", answer: "a", confidence: 1, skip_reason: null },
  },
  {
    type: "synthesis_completed",
    payload: { decision_matrix_ref: "d", baseline_comparison_ref: "b" },
  },
  {
    type: "conversation_terminal",
    payload: { lifecycle: "COMPLETED", terminal: true, final_score: null },
  },
  {
    type: "dry_run_result",
    payload: {
      participants: [
        {
          participant_id: "p",
          role_ref: "r",
          engine: "codex",
          model: null,
          engine_available: true,
          model_valid: false,
        },
      ],
      evaluator_auto_added: true,
      engines_available: ["codex"],
      models_valid: true,
    },
  },
  { type: "error", payload: { agent_id: null, code: "c", message: "m" } },
  {
    type: "operation_lifecycle",
    payload: { operation_id: "o", attempt_id: "a", state: "requested" },
  },
  {
    type: "approval_requested",
    payload: { token: { approval_id: "a", operation_id: "o", actor: "u" }, description: "d" },
  },
  {
    type: "approval_resolved",
    payload: {
      decision: {
        approval_id: "a",
        operation_id: "o",
        actor: "u",
        outcome: "approve",
        reason: null,
      },
    },
  },
  { type: "caller_cancelled", payload: { operation_id: "o", actor: "u", reason: null } },
  { type: "artifact_created", payload: { artifact_id: "a", artifact_type: "plan", ref: "r" } },
  {
    type: "artifact_updated",
    payload: { artifact_id: "a", artifact_type: "anything", ref: "r", previous_ref: "p" },
  },
  {
    type: "native_history_reconciled",
    payload: {
      public_session_ref: "s",
      status: "reconciled",
      imported_turn_count: 1,
      imported_tool_count: 2,
      provenance_refs: ["p"],
      evidence_refs: ["e"],
      completeness_reason: "c",
    },
  },
];
const clone = <T>(x: T): T => JSON.parse(JSON.stringify(x));
const projectionRegistry: ArtifactRegistry = {
  register(conversationId, internalRef) {
    return `artifact_${conversationId}_${internalRef.length}` as OpaqueArtifactId;
  },
  resolve() {
    return null;
  },
  sessionRef(conversationId, nativeSessionId) {
    return `session_${conversationId}_${nativeSessionId.length}` as OpaqueSessionRef;
  },
  prepareProjection(inputs) {
    return {
      ids: inputs.map((input) =>
        input.kind === "artifact"
          ? (`artifact_${input.conversationId}_${input.value.length}` as OpaqueArtifactId)
          : (`session_${input.conversationId}_${input.value.length}` as OpaqueSessionRef),
      ),
      commit() {},
      rollback() {},
    };
  },
};
const publicStored = (stored_event: StoredTraceEvent, native_session_id: string | null = null) =>
  projectPublicStoredTrace(
    { stored_event, native_session_id },
    { conversationId: stored_event.conversation_id, artifactRegistry: projectionRegistry },
  );

const runProcess = async (command: string, args: string[], timeoutMs = 1_000) => {
  const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"] });
  let stdout = Buffer.alloc(0);
  let stderr = Buffer.alloc(0);
  let spawnError: Error | undefined;
  let timedOut = false;
  const capture = (current: Buffer, chunk: Buffer) =>
    Buffer.concat([current, chunk]).subarray(0, 16 * 1_024);
  child.stdout.on("data", (chunk: Buffer) => {
    stdout = capture(stdout, chunk);
  });
  child.stderr.on("data", (chunk: Buffer) => {
    stderr = capture(stderr, chunk);
  });
  child.once("error", (error) => {
    spawnError = error;
  });
  const closed = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    child.once("close", (code, signal) => resolve({ code, signal })),
  );
  const timer = setTimeout(() => {
    timedOut = true;
    child.kill("SIGKILL");
  }, timeoutMs);
  const completion = await closed;
  clearTimeout(timer);
  return {
    ...completion,
    timedOut,
    spawnError,
    stdout: stdout.toString("utf8"),
    stderr: stderr.toString("utf8"),
  };
};

const independentStore = (dir: string, suffix: string, mirrored: unknown[]) => {
  let n = 0;
  return new TraceStore({
    dir,
    eventId: () => `00000000-0000-4000-8${suffix}00-${String(++n).padStart(12, suffix)}`,
    now: () => "2026-01-01T00:00:00.000Z",
    mirror: { mirrorTrace: (value) => mirrored.push(value) },
  });
};
const lifecycleInput = (
  key: string,
  lifecycle: "ACTIVE" | "PAUSED" | "COMPLETED" | "STOPPED" | "FAILED" | "ABORTED",
  health: "healthy" | "degraded" = "healthy",
) => ({
  idempotency_key: key,
  event: {
    type: "state_change" as const,
    payload: {
      lifecycle,
      health,
      terminal: ["COMPLETED", "STOPPED", "FAILED", "ABORTED"].includes(lifecycle),
      reason: null,
    },
  },
});
const terminalInput = (lifecycle: "COMPLETED" | "STOPPED" | "FAILED" | "ABORTED") => ({
  idempotency_key: "conversation:terminal",
  event: {
    type: "conversation_terminal" as const,
    payload: { lifecycle, terminal: true as const, final_score: null },
  },
});

type IdentityEvent = {
  event_id: string;
  seq: number;
  event: TraceEvent;
};
const identityTuple = (stored: IdentityEvent) => {
  if (stored.event.type !== "user_message") throw new Error("expected user message");
  return [stored.event_id, stored.seq, stored.event.payload.content] as const;
};
const sortedIdentityTuples = (values: IdentityEvent[]) =>
  values.map(identityTuple).sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

test("independent stores serialize same-key and distinct-key races", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-two-store-"));
  try {
    const mirrored: unknown[] = [];
    const one = independentStore(dir, "1", mirrored);
    const two = independentStore(dir, "2", mirrored);
    const sameCorrelation = { ...correlation, conversation_id: "same-key" };
    const same = await Promise.all([
      one.append(sameCorrelation, input("same", "same")),
      two.append(sameCorrelation, input("same", "same")),
    ]);
    expect(same[0]).toEqual(same[1]);
    expect((await one.readConversation("same-key")).map((row) => row.stored_event)).toEqual([
      same[0],
    ]);
    expect(mirrored).toEqual([publicStored(same[0])]);
    expect(existsSync(`${traceJournalPath(dir, "same-key")}.lock`)).toBe(false);

    mirrored.length = 0;
    const distinctCorrelation = { ...correlation, conversation_id: "distinct-keys" };
    const appended = await Promise.all([
      one.append(distinctCorrelation, input("left", "left")),
      two.append(distinctCorrelation, input("right", "right")),
    ]);
    const replayed = await two.readConversation("distinct-keys");
    expect(sortedIdentityTuples(mirrored as IdentityEvent[])).toEqual(
      sortedIdentityTuples(
        appended.map((stored) => publicStored(stored)) as unknown as IdentityEvent[],
      ),
    );
    expect((mirrored as IdentityEvent[]).map(({ seq }) => seq)).toEqual([1, 2]);
    expect(sortedIdentityTuples(replayed.map((row) => row.stored_event))).toEqual(
      sortedIdentityTuples(appended),
    );
    expect(replayed.map((row) => row.stored_event.seq)).toEqual([1, 2]);
    expect(new Set(replayed.map((row) => row.stored_event.event_id)).size).toBe(2);
    expect(new Set(replayed.map((row) => row.stored_event.idempotency_key))).toEqual(
      new Set(["left", "right"]),
    );
    expect(
      new Set(
        replayed.map((row) =>
          row.stored_event.event.type === "user_message"
            ? row.stored_event.event.payload.content
            : "",
        ),
      ),
    ).toEqual(new Set(["left", "right"]));
    expect(mirrored).toHaveLength(2);
    expect(appended).toHaveLength(2);
    expect(() =>
      new TextDecoder("utf-8", { fatal: true }).decode(
        readFileSync(traceJournalPath(dir, "distinct-keys")),
      ),
    ).not.toThrow();
    expect(existsSync(`${traceJournalPath(dir, "distinct-keys")}.lock`)).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical lifecycle append rejects stale transition and terminal races under the journal lock", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-lifecycle-cas-"));
  try {
    const one = independentStore(dir, "1", []);
    const two = independentStore(dir, "2", []);
    const sameCorrelation = { ...correlation, conversation_id: "lifecycle-cas" };
    await one.append(sameCorrelation, lifecycleInput("conversation:active", "ACTIVE"));
    const outcomes = await Promise.allSettled([
      one.append(sameCorrelation, lifecycleInput("conversation:transition:1:PAUSED", "PAUSED")),
      two.appendBatch?.([
        {
          correlation: sameCorrelation,
          input: lifecycleInput("conversation:terminal-state", "COMPLETED"),
        },
        { correlation: sameCorrelation, input: terminalInput("COMPLETED") },
      ]) as Promise<unknown>,
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toHaveLength(1);
    const replay = (await one.readConversation("lifecycle-cas")).map(
      ({ stored_event }) => stored_event.event,
    );
    const paused = replay.some(
      (event) => event.type === "state_change" && event.payload.lifecycle === "PAUSED",
    );
    const terminal = replay.filter((event) => event.type === "conversation_terminal");
    expect({ paused, terminal: terminal.length }).toEqual(
      paused ? { paused: true, terminal: 0 } : { paused: false, terminal: 1 },
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical lifecycle append admits ABORTED but rejects COMPLETED from durable PAUSED", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-lifecycle-paused-"));
  try {
    const store = new TraceStore(options(dir));
    await store.append(correlation, lifecycleInput("conversation:active", "ACTIVE"));
    await store.append(correlation, lifecycleInput("conversation:transition:1:PAUSED", "PAUSED"));
    await expect(store.append(correlation, input("stale-paused", "too late"))).rejects.toThrow(
      /lifecycle/i,
    );
    await expect(
      store.appendBatch?.([
        {
          correlation,
          input: lifecycleInput("conversation:terminal-state", "COMPLETED"),
        },
        { correlation, input: terminalInput("COMPLETED") },
      ]),
    ).rejects.toThrow(/lifecycle/i);
    await expect(
      store.appendBatch?.([
        {
          correlation,
          input: lifecycleInput("conversation:terminal-state", "ABORTED"),
        },
        { correlation, input: terminalInput("ABORTED") },
      ]),
    ).resolves.toHaveLength(2);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical health changes are independent, typed, and legal while ACTIVE or PAUSED", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-health-cas-"));
  try {
    const store = new TraceStore(options(dir));
    await store.append(correlation, lifecycleInput("conversation:active", "ACTIVE"));
    await expect(
      store.append(
        correlation,
        lifecycleInput("conversation:health:1:degraded", "ACTIVE", "degraded"),
      ),
    ).resolves.toMatchObject({ event: { payload: { lifecycle: "ACTIVE", health: "degraded" } } });
    await store.append(
      correlation,
      lifecycleInput("conversation:transition:2:PAUSED", "PAUSED", "degraded"),
    );
    await expect(
      store.append(
        correlation,
        lifecycleInput("conversation:health:3:healthy", "PAUSED", "healthy"),
      ),
    ).resolves.toMatchObject({ event: { payload: { lifecycle: "PAUSED", health: "healthy" } } });
    await expect(
      store.append(
        correlation,
        lifecycleInput("conversation:health:4:healthy", "PAUSED", "healthy"),
      ),
    ).rejects.toThrow(/lifecycle/i);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical lifecycle CAS rejects incoherent terminal flags without poisoning authority", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-terminal-flag-cas-"));
  try {
    const store = new TraceStore(options(dir));
    const activeTerminal = lifecycleInput("poison-active-terminal", "ACTIVE");
    activeTerminal.event.payload.terminal = true;
    await expect(store.append(correlation, activeTerminal)).rejects.toThrow(/lifecycle/i);
    await store.append(correlation, lifecycleInput("conversation:active", "ACTIVE"));
    const completedNonterminal = lifecycleInput("poison-completed-nonterminal", "COMPLETED");
    completedNonterminal.event.payload.terminal = false;
    await expect(store.append(correlation, completedNonterminal)).rejects.toThrow(/lifecycle/i);
    await expect(
      store.append(correlation, input("still-active", "admitted")),
    ).resolves.toMatchObject({ event: { type: "user_message" } });
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable terminal authority rejects every later non-idempotent effect", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-terminal-closed-"));
  try {
    const store = new TraceStore(options(dir));
    await store.append(correlation, lifecycleInput("conversation:active", "ACTIVE"));
    await store.appendBatch?.([
      {
        correlation,
        input: lifecycleInput("conversation:terminal-state", "COMPLETED"),
      },
      { correlation, input: terminalInput("COMPLETED") },
    ]);
    await expect(store.append(correlation, input("stale-message", "too late"))).rejects.toThrow(
      /lifecycle/i,
    );
    await expect(
      store.appendBatch?.([
        { correlation, input: lifecycleInput("conversation:terminal-state", "COMPLETED") },
        { correlation, input: terminalInput("COMPLETED") },
        {
          correlation,
          input: {
            idempotency_key: "stale-policy-effect",
            event: { type: "error", payload: { agent_id: null, code: "late", message: "late" } },
          },
        },
      ]),
    ).rejects.toThrow(/lifecycle|idempotency/i);
    expect(
      await store.append(correlation, lifecycleInput("conversation:active", "ACTIVE")),
    ).toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("two processes prove exact lock-sidecar contention before serial append", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-process-race-"));
  const id = "process-race";
  const journal = traceJournalPath(fs.realpathSync(dir), id);
  const go = join(dir, "go");
  const children: ChildProcessWithoutNullStreams[] = [];
  const completions: Array<{
    promise: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
    settled: boolean;
  }> = [];
  let release: (() => Promise<void>) | undefined;
  const deadline = Date.now() + 15_000;
  const beforeDeadline = <T>(promise: Promise<T>) =>
    new Promise<T>((resolve, reject) => {
      const remaining = deadline - Date.now();
      if (remaining <= 0) {
        reject(new Error("process race deadline exceeded"));
        return;
      }
      const timer = setTimeout(
        () => reject(new Error("process race deadline exceeded")),
        remaining,
      );
      promise.then(
        (value) => {
          clearTimeout(timer);
          resolve(value);
        },
        (error) => {
          clearTimeout(timer);
          reject(error);
        },
      );
    });
  const waitUntil = async (condition: () => boolean) => {
    while (!condition()) {
      if (Date.now() >= deadline)
        throw new Error(
          `process race deadline exceeded: ${children.map((child) => JSON.stringify((child as typeof child & { race?: unknown }).race)).join(" ")}`,
        );
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  };
  try {
    const parentStore = new TraceStore(options(dir));
    await parentStore.readConversation(id);
    release = await lockfile.lock(journal, { realpath: false });
    const moduleUrl = new URL("../../src/orchestrator/trace/store.ts", import.meta.url).href;
    for (const [index, key] of ["left", "right"].entries()) {
      const uuid = `10000000-0000-4000-8000-00000000000${index + 1}`;
      const ready = join(dir, `${key}.ready`);
      const contended = join(dir, `${key}.contended`);
      const completed = join(dir, `${key}.completed`);
      const program = `
import fs from "node:fs";
import {createRequire} from "node:module";
const lockfile=createRequire(import.meta.url)("proper-lockfile");
const journal=${JSON.stringify(journal)}, ready=${JSON.stringify(ready)}, contended=${JSON.stringify(contended)}, completed=${JSON.stringify(completed)}, go=${JSON.stringify(go)};
const realLock=lockfile.lock.bind(lockfile), realMkdir=fs.mkdir.bind(fs);
lockfile.lock=(path, options={}) => {
  const facade={...fs};
  facade.mkdir=(target, callback) => realMkdir(target, (error) => {
    if (String(target)===journal+".lock" && error?.code==="EEXIST" && fs.existsSync(journal+".lock")) fs.writeFileSync(contended, "EEXIST");
    callback(error);
  });
  return realLock(path, {...options, fs:facade});
};
const {TraceStore}=await import(${JSON.stringify(moduleUrl)});
const store=new TraceStore({dir:${JSON.stringify(dir)},eventId:()=>${JSON.stringify(uuid)},now:()=>"2026-01-01T00:00:00.000Z"});
fs.writeFileSync(ready, "ready");
while (!fs.existsSync(go)) await new Promise(resolve => setTimeout(resolve, 5));
const stored=await store.append(${JSON.stringify({ ...correlation, conversation_id: id })},{idempotency_key:${JSON.stringify(key)},event:${JSON.stringify(event(key))}});
fs.writeFileSync(completed, "completed");
console.log(JSON.stringify({key:${JSON.stringify(key)},event_id:stored.event_id,seq:stored.seq}));`;
      const child = spawn(process.execPath, ["-e", program], { stdio: ["pipe", "pipe", "pipe"] });
      const completion = {
        settled: false,
        promise: undefined as unknown as Promise<{
          code: number | null;
          signal: NodeJS.Signals | null;
        }>,
      };
      completion.promise = new Promise((resolve) => {
        child.once("close", (code, signal) => {
          completion.settled = true;
          resolve({ code, signal });
        });
      });
      completions.push(completion);
      child.stdin.end();
      children.push(child);
      Object.assign(child, {
        race: { key, uuid, ready, contended, completed, stdout: "", stderr: "" },
      });
      child.stdout.on("data", (chunk) => {
        const race = (child as typeof child & { race: { stdout: string } }).race;
        race.stdout = (race.stdout + chunk).slice(0, 16_384);
      });
      child.stderr.on("data", (chunk) => {
        const race = (child as typeof child & { race: { stderr: string } }).race;
        race.stderr = (race.stderr + chunk).slice(0, 16_384);
      });
    }
    const races = children.map(
      (child) =>
        (
          child as typeof child & {
            race: {
              key: string;
              uuid: string;
              ready: string;
              contended: string;
              completed: string;
              stdout: string;
              stderr: string;
            };
          }
        ).race,
    );
    await waitUntil(() => races.every(({ ready }) => existsSync(ready)));
    writeFileSync(go, "go");
    await waitUntil(() => races.every(({ contended }) => existsSync(contended)));
    expect(races.map(({ contended }) => readFileSync(contended, "utf8"))).toEqual([
      "EEXIST",
      "EEXIST",
    ]);
    expect(races.every(({ completed }) => !existsSync(completed))).toBe(true);
    expect(completions.every(({ settled }) => !settled)).toBe(true);
    await release();
    release = undefined;
    const closed = await beforeDeadline(Promise.all(completions.map(({ promise }) => promise)));
    const childResults: Array<{ key: string; event_id: string; seq: number }> = [];
    for (const [index, child] of children.entries()) {
      const race = races[index];
      const completion = closed[index];
      if (!race) throw new Error("missing child race");
      if (!completion) throw new Error("missing child completion");
      expect([completion.code, completion.signal, race.stderr]).toEqual([0, null, ""]);
      const lines = race.stdout.trim().split("\n");
      expect(lines).toHaveLength(1);
      const result = JSON.parse(lines[0] ?? "") as {
        key: string;
        event_id: string;
        seq: number;
      };
      expect(result).toEqual({
        key: race.key,
        event_id: race.uuid,
        seq: expect.any(Number),
      });
      childResults.push(result);
    }
    const replayed = await parentStore.readConversation(id);
    const expected = childResults
      .map(({ key, event_id, seq }) => [event_id, seq, key] as const)
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
    expect(sortedIdentityTuples(replayed.map((row) => row.stored_event))).toEqual(expected);
    expect(childResults.map(({ seq }) => seq).sort((a, b) => a - b)).toEqual([1, 2]);
    expect(replayed.map((row) => row.stored_event.seq)).toEqual([1, 2]);
    expect(new Set(replayed.map((row) => row.stored_event.event_id)).size).toBe(2);
    expect(new Set(replayed.map((row) => row.stored_event.idempotency_key))).toEqual(
      new Set(["left", "right"]),
    );
    expect(existsSync(`${journal}.lock`)).toBe(false);
  } finally {
    if (release) await release().catch(() => {});
    for (const [index, child] of children.entries())
      if (!completions[index]?.settled) child.kill("SIGKILL");
    await Promise.all(completions.map(({ promise }) => promise));
    await rm(dir, { recursive: true, force: true });
  }
}, 20_000);

test("makes private durable entries in order and cleans up observed resources", async () => {
  const parent = fs.realpathSync(await mkdtemp(join(tmpdir(), "trace-order-")));
  chmodSync(parent, 0o755);
  const dir = join(parent, "store");
  const actions: string[] = [];
  type Allocation = {
    fd: number;
    generation: number;
    path: string;
    creation: boolean;
    locked: boolean;
  };
  type Operation = Allocation & { operation: "open" | "fsync" | "close"; index: number };
  const operations: Operation[] = [];
  const opened = new Map<number, Allocation>();
  const journalOpens: Array<{ creation: boolean; locked: boolean }> = [];
  let generation = 0;
  let outstanding = 0;
  let locked = false;
  let released = false;
  const realOpen = fs.openSync;
  const realClose = fs.closeSync;
  const realFsync = fs.fsyncSync;
  const realLock = lockfile.lock.bind(lockfile);
  const record = (operation: Operation["operation"], allocation: Allocation) =>
    operations.push({ ...allocation, operation, index: operations.length });
  const assertDurableAllocation = (path: string, creation = false) => {
    const fsync = operations.find(
      (entry) => entry.path === path && entry.creation === creation && entry.operation === "fsync",
    );
    if (!fsync) throw new Error(`durability fsync not observed for ${path}`);
    const allocation = operations.filter(({ generation: value }) => value === fsync.generation);
    const open = allocation.find(({ operation }) => operation === "open");
    const close = allocation.find(({ operation }) => operation === "close");
    if (!open || !close) throw new Error(`durability allocation incomplete for ${path}`);
    expect(open.index).toBeLessThan(fsync.index);
    expect(fsync.index).toBeLessThan(close.index);
    return { fsync, close };
  };
  const assertShapeDurability = (requestedRoot: string) => {
    const physicalRoot = fs.realpathSync(requestedRoot);
    const conversations = join(physicalRoot, "conversations");
    const journal = traceJournalPath(physicalRoot, "safe");
    const root = assertDurableAllocation(physicalRoot);
    const directory = assertDurableAllocation(conversations);
    const createdJournal = assertDurableAllocation(journal, true);
    expect(createdJournal.close.index).toBeLessThan(directory.fsync.index);
    return root;
  };
  const openSpy = spyOn(fs, "openSync").mockImplementation(((path, flags, mode) => {
    const fd = realOpen(path, flags, mode);
    const allocation = {
      fd,
      generation: ++generation,
      path: String(path),
      creation: typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0,
      locked,
    };
    opened.set(fd, allocation);
    record("open", allocation);
    if (allocation.path.endsWith(".jsonl"))
      journalOpens.push({ creation: allocation.creation, locked: allocation.locked });
    outstanding++;
    actions.push(`open:${allocation.path}:${locked}`);
    return fd;
  }) as typeof fs.openSync);
  const closeSpy = spyOn(fs, "closeSync").mockImplementation((fd) => {
    const instance = opened.get(fd);
    if (!instance) throw new Error(`close of unobserved fd ${fd}`);
    if (instance.creation) actions.push("close:created-journal");
    actions.push(`close:${instance.path}`);
    const result = realClose(fd);
    record("close", instance);
    opened.delete(fd);
    outstanding--;
    return result;
  });
  const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const instance = opened.get(fd);
    if (!instance) throw new Error(`fsync of unobserved fd ${fd}`);
    if (instance.creation) actions.push("fsync:created-journal");
    actions.push(`fsync:${instance.path}`);
    record("fsync", instance);
    return realFsync(fd);
  });
  const lockSpy = spyOn(lockfile, "lock").mockImplementation(async (...args) => {
    const release = await realLock(...args);
    locked = true;
    actions.push("lock");
    return async () => {
      released = true;
      locked = false;
      actions.push("release");
      await release();
    };
  });
  try {
    const store = new TraceStore(options(dir));
    expect(resolve(dir)).toBe(fs.realpathSync(dir));
    await store.readConversation("safe");
    await store.readConversation("safe");

    const physicalAncestor = join(parent, "physical");
    const ordinaryParent = join(physicalAncestor, "ordinary");
    mkdirSync(ordinaryParent, { recursive: true, mode: 0o700 });
    const aliasAncestor = join(parent, "alias");
    symlinkSync(physicalAncestor, aliasAncestor, "dir");
    const aliasDir = join(aliasAncestor, "ordinary", "store");
    expect(() => new TraceStore(options(aliasDir))).toThrow("symlink path component");

    const conversations = join(dir, "conversations");
    const journal = traceJournalPath(dir, "safe");
    expect(fs.lstatSync(dir).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(conversations).mode & 0o777).toBe(0o700);
    expect(fs.lstatSync(journal).mode & 0o777).toBe(0o600);
    const index = (value: string) => actions.findIndex((action) => action === value);
    const realDir = fs.realpathSync(dir);
    for (const value of [
      `fsync:${parent}`,
      `close:${parent}`,
      `fsync:${realDir}`,
      `close:${realDir}`,
      "fsync:created-journal",
      "close:created-journal",
    ])
      expect(index(value)).toBeGreaterThanOrEqual(0);
    const durabilityGenerations = new Set(
      operations
        .filter(({ operation }) => operation === "fsync")
        .map(({ generation }) => generation),
    );
    for (const allocationGeneration of durabilityGenerations) {
      const allocation = operations.filter(({ generation }) => generation === allocationGeneration);
      expect(allocation.find(({ operation }) => operation === "open")?.index).toBeLessThan(
        allocation.find(({ operation }) => operation === "fsync")?.index ?? -1,
      );
      expect(allocation.find(({ operation }) => operation === "fsync")?.index).toBeLessThan(
        allocation.find(({ operation }) => operation === "close")?.index ?? -1,
      );
    }
    assertShapeDurability(dir);
    const rootOperations = operations.filter(({ path }) => path === realDir);
    const durabilityFsync = rootOperations.find(({ operation }) => operation === "fsync");
    const validationClose = rootOperations.find(
      ({ operation, index: operationIndex }) =>
        operation === "close" && operationIndex < (durabilityFsync?.index ?? -1),
    );
    if (!validationClose || !durabilityFsync) throw new Error("root generations not observed");
    expect(validationClose.index).toBeLessThan(durabilityFsync.index);
    expect(validationClose.generation).not.toBe(durabilityFsync.generation);
    expect(durabilityFsync.index).toBeLessThan(
      rootOperations.find(
        ({ operation, generation }) =>
          operation === "close" && generation === durabilityFsync.generation,
      )?.index ?? -1,
    );
    expect(index(`fsync:${parent}`)).toBeLessThan(index(`close:${parent}`));
    expect(index("fsync:created-journal")).toBeLessThan(index("close:created-journal"));
    expect(index("close:created-journal")).toBeLessThan(
      actions.findIndex(
        (action) => action.startsWith("fsync:") && action.endsWith("/conversations"),
      ),
    );
    expect(journalOpens.filter(({ creation }) => !creation).length).toBeGreaterThan(0);
    expect(journalOpens.filter(({ creation }) => !creation).every(({ locked }) => locked)).toBe(
      true,
    );
    expect(released).toBe(true);
    expect(outstanding).toBe(0);

    released = false;
    fsyncSpy.mockImplementationOnce((fd) => {
      const instance = opened.get(fd);
      actions.push(`fsync:${instance?.path}`);
      throw new Error("observed fsync failure");
    });
    expect(() => new TraceStore(options(join(parent, "failed")))).toThrow();
    expect(outstanding).toBe(0);
    const parentFsyncsBeforeRetry = actions.filter((action) => action === `fsync:${parent}`).length;
    const parentClosesBeforeRetry = actions.filter((action) => action === `close:${parent}`).length;
    expect(parentFsyncsBeforeRetry).toBeGreaterThan(0);
    expect(parentClosesBeforeRetry).toBeGreaterThan(0);
    expect(() => new TraceStore(options(join(parent, "failed")))).not.toThrow();
    const parentFsyncRetryDelta =
      actions.filter((action) => action === `fsync:${parent}`).length - parentFsyncsBeforeRetry;
    const parentCloseRetryDelta =
      actions.filter((action) => action === `close:${parent}`).length - parentClosesBeforeRetry;
    expect(parentFsyncRetryDelta).toBeGreaterThan(0);
    expect(parentCloseRetryDelta).toBeGreaterThan(0);
    expect(outstanding).toBe(0);

    const retryId = "durability-retry";
    const retryJournal = traceJournalPath(dir, retryId);
    let failNewJournal = true;
    fsyncSpy.mockImplementation((fd) => {
      const instance = opened.get(fd);
      if (failNewJournal && instance?.creation && instance.path.endsWith(".jsonl")) {
        failNewJournal = false;
        throw new Error("new journal fsync failure");
      }
      if (instance?.path.endsWith(".jsonl")) actions.push(`retry-fsync:journal:${locked}`);
      if (instance?.path.endsWith("/conversations"))
        actions.push(`retry-fsync:conversations:${locked}`);
      return realFsync(fd);
    });
    await expect(store.readConversation(retryId)).rejects.toThrow("new journal fsync failure");
    const retryStart = actions.length;
    await expect(store.readConversation(retryId)).resolves.toEqual([]);
    const retryActions = actions.slice(retryStart);
    const journalFsync = retryActions.indexOf("retry-fsync:journal:true");
    const directoryFsync = retryActions.indexOf("retry-fsync:conversations:true");
    expect(journalFsync).toBeGreaterThanOrEqual(0);
    expect(directoryFsync).toBeGreaterThan(journalFsync);

    fsyncSpy.mockImplementation((fd) => realFsync(fd));
    const failing = new TraceStore(options(join(parent, "action-failed")));
    await failing.readConversation("safe");
    await writeFile(traceJournalPath(join(parent, "action-failed"), "safe"), "{bad\n");
    released = false;
    await expect(failing.readConversation("safe")).rejects.toThrow();
    expect(released).toBe(true);
    expect(outstanding).toBe(0);

    released = false;
    let closeThrown = false;
    closeSpy.mockImplementation((fd) => {
      const instance = opened.get(fd);
      const result = realClose(fd);
      opened.delete(fd);
      outstanding--;
      if (!closeThrown && locked && instance?.path.endsWith(".jsonl")) {
        closeThrown = true;
        throw new Error("observed close failure");
      }
      return result;
    });
    await expect(failing.readConversation("safe")).rejects.toThrow("observed close failure");
    expect(released).toBe(true);
    expect(outstanding).toBe(0);
  } finally {
    openSpy.mockRestore();
    closeSpy.mockRestore();
    fsyncSpy.mockRestore();
    lockSpy.mockRestore();
    await rm(parent, { recursive: true, force: true });
  }
});

// ponytail: table covers contract variants; split only when event fixtures become shared.
test("accepts all TraceEvent variants and rejects exact payload shape violations", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const store = new TraceStore(options(dir));
    for (const [index, sample] of samples.entries()) {
      const sampleCorrelation = {
        ...correlation,
        conversation_id: `variant-${index}`,
        operation_id: `variant-operation-${index}`,
        turn_id: `variant-turn-${index}`,
      };
      if (sample.type === "conversation_terminal") {
        await store.append(sampleCorrelation, lifecycleInput("conversation:active", "ACTIVE"));
        await store.append(
          sampleCorrelation,
          lifecycleInput("conversation:terminal-state", sample.payload.lifecycle),
        );
      }
      const validKey =
        sample.type === "conversation_terminal" ? "conversation:terminal" : `valid-${index}`;
      await expect(
        store.append(sampleCorrelation, { idempotency_key: validKey, event: sample }),
      ).resolves.toMatchObject({ event: sample });
      const extra = clone(sample) as unknown as { payload: Record<string, unknown> };
      extra.payload.extra = true;
      await expect(
        store.append(sampleCorrelation, {
          idempotency_key: `extra-${index}`,
          event: extra as unknown as TraceEvent,
        }),
      ).rejects.toThrow();
      const missing = clone(sample) as unknown as { payload: Record<string, unknown> };
      const [key] = Object.keys(missing.payload);
      if (!key) throw new Error("sample payload missing key");
      delete missing.payload[key];
      await expect(
        store.append(sampleCorrelation, {
          idempotency_key: `missing-${index}`,
          event: missing as unknown as TraceEvent,
        }),
      ).rejects.toThrow();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects malformed nested values, exact envelopes, and private fields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const store = new TraceStore(options(dir));
    const [
      configured,
      ,
      bound,
      ,
      ,
      ,
      ,
      evaluated,
      ,
      consensus,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      ,
      approval,
      ,
      created,
    ] = samples;
    if (!configured || !bound || !evaluated || !consensus || !approval || !created)
      throw new Error("missing event samples");
    const bad: unknown[] = [
      {
        ...configured,
        payload: {
          ...configured.payload,
          participants: [{ participant_id: "p", role_ref: "r", engine: "bad", model: null }],
        },
      },
      { ...bound, payload: { ...bound.payload, tools: ["bad"] } },
      {
        ...evaluated,
        payload: {
          ...evaluated.payload,
          assessment: { agreement: { value: true, evidence: "e", extra: 1 } },
        },
      },
      {
        ...consensus,
        payload: { round_id: "r", decision: { outcome: "abort", score: null, reason: "bad" } },
      },
      {
        ...approval,
        payload: {
          token: { approval_id: "a", operation_id: "o", actor: "u", raw_env: "x" },
          description: "d",
        },
      },
      { ...created, payload: { artifact_id: "a", artifact_type: "bad", ref: "r" } },
      { type: "unknown", payload: {} },
      { type: "user_message", payload: { content: "x", target_participants: "all" }, extra: true },
      { type: "user_message", payload: { content: "x", target_participants: "all", raw_env: "x" } },
    ];
    for (const [index, value] of bad.entries())
      await expect(
        store.append(correlation, {
          idempotency_key: `bad-${index}`,
          event: value as unknown as TraceEvent,
        }),
      ).rejects.toThrow();
    await expect(
      store.append(
        { ...correlation, raw_env: "x" } as unknown as typeof correlation,
        input("correlation-extra"),
      ),
    ).rejects.toThrow();
    await expect(
      store.append(
        {
          workflow_id: "w",
          conversation_id: "safe",
          revision_id: "r",
          run_id: "r",
          turn_id: "t",
          operation_id: "o",
        } as unknown as typeof correlation,
        input("correlation-missing"),
      ),
    ).rejects.toThrow();
    await expect(
      store.append(correlation, {
        idempotency_key: "x",
        event: event(),
        native_session_id: "x",
      } as never),
    ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("participant tools use canonical enum", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const store = new TraceStore(options(dir));
    const bound = samples[2];
    if (!bound || bound.type !== "participant_bound") throw new Error("missing participant sample");
    const statuses = await Promise.allSettled(
      [["grep", "glob"], ["mcp"]].map((tools, index) =>
        store.append(correlation, {
          idempotency_key: `tools-${index}`,
          event: { ...bound, payload: { ...bound.payload, tools } } as TraceEvent,
        }),
      ),
    );
    expect(statuses.map(({ status }) => status)).toEqual(["fulfilled", "rejected"]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("participant models accept bounded provider IDs and reject hostile values", async () => {
  const valid = [
    "claude-sonnet-4-5-20250929",
    "openai/gpt-5.4:preview",
    "us.anthropic.claude-opus-4-1-v1:0",
    "provider/model_v2.1@stable",
  ];
  const invalid = [
    "",
    "x".repeat(201),
    "model\u0000override",
    "../private/model",
    "/absolute/model",
    "C:/Users/alice/.ssh/id_rsa",
    "src/private/evidence.json",
    "GITHUB_TOKEN",
    "provider//model",
    "sk-abcdefghijklmnopqrstuvwxyz1234567890",
  ];
  expect(valid.map(isValidParticipantModel)).toEqual([true, true, true, true]);
  expect(invalid.map(isValidParticipantModel)).toEqual(invalid.map(() => false));

  const dir = await mkdtemp(join(tmpdir(), "trace-models-"));
  try {
    const store = new TraceStore(options(dir));
    const configured = samples[0];
    const bound = samples[2];
    if (
      !configured ||
      configured.type !== "conversation_configured" ||
      !bound ||
      bound.type !== "participant_bound"
    )
      throw new Error("missing participant fixtures");
    const configuredParticipant = configured.payload.participants[0];
    const configuredModel = valid[1];
    const boundModel = valid[2];
    if (!configuredParticipant || !configuredModel || !boundModel)
      throw new Error("missing participant model fixtures");
    await expect(
      store.append(correlation, {
        idempotency_key: "provider-configured",
        event: {
          ...configured,
          payload: {
            ...configured.payload,
            participants: [{ ...configuredParticipant, model: configuredModel }],
          },
        },
      }),
    ).resolves.toBeDefined();
    await expect(
      store.append(correlation, {
        idempotency_key: "provider-bound",
        event: { ...bound, payload: { ...bound.payload, model: boundModel } },
      }),
    ).resolves.toBeDefined();
    for (const [index, model] of invalid.entries())
      await expect(
        store.append(correlation, {
          idempotency_key: `hostile-model-${index}`,
          event: {
            ...bound,
            payload: { ...bound.payload, model },
          },
        }),
      ).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trace input enforces bounded strings, arrays, references, records, and journals", async () => {
  const maxTextBytes = 64 * 1024;
  const maxArrayItems = 512;
  const maxReferenceBytes = 4 * 1024;
  const maxRecordBytes = 512 * 1024;
  const maxJournalBytes = 16 * 1024 * 1024;
  const dir = await mkdtemp(join(tmpdir(), "trace-limits-"));
  try {
    const store = new TraceStore(options(dir));
    await expect(
      store.append(correlation, input("oversized-text", "x".repeat(maxTextBytes + 1))),
    ).rejects.toThrow("invalid input");
    await expect(
      store.append(correlation, {
        idempotency_key: "oversized-array",
        event: {
          type: "user_message",
          payload: {
            content: "safe",
            target_participants: Array.from({ length: maxArrayItems + 1 }, () => "p"),
          },
        },
      }),
    ).rejects.toThrow("invalid input");
    await expect(
      store.append(
        { ...correlation, evidence_refs: ["r".repeat(maxReferenceBytes + 1)] },
        input("oversized-ref"),
      ),
    ).rejects.toThrow("invalid input");
    await expect(
      store.append(
        correlation,
        input("oversized-native-session"),
        "n".repeat(maxReferenceBytes + 1),
      ),
    ).rejects.toThrow("invalid input");
    expect(() => decodeRecord(`{"padding":"${"x".repeat(maxRecordBytes)}"}`)).toThrow(
      "record too large",
    );

    await store.readConversation("oversized-journal");
    writeFileSync(
      traceJournalPath(dir, "oversized-journal"),
      Buffer.alloc(maxJournalBytes + 1, 0x20),
    );
    await expect(store.readConversation("oversized-journal")).rejects.toThrow("journal too large");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trace store incrementally indexes registry records after one rebuild", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-registry-index-"));
  const rebuildLengths: number[] = [];
  const indexLengths: number[] = [];
  const registry: RebuildableArtifactRegistry & {
    index(records: readonly unknown[]): void;
  } = {
    register(_conversationId, internalRef) {
      return `artifact_${internalRef}` as OpaqueArtifactId;
    },
    resolve() {
      return null;
    },
    rebuild(records) {
      rebuildLengths.push(records.length);
    },
    index(records) {
      indexLengths.push(records.length);
    },
  };
  try {
    const store = new TraceStore({ ...options(dir), artifactRegistry: registry });
    await store.append(correlation, input("one", "one"));
    await store.append(correlation, input("two", "two"));
    await store.append(correlation, input("three", "three"));
    expect(rebuildLengths).toEqual([0]);
    expect(indexLengths).toEqual([1, 1, 1]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("trace store rejects a user-owned symlink in any supplied path component", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-component-symlink-"));
  try {
    const actual = join(root, "actual");
    mkdirSync(actual, { mode: 0o700 });
    const alias = join(root, "alias");
    symlinkSync(actual, alias);
    expect(() => new TraceStore(options(join(alias, "trace")))).toThrow("symlink path component");
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("rejects non-lossless JSON domain and accepts null-prototype data", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const store = new TraceStore(options(dir));
    const cycle: Record<string, unknown> = {};
    cycle.self = cycle;
    const values: unknown[] = [
      cycle,
      1n,
      undefined,
      () => {},
      Symbol("x"),
      -0,
      Number.NaN,
      Number.POSITIVE_INFINITY,
      Number.NEGATIVE_INFINITY,
      new Date(),
      Object.create({ x: 1 }),
    ];
    const accessor = {};
    Object.defineProperty(accessor, "x", { get: () => 1, enumerable: true });
    values.push(accessor);
    const symbol = { x: 1 };
    Object.defineProperty(symbol, Symbol("x"), { value: 1 });
    values.push(
      symbol,
      { toJSON: () => "x" },
      { constructor: "x" },
      { prototype: "x" },
      { __proto__: "x" },
    );
    const sparse = ["x", undefined, "z"];
    const tagged = ["x"];
    (tagged as unknown as Record<string, unknown>).extra = "x";
    values.push(sparse, tagged);
    for (const [index, value] of values.entries())
      await expect(
        store.append({ ...correlation, evidence_refs: value as string[] }, input(`json-${index}`)),
      ).rejects.toThrow();
    const nullObject = Object.create(null) as Record<string, unknown>;
    nullObject.content = "x";
    nullObject.target_participants = ["p"];
    await expect(
      store.append(Object.assign(Object.create(null), correlation), {
        idempotency_key: "null-prototype",
        event: { type: "user_message", payload: nullObject } as unknown as TraceEvent,
      }),
    ).resolves.toBeDefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("mirrors durable journal synchronously once and treats mirror failures as best effort", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-mirror-order-"));
  const journal = traceJournalPath(dir, correlation.conversation_id);
  const realOpen = fs.openSync;
  const realClose = fs.closeSync;
  const realWrite = fs.writeSync;
  const realFsync = fs.fsyncSync;
  const journals = new Map<number, { generation: number; creation: boolean }>();
  const actions: string[] = [];
  let generation = 0;
  let observedJournalOpens = 0;
  let mirrorCalls = 0;
  let mirrorLocked = false;
  let mirrorStoredEventVisible = false;
  let mirrorActionIndex = -1;
  let mirrorObservationError: string | null = null;
  let mirroredBeforeMutation: unknown;
  const order: string[] = [];
  const openSpy = spyOn(fs, "openSync").mockImplementation(((path, flags, mode) => {
    const fd = realOpen(path, flags, mode);
    const canonicalRoot = fs.realpathSync(dir);
    const canonicalJournal = existsSync(journal) ? fs.realpathSync(journal) : null;
    const canonicalPath = fs.realpathSync(String(path));
    if (
      canonicalJournal !== null &&
      canonicalPath === canonicalJournal &&
      canonicalJournal.startsWith(`${canonicalRoot}/`)
    ) {
      const opened = {
        generation: ++generation,
        creation: typeof flags === "number" && (flags & fs.constants.O_EXCL) !== 0,
      };
      journals.set(fd, opened);
      observedJournalOpens++;
      actions.push(`open:${opened.generation}:${opened.creation ? "creation" : "working"}`);
    }
    return fd;
  }) as typeof fs.openSync);
  const writeSpy = spyOn(fs, "writeSync").mockImplementation(((fd, ...args: unknown[]) => {
    const result = (realWrite as (...values: unknown[]) => number)(fd, ...args);
    const opened = journals.get(fd);
    if (opened)
      actions.push(`write:${opened.generation}:${opened.creation ? "creation" : "working"}`);
    return result;
  }) as typeof fs.writeSync);
  const closeSpy = spyOn(fs, "closeSync").mockImplementation((fd) => {
    const opened = journals.get(fd);
    const result = realClose(fd);
    if (opened)
      actions.push(`close:${opened.generation}:${opened.creation ? "creation" : "working"}`);
    journals.delete(fd);
    return result;
  });
  const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
    const result = realFsync(fd);
    const opened = journals.get(fd);
    if (opened)
      actions.push(`fsync:${opened.generation}:${opened.creation ? "creation" : "working"}`);
    return result;
  });
  try {
    const store = new TraceStore({
      ...options(dir),
      mirror: {
        mirrorTrace(stored) {
          mirrorCalls++;
          order.push("mirror");
          mirroredBeforeMutation = clone(stored);
          try {
            mirrorLocked = lockfile.checkSync(journal, { realpath: false });
            const durable = JSON.parse(readFileSync(journal, "utf8").trim());
            mirrorStoredEventVisible =
              JSON.stringify(publicStored(durable.stored_event, durable.native_session_id)) ===
              JSON.stringify(stored);
            const working = [...journals.values()].find(({ creation }) => !creation);
            mirrorActionIndex = actions.push(`mirror:${working?.generation ?? 0}:working`) - 1;
          } catch (error) {
            mirrorObservationError = error instanceof Error ? error.message : String(error);
          }
          const mutable = stored as unknown as {
            conversation_id: string;
            event: { payload: { content: string } };
          };
          mutable.conversation_id = "mutated-by-mirror";
          mutable.event.payload.content = "mutated-by-mirror";
          throw new Error("best-effort mirror failure");
        },
      },
    });
    const first = await store.append(correlation, input()).then((stored) => {
      order.push("resolved");
      return stored;
    });
    const bytes = readFileSync(journal);
    const workingGeneration = Number(actions[mirrorActionIndex]?.split(":")[1]);
    const workingSequence = [
      `open:${workingGeneration}:working`,
      `write:${workingGeneration}:working`,
      `fsync:${workingGeneration}:working`,
      `mirror:${workingGeneration}:working`,
    ].map((action) => actions.indexOf(action));
    expect(observedJournalOpens).toBeGreaterThan(0);
    expect(workingGeneration).toBeGreaterThan(0);
    expect(workingSequence.every((index) => index >= 0)).toBe(true);
    expect(workingSequence).toEqual([...workingSequence].sort((a, b) => a - b));
    expect(mirrorObservationError).toBeNull();
    expect(mirrorLocked).toBe(true);
    expect(mirrorStoredEventVisible).toBe(true);
    expect(order).toEqual(["mirror", "resolved"]);
    expect(mirroredBeforeMutation).toEqual(publicStored(first));
    expect(first).toMatchObject({ conversation_id: "safe", event: event("x") });
    const replayed = await store.readConversation(correlation.conversation_id);
    expect(replayed).toEqual([{ stored_event: first, native_session_id: null }]);
    expect(JSON.parse(bytes.toString())).toEqual({ stored_event: first, native_session_id: null });
    expect(await store.append(correlation, input())).toEqual(first);
    expect(readFileSync(journal)).toEqual(bytes);
    expect(mirrorCalls).toBe(1);
    await expect(store.append(correlation, input("k", "conflict"))).rejects.toBeInstanceOf(
      TraceIdempotencyConflictError,
    );
    expect(readFileSync(journal)).toEqual(bytes);
    expect(mirrorCalls).toBe(1);
    expect(journals.size).toBe(0);
    expect(lockfile.checkSync(journal, { realpath: false })).toBe(false);
  } finally {
    openSpy.mockRestore();
    writeSpy.mockRestore();
    closeSpy.mockRestore();
    fsyncSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("durable canonical append, idempotency, private hash path, and mirror", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  let bus: Logbus | undefined;
  try {
    bus = new Logbus({
      dir: join(dir, "logs"),
      runId: "constructor-secret-run",
      context: {
        workflowId: "constructor-secret-workflow",
        repoPath: "/constructor-secret-repo",
      },
    });
    bus.write({
      runId: "seed-run",
      workflowId: "seed-workflow",
      repoPath: "/seed-repo",
      channel: "user",
      level: "info",
      text: "seed",
    });
    const seen: LogEvent[] = [];
    bus.subscribe((value) => seen.push(value));
    const store = new TraceStore({ ...options(dir), mirror: bus });
    const one = await store.append(correlation, input());
    expect(await store.append({ ...correlation, run_id: "changed" }, input(), "changed")).toEqual(
      one,
    );
    expect(seen).toHaveLength(1);
    await expect(
      store.append(correlation, {
        idempotency_key: "k",
        event: { type: "user_message", payload: { target_participants: ["p"], content: "x" } },
      }),
    ).rejects.toBeInstanceOf(TraceIdempotencyConflictError);
    await expect(store.append(correlation, input("k", "changed"))).rejects.toBeInstanceOf(
      TraceIdempotencyConflictError,
    );
    expect((await store.readConversation("safe"))[0]?.stored_event.seq).toBe(1);
    const path = traceJournalPath(dir, "safe");
    expect(path).not.toContain("safe");
    expect(lstatSync(path).mode & 0o777).toBe(0o600);
    const observed = seen[0];
    expect(observed).toBeDefined();
    const publicOne = publicStored(one);
    expect(observed).toEqual({
      seq: 2,
      ts: expect.any(Number),
      runId: "trace-public",
      workflowId: "trace-public",
      repoPath: "",
      unit: undefined,
      channel: "vf",
      level: "info",
      text: "trace:user_message",
      meta: { trace: publicOne },
    });
    expect(Object.keys(observed?.meta ?? {})).toEqual(["trace"]);
    const serializedObserved = JSON.stringify(observed);
    for (const secret of [
      "constructor-secret-run",
      "constructor-secret-workflow",
      "/constructor-secret-repo",
    ])
      expect(serializedObserved).not.toContain(secret);
    for (const key of Object.keys(correlation))
      expect(serializedObserved).toContain(`${JSON.stringify(key)}:`);
    expect(serializedObserved).not.toContain("idempotency_key");
  } finally {
    if (bus) await bus.close();
    await rm(dir, { recursive: true, force: true });
  }
});

test("append snapshots caller values before lock acquisition yields", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const mirrored: unknown[] = [];
    const store = new TraceStore({
      ...options(dir),
      artifactRegistry: projectionRegistry,
      mirror: { mirrorTrace: (value) => mirrored.push(value) },
    });
    const mutableCorrelation = clone(correlation);
    const mutableInput = input("snapshot", "before");
    const pending = store.append(mutableCorrelation, mutableInput, "native-before");
    mutableCorrelation.conversation_id = "mutated";
    mutableCorrelation.revision_id = "mutated";
    mutableCorrelation.skill_refs.push("mutated");
    Object.assign(mutableCorrelation, { raw_env: "forbidden" });
    mutableInput.idempotency_key = "mutated";
    if (mutableInput.event.type !== "user_message") throw new Error("wrong fixture event");
    mutableInput.event.payload.content = "after";
    if (Array.isArray(mutableInput.event.payload.target_participants))
      mutableInput.event.payload.target_participants.push("mutated");
    Object.assign(mutableInput.event, { private: "forbidden" });

    const stored = await pending;
    expect(existsSync(traceJournalPath(dir, "mutated"))).toBe(false);
    expect(stored).toMatchObject({
      conversation_id: "safe",
      revision_id: "r",
      skill_refs: ["s"],
      idempotency_key: "snapshot",
      event: event("before"),
    });
    expect(stored).not.toHaveProperty("raw_env");
    expect(stored.event).not.toHaveProperty("private");
    expect(await store.readConversation("safe")).toEqual([
      { stored_event: stored, native_session_id: "native-before" },
    ]);
    expect(await store.append(correlation, input("snapshot", "before"), "changed")).toEqual(stored);
    expect(mirrored).toEqual([publicStored(stored, "native-before")]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("rejects corruption and recovers torn tail", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const store = new TraceStore(options(dir));
    await store.append(correlation, input());
    const path = traceJournalPath(dir, "safe");
    await writeFile(path, `${readFileSync(path)}{bad`);
    const torn = await readFile(path);
    await expect(store.readConversation("safe")).rejects.toThrow();
    expect(await readFile(path)).toEqual(torn);
    await store.append(correlation, input("two"));
    expect((await store.readConversation("safe")).map((x) => x.stored_event.seq)).toEqual([1, 2]);
    const before = await readFile(path);
    await writeFile(path, Buffer.concat([before, Buffer.from("\n")]));
    await expect(store.append(correlation, input("three"))).rejects.toThrow();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovering torn tail is durable before idempotent append resolves", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const mirrored: unknown[] = [];
    const store = new TraceStore({
      ...options(dir),
      mirror: { mirrorTrace: (value) => mirrored.push(value) },
    });
    const stored = await store.append(correlation, input());
    const path = traceJournalPath(dir, "safe");
    const canonical = readFileSync(path);
    await writeFile(path, Buffer.concat([canonical, Buffer.from("{bad")]));

    const actions: string[] = [];
    let truncatedFd: number | undefined;
    const realTruncate = fs.ftruncateSync;
    const realFsync = fs.fsyncSync;
    const truncateSpy = spyOn(fs, "ftruncateSync").mockImplementation((fd, length) => {
      truncatedFd = fd;
      actions.push("truncate");
      return realTruncate(fd, length);
    });
    try {
      const fsyncSpy = spyOn(fs, "fsyncSync").mockImplementation((fd) => {
        if (fd === truncatedFd) actions.push("journal fsync");
        return realFsync(fd);
      });
      try {
        const recovered = await store.append(correlation, input()).then((value) => {
          actions.push("resolved");
          return value;
        });
        expect(actions).toEqual(["truncate", "journal fsync", "resolved"]);
        expect(recovered).toEqual(stored);
        expect(readFileSync(path)).toEqual(canonical);
        expect(mirrored).toEqual([publicStored(stored)]);
      } finally {
        fsyncSpy.mockRestore();
      }
    } finally {
      truncateSpy.mockRestore();
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("recovery drops a crash-torn batch containing an idempotent prefix and two new records", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-mixed-batch-"));
  const realWrite = fs.writeSync;
  const write = spyOn(fs, "writeSync");
  try {
    const store = new TraceStore(options(dir));
    await store.append(correlation, input("old", "old"));
    let injected = false;
    write.mockImplementation(((
      fd: number,
      buffer: Uint8Array,
      offset: number,
      length: number,
      position: number,
    ) => {
      const bytes = Buffer.from(buffer).subarray(offset, offset + length);
      if (!injected && bytes.includes(Buffer.from('"batch-new-2"'))) {
        injected = true;
        const firstRecord = bytes.indexOf(10) + 1;
        realWrite(fd, buffer, offset, firstRecord, position);
        throw new Error("simulated mixed-batch crash");
      }
      return realWrite(fd, buffer, offset, length, position);
    }) as typeof fs.writeSync);
    await expect(
      store.appendBatch?.([
        { correlation, input: input("old", "old") },
        { correlation, input: input("batch-new-1", "one") },
        { correlation, input: input("batch-new-2", "two") },
      ]),
    ).rejects.toThrow("simulated mixed-batch crash");
    write.mockRestore();

    expect(
      (await store.recoverConversation?.("safe"))?.map(
        ({ stored_event }) => stored_event.idempotency_key,
      ),
    ).toEqual(["old"]);
  } finally {
    write.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("canonical replay, crash recovery, and corruption refusal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const hidden = <T extends object>(x: T) => {
      Object.defineProperty(x, "hidden", { value: 1 });
      return x;
    };
    const mirrored: unknown[] = [];
    const store = new TraceStore({
      ...options(dir),
      mirror: { mirrorTrace: (x) => mirrored.push(x) },
    });
    for (const [c, i] of [
      [hidden({ ...correlation }), input("hc")],
      [correlation, hidden(input("hi"))],
      [
        correlation,
        { ...input("hp"), event: { ...event(), payload: hidden({ ...event().payload }) } },
      ],
    ] as const)
      await expect(
        store.append(c as typeof correlation, i as ReturnType<typeof input>),
      ).rejects.toThrow();
    await store.append(correlation, input("one"));
    await store.append(correlation, input("two"));
    const path = traceJournalPath(dir, "safe");
    const rows = readFileSync(path)
      .toString()
      .trimEnd()
      .split("\n")
      .map((x) => JSON.parse(x));
    await writeFile(path, readFileSync(path).subarray(0, -1));
    expect(await store.readConversation("safe")).toHaveLength(2);
    await store.append(correlation, input("three"));
    expect(readFileSync(path).toString().split("\n")).toHaveLength(4);
    const mutations: Array<(x: any) => void> = [
      (x) => Object.assign(x.stored_event, { conversation_id: "other" }),
      (x) => Object.assign(x.stored_event, { event_id: rows[0].stored_event.event_id }),
      (x) => Object.assign(x.stored_event, { idempotency_key: "one" }),
      (x) => Object.assign(x.stored_event, { seq: 0 }),
      (x) => Object.assign(x.stored_event, { seq: -1 }),
      (x) => Object.assign(x.stored_event, { seq: 1 }),
      (x) => Object.assign(x.stored_event, { seq: 3 }),
      (x) => Object.assign(x.stored_event, { idempotency_key: "" }),
      (x) => Object.assign(x.stored_event, { ts: "bad" }),
      (x) => Object.assign(x.stored_event, { event_id: "BAD" }),
      (x) => Object.assign(x.stored_event, { event: { type: "bad", payload: {} } }),
      (x) => Object.assign(x, { extra: true }),
      (x) => Reflect.deleteProperty(x, "native_session_id"),
      (x) => Object.assign(x.stored_event, { extra: true }),
      (x) => Reflect.deleteProperty(x.stored_event, "ts"),
    ];
    const corrupt = [
      Buffer.from(`${JSON.stringify(rows[0])}\n\n${JSON.stringify(rows[1])}\n`),
      Buffer.from(`${JSON.stringify(rows[0])}\n{bad\n`),
      Buffer.concat([Buffer.from(JSON.stringify(rows[0])), Buffer.from([255, 10])]),
      Buffer.from(`${JSON.stringify(rows[0])}\n{bad\n{torn`),
      ...mutations.map((mutate) => {
        const copy = clone(rows);
        mutate(copy[1]);
        return Buffer.from(`${copy.map((x) => JSON.stringify(x)).join("\n")}\n`);
      }),
    ];
    for (const [index, bytes] of corrupt.entries()) {
      await writeFile(path, bytes);
      const mirrorCount = mirrored.length;
      await expect(store.append(correlation, input(`bad-${index}`))).rejects.toThrow();
      expect(readFileSync(path)).toEqual(bytes);
      expect(mirrored).toHaveLength(mirrorCount);
    }
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repairs torn first record but read-only replay refuses it", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const store = new TraceStore(options(dir));
    const path = traceJournalPath(dir, "safe");
    await store.readConversation("safe");
    await writeFile(path, "{torn");
    const torn = await readFile(path);
    await expect(store.readConversation("safe")).rejects.toThrow();
    expect(await readFile(path)).toEqual(torn);
    await store.append(correlation, input());
    expect(await store.readConversation("safe")).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test(
  "rejects hostile journal entry matrix without mutation or mirrors",
  async () => {
    const attacks = [
      {
        name: "symlink to external regular file",
        place: (path: string, external: string) => symlinkSync(external, path),
      },
      {
        name: "directory containing sentinel",
        place: (path: string) => {
          mkdirSync(path, { mode: 0o700 });
          writeFileSync(join(path, "sentinel"), "directory-sentinel");
        },
      },
      ...(process.platform === "win32"
        ? []
        : [
            {
              name: "POSIX FIFO",
              place: async (path: string) => {
                const made = await runProcess("mkfifo", [path]);
                if (made.spawnError || made.timedOut || made.code !== 0 || made.signal !== null)
                  throw new Error(`mkfifo failed: ${made.stderr}`);
              },
            },
          ]),
      {
        name: "hardlink to external regular file",
        place: (path: string, external: string) => linkSync(external, path),
      },
      {
        name: "regular file mode 0644",
        place: (path: string) => chmodSync(path, 0o644),
      },
    ];
    for (const [index, attack] of attacks.entries())
      for (const operation of ["read", "append"] as const) {
        const parent = await mkdtemp(join(tmpdir(), "trace-journal-attack-"));
        chmodSync(parent, 0o755);
        const dir = join(parent, "store");
        const external = join(parent, "external");
        const id = `attacked-${index}-${operation}`;
        const mirrored: unknown[] = [];
        try {
          const store = new TraceStore({
            ...options(dir),
            mirror: { mirrorTrace: (value) => mirrored.push(value) },
          });
          await store.append({ ...correlation, conversation_id: id }, input(`seed-${id}`));
          mirrored.length = 0;
          const path = traceJournalPath(dir, id);
          const validBytes = readFileSync(path);
          rmSync(path, { force: true });
          writeFileSync(external, validBytes, { mode: 0o600 });
          if (attack.name.includes("mode 0644")) writeFileSync(path, validBytes, { mode: 0o600 });
          await attack.place(path, external);
          const before = lstatSync(path);
          const attackedBytes = before.isFile() ? readFileSync(path) : undefined;
          const linkTarget = before.isSymbolicLink() ? readlinkSync(path) : undefined;
          const entries = before.isDirectory() ? readdirSync(path) : undefined;
          const sentinel = before.isDirectory() ? readFileSync(join(path, "sentinel")) : undefined;

          if (before.isFIFO()) {
            const moduleUrl = new URL("../../src/orchestrator/trace/store.ts", import.meta.url)
              .href;
            const child = await runProcess(process.execPath, [
              "-e",
              `import { TraceStore } from ${JSON.stringify(moduleUrl)};
let mirrors=0; const store=new TraceStore({dir:${JSON.stringify(dir)},mirror:{mirrorTrace:()=>mirrors++}});
const correlation=${JSON.stringify({ ...correlation, conversation_id: id })};
try { await ${operation === "read" ? `store.readConversation(${JSON.stringify(id)})` : `store.append(correlation,${JSON.stringify(input(id))})`}; console.log(JSON.stringify({result:"fulfilled",mirrors,error:null})); }
catch (error) { console.log(JSON.stringify({result:"rejected",mirrors,error:error instanceof Error ? error.message : String(error)})); }`,
            ]);
            expect(child.spawnError).toBeUndefined();
            expect(child.timedOut).toBe(false);
            expect(child.signal).toBeNull();
            expect(child.code).toBe(0);
            expect(child.stderr).toBe("");
            expect(JSON.parse(child.stdout.trim())).toEqual({
              result: "rejected",
              mirrors: 0,
              error: "trace journal: unsafe journal",
            });
          } else if (operation === "read")
            await expect(store.readConversation(id)).rejects.toThrow();
          else
            await expect(
              store.append({ ...correlation, conversation_id: id }, input(id)),
            ).rejects.toThrow();

          const after = lstatSync(path);
          expect([after.dev, after.ino, after.mode, after.nlink]).toEqual([
            before.dev,
            before.ino,
            before.mode,
            before.nlink,
          ]);
          expect([
            after.isSymbolicLink(),
            after.isDirectory(),
            after.isFIFO(),
            after.isFile(),
          ]).toEqual([
            before.isSymbolicLink(),
            before.isDirectory(),
            before.isFIFO(),
            before.isFile(),
          ]);
          expect(readFileSync(external)).toEqual(validBytes);
          if (attackedBytes) expect(readFileSync(path)).toEqual(attackedBytes);
          if (linkTarget) expect(readlinkSync(path)).toBe(linkTarget);
          if (sentinel) expect(readFileSync(join(path, "sentinel"))).toEqual(sentinel);
          if (entries) expect(readdirSync(path)).toEqual(entries);
          expect(existsSync(`${path}.lock`)).toBe(false);
          expect(mirrored).toHaveLength(0);
        } finally {
          await rm(parent, { recursive: true, force: true });
        }
      }
  },
  { timeout: 10_000 },
);

test("rejects hostile store roots without mutation", async () => {
  const attacks = [
    ["symlink", (path: string, external: string) => symlinkSync(external, path)],
    ["file", (path: string) => writeFileSync(path, "root-bytes")],
    [
      "mode",
      (path: string) => {
        mkdirSync(path, { mode: 0o755 });
        chmodSync(path, 0o755);
        expect(lstatSync(path).mode & 0o777).toBe(0o755);
        writeFileSync(join(path, "sentinel"), "inside-bytes");
      },
    ],
  ] as const;
  for (const [name, place] of attacks) {
    const parent = await mkdtemp(join(tmpdir(), "trace-root-attack-"));
    const root = join(parent, "store");
    const external = join(parent, "external");
    mkdirSync(external);
    chmodSync(external, 0o700);
    expect(lstatSync(external).mode & 0o777).toBe(0o700);
    writeFileSync(join(external, "sentinel"), "external-bytes");
    try {
      place(root, external);
      const before = lstatSync(root);
      const rootEntries = name === "mode" ? readdirSync(root) : undefined;
      const rootSentinel = name === "mode" ? readFileSync(join(root, "sentinel")) : undefined;
      expect(() => new TraceStore(options(root))).toThrow();
      const after = lstatSync(root);
      expect([after.dev, after.ino, after.mode, after.isSymbolicLink(), after.isFile()]).toEqual([
        before.dev,
        before.ino,
        before.mode,
        before.isSymbolicLink(),
        before.isFile(),
      ]);
      if (name === "symlink") expect(readlinkSync(root)).toBe(external);
      if (name === "file") expect(readFileSync(root, "utf8")).toBe("root-bytes");
      if (rootEntries) expect(readdirSync(root)).toEqual(rootEntries);
      if (rootSentinel) expect(readFileSync(join(root, "sentinel"))).toEqual(rootSentinel);
      expect(existsSync(join(root, "conversations"))).toBe(false);
      expect(existsSync(join(root, "journal"))).toBe(false);
      expect(existsSync(`${root}.lock`)).toBe(false);
      expect(readdirSync(external)).toEqual(["sentinel"]);
      expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("external-bytes");
    } finally {
      await rm(parent, { recursive: true, force: true });
    }
  }

  const parent = await mkdtemp(join(tmpdir(), "trace-root-parent-"));
  const blocked = join(parent, "blocked");
  try {
    writeFileSync(blocked, "parent-bytes");
    expect(() => new TraceStore(options(join(blocked, "store")))).toThrow();
    expect(readFileSync(blocked, "utf8")).toBe("parent-bytes");
  } finally {
    await rm(parent, { recursive: true, force: true });
  }
});

test("rejects hostile conversations directories without mutation, artifacts, or mirrors", async () => {
  const attacks = [
    ["symlink", (path: string, external: string) => symlinkSync(external, path)],
    ["file", (path: string) => writeFileSync(path, "conversation-bytes")],
    [
      "mode",
      (path: string) => {
        mkdirSync(path, { mode: 0o755 });
        chmodSync(path, 0o755);
        expect(lstatSync(path).mode & 0o777).toBe(0o755);
        writeFileSync(join(path, "sentinel"), "inside-bytes");
      },
    ],
  ] as const;
  for (const [name, place] of attacks)
    for (const operation of ["read", "append"] as const) {
      const parent = await mkdtemp(join(tmpdir(), "trace-conversations-attack-"));
      const root = join(parent, "store");
      const external = join(parent, "external");
      const conversations = join(root, "conversations");
      const mirrors: unknown[] = [];
      try {
        const store = new TraceStore({
          ...options(root),
          mirror: { mirrorTrace: (value) => mirrors.push(value) },
        });
        expect(lstatSync(root).mode & 0o777).toBe(0o700);
        mkdirSync(external);
        chmodSync(external, 0o700);
        expect(lstatSync(external).mode & 0o777).toBe(0o700);
        writeFileSync(join(external, "sentinel"), "external-bytes");
        place(conversations, external);
        const before = lstatSync(conversations);
        const action =
          operation === "read"
            ? store.readConversation("attacked")
            : store.append({ ...correlation, conversation_id: "attacked" }, input("attacked"));
        await expect(action).rejects.toThrow();
        const after = lstatSync(conversations);
        expect([after.dev, after.ino, after.mode, after.isSymbolicLink(), after.isFile()]).toEqual([
          before.dev,
          before.ino,
          before.mode,
          before.isSymbolicLink(),
          before.isFile(),
        ]);
        if (name === "symlink") expect(readlinkSync(conversations)).toBe(external);
        if (name === "file") expect(readFileSync(conversations, "utf8")).toBe("conversation-bytes");
        if (name === "mode") {
          expect(readdirSync(conversations)).toEqual(["sentinel"]);
          expect(readFileSync(join(conversations, "sentinel"), "utf8")).toBe("inside-bytes");
        }
        expect(readdirSync(external)).toEqual(["sentinel"]);
        expect(readFileSync(join(external, "sentinel"), "utf8")).toBe("external-bytes");
        expect(existsSync(traceJournalPath(root, "attacked"))).toBe(false);
        expect(existsSync(`${traceJournalPath(root, "attacked")}.lock`)).toBe(false);
        expect(mirrors).toHaveLength(0);
      } finally {
        await rm(parent, { recursive: true, force: true });
      }
    }
});

test("rejects invalid and duplicate generated values without side effects", async () => {
  const invalid: Array<[unknown, unknown]> = [
    ["bad", "2026-01-01T00:00:00.000Z"],
    ["00000000-0000-4000-8000-00000000000A", "2026-01-01T00:00:00.000Z"],
    [{ toString: () => "00000000-0000-4000-8000-000000000001" }, "2026-01-01T00:00:00.000Z"],
    [Symbol("id"), "2026-01-01T00:00:00.000Z"],
    ["00000000-0000-4000-8000-000000000001", "bad"],
    ["00000000-0000-4000-8000-000000000001", "2026-01-01T00:00:00Z"],
    ["00000000-0000-4000-8000-000000000001", { toString: () => "2026-01-01T00:00:00.000Z" }],
    ["00000000-0000-4000-8000-000000000001", Symbol("ts")],
  ];
  for (const [index, [eventId, now]] of invalid.entries()) {
    const dir = await mkdtemp(join(tmpdir(), "trace-"));
    try {
      const mirrored: unknown[] = [];
      const store = new TraceStore({
        dir,
        eventId: () => eventId as string,
        now: () => now as string,
        mirror: { mirrorTrace: (x) => mirrored.push(x) },
      });
      await expect(store.append(correlation, input(`invalid-${index}`))).rejects.toThrow(
        "trace journal: invalid generated value",
      );
      expect(await readFile(traceJournalPath(dir, "safe"))).toEqual(Buffer.alloc(0));
      expect(mirrored).toHaveLength(0);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  }
  const dir = await mkdtemp(join(tmpdir(), "trace-"));
  try {
    const mirrored: unknown[] = [];
    const duplicate = "00000000-0000-4000-8000-000000000001";
    const store = new TraceStore({
      dir,
      eventId: () => duplicate,
      now: () => "2026-01-01T00:00:00.000Z",
      mirror: { mirrorTrace: (x) => mirrored.push(x) },
    });
    await store.append(correlation, input("one"));
    const path = traceJournalPath(dir, "safe");
    const before = await readFile(path);
    await expect(store.append(correlation, input("two"))).rejects.toThrow(
      "trace journal: invalid generated value",
    );
    expect(await readFile(path)).toEqual(before);
    expect(mirrored).toHaveLength(1);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("repeated append reads only a bounded tail instead of replaying the full journal", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-tail-cursor-"));
  const realRead = fs.readSync;
  let requestedBytes = 0;
  const readSpy = spyOn(fs, "readSync").mockImplementation(((
    fd,
    buffer,
    offset,
    length,
    position,
  ) => {
    requestedBytes += length;
    return realRead(fd, buffer, offset, length, position);
  }) as typeof fs.readSync);
  try {
    const store = new TraceStore(options(dir));
    for (let index = 0; index < 80; index++)
      await store.append(
        { ...correlation, attempt_id: `attempt-${index}` },
        input(`cursor-${index}`, `message-${index}`),
      );
    const journalBytes = lstatSync(traceJournalPath(dir, "safe")).size;
    expect(requestedBytes).toBeLessThan(journalBytes * 15);
  } finally {
    readSpy.mockRestore();
    await rm(dir, { recursive: true, force: true });
  }
});

test("append cursor validates cross-store tails and preserves monotonic order", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-tail-cross-store-"));
  try {
    const first = new TraceStore(options(dir));
    const second = new TraceStore({
      ...options(dir),
      eventId: (() => {
        let n = 5_000;
        return () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}`;
      })(),
    });
    for (let index = 0; index < 12; index++) {
      const store = index % 2 ? second : first;
      await store.append(
        { ...correlation, attempt_id: `cross-${index}` },
        input(`cross-${index}`, `message-${index}`),
      );
    }
    const records = await first.readConversation("safe");
    expect(records.map(({ stored_event }) => stored_event.seq)).toEqual(
      Array.from({ length: 12 }, (_, index) => index + 1),
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("same-size middle rewrite and empty truncation authoritatively rebuild registry state", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-authoritative-rebuild-"));
  const traceDir = join(root, "trace");
  try {
    const registry = new DurableArtifactRegistry({ dir: join(root, "registry") });
    const store = new TraceStore({ ...options(traceDir), artifactRegistry: registry });
    await store.append(correlation, {
      idempotency_key: "artifact-one",
      event: {
        type: "artifact_created",
        payload: { artifact_id: "one", artifact_type: "plan", ref: "artifact/one" },
      },
    });
    await store.append(
      { ...correlation, attempt_id: "last" },
      {
        idempotency_key: "artifact-last",
        event: {
          type: "artifact_created",
          payload: { artifact_id: "last", artifact_type: "plan", ref: "artifact/end" },
        },
      },
    );
    const oldOpaque = registry.register("safe", "artifact/one");
    await store.readConversation("safe");
    const journal = traceJournalPath(traceDir, "safe");
    const lines = readFileSync(journal, "utf8").trimEnd().split("\n");
    const first = JSON.parse(lines[0] ?? "null");
    first.stored_event.event.payload.ref = "artifact/two";
    lines[0] = JSON.stringify(first);
    const rewritten = `${lines.join("\n")}\n`;
    expect(Buffer.byteLength(rewritten)).toBe(lstatSync(journal).size);
    writeFileSync(journal, rewritten, { mode: 0o600 });
    await store.readConversation("safe");
    expect(registry.resolve("safe", oldOpaque)).toBeNull();
    const rewrittenOpaque = registry.register("safe", "artifact/two");
    expect(registry.resolve("safe", rewrittenOpaque)).toEqual({ internalRef: "artifact/two" });

    writeFileSync(journal, "", { mode: 0o600 });
    expect(await store.readConversation("safe")).toEqual([]);
    expect(registry.resolve("safe", rewrittenOpaque)).toBeNull();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("registry capacity is rejected before a durable append can poison journal or cursor", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-registry-preflight-"));
  const traceDir = join(root, "trace");
  try {
    const registry = new DurableArtifactRegistry({
      dir: join(root, "registry"),
      limits: {
        maxConversations: 1,
        maxReferencesPerConversation: 1,
        maxTotalReferences: 1,
        maxRetiredKeys: 2,
        maxAssignments: 4,
      },
    });
    const store = new TraceStore({ ...options(traceDir), artifactRegistry: registry });
    await store.append(correlation, {
      idempotency_key: "within-cap",
      event: {
        type: "artifact_created",
        payload: { artifact_id: "one", artifact_type: "plan", ref: "artifact/one" },
      },
    });
    const journal = traceJournalPath(traceDir, "safe");
    const before = readFileSync(journal);
    await expect(
      store.append(
        { ...correlation, attempt_id: "over-cap" },
        {
          idempotency_key: "over-cap",
          event: {
            type: "artifact_created",
            payload: { artifact_id: "two", artifact_type: "plan", ref: "artifact/two" },
          },
        },
      ),
    ).rejects.toThrow("reference limit reached");
    expect(readFileSync(journal)).toEqual(before);
    expect(await store.readConversation("safe")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("session-reference capacity is rejected before its trace record becomes durable", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-session-preflight-"));
  const traceDir = join(root, "trace");
  const history = (session: string): TraceEvent => ({
    type: "native_history_reconciled",
    payload: {
      public_session_ref: session,
      status: "reconciled",
      imported_turn_count: 0,
      imported_tool_count: 0,
      provenance_refs: [],
      evidence_refs: [],
      completeness_reason: "complete",
    },
  });
  try {
    const registry = new DurableArtifactRegistry({
      dir: join(root, "registry"),
      limits: {
        maxConversations: 1,
        maxReferencesPerConversation: 1,
        maxTotalReferences: 1,
        maxRetiredKeys: 1,
        maxAssignments: 1,
      },
    });
    const store = new TraceStore({ ...options(traceDir), artifactRegistry: registry });
    await store.append(correlation, {
      idempotency_key: "history-one",
      event: history("native-one"),
    });
    const journal = traceJournalPath(traceDir, "safe");
    const before = readFileSync(journal);
    await expect(
      store.append(
        { ...correlation, attempt_id: "history-two" },
        { idempotency_key: "history-two", event: history("native-two") },
      ),
    ).rejects.toThrow("assignment limit reached");
    expect(readFileSync(journal)).toEqual(before);
    expect(await store.readConversation("safe")).toHaveLength(1);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("append recovers a complete record missing its required separator without poisoning replay", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-missing-separator-"));
  try {
    const seed = new TraceStore(options(dir));
    const first = await seed.append(correlation, input("one", "one"));
    const journal = traceJournalPath(dir, "safe");
    writeFileSync(journal, readFileSync(journal, "utf8").trimEnd(), { mode: 0o600 });
    const live = new TraceStore({ dir });
    await live.readConversation("safe");
    const malformedTail = {
      stored_event: {
        ...first,
        event_id: "00000000-0000-4000-8000-000000000002",
        seq: 2,
        attempt_id: "external",
        idempotency_key: "external",
        event: event("external"),
      },
      native_session_id: null,
    };
    await writeFile(journal, `${JSON.stringify(malformedTail)}\n`, { flag: "a" });
    const recovered = await live.append(
      { ...correlation, attempt_id: "after-recovery" },
      input("after-recovery", "after-recovery"),
    );
    expect(recovered.seq).toBe(2);
    const replayed = await new TraceStore({ dir }).readConversation("safe");
    expect(replayed.map(({ stored_event }) => stored_event.idempotency_key)).toEqual([
      "one",
      "after-recovery",
    ]);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("external growth cannot hide a middle rewrite from the artifact registry", async () => {
  const root = await mkdtemp(join(tmpdir(), "trace-grow-rewrite-"));
  const traceDir = join(root, "trace");
  const registryDir = join(root, "registry");
  try {
    const registry = new DurableArtifactRegistry({ dir: registryDir });
    const store = new TraceStore({ dir: traceDir, artifactRegistry: registry });
    await store.append(correlation, {
      idempotency_key: "artifact-one",
      event: {
        type: "artifact_created",
        payload: { artifact_id: "one", artifact_type: "plan", ref: "artifact/one" },
      },
    });
    await store.append(
      { ...correlation, attempt_id: "padding" },
      input("padding", "x".repeat(1_200)),
    );
    const oldOpaque = registry.register("safe", "artifact/one");
    const journal = traceJournalPath(traceDir, "safe");
    writeFileSync(journal, readFileSync(journal, "utf8").replace("artifact/one", "artifact/two"), {
      mode: 0o600,
    });
    const external = new TraceStore({ dir: traceDir });
    await external.append(
      { ...correlation, attempt_id: "external" },
      input("external", "external"),
    );
    const authority = new DurableArtifactRegistry({ dir: registryDir });
    await new TraceStore({ dir: traceDir, artifactRegistry: authority }).readConversation("safe");
    const rewrittenOpaque = authority.register("safe", "artifact/two");

    await store.append({ ...correlation, attempt_id: "after" }, input("after", "after"));
    expect(registry.resolve("safe", oldOpaque)).toBeNull();
    expect(registry.resolve("safe", rewrittenOpaque)).toEqual({ internalRef: "artifact/two" });
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("mutating an idempotent result cannot alter the store cursor", async () => {
  const dir = await mkdtemp(join(tmpdir(), "trace-idempotent-result-"));
  try {
    const store = new TraceStore(options(dir));
    const request = input("same", "original");
    const original = await store.append(correlation, request);
    const duplicate = await store.append(correlation, request);
    (duplicate.event.payload as { content: string }).content = "mutated";
    expect(await store.append(correlation, request)).toEqual(original);
    const replayed = await store.readConversation("safe");
    expect((replayed[0]?.stored_event.event.payload as { content: string }).content).toBe(
      "original",
    );
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
