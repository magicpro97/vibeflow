import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import vm from "node:vm";

const AsyncFunction = vm.runInThisContext("(async function () {}).constructor");

const WORKFLOW = readFileSync(".github/workflows/review-thread-gate.yml", "utf8");

const START = "// review-thread-gate:start";
const END = "// review-thread-gate:end";
const SCRIPT = (() => {
  const start = WORKFLOW.indexOf(START);
  const end = WORKFLOW.indexOf(END);
  if (start === -1 || end === -1 || end < start) {
    throw new Error("review-thread-gate inline script block markers missing");
  }
  // Strip the two marker comments, keep the body between them.
  const from = start + START.length;
  return WORKFLOW.slice(from, end).trim();
})();

interface FakeContext {
  repo: { owner: string; repo: string };
  payload: { pull_request: { number: number; head: { sha: string } } };
}

interface ThreadNode {
  isResolved: boolean;
  isOutdated: boolean;
  path: string | null;
  line: number | null;
  comments: { nodes: Array<{ author: { login: string } | null; url: string | null }> };
}

function page(headRefOid: string, nodes: ThreadNode[], hasNextPage: false): Record<string, unknown>;

function page(
  headRefOid: string,
  nodes: ThreadNode[],
  hasNextPage: true,
  cursor: string,
): Record<string, unknown>;

function page(
  headRefOid: string,
  nodes: ThreadNode[],
  hasNextPage: boolean,
  cursor: string | null = null,
): Record<string, unknown> {
  return {
    repository: {
      pullRequest: {
        headRefOid,
        reviewThreads: {
          nodes,
          pageInfo: { hasNextPage, endCursor: hasNextPage ? cursor : null },
        },
      },
    },
  };
}

interface Harness {
  run: (ctx: FakeContext, pages: Record<string, unknown>[]) => Promise<void>;
  calls: Record<string, unknown>[];
  failures: string[];
}

function makeHarness(): Harness {
  const calls: Record<string, unknown>[] = [];
  const failures: string[] = [];
  let index = 0;
  const github = {
    graphql: async (_query: string, vars: Record<string, unknown>) => {
      calls.push(vars);
      const p = pages[index++];
      if (p === undefined) throw new Error("fake: no more pages queued");
      return p;
    },
  };
  let pages: Record<string, unknown>[] = [];
  const core = {
    info: () => {},
    setFailed: (message: string) => failures.push(message),
  };
  const run = async (ctx: FakeContext, queued: Record<string, unknown>[]): Promise<void> => {
    calls.length = 0;
    failures.length = 0;
    index = 0;
    pages = queued;
    const fn = AsyncFunction("github", "context", "core", SCRIPT);
    await fn(github, ctx, core);
  };
  return { run, calls, failures };
}

const SHA8 = "0123456789abcdef0123456789abcdef01234567";

function ctx(overrides: Partial<FakeContext> = {}): FakeContext {
  return {
    repo: { owner: "magicpro97", repo: "vibeflow" },
    payload: { pull_request: { number: 123, head: { sha: SHA8 } } },
    ...overrides,
  };
}

function thread(node: Partial<ThreadNode> = {}): ThreadNode {
  return {
    isResolved: false,
    isOutdated: false,
    path: "src/main.ts",
    line: 42,
    comments: { nodes: [{ author: { login: "reviewer" }, url: "https://example.com/c1" }] },
    ...node,
  };
}

describe("review-thread-gate workflow (static)", () => {
  test("triggers on PR, review, and review-comment events", () => {
    expect(WORKFLOW).toContain("opened, synchronize, reopened, ready_for_review");
    expect(WORKFLOW).toContain("pull_request_review:");
    expect(WORKFLOW).toContain("submitted, edited, dismissed");
    expect(WORKFLOW).toContain("pull_request_review_comment:");
    expect(WORKFLOW).toContain("created, edited, deleted");
    expect(WORKFLOW).toContain("if: github.event.pull_request.base.ref == 'main'");
  });

  test("pins exact actions/github-script SHA and v7.0.1 tag", () => {
    expect(WORKFLOW).toContain("actions/github-script@60a0d83039c74a4aee543508d2ffcb1c3799cdea");
    expect(WORKFLOW).toContain("# v7.0.1");
  });

  test("default permissions empty and job only requests read", () => {
    expect(WORKFLOW).toMatch(/^permissions:\s*\{\}/m);
    expect(WORKFLOW).toContain("pull-requests: read");
    expect(WORKFLOW).not.toContain("contents: read");
    expect(WORKFLOW).not.toContain("contents: write");
    expect(WORKFLOW).not.toContain("pull-requests: write");
  });

  test("no checkout, no pull_request_target, stable job name", () => {
    expect(WORKFLOW).not.toContain("actions/checkout");
    expect(WORKFLOW).not.toContain("checkout@");
    expect(WORKFLOW).not.toContain("pull_request_target");
    expect(WORKFLOW).toContain("review-thread-gate:");
    expect(WORKFLOW).toMatch(/name: review-thread-gate/);
  });
});

