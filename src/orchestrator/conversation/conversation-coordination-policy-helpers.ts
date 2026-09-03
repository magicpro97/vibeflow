import {
  CONVERSATION_COORDINATION_CORRECTION_CODE,
  CONVERSATION_COORDINATION_DIAGNOSTIC,
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_PHASE,
  CONVERSATION_COORDINATION_RESOLUTION_SOURCE,
  type ConversationCoordinationDirectiveKindV1,
  conversationCoordinationEpochId,
  conversationCoordinationTopicMessageRef,
  conversationCoordinationWorkspaceKey,
} from "./conversation-coordination-contract.js";
import type { ConversationCoordinationStateV1 } from "./conversation-coordination-fold.js";
import type { ConversationCoordinationDirectiveV1 } from "./conversation-coordination-records.js";
import {
  delegationCitesCurrentUserDecision,
  referencesBelongToTurn,
  resolutionSourceVerified,
} from "./conversation-coordination-source-authority.js";
import {
  CONVERSATION_DELEGATION_TASK_DIAGNOSTIC,
  conversationDelegationOracleInvocation,
} from "./conversation-delegation-workspace-contract.js";
import { isCanonicalDelegationPath } from "./conversation-delegation-workspace-task.js";
import { CONVERSATION_TURN_INSTRUCTION_KIND } from "./turn-delivery-contract.js";
import type {
  ConversationCoordinationTurnCorrectionV1,
  ConversationTurnInstructionV1,
  PreparedConversationTurnV1,
} from "./turn-delivery-types.js";
import type { ConversationContext, DryRunResult } from "./types.js";

export interface ConversationCoordinationTurnPlanV1 {
  participant_id: string;
  binding_index: number;
  lane:
    | typeof CONVERSATION_COORDINATION_LANE.COORDINATOR
    | typeof CONVERSATION_COORDINATION_LANE.EXECUTOR;
  allowed_kinds: readonly ConversationCoordinationDirectiveKindV1[];
  instruction: ConversationTurnInstructionV1;
}

export function coordinationWorkspaceKey(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
): string {
  return conversationCoordinationWorkspaceKey(
    state.epoch_id ?? conversationCoordinationEpochId(context.correlation),
  );
}

const COORDINATOR_RESOLUTION_KINDS = Object.freeze([
  CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION,
  CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT,
] as const);
const EXECUTOR_KINDS = Object.freeze([
  CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION,
  CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK,
  CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED,
] as const);
const COORDINATOR_COMPLETION_REVIEW_KINDS = Object.freeze([
  CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
  CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE,
] as const);
const COORDINATOR_REDELEGATION_KINDS = Object.freeze([
  CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK,
] as const);
const COORDINATOR_UNRECOVERABLE_REVIEW_KINDS = Object.freeze([
  CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT,
] as const);

function coordinatorReviewKinds(
  state: ConversationCoordinationStateV1,
): readonly ConversationCoordinationDirectiveKindV1[] | null {
  if (state.last_completion) return COORDINATOR_COMPLETION_REVIEW_KINDS;
  if (!state.last_blocked) return null;
  if (state.last_blocked.recoverable || state.last_escalation)
    return COORDINATOR_REDELEGATION_KINDS;
  return COORDINATOR_UNRECOVERABLE_REVIEW_KINDS;
}

export function coordinationDryRun(context: ConversationContext): DryRunResult {
  return {
    participants: context.bindings.flatMap((binding, index) => {
      const participantId = context.participantIds[index];
      const readiness = context.bindingReadiness[index];
      return participantId
        ? [
            {
              participant_id: participantId,
              role_ref: binding.role.spec.name,
              engine: binding.engine,
              model: binding.model,
              engine_available: readiness?.engine_available ?? false,
              model_valid: readiness?.model_valid ?? false,
            },
          ]
        : [];
    }),
    evaluator_auto_added: context.evaluatorAutoAdded,
    engines_available: [
      ...new Set(
        context.bindings.flatMap((binding, index) =>
          context.bindingReadiness[index]?.engine_available ? [binding.engine] : [],
        ),
      ),
    ],
    models_valid:
      context.bindings.length >= 2 &&
      context.bindings.every((_binding, index) => context.bindingReadiness[index]?.model_valid),
  };
}

function escalationRevision(state: ConversationCoordinationStateV1): string | null {
  for (let index = state.committed_records.length - 1; index >= 0; index -= 1) {
    const record = state.committed_records[index]?.record;
    if (record?.directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT)
      return record.revision_id;
  }
  return null;
}

export function coordinationAwaitsUserInCurrentRevision(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
): boolean {
  return (
    state.phase === CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT &&
    escalationRevision(state) === context.correlation.revision_id
  );
}

