import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { ENGINES, type Engine } from "../../core/types.js";
import { isSafeNativeSessionId } from "../../dispatch/public-redaction.js";
import type { InternalResumeBinding } from "../../dispatch/session-types.js";
import type {
  ArtifactCreateRequest,
  ArtifactUpdateRequest,
  ConversationManifest,
} from "./types.js";

export interface ConversationArtifactEntry {
  artifact_id: string;
  artifact_type: string;
  ref: string;
  previous_ref: string | null;
  idempotency_key: string;
  content_hash: string;
}
export interface BindingAuthoritySnapshot {
  participant_id: string;
  engine: Engine;
  model: string | null;
  session_mode: "exact" | "replay" | "fresh";
  role_source: "builtin" | "repo";
  role_hash: string;
  skill_hashes: string[];
}
export interface PersistedResumeBinding extends InternalResumeBinding {
  participant_id: string;
}
export interface ConversationDurableRecord {
  manifest: ConversationManifest;
  binding_authorities: BindingAuthoritySnapshot[];
  resume_bindings: PersistedResumeBinding[];
  child_revisions: Record<string, string>;
  artifacts: ConversationArtifactEntry[];
  artifact_reservations: Record<string, number>;
}

const MAX_REF = 4096;
const MAX_TEXT = 64 * 1024;
const MAX_ITEMS = 512;
const HASH = /^[0-9a-f]{64}$/;
const ARTIFACT_REF = /^vf-artifact-[0-9a-f]{64}$/;
const ARTIFACT_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;
const ARTIFACT_TYPES = new Set([
  "decision_matrix",
  "plan",
  "diff",
  "tests",
  "synthesis",
  "transcript",
]);
const SESSION_MODES = new Set(["exact", "replay", "fresh"]);

const fail: () => never = () => {
  throw new Error("invalid manifest");
};
const plain = (value: unknown): value is Record<string, unknown> => {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  if (Object.getOwnPropertySymbols(value).length) return false;
  return Object.values(Object.getOwnPropertyDescriptors(value)).every(
    (descriptor) => "value" in descriptor && descriptor.enumerable,
  );
};
const exact = (value: Record<string, unknown>, keys: readonly string[]): boolean => {
  const observed = Object.keys(value).sort();
  const expected = [...keys].sort();
  return (
    observed.length === expected.length && observed.every((key, index) => key === expected[index])
  );
};
const ref = (value: unknown): value is string =>
  typeof value === "string" &&
  value.length > 0 &&
  Buffer.byteLength(value, "utf8") <= MAX_REF &&
  !/\p{Cc}/u.test(value);
const text = (value: unknown): value is string =>
  typeof value === "string" && Buffer.byteLength(value, "utf8") <= MAX_TEXT;
const list = <T>(value: unknown, valid: (item: unknown) => item is T): value is T[] =>
  Array.isArray(value) && value.length <= MAX_ITEMS && value.every(valid);
const nullableRef = (value: unknown): value is string | null => value === null || ref(value);

export function readVerifiedArtifact(fd: number, size: number, contentHash: string): Uint8Array {
  const data = Buffer.alloc(size);
  let offset = 0;
  while (offset < data.length) {
    const read = fs.readSync(fd, data, offset, data.length - offset, offset);
    if (read === 0) throw new Error("artifact content truncated");
    offset += read;
  }
  if (createHash("sha256").update(data).digest("hex") !== contentHash) {
    throw new Error("artifact content hash mismatch");
  }
  return new Uint8Array(data);
}

export function assertArtifactIdentity(value: unknown): asserts value is string {
  if (typeof value !== "string" || !ARTIFACT_ID.test(value))
    throw new Error("invalid artifact identity");
}

export function assertArtifactCreateRequest(
  value: unknown,
): asserts value is ArtifactCreateRequest {
  if (
    !plain(value) ||
    !exact(value, ["artifact_type", "content", "idempotency_key"]) ||
    !ARTIFACT_TYPES.has(value.artifact_type as string) ||
    !(typeof value.content === "string" || value.content instanceof Uint8Array) ||
    !ref(value.idempotency_key)
  )
    throw new Error("invalid artifact request");
}

