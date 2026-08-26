import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  OWNED_CLI_IDENTITY_STATE,
  OWNED_CLI_IDENTITY_STATES,
  OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE,
  OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODES,
  OWNED_PROCESS_PRESENCE_KIND,
  OWNED_PROCESS_PRESENCE_KINDS,
  OWNED_PROCESS_PROOF_STRENGTH,
  OWNED_PROCESS_PROOF_STRENGTHS,
  OWNED_PROCESS_QUIESCENCE_MODE,
  OWNED_PROCESS_QUIESCENCE_MODES,
  OWNED_PROCESS_QUIESCENCE_SCOPE,
  OWNED_PROCESS_QUIESCENCE_SCOPES,
  OWNED_PROCESS_STATE,
  OWNED_PROCESS_STATES,
  OWNED_PROCESS_STRATEGIES,
  OWNED_PROCESS_STRATEGY,
  OWNED_PROCESS_TERMINAL_KIND,
  OWNED_PROCESS_TERMINAL_KINDS,
  OWNED_SUPERVISOR_OUTCOME_KIND,
  OWNED_SUPERVISOR_OUTCOME_KINDS,
  OWNED_SUPERVISOR_PHASE,
  OWNED_SUPERVISOR_PHASES,
  OWNED_SUPERVISOR_RECEIPT_KEY,
  OWNED_SUPERVISOR_RECEIPT_KEYS,
  OWNED_SUPERVISOR_RECEIPT_PHASE,
  OWNED_SUPERVISOR_RECEIPT_PHASES,
  OWNED_SUPERVISOR_STATUS_KEY,
  OWNED_SUPERVISOR_TERMINAL_PHASE,
  OWNED_SUPERVISOR_TERMINAL_PHASES,
  isOwnedCliIdentityState,
  isOwnedProcessIgnorableStreamErrorCode,
  isOwnedProcessPresenceKind,
  isOwnedProcessProofStrength,
  isOwnedProcessQuiescenceMode,
  isOwnedProcessQuiescenceScope,
  isOwnedProcessState,
  isOwnedProcessStrategy,
  isOwnedProcessTerminalKind,
  isOwnedSupervisorOutcomeKind,
  isOwnedSupervisorPhase,
  isOwnedSupervisorReceiptKey,
  isOwnedSupervisorReceiptPhase,
  isOwnedSupervisorTerminalPhase,
} from "../src/dispatch/owned-process-contract.js";
import {
  ignorableOwnedStdinError,
  waitForOwnedSupervisorReceipt,
} from "../src/dispatch/owned-process-launch-receipt.js";
import { OWNED_SUPERVISOR_SCRIPT } from "../src/dispatch/owned-process-launch.js";
import {
  CAPABILITY_DISPATCH_RELEASE_OUTCOME,
  CAPABILITY_DISPATCH_RELEASE_OUTCOMES,
  CAPABILITY_DISPATCH_RESERVATION_ERROR_NAME,
  CAPABILITY_DISPATCH_RESERVATION_SCHEMA_VERSION,
  CAPABILITY_DISPATCH_RESERVATION_STALE_REASON,
  CAPABILITY_DISPATCH_RESERVATION_STATUS,
  CAPABILITY_DISPATCH_RESERVATION_STATUSES,
  isCapabilityDispatchReleaseOutcome,
  isCapabilityDispatchReservationStatus,
} from "../src/orchestrator/conversation/conversation-capability-dispatch-reservation-contract.js";
import {
  LINEAGE_MUTATION_ACTION_TYPE,
  LINEAGE_MUTATION_ACTION_TYPES,
  LINEAGE_MUTATION_KIND,
  LINEAGE_MUTATION_KINDS,
  LINEAGE_MUTATION_RELEASE_OUTCOME,
  LINEAGE_MUTATION_RELEASE_OUTCOMES,
  LINEAGE_MUTATION_RESERVATION_ERROR_NAME,
  LINEAGE_MUTATION_RESERVATION_SCHEMA_VERSION,
  LINEAGE_MUTATION_RESERVATION_STALE_REASON,
  LINEAGE_MUTATION_RESERVATION_STATUS,
  LINEAGE_MUTATION_RESERVATION_STATUSES,
  isLineageMutationActionType,
  isLineageMutationKind,
  isLineageMutationReleaseOutcome,
  isLineageMutationReservationStatus,
} from "../src/orchestrator/conversation/conversation-lineage-mutation-reservation-contract.js";

