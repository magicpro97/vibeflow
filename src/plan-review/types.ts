export type PlanReviewBlockType =
  | "heading"
  | "paragraph"
  | "list-run"
  | "fenced-code"
  | "fenced-mermaid";

export type PlanReviewBlockId = string & { __brand: "BlockId" };
export type PlanReviewRevisionId = string & { __brand: "RevisionId" };

export type RevisionStatus = "draft" | "accepted" | "superseded";

export interface CreatedByUser {
  type: "user";
  id: string;
  name: string;
}

export interface CreatedByAgent {
  type: "agent";
  id: string;
  name: string;
}

export type CreatedBy = CreatedByUser | CreatedByAgent;

export interface SelectionRange {
  startLine: number;
  endLine: number;
}

export interface BlockMarker {
  id: PlanReviewBlockId;
  line: number;
}

export interface PlanReviewBlock {
  id: PlanReviewBlockId;
  type: PlanReviewBlockType;
  content: string;
  lines: SelectionRange;
}

export interface PlanReviewRevision {
  id: PlanReviewRevisionId;
  workflowId: string;
  parentId?: PlanReviewRevisionId;
  markdown: string;
  blocks: PlanReviewBlock[];
  createdAt: string;
  createdBy: CreatedBy;
  status: RevisionStatus;
}

export interface PlanReviewIndex {
  workflowId: string;
  currentRevisionId: PlanReviewRevisionId;
  acceptedRevisionId?: PlanReviewRevisionId;
  updatedAt: string;
}

export interface CreateRevisionInput {
  workflowId: string;
  parentId?: PlanReviewRevisionId;
  markdown: string;
  blocks: PlanReviewBlock[];
  createdBy: CreatedBy;
}

export interface PlanReviewStore {
  createRevision(input: CreateRevisionInput): PlanReviewRevision;
  loadRevision(id: PlanReviewRevisionId): PlanReviewRevision | null;
  listRevisions(): PlanReviewRevisionId[];
  listRevisionsByWorkflow(workflowId: string, limit?: number): PlanReviewRevision[];
  loadIndex(): PlanReviewIndex | null;
  createComment(input: CreateCommentInput): Comment;
  loadComment(id: CommentId): Comment | null;
  listCommentsByRevision(revisionId: PlanReviewRevisionId): Comment[];
  listCommentsByThread(rootId: CommentId): Comment[];
  updateCommentBody(id: CommentId, body: string): Comment;
  deleteComment(id: CommentId): void;
  submitComment(id: CommentId): Comment;
  loadCommentIndex(): CommentIndex | null;
}

export const BLOCK_MARKER_REGEX = /^<!--\s*vf:block:([A-Fa-f0-9-]+)\s*-->$/;

export const MAX_BLOCK_ID_LENGTH = 64;
export const MAX_BLOCK_CONTENT_LENGTH = 100_000;
export const MAX_BLOCKS_PER_REVISION = 1_000;
export const MAX_REVISION_ID_LENGTH = 64;
export const MAX_MARKDOWN_LENGTH = 1_000_000;
export const MAX_REVISIONS_LIST = 50;

export function utf8ByteLength(str: string): number {
  return new TextEncoder().encode(str).length;
}

export function isValidBlockId(id: string): id is PlanReviewBlockId {
  return /^[A-Fa-f0-9-]{1,64}$/.test(id);
}

export function assertValidBlockId(id: string): asserts id is PlanReviewBlockId {
  if (!isValidBlockId(id)) {
    throw new Error(`Invalid block ID: ${id}`);
  }
}

