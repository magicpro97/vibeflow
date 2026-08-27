import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  PUBLIC_ERROR_CODE,
  PUBLIC_ERROR_DETAIL_FIELDS,
  PUBLIC_ERROR_FIELD_CONTRACTS_EXACT,
  PUBLIC_ERROR_NULLABLE_DETAIL_FIELDS,
  PUBLIC_RECOVERY_ACTION,
} from "../../src/actions/public-error-contract.js";
import {
  parsePublicApiErrorBody,
  validatePublicErrorDetails,
} from "../../src/actions/public-error-wire-validation.js";
import {
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_PREFIXED_PHASE,
  PUBLIC_OPERATION_PROGRESS_STATUS,
} from "../../src/actions/public-operation-contract.js";
import { isPublicOperationPhaseOwned } from "../../src/actions/public-operation-semantics.js";
import { parsePublicOperationEvent } from "../../src/actions/public-operation-wire-validation.js";

const cursor = `vf-operation-event-${"a".repeat(64)}`;
const occurredAt = "2026-08-26T00:00:00.000Z";

function eventFor(
  phase: string,
  status: string,
  phaseSequence: number,
  state = "committing",
): Record<string, unknown> {
  return {
    schema_version: "1.0",
    operation_id: "operation-1",
    phase_sequence: phaseSequence,
    state,
    progress: {
      sequence: phaseSequence,
      phase,
      status,
      message_code: `operation.${phase}`,
      at: occurredAt,
    },
    target: null,
    error: null,
    occurred_at: occurredAt,
    event_cursor: cursor,
  };
}

