import { expect, test } from "bun:test";
import type { RoleSpec } from "../../src/agents/role.js";
import type { Engine } from "../../src/core/types.js";
import { projectPublicTrace } from "../../src/orchestrator/trace/project.js";
import type {
  PublicTraceProjection,
  TraceAppendInput,
  TraceEvent,
} from "../../src/orchestrator/trace/types.js";

type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2
  ? true
  : false;
type Assert<T extends true> = T;
type _EngineIsCanonical = Assert<
  Equal<import("../../src/orchestrator/trace/types.js").Engine, Engine>
>;
type _RoleFieldsAreCanonical = Assert<
  Equal<
    import("../../src/orchestrator/trace/types.js").Participant["model"],
    RoleSpec["model"] | null
  >
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
// @ts-expect-error idempotency_key is required
const missingKey: TraceAppendInput = { event };
void missingKey;
const mismatched: TraceEvent = {
  type: "tool_action",
  // @ts-expect-error type/payload remain correlated
  payload: { content: "wrong", target_participants: "all" },
};
void mismatched;
const projected = projectPublicTrace(event);
type _ProjectorIsSpecific = Assert<
  Equal<typeof projected, Extract<PublicTraceProjection, { type: "tool_action" }>>
>;
void (0 as unknown as _ProjectorIsSpecific);

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
  const output = projectPublicTrace(unsafe);
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
  const output = projectPublicTrace({
    type: "participant_bound",
    payload: {
      participant_id: "p",
      engine: "codex",
      model: null,
      prompt_hash: "safe",
      tools: ["read"],
      sandbox: "read-only",
    },
  });
  expect(output).toMatchObject({
    type: "participant_bound",
    payload: {
      participant_id: "p",
      engine: "codex",
      model: null,
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
    `{"type":"native_history_reconciled","payload":{"public_session_ref":"${session}","status":"reconciled","imported_turn_count":1,"imported_tool_count":1,"provenance_refs":["${artifact}"],"evidence_refs":["${otherArtifact}"],"completeness_reason":"safe https://example.test/a api_key=multi word value; token: 'two words'\\u202E ghp_abcdefghijklmnopqrstuvwxyz1234567890 AKIAABCDEFGHIJKLMNOP Bearer abc.def.ghi Basic dXNlcjpwYXNz https://u:p@example.test/?token=x /root/a /workspace/b /srv/c ../secret ./secret C:\\\\work\\\\x"}}`,
  ) as TraceEvent;
  const duplicate = projectPublicTrace({
    type: "artifact_created",
    payload: { artifact_id: "safe", artifact_type: "plan", ref: artifact },
  });
  const output = projectPublicTrace(unsafe);
  const json = JSON.stringify(output);
  const payload = output.payload as unknown as Record<string, unknown>;
  const stable = projectPublicTrace({
    type: "artifact_created",
    payload: { artifact_id: "safe", artifact_type: "plan", ref: artifact },
  });
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
  const output = projectPublicTrace({
    type: "artifact_created",
    payload: {
      artifact_id: "safe",
      artifact_type: "plan",
      ref: "artifact://safe",
      note: `password=secret\nkeep this safe sentence ${jwt} foo.bar.baz 1.2.3 open /tmp/a then visit https://example.test/a`,
    },
  } as unknown as TraceEvent);
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
  const output = projectPublicTrace(unsafe);
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
  const output = projectPublicTrace({
    type: "artifact_created",
    payload: {
      artifact_id: "safe",
      artifact_type: "plan",
      ref: "artifact://safe",
      note: `${privateKey}\n${jwt} ${asia} "/tmp/path with spaces/file.txt"; "C:\\work dir\\file.txt"; "./local path/file"; "../parent path/file"; https://example.test/a path`,
      posix_path: "/tmp/path with spaces/file.txt",
      windows_path: "C:\\work dir\\file.txt",
    },
  } as unknown as TraceEvent);
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
