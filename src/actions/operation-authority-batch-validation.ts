import { HOST_ACTION_KIND } from "./host-action-contract.js";
import { ACTION_OPERATION_STATE } from "./protocol-contract.js";
import {
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_PREFIXED_PHASE,
} from "./public-operation-contract.js";
import type { ActionOperationEventV1 } from "./public-types.js";
import type { ActionAuthoritySnapshotV1 } from "./types.js";

const REPAIR_STATE = Object.freeze({
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.PREPARED]: ACTION_OPERATION_STATE.COMMITTING,
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.PREIMAGE_FSYNCED]:
    ACTION_OPERATION_STATE.COMMITTING,
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.RESTORE_IN_PROGRESS]:
    ACTION_OPERATION_STATE.COMMITTING,
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.RESTORED]: ACTION_OPERATION_STATE.COMMITTING,
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.VERIFIED]: ACTION_OPERATION_STATE.SUCCEEDED,
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.FAILED]: ACTION_OPERATION_STATE.FAILED,
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.NEEDS_RECOVERY]:
    ACTION_OPERATION_STATE.NEEDS_RECOVERY,
} as const);
type RepairPhase = keyof typeof REPAIR_STATE;
type RepairAnchorPhase = Exclude<
  RepairPhase,
  typeof PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.NEEDS_RECOVERY
>;

const REPAIR_EDGES = Object.freeze({
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.PREPARED]: Object.freeze([
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.PREIMAGE_FSYNCED,
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.FAILED,
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.NEEDS_RECOVERY,
  ]),
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.PREIMAGE_FSYNCED]: Object.freeze([
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.RESTORE_IN_PROGRESS,
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.FAILED,
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.NEEDS_RECOVERY,
  ]),
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.RESTORE_IN_PROGRESS]: Object.freeze([
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.RESTORED,
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.FAILED,
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.NEEDS_RECOVERY,
  ]),
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.RESTORED]: Object.freeze([
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.VERIFIED,
    PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.NEEDS_RECOVERY,
  ]),
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.VERIFIED]: Object.freeze([]),
  [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.FAILED]: Object.freeze([]),
} satisfies Readonly<Record<RepairAnchorPhase, readonly RepairPhase[]>>);

const isRepairPhase = (value: unknown): value is RepairPhase =>
  typeof value === "string" && Object.hasOwn(REPAIR_STATE, value);

export function validateRepairProgression(events: readonly ActionOperationEventV1[]): void {
  let prior: RepairPhase | null = null;
  let anchor: RepairAnchorPhase | null = null;
  for (const [index, event] of events.entries()) {
    if (index === 0) {
      if (
        event.state !== ACTION_OPERATION_STATE.COMMITTING ||
        event.progress?.phase !== PUBLIC_OPERATION_FIXED_PHASE.DISPATCH
      )
        invalid("repair phase zero is not its committing dispatch");
      continue;
    }
    const phase = event.progress?.phase;
    if (!isRepairPhase(phase) || event.state !== REPAIR_STATE[phase])
      invalid("nonterminal phase must remain committing or match its repair terminal state");
    if (prior === null) {
      if (phase !== PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.PREPARED)
        invalid("repair event chain does not begin at prepared");
    } else if (prior === PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.NEEDS_RECOVERY) {
      if (
        phase !== PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.NEEDS_RECOVERY &&
        phase !== PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.FAILED &&
        (!anchor || !REPAIR_EDGES[anchor].some((candidate) => candidate === phase))
      )
        invalid("repair reconciliation does not resume the nearest anchor edge");
    } else if (!REPAIR_EDGES[prior].some((candidate) => candidate === phase)) {
      invalid(`illegal repair phase transition ${prior} to ${phase}`);
    }
    if (phase !== PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_REPAIR.NEEDS_RECOVERY) anchor = phase;
    prior = phase;
  }
}

export function validateAuthorityChangeProgression(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[],
): void {
  const expected =
    snapshot.proposal.action.type === HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY
      ? [
          PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.PREPARED,
          PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.EFFECT_IN_PROGRESS,
          PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.OBSERVED,
        ]
      : [PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.OBSERVED];
  let position = 0;
  for (const event of events.slice(1)) {
    const phase = event.progress?.phase;
    if (
      phase === PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.PREPARED ||
      phase === PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.EFFECT_IN_PROGRESS ||
      phase === PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.OBSERVED
    ) {
      if (phase !== expected[position])
        invalid("authority change nonterminal phases are not in their exact durable order");
      position += 1;
      continue;
    }
    if (
      phase === PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.EPOCH_COMMITTED &&
      position !== expected.length
    )
      invalid("authority epoch committed before its exact staged phase closure");
    if (
      phase !== PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.EPOCH_COMMITTED &&
      phase !== PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.FAILED &&
      phase !== PUBLIC_OPERATION_PREFIXED_PHASE.AUTHORITY_CHANGE.NEEDS_RECOVERY
    )
      invalid("authority change operation contains a foreign phase");
  }
}

function invalid(message: string): never {
  throw new Error(message);
}