export function assertArtifactUpdateRequest(
  value: unknown,
): asserts value is ArtifactUpdateRequest {
  if (
    !plain(value) ||
    !exact(value, ["artifact_id", "artifact_type", "content", "idempotency_key", "previous_ref"]) ||
    !ARTIFACT_ID.test(value.artifact_id as string) ||
    !ARTIFACT_TYPES.has(value.artifact_type as string) ||
    !(typeof value.content === "string" || value.content instanceof Uint8Array) ||
    !ref(value.idempotency_key) ||
    typeof value.previous_ref !== "string" ||
    !ARTIFACT_REF.test(value.previous_ref)
  )
    throw new Error("invalid artifact request");
}

const assertBindingInput = (value: unknown): void => {
  if (!plain(value)) fail();
  const required = ["engine", "roleRef", "sessionMode"];
  const optional = ["additionalSkillRefs", "modelOverride"];
  const keys = Object.keys(value);
  if (
    required.some((key) => !keys.includes(key)) ||
    keys.some((key) => !required.includes(key) && !optional.includes(key)) ||
    !ref(value.roleRef) ||
    !ENGINES.includes(value.engine as Engine) ||
    !SESSION_MODES.has(value.sessionMode as string) ||
    (value.modelOverride !== undefined && !ref(value.modelOverride)) ||
    (value.additionalSkillRefs !== undefined && !list(value.additionalSkillRefs, ref))
  )
    fail();
};

const assertManifestBinding = (value: unknown): void => {
  if (!plain(value) || !exact(value, ["input", "participant_id"]) || !ref(value.participant_id))
    fail();
  assertBindingInput(value.input);
};

export function assertConversationManifest(
  value: unknown,
  expectedId?: string,
): asserts value is ConversationManifest {
  if (plain(value) && !Object.hasOwn(value, "baseline_enabled")) value.baseline_enabled = true;
  if (plain(value) && !Object.hasOwn(value, "evaluator_auto_added")) {
    value.evaluator_auto_added = false;
  }
  const keys = [
    "baseline_enabled",
    "bindings",
    "conversation_id",
    "created_at",
    "evaluator_auto_added",
    "max_rounds",
    "parent_conversation_id",
    "parent_revision_id",
    "phase",
    "policy",
    "repo_root",
    "revision_id",
    "run_id",
    "task_text",
    "topic",
    "version",
    "workflow_id",
  ];
  if (!plain(value) || !exact(value, keys)) fail();
  if (
    value.version !== "1.0" ||
    !ref(value.conversation_id) ||
    (expectedId !== undefined && value.conversation_id !== expectedId) ||
    !ref(value.workflow_id) ||
    !ref(value.revision_id) ||
    !ref(value.run_id) ||
    !nullableRef(value.parent_conversation_id) ||
    !nullableRef(value.parent_revision_id) ||
    !text(value.topic) ||
    !ref(value.policy) ||
    !Number.isSafeInteger(value.max_rounds) ||
    (value.max_rounds as number) < 1 ||
    (value.max_rounds as number) > MAX_ITEMS ||
    typeof value.baseline_enabled !== "boolean" ||
    typeof value.evaluator_auto_added !== "boolean" ||
    !ref(value.repo_root) ||
    !Number.isSafeInteger(value.phase) ||
    (value.phase as number) < 1 ||
    !text(value.task_text) ||
    !list(value.bindings, (item): item is ConversationManifest["bindings"][number] => {
      try {
        assertManifestBinding(item);
        return true;
      } catch {
        return false;
      }
    }) ||
    value.bindings.length < 1 ||
    new Set(value.bindings.map((binding) => binding.participant_id)).size !==
      value.bindings.length ||
    typeof value.created_at !== "string" ||
    Number.isNaN(Date.parse(value.created_at)) ||
    new Date(value.created_at).toISOString() !== value.created_at
  )
    fail();
}

const assertAuthority: (value: unknown) => asserts value is BindingAuthoritySnapshot = (value) => {
  const keys = [
    "engine",
    "model",
    "participant_id",
    "role_hash",
    "role_source",
    "session_mode",
    "skill_hashes",
  ];
  if (
    !plain(value) ||
    !exact(value, keys) ||
    !ref(value.participant_id) ||
    !ENGINES.includes(value.engine as Engine) ||
    (value.model !== null && !ref(value.model)) ||
    !SESSION_MODES.has(value.session_mode as string) ||
    (value.role_source !== "builtin" && value.role_source !== "repo") ||
    typeof value.role_hash !== "string" ||
    !HASH.test(value.role_hash) ||
    !list(value.skill_hashes, (item): item is string => typeof item === "string" && HASH.test(item))
  )
    fail();
};

