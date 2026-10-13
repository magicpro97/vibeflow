import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { handleFilesTreeRoute } from "../src/server/files-tree-route.js";

// Fake git: queued responses, call-count checked, throws on overrun.
function fakeGit(responses: { status: number; stdout: string }[]) {
  const queue = [...responses];
  return {
    deps: {
      runGit: () => {
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
    expect(byPath.get("clean.txt")).toBe("modified");
    expect(byPath.get("new.txt")).toBe("untracked");
    expect(byPath.get("new-name.txt")).toBe("renamed"); // keyed by NEW path
    expect(byPath.get("old-name.txt")).toBeUndefined(); // old chunk is skipped
    expect(byPath.get("safe/readme.md")).toBeUndefined();
    expect(body.entries).toHaveLength(5);
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
    expect(byPath.get("a.txt")).toBe("added");
    expect(byPath.get("b.txt")).toBe("deleted");
    expect(byPath.get("c.txt")).toBe("modified");
    expect(byPath.get("d.txt")).toBe("untracked");
    expect(byPath.get("e.txt")).toBe("renamed");
    expect(byPath.get("t.txt")).toBe("modified"); // T (typechange) maps to modified
    expect(byPath.get("u.txt")).toBeUndefined(); // "U " is unmapped — return undefined covered
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

  test("caps at 5000 entries and reports truncation", async () => {
    const many = [...Array.from({ length: 5001 }, (_, i) => `f${i}.txt`), ""].join("\0");
    const git = fakeGit([
      { status: 0, stdout: many },
      { status: 0, stdout: "" },
    ]);
    const body = (await handleFilesTreeRoute("/repo", git.deps).json()) as {
      entries: unknown[];
      truncated: boolean;
    };
    expect(body.entries).toHaveLength(5000);
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
