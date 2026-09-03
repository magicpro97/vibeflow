import { type BrowserHostActionRequestV1, exactObject } from "../../actions/index.js";
import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import {
  AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN,
  AGENT_ACTION_CANDIDATE_RECORD_FIELDS,
  AGENT_ACTION_CANDIDATE_RECORD_KIND,
  AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
  type AgentActionCandidateSchemaVersionV1,
  isAgentActionCandidateSchemaVersion,
} from "./conversation-agent-action-candidate-contract.js";
import { validateAgentProposableHostActionRequest } from "./conversation-agent-action-candidate-validation.js";

export const MAX_RECORD_BYTES = 2 * 1024 * 1024;
export const MAX_NAMESPACE_FILES = 16_384;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
export const DIGEST_FILE = /^[0-9a-f]{64}\.json$/;
const OPAQUE_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,255}$/;
const RESPONSE_KEY = /^[A-Za-z0-9][A-Za-z0-9:._~-]{0,511}$/;

export class ConversationAgentActionCandidateResponseConflictError extends Error {
  override readonly name = "ConversationAgentActionCandidateResponseConflictError";
}

export interface DurableAgentActionCandidateStageV1 {
  schema_version: AgentActionCandidateSchemaVersionV1;
  record_digest: string;
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  participant_id: string;
  response_idempotency_key: string;
  candidate: BrowserHostActionRequestV1;
  grant_digest: string;
}

export interface DurableAgentActionCandidateResponseBindingV1 {
  schema_version: AgentActionCandidateSchemaVersionV1;
  conversation_id: string;
  revision_id: string;
  participant_id: string;
  response_idempotency_key: string;
  response_binding_key_digest: string;
  record_digest: string;
  stage: DurableAgentActionCandidateStageV1;
  binding_digest: string;
}

export function requireOpaqueId(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !OPAQUE_ID.test(value)) throw new Error(`invalid ${label}`);
}

export function requireDigest(value: unknown, label: string): asserts value is string {
  if (typeof value !== "string" || !DIGEST.test(value)) throw new Error(`invalid ${label}`);
}

function stagePreimage(input: {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  participant_id: string;
  response_idempotency_key: string;
  candidate: BrowserHostActionRequestV1;
  grant_digest: string;
}) {
  return {
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    root_session_id: input.root_session_id,
    conversation_id: input.conversation_id,
    revision_id: input.revision_id,
    participant_id: input.participant_id,
    response_idempotency_key: input.response_idempotency_key,
    candidate: structuredClone(input.candidate),
    grant_digest: input.grant_digest,
  };
}

function stageDigest(input: ReturnType<typeof stagePreimage>): string {
  return digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.STAGE, input);
}

export function materializeDurableAgentActionCandidateStage(input: {
  root_session_id: string;
  conversation_id: string;
  revision_id: string;
  participant_id: string;
  response_idempotency_key: string;
  candidate: BrowserHostActionRequestV1;
  grant_digest: string;
}): DurableAgentActionCandidateStageV1 {
  const preimage = stagePreimage(input);
  const stage = {
    ...preimage,
    record_digest: stageDigest(preimage),
  };
  validateStage(stage);
  return stage;
}

export function validateStage(value: unknown): asserts value is DurableAgentActionCandidateStageV1 {
  const row = exactObject(
    value,
    AGENT_ACTION_CANDIDATE_RECORD_FIELDS.STAGE,
    [],
    `$.${AGENT_ACTION_CANDIDATE_RECORD_KIND.STAGE}`,
  );
  if (!isAgentActionCandidateSchemaVersion(row.schema_version))
    throw new Error("unsupported candidate stage version");
  requireDigest(row.record_digest, "candidate stage digest");
  requireOpaqueId(row.root_session_id, "candidate root session id");
  requireOpaqueId(row.conversation_id, "candidate conversation id");
  requireOpaqueId(row.revision_id, "candidate revision id");
  requireOpaqueId(row.participant_id, "candidate participant id");
  if (
    typeof row.response_idempotency_key !== "string" ||
    !RESPONSE_KEY.test(row.response_idempotency_key)
  )
    throw new Error("invalid candidate response idempotency key");
  requireDigest(row.grant_digest, "candidate grant digest");
  const candidate = validateAgentProposableHostActionRequest(row.candidate);
  const expected = stagePreimage({
    root_session_id: row.root_session_id,
    conversation_id: row.conversation_id,
    revision_id: row.revision_id,
    participant_id: row.participant_id,
    response_idempotency_key: row.response_idempotency_key,
    candidate,
    grant_digest: row.grant_digest,
  });
  if (stageDigest(expected) !== row.record_digest)
    throw new Error("candidate stage digest mismatch");
}

