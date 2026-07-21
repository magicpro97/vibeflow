import { readState } from "../core.js";
import { insertMarkers, parseBlocks } from "../plan-review/blocks.js";
import { createPlanReviewStore } from "../plan-review/store.js";
import type { CreatedBy, PlanReviewBlock } from "../plan-review/types.js";
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