export function planConversationCoordinationTurn(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
): ConversationCoordinationTurnPlanV1 | null {
  const coordinatorId = context.participantIds[0];
  if (!coordinatorId) return null;
  if (state.phase === CONVERSATION_COORDINATION_PHASE.COORDINATOR_PLANNING) {
    return {
      participant_id: coordinatorId,
      binding_index: 0,
      lane: CONVERSATION_COORDINATION_LANE.COORDINATOR,
      allowed_kinds: [CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK],
      instruction: {
        kind: CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_PLAN,
        topic: context.topic,
        topic_message_ref: conversationCoordinationTopicMessageRef({
          workflow_id: context.correlation.workflow_id,
          conversation_id: context.correlation.conversation_id,
          revision_id: context.correlation.revision_id,
          topic: context.topic,
        }),
        executor_participant_ids: [...context.participantIds.slice(1)],
      },
    };
  }
  if (state.phase === CONVERSATION_COORDINATION_PHASE.EXECUTOR_RUNNING && state.active_task) {
    const executorIndex = context.participantIds.indexOf(state.active_task.executor_participant_id);
    if (executorIndex < 1) return null;
    return {
      participant_id: state.active_task.executor_participant_id,
      binding_index: executorIndex,
      lane: CONVERSATION_COORDINATION_LANE.EXECUTOR,
      allowed_kinds: EXECUTOR_KINDS,
      instruction: state.last_resolution
        ? {
            kind: CONVERSATION_TURN_INSTRUCTION_KIND.EXECUTOR_RESOLUTION,
            task: structuredClone(state.active_task),
            resolution: structuredClone(state.last_resolution),
          }
        : {
            kind: CONVERSATION_TURN_INSTRUCTION_KIND.EXECUTOR_TASK,
            task: structuredClone(state.active_task),
          },
    };
  }
  if (
    (state.phase === CONVERSATION_COORDINATION_PHASE.COORDINATOR_RESOLVING ||
      state.phase === CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT) &&
    state.active_task &&
    state.last_clarification
  ) {
    return {
      participant_id: coordinatorId,
      binding_index: 0,
      lane: CONVERSATION_COORDINATION_LANE.COORDINATOR,
      allowed_kinds: COORDINATOR_RESOLUTION_KINDS,
      instruction: {
        kind: CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_CLARIFICATION,
        task: structuredClone(state.active_task),
        clarification: structuredClone(state.last_clarification),
        user_escalation: state.last_escalation ? structuredClone(state.last_escalation) : null,
      },
    };
  }
  const reviewPhase =
    state.phase === CONVERSATION_COORDINATION_PHASE.COORDINATOR_REVIEWING ||
    (state.phase === CONVERSATION_COORDINATION_PHASE.NEEDS_INPUT &&
      state.last_blocked?.recoverable === false &&
      state.last_escalation !== null);
  if (reviewPhase && state.active_task) {
    const allowed = coordinatorReviewKinds(state);
    if (!allowed) return null;
    return {
      participant_id: coordinatorId,
      binding_index: 0,
      lane: CONVERSATION_COORDINATION_LANE.COORDINATOR,
      allowed_kinds: allowed,
      instruction: {
        kind: CONVERSATION_TURN_INSTRUCTION_KIND.COORDINATOR_REVIEW,
        task: structuredClone(state.active_task),
        completion: state.last_completion ? structuredClone(state.last_completion) : null,
        blocked: state.last_blocked ? structuredClone(state.last_blocked) : null,
        user_escalation: state.last_escalation ? structuredClone(state.last_escalation) : null,
        allowed_directives: [...allowed],
        completed_task_ids: [...state.completed_task_ids],
        workspace: state.last_completion
          ? structuredClone(context.observeWorkspace(coordinationWorkspaceKey(context, state)))
          : null,
      },
    };
  }
  return null;
}

export function correctedCoordinationInstruction(
  instruction: ConversationTurnInstructionV1,
  diagnosticCode: string,
  allowedKinds: readonly ConversationCoordinationDirectiveKindV1[],
): ConversationTurnInstructionV1 {
  const correction: ConversationCoordinationTurnCorrectionV1 = {
    code: CONVERSATION_COORDINATION_CORRECTION_CODE,
    diagnostic_code: diagnosticCode,
    correction_attempt: 1,
    allowed_directives: [...allowedKinds],
  };
  if (
    instruction.kind === CONVERSATION_TURN_INSTRUCTION_KIND.DIRECT ||
    instruction.kind === CONVERSATION_TURN_INSTRUCTION_KIND.DEBATE_PARTICIPANT
  )
    throw new Error("non-coordination instruction cannot be corrected");
  return { ...structuredClone(instruction), correction };
}