const assertResume: (value: unknown) => asserts value is PersistedResumeBinding = (value) => {
  if (
    !plain(value) ||
    !exact(value, ["attemptId", "engine", "nativeSessionId", "participant_id"]) ||
    !ref(value.participant_id) ||
    !ref(value.attemptId) ||
    !ENGINES.includes(value.engine as Engine) ||
    typeof value.nativeSessionId !== "string" ||
    !isSafeNativeSessionId(value.engine as Engine, value.nativeSessionId)
  )
    fail();
};

const assertArtifact: (value: unknown) => asserts value is ConversationArtifactEntry = (value) => {
  if (
    !plain(value) ||
    !exact(value, [
      "artifact_id",
      "artifact_type",
      "content_hash",
      "idempotency_key",
      "previous_ref",
      "ref",
    ]) ||
    typeof value.artifact_id !== "string" ||
    !ARTIFACT_ID.test(value.artifact_id) ||
    !ARTIFACT_TYPES.has(value.artifact_type as string) ||
    typeof value.ref !== "string" ||
    !ARTIFACT_REF.test(value.ref) ||
    (value.previous_ref !== null &&
      (typeof value.previous_ref !== "string" || !ARTIFACT_REF.test(value.previous_ref))) ||
    !ref(value.idempotency_key) ||
    typeof value.content_hash !== "string" ||
    !HASH.test(value.content_hash)
  )
    fail();
};

export function assertConversationDurableRecord(
  value: unknown,
  expectedId?: string,
): asserts value is ConversationDurableRecord {
  if (plain(value) && !Object.hasOwn(value, "artifact_reservations"))
    value.artifact_reservations = {};
  if (
    !plain(value) ||
    !exact(value, [
      "artifacts",
      "artifact_reservations",
      "binding_authorities",
      "child_revisions",
      "manifest",
      "resume_bindings",
    ])
  )
    fail();
  const manifest = value.manifest;
  assertConversationManifest(manifest, expectedId);
  const authorities = value.binding_authorities;
  if (
    !list(authorities, (item): item is BindingAuthoritySnapshot => {
      try {
        assertAuthority(item);
        return true;
      } catch {
        return false;
      }
    })
  )
    fail();
  if (
    authorities.length !== manifest.bindings.length ||
    authorities.some(
      (item, index) => item.participant_id !== manifest.bindings[index]?.participant_id,
    )
  )
    fail();
  const resumeBindings = value.resume_bindings;
  if (
    !list(resumeBindings, (item): item is PersistedResumeBinding => {
      try {
        assertResume(item);
        return true;
      } catch {
        return false;
      }
    })
  )
    fail();
  if (
    resumeBindings.some(
      (item) =>
        !authorities.some(
          (binding) =>
            binding.participant_id === item.participant_id && binding.engine === item.engine,
        ),
    )
  )
    fail();
  if (
    new Set(resumeBindings.map((item) => item.participant_id)).size !== resumeBindings.length ||
    new Set(resumeBindings.map((item) => item.attemptId)).size !== resumeBindings.length
  )
    fail();
  const children = value.child_revisions;
  if (
    !plain(children) ||
    Object.entries(children).some(
      ([key, child]) =>
        !HASH.test(key) || ["__proto__", "prototype", "constructor"].includes(key) || !ref(child),
    )
  )
    fail();
  const artifacts = value.artifacts;
  if (
    !list(artifacts, (item): item is ConversationArtifactEntry => {
      try {
        assertArtifact(item);
        return true;
      } catch {
        return false;
      }
    })
  )
    fail();
  if (
    new Set(artifacts.map((item) => item.idempotency_key)).size !== artifacts.length ||
    artifacts.some(
      (item, index) =>
        item.previous_ref !== null &&
        !artifacts
          .slice(0, index)
          .some(
            (prior) => prior.artifact_id === item.artifact_id && prior.ref === item.previous_ref,
          ),
    )
  )
    fail();
  const reservations = value.artifact_reservations;
  if (
    !plain(reservations) ||
    Object.entries(reservations).some(
      ([artifactRef, count]) =>
        !ARTIFACT_REF.test(artifactRef) ||
        !artifacts.some((artifact) => artifact.ref === artifactRef) ||
        !Number.isSafeInteger(count) ||
        (count as number) < 1 ||
        (count as number) > MAX_ITEMS,
    )
  )
    fail();
}
