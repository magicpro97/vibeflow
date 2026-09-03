import { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import {
  type ActionProposalRequestV1,
  type ActionRequestAuthorityV1,
  type CanonicalActionRequestV1,
  actionIdempotencyKeyDigest,
  canonicalActionRequestDigest,
} from "../../actions/index.js";
import type { ConversationHomeAuthorities } from "./conversation-home-authorities.js";
import { HandoffTooLargeError } from "./handoff-selection.js";
import { ConversationHandoffTooLargeError } from "./revision-errors.js";
import type { ResolvedRevisionBaseV1 } from "./revision-source.js";
import type { MessageRequest } from "./types.js";

export function rethrowWithOversizedCandidate(input: {
  error: unknown;
  home: ConversationHomeAuthorities;
  request: ActionProposalRequestV1;
  authority: ActionRequestAuthorityV1;
  created_at: string;
}): never {
  if (!(input.error instanceof HandoffTooLargeError)) throw input.error;
  input.home.handoffs.writeOmissions(input.error.omitted_public_event_artifacts);
  const { idempotency_key: _key, ...request } = input.request;
  const canonicalRequest: CanonicalActionRequestV1 = {
    schema_version: "1.0",
    origin: "conversation",
    principal_digest: input.authority.principal_digest,
    authority_scope_digest: input.authority.authority_scope_digest,
    planning_options: { mode: "durable", network_read: "ordinary-host-policy" },
    request,
  };
  const rejected = input.home.oversizedHandoffs.materializeRejected({
    source: structuredClone(input.error.projection.source),
    source_public_head_digest: input.error.selection_plan.source_public_head_digest,
    selection_plan_digest: input.error.selection_plan.selection_digest,
    prompt_budget_bytes: input.error.selection_plan.prompt_budget_bytes,
    prompt_projection: structuredClone(input.error.projection),
  });
  const candidate = input.home.oversizedHandoffs.issue({
    rejected,
    principal_digest: input.authority.principal_digest,
    authority_scope_digest: input.authority.authority_scope_digest,
    idempotency_key_digest: actionIdempotencyKeyDigest(input.request.idempotency_key),
    canonical_request_digest: canonicalActionRequestDigest(canonicalRequest),
    created_at: input.created_at,
  });
  throw new ConversationHandoffTooLargeError(candidate);
}

export function rethrowTerminalMessageOverflow(input: {
  error: unknown;
  home: ConversationHomeAuthorities;
  base: ResolvedRevisionBaseV1;
  request: MessageRequest & { target_participants: "all" | string[] };
  action_key: string;
  authority: ActionRequestAuthorityV1;
  created_at: string;
}): never {
  return rethrowWithOversizedCandidate({
    error: input.error,
    home: input.home,
    request: {
      schema_version: "1.0",
      idempotency_key: input.action_key,
      anchor_event_id: null,
      expected: {
        mode: "writable-revision",
        conversation_id: input.base.parent.node.conversation_id,
        revision_id: input.base.parent.node.revision_id,
        last_seq: input.base.parent.source.journal_head.last_seq,
        conversation_lock_digest: input.base.lock.lock_digest,
      },
      candidate: {
        type: HOST_ACTION_KIND.CONVERSATION_CONTINUE_MESSAGE,
        content: input.request.content,
        target_participants: input.request.target_participants,
        ...(input.request.quote_refs
          ? { quote_refs: structuredClone(input.request.quote_refs) }
          : {}),
      },
    },
    authority: input.authority,
    created_at: input.created_at,
  });
}
