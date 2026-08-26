import { describe, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  AGENT_ACTION_CANDIDATE_ACTOR_KIND,
  AGENT_ACTION_CANDIDATE_BARRIER_POINT,
  AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE,
  AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPES,
  AGENT_ACTION_CANDIDATE_CREDENTIAL_CLASS,
  AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE,
  AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODES,
  AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN,
  AGENT_ACTION_CANDIDATE_DIGEST_PREFIX,
  AGENT_ACTION_CANDIDATE_EVENT_TYPE,
  AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE,
  AGENT_ACTION_CANDIDATE_FAILURE_DISPOSITION,
  AGENT_ACTION_CANDIDATE_FIELD,
  AGENT_ACTION_CANDIDATE_HOST_TOOL,
  AGENT_ACTION_CANDIDATE_IDEMPOTENCY_PREFIX,
  AGENT_ACTION_CANDIDATE_LOCK_OPERATION_PREFIX,
  AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE,
  AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATES,
  AGENT_ACTION_CANDIDATE_NETWORK_READ_POLICY,
  AGENT_ACTION_CANDIDATE_PLANNING_MODE,
  AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPE,
  AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPES,
  AGENT_ACTION_CANDIDATE_RECEIPT_STATE,
  AGENT_ACTION_CANDIDATE_RECEIPT_STATES,
  AGENT_ACTION_CANDIDATE_RECORD_FIELDS,
  AGENT_ACTION_CANDIDATE_RECORD_KIND,
  AGENT_ACTION_CANDIDATE_RECORD_KINDS,
  AGENT_ACTION_CANDIDATE_REJECTION_CODE,
  AGENT_ACTION_CANDIDATE_REJECTION_CODES,
  AGENT_ACTION_CANDIDATE_REQUEST_ORIGIN,
  AGENT_ACTION_CANDIDATE_RESERVATION_STATE,
  AGENT_ACTION_CANDIDATE_REVIEW_PHASE,
  AGENT_ACTION_CANDIDATE_REVIEW_PHASES,
  AGENT_ACTION_CANDIDATE_ROLE,
  AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
  AGENT_ACTION_CANDIDATE_SOURCE_LIFECYCLE,
  AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE,
  AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODES,
  AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT,
  isAgentActionCandidateCapabilityInputActionType,
  isAgentActionCandidateDiagnosticCode,
  isAgentActionCandidateMaterializationState,
  isAgentActionCandidatePrivateOrStagedActionType,
  isAgentActionCandidateReceiptState,
  isAgentActionCandidateRecordKind,
  isAgentActionCandidateRejectionCode,
  isAgentActionCandidateReviewPhase,
  isAgentActionCandidateSchemaVersion,
  isAgentActionCandidateSourceStaleCode,
} from "../../src/orchestrator/conversation/conversation-agent-action-candidate-contract.js";

const vocabularyObjects = [
  AGENT_ACTION_CANDIDATE_RECORD_KIND,
  AGENT_ACTION_CANDIDATE_FIELD,
  AGENT_ACTION_CANDIDATE_RECEIPT_STATE,
  AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE,
  AGENT_ACTION_CANDIDATE_REJECTION_CODE,
  AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE,
  AGENT_ACTION_CANDIDATE_REVIEW_PHASE,
  AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE,
  AGENT_ACTION_CANDIDATE_BARRIER_POINT,
  AGENT_ACTION_CANDIDATE_HOST_TOOL,
  AGENT_ACTION_CANDIDATE_EVENT_TYPE,
  AGENT_ACTION_CANDIDATE_SOURCE_LIFECYCLE,
  AGENT_ACTION_CANDIDATE_ROLE,
  AGENT_ACTION_CANDIDATE_REQUEST_ORIGIN,
  AGENT_ACTION_CANDIDATE_ACTOR_KIND,
  AGENT_ACTION_CANDIDATE_CREDENTIAL_CLASS,
  AGENT_ACTION_CANDIDATE_PLANNING_MODE,
  AGENT_ACTION_CANDIDATE_NETWORK_READ_POLICY,
  AGENT_ACTION_CANDIDATE_EXPECTED_SOURCE_MODE,
  AGENT_ACTION_CANDIDATE_RESERVATION_STATE,
  AGENT_ACTION_CANDIDATE_FAILURE_DISPOSITION,
  AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPE,
  AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE,
  AGENT_ACTION_CANDIDATE_DIGEST_DOMAIN,
  AGENT_ACTION_CANDIDATE_STORAGE_SEGMENT,
  AGENT_ACTION_CANDIDATE_LOCK_OPERATION_PREFIX,
] as const;

const vocabularyLists = [
  [AGENT_ACTION_CANDIDATE_RECORD_KIND, AGENT_ACTION_CANDIDATE_RECORD_KINDS],
  [AGENT_ACTION_CANDIDATE_RECEIPT_STATE, AGENT_ACTION_CANDIDATE_RECEIPT_STATES],
  [AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATE, AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATES],
  [AGENT_ACTION_CANDIDATE_REJECTION_CODE, AGENT_ACTION_CANDIDATE_REJECTION_CODES],
  [AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODE, AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODES],
  [AGENT_ACTION_CANDIDATE_REVIEW_PHASE, AGENT_ACTION_CANDIDATE_REVIEW_PHASES],
  [AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODE, AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODES],
  [
    AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPE,
    AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPES,
  ],
  [
    AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPE,
    AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPES,
  ],
] as const;

