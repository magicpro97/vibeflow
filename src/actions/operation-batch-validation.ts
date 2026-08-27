import { canonicalJsonBytes } from "../durability/index.js";
import { HOST_ACTION_KIND, type HostActionKind } from "./host-action-contract.js";
import {
  validateAuthorityChangeProgression,
  validateRepairProgression,
} from "./operation-authority-batch-validation.js";
import { terminalStateForPhase } from "./operation-phase-rules.js";
import {
  ACTION_OPERATION_STATE,
  type ActionOperationState,
  isActionOperationDomainTerminalState,
  isActionOperationResolvedDomainState,
} from "./protocol-contract.js";
import {
  PUBLIC_OPERATION_FIXED_PHASE,
  PUBLIC_OPERATION_PHASE_PREFIX,
  PUBLIC_TARGET_RESULT_OUTCOME,
  type PublicOperationPhaseV1,
  isPublicOperationParticipantTargetPhase,
  isPublicOperationPhase,
  isPublicOperationStateDependentStatusPhase,
  publicOperationTargetOutcomes,
} from "./public-operation-contract.js";
import { isPublicOperationPhaseStateValid } from "./public-operation-semantics.js";
import type { ActionOperationEventV1 } from "./public-types.js";
import type { ActionAuthoritySnapshotV1 } from "./types.js";

const AUTHORITY_ACTIONS = new Set<HostActionKind>([
  HOST_ACTION_KIND.GRANT_CREATE,
  HOST_ACTION_KIND.GRANT_RENEW,
  HOST_ACTION_KIND.GRANT_REVOKE,
  HOST_ACTION_KIND.POLICY_UPDATE_AUTHORITY,
  HOST_ACTION_KIND.SECRET_REVOKE,
  HOST_ACTION_KIND.REGISTRY_TRUST_KEY,
]);

const RECEIPT_ACTIONS = new Set<HostActionKind>([
  HOST_ACTION_KIND.CONVERSATION_SELECT_LINEAGE_HEAD,
  HOST_ACTION_KIND.CONVERSATION_ASSOCIATE_LINEAGES,
  HOST_ACTION_KIND.CONVERSATION_PUBLISH_SUSPECTED_LITERAL,
  HOST_ACTION_KIND.CONVERSATION_STOP_OPERATION,
  HOST_ACTION_KIND.CONTEXT_COMPACT,
]);

const CAPABILITY_OPERATION_BOUNDARY_PHASES = Object.freeze([
  PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED,
  PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED,
  PUBLIC_OPERATION_FIXED_PHASE.OPERATION_NEEDS_RECOVERY,
] as const);

const CAPABILITY_FINAL_BOUNDARY_PHASES = Object.freeze([
  PUBLIC_OPERATION_FIXED_PHASE.OPERATION_SUCCEEDED,
  PUBLIC_OPERATION_FIXED_PHASE.OPERATION_FAILED,
] as const);

export function validateOperationBatches(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[],
): void {
  if (!events.length) return;
  if (snapshot.proposal.action.type === HOST_ACTION_KIND.AUTHORITY_REPAIR)
    validateRepairProgression(events);
  else validateStateProgression(snapshot, events);
  const capability = snapshot.proposal.action.type.startsWith("capability.");
  if (capability) validateCapabilityBatches(snapshot, events);
  else {
    if (AUTHORITY_ACTIONS.has(snapshot.proposal.action.type))
      validateAuthorityChangeProgression(snapshot, events);
    validateNonCapabilityClosure(snapshot, events);
  }
}

