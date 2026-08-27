import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  ACTION_OPERATION_DISPATCH_REPLAY_STATES,
  ACTION_OPERATION_STATE,
} from "../../src/actions/protocol-contract.js";
import { PUBLIC_RECOVERY_ACTION } from "../../src/actions/public-error-contract.js";
import {
  PUBLIC_ACTION_TARGET_HEALTH_FAILURE,
  PUBLIC_ACTION_TARGET_SUBJECT_KIND,
  PUBLIC_TARGET_RESULT_HEALTH,
  PUBLIC_TARGET_RESULT_OUTCOME,
  PUBLIC_TARGET_RESULT_OUTCOMES,
} from "../../src/actions/public-operation-contract.js";
import type { CapabilityOperationResultV1 } from "../../src/capabilities/operations/types.js";
import { CAPABILITY_LOCK_TARGET_STATE } from "../../src/capabilities/wire/lock.js";
import {
  CAPABILITY_ADAPTER_RECEIPT_EFFECT_UNRESOLVED_STATES,
  CAPABILITY_ADAPTER_RECEIPT_PUBLICATION_TERMINAL_STATES,
  CAPABILITY_ADAPTER_RECEIPT_STATE,
  CAPABILITY_ADAPTER_RECEIPT_STATES,
  CAPABILITY_HEALTH_OUTCOME,
  CAPABILITY_HEALTH_OUTCOMES,
  CAPABILITY_OPERATION_CHANGED_TARGET_OUTCOMES,
  CAPABILITY_OPERATION_DEFAULT_RECOVERY_ACTIONS_BY_STATUS,
  CAPABILITY_OPERATION_RECOVERY_ACTION,
  CAPABILITY_OPERATION_RECOVERY_ACTIONS,
  CAPABILITY_OPERATION_RECOVERY_PHASE,
  CAPABILITY_OPERATION_STATUS,
  CAPABILITY_OPERATION_STATUSES,
  CAPABILITY_OPERATION_STATUS_BY_ACTION_STATE,
  CAPABILITY_OUTBOX_DELIVERIES,
  CAPABILITY_OUTBOX_PHASES,
  CAPABILITY_OUTBOX_TRANSITIONS,
  CAPABILITY_PRE_EFFECT_FRONTIER,
  CAPABILITY_PRE_EFFECT_FRONTIERS,
  CAPABILITY_PRE_EFFECT_OBSERVED_STATE,
  CAPABILITY_PRE_EFFECT_OBSERVED_STATES,
  CAPABILITY_PRE_EFFECT_REFUSAL_REASON,
  CAPABILITY_PRE_EFFECT_REFUSAL_REASONS,
  CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES,
  CAPABILITY_WAL_PAYLOAD_KIND,
  CAPABILITY_WAL_PAYLOAD_KINDS,
  type CapabilityOperationRecoveryActionV1,
  type CapabilityOperationStatusV1,
  isCapabilityOperationRecoveryAction,
  isCapabilityOperationStatus,
} from "../../src/capabilities/wire/operation.js";

