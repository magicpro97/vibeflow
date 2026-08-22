import { type PlanArtifactLocator, type ReviewService, policyDryRun } from "./services.js";
import type {
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
} from "./types.js";

/** Human-review policy. Artifact lookup is injected from the canonical artifact catalog. */
export class ReviewConversationPolicy implements ConversationPolicy {
  readonly name = "review";

  constructor(
    private readonly reviews: ReviewService,
    private readonly locatePlan: PlanArtifactLocator,
  ) {}

  dryRun(context: ConversationContext): Promise<DryRunResult> {
    return Promise.resolve(policyDryRun(context));
  }

  async execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    try {
      const plan = await this.locatePlan(context);
      if (!plan) throw new Error("plan artifact not found");
      const resolution = await this.reviews.requestReview(context, plan);
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [...resolution.evidence_refs],
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
