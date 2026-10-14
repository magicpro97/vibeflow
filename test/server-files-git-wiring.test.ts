import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { startServer } from "../src/server.js";
import { defaultRunGit } from "../src/server/files-tree-route.js";

/** Fetch the CSRF token from the HTML page served at `/`. */
async function csrfToken(url: string): Promise<string> {
  const res = await fetch(url);
  const html = await res.text();
  const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
  if (!m) throw new Error("CSRF token not found in page HTML");
  return m[1] as string;
}

const post = (url: string, route: string, body: unknown, token?: string) =>
  fetch(`${url}${route}`, {
    method: "POST",
    headers: {
      "content-type": "application/json",
      ...(token ? { "x-vibeflow-token": token } : {}),
    },
    body: JSON.stringify(body),
  });

interface GitResp {
  ok?: boolean;
  changed?: number;
  reason?: string;
  error?: string;
}

/** Temp repo with one commit — `restore --staged` needs a HEAD to restore from. */
function seededRepo(): string {
  const repo = mkdtempSync(join(tmpdir(), "vf-files-git-"));
  writeFileSync(join(repo, "tracked.txt"), "one\n");
  defaultRunGit(["init", "-q"], repo);
  defaultRunGit(["add", "--", "tracked.txt"], repo);
  defaultRunGit(
    [
      "-c",
      "user.email=t@example.com",
      "-c",
      "user.name=t",
      "-c",
      "commit.gpgsign=false",
      "commit",
      "-q",
      "-m",
      "seed",
    ],
    repo,
  );
  return repo;
}

// The stage/unstage block lives inline in server.ts (routes.ts is at the 400
// cap) and self-guards: these tests drive the REAL defaultRunGit, not a fake.
describe("POST /api/files/stage|unstage wiring (inline block in server.ts)", () => {
  test("missing token → 403 (self-guarded, unlike a global isWrite check)", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-files-git-"));
    try {
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const res = await post(url, "/api/files/stage", { paths: ["tracked.txt"] });
        expect(res.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("with token, an invalid paths list → 400 before any git call", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-files-git-"));
    try {
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        for (const body of [{}, { paths: [] }, { paths: ["../escape.ts"] }, "not-an-object"]) {
          const res = await post(url, "/api/files/unstage", body, token);
          expect(res.status, JSON.stringify(body)).toBe(400);
          expect(((await res.json()) as GitResp).error).toBe("invalid paths");
        }
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("with token: stage moves the path into the index, unstage takes it back out", async () => {
    const callerCwd = process.cwd();
    const repo = seededRepo();
    try {
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        writeFileSync(join(repo, "tracked.txt"), "one\ntwo\n");
        const staged = await post(url, "/api/files/stage", { paths: ["tracked.txt"] }, token);
        expect(staged.status).toBe(200);
        expect(await staged.json()).toEqual({ ok: true, changed: 1 });
        expect(defaultRunGit(["diff", "--cached", "--name-only"], repo).stdout.trim()).toBe(
          "tracked.txt",
        );

        const unstaged = await post(url, "/api/files/unstage", { paths: ["tracked.txt"] }, token);
        expect(unstaged.status).toBe(200);
        expect(await unstaged.json()).toEqual({ ok: true, changed: 1 });
        expect(defaultRunGit(["diff", "--cached", "--name-only"], repo).stdout.trim()).toBe("");
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("real git failure → 200 ok:false with git's own stderr as a non-empty reason", async () => {
    const callerCwd = process.cwd();
    const repo = seededRepo();
    const bogus = "definitely-not-a-tracked-path-xyz.ts";
    try {
      // Pin the seam the failure path depends on: defaultRunGit captures stderr.
      const direct = defaultRunGit(["add", "--", bogus], repo);
      expect(direct.status).not.toBe(0);
      expect((direct.stderr ?? "").trim().length).toBeGreaterThan(0);

      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const res = await post(url, "/api/files/stage", { paths: [bogus] }, token);
        expect(res.status).toBe(200); // a git failure is NOT an HTTP error
        const body = (await res.json()) as GitResp;
        expect(body.ok).toBe(false);
        expect(typeof body.reason).toBe("string");
        expect(body.reason?.length).toBeGreaterThan(0);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
