import { UI_LAN_TOKEN_HEADER } from "../../core/ui-cli-contract.js";
import { readUiPageToken } from "./browser-ui-token.js";
import {
  isConversationPublicTraceRecordWireV1,
  isConversationSnapshotWireV1,
} from "./conversation-public-wire.js";
import type {
  ApprovalDecision,
  ApprovalResolveResponse,
  ConversationCreateRequest,
  ConversationCreateResponse,
  ConversationSnapshot,
  ConversationTraceRecord,
  MessageRequest,
  MessageResponse,
  OperationCancelCommand,
  PauseResponse,
  ResumeResponse,
  StopResponse,
  StreamTokenRenewalResponse,
} from "./conversation-types.js";

const JSON_HEADERS = { "content-type": "application/json" } as const;
const CSRF = readUiPageToken();

export class ConversationApiError extends Error {
  readonly status: number;
  readonly code: string | null;

  constructor(status: number, code: string | null, message: string) {
    super(message);
    this.name = "ConversationApiError";
    this.status = status;
    this.code = code;
  }
}

function requestHeaders(write: boolean): Record<string, string> {
  if (!write || !CSRF) return { ...JSON_HEADERS };
  return { ...JSON_HEADERS, [UI_LAN_TOKEN_HEADER]: CSRF };
}

async function parseJson<T>(response: Response): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    throw new ConversationApiError(response.status, null, "conversation response was invalid");
  }
}

async function readError(response: Response): Promise<ConversationApiError> {
  let code: string | null = null;
  let message = `conversation request failed (${response.status})`;
  try {
    const body = (await response.json()) as { code?: string; message?: string };
    code = typeof body.code === "string" ? body.code : null;
    if (typeof body.message === "string" && body.message.trim()) message = body.message.trim();
    else if (code) message = code;
  } catch {
    // Status-only fallback is adequate here.
  }
  return new ConversationApiError(response.status, code, message);
}

async function jsonRequest<T>(
  method: string,
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: requestHeaders(method !== "GET"),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  if (!response.ok) throw await readError(response);
  return parseJson<T>(response);
}

const conversationRoute = (conversationId: string, suffix = "") =>
  `/api/conversations/${encodeURIComponent(conversationId)}${suffix}`;
const getConversationJson = <T>(conversationId: string, suffix: string, signal?: AbortSignal) =>
  jsonRequest<T>("GET", conversationRoute(conversationId, suffix), undefined, signal);
const postConversationJson = <T>(
  conversationId: string,
  suffix: string,
  body: unknown,
  signal?: AbortSignal,
) => jsonRequest<T>("POST", conversationRoute(conversationId, suffix), body, signal);

const requireConversationSnapshot = (value: unknown, conversationId?: string) => {
  if (
    !isConversationSnapshotWireV1(value) ||
    (conversationId !== undefined && value.conversation_id !== conversationId)
  )
    throw new ConversationApiError(200, null, "conversation response was invalid");
  return value as ConversationSnapshot;
};

export function conversationEventsUrl(
  conversationId: string,
  streamToken: string,
  cursor = 0,
): string {
  const params = new URLSearchParams({ stream_token: streamToken });
  if (cursor > 0) params.set("since", String(cursor));
  return `/api/conversations/${encodeURIComponent(conversationId)}/events?${params.toString()}`;
}

export function conversationArtifactUrl(conversationId: string, opaqueId: string): string {
  return `${conversationRoute(conversationId, "/artifacts/")}${encodeURIComponent(opaqueId)}`;
}

export const conversationApi = {
  create: (request: ConversationCreateRequest, signal?: AbortSignal) =>
    jsonRequest<ConversationCreateResponse>("POST", "/api/conversations", request, signal),
  snapshot: async (conversationId: string, signal?: AbortSignal) =>
    requireConversationSnapshot(
      await getConversationJson<unknown>(conversationId, "/snapshot", signal),
      conversationId,
    ),
  renewStreamToken: (conversationId: string, signal?: AbortSignal) =>
    postConversationJson<StreamTokenRenewalResponse>(conversationId, "/stream-token", {}, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
  message: (conversationId: string, request: MessageRequest, signal?: AbortSignal) => postConversationJson<MessageResponse>(conversationId, "/messages", request, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
  pause: (conversationId: string, signal?: AbortSignal) => postConversationJson<PauseResponse>(conversationId, "/pause", {}, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
  resume: (conversationId: string, signal?: AbortSignal) => postConversationJson<ResumeResponse>(conversationId, "/resume", {}, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
  stop: (conversationId: string, signal?: AbortSignal) => postConversationJson<StopResponse>(conversationId, "/stop", {}, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid Bun LCOV phantom counters
  resolveApproval: (conversationId: string, approvalId: string, decision: ApprovalDecision, signal?: AbortSignal) => postConversationJson<ApprovalResolveResponse>(conversationId, `/approvals/${encodeURIComponent(approvalId)}/resolve`, decision, signal),
  // biome-ignore format: keep invocation on its declaration line to avoid Bun LCOV phantom counters
  cancelOperation: (conversationId: string, command: OperationCancelCommand, signal?: AbortSignal) => postConversationJson<{ operation_id: string; cancelled: true }>(conversationId, `/operations/${encodeURIComponent(command.operation_id)}/cancel`, command, signal),
};

export function parseConversationSseRecord(raw: string): ConversationTraceRecord {
  const value: unknown = JSON.parse(raw);
  if (!isConversationPublicTraceRecordWireV1(value))
    throw new Error("conversation trace event was invalid");
  return value as ConversationTraceRecord;
}

export function parseConversationSseSnapshot(raw: string, conversationId?: string) {
  return requireConversationSnapshot(JSON.parse(raw) as unknown, conversationId);
}

export {
  projectConversationBaseline,
  projectConversationDecisionMatrix,
} from "./conversation-decision-projection.js";
