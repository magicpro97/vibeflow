import { PUBLIC_ERROR_CODE, PUBLIC_RECOVERY_ACTION } from "../actions/public-error-contract.js";
import {
  type ConversationActionRouteAuthorityV1,
  handleConversationActionRoute,
} from "./conversation-action-route.js";
import type { ConversationSessionAuthority } from "./conversation-auth.js";
import type { ReturnTypeOfBrowserAuthorities } from "./conversation-browser-route-types.js";
import { handleConversationHandoffRoute } from "./conversation-handoff-route.js";
import { handleConversationHeadRoute } from "./conversation-head-route.js";
import {
  type ConversationLegacyAdoptRouteAuthorityV1,
  handleConversationLegacyAdoptRoute,
} from "./conversation-legacy-adopt-route.js";
import { handleConversationLineageRoute } from "./conversation-lineage-route.js";
import { conversationReadError, handleConversationListRoute } from "./conversation-list-route.js";
import {
  type ConversationMessageQueueHttpAuthorityV1,
  handleConversationDraftPrivateContextRoute,
  handleConversationMessageQueueRoute,
} from "./conversation-message-queue-route.js";
import { handleConversationReactionRoute } from "./conversation-reaction-route.js";
import { handleConversationTimelineRoute } from "./conversation-timeline-route.js";

const CONVERSATIONS = "/api/conversations";
const SESSIONS = "/api/conversation-sessions";
const DRAFTS = "/api/conversation-drafts";

export interface ConversationBrowserHttpAuthorityV1 extends ReturnTypeOfBrowserAuthorities {
  sessions: Pick<ConversationSessionAuthority, "authorize">;
  csrf?(request: Request): boolean;
  principal?: ConversationActionRouteAuthorityV1["principal"];
  legacyAdopt?: ConversationLegacyAdoptRouteAuthorityV1["legacyAdopt"];
  messageQueue?: ConversationMessageQueueHttpAuthorityV1["queue"];
}

export function isConversationNamespace(path: string): boolean {
  return (
    path === CONVERSATIONS ||
    path.startsWith(`${CONVERSATIONS}/`) ||
    path === SESSIONS ||
    path.startsWith(`${SESSIONS}/`) ||
    path === DRAFTS ||
    path.startsWith(`${DRAFTS}/`)
  );
}

export async function handleOptionalConversationBrowserRoute(
  browser: Omit<ConversationBrowserHttpAuthorityV1, "sessions" | "csrf"> | undefined,
  sessions: ConversationBrowserHttpAuthorityV1["sessions"],
  csrf: ConversationBrowserHttpAuthorityV1["csrf"],
  request: Request,
  url: URL,
): Promise<Response | null> {
  if (!browser) return null;
  return handleConversationBrowserRoute(
    { ...browser, sessions, ...(csrf ? { csrf } : {}) },
    request,
    url,
  );
}

function decodedPath(pathname: string, prefix: string): string[] | null {
  if (pathname === prefix) return [];
  if (!pathname.startsWith(`${prefix}/`)) return null;
  try {
    const values = pathname
      .slice(prefix.length + 1)
      .split("/")
      .map(decodeURIComponent);
    return values.some((value) => !value || value.includes("/") || value.includes("\\"))
      ? null
      : values;
  } catch {
    return null;
  }
}

/** Composes the additive catalog/lineage/timeline/handoff/action browser API. */
export async function handleConversationBrowserRoute(
  authority: ConversationBrowserHttpAuthorityV1,
  request: Request,
  url: URL,
): Promise<Response | null> {
  const drafts = decodedPath(url.pathname, DRAFTS);
  if (drafts) {
    if (!authority.messageQueue) return null;
    if (drafts.length === 1 && drafts[0] === "private-context")
      return handleConversationDraftPrivateContextRoute(
        {
          sessions: authority.sessions,
          csrf: authority.csrf,
          principal: authority.principal,
          queue: authority.messageQueue,
        },
        request,
        false,
      );
    if (drafts.length === 2 && drafts[0] === "private-context" && drafts[1] === "discard")
      return handleConversationDraftPrivateContextRoute(
        {
          sessions: authority.sessions,
          csrf: authority.csrf,
          principal: authority.principal,
          queue: authority.messageQueue,
        },
        request,
        true,
      );
    return null;
  }
  const sessions = decodedPath(url.pathname, SESSIONS);
  if (sessions) {
    const [rootSessionId, resource, ...tail] = sessions;
    if (!rootSessionId) return null;
    if (resource === "messages" && authority.messageQueue && tail.length > 0)
      return handleConversationMessageQueueRoute(
        {
          sessions: authority.sessions,
          csrf: authority.csrf,
          principal: authority.principal,
          queue: authority.messageQueue,
        },
        request,
        rootSessionId,
        tail,
      );
    if (sessions.length !== 2) return null;
    if (resource === "head") return handleConversationHeadRoute(authority, request, rootSessionId);
    if (resource === "timeline")
      return handleConversationTimelineRoute(authority, request, url, rootSessionId);
    return null;
  }
  const path = decodedPath(url.pathname, CONVERSATIONS);
  if (!path) return null;
  if (path.length === 0 && request.method === "GET")
    return handleConversationListRoute(authority, request, url);
  const [conversationId, resource] = path;
  if (!conversationId) return null;
  if (path.length === 2 && resource === "lineage")
    return handleConversationLineageRoute(authority, request, url, conversationId);
  if (path.length === 2 && resource === "context-handoff")
    return handleConversationHandoffRoute(authority, request, conversationId);
  if (path.length === 2 && resource === "legacy-adopt-candidates")
    return authority.legacyAdopt
      ? handleConversationLegacyAdoptRoute(
          {
            sessions: authority.sessions,
            csrf: authority.csrf,
            rootSessionId: authority.rootSessionId,
            principal: authority.principal,
            legacyAdopt: authority.legacyAdopt,
          },
          request,
          conversationId,
        )
      : conversationReadError(PUBLIC_ERROR_CODE.SERVICE_UNAVAILABLE, {
          message: "Legacy adoption inspection is unavailable.",
          retryable: true,
          recoveryAction: PUBLIC_RECOVERY_ACTION.RETRY,
        });
  if (path.length === 4 && resource === "events" && path[2] && path[3] === "reactions")
    return handleConversationReactionRoute(
      {
        sessions: authority.sessions,
        csrf: authority.csrf,
        rootSessionId: authority.rootSessionId,
        interactions: authority.interactions,
      },
      request,
      conversationId,
      path[2],
    );
  return handleConversationActionRoute(
    {
      sessions: authority.sessions,
      csrf: authority.csrf,
      actions: authority.actions,
      actionCursors: authority.actionCursors,
      rootSessionId: authority.rootSessionId,
      principal: authority.principal,
    },
    request,
    url,
    conversationId,
    path.slice(1),
  );
}
