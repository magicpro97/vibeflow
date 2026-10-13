import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  FILE_STATUS,
  FILE_TREE_MAX_ENTRIES,
  UNMERGED_PORCELAIN_CODES,
} from "../src/core/file-tree-contract.js";
import { defaultRunGit, handleFilesTreeRoute } from "../src/server/files-tree-route.js";

import { startServer } from "../src/server.js";

/** The worktree root, derived from this file's URL — never process.cwd(). */
const repoRoot = fileURLToPath(new URL("..", import.meta.url));

/** Fetch the CSRF token from the HTML page served at `/`. */
async function csrfToken(url: string): Promise<string> {
  const res = await fetch(url);
  const html = await res.text();
  const m = html.match(/<meta\s+name="vf-token"\s+content="([^"]+)"\s*\/?>/i);
  if (!m) throw new Error("CSRF token not found in page HTML");
  return m[1] as string;
}

// Fake git: queued responses, recorded argv, call-count checked, throws on overrun.
function fakeGit(responses: { status: number; stdout: string }[]) {
  const queue = [...responses];
  const calls: { args: string[]; cwd: string }[] = [];
  return {
    calls,
    deps: {
      runGit: (args: string[], cwd: string) => {
        calls.push({ args, cwd });
        const next = queue.shift();
        if (!next) throw new Error("fake git: unexpected extra call");
        return next;
      },
    },
  };
}

const LS = {
  status: 0,
  stdout: "clean.txt\0new.txt\0new-name.txt\0.gitignore\0safe/readme.md\0",
};
const PORCELAIN = {
  status: 0,
  // -z rename entries carry the OLD path as a prefix-free next chunk, and the
  // new name differs from the old — otherwise the assertion cannot tell which
  // key won.
  stdout: " M clean.txt\0?? new.txt\0R  new-name.txt\0old-name.txt\0",
};
const LIST_ARGS = ["ls-files", "--cached", "--others", "--exclude-standard", "--deduplicate", "-z"];

