import type { OrchestrateService } from "./services.js";
import type {
  ApprovalDecision,
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
} from "./types.js";

/** Approval continuation adapter over the existing work-unit orchestration service. */
export class OrchestrateConversationPolicy implements ConversationPolicy {
  readonly name = "orchestrate";

  constructor(private readonly orchestrate: OrchestrateService) {}

  dryRun(context: ConversationContext): Promise<DryRunResult> {
    return this.orchestrate.dryRun(context);
  }

  execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    return this.orchestrate.execute(context, null);
  }

  continueAfterApproval(
    context: ConversationContext,
    decision: ApprovalDecision,
  ): Promise<ConversationOrchestrationResult> {
    return this.orchestrate.execute(context, decision);
  }
}
