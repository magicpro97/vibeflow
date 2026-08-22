import { expect, test } from "bun:test";
import type { Engine } from "../../src/core/types.js";
import type {
  ArtifactRegistry,
  ArtifactResolution,
} from "../../src/orchestrator/trace/artifacts.js";
import {
  projectPublicStoredTrace,
  projectPublicTrace,
} from "../../src/orchestrator/trace/project.js";
import type {
  OpaqueArtifactId,
  OpaqueSessionRef,
  PublicTraceProjection,
  TraceAppendInput,
  TraceEvent,
} from "../../src/orchestrator/trace/types.js";
import { isValidParticipantModel } from "../../src/orchestrator/trace/validation.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;
type _EngineIsCanonical = Assert<
  Equal<import("../../src/orchestrator/trace/types.js").Engine, Engine>
>;
type _RoleFieldsAreCanonical = Assert<
  Equal<import("../../src/orchestrator/trace/types.js").Participant["model"], string | null>
>;
void (0 as unknown as _EngineIsCanonical);
void (0 as unknown as _RoleFieldsAreCanonical);

const event = {
  type: "tool_action",
  payload: {
    tool: "safe",
    action: "open",
    status: "completed",
    input_ref: "artifact://secret/input",
    output_ref: null,
  },
} as const satisfies TraceEvent;
const append: TraceAppendInput = { idempotency_key: "key", event };
void append;
const testOpaqueIds = new Map<string, OpaqueArtifactId>();
const testRegistry: ArtifactRegistry = {
  register(conversationId, internalRef) {
    const key = `${conversationId}\0${internalRef}`;
    let id = testOpaqueIds.get(key);
    if (!id) {
      id = `artifact_test_${testOpaqueIds.size}` as OpaqueArtifactId;
      testOpaqueIds.set(key, id);
    }
    return id;
  },
  resolve() {
    return null;
  },
  sessionRef(conversationId, nativeSessionId) {
    return `session_test_${conversationId}_${nativeSessionId.length}` as OpaqueSessionRef;
  },
  prepareProjection(inputs) {
    const staged = new Map<string, OpaqueArtifactId>();
    const ids = inputs.map((input) => {
      if (input.kind === "session")
        return `session_test_${input.conversationId}_${input.value.length}` as OpaqueSessionRef;
      const key = `${input.conversationId}\0${input.value}`;
      let id = testOpaqueIds.get(key) ?? staged.get(key);
      if (!id) {
        id = `artifact_test_${testOpaqueIds.size + staged.size}` as OpaqueArtifactId;
        staged.set(key, id);
      }
      return id;
    });
    return {
      ids,
      commit() {
        for (const [key, id] of staged) testOpaqueIds.set(key, id);
      },
      rollback() {},
    };
  },
};
const context = { conversationId: "conversation-a", artifactRegistry: testRegistry };
// @ts-expect-error idempotency_key is required
const missingKey: TraceAppendInput = { event };
void missingKey;
const mismatched: TraceEvent = {
  type: "tool_action",
  // @ts-expect-error type/payload remain correlated
  payload: { content: "wrong", target_participants: "all" },
};
void mismatched;
const projected = projectPublicTrace(event, context);
type _ProjectorIsSpecific = Assert<
  Equal<typeof projected, Extract<PublicTraceProjection, { type: "tool_action" }>>
>;
void (0 as unknown as _ProjectorIsSpecific);
const contextIsRequired = () => {
  // @ts-expect-error public projection always requires a conversation domain
  projectPublicTrace(event);
};
void contextIsRequired;

test("sole projector strips dangerous fields, opaque refs, and sanitizes recursively without mutation", () => {
  const unsafe = {
    type: "artifact_created",
    payload: {
      artifact_id: "id\u0000",
      artifact_type: "plan",
      ref: "artifact://secret/input",
      native_session_id: "native-secret",
      prompt_template: "token=abc.def.ghi",
      raw_env: { KEY: "secret" },
      nested: {
        raw_env: "no",
        path: "/Users/alice/private folder/secret.txt",
        credential: "https://user:password@example.test/path",
        token: "ghp_abcdefghijklmnopqrstuvwxyz1234567890",
      },
    },
  } as unknown as TraceEvent;
  const before = JSON.stringify(unsafe);
  const output = projectPublicTrace(unsafe, context);
  const json = JSON.stringify(output);
  expect(JSON.stringify(unsafe)).toBe(before);
  expect(output.type).toBe("artifact_created");
  expect(json).not.toContain("native-secret");
  expect(json).not.toContain("token=");
  expect(json).not.toContain("/Users/alice");
  expect(json).not.toContain("C:\\Users");
  expect(json).not.toContain("password");
  expect(json).not.toContain("ghp_");
  expect(json).not.toContain("artifact://secret/input");
});

