import type { ActionProposalResponseV1 } from "../../actions/index.js";
import type { ConversationActionDomainRegistryV1 } from "./conversation-action-registry.js";
import type { DurableAgentActionCandidateMaterializedReceiptV1 } from "./conversation-agent-action-candidate-receipts.js";
import type { DurableAgentActionCandidateStageV1 } from "./conversation-agent-action-candidate-records.js";
import { assertCanonicalAgentActionProposalStage } from "./conversation-agent-action-candidate-review.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";

/** Reprojects a terminal receipt through both canonical authority and domain storage. */
export async function projectCanonicalAgentActionCandidateReceipt(input: {
  home: ConversationHomeAuthorities;
  actions: ConversationActionDomainRegistryV1 | null;
  stage: DurableAgentActionCandidateStageV1;
  receipt: DurableAgentActionCandidateMaterializedReceiptV1;
}): Promise<ActionProposalResponseV1> {
  const snapshot = input.home.actions.authority.get(input.receipt.proposal_id);
  if (!snapshot)
    throw new Error("candidate materialization receipt lost its canonical action proposal");
  assertCanonicalAgentActionProposalStage({
    stage: input.stage,
    receipt: input.receipt,
    proposal: snapshot.proposal,
  });
  const projected = await input.actions?.get(
    input.stage.conversation_id,
    input.receipt.proposal_id,
  );
  if (
    !projected ||
    projected.proposal.proposal_digest !== snapshot.proposal.proposal_digest ||
    projected.proposal.origin_event_id !== snapshot.proposal.origin_event_id
  )
    throw new Error("candidate materialization domain projection is not canonical");
  return projected;
}
