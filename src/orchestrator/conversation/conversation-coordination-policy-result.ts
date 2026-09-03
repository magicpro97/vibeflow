import { CONVERSATION_COMMAND_RESULT_STATUS } from "./conversation-command-result-contract.js";
import {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_PHASE,
  CONVERSATION_COORDINATION_SCHEMA_VERSION,
  CONVERSATION_COORDINATION_SETTLEMENT,
  CONVERSATION_COORDINATION_TERMINAL_OUTCOME,
} from "./conversation-coordination-contract.js";
import type { ConversationCoordinationStateV1 } from "./conversation-coordination-fold.js";
import {
  appendConversationCoordinationRecord,
  reconcilePendingConversationCoordinationRecord,
} from "./conversation-coordination-journal.js";
import { coordinationWorkspaceKey } from "./conversation-coordination-policy-helpers.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import type { ConversationContext, ConversationOrchestrationResult } from "./types.js";

const artifactRefs = (
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
): string[] => [
  ...new Set(
    state.committed_records
      .filter(({ record }) => record.revision_id === context.correlation.revision_id)
      .map(({ artifact_ref: artifactRef }) => artifactRef),
  ),
];

export const coordinationPolicyResult = (
  context: ConversationContext,
  status: ConversationOrchestrationResult["status"],
  state: ConversationCoordinationStateV1,
): ConversationOrchestrationResult => ({
  operation_id: context.correlation.operation_id,
  status,
  artifact_refs: artifactRefs(context, state),
});

export async function settleCoordinationWorkspace(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
  outcome: Parameters<ConversationContext["settleWorkspace"]>[1],
): Promise<void> {
  try {
    await context.settleWorkspace(coordinationWorkspaceKey(context, state), outcome);
  } catch {
    if (outcome === CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED)
      throw new Error("workspace settlement failed");
  }
}

async function publishCoordinationError(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
  code: string,
): Promise<void> {
  try {
    await context.emit({
      idempotency_key: `coordination:${context.correlation.operation_id}:step:${state.committed_records.length}:${code}`,
      event: {
        type: CONVERSATION_TRACE_EVENT_KIND.ERROR,
        payload: { agent_id: null, code, message: "coordination could not continue safely" },
      },
    });
  } catch {
    // The result still fails closed when diagnostic publication is unavailable.
  }
}

export async function failCoordinationPolicy(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
  code: string,
  aborted = context.signal.aborted,
): Promise<ConversationOrchestrationResult> {
  await publishCoordinationError(context, state, code);
  let closed = state;
  if (
    state.phase !== CONVERSATION_COORDINATION_PHASE.COMPLETED &&
    state.phase !== CONVERSATION_COORDINATION_PHASE.TERMINATED
  ) {
    try {
      closed = await appendConversationCoordinationRecord({
        context,
        state,
        actor_participant_id: context.participantIds[0] ?? "host",
        actor_lane: CONVERSATION_COORDINATION_LANE.HOST,
        directive: {
          schema_version: CONVERSATION_COORDINATION_SCHEMA_VERSION,
          kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.TERMINATE_EPOCH,
          termination: {
            outcome: aborted
              ? CONVERSATION_COORDINATION_TERMINAL_OUTCOME.ABORTED
              : CONVERSATION_COORDINATION_TERMINAL_OUTCOME.FAILED,
            reason_code: code,
          },
        },
      });
    } catch {
      // The original failure remains authoritative when terminal journaling is unavailable.
    }
  }
  await settleCoordinationWorkspace(context, closed, CONVERSATION_COORDINATION_SETTLEMENT.FAILED);
  return coordinationPolicyResult(
    context,
    aborted
      ? CONVERSATION_COMMAND_RESULT_STATUS.ABORTED
      : CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
    closed,
  );
}

export async function recoverCoordinationPolicyFailure(
  context: ConversationContext,
): Promise<ConversationOrchestrationResult> {
  const observed = await context.coordinationState().catch(() => null);
  if (!observed)
    return {
      operation_id: context.correlation.operation_id,
      status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
      artifact_refs: [],
    };
  let recovered: ConversationCoordinationStateV1;
  try {
    recovered = await reconcilePendingConversationCoordinationRecord(context, observed);
  } catch {
    await publishCoordinationError(context, observed, "coordination_runtime_failure");
    await settleCoordinationWorkspace(
      context,
      observed,
      CONVERSATION_COORDINATION_SETTLEMENT.FAILED,
    );
    return coordinationPolicyResult(
      context,
      context.signal.aborted
        ? CONVERSATION_COMMAND_RESULT_STATUS.ABORTED
        : CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
      observed,
    );
  }
  return failCoordinationPolicy(context, recovered, "coordination_runtime_failure");
}
