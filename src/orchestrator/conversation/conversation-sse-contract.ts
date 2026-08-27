import {
  PUBLIC_ERROR_CODE,
  type PublicApiErrorBodyV1,
} from "../../actions/public-error-contract.js";

export const CONVERSATION_SSE_EVENT = Object.freeze({
  TRACE: "trace",
  SNAPSHOT: "snapshot",
  MESSAGE_QUEUE_INVALIDATED: "message-queue-invalidated",
  ERROR: "error",
  HEARTBEAT: "heartbeat",
} as const);

export const CONVERSATION_CLIENT_STREAM_STATE = Object.freeze({
  IDLE: "idle",
  CONNECTING: "connecting",
  LIVE: "live",
  RECONNECTING: "reconnecting",
  ERROR: "error",
} as const);
export type ConversationClientStreamState =
  (typeof CONVERSATION_CLIENT_STREAM_STATE)[keyof typeof CONVERSATION_CLIENT_STREAM_STATE];
export const CONVERSATION_CLIENT_STREAM_STATES = Object.freeze(
  Object.values(CONVERSATION_CLIENT_STREAM_STATE),
) as readonly ConversationClientStreamState[];

export const CONVERSATION_STREAM_RECOVERY_OUTCOME = Object.freeze({
  TERMINAL: "terminal",
  RENEWED: "renewed",
  RECONNECTING: CONVERSATION_CLIENT_STREAM_STATE.RECONNECTING,
} as const);
export type ConversationStreamRecoveryOutcome =
  (typeof CONVERSATION_STREAM_RECOVERY_OUTCOME)[keyof typeof CONVERSATION_STREAM_RECOVERY_OUTCOME];

export const ASK_SSE_EVENT = Object.freeze({
  TOKEN: "token",
  DONE: "done",
  ERROR: "error",
} as const);

export const ASK_COMPATIBILITY_SSE_EVENT = Object.freeze({
  ACCEPTED: "accepted",
  DONE: ASK_SSE_EVENT.DONE,
} as const);

export const LOG_SSE_EVENT = Object.freeze({ LOG: "log" } as const);
export const LEGACY_WORKFLOW_SSE_EVENT = Object.freeze({ STREAM: "stream" } as const);

export const SSE_COMMENT = Object.freeze({
  ASK_OPEN: "vibeflow-ask-1",
  ASK_COMPATIBILITY_OPEN: "vibeflow-ask-compatibility-1",
  LOGS_OPEN: "vibeflow-logs-1",
  DASHBOARD_LOGS_OPEN: "vibeflow-dashboard-logs-1",
  KEEPALIVE: "keepalive",
} as const);

export interface SseFrameSerializationOptions {
  id?: string;
  retryMilliseconds?: number;
}

function sseLine(value: string, field: string): string {
  if (value.includes("\r") || value.includes("\n")) throw new Error(`invalid SSE ${field}`);
  return value;
}

export function serializeSseDataEvent(
  event: string,
  data: string,
  options: SseFrameSerializationOptions = {},
): string {
  const id = options.id === undefined ? "" : `id: ${sseLine(options.id, "id")}\n`;
  const retry =
    options.retryMilliseconds === undefined
      ? ""
      : `retry: ${Math.max(0, Math.trunc(options.retryMilliseconds))}\n`;
  return `${id}event: ${sseLine(event, "event")}\ndata: ${data}\n${retry}\n`;
}

export const serializeSseJsonEvent = (
  event: string,
  data: unknown,
  options?: SseFrameSerializationOptions,
): string => serializeSseDataEvent(event, JSON.stringify(data) ?? "null", options);

export const serializeSseEmptyEvent = (
  event: string,
  options?: SseFrameSerializationOptions,
): string => serializeSseDataEvent(event, "", options);

export const serializeSseJsonData = (data: unknown): string =>
  `data: ${JSON.stringify(data) ?? "null"}\n\n`;

export const serializeSseComment = (comment: string): string =>
  `: ${sseLine(comment, "comment")}\n\n`;

export const CONVERSATION_SSE_ERROR_CODE = Object.freeze({
  NOT_FOUND: PUBLIC_ERROR_CODE.NOT_FOUND,
  SERVICE_UNAVAILABLE: PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE,
} as const);

export const CONVERSATION_SSE_HTTP_ERROR_CODE = Object.freeze({
  UNAUTHENTICATED: PUBLIC_ERROR_CODE.UNAUTHENTICATED,
  INVALID_REQUEST: PUBLIC_ERROR_CODE.INVALID_REQUEST,
  ...CONVERSATION_SSE_ERROR_CODE,
} as const);

export type ConversationSseHttpErrorCode =
  (typeof CONVERSATION_SSE_HTTP_ERROR_CODE)[keyof typeof CONVERSATION_SSE_HTTP_ERROR_CODE];

export type ConversationSseErrorCode =
  (typeof CONVERSATION_SSE_ERROR_CODE)[keyof typeof CONVERSATION_SSE_ERROR_CODE];

export const CONVERSATION_SSE_ERROR_CODES = Object.freeze(
  Object.values(CONVERSATION_SSE_ERROR_CODE),
) as readonly ConversationSseErrorCode[];

export const isConversationSseErrorCode = (value: unknown): value is ConversationSseErrorCode =>
  typeof value === "string" &&
  CONVERSATION_SSE_ERROR_CODES.some((candidate) => candidate === value);

export type ConversationSseEventName =
  (typeof CONVERSATION_SSE_EVENT)[keyof typeof CONVERSATION_SSE_EVENT];

export type ConversationSseFrameV1<Trace, Snapshot, QueueInvalidation> =
  | { id: string; event: typeof CONVERSATION_SSE_EVENT.TRACE; data: Trace }
  | { id: string; event: typeof CONVERSATION_SSE_EVENT.SNAPSHOT; data: Snapshot }
  | { event: typeof CONVERSATION_SSE_EVENT.MESSAGE_QUEUE_INVALIDATED; data: QueueInvalidation }
  | { event: typeof CONVERSATION_SSE_EVENT.ERROR; data: PublicApiErrorBodyV1 }
  | { event: typeof CONVERSATION_SSE_EVENT.HEARTBEAT; data: "" };

export const CONVERSATION_SSE_EVENTS = Object.freeze(
  Object.values(CONVERSATION_SSE_EVENT),
) as readonly ConversationSseEventName[];

export const isConversationSseEventName = (value: unknown): value is ConversationSseEventName =>
  typeof value === "string" && (CONVERSATION_SSE_EVENTS as readonly string[]).includes(value);
