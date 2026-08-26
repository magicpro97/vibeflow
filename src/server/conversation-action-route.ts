import {
  ActionConflictError,
  type ActionRequestAuthorityV1,
  ActionValidationError,
  httpStatusForPublicError,
  parseActionApprovalChallengeRequestJson,
  parseActionApprovalRequestJson,
  parseActionCancelRequestJson,
  parseActionCommitRequestJson,
  parseActionProposalRequestJson,
} from "../actions/index.js";
import { CapabilityConversationSourceStaleError } from "../orchestrator/conversation/capability-proposal-base.js";
import type { ConversationActionCursorCodec } from "../orchestrator/conversation/conversation-action-cursor.js";
import {
  ConversationActionCursorError,
  StaleConversationActionCursorError,
} from "../orchestrator/conversation/conversation-action-cursor.js";
import { ConversationActionTargetUnsupportedError } from "../orchestrator/conversation/conversation-action-domain.js";
import type { ConversationActionDomainRegistryV1 } from "../orchestrator/conversation/conversation-action-registry.js";
import { ConversationHandoffTooLargeError } from "../orchestrator/conversation/revision-errors.js";
import {
  ConversationControlConflictError,
  ConversationNotFoundError,
} from "../orchestrator/conversation/service.js";
import { BoundedRequestBodyError, readBoundedUtf8Body } from "./bounded-request-body.js";
import { operationActionEvents } from "./conversation-action-events-route.js";
import { anchoredActionList, pendingActionList } from "./conversation-action-list-route.js";
import { deriveBrowserActionAuthority } from "./conversation-action-principal.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import { conversationReadError } from "./conversation-list-route.js";

const MAX_BODY_BYTES = 1024 * 1024;
const PROPOSAL = /^vf-proposal-[0-9a-f]{64}$/;

export interface ConversationActionRouteAuthorityV1 {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  csrf?(request: Request): boolean;
  actions: ConversationActionDomainRegistryV1;
  actionCursors?: ConversationActionCursorCodec;
  actionHeartbeatMs?: number;
  rootSessionId(conversationId: string): string | null | Promise<string | null>;
  principal?(request: Request, rootSessionId: string): ActionRequestAuthorityV1;
}

async function bodyText(request: Request): Promise<string> {
  if (request.headers.get("content-type")?.split(";", 1)[0]?.trim() !== "application/json")
    throw new ActionValidationError("content type must be application/json");
  const declared = request.headers.get("content-length");
  if (declared && (!/^\d+$/.test(declared) || Number(declared) > MAX_BODY_BYTES))
    throw new ActionValidationError("JSON body exceeds byte limit");
  try {
    return await readBoundedUtf8Body(request, MAX_BODY_BYTES);
  } catch (error) {
    if (error instanceof BoundedRequestBodyError)
      throw new ActionValidationError("JSON body exceeds byte limit");
    throw error;
  }
}

function actionError(error: unknown): Response {
  if (error instanceof ConversationHandoffTooLargeError)
    return Response.json(error.public_error, {
      status: httpStatusForPublicError(error.public_error.error.code),
      headers: { "cache-control": "no-store" },
    });
  if (error instanceof ActionConflictError)
    return Response.json(error.public_error, {
      status: httpStatusForPublicError(error.public_error.error.code),
      headers: { "cache-control": "no-store" },
    });
  if (error instanceof ActionValidationError)
    return conversationReadError(error.code, { message: "The action request is invalid." });
  if (error instanceof ConversationActionCursorError)
    return conversationReadError("invalid_request", {
      message: "The action cursor is invalid.",
    });
  if (error instanceof StaleConversationActionCursorError)
    return conversationReadError(error.code, {
      message: "The action proposal set changed during pagination.",
      recoveryAction: "restart-pagination",
      details:
        error.code === "stale_pending_proposal_cursor"
          ? { restart_cursor: error.restart_cursor, authority_watermark: error.watermark }
          : { restart_cursor: error.restart_cursor, proposal_set_watermark: error.watermark },
    });
  if (error instanceof ConversationActionTargetUnsupportedError)
    return conversationReadError("target_unsupported", {
      message: error.message,
      details: error.action_type === null ? null : { action_type: error.action_type },
    });
  if (error instanceof ConversationNotFoundError)
    return conversationReadError("not_found", { message: "The conversation was not found." });
  if (
    error instanceof ConversationControlConflictError ||
    error instanceof CapabilityConversationSourceStaleError
  )
    return conversationReadError("stale_conversation", {
      message: "The writable conversation revision changed.",
      recoveryAction: "refresh-proposal",
    });
  return conversationReadError("service_unavailable", {
    message: "The action authority is unavailable.",
    retryable: true,
    recoveryAction: "retry",
  });
}

