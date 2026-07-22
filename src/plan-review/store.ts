import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync, unlinkSync } from "node:fs";
import { join } from "node:path";
import { ctxPathIn, writeFileSafe } from "../core.js";
import {
  commentIndexPath,
  commentPath,
  loadAllCommentFiles,
  loadCommentFile,
  readCommentIndexFile,
  resolveRootAnchor,
  writeCommentIndexFile,
} from "./comments.js";
import type {
  Comment,
  CommentAnchor,
  CommentId,
  CommentIndex,
  CreateCommentInput,
  CreateRevisionInput,
  PlanReviewIndex,
  PlanReviewRevision,
  PlanReviewRevisionId,
  PlanReviewStore,
} from "./types.js";
import {
  MAX_BLOCKS_PER_REVISION,
  MAX_COMMENTS_PER_REVISION,
  MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_DEPTH,
  MAX_REVISIONS_LIST,
  assertCap,
  assertInputValid,
  assertValidCommentId,
  assertValidCreateCommentInput,
  isValidRevisionId,
  utf8ByteLength,
} from "./types.js";

export interface CreateStoreOpts {
  base?: string;
  existsSync?: (p: string) => boolean;
  readFileSync?: (p: string, enc: string) => string;
  readdirSync?: (p: string) => string[];
}

function revisionsDir(base: string): string {
  return ctxPathIn(base, "plan-review", "revisions");
}

function revisionPath(base: string, id: string): string {
  return join(revisionsDir(base), `${id}.json`);
}

function indexPath(base: string): string {
  return ctxPathIn(base, "plan-review", "index.json");
}