test("projector preserves safe values and canonical engine", () => {
  const output = projectPublicTrace(
    {
      type: "participant_bound",
      payload: {
        participant_id: "p",
        engine: "codex",
        model: "provider/model-v2.1:preview",
        prompt_hash: "safe",
        tools: ["read"],
        sandbox: "read-only",
      },
    },
    context,
  );
  expect(output).toMatchObject({
    type: "participant_bound",
    payload: {
      participant_id: "p",
      engine: "codex",
      model: "provider/model-v2.1:preview",
      prompt_hash: "safe",
      tools: ["read"],
      sandbox: "read-only",
    },
  });
});

test("projector uses opaque domain-separated refs and redacts hostile public text", () => {
  const artifact = "artifact://😀";
  const otherArtifact = "artifact://😁";
  const session = "session://😀";
  const unsafe = JSON.parse(
    `{"type":"native_history_reconciled","payload":{"public_session_ref":"${session}","status":"reconciled","imported_turn_count":1,"imported_tool_count":1,"provenance_refs":["${artifact}"],"evidence_refs":["${otherArtifact}"],"completeness_reason":"safe ${session} https://example.test/a api_key=multi word value; token: 'two words'\\u202E ghp_abcdefghijklmnopqrstuvwxyz1234567890 AKIAABCDEFGHIJKLMNOP Bearer abc.def.ghi Basic dXNlcjpwYXNz https://u:p@example.test/?token=x /root/a /workspace/b /srv/c ../secret ./secret C:\\\\work\\\\x"}}`,
  ) as TraceEvent;
  const duplicate = projectPublicTrace(
    {
      type: "artifact_created",
      payload: { artifact_id: "safe", artifact_type: "plan", ref: artifact },
    },
    context,
  );
  const output = projectPublicTrace(unsafe, context);
  const json = JSON.stringify(output);
  const payload = output.payload as unknown as Record<string, unknown>;
  const stable = projectPublicTrace(
    {
      type: "artifact_created",
      payload: { artifact_id: "safe", artifact_type: "plan", ref: artifact },
    },
    context,
  );
  expect(duplicate.payload.ref).toBe(stable.payload.ref);
  expect(duplicate.payload.ref).not.toBe((payload.evidence_refs as string[])[0]);
  expect(payload.public_session_ref).not.toBe(duplicate.payload.ref);
  for (const raw of [
    artifact,
    otherArtifact,
    session,
    "api_key",
    "token",
    "ghp_",
    "AKIA",
    "Bearer",
    "Basic",
    "/root",
    "/workspace",
    "/srv",
    "../",
    "./secret",
    "C:\\work",
    "\u202e",
  ])
    expect(json).not.toContain(raw);
  expect(json).toContain("https://example.test/a");
  expect(json).toContain("safe");
});

test("projector redacts secrets without consuming safe text", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature_value_123456";
  const output = projectPublicTrace(
    {
      type: "artifact_created",
      payload: {
        artifact_id: "safe",
        artifact_type: "plan",
        ref: "artifact://safe",
        note: `password=secret\nkeep this safe sentence ${jwt} foo.bar.baz 1.2.3 open /tmp/a then visit https://example.test/a`,
      },
    } as unknown as TraceEvent,
    context,
  );
  const note = (output.payload as unknown as { note: string }).note;
  expect(note).not.toContain("secret");
  expect(note).not.toContain(jwt);
  expect(note).toContain("keep this safe sentence");
  expect(note).toContain("foo.bar.baz");
  expect(note).toContain("1.2.3");
  expect(note).toContain("then visit https://example.test/a");
  expect(note).not.toContain("/tmp/a");
});