export async function validateCoordinationDirectiveForTurn(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
  plan: ConversationCoordinationTurnPlanV1,
  directive: ConversationCoordinationDirectiveV1,
  delivery: PreparedConversationTurnV1,
): Promise<string | null> {
  if (!plan.allowed_kinds.some((kind) => kind === directive.kind))
    return "coordination_directive_not_allowed";
  if (directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK) {
    if (
      directive.task.verify_oracles.some(
        (oracle) => conversationDelegationOracleInvocation(oracle) === null,
      )
    )
      return CONVERSATION_DELEGATION_TASK_DIAGNOSTIC.VERIFY_ORACLE_UNSUPPORTED;
    if (!directive.task.scope.every((selector) => isCanonicalDelegationPath(selector, true)))
      return CONVERSATION_DELEGATION_TASK_DIAGNOSTIC.SCOPE_SELECTOR_INVALID;
    if (!directive.task.forbidden.every((selector) => isCanonicalDelegationPath(selector, true)))
      return CONVERSATION_DELEGATION_TASK_DIAGNOSTIC.FORBIDDEN_SELECTOR_INVALID;
    if (
      !context.participantIds.slice(1).some((id) => id === directive.task.executor_participant_id)
    )
      return "coordination_executor_not_bound";
    if (
      state.committed_records.some(
        ({ record }) =>
          record.directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.DELEGATE_TASK &&
          record.directive.task.task_id === directive.task.task_id,
      )
    )
      return "coordination_task_id_reused";
    if (!referencesBelongToTurn(directive.task.source_message_refs, delivery))
      return "coordination_task_source_unverified";
    if (!delegationCitesCurrentUserDecision(state, directive.task.source_message_refs, delivery))
      return CONVERSATION_COORDINATION_DIAGNOSTIC.USER_DECISION_SOURCE_UNVERIFIED;
  }
  const activeTaskId = state.active_task?.task_id;
  if (
    (directive.kind ===
      CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_COORDINATOR_CLARIFICATION &&
      directive.clarification.task_id !== activeTaskId) ||
    (directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK &&
      directive.completion.task_id !== activeTaskId) ||
    (directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REPORT_BLOCKED &&
      directive.blocked.task_id !== activeTaskId)
  )
    return "coordination_executor_task_mismatch";
  if (directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.COMPLETE_TASK) {
    const workspaceKey = coordinationWorkspaceKey(context, state);
    try {
      const workspace = context.observeWorkspace(workspaceKey);
      if (
        workspace.workspace_key !== workspaceKey ||
        !workspace.branch_ref ||
        !workspace.head ||
        workspace.dirty ||
        !workspace.quiescent
      )
        return CONVERSATION_COORDINATION_DIAGNOSTIC.WORKSPACE_REQUIRES_CLEAN_COMMIT;
    } catch {
      return CONVERSATION_COORDINATION_DIAGNOSTIC.WORKSPACE_REQUIRES_CLEAN_COMMIT;
    }
    try {
      const verified = await context.verifyWorkspace(workspaceKey, directive.completion);
      if (
        verified.workspace_key !== workspaceKey ||
        !verified.branch_ref ||
        !verified.head ||
        !verified.verified_head ||
        verified.head !== verified.verified_head ||
        verified.dirty ||
        !verified.quiescent
      )
        return CONVERSATION_COORDINATION_DIAGNOSTIC.WORKSPACE_VERIFICATION_FAILED;
    } catch {
      return CONVERSATION_COORDINATION_DIAGNOSTIC.WORKSPACE_VERIFICATION_FAILED;
    }
  }
  if (
    directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION &&
    (directive.resolution.task_id !== activeTaskId ||
      directive.resolution.question_id !== state.last_clarification?.question_id)
  )
    return "coordination_resolution_mismatch";
  if (
    directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.RESOLVE_CLARIFICATION &&
    !resolutionSourceVerified(context, state, delivery, directive.resolution)
  )
    return "coordination_resolution_source_unverified";
  if (
    directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT &&
    (directive.escalation.task_id !== activeTaskId ||
      (state.last_blocked?.recoverable === false
        ? state.phase !== CONVERSATION_COORDINATION_PHASE.COORDINATOR_REVIEWING ||
          state.last_escalation !== null
        : directive.escalation.question_id !== state.last_clarification?.question_id))
  )
    return "coordination_escalation_mismatch";
  if (
    directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT &&
    directive.escalation.resolution_attempts.some(
      (attempt) =>
        !resolutionSourceVerified(context, state, delivery, {
          source: attempt.source,
          source_refs: attempt.source_refs,
          assumptions:
            attempt.source === CONVERSATION_COORDINATION_RESOLUTION_SOURCE.SAFE_DEFAULT
              ? [attempt.outcome]
              : [],
        }),
    )
  )
    return "coordination_escalation_source_unverified";
  if (
    directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE &&
    (directive.finalization.completed_task_ids.length !== state.completed_task_ids.length ||
      !directive.finalization.completed_task_ids.every(
        (id, index) => id === state.completed_task_ids[index],
      ))
  )
    return "coordination_finalization_tasks_mismatch";
  if (directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE) {
    const workspace = context.observeWorkspace(coordinationWorkspaceKey(context, state));
    if (
      workspace.dirty ||
      !workspace.quiescent ||
      !workspace.verified_head ||
      directive.finalization.reviewed_head !== workspace.verified_head ||
      !workspace.evidence_refs.every((reference) =>
        directive.finalization.evidence_refs.includes(reference),
      )
    )
      return "coordination_finalization_review_unverified";
  }
  return null;
}
