import { describe, expect, test } from "bun:test";
import {
  CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KIND,
  CONVERSATION_PRIVATE_CONTEXT_BROKER_RECORD_KINDS,
  CONVERSATION_PRIVATE_CONTEXT_STAGE_IDEMPOTENCY_FIELD,
  CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD,
} from "../../src/orchestrator/conversation/conversation-private-context-broker-contract.js";
import { exactBrokerFieldTypeParity } from "./conversation-private-context-broker-type-parity.js";

describe("conversation private-context broker field contracts", () => {
  test("keeps every broker field tuple in exact DTO and record type parity", () => {
    expect(Object.values(exactBrokerFieldTypeParity).every(Boolean)).toBe(true);
  });

  test("keeps persisted record shapes frozen, unique, and mapped to every record kind", () => {
    const definedFields = new Set(Object.values(CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD));
    expect(definedFields.size).toBe(Object.keys(CONVERSATION_PRIVATE_CONTEXT_WIRE_FIELD).length);
    for (const fields of Object.values(CONVERSATION_PRIVATE_CONTEXT_BROKER_FIELDS)) {
      expect(Object.isFrozen(fields)).toBe(true);
      expect(new Set(fields).size).toBe(fields.length);
      expect(fields.every((field) => definedFields.has(field))).toBe(true);
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
});
