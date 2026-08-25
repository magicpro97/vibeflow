import type { StoredTraceEvent } from "../trace/types.js";
import type { AgentSocialIntentRequestV1 } from "./conversation-interaction-types.js";
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
  },
): Promise<StoredTraceEvent> {
  return participant.attempt
    .emit({
      idempotency_key: `debate:round:${round}:participant:${participant.participantId}:response`,
      event: {
        type: "agent_response_delta",
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
    .then((response) => {
      if (participant.socialIntent.present)
        context.publishSocialIntent({
          participant_id: participant.participantId,
          response_event_id: response.event_id,
          request: participant.socialIntent,
        });
      return response;
    });
}
