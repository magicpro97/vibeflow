import { type PlanService, policyDryRun } from "./services.js";
import type {
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
} from "./types.js";

/** Conversation adapter for the existing structured planner service. */
export class PlanConversationPolicy implements ConversationPolicy {
  readonly name = "plan";

  constructor(private readonly plans: PlanService) {}

  dryRun(context: ConversationContext): Promise<DryRunResult> {
    return Promise.resolve(policyDryRun(context));
  }

  async execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    try {
      const plan = await this.plans.createPlan(context);
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [plan.ref],
      };
    } catch {
      return {
        operation_id: context.correlation.operation_id,
        status: context.signal.aborted ? "aborted" : "failed",
        artifact_refs: [],
      };
    }
  }
}
