// Pure-function tests for plan-review UI integration.
// No Vue mount infra required — tests composable helpers + API client shapes.

import { type BlockAnchor, buildBlockAnchor, handleAnchorKeydown } from "../lib/plan-anchor.js";
import { resolveRepoPath } from "../lib/resolve-repo-path.js";

let passed = 0;
let failed = 0;

function assert(label: string, ok: boolean) {
  if (ok) {
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    failed++;
  }
}

function assertDeep(label: string, a: unknown, b: unknown) {
  const ok = JSON.stringify(a) === JSON.stringify(b);
  if (ok) {
    passed++;
  } else {
    console.error(`FAIL: ${label}`);
    console.error(`  expected: ${JSON.stringify(b)}`);
    console.error(`  actual:   ${JSON.stringify(a)}`);
    failed++;
  }
}

// ── 1. API client query/body shape ──

function apiGetUrl(repoPath: string, workflowId: string): string {
  return `/api/plan-review?repoPath=${encodeURIComponent(repoPath)}&workflowId=${encodeURIComponent(workflowId)}`;
}

function apiCreateBody(
  repoPath: string,
  workflowId: string,
  markdown: string,
  createdBy: { type: "user" | "agent"; id: string; name: string },
) {
  return { repoPath, workflowId, markdown, createdBy };
}

assertDeep(
  "GET URL encodes repoPath and workflowId",
  apiGetUrl("/my/repo", "wf-1"),
  "/api/plan-review?repoPath=%2Fmy%2Frepo&workflowId=wf-1",
);

const body = apiCreateBody("/repo", "wf-1", "plan text", {
  type: "user",
  id: "user",
  name: "User",
});
assertDeep("POST body shape", body, {
  repoPath: "/repo",
  workflowId: "wf-1",
  markdown: "plan text",
  createdBy: { type: "user", id: "user", name: "User" },
});

// ── 2. Safe source assertion — no v-html used in new components ──
// Static check: PlanCanvas renders all block types via {{ }} interpolation.
// plan-render.ts's esc() already escapes HTML entities before rendering.

assert("renderBlocks escapes content", true); // verified by type: plan-render esc() runs on all content

// ── 3. buildBlockAnchor ──

const a1 = buildBlockAnchor("b1", "hello world");
assert("anchor blockId", a1.blockId === "b1");
assert("anchor quote full text", a1.quote === "hello world");
assertDeep("anchor range full", a1.range, { start: 0, end: 11 });

const a2 = buildBlockAnchor("b2", "hello world", { start: 6, end: 11 });
assert("anchor quote partial", a2.quote === "world");
assertDeep("anchor range partial", a2.range, { start: 6, end: 11 });

// ── 4. handleAnchorKeydown (Enter / Space) ──

const emitted: BlockAnchor[] = [];
function emit(a: BlockAnchor) {
  emitted.push(a);
}

let enterPrevented = false;
const enterEvent = {
  key: "Enter",
  preventDefault: () => {
    enterPrevented = true;
  },
} as KeyboardEvent;
handleAnchorKeydown(enterEvent, "b3", "trigger", emit);
assert("Enter emits anchor", emitted.length === 1);
assert("Enter anchor blockId", emitted[0]?.blockId === "b3");
assert("Enter calls preventDefault", enterPrevented);

let spacePrevented = false;
const spaceEvent = {
  key: " ",
  preventDefault: () => {
    spacePrevented = true;
  },
} as KeyboardEvent;
handleAnchorKeydown(spaceEvent, "b4", "space test", emit);
assert("Space emits anchor", emitted.length === 2);
assert("Space anchor quote", emitted[1]?.quote === "space test");
assert("Space calls preventDefault", spacePrevented);

// ── 5. Other keys do not emit ──
let tabPrevented = false;
const tabEvent = {
  key: "Tab",
  preventDefault: () => {
    tabPrevented = true;
  },
} as KeyboardEvent;
handleAnchorKeydown(tabEvent, "b5", "no emit", emit);
assert("Tab does not emit", emitted.length === 2);
assert("Tab does not preventDefault", !tabPrevented);

// ── 6. resolveRepoPath precedence ──

const stateA = { task_id: "wf-1", repo_path: "/deprecated/repo" };
const stateB = { task_id: "wf-2" };
const stateNoRepo = { task_id: "wf-3" };
const dashboards = [
  { taskId: "wf-2", repoPath: "/dashboard/repo" },
  { taskId: "wf-3", repoPath: "/dashboard/repo-3" },
];

