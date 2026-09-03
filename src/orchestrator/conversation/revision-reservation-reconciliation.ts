import { canonicalJsonBytes } from "../../durability/index.js";
import type { RevisionReservationRecordV1 } from "./lineage-reservation.js";
import type { LineageAuthorityStore } from "./lineage-store.js";
import { materializeConsumedRevisionReservation } from "./revision-planner.js";

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

function exactConsumedClosure(input: {
  lineage: LineageAuthorityStore;
  rootSessionId: string;
  expected: RevisionReservationRecordV1;
}): boolean {
  const current = input.lineage.readReservation(input.rootSessionId);
  if (current && same(current, input.expected)) return true;
  const historical = input.lineage
    .readReservationHistory(input.rootSessionId)
    .get(input.expected.content_digest);
  return historical !== undefined && same(historical, input.expected);
}

/** Proves the exact active-or-consumed closure without changing reservation state. */
export function validatePublishedRevisionReservation(input: {
  lineage: LineageAuthorityStore;
  reservation: RevisionReservationRecordV1;
  consumedAt: string;
}): "active" | "consumed" {
  const current = input.lineage.readReservation(input.reservation.root_session_id);
  if (current && same(current, input.reservation)) return "active";
  const expected = materializeConsumedRevisionReservation(input.reservation, input.consumedAt);
  if (
    exactConsumedClosure({
      lineage: input.lineage,
      rootSessionId: input.reservation.root_session_id,
      expected,
    })
  )
    return "consumed";
  throw new Error("published revision reservation closure changed");
}

/**
 * Closes only the exact reservation carried by a validated revision publication.
 * A later descendant is accepted only when its checkpoint chain contains that
 * exact consumed record; merely observing a newer reservation is never enough.
 */
export function reconcilePublishedRevisionReservation(input: {
  lineage: LineageAuthorityStore;
  reservation: RevisionReservationRecordV1;
  consumedAt: string;
}): void {
  const expected = materializeConsumedRevisionReservation(input.reservation, input.consumedAt);
  const current = input.lineage.readReservation(input.reservation.root_session_id);
  if (current?.content_digest === input.reservation.content_digest) {
    try {
      input.lineage.commitReservation(current, expected);
      return;
    } catch (error) {
      if (
        exactConsumedClosure({
          lineage: input.lineage,
          rootSessionId: input.reservation.root_session_id,
          expected,
        })
      )
        return;
      throw error;
    }
  }
  if (
    exactConsumedClosure({
      lineage: input.lineage,
      rootSessionId: input.reservation.root_session_id,
      expected,
    })
  )
    return;
  throw new Error("published revision reservation closure changed");
}
