import { describe, expect, test } from "bun:test";
import type {
  ACTION_OPERATION_DOMAIN_TERMINAL_STATES,
  ActionOperationDomainTerminalState,
} from "../../src/actions/protocol-contract.js";
import type { PublicApiErrorBodyV1 } from "../../src/actions/public-error-contract.js";
import {
  PUBLIC_API_ERROR_FIELDS,
  PUBLIC_ERROR_CODES,
  PUBLIC_RECOVERY_ACTIONS,
  isPublicErrorCode,
  isPublicRecoveryAction,
} from "../../src/actions/public-error-contract.js";
import {
  PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS,
  PUBLIC_ACTION_TARGET_FIELDS,
  type PUBLIC_ACTION_TARGET_SCOPE,
  type PUBLIC_OPERATION_PARTICIPANT_START_PHASE,
  PUBLIC_OPERATION_PREFIXED_PHASE,
  PUBLIC_OPERATION_PREFIXED_REVISION_PHASE_BY_VALUE,
  PUBLIC_OPERATION_PROGRESS_FIELDS,
  type PUBLIC_OPERATION_PROGRESS_STATUSES,
  type PUBLIC_OPERATION_REVISION_PHASE,
  PUBLIC_OPERATION_TARGET_OUTCOMES_BY_PHASE,
  PUBLIC_TARGET_RESULT_FIELDS,
  type PUBLIC_TARGET_RESULT_HEALTHS,
  type PUBLIC_TARGET_RESULT_OUTCOMES,
  isPublicOperationPhase,
  isPublicOperationProgressStatus,
  isPublicTargetResultHealth,
  isPublicTargetResultOutcome,
} from "../../src/actions/public-operation-contract.js";
import type {
  PublicActionTargetSubjectV1,
  PublicActionTargetV1,
  PublicOperationProgressV1,
  PublicTargetResultV1,
} from "../../src/actions/public-operation-dto.js";
import type { ConversationActionReceiptV1 } from "../../src/orchestrator/conversation/conversation-action-receipt-store.js";
import type { ParticipantStartStateV1 } from "../../src/orchestrator/conversation/revision-participant-receipt.js";
import type { RevisionOperationStateV1 } from "../../src/orchestrator/conversation/revision-planner.js";

type SameKeys<Shape, Fields extends readonly PropertyKey[]> = Exclude<
  keyof Shape,
  Fields[number]
> extends never
  ? Exclude<Fields[number], keyof Shape> extends never
    ? true
    : false
  : false;

type SameUnion<Left, Right> = Exclude<Left, Right> extends never
  ? Exclude<Right, Left> extends never
    ? true
    : false
  : false;

type ValueOf<Contract> = Contract[keyof Contract];
type ConversationTarget = Extract<PublicActionTargetSubjectV1, { kind: "conversation" }>;
type CapabilityTarget = Extract<PublicActionTargetSubjectV1, { kind: "capability" }>;

const keyParity = {
  progress: true satisfies SameKeys<
    PublicOperationProgressV1,
    typeof PUBLIC_OPERATION_PROGRESS_FIELDS
  >,
  targetResult: true satisfies SameKeys<PublicTargetResultV1, typeof PUBLIC_TARGET_RESULT_FIELDS>,
  target: true satisfies SameKeys<PublicActionTargetV1, typeof PUBLIC_ACTION_TARGET_FIELDS>,
  conversationSubject: true satisfies SameKeys<
    ConversationTarget,
    typeof PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS
  >,
  capabilitySubject: true satisfies SameKeys<
    CapabilityTarget,
    typeof PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS
  >,
  error: true satisfies SameKeys<PublicApiErrorBodyV1, typeof PUBLIC_API_ERROR_FIELDS>,
} as const;

