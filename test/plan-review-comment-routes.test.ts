import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeState } from "../src/core.js";
import { createPlanReviewStore } from "../src/plan-review/store.js";
import type { PlanReviewBlock, PlanReviewBlockId } from "../src/plan-review/types.js";
import { deleteRegistry, upsertRegistry } from "../src/registry.js";
import {
  handlePlanReviewCommentsDelete,
  handlePlanReviewCommentsGet,
  handlePlanReviewCommentsPost,
} from "../src/server/plan-review.js";

function tmpRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "vf-prc-route-"));
  mkdirSync(join(base, ".vibeflow"), { recursive: true });
  return base;
}
function seedState(base: string, wfId: string): void {
  writeState(base, {
    task_id: wfId,
    goal: "test",
    success_criteria: [],
    work_units: [],
    totals: { units: 0, done: 0, tokens: 0, cost_usd: 0, wall_seconds: 0 },
  });
}
function register(base: string): void {
  upsertRegistry({
    path: base,
    name: "",
    lastUsed: Date.now(),
    goal: "test",
    totals: { units: 0, done: 0, tokens: 0, cost_usd: 0 },
  });
}
function cleanup(base: string): void {
  try {
    deleteRegistry(base);
  } catch {
    /* */
  }
  try {
    rmSync(base, { recursive: true, force: true });
  } catch {
    /* */
  }
}

function setupEnv(wfId: string) {
  const base = tmpRepo();
  seedState(base, wfId);
  register(base);
  return base;
}

function seedRevisionWithBlock(
  base: string,
  wfId: string,
  opts: { blockId: string; content: string },
) {
  const store = createPlanReviewStore({ base });
  const blockId = opts.blockId as PlanReviewBlockId;
  const blocks: PlanReviewBlock[] = [
    { id: blockId, type: "paragraph", content: opts.content, lines: { startLine: 1, endLine: 1 } },
  ];
  const revision = store.createRevision({
    workflowId: wfId,
    markdown: `# Plan\n${opts.content}`,
    blocks,
    createdBy: { type: "user", id: "u1", name: "User" },
  });
  return { store, blockId, revision };
}

async function createDraftComment(
  base: string,
  wfId: string,
  revisionId: string,
  blockId: PlanReviewBlockId,
  body: string,
  quote: string,
) {
  const payload = {
    repoPath: base,
    workflowId: wfId,
    revisionId,
    body,
    createdBy: { type: "user", id: "u1", name: "Tester" },
    anchor: { blockId, quote, range: { startOffset: 0, endOffset: quote.length } },
  };
  const res = handlePlanReviewCommentsPost(base, "/api/plan-review/comments", payload);
  expect(res).not.toBeNull();
  if (!res) throw new Error("null response");
  const json = (await res.json()) as Record<string, unknown>;
  return { res, json, comment: json.comment as Record<string, unknown> };
}

describe("handlePlanReviewCommentsGet", () => {
  test("unknown revision returns 404", () => {
    const base = setupEnv("wf-comments-1");
    try {
      const url = new URL(
        `http://localhost/api/plan-review/comments?repoPath=${encodeURIComponent(base)}&workflowId=wf-comments-1&revisionId=aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee`,
      );
      const res = handlePlanReviewCommentsGet(base, url);
      expect(res.status).toBe(404);
    } finally {
      cleanup(base);
    }
  });
});