function validateStateProgression(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[],
): void {
  let state: ActionOperationState = ACTION_OPERATION_STATE.COMMITTING;
  let boundary: ActionOperationEventV1 | null = null;
  for (const [index, event] of events.entries()) {
    assertPhaseStateClass(snapshot, event, index);
    if (index === 0) {
      if (event.state !== ACTION_OPERATION_STATE.COMMITTING)
        invalid("operation phase zero is not committing");
      continue;
    }
    if (event.state !== state) {
      const valid =
        (state === ACTION_OPERATION_STATE.COMMITTING &&
          isActionOperationDomainTerminalState(event.state)) ||
        (state === ACTION_OPERATION_STATE.NEEDS_RECOVERY &&
          isActionOperationResolvedDomainState(event.state));
      if (!valid) invalid(`illegal operation state transition ${state} to ${event.state}`);
      if (!isDomainTerminalBoundary(event) && !isCapabilityTargetPhase(event.progress?.phase))
        invalid("operation state changes outside a terminal batch");
      state = event.state;
    }
    if (isDomainTerminalBoundary(event)) {
      if (boundary && boundary.state !== ACTION_OPERATION_STATE.NEEDS_RECOVERY)
        invalid("terminal phase has a successor");
      if (
        boundary?.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY &&
        event.state === ACTION_OPERATION_STATE.NEEDS_RECOVERY
      )
        invalid("needs-recovery boundary is duplicated");
      boundary = event;
    } else if (boundary && boundary.state !== ACTION_OPERATION_STATE.NEEDS_RECOVERY) {
      invalid("terminal phase has a successor");
    }
  }
}

function assertPhaseStateClass(
  snapshot: ActionAuthoritySnapshotV1,
  event: ActionOperationEventV1,
  index: number,
): void {
  const phase = event.progress?.phase ?? "";
  if (isPublicOperationPhase(phase)) {
    if (
      isPublicOperationPhaseStateValid({
        actionType: snapshot.proposal.action.type,
        phase,
        phaseSequence: index,
        state: event.state,
      })
    )
      return;
    if (isPublicOperationStateDependentStatusPhase(phase))
      invalid("terminal-bound phase has an invalid operation state");
  }
  if (index === 0) {
    if (event.state !== ACTION_OPERATION_STATE.COMMITTING)
      invalid("operation phase zero is not committing");
    return;
  }
  const exactTerminal = terminalStateForPhase(phase);
  if (exactTerminal !== null) {
    if (event.state !== exactTerminal) invalid("terminal phase has an invalid operation state");
    return;
  }
  const boundTerminal =
    isCapabilityTargetPhase(phase) ||
    isPublicOperationStateDependentStatusPhase(phase) ||
    isPublicOperationParticipantTargetPhase(phase);
  if (boundTerminal) {
    if (!isActionOperationDomainTerminalState(event.state))
      invalid("terminal-bound phase has a nonterminal state");
  } else if (event.state !== ACTION_OPERATION_STATE.COMMITTING) {
    invalid("nonterminal phase must remain committing");
  }
}

