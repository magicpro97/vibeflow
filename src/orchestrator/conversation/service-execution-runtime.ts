import {
  conversationTerminal,
  isTerminalLifecycle,
  projectOrchestrationResult,
  terminalResultStatus,
} from "./policy-registry.js";
import type { ConversationRuntime, ConversationRuntimeOptions } from "./runtime.js";
import type {
  ConversationCreateResult,
  ConversationManifest,
  ConversationOrchestrationResult,
} from "./types.js";

export class ConversationExecutionRuntime {
  constructor(
    private readonly runtime: ConversationRuntime,
    private readonly options: ConversationRuntimeOptions,
  ) {}

  async execute(
    manifest: ConversationManifest,
    operationId: string,
  ): Promise<ConversationCreateResult> {
    let keepLive = false;
    try {
      let result: ConversationOrchestrationResult;
      const policy = this.options.policies.require(manifest.policy);
      try {
        result = await policy.execute(await this.runtime.context(manifest.conversation_id));
      } catch {
        result = { operation_id: operationId, status: "failed", artifact_refs: [] };
      }
      result = projectOrchestrationResult(
        result,
        operationId,
        manifest.conversation_id,
        this.options.artifactStore,
      );
      if (result.status === "awaiting_approval" && !policy.continueAfterApproval)
        result = { operation_id: operationId, status: "failed", artifact_refs: [] };
      result = await this.finalize(manifest, operationId, result);
      keepLive = result.status === "awaiting_approval";
      return {
        conversation_id: manifest.conversation_id,
        revision_id: manifest.revision_id,
        result,
      };
    } finally {
      if (!keepLive) {
        this.runtime.finish(manifest.conversation_id);
        await this.options.agentActionCandidates
          ?.flush(manifest.conversation_id)
          .catch(() => undefined);
      }
    }
  }

  async finalize(
    manifest: ConversationManifest,
    operationId: string,
    candidate: ConversationOrchestrationResult,
  ): Promise<ConversationOrchestrationResult> {
    let result =
      candidate.operation_id === operationId
        ? candidate
        : { operation_id: operationId, status: "failed" as const, artifact_refs: [] };
    const state = await this.runtime.snapshot(manifest.conversation_id);
    if (state && isTerminalLifecycle(state.lifecycle)) {
      const status = terminalResultStatus(state.lifecycle);
      return {
        operation_id: operationId,
        status,
        artifact_refs: status === "completed" ? result.artifact_refs : [],
      };
    }
    if (state?.lifecycle === "PAUSED" && result.status === "completed")
      result = { operation_id: operationId, status: "aborted", artifact_refs: [] };
    if (this.runtime.operationCancelled(manifest.conversation_id, operationId))
      result = { operation_id: operationId, status: "aborted", artifact_refs: [] };
    const requested = conversationTerminal(result.status);
    if (!requested) {
      if (
        result.status === "awaiting_approval" &&
        !(await this.runtime.retain(manifest.conversation_id, operationId))
      )
        return { operation_id: operationId, status: "aborted", artifact_refs: [] };
      return result;
    }
    if (state?.lifecycle !== "ACTIVE" && state?.lifecycle !== "PAUSED") return result;
    try {
      const effective = await this.runtime.terminal(
        manifest.conversation_id,
        requested,
        state.health,
        requested === "COMPLETED" ? null : result.status,
        requested === "COMPLETED" ? state.consensus_score : null,
      );
      return effective === requested
        ? result
        : {
            operation_id: operationId,
            status: effective === "STOPPED" ? "stopped" : "aborted",
            artifact_refs: [],
          };
    } catch {
      await this.runtime.terminal(
        manifest.conversation_id,
        "FAILED",
        state.health,
        "terminal append failed",
        null,
      );
      return { operation_id: operationId, status: "failed", artifact_refs: [] };
    }
  }
}
