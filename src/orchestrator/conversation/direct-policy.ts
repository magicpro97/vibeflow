import {
  MAX_DIRECT_CONTINUATIONS,
  appliesToParticipant,
  directMessagePrompt,
} from "./message-delivery.js";
import type {
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
  MessageRequest,
} from "./types.js";

/** One-participant compatibility policy; all execution still flows through launchAttempt. */
export class DirectConversationPolicy implements ConversationPolicy {
  readonly name = "direct";

  async dryRun(context: ConversationContext): Promise<DryRunResult> {
    const binding = context.bindings[0];
    const participantId = context.participantIds[0];
    const readiness = context.bindingReadiness[0];
    return {
      participants:
        binding && participantId
          ? [
              {
                participant_id: participantId,
                role_ref: binding.role.spec.name,
                engine: binding.engine,
                model: binding.model,
                engine_available: readiness?.engine_available ?? false,
                model_valid: readiness?.model_valid ?? false,
              },
            ]
          : [],
      evaluator_auto_added: context.evaluatorAutoAdded,
      engines_available: binding && readiness?.engine_available ? [binding.engine] : [],
      models_valid: binding !== undefined && readiness?.model_valid === true,
    };
  }

  async execute(context: ConversationContext): Promise<ConversationOrchestrationResult> {
    if (context.bindings.length !== 1) {
      return {
        operation_id: context.correlation.operation_id,
        status: "failed",
        artifact_refs: [],
      };
    }
    const participantId = context.participantIds[0];
    if (!participantId) {
      return {
        operation_id: context.correlation.operation_id,
        status: "failed",
        artifact_refs: [],
      };
    }
    let messages = await context.messages();
    let observedMessages = messages.length;
    let promptInput = directMessagePrompt(
      messages.filter((message) => appliesToParticipant(message, participantId)),
    );
    if (!promptInput) promptInput = context.topic;
    let continuation = 0;
    while (true) {
      const suffix = continuation === 0 ? "" : `:continuation:${continuation}`;
      const eventPrefix = `direct:${context.correlation.operation_id}${suffix}`;
      const attempt = context.launchAttempt({
        participantId,
        bindingIndex: 0,
        purpose: "direct",
        promptInput,
      });
      let stdoutChunks = 0;
      let emissionChain: Promise<unknown> = Promise.resolve();
      const queueDelta = (content: string) => {
        const index = stdoutChunks++;
        const emitted = attempt.emit({
          idempotency_key: `${eventPrefix}:chunk:${index}`,
          event: {
            type: "agent_response_delta",
            payload: {
              round_id: `direct:${context.correlation.operation_id}`,
              participant_id: participantId,
              content_delta: content,
              final_claim: null,
              final_evidence: [],
              completes_response: false,
            },
          },
        });
        emissionChain = emissionChain.then(() => emitted);
      };
      const unsubscribe = attempt.onChunk((chunk) => {
        if (chunk.stream === "stdout" && chunk.content) queueDelta(chunk.content);
      });
      const result = await attempt.completion;
      unsubscribe();
      if (stdoutChunks === 0 && result.output) queueDelta(result.output);
      await emissionChain;
      const complete = result.state === "completed";
      const failed = !result.ok || context.signal.aborted;
      let pending: MessageRequest[] = [];
      if (!failed) {
        messages = await context.messages();
        pending = messages
          .slice(observedMessages)
          .filter((message) => appliesToParticipant(message, participantId));
        observedMessages = messages.length;
      }
      if (failed || !pending.length) {
        await attempt.emit({
          idempotency_key: `${eventPrefix}:complete`,
          event: {
            type: "agent_response_delta",
            payload: {
              round_id: `direct:${context.correlation.operation_id}`,
              participant_id: participantId,
              content_delta: "",
              final_claim: complete && result.ok ? result.output || null : null,
              final_evidence: [],
              completes_response: complete,
            },
          },
        });
      }
      if (failed) {
        return {
          operation_id: context.correlation.operation_id,
          status: context.signal.aborted ? "aborted" : "failed",
          artifact_refs: [],
        };
      }
      if (!pending.length) break;
      continuation += 1;
      if (continuation > MAX_DIRECT_CONTINUATIONS) {
        await context.emit({
          idempotency_key: `direct:${context.correlation.operation_id}:continuation-limit`,
          event: {
            type: "error",
            payload: {
              agent_id: null,
              code: "message_continuation_limit",
              message: "direct message continuation limit reached",
            },
          },
        });
        return {
          operation_id: context.correlation.operation_id,
          status: "failed",
          artifact_refs: [],
        };
      }
      promptInput = directMessagePrompt(pending);
    }
    return {
      operation_id: context.correlation.operation_id,
      status: "completed",
      artifact_refs: [],
    };
  }
}
