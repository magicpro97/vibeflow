import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  isConversationMessageQueueStaleReason,
  isConversationMessageQueueState,
} from "../../orchestrator/conversation/conversation-message-queue-contract.js";
import { ConversationHomeApiError } from "./conversation-home-api.js";
import type {
  HomeQueuedMessage,
  HomeQueuedMessageEditBinding,
} from "./conversation-home-message-queue-types.js";

const DIGEST = /^sha256:[0-9a-f]{64}$/;

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function exactKeys(value: Record<string, unknown>, expected: readonly string[]): boolean {
  const actual = Object.keys(value).sort();
  const sortedExpected = [...expected].sort();
  return (
    actual.length === sortedExpected.length &&
    actual.every((key, index) => key === sortedExpected[index])
  );
}

const samePublicList = (left: unknown, right: unknown): boolean =>
  JSON.stringify(left) === JSON.stringify(right);

export function sameHomeQueueEditBinding(
  current: HomeQueuedMessageEditBinding | null,
  expected: HomeQueuedMessageEditBinding,
): boolean {
  return Boolean(
    current &&
      current.root_session_id === expected.root_session_id &&
      current.queue_item_id === expected.queue_item_id &&
      current.item_digest === expected.item_digest &&
      current.queue_sequence === expected.queue_sequence,
  );
}

export function preservesHomeQueueEditAuthority(
  before: HomeQueuedMessage,
  after: HomeQueuedMessage,
  expectedContent: string,
): boolean {
  return (
    after.state === CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED &&
    after.stale_reason === null &&
    after.content === expectedContent &&
    before.queue_item_id === after.queue_item_id &&
    before.queue_sequence === after.queue_sequence &&
    before.root_session_id === after.root_session_id &&
    before.author_public_id === after.author_public_id &&
    samePublicList(before.target_participants, after.target_participants) &&
    samePublicList(before.quote_refs, after.quote_refs) &&
    before.private_context_present === after.private_context_present &&
    before.predecessor_queue_item_id === after.predecessor_queue_item_id &&
    before.admitted_authority_digest === after.admitted_authority_digest &&
    before.effective_authority_digest === after.effective_authority_digest &&
    before.admitted_at === after.admitted_at
  );
}

function matchesCommonConflict(
  details: Record<string, unknown>,
  binding: HomeQueuedMessageEditBinding,
): boolean {
  return (
    details.root_session_id === binding.root_session_id &&
    details.queue_item_id === binding.queue_item_id &&
    typeof details.item_digest === "string" &&
    DIGEST.test(details.item_digest)
  );
}

export function matchesHomeQueueEditConflict(
  error: unknown,
  binding: HomeQueuedMessageEditBinding,
): boolean {
  if (!(error instanceof ConversationHomeApiError) || error.status !== 409) return false;
  const details = error.publicError.details;
  if (!record(details)) return false;
  if (
    error.publicError.code === CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE
  ) {
    return (
      exactKeys(details, ["root_session_id", "queue_item_id", "state", "item_digest"]) &&
      matchesCommonConflict(details, binding) &&
      isConversationMessageQueueState(details.state)
    );
  }
  if (error.publicError.code !== CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE)
    return false;
  return (
    exactKeys(details, ["root_session_id", "queue_item_id", "stale_reason", "item_digest"]) &&
    matchesCommonConflict(details, binding) &&
    isConversationMessageQueueStaleReason(details.stale_reason)
  );
}
