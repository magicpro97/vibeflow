import { describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, statSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";

import { startServer } from "../src/server";

/** Fetch the CSRF token from the HTML page served at `/`. */
async function csrfToken(url: string): Promise<string> {
  const res = await fetch(url);
  const html = await res.text();
  const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
  if (!m) throw new Error("CSRF token not found in page HTML");
  return m[1] as string;
}

interface FileResp {
  ok: boolean;
  path?: string;
  content?: string;
  truncated?: boolean;
  reason?: string;
}

const get = (url: string, path: string, token?: string) =>
  fetch(`${url}/api/file?path=${encodeURIComponent(path)}`, {
    headers: token ? { "x-vibeflow-token": token } : {},
  });

describe("GET /api/file (#558 sandboxed file-read route)", () => {
  test("happy path — an in-repo file returns ok:true with content", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    try {
      writeFileSync(join(repo, "package.json"), '{"name":"fixture"}');
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const res = await get(url, "package.json", token);
        expect(res.status).toBe(200);
        const body = (await res.json()) as FileResp;
        expect(body.ok).toBe(true);
        expect(body.path).toBe("package.json");
        expect(body.truncated).toBe(false);
        expect(body.content).toContain('"name"');
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("`../` traversal → 403", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    try {
      writeFileSync(join(repo, "package.json"), '{"name":"fixture"}');
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const res = await get(url, "../../../etc/passwd", token);
        expect(res.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("absolute path → 403", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    try {
      writeFileSync(join(repo, "package.json"), '{"name":"fixture"}');
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const res = await get(url, "/etc/passwd", token);
        expect(res.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("`~` home-relative → 403", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    try {
      writeFileSync(join(repo, "package.json"), '{"name":"fixture"}');
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const res = await get(url, "~/secret.txt", token);
        expect(res.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("symlink escaping the repo → 403", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    const outside = mkdtempSync(join(tmpdir(), "vf-outside-"));
    const outsideFile = join(outside, "leak.txt");
    const link = join(repo, "escape.txt");
    writeFileSync(outsideFile, "SECRET");
    symlinkSync(outsideFile, link);
    try {
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const rel = relative(repo, link);
        const res = await get(url, rel, token);
        expect(res.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
      rmSync(outside, { recursive: true, force: true });
    }
  });

  test("missing token → 403", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    try {
      writeFileSync(join(repo, "package.json"), '{"name":"fixture"}');
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const res = await get(url, "package.json");
        expect(res.status).toBe(403);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("oversize file (> 256 KB) → 413", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    const big = join(repo, "big.txt");
    writeFileSync(big, "x".repeat(256 * 1024 + 1));
    try {
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const res = await get(url, relative(repo, big), token);
        expect(res.status).toBe(413);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("binary file (NUL byte) → ok:false reason:binary", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    const bin = join(repo, "bin.dat");
    writeFileSync(bin, "abc\u0000def");
    try {
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const res = await get(url, relative(repo, bin), token);
        expect(res.status).toBe(200);
        const body = (await res.json()) as FileResp;
        expect(body.ok).toBe(false);
        expect(body.reason).toBe("binary");
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("non-existent file → 404", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    try {
      writeFileSync(join(repo, "package.json"), '{"name":"fixture"}');
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const res = await get(url, "does-not-exist-558.txt", token);
        expect(res.status).toBe(404);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });

  test("a directory (not a regular file) → 404", async () => {
    const callerCwd = process.cwd();
    const repo = mkdtempSync(join(tmpdir(), "vf-repo-"));
    try {
      mkdirSync(join(repo, "src"), { recursive: true });
      const { server, url } = await startServer(0, { repoDir: repo });
      try {
        const token = await csrfToken(url);
        const res = await get(url, "src", token);
        expect(res.status).toBe(404);
      } finally {
        server.stop();
      }
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});

// Direct handleFileRoute unit tests — the case-sensitive sandbox can't be reproduced through
// startServer (needs a synthetic repo root), so drive the handler with a synthetic repo root.
describe("handleFileRoute — case-sensitive sandbox (#558 review WARN-2b)", () => {
  test("a lowercase-twin sibling dir does NOT bypass the sandbox (case-sensitive prefix)", async () => {
    const callerCwd = process.cwd();
    const { handleFileRoute } = await import("../src/server/file-route.js");
    // The escape only EXISTS on a case-sensitive FS (Linux CI): there, parent/App and parent/app
    // are distinct dirs. On a case-insensitive FS (macOS/Windows dev) they're the same inode, so
    // the attack is unreproducible and there's nothing to assert — detect and skip.
    const probe = mkdtempSync(join(tmpdir(), "vf-cs-probe-"));
    writeFileSync(join(probe, "casecheck"), "");
    let caseSensitive = true;
    try {
      statSync(join(probe, "CASECHECK"));
      caseSensitive = false; // uppercase resolved → FS folds case
    } catch {
      /* uppercase not found → case-sensitive */
    }
    rmSync(probe, { recursive: true, force: true });
    if (!caseSensitive) return; // nothing to prove on a case-folding FS

    const parent = mkdtempSync(join(tmpdir(), "vf-case-"));
    const repo = join(parent, "App");
    const sibling = join(parent, "app");
    try {
      mkdirSync(repo, { recursive: true });
      mkdirSync(sibling, { recursive: true });
      writeFileSync(join(sibling, "secret"), "LEAK");
      const res = handleFileRoute(repo, "../app/secret");
      expect(res.status).toBe(403); // a case-folding compare would have served this
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(parent, { recursive: true, force: true });
    }
  });

  test("an in-repo file with the exact case still reads ok", async () => {
    const callerCwd = process.cwd();
    const { handleFileRoute } = await import("../src/server/file-route.js");
    const repo = mkdtempSync(join(tmpdir(), "vf-case-ok-"));
    try {
      writeFileSync(join(repo, "a.txt"), "hello");
      const res = handleFileRoute(repo, "a.txt");
      expect(res.status).toBe(200);
      const body = (await res.json()) as { ok: boolean; content: string };
      expect(body.ok).toBe(true);
      expect(body.content).toBe("hello");
    } finally {
      expect(process.cwd()).toBe(callerCwd);
      rmSync(repo, { recursive: true, force: true });
    }
  });
});
