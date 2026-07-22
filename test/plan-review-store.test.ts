import { expect, test } from "bun:test";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPlanReviewStore } from "../src/plan-review/store.js";
import type {
  CreateRevisionInput,
  PlanReviewBlock,
  PlanReviewBlockId,
  PlanReviewRevision,
  PlanReviewRevisionId,
} from "../src/plan-review/types.js";
import { isValidRevisionId } from "../src/plan-review/types.js";

function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "vf-pr-store-"));
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

function makeInput(overrides: Partial<CreateRevisionInput> = {}): CreateRevisionInput {
  return {
    workflowId: "wf-1",
    markdown: "hello",
    blocks: [dummyBlock()],
    createdBy: { type: "user", id: "user-1", name: "Test User" },
    ...overrides,
  };
}

function cleanup(base: string): void {
  rmSync(base, { recursive: true, force: true });
}

test("createRevision writes revision to revisions/<id>.json and creates index.json", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision(makeInput());
    expect(isValidRevisionId(rev.id)).toBe(true);
    expect(rev.blocks).toHaveLength(1);
    expect(typeof rev.createdAt).toBe("string");
    expect(rev.createdAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(rev.workflowId).toBe("wf-1");
    expect(rev.createdBy).toEqual({ type: "user", id: "user-1", name: "Test User" });
    expect(rev.status).toBe("draft");

    const revPath = join(base, ".vibeflow", "plan-review", "revisions", `${rev.id}.json`);
    expect(existsSync(revPath)).toBe(true);
    const raw = readFileSync(revPath, "utf8");
    const parsed = JSON.parse(raw);
    expect(parsed.id).toBe(rev.id);
    expect(parsed.workflowId).toBe("wf-1");
    expect(parsed.createdBy.type).toBe("user");
    expect(parsed.createdAt).toBe(rev.createdAt);

    const idxPath = join(base, ".vibeflow", "plan-review", "index.json");
    expect(existsSync(idxPath)).toBe(true);
    const idxRaw = readFileSync(idxPath, "utf8");
    const idx = JSON.parse(idxRaw);
    expect(idx.workflowId).toBe("wf-1");
    expect(idx.currentRevisionId).toBe(rev.id);
    expect(typeof idx.updatedAt).toBe("string");
  } finally {
    cleanup(base);
  }
});

test("index persists workflowId, currentRevisionId, acceptedRevisionId, updatedAt", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const r1 = store.createRevision(makeInput());
    const idx1 = store.loadIndex();
    expect(idx1).not.toBeNull();
    if (idx1 === null) return;
    expect(idx1.workflowId).toBe("wf-1");
    expect(idx1.currentRevisionId).toBe(r1.id);
    expect(idx1.acceptedRevisionId).toBeUndefined();
    expect(typeof idx1.updatedAt).toBe("string");

    const r2 = store.createRevision(makeInput({ parentId: r1.id }));
    const idx2 = store.loadIndex();
    expect(idx2).not.toBeNull();
    if (idx2 === null) return;
    expect(idx2.currentRevisionId).toBe(r2.id);
  } finally {
    cleanup(base);
  }
});

test("loadRevision returns saved revision", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision(makeInput());
    const loaded = store.loadRevision(rev.id);
    expect(loaded).not.toBeNull();
    if (loaded === null) return;
    expect(loaded.id).toBe(rev.id);
    expect(loaded.blocks).toHaveLength(1);
    expect(loaded.createdAt).toBe(rev.createdAt);
  } finally {
    cleanup(base);
  }
});

test("loadRevision returns null for non-existent id", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const loaded = store.loadRevision(
      "00000000-0000-0000-0000-000000000000" as PlanReviewRevisionId,
    );
    expect(loaded).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadRevision returns null for invalid id format", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const loaded = store.loadRevision("../escape" as PlanReviewRevisionId);
    expect(loaded).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("createRevision guards against existing file via injected existsSync", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({
      base,
      existsSync: () => true,
      readFileSync: () =>
        JSON.stringify({ workflowId: "wf-1", currentRevisionId: null, updatedAt: "" }),
      readdirSync: () => [],
    });
    expect(() => store.createRevision(makeInput())).toThrow("Revision already exists");
  } finally {
    cleanup(base);
  }
});

