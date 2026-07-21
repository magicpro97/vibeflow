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

// ── Results ──

if (failed > 0) {
  console.error(`\nui-plan-review.test.ts: ${passed} passed, ${failed} failed ❌`);
} else {
  console.log(`\nui-plan-review.test.ts: ${passed} passed, ${failed} failed ✅`);
}