const valuesAreUnique = (values: readonly string[]): boolean =>
  new Set(values).size === values.length;

describe("durable reservation protocol contracts", () => {
  test("capability dispatch vocabulary is frozen, parity-safe, and fail-closed", () => {
    expect(
      [
        CAPABILITY_DISPATCH_RESERVATION_STATUS,
        CAPABILITY_DISPATCH_RESERVATION_STATUSES,
        CAPABILITY_DISPATCH_RELEASE_OUTCOME,
        CAPABILITY_DISPATCH_RELEASE_OUTCOMES,
        CAPABILITY_DISPATCH_RESERVATION_STALE_REASON,
        CAPABILITY_DISPATCH_RESERVATION_ERROR_NAME,
      ].every(Object.isFrozen),
    ).toBe(true);
    expect(CAPABILITY_DISPATCH_RESERVATION_STATUSES).toEqual(
      Object.values(CAPABILITY_DISPATCH_RESERVATION_STATUS),
    );
    expect(CAPABILITY_DISPATCH_RELEASE_OUTCOMES).toEqual(
      Object.values(CAPABILITY_DISPATCH_RELEASE_OUTCOME),
    );
    expect(
      CAPABILITY_DISPATCH_RESERVATION_STATUSES.every(isCapabilityDispatchReservationStatus),
    ).toBe(true);
    expect(CAPABILITY_DISPATCH_RELEASE_OUTCOMES.every(isCapabilityDispatchReleaseOutcome)).toBe(
      true,
    );
    expect(isCapabilityDispatchReservationStatus("unknown")).toBe(false);
    expect(isCapabilityDispatchReleaseOutcome(null)).toBe(false);
  });

  test("lineage mutation vocabulary is frozen, parity-safe, and fail-closed", () => {
    expect(
      [
        LINEAGE_MUTATION_RESERVATION_STATUS,
        LINEAGE_MUTATION_RESERVATION_STATUSES,
        LINEAGE_MUTATION_KIND,
        LINEAGE_MUTATION_KINDS,
        LINEAGE_MUTATION_ACTION_TYPE,
        LINEAGE_MUTATION_ACTION_TYPES,
        LINEAGE_MUTATION_RELEASE_OUTCOME,
        LINEAGE_MUTATION_RELEASE_OUTCOMES,
        LINEAGE_MUTATION_RESERVATION_STALE_REASON,
        LINEAGE_MUTATION_RESERVATION_ERROR_NAME,
      ].every(Object.isFrozen),
    ).toBe(true);
    expect(LINEAGE_MUTATION_RESERVATION_STATUSES).toEqual(
      Object.values(LINEAGE_MUTATION_RESERVATION_STATUS),
    );
    expect(LINEAGE_MUTATION_KINDS).toEqual(Object.values(LINEAGE_MUTATION_KIND));
    expect(LINEAGE_MUTATION_ACTION_TYPES).toEqual(Object.values(LINEAGE_MUTATION_ACTION_TYPE));
    expect(LINEAGE_MUTATION_RELEASE_OUTCOMES).toEqual(
      Object.values(LINEAGE_MUTATION_RELEASE_OUTCOME),
    );
    expect(LINEAGE_MUTATION_RESERVATION_STATUSES.every(isLineageMutationReservationStatus)).toBe(
      true,
    );
    expect(LINEAGE_MUTATION_KINDS.every(isLineageMutationKind)).toBe(true);
    expect(LINEAGE_MUTATION_ACTION_TYPES.every(isLineageMutationActionType)).toBe(true);
    expect(LINEAGE_MUTATION_RELEASE_OUTCOMES.every(isLineageMutationReleaseOutcome)).toBe(true);
    expect([
      isLineageMutationReservationStatus("unknown"),
      isLineageMutationKind("remove"),
      isLineageMutationActionType(null),
      isLineageMutationReleaseOutcome(1),
    ]).toEqual([false, false, false, false]);
  });

  test("reservation consumers do not duplicate their protocol literals", () => {
    const protocols = [
      {
        consumers: [
          "src/orchestrator/conversation/conversation-capability-dispatch-reservation-records.ts",
          "src/orchestrator/conversation/conversation-capability-dispatch-reservation.ts",
        ],
        literals: [
          CAPABILITY_DISPATCH_RESERVATION_SCHEMA_VERSION,
          ...Object.values(CAPABILITY_DISPATCH_RESERVATION_STATUS),
          ...Object.values(CAPABILITY_DISPATCH_RELEASE_OUTCOME),
          ...Object.values(CAPABILITY_DISPATCH_RESERVATION_STALE_REASON),
          ...Object.values(CAPABILITY_DISPATCH_RESERVATION_ERROR_NAME),
        ],
      },
      {
        consumers: [
          "src/orchestrator/conversation/conversation-lineage-mutation-reservation-records.ts",
          "src/orchestrator/conversation/conversation-lineage-mutation-reservation.ts",
        ],
        literals: [
          LINEAGE_MUTATION_RESERVATION_SCHEMA_VERSION,
          ...Object.values(LINEAGE_MUTATION_RESERVATION_STATUS),
          ...Object.values(LINEAGE_MUTATION_KIND),
          ...Object.values(LINEAGE_MUTATION_ACTION_TYPE),
          ...Object.values(LINEAGE_MUTATION_RELEASE_OUTCOME),
          ...Object.values(LINEAGE_MUTATION_RESERVATION_STALE_REASON),
          ...Object.values(LINEAGE_MUTATION_RESERVATION_ERROR_NAME),
        ],
      },
    ] as const;
    const duplicates: string[] = [];
    for (const protocol of protocols) {
      expect(valuesAreUnique(protocol.literals)).toBe(true);
      for (const consumer of protocol.consumers) {
        const source = readFileSync(resolve(consumer), "utf8");
        for (const literal of protocol.literals) {
          if (source.includes(JSON.stringify(literal)))
            duplicates.push(`${consumer} -> ${literal}`);
        }
      }
    }
    expect(duplicates).toEqual([]);
  });
});

