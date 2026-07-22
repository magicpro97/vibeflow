import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  readCommentIndexFile,
  validateCommentIndexSchema,
  validateCommentSchema,
} from "../src/plan-review/comments.js";
import { createPlanReviewStore } from "../src/plan-review/store.js";
import type {
  CommentAnchor,
  CommentId,
  CreateCommentInput,
  CreateRevisionInput,
  PlanReviewBlock,
  PlanReviewBlockId,
  PlanReviewRevisionId,
} from "../src/plan-review/types.js";
import {
  MAX_COMMENT_BODY_BYTES,
  MAX_COMMENT_DEPTH,
  MAX_QUOTE_LENGTH,
  assertValidCommentId,
  isValidCommentId,
  isValidRevisionId,
} from "../src/plan-review/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "vf-pr-comment-"));
}

function dummyBlock(overrides: Partial<PlanReviewBlock> = {}): PlanReviewBlock {
  return {
    id: "a".repeat(32) as PlanReviewBlockId,
    type: "paragraph",
    content: "hello",
    lines: { startLine: 1, endLine: 1 },
    ...overrides,
  };
}

function makeRevInput(overrides: Partial<CreateRevisionInput> = {}): CreateRevisionInput {
  return {
    workflowId: "wf-1",
    markdown: "hello",
    blocks: [dummyBlock()],
    createdBy: { type: "user", id: "user-1", name: "Test User" },
    ...overrides,
  };
}

function makeCommentInput(
  revisionId: PlanReviewRevisionId,
  overrides: Partial<CreateCommentInput> = {},
): CreateCommentInput {
  return {
    revisionId,
    body: "test comment",
    anchor: { blockId: "a".repeat(32) as PlanReviewBlockId, quote: "selected text" },
    createdBy: { type: "user", id: "user-1", name: "Test User" },
    ...overrides,
  };
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

function createRevision(store: ReturnType<typeof createPlanReviewStore>, workflowId = "wf-1") {
  return store.createRevision(makeRevInput({ workflowId }));
}

test("createComment writes file and returns comment with draft status", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));

    expect(isValidCommentId(c.id)).toBe(true);
    expect(c.revisionId).toBe(rev.id);
    expect(c.parentId).toBeUndefined();
    const expectedAnchor: CommentAnchor = {
      blockId: "a".repeat(32) as PlanReviewBlockId,
      quote: "selected text",
    };
    expect(c.anchor).toEqual(expectedAnchor);
    expect(c.body).toBe("test comment");
    expect(c.status).toBe("draft");
    expect(c.depth).toBe(0);
    expect(c.createdBy).toEqual({ type: "user", id: "user-1", name: "Test User" });
    expect(c.createdAt).toBe(c.updatedAt);

    const filePath = join(base, ".vibeflow", "plan-review", "comments", `${c.id}.json`);
    expect(existsSync(filePath)).toBe(true);
    const raw = JSON.parse(readFileSync(filePath, "utf8"));
    expect(raw.id).toBe(c.id);
    expect(raw.status).toBe("draft");
  } finally {
    cleanup(base);
  }
});

test("createComment root updates comment-index.json", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));

    const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
    expect(existsSync(idxPath)).toBe(true);
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    expect(idx.workflowId).toBe("wf-1");
    expect(idx.rootsByRevision[rev.id]).toEqual([c.id]);
  } finally {
    cleanup(base);
  }
});

test("createComment reply inherits anchor and increments depth", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    const reply = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );

    expect(reply.parentId).toBe(root.id);
    expect(reply.depth).toBe(1);
    expect(reply.anchor).toEqual(root.anchor);
    expect(reply.status).toBe("draft");
  } finally {
    cleanup(base);
  }
});

test("createComment reply does not update comment-index", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    store.createComment(makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }));

    const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    expect(idx.rootsByRevision[rev.id]).toEqual([root.id]);
  } finally {
    cleanup(base);
  }
});

