import { ConversationMessageReferenceUnavailableError } from "../orchestrator/conversation/conversation-social-authority.js";
import { ConversationHandoffTooLargeError } from "../orchestrator/conversation/revision-errors.js";
import {
  CONVERSATION_ROUTING_ERROR_CODE,
  ConversationRoutingError,
} from "../orchestrator/conversation/router.js";
import {
  ConversationControlConflictError,
  ConversationInvalidTargetParticipantError,
  ConversationNotFoundError,
} from "../orchestrator/conversation/service.js";

const CLIENT_ROUTING_ERRORS = new Set<ConversationRoutingError["code"]>([
  CONVERSATION_ROUTING_ERROR_CODE.INVALID_ROUTING_INPUT,
  CONVERSATION_ROUTING_ERROR_CODE.UNKNOWN_EXPLICIT_POLICY,
  CONVERSATION_ROUTING_ERROR_CODE.UNKNOWN_EXPLICIT_ROLE,
  CONVERSATION_ROUTING_ERROR_CODE.EXPLICIT_ENGINE_UNAVAILABLE,
  CONVERSATION_ROUTING_ERROR_CODE.COORDINATE_EXECUTOR_UNAVAILABLE,
  CONVERSATION_ROUTING_ERROR_CODE.POLICY_UNAVAILABLE,
  CONVERSATION_ROUTING_ERROR_CODE.ROLE_UNAVAILABLE,
]);

const response = (status: number, code: string): Response =>
  Response.json({ code }, { status, headers: { "cache-control": "no-store" } });

export function conversationRouteError(error: unknown): Response {
  if (error instanceof ConversationHandoffTooLargeError)
    return Response.json(error.public_error, {
      status: 422,
      headers: { "cache-control": "no-store" },
    });
  if (error instanceof ConversationNotFoundError) return response(404, "conversation_not_found");
  if (error instanceof ConversationMessageReferenceUnavailableError)
    return response(404, "message_not_found");
  if (error instanceof ConversationControlConflictError)
    return response(409, "conversation_conflict");
  if (
    error instanceof ConversationInvalidTargetParticipantError ||
    (error instanceof ConversationRoutingError && CLIENT_ROUTING_ERRORS.has(error.code))
  )
    return response(400, "invalid_request");
  return response(500, "conversation_failed");
}
