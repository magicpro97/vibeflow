import { describe, expect, test } from "bun:test";
import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { ENGINES } from "../../src/core.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_STATE,
} from "../../src/orchestrator/conversation/conversation-message-queue-contract.js";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODES,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KINDS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINES,
  CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOL,
  CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOLS,
  CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE,
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATES,
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITION,
  CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITIONS,
  CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT,
  CONVERSATION_PRIVATE_CONTEXT_FAULT_POINTS,
  CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX,
  CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE,
  CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATES,
  CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITION,
  CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITIONS,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITIONS,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME,
  CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOMES,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_BINDING_SCHEMA_VERSION,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATES,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND,
  CONVERSATION_PRIVATE_CONTEXT_SOURCE_KINDS,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_KINDS,
  CONVERSATION_PRIVATE_CONTEXT_STORAGE,
  isConversationPrivateContextBrokerErrorCode,
  isConversationPrivateContextBrokerRecordKind,
  isConversationPrivateContextBrokerSchemaVersion,
  isConversationPrivateContextCreateEngine,
  isConversationPrivateContextCreateHostTool,
  isConversationPrivateContextDigest,
  isConversationPrivateContextDiscardNamespace,
  isConversationPrivateContextDraftStageState,
  isConversationPrivateContextDraftStageTransition,
  isConversationPrivateContextFaultPoint,
  isConversationPrivateContextMessageStageState,
  isConversationPrivateContextMessageStageTransition,
  isConversationPrivateContextQueueDisposition,
  isConversationPrivateContextQueueItemId,
  isConversationPrivateContextQueueOutcome,
  isConversationPrivateContextSourceFrameState,
  isConversationPrivateContextSourceKind,
  isConversationPrivateContextSourceRecordRef,
  isConversationPrivateContextStageKind,
} from "../../src/orchestrator/conversation/conversation-private-context-broker-contract.js";
import { ConversationPrivateContextBrokerConflictError } from "../../src/orchestrator/conversation/conversation-private-context-broker-validation.js";
import { PRIVATE_FILE_RANGE_MAX_FRAMES } from "../../src/orchestrator/conversation/private-file-range-staging-store.js";

const values = <Value extends string>(record: Record<string, Value>): Value[] =>
  Object.values(record);

const expectFrozenVocabulary = <Value extends string>(
  record: Readonly<Record<string, Value>>,
  list: readonly Value[],
): void => {
  expect(Object.isFrozen(record)).toBe(true);
  expect(Object.isFrozen(list)).toBe(true);
  expect(list).toEqual(values(record));
  expect(new Set(list).size).toBe(list.length);
};

