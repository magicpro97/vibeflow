import { assertPrivateFileRangeHandoffBindingV1 } from "../orchestrator/conversation/private-file-range-staging-store.js";
import type {
  ApprovalDecision,
  ConversationCreateParticipant,
  ConversationCreateRequest,
  ConversationService,
  MessageRequest,
  OperationCancelCommand,
} from "../orchestrator/conversation/types.js";
import {
  type ConversationArtifactAuthority,
  handleConversationArtifact,
} from "./conversation-artifact.js";
import type {
  ConversationSessionAuthority,
  ConversationStreamTokenAuthority,
} from "./conversation-auth.js";
import {
  type ConversationBrowserHttpAuthorityV1,
  handleOptionalConversationBrowserRoute,
} from "./conversation-browser-route.js";
import { decodeConversationMessageRequest } from "./conversation-message-request.js";
import { conversationRouteError } from "./conversation-route-error.js";
import { handleConversationSse } from "./conversation-sse.js";

const PREFIX = "/api/conversations";
const BODY_LIMIT = 64 * 1024;
const TEXT_LIMIT = 32 * 1024;
const SHORT_LIMIT = 256;
const REASON_LIMIT = 4 * 1024;
const PARTICIPANT_LIMIT = 64;
const ROUND_LIMIT = 100;
const ENGINES = new Set(["claude", "codex", "copilot", "opencode", "antigravity"]);
const ID_PATTERN = /^[A-Za-z0-9_-]{1,200}$/;
const APPROVAL_TOKEN_PATTERN = /^approval:[0-9a-f]{64}$/;

type JsonObject = Record<string, unknown>;
type ParsedBody = { ok: true; body: JsonObject } | { ok: false };

export interface ConversationHttpAuthority {
  service: ConversationService;
  sessions: Pick<ConversationSessionAuthority, "authorize" | "issueCookie" | "loopback">;
  streamTokens: Pick<ConversationStreamTokenAuthority, "authorize" | "issue">;
  privateFileRanges?: {
    createId(): string;
    stage(input: {
      handoff_id: string;
      repo_relative_path: string;
      start_line: number;
      end_line: number;
      content: string;
      staged_at: string;
    }): unknown;
  };
  artifacts?: ConversationArtifactAuthority;
  csrf?(request: Request): boolean;
  heartbeatMs?: number;
  browser?: Omit<ConversationBrowserHttpAuthorityV1, "sessions" | "csrf">;
}

export { isConversationNamespace } from "./conversation-browser-route.js";

const response = (status: number, code: string): Response =>
  Response.json({ code }, { status, headers: { "cache-control": "no-store" } });
const accepted = (body: unknown, headers?: Record<string, string>): Response =>
  Response.json(body, { status: 202, headers: { "cache-control": "no-store", ...headers } });

function exactKeys(value: JsonObject, allowed: readonly string[]): boolean {
  const keys = Object.keys(value);
  return keys.length <= allowed.length && keys.every((key) => allowed.includes(key));
}

function boundedString(value: unknown, limit: number): value is string {
  return (
    typeof value === "string" &&
    value.trim().length > 0 &&
    !value.includes("\0") &&
    Buffer.byteLength(value) <= limit
  );
}

async function readBoundedJson(request: Request): Promise<ParsedBody> {
  const declared = request.headers.get("content-length");
  if (declared !== null && (!/^(0|[1-9][0-9]*)$/.test(declared) || Number(declared) > BODY_LIMIT))
    return { ok: false };
  if (!request.body) return { ok: true, body: {} };
  const mediaType = request.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase();
  if (mediaType !== "application/json") return { ok: false };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      const part = await reader.read();
      if (part.done) break;
      size += part.value.byteLength;
      if (size > BODY_LIMIT) {
        await reader.cancel();
        return { ok: false };
      }
      chunks.push(part.value);
    }
  } catch {
    return { ok: false };
  }
  if (!size) return { ok: true, body: {} };
  const bytes = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  let decoded: string;
  try {
    decoded = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { ok: false };
  }
  let value: unknown;
  try {
    value = JSON.parse(decoded);
  } catch {
    return { ok: false };
  }
  if (value === null || typeof value !== "object" || Array.isArray(value)) return { ok: false };
  return { ok: true, body: value as JsonObject };
}

