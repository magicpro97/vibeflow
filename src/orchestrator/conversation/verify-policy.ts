import { type PlanArtifactLocator, type VerifyService, policyDryRun } from "./services.js";
import type {
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
} from "./types.js";

/** Full-verify policy; the injected service is the same structured core consumed by the CLI. */
export class VerifyConversationPolicy implements ConversationPolicy {
  readonly name = "verify";

  constructor(
    private readonly verify: VerifyService,
    private readonly locatePlan: PlanArtifactLocator,
  ) {}

  dryRun(context: ConversationContext): Promise<DryRunResult> {
    return Promise.resolve(policyDryRun(context));
  }

  async execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    try {
      const plan = await this.locatePlan(context);
      if (!plan) throw new Error("plan artifact not found");
      const report = await this.verify.runVerify(context, plan);
      const artifact = await context.createArtifact({
        artifact_type: "tests",
        content: `${JSON.stringify(report)}\n`,
        idempotency_key: `verify-policy:report:${context.correlation.operation_id}`,
      });
      return {
        operation_id: context.correlation.operation_id,
        status: "completed",
        artifact_refs: [artifact.ref],
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