test("projector drops prototype-pollution keys without mutation", () => {
  const unsafe = JSON.parse(
    '{"type":"artifact_created","payload":{"artifact_id":"safe","artifact_type":"plan","ref":"artifact://x","__proto__":{"isAdmin":true},"nested":{"constructor":{"isAdmin":true},"prototype":{"isAdmin":true}}}}',
  ) as TraceEvent;
  const output = projectPublicTrace(unsafe, context);
  expect((output as unknown as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  expect((output.payload as unknown as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  expect(({} as { isAdmin?: boolean }).isAdmin).toBeUndefined();
  expect(JSON.stringify(output)).not.toContain("isAdmin");
});

test("projector redacts complete private keys, precise tokens, and path-valued fields", () => {
  const privateKey =
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----";
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature";
  const asia = "ASIA1234567890ABCDEF";
  const output = projectPublicTrace(
    {
      type: "artifact_created",
      payload: {
        artifact_id: "safe",
        artifact_type: "plan",
        ref: "artifact://safe",
        note: `${privateKey}\n${jwt} ${asia} "/tmp/path with spaces/file.txt"; "C:\\work dir\\file.txt"; "./local path/file"; "../parent path/file"; https://example.test/a path`,
        posix_path: "/tmp/path with spaces/file.txt",
        windows_path: "C:\\work dir\\file.txt",
      },
    } as unknown as TraceEvent,
    context,
  );
  const json = JSON.stringify(output);
  for (const raw of [
    privateKey,
    jwt,
    asia,
    "/tmp/path with spaces/file.txt",
    "C:\\work dir\\file.txt",
    "./local path/file",
    "../parent path/file",
  ])
    expect(json).not.toContain(raw);
  expect(json).toContain("https://example.test/a");
});

test("projector redacts named credentials and local path dialects without consuming safe URLs", () => {
  const unsafe = {
    type: "artifact_created",
    payload: {
      artifact_id: "safe",
      artifact_type: "plan",
      ref: "artifact://safe",
      note: [
        "keep ordinary prose",
        "https://example.test/safe/path",
        "AWS_SECRET_ACCESS_KEY=plainsecretvalue",
        "GITHUB_TOKEN=plainvalue",
        "C:/Users/alice/.ssh/id_rsa",
        "\\\\server\\share\\secret",
        "src/private/evidence.json",
      ].join("; "),
    },
  } as unknown as TraceEvent;
  const output = projectPublicTrace(unsafe, context);
  const note = (output.payload as unknown as { note: string }).note;
  for (const raw of [
    "plainsecretvalue",
    "plainvalue",
    "C:/Users/alice",
    "\\\\server\\share",
    "src/private/evidence.json",
  ])
    expect(note).not.toContain(raw);
  expect(note).toContain("keep ordinary prose");
  expect(note).toContain("https://example.test/safe/path");
});

test("artifact and session projection fail closed without an explicit registry", () => {
  expect(() =>
    projectPublicTrace(
      {
        type: "artifact_created",
        payload: { artifact_id: "plan", artifact_type: "plan", ref: "private/plan.json" },
      },
      { conversationId: "conversation-a" },
    ),
  ).toThrow("artifact registry required");
  expect(() =>
    projectPublicStoredTrace(
      {
        stored_event: {
          workflow_id: "workflow",
          conversation_id: "conversation-a",
          revision_id: "revision",
          run_id: "run",
          turn_id: "turn",
          operation_id: "operation",
          attempt_id: "attempt",
          event_id: "00000000-0000-4000-8000-000000000001",
          seq: 1,
          ts: "2026-08-22T00:00:00.000Z",
          idempotency_key: "internal",
          event: { type: "user_message", payload: { content: "safe", target_participants: "all" } },
        },
        native_session_id: "native-session",
      },
      { conversationId: "conversation-a" },
    ),
  ).toThrow("artifact registry required");
});

test("legacy registries fail closed before multi-identity mutation and cache one unique identity", () => {
  const mutations: string[] = [];
  const legacy: ArtifactRegistry = {
    register(_conversationId, internalRef) {
      mutations.push(`artifact:${internalRef}`);
      if (mutations.length === 2) throw new Error("second register mutated then failed");
      return `artifact_legacy_${internalRef.length}` as OpaqueArtifactId;
    },
    resolve() {
      return null;
    },
    sessionRef(_conversationId, nativeSessionId) {
      mutations.push(`session:${nativeSessionId}`);
      return `session_legacy_${nativeSessionId.length}` as OpaqueSessionRef;
    },
  };
  expect(() =>
    projectPublicTrace(
      {
        type: "artifact_updated",
        payload: {
          artifact_id: "plan",
          artifact_type: "plan",
          ref: "artifact/private-first",
          previous_ref: "artifact/private-second",
        },
      },
      { conversationId: "conversation-a", artifactRegistry: legacy },
    ),
  ).toThrow("atomic projection registry required");
  expect(mutations).toEqual([]);

  const repeated = projectPublicTrace(
    {
      type: "tool_action",
      payload: {
        tool: "read",
        action: "inspect",
        status: "completed",
        input_ref: "artifact/repeated",
        output_ref: "artifact/repeated",
      },
    },
    { conversationId: "conversation-a", artifactRegistry: legacy },
  );
  expect(repeated.payload.input_ref).toBe(repeated.payload.output_ref);
  expect(mutations).toEqual(["artifact:artifact/repeated"]);

  mutations.length = 0;
  expect(() =>
    projectPublicStoredTrace(
      {
        stored_event: {
          workflow_id: "workflow",
          conversation_id: "conversation-a",
          revision_id: "revision",
          run_id: "run",
          turn_id: "turn",
          operation_id: "operation",
          attempt_id: "attempt",
          evidence_refs: ["artifact/private"],
          event_id: "00000000-0000-4000-8000-000000000001",
          seq: 1,
          ts: "2026-08-22T00:00:00.000Z",
          idempotency_key: "internal",
          event: {
            type: "user_message",
            payload: { content: "safe", target_participants: "all" },
          },
        },
        native_session_id: "native-session",
      },
      { conversationId: "conversation-a", artifactRegistry: legacy },
    ),
  ).toThrow("atomic projection registry required");
  expect(mutations).toEqual([]);
});

test("stored-envelope projector preserves safe correlation and drops internal control fields", () => {
  const reverse = new Map<string, ArtifactResolution>();
  const registry: ArtifactRegistry = {
    register(conversationId, internalRef) {
      const opaque = `artifact_${conversationId}_${reverse.size}` as OpaqueArtifactId;
      reverse.set(`${conversationId}\0${opaque}`, { internalRef });
      return opaque;
    },
    resolve(conversationId, opaqueId) {
      return reverse.get(`${conversationId}\0${opaqueId}`) ?? null;
    },
    sessionRef(conversationId, nativeSessionId) {
      return `session_${conversationId}_${nativeSessionId.length}` as OpaqueSessionRef;
    },
    prepareProjection(inputs) {
      const staged = new Map<
        string,
        { id: OpaqueArtifactId; conversationId: string; internalRef: string }
      >();
      const ids = inputs.map((input) => {
        if (input.kind === "session")
          return `session_${input.conversationId}_${input.value.length}` as OpaqueSessionRef;
        const key = `${input.conversationId}\0${input.value}`;
        let stagedValue = staged.get(key);
        if (!stagedValue) {
          stagedValue = {
            id: `artifact_${input.conversationId}_${reverse.size + staged.size}` as OpaqueArtifactId,
            conversationId: input.conversationId,
            internalRef: input.value,
          };
          staged.set(key, stagedValue);
        }
        return stagedValue.id;
      });
      return {
        ids,
        commit() {
          for (const value of staged.values())
            reverse.set(`${value.conversationId}\0${value.id}`, value);
        },
        rollback() {},
      };
    },
  };
  const record = {
    stored_event: {
      workflow_id: "workflow",
      conversation_id: "conversation-a",
      revision_id: "revision",
      run_id: "run",
      turn_id: "turn",
      operation_id: "operation",
      attempt_id: "attempt",
      unit_id: "unit",
      participant_id: "participant",
      role_ref: "role",
      role_resolved_hash: "role-hash",
      skill_refs: ["skill"],
      skill_resolved_hashes: ["skill-hash"],
      engine: "codex" as const,
      evidence_refs: ["private/evidence.json"],
      parent_attempt_id: "parent-attempt",
      event_id: "00000000-0000-4000-8000-000000000001",
      seq: 7,
      ts: "2026-08-22T00:00:00.000Z",
      idempotency_key: "internal-idempotency",
      event,
    },
    native_session_id: "native-session-secret",
  };
  const output = projectPublicStoredTrace(record, {
    conversationId: "conversation-a",
    artifactRegistry: registry,
  });
  expect(output).toMatchObject({
    workflow_id: "workflow",
    conversation_id: "conversation-a",
    revision_id: "revision",
    run_id: "run",
    turn_id: "turn",
    operation_id: "operation",
    attempt_id: "attempt",
    unit_id: "unit",
    participant_id: "participant",
    role_ref: "role",
    role_resolved_hash: "role-hash",
    skill_refs: ["skill"],
    skill_resolved_hashes: ["skill-hash"],
    engine: "codex",
    parent_attempt_id: "parent-attempt",
    event_id: record.stored_event.event_id,
    seq: 7,
    ts: record.stored_event.ts,
    event: { type: "tool_action" },
  });
  expect(output.evidence_refs).toHaveLength(1);
  expect(output.public_session_ref).not.toBe(record.native_session_id);
  const json = JSON.stringify(output);
  expect(json).not.toContain("idempotency");
  expect(json).not.toContain("native-session-secret");
  expect(json).not.toContain("private/evidence.json");
  expect(json).not.toContain("artifact://secret/input");
  expect(() =>
    projectPublicStoredTrace(record, {
      conversationId: "conversation-b",
      artifactRegistry: registry,
    }),
  ).toThrow("conversation context mismatch");
});

test("projector normalizes split credentials and bidi controls while preserving text boundaries", () => {
  const splitToken = "sk-abcde\u200bfghij\u2060klmnopqrstuv";
  const output = projectPublicTrace(
    {
      type: "error",
      payload: {
        agent_id: null,
        code: "unsafe",
        message: [
          `prefix ${splitToken}`,
          "GITHUB_TO\u200bKEN=plain-secret-value",
          "https://example.test/callback?to\u200bken=credential-value",
          "https://example.test/download/sk-abcdefghijklmnopqrstuv",
          "left\u202eright",
          "keep\tcolumns",
          "keep lines",
        ].join("\n"),
      },
    },
    context,
  );
  const message = output.payload.message;
  expect(message).not.toContain("plain-secret-value");
  expect(message).not.toContain("credential-value");
  expect(message).not.toContain("sk-abcdefghijklmnopqrstuv");
  expect(message).not.toContain("\u200b");
  expect(message).not.toContain("\u2060");
  expect(message).not.toContain("\u202e");
  expect(message).toContain("keep\tcolumns\nkeep lines");
});

test("URL protection is collision-free and path redaction is field-aware", () => {
  const markerLikeText = "VFURLHOLDER0VF";
  const output = projectPublicTrace(
    {
      type: "participant_bound",
      payload: {
        participant_id: "p",
        engine: "codex",
        model: "provider/model-v2.1:preview",
        prompt_hash: "safe",
        tools: ["read"],
        sandbox: "read-only",
        note: `${markerLikeText} https://example.test/safe .ssh/id_rsa foo/bar.txt`,
      },
    } as unknown as TraceEvent,
    context,
  );
  const payload = output.payload as unknown as { model: string; note: string };
  expect(payload.model).toBe("provider/model-v2.1:preview");
  expect(payload.note).toContain(markerLikeText);
  expect(payload.note).toContain("https://example.test/safe");
  expect(payload.note).not.toContain(".ssh/id_rsa");
  expect(payload.note).not.toContain("foo/bar.txt");
});

test("stored-envelope projection scrubs native and raw reference deny-values everywhere", () => {
  const native = "native-identity-that-is-not-a-token";
  const internalRef = "vault:raw-artifact-identity";
  const stored_event = {
    workflow_id: "workflow",
    conversation_id: "conversation-a",
    revision_id: "revision",
    run_id: "run",
    turn_id: "turn",
    operation_id: "operation",
    attempt_id: "attempt",
    evidence_refs: [internalRef],
    event_id: "00000000-0000-4000-8000-000000000001",
    seq: 1,
    ts: "2026-08-22T00:00:00.000Z",
    idempotency_key: "private-key",
    event: {
      type: "error",
      payload: {
        agent_id: null,
        code: "engine_error",
        message: `reason=${native}; raw=${internalRef}`,
        reason: `retry ${native}`,
        warning: `do not expose ${internalRef}`,
      },
    } as unknown as TraceEvent,
  };
  const output = projectPublicStoredTrace(
    { stored_event, native_session_id: native },
    { conversationId: "conversation-a", artifactRegistry: testRegistry },
  );
  const json = JSON.stringify(output);
  expect(json).not.toContain(native);
  expect(json).not.toContain(internalRef);
  expect(json).toContain("[redacted");
});

test("stored-envelope projection scrubs embedded native and artifact deny-values", () => {
  const native = "native-secret-42";
  const internalRef = "artifact-private-42";
  const output = projectPublicStoredTrace(
    {
      stored_event: {
        workflow_id: "workflow",
        conversation_id: "conversation-a",
        revision_id: "revision",
        run_id: "run",
        turn_id: "turn",
        operation_id: "operation",
        attempt_id: "attempt",
        evidence_refs: [internalRef],
        event_id: "00000000-0000-4000-8000-000000000001",
        seq: 1,
        ts: "2026-08-22T00:00:00.000Z",
        idempotency_key: "private-key",
        event: {
          type: "error",
          payload: {
            agent_id: null,
            code: "engine_error",
            message: `prefix${native}suffix prefix${internalRef}suffix`,
          },
        },
      },
      native_session_id: native,
    },
    { conversationId: "conversation-a", artifactRegistry: testRegistry },
  );
  const json = JSON.stringify(output);
  expect(json).not.toContain(native);
  expect(json).not.toContain(internalRef);
  expect(output.event.type).toBe("error");
});

test("stored-envelope projection scrubs long deny substrings from semantic and identity fields", () => {
  const native = "native-session-identity-abcdefghijklmnopqrstuvwxyz";
  const internalRef = "artifact-private-identity-abcdefghijklmnopqrstuvwxyz";
  const output = projectPublicStoredTrace(
    {
      stored_event: {
        workflow_id: "workflow-authority",
        conversation_id: "conversation-a",
        revision_id: "revision-authority",
        run_id: "run-authority",
        turn_id: "turn-authority",
        operation_id: "operation-authority",
        attempt_id: "attempt-authority",
        evidence_refs: [internalRef],
        event_id: "00000000-0000-4000-8000-000000000001",
        seq: 1,
        ts: "2026-08-22T00:00:00.000Z",
        idempotency_key: "private-key",
        event: {
          type: "error",
          payload: {
            agent_id: `agent-${internalRef}-suffix`,
            code: `ERR_${native}_${internalRef}`,
            message: "safe message",
          },
        },
      },
      native_session_id: native,
    },
    { conversationId: "conversation-a", artifactRegistry: testRegistry },
  );
  const json = JSON.stringify(output);
  expect(json).not.toContain(native);
  expect(json).not.toContain(internalRef);
  expect(String(output.workflow_id)).toBe("workflow-authority");
  expect(String(output.revision_id)).toBe("revision-authority");
  expect(output.event.type).toBe("error");
  if (output.event.type !== "error") throw new Error("unexpected public event");
  expect(String(output.event.payload.message)).toBe("safe message");
});

test("public text redacts extensionless relative paths and file URIs", () => {
  const output = projectPublicTrace(
    {
      type: "error",
      payload: {
        agent_id: null,
        code: "engine_error",
        message: "leaks worktree/private-file and file:///Users/alice/private-note",
      },
    },
    context,
  );
  const message = output.payload.message;
  expect(message).not.toContain("worktree/private-file");
  expect(message).not.toContain("file:///Users/alice/private-note");
  expect(message.match(/\[redacted-path\]/g)).toHaveLength(2);
});

test("short private values redact only standalone free text and preserve trace semantics", () => {
  const stored_event = {
    workflow_id: "safe-workflow",
    conversation_id: "conversation-a",
    revision_id: "revision",
    run_id: "run",
    turn_id: "turn",
    operation_id: "operation",
    attempt_id: "a",
    evidence_refs: ["a"],
    event_id: "00000000-0000-4000-8000-000000000001",
    seq: 1,
    ts: "2026-08-22T00:00:00.000Z",
    idempotency_key: "private-key",
    event: {
      type: "artifact_created",
      payload: {
        artifact_id: "plan",
        artifact_type: "plan",
        ref: "a",
        note: "a n, a; n",
      },
    } as unknown as TraceEvent,
  };
  const output = projectPublicStoredTrace(
    { stored_event, native_session_id: "n" },
    { conversationId: "conversation-a", artifactRegistry: testRegistry },
  );
  const payload = output.event.payload as unknown as {
    artifact_id: string;
    artifact_type: string;
    note: string;
  };
  expect(String(output.workflow_id)).toBe("safe-workflow");
  expect(String(output.attempt_id)).toBe("a");
  expect(output.event.type).toBe("artifact_created");
  expect(payload.artifact_id).toBe("plan");
  expect(payload.artifact_type).toBe("plan");
  expect(payload.note).toBe(
    "[redacted-ref] [opaque-native-session], [redacted-ref]; [opaque-native-session]",
  );
});

test("dropped private fields seed repeated free-text redaction without mutating input", () => {
  const unsafe = {
    type: "artifact_created",
    payload: {
      artifact_id: "plan",
      artifact_type: "plan",
      ref: "artifact://safe",
      prompt_template: "hidden-template",
      raw_env: {
        API_TOKEN: "hidden-env",
        nested: ["hidden-nested"],
      },
      idempotency_key: "hidden-key",
      note: "hidden-template hidden-template; hidden-env hidden-nested; hidden-key hidden-key",
    },
  } as unknown as TraceEvent;
  const before = JSON.stringify(unsafe);
  const output = projectPublicTrace(unsafe, context);
  const json = JSON.stringify(output);
  expect(JSON.stringify(unsafe)).toBe(before);
  expect(json).not.toContain("prompt_template");
  expect(json).not.toContain("raw_env");
  expect(json).not.toContain("idempotency_key");
  for (const privateValue of ["hidden-template", "hidden-env", "hidden-nested", "hidden-key"])
    expect(json).not.toContain(privateValue);
  expect(
    (output.payload as unknown as { note: string }).note.match(/\[redacted-ref\]/g),
  ).toHaveLength(6);
});

test("public projection rejects malformed containers and still bounds dropped traversal", () => {
  expect(() =>
    projectPublicTrace(
      {
        type: "artifact_created",
        payload: { artifact_id: "plan", artifact_type: "plan", ref: 42 },
      } as unknown as TraceEvent,
      context,
    ),
  ).toThrow("invalid reference");

  expect(() =>
    projectPublicTrace(
      {
        type: "native_history_reconciled",
        payload: {
          public_session_ref: "native",
          status: "reconciled",
          imported_turn_count: 0,
          imported_tool_count: 0,
          provenance_refs: [42],
          evidence_refs: [],
          completeness_reason: "safe",
        },
      } as unknown as TraceEvent,
      context,
    ),
  ).toThrow("invalid reference array");

  const cycle: Record<string, unknown> = {};
  cycle.self = cycle;
  expect(() =>
    projectPublicTrace(
      {
        type: "artifact_created",
        payload: {
          artifact_id: "plan",
          artifact_type: "plan",
          ref: "artifact://safe",
          raw_env: cycle,
        },
      } as unknown as TraceEvent,
      context,
    ),
  ).toThrow("cyclic value");

  let accessorReads = 0;
  const payload = {
    artifact_id: "plan",
    artifact_type: "plan",
    ref: "artifact://safe",
  } as Record<string, unknown>;
  Object.defineProperty(payload, "raw_env", {
    enumerable: true,
    get() {
      accessorReads += 1;
      return "hidden";
    },
  });
  expect(() =>
    projectPublicTrace({ type: "artifact_created", payload } as unknown as TraceEvent, context),
  ).toThrow("invalid property");
  expect(accessorReads).toBe(0);
});

test("participant models reject provider-qualified credentials without rejecting provider IDs", () => {
  const valid = [
    "openai/gpt-5.4:preview",
    "provider/sk-model-v2",
    "provider/github-compatible-v1",
    "us.anthropic.claude-opus-4-1-v1:0",
  ];
  const invalid = [
    "provider/sk-abcdefghijklmnopqrstuvwxyz123456",
    "provider/ghp_abcdefghijklmnopqrstuvwxyz123456",
    "provider/gho_abcdefghijklmnopqrstuvwxyz123456",
    "provider/github_pat_abcdefghijklmnopqrstuvwxyz123456",
    "provider/AKIAABCDEFGHIJKLMNOP",
    "provider/xoxb-12345678901234567890",
  ];
  expect(valid.map(isValidParticipantModel)).toEqual(valid.map(() => true));
  expect(invalid.map(isValidParticipantModel)).toEqual(invalid.map(() => false));
});
