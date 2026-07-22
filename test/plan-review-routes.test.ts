import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readState, writeState } from "../src/core.js";
import { createPlanReviewStore } from "../src/plan-review/store.js";
import { deleteRegistry, readRegistry, upsertRegistry } from "../src/registry.js";
import { startServer } from "../src/server.js";

async function csrfToken(url: string): Promise<string> {
  const res = await fetch(url);
  const html = await res.text();
  const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
  if (!m) throw new Error("CSRF token not found");
  return m[1] as string;
}

function tmpRepo(): string {
  const base = mkdtempSync(join(tmpdir(), "vf-pr-route-"));
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

describe("GET /api/plan-review", () => {
  test("unknown repo → 400", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(
        `${url}/api/plan-review?repoPath=${encodeURIComponent("/no/such/repo")}&workflowId=wf-1`,
        { headers: { "x-vibeflow-token": token } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("repo not found");
    } finally {
      server.stop();
    }
  });

  test("known repo, wrong workflow → 404", async () => {
    const base = tmpRepo();
    seedState(base, "wf-alpha");
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(
        `${url}/api/plan-review?repoPath=${encodeURIComponent(base)}&workflowId=wrong-wf`,
        { headers: { "x-vibeflow-token": token } },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("workflow not found");
    } finally {
      server.stop();
      cleanup(base);
    }
  });

  test("no plan review index → 404", async () => {
    const base = tmpRepo();
    seedState(base, "wf-beta");
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(
        `${url}/api/plan-review?repoPath=${encodeURIComponent(base)}&workflowId=wf-beta`,
        { headers: { "x-vibeflow-token": token } },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("no plan review");
    } finally {
      server.stop();
      cleanup(base);
    }
  });

  test("GET rejects index with mismatched workflowId", async () => {
    const base = tmpRepo();
    const wfId = "wf-idx-mm";
    seedState(base, wfId);
    register(base);
    const store = createPlanReviewStore({ base });
    store.createRevision({
      workflowId: wfId,
      markdown: "# Test",
      blocks: [],
      createdBy: { type: "user", id: "u1", name: "T" },
    });
    const idxPath = join(base, ".vibeflow", "plan-review", "index.json");
    const idx = JSON.parse(readFileSync(idxPath, "utf8"));
    idx.workflowId = "wrong-wf";
    writeFileSync(idxPath, JSON.stringify(idx));
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(
        `${url}/api/plan-review?repoPath=${encodeURIComponent(base)}&workflowId=${wfId}`,
        { headers: { "x-vibeflow-token": token } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("workflowId mismatch");
    } finally {
      server.stop();
      cleanup(base);
    }
  });

  test("GET rejects revision with mismatched workflowId", async () => {
    const base = tmpRepo();
    const wfId = "wf-rev-mm";
    seedState(base, wfId);
    register(base);
    const store = createPlanReviewStore({ base });
    const rev = store.createRevision({
      workflowId: wfId,
      markdown: "# Test",
      blocks: [],
      createdBy: { type: "user", id: "u1", name: "T" },
    });
    const revPath = join(base, ".vibeflow", "plan-review", "revisions", `${rev.id}.json`);
    const rdata = JSON.parse(readFileSync(revPath, "utf8"));
    rdata.workflowId = "other-wf";
    writeFileSync(revPath, JSON.stringify(rdata));
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(
        `${url}/api/plan-review?repoPath=${encodeURIComponent(base)}&workflowId=${wfId}`,
        { headers: { "x-vibeflow-token": token } },
      );
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("workflowId mismatch");
    } finally {
      server.stop();
      cleanup(base);
    }
  });

  test("happy path: stored revision returned with revisions array", async () => {
    const base = tmpRepo();
    const wfId = "wf-happy";
    seedState(base, wfId);
    register(base);
    const store = createPlanReviewStore({ base });
    store.createRevision({
      workflowId: wfId,
      markdown: "# Plan\n\nStep 1",
      blocks: [],
      createdBy: { type: "user", id: "u1", name: "Tester" },
    });
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(
        `${url}/api/plan-review?repoPath=${encodeURIComponent(base)}&workflowId=${wfId}`,
        { headers: { "x-vibeflow-token": token } },
      );
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        index: { currentRevisionId: string };
        revision: { id: string; workflowId: string; markdown: string };
        revisions: Array<{ id: string }>;
        blocks: unknown[];
      };
      expect(body.index.currentRevisionId).toBeTruthy();
      expect(body.revision.id).toBeTruthy();
      expect(body.revision.workflowId).toBe(wfId);
      expect(body.revision.markdown).toContain("# Plan");
      expect(Array.isArray(body.revisions)).toBe(true);
      expect(body.revisions).toHaveLength(1);
      expect(body.revisions[0]?.id).toBe(body.revision.id);
      expect(Array.isArray(body.blocks)).toBe(true);
    } finally {
      server.stop();
      cleanup(base);
    }
  });
});