describe("durable agent action candidate typed runtime contract", () => {
  test("frozen vocabularies and inferred member lists stay in parity", () => {
    expect(vocabularyObjects.every(Object.isFrozen)).toBe(true);
    expect(Object.isFrozen(AGENT_ACTION_CANDIDATE_RECORD_FIELDS)).toBe(true);
    expect(Object.values(AGENT_ACTION_CANDIDATE_RECORD_FIELDS).every(Object.isFrozen)).toBe(true);

    for (const [vocabulary, members] of vocabularyLists) {
      const values = Object.values(vocabulary);
      expect(members as readonly string[]).toEqual(values as readonly string[]);
      expect(Object.isFrozen(members)).toBe(true);
      expect(new Set(values).size).toBe(values.length);
    }
  });

  test("membership guards accept the contract and reject untrusted near-misses", () => {
    expect(isAgentActionCandidateSchemaVersion(AGENT_ACTION_CANDIDATE_SCHEMA_VERSION)).toBe(true);
    expect(AGENT_ACTION_CANDIDATE_RECORD_KINDS.every(isAgentActionCandidateRecordKind)).toBe(true);
    expect(AGENT_ACTION_CANDIDATE_RECEIPT_STATES.every(isAgentActionCandidateReceiptState)).toBe(
      true,
    );
    expect(
      AGENT_ACTION_CANDIDATE_MATERIALIZATION_STATES.every(
        isAgentActionCandidateMaterializationState,
      ),
    ).toBe(true);
    expect(AGENT_ACTION_CANDIDATE_REJECTION_CODES.every(isAgentActionCandidateRejectionCode)).toBe(
      true,
    );
    expect(
      AGENT_ACTION_CANDIDATE_DIAGNOSTIC_CODES.every(isAgentActionCandidateDiagnosticCode),
    ).toBe(true);
    expect(AGENT_ACTION_CANDIDATE_REVIEW_PHASES.every(isAgentActionCandidateReviewPhase)).toBe(
      true,
    );
    expect(
      AGENT_ACTION_CANDIDATE_SOURCE_STALE_CODES.every(isAgentActionCandidateSourceStaleCode),
    ).toBe(true);
    expect(
      AGENT_ACTION_CANDIDATE_PRIVATE_OR_STAGED_ACTION_TYPES.every(
        isAgentActionCandidatePrivateOrStagedActionType,
      ),
    ).toBe(true);
    expect(
      AGENT_ACTION_CANDIDATE_CAPABILITY_INPUT_ACTION_TYPES.every(
        isAgentActionCandidateCapabilityInputActionType,
      ),
    ).toBe(true);

    expect([
      isAgentActionCandidateSchemaVersion("1.1"),
      isAgentActionCandidateRecordKind("stage"),
      isAgentActionCandidateReceiptState("pending"),
      isAgentActionCandidateMaterializationState("complete"),
      isAgentActionCandidateRejectionCode("internal_error"),
      isAgentActionCandidateDiagnosticCode(null),
      isAgentActionCandidateReviewPhase("approve"),
      isAgentActionCandidateSourceStaleCode(1),
      isAgentActionCandidatePrivateOrStagedActionType("capability.install"),
      isAgentActionCandidateCapabilityInputActionType("capability.adopt"),
    ]).toEqual([false, false, false, false, false, false, false, false, false, false]);
  });

  test("candidate consumers import protocol vocabulary instead of duplicating literals", () => {
    const conversationRoot = resolve("src/orchestrator/conversation");
    const consumers = readdirSync(conversationRoot)
      .filter(
        (name) =>
          name.startsWith("conversation-agent-action-candidate-") &&
          name.endsWith(".ts") &&
          name !== "conversation-agent-action-candidate-contract.ts",
      )
      .map((name) => join(conversationRoot, name));
    const literals = new Set([
      AGENT_ACTION_CANDIDATE_SCHEMA_VERSION,
      AGENT_ACTION_CANDIDATE_IDEMPOTENCY_PREFIX,
      AGENT_ACTION_CANDIDATE_DIGEST_PREFIX,
      ...vocabularyObjects.flatMap((vocabulary) => Object.values(vocabulary)),
      ...Object.values(AGENT_ACTION_CANDIDATE_RECORD_FIELDS).flat(),
    ]);
    const duplicates: string[] = [];
    for (const path of consumers) {
      const source = readFileSync(path, "utf8");
      for (const literal of literals) {
        if (source.includes(JSON.stringify(literal)))
          duplicates.push(`${path.slice(process.cwd().length + 1)} -> ${literal}`);
      }
    }
    expect(duplicates).toEqual([]);
  });
});
