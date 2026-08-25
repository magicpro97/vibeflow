import type { RevisionOperationV1 } from "./lineage-revision-operation.js";
import type {
  RevisionActionTerminalBindingV1,
  RevisionOperationPayloadV1,
  RevisionOperationStateV1,
} from "./revision-planner.js";

const OPERATION = /^vf-operation-[0-9a-f]{64}$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;

function sameTerminals(
  actual: readonly RevisionActionTerminalBindingV1[],
  expected: readonly RevisionActionTerminalBindingV1[],
): boolean {
  return (
    JSON.stringify(actual) ===
    JSON.stringify(
      [...expected].sort((left, right) =>
        Buffer.compare(
          Buffer.from(left.action_operation_id),
          Buffer.from(right.action_operation_id),
        ),
      ),
    )
  );
}

function assertTerminalShape(terminals: readonly RevisionActionTerminalBindingV1[]): void {
  let prior = "";
  for (const terminal of terminals) {
    if (
      !OPERATION.test(terminal.action_operation_id) ||
      !["succeeded", "failed", "needs_recovery"].includes(terminal.outcome) ||
      (terminal.outcome === "succeeded") !== (terminal.reason_code === null) ||
      (terminal.reason_code !== null && !/^[a-z][a-z0-9_~-]{0,127}$/.test(terminal.reason_code)) ||
      (prior && Buffer.compare(Buffer.from(prior), Buffer.from(terminal.action_operation_id)) >= 0)
    )
      throw new Error("invalid revision action terminal bindings");
    prior = terminal.action_operation_id;
  }
}

function terminal(
  operationId: string,
  outcome: RevisionActionTerminalBindingV1["outcome"],
  reason: string | null,
): RevisionActionTerminalBindingV1 {
  return { action_operation_id: operationId, outcome, reason_code: reason };
}

function assertOrdinaryTransition(
  payload: Extract<RevisionOperationPayloadV1, { kind: "state-transition" }>,
  activeEffect: string,
): string {
  const { authorized_by_action_operation_id: authorizer, effect_action_operation_id: effect } =
    payload;
  if (!OPERATION.test(authorizer) || !OPERATION.test(effect))
    throw new Error("invalid revision transition action authority identity");
  if (payload.from === "start_failed" && payload.to === "starting") {
    if (
      authorizer !== effect ||
      effect === activeEffect ||
      payload.action_terminals.length !== 0 ||
      payload.reason_code !== null
    )
      throw new Error("invalid revision retry transition authority");
    return effect;
  }
  if (payload.to === "abandoned") {
    const controlled = authorizer !== activeEffect;
    const expected = controlled
      ? [
          terminal(activeEffect, "failed", payload.reason_code),
          terminal(authorizer, "succeeded", null),
        ]
      : [terminal(activeEffect, "failed", payload.reason_code)];
    if (
      effect !== activeEffect ||
      payload.reason_code === null ||
      !sameTerminals(payload.action_terminals, expected)
    )
      throw new Error("invalid revision abandon terminal authority");
    return activeEffect;
  }
  if (authorizer !== activeEffect || effect !== activeEffect)
    throw new Error("ordinary revision work has mismatched authorizer and effect");
  let expected: RevisionActionTerminalBindingV1[] = [];
  if (payload.to === "started") expected = [terminal(activeEffect, "succeeded", null)];
  else if (payload.to === "start_failed")
    expected = [terminal(activeEffect, "failed", payload.reason_code)];
  else if (payload.to === "needs_recovery")
    expected = [terminal(activeEffect, "needs_recovery", payload.reason_code)];
  if (
    (expected.length === 0 && payload.reason_code !== null) ||
    (expected.length > 0 && payload.to !== "started" && payload.reason_code === null) ||
    !sameTerminals(payload.action_terminals, expected)
  )
    throw new Error("invalid revision transition terminal cardinality");
  return activeEffect;
}

export function validateRevisionTransitionAuthority(
  payload: Extract<RevisionOperationPayloadV1, { kind: "state-transition" }>,
  activeEffect: string,
): string {
  assertTerminalShape(payload.action_terminals);
  if (payload.from !== "needs_recovery") return assertOrdinaryTransition(payload, activeEffect);
  const authorizer = payload.authorized_by_action_operation_id;
  if (
    !OPERATION.test(authorizer) ||
    authorizer === activeEffect ||
    payload.effect_action_operation_id !== activeEffect
  )
    throw new Error("invalid revision recovery transition authority");
  // The suspended effect was already terminally mirrored as needs_recovery.
  // Recovery closes only the reviewed control action; terminal authority is append-once.
  const expected = [terminal(authorizer, "succeeded", null)];
  if (
    ((payload.to === "start_failed" || payload.to === "abandoned") &&
      payload.reason_code === null) ||
    (!["start_failed", "abandoned"].includes(payload.to) && payload.reason_code !== null) ||
    !sameTerminals(payload.action_terminals, expected)
  )
    throw new Error("invalid revision recovery terminal cardinality");
  return activeEffect;
}

export function validateRevisionAuxiliaryAuthority(
  operation: RevisionOperationV1,
  payload: Exclude<RevisionOperationPayloadV1, { kind: "state-transition" }>,
  state: RevisionOperationStateV1 | "created",
  activeEffect: string,
  prefixDigest: string,
): void {
  if (
    !OPERATION.test(payload.authorized_by_action_operation_id) ||
    payload.effect_action_operation_id !== activeEffect
  )
    throw new Error("invalid revision auxiliary action authority");
  if (payload.kind === "reconciliation-result") {
    assertTerminalShape(payload.action_terminals);
    if (
      state !== "needs_recovery" ||
      payload.authorized_by_action_operation_id === activeEffect ||
      payload.outcome !== "failed" ||
      payload.observed_state_digest !== prefixDigest ||
      !payload.reason_code ||
      !sameTerminals(payload.action_terminals, [
        terminal(payload.authorized_by_action_operation_id, "failed", payload.reason_code),
      ])
    )
      throw new Error("invalid revision reconciliation result authority");
    return;
  }
  if (payload.kind === "head-commit") {
    if (
      state !== "prepared" ||
      payload.authorized_by_action_operation_id !== activeEffect ||
      payload.prior_head_digest !== operation.expected_head_digest ||
      payload.prior_head_checkpoint_digest !== payload.prior_head_digest ||
      !DIGEST.test(payload.committed_head_digest) ||
      payload.directory_fsync_completed !== true
    )
      throw new Error("invalid revision head commit authority");
    return;
  }
  if (state !== "starting" || payload.authorized_by_action_operation_id !== activeEffect)
    throw new Error("revision participant event is out of order or unauthorized");
}
