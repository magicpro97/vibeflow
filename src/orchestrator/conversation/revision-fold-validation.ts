import {
  ACTION_OPERATION_DOMAIN_TERMINAL_STATES,
  ACTION_OPERATION_STATE,
  PUBLIC_OPERATION_REVISION_PHASE,
} from "../../actions/protocol-contract.js";
import type { RevisionOperationV1 } from "./lineage-revision-operation.js";
import {
  REVISION_OPERATION_EVENT_PAYLOAD_KIND,
  type REVISION_OPERATION_INITIAL_PHASE,
} from "./revision-operation-event-contract.js";
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
      !ACTION_OPERATION_DOMAIN_TERMINAL_STATES.some(
        (candidate) => candidate === terminal.outcome,
      ) ||
      (terminal.outcome === ACTION_OPERATION_STATE.SUCCEEDED) !== (terminal.reason_code === null) ||
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
  payload: Extract<
    RevisionOperationPayloadV1,
    { kind: typeof REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION }
  >,
  activeEffect: string,
): string {
  const { authorized_by_action_operation_id: authorizer, effect_action_operation_id: effect } =
    payload;
  if (!OPERATION.test(authorizer) || !OPERATION.test(effect))
    throw new Error("invalid revision transition action authority identity");
  if (
    payload.from === PUBLIC_OPERATION_REVISION_PHASE.START_FAILED &&
    payload.to === PUBLIC_OPERATION_REVISION_PHASE.STARTING
  ) {
    if (
      authorizer !== effect ||
      effect === activeEffect ||
      payload.action_terminals.length !== 0 ||
      payload.reason_code !== null
    )
      throw new Error("invalid revision retry transition authority");
    return effect;
  }
  if (payload.to === PUBLIC_OPERATION_REVISION_PHASE.ABANDONED) {
    const controlled = authorizer !== activeEffect;
    const expected = controlled
      ? [
          terminal(activeEffect, ACTION_OPERATION_STATE.FAILED, payload.reason_code),
          terminal(authorizer, ACTION_OPERATION_STATE.SUCCEEDED, null),
        ]
      : [terminal(activeEffect, ACTION_OPERATION_STATE.FAILED, payload.reason_code)];
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
  if (payload.to === PUBLIC_OPERATION_REVISION_PHASE.STARTED)
    expected = [terminal(activeEffect, ACTION_OPERATION_STATE.SUCCEEDED, null)];
  else if (payload.to === PUBLIC_OPERATION_REVISION_PHASE.START_FAILED)
    expected = [terminal(activeEffect, ACTION_OPERATION_STATE.FAILED, payload.reason_code)];
  else if (payload.to === PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY)
    expected = [terminal(activeEffect, ACTION_OPERATION_STATE.NEEDS_RECOVERY, payload.reason_code)];
  if (
    (expected.length === 0 && payload.reason_code !== null) ||
    (expected.length > 0 &&
      payload.to !== PUBLIC_OPERATION_REVISION_PHASE.STARTED &&
      payload.reason_code === null) ||
    !sameTerminals(payload.action_terminals, expected)
  )
    throw new Error("invalid revision transition terminal cardinality");
  return activeEffect;
}

export function validateRevisionTransitionAuthority(
  payload: Extract<
    RevisionOperationPayloadV1,
    { kind: typeof REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION }
  >,
  activeEffect: string,
): string {
  assertTerminalShape(payload.action_terminals);
  if (payload.from !== PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY)
    return assertOrdinaryTransition(payload, activeEffect);
  const authorizer = payload.authorized_by_action_operation_id;
  if (
    !OPERATION.test(authorizer) ||
    authorizer === activeEffect ||
    payload.effect_action_operation_id !== activeEffect
  )
    throw new Error("invalid revision recovery transition authority");
  // The suspended effect was already terminally mirrored as needs_recovery.
  // Recovery closes only the reviewed control action; terminal authority is append-once.
  const expected = [terminal(authorizer, ACTION_OPERATION_STATE.SUCCEEDED, null)];
  if (
    ((payload.to === PUBLIC_OPERATION_REVISION_PHASE.START_FAILED ||
      payload.to === PUBLIC_OPERATION_REVISION_PHASE.ABANDONED) &&
      payload.reason_code === null) ||
    (payload.to !== PUBLIC_OPERATION_REVISION_PHASE.START_FAILED &&
      payload.to !== PUBLIC_OPERATION_REVISION_PHASE.ABANDONED &&
      payload.reason_code !== null) ||
    !sameTerminals(payload.action_terminals, expected)
  )
    throw new Error("invalid revision recovery terminal cardinality");
  return activeEffect;
}

export function validateRevisionAuxiliaryAuthority(
  operation: RevisionOperationV1,
  payload: Exclude<
    RevisionOperationPayloadV1,
    { kind: typeof REVISION_OPERATION_EVENT_PAYLOAD_KIND.STATE_TRANSITION }
  >,
  state: RevisionOperationStateV1 | typeof REVISION_OPERATION_INITIAL_PHASE.CREATED,
  activeEffect: string,
  prefixDigest: string,
): void {
  if (
    !OPERATION.test(payload.authorized_by_action_operation_id) ||
    payload.effect_action_operation_id !== activeEffect
  )
    throw new Error("invalid revision auxiliary action authority");
  if (payload.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.RECONCILIATION_RESULT) {
    assertTerminalShape(payload.action_terminals);
    if (
      state !== PUBLIC_OPERATION_REVISION_PHASE.NEEDS_RECOVERY ||
      payload.authorized_by_action_operation_id === activeEffect ||
      payload.outcome !== ACTION_OPERATION_STATE.FAILED ||
      payload.observed_state_digest !== prefixDigest ||
      !payload.reason_code ||
      !sameTerminals(payload.action_terminals, [
        terminal(
          payload.authorized_by_action_operation_id,
          ACTION_OPERATION_STATE.FAILED,
          payload.reason_code,
        ),
      ])
    )
      throw new Error("invalid revision reconciliation result authority");
    return;
  }
  if (payload.kind === REVISION_OPERATION_EVENT_PAYLOAD_KIND.HEAD_COMMIT) {
    if (
      state !== PUBLIC_OPERATION_REVISION_PHASE.PREPARED ||
      payload.authorized_by_action_operation_id !== activeEffect ||
      payload.prior_head_digest !== operation.expected_head_digest ||
      payload.prior_head_checkpoint_digest !== payload.prior_head_digest ||
      !DIGEST.test(payload.committed_head_digest) ||
      payload.directory_fsync_completed !== true
    )
      throw new Error("invalid revision head commit authority");
    return;
  }
  if (
    state !== PUBLIC_OPERATION_REVISION_PHASE.STARTING ||
    payload.authorized_by_action_operation_id !== activeEffect
  )
    throw new Error("revision participant event is out of order or unauthorized");
}