describe("handleFilesTreeRoute", () => {
  test("lists files with status badges; renames key by the new path", async () => {
    const git = fakeGit([LS, PORCELAIN]);
    const body = (await handleFilesTreeRoute("/repo", git.deps).json()) as {
      ok: boolean;
      entries: { path: string; status?: string }[];
      truncated: boolean;
    };
    expect(body.ok).toBe(true);
    expect(body.truncated).toBe(false);
    const byPath = new Map(body.entries.map((e) => [e.path, e.status]));
    expect(byPath.get("clean.txt")).toBe(FILE_STATUS.MODIFIED);
    expect(byPath.get("new.txt")).toBe(FILE_STATUS.UNTRACKED);
    expect(byPath.get("new-name.txt")).toBe(FILE_STATUS.RENAMED); // keyed by NEW path
    expect(byPath.get("old-name.txt")).toBeUndefined(); // old chunk is skipped
    expect(byPath.get("safe/readme.md")).toBeUndefined();
    expect(body.entries).toHaveLength(5);
  });

  test("pins the git argv: deduplicated ls-files listing, -z porcelain, cwd-anchored", async () => {
    const git = fakeGit([LS, PORCELAIN]);
    await handleFilesTreeRoute("/repo", git.deps);
    expect(git.calls[0]?.args).toEqual(LIST_ARGS);
    expect(git.calls[0]?.cwd).toBe("/repo");
    expect(git.calls[1]?.args).toEqual(["status", "--porcelain", "-z"]);
    expect(git.calls).toHaveLength(2);
  });

  test("unmerged porcelain codes stay unbadged (conflict check precedes the A/D halves)", async () => {
    const codes = [...UNMERGED_PORCELAIN_CODES];
    const names = codes.map((_, index) => `u${index}.txt`);
    const git = fakeGit([
      { status: 0, stdout: `${names.join("\0")}\0` },
      { status: 0, stdout: `${codes.map((code, i) => `${code} ${names[i]}`).join("\0")}\0` },
    ]);
    const body = (await handleFilesTreeRoute("/repo", git.deps).json()) as {
      entries: { path: string; status?: string }[];
    };
    const byPath = new Map(body.entries.map((e) => [e.path, e.status]));
    for (const [index, code] of codes.entries()) {
      expect(byPath.get(names[index] ?? ""), `${code} must stay unbadged`).toBeUndefined();
    }
  });

  test("every porcelain code maps to a label; unmapped codes stay unbadged", async () => {
    const git = fakeGit([
      { status: 0, stdout: "a.txt\0b.txt\0c.txt\0d.txt\0e.txt\0t.txt\0u.txt\0" },
      {
        status: 0,
        stdout: "A  a.txt\0D  b.txt\0M  c.txt\0?? d.txt\0R  e.txt\0e.txt\0T  t.txt\0U  u.txt\0",
      },
    ]);
    const body = (await handleFilesTreeRoute("/repo", git.deps).json()) as {
      entries: { path: string; status?: string }[];
    };
    const byPath = new Map(body.entries.map((e) => [e.path, e.status]));
    expect(byPath.get("a.txt")).toBe(FILE_STATUS.ADDED);
    expect(byPath.get("b.txt")).toBe(FILE_STATUS.DELETED);
    expect(byPath.get("c.txt")).toBe(FILE_STATUS.MODIFIED);
    expect(byPath.get("d.txt")).toBe(FILE_STATUS.UNTRACKED);
    expect(byPath.get("e.txt")).toBe(FILE_STATUS.RENAMED);
    expect(byPath.get("t.txt")).toBe(FILE_STATUS.MODIFIED); // T (typechange) maps to modified
    expect(byPath.get("u.txt")).toBeUndefined(); // "U " is unmapped — return undefined covered
    // Every emitted badge is a value of the shared contract vocabulary.
    const vocabulary = Object.values(FILE_STATUS) as string[];
    for (const entry of body.entries) {
      if (entry.status !== undefined) expect(vocabulary).toContain(entry.status);
    }
  });

  test("unsafe paths are dropped before they reach the UI (and do not fake truncation)", async () => {
    const git = fakeGit([
      { status: 0, stdout: `ok.txt\0../escape.txt\0${String.fromCharCode(7)}bell.txt\0` },
      { status: 0, stdout: "" },
    ]);
    const body = (await handleFilesTreeRoute("/repo", git.deps).json()) as {
      entries: { path: string }[];
      truncated: boolean;
    };
    expect(body.entries.map((e) => e.path)).toEqual(["ok.txt"]);
    expect(body.truncated).toBe(false); // drops are not the cap
  });

  test("caps at FILE_TREE_MAX_ENTRIES entries and reports truncation", async () => {
    const many = [
      ...Array.from({ length: FILE_TREE_MAX_ENTRIES + 1 }, (_, i) => `f${i}.txt`),
      "",
    ].join("\0");
    const git = fakeGit([
      { status: 0, stdout: many },
      { status: 0, stdout: "" },
    ]);
    const body = (await handleFilesTreeRoute("/repo", git.deps).json()) as {
      entries: unknown[];
      truncated: boolean;
    };
    expect(body.entries).toHaveLength(FILE_TREE_MAX_ENTRIES);
    expect(body.truncated).toBe(true);
  });

  test("a non-git directory yields ok:false via the real runner", async () => {
    // No spawns in this file: the default runner is exercised through the route.
    // (os.tmpdir() lives outside any git repo on macOS — git walks upward.)
    const dir = mkdtempSync(join(tmpdir(), "vf-nogit-"));
    try {
      const body = (await handleFilesTreeRoute(dir).json()) as { ok: boolean };
      expect(body.ok).toBe(false);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

// --- production runner: explicit byte-capped stdout, cwd-anchored real git ---
describe("defaultRunGit buffer bounds (real git)", () => {
  test("lists the worktree under the default 64MiB cap", () => {
    const out = defaultRunGit(LIST_ARGS, repoRoot);
    expect(out.status).toBe(0);
    expect(out.stdout.split("\0")).toContain("package.json");
  });

  test("a tiny byte cap overflows to status null instead of silently truncating", () => {
    // Bun clamps stdout and keeps status 0 with error ENOBUFS; Node yields
    // status null. The runner normalizes both to null so overflow is a failure,
    // not a plausible-looking partial listing.
    const out = defaultRunGit(["ls-files", "-z"], repoRoot, 64);
    expect(out.status).toBeNull();
  });
});

// --- wrapper-level wiring: the token guard must gate the new route ---
describe("GET /api/files/tree wiring", () => {
  test("403 without a token, 200 + entries with one", async () => {
    // Explicit repoDir = this worktree, derived from import.meta.url — no
    // process.cwd() dependency, so a sibling test's chdir cannot turn the 200
    // case into a spurious "not a git repository".
    const { server, url } = await startServer(0, { repoDir: repoRoot });
    try {
      const denied = await fetch(`${url}/api/files/tree`);
      expect(denied.status).toBe(403);
      const token = await csrfToken(url);
      const ok = await fetch(`${url}/api/files/tree`, {
        headers: { "x-vibeflow-token": token },
      });
      expect(ok.status).toBe(200);
      const body = (await ok.json()) as { ok: boolean; entries: { path: string }[] };
      expect(body.ok).toBe(true);
      expect(body.entries.some((e) => e.path === "package.json")).toBe(true);
    } finally {
      server.stop(true);
    }
  });
});
