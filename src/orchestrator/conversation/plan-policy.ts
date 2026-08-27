import {
  CONVERSATION_COMMAND_FAILURE_STATUS,
  CONVERSATION_COMMAND_RESULT_STATUS,
} from "./conversation-command-result-contract.js";
import {
  type PlanArtifact,
  type PlanArtifactLocator,
  type PlanService,
  policyDryRun,
} from "./services.js";
import type {
  ApprovalDecision,
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
} from "./types.js";

export interface PlanWorkflowPolicies {
  orchestrate: ConversationPolicy &
    Required<Pick<ConversationPolicy, "continueAfterApproval">> & {
      continuePlanAfterApproval?: (
        context: ConversationContext,
        decision: ApprovalDecision,
        artifact: PlanArtifact,
      ) => Promise<ConversationOrchestrationResult>;
    };
  review: ConversationPolicy;
  verify: ConversationPolicy;
}

const failed = (context: ConversationContext): ConversationOrchestrationResult => ({
  operation_id: context.correlation.operation_id,
  status: context.signal.aborted
    ? CONVERSATION_COMMAND_RESULT_STATUS.ABORTED
    : CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
  artifact_refs: [],
});

const mergeRefs = (
  context: ConversationContext,
  status: ConversationOrchestrationResult["status"],
  ...refs: readonly string[][]
): ConversationOrchestrationResult => ({
  operation_id: context.correlation.operation_id,
  status,
  artifact_refs:
    status === CONVERSATION_COMMAND_FAILURE_STATUS.FAILED ||
    status === CONVERSATION_COMMAND_FAILURE_STATUS.ABORTED
      ? []
      : [...new Set(refs.flat())],
});

/** Durable plan → approval → units → human review → verify workflow policy. */
export class PlanConversationPolicy implements ConversationPolicy {
  readonly name = "plan";

  constructor(
    private readonly plans: PlanService,
    private readonly locatePlan?: PlanArtifactLocator,
    private readonly workflow?: PlanWorkflowPolicies,
  ) {}

  dryRun(context: ConversationContext): Promise<DryRunResult> {
    return this.workflow?.orchestrate.dryRun(context) ?? Promise.resolve(policyDryRun(context));
  }

  private async persistRevision(context: ConversationContext): Promise<PlanArtifact> {
    const previous = await this.locatePlan?.(context);
    if (!previous) return this.plans.createPlan(context);
    if (previous.revision_id === context.correlation.revision_id) return previous;
    const messages = await context.messages();
    return this.plans.updatePlan(context, {
      revision_id: context.correlation.revision_id,
      content: messages.at(-1)?.content ?? context.topic,
      reason: "conversation revision",
    });
  }

  async execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    try {
      if (context.signal.aborted) return failed(context);
      const plan = await this.persistRevision(context);
      if (context.signal.aborted) return failed(context);
      if (!this.workflow)
        return mergeRefs(context, CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED, [plan.ref]);
      const requested = await this.workflow.orchestrate.execute(context);
      if (context.signal.aborted) return failed(context);
      if (requested.operation_id !== context.correlation.operation_id) return failed(context);
      return mergeRefs(context, requested.status, [plan.ref], requested.artifact_refs);
    } catch {
      return failed(context);
    }
  }

  continueAfterApproval = async (
    context: ConversationContext,
    decision: ApprovalDecision,
  ): Promise<ConversationOrchestrationResult> => {
    try {
      if (context.signal.aborted) return failed(context);
      const plan = await this.locatePlan?.(context);
      if (context.signal.aborted || !plan || !this.workflow) return failed(context);
      const executed = this.workflow.orchestrate.continuePlanAfterApproval
        ? await this.workflow.orchestrate.continuePlanAfterApproval(context, decision, plan)
        : await this.workflow.orchestrate.continueAfterApproval(context, decision);
      if (context.signal.aborted) return failed(context);
      if (executed.operation_id !== context.correlation.operation_id) return failed(context);
      if (executed.status !== CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED) {
        return mergeRefs(context, executed.status, executed.artifact_refs);
      }
      const reviewed = await this.workflow.review.execute(context);
      if (context.signal.aborted) return failed(context);
      if (
        reviewed.operation_id !== context.correlation.operation_id ||
        reviewed.status !== CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED
      ) {
        return failed(context);
      }
      const verified = await this.workflow.verify.execute(context);
      if (context.signal.aborted) return failed(context);
      if (
        verified.operation_id !== context.correlation.operation_id ||
        verified.status !== CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED
      ) {
        return failed(context);
      }
      return mergeRefs(
        context,
        CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED,
        [plan.ref],
        executed.artifact_refs,
        reviewed.artifact_refs,
        verified.artifact_refs,
      );
    } catch {
      return failed(context);
    }
  };
}
