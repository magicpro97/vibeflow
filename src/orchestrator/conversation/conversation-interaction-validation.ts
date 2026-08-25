import { canonicalJsonBytes, digestV1 } from "../../durability/index.js";
import {
  type ConversationInteractionFrameV1,
  type ConversationInteractionHeadV1,
  type ConversationParticipantSocialIntentV1,
  type ConversationReactionOperationV1,
  type PublicMessageLocatorV1,
  type PublicQuoteReferenceV1,
  REACTION_EMOJIS,
  type ReactionEmojiV1,
} from "./conversation-interaction-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const REACTION_ID = /^vf-reaction-[0-9a-f]{64}$/;
const INTENT_ID = /^vf-social-intent-[0-9a-f]{64}$/;
const MAX_REFERENCE_BYTES = 512;
const EMOJIS = new Set<string>(REACTION_EMOJIS);

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exact(value: Record<string, unknown>, keys: readonly string[]): boolean {
  return (
    Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key))
  );
}

function reference(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= MAX_REFERENCE_BYTES
  );
}

function iso(value: unknown): value is string {
  return (
    typeof value === "string" &&
    !Number.isNaN(Date.parse(value)) &&
    new Date(value).toISOString() === value
  );
}

export function isReactionEmojiV1(value: unknown): value is ReactionEmojiV1 {
  return typeof value === "string" && EMOJIS.has(value);
}

export function assertPublicMessageLocatorV1(
  value: unknown,
): asserts value is PublicMessageLocatorV1 {
  if (
    !record(value) ||
    !exact(value, [
      "root_session_id",
      "conversation_id",
      "revision_id",
      "target_event_id",
      "target_kind",
      "content_digest",
    ]) ||
    !reference(value.root_session_id) ||
    !reference(value.conversation_id) ||
    !reference(value.revision_id) ||
    !reference(value.target_event_id) ||
    (value.target_kind !== "user-message" && value.target_kind !== "completed-agent-response") ||
    typeof value.content_digest !== "string" ||
    !DIGEST.test(value.content_digest)
  )
    throw new Error("invalid public message locator");
}

export function assertPublicQuoteReferenceV1(
  value: unknown,
): asserts value is PublicQuoteReferenceV1 {
  if (!record(value) || !reference(value.author_public_id))
    throw new Error("invalid public quote reference");
  const { author_public_id: _author, ...locator } = value;
  assertPublicMessageLocatorV1(locator);
  if (!exact(value, [...Object.keys(locator), "author_public_id"]))
    throw new Error("invalid public quote reference");
}

export function reactionOperationDigest(
  value: Omit<ConversationReactionOperationV1, "operation_digest">,
): string {
  return digestV1("VF-CONVERSATION-REACTION-OPERATION\0v1\0", value);
}

export function assertConversationReactionOperationV1(
  value: unknown,
): asserts value is ConversationReactionOperationV1 {
  if (
    !record(value) ||
    !exact(value, [
      "schema_version",
      "operation_id",
      "root_session_id",
      "actor_public_id",
      "actor_kind",
      "operation",
      "target",
      "emoji",
      "prior_interaction_head_digest",
      "created_at",
      "operation_digest",
    ]) ||
    value.schema_version !== "1.0" ||
    typeof value.operation_id !== "string" ||
    !REACTION_ID.test(value.operation_id) ||
    !reference(value.root_session_id) ||
    !reference(value.actor_public_id) ||
    (value.actor_kind !== "human" && value.actor_kind !== "participant") ||
    (value.operation !== "add" && value.operation !== "remove") ||
    !isReactionEmojiV1(value.emoji) ||
    typeof value.prior_interaction_head_digest !== "string" ||
    !DIGEST.test(value.prior_interaction_head_digest) ||
    !iso(value.created_at) ||
    typeof value.operation_digest !== "string" ||
    !DIGEST.test(value.operation_digest)
  )
    throw new Error("invalid conversation reaction operation");
  assertPublicMessageLocatorV1(value.target);
  const typed = value as unknown as ConversationReactionOperationV1;
  const { operation_digest: _operationDigest, ...preimage } = typed;
  if (
    value.target.root_session_id !== value.root_session_id ||
    reactionOperationDigest(preimage) !== typed.operation_digest
  )
    throw new Error("conversation reaction operation binding changed");
}

export function participantSocialIntentDigest(
  value: Omit<ConversationParticipantSocialIntentV1, "intent_digest">,
): string {
  return digestV1("VF-CONVERSATION-PARTICIPANT-SOCIAL-INTENT\0v1\0", value);
}

