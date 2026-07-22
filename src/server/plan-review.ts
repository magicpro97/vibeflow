import { readState } from "../core.js";
import { insertMarkers, parseBlocks } from "../plan-review/blocks.js";
import { createPlanReviewStore } from "../plan-review/store.js";
import type {
  CommentAnchor,
  CommentId,
  CreatedBy,
  PlanReviewBlock,
  PlanReviewRevisionId,
} from "../plan-review/types.js";
import { isValidCommentId, isValidRevisionId } from "../plan-review/types.js";
import { readRegistry } from "../registry.js";

function resolveSelection(
  repoPath: string,
  workflowId: string,
): { error: string; status: number } | null {
  if (!repoPath || !workflowId) return { error: "repoPath and workflowId required", status: 400 };
  const entries = readRegistry();
  if (!entries.find((e) => e.path === repoPath))
    return { error: "repo not found in registry", status: 400 };
  const state = readState(repoPath);
  if (!state || state.task_id !== workflowId) return { error: "workflow not found", status: 404 };
  return null;
}

export function handlePlanReviewGet(_activeRepo: string, url: URL): Response {
  const repoPath = url.searchParams.get("repoPath") ?? "";
  const workflowId = url.searchParams.get("workflowId") ?? "";
  const err = resolveSelection(repoPath, workflowId);
  if (err) return Response.json({ error: err.error }, { status: err.status });

  const store = createPlanReviewStore({ base: repoPath });
  const index = store.loadIndex();
  if (!index) return Response.json({ error: "no plan review found" }, { status: 404 });

  if (index.workflowId !== workflowId)
    return Response.json({ error: "index workflowId mismatch" }, { status: 400 });

  const rev = store.loadRevision(index.currentRevisionId);
  if (!rev) return Response.json({ error: "current revision not found" }, { status: 404 });

  if (rev.workflowId !== workflowId)
    return Response.json({ error: "revision workflowId mismatch" }, { status: 400 });

  const revisions = store.listRevisionsByWorkflow(workflowId);

  return Response.json({ index, revision: rev, revisions, blocks: rev.blocks });
}

export function handlePlanReviewPost(
  _activeRepo: string,
  payload: Record<string, unknown>,
): Response {
  const repoPath = typeof payload.repoPath === "string" ? payload.repoPath.trim() : "";
  const workflowId = typeof payload.workflowId === "string" ? payload.workflowId.trim() : "";
  const markdown = typeof payload.markdown === "string" ? payload.markdown : "";
  const createdByRaw = payload.createdBy;

  if (!repoPath) return Response.json({ error: "repoPath required" }, { status: 400 });
  if (!workflowId) return Response.json({ error: "workflowId required" }, { status: 400 });
  if (!markdown) return Response.json({ error: "markdown required" }, { status: 400 });

  if (!createdByRaw || typeof createdByRaw !== "object")
    return Response.json({ error: "createdBy required" }, { status: 400 });

  const cb = createdByRaw as Record<string, unknown>;
  const ctype = cb.type;
  if (ctype !== "user" && ctype !== "agent")
    return Response.json({ error: "createdBy.type must be 'user' or 'agent'" }, { status: 400 });
  if (typeof cb.id !== "string" || !cb.id.trim())
    return Response.json({ error: "createdBy.id required" }, { status: 400 });
  if (typeof cb.name !== "string" || !cb.name.trim())
    return Response.json({ error: "createdBy.name required" }, { status: 400 });

  const createdBy: CreatedBy =
    ctype === "agent"
      ? { type: "agent", id: cb.id.trim(), name: cb.name.trim() }
      : { type: "user", id: cb.id.trim(), name: cb.name.trim() };

  const err = resolveSelection(repoPath, workflowId);
  if (err) return Response.json({ error: err.error }, { status: err.status });

  let blocks: PlanReviewBlock[];
  let markedMd: string;
  try {
    markedMd = insertMarkers(markdown);
    const parsed = parseBlocks(markedMd, { detectMarkers: true });
    blocks = parsed.blocks;
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }

  const store = createPlanReviewStore({ base: repoPath });

  try {
    const revision = store.createRevision({
      workflowId,
      markdown: markedMd,
      blocks,
      createdBy,
    });
    const index = store.loadIndex();
    return Response.json({ revision, index });
  } catch (e) {
    return Response.json({ error: (e as Error).message }, { status: 400 });
  }
}