describe("handlePlanReviewCommentsPost", () => {
  test("create root comment success returns 200 and draft", async () => {
    const base = setupEnv("wf-post-1");
    try {
      const { blockId, revision } = seedRevisionWithBlock(base, "wf-post-1", {
        blockId: "aabbccdd-1111-2222-3333-444444444444",
        content: "hello world",
      });
      const { res, comment } = await createDraftComment(
        base,
        "wf-post-1",
        revision.id,
        blockId,
        "Looks good",
        "hello",
      );
      expect(res.status).toBe(200);
      expect(comment.body).toBe("Looks good");
      expect(comment.status).toBe("draft");
      expect(comment.revisionId).toBe(revision.id);
      expect((comment.anchor as Record<string, unknown>).blockId).toBe(blockId);
    } finally {
      cleanup(base);
    }
  });

  test("submit same comment twice returns 400 on second attempt", async () => {
    const base = setupEnv("wf-post-dup-submit");
    try {
      const { blockId, revision } = seedRevisionWithBlock(base, "wf-post-dup-submit", {
        blockId: "aabbccdd-1111-2222-3333-dddddddddddd",
        content: "dup submit",
      });
      const { comment: created } = await createDraftComment(
        base,
        "wf-post-dup-submit",
        revision.id,
        blockId,
        "Submit me twice",
        "dup",
      );
      const commentId = created.id as string;

      const firstSubmit = handlePlanReviewCommentsPost(
        base,
        `/api/plan-review/comments/${commentId}/submit`,
        { repoPath: base, workflowId: "wf-post-dup-submit" },
      );
      expect(firstSubmit).not.toBeNull();
      if (!firstSubmit) return;
      expect(firstSubmit.status).toBe(200);
      const firstJson = (await firstSubmit.json()) as Record<string, unknown>;
      expect((firstJson.comment as Record<string, unknown>).status).toBe("open");

      const secondSubmit = handlePlanReviewCommentsPost(
        base,
        `/api/plan-review/comments/${commentId}/submit`,
        { repoPath: base, workflowId: "wf-post-dup-submit" },
      );
      expect(secondSubmit).not.toBeNull();
      if (!secondSubmit) return;
      expect(secondSubmit.status).toBe(400);
    } finally {
      cleanup(base);
    }
  });

  test("submit returns 200/open, update after submit returns 400", async () => {
    const base = setupEnv("wf-post-2");
    try {
      const { blockId, revision } = seedRevisionWithBlock(base, "wf-post-2", {
        blockId: "aabbccdd-1111-2222-3333-555555555555",
        content: "test block",
      });
      const { comment: created } = await createDraftComment(
        base,
        "wf-post-2",
        revision.id,
        blockId,
        "Draft comment",
        "test",
      );
      const commentId = created.id as string;

      const submitRes = handlePlanReviewCommentsPost(
        base,
        `/api/plan-review/comments/${commentId}/submit`,
        { repoPath: base, workflowId: "wf-post-2" },
      );
      expect(submitRes).not.toBeNull();
      if (!submitRes) return;
      expect(submitRes.status).toBe(200);
      const submitted = (await submitRes.json()) as Record<string, unknown>;
      expect((submitted.comment as Record<string, unknown>).status).toBe("open");

      const updateRes = handlePlanReviewCommentsPost(
        base,
        `/api/plan-review/comments/${commentId}`,
        { repoPath: base, workflowId: "wf-post-2", body: "Updated body" },
      );
      expect(updateRes).not.toBeNull();
      if (!updateRes) return;
      expect(updateRes.status).toBe(400);
    } finally {
      cleanup(base);
    }
  });

  test("negative startOffset in anchor range returns 400", async () => {
    const base = setupEnv("wf-neg-offset");
    try {
      const { blockId, revision } = seedRevisionWithBlock(base, "wf-neg-offset", {
        blockId: "aabbccdd-1111-2222-3333-ffffffffffff",
        content: "offset check",
      });
      const payload = {
        repoPath: base,
        workflowId: "wf-neg-offset",
        revisionId: revision.id,
        body: "Bad range",
        createdBy: { type: "user", id: "u1", name: "Tester" },
        anchor: { blockId, quote: "offset", range: { startOffset: -1, endOffset: 0 } },
      };
      const res = handlePlanReviewCommentsPost(base, "/api/plan-review/comments", payload);
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.status).toBe(400);
    } finally {
      cleanup(base);
    }
  });
});

describe("handlePlanReviewCommentsDelete", () => {
  test("delete draft returns 200 then GET list has no comment", async () => {
    const base = setupEnv("wf-del-1");
    try {
      const { blockId, revision } = seedRevisionWithBlock(base, "wf-del-1", {
        blockId: "aabbccdd-1111-2222-3333-666666666666",
        content: "deleteme",
      });
      const { comment: created } = await createDraftComment(
        base,
        "wf-del-1",
        revision.id,
        blockId,
        "To be deleted",
        "deleteme",
      );
      const commentId = created.id as string;

      const delUrl = new URL(
        `http://localhost/api/plan-review/comments/${commentId}?repoPath=${encodeURIComponent(base)}&workflowId=wf-del-1`,
      );
      const delRes = handlePlanReviewCommentsDelete(
        base,
        `/api/plan-review/comments/${commentId}`,
        delUrl,
      );
      expect(delRes).not.toBeNull();
      if (!delRes) return;
      expect(delRes.status).toBe(200);

      const listUrl = new URL(
        `http://localhost/api/plan-review/comments?repoPath=${encodeURIComponent(base)}&workflowId=wf-del-1&revisionId=${revision.id}`,
      );
      const listRes = handlePlanReviewCommentsGet(base, listUrl);
      expect(listRes.status).toBe(200);
      const list = (await listRes.json()) as Record<string, unknown>;
      expect((list.comments as unknown[]).length).toBe(0);
    } finally {
      cleanup(base);
    }
  });
});

