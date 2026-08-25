import { ActionValidationError } from "../actions/index.js";
import { digestV1 } from "../durability/index.js";
import type {
  ConversationActionCursorCodec,
  ConversationActionCursorTupleV1,
} from "../orchestrator/conversation/conversation-action-cursor.js";
import type { ConversationActionDomainRegistryV1 } from "../orchestrator/conversation/conversation-action-registry.js";

const SAFE_ID = /^[A-Za-z0-9_-]{1,200}$/;

interface ListAuthority {
  actions: ConversationActionDomainRegistryV1;
  actionCursors?: ConversationActionCursorCodec;
}

function noStore(body: unknown): Response {
  return Response.json(body, { headers: { "cache-control": "no-store" } });
}

function listLimit(url: URL, maximum: number, fallback: number): number {
  const values = url.searchParams.getAll("limit");
  if (values.length > 1) throw new ActionValidationError("duplicate limit");
  if (!values.length) return fallback;
  const value = values[0] ?? "";
  if (!/^[1-9][0-9]*$/.test(value) || Number(value) > maximum)
    throw new ActionValidationError("invalid limit");
  return Number(value);
}

function pendingWatermark(
  conversationId: string,
  items: Awaited<ReturnType<ConversationActionDomainRegistryV1["pending"]>>,
) {
  return digestV1("VF-PENDING-ACTION-PROPOSAL-SET\0v1\0", {
    schema_version: "1.0",
    conversation_id: conversationId,
    proposals: items.map(({ proposal }) => ({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
    })),
  });
}

function anchoredWatermark(
  conversationId: string,
  revisionId: string,
  originEventId: string | null,
  rows: Awaited<ReturnType<ConversationActionDomainRegistryV1["anchored"]>>,
) {
  return digestV1("VF-ANCHORED-ACTION-PROPOSAL-SET\0v1\0", {
    schema_version: "1.0",
    conversation_id: conversationId,
    revision_id: revisionId,
    origin_event_id: originEventId,
    proposals: rows.map(({ proposal }) => ({
      proposal_id: proposal.proposal_id,
      proposal_digest: proposal.proposal_digest,
    })),
  });
}

function startIndex(
  rows: Awaited<ReturnType<ConversationActionDomainRegistryV1["pending"]>>,
  last: ConversationActionCursorTupleV1 | null,
): number {
  if (!last) return 0;
  const index = rows.findIndex(
    ({ proposal }) =>
      proposal.created_at === last.created_at && proposal.proposal_id === last.proposal_id,
  );
  if (index < 0) throw new ActionValidationError("cursor boundary is absent");
  return index + 1;
}

function tuple(
  row: Awaited<ReturnType<ConversationActionDomainRegistryV1["pending"]>>[number],
): ConversationActionCursorTupleV1 {
  return { created_at: row.proposal.created_at, proposal_id: row.proposal.proposal_id };
}

export async function pendingActionList(
  authority: ListAuthority,
  url: URL,
  conversationId: string,
): Promise<Response> {
  for (const key of url.searchParams.keys())
    if (!["state", "cursor", "limit"].includes(key))
      throw new ActionValidationError("unknown pending proposal query");
  if (url.searchParams.getAll("state").length !== 1 || url.searchParams.get("state") !== "pending")
    throw new ActionValidationError("state=pending is required");
  if (url.searchParams.getAll("cursor").length > 1)
    throw new ActionValidationError("duplicate pending proposal cursor");
  const items = await authority.actions.pending(conversationId);
  const limit = listLimit(url, 100, 50);
  const authorityWatermark = pendingWatermark(conversationId, items);
  const binding = {
    kind: "pending-actions" as const,
    conversation_id: conversationId,
    authority_watermark: authorityWatermark,
    limit,
    last: null,
  };
  const cursor = url.searchParams.get("cursor");
  if (cursor && !authority.actionCursors)
    throw new ActionValidationError("pending proposal cursor authority is absent");
  const last = cursor ? (authority.actionCursors?.validate(cursor, binding) ?? null) : null;
  const offset = startIndex(items, last);
  const page = items.slice(offset, offset + limit);
  const more = offset + page.length < items.length;
  const tail = page.at(-1);
  return noStore({
    schema_version: "1.0",
    items: page,
    next_cursor:
      more && authority.actionCursors && tail
        ? authority.actionCursors.encode({ ...binding, last: tuple(tail) })
        : null,
    authority_watermark: authorityWatermark,
  });
}

export async function anchoredActionList(
  authority: ListAuthority,
  url: URL,
  conversationId: string,
): Promise<Response> {
  const allowed = new Set(["anchor_kind", "anchor_event_id", "revision_id", "cursor", "limit"]);
  for (const key of url.searchParams.keys())
    if (!allowed.has(key)) throw new ActionValidationError("unknown action operation query");
  if (url.searchParams.getAll("cursor").length > 1)
    throw new ActionValidationError("duplicate action operation cursor");
  const kind = url.searchParams.get("anchor_kind");
  const revisionId = url.searchParams.get("revision_id");
  const eventId = url.searchParams.get("anchor_event_id");
  if (
    (kind !== "event" && kind !== "conversation-start") ||
    !revisionId ||
    !SAFE_ID.test(revisionId) ||
    (kind === "event" ? !eventId || !SAFE_ID.test(eventId) : eventId !== null && eventId !== "")
  )
    throw new ActionValidationError("invalid action operation anchor");
  const originEventId = kind === "event" ? (eventId as string) : null;
  const rows = await authority.actions.anchored({
    conversation_id: conversationId,
    revision_id: revisionId,
    origin_event_id: originEventId,
  });
  const limit = listLimit(url, 50, 20);
  const watermark = anchoredWatermark(conversationId, revisionId, originEventId, rows);
  const binding = {
    kind: "anchored-actions" as const,
    conversation_id: conversationId,
    revision_id: revisionId,
    origin_event_id: originEventId,
    proposal_set_watermark: watermark,
    limit,
    last: null,
  };
  const cursor = url.searchParams.get("cursor");
  if (cursor && !authority.actionCursors)
    throw new ActionValidationError("action operation cursor authority is absent");
  const last = cursor ? (authority.actionCursors?.validate(cursor, binding) ?? null) : null;
  const offset = startIndex(rows, last);
  const page = rows.slice(offset, offset + limit);
  const more = offset + page.length < rows.length;
  const tail = page.at(-1);
  return noStore({
    schema_version: "1.0",
    items: page.map(({ operation }) => operation),
    next_cursor:
      more && authority.actionCursors && tail
        ? authority.actionCursors.encode({ ...binding, last: tuple(tail) })
        : null,
    proposal_set_watermark: watermark,
  });
}
