import {
  type ActionAuthoritySnapshotV1,
  type ActionOperationEventV1,
  type ActionOperationState,
  type PublicOperationPhaseV1,
  type PublicTargetResultV1,
  projectActionSnapshot,
} from "../../actions/index.js";
import { expectedOperationStatus } from "../../actions/operation-phase-rules.js";
import { canonicalJson, digestHex, digestV1 } from "../../durability/index.js";
import {
  readOperationBaseLock,
  readOperationGraph,
  readOperationHeader,
} from "../operations/fold.js";
import { foldCapabilityTarget } from "../operations/target-fold.js";
import type { CapabilityOperationActionAuthorityV1 } from "../operations/types.js";
import { readCapabilityWal } from "../storage/operation-store.js";
import type { CapabilityStorageV1 } from "../storage/store.js";
import type { CapabilityWalEventV1 } from "../wire/operation.js";

type TerminalStateV1 = Extract<ActionOperationState, "succeeded" | "failed" | "needs_recovery">;

function cursor(
  operationId: string,
  sequence: number,
  authorityDigest: string,
  targetId: string | null,
): string {
  return `vf-operation-event-${digestHex(
    digestV1("VF-CAPABILITY-ACTION-EVENT-CURSOR\0v1\0", {
      schema_version: "1.0",
      operation_id: operationId,
      phase_sequence: sequence,
      authority_digest: authorityDigest,
      target_id: targetId,
    }),
  )}`;
}

function targetPhase(outcome: PublicTargetResultV1["outcome"]): PublicOperationPhaseV1 {
  if (outcome === "applied") return "target-applied";
  if (outcome === "omitted") return "target-omitted";
  if (outcome === "reversed") return "target-reversed";
  if (outcome === "degraded") return "target-degraded";
  if (outcome === "failed") return "target-failed";
  if (outcome === "needs-recovery") return "target-needs-recovery";
  return "target-blocked";
}

function boundaryPhase(state: TerminalStateV1): PublicOperationPhaseV1 {
  return state === "succeeded"
    ? "operation-succeeded"
    : state === "failed"
      ? "operation-failed"
      : "operation-needs-recovery";
}

function terminalTransitions(events: readonly CapabilityWalEventV1[]) {
  return events.flatMap((event, index) =>
    event.payload.kind === "operation-transition" &&
    ["succeeded", "failed", "needs_recovery"].includes(event.payload.to)
      ? [{ event, index, state: event.payload.to as TerminalStateV1 }]
      : [],
  );
}

function append(
  output: ActionOperationEventV1[],
  operationId: string,
  phase: PublicOperationPhaseV1,
  state: ActionOperationState,
  occurredAt: string,
  authorityDigest: string,
  target: PublicTargetResultV1 | null,
): void {
  const sequence = output.length;
  output.push({
    schema_version: "1.0",
    operation_id: operationId,
    phase_sequence: sequence,
    state,
    progress: {
      sequence,
      phase,
      status: expectedOperationStatus(phase, state),
      message_code: `operation.${phase}`,
      at: occurredAt,
    },
    target: target ? structuredClone(target) : null,
    error: null,
    occurred_at: occurredAt,
    event_cursor: cursor(operationId, sequence, authorityDigest, target?.target_id ?? null),
  });
}

/** Deterministically projects the private Capability WAL into the shared public action stream. */
export function projectCapabilityActionEvents(
  snapshot: ActionAuthoritySnapshotV1,
  storage: CapabilityStorageV1,
  actionAuthority: CapabilityOperationActionAuthorityV1,
): ActionOperationEventV1[] {
  const operationId = snapshot.operation_id;
  if (!operationId || !snapshot.approval) return [];
  const header = readOperationHeader(storage, operationId);
  const plan = readOperationGraph(actionAuthority, header).plan;
  const baseLock = readOperationBaseLock(storage, plan);
  const wal = readCapabilityWal(storage.paths, operationId);
  const output: ActionOperationEventV1[] = [];
  append(
    output,
    operationId,
    "operation-started",
    "committing",
    header.created_at,
    header.header_digest,
    null,
  );
  if (snapshot.state === "committing") return output;
  const transitions = terminalTransitions(wal);
  const retained =
    snapshot.state === "needs_recovery"
      ? transitions.filter((row) => row.state === "needs_recovery").slice(0, 1)
      : transitions.slice(0, transitions.findIndex((row) => row.state === snapshot.state) + 1);
  if (retained.length === 0) return output;
  let prior = new Map<string, PublicTargetResultV1>();
  for (const transition of retained) {
    const prefix = wal.slice(0, transition.index + 1);
    const current = plan.targets.map((target) =>
      foldCapabilityTarget({
        plan,
        events: prefix,
        targetId: target.target_id,
        terminal: transition.state,
        baseLock,
      }),
    );
    const changed =
      prior.size === 0
        ? current
        : current.filter(
            (target) => canonicalJson(prior.get(target.target_id)) !== canonicalJson(target),
          );
    for (const target of changed)
      append(
        output,
        operationId,
        targetPhase(target.outcome),
        transition.state,
        transition.event.recorded_at,
        transition.event.event_digest,
        target,
      );
    append(
      output,
      operationId,
      boundaryPhase(transition.state),
      transition.state,
      transition.event.recorded_at,
      transition.event.event_digest,
      null,
    );
    prior = new Map(current.map((target) => [target.target_id, target]));
  }
  return output;
}

export function projectCapabilityActionSnapshot(
  snapshot: ActionAuthoritySnapshotV1,
  storage: CapabilityStorageV1,
  actionAuthority: CapabilityOperationActionAuthorityV1,
) {
  return projectActionSnapshot(
    snapshot,
    projectCapabilityActionEvents(snapshot, storage, actionAuthority),
  );
}
