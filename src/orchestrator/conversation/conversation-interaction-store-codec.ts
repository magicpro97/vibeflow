import { canonicalJsonBytes } from "../../durability/index.js";
import {
  CONVERSATION_INTERACTION_ENTRY_KIND,
  CONVERSATION_INTERACTION_LIMITS,
  CONVERSATION_INTERACTION_SCHEMA_VERSION,
} from "./conversation-interaction-contract.js";
import type {
  ConversationInteractionEntryV1,
  ConversationInteractionHeadV1,
} from "./conversation-interaction-types.js";
import { interactionHeadDigest } from "./conversation-interaction-validation.js";

const INITIAL_TIME = "1970-01-01T00:00:00.000Z";

export function initialInteractionHead(rootSessionId: string): ConversationInteractionHeadV1 {
  const preimage = {
    schema_version: CONVERSATION_INTERACTION_SCHEMA_VERSION,
    root_session_id: rootSessionId,
    sequence: 0,
    last_frame_digest: null,
    updated_at: INITIAL_TIME,
  };
  return { ...preimage, content_digest: interactionHeadDigest(preimage) };
}

export function interactionEntryTime(entry: ConversationInteractionEntryV1): string {
  return entry.kind === CONVERSATION_INTERACTION_ENTRY_KIND.REACTION_OPERATION
    ? entry.operation.created_at
    : entry.intent.created_at;
}

export function interactionEntryPriorHead(entry: ConversationInteractionEntryV1): string {
  return entry.kind === CONVERSATION_INTERACTION_ENTRY_KIND.REACTION_OPERATION
    ? entry.operation.prior_interaction_head_digest
    : entry.intent.prior_interaction_head_digest;
}

export function decodeInteractionAuthority<T>(bytes: Buffer, assert: (value: unknown) => void): T {
  const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
  assert(value);
  if (
    !canonicalJsonBytes(value, {
      maxBytes: CONVERSATION_INTERACTION_LIMITS.maxObjectBytes,
    }).equals(bytes)
  )
    throw new Error("conversation interaction authority is non-canonical");
  return structuredClone(value) as T;
}