test("listRevisions returns ids from revisions/ dir", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const r1 = store.createRevision(makeInput());
    const r2 = store.createRevision(makeInput({ blocks: [dummyBlock({ content: "world" })] }));
    const ids = store.listRevisions();
    expect(ids).toHaveLength(2);
    expect(ids).toContain(r1.id);
    expect(ids).toContain(r2.id);
  } finally {
    cleanup(base);
  }
});

test("listRevisions returns empty when no revisions exist", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(store.listRevisions()).toEqual([]);
  } finally {
    cleanup(base);
  }
});

test("no deleteRevision on store", () => {
  const store = createPlanReviewStore();
  expect((store as unknown as Record<string, unknown>).deleteRevision).toBeUndefined();
});

test("revisions are immutable — no delete API exposed", () => {
  const store = createPlanReviewStore();
  store.createRevision(makeInput());
  const keys = Object.keys(store);
  expect(keys).not.toContain("deleteRevision");
});

test("comment methods are exposed on store", () => {
  const store = createPlanReviewStore();
  expect(typeof store.createComment).toBe("function");
  expect(typeof store.loadComment).toBe("function");
  expect(typeof store.listCommentsByRevision).toBe("function");
  expect(typeof store.listCommentsByThread).toBe("function");
  expect(typeof store.updateCommentBody).toBe("function");
  expect(typeof store.deleteComment).toBe("function");
  expect(typeof store.loadCommentIndex).toBe("function");
});

test("createRevision enforces blocks cap", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const lotsaBlocks = Array.from({ length: 1001 }, (_, i) => dummyBlock({ content: `b${i}` }));
    expect(() => store.createRevision(makeInput({ blocks: lotsaBlocks }))).toThrow(
      "blocks exceeds cap",
    );
  } finally {
    cleanup(base);
  }
});

test("createRevision with empty blocks list", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision(makeInput({ blocks: [] }));
    expect(rev.blocks).toHaveLength(0);
    expect(isValidRevisionId(rev.id)).toBe(true);
  } finally {
    cleanup(base);
  }
});