describe("PR2 review findings", () => {
  test("create comment with invalid blockId returns 400", async () => {
    const base = setupEnv("wf-findings-1");
    try {
      const { revision } = seedRevisionWithBlock(base, "wf-findings-1", {
        blockId: "aabbccdd-1111-2222-3333-888888888888",
        content: "hi",
      });
      const payload = {
        repoPath: base,
        workflowId: "wf-findings-1",
        revisionId: revision.id,
        body: "bad anchor",
        createdBy: { type: "user", id: "u1", name: "Tester" },
        anchor: { blockId: "has spaces!!!", quote: "hi" },
      };
      const res = handlePlanReviewCommentsPost(base, "/api/plan-review/comments", payload);
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.error as string).toContain("Invalid anchor blockId");
    } finally {
      cleanup(base);
    }
  });

  test("DELETE comment route works without request body (query params only)", async () => {
    const base = setupEnv("wf-findings-2");
    try {
      const { store, blockId, revision } = seedRevisionWithBlock(base, "wf-findings-2", {
        blockId: "aabbccdd-1111-2222-3333-999999999999",
        content: "del",
      });
      const comment = store.createComment({
        revisionId: revision.id,
        body: "to delete",
        anchor: { blockId, quote: "del" },
        createdBy: { type: "user", id: "u1", name: "Tester" },
      });

      const delUrl = new URL(
        `http://localhost/api/plan-review/comments/${comment.id}?repoPath=${encodeURIComponent(base)}&workflowId=wf-findings-2`,
      );
      const res = handlePlanReviewCommentsDelete(
        base,
        `/api/plan-review/comments/${comment.id}`,
        delUrl,
      );
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.status).toBe(200);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.ok).toBe(true);
      expect(store.loadComment(comment.id)).toBeNull();
    } finally {
      cleanup(base);
    }
  });

  test("create comment with corrupt index returns 400 and preserves existing roots", async () => {
    const base = setupEnv("wf-findings-3");
    try {
      const { store, blockId, revision } = seedRevisionWithBlock(base, "wf-findings-3", {
        blockId: "aabbccdd-1111-2222-3333-aaaaaaaaaaaa",
        content: "corrupt",
      });
      const existing = store.createComment({
        revisionId: revision.id,
        body: "existing",
        anchor: { blockId, quote: "corrupt" },
        createdBy: { type: "user", id: "u1", name: "Tester" },
      });
      const { writeFileSync } = await import("node:fs");
      const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
      writeFileSync(idxPath, "{{{bad json");

      const payload = {
        repoPath: base,
        workflowId: "wf-findings-3",
        revisionId: revision.id,
        body: "should fail",
        createdBy: { type: "user", id: "u1", name: "Tester" },
        anchor: { blockId, quote: "corrupt" },
      };
      const res = handlePlanReviewCommentsPost(base, "/api/plan-review/comments", payload);
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.error as string).toContain("Corrupt comment-index");

      const comments = store.listCommentsByRevision(revision.id);
      expect(comments.length).toBe(1);
      expect(comments[0]?.id).toBe(existing.id);
    } finally {
      cleanup(base);
    }
  });
});

describe("handlePlanReviewCommentsDelete error catch", () => {
  test("delete non-draft comment returns 400", async () => {
    const base = setupEnv("wf-del-err");
    try {
      const { blockId, revision } = seedRevisionWithBlock(base, "wf-del-err", {
        blockId: "aabbccdd-1111-2222-3333-cccccccccccc",
        content: "submitted",
      });
      const { comment: created } = await createDraftComment(
        base,
        "wf-del-err",
        revision.id,
        blockId,
        "Will submit",
        "submitted",
      );
      const commentId = created.id as string;

      const submitRes = handlePlanReviewCommentsPost(
        base,
        `/api/plan-review/comments/${commentId}/submit`,
        { repoPath: base, workflowId: "wf-del-err" },
      );
      expect(submitRes).not.toBeNull();
      if (!submitRes) return;
      expect(submitRes.status).toBe(200);

      const delUrl = new URL(
        `http://localhost/api/plan-review/comments/${commentId}?repoPath=${encodeURIComponent(base)}&workflowId=wf-del-err`,
      );
      const delRes = handlePlanReviewCommentsDelete(
        base,
        `/api/plan-review/comments/${commentId}`,
        delUrl,
      );
      expect(delRes).not.toBeNull();
      if (!delRes) return;
      expect(delRes.status).toBe(400);
      const json = (await delRes.json()) as Record<string, unknown>;
      expect(json.error as string).toContain("Cannot delete non-draft");
    } finally {
      cleanup(base);
    }
  });
});

describe("handlePlanReviewCommentsDelete 404", () => {
  test("valid UUID but missing comment returns 404", () => {
    const base = setupEnv("wf-del-404");
    try {
      const missingId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const delUrl = new URL(
        `http://localhost/api/plan-review/comments/${missingId}?repoPath=${encodeURIComponent(base)}&workflowId=wf-del-404`,
      );
      const res = handlePlanReviewCommentsDelete(
        base,
        `/api/plan-review/comments/${missingId}`,
        delUrl,
      );
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.status).toBe(404);
    } finally {
      cleanup(base);
    }
  });
});