export function handlePlanReviewCommentsGet(_activeRepo: string, url: URL): Response {
  const repoPath = url.searchParams.get("repoPath") ?? "";
  const workflowId = url.searchParams.get("workflowId") ?? "";
  const revisionId = url.searchParams.get("revisionId") ?? "";

  const err = resolveSelection(repoPath, workflowId);
  if (err) return Response.json({ error: err.error }, { status: err.status });

  if (!revisionId || !isValidRevisionId(revisionId))
    return Response.json({ error: "valid revisionId required" }, { status: 400 });

  const store = createPlanReviewStore({ base: repoPath });
  const rev = store.loadRevision(revisionId as PlanReviewRevisionId);
  if (!rev || rev.workflowId !== workflowId)
    return Response.json({ error: "revision not found" }, { status: 404 });

  const comments = store.listCommentsByRevision(revisionId as PlanReviewRevisionId);
  return Response.json({ comments });
}

export function handlePlanReviewCommentsDelete(
  _activeRepo: string,
  path: string,
  url: URL,
): Response | null {
  const match = path.match(/^\/api\/plan-review\/comments\/([^/]+)$/);
  if (!match) return Response.json({ error: "comment id required in path" }, { status: 400 });

  const id = match[1] ?? "";
  if (!isValidCommentId(id)) return Response.json({ error: "invalid comment id" }, { status: 400 });

  const repoPath = url.searchParams.get("repoPath") ?? "";
  const workflowId = url.searchParams.get("workflowId") ?? "";
  const err = resolveSelection(repoPath, workflowId);
  if (err) return Response.json({ error: err.error }, { status: err.status });

  const store = createPlanReviewStore({ base: repoPath });
  const comment = store.loadComment(id as CommentId);
  if (!comment) return Response.json({ error: "comment not found" }, { status: 404 });
  const rev = store.loadRevision(comment.revisionId);
  if (!rev || rev.workflowId !== workflowId)
    return Response.json({ error: "revision not found" }, { status: 404 });

  try {
    store.deleteComment(id as CommentId);
    return Response.json({ ok: true });
  } catch (e) {
    const msg = (e as Error).message;
    const status = msg.includes("not found") ? 404 : 400;
    return Response.json({ error: msg }, { status });
  }
}