describe("browser-safe public action boundary", () => {
  test("accepts only exact public error vocabulary and per-code semantics", () => {
    expect(PUBLIC_ERROR_FIELD_CONTRACTS_EXACT).toBeTrue();
    expect(Object.isFrozen(PUBLIC_ERROR_DETAIL_FIELDS)).toBeTrue();
    expect(Object.isFrozen(PUBLIC_ERROR_NULLABLE_DETAIL_FIELDS)).toBeTrue();
    for (const detailFields of Object.values(PUBLIC_ERROR_DETAIL_FIELDS))
      expect(Object.isFrozen(detailFields)).toBeTrue();
    const canonical = {
      code: PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
      message: "The operation stream is unavailable.",
      correlation_id: "correlation-1",
      retryable: true,
      recovery_action: PUBLIC_RECOVERY_ACTION.RETRY,
      details: null,
    } as const;
    expect(parsePublicApiErrorBody(canonical, "correlation-1")).toEqual(canonical);
    expect(() => parsePublicApiErrorBody({ ...canonical, code: "invented" })).toThrow(/code/i);
    expect(() => parsePublicApiErrorBody({ ...canonical, recovery_action: "invented" })).toThrow();
    expect(() => parsePublicApiErrorBody({ ...canonical, extra: true })).toThrow(/field/i);
    const legacyDetails = {
      reason: "legacy-v1",
      retry_after_ms: 25,
      cached: false,
      optional: null,
    };
    const legacy = parsePublicApiErrorBody({ ...canonical, details: legacyDetails });
    expect(legacy.details).toEqual(legacyDetails);
    expect(Object.getPrototypeOf(legacy.details)).toBeNull();
    legacyDetails.reason = "mutated-after-decode";
    expect(legacy.details).toMatchObject({ reason: "legacy-v1" });
    expect(() =>
      parsePublicApiErrorBody({ ...canonical, details: { nested: { private: true } } }),
    ).toThrow(/scalar|4 KiB/i);
    expect(() =>
      parsePublicApiErrorBody({ ...canonical, details: { diagnostic: "x".repeat(4_096) } }),
    ).toThrow(/4 KiB|byte limit/i);
    expect(() => parsePublicApiErrorBody({ ...canonical, recovery_action: null })).toThrow(
      /semantics/i,
    );
    expect(() => parsePublicApiErrorBody({ ...canonical, message: "e\u0301" })).toThrow(/bounded/i);
    expect(() => parsePublicApiErrorBody({ ...canonical, message: "bad\nmessage" })).toThrow(
      /bounded/i,
    );
    expect(() => parsePublicApiErrorBody({ ...canonical, message: "x".repeat(513) })).toThrow(
      /bounded/i,
    );
    expect(() => parsePublicApiErrorBody(canonical, "other-correlation")).toThrow(/bounded/i);
    expect(() =>
      parsePublicApiErrorBody({
        code: PUBLIC_ERROR_CODE.TARGET_UNSUPPORTED,
        message: "Target unsupported.",
        correlation_id: "correlation-1",
        retryable: false,
        recovery_action: PUBLIC_RECOVERY_ACTION.RETARGET,
        details: { action_type: "invented.action" },
      }),
    ).toThrow(/action type/i);
    const scopeRecovery = {
      code: PUBLIC_ERROR_CODE.SCOPE_NEEDS_RECOVERY,
      message: "The capability scope requires recovery before it can be changed.",
      correlation_id: "correlation-1",
      retryable: false,
      recovery_action: PUBLIC_RECOVERY_ACTION.REPAIR,
      details: { operation_id: null },
    } as const;
    expect(parsePublicApiErrorBody(scopeRecovery, "correlation-1")).toEqual(scopeRecovery);
    expect(
      parsePublicApiErrorBody({
        ...scopeRecovery,
        details: { operation_id: "vf-operation-bound-to-recovery" },
      }),
    ).toMatchObject({ details: { operation_id: "vf-operation-bound-to-recovery" } });
    expect(() => parsePublicApiErrorBody({ ...scopeRecovery, details: {} })).toThrow(/field/i);
    expect(() =>
      validatePublicErrorDetails(PUBLIC_ERROR_CODE.STALE_OPERATION_CURSOR, {
        restart_cursor: "cursor-restart",
        proposal_id: "vf-proposal-stale",
        operation_id: null,
      }),
    ).not.toThrow();
    expect(() =>
      validatePublicErrorDetails(PUBLIC_ERROR_CODE.PRE_EFFECT_REFUSED, {
        operation_id: null,
        reason_code: "scope-base-stale",
        frontier_kind: "operation",
      }),
    ).toThrow(/nullable/i);
    expect(() =>
      validatePublicErrorDetails(PUBLIC_ERROR_CODE.STALE_OPERATION_CURSOR, {
        restart_cursor: null,
        proposal_id: "vf-proposal-stale",
        operation_id: null,
      }),
    ).toThrow(/nullable/i);
  });

  test("shares exact phase ownership and initial-sequence rules", () => {
    expect(
      isPublicOperationPhaseOwned({
        actionType: "conversation.add_participant",
        phase: PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.PREPARED,
        phaseSequence: 1,
      }),
    ).toBeFalse();
    expect(
      isPublicOperationPhaseOwned({
        actionType: "conversation.add_participant",
        phase: PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.PREPARED,
        phaseSequence: 1,
      }),
    ).toBeTrue();
    expect(
      isPublicOperationPhaseOwned({
        actionType: "conversation.add_participant",
        phase: PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.PREPARED,
        phaseSequence: 0,
      }),
    ).toBeFalse();
    expect(
      isPublicOperationPhaseOwned({
        actionType: "conversation.add_participant",
        phase: PUBLIC_OPERATION_FIXED_PHASE.DISPATCH,
        phaseSequence: 0,
      }),
    ).toBeTrue();
    expect(
      isPublicOperationPhaseOwned({
        actionType: "capability.install",
        phase: PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
        phaseSequence: 0,
      }),
    ).toBeTrue();
    expect(
      isPublicOperationPhaseOwned({
        actionType: "capability.install",
        phase: PUBLIC_OPERATION_FIXED_PHASE.TARGET_APPLIED,
        phaseSequence: 0,
      }),
    ).toBeFalse();
  });

  test("rejects wrong-owner and arbitrary phase-zero SSE events", () => {
    const expected = {
      operationId: "operation-1",
      correlationId: "correlation-1",
      actionType: "conversation.add_participant",
      targets: [],
    };
    expect(() =>
      parsePublicOperationEvent(
        eventFor(
          PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.PREPARED,
          PUBLIC_OPERATION_PROGRESS_STATUS.PENDING,
          1,
        ),
        expected,
      ),
    ).toThrow(/semantics/i);
    expect(() =>
      parsePublicOperationEvent(
        eventFor(
          PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.PREPARED,
          PUBLIC_OPERATION_PROGRESS_STATUS.SUCCEEDED,
          0,
        ),
        expected,
      ),
    ).toThrow(/semantics/i);
    expect(
      parsePublicOperationEvent(
        eventFor(
          PUBLIC_OPERATION_FIXED_PHASE.DISPATCH,
          PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
          0,
        ),
        expected,
      ).progress?.phase,
    ).toBe(PUBLIC_OPERATION_FIXED_PHASE.DISPATCH);

    const capability = {
      operationId: "operation-1",
      correlationId: "correlation-1",
      actionType: "capability.install",
      targets: [],
    };
    expect(() =>
      parsePublicOperationEvent(
        eventFor(
          PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
          PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
          0,
          "succeeded",
        ),
        capability,
      ),
    ).toThrow(/semantics/i);
    expect(() =>
      parsePublicOperationEvent(
        eventFor(
          PUBLIC_OPERATION_FIXED_PHASE.OPERATION_STARTED,
          PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
          4,
        ),
        capability,
      ),
    ).toThrow(/semantics/i);
  });

  test("decodes the legacy v1 target event without a progress target_id extension", () => {
    const binding = {
      target_id: "target-legacy-v1",
      target: {
        scope: "project" as const,
        engine: "codex" as const,
        participant_id: null,
        required: true as const,
        on_apply_failure: "abort-scope" as const,
        on_health_failure: "abort-scope" as const,
      },
      subject: {
        kind: "capability" as const,
        package_id: "package.legacy-v1",
        component_id: "component-legacy-v1",
      },
    };
    const event = eventFor(
      PUBLIC_OPERATION_FIXED_PHASE.TARGET_APPLIED,
      PUBLIC_OPERATION_PROGRESS_STATUS.SUCCEEDED,
      1,
      "succeeded",
    );
    event.target = {
      ...binding,
      outcome: "applied",
      health: "unknown",
      evidence_digest: null,
    };
    const decoded = parsePublicOperationEvent(event, {
      operationId: "operation-1",
      correlationId: "correlation-1",
      actionType: "capability.install",
      targets: [binding],
    });
    expect(decoded.progress).not.toHaveProperty("target_id");
    expect(decoded.target?.target_id).toBe(binding.target_id);
  });

  test("rejects terminal states on nonterminal phases for every operation family", () => {
    const cases = [
      {
        expected: {
          operationId: "operation-1",
          correlationId: "correlation-1",
          actionType: "grant.create",
          targets: [],
        },
        event: eventFor(
          PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.PREPARED,
          PUBLIC_OPERATION_PROGRESS_STATUS.PENDING,
          1,
          "succeeded",
        ),
      },
      {
        expected: {
          operationId: "operation-1",
          correlationId: "correlation-1",
          actionType: "authority.repair",
          targets: [],
        },
        event: eventFor(
          PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.RESTORED,
          PUBLIC_OPERATION_PROGRESS_STATUS.SUCCEEDED,
          1,
          "failed",
        ),
      },
      {
        expected: {
          operationId: "operation-1",
          correlationId: "correlation-1",
          actionType: "conversation.add_participant",
          targets: [],
        },
        event: eventFor(
          PUBLIC_OPERATION_PREFIXED_PHASE.REVISION.PREPARING,
          PUBLIC_OPERATION_PROGRESS_STATUS.RUNNING,
          1,
          "failed",
        ),
      },
    ] as const;
    for (const fixture of cases)
      expect(() => parsePublicOperationEvent(fixture.event, fixture.expected)).toThrow(
        /semantics/i,
      );
  });

  test("keeps browser validators free of backend durability imports", () => {
    const root = join(import.meta.dir, "../..");
    const sources = [
      "src/actions/public-operation-wire-validation.ts",
      "src/actions/public-error-wire-validation.ts",
      "src/actions/public-operation-dto.ts",
      "src/ui/src/conversation-home-operation-stream.ts",
      "src/ui/src/conversation-home-types.ts",
    ].map((path) => readFileSync(join(root, path), "utf8"));
    for (const source of sources) {
      expect(source).not.toContain("bun:ffi");
      expect(source).not.toContain("/durability/");
      expect(source).not.toContain('from "./types.js"');
      expect(source).not.toContain('from "./public-types.js"');
      expect(source).not.toContain('from "./operation-phase-rules.js"');
    }
  });
});
