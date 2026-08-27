import { CONVERSATION_COMMAND_RESULT_STATUS } from "./conversation-command-result-contract.js";
import {
  CONVERSATION_TERMINAL_LIFECYCLE,
  CONVERSATION_TRANSITION_LIFECYCLE,
} from "./conversation-public-wire-contract.js";
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
        result = {
          operation_id: operationId,
          status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
          artifact_refs: [],
        };
      }
      result = projectOrchestrationResult(
        result,
        operationId,
        manifest.conversation_id,
        this.options.artifactStore,
      );
      if (
        result.status === CONVERSATION_COMMAND_RESULT_STATUS.AWAITING_APPROVAL &&
        !policy.continueAfterApproval
      )
        result = {
          operation_id: operationId,
          status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
          artifact_refs: [],
        };
      result = await this.finalize(manifest, operationId, result);
      keepLive = result.status === CONVERSATION_COMMAND_RESULT_STATUS.AWAITING_APPROVAL;
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
        : {
            operation_id: operationId,
            status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
            artifact_refs: [],
          };
    const state = await this.runtime.snapshot(manifest.conversation_id);
    if (state && isTerminalLifecycle(state.lifecycle)) {
      const status = terminalResultStatus(state.lifecycle);
      return {
        operation_id: operationId,
        status,
        artifact_refs:
          status === CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED ? result.artifact_refs : [],
      };
    }
    if (
      state?.lifecycle === CONVERSATION_TRANSITION_LIFECYCLE.PAUSED &&
      result.status === CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED
    )
      result = {
        operation_id: operationId,
        status: CONVERSATION_COMMAND_RESULT_STATUS.ABORTED,
        artifact_refs: [],
      };
    if (this.runtime.operationCancelled(manifest.conversation_id, operationId))
      result = {
        operation_id: operationId,
        status: CONVERSATION_COMMAND_RESULT_STATUS.ABORTED,
        artifact_refs: [],
      };
    const requested = conversationTerminal(result.status);
    if (!requested) {
      if (
        result.status === CONVERSATION_COMMAND_RESULT_STATUS.AWAITING_APPROVAL &&
        !(await this.runtime.retain(manifest.conversation_id, operationId))
      )
        return {
          operation_id: operationId,
          status: CONVERSATION_COMMAND_RESULT_STATUS.ABORTED,
          artifact_refs: [],
        };
      return result;
    }
    if (
      state?.lifecycle !== CONVERSATION_TRANSITION_LIFECYCLE.ACTIVE &&
      state?.lifecycle !== CONVERSATION_TRANSITION_LIFECYCLE.PAUSED
    )
      return result;
    try {
      const effective = await this.runtime.terminal(
        manifest.conversation_id,
        requested,
        state.health,
        requested === CONVERSATION_TERMINAL_LIFECYCLE.COMPLETED ? null : result.status,
        requested === CONVERSATION_TERMINAL_LIFECYCLE.COMPLETED ? state.consensus_score : null,
      );
      return effective === requested
        ? result
        : {
            operation_id: operationId,
            status:
              effective === CONVERSATION_TERMINAL_LIFECYCLE.STOPPED
                ? CONVERSATION_COMMAND_RESULT_STATUS.STOPPED
                : CONVERSATION_COMMAND_RESULT_STATUS.ABORTED,
            artifact_refs: [],
          };
    } catch {
      await this.runtime.terminal(
        manifest.conversation_id,
        CONVERSATION_TERMINAL_LIFECYCLE.FAILED,
        state.health,
        "terminal append failed",
        null,
      );
      return {
        operation_id: operationId,
        status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
        artifact_refs: [],
      };
    }
  }
}