test("loadComment returns null for non-existent id", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const loaded = store.loadComment("00000000-0000-0000-0000-000000000000" as CommentId);
    expect(loaded).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadComment returns null for invalid id format", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(store.loadComment("../escape" as CommentId)).toBeNull();
    expect(store.loadComment("bad" as CommentId)).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadComment returns saved comment", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const loaded = store.loadComment(c.id);
    expect(loaded).not.toBeNull();
    if (loaded) {
      expect(loaded.id).toBe(c.id);
      expect(loaded.body).toBe("test comment");
      expect(loaded.depth).toBe(0);
    }
  } finally {
    cleanup(base);
  }
});

test("loadComment rejects invalid status", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const filePath = join(base, ".vibeflow", "plan-review", "comments", `${c.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.status = "resolved";
    writeFileSync(filePath, JSON.stringify(data));
    expect(store.loadComment(c.id)).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadComment rejects mismatched id", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const filePath = join(base, ".vibeflow", "plan-review", "comments", `${c.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.id = "00000000-0000-0000-0000-000000000000";
    writeFileSync(filePath, JSON.stringify(data));
    expect(store.loadComment(c.id)).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadComment rejects invalid createdBy type", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const filePath = join(base, ".vibeflow", "plan-review", "comments", `${c.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.createdBy.type = "bot";
    writeFileSync(filePath, JSON.stringify(data));
    expect(store.loadComment(c.id)).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadComment rejects corrupt json", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const filePath = join(base, ".vibeflow", "plan-review", "comments", `${c.id}.json`);
    writeFileSync(filePath, "not json{{{");
    expect(store.loadComment(c.id)).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("listCommentsByRevision returns comments ordered by creation", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c1 = store.createComment(makeCommentInput(rev.id, { body: "first" }));
    const c2 = store.createComment(makeCommentInput(rev.id, { body: "second" }));
    const list = store.listCommentsByRevision(rev.id);
    expect(list).toHaveLength(2);
    expect(list[0]?.id).toBe(c1.id);
    expect(list[1]?.id).toBe(c2.id);
  } finally {
    cleanup(base);
  }
});

test("listCommentsByRevision returns empty for revision with no comments", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const list = store.listCommentsByRevision(rev.id);
    expect(list).toEqual([]);
  } finally {
    cleanup(base);
  }
});

test("listCommentsByRevision returns empty for invalid id", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(store.listCommentsByRevision("bad" as PlanReviewRevisionId)).toEqual([]);
  } finally {
    cleanup(base);
  }
});

test("listCommentsByThread returns root and replies in order", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    const r1 = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );
    const r2 = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );
    const nested = store.createComment(
      makeCommentInput(rev.id, { parentId: r1.id, anchor: undefined }),
    );

    const thread = store.listCommentsByThread(root.id);
    expect(thread).toHaveLength(4);
    expect(thread[0]?.id).toBe(root.id);
    expect(thread[0]?.depth).toBe(0);
    expect(thread[1]?.id).toBe(r1.id);
    expect(thread[1]?.depth).toBe(1);
    expect(thread[2]?.id).toBe(r2.id);
    expect(thread[2]?.depth).toBe(1);
    expect(thread[3]?.id).toBe(nested.id);
    expect(thread[3]?.depth).toBe(2);
  } finally {
    cleanup(base);
  }
});

test("listCommentsByThread throws for non-existent root", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() =>
      store.listCommentsByThread("00000000-0000-0000-0000-000000000000" as CommentId),
    ).toThrow("Comment not found");
  } finally {
    cleanup(base);
  }
});

test("listCommentsByThread rejects reply as root id", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    const reply = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );
    expect(() => store.listCommentsByThread(reply.id)).toThrow("Root id must not be a reply");
  } finally {
    cleanup(base);
  }
});

test("updateCommentBody modifies body and updates timestamp on draft", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const beforeMs = Date.parse(c.updatedAt);

    const updated = store.updateCommentBody(c.id, "new body");
    expect(updated.body).toBe("new body");
    expect(Date.parse(updated.updatedAt)).toBeGreaterThanOrEqual(beforeMs);

    const loaded = store.loadComment(c.id);
    expect(loaded).not.toBeNull();
    if (loaded) expect(loaded.body).toBe("new body");
  } finally {
    cleanup(base);
  }
});

