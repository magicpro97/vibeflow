import { describe, expect, test } from "bun:test";
import { HOST_ACTION_KIND } from "../../src/actions/host-action-contract.js";
import { validateOperationBatches } from "../../src/actions/operation-batch-validation.js";
import { assertPhaseOwner } from "../../src/actions/operation-phase-rules.js";
import {
  ACTION_AUTHORITY_EVENT_KIND,
  ACTION_OPERATION_STATE,
  ACTION_ROOT_LOCATOR_KIND,
  isActionAuthorityEventKind,
} from "../../src/actions/protocol-contract.js";
import {
  PUBLIC_ERROR_CODE,
  PUBLIC_RECOVERY_ACTION,
  type PublicApiErrorBodyV1,
} from "../../src/actions/public-error-contract.js";
import { isPublicApiErrorBody } from "../../src/actions/public-error-wire-validation.js";
import {
  PUBLIC_ACTION_TARGET_APPLY_FAILURE,
  PUBLIC_ACTION_TARGET_HEALTH_FAILURE,
  PUBLIC_ACTION_TARGET_SCOPE,
  PUBLIC_ACTION_TARGET_SUBJECT_KIND,
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_PREFIXED_PHASE,
  PUBLIC_OPERATION_PROGRESS_STATUS,
  PUBLIC_TARGET_RESULT_HEALTH,
  PUBLIC_TARGET_RESULT_OUTCOME,
  type PublicOperationPhaseV1,
  isPublicActionTargetSubjectKind,
} from "../../src/actions/public-operation-contract.js";
import type {
  ActionOperationEventV1,
  PublicOperationProgressV1,
} from "../../src/actions/public-operation-dto.js";
import {
  isPublicOperationEventSemantics,
  isPublicOperationProgress,
  isPublicTargetResult,
} from "../../src/actions/public-operation-wire-validation.js";
import { isBoundedJsonWireValue } from "../../src/actions/public-wire-primitives.js";
import type { ActionAuthoritySnapshotV1 } from "../../src/actions/types.js";

const OCCURRED_AT = "2026-08-27T00:00:00.000Z";
const OPERATION_ID = `vf-operation-${"a".repeat(64)}`;

function snapshot(
  actionType: (typeof HOST_ACTION_KIND)[keyof typeof HOST_ACTION_KIND],
  state: ActionAuthoritySnapshotV1["state"] = ACTION_OPERATION_STATE.COMMITTING,
): ActionAuthoritySnapshotV1 {
  return {
    state,
    proposal: {
      action: { type: actionType },
      action_root_locator: {
        kind: ACTION_ROOT_LOCATOR_KIND.CONVERSATION,
        root_session_id: "root-session",
      },
      target_set: [],
    },
  } as unknown as ActionAuthoritySnapshotV1;
}

function operationEvent(input: {
  sequence: number;
  phase: string;
  state: ActionOperationEventV1["state"];
  status: PublicOperationProgressV1["status"];
}): ActionOperationEventV1 {
  return {
    schema_version: "1.0",
    operation_id: OPERATION_ID,
    phase_sequence: input.sequence,
    state: input.state,
    progress: {
      sequence: input.sequence,
      phase: input.phase as PublicOperationPhaseV1,
      status: input.status,
      message_code: `operation.${input.phase}` as PublicOperationProgressV1["message_code"],
      at: OCCURRED_AT,
    },
    target: null,
    error: null,
    occurred_at: OCCURRED_AT,
    event_cursor: `vf-operation-event-${String(input.sequence).repeat(64)}`,
  };
}

function progress(
  phase: PublicOperationPhaseV1,
  status: PublicOperationProgressV1["status"],
): PublicOperationProgressV1 {
  return {
    sequence: 1,
    phase,
    status,
    message_code: `operation.${phase}`,
    at: OCCURRED_AT,
  };
}

