import { canonicalJsonBytes } from "../durability/index.js";
import { terminalStateForPhase } from "./operation-phase-rules.js";
import type { ActionOperationEventV1, PublicTargetResultV1 } from "./public-types.js";
import type { ActionAuthoritySnapshotV1, ActionOperationState } from "./types.js";

const TERMINAL = new Set<ActionOperationState>(["succeeded", "failed", "needs_recovery"]);
const AUTHORITY_ACTIONS = new Set([
  "grant.create",
  "grant.renew",
  "grant.revoke",
  "policy.update_authority",
  "secret.revoke",
  "registry.trust_key",
]);

export function validateOperationBatches(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[],
): void {
  if (!events.length) return;
  if (snapshot.proposal.action.type === "authority.repair") validateRepairProgression(events);
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
  let state: ActionOperationState = "committing";
  let terminalBoundary: ActionOperationEventV1 | null = null;
  for (const [index, event] of events.entries()) {
    assertPhaseStateClass(snapshot, event, index);
    if (index === 0) {
      if (event.state !== "committing") invalid("operation phase zero is not committing");
      continue;
    }
    if (event.state !== state) {
      const valid =
        (state === "committing" && TERMINAL.has(event.state)) ||
        (state === "needs_recovery" && ["succeeded", "failed"].includes(event.state));
      if (!valid) invalid(`illegal operation state transition ${state} to ${event.state}`);
      if (!isDomainTerminalBoundary(event) && !event.progress?.phase.startsWith("target-"))
        invalid("operation state changes outside a terminal batch");
      state = event.state;
    }
    if (isDomainTerminalBoundary(event)) {
      if (terminalBoundary && terminalBoundary.state !== "needs_recovery")
        invalid("terminal phase has a successor");
      if (terminalBoundary?.state === "needs_recovery" && event.state === "needs_recovery")
        invalid("needs-recovery boundary is duplicated");
      terminalBoundary = event;
    } else if (terminalBoundary && terminalBoundary.state !== "needs_recovery") {
      invalid("terminal phase has a successor");
    }
  }
}

const REPAIR_STATE = {
  prepared: "committing",
  preimage_fsynced: "committing",
  restore_in_progress: "committing",
  restored: "committing",
  verified: "succeeded",
  failed: "failed",
  needs_recovery: "needs_recovery",
} as const;
type RepairPhase = keyof typeof REPAIR_STATE;
function validateRepairProgression(events: readonly ActionOperationEventV1[]): void {
  let prior: RepairPhase | null = null;
  let anchor: Exclude<RepairPhase, "needs_recovery"> | null = null;
  for (const [index, event] of events.entries()) {
    if (index === 0) {
      if (event.state !== "committing" || event.progress?.phase !== "dispatch")
        invalid("repair phase zero is not its committing dispatch");
      continue;
    }
    const prefix = "authority-repair:";
    const phaseText = event.progress?.phase ?? "";
    if (!phaseText.startsWith(prefix)) invalid("repair operation contains a foreign phase");
    const phase = phaseText.slice(prefix.length) as RepairPhase;
    if (!(phase in REPAIR_STATE) || event.state !== REPAIR_STATE[phase])
      invalid("nonterminal phase must remain committing or match its repair terminal state");
    if (prior === null) {
      if (phase !== "prepared") invalid("repair event chain does not begin at prepared");
    } else if (prior === "needs_recovery") {
      if (
        phase !== "needs_recovery" &&
        phase !== "failed" &&
        (!anchor || !isRepairEdge(anchor, phase))
      )
        invalid("repair reconciliation does not resume the nearest anchor edge");
    } else if (!isRepairEdge(prior, phase)) {
      invalid(`illegal repair phase transition ${prior} to ${phase}`);
    }
    if (phase !== "needs_recovery") anchor = phase;
    prior = phase;
  }
}

function isRepairEdge(from: Exclude<RepairPhase, "needs_recovery">, to: RepairPhase): boolean {
  const edges: Record<Exclude<RepairPhase, "needs_recovery">, readonly RepairPhase[]> = {
    prepared: ["preimage_fsynced", "failed", "needs_recovery"],
    preimage_fsynced: ["restore_in_progress", "failed", "needs_recovery"],
    restore_in_progress: ["restored", "failed", "needs_recovery"],
    restored: ["verified", "needs_recovery"],
    verified: [],
    failed: [],
  };
  return edges[from].some((candidate) => candidate === to);
}