function validateCapabilityBatches(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[],
): void {
  const proposalTargets = snapshot.proposal.target_set.map((row) => row.target_id);
  const rows = events.slice(1);
  const initialBoundaryIndex = rows.findIndex(isOperationBoundary);
  const initialTargetRows = initialBoundaryIndex < 0 ? rows : rows.slice(0, initialBoundaryIndex);
  assertOnlyTargets(initialTargetRows, "initial capability batch");
  assertInitialTargetOrder(initialTargetRows, proposalTargets);
  assertUniformBatch(initialTargetRows, "initial capability batch");
  if (initialBoundaryIndex < 0) {
    if (
      isActionOperationDomainTerminalState(snapshot.state) &&
      initialTargetRows.some((row) => row.state !== snapshot.state)
    )
      invalid("partial capability batch does not match its durable transition");
    const observedState = initialTargetRows[0]?.state;
    if (observedState)
      assertFinalTargetOutcomes(initialTargetRows, observedState, snapshot.proposal.target_set);
    return;
  }
  if (initialTargetRows.length !== proposalTargets.length)
    invalid("capability target coverage is incomplete at its state boundary");
  const initialBoundary = rows[initialBoundaryIndex];
  if (!initialBoundary) invalid("capability batch is missing its operation boundary");
  assertUniformBatch([...initialTargetRows, initialBoundary], "initial capability batch");
  if (!includesPhase(CAPABILITY_OPERATION_BOUNDARY_PHASES, initialBoundary.progress?.phase))
    invalid("capability batch has an invalid operation boundary");
  for (const row of initialTargetRows)
    if (row.state !== initialBoundary.state)
      invalid("capability target batch state differs from its boundary");

  const successors = rows.slice(initialBoundaryIndex + 1);
  if (initialBoundary.state !== ACTION_OPERATION_STATE.NEEDS_RECOVERY) {
    if (successors.length) invalid("terminal phase has a successor");
    if (snapshot.state !== initialBoundary.state)
      invalid("completed capability batch does not match action authority");
    assertFinalTargetOutcomes(
      initialTargetRows,
      initialBoundary.state,
      snapshot.proposal.target_set,
    );
    return;
  }
  const finalBoundaryIndex = successors.findIndex(isOperationBoundary);
  const corrections = finalBoundaryIndex < 0 ? successors : successors.slice(0, finalBoundaryIndex);
  assertOnlyTargets(corrections, "capability correction batch");
  assertCorrectionOrder(corrections, proposalTargets);
  assertUniformBatch(corrections, "capability correction batch");
  assertChangedCorrections(initialTargetRows, corrections);
  if (finalBoundaryIndex >= 0) {
    const finalBoundary = successors[finalBoundaryIndex];
    if (!finalBoundary) invalid("capability correction is missing its final boundary");
    if (!includesPhase(CAPABILITY_FINAL_BOUNDARY_PHASES, finalBoundary.progress?.phase))
      invalid("capability correction has an invalid final boundary");
    if (successors.length !== finalBoundaryIndex + 1) invalid("terminal phase has a successor");
    assertUniformBatch([...corrections, finalBoundary], "capability correction batch");
    for (const row of corrections)
      if (row.state !== finalBoundary.state)
        invalid("correction target state differs from its boundary");
    const folded = foldTargets(initialTargetRows, corrections);
    if (snapshot.state !== finalBoundary.state)
      invalid("completed correction batch does not match action authority");
    assertFinalTargetOutcomes(folded, finalBoundary.state, snapshot.proposal.target_set);
  } else if (corrections.length && corrections.some((row) => row.state !== snapshot.state)) {
    invalid("partial correction batch does not match its durable transition");
  }
}

function validateNonCapabilityClosure(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[],
): void {
  const action = snapshot.proposal.action.type;
  const receipt = RECEIPT_ACTIONS.has(action);
  if (receipt && events.length > 2)
    invalid("conversation receipt operation has more than one receipt phase");
  const last = events.at(-1);
  if (
    last &&
    isActionOperationDomainTerminalState(snapshot.state) &&
    !isDomainTerminalBoundary(last)
  )
    invalid("terminal action is missing its domain terminal boundary");
}

function assertInitialTargetOrder(
  rows: readonly ActionOperationEventV1[],
  expected: readonly string[],
): void {
  const observed = rows.map(targetId);
  if (new Set(observed).size !== observed.length) invalid("initial batch has a duplicate target");
  for (const [index, target] of observed.entries())
    if (target !== expected[index]) invalid("initial batch is not in canonical target order");
}

function assertCorrectionOrder(
  rows: readonly ActionOperationEventV1[],
  expected: readonly string[],
): void {
  const observed = rows.map(targetId);
  if (new Set(observed).size !== observed.length) invalid("duplicate correction target");
  let prior = -1;
  for (const target of observed) {
    const position = expected.indexOf(target);
    if (position < 0 || position <= prior)
      invalid("correction batch is not in canonical target order");
    prior = position;
  }
}

function assertOnlyTargets(rows: readonly ActionOperationEventV1[], label: string): void {
  if (rows.some((row) => row.target === null || !isCapabilityTargetPhase(row.progress?.phase)))
    invalid(`${label} contains a non-target phase`);
}