export function isValidRevisionId(id: string): id is PlanReviewRevisionId {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function assertValidRevisionId(id: string): asserts id is PlanReviewRevisionId {
  if (!isValidRevisionId(id)) {
    throw new Error(`Invalid revision ID: ${id}`);
  }
}

export function assertCap(value: number, max: number, label: string): void {
  if (value > max) {
    throw new Error(`${label} exceeds cap (${value} > ${max})`);
  }
}

export function assertInputValid(input: CreateRevisionInput): void {
  if (input.workflowId.length === 0) {
    throw new Error("workflowId must be non-empty");
  }
  if (input.parentId !== undefined && !isValidRevisionId(input.parentId)) {
    throw new Error(`Invalid parent revision ID: ${input.parentId}`);
  }
  if (input.createdBy.id.length === 0) {
    throw new Error("createdBy.id must be non-empty");
  }
  if (input.createdBy.name.length === 0) {
    throw new Error("createdBy.name must be non-empty");
  }
  assertCap(utf8ByteLength(input.markdown), MAX_MARKDOWN_LENGTH, "markdown");
  for (const block of input.blocks) {
    assertCap(utf8ByteLength(block.content), MAX_BLOCK_CONTENT_LENGTH, "block content");
  }
}

// --- Comment types ---

export type CommentId = string & { __brand: "CommentId" };
export type CommentStatus = "draft" | "open";

export interface CommentAnchor {
  blockId: PlanReviewBlockId;
  quote: string;
  range?: { startOffset: number; endOffset: number };
}

export interface Comment {
  id: CommentId;
  revisionId: PlanReviewRevisionId;
  parentId?: CommentId;
  anchor?: CommentAnchor;
  body: string;
  status: CommentStatus;
  depth: number;
  createdAt: string;
  createdBy: CreatedBy;
  updatedAt: string;
}

export interface CreateCommentInput {
  revisionId: PlanReviewRevisionId;
  parentId?: CommentId;
  anchor?: CommentAnchor;
  body: string;
  createdBy: CreatedBy;
}

export interface CommentIndex {
  workflowId: string;
  rootsByRevision: Record<string, CommentId[]>;
  updatedAt: string;
}

export const MAX_COMMENT_BODY_BYTES = 10_000;
export const MAX_COMMENT_DEPTH = 5;
export const MAX_COMMENTS_PER_REVISION = 100;
export const MAX_QUOTE_LENGTH = 2000;

export function isValidCommentId(id: string): id is CommentId {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id);
}

export function assertValidCommentId(id: string): asserts id is CommentId {
  if (!isValidCommentId(id)) {
    throw new Error(`Invalid comment ID: ${id}`);
  }
}

export function assertValidCreateCommentInput(input: CreateCommentInput): void {
  if (!isValidRevisionId(input.revisionId)) {
    throw new Error(`Invalid revision ID: ${input.revisionId}`);
  }
  if (input.parentId !== undefined && !isValidCommentId(input.parentId)) {
    throw new Error(`Invalid parent comment ID: ${input.parentId}`);
  }
  if (input.createdBy.id.length === 0) {
    throw new Error("createdBy.id must be non-empty");
  }
  if (input.createdBy.name.length === 0) {
    throw new Error("createdBy.name must be non-empty");
  }
  if (input.createdBy.type !== "user" && input.createdBy.type !== "agent") {
    throw new Error("createdBy.type must be 'user' or 'agent'");
  }
  if (input.parentId === undefined && input.anchor === undefined) {
    throw new Error("Root comment requires anchor");
  }
  if (input.parentId !== undefined && input.anchor !== undefined) {
    throw new Error("Reply comment must not have anchor");
  }
  if (input.anchor !== undefined) {
    if (!isValidBlockId(input.anchor.blockId)) {
      throw new Error(`Invalid anchor blockId: ${input.anchor.blockId}`);
    }
    if (input.anchor.quote.length === 0) {
      throw new Error("Anchor quote must be non-empty");
    }
    assertCap(utf8ByteLength(input.anchor.quote), MAX_QUOTE_LENGTH, "anchor quote");
    if (input.anchor.range !== undefined) {
      if (
        !Number.isFinite(input.anchor.range.startOffset) ||
        !Number.isFinite(input.anchor.range.endOffset)
      ) {
        throw new Error("Anchor range offsets must be finite");
      }
      if (
        !Number.isInteger(input.anchor.range.startOffset) ||
        !Number.isInteger(input.anchor.range.endOffset)
      ) {
        throw new Error("Anchor range offsets must be integers");
      }
      if (input.anchor.range.startOffset < 0 || input.anchor.range.endOffset < 0) {
        throw new Error("Anchor range offsets must be nonnegative");
      }
      if (input.anchor.range.startOffset > input.anchor.range.endOffset) {
        throw new Error("Anchor range start must not exceed end");
      }
    }
  }
}