test("loadRevision returns null when stored JSON id mismatches requested id", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision(makeInput());
    const filePath = join(base, ".vibeflow", "plan-review", "revisions", `${rev.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.id = "00000000-0000-0000-0000-000000000000";
    writeFileSync(filePath, JSON.stringify(data));
    expect(store.loadRevision(rev.id)).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadRevision returns null when id field is missing from stored JSON", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision(makeInput());
    const filePath = join(base, ".vibeflow", "plan-review", "revisions", `${rev.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.id = undefined;
    writeFileSync(filePath, JSON.stringify(data));
    expect(store.loadRevision(rev.id)).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadRevision returns null when stored JSON has empty workflowId", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision(makeInput());
    const filePath = join(base, ".vibeflow", "plan-review", "revisions", `${rev.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.workflowId = "";
    writeFileSync(filePath, JSON.stringify(data));
    expect(store.loadRevision(rev.id)).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadRevision returns null when stored JSON has invalid status", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision(makeInput());
    const filePath = join(base, ".vibeflow", "plan-review", "revisions", `${rev.id}.json`);
    const data = JSON.parse(readFileSync(filePath, "utf8"));
    data.status = "deleted";
    writeFileSync(filePath, JSON.stringify(data));
    expect(store.loadRevision(rev.id)).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadRevision returns null for corrupt json file", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision(makeInput());
    const filePath = join(base, ".vibeflow", "plan-review", "revisions", `${rev.id}.json`);
    writeFileSync(filePath, "not json{{}");
    const loaded = store.loadRevision(rev.id);
    expect(loaded).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("loadIndex returns null before any revision, valid after", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(store.loadIndex()).toBeNull();
    const rev = store.createRevision(makeInput());
    const idx = store.loadIndex();
    expect(idx).not.toBeNull();
    if (idx === null) return;
    expect(idx.workflowId).toBe("wf-1");
    expect(idx.currentRevisionId).toBe(rev.id);
    expect(idx.updatedAt).toBeTruthy();
  } finally {
    cleanup(base);
  }
});

test("loadIndex returns null for corrupt index JSON", () => {
  const base = tempDir();
  try {
    mkdirSync(join(base, ".vibeflow", "plan-review"), { recursive: true });
    writeFileSync(join(base, ".vibeflow", "plan-review", "index.json"), "{{{ bad json");
    const store = createPlanReviewStore({ base });
    expect(store.loadIndex()).toBeNull();
  } finally {
    cleanup(base);
  }
});

test("isValidRevisionId accepts standard UUID", () => {
  expect(isValidRevisionId("550e8400-e29b-41d4-a716-446655440000")).toBe(true);
});

test("isValidRevisionId rejects non-UUID strings", () => {
  expect(isValidRevisionId("abc123")).toBe(false);
  expect(isValidRevisionId("../evil")).toBe(false);
  expect(isValidRevisionId("")).toBe(false);
  expect(isValidRevisionId("a".repeat(32))).toBe(false);
});

test("createRevision rejects empty workflowId", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() => store.createRevision(makeInput({ workflowId: "" }))).toThrow(
      "workflowId must be non-empty",
    );
  } finally {
    cleanup(base);
  }
});

test("createRevision rejects invalid parentId format", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() =>
      store.createRevision(makeInput({ parentId: "not-a-uuid" as PlanReviewRevisionId })),
    ).toThrow("Invalid parent revision ID");
  } finally {
    cleanup(base);
  }
});

test("createRevision rejects parent revision not found", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() =>
      store.createRevision(
        makeInput({ parentId: "00000000-0000-0000-0000-000000000000" as PlanReviewRevisionId }),
      ),
    ).toThrow("Parent revision not found");
  } finally {
    cleanup(base);
  }
});

test("createRevision rejects parent revision with different workflowId", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const r1 = store.createRevision(makeInput({ workflowId: "wf-1" }));
    expect(() =>
      store.createRevision(
        makeInput({
          workflowId: "wf-2",
          parentId: r1.id,
        }),
      ),
    ).toThrow("Parent revision workflowId mismatch");
  } finally {
    cleanup(base);
  }
});

test("createRevision rejects workflowId mismatch against existing index", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    store.createRevision(makeInput({ workflowId: "wf-1" }));
    expect(() => store.createRevision(makeInput({ workflowId: "wf-2" }))).toThrow(
      "Workflow mismatch",
    );
  } finally {
    cleanup(base);
  }
});

test("createRevision rejects empty createdBy.id", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() =>
      store.createRevision(makeInput({ createdBy: { type: "user", id: "", name: "Test" } })),
    ).toThrow("createdBy.id must be non-empty");
  } finally {
    cleanup(base);
  }
});

test("createRevision rejects empty createdBy.name", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    expect(() =>
      store.createRevision(makeInput({ createdBy: { type: "user", id: "u1", name: "" } })),
    ).toThrow("createdBy.name must be non-empty");
  } finally {
    cleanup(base);
  }
});

test("createRevision enforces markdown byte cap", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const bigMd = "x".repeat(1_000_001);
    expect(() => store.createRevision(makeInput({ markdown: bigMd }))).toThrow(
      "markdown exceeds cap",
    );
  } finally {
    cleanup(base);
  }
});

test("createRevision enforces block content byte cap", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const bigContent = "x".repeat(100_001);
    expect(() =>
      store.createRevision(makeInput({ blocks: [dummyBlock({ content: bigContent })] })),
    ).toThrow("block content exceeds cap");
  } finally {
    cleanup(base);
  }
});

test("listRevisionsByWorkflow returns newest first, filters by workflowId", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const r1 = store.createRevision(makeInput({ workflowId: "wf-a", markdown: "first" }));
    const r2 = store.createRevision(makeInput({ workflowId: "wf-a", markdown: "second" }));
    const r3 = store.createRevision(makeInput({ workflowId: "wf-a", markdown: "third" }));

    const all = store.listRevisionsByWorkflow("wf-a");
    expect(all).toHaveLength(3);
    expect(all[0]?.id).toBe(r3.id);
    expect(all[1]?.id).toBe(r2.id);
    expect(all[2]?.id).toBe(r1.id);
    expect(all.length >= 3).toBe(true);
    const createdAt0 = all[0]?.createdAt ?? "";
    const createdAt1 = all[1]?.createdAt ?? "";
    const createdAt2 = all[2]?.createdAt ?? "";
    expect(createdAt0 > createdAt1).toBe(true);
    expect(createdAt1 > createdAt2).toBe(true);
  } finally {
    cleanup(base);
  }
});

test("createRevision createdAt strictly monotonic under rapid calls", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const N = 100;
    for (let i = 0; i < N; i++) {
      store.createRevision(makeInput({ markdown: `rev-${i}` }));
    }
    const all = store.listRevisionsByWorkflow("wf-1", N);
    expect(all).toHaveLength(N);
    for (let i = 1; i < all.length; i++) {
      const prev = all[i - 1];
      const cur = all[i];
      if (!prev || !cur) break;
      expect(prev.createdAt > cur.createdAt).toBe(true);
    }
  } finally {
    cleanup(base);
  }
});

test("listRevisionsByWorkflow excludes different workflowId", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const r1 = store.createRevision(makeInput({ workflowId: "wf-a", markdown: "a" }));
    // Manually write a revision with different workflowId (bypasses index guard)
    const otherId = "00000000-0000-0000-0000-000000000001" as PlanReviewRevisionId;
    const revPath = join(base, ".vibeflow", "plan-review", "revisions", `${otherId}.json`);
    writeFileSync(
      revPath,
      JSON.stringify({
        id: otherId,
        workflowId: "wf-b",
        markdown: "b",
        blocks: [],
        createdAt: new Date().toISOString(),
        createdBy: { type: "user", id: "u1", name: "T" },
        status: "draft",
      }),
    );

    const a = store.listRevisionsByWorkflow("wf-a");
    expect(a).toHaveLength(1);
    expect(a[0]?.workflowId).toBe("wf-a");
    const b = store.listRevisionsByWorkflow("wf-b");
    expect(b).toHaveLength(1);
    expect(b[0]?.workflowId).toBe("wf-b");
  } finally {
    cleanup(base);
  }
});

test("listRevisionsByWorkflow respects limit", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    store.createRevision(makeInput({ workflowId: "wf-c", markdown: "1" }));
    store.createRevision(makeInput({ workflowId: "wf-c", markdown: "2" }));
    store.createRevision(makeInput({ workflowId: "wf-c", markdown: "3" }));
    expect(store.listRevisionsByWorkflow("wf-c", 2).length).toBe(2);
    expect(store.listRevisionsByWorkflow("wf-c", 0).length).toBe(0);
  } finally {
    cleanup(base);
  }
});

test("listRevisionsByWorkflow handles corrupt revisions gracefully", () => {
  const base = tempDir();
  try {
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision(makeInput({ workflowId: "wf-d", markdown: "fine" }));
    const revPath = join(base, ".vibeflow", "plan-review", "revisions", `${rev.id}.json`);
    writeFileSync(revPath, "bad json{{{");
    const result = store.listRevisionsByWorkflow("wf-d");
    expect(result.length).toBe(0);
  } finally {
    cleanup(base);
  }
});
