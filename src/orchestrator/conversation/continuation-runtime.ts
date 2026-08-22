import { assertChildManifestAuthority, createChildManifest } from "./boundary-projection.js";
import {
  conversationChildId,
  conversationChildOperationId,
  projectOrchestrationResult,
} from "./policy-registry.js";
import type { ConversationRuntime, ConversationRuntimeOptions } from "./runtime.js";
import type {
  ApprovalDecision,
  ConversationManifest,
  ConversationOrchestrationResult,
  MessageRequest,
} from "./types.js";

type FinalizeResult = (
  manifest: ConversationManifest,
  operationId: string,
  result: ConversationOrchestrationResult,
) => Promise<ConversationOrchestrationResult>;
type ExecuteConfigured = (manifest: ConversationManifest, operationId: string) => Promise<unknown>;
interface ContinuationLane {
  readonly operationId: string;
  readonly claimed: Set<string>;
  readonly queue: ApprovalDecision[];
  running: boolean;
}

/** Owns exactly-once continuations without exposing runtime authority to policies. */
export class ConversationContinuationRuntime {
  private readonly lanes = new Map<string, ContinuationLane>();
  private readonly revisionCreations = new Map<string, Promise<string>>();

  constructor(
    private readonly runtime: ConversationRuntime,
    private readonly options: Pick<ConversationRuntimeOptions, "artifactStore" | "policies">,
    private readonly finalize: FinalizeResult,
    private readonly executeConfigured: ExecuteConfigured,
    private readonly now: () => string,
    private readonly schedule: (task: () => void) => void,
  ) {}

  childRevision(
    parent: ConversationManifest,
    request: MessageRequest,
    key: string,
  ): Promise<string> {
    const reservation = `${parent.conversation_id}:${key}`;
    const existing = this.revisionCreations.get(reservation);
    if (existing) return existing;
    const creation = this.createChild(parent, request, key);
    this.revisionCreations.set(reservation, creation);
    const cleanup = () => {
      if (this.revisionCreations.get(reservation) === creation) {
        this.revisionCreations.delete(reservation);
      }
    };
    void creation.then(cleanup, cleanup);
    return creation;
  }

  private async createChild(
    parent: ConversationManifest,
    request: MessageRequest,
    key: string,
  ): Promise<string> {
    const childId = conversationChildId(parent.conversation_id, request);
    let child = this.runtime.manifest(childId);
    const { bindings } = await this.runtime.rehydrate(child ? childId : parent.conversation_id);
    if (!child) {
      child = createChildManifest(parent, childId, this.runtime.ids("run"), this.now());
      try {
        this.runtime.persist(child, bindings);
      } catch {
        child = assertChildManifestAuthority(this.runtime.manifest(childId), parent, childId);
      }
    }
    let operationId = this.runtime.operationId(childId);
    const ownsOperation = !operationId;
    if (!operationId) {
      operationId = this.runtime.begin(
        child,
        bindings,
        [],
        false,
        0,
        conversationChildOperationId(childId),
      );
    }
    try {
      await this.runtime.configure(childId);
      await this.runtime.userMessage(childId, request, `child:message:${key}`);
    } catch (error) {
      await this.runtime.abandon(childId, "child configuration failed");
      throw error;
    }
    const [, claimed] = this.options.artifactStore.recordChildRevision(
      parent.conversation_id,
      key,
      childId,
    );
    if (!claimed) await this.runtime.abandon(childId, "child revision owned elsewhere");
    if (ownsOperation && claimed) {
      this.schedule(() => void this.executeConfigured(child, operationId).catch(() => undefined));
    }
    return childId;
  }

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
        status: "failed",
        artifact_refs: [],
      });
      this.runtime.finish(id);
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
      result = { operation_id: operationId, status: "failed", artifact_refs: [] };
    }
    result = projectOrchestrationResult(result, operationId, id, this.options.artifactStore);
    result = await this.finalize(manifest, operationId, result);
    if (result.status === "awaiting_approval") return true;
    this.runtime.finish(id);
    return false;
  }
}