describe("review-thread-gate inline algorithm", () => {
  test("two-page response uses second page cursor and fails only on page-two thread", async () => {
    const h = makeHarness();
    await h.run(ctx(), [
      page(SHA8, [thread({ isResolved: true })], true, "c1"),
      page(SHA8, [thread({ path: "b.ts" })], false),
    ]);
    expect(h.failures.length).toBe(1);
    expect(h.failures[0]).toContain("1 unresolved");
    expect(h.failures[0]).toContain("b.ts");
  });

  test("resolved threads pass", async () => {
    const h = makeHarness();
    await h.run(ctx(), [page(SHA8, [thread({ isResolved: true })], false)]);
    expect(h.failures).toEqual([]);
  });

  test("outdated unresolved threads pass as non-current", async () => {
    const h = makeHarness();
    await h.run(ctx(), [page(SHA8, [thread({ isOutdated: true })], false)]);
    expect(h.failures).toEqual([]);
  });

  test("current unresolved thread fails with path, line, author, URL", async () => {
    const h = makeHarness();
    await h.run(ctx(), [page(SHA8, [thread()], false)]);
    expect(h.failures.length).toBe(1);
    expect(h.failures[0]).toContain("src/main.ts");
    expect(h.failures[0]).toContain("42");
    expect(h.failures[0]).toContain("reviewer");
    expect(h.failures[0]).toContain("https://example.com/c1");
  });

  test("headRefOid different from event SHA fails stale-SHA check", async () => {
    const h = makeHarness();
    const other = "ffffffffffffffffffffffffffffffffffffffff";
    await h.run(ctx(), [page(other, [thread({ isResolved: true })], false)]);
    expect(h.failures.length).toBe(1);
    expect(h.failures[0]).toContain(other.slice(0, 8));
    expect(h.failures[0]).toContain(SHA8.slice(0, 8));
  });

  test("null pullRequest fails closed", async () => {
    const h = makeHarness();
    const p = { repository: { pullRequest: null } };
    await h.run(ctx(), [p]);
    expect(h.failures.length).toBe(1);
  });

  test("malformed response shape (missing reviewThreads) fails closed", async () => {
    const h = makeHarness();
    const p = { repository: { pullRequest: {} } };
    await h.run(ctx(), [p]);
    expect(h.failures.length).toBe(1);
  });

  test("hasNextPage true with null cursor fails closed", async () => {
    const h = makeHarness();
    const p = {
      repository: {
        pullRequest: {
          headRefOid: SHA8,
          reviewThreads: { nodes: [], pageInfo: { hasNextPage: true, endCursor: null } },
        },
      },
    };
    await h.run(ctx(), [p, p]);
    expect(h.failures.length).toBe(1);
  });

  test("repeated pagination cursor fails closed", async () => {
    const h = makeHarness();
    const p = page(SHA8, [], true, "same");
    await h.run(ctx(), [p, p]);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toContain("repeated pagination cursor");
  });

  test("missing path is rendered safely", async () => {
    const h = makeHarness();
    await h.run(ctx(), [page(SHA8, [thread({ path: null, line: null })], false)]);
    expect(h.failures).toHaveLength(1);
    expect(h.failures[0]).toContain("(unknown path):?");
    expect(h.failures[0]).not.toContain("null");
  });

  test(">100 pages fails bounded-pagination guard", async () => {
    const h = makeHarness();
    const pages = Array.from({ length: 101 }, (_, i) => page(SHA8, [], true, `c${i}`));
    await h.run(ctx(), pages);
    expect(h.failures.length).toBe(1);
    expect(h.failures[0]).toMatch(/100|page/i);
  });

  test("invalid pull_request number fails closed", async () => {
    const h = makeHarness();
    await h.run(ctx({ payload: { pull_request: { number: 0, head: { sha: SHA8 } } } }), []);
    expect(h.failures.length).toBe(1);
  });

  test("invalid head sha format fails closed", async () => {
    const h = makeHarness();
    await h.run(ctx({ payload: { pull_request: { number: 5, head: { sha: "not-a-sha" } } } }), []);
    expect(h.failures.length).toBe(1);
  });
});
