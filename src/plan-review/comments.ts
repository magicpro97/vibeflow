import { join } from "node:path";
import { ctxPathIn, writeFileSafe } from "../core.js";
import type { Comment, CommentAnchor, CommentId, CommentIndex } from "./types.js";
import {
  MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_DEPTH,
  MAX_QUOTE_LENGTH,
  isValidBlockId,
  isValidCommentId,
  isValidRevisionId,
  utf8ByteLength,
} from "./types.js";

export function commentsDir(base: string): string {
  return ctxPathIn(base, "plan-review", "comments");
}

export function commentPath(base: string, id: string): string {
  return join(commentsDir(base), `${id}.json`);
}

export function commentIndexPath(base: string): string {
  return ctxPathIn(base, "plan-review", "comment-index.json");
}

export function validateCommentIndexSchema(parsed: unknown): CommentIndex | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const o = parsed as Record<string, unknown>;
  if (typeof o.workflowId !== "string" || o.workflowId.length === 0) return null;
  if (typeof o.updatedAt !== "string" || Number.isNaN(Date.parse(o.updatedAt))) return null;
  if (typeof o.rootsByRevision !== "object" || o.rootsByRevision === null) return null;
  const rbr = o.rootsByRevision as Record<string, unknown>;
  for (const [key, val] of Object.entries(rbr)) {
    if (!isValidRevisionId(key)) return null;
    if (!Array.isArray(val)) return null;
    for (const id of val) {
      if (typeof id !== "string" || !isValidCommentId(id)) return null;
    }
  }
  return parsed as CommentIndex;
}

export function readCommentIndexFile(
  base: string,
  _exists: (p: string) => boolean,
  _read: (p: string, enc: string) => string,
): CommentIndex | null {
  const p = commentIndexPath(base);
  if (!_exists(p)) return null;
  try {
    const parsed = JSON.parse(_read(p, "utf8"));
    return validateCommentIndexSchema(parsed);
  } catch {
    return null;
  }
}

export function writeCommentIndexFile(base: string, idx: CommentIndex): void {
  writeFileSafe(commentIndexPath(base), JSON.stringify(idx, null, 2));
}

export function validateCommentSchema(parsed: unknown, expectedId?: string): Comment | null {
  if (typeof parsed !== "object" || parsed === null) return null;
  const p = parsed as Record<string, unknown>;

  if (typeof p.id !== "string" || !isValidCommentId(p.id)) return null;
  if (expectedId !== undefined && p.id !== expectedId) return null;
  if (typeof p.revisionId !== "string" || !isValidRevisionId(p.revisionId)) return null;
  if (p.status !== "draft" && p.status !== "open") return null;

  if (typeof p.body !== "string") return null;
  if (utf8ByteLength(p.body) > MAX_COMMENT_BODY_BYTES) return null;

  if (typeof p.depth !== "number" || !Number.isInteger(p.depth)) return null;
  if (p.depth < 0 || p.depth > MAX_COMMENT_DEPTH) return null;

  if (typeof p.createdAt !== "string" || Number.isNaN(Date.parse(p.createdAt))) return null;
  if (typeof p.updatedAt !== "string" || Number.isNaN(Date.parse(p.updatedAt))) return null;

  if (typeof p.createdBy !== "object" || p.createdBy === null) return null;
  const cb = p.createdBy as Record<string, unknown>;
  if (cb.type !== "user" && cb.type !== "agent") return null;
  if (typeof cb.id !== "string" || cb.id.length === 0) return null;
  if (typeof cb.name !== "string" || cb.name.length === 0) return null;

  if (p.parentId !== undefined) {
    if (typeof p.parentId !== "string" || !isValidCommentId(p.parentId)) return null;
  }

  if (typeof p.anchor !== "object" || p.anchor === null) return null;
  const a = p.anchor as Record<string, unknown>;
  if (typeof a.blockId !== "string" || !isValidBlockId(a.blockId)) return null;
  if (typeof a.quote !== "string") return null;
  const trimmedQuote = a.quote.trim();
  if (trimmedQuote.length === 0) return null;
  if (utf8ByteLength(a.quote) > MAX_QUOTE_LENGTH) return null;
  if (a.range !== undefined) {
    if (typeof a.range !== "object" || a.range === null) return null;
    const r = a.range as Record<string, unknown>;
    if (typeof r.startOffset !== "number" || !Number.isFinite(r.startOffset)) return null;
    if (typeof r.endOffset !== "number" || !Number.isFinite(r.endOffset)) return null;
    if (!Number.isInteger(r.startOffset) || !Number.isInteger(r.endOffset)) return null;
    if (r.startOffset < 0 || r.endOffset < 0) return null;
    if (r.startOffset > r.endOffset) return null;
  }

  return parsed as Comment;
}

export function loadCommentFile(
  base: string,
  id: string,
  _exists: (p: string) => boolean,
  _read: (p: string, enc: string) => string,
): Comment | null {
  if (!isValidCommentId(id)) return null;
  const p = commentPath(base, id);
  if (!_exists(p)) return null;
  try {
    const parsed = JSON.parse(_read(p, "utf8"));
    return validateCommentSchema(parsed, id);
  } catch {
    return null;
  }
}

export function loadAllCommentFiles(
  base: string,
  _exists: (p: string) => boolean,
  _read: (p: string, enc: string) => string,
  _readdir: (p: string) => string[],
): Comment[] {
  const dir = commentsDir(base);
  if (!_exists(dir)) return [];
  const result: Comment[] = [];
  for (const f of _readdir(dir)) {
    if (!f.endsWith(".json")) continue;
    try {
      const parsed = JSON.parse(_read(join(dir, f), "utf8"));
      const comment = validateCommentSchema(parsed);
      if (comment) result.push(comment);
    } catch {
      // skip corrupt
    }
  }
  return result;
}

export function resolveRootAnchor(id: CommentId, cache: Map<string, Comment>): CommentAnchor {
  let cur = cache.get(id);
  while (cur?.parentId) cur = cache.get(cur.parentId);
  const a = cur?.anchor;
  if (!a) throw new Error("Root comment anchor not found");
  return a;
}
