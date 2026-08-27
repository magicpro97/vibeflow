import { describe, expect, test } from "bun:test";
import { canonicalJsonBytes, digestV1 } from "../../src/durability/index.js";
import type { PublicQuoteReferenceV1 } from "../../src/orchestrator/conversation/conversation-interaction-types.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_DIGEST_DOMAIN,
  CONVERSATION_MESSAGE_QUEUE_FIELD,
  CONVERSATION_MESSAGE_QUEUE_LIMITS,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import type {
  ConversationMessageQueueSnapshotV1,
  EnqueueConversationUserMessageRequestV1,
  PublicConversationMessageQueueInvalidationV1,
  PublicQueuedUserMessageV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-records.js";
import {
  conversationMessageQueueRootFromMarkerBytes,
  materializeConversationMessageQueueRootMarker,
} from "../../src/orchestrator/conversation/conversation-message-queue-root-marker.js";
import { assertEnqueueConversationUserMessageRequestV1 } from "../../src/orchestrator/conversation/conversation-message-queue-validation.js";
import {
  isConversationMessageQueueReference,
  isConversationMessageQueueSnapshotWireV1,
  isPublicConversationMessageQueueInvalidationWireV1,
  isPublicConversationMessageQueueQuoteReferenceWireV1,
  isPublicQueuedUserMessageWireV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-wire.js";

describe("conversation message queue typed runtime contract", () => {
  test("public wire guards fail closed on exact-key, root, and nested quote drift", () => {
    const digest = `sha256:${"a".repeat(64)}`;
    const queueItemId = `vf-queued-message-${"b".repeat(64)}`;
    const rootSessionId = "queue-wire-root";
    const item: PublicQueuedUserMessageV1 = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      queue_item_id: queueItemId,
      queue_sequence: 1,
      root_session_id: rootSessionId,
      author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
      content: "queued",
      content_digest: digest,
      target_participants: CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE.ALL,
      quote_refs: [],
      private_context_present: false,
      predecessor_queue_item_id: null,
      admitted_authority_digest: digest,
      effective_authority_digest: digest,
      state: CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED,
      stale_reason: null,
      admitted_at: "2026-08-26T00:00:00.000Z",
      updated_at: "2026-08-26T00:00:00.000Z",
      item_digest: digest,
    };
    const snapshot: ConversationMessageQueueSnapshotV1 = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      root_session_id: rootSessionId,
      current_authority_digest: digest,
      max_nonterminal_items: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems,
      items: [item],
    };
    const invalidation: PublicConversationMessageQueueInvalidationV1 = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      root_session_id: rootSessionId,
      queue_item_id: queueItemId,
      state: CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED,
      item_digest: digest,
    };

    expect(isPublicQueuedUserMessageWireV1(item)).toBe(true);
    expect(isConversationMessageQueueSnapshotWireV1(snapshot, rootSessionId)).toBe(true);
    expect(isPublicConversationMessageQueueInvalidationWireV1(invalidation, rootSessionId)).toBe(
      true,
    );
    expect(isPublicQueuedUserMessageWireV1({ ...item, unexpected: true })).toBe(false);
    expect(
      isConversationMessageQueueSnapshotWireV1({ ...snapshot, unexpected: true }, rootSessionId),
    ).toBe(false);
    expect(
      isPublicConversationMessageQueueInvalidationWireV1(
        { ...invalidation, unexpected: true },
        rootSessionId,
      ),
    ).toBe(false);
    expect(isPublicConversationMessageQueueInvalidationWireV1(invalidation, "different-root")).toBe(
      false,
    );
    expect(
      isPublicQueuedUserMessageWireV1({
        ...item,
        quote_refs: [
          {
            root_session_id: rootSessionId,
            conversation_id: "conversation",
            revision_id: "revision",
            target_event_id: "event",
            target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.USER_MESSAGE,
            content_digest: digest,
            author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
            unexpected: true,
          },
        ],
      }),
    ).toBe(false);
    const canonicalQuote: PublicQuoteReferenceV1 = {
      root_session_id: rootSessionId,
      conversation_id: "conversation",
      revision_id: "revision",
      target_event_id: "event",
      target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.USER_MESSAGE,
      content_digest: digest,
      author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
    };
    expect(isPublicQueuedUserMessageWireV1({ ...item, quote_refs: [canonicalQuote] })).toBe(true);
    expect(
      isPublicQueuedUserMessageWireV1({
        ...item,
        quote_refs: [{ ...canonicalQuote, root_session_id: "different-root" }],
      }),
    ).toBe(false);
    expect(
      isPublicQueuedUserMessageWireV1({
        ...item,
        admitted_at: "2026-08-26T00:00:01.000Z",
        updated_at: "2026-08-26T00:00:00.999Z",
      }),
    ).toBe(false);

    const nonterminalOverflow = Array.from(
      { length: CONVERSATION_MESSAGE_QUEUE_LIMITS.maxNonterminalItems + 1 },
      (_, index): PublicQueuedUserMessageV1 => ({
        ...item,
        queue_item_id: `vf-queued-message-${(index + 1).toString(16).padStart(64, "0")}`,
        queue_sequence: index + 1,
      }),
    );
    expect(
      isConversationMessageQueueSnapshotWireV1(
        { ...snapshot, items: nonterminalOverflow },
        rootSessionId,
      ),
    ).toBe(false);
    expect(
      isConversationMessageQueueSnapshotWireV1(
        {
          ...snapshot,
          items: nonterminalOverflow.map((entry) => ({
            ...entry,
            state: CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED,
          })),
        },
        rootSessionId,
      ),
    ).toBe(true);
  });

  test("browser and backend queue references share byte, control, and quote semantics", () => {
    const digest = `sha256:${"c".repeat(64)}`;
    const canonicalQuote: PublicQuoteReferenceV1 = {
      root_session_id: "root",
      conversation_id: "conversation",
      revision_id: "revision",
      target_event_id: "event",
      target_kind: CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND.COMPLETED_AGENT_RESPONSE,
      content_digest: digest,
      author_public_id: CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID.HUMAN,
    };
    const canonicalRequest: EnqueueConversationUserMessageRequestV1 = {
      schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      idempotency_key: "queue-wire-reference",
      expected_authority_digest: digest,
      client_instance_id: "queue-wire-client",
      client_order: 1,
      content: "queued",
      target_participants: ["agent-a"],
      quote_refs: [canonicalQuote],
      private_context_present: false,
    };

    expect(
      isConversationMessageQueueReference(
        "a".repeat(CONVERSATION_MESSAGE_QUEUE_LIMITS.maxReferenceBytes),
      ),
    ).toBe(true);
    expect(
      isConversationMessageQueueReference(
        "a".repeat(CONVERSATION_MESSAGE_QUEUE_LIMITS.maxReferenceBytes + 1),
      ),
    ).toBe(false);
    expect(isConversationMessageQueueReference("agent\nname")).toBe(false);
    expect(isPublicConversationMessageQueueQuoteReferenceWireV1(canonicalQuote)).toBe(true);
    expect(() => assertEnqueueConversationUserMessageRequestV1(canonicalRequest)).not.toThrow();

    for (const request of [
      { ...canonicalRequest, client_instance_id: "client\nprivate" },
      { ...canonicalRequest, client_instance_id: "a".repeat(129) },
      { ...canonicalRequest, client_order: 0 },
      { ...canonicalRequest, client_order: Number.MAX_SAFE_INTEGER + 1 },
      { ...canonicalRequest, target_participants: ["agent\nname"] },
      {
        ...canonicalRequest,
        target_participants: ["a".repeat(CONVERSATION_MESSAGE_QUEUE_LIMITS.maxReferenceBytes + 1)],
      },
      {
        ...canonicalRequest,
        quote_refs: [{ ...canonicalQuote, target_event_id: "event\0private" }],
      },
      {
        ...canonicalRequest,
        quote_refs: [
          {
            ...canonicalQuote,
            author_public_id: "a".repeat(CONVERSATION_MESSAGE_QUEUE_LIMITS.maxReferenceBytes + 1),
          },
        ],
      },
    ]) {
      expect(() => assertEnqueueConversationUserMessageRequestV1(request)).toThrow();
    }
  });

  test("root marker decoding keeps the same frozen exact-key contract", () => {
    const rootSessionId = "queue-contract-root";
    const materialized = materializeConversationMessageQueueRootMarker(rootSessionId);
    expect(
      conversationMessageQueueRootFromMarkerBytes(materialized.file_name, materialized.bytes),
    ).toBe(rootSessionId);
    const base = {
      [CONVERSATION_MESSAGE_QUEUE_FIELD.SCHEMA_VERSION]: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
      [CONVERSATION_MESSAGE_QUEUE_FIELD.ROOT_SESSION_ID]: rootSessionId,
    };
    const extendedBase = { ...base, unexpected_field: true };
    const extendedMarker = {
      ...extendedBase,
      [CONVERSATION_MESSAGE_QUEUE_FIELD.MARKER_DIGEST]: digestV1(
        CONVERSATION_MESSAGE_QUEUE_DIGEST_DOMAIN.ROOT_MARKER,
        extendedBase,
      ),
    };
    expect(
      conversationMessageQueueRootFromMarkerBytes(
        materialized.file_name,
        canonicalJsonBytes(extendedMarker),
      ),
    ).toBeNull();
  });
});
