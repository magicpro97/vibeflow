import { expect, test } from "bun:test";
import type { RevisionOperationV1 } from "../../src/orchestrator/conversation/lineage-revision-operation.js";
import type { LineageAuthorityStore } from "../../src/orchestrator/conversation/lineage-store.js";
import {
  materializeConsumedRevisionReservation,
  materializeRevisionReservation,
} from "../../src/orchestrator/conversation/revision-planner.js";
import { reconcilePublishedRevisionReservation } from "../../src/orchestrator/conversation/revision-reservation-reconciliation.js";

const recordedAt = "2026-08-25T00:00:00.000Z";

function operation(suffix: string, expected: string | null, epoch: number): RevisionOperationV1 {
  return {
    root_session_id: "root-session",
    reservation_epoch: epoch,
    expected_reservation_digest: expected,
    revision_claim_epoch: epoch,
    operation_id: `vf-operation-${suffix.repeat(64)}`,
    proposal_id: `vf-proposal-${suffix.repeat(64)}`,
    plan_digest: `sha256:${suffix.repeat(64)}`,
    parent: { conversation_id: "parent", revision_id: "parent-revision", revision_ordinal: 0 },
    child: {
      conversation_id: `child-${suffix}`,
      revision_id: `revision-${suffix}`,
      revision_ordinal: 1,
    },
    created_at: recordedAt,
  } as RevisionOperationV1;
}

test("a descendant reservation is accepted only through the exact consumed checkpoint", () => {
  const active = materializeRevisionReservation(operation("1", null, 1));
  const consumed = materializeConsumedRevisionReservation(active, recordedAt);
  const descendant = materializeRevisionReservation(
    operation("2", consumed.content_digest, consumed.reservation_epoch + 1),
  );
  let commits = 0;
  const lineage = {
    readReservation: () => structuredClone(descendant),
    readReservationHistory: () => new Map([[consumed.content_digest, structuredClone(consumed)]]),
    commitReservation: () => {
      commits += 1;
      throw new Error("descendant reservation was overwritten");
    },
  } as unknown as LineageAuthorityStore;

  reconcilePublishedRevisionReservation({ lineage, reservation: active, consumedAt: recordedAt });
  expect(commits).toBe(0);

  const divergent = {
    ...lineage,
    readReservationHistory: () =>
      new Map([
        [
          consumed.content_digest,
          { ...consumed, operation_id: operation("3", null, 1).operation_id },
        ],
      ]),
  } as unknown as LineageAuthorityStore;
  expect(() =>
    reconcilePublishedRevisionReservation({
      lineage: divergent,
      reservation: active,
      consumedAt: recordedAt,
    }),
  ).toThrow("published revision reservation closure changed");
});

test("a reservation CAS loser accepts only the exact consumed reread", () => {
  const active = materializeRevisionReservation(operation("4", null, 1));
  const consumed = materializeConsumedRevisionReservation(active, recordedAt);
  let current = structuredClone(active);
  let commits = 0;
  const lineage = {
    readReservation: () => structuredClone(current),
    readReservationHistory: () => new Map(),
    commitReservation: () => {
      commits += 1;
      current = structuredClone(consumed);
      throw new Error("simulated reservation CAS loss");
    },
  } as unknown as LineageAuthorityStore;

  reconcilePublishedRevisionReservation({ lineage, reservation: active, consumedAt: recordedAt });
  expect(commits).toBe(1);
  expect(current).toEqual(consumed);
});
