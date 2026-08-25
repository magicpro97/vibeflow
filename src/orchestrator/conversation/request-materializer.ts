import {
  projectRuntimeCreateRequest,
  projectRuntimePreviewRequest,
} from "./boundary-projection.js";
import { snapshotRuntimeValue } from "./emission-authority.js";
import type { RuntimeCreateRequest, RuntimePreviewRequest } from "./policy-registry.js";
import type { ConversationRuntime, ConversationRuntimeOptions } from "./runtime.js";
import type {
  ConversationCreateRequest,
  ConversationInvocationOptions,
  ConversationManifest,
} from "./types.js";

export class ConversationRequestMaterializer {
  constructor(
    private readonly runtime: ConversationRuntime,
    private readonly options: ConversationRuntimeOptions,
    private readonly now: () => string,
  ) {}

  manifest(request: RuntimeCreateRequest | RuntimePreviewRequest): ConversationManifest {
    return {
      version: "1.0",
      conversation_id: this.runtime.ids("conversation"),
      workflow_id: this.runtime.ids("workflow"),
      revision_id: this.runtime.ids("revision"),
      run_id: this.runtime.ids("run"),
      parent_conversation_id: "parent" in request ? (request.parent?.conversationId ?? null) : null,
      parent_revision_id: "parent" in request ? (request.parent?.revisionId ?? null) : null,
      topic: request.topic,
      policy: request.policy,
      max_rounds: request.maxRounds,
      baseline_enabled: request.baselineEnabled ?? true,
      evaluator_auto_added: request.evaluatorAutoAdded ?? false,
      repo_root: request.repoRoot,
      phase: request.phase,
      task_text: request.topic,
      bindings: request.bindings.map((binding) => ({
        participant_id: binding.participantId,
        input: binding.input,
      })),
      created_at: this.now(),
    };
  }

  async materialize(
    request: ConversationCreateRequest | RuntimeCreateRequest,
    options: ConversationInvocationOptions = {},
  ): Promise<RuntimeCreateRequest> {
    const capturedOptions = snapshotRuntimeValue(options);
    const resolved =
      "bindings" in request ? request : await this.resolve(snapshotRuntimeValue(request));
    return projectRuntimeCreateRequest(resolved, capturedOptions);
  }

  private resolve(request: ConversationCreateRequest): Promise<RuntimeCreateRequest> {
    const resolver = this.options.resolveCreateRequest;
    if (!resolver) throw new Error("conversation create requires canonical binding resolution");
    return resolver(request);
  }

  async preview(
    request: ConversationCreateRequest | RuntimeCreateRequest,
    options: ConversationInvocationOptions,
  ): Promise<RuntimeCreateRequest | RuntimePreviewRequest> {
    if ("bindings" in request || !this.options.resolveDryRunRequest) {
      return this.materialize(request, options);
    }
    const capturedOptions = snapshotRuntimeValue(options);
    const resolved = await this.options.resolveDryRunRequest(snapshotRuntimeValue(request));
    return projectRuntimePreviewRequest(resolved, capturedOptions);
  }
}
