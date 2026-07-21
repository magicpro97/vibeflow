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
