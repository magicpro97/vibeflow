import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
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
