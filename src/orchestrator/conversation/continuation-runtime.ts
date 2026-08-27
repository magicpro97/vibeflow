import { CONVERSATION_COMMAND_RESULT_STATUS } from "./conversation-command-result-contract.js";
import { projectOrchestrationResult } from "./policy-registry.js";
import type { ConversationRuntime, ConversationRuntimeOptions } from "./runtime.js";
import type {
  ApprovalDecision,
  ConversationManifest,
  ConversationOrchestrationResult,
} from "./types.js";

type FinalizeResult = (
  manifest: ConversationManifest,
  operationId: string,
  result: ConversationOrchestrationResult,
) => Promise<ConversationOrchestrationResult>;
interface ContinuationLane {
  readonly operationId: string;
  readonly claimed: Set<string>;
  readonly queue: ApprovalDecision[];
  running: boolean;
}

/** Owns exactly-once continuations without exposing runtime authority to policies. */
export class ConversationContinuationRuntime {
  private readonly lanes = new Map<string, ContinuationLane>();

  constructor(
    private readonly runtime: ConversationRuntime,
    private readonly options: Pick<
      ConversationRuntimeOptions,
      "artifactStore" | "policies" | "agentActionCandidates"
    >,
    private readonly finalize: FinalizeResult,
    private readonly onSettled: (conversationId: string) => void = () => undefined,
  ) {}

  start(id: string, decision: ApprovalDecision): void {
    let lane = this.lanes.get(id);
    if (!lane || lane.operationId !== decision.operation_id) {
      lane = {
        operationId: decision.operation_id,
        claimed: new Set<string>(),
        queue: [],
        running: false,
      };
      this.lanes.set(id, lane);
    }
    const claim = JSON.stringify([decision.operation_id, decision.approval_id]);
    if (lane.claimed.has(claim)) return;
    lane.claimed.add(claim);
    lane.queue.push(decision);
    this.pump(id, lane);
  }

  private pump(id: string, lane: ContinuationLane): void {
    if (lane.running) return;
    lane.running = true;
    const running = this.drain(id, lane).then(
      (awaitingApproval) => awaitingApproval,
      async () => {
        await this.fail(id);
        return false;
      },
    );
    void running.then((awaitingApproval) => {
      if (this.lanes.get(id) !== lane) return;
      lane.running = false;
      if (!awaitingApproval) {
        lane.queue.length = 0;
        this.lanes.delete(id);
      } else if (lane.queue.length > 0) {
        this.pump(id, lane);
      }
    });
  }

  private async drain(id: string, lane: ContinuationLane): Promise<boolean> {
    while (true) {
      const decision = lane.queue.shift();
      if (!decision) return true;
      if (!(await this.continue(id, decision))) return false;
    }
  }

  private async fail(id: string): Promise<void> {
    try {
      const manifest = this.runtime.manifest(id);
      const operationId = this.runtime.operationId(id);
      if (!manifest || !operationId) return;
      await this.finalize(manifest, operationId, {
        operation_id: operationId,
        status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
        artifact_refs: [],
      });
      this.runtime.finish(id);
      await this.options.agentActionCandidates?.flush(id).catch(() => undefined);
      this.onSettled(id);
    } catch {
      // Keep live authority when failure evidence cannot be appended durably.
    }
  }

  private async continue(id: string, decision: ApprovalDecision): Promise<boolean> {
    const manifest = this.runtime.manifest(id);
    const operationId = this.runtime.operationId(id);
    if (!manifest || !operationId) throw new Error("approval continuation authority missing");
    const continuation = this.options.policies.require(manifest.policy).continueAfterApproval;
    if (!continuation) throw new Error("approval continuation policy missing");
    let result: ConversationOrchestrationResult;
    try {
      result = await continuation(await this.runtime.context(id), decision);
    } catch {
      result = {
        operation_id: operationId,
        status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
        artifact_refs: [],
      };
    }
    result = projectOrchestrationResult(result, operationId, id, this.options.artifactStore);
    result = await this.finalize(manifest, operationId, result);
    if (result.status === CONVERSATION_COMMAND_RESULT_STATUS.AWAITING_APPROVAL) return true;
    this.runtime.finish(id);
    await this.options.agentActionCandidates?.flush(id).catch(() => undefined);
    this.onSettled(id);
    return false;
  }
}
