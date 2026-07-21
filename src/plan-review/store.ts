import { randomUUID } from "node:crypto";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ctxPathIn, writeFileSafe } from "../core.js";
import type {
  CreateRevisionInput,
  PlanReviewBlock,
  PlanReviewBlockId,
  PlanReviewIndex,
  PlanReviewRevision,
  PlanReviewRevisionId,
  PlanReviewStore,
} from "./types.js";
import {
  MAX_BLOCKS_PER_REVISION,
  MAX_REVISIONS_LIST,
  assertCap,
  assertInputValid,
  isValidRevisionId,
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
  const _read = opts.readFileSync ?? readFileSync;
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

  return { createRevision, loadRevision, listRevisions, listRevisionsByWorkflow, loadIndex };
}