function noStore(body: unknown, status = 200): Response {
  return Response.json(body, { status, headers: { "cache-control": "no-store" } });
}

async function readMutationContext(
  authority: ConversationActionRouteAuthorityV1,
  request: Request,
  conversationId: string,
) {
  const root = await authority.rootSessionId(conversationId);
  if (!root) throw new ConversationNotFoundError("conversation not found");
  return authority.principal?.(request, root) ?? deriveBrowserActionAuthority(request, root);
}

async function commitActionMutation(
  authority: ConversationActionRouteAuthorityV1,
  context: {
    conversation_id: string;
    proposal_id: string;
    authority: ActionRequestAuthorityV1;
  },
  source: string,
): Promise<Response> {
  const result = await authority.actions.commit({
    ...context,
    request: parseActionCommitRequestJson(source),
  });
  const terminal = ["succeeded", "failed", "needs_recovery"].includes(result.operation.state);
  return noStore(result, terminal ? 200 : 202);
}

/** Handles only the additive typed-action subroutes; unmatched paths return null. */
export async function handleConversationActionRoute(
  authority: ConversationActionRouteAuthorityV1,
  request: Request,
  url: URL,
  conversationId: string,
  path: readonly string[],
): Promise<Response | null> {
  const [resource, proposalId, mutation] = path;
  if (resource !== "action-proposals" && resource !== "action-operations") return null;
  if (!authority.sessions.authorize(request))
    return conversationReadError("unauthenticated", { message: "Authentication is required." });
  if (request.method === "POST" && authority.csrf && !authority.csrf(request))
    return conversationReadError("forbidden", { message: "CSRF validation failed." });
  try {
    if (resource === "action-operations" && path.length === 1 && request.method === "GET")
      return await anchoredActionList(authority, url, conversationId);
    if (resource !== "action-proposals") return null;
    if (path.length === 1 && request.method === "GET")
      return await pendingActionList(authority, url, conversationId);
    if (path.length === 1 && request.method === "POST") {
      const body = parseActionProposalRequestJson(await bodyText(request));
      const principal = await readMutationContext(authority, request, conversationId);
      const result = await authority.actions.propose({
        conversation_id: conversationId,
        request: body,
        authority: principal,
      });
      return noStore(result.response, result.created ? 201 : 200);
    }
    if (!proposalId || !PROPOSAL.test(proposalId)) return null;
    if (path.length === 2 && request.method === "GET") {
      const view = await authority.actions.get(conversationId, proposalId);
      return view
        ? noStore(view)
        : conversationReadError("not_found", { message: "The proposal was not found." });
    }
    if (path.length === 3 && mutation === "events" && request.method === "GET")
      return await operationActionEvents(authority, request, url, conversationId, proposalId);
    if (path.length !== 3 || request.method !== "POST") return null;
    const principal = await readMutationContext(authority, request, conversationId);
    const source = await bodyText(request);
    const context = {
      conversation_id: conversationId,
      proposal_id: proposalId,
      authority: principal,
    };
    if (mutation === "approval-challenge")
      return noStore(
        await authority.actions.challenge({
          ...context,
          request: parseActionApprovalChallengeRequestJson(source),
        }),
        201,
      );
    if (mutation === "approval")
      return noStore(
        await authority.actions.approve({
          ...context,
          request: parseActionApprovalRequestJson(source),
        }),
      );
    if (mutation === "commit") return commitActionMutation(authority, context, source);
    if (mutation === "cancel")
      return noStore(
        await authority.actions.cancel({
          ...context,
          request: parseActionCancelRequestJson(source),
        }),
      );
    return null;
  } catch (error) {
    return actionError(error);
  }
}