describe("owned process protocol contract", () => {
  test("closed vocabularies are frozen, parity-safe, and narrowed fail-closed", () => {
    const vocabularies = [
      [OWNED_PROCESS_STATE, OWNED_PROCESS_STATES, isOwnedProcessState],
      [OWNED_PROCESS_STRATEGY, OWNED_PROCESS_STRATEGIES, isOwnedProcessStrategy],
      [
        OWNED_PROCESS_QUIESCENCE_SCOPE,
        OWNED_PROCESS_QUIESCENCE_SCOPES,
        isOwnedProcessQuiescenceScope,
      ],
      [OWNED_PROCESS_PROOF_STRENGTH, OWNED_PROCESS_PROOF_STRENGTHS, isOwnedProcessProofStrength],
      [OWNED_PROCESS_QUIESCENCE_MODE, OWNED_PROCESS_QUIESCENCE_MODES, isOwnedProcessQuiescenceMode],
      [OWNED_SUPERVISOR_PHASE, OWNED_SUPERVISOR_PHASES, isOwnedSupervisorPhase],
      [
        OWNED_SUPERVISOR_TERMINAL_PHASE,
        OWNED_SUPERVISOR_TERMINAL_PHASES,
        isOwnedSupervisorTerminalPhase,
      ],
      [
        OWNED_SUPERVISOR_RECEIPT_PHASE,
        OWNED_SUPERVISOR_RECEIPT_PHASES,
        isOwnedSupervisorReceiptPhase,
      ],
      [OWNED_SUPERVISOR_RECEIPT_KEY, OWNED_SUPERVISOR_RECEIPT_KEYS, isOwnedSupervisorReceiptKey],
      [OWNED_CLI_IDENTITY_STATE, OWNED_CLI_IDENTITY_STATES, isOwnedCliIdentityState],
      [OWNED_PROCESS_PRESENCE_KIND, OWNED_PROCESS_PRESENCE_KINDS, isOwnedProcessPresenceKind],
      [OWNED_SUPERVISOR_OUTCOME_KIND, OWNED_SUPERVISOR_OUTCOME_KINDS, isOwnedSupervisorOutcomeKind],
      [
        OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE,
        OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODES,
        isOwnedProcessIgnorableStreamErrorCode,
      ],
      [OWNED_PROCESS_TERMINAL_KIND, OWNED_PROCESS_TERMINAL_KINDS, isOwnedProcessTerminalKind],
    ] as const;
    for (const [contract, values, guard] of vocabularies) {
      expect(Object.isFrozen(contract)).toBe(true);
      expect(Object.isFrozen(values)).toBe(true);
      expect(JSON.stringify(values)).toBe(JSON.stringify(Object.values(contract)));
      expect(valuesAreUnique(values)).toBe(true);
      expect(values.every((value) => guard(value))).toBe(true);
      expect(guard(Symbol("untrusted"))).toBe(false);
    }
    expect(Object.isFrozen(OWNED_SUPERVISOR_STATUS_KEY)).toBe(true);
  });

  test("receipt reader validates all untrusted optional CLI fields", () => {
    const cliKey = OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PID;
    const invalidReceipts = [
      null,
      [],
      { [cliKey]: 0 },
      { [cliKey]: 42, [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY]: 1 },
      { [cliKey]: 42, [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY_STATE]: "forged" },
      { [cliKey]: 42, [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PGID]: -1 },
    ];
    const validReceipt = {
      [cliKey]: 42,
      [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY]: "linux:boot:42",
      [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_IDENTITY_STATE]: OWNED_CLI_IDENTITY_STATE.AVAILABLE,
      [OWNED_SUPERVISOR_RECEIPT_KEY.CLI_PGID]: 41,
    };
    const serialized = [...invalidReceipts, validReceipt].map((value) => JSON.stringify(value));
    const runtime = {
      now: () => Date.now(),
      readFileSync: (() =>
        serialized.shift() ?? JSON.stringify(validReceipt)) as unknown as typeof readFileSync,
    };
    expect(waitForOwnedSupervisorReceipt("receipt.json", cliKey, runtime)).toEqual(validReceipt);

    const supervisorReceipt = {
      [OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID]: 40,
      [OWNED_SUPERVISOR_RECEIPT_KEY.CONTAINMENT]:
        OWNED_PROCESS_QUIESCENCE_SCOPE.POSIX_PROCESS_GROUP,
    };
    expect(
      waitForOwnedSupervisorReceipt("receipt.json", OWNED_SUPERVISOR_RECEIPT_KEY.SUPERVISOR_PID, {
        now: () => Date.now(),
        readFileSync: (() => JSON.stringify(supervisorReceipt)) as unknown as typeof readFileSync,
      }),
    ).toEqual(supervisorReceipt);
  });

  test("launch and status consumers use the canonical receipt/status/error vocabulary", () => {
    expect(
      ignorableOwnedStdinError({ code: OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE.BROKEN_PIPE }),
    ).toBe(true);
    expect(
      ignorableOwnedStdinError({
        code: OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE.STREAM_DESTROYED,
      }),
    ).toBe(true);
    expect(ignorableOwnedStdinError({ code: "ENOENT" })).toBe(false);
    expect(OWNED_SUPERVISOR_SCRIPT).toContain(
      `const RECEIPT_KEY = ${JSON.stringify(OWNED_SUPERVISOR_RECEIPT_KEY)};`,
    );
    expect(OWNED_SUPERVISOR_SCRIPT).toContain(
      `const STATUS_KEY = ${JSON.stringify(OWNED_SUPERVISOR_STATUS_KEY)};`,
    );

    const consumers = [
      "src/dispatch/owned-process-launch-receipt.ts",
      "src/dispatch/owned-process-launch.ts",
      "src/dispatch/owned-process-status.ts",
    ];
    const literals = [
      ...Object.values(OWNED_SUPERVISOR_RECEIPT_KEY),
      ...Object.values(OWNED_SUPERVISOR_STATUS_KEY),
      ...Object.values(OWNED_PROCESS_IGNORABLE_STREAM_ERROR_CODE),
    ];
    const duplicates: string[] = [];
    for (const consumer of consumers) {
      const source = readFileSync(resolve(consumer), "utf8");
      for (const literal of literals) {
        if (source.includes(JSON.stringify(literal))) duplicates.push(`${consumer} -> ${literal}`);
      }
    }
    expect(duplicates).toEqual([]);
    expect(readFileSync(resolve("src/dispatch/owned-process-status.ts"), "utf8")).not.toContain(
      "UNPROVEN_SUPERVISOR_EXIT_CODE",
    );
  });
});