export function handlePlanReviewCommentsPost(
  _activeRepo: string,
  path: string,
  payload: Record<string, unknown>,
): Response | null {
  const repoPath = typeof payload.repoPath === "string" ? payload.repoPath.trim() : "";
  const workflowId = typeof payload.workflowId === "string" ? payload.workflowId.trim() : "";

  if (path === "/api/plan-review/comments") {
    const err = resolveSelection(repoPath, workflowId);
    if (err) return Response.json({ error: err.error }, { status: err.status });

    const revisionId = typeof payload.revisionId === "string" ? payload.revisionId.trim() : "";
    if (!revisionId || !isValidRevisionId(revisionId))
      return Response.json({ error: "valid revisionId required" }, { status: 400 });

    const body = typeof payload.body === "string" ? payload.body : "";
    if (!body) return Response.json({ error: "body required" }, { status: 400 });

    const createdByRaw = payload.createdBy;
    if (!createdByRaw || typeof createdByRaw !== "object")
      return Response.json({ error: "createdBy required" }, { status: 400 });
    const cb = createdByRaw as Record<string, unknown>;
    if (cb.type !== "user" && cb.type !== "agent")
      return Response.json({ error: "createdBy.type must be 'user' or 'agent'" }, { status: 400 });
    if (typeof cb.id !== "string" || !cb.id.trim())
      return Response.json({ error: "createdBy.id required" }, { status: 400 });
    if (typeof cb.name !== "string" || !cb.name.trim())
      return Response.json({ error: "createdBy.name required" }, { status: 400 });

    const createdBy: CreatedBy = { type: cb.type, id: cb.id.trim(), name: cb.name.trim() };

    const parentId = typeof payload.parentId === "string" ? payload.parentId.trim() : undefined;
    if (parentId !== undefined && !isValidCommentId(parentId))
      return Response.json({ error: "invalid parentId" }, { status: 400 });

    let anchor: CommentAnchor | undefined;
    if (payload.anchor !== undefined) {
      if (typeof payload.anchor !== "object" || payload.anchor === null)
        return Response.json({ error: "anchor must be an object" }, { status: 400 });
      const raw = payload.anchor as Record<string, unknown>;
      const parsed: CommentAnchor = {
        blockId: raw.blockId as unknown as CommentAnchor["blockId"],
        quote: raw.quote as string,
      };
      if (raw.range !== undefined) {
        if (typeof raw.range !== "object" || raw.range === null)
          return Response.json({ error: "anchor.range must be an object" }, { status: 400 });
        const r = raw.range as Record<string, unknown>;
        parsed.range = {
          startOffset: r.startOffset as number,
          endOffset: r.endOffset as number,
        };
      }
      anchor = parsed;
    }

    const store = createPlanReviewStore({ base: repoPath });
    const rev = store.loadRevision(revisionId as PlanReviewRevisionId);
    if (!rev || rev.workflowId !== workflowId)
      return Response.json({ error: "revision not found" }, { status: 404 });

    try {
      const comment = store.createComment({
        revisionId: revisionId as PlanReviewRevisionId,
        parentId: parentId as CommentId | undefined,
        anchor,
        body,
        createdBy,
      });
      return Response.json({ comment });
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg.includes("not found") ? 404 : 400;
      return Response.json({ error: msg }, { status });
    }
  }

  const submitMatch = path.match(/^\/api\/plan-review\/comments\/([^/]+)\/submit$/);
  if (submitMatch) {
    const id = submitMatch[1] ?? "";
    if (!isValidCommentId(id))
      return Response.json({ error: "invalid comment id" }, { status: 400 });

    const err = resolveSelection(repoPath, workflowId);
    if (err) return Response.json({ error: err.error }, { status: err.status });

    const store = createPlanReviewStore({ base: repoPath });
    const comment = store.loadComment(id as CommentId);
    if (!comment) return Response.json({ error: "comment not found" }, { status: 404 });
    const rev = store.loadRevision(comment.revisionId);
    if (!rev || rev.workflowId !== workflowId)
      return Response.json({ error: "revision not found" }, { status: 404 });

    try {
      const submitted = store.submitComment(id as CommentId);
      return Response.json({ comment: submitted });
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg.includes("not found") ? 404 : 400;
      return Response.json({ error: msg }, { status });
    }
  }

  const updateMatch = path.match(/^\/api\/plan-review\/comments\/([^/]+)$/);
  if (updateMatch) {
    const id = updateMatch[1] ?? "";
    if (!isValidCommentId(id))
      return Response.json({ error: "invalid comment id" }, { status: 400 });

    const err = resolveSelection(repoPath, workflowId);
    if (err) return Response.json({ error: err.error }, { status: err.status });

    const body = typeof payload.body === "string" ? payload.body : "";
    if (!body) return Response.json({ error: "body required" }, { status: 400 });

    const store = createPlanReviewStore({ base: repoPath });
    const comment = store.loadComment(id as CommentId);
    if (!comment) return Response.json({ error: "comment not found" }, { status: 404 });
    const rev = store.loadRevision(comment.revisionId);
    if (!rev || rev.workflowId !== workflowId)
      return Response.json({ error: "revision not found" }, { status: 404 });

    try {
      const updated = store.updateCommentBody(id as CommentId, body);
      return Response.json({ comment: updated });
    } catch (e) {
      const msg = (e as Error).message;
      const status = msg.includes("not found") ? 404 : 400;
      return Response.json({ error: msg }, { status });
    }
  }

  return null;
}