test("updateCommentBody throws on non-draft comment", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const filePath = join(base, ".vibeflow", "plan-review", "comments", `${c.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.status = "open";
    writeFileSync(filePath, JSON.stringify(data));

    expect(() => store.updateCommentBody(c.id, "new body")).toThrow(
      "Only draft comments can be edited",
    );
  } finally {
    cleanup(base);
  }
});

test("deleteComment removes comment file and descendants", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    const r1 = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );
    const r2 = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );
    const nested = store.createComment(
      makeCommentInput(rev.id, { parentId: r1.id, anchor: undefined }),
    );

    store.deleteComment(root.id);

    const dir = join(base, ".vibeflow", "plan-review", "comments");
    expect(existsSync(join(dir, `${root.id}.json`))).toBe(false);
    expect(existsSync(join(dir, `${r1.id}.json`))).toBe(false);
    expect(existsSync(join(dir, `${r2.id}.json`))).toBe(false);
    expect(existsSync(join(dir, `${nested.id}.json`))).toBe(false);

    expect(store.listCommentsByRevision(rev.id)).toEqual([]);
  } finally {
    cleanup(base);
  }
});

test("deleteComment removes root from comment-index", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    store.deleteComment(root.id);

    const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    expect(idx.rootsByRevision[rev.id]).toEqual([]);
  } finally {
    cleanup(base);
  }
});

test("deleteComment deletes single leaf reply", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    const reply = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );

    store.deleteComment(reply.id);
    expect(store.loadComment(reply.id)).toBeNull();
    expect(store.loadComment(root.id)).not.toBeNull();
  } finally {
    cleanup(base);
  }
});

test("deleteComment throws on non-draft target", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const filePath = join(base, ".vibeflow", "plan-review", "comments", `${c.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.status = "open";
    writeFileSync(filePath, JSON.stringify(data));

    expect(() => store.deleteComment(c.id)).toThrow("Cannot delete non-draft comment");
  } finally {
    cleanup(base);
  }
});

