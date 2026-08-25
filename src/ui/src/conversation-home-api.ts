import type {
  HomeActionApproval,
  HomeActionView,
  HomeApiErrorBody,
  HomeAuthoritativeHeadResponse,
  HomeCanonicalMessageReference,
  HomeCanonicalQuoteReference,
  HomeCapabilityResponse,
  HomeCatalogResponse,
  HomePendingActionsResponse,
  HomePrivateFileRangeBinding,
  HomeReactionEmoji,
  HomeReactionSummary,
  HomeTimelineResponse,
} from "./conversation-home-types.js";
import type { ConversationCreateResponse, MessageResponse } from "./conversation-types.js";

interface BrowserDocumentGlobal {
  document: { querySelector(selector: string): { content?: string } | null };
}

function hasBrowserDocument(value: unknown): value is BrowserDocumentGlobal {
  if (typeof value !== "object" || value === null || !("document" in value)) return false;
  const document = value.document;
  return (
    typeof document === "object" &&
    document !== null &&
    "querySelector" in document &&
    typeof document.querySelector === "function"
  );
}

const browserGlobal: unknown = globalThis;
const CSRF = hasBrowserDocument(browserGlobal)
  ? (browserGlobal.document.querySelector('meta[name="vf-token"]')?.content ?? "")
  : "";

export class ConversationHomeApiError extends Error {
  constructor(
    readonly status: number,
    readonly publicError: HomeApiErrorBody,
  ) {
    super(publicError.message);
    this.name = "ConversationHomeApiError";
  }
}

function headers(write: boolean): Record<string, string> {
  return {
    "content-type": "application/json",
    ...(write && CSRF ? { "x-vibeflow-token": CSRF } : {}),
  };
}

async function decode<T>(response: Response): Promise<T> {
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new ConversationHomeApiError(response.status, {
      code: "invalid_response",
      message: "VibeFlow returned an unreadable response.",
      retryable: response.status >= 500,
    });
  }
  if (response.ok) return body as T;
  const row = body as { error?: HomeApiErrorBody; code?: string; message?: string };
  throw new ConversationHomeApiError(response.status, {
    code: row.error?.code ?? row.code ?? "request_failed",
    message: row.error?.message ?? row.message ?? `Request failed (${response.status}).`,
    correlation_id: row.error?.correlation_id,
    retryable: row.error?.retryable ?? response.status >= 500,
    recovery_action: row.error?.recovery_action ?? null,
    details: row.error?.details,
  });
}

async function request<T>(
  method: "GET" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: headers(method === "POST"),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return decode<T>(response);
}

const conversationPath = (conversationId: string, suffix = "") =>
  `/api/conversations/${encodeURIComponent(conversationId)}${suffix}`;

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

export interface HomeMessageRequest {
  content: string;
  target_participants?: string[] | "all";
  quote_refs?: HomeCanonicalQuoteReference[];
  private_file_range?: HomePrivateFileRangeBinding;
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

  create(topic: string, privateFileRange?: HomePrivateFileRangeBinding, signal?: AbortSignal) {
    return request<ConversationCreateResponse>(
      "POST",
      "/api/conversations",
      {
        topic,
        ...(privateFileRange ? { private_file_range: privateFileRange } : {}),
      },
      signal,
    );
  },

  message(conversationId: string, input: HomeMessageRequest, signal?: AbortSignal) {
    return request<MessageResponse>(
      "POST",
      conversationPath(conversationId, "/messages"),
      {
        content: input.content,
        target_participants: input.target_participants,
        ...(input.quote_refs?.length ? { quote_refs: input.quote_refs } : {}),
        ...(input.private_file_range ? { private_file_range: input.private_file_range } : {}),
      },
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
