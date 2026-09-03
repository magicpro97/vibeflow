import { UI_LAN_TOKEN_HEADER } from "../../core/ui-cli-contract.js";
import { readUiPageToken } from "./browser-ui-token.js";
import {
  isConversationPublicTraceRecordWireV1,
  isConversationSnapshotWireV1,
} from "./conversation-public-wire.js";
import { CONVERSATION_STREAM_ERROR_MESSAGE } from "./conversation-stream-error-contract.js";
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

// biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
const conversationRoute = (conversationId: string, suffix = "") => `/api/conversations/${encodeURIComponent(conversationId)}${suffix}`;
// biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
const getConversationJson = <T>(conversationId: string, suffix: string, signal?: AbortSignal) => jsonRequest<T>("GET", conversationRoute(conversationId, suffix), undefined, signal);
// biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
const postConversationJson = <T>(conversationId: string, suffix: string, body: unknown, signal?: AbortSignal) => jsonRequest<T>("POST", conversationRoute(conversationId, suffix), body, signal);

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

// biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
export function conversationArtifactUrl(conversationId: string, opaqueId: string): string {
  return `${conversationRoute(conversationId, "/artifacts/")}${encodeURIComponent(opaqueId)}`;
}

export function createConversation(
  request: ConversationCreateRequest,
  signal?: AbortSignal,
): Promise<ConversationCreateResponse> {
  return jsonRequest<ConversationCreateResponse>("POST", "/api/conversations", request, signal);
}

export async function snapshotConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ConversationSnapshot> {
  return requireConversationSnapshot(
    await getConversationJson<unknown>(conversationId, "/snapshot", signal),
    conversationId,
  );
}

export function renewConversationStreamToken(
  conversationId: string,
  signal?: AbortSignal,
): Promise<StreamTokenRenewalResponse> {
  return postConversationJson<StreamTokenRenewalResponse>(
    conversationId,
    "/stream-token",
    {},
    signal,
  );
}

export function sendConversationMessage(
  conversationId: string,
  request: MessageRequest,
  signal?: AbortSignal,
): Promise<MessageResponse> {
  return postConversationJson<MessageResponse>(conversationId, "/messages", request, signal);
}

export function pauseConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<PauseResponse> {
  return postConversationJson<PauseResponse>(conversationId, "/pause", {}, signal);
}

export function resumeConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<ResumeResponse> {
  return postConversationJson<ResumeResponse>(conversationId, "/resume", {}, signal);
}

export function stopConversation(
  conversationId: string,
  signal?: AbortSignal,
): Promise<StopResponse> {
  return postConversationJson<StopResponse>(conversationId, "/stop", {}, signal);
}

export function resolveConversationApproval(
  conversationId: string,
  approvalId: string,
  decision: ApprovalDecision,
  signal?: AbortSignal,
): Promise<ApprovalResolveResponse> {
  return postConversationJson<ApprovalResolveResponse>(
    conversationId,
    `/approvals/${encodeURIComponent(approvalId)}/resolve`,
    decision,
    signal,
  );
}

export function cancelConversationOperation(
  conversationId: string,
  command: OperationCancelCommand,
  signal?: AbortSignal,
): Promise<{ operation_id: string; cancelled: true }> {
  return postConversationJson<{ operation_id: string; cancelled: true }>(
    conversationId,
    `/operations/${encodeURIComponent(command.operation_id)}/cancel`,
    command,
    signal,
  );
}

export const conversationApi = {
  create: createConversation,
  snapshot: snapshotConversation,
  renewStreamToken: renewConversationStreamToken,
  message: sendConversationMessage,
  pause: pauseConversation,
  resume: resumeConversation,
  stop: stopConversation,
  resolveApproval: resolveConversationApproval,
  cancelOperation: cancelConversationOperation,
};

export function parseConversationSseRecord(raw: string): ConversationTraceRecord {
  const value: unknown = JSON.parse(raw);
  if (!isConversationPublicTraceRecordWireV1(value))
    throw new Error(CONVERSATION_STREAM_ERROR_MESSAGE.TRACE_INVALID);
  return value as ConversationTraceRecord;
}

// biome-ignore format: keep invocation on its declaration line to avoid a Bun LCOV phantom counter
export function parseConversationSseSnapshot(raw: string, conversationId?: string) {
  return requireConversationSnapshot(JSON.parse(raw) as unknown, conversationId);
}

export {
  projectConversationBaseline,
  projectConversationDecisionMatrix,
} from "./conversation-decision-projection.js";
