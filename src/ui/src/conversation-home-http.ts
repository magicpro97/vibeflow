import type { HomeApiErrorBody } from "./conversation-home-types.js";

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

function headers(method: "GET" | "PATCH" | "POST"): Record<string, string> {
  const write = method !== "GET";
  return {
    "content-type": "application/json",
    ...(write ? {} : { "cache-control": "no-store" }),
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

export async function conversationHomeRequest<T>(
  method: "GET" | "PATCH" | "POST",
  path: string,
  body?: unknown,
  signal?: AbortSignal,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: headers(method),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return decode<T>(response);
}
