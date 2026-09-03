import { UI_LAN_TOKEN_HEADER } from "../../core/ui-cli-contract.js";
import { readUiPageToken } from "./browser-ui-token.js";
import {
  HOME_API_ERROR_CONTRACT,
  type HomeApiErrorContract,
  parseHomeApiError,
} from "./conversation-home-error-boundary.js";
import type { HomeApiErrorBody } from "./conversation-home-types.js";

const CSRF = readUiPageToken();

export class ConversationHomeApiError extends Error {
  constructor(
    readonly status: number,
    readonly publicError: HomeApiErrorBody,
  ) {
    super(publicError.message);
    this.name = "ConversationHomeApiError";
  }
}

type ResponseParser<T> = (value: unknown) => T;

function headers(method: "GET" | "PATCH" | "POST"): Record<string, string> {
  const write = method !== "GET";
  return {
    "content-type": "application/json",
    ...(write ? {} : { "cache-control": "no-store" }),
    ...(write && CSRF ? { [UI_LAN_TOKEN_HEADER]: CSRF } : {}),
  };
}

async function decode<T>(
  response: Response,
  errorContract: HomeApiErrorContract,
  parser?: ResponseParser<T>,
): Promise<T> {
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
  if (response.ok) {
    if (!parser) return body as T;
    try {
      return parser(body);
    } catch {
      throw new ConversationHomeApiError(response.status, {
        code: "invalid_response",
        message: "VibeFlow returned an unreadable response.",
        retryable: response.status >= 500,
      });
    }
  }
  try {
    throw new ConversationHomeApiError(response.status, parseHomeApiError(body, errorContract));
  } catch (error) {
    if (error instanceof ConversationHomeApiError) throw error;
    throw new ConversationHomeApiError(response.status, {
      code: "invalid_response",
      message: "VibeFlow returned an unreadable response.",
      retryable: response.status >= 500,
    });
  }
}

export async function conversationHomeRequest<T>(
  method: "GET" | "PATCH" | "POST",
  path: string,
  body: unknown | undefined,
  signal: AbortSignal | undefined,
  parser: ResponseParser<T> | undefined,
  errorContract: HomeApiErrorContract,
): Promise<T> {
  const response = await fetch(path, {
    method,
    headers: headers(method),
    body: body === undefined ? undefined : JSON.stringify(body),
    signal,
  });
  return decode<T>(response, errorContract, parser);
}