const unionParity = {
  progressStatus: true satisfies SameUnion<
    PublicOperationProgressV1["status"],
    (typeof PUBLIC_OPERATION_PROGRESS_STATUSES)[number]
  >,
  targetOutcome: true satisfies SameUnion<
    PublicTargetResultV1["outcome"],
    (typeof PUBLIC_TARGET_RESULT_OUTCOMES)[number]
  >,
  targetHealth: true satisfies SameUnion<
    PublicTargetResultV1["health"],
    (typeof PUBLIC_TARGET_RESULT_HEALTHS)[number]
  >,
  targetScope: true satisfies SameUnion<
    PublicActionTargetV1["scope"],
    ValueOf<typeof PUBLIC_ACTION_TARGET_SCOPE>
  >,
  revisionState: true satisfies SameUnion<
    RevisionOperationStateV1,
    ValueOf<typeof PUBLIC_OPERATION_REVISION_PHASE>
  >,
  participantState: true satisfies SameUnion<
    ParticipantStartStateV1,
    ValueOf<typeof PUBLIC_OPERATION_PARTICIPANT_START_PHASE>
  >,
  receiptOutcome: true satisfies SameUnion<
    ConversationActionReceiptV1["outcome"],
    ActionOperationDomainTerminalState
  >,
  terminalOutcomeValues: true satisfies SameUnion<
    ConversationActionReceiptV1["outcome"],
    (typeof ACTION_OPERATION_DOMAIN_TERMINAL_STATES)[number]
  >,
} as const;

describe("public operation contract parity", () => {
  test("keeps every public DTO field tuple and inferred union exact", () => {
    expect(Object.values(keyParity).every(Boolean)).toBeTrue();
    expect(Object.values(unionParity).every(Boolean)).toBeTrue();
    for (const fields of [
      PUBLIC_OPERATION_PROGRESS_FIELDS,
      PUBLIC_TARGET_RESULT_FIELDS,
      PUBLIC_ACTION_TARGET_FIELDS,
      PUBLIC_ACTION_TARGET_CONVERSATION_SUBJECT_FIELDS,
      PUBLIC_ACTION_TARGET_CAPABILITY_SUBJECT_FIELDS,
      PUBLIC_API_ERROR_FIELDS,
    ]) {
      expect(Object.isFrozen(fields)).toBeTrue();
      expect(new Set(fields).size).toBe(fields.length);
    }
  });

  test("keeps phase outcome maps frozen and closed against prototype-shaped names", () => {
    expect(Object.isFrozen(PUBLIC_OPERATION_TARGET_OUTCOMES_BY_PHASE)).toBeTrue();
    expect(
      Object.values(PUBLIC_OPERATION_TARGET_OUTCOMES_BY_PHASE).every(Object.isFrozen),
    ).toBeTrue();
    expect(Object.isFrozen(PUBLIC_OPERATION_PREFIXED_REVISION_PHASE_BY_VALUE)).toBeTrue();
    expect(PUBLIC_OPERATION_PREFIXED_REVISION_PHASE_BY_VALUE.prepared).toBe(
      PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.PREPARED,
    );
    expect(PUBLIC_OPERATION_PREFIXED_REVISION_PHASE_BY_VALUE.start_failed).toBe(
      PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.START_FAILED,
    );
    for (const value of ["toString:x", "__proto__:x", "constructor:x", "future"]) {
      expect(isPublicOperationPhase(value)).toBeFalse();
      expect(isPublicOperationProgressStatus(value)).toBeFalse();
      expect(isPublicTargetResultOutcome(value)).toBeFalse();
      expect(isPublicTargetResultHealth(value)).toBeFalse();
      expect(isPublicErrorCode(value)).toBeFalse();
      expect(isPublicRecoveryAction(value)).toBeFalse();
    }
    expect(PUBLIC_ERROR_CODES.every(isPublicErrorCode)).toBeTrue();
    expect(PUBLIC_RECOVERY_ACTIONS.every(isPublicRecoveryAction)).toBeTrue();
  });
});
