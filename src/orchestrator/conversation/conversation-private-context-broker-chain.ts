import { join } from "node:path";
import { canonicalJsonBytes, digestHex, privateFileBytes } from "../../durability/index.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS,
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_STORAGE,
  isConversationPrivateContextDraftStageTransition,
  isConversationPrivateContextMessageStageTransition,
} from "./conversation-private-context-broker-contract.js";
import type {
  PrivateConversationDraftContextStageV1,
  PrivateConversationMessageContextStageV1,
} from "./conversation-private-context-broker-types.js";
import {
  assertPrivateConversationDraftContextStageV1,
  assertPrivateConversationMessageContextStageV1,
} from "./conversation-private-context-broker-validation.js";

function decode<T>(bytes: Buffer, validate: (value: unknown) => asserts value is T): T {
  const value = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  validate(value);
  if (!canonicalJsonBytes(value).equals(bytes))
    throw new Error("private context stage record is not canonical");
  return value;
}

export const decodeMessagePrivateContextStage = (bytes: Buffer) =>
  decode(bytes, assertPrivateConversationMessageContextStageV1);

export const decodeDraftPrivateContextStage = (bytes: Buffer) =>
  decode(bytes, assertPrivateConversationDraftContextStageV1);

function eventBytes(path: string, digest: string): Buffer {
  const bytes = privateFileBytes(
    join(path, CONVERSATION_PRIVATE_CONTEXT_STORAGE.EVENTS_DIRECTORY, `${digestHex(digest)}.json`),
    CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRecordBytes,
  );
  if (!bytes) throw new Error("private context stage event is missing");
  return bytes;
}

function messageIdentity(value: PrivateConversationMessageContextStageV1) {
  return {
    owner_principal_digest: value.owner_principal_digest,
    root_session_id: value.root_session_id,
    enqueue_idempotency_key_digest: value.enqueue_idempotency_key_digest,
    staged_authority_digest: value.staged_authority_digest,
    canonical_request_digest: value.canonical_request_digest,
    source_kind: value.source_kind,
    source_record_ref: value.source_record_ref,
    source_record_digest: value.source_record_digest,
    staged_at: value.staged_at,
  };
}

function assertMessageEdge(
  prior: PrivateConversationMessageContextStageV1,
  next: PrivateConversationMessageContextStageV1,
): void {
  const edge = `${prior.stage_state}->${next.stage_state}`;
  if (
    !canonicalJsonBytes(messageIdentity(prior)).equals(canonicalJsonBytes(messageIdentity(next))) ||
    next.stage_sequence !== prior.stage_sequence + 1 ||
    next.previous_record_digest !== prior.record_digest ||
    Date.parse(next.updated_at) < Date.parse(prior.updated_at) ||
    !isConversationPrivateContextMessageStageTransition(edge) ||
    (prior.stage_state === CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED &&
      next.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE &&
      (next.queue_item_id !== prior.queue_item_id ||
        next.private_context_binding_digest !== prior.private_context_binding_digest))
  )
    throw new Error("message private context transition is invalid");
}

export function validateMessagePrivateContextChain(
  path: string,
  current: PrivateConversationMessageContextStageV1,
): void {
  let next: PrivateConversationMessageContextStageV1 | null = null;
  let cursor = current;
  for (
    let count = CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.genesisStageSequence;
    count < CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxStageRecords;
    count += 1
  ) {
    const bytes = eventBytes(path, cursor.record_digest);
    if (!canonicalJsonBytes(cursor).equals(bytes))
      throw new Error("message private context current is not its event");
    if (next) assertMessageEdge(cursor, next);
    if (cursor.stage_sequence === CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.genesisStageSequence) {
      if (
        cursor.stage_state !== CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.AVAILABLE ||
        cursor.previous_record_digest !== null
      )
        throw new Error("message private context genesis is invalid");
      return;
    }
    if (!cursor.previous_record_digest)
      throw new Error("message private context prior digest is absent");
    next = cursor;
    cursor = decodeMessagePrivateContextStage(eventBytes(path, cursor.previous_record_digest));
  }
  throw new Error("message private context event chain is too long");
}

function draftIdentity(value: PrivateConversationDraftContextStageV1) {
  return {
    owner_principal_digest: value.owner_principal_digest,
    create_idempotency_key_digest: value.create_idempotency_key_digest,
    canonical_request_digest: value.canonical_request_digest,
    source_kind: value.source_kind,
    source_record_ref: value.source_record_ref,
    source_record_digest: value.source_record_digest,
    staged_at: value.staged_at,
  };
}

function assertDraftEdge(
  prior: PrivateConversationDraftContextStageV1,
  next: PrivateConversationDraftContextStageV1,
): void {
  const edge = `${prior.stage_state}->${next.stage_state}`;
  if (
    !canonicalJsonBytes(draftIdentity(prior)).equals(canonicalJsonBytes(draftIdentity(next))) ||
    next.stage_sequence !== prior.stage_sequence + 1 ||
    next.previous_record_digest !== prior.record_digest ||
    Date.parse(next.updated_at) < Date.parse(prior.updated_at) ||
    !isConversationPrivateContextDraftStageTransition(edge) ||
    (prior.stage_state === CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED &&
      (next.allocated_root_session_id !== prior.allocated_root_session_id ||
        next.allocated_conversation_id !== prior.allocated_conversation_id ||
        next.allocated_revision_id !== prior.allocated_revision_id ||
        next.initial_turn_context_digest !== prior.initial_turn_context_digest))
  )
    throw new Error("draft private context transition is invalid");
}

export function validateDraftPrivateContextChain(
  path: string,
  current: PrivateConversationDraftContextStageV1,
): void {
  let next: PrivateConversationDraftContextStageV1 | null = null;
  let cursor = current;
  while (cursor.stage_sequence > CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.genesisStageSequence) {
    const bytes = eventBytes(path, cursor.record_digest);
    if (!canonicalJsonBytes(cursor).equals(bytes))
      throw new Error("draft private context current is not its event");
    if (next) assertDraftEdge(cursor, next);
    if (!cursor.previous_record_digest)
      throw new Error("draft private context prior digest is absent");
    next = cursor;
    cursor = decodeDraftPrivateContextStage(eventBytes(path, cursor.previous_record_digest));
  }
  const genesisBytes = eventBytes(path, cursor.record_digest);
  if (!canonicalJsonBytes(cursor).equals(genesisBytes))
    throw new Error("draft private context current is not its event");
  if (next) assertDraftEdge(cursor, next);
  if (
    cursor.stage_state !== CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.AVAILABLE ||
    cursor.previous_record_digest !== null
  )
    throw new Error("draft private context genesis is invalid");
}