function createRequest(body: JsonObject): ConversationCreateRequest | null {
  if (!exactKeys(body, ["topic", "policy", "participants", "max_rounds", "private_file_range"]))
    return null;
  if (!boundedString(body.topic, TEXT_LIMIT)) return null;
  if (body.policy !== undefined && !boundedString(body.policy, SHORT_LIMIT)) return null;
  if (
    body.max_rounds !== undefined &&
    (typeof body.max_rounds !== "number" ||
      !Number.isSafeInteger(body.max_rounds) ||
      body.max_rounds < 1 ||
      body.max_rounds > ROUND_LIMIT)
  )
    return null;
  let participants: ConversationCreateParticipant[] | undefined;
  if (body.participants !== undefined) {
    if (
      !Array.isArray(body.participants) ||
      body.participants.length < 1 ||
      body.participants.length > PARTICIPANT_LIMIT
    )
      return null;
    participants = [];
    for (const value of body.participants) {
      if (value === null || typeof value !== "object" || Array.isArray(value)) return null;
      const participant = value as JsonObject;
      if (!exactKeys(participant, ["role_ref", "engine", "model"])) return null;
      if (
        !boundedString(participant.role_ref, SHORT_LIMIT) ||
        !boundedString(participant.engine, SHORT_LIMIT) ||
        !ENGINES.has(participant.engine)
      )
        return null;
      if (participant.model !== undefined && !boundedString(participant.model, SHORT_LIMIT))
        return null;
      participants.push({
        role_ref: participant.role_ref,
        engine: participant.engine,
        ...(participant.model === undefined ? {} : { model: participant.model as string }),
      });
    }
  }
  let privateFileRange: ConversationCreateRequest["private_file_range"];
  if (body.private_file_range !== undefined) {
    try {
      assertPrivateFileRangeHandoffBindingV1(body.private_file_range);
      privateFileRange = structuredClone(body.private_file_range);
    } catch {
      return null;
    }
  }
  return {
    topic: body.topic,
    ...(body.policy === undefined ? {} : { policy: body.policy as string }),
    ...(participants === undefined ? {} : { participants }),
    ...(body.max_rounds === undefined ? {} : { max_rounds: body.max_rounds as number }),
    ...(privateFileRange ? { private_file_range: privateFileRange } : {}),
  };
}

function emptyRequest(body: JsonObject): boolean {
  return exactKeys(body, []) && Object.keys(body).length === 0;
}

function approvalRequest(body: JsonObject): ApprovalDecision | null {
  if (!exactKeys(body, ["approval_id", "operation_id", "actor", "outcome", "reason"])) return null;
  if (
    !Object.hasOwn(body, "reason") ||
    !approvalRouteId(body.approval_id) ||
    !routeId(body.operation_id) ||
    !boundedString(body.actor, SHORT_LIMIT) ||
    (body.outcome !== "approve" && body.outcome !== "reject") ||
    (body.reason !== null &&
      (typeof body.reason !== "string" || Buffer.byteLength(body.reason) > REASON_LIMIT))
  )
    return null;
  return {
    approval_id: body.approval_id,
    operation_id: body.operation_id,
    actor: body.actor,
    outcome: body.outcome,
    reason: body.reason,
  };
}

function cancellationRequest(body: JsonObject): OperationCancelCommand | null {
  if (!exactKeys(body, ["conversation_id", "operation_id", "actor", "reason"])) return null;
  if (
    !Object.hasOwn(body, "reason") ||
    !routeId(body.conversation_id) ||
    !routeId(body.operation_id) ||
    !boundedString(body.actor, SHORT_LIMIT) ||
    (body.reason !== null &&
      (typeof body.reason !== "string" || Buffer.byteLength(body.reason) > REASON_LIMIT))
  )
    return null;
  return {
    conversation_id: body.conversation_id,
    operation_id: body.operation_id,
    actor: body.actor,
    reason: body.reason,
  };
}

function segments(url: URL): string[] | null {
  if (url.pathname === PREFIX) return [];
  const raw = url.pathname.slice(`${PREFIX}/`.length).split("/");
  const decoded: string[] = [];
  try {
    for (const value of raw) decoded.push(decodeURIComponent(value));
  } catch {
    return null;
  }
  if (decoded.some((value) => !value || value.includes("/") || value.includes("\\"))) return null;
  return decoded;
}

function routeId(value: unknown): value is string {
  return typeof value === "string" && ID_PATTERN.test(value);
}

function approvalRouteId(value: unknown): value is string {
  return routeId(value) || (typeof value === "string" && APPROVAL_TOKEN_PATTERN.test(value));
}

async function parsedBody(request: Request): Promise<JsonObject | Response> {
  const parsed = await readBoundedJson(request);
  return parsed.ok ? parsed.body : response(400, "invalid_request");
}