describe("POST /api/plan-review/revisions", () => {
  test("creates a revision and updates index", async () => {
    const base = tmpRepo();
    const wfId = "wf-post-1";
    seedState(base, wfId);
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(`${url}/api/plan-review/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
        body: JSON.stringify({
          repoPath: base,
          workflowId: wfId,
          markdown: "# My Plan\n\nDo the thing.\n\n```js\nconst x = 1;\n```",
          createdBy: { type: "user", id: "user-1", name: "Alice" },
        }),
      });
      expect(res.status).toBe(200);
      const body = (await res.json()) as {
        revision: { id: string; workflowId: string; blocks: unknown[] };
        index: { currentRevisionId: string };
      };
      expect(body.revision.workflowId).toBe(wfId);
      expect(body.revision.blocks.length).toBeGreaterThan(0);
      expect(body.index.currentRevisionId).toBe(body.revision.id);
    } finally {
      server.stop();
      cleanup(base);
    }
  });

  test("missing repoPath → 400", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(`${url}/api/plan-review/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
        body: JSON.stringify({
          workflowId: "wf",
          markdown: "test",
          createdBy: { type: "user", id: "u1", name: "T" },
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("repoPath");
    } finally {
      server.stop();
    }
  });

  test("missing createdBy → 400", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(`${url}/api/plan-review/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
        body: JSON.stringify({ repoPath: "/tmp", workflowId: "wf", markdown: "test" }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("createdBy");
    } finally {
      server.stop();
    }
  });

  test("invalid createdBy.type → 400", async () => {
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(`${url}/api/plan-review/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
        body: JSON.stringify({
          repoPath: "/tmp",
          workflowId: "wf",
          markdown: "test",
          createdBy: { type: "bot", id: "u1", name: "T" },
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.stop();
    }
  });

  test("POST with malformed marker returns 400", async () => {
    const base = tmpRepo();
    const wfId = "wf-bad-marker";
    seedState(base, wfId);
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(`${url}/api/plan-review/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
        body: JSON.stringify({
          repoPath: base,
          workflowId: wfId,
          markdown: "<!-- vf:block:ZZZZ -->\nhello",
          createdBy: { type: "user", id: "u1", name: "T" },
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.stop();
      cleanup(base);
    }
  });

  test("POST with duplicate marker returns 400", async () => {
    const base = tmpRepo();
    const wfId = "wf-dup-marker";
    seedState(base, wfId);
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(`${url}/api/plan-review/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
        body: JSON.stringify({
          repoPath: base,
          workflowId: wfId,
          markdown:
            "<!-- vf:block:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->\nhello\n<!-- vf:block:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa -->\nworld",
          createdBy: { type: "user", id: "u1", name: "T" },
        }),
      });
      expect(res.status).toBe(400);
    } finally {
      server.stop();
      cleanup(base);
    }
  });

  test("no token → 403", async () => {
    const { server, url } = await startServer();
    try {
      const res = await fetch(`${url}/api/plan-review/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          repoPath: "/tmp",
          workflowId: "wf",
          markdown: "test",
          createdBy: { type: "user", id: "u1", name: "T" },
        }),
      });
      expect(res.status).toBe(403);
    } finally {
      server.stop();
    }
  });

  test("POST with markdown exceeding cap returns 400", async () => {
    const base = tmpRepo();
    const wfId = "wf-cap";
    seedState(base, wfId);
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(`${url}/api/plan-review/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
        body: JSON.stringify({
          repoPath: base,
          workflowId: wfId,
          markdown: "x".repeat(1_000_001),
          createdBy: { type: "user", id: "u1", name: "T" },
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("exceeds cap");
    } finally {
      server.stop();
      cleanup(base);
    }
  });
});

describe("handleMutationRoute coverage", () => {
  test("DELETE /api/plan-review/comments/<uuid> with empty body reaches 404 not JSON parse", async () => {
    const base = tmpRepo();
    const wfId = "wf-del-cmt";
    seedState(base, wfId);
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const fakeId = "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee";
      const res = await fetch(
        `${url}/api/plan-review/comments/${fakeId}?repoPath=${encodeURIComponent(base)}&workflowId=${wfId}`,
        { method: "DELETE", headers: { "x-vibeflow-token": token } },
      );
      expect(res.status).toBe(404);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("comment not found");
    } finally {
      server.stop();
      cleanup(base);
    }
  });

  test("POST /api/plan-review/comments with payload reaches handler path", async () => {
    const base = tmpRepo();
    const wfId = "wf-post-cmt";
    seedState(base, wfId);
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const res = await fetch(`${url}/api/plan-review/comments`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
        body: JSON.stringify({
          repoPath: base,
          workflowId: wfId,
        }),
      });
      expect(res.status).toBe(400);
      const body = (await res.json()) as { error: string };
      expect(body.error).toContain("revisionId");
    } finally {
      server.stop();
      cleanup(base);
    }
  });
});

describe("GET /api/plan-review with seeded plan via POST", () => {
  test("full round-trip: POST then GET returns same data", async () => {
    const base = tmpRepo();
    const wfId = "wf-rt";
    seedState(base, wfId);
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);

      const postRes = await fetch(`${url}/api/plan-review/revisions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
        body: JSON.stringify({
          repoPath: base,
          workflowId: wfId,
          markdown: "# Roundtrip\n\n- item 1\n- item 2",
          createdBy: { type: "agent", id: "agent-42", name: "Codex" },
        }),
      });
      expect(postRes.status).toBe(200);
      const postBody = (await postRes.json()) as {
        revision: { id: string; blocks: { type: string; content: string }[] };
      };
      expect(postBody.revision.blocks.some((b) => b.type === "list-run")).toBe(true);

      const getRes = await fetch(
        `${url}/api/plan-review?repoPath=${encodeURIComponent(base)}&workflowId=${wfId}`,
        { headers: { "x-vibeflow-token": token } },
      );
      expect(getRes.status).toBe(200);
      const getBody = (await getRes.json()) as {
        revision: { id: string };
        revisions: { id: string }[];
        blocks: unknown[];
      };
      expect(getBody.revision.id).toBe(postBody.revision.id);
      expect(getBody.revisions.length).toBe(1);
      expect((getBody.revisions as Array<{ id: string }>)[0]?.id).toBe(postBody.revision.id);
    } finally {
      server.stop();
      cleanup(base);
    }
  });

  test("multiple POSTs then GET returns all revisions newest first", async () => {
    const base = tmpRepo();
    const wfId = "wf-multi";
    seedState(base, wfId);
    register(base);
    const { server, url } = await startServer();
    try {
      const token = await csrfToken(url);
      const ids: string[] = [];
      for (let i = 0; i < 3; i++) {
        const res = await fetch(`${url}/api/plan-review/revisions`, {
          method: "POST",
          headers: { "Content-Type": "application/json", "x-vibeflow-token": token },
          body: JSON.stringify({
            repoPath: base,
            workflowId: wfId,
            markdown: `# Rev ${i}`,
            createdBy: { type: "user", id: `u${i}`, name: `User ${i}` },
          }),
        });
        const b = (await res.json()) as { revision: { id: string } };
        ids.push(b.revision.id);
      }

      const getRes = await fetch(
        `${url}/api/plan-review?repoPath=${encodeURIComponent(base)}&workflowId=${wfId}`,
        { headers: { "x-vibeflow-token": token } },
      );
      expect(getRes.status).toBe(200);
      const body = (await getRes.json()) as {
        revision: { id: string };
        revisions: { id: string; createdAt: string }[];
      };
      expect(body.revisions.length).toBe(3);
      expect(body.revisions[0]?.id).toBe(ids[2]);
      expect(body.revisions[1]?.id).toBe(ids[1]);
      expect(body.revisions[2]?.id).toBe(ids[0]);
    } finally {
      server.stop();
      cleanup(base);
    }
  });
});
