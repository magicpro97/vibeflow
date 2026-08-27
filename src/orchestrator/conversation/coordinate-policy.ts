import { CONVERSATION_COMMAND_RESULT_STATUS } from "./conversation-command-result-contract.js";
import {
  CONVERSATION_COORDINATION_DIRECTIVE_KIND,
  CONVERSATION_COORDINATION_LANE,
  CONVERSATION_COORDINATION_LIMIT,
  CONVERSATION_COORDINATION_PHASE,
  CONVERSATION_COORDINATION_POLICY,
  CONVERSATION_COORDINATION_SCHEMA_VERSION,
  CONVERSATION_COORDINATION_SETTLEMENT,
  CONVERSATION_COORDINATION_TERMINAL_OUTCOME,
} from "./conversation-coordination-contract.js";
import type { ConversationCoordinationStateV1 } from "./conversation-coordination-fold.js";
import {
  appendConversationCoordinationRecord,
  coordinationCorrectionKey,
  reconcilePendingConversationCoordinationRecord,
} from "./conversation-coordination-journal.js";
import {
  CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC,
  parseConversationCoordinationOutput,
} from "./conversation-coordination-output.js";
import {
  type ConversationCoordinationTurnPlanV1,
  coordinationAwaitsUserInCurrentRevision,
  coordinationDryRun,
  coordinationWorkspaceKey,
  correctedCoordinationInstruction,
  planConversationCoordinationTurn,
  validateCoordinationDirectiveForTurn,
} from "./conversation-coordination-policy-helpers.js";
import {
  coordinationPolicyResult,
  failCoordinationPolicy,
  recoverCoordinationPolicyFailure,
  settleCoordinationWorkspace,
} from "./conversation-coordination-policy-result.js";
import type {
  ConversationCoordinationDirectiveV1,
  HostCoordinationDirectiveV1,
} from "./conversation-coordination-records.js";
import { coordinationWorkspaceForTurn } from "./conversation-coordination-workspace-binding.js";
import {
  CONVERSATION_OPERATION_STATE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";
import { coordinateTopologyDiagnostic } from "./router-helpers.js";
import type {
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
  PolicyAttempt,
} from "./types.js";

type TurnOutcome =
  | {
      ok: true;
      state: ConversationCoordinationStateV1;
      directive: ConversationCoordinationDirectiveV1;
      attempt: PolicyAttempt;
    }
  | { ok: false; state: ConversationCoordinationStateV1; aborted: boolean; code: string };
interface CoordinationAttemptBudget {
  used: number;
}
function workspaceCompletionEvidence(
  context: ConversationContext,
  state: ConversationCoordinationStateV1,
): readonly string[] | null {
  const workspaceKey = coordinationWorkspaceKey(context, state);
  const observation = context.observeWorkspace(workspaceKey);
  if (
    observation.workspace_key !== workspaceKey ||
    !observation.quiescent ||
    observation.dirty ||
    !observation.branch_ref ||
    !observation.head ||
    observation.verified_head !== observation.head
  )
    return null;
  return observation.evidence_refs;
}

async function emitAttemptError(
  context: ConversationContext,
  attempt: PolicyAttempt,
  plan: ConversationCoordinationTurnPlanV1,
  code: string,
  ordinal: number,
): Promise<void> {
  try {
    await attempt.emit({
      idempotency_key: `coordination:${context.correlation.operation_id}:${plan.participant_id}:${ordinal}:${code}`,
      event: {
        type: CONVERSATION_TRACE_EVENT_KIND.ERROR,
        payload: {
          agent_id: plan.participant_id,
          code,
          message: "agent returned no valid coordination directive",
        },
      },
    });
  } catch {
    // Terminal policy result remains fail-closed.
  }
}

/** Direct coordinator → executor policy over the canonical conversation attempt runtime. */
export class CoordinateConversationPolicy implements ConversationPolicy {
  readonly name = CONVERSATION_COORDINATION_POLICY;

  dryRun(context: ConversationContext): Promise<DryRunResult> {
    if (coordinateTopologyDiagnostic(context))
      return Promise.resolve({
        participants: [],
        evaluator_auto_added: context.evaluatorAutoAdded,
        engines_available: [],
        models_valid: false,
      });
    return Promise.resolve(coordinationDryRun(context));
  }

  private async runTurn(
    context: ConversationContext,
    initialState: ConversationCoordinationStateV1,
    plan: ConversationCoordinationTurnPlanV1,
    budget: CoordinationAttemptBudget,
  ): Promise<TurnOutcome> {
    let state = initialState;
    const engine = context.bindings[plan.binding_index]?.engine;
    if (!engine) return { ok: false, state, aborted: false, code: "coordination_binding_missing" };
    let instruction = plan.instruction;
    let parent: PolicyAttempt["ref"] | undefined;
    const correctionKey = coordinationCorrectionKey({
      state,
      participant_id: plan.participant_id,
      lane: plan.lane,
    });
    let corrected = state.correction_keys.some((key) => key === correctionKey);
    for (
      let ordinal = 0;
      ordinal <= CONVERSATION_COORDINATION_LIMIT.MAX_OUTPUT_CORRECTIONS_PER_TRANSITION;
      ordinal += 1
    ) {
      if (context.signal.aborted)
        return { ok: false, state, aborted: true, code: "coordination_aborted" };
      if (budget.used >= CONVERSATION_COORDINATION_LIMIT.MAX_TOTAL_ATTEMPTS)
        return { ok: false, state, aborted: false, code: "coordination_attempt_limit" };
      budget.used += 1;
      const delivery = await context.prepareTurn({
        participant_id: plan.participant_id,
        instruction,
      });
      const coordinationWorkspace = coordinationWorkspaceForTurn(
        coordinationWorkspaceKey(context, state),
        state,
        plan.lane,
      );
      const attempt = context.launchAttempt({
        participantId: plan.participant_id,
        bindingIndex: plan.binding_index,
        purpose: "coordinate",
        promptInput: delivery.prompt_input,
        delivery,
        ...(parent ? { parent } : {}),
        ...(coordinationWorkspace ? { coordinationWorkspace } : {}),
      });
      const completed = await attempt.completion;
      if (
        !completed.ok ||
        completed.state !== CONVERSATION_OPERATION_STATE.COMPLETED ||
        context.signal.aborted
      ) {
        await emitAttemptError(context, attempt, plan, "coordination_attempt_failed", ordinal);
        return {
          ok: false,
          state,
          aborted: context.signal.aborted,
          code: "coordination_attempt_failed",
        };
      }
      const internalModelOutput = attempt.readModelOutputBinding();
      if (!internalModelOutput || internalModelOutput.engine !== engine) {
        await emitAttemptError(
          context,
          attempt,
          plan,
          "coordination_authenticated_output_unavailable",
          ordinal,
        );
        return {
          ok: false,
          state,
          aborted: false,
          code: "coordination_authenticated_output_unavailable",
        };
      }
      const parsed = parseConversationCoordinationOutput(
        internalModelOutput.output,
        plan.lane,
        plan.allowed_kinds,
      );
      const semanticCode = parsed.ok
        ? await validateCoordinationDirectiveForTurn(
            context,
            state,
            plan,
            parsed.directive,
            delivery,
          )
        : parsed.diagnostic_code;
      if (parsed.ok && semanticCode === null)
        return { ok: true, state, directive: parsed.directive, attempt };
      const diagnostic =
        semanticCode ?? CONVERSATION_COORDINATION_OUTPUT_DIAGNOSTIC.INVALID_DIRECTIVE;
      if (corrected) {
        await emitAttemptError(context, attempt, plan, diagnostic, ordinal);
        return { ok: false, state, aborted: false, code: diagnostic };
      }
      const malformed: HostCoordinationDirectiveV1 = {
        schema_version: CONVERSATION_COORDINATION_SCHEMA_VERSION,
        kind: CONVERSATION_COORDINATION_DIRECTIVE_KIND.MALFORMED_OUTPUT,
        correction: {
          correction_key: correctionKey,
          participant_id: plan.participant_id,
          lane: plan.lane,
          diagnostic_code: diagnostic,
        },
      };
      state = await appendConversationCoordinationRecord({
        context,
        state,
        actor_participant_id: plan.participant_id,
        actor_lane: CONVERSATION_COORDINATION_LANE.HOST,
        directive: malformed,
      });
      corrected = true;
      parent = attempt.ref;
      instruction = correctedCoordinationInstruction(instruction, diagnostic, plan.allowed_kinds);
    }
    return { ok: false, state, aborted: false, code: "coordination_correction_limit" };
  }

  async execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    if (coordinateTopologyDiagnostic(context))
      return {
        operation_id: context.correlation.operation_id,
        status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
        artifact_refs: [],
      };
    let state: ConversationCoordinationStateV1 | null = null;
    try {
      state = await context.coordinationState();
      state = await reconcilePendingConversationCoordinationRecord(context, state);
      if (state.phase === CONVERSATION_COORDINATION_PHASE.TERMINATED)
        return coordinationPolicyResult(
          context,
          state.terminal_outcome === CONVERSATION_COORDINATION_TERMINAL_OUTCOME.ABORTED
            ? CONVERSATION_COMMAND_RESULT_STATUS.ABORTED
            : CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
          state,
        );
      const attemptBudget: CoordinationAttemptBudget = { used: 0 };
      if (
        state.coordinator_participant_id !== null &&
        state.coordinator_participant_id !== context.participantIds[0]
      )
        return failCoordinationPolicy(context, state, "coordination_coordinator_changed");
      for (
        let transition = 0;
        transition < CONVERSATION_COORDINATION_LIMIT.MAX_TOTAL_RECORDS;
        transition += 1
      ) {
        if (context.signal.aborted)
          return failCoordinationPolicy(context, state, "coordination_aborted", true);
        if (state.phase === CONVERSATION_COORDINATION_PHASE.COMPLETED) {
          const evidence = workspaceCompletionEvidence(context, state);
          if (!evidence)
            return failCoordinationPolicy(context, state, "coordination_workspace_not_quiescent");
          await settleCoordinationWorkspace(
            context,
            state,
            CONVERSATION_COORDINATION_SETTLEMENT.COMPLETED,
          );
          return coordinationPolicyResult(
            context,
            CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED,
            state,
          );
        }
        if (coordinationAwaitsUserInCurrentRevision(context, state)) {
          await settleCoordinationWorkspace(
            context,
            state,
            CONVERSATION_COORDINATION_SETTLEMENT.NEEDS_INPUT,
          );
          return coordinationPolicyResult(
            context,
            CONVERSATION_COMMAND_RESULT_STATUS.NEEDS_INPUT,
            state,
          );
        }
        const plan = planConversationCoordinationTurn(context, state);
        if (!plan)
          return failCoordinationPolicy(context, state, "coordination_state_has_no_next_turn");
        const turn = await this.runTurn(context, state, plan, attemptBudget);
        state = turn.state;
        if (!turn.ok) return failCoordinationPolicy(context, state, turn.code, turn.aborted);
        if (turn.directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.FINALIZE) {
          const evidence = workspaceCompletionEvidence(context, state);
          if (!evidence)
            return failCoordinationPolicy(context, state, "coordination_workspace_not_quiescent");
        }
        state = await appendConversationCoordinationRecord({
          context,
          state,
          actor_participant_id: plan.participant_id,
          actor_lane: plan.lane,
          directive: turn.directive,
          attempt: turn.attempt,
        });
        if (turn.directive.kind === CONVERSATION_COORDINATION_DIRECTIVE_KIND.REQUEST_USER_INPUT) {
          await settleCoordinationWorkspace(
            context,
            state,
            CONVERSATION_COORDINATION_SETTLEMENT.NEEDS_INPUT,
          );
          return coordinationPolicyResult(
            context,
            CONVERSATION_COMMAND_RESULT_STATUS.NEEDS_INPUT,
            state,
          );
        }
      }
      return failCoordinationPolicy(context, state, "coordination_transition_limit");
    } catch {
      return recoverCoordinationPolicyFailure(context);
    }
  }
}
