import type { HOST_ACTION_KIND } from "../../actions/host-action-contract.js";
import { PUBLIC_ACTION_SCHEMA_VERSION } from "../../actions/public-action-contract.js";
import type {
  ActionApprovalChallengeRequestV1,
  ActionApprovalRequestV1,
  ActionCancelRequestV1,
  ActionCommitRequestV1,
} from "../../actions/public-types.js";
import type { BrowserHostActionRequestV1 } from "../../actions/request-types.js";
import type {
  ActionProposalRequestV1,
  CapabilityScope,
  ExpectedActionSourceV1,
} from "../../actions/types.js";
import type {
  CONVERSATION_HUMAN_REACTION_REQUEST_MODE,
  CONVERSATION_INTERACTION_SCHEMA_VERSION,
} from "../../orchestrator/conversation/conversation-interaction-contract.js";
import {
  parseHomeActionApprovalResponse,
  parseHomeActionCancelResponse,
  parseHomeActionChallengeResponse,
  parseHomeActionMutationResponse,
  parseHomeActionViewResponse,
  parseHomePendingActionsResponse,
  parseHomeTimelineResponse,
} from "./conversation-home-action-boundary.js";
import { HOME_API_ERROR_CONTRACT } from "./conversation-home-error-boundary.js";
import { conversationHomeRequest as rawRequest } from "./conversation-home-http.js";
import type {
  HomeEditQueuedMessageRequest,
  HomeEnqueueMessageRequest,
  HomeMessageQueueSnapshot,
  HomeQueuedMessage,
} from "./conversation-home-message-queue-types.js";
export { ConversationHomeApiError } from "./conversation-home-http.js";
import type {
  HomeConversationCreateRequest,
  HomeDiscardDraftPrivateContextRequest,
  HomeDiscardMessagePrivateContextRequest,
  HomePrivateContextPresence,
  HomeStageDraftPrivateContextRequest,
  HomeStageMessagePrivateContextRequest,
} from "./conversation-home-private-context-types.js";
import type {
  HomeActionView,
  HomeAuthoritativeHeadResponse,
  HomeCanonicalMessageReference,
  HomeCapabilityResponse,
  HomeCatalogResponse,
  HomePendingActionsResponse,
  HomeReactionEmoji,
  HomeReactionSummary,
  HomeTimelineResponse,
} from "./conversation-home-types.js";
import type { ConversationCreateResponse } from "./conversation-types.js";

const conversationPath = (conversationId: string, suffix = "") =>
  `/api/conversations/${encodeURIComponent(conversationId)}${suffix}`;
const messageQueuePath = (rootSessionId: string, queueItemId?: string) => {
  const base = `/api/conversation-sessions/${encodeURIComponent(rootSessionId)}/messages/queue`;
  return queueItemId ? `${base}/${encodeURIComponent(queueItemId)}` : base;
};
const messagePrivateContextPath = (rootSessionId: string, discard = false) =>
  `/api/conversation-sessions/${encodeURIComponent(rootSessionId)}/messages/private-context${discard ? "/discard" : ""}`;
const publicRequest = <T>(
  method: "GET" | "PATCH" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
  parser?: (value: unknown) => T,
) => rawRequest(method, path, body, signal, parser, HOME_API_ERROR_CONTRACT.PUBLIC);
const queueRequest = <T>(
  method: "GET" | "PATCH" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
) => rawRequest<T>(method, path, body, signal, undefined, HOME_API_ERROR_CONTRACT.MESSAGE_QUEUE);

export type BrowserActionCandidate = Extract<
  BrowserHostActionRequestV1,
  | { type: typeof HOST_ACTION_KIND.CONVERSATION_ADD_PARTICIPANT }
  | { type: typeof HOST_ACTION_KIND.CONVERSATION_REMOVE_PARTICIPANT }
  | { type: typeof HOST_ACTION_KIND.CONVERSATION_UPDATE_SETTINGS }
  | { type: typeof HOST_ACTION_KIND.CAPABILITY_INSTALL }
  | { type: typeof HOST_ACTION_KIND.CAPABILITY_REMOVE }
  | { type: typeof HOST_ACTION_KIND.CAPABILITY_REPAIR }
>;

export type WritableRevisionExpectation = Extract<
  ExpectedActionSourceV1,
  { mode: "writable-revision" }
>;