export function createPlanReviewStore(opts: CreateStoreOpts = {}): PlanReviewStore {
  const base = opts.base ?? process.cwd();
  const _exists = opts.existsSync ?? existsSync;
  const _read = opts.readFileSync ?? (readFileSync as (p: string, enc: string) => string);
  const _readdir = opts.readdirSync ?? readdirSync;

  function readIndex(): PlanReviewIndex | null {
    const p = indexPath(base);
    if (!_exists(p)) return null;
    try {
      return JSON.parse(_read(p, "utf8")) as PlanReviewIndex;
    } catch {
      return null;
    }
  }

  function writeIndex(idx: PlanReviewIndex): void {
    writeFileSafe(indexPath(base), JSON.stringify(idx, null, 2));
  }

  let _lastCreatedAtMs = 0;

  function createRevision(input: CreateRevisionInput): PlanReviewRevision {
    assertInputValid(input);
    assertCap(input.blocks.length, MAX_BLOCKS_PER_REVISION, "blocks");
    if (input.parentId !== undefined) {
      const parent = loadRevision(input.parentId);
      if (parent === null) {
        throw new Error(`Parent revision not found: ${input.parentId}`);
      }
      if (parent.workflowId !== input.workflowId) {
        throw new Error("Parent revision workflowId mismatch");
      }
    }
    const prev = readIndex();
    if (prev !== null && prev.workflowId !== input.workflowId) {
      throw new Error(
        `Workflow mismatch: existing index has workflowId "${prev.workflowId}", got "${input.workflowId}"`,
      );
    }

    const id = randomUUID() as PlanReviewRevisionId;
    const previousMs = prev ? Date.parse(prev.updatedAt) : 0;
    const previousFloor = Number.isFinite(previousMs) ? previousMs + 1 : 0;
    const now = Date.now();
    _lastCreatedAtMs = Math.max(now, _lastCreatedAtMs + 1, previousFloor);
    const createdAt = new Date(_lastCreatedAtMs).toISOString();
    const revision: PlanReviewRevision = {
      id,
      workflowId: input.workflowId,
      parentId: input.parentId,
      markdown: input.markdown,
      blocks: input.blocks,
      createdAt,
      createdBy: input.createdBy,
      status: "draft",
    };
    const revPath = revisionPath(base, id);
    if (_exists(revPath)) {
      throw new Error(`Revision already exists: ${id}`);
    }
    writeFileSafe(revPath, JSON.stringify(revision, null, 2));

    writeIndex({
      workflowId: input.workflowId,
      currentRevisionId: id,
      acceptedRevisionId: prev?.acceptedRevisionId,
      updatedAt: createdAt,
    });

    return revision;
  }

  function loadRevision(id: PlanReviewRevisionId): PlanReviewRevision | null {
    if (!isValidRevisionId(id)) return null;
    const p = revisionPath(base, id);
    if (!_exists(p)) return null;
    try {
      const parsed = JSON.parse(_read(p, "utf8")) as PlanReviewRevision;
      if (typeof parsed !== "object" || parsed === null) return null;
      if (!isValidRevisionId(parsed.id)) return null;
      if (parsed.id !== id) return null;
      if (typeof parsed.workflowId !== "string" || parsed.workflowId.length === 0) return null;
      if (
        parsed.status !== "draft" &&
        parsed.status !== "accepted" &&
        parsed.status !== "superseded"
      )
        return null;
      return parsed;
    } catch {
      return null;
    }
  }

  function listRevisions(): PlanReviewRevisionId[] {
    const dir = revisionsDir(base);
    if (!_exists(dir)) return [];
    return _readdir(dir)
      .filter((f) => f.endsWith(".json"))
      .map((f) => f.replace(/\.json$/, ""))
      .filter((f): f is PlanReviewRevisionId => isValidRevisionId(f));
  }

  function listRevisionsByWorkflow(
    workflowId: string,
    limit = MAX_REVISIONS_LIST,
  ): PlanReviewRevision[] {
    const ids = listRevisions();
    const result: PlanReviewRevision[] = [];
    for (const id of ids) {
      const rev = loadRevision(id);
      if (rev && rev.workflowId === workflowId) {
        result.push(rev);
      }
    }
    result.sort((a, b) => new Date(b.createdAt).getTime() - new Date(a.createdAt).getTime());
    return result.slice(0, limit);
  }

  function loadIndex(): PlanReviewIndex | null {
    return readIndex();
  }

  function createComment(input: CreateCommentInput): Comment {
    assertValidCreateCommentInput(input);
    const revision = loadRevision(input.revisionId);
    if (!revision) throw new Error(`Revision not found: ${input.revisionId}`);
    const all = loadAllCommentFiles(base, _exists, _read, _readdir);
    const revCount = all.filter((c) => c.revisionId === input.revisionId).length;
    if (revCount >= MAX_COMMENTS_PER_REVISION) {
      throw new Error(
        `comments per revision exceeds cap (${revCount} >= ${MAX_COMMENTS_PER_REVISION})`,
      );
    }
    const cache = new Map<string, Comment>();
    for (const c of all) cache.set(c.id, c);
    let depth = 0;
    let anchor: CommentAnchor;
    if (input.parentId) {
      const parent = cache.get(input.parentId);
      if (!parent) throw new Error(`Parent comment not found: ${input.parentId}`);
      if (parent.revisionId !== input.revisionId)
        throw new Error("Parent comment revision mismatch");
      depth = parent.depth + 1;
      assertCap(depth, MAX_COMMENT_DEPTH, "comment depth");
      anchor = resolveRootAnchor(input.parentId, cache);
    } else {
      if (!input.anchor) throw new Error("Root comment requires anchor");
      const blockIds = new Set(revision.blocks.map((b) => b.id));
      if (!blockIds.has(input.anchor.blockId)) {
        throw new Error(`Anchor blockId ${input.anchor.blockId} not found in revision blocks`);
      }
      anchor = input.anchor;
    }
    assertCap(utf8ByteLength(input.body), MAX_COMMENT_BODY_BYTES, "comment body");
    const id = randomUUID() as CommentId;

    const idxResult = readCommentIndexFile(base, _exists, _read);
    if (idxResult === null && _exists(commentIndexPath(base))) {
      throw new Error("Corrupt comment-index file");
    }
    const idx = idxResult ?? {
      workflowId: revision.workflowId,
      rootsByRevision: {},
      updatedAt: new Date(0).toISOString(),
    };

    if (!input.parentId) {
      if (idx.workflowId !== revision.workflowId) {
        throw new Error(
          `Comment index workflowId mismatch: "${idx.workflowId}" !== "${revision.workflowId}"`,
        );
      }
    }

    const idxMs = Date.parse(idx.updatedAt);
    const floor = Number.isFinite(idxMs) ? idxMs + 1 : 0;
    const now = Date.now();
    _lastCreatedAtMs = Math.max(now, _lastCreatedAtMs + 1, floor);
    const createdAt = new Date(_lastCreatedAtMs).toISOString();

    const comment: Comment = {
      id,
      revisionId: input.revisionId,
      parentId: input.parentId,
      anchor,
      body: input.body,
      status: "draft",
      depth,
      createdAt,
      createdBy: input.createdBy,
      updatedAt: createdAt,
    };
    writeFileSafe(commentPath(base, id), JSON.stringify(comment, null, 2));

    if (!input.parentId) {
      const roots = idx.rootsByRevision[input.revisionId] ?? [];
      roots.push(id);
      idx.rootsByRevision[input.revisionId] = roots;
    }
    idx.updatedAt = createdAt;
    writeCommentIndexFile(base, idx);

    return comment;
  }

  function loadComment(id: CommentId): Comment | null {
    return loadCommentFile(base, id, _exists, _read);
  }

  function listCommentsByRevision(revisionId: PlanReviewRevisionId): Comment[] {
    if (!isValidRevisionId(revisionId)) return [];
    return loadAllCommentFiles(base, _exists, _read, _readdir)
      .filter((c) => c.revisionId === revisionId)
      .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
  }

  function listCommentsByThread(rootId: CommentId): Comment[] {
    assertValidCommentId(rootId);

    const all = loadAllCommentFiles(base, _exists, _read, _readdir);
    const root = all.find((c) => c.id === rootId);
    if (!root) throw new Error(`Comment not found: ${rootId}`);
    if (root.parentId) throw new Error("Root id must not be a reply");

    const result: Comment[] = [root];
    const queue = [rootId];
    while (queue.length > 0) {
      const cid = queue.shift();
      if (!cid) break;
      const children = all
        .filter((c) => c.parentId === cid)
        .sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      for (const child of children) {
        result.push(child);
        queue.push(child.id);
      }
    }
    return result;
  }

  function updateCommentBody(id: CommentId, body: string): Comment {
    assertValidCommentId(id);

    const parsed = loadCommentFile(base, id, _exists, _read);
    if (!parsed) throw new Error(`Comment not found: ${id}`);
    if (parsed.status !== "draft") throw new Error("Only draft comments can be edited");
    assertCap(utf8ByteLength(body), MAX_COMMENT_BODY_BYTES, "comment body");

    parsed.body = body;
    // ponytail: clamp forward — same monotonic-clock invariant as submitComment.
    parsed.updatedAt = new Date(Math.max(Date.now(), Date.parse(parsed.updatedAt))).toISOString();
    writeFileSafe(commentPath(base, id), JSON.stringify(parsed, null, 2));
    return parsed;
  }

  function deleteComment(id: CommentId): void {
    assertValidCommentId(id);

    const all = loadAllCommentFiles(base, _exists, _read, _readdir);
    const target = all.find((c) => c.id === id);
    if (!target) throw new Error(`Comment not found: ${id}`);
    if (target.status !== "draft") throw new Error(`Cannot delete non-draft comment: ${id}`);

    const toDelete = new Set<string>();
    const queue = [id];
    while (queue.length > 0) {
      const cid = queue.shift();
      if (!cid) break;
      if (toDelete.has(cid)) continue;
      const c = all.find((x) => x.id === cid);
      if (c && c.status !== "draft") {
        throw new Error(`Cannot delete non-draft comment: ${cid}`);
      }
      toDelete.add(cid);
      for (const c of all) {
        if (c.parentId === cid && !toDelete.has(c.id)) {
          queue.push(c.id);
        }
      }
    }

    for (const did of toDelete) {
      try {
        unlinkSync(commentPath(base, did));
      } catch {
        // race: file already gone
      }
    }

    const idx = readCommentIndexFile(base, _exists, _read);
    if (idx) {
      const roots = idx.rootsByRevision[target.revisionId];
      if (roots) {
        const remaining = roots.filter((rid) => !toDelete.has(rid));
        if (remaining.length !== roots.length) {
          idx.rootsByRevision[target.revisionId] = remaining;
          idx.updatedAt = new Date().toISOString();
          writeCommentIndexFile(base, idx);
        }
      }
    }
  }

  function submitComment(id: CommentId): Comment {
    assertValidCommentId(id);
    const parsed = loadCommentFile(base, id, _exists, _read);
    if (!parsed) throw new Error(`Comment not found: ${id}`);
    if (parsed.status !== "draft") throw new Error("Only draft comments can be submitted");
    parsed.status = "open";
    // ponytail: clamp forward — createdAt/updatedAt use a monotonic clock that can lead Date.now();
    // a raw new Date() here can go backwards on a fast machine and break the >= invariant.
    parsed.updatedAt = new Date(Math.max(Date.now(), Date.parse(parsed.updatedAt))).toISOString();
    writeFileSafe(commentPath(base, id), JSON.stringify(parsed, null, 2));
    return parsed;
  }

  function loadCommentIndex(): CommentIndex | null {
    return readCommentIndexFile(base, _exists, _read);
  }

  return {
    createRevision,
    loadRevision,
    listRevisions,
    listRevisionsByWorkflow,
    loadIndex,
    createComment,
    loadComment,
    listCommentsByRevision,
    listCommentsByThread,
    updateCommentBody,
    deleteComment,
    submitComment,
    loadCommentIndex,
  };
}