test("deleteComment throws when any descendant is non-draft", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    const reply = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );
    const filePath = join(base, ".vibeflow", "plan-review", "comments", `${reply.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.status = "open";
    writeFileSync(filePath, JSON.stringify(data));

    expect(() => store.deleteComment(root.id)).toThrow("Cannot delete non-draft comment");
    expect(store.loadComment(root.id)).not.toBeNull();
  } finally {
    cleanup(base);
  }
});

test("deleteComment throws on non-existent comment", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() => store.deleteComment("00000000-0000-0000-0000-000000000000" as CommentId)).toThrow(
      "Comment not found",
    );
  } finally {
    cleanup(base);
  }
});

test("createComment rejects non-existent revision", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() =>
      store.createComment(
        makeCommentInput("00000000-0000-0000-0000-000000000000" as PlanReviewRevisionId),
      ),
    ).toThrow("Revision not found");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects non-existent parent", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, {
          parentId: "00000000-0000-0000-0000-000000000000" as CommentId,
          anchor: undefined,
        }),
      ),
    ).toThrow("Parent comment not found");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects cross-revision parent", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev1 = createRevision(store, "wf-1");
    const rev2 = store.createRevision(makeRevInput({ markdown: "second" }));
    const root = store.createComment(makeCommentInput(rev1.id));
    expect(() =>
      store.createComment(makeCommentInput(rev2.id, { parentId: root.id, anchor: undefined })),
    ).toThrow("Parent comment revision mismatch");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects root without anchor", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() => store.createComment(makeCommentInput(rev.id, { anchor: undefined }))).toThrow(
      "Root comment requires anchor",
    );
  } finally {
    cleanup(base);
  }
});

test("createComment rejects reply with anchor", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, {
          parentId: root.id,
          anchor: { blockId: "b".repeat(32) as PlanReviewBlockId, quote: "selected text" },
        }),
      ),
    ).toThrow("Reply comment must not have anchor");
  } finally {
    cleanup(base);
  }
});

test("createComment enforces body byte cap", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const bigBody = "x".repeat(10_001);
    expect(() => store.createComment(makeCommentInput(rev.id, { body: bigBody }))).toThrow(
      "comment body exceeds cap",
    );
  } finally {
    cleanup(base);
  }
});

test("createComment enforces depth cap", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const ids: CommentId[] = [];
    for (let i = 0; i <= MAX_COMMENT_DEPTH + 1; i++) {
      const input =
        i === 0
          ? makeCommentInput(rev.id)
          : makeCommentInput(rev.id, { parentId: ids[i - 1], anchor: undefined });
      if (i <= MAX_COMMENT_DEPTH) {
        const c = store.createComment(input);
        ids.push(c.id);
      } else {
        expect(() => store.createComment(input)).toThrow("comment depth exceeds cap");
      }
    }
  } finally {
    cleanup(base);
  }
});

test("createComment enforces count cap per revision", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    for (let i = 0; i < 100; i++) {
      store.createComment(makeCommentInput(rev.id, { body: `c${i}` }));
    }
    expect(() => store.createComment(makeCommentInput(rev.id, { body: "overflow" }))).toThrow(
      "comments per revision exceeds cap",
    );
  } finally {
    cleanup(base);
  }
});

test("loadCommentIndex returns null before any comment", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(store.loadCommentIndex()).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadCommentIndex returns index after root comment created", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const idx = store.loadCommentIndex();
    expect(idx).not.toBeNull();
    if (idx) {
      expect(idx.workflowId).toBe("wf-1");
      expect(idx.rootsByRevision[rev.id]).toEqual([c.id]);
    }
  } finally {
    cleanup(base);
  }
});

test("updateCommentBody enforces body byte cap", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    expect(() => store.updateCommentBody(c.id, "x".repeat(10_001))).toThrow(
      "comment body exceeds cap",
    );
  } finally {
    cleanup(base);
  }
});

test("updateCommentBody throws on non-existent comment", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() =>
      store.updateCommentBody("00000000-0000-0000-0000-000000000000" as CommentId, "new"),
    ).toThrow("Comment not found");
  } finally {
    cleanup(base);
  }
});

test("listCommentsByRevision only returns comments from specified revision", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev1 = createRevision(store, "wf-1");
    const rev2 = store.createRevision(makeRevInput({ markdown: "other" }));
    const c1 = store.createComment(makeCommentInput(rev1.id));
    const c2 = store.createComment(makeCommentInput(rev2.id));

    const list1 = store.listCommentsByRevision(rev1.id);
    expect(list1).toHaveLength(1);
    expect(list1[0]?.id).toBe(c1.id);

    const list2 = store.listCommentsByRevision(rev2.id);
    expect(list2).toHaveLength(1);
    expect(list2[0]?.id).toBe(c2.id);
  } finally {
    cleanup(base);
  }
});

test("createComment rejects empty createdBy.id", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, { createdBy: { type: "user", id: "", name: "T" } }),
      ),
    ).toThrow("createdBy.id must be non-empty");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects empty createdBy.name", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, { createdBy: { type: "user", id: "u1", name: "" } }),
      ),
    ).toThrow("createdBy.name must be non-empty");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects invalid createdBy.type", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, { createdBy: { type: "bot", id: "u1", name: "Bot" } as never }),
      ),
    ).toThrow("createdBy.type must be 'user' or 'agent'");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects invalid revisionId format", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() => store.createComment(makeCommentInput("bad" as PlanReviewRevisionId))).toThrow(
      "Invalid revision ID",
    );
  } finally {
    cleanup(base);
  }
});

test("createComment rejects invalid parentId format", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, { parentId: "bad" as CommentId, anchor: undefined }),
      ),
    ).toThrow("Invalid parent comment ID");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects anchor with empty quote", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, {
          anchor: { blockId: "a".repeat(32) as PlanReviewBlockId, quote: "" },
        }),
      ),
    ).toThrow("Anchor quote must be non-empty");
  } finally {
    cleanup(base);
  }
});

test("createComment validates anchor blockId belongs to revision blocks", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const badBlockId = "b".repeat(32) as PlanReviewBlockId;
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, { anchor: { blockId: badBlockId, quote: "text" } }),
      ),
    ).toThrow("not found in revision blocks");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects comment index workflowId mismatch", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    store.createComment(makeCommentInput(rev.id));

    const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    idx.workflowId = "wf-other";
    writeFileSync(idxPath, JSON.stringify(idx));

    const rev2 = store.createRevision(makeRevInput({ markdown: "second" }));
    expect(() =>
      store.createComment(
        makeCommentInput(rev2.id, {
          anchor: { blockId: "a".repeat(32) as PlanReviewBlockId, quote: "text" },
        }),
      ),
    ).toThrow("Comment index workflowId mismatch");
  } finally {
    cleanup(base);
  }
});

test("createComment accepts agent createdBy type", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(
      makeCommentInput(rev.id, { createdBy: { type: "agent", id: "agent-1", name: "Agent" } }),
    );
    expect(c.createdBy.type).toBe("agent");
  } finally {
    cleanup(base);
  }
});

test("loadAllComments skips corrupt/invalid comment files", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    store.createComment(makeCommentInput(rev.id));

    const dir = join(base, ".vibeflow", "plan-review", "comments");
    writeFileSync(join(dir, "invalid.json"), "{{{ bad");
    writeFileSync(join(dir, "not-a-uuid.json"), JSON.stringify({ id: "bad" }));

    expect(store.listCommentsByRevision(rev.id)).toHaveLength(1);
  } finally {
    cleanup(base);
  }
});

// --- strict validateCommentSchema tests ---

function validComment() {
  return {
    id: "00000000-0000-0000-0000-000000000001",
    revisionId: "00000000-0000-0000-0000-000000000002",
    status: "draft",
    body: "hello",
    depth: 0,
    createdAt: "2024-01-01T00:00:00.000Z",
    updatedAt: "2024-01-01T00:00:00.000Z",
    createdBy: { type: "user", id: "u1", name: "User" },
    anchor: { blockId: "a".repeat(32), quote: "selected" },
  };
}

test("validateCommentSchema accepts valid comment", () => {
  expect(validateCommentSchema(validComment())).not.toBeNull();
});

test("validateCommentSchema rejects missing anchor", () => {
  const c = validComment() as Record<string, unknown>;
  c.anchor = null;
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects whitespace-only quote", () => {
  const c = validComment();
  c.anchor = { blockId: "a".repeat(32), quote: "   \t\n  " };
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects quote exceeding byte cap", () => {
  const c = validComment();
  c.anchor = { blockId: "a".repeat(32), quote: "x".repeat(MAX_QUOTE_LENGTH + 1) };
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects non-finite range startOffset", () => {
  const c = validComment() as Record<string, unknown>;
  c.anchor = {
    blockId: "a".repeat(32),
    quote: "ok",
    range: { startOffset: Number.POSITIVE_INFINITY, endOffset: 5 },
  };
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects NaN range endOffset", () => {
  const c = validComment() as Record<string, unknown>;
  c.anchor = {
    blockId: "a".repeat(32),
    quote: "ok",
    range: { startOffset: 0, endOffset: Number.NaN },
  };
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects non-integer range offsets", () => {
  const c = validComment() as Record<string, unknown>;
  c.anchor = { blockId: "a".repeat(32), quote: "ok", range: { startOffset: 1.5, endOffset: 3 } };
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects negative range offsets", () => {
  const c = validComment() as Record<string, unknown>;
  c.anchor = { blockId: "a".repeat(32), quote: "ok", range: { startOffset: -1, endOffset: 3 } };
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects start > end in range", () => {
  const c = validComment() as Record<string, unknown>;
  c.anchor = { blockId: "a".repeat(32), quote: "ok", range: { startOffset: 10, endOffset: 5 } };
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema accepts valid range with start <= end", () => {
  const c = validComment() as Record<string, unknown>;
  c.anchor = { blockId: "a".repeat(32), quote: "ok", range: { startOffset: 0, endOffset: 0 } };
  expect(validateCommentSchema(c)).not.toBeNull();
});

test("validateCommentSchema rejects body exceeding byte cap", () => {
  const c = validComment();
  c.body = "x".repeat(MAX_COMMENT_BODY_BYTES + 1);
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects non-integer depth", () => {
  const c = validComment();
  c.depth = 1.5;
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects negative depth", () => {
  const c = validComment();
  c.depth = -1;
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects depth > MAX_COMMENT_DEPTH", () => {
  const c = validComment();
  c.depth = MAX_COMMENT_DEPTH + 1;
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects invalid ISO createdAt", () => {
  const c = validComment();
  c.createdAt = "not-a-date";
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects invalid ISO updatedAt", () => {
  const c = validComment();
  c.updatedAt = "nope";
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects createdBy with empty id", () => {
  const c = validComment();
  c.createdBy = { type: "user", id: "", name: "X" };
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects createdBy with empty name", () => {
  const c = validComment();
  c.createdBy = { type: "agent", id: "a1", name: "" };
  expect(validateCommentSchema(c)).toBeNull();
});

test("validateCommentSchema rejects createdBy with invalid type", () => {
  const c = validComment();
  c.createdBy = { type: "bot", id: "b1", name: "Bot" };
  expect(validateCommentSchema(c)).toBeNull();
});

// --- strict validateCommentIndexSchema / readCommentIndexFile tests ---

test("validateCommentIndexSchema accepts valid index", () => {
  const idx = {
    workflowId: "wf-1",
    rootsByRevision: {
      "00000000-0000-0000-0000-000000000002": ["00000000-0000-0000-0000-000000000001"],
    },
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  expect(validateCommentIndexSchema(idx)).not.toBeNull();
});

test("validateCommentIndexSchema rejects empty workflowId", () => {
  const idx = { workflowId: "", rootsByRevision: {}, updatedAt: "2024-01-01T00:00:00.000Z" };
  expect(validateCommentIndexSchema(idx)).toBeNull();
});

test("validateCommentIndexSchema rejects invalid updatedAt", () => {
  const idx = { workflowId: "wf-1", rootsByRevision: {}, updatedAt: "bad" };
  expect(validateCommentIndexSchema(idx)).toBeNull();
});

test("validateCommentIndexSchema rejects invalid revision key", () => {
  const idx = {
    workflowId: "wf-1",
    rootsByRevision: { "bad-key": [] },
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  expect(validateCommentIndexSchema(idx)).toBeNull();
});

test("validateCommentIndexSchema rejects invalid comment id in array", () => {
  const idx = {
    workflowId: "wf-1",
    rootsByRevision: { "00000000-0000-0000-0000-000000000002": ["not-valid"] },
    updatedAt: "2024-01-01T00:00:00.000Z",
  };
  expect(validateCommentIndexSchema(idx)).toBeNull();
});

test("readCommentIndexFile returns null on invalid schema", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    store.createComment(makeCommentInput(rev.id));

    const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
    writeFileSync(
      idxPath,
      JSON.stringify({ workflowId: "", rootsByRevision: {}, updatedAt: "bad" }),
    );

    expect(store.loadCommentIndex()).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("readCommentIndexFile returns null on corrupt JSON", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    store.createComment(makeCommentInput(rev.id));

    const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
    writeFileSync(idxPath, "{not valid json");

    expect(store.loadCommentIndex()).toBeNull();
  } finally {
    cleanup(base);
  }
});

// --- submitComment tests ---

test("submitComment transitions root comment from draft to open", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    expect(c.status).toBe("draft");

    const submitted = store.submitComment(c.id);
    expect(submitted.status).toBe("open");
    expect(submitted.id).toBe(c.id);
    expect(Date.parse(submitted.updatedAt)).toBeGreaterThanOrEqual(Date.parse(c.updatedAt));

    const loaded = store.loadComment(c.id);
    expect(loaded?.status).toBe("open");
  } finally {
    cleanup(base);
  }
});

test("submitComment transitions reply comment from draft to open", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    const reply = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );

    const submitted = store.submitComment(reply.id);
    expect(submitted.status).toBe("open");
    expect(submitted.depth).toBe(1);
  } finally {
    cleanup(base);
  }
});

test("submitComment rejects non-draft comment with clear error", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    store.submitComment(c.id);

    expect(() => store.submitComment(c.id)).toThrow("Only draft comments can be submitted");
  } finally {
    cleanup(base);
  }
});

test("submitComment updates timestamp", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    const before = Date.parse(c.updatedAt);

    const submitted = store.submitComment(c.id);
    expect(Date.parse(submitted.updatedAt)).toBeGreaterThanOrEqual(before);
  } finally {
    cleanup(base);
  }
});

test("cannot edit open comment after submit", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    store.submitComment(c.id);

    expect(() => store.updateCommentBody(c.id, "changed")).toThrow(
      "Only draft comments can be edited",
    );
  } finally {
    cleanup(base);
  }
});

test("cannot delete open comment after submit", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c = store.createComment(makeCommentInput(rev.id));
    store.submitComment(c.id);

    expect(() => store.deleteComment(c.id)).toThrow("Cannot delete non-draft comment");
  } finally {
    cleanup(base);
  }
});

test("cannot delete parent when child is open", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    const reply = store.createComment(
      makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }),
    );
    store.submitComment(reply.id);

    expect(() => store.deleteComment(root.id)).toThrow("Cannot delete non-draft comment");
    expect(store.loadComment(root.id)).not.toBeNull();
  } finally {
    cleanup(base);
  }
});

// --- timestamp ordering regression tests ---

test("rapid root comments have strictly increasing createdAt", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const comments = [];
    for (let i = 0; i < 20; i++) {
      comments.push(store.createComment(makeCommentInput(rev.id, { body: `c${i}` })));
    }
    for (let i = 1; i < comments.length; i++) {
      const cur = comments[i] as (typeof comments)[0];
      const prev = comments[i - 1] as (typeof comments)[0];
      expect(Date.parse(cur.createdAt)).toBeGreaterThan(Date.parse(prev.createdAt));
    }
    const list = store.listCommentsByRevision(rev.id);
    for (let i = 1; i < list.length; i++) {
      const cur = list[i] as (typeof list)[0];
      const expected = comments[i] as (typeof comments)[0];
      expect(cur.id).toBe(expected.id);
    }
  } finally {
    cleanup(base);
  }
});

test("replies have strictly increasing createdAt after root", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));
    const replies = [];
    for (let i = 0; i < 10; i++) {
      replies.push(
        store.createComment(makeCommentInput(rev.id, { parentId: root.id, anchor: undefined })),
      );
    }
    const first = replies[0] as (typeof replies)[0];
    expect(Date.parse(first.createdAt)).toBeGreaterThan(Date.parse(root.createdAt));
    for (let i = 1; i < replies.length; i++) {
      const cur = replies[i] as (typeof replies)[0];
      const prev = replies[i - 1] as (typeof replies)[0];
      expect(Date.parse(cur.createdAt)).toBeGreaterThan(Date.parse(prev.createdAt));
    }
  } finally {
    cleanup(base);
  }
});

test("separate store instances preserve ordering via comment-index updatedAt floor", () => {
  const base = tempDir();
  try {
    const store1 = createPlanReviewStore({ base });
    const rev = store1.createRevision(makeRevInput());
    const c1 = store1.createComment(makeCommentInput(rev.id, { body: "from store1" }));

    const store2 = createPlanReviewStore({ base });
    const c2 = store2.createComment(makeCommentInput(rev.id, { body: "from store2" }));

    expect(Date.parse(c2.createdAt)).toBeGreaterThan(Date.parse(c1.createdAt));

    const list = store2.listCommentsByRevision(rev.id);
    expect((list[0] as (typeof list)[0]).id).toBe(c1.id);
    expect((list[1] as (typeof list)[0]).id).toBe(c2.id);
  } finally {
    cleanup(base);
  }
});

test("createComment rejects invalid anchor blockId format", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, {
          anchor: { blockId: "has spaces!" as PlanReviewBlockId, quote: "text" },
        }),
      ),
    ).toThrow("Invalid anchor blockId");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects non-finite range offsets", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, {
          anchor: {
            blockId: "a".repeat(32) as PlanReviewBlockId,
            quote: "text",
            range: { startOffset: Number.POSITIVE_INFINITY, endOffset: 5 },
          },
        }),
      ),
    ).toThrow("Anchor range offsets must be finite");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects non-integer range offsets", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, {
          anchor: {
            blockId: "a".repeat(32) as PlanReviewBlockId,
            quote: "text",
            range: { startOffset: 1.5, endOffset: 5 },
          },
        }),
      ),
    ).toThrow("Anchor range offsets must be integers");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects range start > end", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    expect(() =>
      store.createComment(
        makeCommentInput(rev.id, {
          anchor: {
            blockId: "a".repeat(32) as PlanReviewBlockId,
            quote: "text",
            range: { startOffset: 10, endOffset: 5 },
          },
        }),
      ),
    ).toThrow("Anchor range start must not exceed end");
  } finally {
    cleanup(base);
  }
});

test("createComment rejects corrupt comment-index with 400 and no writes", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    store.createComment(makeCommentInput(rev.id, { body: "first" }));

    const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
    writeFileSync(idxPath, "{{{corrupt json");

    const commentsBefore = store.listCommentsByRevision(rev.id);
    expect(() => store.createComment(makeCommentInput(rev.id, { body: "should fail" }))).toThrow(
      "Corrupt comment-index file",
    );

    const commentsAfter = store.listCommentsByRevision(rev.id);
    expect(commentsAfter.length).toBe(commentsBefore.length);
  } finally {
    cleanup(base);
  }
});

test("createComment corrupt index: root count preserved, no orphan", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const c1 = store.createComment(makeCommentInput(rev.id, { body: "keeper" }));

    const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
    const idxBefore = JSON.parse(readFileSync(idxPath, "utf8"));
    writeFileSync(idxPath, "null");

    expect(() => store.createComment(makeCommentInput(rev.id, { body: "fail" }))).toThrow(
      "Corrupt comment-index file",
    );

    writeFileSync(idxPath, JSON.stringify(idxBefore));
    const idx = store.loadCommentIndex();
    expect(idx).not.toBeNull();
    if (!idx) return;
    expect(idx.rootsByRevision[rev.id]).toEqual([c1.id]);
  } finally {
    cleanup(base);
  }
});

test("assertValidCommentId throws on invalid id", () => {
  expect(() => assertValidCommentId("bad")).toThrow("Invalid comment ID: bad");
});
test("reply updates comment-index updatedAt but not rootsByRevision", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = createRevision(store);
    const root = store.createComment(makeCommentInput(rev.id));

    const idxPath = join(base, ".vibeflow", "plan-review", "comment-index.json");
    const idxBefore = JSON.parse(readFileSync(idxPath, "utf8"));

    store.createComment(makeCommentInput(rev.id, { parentId: root.id, anchor: undefined }));

    const idxAfter = JSON.parse(readFileSync(idxPath, "utf8"));
    expect(Date.parse(idxAfter.updatedAt)).toBeGreaterThan(Date.parse(idxBefore.updatedAt));
    expect(idxAfter.rootsByRevision[rev.id]).toEqual([root.id]);
  } finally {
    cleanup(base);
  }
});