describe("handlePlanReviewCommentsPost unmatched path", () => {
  test("unmatched path returns null", () => {
    const base = setupEnv("wf-null-path");
    try {
      const res = handlePlanReviewCommentsPost(base, "/api/plan-review/unknown-route", {
        repoPath: base,
        workflowId: "wf-null-path",
      });
      expect(res).toBeNull();
    } finally {
      cleanup(base);
    }
  });
});

describe("handlePlanReviewCommentsGet cross-workflow", () => {
  test("cross-workflow revision GET returns 404", () => {
    const base = setupEnv("wf-cross-1");
    try {
      const { revision } = seedRevisionWithBlock(base, "other-workflow", {
        blockId: "aabbccdd-1111-2222-3333-777777777777",
        content: "cross",
      });
      const url = new URL(
        `http://localhost/api/plan-review/comments?repoPath=${encodeURIComponent(base)}&workflowId=wf-cross-1&revisionId=${revision.id}`,
      );
      const res = handlePlanReviewCommentsGet(base, url);
      expect(res.status).toBe(404);
    } finally {
      cleanup(base);
    }
  });
});

describe("DELETE /api/plan-review/comments without ID returns 400", () => {
  test("bare path (no comment ID) returns 400 without JSON parse error", async () => {
    const base = setupEnv("wf-del-bare");
    try {
      const delUrl = new URL(
        `http://localhost/api/plan-review/comments?repoPath=${encodeURIComponent(base)}&workflowId=wf-del-bare`,
      );
      const res = handlePlanReviewCommentsDelete(base, "/api/plan-review/comments", delUrl);
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.error).toBe("comment id required in path");
    } finally {
      cleanup(base);
    }
  });
});

describe("anchor sanitization rejects non-object and strips extra keys", () => {
  test("non-object anchor returns 400", async () => {
    const base = setupEnv("wf-anchor-nonobj");
    try {
      const { revision } = seedRevisionWithBlock(base, "wf-anchor-nonobj", {
        blockId: "aabbccdd-1111-2222-3333-dddddddddddd",
        content: "anchor test",
      });
      const payload = {
        repoPath: base,
        workflowId: "wf-anchor-nonobj",
        revisionId: revision.id,
        body: "bad anchor",
        createdBy: { type: "user", id: "u1", name: "Tester" },
        anchor: "not-an-object",
      };
      const res = handlePlanReviewCommentsPost(base, "/api/plan-review/comments", payload);
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.error).toBe("anchor must be an object");
    } finally {
      cleanup(base);
    }
  });

  test("extra keys in anchor payload are not persisted", async () => {
    const base = setupEnv("wf-anchor-extra");
    try {
      const { blockId, revision } = seedRevisionWithBlock(base, "wf-anchor-extra", {
        blockId: "aabbccdd-1111-2222-3333-eeeeeeeeeeee",
        content: "extra keys",
      });
      const payload = {
        repoPath: base,
        workflowId: "wf-anchor-extra",
        revisionId: revision.id,
        body: "anchor extra",
        createdBy: { type: "user", id: "u1", name: "Tester" },
        anchor: { blockId, quote: "extra keys", evil: "payload", __proto__: null },
      };
      const res = handlePlanReviewCommentsPost(base, "/api/plan-review/comments", payload);
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.status).toBe(200);
      const json = (await res.json()) as { comment: Record<string, unknown> };
      const anchor = json.comment.anchor as Record<string, unknown>;
      expect(anchor.blockId).toBe(blockId);
      expect(anchor.quote).toBe("extra keys");
      expect("evil" in anchor).toBe(false);
      expect(Object.hasOwn(anchor, "__proto__")).toBe(false);
    } finally {
      cleanup(base);
    }
  });

  test("non-object anchor.range returns 400", async () => {
    const base = setupEnv("wf-anchor-badrange");
    try {
      const { blockId, revision } = seedRevisionWithBlock(base, "wf-anchor-badrange", {
        blockId: "aabbccdd-1111-2222-3333-ffffffffffff",
        content: "range test",
      });
      const payload = {
        repoPath: base,
        workflowId: "wf-anchor-badrange",
        revisionId: revision.id,
        body: "bad range type",
        createdBy: { type: "user", id: "u1", name: "Tester" },
        anchor: { blockId, quote: "range test", range: "not-object" },
      };
      const res = handlePlanReviewCommentsPost(base, "/api/plan-review/comments", payload);
      expect(res).not.toBeNull();
      if (!res) return;
      expect(res.status).toBe(400);
      const json = (await res.json()) as Record<string, unknown>;
      expect(json.error).toBe("anchor.range must be an object");
    } finally {
      cleanup(base);
    }
  });
});