export function assertConversationParticipantSocialIntentV1(
  value: unknown,
): asserts value is ConversationParticipantSocialIntentV1 {
  if (
    !record(value) ||
    !exact(value, [
      "schema_version",
      "intent_id",
      "root_session_id",
      "actor_participant_id",
      "response",
      "quote_refs",
      "reaction_operations",
      "diagnostic_code",
      "prior_interaction_head_digest",
      "created_at",
      "intent_digest",
    ]) ||
    value.schema_version !== "1.0" ||
    typeof value.intent_id !== "string" ||
    !INTENT_ID.test(value.intent_id) ||
    !reference(value.root_session_id) ||
    !reference(value.actor_participant_id) ||
    !Array.isArray(value.quote_refs) ||
    value.quote_refs.length > 8 ||
    !Array.isArray(value.reaction_operations) ||
    value.reaction_operations.length > 16 ||
    (value.diagnostic_code !== null && !reference(value.diagnostic_code)) ||
    typeof value.prior_interaction_head_digest !== "string" ||
    !DIGEST.test(value.prior_interaction_head_digest) ||
    !iso(value.created_at) ||
    typeof value.intent_digest !== "string" ||
    !DIGEST.test(value.intent_digest)
  )
    throw new Error("invalid participant social intent");
  assertPublicMessageLocatorV1(value.response);
  for (const quote of value.quote_refs) assertPublicQuoteReferenceV1(quote);
  for (const operation of value.reaction_operations)
    assertConversationReactionOperationV1(operation);
  const typed = value as unknown as ConversationParticipantSocialIntentV1;
  const { intent_digest: _intentDigest, ...preimage } = typed;
  if (
    value.response.root_session_id !== value.root_session_id ||
    value.reaction_operations.some(
      (operation) =>
        operation.root_session_id !== value.root_session_id ||
        operation.actor_kind !== "participant" ||
        operation.actor_public_id !== value.actor_participant_id ||
        operation.prior_interaction_head_digest !== value.prior_interaction_head_digest,
    ) ||
    participantSocialIntentDigest(preimage) !== typed.intent_digest
  )
    throw new Error("participant social intent binding changed");
}

export function interactionHeadDigest(
  value: Omit<ConversationInteractionHeadV1, "content_digest">,
): string {
  return digestV1("VF-CONVERSATION-INTERACTION-HEAD\0v1\0", value);
}

export function interactionFrameDigest(
  value: Omit<ConversationInteractionFrameV1, "frame_digest">,
): string {
  return digestV1("VF-CONVERSATION-INTERACTION-FRAME\0v1\0", value);
}

export function assertConversationInteractionHeadV1(
  value: unknown,
): asserts value is ConversationInteractionHeadV1 {
  if (
    !record(value) ||
    !exact(value, [
      "schema_version",
      "root_session_id",
      "sequence",
      "last_frame_digest",
      "updated_at",
      "content_digest",
    ]) ||
    value.schema_version !== "1.0" ||
    !reference(value.root_session_id) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 0 ||
    (value.last_frame_digest !== null &&
      (typeof value.last_frame_digest !== "string" || !DIGEST.test(value.last_frame_digest))) ||
    !iso(value.updated_at) ||
    typeof value.content_digest !== "string" ||
    !DIGEST.test(value.content_digest) ||
    (value.sequence === 0) !== (value.last_frame_digest === null) ||
    (() => {
      const typed = value as unknown as ConversationInteractionHeadV1;
      const { content_digest: _contentDigest, ...preimage } = typed;
      return interactionHeadDigest(preimage) !== typed.content_digest;
    })()
  )
    throw new Error("invalid conversation interaction head");
}

export function assertConversationInteractionFrameV1(
  value: unknown,
): asserts value is ConversationInteractionFrameV1 {
  if (
    !record(value) ||
    !exact(value, [
      "schema_version",
      "root_session_id",
      "sequence",
      "previous_frame_digest",
      "entry",
      "frame_digest",
    ]) ||
    value.schema_version !== "1.0" ||
    !reference(value.root_session_id) ||
    !Number.isSafeInteger(value.sequence) ||
    (value.sequence as number) < 1 ||
    (value.previous_frame_digest !== null &&
      (typeof value.previous_frame_digest !== "string" ||
        !DIGEST.test(value.previous_frame_digest))) ||
    !record(value.entry) ||
    typeof value.frame_digest !== "string" ||
    !DIGEST.test(value.frame_digest)
  )
    throw new Error("invalid conversation interaction frame");
  if (value.entry.kind === "reaction-operation") {
    if (!exact(value.entry, ["kind", "operation"]))
      throw new Error("invalid conversation interaction entry");
    assertConversationReactionOperationV1(value.entry.operation);
  } else if (value.entry.kind === "participant-social-intent") {
    if (!exact(value.entry, ["kind", "intent"]))
      throw new Error("invalid conversation interaction entry");
    assertConversationParticipantSocialIntentV1(value.entry.intent);
  } else throw new Error("invalid conversation interaction entry");
  const typed = value as unknown as ConversationInteractionFrameV1;
  const { frame_digest: _frameDigest, ...preimage } = typed;
  if (interactionFrameDigest(preimage) !== typed.frame_digest)
    throw new Error("conversation interaction frame digest changed");
}

export function sameCanonicalInteraction(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}
