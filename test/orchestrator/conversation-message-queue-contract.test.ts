import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { PublicQuoteReferenceV1 } from "../../src/orchestrator/conversation/conversation-interaction-types.js";
import {
  CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS,
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_IDS,
  CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODES,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KINDS,
  CONVERSATION_MESSAGE_QUEUE_FIELD,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KINDS,
  CONVERSATION_MESSAGE_QUEUE_NONTERMINAL_STATES,
  CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KINDS,
  CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASONS,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_STATES,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODES,
  type ConversationMessageQueueQuoteTargetKindV1,
  type ConversationMessageQueueRecoveryFaultV1,
  type ConversationMessageQueueRecoveryReportV1,
  isConversationMessageQueueAuthorPublicId,
  isConversationMessageQueueErrorCode,
  isConversationMessageQueueEventKind,
  isConversationMessageQueueMutationKind,
  isConversationMessageQueueNonterminalState,
  isConversationMessageQueueQuoteTargetKind,
  isConversationMessageQueueStaleReason,
  isConversationMessageQueueState,
  isConversationMessageQueueTargetParticipantMode,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import type { PrivateConversationMessageQueuePendingMutationV1 } from "../../src/orchestrator/conversation/conversation-message-queue-pending.js";
import type {
  ConversationMessageQueueAuthorityV1,
  ConversationMessageQueueSnapshotV1,
  EditQueuedUserMessageRequestV1,
  EnqueueConversationUserMessageRequestV1,
  PrivateConversationMessageQueueClaimOwnerV1,
  PrivateConversationMessageQueueContextBindingV1,
  PrivateConversationMessageQueueContextDispositionV1,
  PrivateConversationMessageQueueCurrentV1,
  PrivateConversationMessageQueueDeliveryProofV1,
  PrivateConversationMessageQueueEventPayloadV1,
  PrivateConversationMessageQueueEventV1,
  PrivateConversationMessageQueueIdempotencyBindingV1,
  PublicConversationMessageQueueInvalidationV1,
  PublicQueuedUserMessageV1,
} from "../../src/orchestrator/conversation/conversation-message-queue-records.js";
import type { ConversationMessageQueueRootMarkerV1 } from "../../src/orchestrator/conversation/conversation-message-queue-root-marker.js";

type SameKeys<RecordType, Fields extends readonly PropertyKey[]> = Exclude<
  keyof RecordType,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof RecordType> extends never
    ? true
    : false
  : false;

type SameUnion<Left, Right> = [Exclude<Left, Right>, Exclude<Right, Left>] extends [never, never]
  ? true
  : false;

const semanticTypeParity = Object.freeze({
  QUOTE_TARGET_KIND: true satisfies SameUnion<
    PublicQuoteReferenceV1["target_kind"],
    ConversationMessageQueueQuoteTargetKindV1
  >,
});

type EventPayload<
  Kind extends
    PrivateConversationMessageQueueEventPayloadV1[typeof CONVERSATION_MESSAGE_QUEUE_FIELD.KIND],
> = Extract<
  PrivateConversationMessageQueueEventPayloadV1,
  { [CONVERSATION_MESSAGE_QUEUE_FIELD.KIND]: Kind }
>;

const exactRecordTypeParity = Object.freeze({
  ROOT_MARKER: true satisfies SameKeys<
    ConversationMessageQueueRootMarkerV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.ROOT_MARKER
  >,
  AUTHORITY: true satisfies SameKeys<
    ConversationMessageQueueAuthorityV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.AUTHORITY
  >,
  ENQUEUE_REQUEST: true satisfies SameKeys<
    EnqueueConversationUserMessageRequestV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.ENQUEUE_REQUEST
  >,
  EDIT_REQUEST: true satisfies SameKeys<
    EditQueuedUserMessageRequestV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EDIT_REQUEST
  >,
  QUOTE_REFERENCE: true satisfies SameKeys<
    PublicQuoteReferenceV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.QUOTE_REFERENCE
  >,
  PUBLIC_ITEM: true satisfies SameKeys<
    PublicQueuedUserMessageV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.PUBLIC_ITEM
  >,
  SNAPSHOT: true satisfies SameKeys<
    ConversationMessageQueueSnapshotV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.SNAPSHOT
  >,
  INVALIDATION: true satisfies SameKeys<
    PublicConversationMessageQueueInvalidationV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.INVALIDATION
  >,
  CLAIM_OWNER: true satisfies SameKeys<
    PrivateConversationMessageQueueClaimOwnerV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.CLAIM_OWNER
  >,
  CONTEXT_DISPOSITION: true satisfies SameKeys<
    PrivateConversationMessageQueueContextDispositionV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.CONTEXT_DISPOSITION
  >,
  DELIVERY_PROOF: true satisfies SameKeys<
    PrivateConversationMessageQueueDeliveryProofV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.DELIVERY_PROOF
  >,
  CONTEXT_BINDING: true satisfies SameKeys<
    PrivateConversationMessageQueueContextBindingV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.CONTEXT_BINDING
  >,
  EVENT_ADMITTED_PAYLOAD: true satisfies SameKeys<
    EventPayload<typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.ADMITTED>,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_ADMITTED_PAYLOAD
  >,
  EVENT_EDITED_PAYLOAD: true satisfies SameKeys<
    EventPayload<typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.EDITED>,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_EDITED_PAYLOAD
  >,
  EVENT_CLAIMED_PAYLOAD: true satisfies SameKeys<
    EventPayload<typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.CLAIMED>,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_CLAIMED_PAYLOAD
  >,
  EVENT_DELIVERED_PAYLOAD: true satisfies SameKeys<
    EventPayload<typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.DELIVERED>,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_DELIVERED_PAYLOAD
  >,
  EVENT_STALE_PAYLOAD: true satisfies SameKeys<
    EventPayload<typeof CONVERSATION_MESSAGE_QUEUE_EVENT_KIND.STALE>,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT_STALE_PAYLOAD
  >,
  EVENT: true satisfies SameKeys<
    PrivateConversationMessageQueueEventV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.EVENT
  >,
  CURRENT: true satisfies SameKeys<
    PrivateConversationMessageQueueCurrentV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.CURRENT
  >,
  IDEMPOTENCY_BINDING: true satisfies SameKeys<
    PrivateConversationMessageQueueIdempotencyBindingV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.IDEMPOTENCY_BINDING
  >,
  PENDING_MUTATION: true satisfies SameKeys<
    PrivateConversationMessageQueuePendingMutationV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.PENDING_MUTATION
  >,
  RECOVERY_FAULT: true satisfies SameKeys<
    ConversationMessageQueueRecoveryFaultV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.RECOVERY_FAULT
  >,
  RECOVERY_REPORT: true satisfies SameKeys<
    ConversationMessageQueueRecoveryReportV1,
    typeof CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS.RECOVERY_REPORT
  >,
});

const contractObjects = [
  CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE,
  CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID,
  CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND,
  CONVERSATION_MESSAGE_QUEUE_STATE,
  CONVERSATION_MESSAGE_QUEUE_STALE_REASON,
  CONVERSATION_MESSAGE_QUEUE_EVENT_KIND,
  CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND,
  CONVERSATION_MESSAGE_QUEUE_AUTHORITY_STATUS,
  CONVERSATION_MESSAGE_QUEUE_CLAIM_RESULT_STATUS,
  CONVERSATION_MESSAGE_QUEUE_PENDING_MUTATION_STATE,
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
] as const;

describe("conversation message queue typed runtime contract", () => {
  test("runtime values are frozen, inferred, and narrowed fail-closed", () => {
    expect(contractObjects.every(Object.isFrozen)).toBe(true);
    expect(CONVERSATION_MESSAGE_QUEUE_STATES).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_STATE),
    );
    expect(Object.isFrozen(CONVERSATION_MESSAGE_QUEUE_NONTERMINAL_STATES)).toBe(true);
    expect(CONVERSATION_MESSAGE_QUEUE_NONTERMINAL_STATES).toEqual([
      CONVERSATION_MESSAGE_QUEUE_STATE.QUEUED,
      CONVERSATION_MESSAGE_QUEUE_STATE.CLAIMED,
    ]);
    expect(CONVERSATION_MESSAGE_QUEUE_STALE_REASONS).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_STALE_REASON),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_EVENT_KINDS).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_EVENT_KIND),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_MUTATION_KINDS).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_MUTATION_KIND),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_ERROR_CODES).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_ERROR_CODE),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODES).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODE),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_IDS).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_ID),
    );
    expect(CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KINDS).toEqual(
      Object.values(CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KIND),
    );
    expect(Object.values(semanticTypeParity).every(Boolean)).toBe(true);
    expect(CONVERSATION_MESSAGE_QUEUE_STATES.every(isConversationMessageQueueState)).toBe(true);
    expect(
      CONVERSATION_MESSAGE_QUEUE_NONTERMINAL_STATES.every(
        isConversationMessageQueueNonterminalState,
      ),
    ).toBe(true);
    expect(
      CONVERSATION_MESSAGE_QUEUE_TARGET_PARTICIPANT_MODES.every(
        isConversationMessageQueueTargetParticipantMode,
      ),
    ).toBe(true);
    expect(
      CONVERSATION_MESSAGE_QUEUE_AUTHOR_PUBLIC_IDS.every(isConversationMessageQueueAuthorPublicId),
    ).toBe(true);
    expect(
      CONVERSATION_MESSAGE_QUEUE_QUOTE_TARGET_KINDS.every(
        isConversationMessageQueueQuoteTargetKind,
      ),
    ).toBe(true);
    expect(
      CONVERSATION_MESSAGE_QUEUE_STALE_REASONS.every(isConversationMessageQueueStaleReason),
    ).toBe(true);
    expect(CONVERSATION_MESSAGE_QUEUE_EVENT_KINDS.every(isConversationMessageQueueEventKind)).toBe(
      true,
    );
    expect(
      CONVERSATION_MESSAGE_QUEUE_MUTATION_KINDS.every(isConversationMessageQueueMutationKind),
    ).toBe(true);
    expect(CONVERSATION_MESSAGE_QUEUE_ERROR_CODES.every(isConversationMessageQueueErrorCode)).toBe(
      true,
    );
    expect([
      isConversationMessageQueueState("unknown"),
      isConversationMessageQueueStaleReason(null),
      isConversationMessageQueueEventKind(1),
      isConversationMessageQueueMutationKind("remove"),
      isConversationMessageQueueErrorCode("internal_error"),
      isConversationMessageQueueTargetParticipantMode("some"),
      isConversationMessageQueueAuthorPublicId("participant"),
      isConversationMessageQueueQuoteTargetKind("tool-message"),
      isConversationMessageQueueNonterminalState(CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED),
    ]).toEqual([false, false, false, false, false, false, false, false, false]);
  });

  test("persisted record fields are frozen, unique, known, and type-exact", () => {
    const knownFields = new Set(Object.values(CONVERSATION_MESSAGE_QUEUE_FIELD));
    const recordFields = Object.values(CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS);
    expect(Object.isFrozen(CONVERSATION_MESSAGE_QUEUE_FIELD)).toBe(true);
    expect(Object.isFrozen(CONVERSATION_MESSAGE_QUEUE_RECORD_FIELDS)).toBe(true);
    expect(recordFields.every(Object.isFrozen)).toBe(true);
    for (const fields of recordFields) {
      expect(new Set(fields).size).toBe(fields.length);
      expect(fields.every((field) => knownFields.has(field))).toBe(true);
    }
    expect(Object.values(exactRecordTypeParity).every(Boolean)).toBe(true);
  });

  test("browser-facing queue contracts remain dependency-free", () => {
    for (const path of [
      resolve("src/orchestrator/conversation/conversation-message-queue-contract.ts"),
      resolve("src/orchestrator/conversation/conversation-message-queue-error-contract.ts"),
      resolve("src/orchestrator/conversation/conversation-message-queue-fields.ts"),
      resolve("src/orchestrator/conversation/conversation-message-queue-wire.ts"),
    ]) {
      const source = readFileSync(path, "utf8");
      expect(source).not.toMatch(
        /(?:from\s+|import\s+)["'][^"']*(?:bun:|node:|durability|lineage-storage-key)/,
      );
    }
  });
});