type Same<Left, Right> = [Left] extends [Right] ? ([Right] extends [Left] ? true : false) : false;
type ValueOf<Contract> = Contract[keyof Contract];
const exactOperationResultParity = Object.freeze({
  STATUS: true satisfies Same<
    CapabilityOperationResultV1["status"],
    ValueOf<typeof CAPABILITY_OPERATION_STATUS>
  >,
  RECOVERY_ACTION: true satisfies Same<
    CapabilityOperationResultV1["recovery_actions"][number],
    ValueOf<typeof CAPABILITY_OPERATION_RECOVERY_ACTION>
  >,
  STATUS_TYPE: true satisfies Same<
    CapabilityOperationStatusV1,
    ValueOf<typeof CAPABILITY_OPERATION_STATUS>
  >,
  RECOVERY_ACTION_TYPE: true satisfies Same<
    CapabilityOperationRecoveryActionV1,
    ValueOf<typeof CAPABILITY_OPERATION_RECOVERY_ACTION>
  >,
});
describe("capability operation protocol consumers", () => {
  test("aliases action, public-result, and public-recovery authorities", () => {
    expect(CAPABILITY_OPERATION_STATUS).toEqual({
      COMMITTING: ACTION_OPERATION_STATE.COMMITTING,
      SUCCEEDED: ACTION_OPERATION_STATE.SUCCEEDED,
      DEGRADED: PUBLIC_TARGET_RESULT_OUTCOME.DEGRADED,
      FAILED: ACTION_OPERATION_STATE.FAILED,
      NEEDS_RECOVERY: PUBLIC_TARGET_RESULT_OUTCOME.NEEDS_RECOVERY,
    });
    expect(CAPABILITY_OPERATION_RECOVERY_ACTION).toEqual({
      RETRY: PUBLIC_RECOVERY_ACTION.RETRY,
      ROLLBACK: PUBLIC_RECOVERY_ACTION.ROLLBACK,
      REPAIR: PUBLIC_RECOVERY_ACTION.REPAIR,
      REPAIR_AUTHORITY: PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
      EXPORT_REDACTED_DIAGNOSTICS: PUBLIC_RECOVERY_ACTION.EXPORT_REDACTED_DIAGNOSTICS,
    });
    expect(CAPABILITY_OPERATION_STATUS_BY_ACTION_STATE).toEqual({
      [ACTION_OPERATION_STATE.COMMITTING]: CAPABILITY_OPERATION_STATUS.COMMITTING,
      [ACTION_OPERATION_STATE.SUCCEEDED]: CAPABILITY_OPERATION_STATUS.SUCCEEDED,
      [ACTION_OPERATION_STATE.FAILED]: CAPABILITY_OPERATION_STATUS.FAILED,
      [ACTION_OPERATION_STATE.NEEDS_RECOVERY]: CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY,
    });
    expect(CAPABILITY_HEALTH_OUTCOME).toBe(PUBLIC_TARGET_RESULT_HEALTH);
    expect(Object.values(exactOperationResultParity).every(Boolean)).toBe(true);
  });
  test("freezes complete vocabularies and operation-specific semantic subsets", () => {
    expect(CAPABILITY_OPERATION_STATUSES).toEqual(Object.values(CAPABILITY_OPERATION_STATUS));
    expect(CAPABILITY_OPERATION_RECOVERY_ACTIONS).toEqual(
      Object.values(CAPABILITY_OPERATION_RECOVERY_ACTION),
    );
    expect(CAPABILITY_ADAPTER_RECEIPT_PUBLICATION_TERMINAL_STATES).toEqual([
      CAPABILITY_ADAPTER_RECEIPT_STATE.APPLIED,
      CAPABILITY_ADAPTER_RECEIPT_STATE.FAILED,
      CAPABILITY_ADAPTER_RECEIPT_STATE.REVERSED,
    ]);
    expect(CAPABILITY_ADAPTER_RECEIPT_STATES).toEqual(
      Object.values(CAPABILITY_ADAPTER_RECEIPT_STATE),
    );
    expect(CAPABILITY_HEALTH_OUTCOMES).toEqual(Object.values(CAPABILITY_HEALTH_OUTCOME));
    expect(CAPABILITY_WAL_PAYLOAD_KINDS).toEqual(Object.values(CAPABILITY_WAL_PAYLOAD_KIND));
    expect(CAPABILITY_PRE_EFFECT_FRONTIERS).toEqual(Object.values(CAPABILITY_PRE_EFFECT_FRONTIER));
    expect(CAPABILITY_PRE_EFFECT_REFUSAL_REASONS).toEqual(
      Object.values(CAPABILITY_PRE_EFFECT_REFUSAL_REASON),
    );
    expect(CAPABILITY_PRE_EFFECT_OBSERVED_STATES).toEqual(
      Object.values(CAPABILITY_PRE_EFFECT_OBSERVED_STATE),
    );
    expect(CAPABILITY_OPERATION_CHANGED_TARGET_OUTCOMES).toEqual([
      PUBLIC_TARGET_RESULT_OUTCOME.APPLIED,
      PUBLIC_TARGET_RESULT_OUTCOME.DEGRADED,
      PUBLIC_TARGET_RESULT_OUTCOME.NEEDS_RECOVERY,
    ]);
    expect(CAPABILITY_OPERATION_DEFAULT_RECOVERY_ACTIONS_BY_STATUS).toEqual({
      [CAPABILITY_OPERATION_STATUS.COMMITTING]: [],
      [CAPABILITY_OPERATION_STATUS.SUCCEEDED]: [],
      [CAPABILITY_OPERATION_STATUS.DEGRADED]: [],
      [CAPABILITY_OPERATION_STATUS.FAILED]: [
        CAPABILITY_OPERATION_RECOVERY_ACTION.RETRY,
        CAPABILITY_OPERATION_RECOVERY_ACTION.ROLLBACK,
      ],
      [CAPABILITY_OPERATION_STATUS.NEEDS_RECOVERY]: [
        CAPABILITY_OPERATION_RECOVERY_ACTION.REPAIR,
        CAPABILITY_OPERATION_RECOVERY_ACTION.EXPORT_REDACTED_DIAGNOSTICS,
      ],
    });
    for (const value of [
      CAPABILITY_OPERATION_STATUS,
      CAPABILITY_OPERATION_STATUSES,
      CAPABILITY_OPERATION_STATUS_BY_ACTION_STATE,
      CAPABILITY_OPERATION_RECOVERY_ACTION,
      CAPABILITY_OPERATION_RECOVERY_ACTIONS,
      CAPABILITY_OPERATION_DEFAULT_RECOVERY_ACTIONS_BY_STATUS,
      CAPABILITY_OPERATION_RECOVERY_PHASE,
      CAPABILITY_OPERATION_CHANGED_TARGET_OUTCOMES,
      CAPABILITY_ADAPTER_RECEIPT_STATE,
      CAPABILITY_ADAPTER_RECEIPT_STATES,
      CAPABILITY_ADAPTER_RECEIPT_EFFECT_UNRESOLVED_STATES,
      CAPABILITY_ADAPTER_RECEIPT_PUBLICATION_TERMINAL_STATES,
      CAPABILITY_HEALTH_OUTCOME,
      CAPABILITY_HEALTH_OUTCOMES,
      CAPABILITY_WAL_PAYLOAD_KIND,
      CAPABILITY_WAL_PAYLOAD_KINDS,
      CAPABILITY_PRE_EFFECT_FRONTIER,
      CAPABILITY_PRE_EFFECT_FRONTIERS,
      CAPABILITY_PRE_EFFECT_REFUSAL_REASON,
      CAPABILITY_PRE_EFFECT_REFUSAL_REASONS,
      CAPABILITY_PRE_EFFECT_OBSERVED_STATE,
      CAPABILITY_PRE_EFFECT_OBSERVED_STATES,
    ])
      expect(Object.isFrozen(value)).toBe(true);
    for (const actions of Object.values(CAPABILITY_OPERATION_DEFAULT_RECOVERY_ACTIONS_BY_STATUS))
      expect(Object.isFrozen(actions)).toBe(true);
  });
  test("guards status and recovery values without prototype membership", () => {
    for (const status of CAPABILITY_OPERATION_STATUSES)
      expect(isCapabilityOperationStatus(status)).toBe(true);
    for (const action of CAPABILITY_OPERATION_RECOVERY_ACTIONS)
      expect(isCapabilityOperationRecoveryAction(action)).toBe(true);
    for (const invalid of ["toString", "__proto__", "constructor", "", null, 1]) {
      expect(isCapabilityOperationStatus(invalid)).toBe(false);
      expect(isCapabilityOperationRecoveryAction(invalid)).toBe(false);
    }
  });
  test("operation consumers import authorities instead of redeclaring protocol literals", () => {
    const requiredImports = new Map<string, readonly string[]>([
      [
        "src/capabilities/operations/operation-preflight.ts",
        ["ACTION_OPERATION_STATE", "CAPABILITY_PRE_EFFECT_FRONTIER", "CAPABILITY_WAL_PAYLOAD_KIND"],
      ],
      [
        "src/capabilities/operations/operation-journal.ts",
        ["CAPABILITY_ADAPTER_RECEIPT_STATE", "CAPABILITY_WAL_PAYLOAD_KIND"],
      ],
      [
        "src/capabilities/operations/health-evidence.ts",
        [
          "isCapabilityHealthOutcome",
          "CAPABILITY_OUTBOX_TRANSITION",
          "CAPABILITY_WAL_PAYLOAD_KIND",
        ],
      ],
      [
        "src/capabilities/operations/wal-referential.ts",
        [
          "CAPABILITY_ADAPTER_RECEIPT_STATE",
          "CAPABILITY_HEALTH_OUTCOME",
          "CAPABILITY_WAL_PAYLOAD_KIND",
        ],
      ],
      [
        "src/capabilities/operations/wal-receipt-referential.ts",
        [
          "CAPABILITY_ADAPTER_RECEIPT_STATE",
          "CAPABILITY_PRE_EFFECT_FRONTIER",
          "CAPABILITY_WAL_PAYLOAD_KIND",
        ],
      ],
      [
        "src/capabilities/operations/fold.ts",
        [
          "CAPABILITY_OPERATION_STATUS_BY_ACTION_STATE",
          "CAPABILITY_OPERATION_DEFAULT_RECOVERY_ACTIONS_BY_STATUS",
        ],
      ],
    ]);
    const rawProtocolValues = new Set([
      ...CAPABILITY_WAL_PAYLOAD_KINDS,
      ...CAPABILITY_WAL_OPERATION_TRANSITION_FROM_STATES,
      ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
      ...CAPABILITY_ADAPTER_RECEIPT_STATES,
      ...CAPABILITY_HEALTH_OUTCOMES,
      ...CAPABILITY_PRE_EFFECT_REFUSAL_REASONS,
      ...CAPABILITY_PRE_EFFECT_FRONTIERS,
      ...CAPABILITY_PRE_EFFECT_OBSERVED_STATES,
      ...CAPABILITY_OUTBOX_PHASES,
      ...CAPABILITY_OUTBOX_TRANSITIONS,
      ...CAPABILITY_OUTBOX_DELIVERIES,
      ...CAPABILITY_OPERATION_STATUSES,
    ]);
    const quotedLiteral = (value: string): RegExp =>
      new RegExp(`(["'])${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\1`, "u");

    for (const [path, symbols] of requiredImports) {
      const source = readFileSync(resolve(path), "utf8");
      for (const symbol of symbols) expect(source, `${path} imports ${symbol}`).toContain(symbol);
      for (const value of rawProtocolValues)
        expect(source, `${path} does not redeclare ${value}`).not.toMatch(quotedLiteral(value));
    }

    const resultTypes = readFileSync(resolve("src/capabilities/operations/types.ts"), "utf8");
    expect(resultTypes).toContain("CapabilityOperationStatusV1");
    expect(resultTypes).toContain("CapabilityOperationRecoveryActionV1");
    expect(resultTypes).not.toContain("export type CapabilityOperationStatusV1 =");
    const resultFold = readFileSync(resolve("src/capabilities/operations/fold.ts"), "utf8");
    for (const value of CAPABILITY_OPERATION_RECOVERY_ACTIONS) {
      expect(resultTypes, `operation result type does not redeclare ${value}`).not.toMatch(
        quotedLiteral(value),
      );
      expect(resultFold, `operation fold does not redeclare ${value}`).not.toMatch(
        quotedLiteral(value),
      );
    }
  });

  test("durable WAL and receipt consumers cannot redeclare persisted protocol values", () => {
    const persistedConsumers = new Map<
      string,
      { imports: readonly string[]; forbidden: readonly string[] }
    >([
      [
        "src/capabilities/operations/lock-checkpoint.ts",
        {
          imports: ["CAPABILITY_WAL_PAYLOAD_KIND"],
          forbidden: CAPABILITY_WAL_PAYLOAD_KINDS,
        },
      ],
      [
        "src/capabilities/operations/publication-evidence.ts",
        {
          imports: ["CAPABILITY_WAL_PAYLOAD_KIND"],
          forbidden: CAPABILITY_WAL_PAYLOAD_KINDS,
        },
      ],
      [
        "src/capabilities/operations/publication-recovery.ts",
        {
          imports: [
            "ACTION_OPERATION_STATE",
            "CAPABILITY_PRE_EFFECT_FRONTIER",
            "CAPABILITY_WAL_PAYLOAD_KIND",
          ],
          forbidden: [
            ...CAPABILITY_WAL_PAYLOAD_KINDS,
            ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
            ...CAPABILITY_PRE_EFFECT_FRONTIERS,
          ],
        },
      ],
      [
        "src/capabilities/operations/operation-commit.ts",
        {
          imports: [
            "ACTION_OPERATION_STATE",
            "CAPABILITY_PRE_EFFECT_FRONTIER",
            "CAPABILITY_WAL_PAYLOAD_KIND",
          ],
          forbidden: [
            ...CAPABILITY_WAL_PAYLOAD_KINDS,
            ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
            ...CAPABILITY_PRE_EFFECT_FRONTIERS,
          ],
        },
      ],
      [
        "src/capabilities/operations/effect-runtime.ts",
        {
          imports: [
            "CAPABILITY_ADAPTER_RECEIPT_STATE",
            "CAPABILITY_HEALTH_OUTCOME",
            "CAPABILITY_OPERATION_RECOVERY_PHASE",
            "CAPABILITY_PRE_EFFECT_FRONTIER",
            "CAPABILITY_WAL_PAYLOAD_KIND",
          ],
          forbidden: [
            ...CAPABILITY_ADAPTER_RECEIPT_STATES,
            ...CAPABILITY_HEALTH_OUTCOMES,
            ...CAPABILITY_PRE_EFFECT_FRONTIERS,
            CAPABILITY_WAL_PAYLOAD_KIND.ADAPTER_STEP,
          ],
        },
      ],
      [
        "src/capabilities/operations/step-runtime.ts",
        {
          imports: [
            "ACTION_OPERATION_STATE",
            "CAPABILITY_ADAPTER_RECEIPT_STATE",
            "CAPABILITY_PRE_EFFECT_OBSERVED_STATE",
            "CAPABILITY_PRE_EFFECT_REFUSAL_REASON",
          ],
          forbidden: [
            ...CAPABILITY_ADAPTER_RECEIPT_STATES,
            ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
            ...CAPABILITY_PRE_EFFECT_OBSERVED_STATES,
            ...CAPABILITY_PRE_EFFECT_REFUSAL_REASONS,
          ],
        },
      ],
      [
        "src/capabilities/operations/executor.ts",
        {
          imports: [
            "ACTION_OPERATION_STATE",
            "CAPABILITY_ADAPTER_RECEIPT_STATE",
            "CAPABILITY_OPERATION_RECOVERY_PHASE",
          ],
          forbidden: [
            ...CAPABILITY_ADAPTER_RECEIPT_STATES,
            ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
            ...Object.values(CAPABILITY_OPERATION_RECOVERY_PHASE),
          ],
        },
      ],
      [
        "src/capabilities/operations/target-fold.ts",
        {
          imports: [
            "ACTION_OPERATION_STATE",
            "CAPABILITY_LOCK_TARGET_STATE",
            "CAPABILITY_ADAPTER_RECEIPT_STATE",
            "CAPABILITY_HEALTH_OUTCOME",
            "CAPABILITY_WAL_PAYLOAD_KIND",
            "PUBLIC_ACTION_TARGET_HEALTH_FAILURE",
            "PUBLIC_ACTION_TARGET_SUBJECT_KIND",
            "PUBLIC_TARGET_RESULT_OUTCOME",
          ],
          forbidden: [
            ...CAPABILITY_WAL_PAYLOAD_KINDS,
            ...CAPABILITY_ADAPTER_RECEIPT_STATES,
            ...CAPABILITY_HEALTH_OUTCOMES,
            ...ACTION_OPERATION_DISPATCH_REPLAY_STATES,
            ...PUBLIC_TARGET_RESULT_OUTCOMES,
            ...Object.values(PUBLIC_ACTION_TARGET_HEALTH_FAILURE),
            ...Object.values(PUBLIC_ACTION_TARGET_SUBJECT_KIND),
            ...Object.values(CAPABILITY_LOCK_TARGET_STATE),
          ],
        },
      ],
      [
        "src/capabilities/operations/lock-builder.ts",
        {
          imports: [
            "CAPABILITY_LOCK_TARGET_STATE",
            "PUBLIC_ACTION_TARGET_SUBJECT_KIND",
            "PUBLIC_TARGET_RESULT_OUTCOME",
          ],
          forbidden: [
            ...PUBLIC_TARGET_RESULT_OUTCOMES,
            ...Object.values(PUBLIC_ACTION_TARGET_SUBJECT_KIND),
            ...Object.values(CAPABILITY_LOCK_TARGET_STATE),
          ],
        },
      ],
    ]);
    const quotedLiteral = (value: string): RegExp =>
      new RegExp(`(["'])${value.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}\\1`, "u");

    for (const [path, contract] of persistedConsumers) {
      const source = readFileSync(resolve(path), "utf8");
      for (const symbol of contract.imports)
        expect(source, `${path} imports ${symbol}`).toContain(symbol);
      for (const value of new Set(contract.forbidden))
        expect(source, `${path} does not redeclare ${value}`).not.toMatch(quotedLiteral(value));
    }

    const effectRuntime = readFileSync(
      resolve("src/capabilities/operations/effect-runtime.ts"),
      "utf8",
    );
    expect(effectRuntime).not.toMatch(
      /(?:payload\.kind\s*(?:===|!==)|\bkind\s*:)\s*(["'])health\1/u,
    );
  });
});