const PRE_EFFECT_ERROR = {
  code: PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED,
  message: "The approved capability action was refused because a pre-effect check changed.",
  correlation_id: "correlation-final-coverage",
  retryable: false,
  recovery_action: PUBLIC_RECOVERY_ACTION.REFRESH_PROPOSAL,
  details: {
    operation_id: OPERATION_ID,
    reason_code: "scope-base-stale",
    frontier_kind: "pre-effect",
  },
} as unknown as PublicApiErrorBodyV1;

const RECOVERY_ERROR = {
  code: PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
  message: "The capability scope requires recovery before it can be changed.",
  correlation_id: "correlation-final-coverage",
  retryable: false,
  recovery_action: PUBLIC_RECOVERY_ACTION.REPAIR,
  details: { operation_id: OPERATION_ID },
} as PublicApiErrorBodyV1;

describe("final action contract branch coverage", () => {
  test("operation batches reject malformed phase-zero and exact-terminal states", () => {
    const receipt = snapshot(HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION);
    const unknownPhase = "future-operation-phase";
    expect(() =>
      validateOperationBatches(receipt, [
        operationEvent({
          sequence: 0,
          phase: unknownPhase,
          state: ACTION_OPERATION_STATE.FAILED,
          status: PUBLIC_OPERATION_PROGRESS_STATUS.FAILED,
        }),
      ]),
    ).toThrow("operation phase zero is not committing");
    expect(() =>
      validateOperationBatches(receipt, [
        operationEvent({
          sequence: 0,
          phase: unknownPhase,
          state: ACTION_OPERATION_STATE.COMMITTING,
          status: PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
        }),
      ]),
    ).not.toThrow();

    const dispatch = operationEvent({
      sequence: 0,
      phase: PUBLIC_OPERATION_FIXED_PHASE.DISPATCH,
      state: ACTION_OPERATION_STATE.COMMITTING,
      status: PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
    });
    const wrongTerminal = operationEvent({
      sequence: 1,
      phase: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED,
      state: ACTION_OPERATION_STATE.FAILED,
      status: PUBLIC_OPERATION_PROGRESS_STATUS.FAILED,
    });
    expect(() => validateOperationBatches(receipt, [dispatch, wrongTerminal])).toThrow(
      "terminal phase has an invalid operation state",
    );

    const succeeded = snapshot(
      HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION,
      ACTION_OPERATION_STATE.SUCCEEDED,
    );
    expect(() =>
      validateOperationBatches(succeeded, [
        dispatch,
        {
          ...wrongTerminal,
          state: ACTION_OPERATION_STATE.SUCCEEDED,
          progress: {
            ...wrongTerminal.progress,
            status: PUBLIC_OPERATION_PROGRESS_STATUS.SUCCEEDED,
          } as PublicOperationProgressV1,
        },
      ]),
    ).not.toThrow();
  });

  test("phase ownership and authority event vocabularies fail closed", () => {
    expect(() =>
      assertPhaseOwner(
        snapshot(HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION),
        PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.PREPARED,
        1,
      ),
    ).toThrow("operation phase does not match its action owner");
    expect(isActionAuthorityEventKind(ACTION_AUTHORITY_EVENT_KIND.STATE_TRANSITION)).toBeTrue();
    expect(isActionAuthorityEventKind("future-authority-event")).toBeFalse();
    expect(isActionAuthorityEventKind(null)).toBeFalse();
  });

  test("public error predicate preserves parser semantics without throwing", () => {
    const serviceUnavailable = {
      code: PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
      message: "The operation stream is unavailable.",
      correlation_id: "correlation-final-coverage",
      retryable: true,
      recovery_action: PUBLIC_RECOVERY_ACTION.RETRY,
      details: null,
    } as const;
    expect(isPublicApiErrorBody(serviceUnavailable, serviceUnavailable.correlation_id)).toBeTrue();
    expect(
      isPublicApiErrorBody(
        { ...serviceUnavailable, retryable: false },
        serviceUnavailable.correlation_id,
      ),
    ).toBeFalse();
  });

  test("optional targets and conversation subjects validate their exact policies", () => {
    const result = {
      target_id: "target-final-coverage",
      target: {
        scope: PUBLIC_ACTION_TARGET_SCOPE.PROJECT,
        engine: null,
        participant_id: null,
        required: false,
        on_apply_failure: PUBLIC_ACTION_TARGET_APPLY_FAILURE.OMIT_AFTER_ROLLBACK,
        on_health_failure: PUBLIC_ACTION_TARGET_HEALTH_FAILURE.COMMIT_DEGRADED,
      },
      subject: {
        kind: PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION,
        action_type: HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION,
        participant_id: null,
      },
      outcome: PUBLIC_TARGET_RESULT_OUTCOME.APPLIED,
      health: PUBLIC_TARGET_RESULT_HEALTH.READY,
      evidence_digest: null,
    } as const;
    expect(isPublicTargetResult(result)).toBeTrue();
    expect(
      isPublicTargetResult({
        ...result,
        target: {
          ...result.target,
          on_health_failure: PUBLIC_ACTION_TARGET_HEALTH_FAILURE.ABORT_SCOPE,
        },
      }),
    ).toBeFalse();
    expect(
      isPublicActionTargetSubjectKind(PUBLIC_ACTION_TARGET_SUBJECT_KIND.CONVERSATION),
    ).toBeTrue();
    expect(isPublicActionTargetSubjectKind("future-subject-kind")).toBeFalse();
  });

  test("progress and terminal error semantics reject unmapped combinations", () => {
    expect(
      isPublicOperationProgress(
        progress(
          PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.STARTED,
          PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
        ),
        {
          sequence: 1,
          state: ACTION_OPERATION_STATE.COMMITTING,
          occurredAt: OCCURRED_AT,
        },
      ),
    ).toBeFalse();

    expect(
      isPublicOperationEventSemantics({
        progress: progress(
          PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED,
          PUBLIC_OPERATION_PROGRESS_STATUS.SUCCEEDED,
        ),
        target: null,
        error: PRE_EFFECT_ERROR,
        state: ACTION_OPERATION_STATE.SUCCEEDED,
        phaseSequence: 1,
        actionType: HOST_ACTION_KIND.CAPABILITY_INSTALL,
      }),
    ).toBeFalse();
    expect(
      isPublicOperationEventSemantics({
        progress: progress(
          PUBLIC_OPERATION_PREFIXED_PHASE.CONVERSATION_RECEIPT.FAILED,
          PUBLIC_OPERATION_PROGRESS_STATUS.FAILED,
        ),
        target: null,
        error: PRE_EFFECT_ERROR,
        state: ACTION_OPERATION_STATE.FAILED,
        phaseSequence: 1,
        actionType: HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION,
      }),
    ).toBeFalse();
    expect(
      isPublicOperationEventSemantics({
        progress: progress(
          PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED,
          PUBLIC_OPERATION_PROGRESS_STATUS.FAILED,
        ),
        target: null,
        error: PRE_EFFECT_ERROR,
        state: ACTION_OPERATION_STATE.FAILED,
        phaseSequence: 1,
        actionType: HOST_ACTION_KIND.CAPABILITY_INSTALL,
      }),
    ).toBeTrue();
    expect(
      isPublicOperationEventSemantics({
        progress: progress(
          PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY,
          PUBLIC_OPERATION_PROGRESS_STATUS.FAILED,
        ),
        target: null,
        error: RECOVERY_ERROR,
        state: ACTION_OPERATION_STATE.NEEDS_RECOVERY,
        phaseSequence: 1,
        actionType: HOST_ACTION_KIND.CAPABILITY_INSTALL,
      }),
    ).toBeTrue();
  });

  test("bounded JSON returns false when serialization itself rejects", () => {
    const serializationFailure = new Proxy(
      {},
      {
        get(target, property, receiver) {
          if (property === "toJSON") throw new Error("injected serialization failure");
          return Reflect.get(target, property, receiver);
        },
      },
    );
    expect(isBoundedJsonWireValue({ stable: true }, 128)).toBeTrue();
    expect(isBoundedJsonWireValue(serializationFailure, 128)).toBeFalse();
  });
});
