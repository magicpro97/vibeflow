import { isReadOnlyRole } from "../../agents/role.js";
import { ROLE_SANDBOX } from "../../core/role-contract.js";
import {
  ENGINE_OUTPUT_STREAM,
  supportsConversationRoleAuthority,
} from "../../dispatch/session-contract.js";
import { CONVERSATION_COMMAND_RESULT_STATUS } from "./conversation-command-result-contract.js";
import { CONVERSATION_POLICY } from "./conversation-policy-contract.js";
import {
  CONVERSATION_OPERATION_STATE,
  CONVERSATION_TRACE_EVENT_KIND,
} from "./conversation-public-wire-contract.js";
import { DirectOutputStreamV1 } from "./direct-output-stream.js";
import { MAX_DIRECT_CONTINUATIONS } from "./message-delivery.js";
import { CONVERSATION_TURN_INSTRUCTION_KIND } from "./turn-delivery-contract.js";
import type {
  ConversationContext,
  ConversationOrchestrationResult,
  ConversationPolicy,
  DryRunResult,
  MessageRequest,
} from "./types.js";

/** One-participant compatibility policy; all execution still flows through launchAttempt. */
export class DirectConversationPolicy implements ConversationPolicy {
  readonly name = CONVERSATION_POLICY.DIRECT;

  private canonical(context: ConversationContext): boolean {
    const binding = context.bindings[0];
    return (
      context.policy === this.name &&
      context.bindings.length === 1 &&
      context.participantIds.length === 1 &&
      binding !== undefined &&
      binding.sandbox === ROLE_SANDBOX.READ_ONLY &&
      isReadOnlyRole(binding.role.spec)
    );
  }

  async dryRun(context: ConversationContext): Promise<DryRunResult> {
    if (!this.canonical(context))
      return {
        participants: [],
        evaluator_auto_added: context.evaluatorAutoAdded,
        engines_available: [],
        models_valid: false,
      };
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
    const binding = context.bindings[0];
    if (
      !this.canonical(context) ||
      !binding ||
      !supportsConversationRoleAuthority(binding.engine)
    ) {
      return {
        operation_id: context.correlation.operation_id,
        status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
        artifact_refs: [],
      };
    }
    const participantId = context.participantIds[0];
    if (!participantId) {
      return {
        operation_id: context.correlation.operation_id,
        status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
        artifact_refs: [],
      };
    }
    let delivery = await context.prepareTurn({
      participant_id: participantId,
      instruction: { kind: CONVERSATION_TURN_INSTRUCTION_KIND.DIRECT, topic: context.topic },
    });
    let continuation = 0;
    while (true) {
      const suffix = continuation === 0 ? "" : `:continuation:${continuation}`;
      const eventPrefix = `direct:${context.correlation.operation_id}${suffix}`;
      const attempt = context.launchAttempt({
        participantId,
        bindingIndex: 0,
        purpose: "direct",
        promptInput: delivery.prompt_input,
        delivery,
      });
      let emittedChunks = 0;
      let emissionChain: Promise<unknown> = Promise.resolve();
      const queueDelta = (content: string) => {
        const index = emittedChunks++;
        const emitted = attempt.emit({
          idempotency_key: `${eventPrefix}:chunk:${index}`,
          event: {
            type: CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA,
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
      const outputStream = new DirectOutputStreamV1(queueDelta);
      const unsubscribe = attempt.onChunk((chunk) => {
        if (chunk.stream === ENGINE_OUTPUT_STREAM.STDOUT && chunk.content)
          outputStream.push(chunk.content);
      });
      const result = await attempt.completion;
      unsubscribe();
      const parsed = outputStream.finish(result.output);
      await emissionChain;
      const complete = result.state === CONVERSATION_OPERATION_STATE.COMPLETED;
      const failed = !result.ok || context.signal.aborted;
      let pending = false;
      if (!failed) {
        delivery = await context.prepareTurn({
          participant_id: participantId,
          instruction: { kind: CONVERSATION_TURN_INSTRUCTION_KIND.DIRECT, topic: null },
        });
        pending = delivery.applicable_user_message_count > 0;
      }
      if (failed || !pending) {
        const responseIdempotencyKey = `${eventPrefix}:complete`;
        const stagedCandidate =
          complete && result.ok && parsed.action_candidate?.present
            ? context.stageActionCandidate({
                participant_id: participantId,
                response_idempotency_key: responseIdempotencyKey,
                candidate: parsed.action_candidate.value,
              })
            : null;
        const response = await attempt.emit({
          idempotency_key: responseIdempotencyKey,
          event: {
            type: CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA,
            payload: {
              round_id: `direct:${context.correlation.operation_id}`,
              participant_id: participantId,
              content_delta: "",
              final_claim: complete && result.ok ? parsed.answer || null : null,
              final_evidence: [],
              completes_response: complete,
            },
          },
        });
        if (complete && result.ok && parsed.social_intent.present)
          context.publishSocialIntent({
            participant_id: participantId,
            response_event_id: response.event_id,
            request: parsed.social_intent,
          });
        if (stagedCandidate && !stagedCandidate.accepted) {
          await attempt.emit({
            idempotency_key: `${eventPrefix}:action-candidate:${stagedCandidate.diagnostic_code ?? "rejected"}`,
            event: {
              type: CONVERSATION_TRACE_EVENT_KIND.ERROR,
              payload: {
                agent_id: participantId,
                code: stagedCandidate.diagnostic_code ?? "action_candidate_rejected",
                message: "agent host-action candidate was rejected",
              },
            },
          });
        }
      }
      if (failed) {
        return {
          operation_id: context.correlation.operation_id,
          status: context.signal.aborted
            ? CONVERSATION_COMMAND_RESULT_STATUS.ABORTED
            : CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
          artifact_refs: [],
        };
      }
      if (!pending) break;
      continuation += 1;
      if (continuation > MAX_DIRECT_CONTINUATIONS) {
        await context.emit({
          idempotency_key: `direct:${context.correlation.operation_id}:continuation-limit`,
          event: {
            type: CONVERSATION_TRACE_EVENT_KIND.ERROR,
            payload: {
              agent_id: null,
              code: "message_continuation_limit",
              message: "direct message continuation limit reached",
            },
          },
        });
        return {
          operation_id: context.correlation.operation_id,
          status: CONVERSATION_COMMAND_RESULT_STATUS.FAILED,
          artifact_refs: [],
        };
      }
    }
    return {
      operation_id: context.correlation.operation_id,
      status: CONVERSATION_COMMAND_RESULT_STATUS.COMPLETED,
      artifact_refs: [],
    };
  }
}
