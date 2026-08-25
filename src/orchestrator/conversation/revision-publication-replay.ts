import { canonicalJsonBytes } from "../../durability/index.js";
import type { PublishedRevisionTransitionInputV1 } from "./lineage-published-transition.js";
import type { MessageRequest } from "./types.js";

function same(left: unknown, right: unknown): boolean {
  return canonicalJsonBytes(left).equals(canonicalJsonBytes(right));
}

export function revisionActionIdempotencyKey(
  messageKey: string,
  revisionClaimEpoch: number,
): string {
  return revisionClaimEpoch === 1 ? messageKey : `${messageKey}.${revisionClaimEpoch}`;
}

export function findPublishedContinuation(
  transitions: readonly PublishedRevisionTransitionInputV1[],
  conversationId: string,
  request: MessageRequest & { target_participants: "all" | string[] },
  messageKey: string,
): { childId: string; proposalId: string; created: false } | null {
  for (const transition of transitions) {
    const authority = transition.authority as {
      kind?: unknown;
      operation?: {
        parent?: { conversation_id?: unknown };
        child?: { conversation_id?: unknown };
        revision_claim_epoch?: unknown;
      };
      proposal?: {
        proposal_id?: unknown;
        idempotency_key?: unknown;
        action?: {
          type?: unknown;
          content?: unknown;
          target_participants?: unknown;
          quote_refs?: unknown;
        };
      };
    };
    const epoch = authority.operation?.revision_claim_epoch;
    if (
      authority.kind === "child-commit" &&
      authority.operation?.parent?.conversation_id === conversationId &&
      typeof epoch === "number" &&
      authority.proposal?.idempotency_key === revisionActionIdempotencyKey(messageKey, epoch) &&
      authority.proposal.action?.type === "conversation.continue_message" &&
      authority.proposal.action.content === request.content &&
      same(authority.proposal.action.target_participants, request.target_participants) &&
      same(authority.proposal.action.quote_refs ?? [], request.quote_refs ?? []) &&
      typeof authority.operation.child?.conversation_id === "string" &&
      typeof authority.proposal.proposal_id === "string"
    )
      return {
        childId: authority.operation.child.conversation_id,
        proposalId: authority.proposal.proposal_id,
        created: false,
      };
  }
  return null;
}
