import type { ActionProposalResponseV1 } from "../../actions/index.js";
import type { StoredTraceEvent } from "../trace/types.js";
import type { ConversationActionDomainRegistryV1 } from "./conversation-action-registry.js";
import type { DurableAgentActionCandidateStageV1 } from "./conversation-agent-action-candidate-records.js";
import {
  isValidCompletedAgentActionOrigin,
  recoverPreparedAgentActionProposal,
} from "./conversation-agent-action-candidate-request.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import type { ResolvedConversationLineageSourceV1 } from "./revision-source.js";

/** Gives an already-durable proposal winner precedence over any later draft-obsolescence receipt. */
export async function recoverPreparedAgentActionWinners(input: {
  stages: readonly DurableAgentActionCandidateStageV1[];
  source: ResolvedConversationLineageSourceV1;
  home: ConversationHomeAuthorities;
  actions: ConversationActionDomainRegistryV1;
  finish: (
    stage: DurableAgentActionCandidateStageV1,
    proposal: ActionProposalResponseV1,
    originEventId: string,
  ) => Promise<void>;
}): Promise<void> {
  for (const stage of input.stages) {
    const recovered = await recoverPreparedAgentActionProposal({
      home: input.home,
      actions: input.actions,
      stage,
    });
    if (!recovered) continue;
    const origins = input.source.parent.source.journal_records
      .map(({ stored_event: event }) => event)
      .filter(
        (event) =>
          event.event_id === recovered.proposal.origin_event_id &&
          isValidCompletedAgentActionOrigin(
            input.source.parent.source.manifest,
            stage.participant_id,
            event,
            stage.response_idempotency_key,
          ),
      );
    if (origins.length !== 1)
      throw new Error("prepared candidate proposal lost its completed public origin");
    await input.finish(stage, recovered, (origins[0] as StoredTraceEvent).event_id);
  }
}