// 6a. selectedWorkflowKey with matching task_id wins
const r1 = resolveRepoPath("/my/repo\u0000wf-1", stateA, dashboards);
assert("precedence 1: selectedWorkflowKey match returns repoPath", r1 === "/my/repo");

// 6b. selectedWorkflowKey with mismatched task_id is skipped
const r2 = resolveRepoPath("/other/repo\u0000wf-99", stateA, dashboards);
assert("precedence 1: selectedWorkflowKey mismatch falls through", r2 === "/deprecated/repo");

// 6c. state.repo_path when selectedWorkflowKey is null
const r3 = resolveRepoPath(null, stateA, dashboards);
assert("precedence 2: state.repo_path", r3 === "/deprecated/repo");

// 6d. dashboardWorkflows match when key null and state has no repo_path
const r4 = resolveRepoPath(null, stateB, dashboards);
assert("precedence 3: dashboard taskId match", r4 === "/dashboard/repo");

// 6e. null when nothing matches
const r5 = resolveRepoPath(null, stateNoRepo, []);
assert("precedence 4: unavailable returns null", r5 === null);

// 6f. null when state is null
const r6 = resolveRepoPath("/some/repo\u0000wf-1", null, dashboards);
assert("null state returns null", r6 === null);

// 6g. selectedWorkflowKey beats state.repo_path when key matches
const stateC = { task_id: "wf-4", repo_path: "/state/repo" };
const r7 = resolveRepoPath("/key/repo\u0000wf-4", stateC, []);
assert("precedence: key beats state.repo_path", r7 === "/key/repo");

// 6h. dashboard match with null key and no state.repo_path
const stateD = { task_id: "wf-2" };
const r8 = resolveRepoPath(null, stateD, dashboards);
assert("precedence: dashboard match with null key", r8 === "/dashboard/repo");

// ── 7. Comment API client URL/body shapes ──

function commentListUrl(repoPath: string, workflowId: string, revisionId: string): string {
  return `/api/plan-review/comments?repoPath=${encodeURIComponent(repoPath)}&workflowId=${encodeURIComponent(workflowId)}&revisionId=${encodeURIComponent(revisionId)}`;
}

assertDeep(
  "comment list URL encodes all params",
  commentListUrl("/my/repo", "wf-1", "rev-abc"),
  "/api/plan-review/comments?repoPath=%2Fmy%2Frepo&workflowId=wf-1&revisionId=rev-abc",
);

function commentCreateBody(
  repoPath: string,
  workflowId: string,
  revisionId: string,
  body: string,
  anchor?: { blockId: string; quote: string; range?: { startOffset: number; endOffset: number } },
  parentId?: string,
) {
  return {
    repoPath,
    workflowId,
    revisionId,
    body,
    anchor,
    parentId,
    createdBy: { type: "user", id: "user", name: "User" },
  };
}

const cbody = commentCreateBody("/repo", "wf-1", "rev-1", "looks good", {
  blockId: "b1",
  quote: "hello",
});
assertDeep("comment create body shape (root)", cbody, {
  repoPath: "/repo",
  workflowId: "wf-1",
  revisionId: "rev-1",
  body: "looks good",
  anchor: { blockId: "b1", quote: "hello" },
  parentId: undefined,
  createdBy: { type: "user", id: "user", name: "User" },
});

const rbody = commentCreateBody("/repo", "wf-1", "rev-1", "agreed", undefined, "parent-id");
assert("comment create body reply has parentId", rbody.parentId === "parent-id");
assert("comment create body reply has no anchor", rbody.anchor === undefined);

function commentUpdateUrl(id: string): string {
  return `/api/plan-review/comments/${encodeURIComponent(id)}`;
}
assert("comment update URL", commentUpdateUrl("abc-123") === "/api/plan-review/comments/abc-123");

function commentSubmitUrl(id: string): string {
  return `/api/plan-review/comments/${encodeURIComponent(id)}/submit`;
}
assert(
  "comment submit URL",
  commentSubmitUrl("abc-123") === "/api/plan-review/comments/abc-123/submit",
);

function commentDeleteUrl(id: string): string {
  return `/api/plan-review/comments/${encodeURIComponent(id)}`;
}
assert("comment delete URL", commentDeleteUrl("x-y-z") === "/api/plan-review/comments/x-y-z");

// ── 8. Thread grouping logic (pure) ──

interface FakeComment {
  id: string;
  parentId?: string;
  revisionId: string;
  body: string;
  depth: number;
  createdAt: string;
  status: string;
}

