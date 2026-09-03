import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../actions/public-error-contract.js";
import { parseStrictJson } from "../actions/strict-json.js";
import { ConversationInteractionCorruptError } from "../orchestrator/conversation/conversation-interaction-store.js";
import type { PublicMessageLocatorV1 } from "../orchestrator/conversation/conversation-interaction-types.js";
import {
  assertPublicMessageLocatorV1,
  isReactionEmojiV1,
} from "../orchestrator/conversation/conversation-interaction-validation.js";
import type { ConversationSocialAuthorityV1 } from "../orchestrator/conversation/conversation-social-authority.js";
import { BoundedRequestBodyError, readBoundedUtf8Body } from "./bounded-request-body.js";
import { deriveBrowserActionAuthority } from "./conversation-action-principal.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import { conversationReadError } from "./conversation-list-route.js";

const MAX_BODY_BYTES = 64 * 1024;

class InvalidReactionRequestError extends Error {}

export interface ConversationReactionRouteAuthorityV1 {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  csrf?(request: Request): boolean;
  rootSessionId(conversationId: string): string | null | Promise<string | null>;
  interactions: Pick<ConversationSocialAuthorityV1, "humanToggle" | "projection">;
}

interface ReactionRequestV1 {
  schema_version: "1.0";
  idempotency_key: string;
  mode: "toggle-self";
  emoji: Parameters<ConversationSocialAuthorityV1["humanToggle"]>[0]["emoji"];
  message_ref: PublicMessageLocatorV1;
}

function decodeRequest(value: unknown, targetEventId: string): ReactionRequestV1 {
  if (!value || typeof value !== "object" || Array.isArray(value))
    throw new InvalidReactionRequestError("invalid reaction request");
  const row = value as Record<string, unknown>;
  const keys = ["schema_version", "idempotency_key", "mode", "emoji", "message_ref"];
  if (
    Object.keys(row).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(row, key)) ||
    row.schema_version !== "1.0" ||
    typeof row.idempotency_key !== "string" ||
    row.idempotency_key.length < 1 ||
    Buffer.byteLength(row.idempotency_key, "utf8") > 200 ||
    row.mode !== "toggle-self" ||
    !isReactionEmojiV1(row.emoji)
  )
    throw new InvalidReactionRequestError("invalid reaction request");
  try {
    assertPublicMessageLocatorV1(row.message_ref);
  } catch {
    throw new InvalidReactionRequestError("invalid reaction request");
  }
  if (row.message_ref.target_event_id !== targetEventId)
    throw new Error("reaction target route mismatch");
  return {
    schema_version: "1.0",
    idempotency_key: row.idempotency_key,
    mode: "toggle-self",
    emoji: row.emoji,
    message_ref: structuredClone(row.message_ref),
  };
}

async function body(request: Request, targetEventId: string): Promise<ReactionRequestV1> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new InvalidReactionRequestError("invalid reaction content type");
  try {
    return decodeRequest(
      parseStrictJson(await readBoundedUtf8Body(request, MAX_BODY_BYTES)),
      targetEventId,
    );
  } catch (error) {
    if (error instanceof BoundedRequestBodyError || error instanceof InvalidReactionRequestError)
      throw error;
    throw new InvalidReactionRequestError("invalid reaction request");
  }
}

/** Authenticated social mutation; toggle selection and append happen under one writer lock. */
export async function handleConversationReactionRoute(
  authority: ConversationReactionRouteAuthorityV1,
  request: Request,
  conversationId: string,
  targetEventId: string,
): Promise<Response> {
  if (!authority.sessions.authorize(request))
    return conversationReadError(PUBLIC_ERROR_CODE.UNAUTHENTICATED, {
      message: "Authentication is required.",
    });
  if (request.method !== "POST")
    return conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
      message: "The requested resource was not found.",
    });
  if (authority.csrf && !authority.csrf(request))
    return conversationReadError(PUBLIC_ERROR_CODE.FORBIDDEN, {
      message: "CSRF validation failed.",
    });
  try {
    const root = await authority.rootSessionId(conversationId);
    if (!root) throw new Error("reaction target unavailable");
    const input = await body(request, targetEventId);
    if (input.message_ref.root_session_id !== root) throw new Error("reaction target unavailable");
    const principal = deriveBrowserActionAuthority(request, root);
    const operation = authority.interactions.humanToggle({
      conversation_id: conversationId,
      actor_public_id: principal.actor.public_actor_id,
      idempotency_key: input.idempotency_key,
      target: input.message_ref,
      emoji: input.emoji,
    });
    const projection = authority.interactions.projection(
      conversationId,
      principal.actor.public_actor_id,
    );
    if (projection.state !== "ready")
      throw new ConversationInteractionCorruptError("interaction projection degraded");
    return Response.json(
      {
        schema_version: "1.0",
        message_ref: structuredClone(operation.target),
        reactions: projection.reaction_projections.filter(
          (item) => item.target.target_event_id === targetEventId,
        ),
        folded_at: operation.created_at,
      },
      { headers: { "cache-control": "no-store" } },
    );
  } catch (error) {
    if (error instanceof ConversationInteractionCorruptError)
      return conversationReadError(PUBLIC_ERROR_CODE.AUTHORITY_CORRUPT, {
        message: "Conversation interaction authority is corrupt.",
        recoveryAction: PUBLIC_RECOVERY_ACTION.REPAIR_AUTHORITY,
      });
    if (error instanceof BoundedRequestBodyError || error instanceof InvalidReactionRequestError)
      return conversationReadError(PUBLIC_ERROR_CODE.INVALID_REQUEST, {
        message: "The reaction body is invalid.",
      });
    return conversationReadError(PUBLIC_ERROR_CODE.NOT_FOUND, {
      message: "The message was not found.",
    });
  }
}
