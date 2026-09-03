import type { AgentActionCandidateOutput } from "../debate.js";
import type { StoredTraceEvent } from "../trace/types.js";
import type { AgentSocialIntentRequestV1 } from "./conversation-interaction-types.js";
import { CONVERSATION_TRACE_EVENT_KIND } from "./conversation-public-wire-contract.js";
import type { ConversationContext, PolicyAttempt } from "./types.js";

export function publishDebateParticipantResponse(
  context: ConversationContext,
  round: number,
  participant: {
    participantId: string;
    attempt: PolicyAttempt;
    content: string;
    claim: string | null;
    evidence: string[];
    socialIntent: AgentSocialIntentRequestV1;
    actionCandidate?: AgentActionCandidateOutput;
  },
): Promise<StoredTraceEvent> {
  const responseIdempotencyKey = `debate:round:${round}:participant:${participant.participantId}:response`;
  const stagedCandidate = participant.actionCandidate?.present
    ? context.stageActionCandidate({
        participant_id: participant.participantId,
        response_idempotency_key: responseIdempotencyKey,
        candidate: participant.actionCandidate.value,
      })
    : null;
  return participant.attempt
    .emit({
      idempotency_key: responseIdempotencyKey,
      event: {
        type: CONVERSATION_TRACE_EVENT_KIND.AGENT_RESPONSE_DELTA,
        payload: {
          round_id: `round-${round}`,
          participant_id: participant.participantId,
          content_delta: participant.content,
          final_claim: participant.claim,
          final_evidence: participant.evidence,
          completes_response: true,
        },
      },
    })
    .then(async (response) => {
      if (participant.socialIntent.present)
        context.publishSocialIntent({
          participant_id: participant.participantId,
          response_event_id: response.event_id,
          request: participant.socialIntent,
        });
      if (stagedCandidate && !stagedCandidate.accepted) {
        await participant.attempt.emit({
          idempotency_key: `debate:round:${round}:participant:${participant.participantId}:action-candidate:${stagedCandidate.diagnostic_code ?? "rejected"}`,
          event: {
            type: CONVERSATION_TRACE_EVENT_KIND.ERROR,
            payload: {
              agent_id: participant.participantId,
              code: stagedCandidate.diagnostic_code ?? "action_candidate_rejected",
              message: "agent host-action candidate was rejected",
            },
          },
        });
      }
      return response;
    });
}