function responseBindingKeyPreimage(input: {
  conversation_id: string;
  revision_id: string;
  participant_id: string;
  response_idempotency_key: string;
}) {
  return {
    schema_version: AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
    conversation_id: input.conversation_id,
    revision_id: input.revision_id,
    participant_id: input.participant_id,
    response_idempotency_key: input.response_idempotency_key,
  };
}

function responseBindingKeyDigest(input: ReturnType<typeof responseBindingKeyPreimage>): string {
  return digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.RESPONSE_BINDING_KEY, input);
}

function responseBindingPreimage(stage: DurableAgentActionCandidateStageV1) {
  const key = responseBindingKeyPreimage(stage);
  return {
    ...key,
    response_binding_key_digest: responseBindingKeyDigest(key),
    record_digest: stage.record_digest,
    stage: structuredClone(stage),
  };
}

export function materializeResponseBinding(
  stage: DurableAgentActionCandidateStageV1,
): DurableAgentActionCandidateResponseBindingV1 {
  validateStage(stage);
  const preimage = responseBindingPreimage(stage);
  const binding = {
    ...preimage,
    binding_digest: digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.RESPONSE_BINDING, preimage),
  };
  validateResponseBinding(binding);
  return binding;
}

export function validateResponseBinding(
  value: unknown,
): asserts value is DurableAgentActionCandidateResponseBindingV1 {
  const row = exactObject(
    value,
    AGENT_ACTION_CANDIDATE_RECORD_FIELDS.RESPONSE_BINDING,
    [],
    `$.${AGENT_ACTION_CANDIDATE_RECORD_KIND.RESPONSE_BINDING}`,
  );
  if (!isAgentActionCandidateSchemaVersion(row.schema_version))
    throw new Error("unsupported response binding version");
  requireOpaqueId(row.conversation_id, "candidate response binding conversation id");
  requireOpaqueId(row.revision_id, "candidate response binding revision id");
  requireOpaqueId(row.participant_id, "candidate response binding participant id");
  if (
    typeof row.response_idempotency_key !== "string" ||
    !RESPONSE_KEY.test(row.response_idempotency_key)
  )
    throw new Error("invalid candidate response binding idempotency key");
  requireDigest(row.response_binding_key_digest, "candidate response binding key digest");
  requireDigest(row.record_digest, "candidate response binding record digest");
  requireDigest(row.binding_digest, "candidate response binding digest");
  validateStage(row.stage);
  const stage = row.stage as DurableAgentActionCandidateStageV1;
  const key = responseBindingKeyPreimage({
    conversation_id: row.conversation_id,
    revision_id: row.revision_id,
    participant_id: row.participant_id,
    response_idempotency_key: row.response_idempotency_key,
  });
  if (responseBindingKeyDigest(key) !== row.response_binding_key_digest)
    throw new Error("candidate response binding key digest mismatch");
  const preimage = {
    ...key,
    response_binding_key_digest: row.response_binding_key_digest,
    record_digest: row.record_digest,
    stage: structuredClone(stage),
  };
  if (
    digestV1(AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN.RESPONSE_BINDING, preimage) !== row.binding_digest
  )
    throw new Error("candidate response binding digest mismatch");
  if (
    stage.conversation_id !== row.conversation_id ||
    stage.revision_id !== row.revision_id ||
    stage.participant_id !== row.participant_id ||
    stage.response_idempotency_key !== row.response_idempotency_key ||
    stage.record_digest !== row.record_digest
  )
    throw new Error("candidate response binding stage identity mismatch");
}

export function assertResponseBindingStage(
  binding: DurableAgentActionCandidateResponseBindingV1,
  stage: DurableAgentActionCandidateStageV1,
): void {
  const expected = materializeResponseBinding(stage);
  if (
    expected.response_binding_key_digest !== binding.response_binding_key_digest ||
    expected.binding_digest !== binding.binding_digest ||
    expected.record_digest !== binding.record_digest
  )
    throw new Error("candidate response binding and stage disagree");
}

export function decode<T>(bytes: Buffer, validate: (value: unknown) => asserts value is T): T {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)) as unknown;
  validate(value);
  if (!canonicalJsonBytes(value, { maxBytes: MAX_RECORD_BYTES }).equals(bytes))
    throw new Error("non-canonical agent action candidate record");
  return structuredClone(value);
}
