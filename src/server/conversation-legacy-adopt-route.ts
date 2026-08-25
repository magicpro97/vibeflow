import {
  ActionConflictError,
  type ActionRequestAuthorityV1,
  ActionValidationError,
} from "../actions/index.js";
import { parseStrictJson } from "../actions/strict-json.js";
import type { LegacyAdoptInspectionResultV1 } from "../capabilities/legacy/issuance-record.js";
import { validateLegacyAdoptInspectionRequest } from "../capabilities/legacy/request-validation.js";
import type { LegacyAdoptInspectionRequestV1 } from "../capabilities/legacy/types.js";
import { CapabilityRuntimeError } from "../capabilities/operations/errors.js";
import { CapabilityValidationError } from "../capabilities/wire/primitives.js";
import {
  ConversationControlConflictError,
  ConversationNotFoundError,
} from "../orchestrator/conversation/service.js";
import { BoundedRequestBodyError, readBoundedUtf8Body } from "./bounded-request-body.js";
import { deriveBrowserActionAuthority } from "./conversation-action-principal.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import { conversationReadError } from "./conversation-list-route.js";

const MAX_BODY_BYTES = 1024 * 1024;

export interface ConversationLegacyAdoptRouteAuthorityV1 {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  csrf?(request: Request): boolean;
  rootSessionId(conversationId: string): string | null | Promise<string | null>;
  principal?(request: Request, rootSessionId: string): ActionRequestAuthorityV1;
  legacyAdopt: {
    inspect(input: {
      conversation_id: string;
      request: LegacyAdoptInspectionRequestV1;
      authority: ActionRequestAuthorityV1;
    }): LegacyAdoptInspectionResultV1 | Promise<LegacyAdoptInspectionResultV1>;
  };
}

function errorResponse(error: unknown): Response {
  if (error instanceof ActionConflictError)
    return Response.json(error.public_error, {
      status: 409,
      headers: { "cache-control": "no-store" },
    });
  if (
    error instanceof ActionValidationError ||
    (error instanceof CapabilityValidationError && error.code !== "integrity_failure")
  )
    return conversationReadError("invalid_request", {
      message: "The legacy adoption inspection request is invalid.",
    });
  if (
    error instanceof CapabilityValidationError ||
    (error instanceof CapabilityRuntimeError && error.runtime_code === "integrity-failure")
  )
    return conversationReadError("authority_corrupt", {
      message: "Legacy adoption inspection authority is corrupt.",
      recoveryAction: "repair-authority",
    });
  if (error instanceof ConversationNotFoundError)
    return conversationReadError("not_found", { message: "The conversation was not found." });
  if (error instanceof ConversationControlConflictError)
    return conversationReadError("stale_conversation", {
      message: "The writable conversation revision changed.",
      recoveryAction: "refresh-proposal",
    });
  return conversationReadError("service_unavailable", {
    message: "Legacy adoption inspection is unavailable.",
    retryable: true,
    recoveryAction: "retry",
  });
}

async function requestBody(request: Request): Promise<LegacyAdoptInspectionRequestV1> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new ActionValidationError("content type must be application/json");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new ActionValidationError("JSON body exceeds byte limit");
  try {
    const source = await readBoundedUtf8Body(request, MAX_BODY_BYTES);
    return validateLegacyAdoptInspectionRequest(parseStrictJson(source) as never);
  } catch (error) {
    if (error instanceof BoundedRequestBodyError)
      throw new ActionValidationError("JSON body exceeds byte limit");
    throw error;
  }
}

/** Authenticated, CSRF-protected inert legacy inspection issuance. */
export async function handleConversationLegacyAdoptRoute(
  authority: ConversationLegacyAdoptRouteAuthorityV1,
  request: Request,
  conversationId: string,
): Promise<Response> {
  if (!authority.sessions.authorize(request))
    return conversationReadError("unauthenticated", { message: "Authentication is required." });
  if (request.method !== "POST")
    return conversationReadError("not_found", { message: "The requested resource was not found." });
  if (authority.csrf && !authority.csrf(request))
    return conversationReadError("forbidden", { message: "CSRF validation failed." });
  try {
    const root = await authority.rootSessionId(conversationId);
    if (!root) throw new ConversationNotFoundError("conversation not found");
    const principal =
      authority.principal?.(request, root) ?? deriveBrowserActionAuthority(request, root);
    const result = await authority.legacyAdopt.inspect({
      conversation_id: conversationId,
      request: await requestBody(request),
      authority: principal,
    });
    return Response.json(result.response, {
      status: result.created ? 201 : 200,
      headers: { "cache-control": "no-store" },
    });
  } catch (error) {
    return errorResponse(error);
  }
}
