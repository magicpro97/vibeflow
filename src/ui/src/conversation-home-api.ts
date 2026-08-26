import { conversationHomeRequest as request } from "./conversation-home-http.js";
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
  HomeActionApproval,
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

export type BrowserActionCandidate =
  | {
      type: "conversation.add_participant";
      participant: {
        role_ref: string;
        engine: string;
        model: string | null;
        skill_refs: string[];
      };
    }
  | { type: "conversation.remove_participant"; participant_id: string }
  | {
      type: "conversation.update_settings";
      changes: { policy?: string; max_rounds?: number; baseline_enabled?: boolean };
    }
  | {
      type: "capability.install";
      package: { id: string };
      scope: "project" | "user";
      requested_targets: Array<{ engine: string; participant_id: string | null }>;
      inputs: [];
    }
  | {
      type: "capability.remove";
      package_id: string;
      scope: "project" | "user";
      cascade: boolean;
    }
  | { type: "capability.repair"; package_id: string | null; scope: "project" | "user" };

export interface WritableRevisionExpectation {
  mode: "writable-revision";
  conversation_id: string;
  revision_id: string;
  last_seq: number;
  conversation_lock_digest: string;
}

export interface HomeReactionMutation {
  schema_version: "1.0";
  idempotency_key: string;
  mode: "toggle-self";
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
    return request<HomeCatalogResponse>("GET", `/api/conversations?${search}`, undefined, signal);
  },

  timeline(
    input: { rootSessionId: string; cursor?: string; limit?: number },
    signal?: AbortSignal,
  ) {
    const search = new URLSearchParams({ limit: String(input.limit ?? 100) });
    if (input.cursor) search.set("cursor", input.cursor);
    return request<HomeTimelineResponse>(
      "GET",
      `/api/conversation-sessions/${encodeURIComponent(input.rootSessionId)}/timeline?${search}`,
      undefined,
      signal,
    );
  },

  head(rootSessionId: string, signal?: AbortSignal) {
    return request<HomeAuthoritativeHeadResponse>(
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
    return request<HomePendingActionsResponse>(
      "GET",
      conversationPath(conversationId, `/action-proposals?${search}`),
      undefined,
      signal,
    );
  },

  create(input: HomeConversationCreateRequest, signal?: AbortSignal) {
    return request<ConversationCreateResponse>("POST", "/api/conversations", input, signal);
  },

  stageMessagePrivateContext(
    rootSessionId: string,
    input: HomeStageMessagePrivateContextRequest,
    signal?: AbortSignal,
  ) {
    return request<HomePrivateContextPresence>(
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
    return request<HomePrivateContextPresence>(
      "POST",
      messagePrivateContextPath(rootSessionId, true),
      input,
      signal,
    );
  },

  stageDraftPrivateContext(input: HomeStageDraftPrivateContextRequest, signal?: AbortSignal) {
    return request<HomePrivateContextPresence>(
      "POST",
      "/api/conversation-drafts/private-context",
      input,
      signal,
    );
  },

  discardDraftPrivateContext(input: HomeDiscardDraftPrivateContextRequest, signal?: AbortSignal) {
    return request<HomePrivateContextPresence>(
      "POST",
      "/api/conversation-drafts/private-context/discard",
      input,
      signal,
    );
  },

  messageQueue(rootSessionId: string, signal?: AbortSignal) {
    return request<HomeMessageQueueSnapshot>(
      "GET",
      messageQueuePath(rootSessionId),
      undefined,
      signal,
    );
  },

  enqueueMessage(rootSessionId: string, input: HomeEnqueueMessageRequest, signal?: AbortSignal) {
    return request<HomeQueuedMessage>("POST", messageQueuePath(rootSessionId), input, signal);
  },

  editQueuedMessage(
    rootSessionId: string,
    queueItemId: string,
    input: HomeEditQueuedMessageRequest,
    signal?: AbortSignal,
  ) {
    return request<HomeQueuedMessage>(
      "PATCH",
      messageQueuePath(rootSessionId, queueItemId),
      input,
      signal,
    );
  },

  reaction(input: HomeReactionMutation, signal?: AbortSignal) {
    return request<HomeReactionMutationResponse>(
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
    return request<HomeActionView>(
      "POST",
      conversationPath(conversationId, "/action-proposals"),
      {
        schema_version: "1.0",
        idempotency_key: idempotencyKey,
        anchor_event_id: null,
        expected,
        candidate,
      },
      signal,
    );
  },

  challenge(
    conversationId: string,
    proposalId: string,
    proposalDigest: string,
    challengeClass: "fresh-user-scope" | "public-literal",
    signal?: AbortSignal,
  ) {
    return request<{ challenge_id: string; display_phrase: string; expires_at: string }>(
      "POST",
      conversationPath(conversationId, `/action-proposals/${proposalId}/approval-challenge`),
      {
        schema_version: "1.0",
        proposal_digest: proposalDigest,
        challenge_class: challengeClass,
      },
      signal,
    );
  },

  approve(
    conversationId: string,
    proposalId: string,
    proposalDigest: string,
    decision: "approved" | "denied",
    challenge: { id: string; response: string } | null,
    signal?: AbortSignal,
  ) {
    return request<{ approval: HomeActionApproval; operation: HomeActionView["operation"] }>(
      "POST",
      conversationPath(conversationId, `/action-proposals/${proposalId}/approval`),
      {
        schema_version: "1.0",
        proposal_digest: proposalDigest,
        decision,
        challenge_id: challenge?.id ?? null,
        challenge_response: challenge?.response ?? null,
      },
      signal,
    );
  },

  commit(
    conversationId: string,
    proposalId: string,
    proposalDigest: string,
    approvalId: string,
    signal?: AbortSignal,
  ) {
    return request<{ operation: HomeActionView["operation"] }>(
      "POST",
      conversationPath(conversationId, `/action-proposals/${proposalId}/commit`),
      { schema_version: "1.0", proposal_digest: proposalDigest, approval_id: approvalId },
      signal,
    );
  },

  cancel(conversationId: string, proposalId: string, proposalDigest: string, signal?: AbortSignal) {
    return request<{ schema_version: "1.0"; operation: HomeActionView["operation"] }>(
      "POST",
      conversationPath(conversationId, `/action-proposals/${proposalId}/cancel`),
      { schema_version: "1.0", proposal_digest: proposalDigest, reason: null },
      signal,
    );
  },

  capabilities(
    input: {
      query?: string;
      cursor?: string;
      scope: "project" | "user";
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
    return request<HomeCapabilityResponse>("GET", `/api/capabilities?${search}`, undefined, signal);
  },

  operationEventsUrl(conversationId: string, proposalId: string, after?: string | null) {
    const search = after ? `?after=${encodeURIComponent(after)}` : "";
    return conversationPath(conversationId, `/action-proposals/${proposalId}/events${search}`);
  },
};