describe("conversation private-context broker typed contract", () => {
  test("freezes each closed vocabulary and keeps its inferred value list in parity", () => {
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND,
      CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KINDS,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND,
      CONVERSATION_PRIVATE_CONTEXT_SOURCE_KINDS,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE,
      CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATES,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE,
      CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATES,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND,
      CONVERSATION_PRIVATE_CONTEXT_STAGE_KINDS,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE,
      CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODES,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME,
      CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOMES,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION,
      CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITIONS,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE,
      CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATES,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT,
      CONVERSATION_PRIVATE_CONTEXT_FAULT_POINTS,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOL,
      CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOLS,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITION,
      CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITIONS,
    );
    expectFrozenVocabulary(
      CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITION,
      CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITIONS,
    );
    expect(CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE).toBe(
      CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND,
    );
    for (const contractObject of [
      CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS,
      CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS,
      CONVERSATION_PRIVATE_CONTEXT_STORAGE,
      CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX,
      CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND,
      CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND,
      CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN,
      CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD,
    ])
      expect(Object.isFrozen(contractObject)).toBe(true);
  });

  test("reuses identical queue vocabularies and keeps broker-specific bounds independent", () => {
    expect(CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE).toEqual({
      IDEMPOTENCY_CONFLICT: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.IDEMPOTENCY_CONFLICT,
      PRIVATE_CONTEXT_CONFLICT: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
      RATE_LIMITED: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.RATE_LIMITED,
    });
    expect(CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME).toEqual({
      DELIVERED: CONVERSATION_MESSAGE_QUEUE_STATE.DELIVERED,
      STALE: CONVERSATION_MESSAGE_QUEUE_STATE.STALE,
    });
    expect(CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxPendingContexts).toBe(32);
    expect(CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxRecordBytes).toBe(512 * 1_024);
    expect(CONVERSATION_PRIVATE_CONTEXT_SOURCE_BINDING_SCHEMA_VERSION).toBe("1.0");
    expect(CONVERSATION_PRIVATE_CONTEXT_BROKER_LIMITS.maxStageRecords).toBe(
      PRIVATE_FILE_RANGE_MAX_FRAMES,
    );
    expect(CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINES).toEqual(ENGINES);
    expect(Object.isFrozen(CONVERSATION_PRIVATE_CONTEXT_CREATE_ENGINES)).toBe(true);
  });

  test("guards every untrusted closed vocabulary before narrowing", () => {
    const valid = [
      isConversationPrivateContextBrokerSchemaVersion(
        CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      ),
      isConversationPrivateContextBrokerRecordKind(
        CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND.MESSAGE_STAGE,
      ),
      isConversationPrivateContextSourceKind(
        CONVERSATION_PRIVATE_CONTEXT_SOURCE_KIND.PRIVATE_FILE_RANGE,
      ),
      isConversationPrivateContextMessageStageState(
        CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATE.ADMISSION_OWNED,
      ),
      isConversationPrivateContextDraftStageState(
        CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATE.TRANSFER_OWNED,
      ),
      isConversationPrivateContextStageKind(CONVERSATION_PRIVATE_CONTEXT_STAGE_KIND.MESSAGE),
      isConversationPrivateContextDiscardNamespace(
        CONVERSATION_PRIVATE_CONTEXT_DISCARD_NAMESPACE.DRAFT,
      ),
      isConversationPrivateContextBrokerErrorCode(
        CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODE.PRIVATE_CONTEXT_CONFLICT,
      ),
      isConversationPrivateContextQueueOutcome(
        CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOME.DELIVERED,
      ),
      isConversationPrivateContextQueueDisposition(
        CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITION.RELEASED,
      ),
      isConversationPrivateContextSourceFrameState(
        CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATE.RESERVED,
      ),
      isConversationPrivateContextFaultPoint(
        CONVERSATION_PRIVATE_CONTEXT_FAULT_POINT.AFTER_PRIVATE_SOURCE_STAGE,
      ),
      isConversationPrivateContextCreateEngine(ENGINES[0]),
      isConversationPrivateContextCreateHostTool(
        CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOL.PROPOSE_ACTION,
      ),
      isConversationPrivateContextMessageStageTransition(
        CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_TRANSITION.ADMISSION_OWNED_TO_RELEASED,
      ),
      isConversationPrivateContextDraftStageTransition(
        CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_TRANSITION.TRANSFER_OWNED_TO_CONSUMED,
      ),
      isConversationPrivateContextDigest(`sha256:${"a".repeat(64)}`),
      isConversationPrivateContextQueueItemId(`vf-queued-message-${"b".repeat(64)}`),
      isConversationPrivateContextSourceRecordRef(`vf-file-range-${"c".repeat(64)}`),
    ];
    expect(valid.every(Boolean)).toBe(true);

    const guards = [
      isConversationPrivateContextBrokerSchemaVersion,
      isConversationPrivateContextBrokerRecordKind,
      isConversationPrivateContextSourceKind,
      isConversationPrivateContextMessageStageState,
      isConversationPrivateContextDraftStageState,
      isConversationPrivateContextStageKind,
      isConversationPrivateContextDiscardNamespace,
      isConversationPrivateContextBrokerErrorCode,
      isConversationPrivateContextQueueOutcome,
      isConversationPrivateContextQueueDisposition,
      isConversationPrivateContextSourceFrameState,
      isConversationPrivateContextFaultPoint,
      isConversationPrivateContextCreateEngine,
      isConversationPrivateContextCreateHostTool,
      isConversationPrivateContextMessageStageTransition,
      isConversationPrivateContextDraftStageTransition,
      isConversationPrivateContextDigest,
      isConversationPrivateContextQueueItemId,
      isConversationPrivateContextSourceRecordRef,
    ];
    for (const guard of guards) {
      expect(guard("not-in-contract")).toBe(false);
      expect(guard(null)).toBe(false);
    }
    expect(
      () =>
        new ConversationPrivateContextBrokerConflictError(
          "not-in-contract" as never,
          "invalid conflict",
        ),
    ).toThrow("invalid private context broker conflict code");
  });

  test("keeps persisted record shapes frozen, unique, and mapped to every record kind", () => {
    for (const fields of Object.values(CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS)) {
      expect(Object.isFrozen(fields)).toBe(true);
      expect(new Set(fields).size).toBe(fields.length);
    }
    const fieldsByRecordKind = {
      [CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND.MESSAGE_STAGE]:
        CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.MESSAGE_STAGE,
      [CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND.DRAFT_STAGE]:
        CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DRAFT_STAGE,
      [CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND.DISCARD_BINDING]:
        CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DISCARD_BINDING,
    };
    expect(Object.keys(fieldsByRecordKind)).toEqual([
      ...CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KINDS,
    ]);
    expect(CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.MESSAGE_STAGE_REQUEST).toContain(
      CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.MESSAGE,
    );
    expect(CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS.DRAFT_STAGE_REQUEST).toContain(
      CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD.DRAFT,
    );
  });

  test("keeps semantic literals in contract authority modules only", async () => {
    const conversationRoot = join(process.cwd(), "src", "orchestrator", "conversation");
    const files = (await readdir(conversationRoot)).filter(
      (name) =>
        /^conversation-private-context-broker-.*\.ts$/u.test(name) &&
        name !== "conversation-private-context-broker-contract.ts" &&
        name !== "conversation-private-context-broker-fields.ts",
    );
    const semanticValues = new Set([
      CONVERSATION_PRIVATE_CONTEXT_BROKER_SCHEMA_VERSION,
      CONVERSATION_PRIVATE_CONTEXT_SOURCE_BINDING_SCHEMA_VERSION,
      ...CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KINDS,
      ...CONVERSATION_PRIVATE_CONTEXT_SOURCE_KINDS,
      ...CONVERSATION_PRIVATE_CONTEXT_MESSAGE_STAGE_STATES,
      ...CONVERSATION_PRIVATE_CONTEXT_DRAFT_STAGE_STATES,
      ...CONVERSATION_PRIVATE_CONTEXT_STAGE_KINDS,
      ...CONVERSATION_PRIVATE_CONTEXT_BROKER_ERROR_CODES,
      ...CONVERSATION_PRIVATE_CONTEXT_QUEUE_OUTCOMES,
      ...CONVERSATION_PRIVATE_CONTEXT_QUEUE_DISPOSITIONS,
      ...CONVERSATION_PRIVATE_CONTEXT_SOURCE_FRAME_STATES,
      ...CONVERSATION_PRIVATE_CONTEXT_FAULT_POINTS,
      ...CONVERSATION_PRIVATE_CONTEXT_CREATE_HOST_TOOLS,
      ...Object.values(CONVERSATION_PRIVATE_CONTEXT_STORAGE),
      ...Object.values(CONVERSATION_PRIVATE_CONTEXT_IDENTIFIER_PREFIX),
      ...Object.values(CONVERSATION_PRIVATE_CONTEXT_SOURCE_AUTHORITY_KIND),
      ...Object.values(CONVERSATION_PRIVATE_CONTEXT_SOURCE_CONSUMER_KIND),
      ...Object.values(CONVERSATION_PRIVATE_CONTEXT_BROKER_DIGEST_DOMAIN),
    ]);
    const duplicateLocations: string[] = [];
    for (const file of files) {
      const source = await readFile(join(conversationRoot, file), "utf8");
      for (const value of semanticValues) {
        const quoted = `"${value
          .replaceAll("\\", "\\\\")
          .replaceAll("\0", "\\0")
          .replaceAll('"', '\\"')}"`;
        if (source.includes(quoted)) duplicateLocations.push(`${file}:${value}`);
      }
    }
    expect(duplicateLocations).toEqual([]);
  });
});
