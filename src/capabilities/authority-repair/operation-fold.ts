import { canonicalJson } from "../../durability/index.js";
import { AUTHORITY_REPAIR_EVENT_STATE } from "./contract.js";
import { assertAuthorityRepairEvent, assertAuthorityRepairOperation } from "./records.js";
import type { AuthorityRepairEventV1, AuthorityRepairOperationV1 } from "./types.js";

export interface AuthorityRepairOperationFoldV1 {
  operation: Readonly<AuthorityRepairOperationV1>;
  events: readonly Readonly<AuthorityRepairEventV1>[];
  head_event_digest: string | null;
  state: AuthorityRepairEventV1["state"] | null;
  resume_anchor: AuthorityRepairEventV1["state"] | null;
}

function fail(message: string): never {
  throw new Error(`invalid authority repair operation journal: ${message}`);
}

const SUCCESSOR = Object.freeze({
  [AUTHORITY_REPAIR_EVENT_STATE.PREPARED]: Object.freeze([
    AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED,
    AUTHORITY_REPAIR_EVENT_STATE.FAILED,
    AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY,
  ]),
  [AUTHORITY_REPAIR_EVENT_STATE.PREIMAGE_FSYNCED]: Object.freeze([
    AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS,
    AUTHORITY_REPAIR_EVENT_STATE.FAILED,
    AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY,
  ]),
  [AUTHORITY_REPAIR_EVENT_STATE.RESTORE_IN_PROGRESS]: Object.freeze([
    AUTHORITY_REPAIR_EVENT_STATE.RESTORED,
    AUTHORITY_REPAIR_EVENT_STATE.FAILED,
    AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY,
  ]),
  [AUTHORITY_REPAIR_EVENT_STATE.RESTORED]: Object.freeze([
    AUTHORITY_REPAIR_EVENT_STATE.VERIFIED,
    AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY,
  ]),
  [AUTHORITY_REPAIR_EVENT_STATE.VERIFIED]: Object.freeze([]),
  [AUTHORITY_REPAIR_EVENT_STATE.FAILED]: Object.freeze([]),
  [AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY]: Object.freeze([]),
} as const satisfies Readonly<
  Record<AuthorityRepairEventV1["state"], readonly AuthorityRepairEventV1["state"][]>
>);

export function isAuthorityRepairOrdinarySuccessor(
  from: Exclude<AuthorityRepairEventV1["state"], "needs_recovery">,
  to: AuthorityRepairEventV1["state"],
): boolean {
  return SUCCESSOR[from].some((candidate) => candidate === to);
}

export function foldAuthorityRepairOperation(
  operation: AuthorityRepairOperationV1,
  events: readonly AuthorityRepairEventV1[],
): AuthorityRepairOperationFoldV1 {
  assertAuthorityRepairOperation(operation);
  let prior: AuthorityRepairEventV1 | null = null;
  let anchor: Exclude<AuthorityRepairEventV1["state"], "needs_recovery"> | null = null;
  for (const [sequence, event] of events.entries()) {
    assertAuthorityRepairEvent(event);
    if (
      event.repair_id !== operation.repair_id ||
      event.operation_id !== operation.operation_id ||
      event.header_digest !== operation.header_digest ||
      event.sequence !== sequence ||
      (event.previous_event_digest !== prior?.event_digest &&
        !(sequence === 0 && event.previous_event_digest === null))
    )
      fail("event identity, sequence, or digest chain mismatch");
    if (sequence === 0) {
      if (event.state !== AUTHORITY_REPAIR_EVENT_STATE.PREPARED)
        fail("sequence zero is not prepared");
    } else if (prior) {
      if (prior.state === AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY) {
        if (
          event.state !== AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY &&
          event.state !== AUTHORITY_REPAIR_EVENT_STATE.FAILED &&
          (!anchor || !isAuthorityRepairOrdinarySuccessor(anchor, event.state))
        )
          fail("needs-recovery resume skipped its nearest anchor");
      } else if (!isAuthorityRepairOrdinarySuccessor(prior.state, event.state)) {
        fail("event transition is forbidden");
      }
    }
    if (
      (event.state === AUTHORITY_REPAIR_EVENT_STATE.RESTORED ||
        event.state === AUTHORITY_REPAIR_EVENT_STATE.VERIFIED) &&
      event.observed_authority_digest !== operation.proposed_restored_authority_digest
    )
      fail("successful event does not bind the approved restored authority");
    if (event.state !== AUTHORITY_REPAIR_EVENT_STATE.NEEDS_RECOVERY) anchor = event.state;
    prior = event;
  }
  return Object.freeze({
    operation: Object.freeze(structuredClone(operation)),
    events: Object.freeze(events.map((event) => Object.freeze(structuredClone(event)))),
    head_event_digest: prior?.event_digest ?? null,
    state: prior?.state ?? null,
    resume_anchor: anchor,
  });
}

export function sameAuthorityRepairEvent(
  left: AuthorityRepairEventV1,
  right: AuthorityRepairEventV1,
): boolean {
  return canonicalJson(left) === canonicalJson(right);
}