function assertFinalTargetOutcomes(
  rows: readonly ActionOperationEventV1[],
  state: ActionOperationState,
  proposalTargets: ActionAuthoritySnapshotV1["proposal"]["target_set"],
): void {
  const outcomes = rows.map((row) => row.target?.outcome);
  if (
    state === ACTION_OPERATION_STATE.SUCCEEDED &&
    outcomes.some(
      (outcome) =>
        outcome === PUBLIC_TARGET_RESULT_OUTCOME.FAILED ||
        outcome === PUBLIC_TARGET_RESULT_OUTCOME.BLOCKED ||
        outcome === PUBLIC_TARGET_RESULT_OUTCOME.NEEDS_RECOVERY,
    )
  )
    invalid("succeeded operation retains a failed target outcome");
  if (
    state === ACTION_OPERATION_STATE.SUCCEEDED &&
    rows.some(
      (row) =>
        row.target?.outcome === PUBLIC_TARGET_RESULT_OUTCOME.OMITTED &&
        proposalTargets.find((target) => target.target_id === row.target?.target_id)?.target
          .required === true,
    )
  )
    invalid("succeeded operation has an omitted required target");
  if (
    state === ACTION_OPERATION_STATE.FAILED &&
    outcomes.includes(PUBLIC_TARGET_RESULT_OUTCOME.NEEDS_RECOVERY)
  )
    invalid("failed operation retains a needs-recovery target outcome");
}

function assertUniformBatch(rows: readonly ActionOperationEventV1[], label: string): void {
  const first = rows[0];
  if (
    first &&
    rows.some((row) => row.state !== first.state || row.occurred_at !== first.occurred_at)
  )
    invalid(`${label} rows do not share the exact transition timestamp and state`);
}

function assertChangedCorrections(
  initial: readonly ActionOperationEventV1[],
  corrections: readonly ActionOperationEventV1[],
): void {
  const baseline = new Map(initial.map((row) => [targetId(row), row.target]));
  for (const row of corrections) {
    const prior = baseline.get(targetId(row));
    if (prior && canonicalJsonBytes(prior).equals(canonicalJsonBytes(row.target)))
      invalid("unchanged target correction must be suppressed");
  }
}

function foldTargets(
  initial: readonly ActionOperationEventV1[],
  corrections: readonly ActionOperationEventV1[],
): ActionOperationEventV1[] {
  const folded = new Map<string, ActionOperationEventV1>();
  for (const row of [...initial, ...corrections]) folded.set(targetId(row), row);
  return [...folded.values()];
}

function targetId(event: ActionOperationEventV1): string {
  const target = event.target;
  if (!target) invalid("target batch row has a null target");
  return target.target_id;
}

function isOperationBoundary(event: ActionOperationEventV1): boolean {
  return includesPhase(CAPABILITY_OPERATION_BOUNDARY_PHASES, event.progress?.phase);
}

function isDomainTerminalBoundary(event: ActionOperationEventV1): boolean {
  const phase = event.progress?.phase ?? "";
  return (
    terminalStateForPhase(phase) !== null ||
    (isActionOperationDomainTerminalState(event.state) &&
      (isPhaseFamily(phase, PUBLIC_OPERATION_PHASE_PREFIX.REVISION) ||
        isPublicOperationParticipantTargetPhase(phase)))
  );
}

function isCapabilityTargetPhase(value: unknown): value is PublicOperationPhaseV1 {
  return (
    isPublicOperationPhase(value) &&
    publicOperationTargetOutcomes(value) !== null &&
    !isPublicOperationParticipantTargetPhase(value)
  );
}

function isPhaseFamily(value: unknown, prefix: string): value is PublicOperationPhaseV1 {
  return isPublicOperationPhase(value) && value.startsWith(`${prefix}:`);
}

function includesPhase(
  phases: readonly PublicOperationPhaseV1[],
  value: unknown,
): value is PublicOperationPhaseV1 {
  return isPublicOperationPhase(value) && phases.some((phase) => phase === value);
}

function invalid(message: string): never {
  throw new Error(message);
}