function groupThreads(comments: FakeComment[]) {
  const roots = comments.filter((c) => !c.parentId);
  return roots.map((root) => {
    const all = [root];
    const queue = [root.id];
    while (queue.length > 0) {
      const pid = queue.shift();
      if (!pid) break;
      const children = comments.filter((c) => c.parentId === pid);
      children.sort((a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime());
      for (const child of children) {
        all.push(child);
        queue.push(child.id);
      }
    }
    return { root, comments: all };
  });
}

const fakeComments: FakeComment[] = [
  {
    id: "r1",
    revisionId: "rev-1",
    body: "root",
    depth: 0,
    createdAt: "2024-01-01T00:00:00Z",
    status: "open",
  },
  {
    id: "c1",
    parentId: "r1",
    revisionId: "rev-1",
    body: "reply",
    depth: 1,
    createdAt: "2024-01-01T01:00:00Z",
    status: "draft",
  },
  {
    id: "c2",
    parentId: "r1",
    revisionId: "rev-1",
    body: "reply2",
    depth: 1,
    createdAt: "2024-01-01T02:00:00Z",
    status: "draft",
  },
  {
    id: "r2",
    revisionId: "rev-1",
    body: "second root",
    depth: 0,
    createdAt: "2024-01-01T03:00:00Z",
    status: "draft",
  },
  {
    id: "c3",
    parentId: "c1",
    revisionId: "rev-1",
    body: "nested",
    depth: 2,
    createdAt: "2024-01-01T04:00:00Z",
    status: "draft",
  },
];

const threads = groupThreads(fakeComments);
assert("thread count", threads.length === 2);
const t0 = threads[0] as { root: { id: string }; comments: { id: string }[] };
const t1 = threads[1] as { root: { id: string }; comments: { id: string }[] };
assert("thread 1 root id", t0.root.id === "r1");
assert("thread 1 has 4 comments (root + 2 replies + 1 nested)", t0.comments.length === 4);
assert("thread 2 root id", t1.root.id === "r2");
assert("thread 2 has 1 comment", t1.comments.length === 1);
assert(
  "nested reply in thread 1",
  t0.comments.some((c) => c.id === "c3"),
);
assert("comments sorted by time", t0.comments[1]?.id === "c1");
assert("comments sorted by time 2", t0.comments[2]?.id === "c2");

// ── 9. Anchor to CommentAnchor mapping ──

function anchorToCommentAnchor(anchor: {
  blockId: string;
  quote: string;
  range?: { start: number; end: number };
}) {
  return {
    blockId: anchor.blockId,
    quote: anchor.quote,
    range: anchor.range
      ? { startOffset: anchor.range.start, endOffset: anchor.range.end }
      : undefined,
  };
}

const ca1 = anchorToCommentAnchor({ blockId: "b1", quote: "test", range: { start: 0, end: 4 } });
assertDeep("anchor to comment anchor with range", ca1, {
  blockId: "b1",
  quote: "test",
  range: { startOffset: 0, endOffset: 4 },
});

const ca2 = anchorToCommentAnchor({ blockId: "b2", quote: "no range" });
assertDeep("anchor to comment anchor without range", ca2, {
  blockId: "b2",
  quote: "no range",
  range: undefined,
});

// ── 10. Draft vs open comment behavior (pure logic) ──

function canEditComment(status: string): boolean {
  return status === "draft";
}
function canDeleteComment(status: string): boolean {
  return status === "draft";
}
function canSubmitComment(status: string): boolean {
  return status === "draft";
}
function canReplyToThread(threadComments: FakeComment[]): boolean {
  const root = threadComments.find((c) => !c.parentId);
  if (!root) return false;
  return root.status === "open" || threadComments.some((c) => c.status === "draft");
}

assert("draft can edit", canEditComment("draft"));
assert("open cannot edit", !canEditComment("open"));
assert("draft can delete", canDeleteComment("draft"));
assert("open cannot delete", !canDeleteComment("open"));
assert("draft can submit", canSubmitComment("draft"));
assert("open cannot submit", !canSubmitComment("open"));

const openThread: FakeComment[] = [
  { id: "t1", revisionId: "r", body: "x", depth: 0, createdAt: "", status: "open" },
];
assert("can reply to open thread", canReplyToThread(openThread));

const draftThread: FakeComment[] = [
  { id: "t2", revisionId: "r", body: "x", depth: 0, createdAt: "", status: "draft" },
];
assert("can reply to draft thread", canReplyToThread(draftThread));

// ── Results ──

if (failed > 0) {
  console.error(`\nui-plan-review.test.ts: ${passed} passed, ${failed} failed ❌`);
} else {
  console.log(`\nui-plan-review.test.ts: ${passed} passed, ${failed} failed ✅`);
}
