import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODES,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  type ConversationMessageQueueErrorCodeV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELDS,
  CONVERSATION_MESSAGE_QUEUE_ERROR_SEMANTICS,
  isConversationMessageQueueErrorDetails,
  isConversationMessageQueueErrorSemantic,
} from "../../src/orchestrator/conversation/conversation-message-queue-error-contract.js";

const queueItemId = `vf-queued-message-${"a".repeat(64)}`;
const itemDigest = `sha256:${"b".repeat(64)}`;

const canonicalDetails = Object.freeze({
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.UNAUTHENTICATED]: null,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.FORBIDDEN]: null,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_FOUND]: null,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE]: {
    max_body_bytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes,
  },
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.AUTHORITY_CORRUPT]: null,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_FULL]: {
    root_session_id: "root-session",
    max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
  },
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED]: {
    max_pending_private_contexts: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
  },
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.INVALID_REQUEST]: null,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.SERVICE_UNAVAILABLE]: null,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT]: null,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT]: {
    private_context_present: true,
    queue_owned: false,
  },
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE]: {
    root_session_id: "root-session",
    queue_item_id: queueItemId,
    state: CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
    item_digest: itemDigest,
  },
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE]: {
    root_session_id: "root-session",
    queue_item_id: queueItemId,
    stale_reason: CONVERSATION_MESSAGE_QUEUE_STALE_REASON.LINEAGE_HEAD_CHANGED,
    item_digest: itemDigest,
  },
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_CLAIM_BUSY]: null,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.NOT_LINEAGE_HEAD]: null,
  [CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUE_AUTHORITY_CORRUPT]: null,
} satisfies Readonly<Record<ConversationMessageQueueErrorCodeV1, unknown>>);

describe("conversation message queue error contract", () => {
  test("freezes one exhaustive semantic and detail-shape authority", () => {
    expect(Object.isFrozen(CONVERSATION_MESSAGE_QUEUE_ERROR_SEMANTICS)).toBeTrue();
    expect(Object.isFrozen(CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELDS)).toBeTrue();
    expect(Object.keys(CONVERSATION_MESSAGE_QUEUE_ERROR_SEMANTICS)).toEqual([
      ...CONVERSATION_MESSAGE_QUEUE_ERROR_CODES,
    ]);
    expect(Object.keys(CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELDS)).toEqual([
      ...CONVERSATION_MESSAGE_QUEUE_ERROR_CODES,
    ]);

    for (const code of CONVERSATION_MESSAGE_QUEUE_ERROR_CODES) {
      const expected = CONVERSATION_MESSAGE_QUEUE_ERROR_SEMANTICS[code];
      expect(Object.isFrozen(expected)).toBeTrue();
      expect(Object.isFrozen(expected.recovery_actions)).toBeTrue();
      for (const recoveryAction of expected.recovery_actions)
        expect(
          isConversationMessageQueueErrorSemantic(code, expected.retryable, recoveryAction),
        ).toBeTrue();
      expect(
        isConversationMessageQueueErrorSemantic(code, !expected.retryable, "future-recovery"),
      ).toBeFalse();

      const detailFields = CONVERSATION_MESSAGE_QUEUE_ERROR_DETAIL_FIELDS[code];
      if (detailFields !== null) expect(Object.isFrozen(detailFields)).toBeTrue();
      const details = canonicalDetails[code];
      expect(isConversationMessageQueueErrorDetails(code, details)).toBeTrue();
      expect(
        isConversationMessageQueueErrorDetails(
          code,
          details === null ? {} : { ...details, unexpected: true },
        ),
      ).toBeFalse();
    }
  });

  test("rejects semantically invalid field values after exact-key validation", () => {
    expect(
      isConversationMessageQueueErrorDetails(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.REQUEST_TOO_LARGE,
        { max_body_bytes: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxObjectBytes - 1 },
      ),
    ).toBeFalse();
    expect(
      isConversationMessageQueueErrorDetails(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
        { private_context_present: "yes", queue_owned: false },
      ),
    ).toBeFalse();
    expect(
      isConversationMessageQueueErrorDetails(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.QUEUED_MESSAGE_NOT_EDITABLE,
        {
          ...canonicalDetails.queued_message_not_editable,
          queue_item_id: "not-a-queue-item",
        },
      ),
    ).toBeFalse();
    expect(
      isConversationMessageQueueErrorDetails(
        CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.STALE_QUEUED_MESSAGE,
        { ...canonicalDetails.stale_queued_message, stale_reason: "future-reason" },
      ),
    ).toBeFalse();
  });
});