export interface HomeReactionMutation {
  schema_version: typeof CONVERSATION_INTERACTION_SCHEMA_VERSION;
  idempotency_key: string;
  mode: typeof CONVERSATION_HUMAN_REACTION_REQUEST_MODE.TOGGLE_SELF;
  emoji: HomeReactionEmoji;
  message_ref: HomeCanonicalMessageReference;
}

export interface HomeReactionMutationResponse {
  schema_version: "1.0";
  message_ref: HomeCanonicalMessageReference;
  reactions: HomeReactionSummary[];
  folded_at: string;
}

export const conversationHomeApi = {
  sessions(input: { query?: string; cursor?: string; limit?: number }, signal?: AbortSignal) {
    const search = new URLSearchParams();
    if (input.query) search.set("q", input.query);
    if (input.cursor) search.set("cursor", input.cursor);
    search.set("limit", String(input.limit ?? 50));
    return publicRequest<HomeCatalogResponse>(
      "GET",
      `/api/conversations?${search}`,
      undefined,
      signal,
    );
  },

  timeline(
    input: { rootSessionId: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ) {
    const search = new URLSearchParams({ limit: String(input.limit ?? 100) });
    if (input.cursor) search.set("cursor", input.cursor);
    return publicRequest<HomeTimelineResponse>(
      "GET",
      `/api/conversation-sessions/${encodeURIComponent(input.rootSessionId)}/timeline?${search}`,
      undefined,
      signal,
      parseHomeTimelineResponse,
    );
  },

  head(rootSessionId: string, signal?: AbortSignal) {
    return publicRequest<HomeAuthoritativeHeadResponse>(
      "GET",
      `/api/conversation-sessions/${encodeURIComponent(rootSessionId)}/head`,
      undefined,
      signal,
    );
  },

  pending(
    conversationId: string,
    input?: { cursor?: string; limit?: number },
    signal?: AbortSignal,
  ) {
    const search = new URLSearchParams({
      state: "pending",
      limit: String(input?.limit ?? 100),
    });
    if (input?.cursor) search.set("cursor", input.cursor);
    return publicRequest<HomePendingActionsResponse>(
      "GET",
      conversationPath(conversationId, `/action-proposals?${search}`),
      undefined,
      signal,
      parseHomePendingActionsResponse,
    );
  },

  create(input: HomeConversationCreateRequest, signal?: AbortSignal) {
    return queueRequest<ConversationCreateResponse>("POST", "/api/conversations", input, signal);
  },

  stageMessagePrivateContext(
    rootSessionId: string,
    input: HomeStageMessagePrivateContextRequest,
    signal?: AbortSignal,
  ) {
    return queueRequest<HomePrivateContextPresence>(
      "POST",
      messagePrivateContextPath(rootSessionId),
      input,
      signal,
    );
  },

  discardMessagePrivateContext(
    rootSessionId: string,
    input: HomeDiscardMessagePrivateContextRequest,
    signal?: AbortSignal,
  ) {
    return queueRequest<HomePrivateContextPresence>(
      "POST",
      messagePrivateContextPath(rootSessionId, true),
      input,
      signal,
    );
  },

  stageDraftPrivateContext(input: HomeStageDraftPrivateContextRequest, signal?: AbortSignal) {
    return queueRequest<HomePrivateContextPresence>(
      "POST",
      "/api/conversation-drafts/private-context",
      input,
      signal,
    );
  },

  discardDraftPrivateContext(input: HomeDiscardDraftPrivateContextRequest, signal?: AbortSignal) {
    return queueRequest<HomePrivateContextPresence>(
      "POST",
      "/api/conversation-drafts/private-context/discard",
      input,
      signal,
    );
  },

  messageQueue(rootSessionId: string, signal?: AbortSignal) {
    return queueRequest<HomeMessageQueueSnapshot>(
      "GET",
      messageQueuePath(rootSessionId),
      undefined,
      signal,
    );
  },

  enqueueMessage(rootSessionId: string, input: HomeEnqueueMessageRequest, signal?: AbortSignal) {
    return queueRequest<HomeQueuedMessage>("POST", messageQueuePath(rootSessionId), input, signal);
  },

  editQueuedMessage(
    rootSessionId: string,
    queueItemId: string,
    input: HomeEditQueuedMessageRequest,
    signal?: AbortSignal,
  ) {
    return queueRequest<HomeQueuedMessage>(
      "PATCH",
      messageQueuePath(rootSessionId, queueItemId),
      input,
      signal,
    );
  },

  reaction(input: HomeReactionMutation, signal?: AbortSignal) {
    return publicRequest<HomeReactionMutationResponse>(
      "POST",
      `${conversationPath(input.message_ref.conversation_id, `/events/${encodeURIComponent(input.message_ref.target_event_id)}/reactions`)}`,
      input,
      signal,
    );
  },

  propose(
    conversationId: string,
    expected: WritableRevisionExpectation,
    candidate: BrowserActionCandidate,
    idempotencyKey: string,
    signal?: AbortSignal,
  ) {
    const payload: ActionProposalRequestV1 = {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      idempotency_key: idempotencyKey,
      anchor_event_id: null,
      expected,
      candidate,
    };
    return publicRequest<HomeActionView>(
      "POST",
      conversationPath(conversationId, "/action-proposals"),
      payload,
      signal,
      parseHomeActionViewResponse,
    );
  },

  challenge(
    conversationId: string,
    proposalId: string,
    proposalDigest: string,
    challengeClass: ActionApprovalChallengeRequestV1["challenge_class"],
    signal?: AbortSignal,
  ) {
    const payload: ActionApprovalChallengeRequestV1 = {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      proposal_digest: proposalDigest,
      challenge_class: challengeClass,
    };
    return publicRequest<ReturnType<typeof parseHomeActionChallengeResponse>>(
      "POST",
      conversationPath(conversationId, `/action-proposals/${proposalId}/approval-challenge`),
      payload,
      signal,
      (value) => parseHomeActionChallengeResponse(value, challengeClass),
    );
  },

  approve(
    conversationId: string,
    proposalId: string,
    proposalDigest: string,
    decision: ActionApprovalRequestV1["decision"],
    challenge: { id: string; response: string } | null,
    signal?: AbortSignal,
  ) {
    const payload: ActionApprovalRequestV1 = {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      proposal_digest: proposalDigest,
      decision,
      challenge_id: challenge?.id ?? null,
      challenge_response: challenge?.response ?? null,
    };
    return publicRequest<ReturnType<typeof parseHomeActionApprovalResponse>>(
      "POST",
      conversationPath(conversationId, `/action-proposals/${proposalId}/approval`),
      payload,
      signal,
      (value) =>
        parseHomeActionApprovalResponse(value, {
          proposalId,
          proposalDigest,
          decision,
        }),
    );
  },

  commit(
    conversationId: string,
    proposalId: string,
    proposalDigest: string,
    approvalId: string,
    signal?: AbortSignal,
  ) {
    const payload: ActionCommitRequestV1 = {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      proposal_digest: proposalDigest,
      approval_id: approvalId,
    };
    return publicRequest<ReturnType<typeof parseHomeActionMutationResponse>>(
      "POST",
      conversationPath(conversationId, `/action-proposals/${proposalId}/commit`),
      payload,
      signal,
      (value) =>
        parseHomeActionMutationResponse(value, {
          proposalId,
          proposalDigest,
          approvalId,
        }),
    );
  },

  cancel(conversationId: string, proposalId: string, proposalDigest: string, signal?: AbortSignal) {
    const payload: ActionCancelRequestV1 = {
      schema_version: PUBLIC_ACTION_SCHEMA_VERSION,
      proposal_digest: proposalDigest,
      reason: null,
    };
    return publicRequest<ReturnType<typeof parseHomeActionCancelResponse>>(
      "POST",
      conversationPath(conversationId, `/action-proposals/${proposalId}/cancel`),
      payload,
      signal,
      (value) =>
        parseHomeActionCancelResponse(value, {
          proposalId,
          proposalDigest,
        }),
    );
  },

  capabilities(
    input: {
      query?: string;
      cursor?: string;
      scope: CapabilityScope;
      view?: "search" | "list" | "status";
    },
    signal?: AbortSignal,
  ) {
    const search = new URLSearchParams({
      view: input.view ?? "search",
      scope: input.scope,
      limit: "50",
    });
    if (input.query) search.set("q", input.query);
    if (input.cursor) search.set("cursor", input.cursor);
    return publicRequest<HomeCapabilityResponse>(
      "GET",
      `/api/capabilities?${search}`,
      undefined,
      signal,
    );
  },

  operationEventsUrl(conversationId: string, proposalId: string, after?: string | null) {
    const search = after ? `?after=${encodeURIComponent(after)}` : "";
    return conversationPath(conversationId, `/action-proposals/${proposalId}/events${search}`);
  },
};