function assertPhaseStateClass(
  snapshot: ActionAuthoritySnapshotV1,
  event: ActionOperationEventV1,
  index: number,
): void {
  const phase = event.progress?.phase ?? "";
  if (index === 0) {
    if (event.state !== "committing") invalid("operation phase zero is not committing");
    return;
  }
  const exactTerminal = terminalStateForPhase(phase as never);
  if (exactTerminal !== null) {
    if (event.state !== exactTerminal) invalid("terminal phase has an invalid operation state");
    return;
  }
  const boundTerminal =
    phase.startsWith("target-") ||
    /^revision:(?:started|start_failed|needs_recovery|abandoned)$/.test(phase) ||
    /^participant-start:(?:accepted|failed|canceled|uncertain)$/.test(phase);
  if (boundTerminal) {
    if (!TERMINAL.has(event.state)) invalid("terminal-bound phase has a nonterminal state");
  } else if (
    snapshot.proposal.action.type === "conversation.reconcile_revision_operation" &&
    phase.startsWith("revision:") &&
    event.state === "succeeded"
  ) {
    // A proved transition out of revision recovery terminalizes its reconcile authorizer.
  } else if (event.state !== "committing") {
    invalid("nonterminal phase must remain committing");
  }
}

function validateAuthorityChangeProgression(
  snapshot: ActionAuthoritySnapshotV1,
  events: readonly ActionOperationEventV1[],
): void {
  const expected =
    snapshot.proposal.action.type === "policy.update_authority"
      ? [
          "authority-change:prepared",
          "authority-change:effect_in_progress",
          "authority-change:observed",
        ]
      : ["authority-change:observed"];
  let position = 0;
  for (const event of events.slice(1)) {
    const phase = event.progress?.phase ?? "";
    if (/^authority-change:(?:prepared|effect_in_progress|observed)$/.test(phase)) {
      if (phase !== expected[position])
        invalid("authority change nonterminal phases are not in their exact durable order");
      position += 1;
      continue;
    }
    if (phase === "authority-change:epoch-committed" && position !== expected.length)
      invalid("authority epoch committed before its exact staged phase closure");
    if (!/^authority-change:(?:epoch-committed|failed|needs-recovery)$/.test(phase))
      invalid("authority change operation contains a foreign phase");
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
      TERMINAL.has(snapshot.state) &&
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
  const initialBoundary = rows[initialBoundaryIndex] as ActionOperationEventV1;
  assertUniformBatch([...initialTargetRows, initialBoundary], "initial capability batch");
  if (
    !/^operation-(?:succeeded|failed|needs-recovery)$/.test(initialBoundary.progress?.phase ?? "")
  )
    invalid("capability batch has an invalid operation boundary");
  for (const row of initialTargetRows)
    if (row.state !== initialBoundary.state)
      invalid("capability target batch state differs from its boundary");

  const successors = rows.slice(initialBoundaryIndex + 1);
  if (initialBoundary.state !== "needs_recovery") {
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
    const finalBoundary = successors[finalBoundaryIndex] as ActionOperationEventV1;
    if (!/^operation-(?:succeeded|failed)$/.test(finalBoundary.progress?.phase ?? ""))
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
  const receipt = new Set([
    "conversation.select_lineage_head",
    "conversation.associate_lineages",
    "conversation.publish_suspected_literal",
    "conversation.stop_operation",
    "context.compact",
  ]).has(action);
  if (receipt && events.length > 2)
    invalid("conversation receipt operation has more than one receipt phase");
  const last = events.at(-1);
  if (last && TERMINAL.has(snapshot.state) && !isDomainTerminalBoundary(last))
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
  if (rows.some((row) => row.target === null || !row.progress?.phase.startsWith("target-")))
    invalid(`${label} contains a non-target phase`);
}

function assertFinalTargetOutcomes(
  rows: readonly ActionOperationEventV1[],
  state: ActionOperationState,
  proposalTargets: ActionAuthoritySnapshotV1["proposal"]["target_set"],
): void {
  const outcomes = rows.map((row) => row.target?.outcome);
  if (
    state === "succeeded" &&
    outcomes.some((outcome) => ["failed", "blocked", "needs-recovery"].includes(outcome ?? ""))
  )
    invalid("succeeded operation retains a failed target outcome");
  if (
    state === "succeeded" &&
    rows.some(
      (row) =>
        row.target?.outcome === "omitted" &&
        proposalTargets.find((target) => target.target_id === row.target?.target_id)?.target
          .required === true,
    )
  )
    invalid("succeeded operation has an omitted required target");
  if (state === "failed" && outcomes.includes("needs-recovery"))
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
  const target = event.target as PublicTargetResultV1 | null;
  if (!target) invalid("target batch row has a null target");
  return target.target_id;
}

function isOperationBoundary(event: ActionOperationEventV1): boolean {
  return /^operation-(?:succeeded|failed|needs-recovery)$/.test(event.progress?.phase ?? "");
}

function isDomainTerminalBoundary(event: ActionOperationEventV1): boolean {
  const phase = event.progress?.phase ?? "";
  return (
    terminalStateForPhase(phase as never) !== null ||
    (TERMINAL.has(event.state) &&
      (/^revision:/.test(phase) ||
        /^participant-start:(?:accepted|failed|canceled|uncertain)$/.test(phase)))
  );
}

function invalid(message: string): never {
  throw new Error(message);
}