export async function handleConversationRoute(
  authority: ConversationHttpAuthority,
  request: Request,
  url: URL,
): Promise<Response> {
  const browser = await handleOptionalConversationBrowserRoute(
    authority.browser,
    authority.sessions,
    authority.csrf,
    request,
    url,
  );
  if (browser) return browser;
  if (!url.pathname.startsWith(PREFIX)) return response(404, "route_not_found");
  const path = segments(url);
  if (path === null) return response(400, "invalid_request");
  const [conversationId, action, identity, tail] = path;
  if (
    request.method === "GET" &&
    path.length === 2 &&
    routeId(conversationId) &&
    action === "events"
  ) {
    return handleConversationSse(
      {
        service: authority.service,
        tokens: authority.streamTokens,
        ...(authority.heartbeatMs === undefined ? {} : { heartbeatMs: authority.heartbeatMs }),
      },
      request,
      url,
      conversationId,
    );
  }
  if (!authority.sessions.authorize(request)) return response(401, "unauthorized");
  if (request.method === "POST" && authority.sessions.loopback && !authority.csrf?.(request))
    return response(403, "forbidden");

  try {
    if (request.method === "POST" && path.length === 0) {
      const body = await parsedBody(request);
      if (body instanceof Response) return body;
      const input = createRequest(body);
      if (!input) return response(400, "invalid_request");
      const started = await authority.service.start(input);
      const token = authority.streamTokens.issue(started.conversation_id);
      return accepted(
        { conversation_id: started.conversation_id, ...token },
        { location: `/api/conversations/${encodeURIComponent(started.conversation_id)}` },
      );
    }
    if (!routeId(conversationId)) return response(404, "route_not_found");
    if (request.method === "GET" && path.length === 2 && action === "snapshot") {
      const value = await authority.service.snapshot(conversationId);
      return value
        ? Response.json(value, { headers: { "cache-control": "no-store" } })
        : response(404, "conversation_not_found");
    }
    if (request.method === "GET" && path.length === 3 && action === "artifacts" && identity) {
      if (!authority.artifacts) return response(500, "artifact_authority_unavailable");
      // A clean process starts with an empty opaque-id registry. Replaying the canonical
      // trace repopulates it before resolution without accepting a client-supplied path.
      if (!(await authority.service.snapshot(conversationId)))
        return response(404, "conversation_not_found");
      return handleConversationArtifact(
        authority.artifacts,
        request,
        url,
        conversationId,
        identity,
      );
    }
    if (request.method !== "POST") return response(404, "route_not_found");
    const body = await parsedBody(request);
    if (body instanceof Response) return body;
    if (path.length === 2 && action === "messages") {
      const input = decodeConversationMessageRequest(body);
      if (!input) return response(400, "invalid_request");
      const value = await authority.service.message(conversationId, input);
      return accepted(value, value.location ? { location: value.location } : undefined);
    }
    if (path.length === 2 && (action === "pause" || action === "resume" || action === "stop")) {
      if (!emptyRequest(body)) return response(400, "invalid_request");
      const value =
        action === "pause"
          ? await authority.service.pause(conversationId)
          : action === "resume"
            ? await authority.service.resume(conversationId)
            : await authority.service.stop(conversationId);
      return accepted(value);
    }
    if (path.length === 2 && action === "stream-token") {
      if (!emptyRequest(body)) return response(400, "invalid_request");
      if (!(await authority.service.snapshot(conversationId)))
        return response(404, "conversation_not_found");
      return accepted(authority.streamTokens.issue(conversationId));
    }
    if (
      path.length === 4 &&
      action === "approvals" &&
      approvalRouteId(identity) &&
      tail === "resolve"
    ) {
      const input = approvalRequest(body);
      if (!input) return response(400, "invalid_request");
      if (input.approval_id !== identity) return response(409, "approval_route_body_mismatch");
      const value = await authority.service.resolveApproval(conversationId, input);
      return Response.json(value.body, {
        status: value.status,
        headers: { "cache-control": "no-store" },
      });
    }
    if (path.length === 4 && action === "operations" && routeId(identity) && tail === "cancel") {
      const input = cancellationRequest(body);
      if (!input) return response(400, "invalid_request");
      if (input.operation_id !== identity) return response(409, "operation_route_body_mismatch");
      if (input.conversation_id !== conversationId)
        return response(409, "operation_conversation_mismatch");
      const value = await authority.service.cancelOperation(input);
      return Response.json(value.body, {
        status: value.status,
        headers: { "cache-control": "no-store" },
      });
    }
    return response(404, "route_not_found");
  } catch (error) {
    return conversationRouteError(error);
  }
}
