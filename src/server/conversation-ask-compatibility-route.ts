import { isAbsolute, relative, resolve, sep } from "node:path";
import { validateIdempotencyKey } from "../actions/idempotency.js";
import type { ActionRequestAuthorityV1 } from "../actions/index.js";
import { ENGINES, type Engine } from "../core.js";
import type {
  ConversationAskCompatibilityRequestV1,
  ConversationAskCompatibilityResultV1,
} from "../orchestrator/conversation/conversation-ask-compatibility.js";
import { CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND } from "../orchestrator/conversation/conversation-ask-compatibility.js";
import {
  CONVERSATION_MESSAGE_QUEUE_ERROR_CODE,
  CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION,
  CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
} from "../orchestrator/conversation/conversation-message-queue-contract.js";
import {
  ASK_COMPATIBILITY_SSE_EVENT,
  SSE_COMMENT,
  serializeSseComment,
  serializeSseJsonEvent,
} from "../orchestrator/conversation/conversation-sse-contract.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import {
  authorizeMessageQueueRoute,
  messageQueueRouteError,
  queueErrorBody,
  queueNoStore,
  queuePrincipal,
  strictQueueBody,
} from "./conversation-message-queue-http.js";

export interface ConversationAskCompatibilityHttpAuthorityV1 {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  csrf?(request: Request): boolean;
  principal?(request: Request, rootSessionId: string): ActionRequestAuthorityV1;
  submit(input: {
    principal_digest: string;
    idempotency_key: string;
    request: ConversationAskCompatibilityRequestV1;
  }): ConversationAskCompatibilityResultV1 | Promise<ConversationAskCompatibilityResultV1>;
}

type ObjectValue = Record<string, unknown>;
const QUESTION_BYTES = 10_000;
const CONVERSATION_ID = /^[A-Za-z0-9_-]{1,200}$/;

function exactKeys(value: ObjectValue, allowed: readonly string[]): boolean {
  const actual = Object.keys(value);
  return actual.every((key) => allowed.includes(key));
}

function question(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.normalize("NFC") === value &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value, "utf8") <= QUESTION_BYTES
  );
}

function engine(value: unknown): value is Engine | undefined {
  return value === undefined || (typeof value === "string" && ENGINES.includes(value as Engine));
}

function decodeAsk(activeRepo: string, body: unknown): ConversationAskCompatibilityRequestV1 {
  if (!body || typeof body !== "object" || Array.isArray(body))
    throw new Error("invalid Ask compatibility request");
  const value = body as ObjectValue;
  if (value.resume === true) {
    if (
      !exactKeys(value, ["resume", "conversation_id", "question"]) ||
      typeof value.conversation_id !== "string" ||
      !CONVERSATION_ID.test(value.conversation_id) ||
      !question(value.question)
    )
      throw new Error("invalid Ask resume request");
    return {
      kind: CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND.RESUME,
      conversation_id: value.conversation_id,
      question: value.question,
    };
  }
  if (
    !exactKeys(value, ["path", "start", "end", "question", "engine", "resume"]) ||
    (value.resume !== undefined && value.resume !== false) ||
    typeof value.path !== "string" ||
    !value.path.trim() ||
    value.path.includes("\0") ||
    !Number.isSafeInteger(value.start) ||
    !Number.isSafeInteger(value.end) ||
    (value.start as number) < 1 ||
    (value.end as number) < (value.start as number) ||
    (value.end as number) - (value.start as number) + 1 > 200 ||
    !question(value.question) ||
    !engine(value.engine)
  )
    throw new Error("invalid Ask create request");
  const target = resolve(activeRepo, value.path);
  const selected = relative(resolve(activeRepo), target);
  if (!selected || selected.startsWith("..") || isAbsolute(selected))
    throw new Error("Ask private context escapes repository");
  return {
    kind: CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND.FRESH,
    repo_relative_path: selected.split(sep).join("/"),
    start_line: value.start as number,
    end_line: value.end as number,
    question: value.question,
    ...(value.engine ? { engine: value.engine as Engine } : {}),
  };
}

function idempotencyKey(request: Request, explicit?: string): string {
  const selected = explicit ?? request.headers.get("idempotency-key");
  if (!selected || selected.includes(",")) throw new Error("invalid Ask idempotency key");
  return validateIdempotencyKey(selected);
}

async function admit(
  authority: ConversationAskCompatibilityHttpAuthorityV1,
  request: Request,
  activeRepo: string,
  body?: unknown,
  explicitIdempotencyKey?: string,
): Promise<ConversationAskCompatibilityResultV1 | Response> {
  const denied = authorizeMessageQueueRoute(authority, request, true);
  if (denied) return denied;
  try {
    const input = decodeAsk(activeRepo, body ?? (await strictQueueBody(request)));
    const principalDigest = queuePrincipal(
      authority,
      request,
      input.kind === CONVERSATION_ASK_COMPATIBILITY_REQUEST_KIND.RESUME
        ? input.conversation_id
        : "conversation-draft",
    );
    return await authority.submit({
      principal_digest: principalDigest,
      idempotency_key: idempotencyKey(request, explicitIdempotencyKey),
      request: input,
    });
  } catch (error) {
    return messageQueueRouteError(error);
  }
}

export async function handleConversationAskCompatibilityRoute(
  authority: ConversationAskCompatibilityHttpAuthorityV1 | undefined,
  request: Request,
  activeRepo: string,
): Promise<Response> {
  if (!authority) {
    try {
      decodeAsk(activeRepo, await strictQueueBody(request));
      idempotencyKey(request);
    } catch (error) {
      return messageQueueRouteError(error);
    }
    return askCompatibilityUnavailable();
  }
  const result = await admit(authority, request, activeRepo);
  if (result instanceof Response) return result;
  return queueNoStore(
    { schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION, accepted: true, ...result },
    result.replayed ? 200 : 202,
  );
}

export async function handleConversationAskCompatibilityStream(
  authority: ConversationAskCompatibilityHttpAuthorityV1 | undefined,
  request: Request,
  activeRepo: string,
  body: unknown,
  explicitIdempotencyKey: string | undefined,
): Promise<Response> {
  if (!authority) {
    try {
      decodeAsk(activeRepo, body);
      idempotencyKey(request, explicitIdempotencyKey);
    } catch (error) {
      return messageQueueRouteError(error);
    }
    return askCompatibilityUnavailable();
  }
  const result = await admit(authority, request, activeRepo, body, explicitIdempotencyKey);
  if (result instanceof Response) return result;
  const accepted = {
    schema_version: CONVERSATION_MESSAGE_QUEUE_SCHEMA_VERSION,
    accepted: true,
    ...result,
  };
  return new Response(
    [
      serializeSseComment(SSE_COMMENT.ASK_COMPATIBILITY_OPEN),
      serializeSseJsonEvent(ASK_COMPATIBILITY_SSE_EVENT.ACCEPTED, accepted),
      serializeSseJsonEvent(ASK_COMPATIBILITY_SSE_EVENT.DONE, { ok: true }),
    ].join(""),
    {
      status: result.replayed ? 200 : 202,
      headers: {
        "content-type": "text/event-stream",
        "cache-control": "no-store",
        "x-accel-buffering": "no",
      },
    },
  );
}

export const askCompatibilityUnavailable = (): Response =>
  queueErrorBody({
    code: CONVERSATION_MESSAGE_QUEUE_ERROR_CODE.SERVICE_UNAVAILABLE,
    message: "Conversation Ask compatibility is unavailable.",
    retryable: true,
    recovery_action: CONVERSATION_MESSAGE_QUEUE_RECOVERY_ACTION.RETRY,
    details: null,
  });
